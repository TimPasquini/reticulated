import {
  anchorNewPositions,
  captureLayoutState,
  mergeLivePositions,
  pruneLiveLayout,
  radialClusterPosition,
  rememberedPinnedRmapNodes,
  rememberLivePosition,
} from "./live-layout.mjs";

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
  put(path, body) { return this.send("PUT", path, body); },
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
  liveReporterId: "all",
  liveReporters: [],
  showLiveDestinationSummaries: false,
  showLiveRmap: false,
  liveView: "topology",
  liveMap: null,
  liveMapLayers: null,
  liveMapHasInitialView: false,
  liveMapSignature: null,
  liveLayoutPending: true,
  liveLayoutRunning: false,
  liveLoadInFlight: false,
  liveLoadGeneration: 0,
  liveReloadRequested: false,
  liveDragging: new Map(),
  liveDeferredSnapshot: null,
  liveGraphSignature: null,
  liveSlots: {},
  liveNextSlot: {},
  livePinned: new Set(),
  liveSavedLayout: null,
  liveLayoutScope: null,
  liveLayoutSaveTimer: null,
  liveLayoutSaveGeneration: 0,
  liveLayouts: [],
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
    { selector: "node", style: { "text-overflow-wrap": "anywhere" }},
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
    { selector: "node.live-root.secondary", style: { "background-color": "#42608a", "width": 54, "height": 54 }},
    { selector: "node.live-root.stale", style: { "opacity": 0.55, "border-width": 3, "border-style": "dashed", "border-color": "#d89b45" }},
    { selector: "node.live-root.rmap-matched", style: { "border-width": 3, "border-color": "#56b9bd" }},
    { selector: "node.live-interface", style: {
      "shape": "round-rectangle", "width": 126, "height": 50, "background-color": "#356b82",
      "label": "data(label)", "color": "#eef8ff", "text-valign": "center", "text-halign": "center",
      "font-size": 10, "text-wrap": "wrap", "text-max-width": 120, "border-width": 2, "border-color": "#5292ad",
    }},
    { selector: "node.live-interface.rf", style: { "background-color": "#725a24", "border-color": "#d1a83d" }},
    { selector: "node.live-interface.i2p", style: { "background-color": "#66437a", "border-color": "#a46fc0" }},
    { selector: "node.live-interface.backbone", style: { "background-color": "#285b78", "border-color": "#4fa3cf" }},
    { selector: "node.live-interface.path-only", style: { "border-style": "dashed", "opacity": 0.75 }},
    { selector: "node.live-interface.rmap-matched", style: { "border-width": 3, "border-color": "#56b9bd" }},
    { selector: "node.live-transport", style: {
      "shape": "hexagon", "width": 50, "height": 50, "background-color": "#3d7c59",
      "label": "data(label)", "color": "#eaffef", "text-valign": "center", "text-halign": "center",
      "font-size": 9, "text-wrap": "wrap", "text-max-width": 100, "text-outline-color": "#11151c", "text-outline-width": 2,
    }},
    { selector: "node.live-transport.rmap-matched", style: { "border-width": 3, "border-color": "#56b9bd" }},
    { selector: "node.rmap-identified", style: {
      "border-width": 5, "border-color": "#63f3ee",
      "underlay-color": "#2dd4cf", "underlay-padding": 9, "underlay-opacity": 0.22,
    }},
    { selector: "node.live-transport.announce-inferred", style: {
      "border-width": 3, "border-style": "dashed", "border-color": "#e4b84a",
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
    { selector: "node.live-destination.local-service", style: {
      "shape": "round-rectangle", "width": 112, "height": 44,
      "background-color": "#62478a", "border-color": "#b58be8", "border-width": 3,
      "color": "#fff", "font-size": 10, "text-max-width": 106,
      "text-valign": "center", "text-halign": "center", "text-margin-y": 0,
    }},
    { selector: "node.live-destination.announced", style: {
      "shape": "ellipse", "width": 48, "height": 48,
      "background-color": "#705724", "border-color": "#e4b84a", "border-width": 3,
      "color": "#fff0bd", "text-max-width": 120,
    }},
    { selector: "node.live-ghost", style: {
      "shape": "round-hexagon", "width": 92, "height": 54,
      "background-color": "#382f45", "border-color": "#bb86d9", "border-width": 3,
      "border-style": "dashed", "color": "#eadcf4", "label": "data(label)",
      "text-valign": "center", "text-halign": "center", "font-size": 9,
      "text-wrap": "wrap", "text-max-width": 86,
    }},
    { selector: "node.live-destination-group", style: {
      "shape": "round-rectangle", "width": 130, "height": 48, "background-color": "#6d542a",
      "label": "data(label)", "color": "#ffe4ae", "text-valign": "center", "text-halign": "center",
      "font-size": 10, "text-wrap": "wrap", "text-max-width": 124, "border-width": 2, "border-color": "#d89b45",
    }},
    { selector: "node.live-destination-group.hop-1", style: { "background-color": "#275fa8", "border-color": "#4d8cff", "color": "#e8f1ff" }},
    { selector: "node.live-destination-group.hop-2", style: { "background-color": "#23694f", "border-color": "#2eb67d", "color": "#e6fff5" }},
    { selector: "node.live-destination-group.hop-3", style: { "background-color": "#80501f", "border-color": "#df8422", "color": "#fff0dc" }},
    { selector: "node.live-destination-group.hop-deep", style: { "background-color": "#57327d", "border-color": "#9b51e0", "color": "#f2e7ff", "opacity": 0.78 }},
    { selector: "node.live-pinned", style: {
      "border-width": 5, "border-color": "#ffd34d",
      "underlay-color": "#ffd34d", "underlay-padding": 7, "underlay-opacity": 0.16,
    }},
    { selector: "edge", style: { "width": 2, "line-color": "#46566b", "curve-style": "bezier" }},
    { selector: "edge.live-observed", style: { "line-color": "#5b8196", "target-arrow-shape": "triangle", "target-arrow-color": "#5b8196", "arrow-scale": 0.7 }},
    { selector: "edge.live-incomplete", style: {
      "line-color": "#d89b45", "line-style": "dashed", "target-arrow-shape": "triangle", "target-arrow-color": "#d89b45",
      "label": "", "font-size": 9, "color": "#e7b96b", "text-background-color": "#11151c", "text-background-opacity": 0.85,
      "text-background-padding": 2, "curve-style": "bezier",
    }},
    { selector: "edge.live-incomplete:selected", style: { "label": "data(label)" }},
    { selector: "edge.live-incomplete.hop-1", style: { "line-color": "#4d8cff", "target-arrow-color": "#4d8cff", "line-style": "solid", "width": 3 }},
    { selector: "edge.live-incomplete.hop-2", style: { "line-color": "#2eb67d", "target-arrow-color": "#2eb67d" }},
    { selector: "edge.live-incomplete.hop-3", style: { "line-color": "#df8422", "target-arrow-color": "#df8422" }},
    { selector: "edge.live-incomplete.hop-deep", style: { "line-color": "#9b51e0", "target-arrow-color": "#9b51e0", "opacity": 0.65 }},
    { selector: "edge.live-discovered", style: {
      "line-color": "#56b9bd", "line-style": "dashed", "target-arrow-shape": "triangle", "target-arrow-color": "#56b9bd",
      "label": "", "font-size": 9, "color": "#9fdbde", "text-background-color": "#11151c", "text-background-opacity": 0.85,
      "text-background-padding": 2, "curve-style": "bezier",
    }},
    { selector: "edge.live-attachment", style: {
      "line-color": "#56b9bd", "line-style": "solid", "width": 3,
      "target-arrow-shape": "triangle", "target-arrow-color": "#56b9bd", "arrow-scale": 0.8,
    }},
    { selector: "edge.live-historical", style: {
      "line-color": "#e4b84a", "line-style": "dotted",
      "target-arrow-shape": "triangle", "target-arrow-color": "#e4b84a",
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
  if (edge.kind === "unknown_segment") {
    if (edge.route_conflict && !(edge.unknown_hops > 0)) return "conflicting hop observations";
    return edge.unknown_hops + " required unknown hop" + (edge.unknown_hops === 1 ? "" : "s");
  }
  if (edge.kind !== "known_path") return "";
  if (edge.hop_tier === "4+") return "… 3+ unknown hops …";
  if (edge.hop_tier === "unknown") return "unknown path length";
  if (edge.hops === null || edge.hops === undefined) return "unknown path length";
  if (edge.unknown_hops > 0) return "… " + edge.unknown_hops + " unknown hop" + (edge.unknown_hops === 1 ? "" : "s") + " …";
  return edge.hops === 1 ? "1 hop total" : edge.hops + " hops total";
}

function liveHopClass(hops, hopTier) {
  if (hopTier === "4+" || hopTier === "unknown") return " hop-deep";
  if (hops === 1) return " hop-1";
  if (hops === 2) return " hop-2";
  if (hops === 3) return " hop-3";
  return " hop-deep";
}

function liveRenderModel(snapshot) {
  const destinationById = {};
  (snapshot.destinations || []).forEach((item) => { destinationById[item.id] = item; });
  const announceDisplayByDestination = {};
  const announceGroups = new Map();
  (snapshot.destinations || []).filter((item) => item.announced).forEach((item) => {
    const key = item.announce_identity_hash ? "identity:" + item.announce_identity_hash : "destination:" + item.hash;
    if (!announceGroups.has(key)) announceGroups.set(key, []);
    announceGroups.get(key).push(item);
  });
  for (const [key, items] of announceGroups) {
    let display = items[0];
    if (key.startsWith("identity:")) {
      const identityHash = key.slice("identity:".length);
      const routes = items.flatMap((item) => item.announce_routes || []);
      const hopValues = routes.map((route) => Number(route.hops)).filter(Number.isFinite);
      display = {
        ...items[0],
        id: "announce-identity:" + identityHash,
        hash: identityHash,
        announce_identity: true,
        identity_hash: identityHash,
        destination_hashes: Array.from(new Set(items.map((item) => item.hash))).sort(),
        announce_aspects: Array.from(new Set(items.flatMap((item) => item.announce_aspects || []))).sort(),
        announce_observed_by: Array.from(new Set(items.flatMap((item) => item.announce_observed_by || []))).sort(),
        announce_count: items.reduce((sum, item) => sum + Number(item.announce_count || 0), 0),
        announce_routes: routes,
        hops: hopValues.length ? Math.min(...hopValues) : null,
      };
    }
    items.forEach((item) => { announceDisplayByDestination[item.id] = display; });
  }
  const buckets = new Map();
  const observedEdges = [];
  const destinationNodes = [];
  const pathEdges = [];
  const addedDestinationNodes = new Set();
  for (const edge of snapshot.edges || []) {
    if (edge.kind !== "known_path") { observedEdges.push(edge); continue; }
    const destination = destinationById[edge.target];
    if (!destination) continue;
    if (destination.local || destination.local_service) {
      destinationNodes.push({ kind: "local_service", item: destination });
      pathEdges.push(edge);
      continue;
    }
    if (destination.announced) {
      const display = announceDisplayByDestination[destination.id] || destination;
      if (!addedDestinationNodes.has(display.id)) {
        destinationNodes.push({ kind: display.announce_identity ? "announced_identity" : "announced_destination", item: display });
        addedDestinationNodes.add(display.id);
      }
      if ((edge.unknown_hops > 0) || edge.route_conflict) {
        const ghostId = "ghost-segment:" + edge.id;
        const ghost = {
          id: ghostId,
          unknown_hops: edge.unknown_hops,
          route_conflict: edge.route_conflict,
          hop_delta: edge.hop_delta,
          expected_hops: edge.expected_hops,
          observed_hops: edge.hops,
          reporter_id: edge.reporter_id,
          destination_hash: destination.hash,
          label: edge.route_conflict
            ? ((edge.unknown_hops > 0 ? edge.unknown_hops + " unexplained hop" + (edge.unknown_hops === 1 ? "" : "s") : "conflicting hop counts") + "\nroute uncertainty")
            : edge.unknown_hops + " unknown intermediate\nhop" + (edge.unknown_hops === 1 ? "" : "s"),
        };
        destinationNodes.push({ kind: "ghost_segment", item: ghost });
        pathEdges.push({ ...edge, id: edge.id + ":unknown", target: ghostId, kind: "unknown_segment" });
        pathEdges.push({ ...edge, id: edge.id + ":completion", source: ghostId, target: display.id, kind: "ghost_completion", hops: 1, unknown_hops: 0 });
      } else {
        pathEdges.push({ ...edge, target: display.id });
      }
      continue;
    }
    if (!state.showLiveDestinationSummaries) continue;
    const hopTier = edge.hops === null || edge.hops === undefined ? "unknown" : (edge.hops >= 4 ? "4+" : String(edge.hops));
    const key = edge.source + "|" + destination.interface_id + "|" + hopTier;
    if (!buckets.has(key)) {
      buckets.set(key, {
        source: edge.source,
        interface_id: destination.interface_id,
        interface: destination.interface,
        reporter_id: destination.reporter_id,
        reporter_label: destination.reporter_label,
        hop_tier: hopTier,
        entries: [],
      });
    }
    buckets.get(key).entries.push({ destination: destination, edge: edge });
  }

  for (const [key, bucket] of buckets) {
    const groupId = "destination-group:" + key;
    const hopCounts = {};
    bucket.entries.forEach((entry) => {
      const exact = entry.edge.hops === null || entry.edge.hops === undefined ? "unknown" : String(entry.edge.hops);
      hopCounts[exact] = (hopCounts[exact] || 0) + 1;
    });
    const exactHops = bucket.hop_tier === "unknown" || bucket.hop_tier === "4+" ? null : Number(bucket.hop_tier);
    const totalHops = bucket.hop_tier === "unknown" ? "unknown hops" : bucket.hop_tier + " hop" + (bucket.hop_tier === "1" ? "" : "s") + " total";
    const unknownHops = bucket.hop_tier === "unknown" ? "unknown" : (bucket.hop_tier === "4+" ? "3+" : Math.max(0, exactHops - 1));
    const group = {
      id: groupId,
      count: bucket.entries.length,
      source: bucket.source,
      interface_id: bucket.interface_id,
      interface: bucket.interface,
      hops: exactHops,
      hop_tier: bucket.hop_tier,
      hop_distribution: hopCounts,
      unknown_hops: unknownHops,
      sample_hashes: bucket.entries.slice(0, 100).map((entry) => entry.destination.hash),
      reporter_id: bucket.reporter_id,
      reporter_label: bucket.reporter_label,
      label: bucket.entries.length.toLocaleString() + " destinations\n" + totalHops +
        (bucket.reporter_label ? " from " + bucket.reporter_label : ""),
    };
    destinationNodes.push({ kind: "destination_group", item: group });
    pathEdges.push({
      id: "edge:" + bucket.source + ":" + groupId,
      source: bucket.source,
      target: groupId,
      kind: "known_path",
      certainty: bucket.hop_tier === "1" ? "observed" : "incomplete",
      hops: exactHops,
      hop_tier: bucket.hop_tier,
      unknown_hops: unknownHops,
    });
  }
  if (state.showLiveDestinationSummaries) {
    for (const provided of snapshot.path_groups || []) {
      if (destinationNodes.some((entry) => entry.item.id === provided.id)) continue;
      const exactHops = provided.hop_tier === "unknown" || provided.hop_tier === "4+" ? null : Number(provided.hop_tier);
      const totalHops = provided.hop_tier === "unknown" ? "unknown hops" : provided.hop_tier + " hop" + (provided.hop_tier === "1" ? "" : "s") + " total";
      const unknownHops = provided.hop_tier === "unknown" ? "unknown" : (provided.hop_tier === "4+" ? "3+" : Math.max(0, exactHops - 1));
      const group = {
        ...provided,
        hops: exactHops,
        unknown_hops: unknownHops,
        label: provided.count.toLocaleString() + " destinations\n" + totalHops +
          (provided.reporter_label ? " from " + provided.reporter_label : ""),
      };
      destinationNodes.push({ kind: "destination_group", item: group });
      pathEdges.push({
        id: "edge:" + provided.source + ":" + provided.id,
        source: provided.source,
        target: provided.id,
        kind: "known_path",
        certainty: provided.hop_tier === "1" ? "observed" : "incomplete",
        hops: exactHops,
        hop_tier: provided.hop_tier,
        unknown_hops: unknownHops,
      });
    }
  }
  const rmapItems = snapshot.rmap_interfaces || [];
  const recordsByKnownHash = new Map();
  rmapItems.forEach((record) => {
    [record.transport_id, record.discovery_hash].forEach((value) => {
      const hash = String(value || "").toLowerCase();
      if (!hash) return;
      if (!recordsByKnownHash.has(hash)) recordsByKnownHash.set(hash, []);
      if (!recordsByKnownHash.get(hash).some((item) => item.id === record.id)) {
        recordsByKnownHash.get(hash).push(record);
      }
    });
  });
  const rmapMatches = {};
  const rmapInterfaceMatches = {};
  const matchedRecordIds = new Set();
  const matchNodeHash = (nodeId, hash) => {
    const records = recordsByKnownHash.get(String(hash || "").toLowerCase()) || [];
    if (!records.length) return;
    rmapMatches[nodeId] = records;
    records.forEach((record) => matchedRecordIds.add(record.id));
  };
  (snapshot.reporter_roots || [snapshot.root]).forEach((root) =>
    matchNodeHash(root.id, root.transport_id)
  );
  (snapshot.transports || []).forEach((transport) =>
    matchNodeHash(transport.id, transport.hash)
  );
  (snapshot.interfaces || []).forEach((interfaceItem) =>
    matchNodeHash(interfaceItem.id, interfaceItem.interface_hash)
  );
  destinationNodes.forEach((entry) => {
    const item = entry.item;
    const candidateHashes = [
      item.hash,
      item.identity_hash,
      item.announce_identity_hash,
      ...(item.announce_identity_hashes || []),
    ];
    for (const hash of candidateHashes) {
      if (recordsByKnownHash.has(String(hash || "").toLowerCase())) {
        matchNodeHash(item.id, hash);
        break;
      }
    }
  });
  const unmatchedRmapCount = rmapItems.filter((record) => !matchedRecordIds.has(record.id)).length;
  for (const match of snapshot.rmap_matches || []) {
    if (!rmapInterfaceMatches[match.interface_id]) rmapInterfaceMatches[match.interface_id] = [];
    rmapInterfaceMatches[match.interface_id].push(match);
  }
  return {
    destinationNodes: destinationNodes,
    edges: observedEdges.concat(pathEdges),
    rmapMatches: rmapMatches,
    rmapInterfaceMatches: rmapInterfaceMatches,
    unmatchedRmapCount: unmatchedRmapCount,
  };
}

function liveGraphSignature(snapshot, renderModel) {
  const roots = snapshot.reporter_roots || [snapshot.root];
  const transportCounts = (snapshot.path_summary || {}).by_transport || {};
  return JSON.stringify({
    roots: roots.map((item) => [item.id, item.label, item.primary, item.report_stale]),
    interfaces: (snapshot.interfaces || []).map((item) => [
      item.id, item.display_name || item.short_name || item.name, item.status,
      item.parent_interface_id,
    ]),
    transports: (snapshot.transports || []).map((item) => [
      item.id, item.hash, transportCounts[item.hash] || 0, item.announce_inferred,
    ]),
    destinations: renderModel.destinationNodes.map((entry) => [
      entry.kind, entry.item.id, entry.item.label, entry.item.count,
      entry.item.hops, entry.item.unknown_hops,
    ]),
    edges: renderModel.edges.map((edge) => [
      edge.id, edge.source, edge.target, edge.kind, edge.certainty,
      edge.hops, edge.unknown_hops, edge.route_conflict,
    ]),
    rmapMatches: (snapshot.rmap_matches || []).map((item) => [
      item.interface_id, item.rmap_interface_id, item.transport_id,
    ]),
    identifiedRmapNodes: Object.entries(renderModel.rmapMatches).sort().map(
      ([id, records]) => [id, records.map((record) => record.id).sort()]
    ),
  });
}

function livePositions(snapshot, renderModel) {
  const positions = {};
  const roots = snapshot.reporter_roots || [snapshot.root];
  const primary = roots.find((root) => root.primary) || snapshot.root;
  positions[primary.id] = { x: 0, y: 0 };
  let secondaryIndex = 0;
  roots.forEach((root) => {
    if (root.id === primary.id) return;
    secondaryIndex += 1;
    const direction = secondaryIndex % 2 ? -1 : 1;
    positions[root.id] = { x: direction * Math.ceil(secondaryIndex / 2) * 520, y: -300 };
  });

  const interfacesByRoot = new Map();
  renderModel.edges.filter((edge) => edge.kind === "observed_interface").forEach((edge) => {
    if (!interfacesByRoot.has(edge.source)) interfacesByRoot.set(edge.source, []);
    interfacesByRoot.get(edge.source).push(edge.target);
  });
  for (const root of roots) {
    const children = (interfacesByRoot.get(root.id) || []).sort();
    const anchor = positions[root.id];
    children.forEach((id, index) => {
      positions[id] = radialClusterPosition(anchor, index, 180, 105);
    });
  }
  const peerEdges = renderModel.edges.filter((edge) => edge.kind === "observed_peer_interface");
  const peersByParent = new Map();
  peerEdges.forEach((edge) => {
    if (!peersByParent.has(edge.source)) peersByParent.set(edge.source, []);
    peersByParent.get(edge.source).push(edge.target);
  });
  // Parent interfaces are already placed beneath their reporter. Place their
  // concrete peer interfaces one level farther out before force refinement.
  for (const [parentId, childIds] of peersByParent) {
    const anchor = positions[parentId];
    if (!anchor) continue;
    childIds.sort().forEach((id, index) => {
      positions[id] = radialClusterPosition(anchor, index, 145, 90, Math.PI / 3);
    });
  }
  const unpositionedInterfaces = (snapshot.interfaces || []).filter((item) => !positions[item.id]);
  unpositionedInterfaces.forEach((item, index) => {
    positions[item.id] = radialClusterPosition({ x: 0, y: 0 }, index, 240, 110);
  });

  // Spread next hops around the interfaces that observed them. Several next
  // hops can share an interface, so assigning all of them to its exact x/y
  // position would stack the nodes on top of each other.
  const transportGroups = new Map();
  for (const item of snapshot.transports || []) {
    if (positions[item.id]) continue;
    const parentIds = item.interface_ids || [];
    const parents = parentIds.map((id) => positions[id]).filter(Boolean);
    const anchorX = parents.length ? parents.reduce((sum, position) => sum + position.x, 0) / parents.length : 0;
    const anchorY = parents.length ? parents.reduce((sum, position) => sum + position.y, 0) / parents.length : 170;
    const groupKey = Math.round(anchorX) + ":" + Math.round(anchorY);
    if (!transportGroups.has(groupKey)) transportGroups.set(groupKey, { anchorX: anchorX, anchorY: anchorY, items: [] });
    transportGroups.get(groupKey).items.push(item);
  }
  for (const group of transportGroups.values()) {
    group.items.sort((left, right) => left.id.localeCompare(right.id));
    group.items.forEach((item, index) => {
      positions[item.id] = radialClusterPosition(
        { x: group.anchorX, y: group.anchorY }, index, 175, 90
      );
    });
  }

  // A path entry tells us the first transport and total hop count, but not the
  // intervening routers. Place aggregates in hop-depth bands without inventing
  // those routers. Four-or-more-hop paths share a deep-mesh band.
  const pathEdges = renderModel.edges.filter((edge) =>
    edge.kind === "known_path" || edge.kind === "unknown_segment" || edge.kind === "ghost_completion"
  );
  const destinationsBySource = new Map();
  pathEdges.forEach((edge) => {
    if (!destinationsBySource.has(edge.source)) destinationsBySource.set(edge.source, []);
    destinationsBySource.get(edge.source).push(edge);
  });
  for (const [source, edges] of destinationsBySource) {
    const anchor = positions[source] || { x: 0, y: 340 };
    const edgesByTier = new Map();
    edges.forEach((edge) => {
      const tier = edge.hops === 0 ? 1 : (edge.hop_tier === "unknown" ? 5 : (edge.hop_tier === "4+" ? 4 : Number(edge.hop_tier || edge.hops || 5)));
      if (!edgesByTier.has(tier)) edgesByTier.set(tier, []);
      edgesByTier.get(tier).push(edge);
    });
    for (const [tier, tierEdges] of edgesByTier) {
      tierEdges.sort((left, right) => left.target.localeCompare(right.target));
      tierEdges.forEach((edge, index) => {
        positions[edge.target] = radialClusterPosition(
          anchor, index, 150 + (tier - 1) * 105, 78, Math.PI / 2 + tier * 0.37
        );
      });
    }
  }
  return positions;
}

function liveLayoutScope() {
  return state.liveReporterId || "all";
}

function liveLayoutPath(scope, name) {
  return "/api/live/layouts/" + encodeURIComponent(scope) + "/" + encodeURIComponent(name);
}

function pinnedRmapMetadata(node) {
  if (!node || !node.nonempty() || !node.hasClass("rmap-identified")) return null;
  const item = node.data("item") || {};
  return {
    label: node.data("label") || "RMAP node",
    live_kind: node.data("liveKind") || "rmap_transport",
    hash: item.hash || item.transport_id || item.identity_hash || null,
    rmap_records: (item.rmap_records || []).slice(0, 20).map((record) => ({
      id: record.id,
      discovery_hash: record.discovery_hash,
      transport_id: record.transport_id,
      name: record.name,
      type: record.type,
      status: record.status,
      hops: record.hops,
      last_heard: record.last_heard,
      latitude: record.latitude,
      longitude: record.longitude,
      reachable_on: record.reachable_on,
      port: record.port,
      frequency: record.frequency,
      bandwidth: record.bandwidth,
    })),
  };
}

function captureLiveLayout() {
  const positions = {};
  const pinnedNodes = {};
  cy.nodes("[liveKind]").forEach((node) => {
    const position = node.position();
    positions[node.id()] = { x: position.x, y: position.y };
    const metadata = state.livePinned.has(node.id()) ? pinnedRmapMetadata(node) : null;
    if (metadata) pinnedNodes[node.id()] = metadata;
  });
  return captureLayoutState(
    state.liveSavedLayout,
    positions,
    state.livePinned,
    { zoom: cy.zoom(), pan: { ...cy.pan() } },
    pinnedNodes,
  );
}

function rememberLiveNodePosition(node) {
  if (!node || !node.nonempty()) return;
  const position = node.position();
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) return;
  // Immediately invalidate any save that captured the position before this
  // move. The next debounced save receives a new generation of its own.
  state.liveLayoutSaveGeneration += 1;
  state.liveSavedLayout = rememberLivePosition(
    state.liveSavedLayout, node.id(), position, state.livePinned
  );
  const pinnedNodes = { ...(state.liveSavedLayout.pinned_nodes || {}) };
  const metadata = state.livePinned.has(node.id()) ? pinnedRmapMetadata(node) : null;
  if (metadata) pinnedNodes[node.id()] = metadata;
  else delete pinnedNodes[node.id()];
  state.liveSavedLayout.pinned_nodes = pinnedNodes;
}

async function saveLiveLayout(name, quiet) {
  if (state.uiMode !== "live" || !cy.nodes("[liveKind]").length) return;
  const scope = liveLayoutScope();
  const generation = ++state.liveLayoutSaveGeneration;
  const saved = await api.put(liveLayoutPath(scope, name), captureLiveLayout());
  if (!saved || !saved.positions) return;
  // A slow earlier request must not replace coordinates captured by a later
  // drag, nor install a layout after the user switched reporter scopes.
  const currentScope = scope === liveLayoutScope();
  if (generation === state.liveLayoutSaveGeneration && currentScope) {
    state.liveSavedLayout = saved;
  }
  // Named-layout counts should reflect the completed write even if an
  // unrelated pan or drag advanced the in-memory save generation meanwhile.
  if (!quiet && currentScope) await refreshLiveLayouts();
  return saved;
}

function scheduleLiveAutosave() {
  if (state.uiMode !== "live") return;
  if (state.liveLayoutSaveTimer) clearTimeout(state.liveLayoutSaveTimer);
  state.liveLayoutSaveTimer = setTimeout(() => {
    state.liveLayoutSaveTimer = null;
    saveLiveLayout("__autosave__", true).catch(() => {});
  }, 700);
}

function applyLivePins() {
  if (state.uiMode !== "live") return;
  cy.nodes("[liveKind]").forEach((node) => {
    const pinned = state.livePinned.has(node.id());
    node.toggleClass("live-pinned", pinned);
    // Pinning constrains automatic layouts, but manual dragging must remain
    // available so an anchor can be repositioned without first unpinning it.
    node.unlock();
  });
  updateLivePinButton();
}

function applyLiveLayout(layout, arrangeNewNodes) {
  if (!layout || !layout.positions) return;
  state.liveSavedLayout = layout;
  state.livePinned = new Set(layout.pinned || []);
  let missing = 0;
  cy.nodes("[liveKind]").forEach((node) => {
    const position = layout.positions[node.id()];
    if (position) node.position(position);
    else missing += 1;
  });
  applyLivePins();
  if (layout.viewport) {
    cy.zoom(layout.viewport.zoom);
    cy.pan(layout.viewport.pan);
  }
  if (arrangeNewNodes && missing && state.livePinned.size) {
    state.liveLayoutPending = true;
    runLiveLayout(true);
  }
}

async function ensureLiveLayoutScope(scope) {
  if (state.liveLayoutScope === scope) return;
  state.liveLayoutScope = scope;
  state.livePinned = new Set();
  state.liveSavedLayout = null;
  const cached = await api.get(liveLayoutPath(scope, "__autosave__"));
  if (cached && cached.positions) {
    state.liveSavedLayout = cached;
    state.livePinned = new Set(cached.pinned || []);
    state.liveLayoutPending = false;
  }
  await refreshLiveLayouts();
}

async function refreshLiveLayouts() {
  const result = await api.get("/api/live/layouts?scope=" + encodeURIComponent(liveLayoutScope()));
  state.liveLayouts = result.layouts || [];
  const select = document.getElementById("live-layout-select");
  const selected = select.value;
  select.innerHTML = '<option value="">Saved layouts</option>' + state.liveLayouts.map((layout) =>
    '<option value="' + escapeHtml(layout.name) + '">' + escapeHtml(layout.name) +
      " (" + layout.pinned_count + " pinned)</option>"
  ).join("");
  if (state.liveLayouts.some((layout) => layout.name === selected)) select.value = selected;
  document.getElementById("btn-live-load-layout").disabled = !select.value;
}

function updateLivePinButton() {
  const button = document.getElementById("btn-live-pin");
  const selected = cy.nodes("[liveKind]:selected");
  button.disabled = state.uiMode !== "live" || selected.length !== 1;
  button.textContent = selected.length === 1 && state.livePinned.has(selected[0].id())
    ? "Unpin node" : "Pin node";
}

function validCoordinate(latitude, longitude) {
  const lat = Number(latitude);
  const lon = Number(longitude);
  return Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function liveMapViewportKey() {
  return "reticulated.live-map." + liveLayoutScope();
}

function saveLiveMapViewport() {
  if (!state.liveMap) return;
  const center = state.liveMap.getCenter();
  try {
    localStorage.setItem(liveMapViewportKey(), JSON.stringify({
      center: [center.lat, center.lng], zoom: state.liveMap.getZoom(),
    }));
  } catch (error) {}
}

function restoreLiveMapViewport() {
  if (!state.liveMap) return false;
  try {
    const viewport = JSON.parse(localStorage.getItem(liveMapViewportKey()));
    if (viewport && Array.isArray(viewport.center) && Number.isFinite(viewport.zoom)) {
      state.liveMap.setView(viewport.center, viewport.zoom, { animate: false });
      return true;
    }
  } catch (error) {}
  return false;
}

function ensureLiveMap() {
  if (state.liveMap || typeof L === "undefined") return state.liveMap;
  state.liveMap = L.map("live-map", { worldCopyJump: true, preferCanvas: true });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(state.liveMap);
  state.liveMapLayers = L.layerGroup().addTo(state.liveMap);
  state.liveMap.setView([20, 0], 2);
  state.liveMap.on("moveend zoomend", saveLiveMapViewport);
  return state.liveMap;
}

function rmapRecordLabel(record) {
  return record.name || record.interface_name || record.transport_id || "RMAP node";
}

function mapHopStyle(hops) {
  if (hops === 1) return { color: "#3b82f6", weight: 3, dashArray: null };
  if (hops === 2) return { color: "#10b981", weight: 2, dashArray: "7 5" };
  if (hops === 3) return { color: "#f59e0b", weight: 2, dashArray: "7 5" };
  return { color: "#a855f7", weight: 2, dashArray: "7 6" };
}

function renderLiveMap(snapshot) {
  const map = ensureLiveMap();
  const summary = document.getElementById("live-map-summary");
  if (!map) {
    summary.textContent = "Map library could not be loaded.";
    return;
  }
  const mapSignature = JSON.stringify({
    records: (snapshot.rmap_interfaces || []).map((item) => [
      item.id, item.transport_id, item.latitude, item.longitude, item.hops, item.status,
    ]),
    matches: (snapshot.rmap_matches || []).map((item) => [
      item.interface_id, item.transport_id, item.latitude, item.longitude,
    ]),
    attachments: (snapshot.rmap_attachments || []).map((item) => [
      item.source, item.target, item.interface_online,
    ]),
  });
  if (mapSignature === state.liveMapSignature) return;
  state.liveMapSignature = mapSignature;
  state.liveMapLayers.clearLayers();
  const roots = snapshot.reporter_roots || [snapshot.root];
  const rootIds = new Set(roots.map((root) => String(root.transport_id || "")));
  const rootByReporter = new Map(roots.map((root) => [root.reporter_id, root]));
  const defaultRoot = snapshot.root || roots[0] || {};
  const recordsByTransport = new Map();
  for (const record of snapshot.rmap_interfaces || []) {
    if (!validCoordinate(record.latitude, record.longitude)) continue;
    const transportId = String(record.transport_id || record.id || "");
    if (!transportId) continue;
    if (!recordsByTransport.has(transportId)) recordsByTransport.set(transportId, []);
    recordsByTransport.get(transportId).push(record);
  }

  const coordinates = new Map();
  const bounds = [];
  for (const [transportId, records] of recordsByTransport) {
    const record = records[0];
    const latlng = [Number(record.latitude), Number(record.longitude)];
    coordinates.set("transport:" + transportId, latlng);
    bounds.push(latlng);
    const isReporter = rootIds.has(transportId);
    const marker = L.circleMarker(latlng, {
      radius: isReporter ? 9 : 6,
      color: isReporter ? "#f2c94c" : "#dbeafe",
      weight: isReporter ? 3 : 2,
      fillColor: isReporter ? "#8b5cf6" : "#16a085",
      fillOpacity: 0.92,
    });
    const reporters = Array.from(new Set(records.map((item) => item.reporter_id).filter(Boolean)));
    marker.bindPopup('<div class="live-map-popup"><strong>' + escapeHtml(rmapRecordLabel(record)) +
      '</strong><span class="mono">' + escapeHtml(transportId) + '</span>' +
      '<div>' + escapeHtml(record.type || "RMAP interface") + '</div>' +
      '<div>' + latlng[0].toFixed(5) + ", " + latlng[1].toFixed(5) + '</div>' +
      (reporters.length ? '<div>Reported by: ' + escapeHtml(reporters.join(", ")) + '</div>' : "") +
      '<div class="muted">Location supplied by RMAP</div></div>');
    marker.addTo(state.liveMapLayers);
  }

  for (const match of snapshot.rmap_matches || []) {
    if (!validCoordinate(match.latitude, match.longitude)) continue;
    coordinates.set(match.interface_id, [Number(match.latitude), Number(match.longitude)]);
  }

  const drawn = new Set();
  for (const attachment of snapshot.rmap_attachments || []) {
    const source = coordinates.get(attachment.source);
    const target = coordinates.get(attachment.target) || (
      validCoordinate(attachment.latitude, attachment.longitude)
        ? [Number(attachment.latitude), Number(attachment.longitude)] : null
    );
    if (!source || !target) continue;
    const key = attachment.source + "|" + attachment.target;
    if (drawn.has(key)) continue;
    drawn.add(key);
    L.polyline([source, target], {
      color: attachment.interface_online === true ? "#3b82f6" : "#94a3b8",
      weight: attachment.interface_online === true ? 3 : 2,
      opacity: 0.8,
      dashArray: attachment.interface_online === true ? null : "7 7",
    }).bindTooltip(
      attachment.interface_online === true ? "Observed one-hop attachment" : "Configured one-hop attachment"
    ).addTo(state.liveMapLayers);
  }

  const routeCandidates = new Map();
  for (const record of snapshot.rmap_interfaces || []) {
    const root = rootByReporter.get(record.reporter_id) || defaultRoot;
    const sourceId = root.transport_id ? "transport:" + root.transport_id : null;
    const targetId = record.transport_id ? "transport:" + record.transport_id : null;
    const source = sourceId ? coordinates.get(sourceId) : null;
    const target = targetId ? coordinates.get(targetId) : null;
    const hops = Number(record.hops);
    if (!source || !target || !Number.isFinite(hops) || hops < 1 || sourceId === targetId) continue;
    const key = sourceId + "|" + targetId;
    const existing = routeCandidates.get(key);
    if (!existing || hops < existing.hops) {
      routeCandidates.set(key, { source, target, hops, reporter: root.label || record.reporter_id });
    }
  }
  for (const [key, route] of routeCandidates) {
    if (drawn.has(key)) continue;
    drawn.add(key);
    const style = mapHopStyle(route.hops);
    L.polyline([route.source, route.target], {
      ...style, opacity: 0.78,
    }).bindTooltip(
      route.hops + "-hop RMAP reachability from " + route.reporter +
      (route.hops > 1 ? " · intermediate transports unknown" : " · direct")
    ).addTo(state.liveMapLayers);
  }

  summary.innerHTML = '<strong>' + recordsByTransport.size + " geolocated RMAP node" +
    (recordsByTransport.size === 1 ? "" : "s") + "</strong> · " + drawn.size +
    " mapped relationship" + (drawn.size === 1 ? "" : "s") +
    '<div class="map-legend"><span class="hop-1">1 hop</span><span class="hop-2">2 hops</span>' +
    '<span class="hop-3">3 hops</span><span class="hop-4">4+ hops</span></div>' +
    '<div class="muted">Multi-hop lines show reachability, not invented intermediate routers. Unlocated nodes are not assigned coordinates.</div>';
  if (!state.liveMapHasInitialView) {
    state.liveMapHasInitialView = true;
    if (!restoreLiveMapViewport() && bounds.length) {
      map.fitBounds(bounds, { padding: [45, 45], maxZoom: 7, animate: false });
    }
  }
}

function setLiveView(view) {
  state.liveView = view === "map" ? "map" : "topology";
  const showingMap = state.liveView === "map";
  document.getElementById("cy").classList.toggle("hidden", showingMap);
  document.getElementById("live-map").classList.toggle("hidden", !showingMap);
  document.getElementById("btn-live-topology").classList.toggle("active", !showingMap);
  document.getElementById("btn-live-map").classList.toggle("active", showingMap);
  if (showingMap) {
    requestAnimationFrame(() => {
      const map = ensureLiveMap();
      if (map) map.invalidateSize();
      if (state.live) renderLiveMap(state.live);
      loadLiveState();
    });
  } else {
    requestAnimationFrame(() => {
      cy.resize();
      if (state.live) rebuildLive(state.live);
    });
  }
}

function rebuildLive(snapshot) {
  const hadLiveGraph = cy.nodes(".live-root").length > 0;
  const oldPan = { ...cy.pan() };
  const oldZoom = cy.zoom();
  const oldPositions = {};
  cy.nodes().forEach((node) => { oldPositions[node.id()] = { ...node.position() }; });
  const selectedIds = cy.$(":selected").map((element) => element.id());
  const renderModel = liveRenderModel(snapshot);
  const graphSignature = liveGraphSignature(snapshot, renderModel);
  if (hadLiveGraph && graphSignature === state.liveGraphSignature) {
    const freshItems = new Map();
    renderModel.destinationNodes.forEach((entry) => freshItems.set(entry.item.id, entry.item));
    cy.nodes("[liveKind]").forEach((node) => {
      if (freshItems.has(node.id())) node.data("item", freshItems.get(node.id()));
    });
    return;
  }
  const generatedPositions = livePositions(snapshot, renderModel);
  const savedPositions = (state.liveSavedLayout || {}).positions || {};
  let positions = mergeLivePositions(
    generatedPositions, savedPositions, oldPositions, state.livePinned
  );
  positions = anchorNewPositions(
    generatedPositions, positions, savedPositions, oldPositions, renderModel.edges
  );
  cy.elements().remove();
  const els = [];
  const roots = snapshot.reporter_roots || [snapshot.root];
  const rootIds = new Set(roots.map((root) => root.id));
  const rmapRecordsForNode = (id) => {
    const current = renderModel.rmapMatches[id] || [];
    if (current.length) return current;
    if (!state.livePinned.has(id)) return [];
    return (((state.liveSavedLayout || {}).pinned_nodes || {})[id] || {}).rmap_records || [];
  };
  for (const root of roots) {
    const role = root.primary ? "\nprimary reporter" : "\nreporter";
    const staleLabel = root.report_stale ? "\nstale snapshot" : "";
    const rmapRecords = rmapRecordsForNode(root.id);
    const rmapLabel = rmapRecords.length ? "◆ RMAP\n" : "";
    const label = rmapLabel + root.label + (roots.length > 1 ? role : "") + staleLabel;
    let classes = "live-root" + (root.primary ? " primary" : " secondary");
    if (rmapRecords.length) classes += " rmap-matched rmap-identified";
    if (root.report_stale) classes += " stale";
    els.push({ group: "nodes", data: { id: root.id, label: label, liveKind: "root", item: { ...root, rmap_records: rmapRecords } }, classes: classes, position: positions[root.id] });
  }
  for (const item of snapshot.interfaces || []) {
    const rmapMatches = renderModel.rmapInterfaceMatches[item.id] || [];
    const rmapRecords = rmapRecordsForNode(item.id);
    let classes = "live-interface" + liveInterfaceClass(item);
    if (item.path_only) classes += " path-only";
    if (rmapMatches.length) classes += " rmap-matched";
    if (rmapRecords.length) classes += " rmap-identified";
    const rmapLabel = rmapRecords.length
      ? "◆ RMAP · " + (rmapRecords[0].name || rmapRecords[0].type || "identified") + "\n"
      : (rmapMatches.length ? "RMAP endpoint: " + (rmapMatches[0].name || "matched") + "\n" : "");
    const interfaceLabel = item.display_name || item.short_name || item.name;
    els.push({ group: "nodes", data: { id: item.id, label: rmapLabel + interfaceLabel, liveKind: "interface", item: { ...item, rmap_matches: rmapMatches, rmap_records: rmapRecords } }, classes: classes, position: positions[item.id] });
  }
  for (const item of snapshot.transports || []) {
    if (rootIds.has(item.id)) continue;
    const transportCounts = (snapshot.path_summary || {}).by_transport || {};
    const destinationCount = transportCounts[item.hash] || 0;
    const countLabel = destinationCount ? "\n" + destinationCount.toLocaleString() + " destinations" : "";
    const rmapRecords = rmapRecordsForNode(item.id);
    const rmapLabel = rmapRecords.length ? "◆ RMAP · " + (rmapRecords[0].name || rmapRecords[0].type || "matched") + "\n" : "";
    const transportItem = { ...item, rmap_records: rmapRecords };
    const announceLabel = item.announce_inferred ? "announce next hop\n" : "next hop\n";
    els.push({ group: "nodes", data: { id: item.id, label: rmapLabel + announceLabel + shortHash(item.hash) + countLabel, liveKind: "transport", item: transportItem }, classes: "live-transport" + (rmapRecords.length ? " rmap-matched rmap-identified" : "") + (item.announce_inferred ? " announce-inferred" : ""), position: positions[item.id] });
  }
  const existingNodeIds = new Set(els.filter((element) => element.group === "nodes").map((element) => element.data.id));
  const existingObservedPairs = new Set(renderModel.edges.map((edge) => edge.source + "|" + edge.target));
  const attachmentByPair = new Map((snapshot.rmap_attachments || []).map((attachment) =>
    [attachment.via_interface_id + "|" + attachment.target, attachment]
  ));
  const rmapSlots = new Map();
  for (const match of snapshot.rmap_matches || []) {
    if (match.kind === "local_publication" || !match.transport_id) continue;
    const transportId = "transport:" + match.transport_id;
    if (transportId === match.interface_id || rootIds.has(transportId)) continue;
    if (!existingNodeIds.has(transportId)) {
      const interfacePosition = positions[match.interface_id] || { x: 0, y: 170 };
      const slot = rmapSlots.get(match.interface_id) || 0;
      rmapSlots.set(match.interface_id, slot + 1);
      const direction = slot % 2 === 0 ? 1 : -1;
      const offset = slot === 0 ? 0 : direction * Math.ceil(slot / 2) * 150;
      positions[transportId] = positions[transportId] || { x: interfacePosition.x + offset, y: interfacePosition.y + 160 };
      const transportItem = { id: transportId, hash: match.transport_id, rmap: true, rmap_records: [match.record] };
      els.push({ group: "nodes", data: { id: transportId, label: "◆ RMAP NODE\n" + (match.name || shortHash(match.transport_id)), liveKind: "rmap_transport", item: transportItem }, classes: "live-rmap-transport rmap-identified", position: positions[transportId] });
      existingNodeIds.add(transportId);
    }
    const pair = match.interface_id + "|" + transportId;
    if (!existingObservedPairs.has(pair)) {
      const attachment = attachmentByPair.get(pair);
      const classes = attachment && attachment.interface_online === true ? "live-attachment" : "live-discovered";
      els.push({ group: "edges", data: { id: "edge:rmap-match:" + match.interface_id + ":" + match.rmap_interface_id, source: match.interface_id, target: transportId, label: "Known one-hop attachment", liveKind: "edge", item: { kind: "rmap_endpoint_attachment", certainty: attachment ? attachment.certainty : "advertised", match: match, attachment: attachment } }, classes: classes });
      existingObservedPairs.add(pair);
    }
  }
  for (const entry of renderModel.destinationNodes) {
    const item = entry.item;
    const rmapRecords = rmapRecordsForNode(item.id);
    const rmapPrefix = rmapRecords.length
      ? "◆ RMAP · " + (rmapRecords[0].name || rmapRecords[0].type || "identified") + "\n"
      : "";
    const rmapClass = rmapRecords.length ? " rmap-identified" : "";
    const displayItem = rmapRecords.length ? { ...item, rmap_records: rmapRecords } : item;
    if (entry.kind === "destination_group") {
      els.push({ group: "nodes", data: { id: item.id, label: rmapPrefix + item.label, liveKind: "destination_group", item: displayItem }, classes: "live-destination-group" + liveHopClass(item.hops, item.hop_tier) + rmapClass, position: positions[item.id] });
    } else if (entry.kind === "local_service") {
      const service = item.local_service;
      const label = service ? service.name + "\n" + service.type : "Local service\n" + shortHash(item.hash);
      els.push({ group: "nodes", data: { id: item.id, label: rmapPrefix + label, liveKind: "destination", item: displayItem }, classes: "live-destination local-service" + rmapClass, position: positions[item.id] });
    } else if (entry.kind === "announced_destination") {
      const aspect = item.announce_aspect || "unclassified announce";
      const hops = item.hops === null || item.hops === undefined ? "unknown route" : item.hops + " hop" + (item.hops === 1 ? "" : "s");
      els.push({ group: "nodes", data: { id: item.id, label: rmapPrefix + aspect + "\n" + shortHash(item.hash) + "\n" + hops, liveKind: "destination", item: displayItem }, classes: "live-destination announced" + rmapClass, position: positions[item.id] });
    } else if (entry.kind === "announced_identity") {
      const services = (item.destination_hashes || []).length;
      const aspect = (item.announce_aspects || []).join(", ") || "announced identity";
      els.push({ group: "nodes", data: { id: item.id, label: rmapPrefix + aspect + "\nidentity " + shortHash(item.identity_hash) + "\n" + services + " destination" + (services === 1 ? "" : "s"), liveKind: "announce_identity", item: displayItem }, classes: "live-destination announced" + rmapClass, position: positions[item.id] });
    } else if (entry.kind === "ghost_segment") {
      els.push({ group: "nodes", data: { id: item.id, label: item.label, liveKind: "ghost_segment", item: item }, classes: "live-ghost", position: positions[item.id] });
    } else {
      const hops = item.hops === null || item.hops === undefined ? "? hops" : item.hops + " hop" + (item.hops === 1 ? "" : "s");
      els.push({ group: "nodes", data: { id: item.id, label: rmapPrefix + shortHash(item.hash) + "\n" + hops, liveKind: "destination", item: displayItem }, classes: "live-destination" + rmapClass, position: positions[item.id] });
    }
  }
  const activeNodeIds = new Set(
    els.filter((element) => element.group === "nodes").map((element) => element.data.id)
  );
  for (const remembered of rememberedPinnedRmapNodes(
    state.liveSavedLayout, state.livePinned, activeNodeIds
  )) {
    const { id, metadata, position } = remembered;
    const item = {
      id: id,
      hash: metadata.hash,
      rmap: true,
      persisted: true,
      rmap_records: metadata.rmap_records || [],
    };
    els.push({
      group: "nodes",
      data: {
        id: id,
        label: "◆ RMAP · REMEMBERED\n" + String(
          metadata.label || shortHash(metadata.hash)
        ).replace(/^◆ RMAP[^\n]*\n/, ""),
        liveKind: "persisted_rmap",
        item: item,
      },
      classes: "live-rmap-transport rmap-identified live-rmap-persisted",
      position: position,
    });
  }
  for (const edge of renderModel.edges) {
    const incomplete = edge.certainty === "incomplete" || edge.kind === "unknown_segment" || edge.kind === "ghost_completion";
    const historical = edge.certainty === "historical_observation";
    els.push({
      group: "edges",
      data: { id: edge.id, source: edge.source, target: edge.target, label: liveEdgeLabel(edge), liveKind: "edge", item: edge },
      classes: (incomplete ? "live-incomplete" : (historical ? "live-historical" : "live-observed")) + (edge.kind === "known_path" ? liveHopClass(edge.hops, edge.hop_tier) : ""),
    });
  }
  cy.add(els);
  state.liveGraphSignature = graphSignature;
  if (state.liveSavedLayout && state.liveSavedLayout.positions) {
    const activeIds = new Set(cy.nodes("[liveKind]").map((node) => node.id()));
    const pruned = pruneLiveLayout(state.liveSavedLayout, activeIds);
    if (pruned.changed) {
      state.liveLayoutSaveGeneration += 1;
      state.liveSavedLayout = pruned.layout;
      state.livePinned = new Set(pruned.layout.pinned || []);
      scheduleLiveAutosave();
    }
  }
  applyLivePins();
  const hasSavedPositions = Object.keys(savedPositions).length > 0;
  // Newly received announces must not launch the force solver every poll.
  // Their deterministic seed positions are immediately usable; users can run
  // Layout explicitly when they want a global refinement.
  const shouldAutoLayout = state.liveLayoutPending || (!hadLiveGraph && !hasSavedPositions);
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
  if (!hadLiveGraph && hasSavedPositions && state.liveSavedLayout.viewport && !shouldAutoLayout) {
    cy.zoom(state.liveSavedLayout.viewport.zoom);
    cy.pan(state.liveSavedLayout.viewport.pan);
  }
  if (shouldAutoLayout) {
    state.liveLayoutPending = false;
    // Run the same detangle/refine pipeline after a reporter, RMAP or path
    // enrichment changes the graph structure. Ordinary polling does not set
    // this flag, so user positions and viewport remain stable between polls.
    requestAnimationFrame(() => runLiveLayout(false));
  }
}

function updateLiveHealth(snapshot) {
  const health = document.getElementById("live-health");
  const sources = snapshot.health || {};
  const failed = Object.keys(sources).filter((key) => !sources[key].ok);
  const reporter = snapshot.reporter || {};
  health.classList.toggle("error", failed.length > 0 || reporter.stale === true);
  if (failed.length) {
    health.textContent = "Stale/partial · " + failed.map((key) => key + ": " + sources[key].error).join(" · ");
  } else if (reporter.stale) {
    health.textContent = "Reporter stale · last received " + Math.round(reporter.age_seconds || 0) + "s ago";
  } else {
    const destinationCount = (snapshot.path_summary || {}).destination_count ?? (snapshot.destinations || []).length;
    const rmapCount = (snapshot.rmap_summary || {}).record_count || 0;
    const rmapMatched = (snapshot.rmap_summary || {}).matched_interface_count || 0;
    const announceCount = (snapshot.announce_summary || {}).event_count || 0;
    const announceMapped = (snapshot.announce_summary || {}).enriched_destination_count || 0;
    const announceSuppressed = (snapshot.announce_summary || {}).suppressed_destination_count || 0;
    health.textContent = (snapshot.interfaces || []).length + " interfaces · " +
      (snapshot.transports || []).length + " next hops · " +
      destinationCount + " known paths · " + rmapCount + " RMAP records · " +
      announceCount + " captured announces · " + announceMapped + " mapped" +
      (announceSuppressed ? " (" + announceSuppressed + " retained off-graph)" : "") + " · " + rmapMatched +
      " interface matches · received " + Math.round(reporter.age_seconds || 0) + "s ago";
  }
}

function applyLiveSnapshot(snapshot) {
  state.live = snapshot;
  updateLiveHealth(snapshot);
  if (state.liveView === "map") renderLiveMap(snapshot);
  else rebuildLive(snapshot);
}

async function loadLiveState() {
  if (state.uiMode !== "live") return;
  if (state.liveLayoutRunning || state.liveLoadInFlight || state.liveDragging.size) {
    state.liveReloadRequested = true;
    return;
  }
  state.liveLoadInFlight = true;
  state.liveReloadRequested = false;
  const generation = ++state.liveLoadGeneration;
  try {
    await refreshLiveReporters();
    if (generation !== state.liveLoadGeneration) return;
    if (!state.liveReporterId) return;
    const reporterScope = state.liveReporterId;
    await ensureLiveLayoutScope(reporterScope);
    if (generation !== state.liveLoadGeneration || reporterScope !== state.liveReporterId) return;
    const query = new URLSearchParams();
    if (state.showLiveRmap || state.liveView === "map") query.set("include_rmap", "true");
    const endpoint = reporterScope === "all"
      ? "/api/live/network"
      : "/api/live/reporters/" + encodeURIComponent(reporterScope) + "/state";
    const snapshot = await api.get(endpoint + (query.size ? "?" + query.toString() : ""));
    if (generation !== state.liveLoadGeneration || reporterScope !== state.liveReporterId) return;
    if (state.liveDragging.size) {
      state.liveDeferredSnapshot = { reporterScope: reporterScope, snapshot: snapshot };
      return;
    }
    applyLiveSnapshot(snapshot);
  } catch (error) {
    const health = document.getElementById("live-health");
    health.textContent = "Live API unavailable";
    health.classList.add("error");
  } finally {
    state.liveLoadInFlight = false;
    if (state.liveReloadRequested && !state.liveDragging.size) {
      state.liveReloadRequested = false;
      setTimeout(loadLiveState, 0);
    }
  }
}

async function refreshLiveReporters() {
  const catalog = await api.get("/api/live/reporters");
  const reporters = catalog.reporters || [];
  state.liveReporters = reporters;
  if (state.liveReporterId !== "all" && !reporters.some((item) => item.id === state.liveReporterId)) {
    const preferred = reporters.find((item) => item.local) || reporters[0];
    state.liveReporterId = preferred ? preferred.id : "all";
  }
  const select = document.getElementById("live-reporter");
  const signature = reporters.map((item) => item.id + ":" + item.stale).join("|");
  if (select.dataset.signature !== signature) {
    select.innerHTML = '<option value="all">All reporters (' + reporters.length + ")</option>" + reporters.map((item) =>
      '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.label) + (item.stale ? " (stale)" : "") + "</option>"
    ).join("");
    select.dataset.signature = signature;
  }
  if (state.liveReporterId) select.value = state.liveReporterId;
}

function setOperatingMode(mode) {
  state.uiMode = mode;
  const live = mode === "live";
  document.body.classList.toggle("live-mode", live);
  document.getElementById("mode-simulation").classList.toggle("active", !live);
  document.getElementById("mode-live").classList.toggle("active", live);
  state.trafficPick = [];
  showPanel(null);
  if (live) {
    state.liveLayoutPending = true;
    setLiveView(state.liveView);
    if (state.liveView === "topology") loadLiveState();
  } else {
    document.getElementById("live-map").classList.add("hidden");
    document.getElementById("cy").classList.remove("hidden");
    rebuild();
    updateTrafficBox();
  }
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
      '<span class="live-swatch incomplete"></span><span class="muted">dashed: unknown intermediate hops</span>' +
      '<span class="muted">ghost nodes: required but unidentified topology</span></div>';
    return;
  }
  const item = el.data("item") || {};
  const kind = el.data("liveKind");
  const row = (name, value) => '<div class="row"><label>' + escapeHtml(name) + '</label><span class="mono">' + escapeHtml(liveValue(value)) + "</span></div>";
  if (kind === "root") {
    title.textContent = item.label || "Local RNS";
    const reporter = ((state.live || {}).reporters || []).find((entry) => entry.id === item.reporter_id) || (state.live || {}).reporter || {};
    const rmapRecords = item.rmap_records || [];
    const rmapDetails = rmapRecords.length ? '<details class="section"><summary>Matched RMAP metadata (' + rmapRecords.length + ')</summary>' +
      rmapRecords.map((record) => row("Advertised interface", record.name) + row("Type", record.type) +
        row("Latitude", record.latitude) + row("Longitude", record.longitude)).join("") + "</details>" : "";
    body.innerHTML = row("Reporter ID", item.reporter_id || reporter.id) + row("Role", item.primary ? "primary" : "contributing") + row("Transport identity", item.transport_id) +
      row("Report age", reporter.age_seconds === undefined ? "unknown" : reporter.age_seconds + " seconds") +
      row("Mode", "read-only live observation") + rmapDetails;
  } else if (kind === "interface") {
    title.textContent = item.name || "Interface";
    const rmapMatches = item.rmap_matches || [];
    const rmapDetails = rmapMatches.length ? '<details class="section" open><summary>RMAP matches (' + rmapMatches.length + ')</summary>' +
      rmapMatches.map((match) => row("Match", match.kind) + row("RMAP name", match.name) +
        row("Transport", match.transport_id) + row("Reachable on", match.reachable_on) +
        row("Coordinates", match.latitude === null || match.latitude === undefined ? "unknown" : match.latitude + ", " + match.longitude)).join("") + "</details>" : "";
    body.innerHTML = row("Reporter", item.reporter_id) + row("Type", item.type) + row("Interface hash", item.interface_hash) + row("Mode", item.mode) +
      row("Online", item.status) + row("Peers", item.peers) + row("Bitrate", item.bitrate) + row("MTU", item.mtu) +
      row("Received bytes", item.rxb) + row("Transmitted bytes", item.txb) +
      (item.path_only ? '<div class="muted">This interface was reported by the path table but absent from the latest interface status.</div>' : "") + rmapDetails;
  } else if (kind === "transport") {
    const destinations = (state.live.destinations || []).filter((destination) => destination.via === item.hash);
    const knownDestinationCount = ((state.live.path_summary || {}).by_transport || {})[item.hash] || destinations.length;
    const hopCounts = {};
    destinations.forEach((destination) => {
      const key = destination.hops === null || destination.hops === undefined ? "unknown" : destination.hops;
      hopCounts[key] = (hopCounts[key] || 0) + 1;
    });
    const distribution = Object.keys(hopCounts).sort((a, b) => Number(a) - Number(b)).map((hops) => hops + " hops: " + hopCounts[hops]).join(" · ");
    const rmapRecords = item.rmap_records || [];
    const rmapDetails = rmapRecords.length ? '<details class="section"><summary>Matched RMAP metadata (' + rmapRecords.length + ')</summary>' +
      rmapRecords.map((record) => row("Advertised interface", record.name) + row("Type", record.type) +
        row("Latitude", record.latitude) + row("Longitude", record.longitude)).join("") + "</details>" : "";
    title.textContent = "Observed next-hop transport";
    body.innerHTML = row("Transport hash", item.hash) + row("Observed by", (item.observed_by || []).join(", ")) + row("Interface IDs", (item.interface_ids || []).join(", ")) +
      row("Known destinations", knownDestinationCount) + row("Hop distribution", distribution || "load path summaries to inspect") +
      (item.announce_inferred
        ? '<div class="muted">A received announce recorded this as the next transport at capture time. The dotted attachment is historical evidence, not a claim that the path is still current.</div>'
        : '<div class="muted">The local path table supports this as a next hop. It does not reveal routers beyond it.</div>') + rmapDetails;
  } else if (kind === "rmap_transport" || kind === "persisted_rmap") {
    title.textContent = kind === "persisted_rmap"
      ? "Remembered RMAP node (no active route)"
      : "RMAP-discovered transport";
    body.innerHTML = row("Transport hash", item.hash) + row("Announced hops", item.hops) +
      '<div class="muted">' + (kind === "persisted_rmap"
        ? "Pinned from prior RMAP evidence. It is retained as an anchor, but no reporter currently supplies an active route to it."
        : "Learned from an RMAP interface-discovery announce. This is not evidence of direct adjacency.") + "</div>";
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
    const distribution = Object.keys(item.hop_distribution || {}).sort((a, b) => Number(a) - Number(b)).map((hops) => hops + " hops: " + item.hop_distribution[hops]).join(" · ");
    body.innerHTML = row("Reporter", item.reporter_label || item.reporter_id) + row("Destinations", item.count) + row("Hop tier", item.hop_tier) + row("Exact distribution", distribution || item.hop_tier) +
      row("Unknown after next hop", item.unknown_hops) + row("Interface", item.interface) +
      '<details class="section"><summary>Destination hashes' + (item.count > item.sample_hashes.length ? " (first " + item.sample_hashes.length + ")" : "") + '</summary><div class="destination-hashes">' + hashes + "</div></details>";
  } else if (kind === "destination") {
    const service = item.local_service;
    title.textContent = service ? service.name : (item.local ? "Local Reticulum service" : "Known destination");
    const remaining = item.hops === null || item.hops === undefined ? "unknown" : Math.max(0, item.hops - (item.via ? 1 : 0));
    body.innerHTML = (service ? row("Service type", service.type) + row("Hosted by", service.reporter_id || item.reporter_label || item.reporter_id) : "") +
      row("Destination hash", item.hash) + row("Local", item.local === true) + row("Total hops", item.hops) + row("Next transport", item.via) +
      row("Unknown remaining hops", remaining) + row("Interface", item.interface) + row("Expires", item.expires) +
      (item.announced ? row("Announce aspect", item.announce_aspect) + row("Announces captured", item.announce_count) +
        row("Observed by", (item.announce_observed_by || []).join(", ")) + row("Last announced", item.announce_received_at) +
        '<div class="muted">This node is backed by a received announce. Dashed route segments preserve unknown intermediate hops.</div>' : "");
  } else if (kind === "announce_identity") {
    const hashes = (item.destination_hashes || []).map((hash) => '<div class="mono">' + escapeHtml(hash) + "</div>").join("");
    title.textContent = "Announced Reticulum identity";
    body.innerHTML = row("Identity hash", item.identity_hash) + row("Aspects", (item.announce_aspects || []).join(", ")) +
      row("Observed by", (item.announce_observed_by || []).join(", ")) + row("Announces captured", item.announce_count) +
      '<details class="section" open><summary>Destination hashes</summary><div class="destination-hashes">' + hashes + "</div></details>" +
      '<div class="muted">These destinations are grouped because their announces carry the same identity hash.</div>';
  } else if (kind === "ghost_segment") {
    title.textContent = "Unknown topology segment";
    body.innerHTML = row("Required unknown hops", item.unknown_hops) + row("Reporter", item.reporter_id) +
      row("Observed total hops", item.observed_hops) + row("Expected stitched hops", item.expected_hops) +
      row("Hop-count delta", item.hop_delta) + row("Destination", item.destination_hash) +
      '<div class="muted">This is not a fabricated router. It represents topology that the observations require but do not identify.</div>';
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
cy.on("tap", "node[liveKind]", (e) => {
  showPanel(e.target);
  updateLivePinButton();
});
cy.on("tap", (e) => {
  if (e.target === cy) showPanel(null);
  updateLivePinButton();
});

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
async function completeLiveNodeDrag(node) {
  const id = node.id();
  const start = state.liveDragging.get(id);
  if (!start || start.committing) return;
  start.committing = true;
  const position = node.position();
  const moved = Math.hypot(position.x - start.x, position.y - start.y) > 0.5;
  if (moved) {
    state.livePinned.add(id);
    // Commit the coordinate before permitting a deferred topology rebuild.
    rememberLiveNodePosition(node);
    applyLivePins();
    try {
      const saved = await saveLiveLayout("__autosave__", true);
      if (!saved) scheduleLiveAutosave();
    } catch (error) {
      // Keep the in-memory coordinate authoritative and retry shortly.
      scheduleLiveAutosave();
    }
  }
  state.liveDragging.delete(id);
  if (state.liveDragging.size) return;

  const deferred = state.liveDeferredSnapshot;
  state.liveDeferredSnapshot = null;
  if (deferred && deferred.reporterScope === state.liveReporterId) {
    applyLiveSnapshot(deferred.snapshot);
  }
  if (state.liveReloadRequested) {
    state.liveReloadRequested = false;
    setTimeout(loadLiveState, 0);
  }
}

cy.on("grab", "node[liveKind]", (e) => {
  state.liveDragging.set(e.target.id(), { ...e.target.position(), committing: false });
});
cy.on("dragfree", "node[liveKind]", (e) => completeLiveNodeDrag(e.target));
cy.on("free", "node[liveKind]", (e) => {
  // Usually dragfree completes this transaction. This fallback handles a grab
  // released without movement, while allowing dragfree to run first.
  const node = e.target;
  requestAnimationFrame(() => completeLiveNodeDrag(node));
});
cy.on("pan zoom", () => {
  if (!state.liveLayoutRunning) {
    state.liveLayoutSaveGeneration += 1;
    scheduleLiveAutosave();
  }
});

document.getElementById("btn-start").onclick = () => api.post("/api/start");
document.getElementById("btn-stop").onclick = () => api.post("/api/stop");
document.getElementById("mode-simulation").onclick = () => setOperatingMode("simulation");
document.getElementById("mode-live").onclick = () => setOperatingMode("live");
document.getElementById("live-reporter").onchange = (event) => {
  saveLiveMapViewport();
  state.liveReporterId = event.target.value;
  state.live = null;
  state.liveLoadGeneration += 1;
  state.liveDeferredSnapshot = null;
  state.liveReloadRequested = true;
  state.liveDragging.clear();
  state.liveLayoutPending = true;
  state.liveGraphSignature = null;
  state.liveLayoutScope = null;
  state.liveSavedLayout = null;
  state.livePinned = new Set();
  state.liveLayoutSaveGeneration += 1;
  state.liveMapHasInitialView = false;
  state.liveMapSignature = null;
  cy.elements().remove();
  loadLiveState();
};
document.getElementById("btn-live-pin").onclick = () => {
  const selected = cy.nodes("[liveKind]:selected");
  if (selected.length !== 1) return;
  const id = selected[0].id();
  if (state.livePinned.has(id)) state.livePinned.delete(id);
  else state.livePinned.add(id);
  rememberLiveNodePosition(selected[0]);
  applyLivePins();
  scheduleLiveAutosave();
};
document.getElementById("btn-live-save-layout").onclick = async () => {
  const name = window.prompt("Layout name:");
  if (!name || !name.trim()) return;
  if (!/^[A-Za-z0-9._ -]{1,64}$/.test(name.trim())) {
    window.alert("Layout names may contain letters, numbers, spaces, dot, underscore, and dash.");
    return;
  }
  try {
    await saveLiveLayout(name.trim(), false);
    document.getElementById("live-layout-select").value = name.trim();
    document.getElementById("btn-live-load-layout").disabled = false;
  } catch (error) {
    window.alert("Could not save layout: " + error);
  }
};
document.getElementById("live-layout-select").onchange = (event) => {
  document.getElementById("btn-live-load-layout").disabled = !event.target.value;
};
document.getElementById("btn-live-load-layout").onclick = async () => {
  const name = document.getElementById("live-layout-select").value;
  if (!name) return;
  const layout = await api.get(liveLayoutPath(liveLayoutScope(), name));
  if (layout && layout.positions) {
    state.liveLayoutSaveGeneration += 1;
    applyLiveLayout(layout, false);
    // The selected layout may contain remembered RMAP anchors that are not in
    // the current route snapshot and therefore need to be materialized.
    state.liveGraphSignature = null;
    if (state.live) rebuildLive(state.live);
    scheduleLiveAutosave();
  }
};
document.getElementById("btn-live-rmap").onclick = () => {
  state.showLiveRmap = !state.showLiveRmap;
  state.liveLayoutPending = true;
  document.getElementById("btn-live-rmap").textContent = state.showLiveRmap ? "Hide RMAP metadata" : "Show RMAP metadata";
  loadLiveState();
};
document.getElementById("btn-live-topology").onclick = () => setLiveView("topology");
document.getElementById("btn-live-map").onclick = () => setLiveView("map");
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
  state.liveLayoutSaveGeneration += 1;
  const startedAt = performance.now();
  const nodeCount = cy.nodes().length;
  const edgeCount = cy.edges().length;
  // Rebuild every unpinned branch from topology-aware seeds on an explicit
  // Layout request. Only pinned coordinates act as anchors; a bad historical
  // row must not remain authoritative merely because it is currently drawn.
  const renderModel = liveRenderModel(state.live);
  const generated = livePositions(state.live, renderModel);
  const pinnedPositions = {};
  cy.nodes("[liveKind]").forEach((node) => {
    if (state.livePinned.has(node.id())) pinnedPositions[node.id()] = { ...node.position() };
  });
  let seeded = mergeLivePositions(
    generated, pinnedPositions, pinnedPositions, state.livePinned
  );
  seeded = anchorNewPositions(
    generated, seeded, pinnedPositions, pinnedPositions, renderModel.edges
  );
  cy.nodes("[liveKind]").forEach((node) => {
    if (!state.livePinned.has(node.id()) && seeded[node.id()]) node.position(seeded[node.id()]);
  });
  applyLivePins();
  const fixedNodeConstraint = cy.nodes("[liveKind]").filter((node) =>
    state.livePinned.has(node.id())
  ).map((node) => ({ nodeId: node.id(), position: { ...node.position() } }));
  fixedNodeConstraint.forEach((constraint) => {
    cy.getElementById(constraint.nodeId).lock();
  });

  const finish = (strategy) => {
    state.liveLayoutRunning = false;
    state.liveLayoutPending = false;
    applyLivePins();
    scheduleLiveAutosave();
    console.info(
      "Reticulated layout profile:", strategy,
      nodeCount + " nodes,", edgeCount + " edges,",
      Math.round(performance.now() - startedAt) + "ms"
    );
  };

  // Force-directed layouts become disproportionately expensive once announce
  // enrichment grows into the hundreds. The radial topology seed above still
  // performs a useful layout instead of leaving large graphs in fixed rows.
  if (nodeCount > 400) {
    cy.nodes("[liveKind]").unlock();
    cy.fit(cy.elements(), 70);
    finish("radial topology clusters (force refinement skipped)");
    return;
  }

  // Preserve topology-aware and user-arranged starting positions. The old
  // random spectral pass discarded those anchors and collapsed branches back
  // around the generated origin before the force refinement even began.
  const layout = cy.layout({
    name: "fcose",
    quality: "default",
    randomize: false,
    animate: animate,
    animationDuration: animate ? 700 : 0,
    fit: true,
    padding: 70,
    nodeDimensionsIncludeLabels: true,
    samplingType: true,
    sampleSize: 25,
    nodeSeparation: 120,
    nodeRepulsion: 7000,
    idealEdgeLength: 135,
    edgeElasticity: 0.35,
    nestingFactor: 0.1,
    gravity: 0.08,
    gravityRange: 4.5,
    gravityCompound: 0.08,
    gravityRangeCompound: 2.0,
    numIter: 2500,
    initialEnergyOnIncremental: 0.2,
    packComponents: true,
    fixedNodeConstraint: fixedNodeConstraint,
  });
  layout.one("layoutstop", () => {
    finish("incremental constrained fCoSE");
  });
  layout.run();
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
if (initialQuery.get("reporter")) state.liveReporterId = initialQuery.get("reporter");
if (initialQuery.get("rmap") === "true") {
  state.showLiveRmap = true;
  document.getElementById("btn-live-rmap").textContent = "Hide RMAP metadata";
}
if (initialQuery.get("paths") === "true") {
  state.showLiveDestinationSummaries = true;
  document.getElementById("btn-live-destinations").textContent = "Hide path summaries";
}
if (initialQuery.get("view") === "map") setLiveView("map");
if (initialQuery.get("mode") === "live") setOperatingMode("live");
else loadState();
connectWs();
updateTrafficBox();
setInterval(loadLiveState, 5000);
