import unittest

from sim.live_reports import LiveReportRegistry, validate_reporter_id, validate_snapshot
from sim.reporter import report_url


def snapshot(label, transport_id=None, observed=()):
    return {
        "mode": "live_rns",
        "collected_at": 100.0,
        "stale": False,
        "root": {
            "id": f"instance:{transport_id or label}",
            "label": label,
            "transport_id": transport_id,
        },
        "interfaces": [],
        "transports": [
            {"id": f"transport:{transport}", "hash": transport, "interface_ids": []}
            for transport in observed
        ],
        "destinations": [],
        "rmap_interfaces": [],
        "edges": [],
        "health": {},
    }


class LiveReportRegistryTests(unittest.TestCase):
    def test_stores_independent_reports_and_projects_large_sections(self):
        registry = LiveReportRegistry(stale_after=90)
        report = snapshot("Fedora", observed=("patroon-hash",))
        report["destinations"].append({"hash": "destination", "via": "patroon-hash"})
        report["edges"].append({"kind": "known_path"})
        registry.update("fedora", report, received_at=1000)

        compact = registry.get("fedora", include_paths=False)
        full = registry.get("fedora", include_paths=True)

        self.assertEqual(compact["destinations"], [])
        self.assertEqual(compact["path_summary"]["by_transport"], {"patroon-hash": 1})
        self.assertEqual(len(full["destinations"]), 1)
        self.assertEqual(registry.list()[0]["id"], "fedora")

    def test_correlates_reporter_transport_with_another_reporters_next_hop(self):
        registry = LiveReportRegistry()
        registry.update("fedora", snapshot("Fedora", observed=("patroon-hash",)))
        registry.update("patroon", snapshot("Patroon", transport_id="patroon-hash"))

        self.assertEqual(registry.correlations(), [{
            "transport_id": "patroon-hash",
            "reported_by": ["patroon"],
            "observed_by": ["fedora"],
        }])

    def test_rejects_invalid_ids_and_payloads(self):
        with self.assertRaises(ValueError):
            validate_reporter_id("../bad")
        with self.assertRaises(ValueError):
            validate_snapshot({"mode": "live_rns"})

    def test_report_url_is_scoped_to_reporter_endpoint(self):
        self.assertEqual(
            report_url("https://patroon.example/base/", "fedora-laptop"),
            "https://patroon.example/base/api/live/reporters/fedora-laptop",
        )
        with self.assertRaises(ValueError):
            report_url("file:///tmp/report", "fedora")


if __name__ == "__main__":
    unittest.main()
