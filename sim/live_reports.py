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
