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
    ownership.set(id, { anchorId: id, distance: 0 });
    queue.push(id);
  }
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    const owner = ownership.get(current);
    for (const neighbor of adjacency.get(current) || []) {
      if (ownership.has(neighbor)) continue;
      ownership.set(neighbor, { anchorId: owner.anchorId, distance: owner.distance + 1 });
      queue.push(neighbor);
    }
  }

  const clusters = new Map();
  for (const [id, owner] of ownership) {
    if (locations.has(id)) continue;
    const node = nodes.get(id);
    const key = owner.anchorId + "|" + semanticGroup(node);
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push({ id, owner, node });
  }
  for (const [key, members] of clusters) {
    members.sort((left, right) => left.owner.distance - right.owner.distance || left.id.localeCompare(right.id));
    const anchor = locations.get(members[0].owner.anchorId);
    if (!anchor) continue;
    const centerAngle = (hashNumber(key) % 6283) / 1000;
    members.forEach((member, index) => {
      const ring = Math.floor(index / 10);
      const slot = index % 10;
      const slotCount = Math.min(10, members.length - ring * 10);
      const angle = centerAngle + (slot - (slotCount - 1) / 2) * 0.11;
      const radius = 0.32 + member.owner.distance * 0.24 + ring * 0.22;
      const latitude = Math.max(-89.5, Math.min(89.5, anchor.latitude + Math.sin(angle) * radius));
      const lonScale = Math.max(0.2, Math.cos(anchor.latitude * Math.PI / 180));
      let longitude = anchor.longitude + Math.cos(angle) * radius / lonScale;
      longitude = ((longitude + 540) % 360) - 180;
      locations.set(member.id, {
        latitude, longitude, actual: false,
        anchorId: member.owner.anchorId, distance: member.owner.distance,
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
