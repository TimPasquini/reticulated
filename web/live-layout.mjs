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

export function anchorNewPositions(generated, merged, saved, current, edges) {
  const positions = { ...(merged || {}) };
  const existing = new Set([
    ...Object.keys(saved || {}),
    ...Object.keys(current || {}),
  ]);
  const incoming = new Map();
  (edges || []).forEach((edge) => {
    if (!edge || !edge.source || !edge.target) return;
    if (!incoming.has(edge.target)) incoming.set(edge.target, []);
    incoming.get(edge.target).push(edge.source);
  });

  const anchored = new Set(existing);
  Object.keys(generated || {}).forEach((id) => {
    if (!incoming.has(id)) anchored.add(id);
  });
  const pending = new Set(
    Object.keys(generated || {}).filter((id) => !existing.has(id) && incoming.has(id))
  );

  // Translate each new node's topology-aware seed offset to the final
  // current/saved location of its closest resolved parent. Iteration handles
  // root -> interface -> transport -> destination chains without returning
  // descendants to the generated origin.
  const maxPasses = pending.size + 1;
  for (let pass = 0; pass < maxPasses && pending.size; pass += 1) {
    let progressed = false;
    Array.from(pending).forEach((id) => {
      const childSeed = (generated || {})[id];
      if (!childSeed) return;
      const translated = (incoming.get(id) || []).filter((source) =>
        anchored.has(source) && positions[source] && (generated || {})[source]
      ).map((source) => ({
        x: positions[source].x + childSeed.x - generated[source].x,
        y: positions[source].y + childSeed.y - generated[source].y,
      }));
      if (!translated.length) return;
      positions[id] = {
        x: translated.reduce((sum, item) => sum + item.x, 0) / translated.length,
        y: translated.reduce((sum, item) => sum + item.y, 0) / translated.length,
      };
      anchored.add(id);
      pending.delete(id);
      progressed = true;
    });
    if (!progressed) break;
  }
  return positions;
}

export function radialClusterPosition(
  anchor, index, baseRadius = 140, spacing = 85, startAngle = Math.PI / 2
) {
  // Golden-angle spiral: deterministic, roughly round, and its width grows
  // with sqrt(count) instead of linearly with the number of siblings.
  const angle = startAngle + index * Math.PI * (3 - Math.sqrt(5));
  const radius = baseRadius + spacing * Math.sqrt(index);
  return {
    x: anchor.x + Math.cos(angle) * radius,
    y: anchor.y + Math.sin(angle) * radius,
  };
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

export function captureLayoutState(layout, visiblePositions, pinnedIds, viewport) {
  const positions = { ...(visiblePositions || {}) };
  const previousPositions = (layout || {}).positions || {};
  const pinned = Array.from(pinnedIds || []).sort();
  pinned.forEach((id) => {
    // A pin is durable layout state even when its node is absent from this
    // particular report. Preserve only pinned background coordinates; stale
    // unpinned nodes remain eligible for pruning.
    if (!positions[id] && previousPositions[id]) positions[id] = previousPositions[id];
  });
  return {
    positions: positions,
    pinned: pinned.filter((id) => positions[id]),
    viewport: viewport,
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
