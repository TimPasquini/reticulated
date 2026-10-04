import assert from "node:assert/strict";
import test from "node:test";

import {
  anchorNewPositions,
  captureLayoutState,
  mergeLivePositions,
  pruneLiveLayout,
  radialClusterPosition,
  rememberLivePosition,
} from "../web/live-layout.mjs";

test("saving retains coordinates and counts for pins absent from the graph", () => {
  const captured = captureLayoutState(
    {
      positions: {
        hiddenPin: { x: -700, y: 450 },
        obsolete: { x: 1, y: 2 },
      },
      pinned: ["hiddenPin"],
    },
    { visiblePin: { x: 300, y: -200 }, visibleLoose: { x: 20, y: 30 } },
    new Set(["hiddenPin", "visiblePin"]),
    { zoom: 1, pan: { x: 0, y: 0 } },
  );

  assert.deepEqual(captured.pinned, ["hiddenPin", "visiblePin"]);
  assert.deepEqual(captured.positions.hiddenPin, { x: -700, y: 450 });
  assert.deepEqual(captured.positions.visiblePin, { x: 300, y: -200 });
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
