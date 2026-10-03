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


def topology_snapshot(
    source: dict[str, Any], *, include_paths: bool = False, include_rmap: bool = False
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
    if not include_paths:
        local_destination_ids = {
            item["id"] for item in service_destinations if item.get("id")
        }
        state["destinations"] = service_destinations
        state["edges"] = [
            edge for edge in state.get("edges", [])
            if edge.get("kind") != "known_path" or edge.get("target") in local_destination_ids
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
    ) -> None:
        self.label = label or config.LIVE_RNS_LABEL
        self.timeout = timeout if timeout is not None else config.LIVE_RNS_TIMEOUT
        self.runner = runner or _default_runner
        self.rnstatus_path = rnstatus_path or config.RNSTATUS_PATH
        self.rnpath_path = rnpath_path or config.RNPATH_PATH
        self.config_dir = config_dir if config_dir is not None else config.LIVE_RNS_CONFIG_DIR
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
            "edges": [],
            "health": {
                "rnstatus": {"ok": False, "error": "not collected yet"},
                "rnpath": {"ok": False, "error": "not collected yet"},
                "rmap": {"ok": False, "error": "not collected yet"},
                "services": {"ok": True, "error": None},
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
        normalized["collected_at"] = time.time()
        normalized["stale"] = not (status_health["ok"] and path_health["ok"])
        normalized["health"] = {
            "rnstatus": status_health,
            "rnpath": path_health,
            "rmap": rmap_health,
            "services": service_health,
        }
        with self._lock:
            self._state = normalized
            return dict(normalized)

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            # JSON round-tripping provides a small and safe deep copy for API use.
            return json.loads(json.dumps(self._state))

    def topology_snapshot(
        self, *, include_paths: bool = False, include_rmap: bool = False
    ) -> dict[str, Any]:
        """Return the observed graph, omitting path-table fan-out by default.

        The complete path table remains available on explicit request, but it is
        not part of the default topology payload. This also prevents older open
        browser tabs from rebuilding thousands of destination nodes.
        """
        return topology_snapshot(
            self.snapshot(), include_paths=include_paths, include_rmap=include_rmap
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
            if item["id"] in interface_by_id:
                # Some shared-instance status responses can repeat the same
                # concrete interface. Its stable hash identifies one graph
                # object, so do not emit duplicate nodes or edges.
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
