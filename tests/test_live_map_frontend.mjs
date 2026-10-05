import assert from "node:assert/strict";
import test from "node:test";

import { buildGeographicTopology } from "../web/live-map.mjs";

test("geographic topology anchors RMAP nodes and schematically places connected evidence", () => {
  const snapshot = {
    root: { id: "instance:patroon", reporter_id: "patroon", transport_id: "patroon", label: "Patroon" },
    reporter_roots: [
      { id: "instance:patroon", reporter_id: "patroon", transport_id: "patroon", label: "Patroon" },
    ],
    interfaces: [{ id: "interface:i2p", name: "Patroon I2P", type: "I2PInterface" }],
    transports: [{ id: "transport:next", hash: "next" }],
    rmap_interfaces: [{
      id: "rmap:patroon", reporter_id: "patroon", transport_id: "patroon",
      name: "Patroon", latitude: 40, longitude: -75, hops: 0,
    }],
    rmap_matches: [],
    rmap_attachments: [],
  };
  const renderModel = {
    destinationNodes: [
      { kind: "ghost_segment", item: { id: "ghost:route", unknown_hops: 2, label: "2 unknown hops" } },
      { kind: "announced_destination", item: { id: "destination:lxmf", hash: "lxmf", announce_aspect: "lxmf.delivery" } },
    ],
    rmapMatches: {},
    edges: [
      { id: "root-interface", source: "instance:patroon", target: "interface:i2p", kind: "observed_interface", certainty: "observed" },
      { id: "interface-next", source: "interface:i2p", target: "transport:next", kind: "observed_next_hop", certainty: "observed" },
      { id: "next-ghost", source: "transport:next", target: "ghost:route", kind: "unknown_segment", certainty: "incomplete", hops: 3 },
      { id: "ghost-lxmf", source: "ghost:route", target: "destination:lxmf", kind: "ghost_completion", certainty: "incomplete", hops: 1 },
    ],
  };

  const topology = buildGeographicTopology(snapshot, renderModel);

  assert.equal(topology.locations.get("instance:patroon").actual, true);
  assert.equal(topology.locations.get("interface:i2p").actual, false);
  assert.equal(topology.locations.get("interface:i2p").anchorId, "instance:patroon");
  assert.equal(topology.locations.get("ghost:route").distance, 3);
  assert.equal(topology.locations.get("destination:lxmf").distance, 4);
  assert.equal(topology.actualCount, 1);
  assert.equal(topology.syntheticCount, 4);
  assert.equal(topology.omittedCount, 0);
  assert.equal(topology.edges.length, 4);
});

test("unconnected nodes without coordinates are omitted instead of geolocated by guess", () => {
  const topology = buildGeographicTopology({
    root: { id: "instance:unknown", label: "Unknown" },
    interfaces: [], transports: [], rmap_interfaces: [], rmap_matches: [], rmap_attachments: [],
  }, { destinationNodes: [], edges: [], rmapMatches: {} });

  assert.equal(topology.locations.size, 0);
  assert.equal(topology.omittedCount, 1);
});
