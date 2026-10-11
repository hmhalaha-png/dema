// STUB — replaced by the player worker. See CONTRACT.md.
import { input } from '../core/input.js';
import { groundAt } from '../core/world.js';
export function init(G) {}
export function update(G, dt) {
  const P = G.player;
  P.vx = (input.right - input.left) * 70;
  if (input.right) P.facing = 1; if (input.left) P.facing = -1;
  P.x += P.vx * dt;
  const g = groundAt(G, P.x, P.y);
  if (g) P.y = g.y;
}
export function draw(ctx, G) { const P = G.player; ctx.fillStyle = '#222'; ctx.fillRect(P.x - 6, P.y - 28, 12, 28); }
export function hurtPlayer(G, dmg, fromX, kind) { G.player.hp -= dmg; }
