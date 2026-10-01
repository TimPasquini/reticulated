const api = {
  async get(path) { const r = await fetch(path); return r.json(); },
  async send(method, path, body) {
    const r = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return r.json();
  },
  post(path, body) { return this.send("POST", path, body); },
  patch(path, body) { return this.send("PATCH", path, body); },
  del(path) { return this.send("DELETE", path); },
};

const MODES = ["full", "gateway", "access_point", "roaming", "boundary", "ptp"];

const LORA_SF = [7, 8, 9, 10, 11, 12];
const LORA_BW = [[62500, "62.5 kHz"], [125000, "125 kHz"], [250000, "250 kHz"], [500000, "500 kHz"]];
const LORA_CR = [[1, "4/5"], [2, "4/6"], [3, "4/7"], [4, "4/8"]];
const LINK_PRESETS = [
  { label: " preset " },
  { label: "TCP / LAN (10 Mbps)", bitrate: 10000000, mtu: 32768, loss: 0 },
  { label: "Ethernet (100 Mbps)", bitrate: 100000000, mtu: 32768, loss: 0 },
  { label: "Packet radio 1200 baud", bitrate: 1200 },
  { label: "Packet radio 9600 baud", bitrate: 9600 },
  { label: "LoRa SF7 / 125 kHz (5469 bps)", bitrate: 5469 },
  { label: "LoRa SF9 / 125 kHz (1758 bps)", bitrate: 1758 },
  { label: "LoRa SF12 / 125 kHz (293 bps)", bitrate: 293 },
  { label: "LoRa SF7 / 500 kHz (21875 bps)", bitrate: 21875 },
];

function loraBitrate(sf, bw, cr) {
  return Math.round((sf * bw * 4) / (Math.pow(2, sf) * (4 + cr)));
}

const state = {
  uiMode: "simulation",
  live: null,
  showLiveDestinationSummaries: false,
  showLiveRmap: false,
  liveLayoutPending: true,
  liveLayoutRunning: false,
  liveSlots: {},
  liveNextSlot: {},
  topology: { nodes: {}, links: {} },
  addresses: {},
  addrToNode: {},
  lxmf: {},
  lxmfToNode: {},
  bridges: {},
  media: {},
  settings: {},
  clipboard: [],
  pendingLayout: false,
  chats: {},
  chatNode: null,
  nodeStatus: {},
  active: false,
  showAddresses: false,
  showNodeLogs: false,
  trafficPick: [],
};

function fmtBitrate(bps) {
  if (bps >= 1000000) return (bps / 1000000).toFixed(bps % 1000000 ? 1 : 0) + "Mbps";
  if (bps >= 1000) return (bps / 1000).toFixed(bps % 1000 ? 1 : 0) + "kbps";
  return bps + "bps";
}

function lossColor(loss) {
  const r = Math.round(60 + loss * 180);
  const g = Math.round(180 - loss * 150);
  return "rgb(" + r + "," + g + ",90)";
}

function mediumLabel(link) {
  const stats = link.mtu + "B  " + fmtBitrate(link.bitrate) + "  " + Math.round(link.loss * 100) + "%";
  return link.name ? link.name + "\n" + stats : stats;
}

function rebuildAddrMap() {
  state.addrToNode = {};
  for (const nid in state.addresses) {
    const a = state.addresses[nid];
    if (a) state.addrToNode[a] = nid;
  }
}

function rebuildLxmfMap() {
  state.lxmfToNode = {};
  for (const nid in state.lxmf) {
    const a = state.lxmf[nid];
    if (a) state.lxmfToNode[a] = nid;
  }
}

function nodeLabel(nid) {
  return (state.topology.nodes[nid] ? state.topology.nodes[nid].label : nid) || nid;
}

function nodeColor(nid) {
  const n = state.topology.nodes[nid];
  if (n && n.color) return n.color;
  return (n && n.transport) ? "#8b5cf6" : "#2f9e57";
}

function nodeDisplayLabel(nid) {
  const name = nodeLabel(nid);
  if (state.showAddresses) {
    const a = state.addresses[nid];
    if (a) return name + "\n" + a.slice(0, 16) + "…";
  }
  return name;
}

function resolveDest(addr) {
  if (!addr) return null;
  if (state.addrToNode[addr]) return nodeLabel(state.addrToNode[addr]);
  if (state.lxmfToNode[addr]) return nodeLabel(state.lxmfToNode[addr]) + " (LXMF)";
  return null;
}

const cy = cytoscape({
  container: document.getElementById("cy"),
  wheelSensitivity: 0.2,
  style: [
    { selector: "node.host", style: {
      "shape": "ellipse", "width": 46, "height": 46,
      "background-color": "data(hostcolor)", "label": "data(label)",
      "color": "#eafaf0", "text-valign": "center", "text-halign": "center",
      "font-size": 11, "text-wrap": "wrap", "text-max-width": 140,
      "text-outline-color": "#11151c", "text-outline-width": 2,
      "border-width": 2, "border-color": "#1c2530", "opacity": 0.6,
    }},
    { selector: "node.host.online", style: { "opacity": 1 }},
    { selector: "node.host.offline", style: { "opacity": 0.3, "border-color": "#e08a96" }},
    { selector: "node.host.traffic-src", style: { "border-color": "#5ac8ff", "border-width": 4, "underlay-color": "#5ac8ff", "underlay-padding": 14, "underlay-opacity": 0.4 }},
    { selector: "node.host.traffic-dst", style: { "border-color": "#c08bff", "border-width": 4, "underlay-color": "#c08bff", "underlay-padding": 14, "underlay-opacity": 0.4 }},
    { selector: "node.host.announce-pulse", style: { "border-color": "#ffd34d", "border-width": 7 }},
    { selector: "node.medium", style: {
      "shape": "round-rectangle", "width": 120, "height": 34,
      "background-color": "data(color)", "label": "data(label)",
      "color": "#11151c", "text-valign": "center", "text-halign": "center",
      "font-size": 10, "font-weight": "bold",
      "text-wrap": "wrap", "text-max-width": 116,
      "border-width": 2, "border-color": "#11151c",
    }},
    { selector: "node.medium.announce-pulse", style: { "border-color": "#ffd34d", "border-width": 6 }},
    { selector: "node.live-root", style: {
      "shape": "diamond", "width": 62, "height": 62, "background-color": "#8b5cf6",
      "label": "data(label)", "color": "#fff", "text-valign": "center", "text-halign": "center",
      "font-size": 11, "text-wrap": "wrap", "text-max-width": 130, "text-outline-color": "#11151c", "text-outline-width": 2,
    }},
    { selector: "node.live-interface", style: {
      "shape": "round-rectangle", "width": 126, "height": 42, "background-color": "#356b82",
      "label": "data(label)", "color": "#eef8ff", "text-valign": "center", "text-halign": "center",
      "font-size": 10, "text-wrap": "wrap", "text-max-width": 120, "border-width": 2, "border-color": "#5292ad",
    }},
    { selector: "node.live-interface.rf", style: { "background-color": "#725a24", "border-color": "#d1a83d" }},
    { selector: "node.live-interface.i2p", style: { "background-color": "#66437a", "border-color": "#a46fc0" }},
    { selector: "node.live-interface.backbone", style: { "background-color": "#285b78", "border-color": "#4fa3cf" }},
    { selector: "node.live-interface.path-only", style: { "border-style": "dashed", "opacity": 0.75 }},
    { selector: "node.live-transport", style: {
      "shape": "hexagon", "width": 50, "height": 50, "background-color": "#3d7c59",
      "label": "data(label)", "color": "#eaffef", "text-valign": "center", "text-halign": "center",
      "font-size": 9, "text-wrap": "wrap", "text-max-width": 100, "text-outline-color": "#11151c", "text-outline-width": 2,
    }},
    { selector: "node.live-rmap-transport", style: {
      "shape": "hexagon", "width": 54, "height": 54, "background-color": "#245f64",
      "label": "data(label)", "color": "#dffcff", "text-valign": "center", "text-halign": "center",
      "font-size": 9, "text-wrap": "wrap", "text-max-width": 110, "border-width": 2, "border-color": "#56b9bd",
    }},
    { selector: "node.live-rmap-interface", style: {
      "shape": "round-rectangle", "width": 132, "height": 44, "background-color": "#244a55",
      "label": "data(label)", "color": "#dffcff", "text-valign": "center", "text-halign": "center",
      "font-size": 9, "text-wrap": "wrap", "text-max-width": 126, "border-width": 2, "border-style": "dashed", "border-color": "#56b9bd",
    }},
    { selector: "node.live-rmap-group", style: {
      "shape": "round-rectangle", "width": 150, "height": 58, "background-color": "#244a55",
      "label": "data(label)", "color": "#dffcff", "text-valign": "center", "text-halign": "center",
      "font-size": 9, "text-wrap": "wrap", "text-max-width": 144, "border-width": 2, "border-style": "dashed", "border-color": "#56b9bd",
    }},
    { selector: "node.live-destination", style: {
      "shape": "ellipse", "width": 34, "height": 34, "background-color": "#687386",
      "label": "data(label)", "color": "#d7dde5", "text-valign": "bottom", "text-margin-y": 7,
      "font-size": 9, "text-wrap": "wrap", "text-max-width": 90, "text-outline-color": "#11151c", "text-outline-width": 2,
    }},
    { selector: "node.live-destination-group", style: {
      "shape": "round-rectangle", "width": 130, "height": 48, "background-color": "#6d542a",
      "label": "data(label)", "color": "#ffe4ae", "text-valign": "center", "text-halign": "center",
      "font-size": 10, "text-wrap": "wrap", "text-max-width": 124, "border-width": 2, "border-color": "#d89b45",
    }},
    { selector: "edge", style: { "width": 2, "line-color": "#46566b", "curve-style": "bezier" }},
    { selector: "edge.live-observed", style: { "line-color": "#5b8196", "target-arrow-shape": "triangle", "target-arrow-color": "#5b8196", "arrow-scale": 0.7 }},
    { selector: "edge.live-incomplete", style: {
      "line-color": "#d89b45", "line-style": "dashed", "target-arrow-shape": "triangle", "target-arrow-color": "#d89b45",
      "label": "", "font-size": 9, "color": "#e7b96b", "text-background-color": "#11151c", "text-background-opacity": 0.85,
      "text-background-padding": 2, "curve-style": "bezier",
    }},
    { selector: "edge.live-incomplete:selected", style: { "label": "data(label)" }},
    { selector: "edge.live-discovered", style: {
      "line-color": "#56b9bd", "line-style": "dashed", "target-arrow-shape": "triangle", "target-arrow-color": "#56b9bd",
      "label": "", "font-size": 9, "color": "#9fdbde", "text-background-color": "#11151c", "text-background-opacity": 0.85,
      "text-background-padding": 2, "curve-style": "bezier",
    }},
    { selector: "edge.live-discovered:selected", style: { "label": "data(label)" }},
    { selector: "edge.announce-flash", style: { "line-color": "#ffd34d", "width": 5 }},
    { selector: "edge.route", style: { "line-color": "#ff9d3c", "width": 5 }},
    { selector: "node.route", style: { "border-color": "#ff9d3c", "border-width": 5 }},
    { selector: "edge.msgpath", style: { "line-color": "#bb6bff", "width": 5 }},
    { selector: "node.msgpath", style: { "border-color": "#bb6bff", "border-width": 5 }},
    { selector: ":selected", style: { "border-color": "#ffd34d", "border-width": 4 }},
  ],
});

function rebuild() {
  cy.elements().remove();
  const els = [];
  const nodes = state.topology.nodes || {};
  const links = state.topology.links || {};
  for (const id in nodes) {
    const n = nodes[id];
    els.push({
      group: "nodes",
      data: { id: id, label: nodeDisplayLabel(id), kind: "host", hostcolor: nodeColor(id) },
      classes: "host" + (n.transport ? " transport" : ""),
      position: { x: n.x || 0, y: n.y || 0 },
    });
  }
  for (const id in links) {
    const l = links[id];
    els.push({
      group: "nodes",
      data: { id: id, label: mediumLabel(l), kind: "medium", color: lossColor(l.loss) },
      classes: "medium",
      position: { x: l.x || 0, y: l.y || 0 },
    });
    for (const m of l.members) {
      if (nodes[m]) els.push({ group: "edges", data: { id: id + "__" + m, source: id, target: m } });
    }
  }
  cy.add(els);
  applyStatusClasses();
  applyPickClasses();
}

function shortHash(value) {
  const text = String(value || "unknown");
  return text.length > 12 ? text.slice(0, 12) + "…" : text;
}

function liveInterfaceClass(item) {
  const descriptor = ((item.type || "") + " " + (item.name || "")).toLowerCase();
  if (descriptor.indexOf("rnode") >= 0 || descriptor.indexOf("lora") >= 0) return " rf";
  if (descriptor.indexOf("i2p") >= 0) return " i2p";
  if (descriptor.indexOf("backbone") >= 0 || descriptor.indexOf("boundary") >= 0) return " backbone";
  return "";
}

function liveEdgeLabel(edge) {
  if (edge.kind !== "known_path") return "";
  if (edge.hops === null || edge.hops === undefined) return "unknown path length";
  if (edge.unknown_hops > 0) return "… " + edge.unknown_hops + " unknown hop" + (edge.unknown_hops === 1 ? "" : "s") + " …";
  return edge.hops === 1 ? "1 hop total" : edge.hops + " hops total";
}

function liveRenderModel(snapshot) {
  const destinationById = {};
  (snapshot.destinations || []).forEach((item) => { destinationById[item.id] = item; });
  const buckets = new Map();
  const observedEdges = [];
  for (const edge of snapshot.edges || []) {
    if (edge.kind !== "known_path") { observedEdges.push(edge); continue; }
    if (!state.showLiveDestinationSummaries) continue;
    const destination = destinationById[edge.target];
    if (!destination) continue;
    const hopKey = edge.hops === null || edge.hops === undefined ? "unknown" : String(edge.hops);
    const key = edge.source + "|" + destination.interface_id + "|" + hopKey;
    if (!buckets.has(key)) {
      buckets.set(key, { source: edge.source, interface_id: destination.interface_id, interface: destination.interface, hops: edge.hops, unknown_hops: edge.unknown_hops, certainty: edge.certainty, entries: [] });
    }
    buckets.get(key).entries.push({ destination: destination, edge: edge });
  }

  const destinationNodes = [];
  const pathEdges = [];
  for (const [key, bucket] of buckets) {
    if (bucket.entries.length <= 12) {
      bucket.entries.forEach((entry) => {
        destinationNodes.push({ kind: "destination", item: entry.destination });
        pathEdges.push(entry.edge);
      });
      continue;
    }
    const groupId = "destination-group:" + key;
    const totalHops = bucket.hops === null || bucket.hops === undefined ? "unknown hops" : bucket.hops + " hop" + (bucket.hops === 1 ? "" : "s") + " total";
    const group = {
      id: groupId,
      count: bucket.entries.length,
      source: bucket.source,
      interface_id: bucket.interface_id,
      interface: bucket.interface,
      hops: bucket.hops,
      unknown_hops: bucket.unknown_hops,
      sample_hashes: bucket.entries.slice(0, 100).map((entry) => entry.destination.hash),
      label: bucket.entries.length.toLocaleString() + " destinations\n" + totalHops,
    };
    destinationNodes.push({ kind: "destination_group", item: group });
    pathEdges.push({
      id: "edge:" + bucket.source + ":" + groupId,
      source: bucket.source,
      target: groupId,
      kind: "known_path",
      certainty: bucket.certainty,
      hops: bucket.hops,
      unknown_hops: bucket.unknown_hops,
    });
  }
  const rmapItems = snapshot.rmap_interfaces || [];
  const rmapGroups = [];
  if (rmapItems.length > 36) {
    const grouped = new Map();
    for (const item of rmapItems) {
      const hops = item.hops === null || item.hops === undefined ? "unknown" : String(item.hops);
      const type = item.type || "Unknown interface";
      const key = hops + "|" + type;
      if (!grouped.has(key)) grouped.set(key, { hops: item.hops, type: type, items: [], transports: new Set() });
      const group = grouped.get(key);
      group.items.push(item);
      group.transports.add(item.transport_id);
    }
    for (const [key, group] of grouped) {
      const hopLabel = group.hops === null || group.hops === undefined ? "unknown hops" : group.hops + " hop" + (group.hops === 1 ? "" : "s");
      rmapGroups.push({
        id: "rmap-group:" + encodeURIComponent(key),
        hops: group.hops,
        type: group.type,
        count: group.items.length,
        transport_count: group.transports.size,
        items: group.items,
        label: hopLabel + "\n" + group.type + "\n" + group.items.length + " interfaces · " + group.transports.size + " transports",
      });
    }
    rmapGroups.sort((a, b) => (a.hops ?? 999) - (b.hops ?? 999) || a.type.localeCompare(b.type));
  }
  return {
    destinationNodes: destinationNodes,
    edges: observedEdges.concat(pathEdges),
    rmapGroups: rmapGroups,
    rmapDetailed: rmapItems.length <= 36,
  };
}

function livePositions(snapshot, renderModel) {
  const positions = {};
  positions[snapshot.root.id] = { x: 0, y: 0 };

  const interfaces = snapshot.interfaces || [];
  interfaces.forEach((item, index) => {
    positions[item.id] = { x: (index - (interfaces.length - 1) / 2) * 220, y: 180 };
  });

  const pathEdges = renderModel.edges.filter((edge) => edge.kind === "known_path");
  const edgeByDestination = {};
  pathEdges.forEach((edge) => { edgeByDestination[edge.target] = edge; });
  const sources = Array.from(new Set(pathEdges.map((edge) => edge.source))).sort();

  // Keep every destination's slot for the lifetime of the page. New paths are
  // appended to a compact wrapped grid instead of reshuffling existing nodes.
  // This makes a growing path table much less disorienting.
  const liveDestinationIds = new Set(renderModel.destinationNodes.map((entry) => entry.item.id));
  Object.keys(state.liveSlots).forEach((id) => {
    if (!liveDestinationIds.has(id)) delete state.liveSlots[id];
  });

  const columns = 18;
  const columnSpacing = 104;
  const rowSpacing = 68;
  const groupSpacing = columns * columnSpacing + 140;
  const sourceX = {};
  sources.forEach((source, index) => {
    sourceX[source] = (index - (sources.length - 1) / 2) * groupSpacing;
    positions[source] = { x: sourceX[source], y: 360 };
  });

  for (const entry of renderModel.destinationNodes) {
    const item = entry.item;
    const edge = edgeByDestination[item.id];
    if (!edge) continue;
    const source = edge.source;
    let assignment = state.liveSlots[item.id];
    if (!assignment || assignment.source !== source) {
      const slot = state.liveNextSlot[source] || 0;
      assignment = { source: source, slot: slot };
      state.liveSlots[item.id] = assignment;
      state.liveNextSlot[source] = slot + 1;
    }
    const column = assignment.slot % columns;
    const row = Math.floor(assignment.slot / columns);
    positions[item.id] = {
      x: sourceX[source] + (column - (columns - 1) / 2) * columnSpacing,
      y: 520 + row * rowSpacing,
    };
  }

  // Spread next hops around the interfaces that observed them. Several next
  // hops can share an interface, so assigning all of them to its exact x/y
  // position would stack the nodes on top of each other.
  const transportGroups = new Map();
  for (const item of snapshot.transports || []) {
    if (positions[item.id]) continue;
    const parentIds = item.interface_ids || [];
    const parentXs = parentIds.map((id) => positions[id]).filter(Boolean).map((p) => p.x);
    const anchorX = parentXs.length ? parentXs.reduce((sum, x) => sum + x, 0) / parentXs.length : 0;
    const groupKey = String(Math.round(anchorX));
    if (!transportGroups.has(groupKey)) transportGroups.set(groupKey, { anchorX: anchorX, items: [] });
    transportGroups.get(groupKey).items.push(item);
  }
  for (const group of transportGroups.values()) {
    group.items.forEach((item, index) => {
      positions[item.id] = {
        x: group.anchorX + (index - (group.items.length - 1) / 2) * 120,
        y: 360,
      };
    });
  }

  // RMAP records are announced interface metadata, not direct adjacency. Keep
  // them in a separate lower band and group each interface under its transport.
  if (renderModel.rmapGroups.length) {
    const columns = Math.min(5, renderModel.rmapGroups.length);
    renderModel.rmapGroups.forEach((group, index) => {
      positions[group.id] = {
        x: (index % columns - (columns - 1) / 2) * 260,
        y: 540 + Math.floor(index / columns) * 190,
      };
    });
    return positions;
  }

  const localTransportIds = new Set((snapshot.transports || []).map((item) => item.id));
  const rmapByTransport = new Map();
  for (const item of snapshot.rmap_interfaces || []) {
    const transportId = "transport:" + item.transport_id;
    if (!rmapByTransport.has(transportId)) rmapByTransport.set(transportId, []);
    rmapByTransport.get(transportId).push(item);
  }
  const newRmapTransports = Array.from(rmapByTransport.keys()).filter((id) => !localTransportIds.has(id)).sort();
  const rmapColumns = 5;
  newRmapTransports.forEach((id, index) => {
    const column = index % rmapColumns;
    const row = Math.floor(index / rmapColumns);
    positions[id] = {
      x: (column - (Math.min(rmapColumns, newRmapTransports.length) - 1) / 2) * 260,
      y: 540 + row * 260,
    };
  });
  for (const [transportId, items] of rmapByTransport) {
    const parent = positions[transportId] || { x: 0, y: 540 };
    const childY = localTransportIds.has(transportId) ? 700 : parent.y + 145;
    items.sort((a, b) => a.id.localeCompare(b.id)).forEach((item, index) => {
      positions[item.id] = {
        x: parent.x + (index - (items.length - 1) / 2) * 150,
        y: childY,
      };
    });
  }
  return positions;
}

function rebuildLive(snapshot) {
  const hadLiveGraph = cy.nodes(".live-root").length > 0;
  const oldPan = { ...cy.pan() };
  const oldZoom = cy.zoom();
  const oldPositions = {};
  cy.nodes().forEach((node) => { oldPositions[node.id()] = { ...node.position() }; });
  const selectedIds = cy.$(":selected").map((element) => element.id());
  const renderModel = liveRenderModel(snapshot);
  const positions = livePositions(snapshot, renderModel);
  Object.keys(oldPositions).forEach((id) => {
    if (positions[id]) positions[id] = oldPositions[id];
  });
  cy.elements().remove();
  const els = [];
  const root = snapshot.root;
  els.push({ group: "nodes", data: { id: root.id, label: root.label, liveKind: "root", item: root }, classes: "live-root", position: positions[root.id] });
  for (const item of snapshot.interfaces || []) {
    let classes = "live-interface" + liveInterfaceClass(item);
    if (item.path_only) classes += " path-only";
    els.push({ group: "nodes", data: { id: item.id, label: item.name, liveKind: "interface", item: item }, classes: classes, position: positions[item.id] });
  }
  for (const item of snapshot.transports || []) {
    const transportCounts = (snapshot.path_summary || {}).by_transport || {};
    const destinationCount = transportCounts[item.hash] || 0;
    const countLabel = destinationCount ? "\n" + destinationCount.toLocaleString() + " destinations" : "";
    els.push({ group: "nodes", data: { id: item.id, label: "next hop\n" + shortHash(item.hash) + countLabel, liveKind: "transport", item: item }, classes: "live-transport", position: positions[item.id] });
  }
  if (renderModel.rmapGroups.length) {
    for (const group of renderModel.rmapGroups) {
      els.push({ group: "nodes", data: { id: group.id, label: group.label, liveKind: "rmap_group", item: group }, classes: "live-rmap-group", position: positions[group.id] });
      els.push({ group: "edges", data: { id: "edge:rmap:" + root.id + ":" + group.id, source: root.id, target: group.id, label: "RMAP aggregate", liveKind: "edge", item: { kind: "rmap_aggregate", certainty: "advertised", hops: group.hops } }, classes: "live-discovered" });
    }
  } else {
    const existingTransportIds = new Set((snapshot.transports || []).map((item) => item.id));
    const rmapByTransport = new Map();
    for (const item of snapshot.rmap_interfaces || []) {
      const transportId = "transport:" + item.transport_id;
      if (!rmapByTransport.has(transportId)) rmapByTransport.set(transportId, []);
      rmapByTransport.get(transportId).push(item);
    }
    for (const [transportId, items] of rmapByTransport) {
      if (!existingTransportIds.has(transportId)) {
        const hops = items.map((item) => item.hops).filter((value) => value !== null && value !== undefined);
        const nearestHops = hops.length ? Math.min(...hops) : null;
        const transportItem = { id: transportId, hash: items[0].transport_id, rmap: true, hops: nearestHops };
        const hopLabel = nearestHops === null ? "" : "\n" + nearestHops + " hop" + (nearestHops === 1 ? "" : "s");
        els.push({ group: "nodes", data: { id: transportId, label: "RMAP transport\n" + shortHash(items[0].transport_id) + hopLabel, liveKind: "rmap_transport", item: transportItem }, classes: "live-rmap-transport", position: positions[transportId] });
        els.push({ group: "edges", data: { id: "edge:rmap:" + root.id + ":" + transportId, source: root.id, target: transportId, label: nearestHops === null ? "RMAP announce" : "RMAP announce · " + nearestHops + " hops", liveKind: "edge", item: { kind: "rmap_discovery", certainty: "advertised" } }, classes: "live-discovered" });
      }
      for (const item of items) {
        els.push({ group: "nodes", data: { id: item.id, label: item.name + "\n" + (item.type || "interface"), liveKind: "rmap_interface", item: item }, classes: "live-rmap-interface", position: positions[item.id] });
        els.push({ group: "edges", data: { id: "edge:" + transportId + ":" + item.id, source: transportId, target: item.id, label: "advertised interface", liveKind: "edge", item: { kind: "rmap_advertisement", certainty: "advertised" } }, classes: "live-discovered" });
      }
    }
  }
  for (const entry of renderModel.destinationNodes) {
    const item = entry.item;
    if (entry.kind === "destination_group") {
      els.push({ group: "nodes", data: { id: item.id, label: item.label, liveKind: "destination_group", item: item }, classes: "live-destination-group", position: positions[item.id] });
    } else {
      const hops = item.hops === null || item.hops === undefined ? "? hops" : item.hops + " hop" + (item.hops === 1 ? "" : "s");
      els.push({ group: "nodes", data: { id: item.id, label: shortHash(item.hash) + "\n" + hops, liveKind: "destination", item: item }, classes: "live-destination", position: positions[item.id] });
    }
  }
  for (const edge of renderModel.edges) {
    const incomplete = edge.certainty === "incomplete";
    els.push({
      group: "edges",
      data: { id: edge.id, source: edge.source, target: edge.target, label: liveEdgeLabel(edge), liveKind: "edge", item: edge },
      classes: incomplete ? "live-incomplete" : "live-observed",
    });
  }
  cy.add(els);
  const shouldAutoLayout = state.liveLayoutPending || !hadLiveGraph;
  if (hadLiveGraph && !shouldAutoLayout) {
    cy.zoom(oldZoom);
    cy.pan(oldPan);
  }
  let restoredSelection = null;
  selectedIds.forEach((id) => {
    const element = cy.getElementById(id);
    if (element.nonempty()) { element.select(); restoredSelection = element; }
  });
  if (restoredSelection) showPanel(restoredSelection);
  if (shouldAutoLayout) requestAnimationFrame(() => runLiveLayout(true));
}

function updateLiveHealth(snapshot) {
  const health = document.getElementById("live-health");
  const sources = snapshot.health || {};
  const failed = Object.keys(sources).filter((key) => !sources[key].ok);
  health.classList.toggle("error", failed.length > 0);
  if (failed.length) {
    health.textContent = "Stale/partial · " + failed.map((key) => key + ": " + sources[key].error).join(" · ");
  } else {
    const destinationCount = (snapshot.path_summary || {}).destination_count ?? (snapshot.destinations || []).length;
    const rmapCount = (snapshot.rmap_summary || {}).interface_count || 0;
    health.textContent = (snapshot.interfaces || []).length + " interfaces · " +
      (snapshot.transports || []).length + " next hops · " +
      destinationCount + " known paths · " + rmapCount + " RMAP interfaces · refreshed " + new Date(snapshot.collected_at * 1000).toLocaleTimeString();
  }
}

async function loadLiveState() {
  if (state.uiMode !== "live") return;
  if (state.liveLayoutRunning) return;
  try {
    const query = new URLSearchParams();
    if (state.showLiveDestinationSummaries) query.set("include_paths", "true");
    if (state.showLiveRmap) query.set("include_rmap", "true");
    const snapshot = await api.get("/api/live/state" + (query.size ? "?" + query.toString() : ""));
    state.live = snapshot;
    updateLiveHealth(snapshot);
    rebuildLive(snapshot);
  } catch (error) {
    const health = document.getElementById("live-health");
    health.textContent = "Live API unavailable";
    health.classList.add("error");
  }
}

function setOperatingMode(mode) {
  state.uiMode = mode;
  const live = mode === "live";
  document.body.classList.toggle("live-mode", live);
  document.getElementById("mode-simulation").classList.toggle("active", !live);
  document.getElementById("mode-live").classList.toggle("active", live);
  state.trafficPick = [];
  showPanel(null);
  if (live) { state.liveLayoutPending = true; loadLiveState(); }
  else { rebuild(); updateTrafficBox(); }
}

function liveValue(value) {
  return value === null || value === undefined || value === "" ? "unknown" : String(value);
}

function showLivePanel(el) {
  const title = document.getElementById("panel-title");
  const body = document.getElementById("panel-body");
  if (!el) {
    title.textContent = "Live RNS details";
    body.innerHTML = '<div class="muted">Read-only local Reticulum observations. Select an item for details.</div>' +
      '<div class="live-key"><span class="live-swatch"></span><span class="muted">solid: directly supported relationship</span>' +
      '<span class="live-swatch incomplete"></span><span class="muted">dashed: incomplete path or RMAP-advertised relationship</span></div>';
    return;
  }
  const item = el.data("item") || {};
  const kind = el.data("liveKind");
  const row = (name, value) => '<div class="row"><label>' + escapeHtml(name) + '</label><span class="mono">' + escapeHtml(liveValue(value)) + "</span></div>";
  if (kind === "root") {
    title.textContent = item.label || "Local RNS";
    body.innerHTML = row("Transport identity", item.transport_id) + row("Mode", "read-only live observation");
  } else if (kind === "interface") {
    title.textContent = item.name || "Interface";
    body.innerHTML = row("Type", item.type) + row("Interface hash", item.interface_hash) + row("Mode", item.mode) +
      row("Online", item.status) + row("Peers", item.peers) + row("Bitrate", item.bitrate) + row("MTU", item.mtu) +
      row("Received bytes", item.rxb) + row("Transmitted bytes", item.txb) +
      (item.path_only ? '<div class="muted">This interface was reported by the path table but absent from the latest interface status.</div>' : "");
  } else if (kind === "transport") {
    const destinations = (state.live.destinations || []).filter((destination) => destination.via === item.hash);
    const knownDestinationCount = ((state.live.path_summary || {}).by_transport || {})[item.hash] || destinations.length;
    const hopCounts = {};
    destinations.forEach((destination) => {
      const key = destination.hops === null || destination.hops === undefined ? "unknown" : destination.hops;
      hopCounts[key] = (hopCounts[key] || 0) + 1;
    });
    const distribution = Object.keys(hopCounts).sort((a, b) => Number(a) - Number(b)).map((hops) => hops + " hops: " + hopCounts[hops]).join(" · ");
    title.textContent = "Observed next-hop transport";
    body.innerHTML = row("Transport hash", item.hash) + row("Interface IDs", (item.interface_ids || []).join(", ")) +
      row("Known destinations", knownDestinationCount) + row("Hop distribution", distribution || "load path summaries to inspect") +
      '<div class="muted">The local path table supports this as a next hop. It does not reveal routers beyond it.</div>';
  } else if (kind === "rmap_transport") {
    title.textContent = "RMAP-discovered transport";
    body.innerHTML = row("Transport hash", item.hash) + row("Announced hops", item.hops) +
      '<div class="muted">Learned from an RMAP interface-discovery announce. This is not evidence of direct adjacency.</div>';
  } else if (kind === "rmap_interface") {
    title.textContent = item.name || "RMAP-discovered interface";
    body.innerHTML = row("Transport hash", item.transport_id) + row("Type", item.type) + row("Status", item.status) +
      row("Announced hops", item.hops) + row("Last heard", item.last_heard) + row("Reachable on", item.reachable_on) +
      row("Port", item.port) + row("Latitude", item.latitude) + row("Longitude", item.longitude) +
      row("Frequency", item.frequency) + row("Bandwidth", item.bandwidth) +
      '<div class="muted">Advertised discovery metadata; coordinates are shown only when explicitly supplied by the announcer.</div>';
  } else if (kind === "rmap_group") {
    title.textContent = "RMAP discovery aggregate";
    const sample = (item.items || []).slice(0, 100).map((entry) =>
      '<div><span>' + escapeHtml(entry.name || "Unnamed interface") + '</span><br><span class="mono muted">' + escapeHtml(entry.transport_id) + "</span></div>"
    ).join("");
    body.innerHTML = row("Announced hops", item.hops) + row("Interface type", item.type) +
      row("Interfaces", item.count) + row("Transports", item.transport_count) +
      '<div class="muted">Aggregated because the RMAP discovery set is too dense to render honestly as individual topology.</div>' +
      '<details class="section"><summary>Discovered records' + (item.count > 100 ? " (first 100)" : "") + '</summary><div class="destination-hashes">' + sample + "</div></details>";
  } else if (kind === "destination_group") {
    title.textContent = "Destination summary";
    const hashes = item.sample_hashes.map((hash) => '<div class="mono">' + escapeHtml(hash) + "</div>").join("");
    body.innerHTML = row("Destinations", item.count) + row("Total hops", item.hops) +
      row("Unknown after next hop", item.unknown_hops) + row("Interface", item.interface) +
      '<details class="section"><summary>Destination hashes' + (item.count > item.sample_hashes.length ? " (first " + item.sample_hashes.length + ")" : "") + '</summary><div class="destination-hashes">' + hashes + "</div></details>";
  } else if (kind === "destination") {
    title.textContent = "Known destination";
    const remaining = item.hops === null || item.hops === undefined ? "unknown" : Math.max(0, item.hops - (item.via ? 1 : 0));
    body.innerHTML = row("Destination hash", item.hash) + row("Total hops", item.hops) + row("Next transport", item.via) +
      row("Unknown remaining hops", remaining) + row("Interface", item.interface) + row("Expires", item.expires);
  }
}

function updateNodeLabels() {
  cy.nodes(".host").forEach((n) => n.data("label", nodeDisplayLabel(n.id())));
}

function applyStatusClasses() {
  cy.nodes(".host").forEach((n) => {
    const st = state.nodeStatus[n.id()];
    n.removeClass("online offline");
    if (state.active && st) n.addClass(st.online ? "online" : "offline");
  });
}

function applyPickClasses() {
  cy.nodes(".host").removeClass("traffic-src traffic-dst");
  if (state.trafficPick[0]) cy.getElementById(state.trafficPick[0]).addClass("traffic-src");
  if (state.trafficPick[1]) cy.getElementById(state.trafficPick[1]).addClass("traffic-dst");
}

function animateAnnounce(event) {
  const medium = cy.getElementById(event.medium);
  if (medium && medium.nonempty()) {
    medium.addClass("announce-pulse");
    const edges = medium.connectedEdges();
    edges.addClass("announce-flash");
    setTimeout(() => { medium.removeClass("announce-pulse"); edges.removeClass("announce-flash"); }, 650);
  }
  const src = cy.getElementById(event.src);
  if (src && src.nonempty()) {
    src.addClass("announce-pulse");
    setTimeout(() => src.removeClass("announce-pulse"), 650);
  }
}

function setSimState(active) {
  state.active = active;
  const badge = document.getElementById("sim-state");
  badge.textContent = active ? "running" : "stopped";
  badge.className = "badge " + (active ? "running" : "stopped");
  applyStatusClasses();
}

function showPanel(el) {
  if (state.uiMode === "live") { showLivePanel(el); return; }
  const title = document.getElementById("panel-title");
  const body = document.getElementById("panel-body");
  if (!el) { title.textContent = "Details"; body.innerHTML = "Select a node or link."; return; }
  if (el.hasClass("host")) showHostPanel(el.id(), title, body);
  else if (el.hasClass("medium")) showLinkPanel(el.id(), title, body);
}

function showHostPanel(id, title, body) {
  const node = state.topology.nodes[id];
  if (!node) return;
  const st = state.nodeStatus[id];
  const addr = state.addresses[id] || "(unknown)";
  const transport = node.transport === true;
  const mode = node.mode || "full";
  title.textContent = "Node " + id;
  let html = "";
  html += '<div class="row"><label>Name</label><input id="f-label" type="text" value="' + escapeHtml(nodeLabel(id)) + '"></div>';
  const hasAddr = !!state.addresses[id];
  html += '<div class="addr-row"><span class="addr-label">Address</span>' + (hasAddr ? '<button id="addr-copy" class="addr-copy">Copy</button>' : "") + "</div>";
  html += '<pre class="addr-pre">' + escapeHtml(addr) + "</pre>";
  html += '<div class="row"><label>State</label><span id="panel-state">' + (st ? (st.online ? "online" : "offline") : "unknown") + "</span></div>";
  html += '<div class="row"><label>Transport (router)</label><input id="f-transport" type="checkbox"' + (transport ? " checked" : "") + "></div>";
  if (transport) {
    let opts = "";
    for (const m of MODES) opts += '<option value="' + m + '"' + (m === mode ? " selected" : "") + ">" + m + "</option>";
    html += '<div class="row"><label>Mode (default)</label><select id="f-mode">' + opts + "</select></div>";
    const myLinks = [];
    for (const lid in state.topology.links) {
      const l = state.topology.links[lid];
      if (l.members && l.members.indexOf(id) !== -1) myLinks.push([lid, l]);
    }
    if (myLinks.length) {
      const linkModes = node.link_modes || {};
      html += '<details class="section"' + (myLinks.length > 1 ? " open" : "") + '><summary>Per-interface mode</summary>';
      for (const [lid, l] of myLinks) {
        const peers = l.members.filter((m) => m !== id).map(nodeLabel).join(", ") || "(self)";
        const cur = linkModes[lid] || "";
        const descr = (l.name ? l.name + " · " : "") + fmtBitrate(l.bitrate);
        let o = '<option value=""' + (cur === "" ? " selected" : "") + ">default (" + escapeHtml(mode) + ")</option>";
        for (const m of MODES) o += '<option value="' + m + '"' + (m === cur ? " selected" : "") + ">" + m + "</option>";
        html += '<div class="row"><label>→ ' + escapeHtml(peers) + ' <span class="muted">(' + escapeHtml(descr) + ')</span></label><select class="f-imode" data-link="' + lid + '">' + o + "</select></div>";
      }
      html += '<div class="row"><span class="muted">Overrides the node mode for one interface. Changing restarts the node.</span></div></details>';
    }
  }
  const defInterval = state.settings.announce_interval !== undefined ? state.settings.announce_interval : 300;
  const effInterval = (node.announce_interval !== undefined && node.announce_interval !== null) ? node.announce_interval : defInterval;
  html += '<div class="row"><label>Announce interval (s)</label><input id="f-announce" type="number" min="0" step="1" value="' + effInterval + '"></div>';
  const defCap = state.settings.announce_cap !== undefined ? state.settings.announce_cap : 2;
  const effCap = (node.announce_cap !== undefined && node.announce_cap !== null) ? node.announce_cap : defCap;
  html += '<div class="row"><label>Announce cap (%)</label><input id="f-cap" type="number" min="0.1" max="100" step="0.1" value="' + effCap + '"></div>';
  html += '<div class="row"><label>Color</label><span><input id="f-color" type="color" value="' + nodeColor(id) + '"><button id="f-color-reset">reset</button></span></div>';
  html += '<div class="row"><button id="panel-announce">Announce</button><button id="panel-announce-lxmf">Announce LXMF</button><button id="panel-restart">Restart</button></div>';
  html += '<div class="row"><button id="panel-chat">Open Chat</button><button id="panel-log">View RNS log</button></div>';
  let bridgeCfg = null;
  if (transport) {
    html += '<details class="section"><summary>Transport rate limiting</summary>';
    const rv = (k) => (node[k] !== undefined && node[k] !== null) ? node[k] : "";
    html += '<div class="row"><label>Announce rate target (s)</label><input id="f-rt" type="number" min="0" step="1" value="' + rv("announce_rate_target") + '"></div>';
    html += '<div class="row"><label>Announce rate grace (s)</label><input id="f-rg" type="number" min="0" step="1" value="' + rv("announce_rate_grace") + '"></div>';
    html += '<div class="row"><label>Announce rate penalty (s)</label><input id="f-rp" type="number" min="0" step="1" value="' + rv("announce_rate_penalty") + '"></div>';
    html += '<div class="row"><span class="muted">Blank = RNS default. Changing restarts the node.</span></div></details>';
    if (state.bridges[id]) {
      const br = state.bridges[id];
      bridgeCfg = "[[Sim " + nodeLabel(id) + "]]\n  type = TCPClientInterface\n  enabled = yes\n  target_host = " + br.host + "\n  target_port = " + br.port;
      html += '<details class="section"><summary>Connect to this transport</summary>';
      html += '<textarea class="bridge-cfg" readonly rows="5">' + escapeHtml(bridgeCfg) + "</textarea>";
      html += '<div class="row"><button id="bridge-copy">Copy interface</button><span class="muted">paste into your Reticulum config (node must be running)</span></div></details>';
    }
  } else {
    html += '<div class="row"><span class="muted">Enable Transport to configure interface modes, rate limiting, and a connectable interface.</span></div>';
  }
  html += '<details class="section" open><summary>Announces heard</summary><div id="heard" class="muted">loading…</div></details>';
  body.innerHTML = html;

  const labelInput = document.getElementById("f-label");
  labelInput.addEventListener("change", () => {
    const v = labelInput.value.trim() || id;
    api.patch("/api/nodes/" + id, { label: v });
    if (state.topology.nodes[id]) state.topology.nodes[id].label = v;
    const n = cy.getElementById(id);
    if (n) n.data("label", nodeDisplayLabel(id));
  });
  document.getElementById("f-transport").addEventListener("change", (e) => {
    api.patch("/api/nodes/" + id, { transport: e.target.checked });
    if (state.topology.nodes[id]) state.topology.nodes[id].transport = e.target.checked;
    showHostPanel(id, document.getElementById("panel-title"), document.getElementById("panel-body"));
  });
  const modeSel = document.getElementById("f-mode");
  if (modeSel) modeSel.addEventListener("change", (e) => {
    api.patch("/api/nodes/" + id, { mode: e.target.value });
    if (state.topology.nodes[id]) state.topology.nodes[id].mode = e.target.value;
    showHostPanel(id, document.getElementById("panel-title"), document.getElementById("panel-body"));
  });
  document.querySelectorAll(".f-imode").forEach((sel) => {
    sel.addEventListener("change", (e) => {
      const lid = e.target.getAttribute("data-link");
      const val = e.target.value;
      api.post("/api/nodes/" + id + "/link_mode", { link_id: lid, mode: val || null });
      const n = state.topology.nodes[id];
      if (n) {
        n.link_modes = n.link_modes || {};
        if (val) n.link_modes[lid] = val; else delete n.link_modes[lid];
      }
    });
  });
  document.getElementById("f-announce").addEventListener("change", (e) => {
    let v = parseFloat(e.target.value);
    v = isNaN(v) ? 0 : Math.max(0, v);
    if (v > 0 && v < 60) v = 60;
    e.target.value = v;
    api.patch("/api/nodes/" + id, { announce_interval: v });
    if (state.topology.nodes[id]) state.topology.nodes[id].announce_interval = v;
  });
  document.getElementById("f-cap").addEventListener("change", (e) => {
    const v = parseFloat(e.target.value);
    if (!isNaN(v)) api.patch("/api/nodes/" + id, { announce_cap: Math.max(0.1, Math.min(100, v)) });
  });
  [["f-rt", "announce_rate_target"], ["f-rg", "announce_rate_grace"], ["f-rp", "announce_rate_penalty"]].forEach(([elid, key]) => {
    const el = document.getElementById(elid);
    if (el) el.addEventListener("change", () => {
      const raw = el.value.trim();
      const body = {};
      body[key] = raw === "" ? null : Math.max(0, parseInt(raw));
      api.patch("/api/nodes/" + id, body);
    });
  });
  const colorEl = document.getElementById("f-color");
  colorEl.addEventListener("input", (e) => { const n = cy.getElementById(id); if (n) n.data("hostcolor", e.target.value); });
  colorEl.addEventListener("change", (e) => {
    api.patch("/api/nodes/" + id, { color: e.target.value });
    if (state.topology.nodes[id]) state.topology.nodes[id].color = e.target.value;
  });
  document.getElementById("f-color-reset").onclick = () => {
    api.patch("/api/nodes/" + id, { color: null });
    if (state.topology.nodes[id]) delete state.topology.nodes[id].color;
    const n = cy.getElementById(id);
    if (n) n.data("hostcolor", nodeColor(id));
    colorEl.value = nodeColor(id);
  };
  document.getElementById("panel-announce").onclick = () => api.post("/api/nodes/" + id + "/announce");
  document.getElementById("panel-announce-lxmf").onclick = () => api.post("/api/nodes/" + id + "/announce_lxmf");
  document.getElementById("panel-restart").onclick = () => api.post("/api/nodes/" + id + "/restart");
  document.getElementById("panel-chat").onclick = () => openChat(id);
  document.getElementById("panel-log").onclick = () => openLog(id);
  if (hasAddr) {
    const ac = document.getElementById("addr-copy");
    if (ac) ac.onclick = () => copyText(state.addresses[id], ac);
  }
  if (bridgeCfg) {
    const cb = document.getElementById("bridge-copy");
    if (cb) cb.onclick = () => copyText(bridgeCfg, cb);
  }
  renderHeard(id);
}

function copyText(text, btn) {
  const done = () => { if (btn) { const t = btn.textContent; btn.textContent = "Copied!"; setTimeout(() => { btn.textContent = t; }, 1200); } };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => {});
  } else {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); done(); } catch (e) {}
    document.body.removeChild(ta);
  }
}

function refreshHostPanel(id) {
  const sEl = document.getElementById("panel-state");
  if (!sEl) return;
  const st = state.nodeStatus[id];
  sEl.textContent = st ? (st.online ? "online" : "offline") : "unknown";
  renderHeard(id);
}

async function renderHeard(id) {
  const target = document.getElementById("heard");
  if (!target) return;
  let paths = [];
  try { paths = await api.get("/api/paths/" + id); } catch (e) { paths = []; }
  if (document.getElementById("heard") !== target) return;
  const rows = [];
  for (const p of paths) {
    if (p.hops === 0) continue;
    let name = resolveDest(p.destination);
    let cls = "";
    if (!name) { name = (p.destination ? p.destination.slice(0, 12) + "… (transport)" : "?"); cls = "muted"; }
    const hops = (p.hops === null || p.hops === undefined) ? "?" : p.hops;
    rows.push('<div class="heard-row"><span class="' + cls + '">' + escapeHtml(name) + '</span><span class="muted">' + hops + " hops</span></div>");
  }
  target.innerHTML = rows.length ? rows.join("") : '<span class="muted">none yet</span>';
}

function showLinkPanel(id, title, body) {
  const l = state.topology.links[id];
  if (!l) return;
  title.textContent = "Link " + id + (l.name ? " · " + l.name : "");
  let presetOpts = "";
  LINK_PRESETS.forEach((p, i) => { presetOpts += '<option value="' + i + '">' + escapeHtml(p.label) + "</option>"; });
  const sfOpts = LORA_SF.map((s) => '<option value="' + s + '"' + (s === 9 ? " selected" : "") + ">SF" + s + "</option>").join("");
  const bwOpts = LORA_BW.map((b) => '<option value="' + b[0] + '"' + (b[0] === 125000 ? " selected" : "") + ">" + b[1] + "</option>").join("");
  const crOpts = LORA_CR.map((c) => '<option value="' + c[0] + '">' + c[1] + "</option>").join("");
  let modesHtml = '<details class="section" open><summary>Interface modes (this connection)</summary>';
  for (const m of l.members) {
    const n = state.topology.nodes[m] || {};
    const ndefault = n.mode || "full";
    const cur = (n.link_modes && n.link_modes[id]) || "";
    if (n.transport) {
      let o = '<option value=""' + (cur === "" ? " selected" : "") + ">default (" + escapeHtml(ndefault) + ")</option>";
      for (const mm of MODES) o += '<option value="' + mm + '"' + (mm === cur ? " selected" : "") + ">" + mm + "</option>";
      modesHtml += '<div class="row"><label>' + escapeHtml(nodeLabel(m)) + '</label><select class="f-lmode" data-node="' + m + '">' + o + "</select></div>";
    } else {
      modesHtml += '<div class="row"><label>' + escapeHtml(nodeLabel(m)) + '</label><span class="muted">' + escapeHtml(cur || ndefault) + " · enable Transport to set</span></div>";
    }
  }
  modesHtml += '<div class="row"><span class="muted">Each end\'s mode for this interface. Changing restarts that node.</span></div></details>';
  body.innerHTML =
    '<div class="row"><label>Name</label><input id="f-link-name" type="text" placeholder="optional" value="' + escapeHtml(l.name || "") + '"></div>' +
    '<div class="row"><label>MTU (>=500)</label><input id="f-mtu" type="number" min="500" value="' + l.mtu + '"></div>' +
    '<div class="row"><label>Bitrate (bps)</label><input id="f-bitrate" type="number" min="1" value="' + l.bitrate + '"></div>' +
    '<div class="row"><label>Loss</label><input id="f-loss-range" type="range" min="0" max="1" step="0.01" value="' + l.loss + '"></div>' +
    '<div class="row"><label>Loss value</label><input id="f-loss" type="number" min="0" max="1" step="0.01" value="' + l.loss + '"></div>' +
    '<div class="row"><label>Propagation (s)</label><input id="f-prop" type="number" min="0" step="0.01" value="' + l.propagation + '"></div>' +
    '<div class="row"><span class="muted">Bitrate/loss/MTU apply live (no restart).</span></div>' +
    modesHtml +
    '<details class="section"><summary>Bitrate presets / LoRa</summary>' +
    '<div class="row"><label>Preset</label><select id="f-preset">' + presetOpts + "</select></div>" +
    '<div class="row"><label>LoRa SF/BW/CR</label><span class="lora-selects"><select id="f-sf">' + sfOpts + '</select><select id="f-bw">' + bwOpts + '</select><select id="f-cr">' + crOpts + "</select></span></div>" +
    '<div class="row"><label>LoRa bitrate</label><span><span id="lora-bps" class="mono"></span> <button id="f-lora-apply">Set</button></span></div></details>' +
    '<details class="section" open><summary>Live medium stats</summary><div id="link-stats" class="muted">no traffic yet</div></details>';
  const nameEl = document.getElementById("f-link-name");
  if (nameEl) nameEl.addEventListener("change", () => {
    const v = nameEl.value.trim();
    api.patch("/api/links/" + id, { name: v });
    if (state.topology.links[id]) state.topology.links[id].name = v;
    const cyn = cy.getElementById(id);
    if (cyn) cyn.data("label", mediumLabel(state.topology.links[id]));
    title.textContent = "Link " + id + (v ? " · " + v : "");
  });
  document.querySelectorAll(".f-lmode").forEach((sel) => {
    sel.addEventListener("change", (e) => {
      const nid = e.target.getAttribute("data-node");
      const val = e.target.value;
      api.post("/api/nodes/" + nid + "/link_mode", { link_id: id, mode: val || null });
      const n = state.topology.nodes[nid];
      if (n) { n.link_modes = n.link_modes || {}; if (val) n.link_modes[id] = val; else delete n.link_modes[id]; }
    });
  });
  bindLinkInputs(id);
  bindLinkPresets(id);
  updateLinkStats(id);
}

function applyLinkBitrate(id, bitrate, mtu, loss) {
  const body = { bitrate: bitrate };
  if (mtu != null) body.mtu = mtu;
  if (loss != null) body.loss = loss;
  api.patch("/api/links/" + id, body);
  const link = state.topology.links[id];
  const set = (sel, v) => { const e = document.getElementById(sel); if (e) e.value = v; };
  set("f-bitrate", bitrate);
  if (link) link.bitrate = bitrate;
  if (mtu != null) { set("f-mtu", mtu); if (link) link.mtu = mtu; }
  if (loss != null) { set("f-loss", loss); set("f-loss-range", loss); if (link) link.loss = loss; }
}

function bindLinkPresets(id) {
  const preset = document.getElementById("f-preset");
  const sf = document.getElementById("f-sf");
  const bw = document.getElementById("f-bw");
  const cr = document.getElementById("f-cr");
  const out = document.getElementById("lora-bps");
  const apply = document.getElementById("f-lora-apply");
  const recalc = () => { if (out) out.textContent = loraBitrate(parseInt(sf.value), parseInt(bw.value), parseInt(cr.value)) + " bps"; };
  if (sf && bw && cr && out) { sf.onchange = recalc; bw.onchange = recalc; cr.onchange = recalc; recalc(); }
  if (apply) apply.onclick = () => applyLinkBitrate(id, loraBitrate(parseInt(sf.value), parseInt(bw.value), parseInt(cr.value)), null, null);
  if (preset) preset.onchange = () => {
    const p = LINK_PRESETS[parseInt(preset.value)];
    preset.value = "0";
    if (p && p.bitrate) applyLinkBitrate(id, p.bitrate, p.mtu != null ? p.mtu : null, p.loss != null ? p.loss : null);
  };
}

function updateLinkStats(id) {
  const el = document.getElementById("link-stats");
  if (!el) return;
  const m = state.media[id];
  if (!m || !m.stats) { el.innerHTML = '<span class="muted">no traffic yet</span>'; return; }
  const s = m.stats;
  const delivered = s.rx || 0;
  const dropped = s.dropped || 0;
  const denom = delivered + dropped;
  const pct = denom > 0 ? (dropped / denom * 100).toFixed(1) : "0.0";
  el.innerHTML =
    '<div class="heard-row"><span>frames sent</span><span class="muted">' + (s.tx || 0) + "</span></div>" +
    '<div class="heard-row"><span>delivered</span><span class="muted">' + delivered + "</span></div>" +
    '<div class="heard-row"><span>dropped</span><span class="muted">' + dropped + "</span></div>" +
    '<div class="heard-row"><span>measured loss</span><span class="muted">' + pct + "%</span></div>";
}

let patchTimer = null;
function bindLinkInputs(id) {
  const mtu = document.getElementById("f-mtu");
  const br = document.getElementById("f-bitrate");
  const lossRange = document.getElementById("f-loss-range");
  const loss = document.getElementById("f-loss");
  const prop = document.getElementById("f-prop");
  const pushParams = () => {
    const body = { mtu: parseInt(mtu.value), bitrate: parseInt(br.value), loss: parseFloat(loss.value), propagation: parseFloat(prop.value) };
    clearTimeout(patchTimer);
    patchTimer = setTimeout(() => api.patch("/api/links/" + id, body), 120);
  };
  lossRange.addEventListener("input", () => { loss.value = lossRange.value; pushParams(); });
  loss.addEventListener("input", () => { lossRange.value = loss.value; pushParams(); });
  mtu.addEventListener("change", pushParams);
  br.addEventListener("change", pushParams);
  prop.addEventListener("change", pushParams);
}

function logEvent(event) {
  const box = document.getElementById("log");
  let cls = "log-node";
  let text = "";
  if (event.type === "drop") { cls = "log-drop"; text = "DROP " + event.src + " -> " + event.dst + " on " + event.medium + " (" + event.size + "B)"; }
  else if (event.type === "oversize") { cls = "log-oversize"; text = "OVERSIZE " + event.node + " on " + event.medium + " (" + event.size + " > " + event.mtu + ")"; }
  else if (event.type === "traffic") {
    cls = "log-traffic";
    const rttMs = (s) => (s === null || s === undefined) ? "?" : Math.round(s * 1000);
    if (event.stage === "begin") {
      const exp = event.expected;
      const route = (event.src_name || event.src) + " → " + (event.dst_name || event.dst);
      text = "▶ resource " + route + " · " + event.size + " B" +
             (exp ? "\n↳ expected rtt ~" + rttMs(exp.rtt) + "ms (" + exp.hops + " hops)" : "");
    } else if (event.stage === "result") {
      const exp = event.expected;
      const ok = event.status === "complete";
      cls = ok ? "log-deliver" : "log-drop";
      text = (ok ? "✓ resource complete" : "✗ resource failed") +
             " · expected ~" + (exp ? rttMs(exp.rtt) : "?") + "ms" +
             (ok ? " vs final " + rttMs(event.actual_rtt) + "ms" : "") +
             " (" + (exp ? exp.hops : "?") + " hops)" +
             "\n↳ " + (event.src_name || event.src) + " → " + (event.dst_name || event.dst);
    } else {
      text = "[" + event.stage + "] " + (event.line || JSON.stringify(event));
    }
  }
  else if (event.type === "announce") { cls = "log-announce"; text = event.address ? (event.node + " announced " + event.address.slice(0, 16) + "…") : (event.node + " announce: " + (event.line || "")); }
  else if (event.type === "sim") { cls = "log-sim"; text = "simulation " + (event.active ? "started" : "stopped"); }
  else if (event.type === "log") { cls = "log-node"; text = event.node + ": " + event.line; }
  else if (event.type === "link_up") { cls = "log-deliver"; text = "link up " + event.node + " on " + event.medium; }
  else if (event.type === "link_down") { cls = "log-drop"; text = "link down " + event.node + " on " + event.medium; }
  else return;
  const div = document.createElement("div");
  div.className = "logline " + cls;
  div.textContent = text;
  box.appendChild(div);
  while (box.childNodes.length > 400) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

function haveTwoPicked() {
  return state.trafficPick.length === 2 && state.trafficPick[0] !== state.trafficPick[1];
}

function updateTrafficBox() {
  document.getElementById("traffic-src").textContent = state.trafficPick[0] ? nodeLabel(state.trafficPick[0]) : "-";
  document.getElementById("traffic-dst").textContent = state.trafficPick[1] ? nodeLabel(state.trafficPick[1]) : "-";
  document.getElementById("btn-traffic").disabled = !(state.active && haveTwoPicked());
  document.getElementById("btn-route").disabled = !(state.active && haveTwoPicked());
  document.getElementById("btn-add-link").disabled = !haveTwoPicked();
}

function ingestState(snap) {
  state.topology = snap.topology || { nodes: {}, links: {} };
  state.addresses = snap.addresses || {};
  state.lxmf = snap.lxmf || {};
  state.bridges = snap.bridges || {};
  state.media = snap.media || {};
  state.settings = snap.settings || {};
  rebuildAddrMap();
  rebuildLxmfMap();
  setSimState(snap.active);
  if (state.uiMode === "simulation") rebuild();
  if (state.pendingLayout) { state.pendingLayout = false; setTimeout(runLayout, 40); }
}

async function loadState() {
  const snap = await api.get("/api/state");
  ingestState(snap);
}

function handleEvent(event) {
  if (event.type === "state") { ingestState(event.state); return; }
  if (event.type === "topology") { loadState(); return; }
  if (event.type === "sim") { setSimState(event.active); logEvent(event); return; }
  if (event.type === "status") {
    state.nodeStatus = event.nodes;
    if (event.lxmf) { state.lxmf = event.lxmf; rebuildLxmfMap(); if (state.chatNode) populatePeers(); }
    if (event.media) state.media = event.media;
    applyStatusClasses();
    const sel = cy.$(":selected");
    if (sel.length && sel.hasClass("host")) refreshHostPanel(sel.id());
    else if (sel.length && sel.hasClass("medium")) updateLinkStats(sel.id());
    return;
  }
  if (event.type === "frame") { animateAnnounce(event); return; }
  if (event.type === "lxmf_up") { state.lxmf[event.node] = event.address; rebuildLxmfMap(); if (state.chatNode) populatePeers(); return; }
  if (event.type === "message") { receiveMessage(event); return; }
  if (event.type === "message_status") {
    const t = formatMsgStatus(event.status);
    if (t) addChatStatus(event.node, t);
    if (event.node === state.chatNode && (event.status.indexOf("DELIVERED") === 0 || event.status.indexOf("SENDFAIL") === 0)) setTimeout(clearMsgPath, 1500);
    return;
  }
  if (event.type === "settings") { state.settings = event.settings || {}; return; }
  if (event.type === "link_update") {
    const l = state.topology.links[event.link];
    if (l) { Object.assign(l, event.params); const n = cy.getElementById(event.link); if (n) { n.data("label", mediumLabel(l)); n.data("color", lossColor(l.loss)); } }
    return;
  }
  if (event.type === "log" && !state.showNodeLogs) return;
  logEvent(event);
}

function connectWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(proto + "://" + location.host + "/ws");
  ws.onmessage = (m) => { try { handleEvent(JSON.parse(m.data)); } catch (e) {} };
  ws.onclose = () => setTimeout(connectWs, 1500);
}

cy.on("tap", "node.host", (e) => {
  const id = e.target.id();
  state.trafficPick.push(id);
  while (state.trafficPick.length > 2) state.trafficPick.shift();
  applyPickClasses();
  updateTrafficBox();
  showPanel(e.target);
});

cy.on("tap", "node.medium", (e) => { showPanel(e.target); });
cy.on("tap", "node.live-root, node.live-interface, node.live-transport, node.live-rmap-transport, node.live-rmap-interface, node.live-rmap-group, node.live-destination, node.live-destination-group", (e) => { showPanel(e.target); });
cy.on("tap", (e) => { if (e.target === cy) showPanel(null); });

cy.on("dragfree", "node.host", (e) => {
  const p = e.target.position();
  api.patch("/api/nodes/" + e.target.id(), { x: p.x, y: p.y });
  if (state.topology.nodes[e.target.id()]) { state.topology.nodes[e.target.id()].x = p.x; state.topology.nodes[e.target.id()].y = p.y; }
});
cy.on("dragfree", "node.medium", (e) => {
  const p = e.target.position();
  api.patch("/api/links/" + e.target.id(), { x: p.x, y: p.y });
  if (state.topology.links[e.target.id()]) { state.topology.links[e.target.id()].x = p.x; state.topology.links[e.target.id()].y = p.y; }
});

document.getElementById("btn-start").onclick = () => api.post("/api/start");
document.getElementById("btn-stop").onclick = () => api.post("/api/stop");
document.getElementById("mode-simulation").onclick = () => setOperatingMode("simulation");
document.getElementById("mode-live").onclick = () => setOperatingMode("live");
document.getElementById("btn-live-rmap").onclick = () => {
  state.showLiveRmap = !state.showLiveRmap;
  state.liveLayoutPending = true;
  document.getElementById("btn-live-rmap").textContent = state.showLiveRmap ? "Hide RMAP discovery" : "Show RMAP discovery";
  loadLiveState();
};
document.getElementById("btn-live-destinations").onclick = () => {
  state.showLiveDestinationSummaries = !state.showLiveDestinationSummaries;
  state.liveLayoutPending = true;
  document.getElementById("btn-live-destinations").textContent = state.showLiveDestinationSummaries ? "Hide path summaries" : "Show path summaries";
  loadLiveState();
};

document.getElementById("btn-add-node").onclick = async () => {
  const ext = cy.extent();
  const x = (ext.x1 + ext.x2) / 2 + (Math.random() - 0.5) * 200;
  const y = (ext.y1 + ext.y2) / 2 + (Math.random() - 0.5) * 200;
  await api.post("/api/nodes", { x: x, y: y });
};

document.getElementById("btn-add-link").onclick = async () => {
  if (!haveTwoPicked()) return;
  const a = state.trafficPick[0], b = state.trafficPick[1];
  const na = state.topology.nodes[a], nb = state.topology.nodes[b];
  if (!na || !nb) return;
  await api.post("/api/links", { members: [a, b], x: (na.x + nb.x) / 2, y: (na.y + nb.y) / 2 });
};

async function deleteSelected() {
  const sel = cy.$(":selected");
  for (let i = 0; i < sel.length; i++) {
    const el = sel[i];
    if (el.hasClass("host")) await api.del("/api/nodes/" + el.id());
    else if (el.hasClass("medium")) await api.del("/api/links/" + el.id());
  }
}

function copySelected() {
  const sel = cy.nodes(":selected").filter(".host");
  if (!sel.length) return false;
  state.clipboard = sel.map((n) => {
    const node = state.topology.nodes[n.id()] || {};
    const p = n.position();
    return { label: node.label || n.id(), x: p.x, y: p.y, transport: node.transport === true, mode: node.mode || "full" };
  });
  return true;
}

async function pasteClipboard() {
  if (!state.clipboard || !state.clipboard.length) return;
  for (const n of state.clipboard) {
    const r = await api.post("/api/nodes", { label: n.label, x: n.x + 50, y: n.y + 50 });
    const patch = {};
    if (n.transport) patch.transport = true;
    if (n.mode && n.mode !== "full") patch.mode = n.mode;
    if (r && r.id && Object.keys(patch).length) await api.patch("/api/nodes/" + r.id, patch);
  }
}

document.getElementById("btn-delete").onclick = deleteSelected;

document.addEventListener("keydown", (e) => {
  const tag = (e.target.tagName || "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelected(); }
  else if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C")) { copySelected(); }
  else if ((e.ctrlKey || e.metaKey) && (e.key === "v" || e.key === "V")) { if (state.clipboard.length) pasteClipboard(); }
});

document.getElementById("btn-traffic").onclick = () => {
  if (state.trafficPick.length === 2) {
    const size = parseInt(document.getElementById("traffic-size").value) || 32768;
    api.post("/api/traffic", { src: state.trafficPick[0], dst: state.trafficPick[1], size: size });
  }
};

function applyPathClass(path, cls) {
  for (const nid of path) {
    const n = cy.getElementById(nid);
    if (n && n.nonempty()) n.addClass(cls);
  }
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    for (const lid in state.topology.links) {
      const l = state.topology.links[lid];
      if (l.members.indexOf(a) >= 0 && l.members.indexOf(b) >= 0) {
        for (const eid of [lid, lid + "__" + a, lid + "__" + b]) {
          const el = cy.getElementById(eid);
          if (el && el.nonempty()) el.addClass(cls);
        }
        break;
      }
    }
  }
}

function clearRoute() {
  cy.elements().removeClass("route");
}

function highlightRoute(path) {
  clearRoute();
  applyPathClass(path, "route");
}

function clearMsgPath() {
  cy.elements().removeClass("msgpath");
}

async function showMsgPath(src, dst) {
  if (!src || !dst || src === dst) return;
  try {
    const r = await api.get("/api/route?src=" + encodeURIComponent(src) + "&dst=" + encodeURIComponent(dst));
    if (r.path && r.path.length) {
      clearMsgPath();
      applyPathClass(r.path, "msgpath");
    }
  } catch (e) {}
}

document.getElementById("btn-route").onclick = async () => {
  if (!haveTwoPicked()) return;
  const src = state.trafficPick[0];
  const dst = state.trafficPick[1];
  const info = document.getElementById("route-info");
  info.textContent = "tracing…";
  clearRoute();
  try {
    const r = await api.get("/api/route?src=" + encodeURIComponent(src) + "&dst=" + encodeURIComponent(dst));
    if (r.path && r.path.length) {
      highlightRoute(r.path);
      info.textContent = r.path.map(nodeLabel).join(" → ") + "  (" + (r.path.length - 1) + " hops)";
    } else {
      info.textContent = "no route — " + (r.reason || "unknown");
    }
  } catch (e) {
    info.textContent = "route error";
  }
};

document.getElementById("btn-save").onclick = async () => {
  const topo = await api.get("/api/topology");
  const blob = new Blob([JSON.stringify(topo, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "reticulated-topology.json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

document.getElementById("btn-load").onclick = () => document.getElementById("file-load").click();
document.getElementById("file-load").addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    let topo;
    try {
      topo = JSON.parse(reader.result);
    } catch (err) {
      alert("Invalid topology JSON file");
      e.target.value = "";
      return;
    }
    if (!topo || !topo.nodes || !topo.links) {
      alert("Not a Reticulated topology file (missing nodes/links)");
      e.target.value = "";
      return;
    }
    try {
      const resp = await api.post("/api/topology/import", { topology: topo });
      if (!resp || !resp.ok) {
        alert("Import failed ");
      }
    } catch (err) {
      alert("Import request failed");
    }
    e.target.value = "";
  };
  reader.readAsText(file);
});

document.getElementById("btn-clear-log").onclick = () => { document.getElementById("log").innerHTML = ""; };
document.getElementById("show-node-logs").addEventListener("change", (e) => { state.showNodeLogs = e.target.checked; });

document.getElementById("show-addr").addEventListener("change", (e) => {
  state.showAddresses = e.target.checked;
  updateNodeLabels();
});

function openOptions() {
  const v = state.settings.announce_interval;
  const c = state.settings.announce_cap;
  document.getElementById("opt-announce-interval").value = (v === undefined || v === null) ? 300 : v;
  document.getElementById("opt-announce-cap").value = (c === undefined || c === null) ? 2 : c;
  const ll = state.settings.loglevel;
  document.getElementById("opt-loglevel").value = String((ll === undefined || ll === null) ? 4 : ll);
  document.getElementById("options-modal").classList.remove("hidden");
}

document.getElementById("btn-options").onclick = openOptions;
document.getElementById("options-close").onclick = () => document.getElementById("options-modal").classList.add("hidden");
document.getElementById("options-save").onclick = () => {
  const body = {};
  const iv = parseFloat(document.getElementById("opt-announce-interval").value);
  if (!isNaN(iv)) { let c = Math.max(0, iv); if (c > 0 && c < 60) c = 60; body.announce_interval = c; }
  const cap = parseFloat(document.getElementById("opt-announce-cap").value);
  if (!isNaN(cap)) body.announce_cap = Math.max(0.1, Math.min(100, cap));
  const ll = parseInt(document.getElementById("opt-loglevel").value);
  if (!isNaN(ll)) body.loglevel = Math.max(0, Math.min(7, ll));
  api.post("/api/settings", body);
  document.getElementById("options-modal").classList.add("hidden");
};

function setupHold(btn, ms, action) {
  let timer = null;
  const start = (e) => {
    if (e) e.preventDefault();
    btn.classList.add("holding");
    timer = setTimeout(() => { cancel(); action(); }, ms);
  };
  const cancel = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    btn.classList.remove("holding");
  };
  btn.addEventListener("mousedown", start);
  btn.addEventListener("mouseup", cancel);
  btn.addEventListener("mouseleave", cancel);
  btn.addEventListener("touchstart", start);
  btn.addEventListener("touchend", cancel);
}

setupHold(document.getElementById("btn-reset"), 3000, () => api.post("/api/reset"));

function runLiveLayout(animate) {
  if (!state.live || !cy.nodes().length || state.liveLayoutRunning) return;
  state.liveLayoutRunning = true;

  // Pass 1 uses fCoSE's spectral stage to quickly pull apart the hand-seeded
  // rows and give the force solver a topology-aware starting point.
  const detangle = cy.layout({
    name: "fcose",
    quality: "draft",
    randomize: true,
    animate: false,
    fit: false,
    samplingType: true,
    sampleSize: 25,
    nodeSeparation: 140,
    packComponents: false,
  });
  detangle.one("layoutstop", () => {
    // Pass 2 retains the spectral positions and performs a bounded CoSE
    // force refinement. Keeping this pass bounded avoids freezing the UI on
    // large path tables while still relaxing crossings and overlaps.
    const refine = cy.layout({
      name: "cose",
      randomize: false,
      animate: animate,
      animationDuration: animate ? 700 : 0,
      fit: true,
      padding: 70,
      nodeDimensionsIncludeLabels: true,
      nodeOverlap: 28,
      nodeRepulsion: 40000,
      idealEdgeLength: 125,
      edgeElasticity: 100,
      nestingFactor: 1.2,
      gravity: 0.8,
      numIter: 1000,
      initialTemp: 300,
      coolingFactor: 0.96,
      minTemp: 1,
    });
    refine.one("layoutstop", () => {
      state.liveLayoutRunning = false;
      state.liveLayoutPending = false;
    });
    refine.run();
  });
  detangle.run();
}

function runLayout() {
  if (!cy.nodes().length) return;
  if (state.uiMode === "live") {
    state.liveLayoutPending = true;
    runLiveLayout(true);
    return;
  }
  const layout = cy.layout({
    name: "cose", animate: true, animationDuration: 600, randomize: true,
    nodeOverlap: 24, idealEdgeLength: 110, componentSpacing: 130,
    nodeRepulsion: 400000, gravity: 0.25, numIter: 1200, padding: 50, fit: true,
  });
  layout.one("layoutstop", saveLayout);
  layout.run();
}

function saveLayout() {
  const nodes = {};
  const links = {};
  cy.nodes(".host").forEach((n) => {
    const p = n.position();
    nodes[n.id()] = [p.x, p.y];
    if (state.topology.nodes[n.id()]) { state.topology.nodes[n.id()].x = p.x; state.topology.nodes[n.id()].y = p.y; }
  });
  cy.nodes(".medium").forEach((n) => {
    const p = n.position();
    links[n.id()] = [p.x, p.y];
    if (state.topology.links[n.id()]) { state.topology.links[n.id()].x = p.x; state.topology.links[n.id()].y = p.y; }
  });
  api.post("/api/positions", { nodes: nodes, links: links });
}

let logNode = null;
async function openLog(id) {
  logNode = id;
  document.getElementById("log-title").textContent = "RNS log  " + nodeLabel(id);
  document.getElementById("log-modal").classList.remove("hidden");
  await refreshLog();
}
async function refreshLog() {
  if (!logNode) return;
  const pre = document.getElementById("log-content");
  pre.textContent = "loading…";
  try {
    const r = await api.get("/api/nodes/" + logNode + "/log");
    pre.textContent = (r.log && r.log.length) ? r.log : "(no log is the node running?)";
  } catch (e) {
    pre.textContent = "(error fetching log)";
  }
  pre.scrollTop = pre.scrollHeight;
}
document.getElementById("log-close").onclick = () => { logNode = null; document.getElementById("log-modal").classList.add("hidden"); };
document.getElementById("log-refresh").onclick = refreshLog;

setupHold(document.getElementById("btn-layout"), 2000, runLayout);
document.getElementById("btn-generate").onclick = () => document.getElementById("gen-modal").classList.remove("hidden");
document.getElementById("gen-close").onclick = () => document.getElementById("gen-modal").classList.add("hidden");
document.getElementById("gen-go").onclick = () => {
  const nodes = parseInt(document.getElementById("gen-nodes").value) || 10;
  const maxHops = parseInt(document.getElementById("gen-hops").value) || 4;
  const maxLoss = parseFloat(document.getElementById("gen-loss").value);
  const shape = document.getElementById("gen-shape").value;
  const presets = Array.from(document.querySelectorAll("#gen-presets input:checked")).map((c) => c.value);
  state.pendingLayout = true;
  api.post("/api/generate", { nodes: nodes, max_hops: maxHops, presets: presets, max_loss: isNaN(maxLoss) ? 0 : maxLoss, shape: shape });
  document.getElementById("gen-modal").classList.add("hidden");
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function openChat(nodeId) {
  state.chatNode = nodeId;
  if (!state.chats[nodeId]) state.chats[nodeId] = [];
  const addr = state.lxmf[nodeId];
  document.getElementById("chat-title").textContent =
    "Chat  " + nodeLabel(nodeId) + (addr ? " (" + addr.slice(0, 12) + "…)" : " (messenger starting…)");
  populatePeers();
  renderChat();
  document.getElementById("chat-modal").classList.remove("hidden");
  document.getElementById("chat-text").focus();
}

function populatePeers() {
  const sel = document.getElementById("chat-peer");
  if (!sel) return;
  const prev = sel.value;
  let html = "";
  for (const nid in state.topology.nodes) {
    if (nid === state.chatNode) continue;
    const ready = state.lxmf[nid] ? "" : " (offline)";
    html += '<option value="' + nid + '">' + escapeHtml(nodeLabel(nid)) + ready + "</option>";
  }
  sel.innerHTML = html || '<option value="">no other nodes</option>';
  if (prev) sel.value = prev;
}

function closeChat() {
  state.chatNode = null;
  clearMsgPath();
  document.getElementById("chat-modal").classList.add("hidden");
}

function pushChat(nodeId, entry) {
  if (!state.chats[nodeId]) state.chats[nodeId] = [];
  state.chats[nodeId].push(entry);
  while (state.chats[nodeId].length > 200) state.chats[nodeId].shift();
  if (state.chatNode === nodeId) renderChat();
}

function renderChat() {
  const box = document.getElementById("chat-log");
  if (!box || !state.chatNode) return;
  const msgs = state.chats[state.chatNode] || [];
  let html = "";
  for (const m of msgs) {
    if (m.dir === "status") {
      html += '<div class="msg status">' + escapeHtml(m.text) + "</div>";
    } else {
      const who = (m.dir === "in" ? "from " : "to ") + m.peer;
      html += '<div class="msg ' + m.dir + '"><span class="who">' + escapeHtml(who) + "</span>" + escapeHtml(m.text) + "</div>";
    }
  }
  box.innerHTML = html;
  box.scrollTop = box.scrollHeight;
}

function receiveMessage(event) {
  const peerNode = state.lxmfToNode[event.from];
  const peer = peerNode ? nodeLabel(peerNode) : (event.from ? event.from.slice(0, 12) + "…" : "?");
  pushChat(event.node, { dir: "in", peer: peer, text: event.text });
}

function addChatStatus(nodeId, status) {
  pushChat(nodeId, { dir: "status", text: status });
}

function formatMsgStatus(line) {
  const parts = line.split(" ");
  const tag = parts[0];
  const kv = {};
  for (const p of parts.slice(1)) { const i = p.indexOf("="); if (i > 0) kv[p.slice(0, i)] = p.slice(i + 1); }
  const ms = (s) => Math.round(parseFloat(s) * 1000);
  if (tag === "ANNOUNCED" || tag === "ANNOUNCEFAIL") return null;
  if (tag === "EXPECT") {
    let s = "↳ expected rtt ~" + ms(kv.rtt) + "ms (" + (kv.hops || "?") + " hops)";
    if (kv.timeout) s += " · link timeout ~" + kv.timeout + "s";
    return s;
  }
  if (tag === "SENDING") return "→ sending… (" + (kv.size || "?") + " B)";
  if (tag === "RETRY") return "↻ retry attempt " + (kv.attempt || "?") + "/5";
  if (tag === "DELIVERED") {
    let s = "✓ delivered · rtt " + ms(kv.rtt) + "ms";
    if (kv.via) s += " · " + kv.via;
    if (kv.size) s += " · " + kv.size + " B";
    if (kv.attempts && kv.attempts !== "1" && kv.attempts !== "0") s += " · " + kv.attempts + " tries";
    return s;
  }
  if (tag === "SENDFAIL") {
    let reason = "";
    if (parts.length >= 3 && parts[1].indexOf("=") < 0 && parts[2].indexOf("=") < 0) reason = parts.slice(1).filter((p) => p.indexOf("=") < 0).join(" ");
    else if (parts[1] && parts[1].indexOf("=") < 0) reason = parts[1];
    let s = "✗ failed" + (reason ? " (" + reason + ")" : "");
    if (kv.attempts) s += " after " + kv.attempts + " tries";
    return s;
  }
  return line;
}

function sendChat() {
  if (!state.chatNode) return;
  const dst = document.getElementById("chat-peer").value;
  const textEl = document.getElementById("chat-text");
  const text = textEl.value;
  if (!dst || !text.trim()) return;
  api.post("/api/message", { src: state.chatNode, dst: dst, text: text });
  showMsgPath(state.chatNode, dst);
  pushChat(state.chatNode, { dir: "out", peer: nodeLabel(dst), text: text });
  textEl.value = "";
}

document.getElementById("chat-close").onclick = closeChat;
document.getElementById("chat-send").onclick = sendChat;
document.getElementById("chat-text").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });

const initialQuery = new URLSearchParams(location.search);
if (initialQuery.get("rmap") === "true") {
  state.showLiveRmap = true;
  document.getElementById("btn-live-rmap").textContent = "Hide RMAP discovery";
}
if (initialQuery.get("paths") === "true") {
  state.showLiveDestinationSummaries = true;
  document.getElementById("btn-live-destinations").textContent = "Hide path summaries";
}
if (initialQuery.get("mode") === "live") setOperatingMode("live");
else loadState();
connectWs();
updateTrafficBox();
setInterval(loadLiveState, 5000);
