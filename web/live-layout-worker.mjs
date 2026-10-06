import { hybridBusPositions } from "./live-layout.mjs";

self.onmessage = (event) => {
  try {
    const data = event.data || {};
    const result = hybridBusPositions(
      data.nodes || [],
      data.edges || [],
      data.positions || {},
      new Set(data.pinnedIds || [])
    );
    self.postMessage({
      positions: result.positions,
      busEdgeIds: Array.from(result.busEdgeIds || []),
    });
  } catch (error) {
    self.postMessage({ error: String(error && error.message || error) });
  }
};
