// STUB — replaced by the items/UI worker. See CONTRACT.md.
export const ITEMS = {};
export function init(G) {}
export const count = (G, id) => G.inv[id] || 0;
export function addItem(G, id, n = 1) { G.inv[id] = (G.inv[id] || 0) + n; }
export function hasItems(G, cost) { return Object.entries(cost).every(([k, n]) => (G.inv[k] || 0) >= n); }
export function takeItems(G, cost) { if (!hasItems(G, cost)) return false; for (const [k, n] of Object.entries(cost)) G.inv[k] -= n; return true; }
export function useItem(G, id) { return false; }
