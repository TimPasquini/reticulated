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

export function shouldAutoSolveLiveLayout({
  pending = false, hadGraph = false, hasSavedPositions = false, blankSlate = false,
} = {}) {
  // Saved coordinates describe an arrangement, not merely seeds for a force
  // solver. Preserve them exactly until the user explicitly requests Layout.
  // New nodes are already placed relative to their closest known parent by
  // anchorNewPositions(), so they do not require a global noisy re-solve.
  return !blankSlate && !hasSavedPositions && (pending || !hadGraph);
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

export function radialFanPosition(
  anchor, index, count, directionAngle, baseRadius = 210, spacing = 110
) {
  const safeCount = Math.max(1, count);
  const perRing = 12;
  const ring = Math.floor(index / perRing);
  const ringIndex = index % perRing;
  const ringCount = Math.min(perRing, safeCount - ring * perRing);
  const arc = Math.min(Math.PI * 0.8, Math.max(0, (ringCount - 1) * 0.24));
  const angle = ringCount === 1
    ? directionAngle
    : directionAngle - arc / 2 + arc * ringIndex / (ringCount - 1);
  const radius = baseRadius + ring * spacing;
  return {
    x: anchor.x + Math.cos(angle) * radius,
    y: anchor.y + Math.sin(angle) * radius,
  };
}

export function liveSemanticGroup(kind, item = {}) {
  const text = [
    item.type, item.interface_type, item.name, item.display_name,
    item.announce_aspect, ...(item.announce_aspects || []),
    item.local_service && item.local_service.type,
    item.local_service && item.local_service.name,
  ].filter(Boolean).join(" ").toLowerCase();
  if (kind === "ghost_segment") {
    const hops = Number(item.unknown_hops || item.hop_delta);
    return "path:" + (Number.isFinite(hops) && hops > 0 ? String(hops) : "unknown");
  }
  if (kind === "destination_group") return "path:" + String(item.hop_tier || "unknown");
  if (kind === "interface") {
    if (/i2p/.test(text)) return "interface:i2p";
    if (/rnode|lora|radio/.test(text)) return "interface:radio";
    if (/backbone|boundary|tcp/.test(text)) return "interface:backbone";
    if (/auto/.test(text)) return "interface:auto";
    if (/local|shared/.test(text)) return "interface:local";
    return "interface:other";
  }
  if (kind === "destination" || kind === "announce_identity") {
    if (/lxmf/.test(text)) return "service:lxmf";
    if (/rnsh/.test(text)) return "service:rnsh";
    if (/probe/.test(text)) return "service:probe";
    if (/topology/.test(text)) return "service:topology";
    const aspect = String(item.announce_aspect || (item.announce_aspects || [])[0] || "");
    return "service:" + (aspect.split(".")[0] || "other");
  }
  if (kind === "rmap_transport" || kind === "persisted_rmap") return "transit:rmap";
  if (kind === "transport") return "transit:next-hop";
  if (kind === "root") return "transit:reporter";
  return kind || "other";
}

export function clusteredForkPositions(anchor, groups, directionAngle, options = {}) {
  const forward = { x: Math.cos(directionAngle), y: Math.sin(directionAngle) };
  const lateral = { x: -forward.y, y: forward.x };
  // These distances account for both the node body and its rendered label.
  // Shorter point-graph defaults technically avoid overlap but leave almost
  // no inspectable edge between Reticulated's 100-150px labelled nodes.
  const cellDepth = options.cellDepth || 320;
  const cellWidth = options.cellWidth || 260;
  const stem = options.stem || 720;
  const gap = options.gap || 420;
  const prepared = Array.from(groups.entries()).sort(([left], [right]) =>
    left.localeCompare(right)
  ).map(([key, ids]) => {
    const columns = Math.max(1, Math.ceil(Math.sqrt(ids.length)));
    const rows = Math.max(1, Math.ceil(ids.length / columns));
    return {
      key, ids: ids.slice().sort(), columns, rows,
      width: Math.max(380, (rows - 1) * cellWidth + 180),
    };
  });
  const totalWidth = prepared.reduce((sum, group) => sum + group.width, 0) +
    Math.max(0, prepared.length - 1) * gap;
  let cursor = -totalWidth / 2;
  const result = {};
  for (const group of prepared) {
    const groupCenter = cursor + group.width / 2;
    group.ids.forEach((id, index) => {
      const column = Math.floor(index / group.rows);
      const row = index % group.rows;
      const side = groupCenter + (row - (group.rows - 1) / 2) * cellWidth;
      const depth = stem + column * cellDepth;
      result[id] = {
        x: anchor.x + forward.x * depth + lateral.x * side,
        y: anchor.y + forward.y * depth + lateral.y * side,
      };
    });
    cursor += group.width + gap;
  }
  return result;
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
      const offset = lane * 260;
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
  const parentByNode = new Map();
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
    parentByNode.set(node.id, parent);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(node.id);
  }
  const branchGroupMemo = new Map();
  const branchGroup = (id, visiting = new Set()) => {
    if (branchGroupMemo.has(id)) return branchGroupMemo.get(id);
    const node = nodeById.get(id) || {};
    const own = node.semanticGroup || liveSemanticGroup(node.kind, node.item || {});
    if (visiting.has(id)) return own;
    const nextVisiting = new Set(visiting).add(id);
    const descendantGroups = Array.from(new Set((children.get(id) || []).map((child) =>
      branchGroup(child, nextVisiting)
    ))).sort();
    // Unknown-hop bodies are more useful when grouped first by depth and then
    // by the service eventually reached through that uncertainty.
    const group = node.kind === "ghost_segment" && descendantGroups.length
      ? own + "/" + descendantGroups.join("+")
      : own;
    branchGroupMemo.set(id, group);
    return group;
  };
  const anchorCenter = averagePoint(anchors.map((id) => positions[id]).filter(Boolean));
  const parentDepth = (id) => {
    let depth = 0;
    const seen = new Set();
    while (parentByNode.has(id) && !seen.has(id)) {
      seen.add(id);
      id = parentByNode.get(id);
      depth += 1;
    }
    return depth;
  };
  const orderedChildren = Array.from(children.entries()).sort(([left], [right]) =>
    parentDepth(left) - parentDepth(right) || left.localeCompare(right)
  );
  for (const [parent, ids] of orderedChildren) {
    const anchor = positions[parent] || averagePoint(ids.map((id) => positions[id]).filter(Boolean));
    const upstream = parentByNode.get(parent);
    const upstreamPosition = upstream && positions[upstream];
    let outwardAngle = upstreamPosition
      ? Math.atan2(anchor.y - upstreamPosition.y, anchor.x - upstreamPosition.x)
      : null;
    if (outwardAngle === null) {
      const awayX = anchor.x - anchorCenter.x;
      const awayY = anchor.y - anchorCenter.y;
      outwardAngle = Math.hypot(awayX, awayY) > 1
        ? Math.atan2(awayY, awayX)
        : -Math.PI / 2;
    }
    const groups = new Map();
    ids.forEach((id) => {
      const key = branchGroup(id);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(id);
    });
    const packed = clusteredForkPositions(anchor, groups, outwardAngle);
    ids.sort();
    ids.forEach((id) => {
      positions[id] = packed[id];
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
