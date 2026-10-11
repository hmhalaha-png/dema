// STUB — replaced by the raft/building worker. See CONTRACT.md.
import { C } from '../core/state.js';
import { waterY } from '../core/world.js';
export function init(G) {}
export function update(G, dt) {
  const R = G.raft;
  R.vx = R.anchored ? 0 : C.DRIFT + (R.sailUp ? C.SAIL_BOOST : 0);
  R.x += R.vx * dt;
  R.y = waterY(G, R.x + R.tiles.length * C.TILE_W / 2) - C.DECK_H;
}
export function deckAt(G, x) {
  const R = G.raft; if (R.y == null) return null;
  return x >= R.x && x <= R.x + R.tiles.length * C.TILE_W ? R.y : null;
}
export function draw(ctx, G) {
  const R = G.raft; ctx.fillStyle = '#6b4a2a';
  ctx.fillRect(R.x, R.y, R.tiles.length * C.TILE_W, 8);
}
export function drawBuildGhost(ctx, G) {}
