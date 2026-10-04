import tempfile
import unittest
from pathlib import Path

import RNS

from sim.announce_capture import AnnounceCapture
from sim.announce_store import AnnounceEventStore


class AnnounceCaptureTests(unittest.TestCase):
    def test_records_classified_bounded_metadata_and_deduplicates_packets(self):
        capture = AnnounceCapture(max_events=1, app_data_preview_bytes=5)
        identity = RNS.Identity()
        destination = RNS.Destination.hash_from_name_and_identity(
            "lxmf.delivery", identity
        )

        capture.received_announce(destination, identity, b"hello world", b"a" * 32)
        capture.received_announce(destination, identity, b"hello world", b"a" * 32)
        first = capture.snapshot()

        self.assertEqual(first["event_count"], 1)
        self.assertEqual(first["events"][0]["aspect"], "lxmf.delivery")
        self.assertEqual(first["events"][0]["app_data_text"], "hello")
        self.assertTrue(first["events"][0]["app_data_truncated"])

        capture.received_announce(destination, identity, None, b"b" * 32)
        second = capture.snapshot()
        self.assertEqual(second["event_count"], 1)
        self.assertEqual(second["evicted_count"], 1)
        self.assertEqual(second["events"][0]["packet_hash"], (b"b" * 32).hex())

    def test_unknown_aspect_is_recorded_without_guessing(self):
        capture = AnnounceCapture()
        identity = RNS.Identity()

        capture.received_announce(b"z" * 16, identity, b"\x00\xff", b"p" * 32)

        event = capture.snapshot()["events"][0]
        self.assertIsNone(event["aspect"])
        self.assertIsNone(event["app_data_text"])


class AnnounceEventStoreTests(unittest.TestCase):
    def test_persists_each_reporter_observation_once(self):
        event = {
            "id": "packet-a",
            "received_at": 100.0,
            "destination_hash": "d" * 32,
            "identity_hash": "i" * 32,
            "packet_hash": "p" * 64,
            "aspect": "lxmf.delivery",
            "app_data_length": 4,
            "route_hops": 2,
            "route_interface": "Garage LAN",
        }
        with tempfile.TemporaryDirectory() as directory:
            store = AnnounceEventStore(str(Path(directory) / "announces.sqlite3"))
            self.assertEqual(store.ingest("patroon", {"events": [event]}), 1)
            self.assertEqual(store.ingest("patroon", {"events": [event]}), 0)
            self.assertEqual(store.ingest("fedora", {"events": [event]}), 1)
            self.assertEqual(store.count(), 2)
            recent = store.recent(reporter_id="fedora")
            self.assertEqual(len(recent), 1)
            self.assertEqual(recent[0]["route_interface"], "Garage LAN")


if __name__ == "__main__":
    unittest.main()
