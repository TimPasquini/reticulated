function coordinate(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validCoordinate(latitude, longitude) {
  const lat = coordinate(latitude);
  const lon = coordinate(longitude);
  return lat !== null && lon !== null && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function hashNumber(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function semanticGroup(node) {
  const item = node.item || {};
  const text = [item.type, item.name, item.announce_aspect, ...(item.announce_aspects || [])]
    .filter(Boolean).join(" ").toLowerCase();
  if (node.kind === "ghost_segment") return "path:" + String(item.unknown_hops || "unknown");
  if (/lxmf/.test(text)) return "service:lxmf";
  if (/i2p/.test(text)) return "interface:i2p";
  if (/backbone|boundary|tcp/.test(text)) return "interface:backbone";
  if (/rnode|lora|radio/.test(text)) return "interface:radio";
  return node.kind || "other";
}

export function geographicDetailLevel(zoom) {
  if (Number(zoom) >= 8) return "detail";
  if (Number(zoom) >= 5) return "regional";
  return "overview";
}

export function geographicVisibility(topology, zoom, expandedAnchors = new Set()) {
  const expanded = expandedAnchors instanceof Set
    ? expandedAnchors : new Set(expandedAnchors || []);
  const level = geographicDetailLevel(zoom);
  const visible = new Set();
  const nodeById = new Map((topology.nodes || []).map((node) => [node.id, node]));
  for (const [id, location] of topology.locations || []) {
    const node = nodeById.get(id) || {};
    const anchorExpanded = expanded.has(location.anchorId);
    const structural = ["root", "interface", "transport", "rmap_transport"].includes(node.kind);
    if (
      location.actual || node.kind === "root" || anchorExpanded || level === "detail" ||
      level === "regional" && (structural || location.distance <= 2)
    ) visible.add(id);
  }

  const grouped = new Map();
  for (const [id, location] of topology.locations || []) {
    if (visible.has(id) || location.actual) continue;
    const node = nodeById.get(id);
    if (!node) continue;
    const key = location.anchorId + "|" + semanticGroup(node);
    if (!grouped.has(key)) grouped.set(key, {
      id: "map-group:" + key,
      anchorId: location.anchorId,
      semanticGroup: semanticGroup(node),
      members: [], latitude: 0, longitude: 0,
    });
    const group = grouped.get(key);
    group.members.push(id);
    group.latitude += location.latitude;
    group.longitude += location.longitude;
  }
  const groups = Array.from(grouped.values()).map((group) => ({
    ...group,
    count: group.members.length,
    latitude: group.latitude / group.members.length,
    longitude: group.longitude / group.members.length,
  })).sort((left, right) => left.id.localeCompare(right.id));
  return { level, visible, groups };
}

export function buildGeographicTopology(snapshot, renderModel) {
  const nodes = new Map();
  const edges = [];
  const roots = snapshot.reporter_roots || [snapshot.root];
  const rootByTransport = new Map();
  const addNode = (id, kind, item, label) => {
    if (!id) return;
    const existing = nodes.get(id);
    if (existing) {
      existing.item = { ...existing.item, ...(item || {}) };
      return;
    }
    nodes.set(id, { id, kind, item: item || {}, label: label || id });
  };
  for (const root of roots) {
    addNode(root.id, "root", root, root.label || root.reporter_id || "Reporter");
    if (root.transport_id) rootByTransport.set(String(root.transport_id), root.id);
  }
  for (const item of snapshot.interfaces || []) {
    addNode(item.id, "interface", item, item.display_name || item.short_name || item.name);
  }
  for (const item of snapshot.transports || []) {
    const canonical = rootByTransport.get(String(item.hash || "")) || item.id;
    addNode(canonical, "transport", item, item.name || item.hash || "Next hop");
  }
  for (const entry of renderModel.destinationNodes || []) {
    addNode(entry.item.id, entry.kind, entry.item, entry.item.label || entry.item.announce_aspect || entry.item.hash);
  }

  const canonicalId = (id) => {
    if (!id || !String(id).startsWith("transport:")) return id;
    return rootByTransport.get(String(id).slice("transport:".length)) || id;
  };
  const edgeKeys = new Set();
  const addEdge = (edge) => {
    const source = canonicalId(edge.source);
    const target = canonicalId(edge.target);
    if (!source || !target || source === target || !nodes.has(source) || !nodes.has(target)) return;
    const key = source + "|" + target + "|" + (edge.kind || "edge");
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ ...edge, source, target });
  };
  for (const edge of renderModel.edges || []) addEdge(edge);

  const recordsByTransport = new Map();
  for (const record of snapshot.rmap_interfaces || []) {
    if (!validCoordinate(record.latitude, record.longitude)) continue;
    const transportId = String(record.transport_id || "");
    if (!transportId) continue;
    if (!recordsByTransport.has(transportId)) recordsByTransport.set(transportId, []);
    recordsByTransport.get(transportId).push(record);
    const nodeId = rootByTransport.get(transportId) || "transport:" + transportId;
    addNode(nodeId, "rmap_transport", record, record.name || transportId);
  }
  for (const attachment of snapshot.rmap_attachments || []) {
    addEdge({
      id: "map-attachment:" + attachment.source + ":" + attachment.target,
      source: attachment.source,
      target: attachment.target,
      kind: "rmap_attachment",
      certainty: attachment.interface_online === true ? "observed" : "advertised",
      hops: 1,
      item: attachment,
    });
  }
  for (const record of snapshot.rmap_interfaces || []) {
    const root = roots.find((item) => item.reporter_id === record.reporter_id) || snapshot.root;
    const target = rootByTransport.get(String(record.transport_id || "")) ||
      (record.transport_id ? "transport:" + record.transport_id : null);
    const hops = Number(record.hops);
    if (root && target && Number.isFinite(hops) && hops > 0) {
      addEdge({
        id: "map-rmap-route:" + root.id + ":" + target,
        source: root.id, target, kind: "rmap_reachability",
        certainty: hops === 1 ? "observed" : "incomplete", hops,
      });
    }
  }

  const locations = new Map();
  const setActual = (nodeId, record) => {
    if (!nodes.has(nodeId) || locations.has(nodeId) || !validCoordinate(record.latitude, record.longitude)) return;
    locations.set(nodeId, {
      latitude: Number(record.latitude), longitude: Number(record.longitude),
      actual: true, anchorId: nodeId, distance: 0, record,
    });
  };
  for (const [transportId, records] of recordsByTransport) {
    setActual(rootByTransport.get(transportId) || "transport:" + transportId, records[0]);
  }
  for (const [nodeId, records] of Object.entries(renderModel.rmapMatches || {})) {
    const record = (records || []).find((item) => validCoordinate(item.latitude, item.longitude));
    if (record) setActual(canonicalId(nodeId), record);
  }
  for (const match of snapshot.rmap_matches || []) {
    if (validCoordinate(match.latitude, match.longitude)) setActual(match.interface_id, match);
  }

  const adjacency = new Map(Array.from(nodes.keys(), (id) => [id, new Set()]));
  for (const edge of edges) {
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  }
  const ownership = new Map();
  const queue = [];
  for (const id of locations.keys()) {
    ownership.set(id, { anchorId: id, distance: 0, parentId: null });
    queue.push(id);
  }
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    const owner = ownership.get(current);
    for (const neighbor of adjacency.get(current) || []) {
      if (ownership.has(neighbor)) continue;
      ownership.set(neighbor, {
        anchorId: owner.anchorId, distance: owner.distance + 1, parentId: current,
      });
      queue.push(neighbor);
    }
  }

  const childrenByParent = new Map();
  for (const [id, owner] of ownership) {
    if (locations.has(id)) continue;
    if (!childrenByParent.has(owner.parentId)) childrenByParent.set(owner.parentId, []);
    childrenByParent.get(owner.parentId).push({ id, owner, node: nodes.get(id) });
  }
  const parentIds = Array.from(childrenByParent.keys()).sort((left, right) =>
    (ownership.get(left)?.distance || 0) - (ownership.get(right)?.distance || 0) ||
    String(left).localeCompare(String(right))
  );
  for (const parentId of parentIds) {
    const parent = locations.get(parentId);
    if (!parent) continue;
    const groups = new Map();
    for (const member of childrenByParent.get(parentId) || []) {
      const key = semanticGroup(member.node);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(member);
    }
    const grouped = Array.from(groups.entries()).sort(([left], [right]) => left.localeCompare(right));
    const rotation = parent.actual
      ? (hashNumber(parentId) % 6283) / 1000
      : Number(parent.angle || 0);
    grouped.forEach(([, members], groupIndex) => {
      members.sort((left, right) => left.id.localeCompare(right.id));
      // Geographic anchors distribute major interface/service families around
      // the full hub. Descendants inherit their parent's bearing and only fork
      // through a narrow forward arc, producing readable outward spokes.
      const groupAngle = parent.actual
        ? rotation + groupIndex * (Math.PI * 2 / Math.max(1, grouped.length))
        : rotation + (groupIndex - (grouped.length - 1) / 2) * 0.65;
      members.forEach((member, index) => {
        const ring = Math.floor(index / 9);
        const slot = index % 9;
        const slotCount = Math.min(9, members.length - ring * 9);
        const angle = groupAngle + (slot - (slotCount - 1) / 2) * 0.14;
        const radius = 0.34 + ring * 0.24;
        const latitude = Math.max(-89.5, Math.min(89.5, parent.latitude + Math.sin(angle) * radius));
        const lonScale = Math.max(0.2, Math.cos(parent.latitude * Math.PI / 180));
        let longitude = parent.longitude + Math.cos(angle) * radius / lonScale;
        longitude = ((longitude + 540) % 360) - 180;
        locations.set(member.id, {
          latitude, longitude, actual: false, angle,
          anchorId: member.owner.anchorId, distance: member.owner.distance,
          parentId,
        });
      });
    });
  }
  return {
    nodes: Array.from(nodes.values()), edges, locations,
    actualCount: Array.from(locations.values()).filter((item) => item.actual).length,
    syntheticCount: Array.from(locations.values()).filter((item) => !item.actual).length,
    omittedCount: nodes.size - locations.size,
  };
}
