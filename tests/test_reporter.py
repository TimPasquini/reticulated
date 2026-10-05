import unittest

from sim.reporter import compact_snapshot_for_report


class ReporterTests(unittest.TestCase):
    def test_wire_snapshot_removes_redundant_path_and_rmap_raw_objects(self):
        snapshot = {
            "mode": "live_rns",
            "root": {"id": "instance:test", "raw": {"future_counter": 7}},
            "interfaces": [{"id": "interface:test", "raw": {"airtime": 2}}],
            "transports": [],
            "destinations": [{"id": "destination:test", "hash": "ab", "raw": {"hash": "ab"}}],
            "rmap_interfaces": [{"id": "rmap:test", "raw": {"name": "test"}}],
            "local_services": [],
            "edges": [],
            "health": {},
        }

        compact = compact_snapshot_for_report(snapshot)

        self.assertNotIn("raw", compact["destinations"][0])
        self.assertNotIn("raw", compact["rmap_interfaces"][0])
        self.assertEqual(compact["root"]["raw"]["future_counter"], 7)
        self.assertEqual(compact["interfaces"][0]["raw"]["airtime"], 2)
        self.assertIn("raw", snapshot["destinations"][0])


if __name__ == "__main__":
    unittest.main()
