"""Thread-safe storage for read-only topology reports from controlled nodes."""

from __future__ import annotations

import json
import re
import threading
import time
from typing import Any

from .live_rns import topology_snapshot


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
    return snapshot


class LiveReportRegistry:
    """Keep the latest complete report for each stable reporter ID."""

    def __init__(self, *, stale_after: float = 90.0) -> None:
        self.stale_after = stale_after
        self._lock = threading.Lock()
        self._reports: dict[str, dict[str, Any]] = {}

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
            "snapshot": json.loads(json.dumps(snapshot)),
        }
        with self._lock:
            self._reports[reporter_id] = entry

    def get(
        self, reporter_id: str, *, include_paths: bool = False, include_rmap: bool = False
    ) -> dict[str, Any] | None:
        validate_reporter_id(reporter_id)
        with self._lock:
            entry = self._reports.get(reporter_id)
            if entry is None:
                return None
            copied = json.loads(json.dumps(entry))
        state = topology_snapshot(
            copied["snapshot"], include_paths=include_paths, include_rmap=include_rmap
        )
        state["reporter"] = self._metadata(copied)
        return state

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            entries = json.loads(json.dumps(list(self._reports.values())))
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
        }

    def correlations(self) -> list[dict[str, Any]]:
        """Correlate reporter roots with the same hashes observed as next hops."""
        with self._lock:
            entries = json.loads(json.dumps(list(self._reports.values())))
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
        self, *, include_paths: bool = False, include_rmap: bool = False
    ) -> dict[str, Any] | None:
        """Merge reporter evidence without fabricating unobserved route segments."""
        with self._lock:
            entries = json.loads(json.dumps(list(self._reports.values())))
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
        interfaces: list[dict[str, Any]] = []
        transports: dict[str, dict[str, Any]] = {}
        rmap_interfaces: list[dict[str, Any]] = []
        edges: list[dict[str, Any]] = []
        destination_candidates: dict[str, tuple[tuple[Any, ...], dict[str, Any], dict[str, Any]]] = {}
        reporter_metadata: list[dict[str, Any]] = []
        reporter_health: dict[str, dict[str, Any]] = {}

        for entry in entries:
            reporter_id = entry["reporter_id"]
            snapshot = entry["snapshot"]
            metadata = self._metadata(entry)
            reporter_metadata.append(metadata)
            root = snapshot["root"]
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
            for interface in snapshot.get("interfaces", []):
                original_id = interface["id"]
                merged_id = f"reporter:{reporter_id}:{original_id}"
                id_map[original_id] = merged_id
                interfaces.append({**interface, "id": merged_id, "reporter_id": reporter_id})

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
                    merged_destination_id = f"reporter:{reporter_id}:destination:{destination_hash}"
                    candidate_destination = {
                        **destination,
                        "id": merged_destination_id,
                        "interface_id": id_map.get(destination.get("interface_id"), destination.get("interface_id")),
                        "reporter_id": reporter_id,
                        "reporter_label": metadata["label"],
                    }
                    candidate_edge = {
                        **edge,
                        "id": f"reporter:{reporter_id}:{edge['id']}",
                        "source": id_map.get(edge.get("source"), edge.get("source")),
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
            "interfaces": interfaces,
            "transports": merged_transports,
            "destinations": destinations,
            "rmap_interfaces": rmap_interfaces,
            "edges": edges,
            "health": reporter_health,
            "correlations": self.correlations(),
        }
        projected = topology_snapshot(
            merged, include_paths=include_paths, include_rmap=include_rmap
        )
        projected["reporter"] = {
            "id": "all",
            "label": "All reporters",
            "age_seconds": 0,
            "stale": merged["stale"],
            "local": True,
        }
        return projected
