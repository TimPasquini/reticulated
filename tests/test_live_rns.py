import json
import subprocess
import unittest
from pathlib import Path
from types import SimpleNamespace

from sim import config
from sim.live_rns import LiveRNSProvider


FIXTURES = Path(__file__).parent / "fixtures"


STATUS = {
    "transport_id": "0998543722d6e34f7c4a1d46b5352835",
    "future_queue_metric": 0.25,
    "interfaces": [
        {
            "name": "BackboneInterface[NYC Backbone]",
            "short_name": "NYC Backbone",
            "hash": "aabbccdd",
            "type": "BackboneInterface",
            "mode": 5,
            "status": True,
            "bitrate": 10_000_000,
            "mtu": 500,
            "rxb": 120,
            "txb": 80,
            "arbitrary_future_counter": 42,
        },
        {
            "name": "RNodeInterface[Patroon]",
            "short_name": "Patroon",
            "hash": "eeff0011",
            "type": "RNodeInterface",
            "mode": 2,
            "status": True,
            "bitrate": 3120,
            "mtu": 508,
        },
    ],
}

PATHS = [
    {
        "hash": "destination-a",
        "timestamp": 1234,
        "via": "transport-x",
        "hops": 4,
        "expires": 2345,
        "interface": "BackboneInterface[NYC Backbone]",
        "future_path_field": "retained",
    },
    {
        "hash": "destination-b",
        "timestamp": 1240,
        "via": "transport-x",
        "hops": 1,
        "expires": 2350,
        "interface": "RNodeInterface[Patroon]",
    },
]

DISCOVERED = [{
    "discovery_hash": "rmap-interface-a",
    "transport_id": "rmap-transport-a",
    "name": "Published LoRa",
    "type": "RNodeInterface",
    "status": "available",
    "hops": 3,
    "last_heard": 1234,
    "latitude": 40.0,
    "longitude": -75.0,
    "frequency": 914875000,
    "bandwidth": 125000,
}]


class LiveRNSNormalizationTests(unittest.TestCase):
    def test_normalizes_sanitized_patroon_1_5_5_capture(self):
        status = json.loads((FIXTURES / "rnstatus_1_5_5_patroon.json").read_text())
        paths = json.loads((FIXTURES / "rnpath_1_5_5_patroon.json").read_text())

        state = LiveRNSProvider.normalize(status, paths, label="Patroon")

        self.assertEqual(state["root"]["transport_id"], STATUS["transport_id"])
        self.assertEqual(len(state["interfaces"]), 5)
        self.assertEqual(len(state["transports"]), 1)
        self.assertEqual(len(state["destinations"]), 3)
        modes = {item["type"]: item["mode"] for item in state["interfaces"]}
        self.assertEqual(modes["BackboneClientInterface"], "boundary")
        self.assertEqual(modes["I2PInterface"], "gateway")
        self.assertEqual(modes["RNodeInterface"], "access_point")
        rnode = next(item for item in state["interfaces"] if item["type"] == "RNodeInterface")
        self.assertEqual(rnode["raw"]["noise_floor"], -119)
        local = next(item for item in state["destinations"] if item["hops"] == 0)
        self.assertIsNone(local["via"])

    def test_normalizes_observed_topology_without_inventing_intermediates(self):
        state = LiveRNSProvider.normalize(STATUS, PATHS, label="Patroon")

        self.assertEqual(state["root"]["id"], "instance:0998543722d6e34f7c4a1d46b5352835")
        self.assertEqual(len(state["interfaces"]), 2)
        self.assertEqual(state["interfaces"][0]["mode"], "boundary")
        self.assertEqual(state["interfaces"][0]["raw"]["arbitrary_future_counter"], 42)
        self.assertEqual(state["root"]["raw"]["future_queue_metric"], 0.25)
        self.assertEqual(len(state["transports"]), 1)
        self.assertEqual(len(state["destinations"]), 2)
        self.assertEqual(
            set(state["transports"][0]["interface_ids"]),
            {"interface:aabbccdd", "interface:eeff0011"},
        )

        path_edges = {edge["target"]: edge for edge in state["edges"] if edge["kind"] == "known_path"}
        distant = path_edges["destination:destination-a"]
        direct = path_edges["destination:destination-b"]
        self.assertEqual(distant["unknown_hops"], 3)
        self.assertEqual(distant["certainty"], "incomplete")
        self.assertEqual(direct["unknown_hops"], 0)
        self.assertEqual(direct["certainty"], "observed")
        self.assertFalse(any("intermediate" in node["id"] for node in state["transports"]))
        self.assertEqual(state["destinations"][0]["raw"]["future_path_field"], "retained")

    def test_path_only_interface_is_explicitly_marked(self):
        paths = [{**PATHS[0], "interface": "I2PInterfacePeer[remote]"}]
        state = LiveRNSProvider.normalize({"interfaces": []}, paths, label="node")
        self.assertEqual(len(state["interfaces"]), 1)
        self.assertTrue(state["interfaces"][0]["path_only"])

    def test_normalizes_rmap_discovery_without_claiming_adjacency(self):
        state = LiveRNSProvider.normalize(
            STATUS, PATHS, label="Patroon", discovered=DISCOVERED
        )

        self.assertEqual(len(state["rmap_interfaces"]), 1)
        item = state["rmap_interfaces"][0]
        self.assertEqual(item["id"], "rmap-interface:rmap-interface-a")
        self.assertEqual(item["transport_id"], "rmap-transport-a")
        self.assertEqual(item["latitude"], 40.0)
        self.assertFalse(any(edge.get("target") == item["id"] for edge in state["edges"]))


class LiveRNSCollectionTests(unittest.TestCase):
    def test_default_topology_snapshot_omits_destination_fanout(self):
        provider = LiveRNSProvider(label="Patroon")
        provider._state = provider.normalize(
            STATUS, PATHS, label="Patroon", discovered=DISCOVERED
        )

        topology = provider.topology_snapshot()
        full = provider.topology_snapshot(include_paths=True, include_rmap=True)

        self.assertEqual(topology["destinations"], [])
        self.assertFalse(any(edge["kind"] == "known_path" for edge in topology["edges"]))
        self.assertEqual(topology["path_summary"]["destination_count"], 2)
        self.assertEqual(topology["path_summary"]["by_transport"], {"transport-x": 2})
        self.assertEqual(topology["rmap_interfaces"], [])
        self.assertEqual(topology["rmap_summary"]["interface_count"], 1)
        self.assertEqual(len(full["destinations"]), 2)
        self.assertEqual(len(full["rmap_interfaces"]), 1)
        self.assertEqual(len([edge for edge in full["edges"] if edge["kind"] == "known_path"]), 2)

    def test_last_good_data_survives_temporary_command_failure(self):
        responses = iter(
            [
                SimpleNamespace(returncode=0, stdout=json.dumps(STATUS), stderr=""),
                SimpleNamespace(returncode=0, stdout=json.dumps(PATHS), stderr=""),
                SimpleNamespace(returncode=0, stdout=json.dumps(DISCOVERED), stderr=""),
                subprocess.TimeoutExpired([config.RNSTATUS_PATH, "-j"], 1),
            ]
        )

        def runner(command, timeout):
            response = next(responses)
            if isinstance(response, Exception):
                raise response
            return response

        provider = LiveRNSProvider(label="Patroon", timeout=1, runner=runner)
        fresh = provider.collect()
        stale = provider.collect()

        self.assertFalse(fresh["stale"])
        self.assertTrue(stale["stale"])
        self.assertEqual(stale["root"]["transport_id"], STATUS["transport_id"])
        self.assertEqual(len(stale["destinations"]), 2)
        self.assertIn("timed out", stale["health"]["rnstatus"]["error"])
        self.assertIn("skipped", stale["health"]["rnpath"]["error"])

    def test_zero_hop_local_path_does_not_create_a_transport(self):
        local_path = [{
            "hash": "local-destination",
            "timestamp": 1234,
            "via": "local-destination",
            "hops": 0,
            "expires": 2345,
            "interface": "LocalInterface[rns/patroon]",
        }]
        state = LiveRNSProvider.normalize({"interfaces": []}, local_path, label="Patroon")

        self.assertEqual(state["transports"], [])
        self.assertIsNone(state["destinations"][0]["via"])
        path_edge = next(edge for edge in state["edges"] if edge["kind"] == "known_path")
        self.assertEqual(path_edge["source"], state["interfaces"][0]["id"])
        self.assertEqual(path_edge["unknown_hops"], 0)

    def test_direct_one_hop_destination_does_not_create_a_transport(self):
        direct_path = [{
            "hash": "direct-destination",
            "timestamp": 1,
            "via": "direct-destination",
            "hops": 1,
            "expires": 2,
            "interface": "AutoInterfacePeer[garage]",
        }]
        state = LiveRNSProvider.normalize({"interfaces": []}, direct_path, label="Laptop")

        self.assertEqual(state["transports"], [])
        self.assertIsNone(state["destinations"][0]["via"])
        path_edge = next(edge for edge in state["edges"] if edge["kind"] == "known_path")
        self.assertEqual(path_edge["source"], state["interfaces"][0]["id"])
        self.assertEqual(path_edge["unknown_hops"], 0)

    def test_invalid_json_is_reported_without_raising(self):
        def runner(command, timeout):
            return SimpleNamespace(returncode=0, stdout="not json", stderr="")

        state = LiveRNSProvider(runner=runner).collect()
        self.assertTrue(state["stale"])
        self.assertIn("invalid JSON", state["health"]["rnstatus"]["error"])
        self.assertIn("skipped", state["health"]["rnpath"]["error"])


if __name__ == "__main__":
    unittest.main()
