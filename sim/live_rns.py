"""Read-only collection and normalization of a local Reticulum instance."""

from __future__ import annotations

import hashlib
import json
import subprocess
import threading
import time
from collections.abc import Callable
from typing import Any

from . import config


CommandRunner = Callable[[list[str], float], Any]


def topology_snapshot(
    source: dict[str, Any], *, include_paths: bool = False, include_rmap: bool = False
) -> dict[str, Any]:
    """Project a full normalized report into the requested API representation."""
    state = json.loads(json.dumps(source))
    destinations = state.get("destinations", [])
    counts_by_transport: dict[str, int] = {}
    for destination in destinations:
        via = destination.get("via")
        if via:
            key = str(via)
            counts_by_transport[key] = counts_by_transport.get(key, 0) + 1
    state["path_summary"] = {
        "destination_count": len(destinations),
        "by_transport": counts_by_transport,
    }
    rmap_interfaces = state.get("rmap_interfaces", [])
    state["rmap_summary"] = {
        "interface_count": len(rmap_interfaces),
        "transport_count": len(
            {item.get("transport_id") for item in rmap_interfaces if item.get("transport_id")}
        ),
    }
    if not include_paths:
        state["destinations"] = []
        state["edges"] = [
            edge for edge in state.get("edges", []) if edge.get("kind") != "known_path"
        ]
    if not include_rmap:
        state["rmap_interfaces"] = []
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
        self._state = self._empty_state()

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
            "edges": [],
            "health": {
                "rnstatus": {"ok": False, "error": "not collected yet"},
                "rnpath": {"ok": False, "error": "not collected yet"},
                "rmap": {"ok": False, "error": "not collected yet"},
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

        normalized = self.normalize(
            self._last_status or {"interfaces": []},
            self._last_paths or [],
            label=self.label,
            discovered=self._last_discovered or [],
        )
        normalized["collected_at"] = time.time()
        normalized["stale"] = not (status_health["ok"] and path_health["ok"])
        normalized["health"] = {
            "rnstatus": status_health,
            "rnpath": path_health,
            "rmap": rmap_health,
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
        edges: list[dict[str, Any]] = []
        for raw in status.get("interfaces", []):
            name = str(raw.get("name") or raw.get("short_name") or "Unnamed interface")
            interface_hash = raw.get("hash")
            fragment = str(interface_hash) if interface_hash else _stable_fragment(name)
            item = {
                "id": f"interface:{fragment}",
                "name": name,
                "short_name": raw.get("short_name"),
                "interface_hash": interface_hash,
                "type": raw.get("type"),
                "mode": _interface_mode(raw.get("mode")),
                "status": raw.get("status"),
                "bitrate": raw.get("bitrate"),
                "mtu": raw.get("mtu"),
                "peers": raw.get("peers"),
                "rxb": raw.get("rxb"),
                "txb": raw.get("txb"),
                "path_only": False,
                "raw": raw,
            }
            interfaces.append(item)
            interface_by_name[name] = item
            edges.append({
                "id": f"edge:{root_id}:{item['id']}",
                "source": root_id,
                "target": item["id"],
                "kind": "observed_interface",
                "certainty": "observed",
            })

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
            "edges": edges,
            "health": {},
        }
