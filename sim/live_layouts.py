"""Persistent named layouts for stable-ID live topology graphs."""

from __future__ import annotations

import json
import math
import os
import re
import tempfile
import threading
import time
from pathlib import Path
from typing import Any


LAYOUT_NAME_PATTERN = re.compile(r"^[A-Za-z0-9._ -]{1,64}$")
SCOPE_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
MAX_LAYOUT_NODES = 20_000


def _validate_key(value: str, pattern: re.Pattern[str], kind: str) -> str:
    if not pattern.fullmatch(value):
        raise ValueError(f"invalid live layout {kind}")
    return value


def validate_layout(scope: str, name: str, layout: Any) -> dict[str, Any]:
    _validate_key(scope, SCOPE_PATTERN, "scope")
    _validate_key(name, LAYOUT_NAME_PATTERN, "name")
    if not isinstance(layout, dict):
        raise ValueError("live layout must be an object")
    raw_positions = layout.get("positions", {})
    if not isinstance(raw_positions, dict) or len(raw_positions) > MAX_LAYOUT_NODES:
        raise ValueError("live layout positions must be an object of reasonable size")
    positions: dict[str, dict[str, float]] = {}
    for node_id, position in raw_positions.items():
        if not isinstance(node_id, str) or not node_id or len(node_id) > 512:
            raise ValueError("invalid live layout node ID")
        if not isinstance(position, dict):
            raise ValueError("invalid live layout position")
        try:
            x, y = float(position["x"]), float(position["y"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError("invalid live layout position") from exc
        if not math.isfinite(x) or not math.isfinite(y):
            raise ValueError("live layout positions must be finite")
        positions[node_id] = {"x": x, "y": y}
    raw_pinned = layout.get("pinned", [])
    if not isinstance(raw_pinned, list) or not all(
        isinstance(node_id, str) and node_id in positions for node_id in raw_pinned
    ):
        raise ValueError("live layout pinned IDs must reference saved positions")
    viewport = layout.get("viewport")
    normalized_viewport = None
    if viewport is not None:
        try:
            zoom = float(viewport["zoom"])
            pan_x = float(viewport["pan"]["x"])
            pan_y = float(viewport["pan"]["y"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError("invalid live layout viewport") from exc
        if not all(math.isfinite(value) for value in (zoom, pan_x, pan_y)) or zoom <= 0:
            raise ValueError("invalid live layout viewport")
        normalized_viewport = {"zoom": zoom, "pan": {"x": pan_x, "y": pan_y}}
    return {
        "version": 1,
        "scope": scope,
        "name": name,
        "positions": positions,
        "pinned": sorted(set(raw_pinned)),
        "viewport": normalized_viewport,
        "updated_at": time.time(),
    }


class LiveLayoutStore:
    """Thread-safe JSON store with atomic replacement on every mutation."""

    def __init__(self, path: str | os.PathLike[str]) -> None:
        self.path = Path(path)
        self._lock = threading.Lock()

    def list(self, scope: str) -> list[dict[str, Any]]:
        _validate_key(scope, SCOPE_PATTERN, "scope")
        with self._lock:
            layouts = self._read().get("layouts", {}).get(scope, {})
            result = [
                {
                    "name": name,
                    "scope": scope,
                    "updated_at": layout.get("updated_at"),
                    "node_count": len(layout.get("positions", {})),
                    "pinned_count": len(layout.get("pinned", [])),
                }
                for name, layout in layouts.items()
                if name != "__autosave__"
            ]
        return sorted(result, key=lambda item: item["name"].lower())

    def get(self, scope: str, name: str) -> dict[str, Any] | None:
        _validate_key(scope, SCOPE_PATTERN, "scope")
        _validate_key(name, LAYOUT_NAME_PATTERN, "name")
        with self._lock:
            layout = self._read().get("layouts", {}).get(scope, {}).get(name)
            return json.loads(json.dumps(layout)) if layout is not None else None

    def save(self, scope: str, name: str, layout: Any) -> dict[str, Any]:
        normalized = validate_layout(scope, name, layout)
        with self._lock:
            document = self._read()
            document.setdefault("version", 1)
            scoped_layouts = document.setdefault("layouts", {}).setdefault(scope, {})
            existing = scoped_layouts.get(name, {})
            existing_positions = existing.get("positions", {})
            retained_pins = set(normalized["pinned"])
            for node_id in existing.get("pinned", []):
                # Omitted means not currently visible. A visible intentional
                # unpin still submits the node's position without its ID in
                # the pinned list, and therefore does not enter this branch.
                if node_id not in normalized["positions"] and node_id in existing_positions:
                    normalized["positions"][node_id] = existing_positions[node_id]
                    retained_pins.add(node_id)
            if len(normalized["positions"]) > MAX_LAYOUT_NODES:
                raise ValueError("live layout positions must be an object of reasonable size")
            normalized["pinned"] = sorted(retained_pins)
            scoped_layouts[name] = normalized
            self._write(document)
        return json.loads(json.dumps(normalized))

    def _read(self) -> dict[str, Any]:
        if not self.path.exists():
            return {"version": 1, "layouts": {}}
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ValueError(f"could not read live layouts: {exc}") from exc
        if not isinstance(value, dict) or not isinstance(value.get("layouts", {}), dict):
            raise ValueError("invalid live layout store")
        return value

    def _write(self, document: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(
            prefix=self.path.name + ".", suffix=".tmp", dir=self.path.parent
        )
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                json.dump(document, output, indent=2, sort_keys=True)
                output.write("\n")
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
