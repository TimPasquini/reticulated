import json
import subprocess
import unittest
from types import SimpleNamespace

from sim import config
from sim.live_rns import LiveRNSProvider


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


class LiveRNSNormalizationTests(unittest.TestCase):
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


class LiveRNSCollectionTests(unittest.TestCase):
    def test_last_good_data_survives_temporary_command_failure(self):
        responses = iter(
            [
                SimpleNamespace(returncode=0, stdout=json.dumps(STATUS), stderr=""),
                SimpleNamespace(returncode=0, stdout=json.dumps(PATHS), stderr=""),
                subprocess.TimeoutExpired([config.RNSTATUS_PATH, "-j"], 1),
                SimpleNamespace(returncode=2, stdout="", stderr="shared instance unavailable"),
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
        self.assertIn("exit 2", stale["health"]["rnpath"]["error"])

    def test_invalid_json_is_reported_without_raising(self):
        def runner(command, timeout):
            return SimpleNamespace(returncode=0, stdout="not json", stderr="")

        state = LiveRNSProvider(runner=runner).collect()
        self.assertTrue(state["stale"])
        self.assertIn("invalid JSON", state["health"]["rnstatus"]["error"])
        self.assertIn("invalid JSON", state["health"]["rnpath"]["error"])


if __name__ == "__main__":
    unittest.main()
