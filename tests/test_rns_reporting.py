import asyncio
import json
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from sim.live_reports import LiveReportRegistry
from sim.rns_reporting import (
    RNSReportListener,
    RNSReportClient,
    decode_report,
    encode_report,
    encode_report_chunks,
    load_allowlist,
    start_report_listener,
)


def snapshot():
    return {
        "mode": "live_rns",
        "root": {"id": "instance:test", "label": "Test", "transport_id": None},
        "interfaces": [],
        "transports": [],
        "destinations": [],
        "rmap_interfaces": [],
        "local_services": [],
        "edges": [],
        "health": {},
    }


class RNSReportingTests(unittest.TestCase):
    def test_listener_does_not_announce_ingest_destination_by_default(self):
        listener = RNSReportListener(
            LiveReportRegistry(),
            identity_path="unused",
            allowlist_path="unused",
            local_reporter_id="patroon",
        )
        destination = Mock()
        destination.hash = bytes.fromhex("ab" * 16)
        with (
            patch("sim.rns_reporting.load_allowlist", return_value={}),
            patch("sim.rns_reporting.load_or_create_identity", return_value=Mock()),
            patch("sim.rns_reporting.RNS.Reticulum"),
            patch("sim.rns_reporting.RNS.Destination", return_value=destination),
        ):
            listener.start()

        destination.announce.assert_not_called()

    def test_listener_initialization_stays_on_event_loop_thread(self):
        caller_thread = threading.get_ident()

        class Listener:
            started_on = None

            def start(self):
                self.started_on = threading.get_ident()
                return "destination"

        listener = Listener()
        destination = asyncio.run(start_report_listener(listener))

        self.assertEqual(destination, "destination")
        self.assertEqual(listener.started_on, caller_thread)
        self.assertIs(threading.current_thread(), threading.main_thread())

    def test_round_trips_versioned_compressed_report(self):
        envelope = encode_report("fedora", "Fedora laptop", snapshot())
        reporter_id, decoded = decode_report(envelope)

        self.assertEqual(reporter_id, "fedora")
        self.assertEqual(decoded["root"]["label"], "Test")
        self.assertEqual(envelope["version"], 1)
        self.assertEqual(envelope["encoding"], "gzip-json")

    def test_decode_enforces_uncompressed_size_limit(self):
        report = snapshot()
        report["root"]["padding"] = "x" * 1000
        with self.assertRaisesRegex(ValueError, "uncompressed report is too large"):
            decode_report(encode_report("fedora", "Fedora", report), max_bytes=200)

    def test_compressed_and_expanded_report_limits_are_independent(self):
        report = snapshot()
        report["root"]["padding"] = "compressible topology " * 1000
        envelope = encode_report("fedora", "Fedora", report)

        reporter_id, decoded = decode_report(
            envelope, max_bytes=1024, max_uncompressed_bytes=64 * 1024
        )

        self.assertEqual(reporter_id, "fedora")
        self.assertEqual(decoded["root"]["padding"], report["root"]["padding"])
        with self.assertRaisesRegex(ValueError, "uncompressed report is too large"):
            decode_report(envelope, max_bytes=1024, max_uncompressed_bytes=1024)

    def test_allowlist_binds_identity_hash_to_reporter(self):
        identity_hash = "ab" * 16
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "reporters.json"
            path.write_text(json.dumps({identity_hash: {
                "reporter_id": "fedora", "label": "Fedora laptop"
            }}))
            loaded = load_allowlist(path)

        self.assertEqual(loaded[identity_hash]["reporter_id"], "fedora")

    def test_listener_rejects_reporter_id_spoofing(self):
        identity_hash = "ab" * 16
        registry = LiveReportRegistry()
        listener = RNSReportListener(
            registry,
            identity_path="unused",
            allowlist_path="unused",
            local_reporter_id="patroon",
        )
        listener.allowlist = {
            identity_hash: {"reporter_id": "fedora", "label": "Fedora laptop"}
        }
        response = listener._handle_report(
            "/report/v1",
            encode_report("vehicle", "Vehicle", snapshot()),
            b"request",
            b"link",
            SimpleNamespace(hash=bytes.fromhex(identity_hash)),
            0,
        )

        self.assertFalse(response["ok"])
        self.assertIn("does not match", response["error"])
        self.assertEqual(registry.list(), [])

    def test_listener_accepts_enrolled_identity(self):
        identity_hash = "ab" * 16
        registry = LiveReportRegistry()
        listener = RNSReportListener(
            registry,
            identity_path="unused",
            allowlist_path="unused",
            local_reporter_id="patroon",
        )
        listener.allowlist = {
            identity_hash: {"reporter_id": "fedora", "label": "Fedora laptop"}
        }
        response = listener._handle_report(
            "/report/v1",
            encode_report("fedora", "Fedora", snapshot()),
            b"request",
            b"link",
            SimpleNamespace(hash=bytes.fromhex(identity_hash)),
            0,
        )

        self.assertTrue(response["ok"])
        self.assertEqual(registry.list()[0]["id"], "fedora")

    def test_listener_atomically_reassembles_bounded_chunks(self):
        identity_hash = "ab" * 16
        registry = LiveReportRegistry()
        listener = RNSReportListener(
            registry,
            identity_path="unused",
            allowlist_path="unused",
            local_reporter_id="patroon",
            max_bytes=1024 * 1024,
        )
        listener.allowlist = {
            identity_hash: {"reporter_id": "fedora", "label": "Fedora laptop"}
        }
        report = snapshot()
        report["destinations"] = [{
            "id": f"destination:{index:08x}",
            "hash": (f"{index:08x}" * 4),
        } for index in range(2000)]
        chunks = encode_report_chunks("fedora", "Fedora", report, chunk_bytes=1024)
        self.assertGreater(len(chunks), 1)

        for index, chunk in enumerate(chunks):
            response = listener._handle_report(
                "/report/v1", chunk, b"request", b"link",
                SimpleNamespace(hash=bytes.fromhex(identity_hash)), 0,
            )
            self.assertTrue(response["ok"])
            self.assertEqual(response["transfer_id"], chunk["transfer_id"])
            self.assertEqual(response["chunk_index"], index)
            if index < len(chunks) - 1:
                self.assertFalse(response["complete"])
                self.assertEqual(registry.list(), [])

        self.assertEqual(registry.list()[0]["id"], "fedora")
        stored = registry.get("fedora", include_paths=True)
        self.assertEqual(len(stored["destinations"]), 2000)

    def test_client_retries_an_incomplete_transfer_and_requires_final_commit(self):
        client = RNSReportClient(
            destination_hash="ab" * 16,
            identity_path="unused",
        )
        client.identity = SimpleNamespace(hash=bytes.fromhex("cd" * 16))
        links = []
        client._ensure_link = lambda: links.append(object()) or links[-1]
        envelopes = [
            {
                "encoding": "gzip-json-chunk",
                "reporter_id": "fedora",
                "transfer_id": "ef" * 32,
                "chunk_index": index,
                "chunk_count": 2,
            }
            for index in range(2)
        ]
        calls = []

        def send(_link, envelope):
            calls.append(envelope["chunk_index"])
            second_attempt = len(calls) > len(envelopes)
            return {
                "ok": True,
                "reporter_id": "fedora",
                "transfer_id": envelope["transfer_id"],
                "chunk_index": envelope["chunk_index"],
                "chunk_count": 2,
                "chunks_received": envelope["chunk_index"] + 1,
                "complete": second_attempt and envelope["chunk_index"] == 1,
            }

        client._send_envelope = send
        with patch("sim.rns_reporting.encode_report_chunks", return_value=envelopes):
            response = client.send_report("fedora", "Fedora", snapshot())

        self.assertTrue(response["complete"])
        self.assertEqual(calls, [0, 1, 0, 1])
        self.assertEqual(len(links), 2)

    def test_client_never_reports_success_without_server_installation(self):
        client = RNSReportClient(
            destination_hash="ab" * 16,
            identity_path="unused",
        )
        client.identity = SimpleNamespace(hash=bytes.fromhex("cd" * 16))
        client._ensure_link = lambda: object()
        envelope = encode_report("fedora", "Fedora", snapshot())
        client._send_envelope = lambda _link, _envelope: {
            "ok": True,
            "reporter_id": "fedora",
            "complete": False,
        }

        with patch("sim.rns_reporting.encode_report_chunks", return_value=[envelope]):
            with self.assertRaisesRegex(ValueError, "not installed"):
                client.send_report("fedora", "Fedora", snapshot())


if __name__ == "__main__":
    unittest.main()
