// Shared particle pool (bubbles, splashes, sparks, dust, glow motes).
// emit(G, {...}) from any module; the core updates and draws them in world space.

import { clamp } from './util.js';

const MAX = 600;

// p: {x, y, vx=0, vy=0, life=1, size=2, color=[r,g,b], alpha=1,
//     gravity=0, drag=0, kind='dot'|'bubble'|'streak'|'glow', water='any'|'above'|'below', grow=0}
export function emit(G, p) {
  if (G.particles.length >= MAX) G.particles.shift();
  G.particles.push({
    x: p.x, y: p.y, vx: p.vx || 0, vy: p.vy || 0, life: p.life || 1, max: p.life || 1,
    size: p.size || 2, color: p.color || [255, 255, 255], alpha: p.alpha == null ? 1 : p.alpha,
    gravity: p.gravity || 0, drag: p.drag || 0, kind: p.kind || 'dot', water: p.water || 'any', grow: p.grow || 0,
  });
}

export function updateParticles(G, dt, waterY) {
  const arr = G.particles;
  let w = 0;
  for (let i = 0; i < arr.length; i++) {
    const p = arr[i];
    p.life -= dt;
    if (p.life <= 0) continue;
    p.vy += p.gravity * dt;
    const d = 1 / (1 + p.drag * dt);
    p.vx *= d; p.vy *= d;
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.size += p.grow * dt;
    if (p.kind === 'bubble') {
      p.vx += Math.sin((p.life + p.x) * 6) * 8 * dt;
      if (p.y < waterY(G, p.x)) continue; // pops at the surface
    }
    if (p.water === 'below' && p.y < waterY(G, p.x) - 2) continue;
    arr[w++] = p;
  }
  arr.length = w;
}

export function drawParticles(ctx, G) {
  for (const p of G.particles) {
    const f = clamp(p.life / p.max, 0, 1);
    const a = p.alpha * (p.kind === 'glow' ? Math.sin(f * Math.PI) : Math.min(1, f * 2.5));
    if (a <= 0.01) continue;
    const [r, g, b] = p.color;
    if (p.kind === 'bubble') {
      ctx.strokeStyle = `rgba(${r},${g},${b},${a * 0.8})`;
      ctx.lineWidth = Math.max(0.6, p.size * 0.25);
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = `rgba(255,255,255,${a * 0.5})`;
      ctx.fillRect(p.x - p.size * 0.4, p.y - p.size * 0.5, p.size * 0.35, p.size * 0.35);
    } else if (p.kind === 'streak') {
      ctx.strokeStyle = `rgba(${r},${g},${b},${a})`;
      ctx.lineWidth = p.size;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.04, p.y - p.vy * 0.04); ctx.stroke();
    } else if (p.kind === 'glow') {
      const g2 = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size * 3);
      g2.addColorStop(0, `rgba(${r},${g},${b},${a})`);
      g2.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = g2;
      ctx.fillRect(p.x - p.size * 3, p.y - p.size * 3, p.size * 6, p.size * 6);
    } else {
      ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
  }
}
