// 少年与海 — lighting and post-processing.
//
// drawLighting: a reduced-resolution darkness buffer (night, storm, and above all DEPTH),
//   light pools carved out of it from G.lights, a faint halo that always keeps the boy
//   findable, then an additive coloured glow pass for the lights themselves.
// drawPost: colour grade per time of day, heavy vignette (opened around the sun and moon),
//   a small sun bloom so the sun is always the brightest thing, animated film grain, dust
//   motes, and finally G.fade (full-screen black for cutscenes).

import { clamp, smoothstep, hash1, mixColor, makeCanvas } from '../core/util.js';
import { celestial } from './sky.js';
import { waterTop, drawNightOverlay, FX } from './sea.js';

const BUF_SCALE = 0.5;   // darkness buffer resolution relative to CSS pixels

let buf = null, bctx = null;
let ART = null;
let tick = 0;            // render-frame counter (G.frame stops while paused)
const perf = { last: 0, ema: 16.7, slow: 0 };

// Adaptive safety net: if the real frame interval stays well below 60 fps for a few
// seconds, drop the optional full-screen passes (the look barely changes).
function watchFrameRate() {
  const force = typeof window !== 'undefined' && window.__raftFx;   // 'high' | 'low' (testing)
  if (force === 'high' || force === 'low') { FX.low = force === 'low'; return; }
  const now = typeof performance !== 'undefined' ? performance.now() : 0;
  const dt = now - perf.last;
  perf.last = now;
  if (!(dt > 0) || dt > 250) return;          // first frame, tab switch, breakpoint
  perf.ema += (dt - perf.ema) * 0.05;
  if (perf.ema > 24) perf.slow += dt; else perf.slow = Math.max(0, perf.slow - dt * 0.5);
  // once switched down it stays down for the session (no visible flip-flopping)
  if (!FX.low && perf.slow > 3000) FX.low = true;
}

// =====================================================================================
// setup
// =====================================================================================

export function init(G) {
  ensureArt();
  G.postFx = { grain: 0, gx: 0, gy: 0 };
}

export function resize(G) {
  const v = G.view;
  if (!(v && v.cssW > 0)) return;
  const k = v.cssW * v.cssH > 1.6e6 ? BUF_SCALE * 0.75 : BUF_SCALE;
  const w = Math.max(16, Math.ceil(v.cssW * k)), h = Math.max(16, Math.ceil(v.cssH * k));
  if (!buf) { buf = makeCanvas(w, h); bctx = buf.getContext('2d'); }
  else if (buf.width !== w || buf.height !== h) { buf.width = w; buf.height = h; }
}

function ensureArt() {
  if (ART || typeof document === 'undefined') return ART;
  ART = {
    hole: radialSprite(128, (d) => { const t = 1 - d; return t <= 0 ? 0 : Math.pow(t, 1.25) * (0.75 + 0.25 * t); }),
    glow: radialSprite(96, (d) => Math.exp(-d * d * 4.2) * (1 - d)),
    core: radialSprite(64, (d) => Math.exp(-d * d * 9)),
    vignette: makeVignette(),
    grain: [makeGrain(1), makeGrain(2), makeGrain(3)],
    tints: new Map(),
  };
  return ART;
}

function radialSprite(size, fn) {
  const c = makeCanvas(size, size), g = c.getContext('2d');
  const img = g.createImageData(size, size), d = img.data, h = size / 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dd = Math.min(1, Math.hypot(x + 0.5 - h, y + 0.5 - h) / h);
    const i = (y * size + x) * 4;
    d[i] = d[i + 1] = d[i + 2] = 255;
    d[i + 3] = 255 * clamp(fn(dd), 0, 1);
  }
  g.putImageData(img, 0, 0);
  return c;
}

function makeVignette() {
  const S = 256, c = makeCanvas(S, S), g = c.getContext('2d');
  const img = g.createImageData(S, S), d = img.data;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const nx = (x + 0.5) / S * 2 - 1, ny = (y + 0.5) / S * 2 - 1;
    // squarish-round falloff, a little heavier along the bottom edge
    const r = Math.pow(Math.pow(Math.abs(nx), 2.6) + Math.pow(Math.abs(ny * (ny > 0 ? 1.08 : 1)), 2.6), 1 / 2.6);
    const a = smoothstep(0.42, 1.18, r);
    const i = (y * S + x) * 4;
    d[i] = 2; d[i + 1] = 3; d[i + 2] = 8;
    d[i + 3] = 255 * Math.pow(a, 1.35);
  }
  g.putImageData(img, 0, 0);
  return c;
}

function makeGrain(seed) {
  const S = 256, c = makeCanvas(S, S), g = c.getContext('2d');
  const img = g.createImageData(S, S), d = img.data;
  let s = seed * 9301 + 49297;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  for (let i = 0; i < S * S; i++) {
    const n = (rnd() + rnd() + rnd() - 1.5) / 1.5;   // soft gaussian-ish
    const v = clamp(128 + n * 120, 0, 255);
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
    d[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

function tinted(src, col) {
  const key = (src === ART.glow ? 'g' : src === ART.core ? 'c' : 'h') + ((col[0] >> 3) << 10 | (col[1] >> 3) << 5 | (col[2] >> 3));
  let c = ART.tints.get(key);
  if (c) return c;
  if (ART.tints.size > 96) ART.tints.clear();
  c = makeCanvas(src.width, src.height);
  const g = c.getContext('2d');
  g.drawImage(src, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = `rgb(${col[0] | 0},${col[1] | 0},${col[2] | 0})`;
  g.fillRect(0, 0, c.width, c.height);
  ART.tints.set(key, c);
  return c;
}

// warm lights lean a little further toward orange (lamp light, not yellow-green)
function warm(c) {
  return c[0] > c[2] + 40 ? [c[0], c[1] * 0.86, c[2] * 0.62] : c;
}
// push a colour away from grey so a light keeps its hue through the grade
function saturate(c, k) {
  const g = (c[0] + c[1] + c[2]) / 3;
  return [clamp(g + (c[0] - g) * k, 0, 255), clamp(g + (c[1] - g) * k, 0, 255), clamp(g + (c[2] - g) * k, 0, 255)];
}

let bloom = [];          // screen-space light glows from the last drawLighting, re-added after the grade

const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${clamp(a, 0, 1).toFixed(3)})`;

// =====================================================================================
// the darkness model
// =====================================================================================

// daytime darkness by water depth: ~300 dim, 600+ nearly black
const DEPTH = [[0, 0], [30, 0.02], [100, 0.1], [200, 0.26], [300, 0.42], [420, 0.55], [600, 0.67], [800, 0.76], [1100, 0.85], [1400, 0.9]];
function depthDark(d) {
  if (d <= 0) return 0;
  for (let i = 1; i < DEPTH.length; i++) {
    if (d <= DEPTH[i][0]) {
      const [d0, a0] = DEPTH[i - 1], [d1, a1] = DEPTH[i];
      const t = (d - d0) / (d1 - d0);
      return a0 + (a1 - a0) * t * t * (3 - 2 * t);
    }
  }
  return DEPTH[DEPTH.length - 1][1];
}

function weatherStorm(G) {
  if (G.sea && G.sea.storm != null) return G.sea.storm;
  const k = G.weather && G.weather.kind;
  return k === 'storm' ? 1 : k === 'rain' ? 0.45 : k === 'cloudy' ? 0.15 : 0;
}

function factors(G, cel) {
  const light = G.light == null ? 1 : G.light;
  const W = G.weather || {};
  const nf = clamp((1 - light) / 0.92, 0, 1);
  const storm = weatherStorm(G);
  const fog = clamp(W.fog || 0, 0, 1);
  const flash = clamp(W.lightning || 0, 0, 1);
  // The sky module already paints its own night/dusk colours; keep this pass light above the horizon
  // so sunrise and dusk stay warm instead of turning grey-purple.
  const sky = clamp(Math.pow(nf, 1.6) * 0.38 + storm * 0.26 * (1 - nf * 0.5) + fog * 0.06, 0, 0.7);
  const seaNight = clamp(nf * 0.76 + storm * 0.34 + fog * 0.05, 0, 0.92);
  // Deep night (not dawn or dusk, whose painted skies are already bright and warm while
  // G.light is still low): judged from the painted zenith when the sky reports it.
  let skyNight = smoothstep(0.85, 1, nf);
  const z = cel && cel.zenith;
  if (Array.isArray(z) && isFinite(z[0])) skyNight = 1 - smoothstep(20, 50, z[0] * 0.3 + z[1] * 0.59 + z[2] * 0.11);
  const deepN = smoothstep(0.8, 1, nf) * skyNight;
  return { nf, storm, fog, flash, sky, seaNight, deepN, keep: 1 - 0.85 * flash, light };
}

// Air darkness at world height wy. At deep night the air around the boy closes in (~0.7 from
// the horizon up to about y = -230) while the high sky stays open (<= 0.25) so moonlit
// clouds keep their colour; the raft's lights then make a warm island in the dark.
const NIGHT_LOW = 0.7, NIGHT_HIGH = 0.24;
function skyA(F, wy) {
  const base = F.sky * (0.5 + 0.5 * smoothstep(-430, -50, wy));
  if (F.deepN <= 0.001) return base * F.keep;
  const band = F.deepN * (NIGHT_HIGH + (NIGHT_LOW - NIGHT_HIGH) * smoothstep(-325, -228, wy));
  return Math.max(base, band) * F.keep;
}
function seaA(F, wy) {
  const dd = depthDark(wy) * (1 + F.storm * 0.12);
  return clamp(1 - (1 - Math.min(0.97, dd)) * (1 - F.seaNight), 0, 0.975) * F.keep;
}
function darkAt(G, F, wx, wy) {
  let surf = 0;
  try { surf = waterTop(G, wx); } catch (e) { surf = 0; }
  return wy < surf ? skyA(F, wy) : seaA(F, wy);
}

function skyColor(F) { return mixColor([5, 8, 22], [9, 11, 15], F.storm * 0.6); }
function seaColor(F) { return mixColor([0, 8, 15], [1, 3, 11], F.nf); }

// =====================================================================================
// lighting (screen space)
// =====================================================================================

export function drawLighting(ctx, G) {
  const v = G.view;
  if (!(v.cssW > 2) || !ensureArt()) return;
  if (!buf || Math.abs(buf.width - Math.ceil(v.cssW * (v.cssW * v.cssH > 1.6e6 ? BUF_SCALE * 0.75 : BUF_SCALE))) > 1) resize(G);
  if (!buf) return;
  let cel = null;
  try { cel = celestial(G); } catch (e) { cel = null; }
  const F = factors(G, cel);
  const W = v.cssW, H = v.cssH, sc = v.scale, cx = W / 2, cy = H / 2;
  const camX = G.cam.x + (G.cam.shakeX || 0), camY = G.cam.y + (G.cam.shakeY || 0);
  const wyOf = (sy) => camY + (sy - cy) / sc;
  const syOf = (wy) => cy + (wy - camY) * sc;
  const sxOf = (wx) => cx + (wx - camX) * sc;

  bloom.length = 0;
  // nothing to darken? (noon with the camera high above the water)
  const maxDark = Math.max(skyA(F, wyOf(H)), wyOf(H) > -12 ? seaA(F, Math.max(0, wyOf(H))) : 0);
  if (maxDark < 0.008) return;

  const q = buf.width / W;
  const b = bctx;
  b.setTransform(1, 0, 0, 1, 0, 0);
  b.globalCompositeOperation = 'source-over';
  b.globalAlpha = 1;
  b.clearRect(0, 0, buf.width, buf.height);
  b.setTransform(q, 0, 0, q, 0, 0);

  // ---- sky / air darkness (full screen)
  const N = 16;
  const sCol = skyColor(F), wCol = seaColor(F);
  const gs = b.createLinearGradient(0, 0, 0, H);
  for (let k = 0; k <= N; k++) gs.addColorStop(k / N, rgba(sCol, skyA(F, Math.min(-1, wyOf((k / N) * H)))));
  b.fillStyle = gs;
  b.fillRect(0, 0, W, H);

  // ---- water darkness, below the wave line, topped up from the sky value
  const sy0 = syOf(0);
  if (sy0 - 30 < H) {
    const top = Math.max(-40, sy0 - 30);
    const gw = b.createLinearGradient(0, top, 0, H);
    const horizon = skyA(F, -1);
    for (let k = 0; k <= N; k++) {
      const sy = top + (k / N) * (H - top);
      const wy = Math.max(0, wyOf(sy));
      const a = seaA(F, wy);
      const bb = horizon >= 0.999 ? 0 : clamp((a - horizon) / (1 - horizon), 0, 1);
      gw.addColorStop(k / N, rgba(wCol, bb));
    }
    b.fillStyle = gw;
    b.beginPath();
    const step = 14;
    let first = true;
    for (let sx = -step; sx <= W + step; sx += step) {
      const wx = camX + (sx - cx) / sc;
      let wy = 0;
      try { wy = waterTop(G, wx); } catch (e) { wy = 0; }
      const sy = syOf(wy);
      if (first) { b.moveTo(sx, sy); first = false; } else b.lineTo(sx, sy);
    }
    b.lineTo(W + step, H + 4); b.lineTo(-step, H + 4); b.closePath();
    b.fill();
  }

  // ---- carve the light pools
  b.globalCompositeOperation = 'destination-out';
  const lights = G.lights || [];
  const drawn = [];
  for (let i = 0; i < lights.length && drawn.length < 96; i++) {
    const l = lights[i];
    if (!l || !isFinite(l.x) || !isFinite(l.y) || !(l.r > 0)) continue;
    const r = l.r * sc, x = sxOf(l.x), y = syOf(l.y);
    if (x + r < 0 || x - r > W || y + r < 0 || y - r > H) continue;
    const a = clamp(l.a == null ? 1 : l.a, 0, 1);
    if (a <= 0.01) continue;
    b.globalAlpha = a;
    b.drawImage(ART.hole, x - r, y - r, r * 2, r * 2);
    drawn.push(l);
  }
  // the moon keeps its glow; the setting sun too
  if (cel) {
    if (cel.moonVisible && isFinite(cel.moonX) && isFinite(cel.moonY) && F.sky > 0.05) {
      const r = Math.min(W, H) * 0.16;
      b.globalAlpha = 0.85;
      b.drawImage(ART.hole, cel.moonX - r, cel.moonY - r, r * 2, r * 2);
      // a wider, faint moonlit zone: the clouds near the moon keep their colour
      if (F.deepN > 0.05) {
        const r2 = Math.min(W, H) * 0.32;
        b.globalAlpha = 0.4 * F.deepN * clamp(cel.moonAlpha == null ? 1 : cel.moonAlpha, 0, 1);
        b.drawImage(ART.hole, cel.moonX - r2, cel.moonY - r2, r2 * 2, r2 * 2);
      }
      // the moon's path on the far sea stays silver
      if (sy0 > -20 && sy0 < H + 20) {
        const rw = 150, rh = 16;
        b.globalAlpha = 0.6 * F.nf;
        b.drawImage(ART.hole, cel.moonX - rw, sy0 - 6 - rh, rw * 2, rh * 2);
      }
    }
    if (cel.sunVisible && isFinite(cel.sunX) && isFinite(cel.sunY) && F.sky > 0.05) {
      const r = Math.min(W, H) * 0.24;
      b.globalAlpha = 0.7;
      b.drawImage(ART.hole, cel.sunX - r, cel.sunY - r, r * 2, r * 2);
    }
  }
  // the boy is never swallowed completely
  const P = G.player;
  if (P && isFinite(P.x) && isFinite(P.y) && G.mode !== 'title') {
    const x = sxOf(P.x), y = syOf(P.y - 14);
    const r1 = 30 * sc, r2 = 78 * sc;
    b.globalAlpha = 0.22;
    b.drawImage(ART.hole, x - r2, y - r2, r2 * 2, r2 * 2);
    b.globalAlpha = 0.5;
    b.drawImage(ART.hole, x - r1, y - r1, r1 * 2, r1 * 2);
  }
  b.globalAlpha = 1;
  b.globalCompositeOperation = 'source-over';

  // ---- night: cool the whole scene first (lights added afterwards stay warm)
  ctx.save();
  if (F.nf > 0.02) {
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = F.nf * F.keep;
    ctx.fillStyle = 'rgb(176,192,236)';
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  // ---- lay the darkness over the scene
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(buf, 0, 0, buf.width, buf.height, 0, 0, W, H);

  // ---- moon shafts and the moon's path on the sea
  try { drawNightOverlay(ctx, G); } catch (e) { /* sea not ready */ }

  // ---- the lights themselves: tint the pool with the light's colour, then glow
  const glows = [];
  for (const l of drawn) {
    const local = darkAt(G, F, l.x, l.y);
    const k = clamp((l.a == null ? 1 : l.a), 0, 1) * (0.1 + 0.9 * local);
    if (k < 0.02) continue;
    glows.push([l, k]);
  }
  if (glows.length) {
    // inside a pool the light's own colour wins over the ambient water tint:
    // drain the ambient colour, then multiply by the light's colour
    ctx.globalCompositeOperation = FX.low ? 'source-over' : 'saturation';
    for (const [l, k] of glows) {
      if (FX.low) break;
      const r = l.r * sc * 0.85, x = sxOf(l.x), y = syOf(l.y);
      ctx.globalAlpha = clamp(k * 0.7, 0, 1);
      ctx.drawImage(tinted(ART.glow, [128, 128, 128]), x - r, y - r, r * 2, r * 2);
    }
    ctx.globalCompositeOperation = 'multiply';
    for (const [l, k] of glows) {
      const col = Array.isArray(l.color) ? l.color : [255, 200, 130];
      const r = l.r * sc * 0.9, x = sxOf(l.x), y = syOf(l.y);
      ctx.globalAlpha = clamp(k * 0.75, 0, 1);
      ctx.drawImage(tinted(ART.glow, saturate(warm(col), 1.3)), x - r, y - r, r * 2, r * 2);
    }
    ctx.globalCompositeOperation = 'lighter';
    for (const [l, k] of glows) {
      const col = saturate(warm(Array.isArray(l.color) ? l.color : [255, 200, 130]), 1.35);
      const x = sxOf(l.x), y = syOf(l.y);
      if (bloom.length < 24) bloom.push({ x, y, r: l.r * sc, col, k });
      const under = l.y > 4;
      const r = l.r * sc * (under ? 1.0 : 0.85);
      ctx.globalAlpha = clamp(k * (under ? 0.34 : 0.3), 0, 1);
      ctx.drawImage(tinted(ART.glow, col), x - r, y - r, r * 2, r * 2);
      if (under) {   // light scattering in the water column
        const rs = r * 1.7;
        ctx.globalAlpha = clamp(k * 0.1, 0, 1);
        ctx.drawImage(tinted(ART.glow, col), x - rs, y - rs, rs * 2, rs * 2);
      }
      const rc = Math.max(4, Math.min(l.r * 0.2, 9) * sc);   // small hot core so a held lantern doesn't swallow the boy
      ctx.globalAlpha = clamp(k * 0.4, 0, 1);
      ctx.drawImage(tinted(ART.core, mixColor(col, [255, 255, 255], 0.4)), x - rc, y - rc, rc * 2, rc * 2);
    }
  }
  ctx.restore();
}

// =====================================================================================
// post (screen space)
// =====================================================================================

export function drawPost(ctx, G) {
  const v = G.view;
  if (!(v.cssW > 2) || !ensureArt()) return;
  tick++;
  watchFrameRate();
  const low = FX.low;
  const W = v.cssW, H = v.cssH;
  let cel = null;
  try { cel = celestial(G); } catch (e) { cel = null; }
  const F = factors(G, cel);
  const ph = ((G.phase % 1) + 1) % 1;
  const camY = G.cam.y;
  const under = smoothstep(-20, 60, camY);            // camera underwater
  const deep = smoothstep(220, 700, camY);
  const dusk = Math.max(bell(ph, 0.565, 0.055), bell(ph, 0.995, 0.05) * 0.7, bell(ph, 0.03, 0.045) * 0.8);
  const day = clamp(1 - F.nf - dusk * 0.6, 0, 1);
  const t = G.time;

  ctx.save();

  // ---- colour grade
  // desaturate: a touch by day, more at night, in storms and in the deep
  const dead = G.mode === 'dead' ? 1 : 0;           // the world drains of colour
  const desat = clamp(0.1 * day + 0.14 * F.nf + 0.28 * F.storm + 0.14 * deep + 0.06 * under + 0.6 * dead, 0, 0.75);
  if (desat > 0.01 && (!low || dead)) {
    ctx.globalCompositeOperation = 'saturation';
    ctx.globalAlpha = desat;
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, W, H);
  }
  // tint (one soft-light pass): warm film by day, rose-gold and lilac at dusk,
  // cold blue at night, teal under water, pewter in storms
  const tints = [
    [[255, 232, 200], 0.14 * day * (1 - under)],
    [[255, 140, 104], 0.34 * dusk * (1 - under * 0.6)],
    [[58, 92, 168], 0.2 * F.nf],
    [[24, 140, 150], 0.26 * under * (1 - F.nf * 0.5)],
    [[120, 128, 136], 0.25 * F.storm],
  ];
  let ta = 0;
  const tc = [0, 0, 0];
  for (const [c, a] of tints) { if (a <= 0) continue; ta += a; tc[0] += c[0] * a; tc[1] += c[1] * a; tc[2] += c[2] * a; }
  if (ta > 0.01) {
    ctx.globalCompositeOperation = 'soft-light';
    ctx.globalAlpha = clamp(ta, 0, 0.6);
    ctx.fillStyle = `rgb(${(tc[0] / ta) | 0},${(tc[1] / ta) | 0},${(tc[2] / ta) | 0})`;
    ctx.fillRect(0, 0, W, H);
  }

  // ---- the lights bloom back through the grade so warm pools stay warm
  if (bloom.length) {
    ctx.globalCompositeOperation = 'lighter';
    for (const b of bloom) {
      const r = b.r * 0.7;
      ctx.globalAlpha = clamp(b.k * 0.16, 0, 1);
      ctx.drawImage(tinted(ART.glow, b.col), b.x - r, b.y - r, r * 2, r * 2);
    }
  }

  // ---- dust motes in the light (above water) / drifting specks (under water by day)
  if (!low) drawMotes(ctx, G, W, H, F, day, dusk, under, deep, t);

  // ---- vignette (opened up around the sun and the moon, which stay the brightest things)
  ctx.globalCompositeOperation = 'source-over';
  const P = G.player;
  const ox = P && isFinite(P.oxygen) ? P.oxygen : 100;
  const tunnel = G.mode === 'play' || G.mode === 'dead' ? smoothstep(35, 5, ox) : 0;
  const vig = 0.52 + 0.3 * F.nf + 0.25 * deep + 0.12 * F.storm + 0.08 * under + 0.3 * dead;
  const holes = celestialHoles(cel, v, F, dead);
  ctx.globalAlpha = clamp(vig, 0, 1);
  ctx.drawImage(holedVignette(0, holes, -2, -2, W + 4, H + 4), -2, -2, W + 4, H + 4);
  if (vig > 1 || tunnel > 0.01 || (F.nf > 0.5 && !low)) {
    // a second, tighter pass for the Little-Nightmares crush at night / when out of air
    const k = clamp(Math.max(vig - 1, 0) + (F.nf - 0.5) * 0.6 + tunnel * (0.8 + 0.2 * Math.sin(t * 5)), 0, 1);
    if (k > 0.01) {
      const s = 1 - 0.12 * k - 0.1 * tunnel;
      const vx = W * (1 - s) / 2, vy = H * (1 - s) / 2;
      ctx.globalAlpha = k;
      ctx.drawImage(holedVignette(1, holes, vx, vy, W * s, H * s), vx, vy, W * s, H * s);
      ctx.fillStyle = '#020308';
      // keep the frame closed outside the shrunken vignette
      const ix = W * (1 - s) / 2, iy = H * (1 - s) / 2;
      ctx.fillRect(0, 0, W, iy); ctx.fillRect(0, H - iy, W, iy);
      ctx.fillRect(0, iy, ix, H - 2 * iy); ctx.fillRect(W - ix, iy, ix, H - 2 * iy);
    }
  }

  // ---- the sun stays the brightest thing on screen: a small additive bloom over the grade
  if (cel && !dead) drawSunBloom(ctx, G, cel, F, W, H);

  // ---- film grain
  const gp = G.postFx || (G.postFx = { grain: 0, gx: 0, gy: 0 });
  if (tick % 2 === 0) {
    gp.grain = (gp.grain + 1 + ((Math.random() * 2) | 0)) % ART.grain.length;
    gp.gx = Math.random() * 256; gp.gy = Math.random() * 256;
  }
  const grainA = 0.075 + 0.06 * F.nf + 0.04 * deep + 0.03 * F.storm;
  ctx.globalCompositeOperation = low ? 'source-over' : 'overlay';
  ctx.globalAlpha = low ? grainA * 0.35 : grainA;
  const tile = ART.grain[gp.grain], ts = 256 * 1.15;
  for (let y = -gp.gy * 1.15; y < H; y += ts) {
    for (let x = -gp.gx * 1.15; x < W; x += ts) ctx.drawImage(tile, x, y, ts, ts);
  }
  // occasional faint gate flicker at night
  if (F.nf > 0.3) {
    const fl = hash1(tick >> 1, 7);
    if (fl > 0.8) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = (fl - 0.8) * 0.12 * F.nf;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
    }
  }

  // ---- cutscene fade
  const fade = clamp(G.fade || 0, 0, 1);
  if (fade > 0.001) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = fade;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
  }
  ctx.restore();
}

// Where the vignette must not darken the sky's own lights.
function celestialHoles(cel, v, F, dead) {
  const holes = [];
  if (!cel || dead) return holes;
  const sea = v.seaScreenY;
  if (cel.sunVisible && isFinite(cel.sunX) && isFinite(cel.sunY) && cel.sunY < sea + 4) {
    const a = clamp((cel.sunAlpha == null ? 1 : cel.sunAlpha) * (1 - 0.7 * (cel.sunCover || 0)), 0, 1);
    if (a > 0.02) holes.push({ x: cel.sunX, y: cel.sunY, r: Math.max(40, (cel.sunR || 16) * 7), a: a * 0.9 });
  }
  if (cel.moonVisible && isFinite(cel.moonX) && isFinite(cel.moonY) && cel.moonY < sea + 4 && F.nf > 0.3) {
    const a = clamp((cel.moonAlpha == null ? 1 : cel.moonAlpha) * (1 - 0.6 * (cel.moonCover || 0)) * smoothstep(0.3, 0.7, F.nf), 0, 1);
    if (a > 0.02) holes.push({ x: cel.moonX, y: cel.moonY, r: Math.max(40, (cel.moonR || 29) * 4.2), a: a * 0.85 });
  }
  return holes;
}

// The vignette sprite with soft holes punched at the given screen points. `rx..rh` is the
// screen rect the sprite will be stretched over. Two slots for the two vignette passes.
const VH = [null, null];
function holedVignette(slot, holes, rx, ry, rw, rh) {
  if (!holes.length) return ART.vignette;
  const S = ART.vignette.width;
  let e = VH[slot];
  if (!e) { const c = makeCanvas(S, S); e = VH[slot] = { c, g: c.getContext('2d') }; }
  const g = e.g;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'copy';
  g.drawImage(ART.vignette, 0, 0);
  g.globalCompositeOperation = 'destination-out';
  for (const h of holes) {
    g.setTransform(h.r * S / rw, 0, 0, h.r * S / rh, (h.x - rx) * S / rw, (h.y - ry) * S / rh);
    const gr = g.createRadialGradient(0, 0, 0, 0, 0, 1);
    gr.addColorStop(0, `rgba(0,0,0,${h.a.toFixed(3)})`);
    gr.addColorStop(0.4, `rgba(0,0,0,${(h.a * 0.7).toFixed(3)})`);
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(-1, -1, 2, 2);
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'source-over';
  return e.c;
}

// Additive bloom on the sun after the grade and the vignette: a hot core that clips toward
// white (warm when the sun is low) and a soft glow. Hidden by cloud cover, and never below
// the horizon or seen through the water.
function drawSunBloom(ctx, G, cel, F, W, H) {
  if (!cel.sunVisible || !isFinite(cel.sunX) || !isFinite(cel.sunY)) return;
  const sea = G.view.seaScreenY;
  if (!(sea > 0)) return;
  const k = clamp((cel.sunAlpha == null ? 1 : cel.sunAlpha) * (1 - (cel.sunCover || 0)) * (1 - 0.7 * F.storm), 0, 1);
  if (k < 0.02) return;
  const x = cel.sunX, y = cel.sunY, r = cel.sunR || 16;
  if (x < -r * 8 || x > W + r * 8 || y < -r * 8) return;
  const sc = Array.isArray(cel.sunColor) ? cel.sunColor : [255, 240, 220];
  const hiE = smoothstep(0.05, 0.4, cel.sunE == null ? 0.5 : cel.sunE);   // 1 = high (white) sun
  const core = mixColor(sc, [255, 255, 255], 0.15 + 0.7 * hiE);
  const coreA = 0.3 + 0.55 * hiE;                       // a low sun stays golden, not white
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, Math.min(H, sea));
  ctx.clip();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 1;
  const R = r * 7;
  let g = ctx.createRadialGradient(x, y, r * 0.6, x, y, R);
  g.addColorStop(0, rgba(sc, 0.3 * k));
  g.addColorStop(0.2, rgba(sc, 0.1 * k));
  g.addColorStop(1, rgba(sc, 0));
  ctx.fillStyle = g;
  ctx.fillRect(x - R, y - R, R * 2, R * 2);
  const rc = r * 1.2;
  g = ctx.createRadialGradient(x, y, 0, x, y, rc);
  g.addColorStop(0, rgba(core, coreA * k));
  g.addColorStop(0.55, rgba(core, coreA * 0.82 * k));
  g.addColorStop(0.8, rgba(core, coreA * 0.35 * k));
  g.addColorStop(1, rgba(core, 0));
  ctx.fillStyle = g;
  ctx.fillRect(x - rc, y - rc, rc * 2, rc * 2);
  ctx.restore();
}

function bell(x, c, w) {
  let d = Math.abs(x - c);
  d = Math.min(d, 1 - d);
  return d >= w ? 0 : 0.5 + 0.5 * Math.cos((d / w) * Math.PI);
}

function drawMotes(ctx, G, W, H, F, day, dusk, under, deep, t) {
  const above = 1 - under;
  const aAbove = (0.5 * day + 0.8 * dusk) * above * (1 - F.storm);
  const aUnder = 0.6 * day * under * (1 - deep);
  const a = Math.max(aAbove, aUnder);
  if (a < 0.02) return;
  const col = under > 0.5 ? [196, 236, 230] : dusk > 0.3 ? [255, 206, 160] : [255, 242, 214];
  const img = tinted(ART.glow, col);
  const sc = G.view.scale;
  const camX = G.cam.x, camY = G.cam.y;
  ctx.globalCompositeOperation = 'lighter';
  const n = 22, span = W + 240, vspan = H + 200;
  for (let i = 0; i < n; i++) {
    const h1 = hash1(i, 81), h2 = hash1(i, 82), h3 = hash1(i, 83), h4 = hash1(i, 84);
    const par = 0.25 + h3 * 0.9;   // depth of field: bigger ones move more
    const x = ((h1 * span + t * (3 + h2 * 6) - camX * sc * par * 0.6) % span + span) % span - 120;
    const y = ((h2 * vspan - t * (1.5 + h4 * 3) * (under > 0.5 ? -1 : 1) - camY * sc * par * 0.6) % vspan + vspan) % vspan - 100;
    const r = 1.2 + h3 * h3 * 7;
    const tw = 0.55 + 0.45 * Math.sin(t * (0.4 + h4) + h1 * 30);
    ctx.globalAlpha = clamp(a * tw * (0.05 + 0.1 * (1 - h3)), 0, 1);
    ctx.drawImage(img, x - r, y - r, r * 2, r * 2);
  }
}
