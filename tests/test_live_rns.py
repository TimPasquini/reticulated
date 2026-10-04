import json
import subprocess
import unittest
from pathlib import Path
from types import SimpleNamespace

from sim import config
from sim.live_rns import LiveRNSProvider, topology_snapshot


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
        backbone = next(item for item in state["interfaces"] if item["type"] == "BackboneClientInterface")
        self.assertEqual(backbone["remote_host"], "lga.us.thunderhost.net")
        self.assertEqual(backbone["remote_port"], 4242)
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

    def test_i2p_peer_is_attached_to_its_reported_parent_interface(self):
        parent_hash = "1" * 64
        peer_hash = "2" * 64
        parent_name = "I2PInterface[Patroon I2P]"
        status = {"interfaces": [
            {
                "name": parent_name,
                "short_name": "Patroon I2P",
                "hash": parent_hash,
                "type": "I2PInterface",
            },
            {
                "name": "I2PInterfacePeer[Connected peer abc]",
                "short_name": "Connected peer abc",
                "hash": peer_hash,
                "type": "I2PInterfacePeer",
                "parent_interface_name": parent_name,
                "parent_interface_hash": parent_hash,
            },
        ]}

        state = LiveRNSProvider.normalize(status, [], label="Patroon")
        peer = next(item for item in state["interfaces"] if item["interface_hash"] == peer_hash)
        parent = next(item for item in state["interfaces"] if item["interface_hash"] == parent_hash)
        peer_edge = next(edge for edge in state["edges"] if edge["target"] == peer["id"])

        self.assertEqual(peer["parent_interface_id"], parent["id"])
        self.assertEqual(peer_edge["source"], parent["id"])
        self.assertEqual(peer_edge["kind"], "observed_peer_interface")

    def test_duplicate_interface_hash_is_emitted_once(self):
        interface = {
            "name": "LocalInterface[rns/test]",
            "short_name": "rns/test",
            "hash": "3" * 64,
            "type": "LocalClientInterface",
            "mtu": None,
        }
        second = dict(interface)
        second["mtu"] = 500
        state = LiveRNSProvider.normalize(
            {"interfaces": [interface, second]}, [], label="Test"
        )

        self.assertEqual(len(state["interfaces"]), 1)
        self.assertEqual(len(state["edges"]), 1)
        self.assertEqual(state["interfaces"][0]["mtu"], 500)
        self.assertEqual(len(state["interfaces"][0]["raw_observations"]), 2)

    def test_replaces_invalid_rns_short_names_only_for_display(self):
        status = {"interfaces": [
            {
                "name": "LocalInterface[rns/default]",
                "short_name": "0@\x00rns/default",
                "type": "LocalClientInterface",
            },
            {
                "name": "AutoInterfacePeer[wlp4s0/fe80::e65f:1ff:fe97:3572]",
                "short_name": "None",
                "type": "AutoInterfacePeer",
            },
        ]}

        state = LiveRNSProvider.normalize(status, [], label="Fedora")

        self.assertEqual(state["interfaces"][0]["display_name"], "Local client\nrns/default")
        self.assertEqual(state["interfaces"][0]["raw"]["short_name"], "0@\x00rns/default")
        self.assertEqual(
            state["interfaces"][1]["display_name"],
            "Auto peer wlp4s0\nfe80::e65f:1ff:fe97:3572",
        )

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

    def test_matches_local_interfaces_to_rmap_endpoints_and_publications(self):
        status = {
            "transport_id": "patroon-transport",
            "interfaces": [
                {
                    "name": "BackboneInterface[NYC/lga.example.net:4242]",
                    "short_name": "NYC",
                    "hash": "backbone-hash",
                    "type": "BackboneClientInterface",
                },
                {
                    "name": "RNodeInterface[Patroon]",
                    "short_name": "Patroon",
                    "hash": "radio-hash",
                    "type": "RNodeInterface",
                },
                {
                    "name": "I2PInterface[Patroon I2P]",
                    "short_name": "Patroon I2P",
                    "hash": "i2p-hash",
                    "type": "I2PInterface",
                    "i2p_b32": "patroon-address.b32.i2p",
                },
            ],
        }
        discovered = [
            {
                "discovery_hash": "nyc-record",
                "transport_id": "nyc-transport",
                "name": "NYC gateway",
                "type": "BackboneInterface",
                "reachable_on": "lga.example.net",
                "port": 4242,
            },
            {
                "discovery_hash": "radio-record",
                "transport_id": "patroon-transport",
                "name": "Patroon LoRa",
                "type": "RNodeInterface",
            },
            {
                "discovery_hash": "i2p-record",
                "transport_id": "patroon-transport",
                "name": "Patroon I2P",
                "type": "I2PInterface",
                "reachable_on": "patroon-address",
            },
        ]
        normalized = LiveRNSProvider.normalize(
            status, [], label="Patroon", discovered=discovered
        )
        projected = topology_snapshot(normalized, include_rmap=True)

        self.assertEqual(projected["rmap_summary"]["record_count"], 3)
        self.assertEqual(projected["rmap_summary"]["matched_interface_count"], 3)
        self.assertEqual(
            {match["kind"] for match in projected["rmap_matches"]},
            {"remote_endpoint", "i2p_endpoint", "local_publication"},
        )


class LiveRNSCollectionTests(unittest.TestCase):
    def test_large_sources_use_independent_cached_refresh_intervals(self):
        responses = iter([
            SimpleNamespace(returncode=0, stdout=json.dumps(STATUS), stderr=""),
            SimpleNamespace(returncode=0, stdout=json.dumps(PATHS), stderr=""),
            SimpleNamespace(returncode=0, stdout=json.dumps(DISCOVERED), stderr=""),
            SimpleNamespace(returncode=0, stdout=json.dumps(STATUS), stderr=""),
        ])
        commands = []

        def runner(command, timeout):
            del timeout
            commands.append(command)
            return next(responses)

        provider = LiveRNSProvider(
            runner=runner, path_interval=60, rmap_interval=60
        )
        first = provider.collect()
        second = provider.collect()

        self.assertEqual(first["rmap_interfaces"], second["rmap_interfaces"])
        self.assertEqual(first["destinations"], second["destinations"])
        self.assertTrue(second["health"]["rnpath"]["cached"])
        self.assertTrue(second["health"]["rmap"]["cached"])
        self.assertEqual(
            len([command for command in commands if "-t" in command]),
            1,
        )
        self.assertEqual(
            len([command for command in commands if "-d" in command]),
            1,
        )

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
        self.assertEqual(len(topology["path_groups"]), 2)
        self.assertEqual(
            {group["hop_tier"] for group in topology["path_groups"]},
            {"1", "4+"},
        )
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

    def test_application_owned_service_is_included_in_collection(self):
        responses = iter([
            SimpleNamespace(returncode=0, stdout=json.dumps(STATUS), stderr=""),
            SimpleNamespace(returncode=0, stdout=json.dumps(PATHS), stderr=""),
            SimpleNamespace(returncode=0, stdout=json.dumps([]), stderr=""),
        ])

        provider = LiveRNSProvider(runner=lambda command, timeout: next(responses))
        provider.register_local_service({
            "destination_hash": "a" * 32,
            "name": "Reticulated topology ingest",
            "type": "reticulated_topology_ingest",
        })
        state = provider.collect()

        self.assertTrue(any(
            service["type"] == "reticulated_topology_ingest"
            for service in state["local_services"]
        ))

    def test_captured_announce_is_enriched_from_current_path(self):
        responses = iter([
            SimpleNamespace(returncode=0, stdout=json.dumps(STATUS), stderr=""),
            SimpleNamespace(returncode=0, stdout=json.dumps(PATHS), stderr=""),
            SimpleNamespace(returncode=0, stdout=json.dumps([]), stderr=""),
        ])

        class Capture:
            def snapshot(self):
                return {
                    "active": True,
                    "events": [{
                        "id": "packet-a", "destination_hash": "destination-a",
                        "received_at": 100.0,
                    }],
                }

        provider = LiveRNSProvider(
            runner=lambda command, timeout: next(responses), announce_capture=Capture()
        )
        state = provider.collect()

        event = state["announces"]["events"][0]
        self.assertEqual(event["route_hops"], 4)
        self.assertEqual(event["route_via"], "transport-x")
        self.assertEqual(event["route_interface"], "BackboneInterface[NYC Backbone]")
        compact = topology_snapshot(state)
        self.assertEqual(compact["announce_summary"]["event_count"], 1)
        self.assertEqual(compact["announce_summary"]["enriched_destination_count"], 1)
        self.assertNotIn("events", compact["announces"])
        self.assertEqual(len(compact["destinations"]), 1)
        self.assertTrue(compact["destinations"][0]["announced"])
        self.assertEqual(compact["destinations"][0]["hash"], "destination-a")
        self.assertTrue(any(
            edge["kind"] == "known_path"
            and edge["target"] == compact["destinations"][0]["id"]
            for edge in compact["edges"]
        ))
        full = topology_snapshot(state, include_announces=True)
        self.assertEqual(full["announces"]["events"][0]["id"], "packet-a")

    def test_announce_route_creates_historical_next_hop_when_path_expired(self):
        state = LiveRNSProvider.normalize(STATUS, [], label="Patroon")
        state["announces"] = {
            "active": True,
            "events": [{
                "id": "packet-a",
                "destination_hash": "destination-a",
                "identity_hash": "identity-a",
                "aspect": "lxmf.delivery",
                "received_at": 100.0,
                "route_hops": 3,
                "route_via": "transport-x",
                "route_interface": "BackboneInterface[NYC Backbone]",
            }],
        }

        compact = topology_snapshot(state)

        destination = compact["destinations"][0]
        self.assertEqual(destination["id"], "announce-destination:destination-a")
        self.assertEqual(destination["announce_aspect"], "lxmf.delivery")
        inferred_transport = next(
            item for item in compact["transports"] if item["hash"] == "transport-x"
        )
        self.assertTrue(inferred_transport["announce_inferred"])
        next_hop_edge = next(
            edge for edge in compact["edges"]
            if edge["kind"] == "announce_next_hop"
        )
        self.assertEqual(next_hop_edge["source"], "interface:aabbccdd")
        path_edge = next(
            edge for edge in compact["edges"] if edge["kind"] == "known_path"
        )
        self.assertEqual(path_edge["source"], "transport:transport-x")
        self.assertEqual(path_edge["unknown_hops"], 2)
        self.assertEqual(path_edge["evidence"], "received_announce")

    def test_zero_hop_local_path_does_not_create_a_transport(self):
        destination_hash = "c" * 32
        local_path = [{
            "hash": destination_hash,
            "timestamp": 1234,
            "via": destination_hash,
            "hops": 0,
            "expires": 2345,
            "interface": "LocalInterface[rns/patroon]",
        }]
        service = {
            "destination_hash": destination_hash,
            "name": "Patroon rnsh",
            "type": "rnsh",
        }
        state = LiveRNSProvider.normalize(
            {"interfaces": []}, local_path, label="Patroon", local_services=[service]
        )

        self.assertEqual(state["transports"], [])
        self.assertIsNone(state["destinations"][0]["via"])
        self.assertTrue(state["destinations"][0]["local"])
        self.assertEqual(state["destinations"][0]["local_service"]["name"], "Patroon rnsh")
        path_edge = next(edge for edge in state["edges"] if edge["kind"] == "known_path")
        self.assertEqual(path_edge["source"], state["interfaces"][0]["id"])
        self.assertEqual(path_edge["unknown_hops"], 0)
        compact = topology_snapshot(state)
        self.assertEqual(len(compact["destinations"]), 1)
        self.assertEqual(compact["service_summary"], {
            "local_destination_count": 1,
            "identified_count": 1,
        })

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
