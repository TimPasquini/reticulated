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
  anchor, index, baseRadius = 210, spacing = 110, startAngle = Math.PI / 2
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

export function orthogonalSegmentGeometry(section) {
  const bends = (section && section.bendPoints) || [];
  const start = section && section.startPoint;
  const end = section && section.endPoint;
  if (!start || !end || !bends.length) return null;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const length = Math.sqrt(lengthSquared);
  if (length < 0.001) return null;
  return {
    weights: bends.map((point) =>
      ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared
    ),
    distances: bends.map((point) =>
      ((point.y - start.y) * dx - (point.x - start.x) * dy) / length
    ),
  };
}

export function elkLayerBound(nodeCount) {
  // A square-root bound makes a wide star spill into roughly balanced rows
  // and columns instead of placing every spoke in one enormous vertical
  // layer. Keep tiny graphs layered and cap huge graphs at a readable row.
  return Math.max(8, Math.min(28, Math.round(Math.sqrt(Math.max(1, nodeCount)))));
}

const TRANSIT_KINDS = new Set([
  "root", "interface", "transport", "rmap_transport", "persisted_rmap",
]);

function graphDistances(start, adjacency) {
  const distances = new Map([[start, 0]]);
  const queue = [start];
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index];
    for (const neighbor of adjacency.get(id) || []) {
      if (distances.has(neighbor)) continue;
      distances.set(neighbor, distances.get(id) + 1);
      queue.push(neighbor);
    }
  }
  return distances;
}

function averagePoint(points) {
  if (!points.length) return { x: 0, y: 0 };
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
}

/**
 * Build a topology-aware hybrid layout without moving any explicit anchors.
 *
 * Pinned high-degree/interface nodes form exchange points. Transit-shaped
 * nodes that are graph-close to two exchange points are assigned to a narrow
 * corridor between them; terminal nodes fan out around their closest placed
 * parent. This models the common Reticulum hub/spoke plus transfer-bus shape
 * more honestly than treating every observed edge as an identical spring.
 */
export function hybridBusPositions(nodes, edges, initialPositions, pinnedIds) {
  const nodeById = new Map((nodes || []).map((node) => [node.id, node]));
  const adjacency = new Map(Array.from(nodeById.keys(), (id) => [id, new Set()]));
  const incoming = new Map(Array.from(nodeById.keys(), (id) => [id, []]));
  (edges || []).forEach((edge) => {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) return;
    adjacency.get(edge.source).add(edge.target);
    adjacency.get(edge.target).add(edge.source);
    incoming.get(edge.target).push(edge.source);
  });

  const pinned = pinnedIds instanceof Set ? pinnedIds : new Set(pinnedIds || []);
  const positions = Object.fromEntries(Object.entries(initialPositions || {}).map(
    ([id, point]) => [id, { x: point.x, y: point.y }]
  ));
  const degree = (id) => (adjacency.get(id) || new Set()).size;

  // Manual anchors come first. If the graph has fewer than two, stable
  // topology hubs supplement them so the mode is still useful before a user
  // has curated a layout. Supplemental anchors are placement references, not
  // pins, and therefore remain movable by later runs or by the user.
  const anchors = Array.from(pinned).filter((id) =>
    nodeById.has(id) && positions[id] && TRANSIT_KINDS.has(nodeById.get(id).kind)
  );
  const supplemental = Array.from(nodeById.values()).filter((node) =>
    positions[node.id] && !pinned.has(node.id) &&
    (node.kind === "root" || (TRANSIT_KINDS.has(node.kind) && degree(node.id) >= 3))
  ).sort((left, right) => degree(right.id) - degree(left.id) || left.id.localeCompare(right.id));
  for (const node of supplemental) {
    if (anchors.length >= 32) break;
    anchors.push(node.id);
  }
  if (!anchors.length && nodes && nodes.length) anchors.push(nodes[0].id);

  const distanceByAnchor = new Map(anchors.map((id) => [id, graphDistances(id, adjacency)]));
  const corridorAssignments = new Map();
  for (const node of nodes || []) {
    if (pinned.has(node.id) || !TRANSIT_KINDS.has(node.kind)) continue;
    const closest = anchors.map((anchorId) => ({
      id: anchorId,
      distance: distanceByAnchor.get(anchorId).get(node.id),
    })).filter((entry) => Number.isFinite(entry.distance) && entry.distance > 0)
      .sort((left, right) => left.distance - right.distance || left.id.localeCompare(right.id));
    if (closest.length < 2) continue;
    const first = closest[0];
    const second = closest.find((entry) => entry.id !== first.id);
    if (!second || first.distance + second.distance > 12) continue;
    const pair = [first.id, second.id].sort();
    const key = pair.join("\u0000");
    if (!corridorAssignments.has(key)) corridorAssignments.set(key, []);
    corridorAssignments.get(key).push({
      id: node.id,
      first: first,
      second: second,
      pair: pair,
    });
  }

  const busNodeIds = new Set(anchors);
  for (const entries of corridorAssignments.values()) {
    entries.sort((left, right) => {
      const leftTotal = left.first.distance + left.second.distance;
      const rightTotal = right.first.distance + right.second.distance;
      const leftT = left.first.distance / leftTotal;
      const rightT = right.first.distance / rightTotal;
      return leftT - rightT || left.id.localeCompare(right.id);
    });
    entries.forEach((entry, index) => {
      const a = positions[entry.first.id];
      const b = positions[entry.second.id];
      if (!a || !b) return;
      const total = entry.first.distance + entry.second.distance;
      const t = Math.max(0.12, Math.min(0.88, entry.first.distance / total));
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.max(1, Math.hypot(dx, dy));
      // Parallel lanes keep multiple logical transfers legible without
      // pretending that their intermediate routers are known.
      const lane = index - (entries.length - 1) / 2;
      const offset = lane * 110;
      positions[entry.id] = {
        x: a.x + dx * t - (dy / length) * offset,
        y: a.y + dy * t + (dx / length) * offset,
      };
      busNodeIds.add(entry.id);
    });
  }

  // Attach everything not assigned to a corridor to its strongest already
  // placed predecessor. Grouping first gives each hub a bounded golden-angle
  // fan instead of a long horizontal destination row.
  const children = new Map();
  for (const node of nodes || []) {
    if (pinned.has(node.id) || busNodeIds.has(node.id)) continue;
    const candidates = (incoming.get(node.id) || []).filter((id) => positions[id]);
    const neighbors = candidates.length ? candidates : Array.from(adjacency.get(node.id) || [])
      .filter((id) => positions[id]);
    if (!neighbors.length) continue;
    neighbors.sort((left, right) => {
      const leftPlaced = busNodeIds.has(left) || pinned.has(left) ? 1 : 0;
      const rightPlaced = busNodeIds.has(right) || pinned.has(right) ? 1 : 0;
      return rightPlaced - leftPlaced || degree(right) - degree(left) || left.localeCompare(right);
    });
    const parent = neighbors[0];
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(node.id);
  }
  for (const [parent, ids] of children) {
    const anchor = positions[parent] || averagePoint(ids.map((id) => positions[id]).filter(Boolean));
    ids.sort();
    ids.forEach((id, index) => {
      positions[id] = radialClusterPosition(anchor, index, 210, 110, Math.PI / 2);
    });
  }

  const busEdgeIds = new Set();
  (edges || []).forEach((edge) => {
    if (busNodeIds.has(edge.source) && busNodeIds.has(edge.target)) busEdgeIds.add(edge.id);
  });
  return { positions, busNodeIds, busEdgeIds };
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

export function captureLayoutState(
  layout, visiblePositions, pinnedIds, viewport, visiblePinnedNodes = {}
) {
  const positions = { ...(visiblePositions || {}) };
  const previousPositions = (layout || {}).positions || {};
  const pinned = Array.from(pinnedIds || []).sort();
  pinned.forEach((id) => {
    // A pin is durable layout state even when its node is absent from this
    // particular report. Preserve only pinned background coordinates; stale
    // unpinned nodes remain eligible for pruning.
    if (!positions[id] && previousPositions[id]) positions[id] = previousPositions[id];
  });
  const pinnedNodes = {};
  pinned.forEach((id) => {
    const metadata = visiblePinnedNodes[id] || ((layout || {}).pinned_nodes || {})[id];
    if (metadata) pinnedNodes[id] = metadata;
  });
  return {
    positions: positions,
    pinned: pinned.filter((id) => positions[id]),
    pinned_nodes: pinnedNodes,
    viewport: viewport,
  };
}

export function clearPinnedLayout(layout) {
  if (!layout) return layout;
  return { ...layout, pinned: [], pinned_nodes: {} };
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
  const pinnedNodes = {};
  retainedPins.forEach((id) => {
    if ((layout.pinned_nodes || {})[id]) pinnedNodes[id] = layout.pinned_nodes[id];
  });
  const changed = Object.keys(positions).length !== Object.keys(layout.positions).length ||
    retainedPins.length !== (layout.pinned || []).length ||
    Object.keys(pinnedNodes).length !== Object.keys(layout.pinned_nodes || {}).length;
  return {
    layout: changed ? {
      ...layout, positions: positions, pinned: retainedPins, pinned_nodes: pinnedNodes,
    } : layout,
    changed: changed,
  };
}

export function rememberedPinnedRmapNodes(layout, pinnedIds, activeIds) {
  const pinned = pinnedIds instanceof Set ? pinnedIds : new Set(pinnedIds || []);
  const active = activeIds instanceof Set ? activeIds : new Set(activeIds || []);
  if (!layout) return [];
  return Object.entries(layout.pinned_nodes || {}).flatMap(([id, metadata]) => {
    const position = (layout.positions || {})[id];
    if (!pinned.has(id) || active.has(id) || !position) return [];
    return [{ id: id, metadata: metadata, position: position }];
  });
}
