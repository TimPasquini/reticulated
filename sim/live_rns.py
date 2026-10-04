"""Read-only collection and normalization of a local Reticulum instance."""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import threading
import time
from collections.abc import Callable
from typing import Any

from . import config
from .announce_capture import AnnounceCapture
from .live_services import discover_local_services


CommandRunner = Callable[[list[str], float], Any]


def _canonical_endpoint(value: Any) -> str:
    endpoint = str(value or "").lower().rstrip(".")
    # RNS 1.5.5's I2P status value includes the conventional suffix while
    # interface-discovery records currently expose the same b32 without it.
    if endpoint.endswith(".b32.i2p"):
        endpoint = endpoint[:-8]
    return endpoint


def _endpoint_from_interface(raw: dict[str, Any]) -> tuple[str | None, int | None]:
    host = raw.get("target_host") or raw.get("remote")
    port = _as_int(raw.get("target_port") or raw.get("port"))
    if host:
        return _canonical_endpoint(host), port
    # RNS 1.5.5 includes a Backbone client's active target in its display name,
    # but not as separate JSON fields.
    name = str(raw.get("name") or "")
    match = re.search(r"/([^/\]]+):(\d+)\]$", name)
    if match:
        return _canonical_endpoint(match.group(1)), int(match.group(2))
    return None, None


def _rmap_matches(state: dict[str, Any]) -> list[dict[str, Any]]:
    records = state.get("rmap_interfaces", [])
    roots = state.get("reporter_roots") or [state.get("root", {})]
    root_transport_by_reporter = {
        root.get("reporter_id"): str(root.get("transport_id"))
        for root in roots if root.get("transport_id")
    }
    default_transport = str(state.get("root", {}).get("transport_id") or "")
    matches: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for interface in state.get("interfaces", []):
        raw = interface.get("raw", {})
        remote_host = _canonical_endpoint(interface.get("remote_host"))
        remote_port = _as_int(interface.get("remote_port"))
        i2p_b32 = _canonical_endpoint(interface.get("i2p_b32") or raw.get("i2p_b32"))
        reporter_transport = root_transport_by_reporter.get(
            interface.get("reporter_id"), default_transport
        )
        interface_type = interface.get("type")
        for record in records:
            reachable = _canonical_endpoint(record.get("reachable_on"))
            record_port = _as_int(record.get("port"))
            match_kind = None
            if remote_host and reachable == remote_host and (
                remote_port is None or record_port is None or remote_port == record_port
            ):
                match_kind = "remote_endpoint"
            elif i2p_b32 and reachable == i2p_b32:
                match_kind = "i2p_endpoint"
            elif (
                reporter_transport
                and str(record.get("transport_id")) == reporter_transport
                and record.get("type") == interface_type
            ):
                match_kind = "local_publication"
            if not match_kind:
                continue
            key = (interface["id"], record["id"])
            if key in seen:
                continue
            seen.add(key)
            matches.append({
                "interface_id": interface["id"],
                "rmap_interface_id": record["id"],
                "transport_id": record.get("transport_id"),
                "kind": match_kind,
                "name": record.get("name"),
                "type": record.get("type"),
                "reachable_on": record.get("reachable_on"),
                "port": record.get("port"),
                "latitude": record.get("latitude"),
                "longitude": record.get("longitude"),
                "record": record,
            })
    return matches


def _rmap_attachments(
    state: dict[str, Any], matches: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Project endpoint matches into confirmed transport attachment edges."""
    roots = state.get("reporter_roots") or [state.get("root", {})]
    root_by_reporter = {root.get("reporter_id"): root for root in roots}
    default_root = state.get("root", {})
    interfaces = {
        interface.get("id"): interface for interface in state.get("interfaces", [])
    }
    attachments = []
    seen: set[tuple[str, str, str]] = set()
    for match in matches:
        if match.get("kind") not in {"remote_endpoint", "i2p_endpoint"}:
            continue
        interface = interfaces.get(match.get("interface_id"), {})
        root = root_by_reporter.get(interface.get("reporter_id"), default_root)
        remote_transport = match.get("transport_id")
        local_transport = root.get("transport_id")
        if not remote_transport or (
            local_transport and str(remote_transport) == str(local_transport)
        ):
            continue
        source_id = root.get("id")
        target_id = f"transport:{remote_transport}"
        if not source_id:
            continue
        key = (str(source_id), target_id, str(match.get("interface_id")))
        if key in seen:
            continue
        seen.add(key)
        attachments.append({
            "id": "rmap-attachment:" + ":".join(key),
            "source": source_id,
            "target": target_id,
            "via_interface_id": match.get("interface_id"),
            "local_transport_id": local_transport,
            "remote_transport_id": remote_transport,
            "match_kind": match.get("kind"),
            "interface_online": interface.get("status"),
            "certainty": (
                "observed_endpoint_attachment"
                if interface.get("status") is True
                else "configured_endpoint_attachment"
            ),
            "latitude": match.get("latitude"),
            "longitude": match.get("longitude"),
        })
    return attachments


def _announce_graph_enrichment(
    state: dict[str, Any], announce_events: list[dict[str, Any]]
) -> None:
    """Project received announces into bounded, evidence-backed graph objects."""
    destinations = [dict(item) for item in state.get("destinations", [])]
    transports = [
        {**item, "interface_ids": list(item.get("interface_ids", []))}
        for item in state.get("transports", [])
    ]
    edges = [dict(item) for item in state.get("edges", [])]
    state["destinations"] = destinations
    state["transports"] = transports
    state["edges"] = edges

    roots = state.get("reporter_roots") or [state.get("root", {})]
    root_by_reporter = {
        root.get("reporter_id"): root for root in roots if root.get("reporter_id")
    }
    reporter_by_transport = {
        str(root.get("transport_id")): root.get("reporter_id")
        for root in roots if root.get("transport_id") and root.get("reporter_id")
    }
    default_root = state.get("root", {})
    interfaces = state.get("interfaces", [])
    destinations_by_hash = {
        str(item.get("hash") or "").lower(): item
        for item in destinations if item.get("hash")
    }
    transports_by_id = {item.get("id"): item for item in transports}
    root_ids = {root.get("id") for root in roots}
    edge_pairs = {(edge.get("source"), edge.get("target")) for edge in edges}

    grouped: dict[str, list[dict[str, Any]]] = {}
    for event in announce_events:
        if not isinstance(event, dict):
            continue
        destination_hash = str(event.get("destination_hash") or "").lower()
        if destination_hash:
            grouped.setdefault(destination_hash, []).append(event)

    def observations(event: dict[str, Any]) -> list[dict[str, Any]]:
        recorded = event.get("observations")
        if isinstance(recorded, list) and recorded:
            return [
                {**event, **item} for item in recorded if isinstance(item, dict)
            ]
        return [event]

    def received_at(item: dict[str, Any]) -> float:
        try:
            return float(item.get("received_at") or 0)
        except (TypeError, ValueError):
            return 0.0

    def matching_interface(
        reporter_id: str | None, interface_name: Any
    ) -> dict[str, Any] | None:
        if not interface_name:
            return None
        wanted = str(interface_name)
        for interface in interfaces:
            candidates = interface.get("observations")
            if not isinstance(candidates, list) or not candidates:
                candidates = [interface]
            for candidate in candidates:
                if reporter_id and candidate.get("reporter_id") != reporter_id:
                    continue
                names = {
                    str(candidate.get(key))
                    for key in ("name", "short_name", "display_name")
                    if candidate.get(key)
                }
                if wanted in names:
                    return interface
        return None

    for destination_hash, events in grouped.items():
        all_observations = [item for event in events for item in observations(event)]
        route = min(
            all_observations,
            key=lambda item: (
                _as_int(item.get("route_hops")) is None,
                _as_int(item.get("route_hops")) or 0,
                -received_at(item),
            ),
        )
        latest = max(events, key=received_at)
        observed_by_values = []
        for event in events:
            event_reporters = event.get("observed_by")
            if isinstance(event_reporters, list):
                observed_by_values.extend(event_reporters)
            observed_by_values.extend(
                item.get("reporter_id") for item in observations(event)
            )
        observed_by = sorted({
            str(reporter_id) for reporter_id in observed_by_values if reporter_id
        })
        aspects = sorted({
            str(event.get("aspect")) for event in events if event.get("aspect")
        })
        identity_hashes = sorted({
            str(event.get("identity_hash"))
            for event in events if event.get("identity_hash")
        })
        destination = destinations_by_hash.get(destination_hash)
        hops = _as_int(route.get("route_hops"))
        via = route.get("route_via")
        if via and str(via).lower() == destination_hash:
            via = None
        reporter_id = route.get("reporter_id")
        interface = matching_interface(reporter_id, route.get("route_interface"))
        root = root_by_reporter.get(reporter_id, default_root)

        if destination is None:
            destination = {
                "id": f"announce-destination:{destination_hash}",
                "hash": destination_hash,
                "hops": hops,
                "via": via,
                "interface_id": interface.get("id") if interface else None,
                "interface": route.get("route_interface"),
                "local": False,
                "reporter_id": reporter_id,
            }
            destinations.append(destination)
            destinations_by_hash[destination_hash] = destination

        destination.update({
            "announced": True,
            "announce_count": len(events),
            "announce_received_at": received_at(latest),
            "announce_aspect": latest.get("aspect"),
            "announce_aspects": aspects,
            "announce_identity_hash": identity_hashes[0] if len(identity_hashes) == 1 else None,
            "announce_identity_hashes": identity_hashes,
            "announce_identity_conflict": len(identity_hashes) > 1,
            "announce_app_data": latest.get("app_data_text"),
            "announce_observed_by": observed_by,
        })

        unique_routes: dict[tuple[Any, ...], dict[str, Any]] = {}
        for observation in all_observations:
            observation_via = observation.get("route_via")
            if observation_via and str(observation_via).lower() == destination_hash:
                observation_via = None
            route_key = (
                observation.get("reporter_id"),
                observation.get("route_interface"),
                observation_via,
                _as_int(observation.get("route_hops")),
            )
            previous = unique_routes.get(route_key)
            if previous is None or received_at(observation) > received_at(previous):
                unique_routes[route_key] = observation
        destination["announce_routes"] = [
            {
                "reporter_id": key[0],
                "interface": key[1],
                "via": key[2],
                "hops": key[3],
                "received_at": received_at(observation),
            }
            for key, observation in unique_routes.items()
        ]

        routes_by_reporter: dict[str, list[dict[str, Any]]] = {}
        for observation in unique_routes.values():
            observation_reporter = observation.get("reporter_id")
            if observation_reporter:
                routes_by_reporter.setdefault(str(observation_reporter), []).append(observation)

        for route_key, observation in unique_routes.items():
            reporter_id = observation.get("reporter_id")
            hops = _as_int(observation.get("route_hops"))
            via = route_key[2]
            interface = matching_interface(reporter_id, observation.get("route_interface"))
            root = root_by_reporter.get(reporter_id, default_root)
            source_id = interface.get("id") if interface else root.get("id")
            if via:
                transport_id = f"transport:{via}"
                transport = transports_by_id.get(transport_id)
                if transport is None and transport_id not in root_ids:
                    transport = {
                        "id": transport_id,
                        "hash": via,
                        "interface_ids": [interface["id"]] if interface else [],
                        "observed_by": [reporter_id] if reporter_id else [],
                        "announce_inferred": True,
                    }
                    transports.append(transport)
                    transports_by_id[transport_id] = transport
                elif (
                    transport is not None
                    and interface
                    and interface["id"] not in transport["interface_ids"]
                ):
                    transport["interface_ids"].append(interface["id"])
                if interface and (interface["id"], transport_id) not in edge_pairs:
                    edges.append({
                        "id": f"edge:announce-next-hop:{interface['id']}:{via}",
                        "source": interface["id"],
                        "target": transport_id,
                        "kind": "announce_next_hop",
                        "certainty": "historical_observation",
                        "reporter_id": reporter_id,
                    })
                    edge_pairs.add((interface["id"], transport_id))
                source_id = transport_id
            if not source_id:
                continue

            stitched_reporter = reporter_by_transport.get(str(via)) if via else None
            downstream = routes_by_reporter.get(str(stitched_reporter), [])
            downstream_hops = [
                _as_int(item.get("route_hops")) for item in downstream
                if _as_int(item.get("route_hops")) is not None
            ]
            expected_hops = None
            hop_delta = None
            if (
                stitched_reporter
                and stitched_reporter != reporter_id
                and hops is not None
                and downstream_hops
            ):
                expected_hops = 1 + min(downstream_hops)
                hop_delta = hops - expected_hops
                # A consistent farther observation contributes the link to the
                # known reporter. Its own observation supplies the onward path.
                if hop_delta == 0:
                    continue
                unknown_hops = hop_delta if hop_delta > 0 else None
            else:
                unknown_hops = max(0, hops - 1) if hops is not None else None

            duplicate = any(
                edge.get("target") == destination["id"]
                and edge.get("source") == source_id
                and edge.get("hops") == hops
                and edge.get("evidence") != "received_announce"
                for edge in edges
            )
            if duplicate:
                continue
            fragment = _stable_fragment("|".join(str(item) for item in route_key))
            edges.append({
                "id": f"edge:announce-path:{fragment}:{destination_hash}",
                "source": source_id,
                "target": destination["id"],
                "kind": "known_path",
                "certainty": (
                    "incomplete"
                    if unknown_hops or hops is None or hop_delta not in (None, 0)
                    else "observed"
                ),
                "evidence": "received_announce",
                "hops": hops,
                "unknown_hops": unknown_hops,
                "reporter_id": reporter_id,
                "stitched_via_reporter": stitched_reporter,
                "expected_hops": expected_hops,
                "hop_delta": hop_delta,
                "route_conflict": hop_delta is not None and hop_delta != 0,
            })
            edge_pairs.add((source_id, destination["id"]))


def topology_snapshot(
    source: dict[str, Any], *, include_paths: bool = False, include_rmap: bool = False,
    include_announces: bool = False,
) -> dict[str, Any]:
    """Project a full normalized report into the requested API representation."""
    # This projection only replaces top-level collections; it never mutates
    # normalized objects. A shallow copy avoids duplicating tens of thousands
    # of path dictionaries on every five-second API poll.
    state = dict(source)
    destinations = state.get("destinations", [])
    counts_by_transport: dict[str, int] = {}
    for destination in destinations:
        via = destination.get("via")
        if via:
            key = str(via)
            counts_by_transport[key] = counts_by_transport.get(key, 0) + 1
    provided_path_summary = state.pop("_path_summary", None)
    state["path_summary"] = provided_path_summary or {
        "destination_count": len(destinations),
        "by_transport": counts_by_transport,
    }
    local_destinations = [item for item in destinations if item.get("local")]
    service_destinations = [
        item for item in destinations if item.get("local") or item.get("local_service")
    ]
    state["service_summary"] = {
        "local_destination_count": len(local_destinations),
        "identified_count": len([
            item for item in service_destinations if item.get("local_service")
        ]),
    }
    rmap_interfaces = state.get("rmap_interfaces", [])
    state["rmap_summary"] = {
        "record_count": len(rmap_interfaces),
        # Kept for API compatibility with the initial live implementation.
        "interface_count": len(rmap_interfaces),
        "transport_count": len(
            {item.get("transport_id") for item in rmap_interfaces if item.get("transport_id")}
        ),
    }
    state["rmap_matches"] = _rmap_matches(state)
    state["rmap_attachments"] = _rmap_attachments(state, state["rmap_matches"])
    state["rmap_summary"]["matched_interface_count"] = len(
        {match["interface_id"] for match in state["rmap_matches"]}
    )
    state["rmap_summary"]["attachment_count"] = len(state["rmap_attachments"])
    announce_capture = state.get("announces")
    if not isinstance(announce_capture, dict):
        announce_capture = {"active": False, "events": [], "error": None}
    announce_events = announce_capture.get("events", [])
    if not isinstance(announce_events, list):
        announce_events = []
    _announce_graph_enrichment(state, announce_events)
    aspect_counts: dict[str, int] = {}
    for event in announce_events:
        if not isinstance(event, dict):
            continue
        aspect = str(event.get("aspect") or "unknown")
        aspect_counts[aspect] = aspect_counts.get(aspect, 0) + 1
    state["announce_summary"] = {
        "active": bool(announce_capture.get("active")),
        "event_count": len(announce_events),
        "destination_count": len({
            event.get("destination_hash") for event in announce_events
            if isinstance(event, dict) and event.get("destination_hash")
        }),
        "evicted_count": int(announce_capture.get("evicted_count") or 0),
        "aspect_counts": aspect_counts,
        "error": announce_capture.get("error"),
        "enriched_destination_count": len([
            item for item in state["destinations"] if item.get("announced")
        ]),
    }
    if not include_announces:
        state["announces"] = {
            key: value for key, value in announce_capture.items() if key != "events"
        }
    if not include_paths:
        visible_destinations = [
            item for item in state["destinations"]
            if item.get("local") or item.get("local_service") or item.get("announced")
        ]
        visible_destination_ids = {
            item["id"] for item in visible_destinations if item.get("id")
        }
        state["destinations"] = visible_destinations
        state["edges"] = [
            edge for edge in state.get("edges", [])
            if edge.get("kind") != "known_path"
            or edge.get("target") in visible_destination_ids
        ]
    if not include_rmap:
        state["rmap_interfaces"] = []
        state["rmap_matches"] = []
        state["rmap_attachments"] = []
    return state


def _stable_fragment(value: Any) -> str:
    """Return a stable, JSON-safe identifier fragment for non-hash values."""
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()[:24]


def _as_int(value: Any) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _interface_mode(value: Any) -> str | Any:
    # Public RNS interface mode constants. Keep unknown future values intact.
    modes = {
        1: "full",
        2: "point_to_point",
        3: "access_point",
        4: "roaming",
        5: "boundary",
        6: "gateway",
    }
    try:
        return modes.get(value, value)
    except TypeError:
        return value


def _compact_endpoint(value: str, limit: int = 24) -> str:
    if len(value) <= limit:
        return value
    return value[:12] + "…" + value[-7:]


def _interface_display_name(raw: dict[str, Any], full_name: str) -> str:
    """Return a readable label while preserving malformed RNS fields in raw."""
    short_name = raw.get("short_name")
    if isinstance(short_name, str):
        candidate = short_name.strip()
        has_controls = any(ord(character) < 32 or ord(character) == 127 for character in candidate)
        if candidate and candidate.lower() not in {"none", "null"} and not has_controls:
            return candidate

    detail_match = re.search(r"\[([^\]]+)\]$", full_name)
    detail = detail_match.group(1) if detail_match else full_name
    interface_type = str(raw.get("type") or "Interface")
    if interface_type == "LocalClientInterface":
        return "Local client\n" + detail
    if interface_type == "AutoInterfacePeer":
        device, separator, endpoint = detail.partition("/")
        suffix = _compact_endpoint(endpoint) if separator else _compact_endpoint(detail)
        return "Auto peer " + device + ("\n" + suffix if suffix else "")
    return _compact_endpoint(detail, 30)


def _default_runner(command: list[str], timeout: float) -> subprocess.CompletedProcess[str]:
    # No shell is used: command configuration cannot turn collection into an
    # arbitrary shell pipeline, and neither command can modify RNS state.
    return subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False)


class LiveRNSProvider:
    """Poll rnstatus/rnpath and expose a stable, frontend-neutral graph model."""

    def __init__(
        self,
        *,
        label: str | None = None,
        timeout: float | None = None,
        runner: CommandRunner | None = None,
        rnstatus_path: str | None = None,
        rnpath_path: str | None = None,
        config_dir: str | None = None,
        announce_capture: AnnounceCapture | None = None,
    ) -> None:
        self.label = label or config.LIVE_RNS_LABEL
        self.timeout = timeout if timeout is not None else config.LIVE_RNS_TIMEOUT
        self.runner = runner or _default_runner
        self.rnstatus_path = rnstatus_path or config.RNSTATUS_PATH
        self.rnpath_path = rnpath_path or config.RNPATH_PATH
        self.config_dir = config_dir if config_dir is not None else config.LIVE_RNS_CONFIG_DIR
        self.announce_capture = announce_capture
        self._lock = threading.Lock()
        self._last_status: dict[str, Any] | None = None
        self._last_paths: list[dict[str, Any]] | None = None
        self._last_discovered: list[dict[str, Any]] | None = None
        self._registered_services: dict[str, dict[str, Any]] = {}
        self._state = self._empty_state()

    def register_local_service(self, service: dict[str, Any]) -> None:
        """Add an application-owned destination to local service enrichment."""
        destination_hash = str(service.get("destination_hash") or "").lower()
        if not destination_hash:
            raise ValueError("local service requires a destination hash")
        with self._lock:
            self._registered_services[destination_hash] = dict(service)

    def _empty_state(self) -> dict[str, Any]:
        return {
            "mode": "live_rns",
            "collected_at": None,
            "stale": True,
            "root": {"id": "instance:local", "label": self.label, "transport_id": None},
            "interfaces": [],
            "transports": [],
            "destinations": [],
            "rmap_interfaces": [],
            "local_services": [],
            "announces": {"version": 1, "active": False, "events": []},
            "edges": [],
            "health": {
                "rnstatus": {"ok": False, "error": "not collected yet"},
                "rnpath": {"ok": False, "error": "not collected yet"},
                "rmap": {"ok": False, "error": "not collected yet"},
                "services": {"ok": True, "error": None},
                "announces": {"ok": True, "error": None},
            },
        }

    def _command(self, tool: str, *arguments: str) -> list[str]:
        command = [tool, *arguments]
        if self.config_dir:
            command.extend(["--config", self.config_dir])
        return command

    def _read_json(self, command: list[str]) -> tuple[Any | None, dict[str, Any]]:
        started = time.monotonic()
        try:
            result = self.runner(command, self.timeout)
        except subprocess.TimeoutExpired:
            return None, {"ok": False, "error": f"timed out after {self.timeout:g}s"}
        except Exception as exc:
            return None, {"ok": False, "error": str(exc)}

        elapsed_ms = round((time.monotonic() - started) * 1000)
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "no diagnostic output").strip()
            return None, {
                "ok": False,
                "error": f"exit {result.returncode}: {detail[:300]}",
                "duration_ms": elapsed_ms,
            }
        try:
            parsed = json.loads(result.stdout)
        except (json.JSONDecodeError, TypeError) as exc:
            return None, {
                "ok": False,
                "error": f"invalid JSON: {exc}",
                "duration_ms": elapsed_ms,
            }
        return parsed, {"ok": True, "error": None, "duration_ms": elapsed_ms}

    def collect(self) -> dict[str, Any]:
        """Collect both sources; retain each source's last good value on failure."""
        status, status_health = self._read_json(self._command(self.rnstatus_path, "-j"))
        if status_health["ok"]:
            paths, path_health = self._read_json(self._command(self.rnpath_path, "-t", "-j"))
            discovered, rmap_health = self._read_json(
                self._command(self.rnstatus_path, "-d", "-j")
            )
        else:
            # Unlike rnstatus, rnpath can create a standalone RNS instance when
            # no shared daemon exists. Do not let an observational poller claim
            # the shared-instance socket during daemon startup or maintenance.
            paths = None
            discovered = None
            path_health = {
                "ok": False,
                "error": "skipped because rnstatus could not reach the shared instance",
            }
            rmap_health = {
                "ok": False,
                "error": "skipped because rnstatus could not reach the shared instance",
            }

        if status_health["ok"]:
            if (
                not isinstance(status, dict)
                or not isinstance(status.get("interfaces", []), list)
                or not all(isinstance(item, dict) for item in status.get("interfaces", []))
            ):
                status_health = {"ok": False, "error": "expected a JSON object with a list of interface objects"}
            else:
                self._last_status = status
        if path_health["ok"]:
            if not isinstance(paths, list) or not all(isinstance(item, dict) for item in paths):
                path_health = {"ok": False, "error": "expected a JSON array of path objects"}
            else:
                self._last_paths = paths
        if rmap_health["ok"]:
            if not isinstance(discovered, list) or not all(isinstance(item, dict) for item in discovered):
                rmap_health = {"ok": False, "error": "expected a JSON array of discovered interface objects"}
            else:
                self._last_discovered = discovered

        try:
            local_services, service_errors = discover_local_services(self._last_status or {})
        except Exception as exc:
            # Service enrichment must never interrupt the core rnstatus/rnpath
            # observation loop.
            local_services, service_errors = [], [str(exc)]
        with self._lock:
            registered_services = list(self._registered_services.values())
        services_by_hash = {
            str(service.get("destination_hash") or "").lower(): service
            for service in local_services + registered_services
            if service.get("destination_hash")
        }
        local_services = list(services_by_hash.values())
        service_health = {
            "ok": not service_errors,
            "error": "; ".join(service_errors) if service_errors else None,
        }

        normalized = self.normalize(
            self._last_status or {"interfaces": []},
            self._last_paths or [],
            label=self.label,
            discovered=self._last_discovered or [],
            local_services=local_services,
        )
        if self.announce_capture is not None:
            announce_state = self.announce_capture.snapshot()
            paths_by_hash = {
                str(path.get("hash") or "").lower(): path
                for path in (self._last_paths or []) if path.get("hash")
            }
            enriched_events = []
            for event in announce_state.get("events", []):
                path = paths_by_hash.get(str(event.get("destination_hash") or "").lower())
                enriched_events.append({
                    **event,
                    **({
                        "route_hops": _as_int(path.get("hops")),
                        "route_via": path.get("via"),
                        "route_interface": path.get("interface"),
                    } if path else {}),
                })
            announce_state["events"] = enriched_events
            normalized["announces"] = announce_state
            announce_health = {
                "ok": bool(announce_state.get("active")),
                "error": announce_state.get("error"),
            }
        else:
            normalized["announces"] = {"version": 1, "active": False, "events": []}
            announce_health = {"ok": True, "error": None}
        normalized["collected_at"] = time.time()
        normalized["stale"] = not (status_health["ok"] and path_health["ok"])
        normalized["health"] = {
            "rnstatus": status_health,
            "rnpath": path_health,
            "rmap": rmap_health,
            "services": service_health,
            "announces": announce_health,
        }
        with self._lock:
            self._state = normalized
            return dict(normalized)

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            # JSON round-tripping provides a small and safe deep copy for API use.
            return json.loads(json.dumps(self._state))

    def topology_snapshot(
        self, *, include_paths: bool = False, include_rmap: bool = False,
        include_announces: bool = False,
    ) -> dict[str, Any]:
        """Return the observed graph, omitting path-table fan-out by default.

        The complete path table remains available on explicit request, but it is
        not part of the default topology payload. This also prevents older open
        browser tabs from rebuilding thousands of destination nodes.
        """
        return topology_snapshot(
            self.snapshot(), include_paths=include_paths, include_rmap=include_rmap,
            include_announces=include_announces,
        )

    @staticmethod
    def normalize(
        status: dict[str, Any],
        paths: list[dict[str, Any]],
        *,
        label: str,
        discovered: list[dict[str, Any]] | None = None,
        local_services: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Normalize RNS JSON without asserting topology RNS did not report."""
        transport_id = status.get("transport_id")
        root_id = f"instance:{transport_id}" if transport_id else "instance:local"
        root = {
            "id": root_id,
            "label": label,
            "transport_id": transport_id,
            # Preserve new RNS telemetry that the normalized schema does not
            # understand yet, without duplicating the (potentially large)
            # interface list on every node.
            "raw": {key: value for key, value in status.items() if key != "interfaces"},
        }

        interfaces: list[dict[str, Any]] = []
        interface_by_name: dict[str, dict[str, Any]] = {}
        interface_by_hash: dict[str, dict[str, Any]] = {}
        interface_by_id: dict[str, dict[str, Any]] = {}
        edges: list[dict[str, Any]] = []
        for raw in status.get("interfaces", []):
            name = str(raw.get("name") or raw.get("short_name") or "Unnamed interface")
            interface_hash = raw.get("hash")
            fragment = str(interface_hash) if interface_hash else _stable_fragment(name)
            remote_host, remote_port = _endpoint_from_interface(raw)
            item = {
                "id": f"interface:{fragment}",
                "name": name,
                "short_name": raw.get("short_name"),
                "display_name": _interface_display_name(raw, name),
                "interface_hash": interface_hash,
                "type": raw.get("type"),
                "mode": _interface_mode(raw.get("mode")),
                "status": raw.get("status"),
                "bitrate": raw.get("bitrate"),
                "mtu": raw.get("mtu"),
                "peers": raw.get("peers"),
                "rxb": raw.get("rxb"),
                "txb": raw.get("txb"),
                "remote_host": remote_host,
                "remote_port": remote_port,
                "i2p_b32": raw.get("i2p_b32"),
                "parent_interface_name": raw.get("parent_interface_name"),
                "parent_interface_hash": raw.get("parent_interface_hash"),
                "parent_interface_id": None,
                "path_only": False,
                "raw": raw,
            }
            existing = interface_by_id.get(item["id"])
            if existing is not None:
                # Some shared-instance status responses can repeat the same
                # concrete interface. Merge complementary fields into one
                # graph object and retain every raw observation for diagnosis.
                observations = existing.setdefault("raw_observations", [existing["raw"]])
                observations.append(raw)
                for key, value in item.items():
                    if key not in {"id", "raw", "raw_observations"} and (
                        existing.get(key) is None or existing.get(key) == ""
                    ) and value is not None and value != "":
                        existing[key] = value
                interface_by_name[name] = existing
                continue
            interfaces.append(item)
            interface_by_id[item["id"]] = item
            interface_by_name[name] = item
            if interface_hash:
                interface_by_hash[str(interface_hash).lower()] = item

        # Spawned peer interfaces are real interfaces, but RNS explicitly
        # reports their owning parent. Preserve that hierarchy instead of
        # incorrectly drawing every peer as a direct child of the instance.
        for item in interfaces:
            parent_hash = item.get("parent_interface_hash")
            parent_name = item.get("parent_interface_name")
            parent = None
            if parent_hash:
                parent = interface_by_hash.get(str(parent_hash).lower())
            if parent is None and parent_name:
                parent = interface_by_name.get(str(parent_name))
            source_id = root_id
            edge_kind = "observed_interface"
            if parent is not None and parent["id"] != item["id"]:
                item["parent_interface_id"] = parent["id"]
                source_id = parent["id"]
                edge_kind = "observed_peer_interface"
            edges.append({
                "id": f"edge:{source_id}:{item['id']}",
                "source": source_id,
                "target": item["id"],
                "kind": edge_kind,
                "certainty": "observed",
            })

        services = local_services or []
        service_by_hash = {
            str(service.get("destination_hash") or "").lower(): service
            for service in services
            if service.get("destination_hash")
        }
        transports: dict[str, dict[str, Any]] = {}
        destinations: dict[str, dict[str, Any]] = {}
        for raw in paths:
            destination_hash = raw.get("hash")
            if not destination_hash:
                continue
            interface_name = str(raw.get("interface") or "Unknown interface")
            interface = interface_by_name.get(interface_name)
            if interface is None:
                # A path entry is still evidence that an interface name existed.
                interface = {
                    "id": f"interface:path:{_stable_fragment(interface_name)}",
                    "name": interface_name,
                    "short_name": None,
                    "interface_hash": None,
                    "type": None,
                    "mode": None,
                    "status": None,
                    "bitrate": None,
                    "mtu": None,
                    "peers": None,
                    "rxb": None,
                    "txb": None,
                    "path_only": True,
                    "raw": {"name": interface_name, "source": "rnpath"},
                }
                interfaces.append(interface)
                interface_by_name[interface_name] = interface
                edges.append({
                    "id": f"edge:{root_id}:{interface['id']}",
                    "source": root_id,
                    "target": interface["id"],
                    "kind": "observed_interface",
                    "certainty": "observed",
                })

            destination_id = f"destination:{destination_hash}"
            hops = _as_int(raw.get("hops"))
            is_local = hops == 0
            reported_via = raw.get("via")
            # When an announce has no transport header, RNS stores the
            # destination hash itself as `via`. It is directly heard, not a
            # separate next-hop router. This occurs for one-hop paths as well
            # as destinations local to the shared instance.
            next_hop = None if reported_via == destination_hash else reported_via
            destination = {
                "id": destination_id,
                "hash": destination_hash,
                "hops": hops,
                "via": next_hop,
                "interface_id": interface["id"],
                "interface": interface_name,
                "timestamp": raw.get("timestamp"),
                "expires": raw.get("expires"),
                "local": is_local,
                "local_service": service_by_hash.get(str(destination_hash).lower()),
                "raw": raw,
            }
            destinations[destination_id] = destination

            via = next_hop
            if via:
                transport_key = str(via)
                transport = transports.get(transport_key)
                if transport is None:
                    transport = {
                        "id": f"transport:{via}",
                        "hash": via,
                        "interface_ids": [],
                    }
                    transports[transport_key] = transport
                if interface["id"] not in transport["interface_ids"]:
                    transport["interface_ids"].append(interface["id"])
                    edges.append({
                        "id": f"edge:{interface['id']}:{transport['id']}",
                        "source": interface["id"],
                        "target": transport["id"],
                        "kind": "observed_next_hop",
                        "certainty": "observed",
                    })
                source_id = transport["id"]
            else:
                source_id = interface["id"]

            unknown_hops = max(0, hops - 1) if hops is not None else None
            edges.append({
                "id": f"edge:{source_id}:{destination_id}",
                "source": source_id,
                "target": destination_id,
                "kind": "known_path",
                "certainty": "incomplete" if unknown_hops or hops is None else "observed",
                "hops": hops,
                "unknown_hops": unknown_hops,
            })

        rmap_interfaces = []
        for raw in discovered or []:
            transport_id = raw.get("transport_id")
            discovery_hash = raw.get("discovery_hash")
            if not transport_id or not discovery_hash:
                continue
            rmap_interfaces.append({
                "id": f"rmap-interface:{discovery_hash}",
                "discovery_hash": discovery_hash,
                "transport_id": transport_id,
                "name": raw.get("name") or "Discovered interface",
                "type": raw.get("type"),
                "status": raw.get("status"),
                "hops": _as_int(raw.get("hops")),
                "last_heard": raw.get("last_heard"),
                "latitude": raw.get("latitude"),
                "longitude": raw.get("longitude"),
                "height": raw.get("height"),
                "reachable_on": raw.get("reachable_on"),
                "port": raw.get("port"),
                "frequency": raw.get("frequency"),
                "bandwidth": raw.get("bandwidth"),
                "raw": raw,
            })

        return {
            "mode": "live_rns",
            "collected_at": None,
            "stale": False,
            "root": root,
            "interfaces": interfaces,
            "transports": list(transports.values()),
            "destinations": list(destinations.values()),
            "rmap_interfaces": rmap_interfaces,
            "local_services": services,
            "edges": edges,
            "health": {},
        }
