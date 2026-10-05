import assert from "node:assert/strict";
import test from "node:test";

import {
  anchorNewPositions,
  captureLayoutState,
  hybridBusPositions,
  mergeLivePositions,
  pruneLiveLayout,
  radialClusterPosition,
  rememberedPinnedRmapNodes,
  rememberLivePosition,
} from "../web/live-layout.mjs";

test("hybrid bus layout preserves pins and places transit nodes between anchors", () => {
  const result = hybridBusPositions([
    { id: "west", kind: "interface" },
    { id: "east", kind: "interface" },
    { id: "transit", kind: "transport" },
    { id: "leaf", kind: "destination" },
  ], [
    { id: "w-t", source: "west", target: "transit" },
    { id: "t-e", source: "transit", target: "east" },
    { id: "t-l", source: "transit", target: "leaf" },
  ], {
    west: { x: -500, y: -120 },
    east: { x: 500, y: 120 },
    transit: { x: 9000, y: 9000 },
    leaf: { x: 9100, y: 9100 },
  }, new Set(["west", "east"]));

  assert.deepEqual(result.positions.west, { x: -500, y: -120 });
  assert.deepEqual(result.positions.east, { x: 500, y: 120 });
  assert.ok(result.positions.transit.x > -500 && result.positions.transit.x < 500);
  assert.ok(Math.hypot(
    result.positions.leaf.x - result.positions.transit.x,
    result.positions.leaf.y - result.positions.transit.y,
  ) < 400);
  assert.ok(result.busEdgeIds.has("w-t"));
  assert.ok(result.busEdgeIds.has("t-e"));
});

test("a pinned RMAP node is rehydrated when its active route disappears", () => {
  const remembered = rememberedPinnedRmapNodes({
    positions: { rmapNode: { x: -90, y: 250 } },
    pinned: ["rmapNode"],
    pinned_nodes: {
      rmapNode: {
        label: "◆ RMAP · Patroon",
        live_kind: "transport",
        hash: "09985437",
        rmap_records: [{ transport_id: "09985437" }],
      },
    },
  }, new Set(["rmapNode"]), new Set());

  assert.equal(remembered.length, 1);
  assert.equal(remembered[0].metadata.hash, "09985437");
  assert.deepEqual(remembered[0].position, { x: -90, y: 250 });
  assert.equal(
    rememberedPinnedRmapNodes(
      { positions: { rmapNode: { x: 0, y: 0 } }, pinned_nodes: { rmapNode: {} } },
      new Set(["rmapNode"]),
      new Set(["rmapNode"]),
    ).length,
    0,
  );
});

test("saving retains coordinates and counts for pins absent from the graph", () => {
  const captured = captureLayoutState(
    {
      positions: {
        hiddenPin: { x: -700, y: 450 },
        obsolete: { x: 1, y: 2 },
      },
      pinned: ["hiddenPin"],
      pinned_nodes: {
        hiddenPin: {
          label: "◆ RMAP · Hidden",
          live_kind: "transport",
          hash: "abc123",
          rmap_records: [{ id: "rmap:hidden", transport_id: "abc123" }],
        },
      },
    },
    { visiblePin: { x: 300, y: -200 }, visibleLoose: { x: 20, y: 30 } },
    new Set(["hiddenPin", "visiblePin"]),
    { zoom: 1, pan: { x: 0, y: 0 } },
    {
      visiblePin: {
        label: "◆ RMAP · Visible",
        live_kind: "transport",
        hash: "def456",
        rmap_records: [{ id: "rmap:visible", transport_id: "def456" }],
      },
    },
  );

  assert.deepEqual(captured.pinned, ["hiddenPin", "visiblePin"]);
  assert.deepEqual(captured.positions.hiddenPin, { x: -700, y: 450 });
  assert.deepEqual(captured.positions.visiblePin, { x: 300, y: -200 });
  assert.equal(captured.pinned_nodes.hiddenPin.hash, "abc123");
  assert.equal(captured.pinned_nodes.visiblePin.hash, "def456");
  assert.equal(captured.positions.obsolete, undefined);
});

test("large sibling sets form a bounded cluster instead of an unbounded row", () => {
  const points = Array.from({ length: 250 }, (_, index) =>
    radialClusterPosition({ x: 1000, y: -500 }, index, 150, 78)
  );
  const width = Math.max(...points.map((point) => point.x)) -
    Math.min(...points.map((point) => point.x));
  const height = Math.max(...points.map((point) => point.y)) -
    Math.min(...points.map((point) => point.y));

  assert.ok(width < 3000);
  assert.ok(height < 3000);
  assert.ok(width > 1500);
  assert.ok(height > 1500);
});

test("new descendants are translated to a moved parent's final position", () => {
  const generated = {
    root: { x: 0, y: 0 },
    interface: { x: 100, y: 150 },
    destination: { x: 130, y: 300 },
  };
  const current = { root: { x: 1200, y: -800 } };
  const merged = mergeLivePositions(generated, {}, current, new Set(["root"]));
  const anchored = anchorNewPositions(generated, merged, {}, current, [
    { source: "root", target: "interface" },
    { source: "interface", target: "destination" },
  ]);

  assert.deepEqual(anchored.interface, { x: 1300, y: -650 });
  assert.deepEqual(anchored.destination, { x: 1330, y: -500 });
});

test("persisted pin wins redraw position without changing coordinate signs", () => {
  const positions = mergeLivePositions(
    { pinned: { x: 1, y: 2 }, loose: { x: 3, y: 4 } },
    { pinned: { x: -125.5, y: 240.25 }, loose: { x: -8, y: -9 } },
    { pinned: { x: 900, y: -700 }, loose: { x: 80, y: -90 } },
    new Set(["pinned"]),
  );

  assert.deepEqual(positions.pinned, { x: -125.5, y: 240.25 });
  assert.deepEqual(positions.loose, { x: 80, y: -90 });
});

test("moving a pinned node immediately replaces its persisted coordinates", () => {
  const moved = rememberLivePosition(
    { positions: { node: { x: 10, y: 20 } }, pinned: ["node"] },
    "node",
    { x: 321.75, y: -654.5 },
    new Set(["node"]),
  );

  assert.deepEqual(moved.positions.node, { x: 321.75, y: -654.5 });
  assert.deepEqual(moved.pinned, ["node"]);
});

test("pruning retains an absent pin but removes obsolete unpinned coordinates", () => {
  const result = pruneLiveLayout({
    positions: {
      active: { x: 1, y: -2 },
      absentPin: { x: -30, y: -40 },
      obsolete: { x: 50, y: 60 },
    },
    pinned: ["absentPin"],
  }, new Set(["active"]));

  assert.equal(result.changed, true);
  assert.deepEqual(result.layout.positions, {
    active: { x: 1, y: -2 },
    absentPin: { x: -30, y: -40 },
  });
  assert.deepEqual(result.layout.pinned, ["absentPin"]);
});
