"""Authenticated topology report delivery over native Reticulum links."""

from __future__ import annotations

import gzip
import io
import json
import os
import threading
import time
from pathlib import Path
from typing import Any

import RNS

from .live_reports import LiveReportRegistry, validate_reporter_id, validate_snapshot


APP_NAME = "reticulated"
DESTINATION_ASPECTS = ("topology", "ingest")
REQUEST_PATH = "/report/v1"
PROTOCOL_VERSION = 1
DEFAULT_MAX_BYTES = 16 * 1024 * 1024


def encode_report(reporter_id: str, label: str, snapshot: dict[str, Any]) -> dict[str, Any]:
    """Build the MessagePack-safe envelope passed to ``Link.request``."""
    validate_reporter_id(reporter_id)
    validate_snapshot(snapshot)
    payload = json.dumps(
        snapshot, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")
    return {
        "version": PROTOCOL_VERSION,
        "reporter_id": reporter_id,
        "label": str(label)[:128],
        "sent_at": time.time(),
        "encoding": "gzip-json",
        "payload": gzip.compress(payload, compresslevel=6),
    }


def decode_report(
    envelope: Any, *, max_bytes: int = DEFAULT_MAX_BYTES
) -> tuple[str, dict[str, Any]]:
    """Decode a bounded report envelope and return its claimed ID and snapshot."""
    if not isinstance(envelope, dict):
        raise ValueError("report envelope must be an object")
    if envelope.get("version") != PROTOCOL_VERSION:
        raise ValueError("unsupported report protocol version")
    if envelope.get("encoding") != "gzip-json":
        raise ValueError("unsupported report encoding")
    reporter_id = validate_reporter_id(str(envelope.get("reporter_id") or ""))
    payload = envelope.get("payload")
    if not isinstance(payload, bytes):
        raise ValueError("report payload must be bytes")
    if len(payload) > max_bytes:
        raise ValueError("compressed report is too large")
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(payload)) as source:
            raw = source.read(max_bytes + 1)
    except (OSError, EOFError) as exc:
        raise ValueError("invalid gzip report") from exc
    if len(raw) > max_bytes:
        raise ValueError("uncompressed report is too large")
    try:
        snapshot = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ValueError("invalid JSON report") from exc
    return reporter_id, validate_snapshot(snapshot)


def load_allowlist(path: str | os.PathLike[str]) -> dict[str, dict[str, str]]:
    """Load identity-hash to reporter-ID bindings from JSON."""
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"could not load reporter allowlist: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError("reporter allowlist must be a JSON object")
    result: dict[str, dict[str, str]] = {}
    for raw_hash, raw_entry in value.items():
        identity_hash = str(raw_hash).lower()
        try:
            identity_bytes = bytes.fromhex(identity_hash)
        except ValueError as exc:
            raise ValueError(f"invalid reporter identity hash: {raw_hash}") from exc
        if len(identity_bytes) != RNS.Reticulum.TRUNCATED_HASHLENGTH // 8:
            raise ValueError(f"invalid reporter identity hash: {raw_hash}")
        if isinstance(raw_entry, str):
            reporter_id, label = raw_entry, raw_entry
        elif isinstance(raw_entry, dict):
            reporter_id = raw_entry.get("reporter_id")
            label = raw_entry.get("label") or reporter_id
        else:
            raise ValueError(f"invalid allowlist entry for {raw_hash}")
        reporter_id = validate_reporter_id(str(reporter_id or ""))
        result[identity_hash] = {"reporter_id": reporter_id, "label": str(label)[:128]}
    return result


def load_or_create_identity(path: str | os.PathLike[str]) -> RNS.Identity:
    """Load a stable RNS identity, creating it with private permissions if absent."""
    identity_path = Path(path)
    if identity_path.exists():
        identity = RNS.Identity.from_file(str(identity_path))
        if identity is None:
            raise ValueError(f"invalid RNS identity file: {identity_path}")
        return identity
    identity_path.parent.mkdir(parents=True, exist_ok=True)
    identity = RNS.Identity()
    if not identity.to_file(str(identity_path)):
        raise OSError(f"could not write RNS identity: {identity_path}")
    identity_path.chmod(0o600)
    return identity


class RNSReportListener:
    """Receive authenticated reports on an allowlisted RNS destination."""

    def __init__(
        self,
        registry: LiveReportRegistry,
        *,
        identity_path: str,
        allowlist_path: str,
        local_reporter_id: str,
        config_dir: str | None = None,
        max_bytes: int = DEFAULT_MAX_BYTES,
        announce_interval: float = 300.0,
    ) -> None:
        self.registry = registry
        self.identity_path = identity_path
        self.allowlist_path = allowlist_path
        self.local_reporter_id = local_reporter_id
        self.config_dir = config_dir
        self.max_bytes = max_bytes
        self.announce_interval = announce_interval
        self.destination: RNS.Destination | None = None
        self.identity: RNS.Identity | None = None
        self.allowlist: dict[str, dict[str, str]] = {}
        self._stop = threading.Event()

    @property
    def destination_hash(self) -> str | None:
        return self.destination.hash.hex() if self.destination is not None else None

    def start(self) -> str:
        self.allowlist = load_allowlist(self.allowlist_path)
        if any(
            entry["reporter_id"] == self.local_reporter_id
            for entry in self.allowlist.values()
        ):
            raise ValueError("the local reporter ID cannot appear in the RNS allowlist")
        RNS.Reticulum(configdir=self.config_dir, require_shared_instance=True)
        self.identity = load_or_create_identity(self.identity_path)
        self.destination = RNS.Destination(
            self.identity,
            RNS.Destination.IN,
            RNS.Destination.SINGLE,
            APP_NAME,
            *DESTINATION_ASPECTS,
        )
        # The RNS request includes MessagePack envelope overhead in addition to
        # the bounded compressed payload checked by ``decode_report``.
        self.destination.set_max_request_size(self.max_bytes + 64 * 1024)
        self.destination.register_request_handler(
            REQUEST_PATH,
            response_generator=self._handle_report,
            allow=RNS.Destination.ALLOW_LIST,
            allowed_list=[bytes.fromhex(value) for value in self.allowlist],
            auto_compress=True,
        )
        self.destination.announce(app_data=b"Reticulated topology ingest v1")
        if self.announce_interval > 0:
            threading.Thread(target=self._announce_loop, daemon=True).start()
        return self.destination_hash or ""

    def stop(self) -> None:
        self._stop.set()

    def service_info(self) -> dict[str, Any] | None:
        if self.destination_hash is None:
            return None
        return {
            "destination_hash": self.destination_hash,
            "name": "Reticulated topology ingest",
            "type": "reticulated_topology_ingest",
            "discovered_by": "application",
        }

    def _announce_loop(self) -> None:
        while not self._stop.wait(self.announce_interval):
            if self.destination is not None:
                self.destination.announce(app_data=b"Reticulated topology ingest v1")

    def _handle_report(
        self,
        path: str,
        data: Any,
        request_id: bytes,
        link_id: bytes,
        remote_identity: RNS.Identity,
        requested_at: float,
    ) -> dict[str, Any]:
        del path, request_id, link_id, requested_at
        try:
            identity_hash = remote_identity.hash.hex()
            enrollment = self.allowlist.get(identity_hash)
            if enrollment is None:
                raise ValueError("reporter identity is not enrolled")
            reporter_id, snapshot = decode_report(data, max_bytes=self.max_bytes)
            if reporter_id != enrollment["reporter_id"]:
                raise ValueError("reporter ID does not match enrolled identity")
            self.registry.update(reporter_id, snapshot)
            return {
                "ok": True,
                "version": PROTOCOL_VERSION,
                "reporter_id": reporter_id,
                "received_at": time.time(),
            }
        except (AttributeError, ValueError) as exc:
            return {"ok": False, "version": PROTOCOL_VERSION, "error": str(exc)[:256]}


async def start_report_listener(listener: RNSReportListener) -> str:
    """Start an RNS listener on the event-loop thread.

    RNS installs process signal handlers while constructing ``Reticulum``.  The
    normal Uvicorn lifespan runs on the main thread, so this deliberately calls
    ``start()`` inline instead of dispatching it through ``asyncio.to_thread``.
    Listener traffic and periodic announces remain managed by RNS/background
    threads after this short, startup-only initialization step.
    """
    return listener.start()


class RNSReportClient:
    """Maintain an authenticated RNS link and send complete topology snapshots."""

    def __init__(
        self,
        *,
        destination_hash: str,
        identity_path: str,
        config_dir: str | None = None,
        timeout: float = 45.0,
    ) -> None:
        try:
            self.destination_hash = bytes.fromhex(destination_hash)
        except ValueError as exc:
            raise ValueError("invalid ingest destination hash") from exc
        if len(self.destination_hash) != RNS.Reticulum.TRUNCATED_HASHLENGTH // 8:
            raise ValueError("invalid ingest destination hash")
        self.timeout = timeout
        self.identity_path = identity_path
        self.config_dir = config_dir
        self.identity: RNS.Identity | None = None
        self.link: RNS.Link | None = None
        self._reticulum: RNS.Reticulum | None = None

    @property
    def identity_hash(self) -> str | None:
        return self.identity.hash.hex() if self.identity is not None else None

    def start(self) -> str:
        self._reticulum = RNS.Reticulum(
            configdir=self.config_dir, require_shared_instance=True
        )
        self.identity = load_or_create_identity(self.identity_path)
        return self.identity_hash or ""

    def send_report(
        self, reporter_id: str, label: str, snapshot: dict[str, Any]
    ) -> dict[str, Any]:
        if self.identity is None:
            self.start()
        link = self._ensure_link()
        envelope = encode_report(reporter_id, label, snapshot)
        complete = threading.Event()
        result: dict[str, Any] = {}

        def succeeded(receipt: RNS.RequestReceipt) -> None:
            result["response"] = receipt.response
            complete.set()

        def failed(receipt: RNS.RequestReceipt) -> None:
            del receipt
            result["error"] = "RNS report request failed or timed out"
            complete.set()

        receipt = link.request(
            REQUEST_PATH,
            data=envelope,
            response_callback=succeeded,
            failed_callback=failed,
            timeout=self.timeout,
            max_response_size=64 * 1024,
        )
        if receipt is False:
            raise OSError("RNS report request could not be sent")
        if not complete.wait(self.timeout + 2):
            raise TimeoutError("timed out waiting for RNS report response")
        if "error" in result:
            raise OSError(result["error"])
        response = result.get("response")
        if not isinstance(response, dict) or not response.get("ok"):
            detail = response.get("error") if isinstance(response, dict) else "invalid response"
            raise ValueError(f"RNS report rejected: {detail}")
        return response

    def _ensure_link(self) -> RNS.Link:
        if self.link is not None and self.link.status == RNS.Link.ACTIVE:
            return self.link
        deadline = time.monotonic() + self.timeout
        if not RNS.Transport.has_path(self.destination_hash):
            RNS.Transport.request_path(self.destination_hash)
            while not RNS.Transport.has_path(self.destination_hash):
                if time.monotonic() >= deadline:
                    raise TimeoutError("path to ingest destination was not found")
                time.sleep(0.1)
        remote_identity = RNS.Identity.recall(self.destination_hash)
        if remote_identity is None:
            raise ValueError("ingest destination identity could not be recalled")
        destination = RNS.Destination(
            remote_identity,
            RNS.Destination.OUT,
            RNS.Destination.SINGLE,
            APP_NAME,
            *DESTINATION_ASPECTS,
        )
        if destination.hash != self.destination_hash:
            raise ValueError("recalled identity does not match ingest destination")
        established = threading.Event()
        failed = threading.Event()
        link = RNS.Link(
            destination,
            established_callback=lambda active_link: established.set(),
            closed_callback=lambda closed_link: failed.set(),
        )
        remaining = max(0.1, deadline - time.monotonic())
        established.wait(remaining)
        if link.status != RNS.Link.ACTIVE or failed.is_set():
            raise TimeoutError("could not establish link to ingest destination")
        assert self.identity is not None
        link.identify(self.identity)
        self.link = link
        return link
