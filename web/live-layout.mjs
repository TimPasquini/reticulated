export function mergeLivePositions(generated, saved, current, pinnedIds) {
  const merged = { ...(generated || {}), ...(saved || {}) };
  const pinned = pinnedIds instanceof Set ? pinnedIds : new Set(pinnedIds || []);
  Object.entries(current || {}).forEach(([id, position]) => {
    // A persisted pin is the anchor. Unpinned nodes retain their most recent
    // screen position when a changing graph is rebuilt.
    if (!pinned.has(id) || !saved || !saved[id]) merged[id] = position;
  });
  return merged;
}

export function rememberLivePosition(layout, nodeId, position, pinnedIds) {
  const current = layout || {};
  return {
    ...current,
    positions: {
      ...(current.positions || {}),
      [nodeId]: { x: position.x, y: position.y },
    },
    pinned: Array.from(pinnedIds || []).sort(),
  };
}

export function pruneLiveLayout(layout, activeIds) {
  if (!layout || !layout.positions) return { layout: layout, changed: false };
  const active = activeIds instanceof Set ? activeIds : new Set(activeIds || []);
  const pinned = new Set(layout.pinned || []);
  const positions = {};
  Object.entries(layout.positions).forEach(([id, position]) => {
    // An absent pin is intentional retained state: the node may only be
    // missing from one transient report and must return to the same anchor.
    if (active.has(id) || pinned.has(id)) positions[id] = position;
  });
  const retainedPins = (layout.pinned || []).filter((id) => positions[id]);
  const changed = Object.keys(positions).length !== Object.keys(layout.positions).length ||
    retainedPins.length !== (layout.pinned || []).length;
  return {
    layout: changed ? { ...layout, positions: positions, pinned: retainedPins } : layout,
    changed: changed,
  };
}
