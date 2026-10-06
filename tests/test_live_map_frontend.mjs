import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGeographicTopology,
  geographicDetailLevel,
  geographicVisibility,
} from "../web/live-map.mjs";

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
  assert.equal(topology.locations.get("instance:patroon").latitude, 40);
  assert.equal(topology.locations.get("instance:patroon").longitude, -75);
  assert.equal(topology.locations.get("interface:i2p").actual, false);
  assert.equal(topology.locations.get("interface:i2p").anchorId, "instance:patroon");
  assert.equal(topology.locations.get("ghost:route").distance, 3);
  assert.equal(topology.locations.get("destination:lxmf").distance, 4);
  assert.equal(topology.actualCount, 1);
  assert.equal(topology.syntheticCount, 4);
  assert.equal(topology.omittedCount, 0);
  assert.equal(topology.edges.length, 4);
  const ordered = [
    "instance:patroon", "interface:i2p", "transport:next", "ghost:route", "destination:lxmf",
  ].map((id) => topology.locations.get(id));
  for (let index = 2; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const beforePrevious = ordered[index - 2];
    const incoming = {
      x: previous.longitude - beforePrevious.longitude,
      y: previous.latitude - beforePrevious.latitude,
    };
    const outgoing = {
      x: ordered[index].longitude - previous.longitude,
      y: ordered[index].latitude - previous.latitude,
    };
    assert.ok(incoming.x * outgoing.x + incoming.y * outgoing.y > 0);
  }
});

test("unconnected nodes without coordinates are omitted instead of geolocated by guess", () => {
  const topology = buildGeographicTopology({
    root: { id: "instance:unknown", label: "Unknown" },
    interfaces: [], transports: [], rmap_interfaces: [], rmap_matches: [], rmap_attachments: [],
  }, { destinationNodes: [], edges: [], rmapMatches: {} });

  assert.equal(topology.locations.size, 0);
  assert.equal(topology.omittedCount, 1);
});

test("map detail progressively reveals topology and supports anchor expansion", () => {
  const nodes = [
    { id: "anchor", kind: "rmap_transport", item: {} },
    { id: "root", kind: "root", item: {} },
    { id: "interface", kind: "interface", item: { type: "I2PInterface" } },
    { id: "transport", kind: "transport", item: {} },
    { id: "lxmf", kind: "announced_destination", item: { announce_aspect: "lxmf.delivery" } },
  ];
  const locations = new Map(nodes.map((node, index) => [node.id, {
    latitude: 40 + index * 0.1, longitude: -75,
    actual: index === 0, anchorId: "anchor", distance: index,
  }]));
  const topology = { nodes, locations };

  const overview = geographicVisibility(topology, 3);
  assert.equal(geographicDetailLevel(3), "overview");
  assert.deepEqual(Array.from(overview.visible).sort(), ["anchor", "root"]);
  assert.equal(overview.groups.length, 3);

  const regional = geographicVisibility(topology, 6);
  assert.equal(regional.level, "regional");
  assert.ok(regional.visible.has("interface"));
  assert.ok(regional.visible.has("transport"));
  assert.equal(regional.visible.has("lxmf"), false);

  const expanded = geographicVisibility(topology, 3, new Set(["anchor"]));
  assert.equal(expanded.visible.size, nodes.length);
  assert.equal(expanded.groups.length, 0);

  const detail = geographicVisibility(topology, 9);
  assert.equal(detail.level, "detail");
  assert.equal(detail.visible.size, nodes.length);
});
