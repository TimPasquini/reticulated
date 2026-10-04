import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeLivePositions,
  pruneLiveLayout,
  rememberLivePosition,
} from "../web/live-layout.mjs";

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
