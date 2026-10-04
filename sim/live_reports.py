"""Thread-safe storage for read-only topology reports from controlled nodes."""

from __future__ import annotations

import gzip
import json
import os
import re
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

from .announce_store import AnnounceEventStore
from .live_rns import _path_groups, topology_snapshot


REPORTER_ID_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
REQUIRED_LISTS = ("interfaces", "transports", "destinations", "rmap_interfaces", "edges")


def validate_reporter_id(reporter_id: str) -> str:
    if not REPORTER_ID_PATTERN.fullmatch(reporter_id):
        raise ValueError("reporter ID must contain only letters, numbers, dot, underscore or dash")
    return reporter_id


def validate_snapshot(snapshot: Any) -> dict[str, Any]:
    if not isinstance(snapshot, dict) or snapshot.get("mode") != "live_rns":
        raise ValueError("expected a normalized live_rns snapshot")
    if not isinstance(snapshot.get("root"), dict):
        raise ValueError("snapshot root must be an object")
    for key in REQUIRED_LISTS:
        value = snapshot.get(key)
        if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
            raise ValueError(f"snapshot {key} must be a list of objects")
    if not isinstance(snapshot.get("health", {}), dict):
        raise ValueError("snapshot health must be an object")
    local_services = snapshot.get("local_services", [])
    if not isinstance(local_services, list) or not all(
        isinstance(item, dict) for item in local_services
    ):
        raise ValueError("snapshot local_services must be a list of objects")
    announces = snapshot.get("announces")
    if announces is not None:
        if not isinstance(announces, dict):
            raise ValueError("snapshot announces must be an object")
        events = announces.get("events", [])
        if not isinstance(events, list) or not all(isinstance(item, dict) for item in events):
            raise ValueError("snapshot announce events must be a list of objects")
    return snapshot


class LiveReportRegistry:
    """Keep the latest complete report for each stable reporter ID."""

    def __init__(
        self,
        *,
        stale_after: float = 90.0,
        storage_path: str | None = None,
        cache_interval: float = 0.0,
        announce_db_path: str | None = None,
        local_reporter_id: str | None = None,
    ) -> None:
        self.stale_after = stale_after
        self._lock = threading.Lock()
        self._reports: dict[str, dict[str, Any]] = {}
        self.storage_path = Path(storage_path) if storage_path else None
        self.cache_interval = max(0.0, cache_interval)
        self._last_cache_write = 0.0
        self.cache_error: str | None = None
        self.announce_store = AnnounceEventStore(announce_db_path) if announce_db_path else None
        self.local_reporter_id = (
            validate_reporter_id(local_reporter_id) if local_reporter_id else None
        )
        self._load()
        self._retire_superseded_local_reports()

    def update(
        self,
        reporter_id: str,
        snapshot: dict[str, Any],
        *,
        received_at: float | None = None,
        local: bool = False,
    ) -> None:
        validate_reporter_id(reporter_id)
        validate_snapshot(snapshot)
        entry = {
            "reporter_id": reporter_id,
            "received_at": received_at if received_at is not None else time.time(),
            "local": local,
            # Collectors and request decoders hand ownership of a newly built
            # snapshot to the registry and never mutate it afterward. Avoid a
            # JSON round-trip of the complete path table on every report; a
            # Patroon-sized snapshot is more than 12 MB before compression.
            "snapshot": snapshot,
        }
        if self.announce_store is not None:
            self.announce_store.ingest(reporter_id, snapshot.get("announces"))
        with self._lock:
            self._reports[reporter_id] = entry
            self._save_locked()

    def flush(self) -> None:
        with self._lock:
            self._save_locked(force=True)

    def _load(self) -> None:
        if self.storage_path is None or not self.storage_path.exists():
            return
        try:
            raw = self.storage_path.read_bytes()
            if raw.startswith(b"\x1f\x8b"):
                raw = gzip.decompress(raw)
            document = json.loads(raw)
            entries = document.get("reports", [])
            if not isinstance(entries, list):
                raise ValueError("cached reports must be a list")
            loaded = {}
            for entry in entries:
                reporter_id = validate_reporter_id(str(entry.get("reporter_id") or ""))
                validate_snapshot(entry.get("snapshot"))
                received_at = float(entry.get("received_at"))
                loaded[reporter_id] = {
                    "reporter_id": reporter_id,
                    "received_at": received_at,
                    "local": bool(entry.get("local")),
                    "snapshot": entry["snapshot"],
                }
            self._reports = loaded
        except (OSError, TypeError, ValueError, json.JSONDecodeError) as exc:
            # A damaged cache must not prevent fresh observations from loading.
            self.cache_error = str(exc)
            self._reports = {}

    def _retire_superseded_local_reports(self) -> None:
        """Remove cached local aliases after the configured reporter ID changes."""
        if self.local_reporter_id is None:
            return
        retired = [
            reporter_id
            for reporter_id, entry in self._reports.items()
            if entry["local"] and reporter_id != self.local_reporter_id
        ]
        if not retired:
            return
        for reporter_id in retired:
            del self._reports[reporter_id]
        # This is a startup migration, so persist it immediately regardless of
        # the normal write-throttling interval. Remote reports remain intact.
        self._save_locked(force=True)

    def _save_locked(self, *, force: bool = False) -> None:
        if self.storage_path is None:
            return
        now = time.monotonic()
        if not force and now - self._last_cache_write < self.cache_interval:
            return
        try:
            self.storage_path.parent.mkdir(parents=True, exist_ok=True)
            descriptor, temporary = tempfile.mkstemp(
                prefix=self.storage_path.name + ".",
                suffix=".tmp",
                dir=self.storage_path.parent,
            )
            try:
                encoded = json.dumps(
                    {"version": 1, "reports": list(self._reports.values())},
                    separators=(",", ":"),
                ).encode("utf-8")
                with os.fdopen(descriptor, "wb") as output:
                    output.write(gzip.compress(encoded, compresslevel=6))
                    output.flush()
                    os.fsync(output.fileno())
                os.replace(temporary, self.storage_path)
                self.cache_error = None
                self._last_cache_write = now
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
        except (OSError, TypeError, ValueError) as exc:
            self.cache_error = str(exc)

    def get(
        self, reporter_id: str, *, include_paths: bool = False, include_rmap: bool = False,
        include_announces: bool = False,
    ) -> dict[str, Any] | None:
        validate_reporter_id(reporter_id)
        with self._lock:
            entry = self._reports.get(reporter_id)
            if entry is None:
                return None
            copied = dict(entry)
            services_by_destination: dict[str, list[dict[str, Any]]] = {}
            for report in self._reports.values():
                service_reporter = report["reporter_id"]
                for service in report["snapshot"].get("local_services", []):
                    destination_hash = str(service.get("destination_hash") or "").lower()
                    if destination_hash:
                        services_by_destination.setdefault(destination_hash, []).append({
                            **service, "reporter_id": service_reporter
                        })
        snapshot = dict(copied["snapshot"])
        enriched_destinations = []
        for destination in snapshot.get("destinations", []):
            service_matches = services_by_destination.get(
                str(destination.get("hash") or "").lower()
            )
            if service_matches:
                destination = {
                    **destination,
                    "local_service": service_matches[0],
                    "service_reporters": sorted({
                        service["reporter_id"] for service in service_matches
                    }),
                }
            enriched_destinations.append(destination)
        snapshot["destinations"] = enriched_destinations
        state = topology_snapshot(
            snapshot, include_paths=include_paths, include_rmap=include_rmap,
            include_announces=include_announces,
        )
        state["reporter"] = self._metadata(copied)
        return state

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            entries = list(self._reports.values())
        result = [self._metadata(entry) for entry in entries]
        return sorted(result, key=lambda item: (not item["local"], item["label"].lower()))

    def _metadata(self, entry: dict[str, Any]) -> dict[str, Any]:
        snapshot = entry["snapshot"]
        root = snapshot.get("root", {})
        received_at = entry["received_at"]
        age = max(0.0, time.time() - received_at)
        return {
            "id": entry["reporter_id"],
            "label": root.get("label") or entry["reporter_id"],
            "transport_id": root.get("transport_id"),
            "received_at": received_at,
            "collected_at": snapshot.get("collected_at"),
            "age_seconds": round(age, 1),
            "stale": bool(snapshot.get("stale")) or age > self.stale_after,
            "local": bool(entry["local"]),
            "interface_count": len(snapshot.get("interfaces", [])),
            "destination_count": len(snapshot.get("destinations", [])),
            "announce_count": len((snapshot.get("announces") or {}).get("events", [])),
        }

    def correlations(self) -> list[dict[str, Any]]:
        """Correlate reporter roots with the same hashes observed as next hops."""
        with self._lock:
            entries = list(self._reports.values())
        roots: dict[str, list[str]] = {}
        observers: dict[str, list[str]] = {}
        for entry in entries:
            reporter_id = entry["reporter_id"]
            snapshot = entry["snapshot"]
            transport_id = snapshot.get("root", {}).get("transport_id")
            if transport_id:
                roots.setdefault(str(transport_id), []).append(reporter_id)
            for transport in snapshot.get("transports", []):
                transport_hash = transport.get("hash")
                if transport_hash:
                    observers.setdefault(str(transport_hash), []).append(reporter_id)
        return [
            {
                "transport_id": transport_id,
                "reported_by": sorted(set(reporter_ids)),
                "observed_by": sorted(set(observers.get(transport_id, []))),
            }
            for transport_id, reporter_ids in sorted(roots.items())
            if observers.get(transport_id)
        ]

    def network(
        self, *, include_paths: bool = False, include_rmap: bool = False,
        include_announces: bool = False,
    ) -> dict[str, Any] | None:
        """Merge reporter evidence without fabricating unobserved route segments."""
        with self._lock:
            # Updates atomically replace complete entries and never mutate an
            # installed snapshot, so readers can safely retain references.
            entries = list(self._reports.values())
        if not entries:
            return None
        entries.sort(key=lambda entry: (not entry["local"], entry["reporter_id"]))
        primary_entry = next((entry for entry in entries if entry["local"]), entries[0])
        primary_next_hops = {
            str(transport.get("hash"))
            for transport in primary_entry["snapshot"].get("transports", [])
            if transport.get("hash")
        }

        reporter_roots_by_id: dict[str, dict[str, Any]] = {}
        interfaces_by_id: dict[str, dict[str, Any]] = {}
        transports: dict[str, dict[str, Any]] = {}
        rmap_interfaces: list[dict[str, Any]] = []
        local_services: list[dict[str, Any]] = []
        services_by_destination: dict[str, list[dict[str, Any]]] = {}
        edges: list[dict[str, Any]] = []
        destination_candidates: dict[str, tuple[tuple[Any, ...], dict[str, Any], dict[str, Any]]] = {}
        path_group_candidates: dict[str, tuple[tuple[Any, ...], dict[str, Any], dict[str, Any]]] = {}
        path_summary_candidates: dict[str, tuple[tuple[Any, ...], str | None]] = {}
        reporter_metadata: list[dict[str, Any]] = []
        reporter_health: dict[str, dict[str, Any]] = {}
        announce_events_by_id: dict[str, dict[str, Any]] = {}
        announce_evicted = 0
        announce_active = False
        announce_errors: list[str] = []

        for entry in entries:
            reporter_id = entry["reporter_id"]
            snapshot = entry["snapshot"]
            metadata = self._metadata(entry)
            reporter_metadata.append(metadata)
            root = snapshot["root"]
            announce_capture = snapshot.get("announces", {})
            if isinstance(announce_capture, dict):
                announce_active = announce_active or bool(announce_capture.get("active"))
                announce_evicted += int(announce_capture.get("evicted_count") or 0)
                if announce_capture.get("error"):
                    announce_errors.append(f"{reporter_id}: {announce_capture['error']}")
                for event in announce_capture.get("events", []):
                    if not isinstance(event, dict) or not event.get("id"):
                        continue
                    event_id = str(event["id"])
                    existing_event = announce_events_by_id.get(event_id)
                    observation = {
                        "reporter_id": reporter_id,
                        "received_at": event.get("received_at"),
                        "route_hops": event.get("route_hops"),
                        "route_via": event.get("route_via"),
                        "route_interface": event.get("route_interface"),
                    }
                    if existing_event is None:
                        announce_events_by_id[event_id] = {
                            **event,
                            "observed_by": [reporter_id],
                            "observations": [observation],
                        }
                    else:
                        existing_event["observed_by"] = sorted(set(
                            existing_event["observed_by"] + [reporter_id]
                        ))
                        existing_event["observations"].append(observation)
            for service in snapshot.get("local_services", []):
                destination_hash = str(service.get("destination_hash") or "").lower()
                merged_service = {**service, "reporter_id": reporter_id}
                local_services.append(merged_service)
                if destination_hash:
                    services_by_destination.setdefault(destination_hash, []).append(merged_service)
            root_transport = root.get("transport_id")
            root_id = f"transport:{root_transport}" if root_transport else f"reporter:{reporter_id}"
            reporter_root = {
                **root,
                "id": root_id,
                "reporter_id": reporter_id,
                "primary": bool(entry["local"]),
                "report_stale": metadata["stale"],
                "contributing_reporters": [reporter_id],
            }
            existing_root = reporter_roots_by_id.get(root_id)
            if existing_root is None or entry["local"]:
                if existing_root:
                    reporter_root["contributing_reporters"] = sorted(set(
                        existing_root["contributing_reporters"] + [reporter_id]
                    ))
                reporter_roots_by_id[root_id] = reporter_root
            else:
                existing_root["contributing_reporters"] = sorted(set(
                    existing_root["contributing_reporters"] + [reporter_id]
                ))

            id_map = {root["id"]: root_id}
            snapshot_interfaces = snapshot.get("interfaces", [])
            for interface in snapshot_interfaces:
                original_id = interface["id"]
                interface_hash = str(interface.get("interface_hash") or "").lower()
                merged_id = (
                    f"interface:{interface_hash}"
                    if interface_hash
                    else f"reporter:{reporter_id}:{original_id}"
                )
                id_map[original_id] = merged_id
            for interface in snapshot_interfaces:
                original_id = interface["id"]
                merged_id = id_map[original_id]
                observation = {**interface, "reporter_id": reporter_id}
                candidate = {
                    **interface,
                    "id": merged_id,
                    "parent_interface_id": id_map.get(
                        interface.get("parent_interface_id"),
                        interface.get("parent_interface_id"),
                    ),
                    "reporter_id": reporter_id,
                    "observed_by": [reporter_id],
                    "observations": [observation],
                }
                existing_interface = interfaces_by_id.get(merged_id)
                if existing_interface is None:
                    interfaces_by_id[merged_id] = candidate
                else:
                    existing_interface["observed_by"] = sorted(set(
                        existing_interface["observed_by"] + [reporter_id]
                    ))
                    existing_interface["observations"].append(observation)
                    # Entries are ordered with the primary reporter first.
                    # Keep its value on conflicts, but fill fields it did not
                    # report from the contributing observation.
                    for key, value in candidate.items():
                        if key not in {
                            "id", "reporter_id", "observed_by", "observations", "raw"
                        } and (
                            existing_interface.get(key) is None
                            or existing_interface.get(key) == ""
                        ) and value is not None and value != "":
                            existing_interface[key] = value

            for transport in snapshot.get("transports", []):
                transport_hash = str(transport.get("hash"))
                merged_id = f"transport:{transport_hash}"
                id_map[transport["id"]] = merged_id
                merged_interfaces = [id_map.get(item, item) for item in transport.get("interface_ids", [])]
                existing = transports.get(transport_hash)
                if existing is None:
                    transports[transport_hash] = {
                        **transport,
                        "id": merged_id,
                        "interface_ids": merged_interfaces,
                        "observed_by": [reporter_id],
                    }
                else:
                    existing["interface_ids"] = sorted(set(existing["interface_ids"] + merged_interfaces))
                    existing["observed_by"] = sorted(set(existing["observed_by"] + [reporter_id]))

            destinations_by_id = {
                destination["id"]: destination for destination in snapshot.get("destinations", [])
            }
            for edge in snapshot.get("edges", []):
                if edge.get("kind") == "known_path":
                    destination = destinations_by_id.get(edge.get("target"))
                    if not destination:
                        continue
                    destination_hash = str(destination.get("hash"))
                    hops = destination.get("hops")
                    hop_score = hops if isinstance(hops, int) else 1_000_000
                    # The closest observation contains the most route detail.
                    # A disconnected reporter must not replace the primary's
                    # route merely because it is locally closer. A reporter
                    # whose transport is a primary-observed next hop can refine
                    # the primary topology (for example a vehicle transport).
                    connected_to_primary = bool(entry["local"]) or (
                        root_transport is not None and str(root_transport) in primary_next_hops
                    )
                    score = (
                        0 if connected_to_primary else 1,
                        hop_score,
                        0 if entry["local"] else 1,
                        reporter_id,
                    )
                    current_summary = path_summary_candidates.get(destination_hash)
                    if current_summary is None or score < current_summary[0]:
                        path_summary_candidates[destination_hash] = (
                            score,
                            str(destination.get("via")) if destination.get("via") else None,
                        )
                    merged_destination_id = f"reporter:{reporter_id}:destination:{destination_hash}"
                    group_destination = {
                        "id": merged_destination_id,
                        "hash": destination.get("hash"),
                        "hops": destination.get("hops"),
                        "interface_id": id_map.get(destination.get("interface_id"), destination.get("interface_id")),
                        "interface": destination.get("interface"),
                        "reporter_id": reporter_id,
                        "reporter_label": metadata["label"],
                    }
                    group_edge = {
                        "kind": "known_path",
                        "hops": edge.get("hops"),
                        "source": id_map.get(edge.get("source"), edge.get("source")),
                        "target": merged_destination_id,
                    }
                    current_group = path_group_candidates.get(destination_hash)
                    if current_group is None or score < current_group[0]:
                        path_group_candidates[destination_hash] = (
                            score, group_destination, group_edge
                        )
                    if (
                        not include_paths
                        and not destination.get("local")
                        and destination_hash.lower() not in services_by_destination
                    ):
                        continue
                    candidate_destination = {
                        **destination,
                        "id": merged_destination_id,
                        "interface_id": group_destination["interface_id"],
                        "reporter_id": reporter_id,
                        "reporter_label": metadata["label"],
                    }
                    candidate_edge = {
                        **edge,
                        "id": f"reporter:{reporter_id}:{edge['id']}",
                        "source": group_edge["source"],
                        "target": merged_destination_id,
                        "reporter_id": reporter_id,
                    }
                    current = destination_candidates.get(destination_hash)
                    if current is None or score < current[0]:
                        destination_candidates[destination_hash] = (
                            score, candidate_destination, candidate_edge
                        )
                    continue

                edges.append({
                    **edge,
                    "id": f"reporter:{reporter_id}:{edge['id']}",
                    "source": id_map.get(edge.get("source"), edge.get("source")),
                    "target": id_map.get(edge.get("target"), edge.get("target")),
                    "reporter_id": reporter_id,
                })

            for rmap in snapshot.get("rmap_interfaces", []):
                rmap_interfaces.append({
                    **rmap,
                    "id": f"reporter:{reporter_id}:{rmap['id']}",
                    "reporter_id": reporter_id,
                })

            failed_sources = [
                name for name, health in snapshot.get("health", {}).items()
                if isinstance(health, dict) and not health.get("ok")
            ]
            reporter_health[f"reporter:{reporter_id}"] = {
                "ok": not metadata["stale"] and not failed_sources,
                "error": (
                    "stale report" if metadata["stale"]
                    else f"failed sources: {', '.join(failed_sources)}" if failed_sources
                    else None
                ),
            }

        destinations = []
        for _, destination, edge in destination_candidates.values():
            service_matches = services_by_destination.get(str(destination.get("hash") or "").lower(), [])
            if service_matches:
                destination["local_service"] = service_matches[0]
                destination["service_reporters"] = sorted({
                    match["reporter_id"] for match in service_matches
                })
            destinations.append(destination)
            edges.append(edge)

        reporter_roots = list(reporter_roots_by_id.values())
        reporter_roots.sort(key=lambda root: (not root["primary"], root["reporter_id"]))
        root_ids = {root["id"] for root in reporter_roots}
        merged_transports = [
            transport for transport in transports.values() if transport["id"] not in root_ids
        ]
        primary = next((root for root in reporter_roots if root["primary"]), reporter_roots[0])
        merged = {
            "mode": "live_rns_network",
            "collected_at": max(
                (entry["snapshot"].get("collected_at") or 0 for entry in entries), default=0
            ),
            "stale": all(metadata["stale"] for metadata in reporter_metadata),
            "root": primary,
            "reporter_roots": reporter_roots,
            "reporters": reporter_metadata,
            "interfaces": list(interfaces_by_id.values()),
            "transports": merged_transports,
            "destinations": destinations,
            "rmap_interfaces": rmap_interfaces,
            "local_services": local_services,
            "edges": edges,
            "health": reporter_health,
            "correlations": self.correlations(),
            "announces": {
                "version": 1,
                "active": announce_active,
                "event_count": len(announce_events_by_id),
                "evicted_count": announce_evicted,
                "error": "; ".join(announce_errors) if announce_errors else None,
                "events": list(announce_events_by_id.values()),
            },
        }
        if not include_paths:
            counts_by_transport: dict[str, int] = {}
            for _, via in path_summary_candidates.values():
                if via:
                    counts_by_transport[via] = counts_by_transport.get(via, 0) + 1
            merged["_path_summary"] = {
                "destination_count": len(path_summary_candidates),
                "by_transport": counts_by_transport,
            }
            group_destinations = []
            group_edges = []
            for _, destination, edge in path_group_candidates.values():
                group_destinations.append(destination)
                group_edges.append(edge)
            merged["_path_groups"] = _path_groups(group_destinations, group_edges)
        projected = topology_snapshot(
            merged, include_paths=include_paths, include_rmap=include_rmap,
            include_announces=include_announces,
        )
        projected["reporter"] = {
            "id": "all",
            "label": "All reporters",
            "age_seconds": 0,
            "stale": merged["stale"],
            "local": True,
        }
        return projected
