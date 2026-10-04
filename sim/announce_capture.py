"""Bounded, read-only capture of announces received by a shared RNS instance."""

from __future__ import annotations

import base64
import hashlib
import threading
import time
from collections import deque
from typing import Any

import RNS


KNOWN_ASPECTS = (
    "rnstransport.discovery.interface",
    "rnstransport.probe",
    "reticulated.topology.ingest",
    "lxmf.delivery",
    "lxmf.propagation",
    "rnsh",
    "rns.id",
    "rncp.receive",
    "rnx.execute",
)


def _hex(value: Any) -> str | None:
    if isinstance(value, bytes):
        return value.hex()
    if hasattr(value, "hex"):
        try:
            return value.hex()
        except Exception:
            return None
    return None


def _classify_aspect(destination_hash: bytes, identity: RNS.Identity) -> str | None:
    for aspect in KNOWN_ASPECTS:
        try:
            expected = RNS.Destination.hash_from_name_and_identity(aspect, identity)
        except Exception:
            continue
        if expected == destination_hash:
            return aspect
    return None


def _text_preview(value: bytes) -> str | None:
    try:
        decoded = value.decode("utf-8")
    except UnicodeDecodeError:
        return None
    if not decoded:
        return ""
    printable = sum(character.isprintable() or character in "\r\n\t" for character in decoded)
    return decoded if printable / len(decoded) >= 0.9 else None


class _AnnounceHandler:
    aspect_filter = None
    receive_path_responses = True

    def __init__(self, owner: "AnnounceCapture") -> None:
        self.owner = owner

    def received_announce(
        self,
        destination_hash: bytes,
        announced_identity: RNS.Identity,
        app_data: bytes | None,
        announce_packet_hash: bytes,
        is_path_response: bool,
    ) -> None:
        self.owner.received_announce(
            destination_hash,
            announced_identity,
            app_data,
            announce_packet_hash,
            is_path_response,
        )


class AnnounceCapture:
    """Record bounded announce metadata without retaining unbounded payloads."""

    def __init__(
        self,
        *,
        config_dir: str | None = None,
        max_events: int = 2048,
        app_data_preview_bytes: int = 512,
    ) -> None:
        self.config_dir = config_dir
        self.max_events = max(1, max_events)
        self.app_data_preview_bytes = max(0, app_data_preview_bytes)
        self._events: deque[dict[str, Any]] = deque()
        self._event_ids: set[str] = set()
        self._lock = threading.Lock()
        self._handler = _AnnounceHandler(self)
        self._started_at: float | None = None
        self._error: str | None = None
        self._registered = False
        self._evicted = 0
        self._reticulum: RNS.Reticulum | None = None

    def start(self) -> bool:
        if self._registered:
            return True
        try:
            instance = RNS.Reticulum.get_instance()
            if instance is None:
                instance = RNS.Reticulum(
                    configdir=self.config_dir,
                    require_shared_instance=True,
                )
            self._reticulum = instance
            RNS.Transport.register_announce_handler(self._handler)
            self._registered = True
            self._started_at = time.time()
            self._error = None
            return True
        except Exception as exc:
            self._error = str(exc)
            return False

    def stop(self) -> None:
        if self._registered:
            try:
                RNS.Transport.deregister_announce_handler(self._handler)
            except Exception:
                pass
        self._registered = False

    def received_announce(
        self,
        destination_hash: bytes,
        announced_identity: RNS.Identity,
        app_data: bytes | None,
        announce_packet_hash: bytes | None,
        is_path_response: bool = False,
    ) -> None:
        received_at = time.time()
        destination_hex = _hex(destination_hash)
        identity_hex = _hex(getattr(announced_identity, "hash", None))
        if not destination_hex or not identity_hex:
            return
        payload = bytes(app_data) if isinstance(app_data, (bytes, bytearray)) else b""
        packet_hex = _hex(announce_packet_hash)
        event_id = packet_hex or hashlib.sha256(
            destination_hash + getattr(announced_identity, "hash", b"") + payload +
            str(time.time_ns()).encode("ascii")
        ).hexdigest()
        preview = payload[:self.app_data_preview_bytes]
        event = {
            "id": event_id,
            "received_at": received_at,
            "destination_hash": destination_hex,
            "identity_hash": identity_hex,
            "packet_hash": packet_hex,
            "aspect": _classify_aspect(destination_hash, announced_identity),
            "is_path_response": bool(is_path_response),
            "app_data_length": len(payload),
            "app_data_sha256": hashlib.sha256(payload).hexdigest() if payload else None,
            "app_data_preview_base64": base64.b64encode(preview).decode("ascii") if preview else None,
            "app_data_text": _text_preview(preview) if preview else None,
            "app_data_truncated": len(payload) > len(preview),
        }
        with self._lock:
            if event_id in self._event_ids:
                return
            if len(self._events) >= self.max_events:
                removed = self._events.popleft()
                self._event_ids.discard(removed["id"])
                self._evicted += 1
            self._events.append(event)
            self._event_ids.add(event_id)

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            events = [dict(event) for event in self._events]
            evicted = self._evicted
        return {
            "version": 1,
            "active": self._registered,
            "started_at": self._started_at,
            "captured_at": time.time(),
            "event_count": len(events),
            "evicted_count": evicted,
            "error": self._error,
            "events": events,
        }

    def status(self) -> dict[str, Any]:
        with self._lock:
            event_count = len(self._events)
            evicted = self._evicted
        return {
            "active": self._registered,
            "started_at": self._started_at,
            "event_count": event_count,
            "evicted_count": evicted,
            "error": self._error,
        }
