import asyncio
import json
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace

from sim.live_reports import LiveReportRegistry
from sim.rns_reporting import (
    RNSReportListener,
    decode_report,
    encode_report,
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


if __name__ == "__main__":
    unittest.main()
