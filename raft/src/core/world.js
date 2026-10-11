// Cross-module world queries. Gameplay code asks these instead of reaching into
// other modules directly, so the owning module can change its internals freely.

import * as sea from '../render/sea.js';
import * as raft from '../systems/raft.js';
import * as islands from '../systems/islands.js';

// Water surface height (world y, smaller = higher) at x, including waves.
export const waterY = (G, x) => sea.waterY(G, x);
// Sea floor height at x (world y, positive = below sea level).
export const seabedY = (G, x) => sea.seabedY(G, x);

// Highest solid walkable surface at x that is at or below `fromY - 2` (so you can
// stand on it from above). Returns {y, kind: 'raft'|'island'|'seabed'} or null.
export function groundAt(G, x, fromY = -1e9) {
  let best = null;
  const r = raft.deckAt(G, x);
  if (r != null && r >= fromY - 2) best = { y: r, kind: 'raft' };
  const i = islands.groundAt(G, x);
  if (i != null && i >= fromY - 2 && (!best || i < best.y)) best = { y: i, kind: 'island' };
  const s = sea.seabedY(G, x);
  if (s >= fromY - 2 && (!best || s < best.y)) best = { y: s, kind: 'seabed' };
  return best;
}

export function addLight(G, x, y, r, color = [255, 200, 130], a = 1) {
  G.lights.push({ x, y, r, color, a });
}

// label: short Chinese verb shown as "E 喝水". act(G) runs when the player presses E.
export function addInteract(G, x, y, r, label, act, priority = 0) {
  G.interactables.push({ x, y, r, label, act, priority });
}

// A damaging area for this step (spear stab, beast swipe...). Consumers check overlap.
export function addHit(G, x, y, r, dmg, kind, from) {
  G.hits.push({ x, y, r, dmg, kind, from });
}

export function screenToWorld(G, sx, sy) {
  const v = G.view;
  return { x: G.cam.x + (sx - v.cssW / 2) / v.scale, y: G.cam.y + (sy - v.cssH / 2) / v.scale };
}
export function worldToScreen(G, wx, wy) {
  const v = G.view;
  return { x: (wx - G.cam.x) * v.scale + v.cssW / 2, y: (wy - G.cam.y) * v.scale + v.cssH / 2 };
}
// Is a world rect visible (with margin, in world units)?
export function onScreen(G, x, y, margin = 60) {
  const v = G.view;
  return x > v.left - margin && x < v.left + v.w + margin && y > v.top - margin && y < v.top + v.h + margin;
}
