import tempfile
import unittest
from pathlib import Path

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
        "local_services": [],
        "edges": [],
        "health": {},
    }


class LiveReportRegistryTests(unittest.TestCase):
    def test_persists_complete_reports_for_immediate_restart_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "reports.json"
            registry = LiveReportRegistry(storage_path=str(path))
            report = snapshot("Patroon", transport_id="patroon")
            report["destinations"] = [{"hash": "destination", "hops": 3}]
            report["rmap_interfaces"] = [{"transport_id": "rmap-node"}]
            registry.update("patroon", report, received_at=100.0, local=True)
            self.assertEqual(path.read_bytes()[:2], b"\x1f\x8b")

            restored = LiveReportRegistry(storage_path=str(path))
            cached = restored.get("patroon", include_paths=True, include_rmap=True)

        self.assertEqual(cached["destinations"][0]["hash"], "destination")
        self.assertEqual(cached["rmap_interfaces"][0]["transport_id"], "rmap-node")
        self.assertTrue(restored.list()[0]["local"])

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

    def test_network_unifies_reporter_roots_and_keeps_closest_path_observation(self):
        fedora = snapshot("Fedora", observed=("patroon-hash",))
        fedora["interfaces"] = [{"id": "interface:lan", "name": "Garage LAN"}]
        fedora["transports"][0]["interface_ids"] = ["interface:lan"]
        fedora["destinations"] = [{
            "id": "destination:shared", "hash": "shared", "hops": 3,
            "via": "patroon-hash", "interface_id": "interface:lan", "interface": "Garage LAN",
        }]
        fedora["edges"] = [
            {"id": "edge:root:lan", "source": fedora["root"]["id"], "target": "interface:lan", "kind": "observed_interface"},
            {"id": "edge:lan:patroon", "source": "interface:lan", "target": "transport:patroon-hash", "kind": "observed_next_hop"},
            {"id": "edge:patroon:shared", "source": "transport:patroon-hash", "target": "destination:shared", "kind": "known_path", "hops": 3, "unknown_hops": 2},
        ]

        patroon = snapshot("Patroon", transport_id="patroon-hash", observed=("backbone-hop",))
        patroon["interfaces"] = [{"id": "interface:backbone", "name": "NYC Backbone"}]
        patroon["transports"][0]["interface_ids"] = ["interface:backbone"]
        patroon["destinations"] = [{
            "id": "destination:shared", "hash": "shared", "hops": 2,
            "via": "backbone-hop", "interface_id": "interface:backbone", "interface": "NYC Backbone",
        }]
        patroon["edges"] = [
            {"id": "edge:root:backbone", "source": patroon["root"]["id"], "target": "interface:backbone", "kind": "observed_interface"},
            {"id": "edge:backbone:hop", "source": "interface:backbone", "target": "transport:backbone-hop", "kind": "observed_next_hop"},
            {"id": "edge:hop:shared", "source": "transport:backbone-hop", "target": "destination:shared", "kind": "known_path", "hops": 2, "unknown_hops": 1},
        ]

        registry = LiveReportRegistry()
        registry.update("patroon", patroon, local=True)
        registry.update("fedora", fedora)
        network = registry.network(include_paths=True)

        self.assertEqual(network["root"]["id"], "transport:patroon-hash")
        self.assertEqual(
            {root["id"] for root in network["reporter_roots"]},
            {"transport:patroon-hash", "reporter:fedora"},
        )
        self.assertEqual([item["hash"] for item in network["transports"]], ["backbone-hop"])
        self.assertEqual(len(network["destinations"]), 1)
        self.assertEqual(network["destinations"][0]["reporter_id"], "patroon")
        self.assertEqual(network["destinations"][0]["hops"], 2)
        self.assertTrue(any(
            edge["source"] == "reporter:fedora" and edge["kind"] == "observed_interface"
            for edge in network["edges"]
        ))
        self.assertTrue(any(
            edge["target"] == "transport:patroon-hash" and edge["kind"] == "observed_next_hop"
            for edge in network["edges"]
        ))

    def test_connected_transport_reporter_refines_primary_path(self):
        patroon = snapshot("Patroon", transport_id="patroon", observed=("vehicle",))
        patroon["destinations"] = [{
            "id": "destination:d", "hash": "d", "hops": 3, "via": "vehicle",
            "interface_id": "interface:radio", "interface": "LoRa",
        }]
        patroon["edges"] = [{
            "id": "edge:vehicle:d", "source": "transport:vehicle", "target": "destination:d",
            "kind": "known_path", "hops": 3, "unknown_hops": 2,
        }]
        vehicle = snapshot("Vehicle", transport_id="vehicle", observed=("radio-hop",))
        vehicle["destinations"] = [{
            "id": "destination:d", "hash": "d", "hops": 2, "via": "radio-hop",
            "interface_id": "interface:radio", "interface": "LoRa",
        }]
        vehicle["edges"] = [{
            "id": "edge:radio:d", "source": "transport:radio-hop", "target": "destination:d",
            "kind": "known_path", "hops": 2, "unknown_hops": 1,
        }]

        registry = LiveReportRegistry()
        registry.update("patroon", patroon, local=True)
        registry.update("vehicle", vehicle)
        network = registry.network(include_paths=True)

        self.assertEqual(network["destinations"][0]["reporter_id"], "vehicle")
        self.assertEqual(network["destinations"][0]["hops"], 2)

    def test_contributed_rmap_records_match_primary_interface_endpoints(self):
        patroon = snapshot("Patroon", transport_id="patroon")
        patroon["interfaces"] = [{
            "id": "interface:nyc", "name": "NYC Backbone",
            "type": "BackboneClientInterface", "remote_host": "nyc.example.net",
            "remote_port": 4242, "raw": {},
        }]
        observer = snapshot("Observer")
        observer["rmap_interfaces"] = [{
            "id": "rmap-interface:nyc", "discovery_hash": "nyc",
            "transport_id": "nyc-transport", "name": "NYC RMAP node",
            "type": "BackboneInterface", "reachable_on": "nyc.example.net",
            "port": 4242,
        }]

        registry = LiveReportRegistry()
        registry.update("patroon", patroon, local=True)
        registry.update("observer", observer)
        network = registry.network(include_rmap=True)

        self.assertEqual(network["rmap_summary"]["matched_interface_count"], 1)
        self.assertEqual(network["rmap_matches"][0]["kind"], "remote_endpoint")
        self.assertEqual(
            network["rmap_matches"][0]["interface_id"],
            "reporter:patroon:interface:nyc",
        )
        self.assertEqual(network["rmap_summary"]["attachment_count"], 1)
        self.assertEqual(network["rmap_attachments"][0]["source"], "transport:patroon")
        self.assertEqual(network["rmap_attachments"][0]["target"], "transport:nyc-transport")

    def test_discovered_service_names_matching_destination_across_reporters(self):
        destination_hash = "c" * 32
        patroon = snapshot("Patroon", transport_id="patroon")
        patroon["local_services"] = [{
            "destination_hash": destination_hash,
            "name": "Patroon rnsh",
            "type": "rnsh",
        }]
        fedora = snapshot("Fedora")
        fedora["destinations"] = [{
            "id": f"destination:{destination_hash}", "hash": destination_hash,
            "hops": 1, "via": None, "local": False,
            "interface_id": "interface:lan", "interface": "Garage LAN",
        }]
        fedora["edges"] = [{
            "id": "edge:lan:rnsh", "source": "interface:lan",
            "target": f"destination:{destination_hash}", "kind": "known_path",
            "hops": 1, "unknown_hops": 0,
        }]

        registry = LiveReportRegistry()
        registry.update("patroon", patroon, local=True)
        registry.update("fedora", fedora)
        network = registry.network()

        self.assertEqual(len(network["destinations"]), 1)
        self.assertEqual(network["destinations"][0]["local_service"]["name"], "Patroon rnsh")
        self.assertEqual(network["destinations"][0]["service_reporters"], ["patroon"])

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
