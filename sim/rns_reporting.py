"""Authenticated topology report delivery over native Reticulum links."""

from __future__ import annotations

import gzip
import hashlib
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
DEFAULT_MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024
DEFAULT_CHUNK_BYTES = 256 * 1024
DEFAULT_CHUNK_EXPANDED_BYTES = 8 * 1024 * 1024
MAX_REPORT_CHUNKS = 256
CHUNK_TTL = 300.0
MAX_INFLIGHT_TRANSFERS = 8
REPORT_TRANSFER_ATTEMPTS = 2


def encode_report(reporter_id: str, label: str, snapshot: dict[str, Any]) -> dict[str, Any]:
    """Build the MessagePack-safe envelope passed to ``Link.request``."""
    validate_reporter_id(reporter_id)
    validate_snapshot(snapshot)
    raw = json.dumps(
        snapshot, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")
    return {
        "version": PROTOCOL_VERSION,
        "reporter_id": reporter_id,
        "label": str(label)[:128],
        "sent_at": time.time(),
        "encoding": "gzip-json",
        "uncompressed_size": len(raw),
        "payload": gzip.compress(raw, compresslevel=6),
    }


def encode_report_chunks(
    reporter_id: str, label: str, snapshot: dict[str, Any], *,
    chunk_bytes: int = DEFAULT_CHUNK_BYTES,
) -> list[dict[str, Any]]:
    """Encode a report as one envelope or bounded pieces of one gzip stream."""
    if chunk_bytes < 1024:
        raise ValueError("report chunk size must be at least 1024 bytes")
    envelope = encode_report(reporter_id, label, snapshot)
    payload = envelope["payload"]
    expanded_size = int(envelope["uncompressed_size"])
    chunk_count = max(
        (len(payload) + chunk_bytes - 1) // chunk_bytes,
        (expanded_size + DEFAULT_CHUNK_EXPANDED_BYTES - 1) // DEFAULT_CHUNK_EXPANDED_BYTES,
    )
    if chunk_count <= 1:
        return [envelope]
    total = chunk_count
    if total > MAX_REPORT_CHUNKS:
        raise ValueError("compressed report requires too many chunks")
    slice_bytes = (len(payload) + total - 1) // total
    transfer_id = hashlib.sha256(payload).hexdigest()
    return [{
        "version": PROTOCOL_VERSION,
        "reporter_id": reporter_id,
        "label": str(label)[:128],
        "sent_at": envelope["sent_at"],
        "encoding": "gzip-json-chunk",
        "transfer_id": transfer_id,
        "chunk_index": index,
        "chunk_count": total,
        "compressed_size": len(payload),
        "uncompressed_size": expanded_size,
        "payload": payload[index * slice_bytes:(index + 1) * slice_bytes],
    } for index in range(total)]


def decode_report(
    envelope: Any, *, max_bytes: int = DEFAULT_MAX_BYTES,
    max_uncompressed_bytes: int | None = None,
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
    expanded_limit = max_bytes if max_uncompressed_bytes is None else max_uncompressed_bytes
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(payload)) as source:
            raw = source.read(expanded_limit + 1)
    except (OSError, EOFError) as exc:
        raise ValueError("invalid gzip report") from exc
    if len(raw) > expanded_limit:
        raise ValueError(
            f"uncompressed report is too large (limit {expanded_limit} bytes)"
        )
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
        max_uncompressed_bytes: int = DEFAULT_MAX_UNCOMPRESSED_BYTES,
        announce_interval: float = 300.0,
    ) -> None:
        self.registry = registry
        self.identity_path = identity_path
        self.allowlist_path = allowlist_path
        self.local_reporter_id = local_reporter_id
        self.config_dir = config_dir
        self.max_bytes = max_bytes
        self.max_uncompressed_bytes = max_uncompressed_bytes
        self.announce_interval = announce_interval
        self.destination: RNS.Destination | None = None
        self.identity: RNS.Identity | None = None
        self.allowlist: dict[str, dict[str, str]] = {}
        self._stop = threading.Event()
        self._chunk_lock = threading.Lock()
        self._chunk_transfers: dict[tuple[str, str], dict[str, Any]] = {}

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
            claimed_reporter_id = validate_reporter_id(str(
                data.get("reporter_id") if isinstance(data, dict) else ""
            ))
            if claimed_reporter_id != enrollment["reporter_id"]:
                raise ValueError("reporter ID does not match enrolled identity")
            if isinstance(data, dict) and data.get("encoding") == "gzip-json-chunk":
                reporter_id, snapshot, progress = self._accept_chunk(identity_hash, data)
            else:
                reporter_id, snapshot = decode_report(
                    data,
                    max_bytes=self.max_bytes,
                    max_uncompressed_bytes=self.max_uncompressed_bytes,
                )
                progress = None
            if reporter_id != claimed_reporter_id:
                raise ValueError("reporter ID does not match enrolled identity")
            if snapshot is None:
                return {
                    "ok": True,
                    "version": PROTOCOL_VERSION,
                    "reporter_id": reporter_id,
                    "complete": False,
                    "transfer_id": data.get("transfer_id"),
                    "chunk_index": data.get("chunk_index"),
                    **(progress or {}),
                }
            self.registry.update(reporter_id, snapshot)
            return {
                "ok": True,
                "version": PROTOCOL_VERSION,
                "reporter_id": reporter_id,
                "complete": True,
                "received_at": time.time(),
                **({
                    "transfer_id": data.get("transfer_id"),
                    "chunk_index": data.get("chunk_index"),
                } if isinstance(data, dict) and data.get("encoding") == "gzip-json-chunk" else {}),
                **(progress or {}),
            }
        except (AttributeError, ValueError) as exc:
            return {"ok": False, "version": PROTOCOL_VERSION, "error": str(exc)[:256]}

    def _accept_chunk(
        self, identity_hash: str, envelope: dict[str, Any]
    ) -> tuple[str, dict[str, Any] | None, dict[str, int]]:
        if envelope.get("version") != PROTOCOL_VERSION:
            raise ValueError("unsupported report protocol version")
        reporter_id = validate_reporter_id(str(envelope.get("reporter_id") or ""))
        transfer_id = str(envelope.get("transfer_id") or "")
        if len(transfer_id) != 64 or any(character not in "0123456789abcdef" for character in transfer_id):
            raise ValueError("invalid report transfer ID")
        try:
            index = int(envelope.get("chunk_index"))
            count = int(envelope.get("chunk_count"))
            compressed_size = int(envelope.get("compressed_size"))
            uncompressed_size = int(envelope.get("uncompressed_size"))
        except (TypeError, ValueError) as exc:
            raise ValueError("invalid report chunk metadata") from exc
        payload = envelope.get("payload")
        if (
            not isinstance(payload, bytes) or not 0 <= index < count
            or count < 1 or count > MAX_REPORT_CHUNKS
            or compressed_size < 1 or compressed_size > self.max_bytes
            or uncompressed_size < 1 or uncompressed_size > self.max_uncompressed_bytes
            or len(payload) > DEFAULT_CHUNK_BYTES
        ):
            raise ValueError("invalid report chunk")
        now = time.monotonic()
        key = (identity_hash, transfer_id)
        with self._chunk_lock:
            self._chunk_transfers = {
                item_key: item for item_key, item in self._chunk_transfers.items()
                if now - item["updated_at"] <= CHUNK_TTL
            }
            if key not in self._chunk_transfers and len(self._chunk_transfers) >= MAX_INFLIGHT_TRANSFERS:
                raise ValueError("too many incomplete report transfers")
            transfer = self._chunk_transfers.setdefault(key, {
                "reporter_id": reporter_id,
                "count": count,
                "compressed_size": compressed_size,
                "uncompressed_size": uncompressed_size,
                "parts": {},
                "updated_at": now,
            })
            if (
                transfer["reporter_id"] != reporter_id or transfer["count"] != count
                or transfer["compressed_size"] != compressed_size
                or transfer["uncompressed_size"] != uncompressed_size
            ):
                raise ValueError("inconsistent report chunk metadata")
            transfer["parts"][index] = payload
            transfer["updated_at"] = now
            if sum(len(part) for part in transfer["parts"].values()) > compressed_size:
                del self._chunk_transfers[key]
                raise ValueError("report chunks exceed declared size")
            received = len(transfer["parts"])
            if received != count:
                return reporter_id, None, {"chunks_received": received, "chunk_count": count}
            compressed = b"".join(transfer["parts"][part] for part in range(count))
            del self._chunk_transfers[key]
        if len(compressed) != compressed_size or hashlib.sha256(compressed).hexdigest() != transfer_id:
            raise ValueError("report chunk checksum mismatch")
        decoded_id, snapshot = decode_report({
            "version": PROTOCOL_VERSION,
            "reporter_id": reporter_id,
            "encoding": "gzip-json",
            "payload": compressed,
        }, max_bytes=self.max_bytes, max_uncompressed_bytes=self.max_uncompressed_bytes)
        return decoded_id, snapshot, {"chunks_received": count, "chunk_count": count}


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
        envelopes = encode_report_chunks(reporter_id, label, snapshot)
        last_error: Exception | None = None
        for attempt in range(REPORT_TRANSFER_ATTEMPTS):
            try:
                link = self._ensure_link()
                response: dict[str, Any] = {}
                for envelope in envelopes:
                    response = self._send_envelope(link, envelope)
                    installed = self._validate_ack(
                        response, envelope, len(envelopes)
                    )
                    # A replay can supply the last missing piece before the
                    # final envelope in local order. Stop immediately because
                    # the listener has atomically installed the snapshot and
                    # discarded its completed transfer buffer.
                    if installed:
                        return response
                raise ValueError("RNS report transfer remained incomplete")
            except (OSError, TimeoutError, ValueError) as exc:
                last_error = exc
                # A transfer is atomic on the listener. Replaying every chunk
                # with the same transfer ID safely fills any missing pieces;
                # replacing the link first also recovers an interrupted RNS
                # session instead of waiting for the next reporter interval.
                self.link = None
                if attempt + 1 >= REPORT_TRANSFER_ATTEMPTS:
                    raise
        assert last_error is not None
        raise last_error

    @staticmethod
    def _validate_ack(
        response: dict[str, Any], envelope: dict[str, Any], total: int
    ) -> bool:
        if response.get("reporter_id") != envelope.get("reporter_id"):
            raise ValueError("RNS report acknowledgement has the wrong reporter ID")
        chunked = envelope.get("encoding") == "gzip-json-chunk"
        if not chunked:
            if response.get("complete") is not True:
                raise ValueError("RNS report was acknowledged but not installed")
            return True
        if response.get("transfer_id") != envelope.get("transfer_id"):
            raise ValueError("RNS report acknowledgement has the wrong transfer ID")
        try:
            acknowledged_index = int(response.get("chunk_index"))
            acknowledged_count = int(response.get("chunks_received"))
            acknowledged_total = int(response.get("chunk_count"))
        except (TypeError, ValueError) as exc:
            raise ValueError("RNS report acknowledgement is missing chunk progress") from exc
        if acknowledged_index != int(envelope["chunk_index"]):
            raise ValueError("RNS report acknowledgement has the wrong chunk index")
        if acknowledged_total != total or not 1 <= acknowledged_count <= total:
            raise ValueError("RNS report acknowledgement has inconsistent chunk progress")
        if response.get("complete") is True:
            if acknowledged_count != total:
                raise ValueError("RNS report completed without every chunk")
            return True
        if response.get("complete") is not False:
            raise ValueError("RNS report acknowledgement has invalid completion state")
        return False

    def _send_envelope(
        self, link: RNS.Link, envelope: dict[str, Any]
    ) -> dict[str, Any]:
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
