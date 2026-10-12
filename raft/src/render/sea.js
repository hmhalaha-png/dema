// 少年与海 — the sea.
//
// waterY / seabedY are the physical sea that every module queries. The draw functions
// paint the ocean as an aquarium cross-section:
//   drawBackdrop (screen) — far sea band at the horizon with the sun/moon path, the water
//                           body gradient, fogged parallax silhouettes far below (pillars,
//                           ruins, a stone head, a sunken ship, kelp forests, a leviathan
//                           skeleton) and slow god rays / moon shafts.
//   drawSeabed   (world)  — terrain with rock texture and sediment, kelp, grass, coral,
//                           anemones, wrecks, an anchor chain rising into the dark, a giant
//                           diving helmet, giant bones, black smokers.
//   drawSurface  (world)  — translucent water over everything below the waterline,
//                           caustics, marine snow, the surface line, foam, glints, rain.

import { TAU, clamp, lerp, smoothstep, hash1, noise1, fbm1, seeded, mixColor, makeCanvas } from '../core/util.js';
import { emit } from '../core/particles.js';
import { C } from '../core/state.js';
import { celestial } from './sky.js';
import * as islands from '../systems/islands.js';

// Render quality shared with post.js. post.drawPost watches the real frame interval and
// sets FX.low when the machine cannot keep up; both modules then skip optional passes.
export const FX = { low: false };

// =====================================================================================
// waves
// =====================================================================================

const BASE_AMP = 2.8;           // calm wave amplitude (world units)

const waveMul = (G) => { const w = G.weather && G.weather.wave; return w > 0 ? w : 1; };

function stormTarget(G) {
  const W = G.weather || {};
  const k = W.kind;
  let s = k === 'storm' ? 1 : k === 'rain' ? 0.45 : k === 'cloudy' ? 0.15 : k === 'fog' ? 0.1 : 0;
  s = Math.max(s, clamp((waveMul(G) - 1) / 2.6, 0, 1), clamp(W.rain || 0, 0, 1) * 0.5);
  return s;
}

// Surface height at x (world y; negative = up). Called thousands of times per frame.
export function waterY(G, x) {
  const S = G.sea;
  const a = S ? S.amp : BASE_AMP * waveMul(G);
  const sh = S ? S.sharp : 0;
  const ch = S ? S.chop : 0;
  const t = G.time;
  const c1 = Math.cos(x * 0.0205 - t * 1.05);
  return -a * (0.5 * c1 + sh * (c1 * c1 - 0.5)
    + 0.28 * Math.sin(x * 0.0447 - t * 1.62 + 1.3)
    + 0.22 * Math.sin(x * 0.0093 - t * 0.57 + 4.1))
    - ch * Math.sin(x * 0.071 - t * 2.35 + 2.2)
    - 0.32 * Math.sin(x * 0.113 - t * 2.9 + 0.7);
}

// Sea floor (world y, 450..1400): basins, sharp ridges, terraced plateaus and trenches.
export function seabedY(G, x) {
  const b = fbm1(x * 0.00042 + 3.7, 3, 11);
  let y = 520 + b * 600;
  const rn = noise1(x * 0.0012 + 9.1, 23);
  const ridge = 1 - Math.abs(rn * 2 - 1);
  y -= ridge * ridge * ridge * 280;
  y += smoothstep(0.68, 0.88, noise1(x * 0.00052 + 1.3, 37)) * 430;
  const tw = smoothstep(0.5, 0.72, noise1(x * 0.0007 + 5.2, 41));
  if (tw > 0) {
    const k = y / 64, fl = Math.floor(k);
    y = lerp(y, (fl + smoothstep(0.3, 0.7, k - fl)) * 64, tw * 0.9);
  }
  y += (fbm1(x * 0.017, 3, 53) - 0.5) * 36 + (noise1(x * 0.085, 61) - 0.5) * 7;
  if (y < 490) y = 450 + 40 * Math.exp((y - 490) / 40);
  return y > 1400 ? 1400 : y;
}

// =====================================================================================
// state
// =====================================================================================

export function init(G) {
  G.sea = {
    amp: BASE_AMP * waveMul(G),
    sharp: 0, chop: 0,
    storm: stormTarget(G),
    chunks: new Map(),       // seabed chunk index -> items
    pal: null, palT: -1, palS: -1,
    sprayT: 0,
  };
  ensureArt();
}

function S_(G) {
  if (!G.sea) init(G);
  return G.sea;
}

// ---- islands: land that rises out of the water has no water column at all ----------

// Spans [x0, x1] of islands overlapping the view, refreshed once per frame/step.
function islandSpans(G) {
  const S = S_(G), v = G.view;
  const key = G.time + v.left * 1e-3 + v.w * 1e-7;
  if (S.spanKey === key) return S.spans;
  S.spanKey = key;
  const spans = S.spans || (S.spans = []);
  spans.length = 0;
  try {
    const a = v.left - 200, b = v.left + v.w + 200;
    for (let x = a; x <= b; x += 70) {
      const isl = islands.islandAt(G, x);
      if (!isl || !isFinite(isl.x0) || !isFinite(isl.x1)) continue;
      if (!spans.some((sp) => sp[0] === isl.x0 && sp[1] === isl.x1)) spans.push([isl.x0, isl.x1]);
      if (isl.x1 > x) x = Math.max(x, isl.x1 - 70);
    }
  } catch (e) { spans.length = 0; }
  return spans;
}

// Island ground at x, or null where there is open sea.
function islandGround(G, x, spans) {
  for (let i = 0; i < spans.length; i++) {
    if (x >= spans[i][0] && x <= spans[i][1]) {
      try {
        const g = islands.groundAt(G, x);
        return g == null || !isFinite(g) ? null : g;
      } catch (e) { return null; }
    }
  }
  return null;
}

// Where "water" darkness begins in a column (used by post.drawLighting): the wavy surface
// over open sea, but a little under the land surface where an island rises above the
// water, so the lighting never slices horizontally through an island. Continuous at the
// shoreline.
export function waterTop(G, x) {
  const w = waterY(G, x);
  const spans = islandSpans(G);
  if (!spans.length) return w;
  const g = islandGround(G, x, spans);
  if (g == null || g >= w) return w;
  return g + 26 * smoothstep(0, 30, w - g);
}

export function update(G, dt) {
  const S = S_(G);
  const target = BASE_AMP * waveMul(G);
  const d = target - S.amp;
  S.amp += clamp(d, -dt * 2.2, dt * 2.2);
  S.sharp = clamp((S.amp - 4) / 10, 0, 0.32);
  S.chop = clamp((S.amp - 3.5) / 6, 0, 1) * S.amp * 0.3;   // short steep chop in rough weather
  S.storm += (stormTarget(G) - S.storm) * Math.min(1, dt * 0.6);
  const v = G.view;
  if (!(v && v.w > 1)) return;

  // wind-torn spray off the crests in rough weather
  if (S.amp > 5.5) {
    S.sprayT += dt * (S.amp - 5) * 7;
    const wind = (G.weather && G.weather.wind) || 0.5;
    let guard = 0;
    while (S.sprayT > 1 && guard++ < 12) {
      S.sprayT -= 1;
      const x = v.left + Math.random() * v.w;
      const y = waterY(G, x);
      if (y > -S.amp * 0.45) continue;
      for (let k = 0; k < 3; k++) {
        emit(G, {
          x: x + (Math.random() - 0.5) * 6, y: y - 1,
          vx: 30 + wind * 70 + Math.random() * 40, vy: -20 - Math.random() * 45,
          life: 0.6 + Math.random() * 0.6, size: 0.9 + Math.random() * 1.2,
          color: [226, 236, 238], alpha: 0.55, gravity: 140, drag: 0.6, kind: 'dot', water: 'above',
        });
      }
    }
  }

  // seabed life near the camera: vent bubbles, bioluminescent glows at night / in the deep
  const bottom = v.top + v.h;
  if (bottom < 330) return;
  const night = nightness(G);
  const c0 = Math.floor((v.left - 60) / CH), c1 = Math.floor((v.left + v.w + 60) / CH);
  const spans = islandSpans(G);
  let lights = 0;
  for (let ci = c0; ci <= c1; ci++) {
    const items = chunkItems(G, ci);
    for (const it of items) {
      if ((it.type === 'vent' || it.glow) && spans.length) {
        const g = islandGround(G, it.x, spans);
        if (g != null && g < it.y - 12) continue;      // buried inside an island
      }
      if (it.type === 'vent') {
        if (it.y - 70 > bottom + 40 || it.y < v.top - 40) continue;
        if (lights < 10) {
          G.lights.push({ x: it.x, y: it.y - it.h + 6, r: 46 * it.s, color: [255, 120, 60], a: 0.3 + 0.08 * Math.sin(G.time * 2.3 + it.ph * 9) });
          lights++;
        }
        if (Math.random() < dt * 3.2) {
          emit(G, {
            x: it.x + (Math.random() - 0.5) * 4, y: it.y - it.h + 2,
            vx: (Math.random() - 0.5) * 6, vy: -18 - Math.random() * 16,
            life: 3 + Math.random() * 3, size: 0.8 + Math.random() * 1.6,
            color: [190, 225, 235], alpha: 0.55, kind: 'bubble', water: 'below',
          });
        }
      } else if (it.glow && lights < 10) {
        const dark = Math.max(night, smoothstep(350, 700, it.y));
        if (dark < 0.35) continue;
        if (it.y < v.top - 30 || it.y - 30 > bottom + 30) continue;
        const pulse = 0.75 + 0.25 * Math.sin(G.time * 1.3 + it.ph * 6);
        G.lights.push({ x: it.x, y: it.y - 8 * it.s, r: 34 + 14 * it.s, color: it.glow, a: 0.32 * dark * pulse });
        lights++;
      }
    }
  }
}

// =====================================================================================
// palette (time of day + weather)
// =====================================================================================

const PAL = {
  dawn: { surf: [58, 76, 106], mid: [26, 42, 72], deep: [9, 16, 32], abyss: [2, 5, 12], haze: [232, 168, 156], band: [112, 104, 132], line: [255, 216, 204], glint: [255, 210, 182], ray: [255, 196, 172], rayA: 0.05, sil: [6, 10, 26], tint: [44, 60, 98], foam: [238, 226, 232], snow: [210, 200, 220] },
  morn: { surf: [82, 138, 150], mid: [30, 86, 108], deep: [9, 32, 50], abyss: [3, 10, 18], haze: [246, 218, 184], band: [128, 154, 158], line: [255, 242, 220], glint: [255, 236, 200], ray: [255, 236, 204], rayA: 0.18, sil: [4, 20, 32], tint: [40, 108, 122], foam: [242, 242, 236], snow: [214, 232, 226] },
  day: { surf: [66, 142, 152], mid: [22, 88, 108], deep: [7, 31, 47], abyss: [2, 9, 16], haze: [212, 226, 216], band: [104, 160, 166], line: [236, 252, 246], glint: [255, 253, 236], ray: [218, 252, 238], rayA: 0.22, sil: [3, 22, 34], tint: [26, 112, 128], foam: [246, 252, 250], snow: [214, 238, 232] },
  gold: { surf: [116, 100, 106], mid: [30, 38, 74], deep: [9, 16, 36], abyss: [3, 7, 16], haze: [252, 214, 164], band: [208, 172, 150], line: [255, 236, 204], glint: [255, 226, 168], ray: [255, 220, 178], rayA: 0.17, sil: [8, 12, 30], tint: [84, 90, 126], foam: [252, 242, 226], snow: [230, 226, 206] },
  dusk: { surf: [124, 72, 94], mid: [44, 28, 62], deep: [14, 10, 28], abyss: [5, 4, 12], haze: [246, 172, 144], band: [166, 104, 120], line: [255, 204, 180], glint: [255, 196, 156], ray: [255, 176, 164], rayA: 0.06, sil: [14, 8, 24], tint: [88, 52, 86], foam: [252, 222, 216], snow: [222, 190, 206] },
  night: { surf: [17, 31, 58], mid: [8, 17, 37], deep: [3, 7, 17], abyss: [1, 2, 7], haze: [42, 56, 96], band: [24, 38, 70], line: [152, 182, 228], glint: [210, 226, 255], ray: [164, 194, 244], rayA: 0.04, sil: [1, 3, 10], tint: [12, 26, 58], foam: [172, 192, 222], snow: [150, 180, 220] },
};
const PAL_KEYS = [[0, 'dawn'], [0.07, 'morn'], [0.17, 'day'], [0.45, 'day'], [0.53, 'gold'], [0.59, 'dusk'], [0.655, 'night'], [0.93, 'night'], [1, 'dawn']];
const STORM = { surf: [38, 56, 60], mid: [16, 32, 40], deep: [5, 13, 19], abyss: [2, 5, 9], haze: [118, 128, 130], band: [52, 68, 72], line: [206, 216, 216], glint: [200, 210, 210], ray: [200, 210, 210], rayA: 0, sil: [4, 10, 14], tint: [30, 52, 58], foam: [230, 236, 236], snow: [200, 210, 210] };

function mixPal(a, b, t) {
  const o = {};
  for (const k in a) o[k] = typeof a[k] === 'number' ? lerp(a[k], b[k], t) : mixColor(a[k], b[k], t);
  return o;
}

const nightness = (G) => clamp((1 - (G.light == null ? 1 : G.light)) / 0.92, 0, 1);

function palette(G) {
  const S = S_(G);
  if (S.pal && S.palT === G.time && S.palS === S.storm) return S.pal;
  const ph = ((G.phase % 1) + 1) % 1;
  let i = 1;
  while (i < PAL_KEYS.length - 1 && ph > PAL_KEYS[i][0]) i++;
  const k0 = PAL_KEYS[i - 1], k1 = PAL_KEYS[i];
  const f = smoothstep(0, 1, (ph - k0[0]) / (k1[0] - k0[0] || 1));
  let p = mixPal(PAL[k0[1]], PAL[k1[1]], f);
  const s = S.storm;
  if (s > 0.01) {
    const lt = 0.3 + 0.7 * (G.light == null ? 1 : G.light);
    const st = {};
    for (const k in STORM) st[k] = typeof STORM[k] === 'number' ? STORM[k] : STORM[k].map((c) => c * lt);
    p = mixPal(p, st, s * 0.7);
  }
  const fog = (G.weather && G.weather.fog) || 0;
  if (fog > 0.01) {
    const fc = [170, 180, 184].map((c) => c * (0.25 + 0.75 * (G.light == null ? 1 : G.light)));
    p.haze = mixColor(p.haze, fc, fog * 0.7);
    p.band = mixColor(p.band, fc, fog * 0.5);
    // the water column greys in fog too (darker than the air: the light is scattered away)
    p.surf = mixColor(p.surf, fc.map((c) => c * 0.62), fog * 0.5);
    p.mid = mixColor(p.mid, fc.map((c) => c * 0.3), fog * 0.35);
    p.tint = mixColor(p.tint, fc.map((c) => c * 0.5), fog * 0.4);
  }
  p.day = clamp(((G.light == null ? 1 : G.light) - 0.12) / 0.88, 0, 1);
  p.night = nightness(G);
  S.pal = p; S.palT = G.time; S.palS = s;
  return p;
}

const rgb = (c) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a < 0 ? 0 : a > 1 ? 1 : a.toFixed(3)})`;

function sun(G) {
  let c = null;
  try { c = celestial(G); } catch (e) { c = null; }
  return c || {};
}

// =====================================================================================
// shared art (built once, module level; independent of G)
// =====================================================================================

let ART = null;

function ensureArt() {
  if (ART || typeof document === 'undefined') return ART;
  ART = {
    ray: makeRaySprite(),
    caustic: makeCaustics(),
    rock: makeRockTexture(),
    far: new Map(),        // far silhouette Path2D cache
    spr: new Map(),        // seabed prop sprites
    pat: new WeakMap(),    // ctx -> patterns
  };
  return ART;
}

function makeRaySprite() {
  const w = 48, h = 256, c = makeCanvas(w, h), g = c.getContext('2d');
  const img = g.createImageData(w, h), d = img.data;
  for (let y = 0; y < h; y++) {
    const ty = y / (h - 1);
    const fall = Math.pow(1 - ty, 1.6) * smoothstep(0, 0.06, ty);
    for (let x = 0; x < w; x++) {
      const tx = (x + 0.5) / w * 2 - 1;
      const prof = Math.exp(-tx * tx * 3.2);
      const i = (y * w + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = 255;
      d[i + 3] = 255 * prof * fall;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

// Tileable, domain-warped voronoi-edge caustic band, bright at the top and fading downward.
function makeCaustics() {
  const W = 256, H = 128, c = makeCanvas(W, H), g = c.getContext('2d');
  const img = g.createImageData(W, H), d = img.data;
  const GX = 7, GY = 3, cw = W / GX, chh = H / GY;
  const r = seeded(4242);
  const pts = [];
  for (let gy = 0; gy < GY; gy++) for (let gx = 0; gx < GX; gx++) pts.push([(gx + 0.1 + r() * 0.8) * cw, (gy + 0.1 + r() * 0.8) * chh]);
  const k1 = TAU / W * 2, k2 = TAU / W * 3;
  for (let y = 0; y < H; y++) {
    const fade = Math.pow(1 - y / H, 2.2) * smoothstep(0, 5, y);
    for (let x0 = 0; x0 < W; x0++) {
      // warp the lookup so the cells are wobbly, not a tiled floor
      let x = x0 + Math.sin(y * 0.11 + x0 * k1) * 7 + Math.sin(x0 * k2 + 1.7) * 4;
      const yy0 = y + Math.sin(x0 * k1 * 1.5 + 0.6) * 6;
      x = ((x % W) + W) % W;
      const gx = Math.floor(x / cw), gy = clamp(Math.floor(yy0 / chh), 0, GY - 1);
      let f1 = 1e9, f2 = 1e9;
      for (let oy = -1; oy <= 1; oy++) {
        const yy = gy + oy;
        if (yy < 0 || yy >= GY) continue;
        for (let ox = -1; ox <= 1; ox++) {
          let xx = gx + ox, shift = 0;
          if (xx < 0) { xx += GX; shift = -W; } else if (xx >= GX) { xx -= GX; shift = W; }
          const p = pts[yy * GX + xx];
          const dx = p[0] + shift - x, dy = p[1] - yy0;
          const dd = dx * dx + dy * dy;
          if (dd < f1) { f2 = f1; f1 = dd; } else if (dd < f2) f2 = dd;
        }
      }
      const e = Math.sqrt(f2) - Math.sqrt(f1);
      const lum = 0.55 + 0.45 * Math.sin(x0 * k1 * 0.5 + y * 0.05 + 2);
      const v = Math.pow(clamp(1 - e / 4.2, 0, 1), 3) * lum;
      const i = (y * W + x0) * 4;
      d[i] = 255; d[i + 1] = 255; d[i + 2] = 240;
      d[i + 3] = 255 * v * fade;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

// Tileable dark rock texture with strata and pebbles (256 px = 128 world units).
function makeRockTexture() {
  const S = 256, c = makeCanvas(S, S), g = c.getContext('2d');
  const r = seeded(777);
  g.fillStyle = '#1e272d'; g.fillRect(0, 0, S, S);
  const wrapDraw = (fn) => { for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) fn(ox, oy); };
  for (let i = 0; i < 260; i++) {
    const x = r() * S, y = r() * S, rx = 3 + r() * 26, ry = rx * (0.35 + r() * 0.4);
    const light = r() < 0.5;
    g.fillStyle = light ? `rgba(120,140,140,${0.04 + r() * 0.07})` : `rgba(0,0,0,${0.06 + r() * 0.12})`;
    wrapDraw((ox, oy) => { g.beginPath(); g.ellipse(x + ox, y + oy, rx, ry, (r() - 0.5) * 0.3, 0, TAU); g.fill(); });
  }
  // strata: wavy dark seams that tile horizontally
  for (let i = 0; i < 9; i++) {
    const y0 = r() * S, amp = 2 + r() * 6, ph = r() * TAU, k = (1 + Math.floor(r() * 3)) * TAU / S;
    g.strokeStyle = `rgba(0,0,0,${0.18 + r() * 0.18})`; g.lineWidth = 0.8 + r() * 1.6;
    for (const oy of [-S, 0, S]) {
      g.beginPath();
      for (let x = 0; x <= S; x += 4) { const y = y0 + oy + Math.sin(x * k + ph) * amp; x ? g.lineTo(x, y) : g.moveTo(x, y); }
      g.stroke();
    }
    g.strokeStyle = 'rgba(140,160,160,0.05)'; g.lineWidth = 0.8;
    for (const oy of [-S, 0, S]) {
      g.beginPath();
      for (let x = 0; x <= S; x += 4) { const y = y0 + oy - 1.5 + Math.sin(x * k + ph) * amp; x ? g.lineTo(x, y) : g.moveTo(x, y); }
      g.stroke();
    }
  }
  for (let i = 0; i < 160; i++) {
    const x = r() * S, y = r() * S, rr = 0.6 + r() * 2.2;
    wrapDraw((ox, oy) => {
      g.fillStyle = `rgba(150,160,150,${0.08 + r() * 0.12})`;
      g.beginPath(); g.arc(x + ox, y + oy, rr, 0, TAU); g.fill();
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.beginPath(); g.arc(x + ox + rr * 0.3, y + oy + rr * 0.4, rr * 0.8, 0, Math.PI); g.fill();
    });
  }
  return c;
}

function getPatterns(ctx) {
  let p = ART.pat.get(ctx);
  if (!p) {
    p = { rock: ctx.createPattern(ART.rock, 'repeat'), caustic: ctx.createPattern(ART.caustic, 'repeat-x') };
    ART.pat.set(ctx, p);
  }
  return p;
}

function setPatternTransform(pat, a, d, e, f) {
  if (pat && pat.setTransform && typeof DOMMatrix !== 'undefined') pat.setTransform(new DOMMatrix([a, 0, 0, d, e, f]));
}

// =====================================================================================
// far silhouettes (Path2D in local units; base at (0,0), growing toward -y)
// =====================================================================================

function farShape(kind, variant) {
  const key = kind + variant;
  let s = ART.far.get(key);
  if (s) return s;
  const r = seeded(variant * 9176 + kind.length * 131 + 7);
  const p = new Path2D();
  let w = 400, h = 600;
  if (kind === 'pillar') ({ w, h } = farPillar(p, r));
  else if (kind === 'arch') ({ w, h } = farArch(p, r));
  else if (kind === 'ruins') ({ w, h } = farRuins(p, r));
  else if (kind === 'head') ({ w, h } = farHead(p, r));
  else if (kind === 'skeleton') ({ w, h } = farSkeleton(p, r));
  else if (kind === 'ship') ({ w, h } = farShip(p, r));
  else ({ w, h } = farRocks(p, r));
  s = { path: p, w, h };
  ART.far.set(key, s);
  return s;
}

// Solid parts are wound clockwise (on screen) and holes counter-clockwise, so the
// default nonzero fill unions overlapping parts and still cuts the holes.
function area2(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return a;
}
function polyTo(p, pts, hole = false) {
  if ((area2(pts) > 0) === hole) pts = pts.slice().reverse();
  p.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) p.lineTo(pts[i][0], pts[i][1]);
  p.closePath();
}
function rot(pts, ang, cx, cy) {
  const c = Math.cos(ang), s = Math.sin(ang);
  return pts.map(([x, y]) => [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c]);
}
function rectPts(x, y, w, h) { return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]; }
function ellipsePts(cx, cy, rx, ry, rotA = 0, n = 20) {
  const c = Math.cos(rotA), s = Math.sin(rotA), pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU, x = Math.cos(a) * rx, y = Math.sin(a) * ry;
    pts.push([cx + x * c - y * s, cy + x * s + y * c]);
  }
  return pts;
}

function farPillar(p, r) {
  const H = 650 + r() * 650, W = 110 + r() * 150;
  const n = 30, L = [], R = [];
  const lean = (r() - 0.5) * 0.5 * W, k1 = r() * 20, k2 = r() * 20, k3 = r() * 20;
  for (let i = 0; i <= n; i++) {
    const t = i / n, y = -H * t;
    const flare = 1 + Math.pow(1 - t, 5) * 1.6;
    const base = W * 0.5 * flare * (1 - t * 0.3);
    const c = lean * t * t + Math.sin(t * 4 + k1) * W * 0.08;
    const lL = noise1(t * 11 + k2, 5) > 0.7 ? W * (0.1 + r() * 0.2) : 0;
    const lR = noise1(t * 11 + k3, 6) > 0.7 ? W * (0.1 + r() * 0.2) : 0;
    L.push([c - base * (0.78 + 0.4 * noise1(t * 7 + k2, 3)) - lL, y]);
    R.push([c + base * (0.78 + 0.4 * noise1(t * 7 + k3, 4)) + lR, y]);
  }
  const top = [];
  const tL = L[n], tR = R[n];
  for (let i = 1; i < 6; i++) {
    const f = i / 6;
    top.push([lerp(tL[0], tR[0], f), tL[1] - (r() * 0.5 + 0.1) * W * Math.sin(f * Math.PI)]);
  }
  polyTo(p, [...L, ...top, ...R.reverse()]);
  return { w: W * 3, h: H };
}

function farArch(p, r) {
  const span = 520 + r() * 300, H = 520 + r() * 260, leg = 110 + r() * 60;
  const outer = [], inner = [];
  const n = 26;
  for (let i = 0; i <= n; i++) {
    const t = i / n, a = Math.PI * (1 - t);
    const jit = 1 + (noise1(t * 9 + 3, 7) - 0.5) * 0.18;
    outer.push([span / 2 + Math.cos(a) * (span / 2 + leg) * jit, -Math.sin(a) * H * jit]);
  }
  for (let i = 0; i <= n; i++) {
    const t = i / n, a = Math.PI * t;
    const jit = 1 + (noise1(t * 7 + 11, 8) - 0.5) * 0.14;
    inner.push([span / 2 + Math.cos(a) * (span / 2 - leg * 0.15) * jit, -Math.sin(a) * (H - leg * 1.1) * jit]);
  }
  const pts = [[-leg - 40, 0], ...outer, [span + leg + 40, 0], ...inner];
  polyTo(p, pts);
  // a broken spire on top
  const sx = span * (0.3 + r() * 0.4);
  polyTo(p, [[sx - 50, -H * 0.92], [sx - 10, -H - 120 - r() * 120], [sx + 30, -H - 60], [sx + 60, -H * 0.9]]);
  return { w: span + leg * 2, h: H + 200 };
}

function farRuins(p, r) {
  const n = 4 + Math.floor(r() * 3), sp = 110 + r() * 40, colW = 34 + r() * 10;
  const W = n * sp;
  // stylobate steps
  polyTo(p, rectPts(-50, -28, W + 100, 28));
  polyTo(p, rectPts(-25, -52, W + 50, 26));
  let prevTop = null;
  for (let i = 0; i < n; i++) {
    const x = i * sp + sp / 2 - colW / 2;
    const broken = r() < 0.4;
    const ch = broken ? 120 + r() * 220 : 380 + r() * 40;
    const lean = broken ? 0 : (r() - 0.5) * 0.06;
    let col = rectPts(x, -52 - ch, colW, ch);
    if (broken) {
      col = [[x, -52], [x + colW, -52], [x + colW, -52 - ch], [x + colW * 0.7, -52 - ch - 26], [x + colW * 0.4, -52 - ch + 8], [x + colW * 0.15, -52 - ch - 18], [x, -52 - ch + 4]];
    }
    polyTo(p, rot(col, lean, x + colW / 2, -52));
    if (!broken) {
      polyTo(p, rot(rectPts(x - 12, -52 - ch - 22, colW + 24, 22), lean, x + colW / 2, -52));
      polyTo(p, rot(rectPts(x - 8, -66, colW + 16, 14), lean, x + colW / 2, -52));
      if (prevTop && r() < 0.75) {
        // architrave resting across two standing columns, slightly askew
        const y = Math.min(prevTop.y, -52 - ch - 22);
        polyTo(p, rot(rectPts(prevTop.x - 20, y - 46, x + colW + 20 - prevTop.x + 20, 46), (r() - 0.5) * 0.08, (prevTop.x + x) / 2, y));
        prevTop = null;
      } else prevTop = { x, y: -52 - ch - 22 };
    } else prevTop = null;
  }
  // a fallen drum lying in front
  polyTo(p, rot(rectPts(W * 0.55, -40, 160, colW), 0.12, W * 0.6, -20));
  return { w: W + 120, h: 520 };
}

function farHead(p, r) {
  // a colossal stone head buried to the chin, face tilted up toward the surface
  const s = 1.6 + r() * 0.5;
  const pts = [
    [-170, 0], [-190, -90], [-200, -190], [-180, -280], [-130, -350], [-60, -385], [20, -380], [80, -352],
    [112, -318], [118, -292], [128, -276], [124, -258], [140, -232], [168, -200], [152, -192], [138, -186],
    [146, -170], [138, -160], [142, -142], [128, -130], [132, -112], [110, -90], [92, -60], [70, -24], [90, 0],
  ].map(([x, y]) => [x * s, y * s]);
  polyTo(p, rot(pts, -0.35, 0, 0));
  // crack running across the skull
  const crack = [[-90, -380], [-70, -330], [-96, -280], [-60, -230]].map(([x, y]) => [x * s, y * s]);
  const cr = rot(crack, -0.35, 0, 0);
  // the crack is cut as a hole so the water shows through
  polyTo(p, [...cr.map(([x, y]) => [x + 6, y]), ...cr.slice().reverse().map(([x, y]) => [x - 6, y])], true);
  // the hollow eye, reverse winding (hole)
  const e = rot([[60 * s, -250 * s]], -0.35, 0, 0)[0];
  polyTo(p, ellipsePts(e[0], e[1], 24 * s, 11 * s, -0.35), true);
  return { w: 420 * s, h: 420 * s };
}

function farSkeleton(p, r) {
  // a leviathan skeleton half sunk in the far seabed, ribs rising like a cathedral
  const L = 2300 + r() * 500;
  const spineY = (x) => -60 - Math.sin((x / L) * Math.PI) * 160;
  const ribs = 15;
  // vertebrae
  for (let i = 0; i < 46; i++) {
    const x = (i / 45) * L, y = spineY(x), sz = 26 + Math.sin((i / 45) * Math.PI) * 30;
    polyTo(p, rot(rectPts(x - sz * 0.4, y - sz * 0.5, sz * 0.8, sz), (r() - 0.5) * 0.2, x, y));
    if (i % 2 === 0) polyTo(p, [[x - 6, y - sz * 0.4], [x + 10, y - sz * 1.5 - r() * 20], [x + 14, y - sz * 0.4]]);
  }
  // ribs: tapered crescents
  for (let i = 0; i < ribs; i++) {
    const t = (i + 0.5) / ribs, x0 = L * (0.22 + t * 0.55), y0 = spineY(x0);
    const hgt = (380 + Math.sin(t * Math.PI) * 420) * (r() < 0.2 ? 0.55 : 1);
    const reach = 120 + r() * 60, th = 22 - t * 6;
    const outer = [], inner = [];
    for (let k = 0; k <= 14; k++) {
      const u = k / 14;
      const bx = x0 - reach * Math.sin(u * Math.PI * 0.9) * 0.6 + u * u * reach * 0.8;
      const by = y0 + 10 - hgt * Math.sin(u * Math.PI * 0.55);
      const wd = th * (1 - u * 0.75);
      outer.push([bx - wd * 0.5, by]); inner.push([bx + wd * 0.5, by]);
    }
    polyTo(p, [...outer, ...inner.reverse()]);
  }
  // skull at the front end
  const sx = L + 20, sy = spineY(L) + 30;
  const skull = [[sx - 60, sy - 40], [sx + 60, sy - 140], [sx + 260, sy - 170], [sx + 470, sy - 120], [sx + 560, sy - 70],
    [sx + 540, sy - 40], [sx + 380, sy - 30], [sx + 200, sy + 10], [sx + 40, sy + 40]];
  polyTo(p, skull);
  // lower jaw with teeth, hanging open
  const jaw = [[sx + 20, sy + 30], [sx + 220, sy + 40], [sx + 480, sy + 20], [sx + 500, sy + 40], [sx + 230, sy + 80], [sx + 30, sy + 70]];
  polyTo(p, rot(jaw, 0.14, sx + 20, sy + 30));
  for (let i = 0; i < 9; i++) {
    const tx = sx + 120 + i * 44;
    polyTo(p, [[tx, sy - 30], [tx + 14, sy + 30 + r() * 20], [tx + 26, sy - 30]]);
  }
  // eye socket (hole)
  polyTo(p, ellipsePts(sx + 250, sy - 96, 44, 30, -0.15), true);
  return { w: L + 700, h: 900 };
}

function farShip(p, r) {
  const L = 760 + r() * 200;
  const hull = [[0, -40], [40, -210], [L * 0.28, -230], [L * 0.62, -220], [L * 0.86, -250], [L + 40, -300], [L + 20, -200], [L * 0.9, -80], [L * 0.7, 0], [L * 0.2, 10]];
  const tilt = -0.14 + r() * 0.08;
  polyTo(p, rot(hull, tilt, L / 2, 0));
  // stern castle
  polyTo(p, rot([[20, -200], [30, -330], [L * 0.22, -330], [L * 0.24, -220]], tilt, L / 2, 0));
  // broken masts and a hanging yard
  const m1 = rot([[L * 0.35, -220], [L * 0.35 + 18, -220], [L * 0.33 + 18, -760], [L * 0.33, -790]], tilt + 0.1, L * 0.35, -220);
  polyTo(p, m1);
  const m2 = rot([[L * 0.68, -230], [L * 0.68 + 16, -230], [L * 0.7 + 16, -520], [L * 0.69, -560], [L * 0.7 - 6, -500]], tilt + 0.32, L * 0.68, -230);
  polyTo(p, m2);
  polyTo(p, rot(rectPts(L * 0.18, -640, L * 0.32, 12), tilt + 0.5, L * 0.34, -640));
  // gun ports (holes)
  for (let i = 0; i < 6; i++) {
    const c = rot([[L * (0.2 + i * 0.11), -150]], tilt, L / 2, 0)[0];
    polyTo(p, ellipsePts(c[0], c[1], 14, 12, 0, 14), true);
  }
  return { w: L + 100, h: 800 };
}

function farRocks(p, r) {
  const W = 300 + r() * 300, H = 90 + r() * 120, n = 20, pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push([t * W, -Math.pow(Math.sin(t * Math.PI), 0.7) * H * (0.75 + 0.5 * noise1(t * 6 + r() * 3, 9))]);
  }
  pts.push([W, 20], [0, 20]);
  polyTo(p, pts);
  return { w: W, h: H };
}

// far layers: p = horizontal parallax, kv = depth compression, size = extra prop scale
const LAYERS = [
  { p: 0.13, kv: 0.29, size: 1, alpha: 0.22, base: 900, amp: 260, f: 0.00055, seed: 3, chunk: 2600, props: ['skeleton', 'pillar', 'head', 'rocks', 'arch', 'pillar', 'skeleton'] },
  { p: 0.25, kv: 0.42, size: 0.72, alpha: 0.27, base: 840, amp: 240, f: 0.0009, seed: 7, chunk: 1250, props: ['ruins', 'arch', 'ship', 'rocks', 'pillar', 'ruins', 'none'] },
  { p: 0.44, kv: 0.6, size: 0.8, alpha: 0.33, base: 800, amp: 200, f: 0.0014, seed: 13, chunk: 560, props: ['kelp', 'kelp', 'rocks', 'kelp', 'none', 'kelp'] },
];

function layerDepth(L, x) {
  const n = fbm1(x * L.f + L.seed * 3.1, 3, L.seed);
  const rn = noise1(x * L.f * 2.3 + L.seed, L.seed + 50);
  const ridge = 1 - Math.abs(rn * 2 - 1);
  return L.base + (n - 0.5) * 2 * L.amp - ridge * ridge * ridge * L.amp * 0.9;
}

// =====================================================================================
// backdrop (screen space)
// =====================================================================================

const BAND_H = 7;   // world units of far sea visible above the near waves

export function drawBackdrop(ctx, G) {
  const v = G.view;
  if (!(v.cssW > 2) || !ensureArt()) return;
  const P = palette(G);
  const W = v.cssW, H = v.cssH, sc = v.scale, cx = W / 2, cy = H / 2;
  const camX = G.cam.x + (G.cam.shakeX || 0), camY = G.cam.y + (G.cam.shakeY || 0);
  const sy0 = cy - camY * sc;
  const t = G.time;
  const cel = sun(G);

  if (sy0 < H + 2) {
    const top = Math.max(0, sy0);
    // ---- water body. Around a low sun the top of the water mirrors the warm horizon sky
    // (golden hour, dawn), fading out ~15% of the way down.
    const hzc = cel.horizon;
    let gw = 0;
    if (Array.isArray(hzc) && isFinite(hzc[0]) && isFinite(cel.sunE)) {
      const e = cel.sunE;
      const lowSun = smoothstep(-0.3, -0.02, e) * (1 - smoothstep(0.08, 0.45, e));
      const fog = (G.weather && G.weather.fog) || 0;
      gw = (1 - P.night) * lowSun * (1 - S_(G).storm * 0.85) * (1 - fog * 0.7);
    }
    const warmTop = (c, k) => (gw > 0.01 ? mixColor(c, hzc, k * gw) : c);
    const g = ctx.createLinearGradient(0, sy0, 0, sy0 + 1150 * sc);
    g.addColorStop(0, rgb(warmTop(P.surf, 0.52)));
    g.addColorStop(0.03, rgb(warmTop(mixColor(P.surf, P.mid, 0.18), 0.36)));
    g.addColorStop(0.075, rgb(warmTop(mixColor(P.surf, P.mid, 0.45), 0.17)));
    g.addColorStop(0.12, rgb(warmTop(mixColor(P.surf, P.mid, 0.75), 0.07)));
    g.addColorStop(0.2, rgb(P.mid));
    g.addColorStop(0.5, rgb(P.deep));
    g.addColorStop(1, rgb(P.abyss));
    ctx.fillStyle = g;
    ctx.fillRect(0, top, W, H - top);

    ctx.save();
    ctx.beginPath(); ctx.rect(0, top, W, H - top); ctx.clip();

    // light cone under the sun / moon
    const lx = cel.sunVisible ? cel.sunX : cel.moonVisible ? cel.moonX : null;
    if (lx != null && isFinite(lx) && !FX.low) {
      const lowSun = cel.sunVisible && isFinite(cel.sunY) ? clamp(1 - (sy0 - cel.sunY) / (H * 0.55), 0, 1) : 0;
      const a = cel.sunVisible ? 0.16 * P.day * (1 + lowSun * 0.5) * (1 - S_(G).storm * 0.7) : 0.1 * P.night;
      if (a > 0.01 && sy0 > -500 * sc) {
        const R = W * (0.42 - 0.12 * lowSun);
        ctx.save();
        ctx.translate(clamp(lx, -W * 0.2, W * 1.2), sy0);
        ctx.scale(1, 1.25);
        const rg = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
        rg.addColorStop(0, rgba(P.ray, a));
        rg.addColorStop(0.45, rgba(P.ray, a * 0.35));
        rg.addColorStop(1, rgba(P.ray, 0));
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = rg;
        ctx.fillRect(-R, 0, R * 2, R);
        ctx.restore();
      }
    }

    // ---- distance haze: at depth the far water glows faintly at eye level, so the far
    // ridges and the near seabed read as dark silhouettes against it
    const hz = smoothstep(120, 520, camY) * (1 - 0.85 * P.night) * (1 - 0.4 * smoothstep(900, 1350, camY));
    if (hz > 0.01 && !FX.low) {
      const hy = cy + H * 0.06, hh = H * 0.42;
      const hg = ctx.createLinearGradient(0, hy - hh, 0, hy + hh);
      const hc = mixColor(P.mid, P.ray, 0.12);
      hg.addColorStop(0, rgba(hc, 0));
      hg.addColorStop(0.5, rgba(hc, 0.55 * hz));
      hg.addColorStop(1, rgba(hc, 0));
      ctx.fillStyle = hg;
      ctx.fillRect(0, Math.max(top, hy - hh), W, hh * 2);
    }

    // ---- far parallax layers
    for (const L of LAYERS) drawFarLayer(ctx, G, L, P, camX, camY, sc, cx, cy, W, H, t, sy0);

    // ---- god rays (day)
    drawRays(ctx, G, P, cel, camX, sy0, sc, W, H, t, false);

    ctx.restore();
  }

  // ---- far sea band along the horizon (drawn over the sky's bottom edge)
  drawBand(ctx, G, P, cel, sy0, sc, W, H, t);
}

// Silhouette fill that dissolves into the bright water near the surface. `k` and `oy`
// map screen y into the space the fill is drawn in (local = (screenY - oy) / k).
function fogFill(ctx, P, alpha, sy0, k, oy) {
  const a = (sy0 + 25 - oy) / k, b = (sy0 + 290 - oy) / k;
  const g = ctx.createLinearGradient(0, a, 0, b);
  g.addColorStop(0, rgba(P.sil, 0));
  g.addColorStop(1, rgba(P.sil, alpha));
  return g;
}

function drawFarLayer(ctx, G, L, P, camX, camY, sc, cx, cy, W, H, t, sy0) {
  const p = L.p, ps = p * sc;
  const syOf = (D) => cy + (D * L.kv - camY * p) * sc;
  // fog strength: silhouettes fade when the water around is already dark
  const alpha = L.alpha * (0.55 + 0.45 * (1 - P.night));
  // the ridge line
  const step = 14;
  let any = false;
  const ys = [];
  for (let sx = -step; sx <= W + step; sx += step) {
    const lx = camX + (sx - cx) / ps;
    const y = syOf(layerDepth(L, lx));
    ys.push(y);
    if (y < H) any = true;
  }
  if (any) {
    ctx.beginPath();
    ctx.moveTo(-step, H + 4);
    for (let i = 0; i < ys.length; i++) ctx.lineTo(-step + i * step, ys[i]);
    ctx.lineTo(W + step, H + 4);
    ctx.closePath();
    ctx.fillStyle = fogFill(ctx, P, alpha, sy0, 1, 0);
    ctx.fill();
    if (P.day > 0.2) {
      ctx.beginPath();
      for (let i = 0; i < ys.length; i++) i ? ctx.lineTo(-step + i * step, ys[i] + 1) : ctx.moveTo(-step, ys[i] + 1);
      ctx.strokeStyle = rgba(P.ray, 0.045 * P.day);
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
  // props on the ridge
  const margin = 500;
  const lx0 = camX + (-cx - margin) / ps, lx1 = camX + (cx + margin) / ps;
  const c0 = Math.floor(lx0 / L.chunk), c1 = Math.floor(lx1 / L.chunk);
  for (let ci = c0; ci <= c1; ci++) {
    const r = seeded((ci * 1013 + L.seed * 7919) | 0);
    const kind = L.props[Math.floor(r() * L.props.length)];
    if (kind === 'none') continue;
    const lx = (ci + 0.15 + r() * 0.7) * L.chunk;
    const D = layerDepth(L, lx) + 30;
    const sx = cx + (lx - camX) * ps, sy = syOf(D);
    if (kind === 'kelp') { drawFarKelp(ctx, r, sx, sy, ps * L.size, t, P, alpha * 1.1, H, W, sy0); continue; }
    const shp = farShape(kind, Math.floor(r() * 4));
    const flip = r() < 0.5 ? -1 : 1;
    const k = ps * L.size;
    const w = shp.w * k, h = shp.h * k;
    if (sx + w < -20 || sx - w > W + 20 || sy - h > H || sy < -20 || sy - h > H) continue;
    if (sy < sy0 + 20) continue;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.scale(k * flip, k);
    ctx.fillStyle = fogFill(ctx, P, alpha * 1.12, sy0, k, sy);
    ctx.fill(shp.path);
    ctx.restore();
  }
}

// a kelp forest far away: leafy ribbons swaying slowly, as silhouettes
function drawFarKelp(ctx, r, sx, sy, ps, t, P, alpha, H, W, sy0) {
  const n = 6 + Math.floor(r() * 7);
  const rs = [];
  for (let i = 0; i < n; i++) rs.push(r(), r(), r());
  if (sy - 640 * ps > H || sy < sy0 + 10 || sx < -400 * ps - 50 || sx > W + 400 * ps + 50) return;
  const stems = new Path2D(), blades = new Path2D();
  for (let i = 0; i < n; i++) {
    const bx = sx + (rs[i * 3] - 0.5) * 460 * ps, hgt = (240 + rs[i * 3 + 1] * 380) * ps, ph = rs[i * 3 + 2] * TAU;
    const segs = 14, sl = hgt / segs;
    let x = bx, y = sy;
    stems.moveTo(x, y);
    for (let k = 1; k <= segs; k++) {
      const f = k / segs;
      const a = -Math.PI / 2 + Math.sin(t * 0.4 + ph + k * 0.3) * 0.13 * f + 0.06;
      x += Math.cos(a) * sl; y += Math.sin(a) * sl;
      stems.lineTo(x, y);
      const side = (k & 1) ? 1 : -1;
      const len = (26 + 10 * Math.sin(k * 1.3 + ph)) * ps * (1 - f * 0.3);
      const la = a + side * (0.95 + 0.2 * Math.sin(t * 0.6 + k));
      const ex = x + Math.cos(la) * len, ey = y + Math.sin(la) * len + len * 0.45;
      const nx = Math.cos(la + Math.PI / 2) * len * 0.22, ny = Math.sin(la + Math.PI / 2) * len * 0.22;
      blades.moveTo(x, y);
      blades.quadraticCurveTo((x + ex) / 2 + nx, (y + ey) / 2 + ny, ex, ey);
      blades.quadraticCurveTo((x + ex) / 2 - nx, (y + ey) / 2 - ny, x, y);
    }
  }
  const fill = fogFill(ctx, P, alpha, sy0, 1, 0);
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = fill; ctx.lineWidth = Math.max(1, 5 * ps);
  ctx.stroke(stems);
  ctx.fillStyle = fill;
  ctx.fill(blades);
  ctx.restore();
}

// Light shafts from the surface. By day (overlay=false) they are drawn in the backdrop,
// behind everything. Moon shafts are drawn by post.drawLighting on top of the darkness
// (overlay=true) so they read as faint cold light hanging in the black water.
function drawRays(ctx, G, P, cel, camX, sy0, sc, W, H, t, overlay) {
  let a, col, n;
  if (!overlay && (cel.sunVisible || (cel.sunVisible == null && P.day > 0.3))) {
    a = P.rayA * (0.3 + 0.7 * P.day); col = P.ray; n = 11;
  } else if (overlay && cel.moonVisible && !cel.sunVisible) {
    a = 0.05 * P.night; col = [150, 182, 236]; n = 5;
  } else return;
  a *= 1 - (G.sea ? G.sea.storm : 0) * 0.75;
  if (a < 0.004) return;
  const len = 480 * sc;
  if (sy0 + len < 0 || sy0 > H) return;
  const lx = cel.sunVisible ? cel.sunX : cel.moonX;
  const lxs = isFinite(lx) ? lx : W / 2;
  const tilt = clamp((lxs - W / 2) / W, -0.6, 0.6) * -0.5;
  const span = W + 600;
  ctx.save();
  if (overlay) { ctx.beginPath(); ctx.rect(0, Math.max(0, sy0), W, H); ctx.clip(); }
  ctx.globalCompositeOperation = 'lighter';
  const tint = makeTinted(ART.ray, col);
  const base = ctx.getTransform();
  for (let i = 0; i < n; i++) {
    const h1 = hash1(i, overlay ? 13 : 3), h2 = hash1(i, 5), h3 = hash1(i, 9);
    let x;
    if (overlay) x = lxs + (h1 - 0.5) * W * 0.5 + Math.sin(t * 0.05 + i * 1.7) * 30;
    else x = ((h1 * span + t * (4 + h2 * 6) * sc - camX * 0.85 * sc) % span + span) % span - 300;
    const w = (30 + h2 * 110) * sc * 0.8;
    const flick = 0.4 + 0.6 * Math.sin(t * (0.16 + h3 * 0.22) + h1 * 20);
    if (flick <= 0.05) continue;
    ctx.globalAlpha = clamp(a * flick * (0.6 + h3 * 0.8), 0, 1);
    ctx.setTransform(base);
    ctx.translate(x, sy0 - 4);
    ctx.rotate(tilt + (h3 - 0.5) * 0.14);
    ctx.drawImage(tint, -w / 2, 0, w, len * (0.55 + h1 * 0.55));
  }
  ctx.restore();
}

// Night overlay, called by post.drawLighting on top of the darkness: moon shafts hanging in
// the black water and the moon's glittering path on the sea (the only colour at night).
export function drawNightOverlay(ctx, G) {
  const v = G.view;
  if (!(v.cssW > 2) || !ensureArt()) return;
  const P = palette(G);
  if (P.night < 0.3) return;
  const cel = sun(G);
  const W = v.cssW, H = v.cssH, sc = v.scale;
  const camX = G.cam.x + (G.cam.shakeX || 0), camY = G.cam.y + (G.cam.shakeY || 0);
  const sy0 = H / 2 - camY * sc;
  const t = G.time;
  drawRays(ctx, G, P, cel, camX, sy0, sc, W, H, t, true);
  if (!cel.moonVisible || cel.sunVisible || !isFinite(cel.moonX)) return;
  if (sy0 < -20 || sy0 > H + 20) return;
  const S = S_(G);
  const k = P.night * (1 - S.storm * 0.8) * (cel.moonAlpha == null ? 1 : clamp(cel.moonAlpha, 0, 1));
  if (k < 0.05) return;
  const mx = cel.moonX;
  const col = [206, 222, 255];
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = rgb(col);
  // on the far band: short silver dashes widening toward the viewer
  const bh = BAND_H * sc, y0 = sy0 - bh;
  const tb = Math.floor(t * 5);
  for (let r = 0; r < 7; r++) {
    const f = (r + 0.5) / 7, yy = y0 + bh * (0.15 + 0.8 * f);
    const spread = 10 + 70 * f;
    for (let j = 0; j < 5; j++) {
      const hh = hash1(r * 31 + j * 7 + tb * 131, 12), hw = hash1(r * 17 + j * 3 + tb * 71, 14);
      const x = mx + (hh - 0.5) * 2 * spread;
      const w = (3 + hw * 14) * (0.4 + f);
      ctx.globalAlpha = clamp(k * (1 - Math.abs(hh - 0.5) * 1.7) * (0.25 + 0.45 * hw), 0, 1);
      ctx.fillRect(x - w / 2, yy, w, Math.max(1, 0.7 * sc));
    }
  }
  // glints on the near waves under the moon
  const cell = 6;
  const wx0 = camX + (mx - W / 2) / sc;
  const spreadW = 150;
  const c0 = Math.floor((wx0 - spreadW * 1.6) / cell), c1 = Math.floor((wx0 + spreadW * 1.6) / cell);
  for (let c = c0; c <= c1; c++) {
    const h1 = hash1(c, 71), h2 = hash1(c, 72);
    const x = c * cell + h1 * cell;
    const dx = (x - wx0) / spreadW;
    const b = Math.pow(Math.max(0, Math.sin(t * (1.1 + h2 * 2.2) + h1 * 40)), 10) * Math.exp(-dx * dx * 1.6) * k;
    if (b < 0.05) continue;
    const sx = W / 2 + (x - camX) * sc, syy = H / 2 + (waterY(G, x) - camY) * sc;
    const s = (0.8 + b * 3) * sc * 0.8;
    ctx.globalAlpha = clamp(b, 0, 1);
    ctx.fillRect(sx - s, syy - 0.5, s * 2, 1);
    ctx.fillRect(sx - 0.5, syy - s * 0.5, 1, s);
  }
  ctx.restore();
}

// colorized copy of a white sprite (cached per color)
const tintCache = new Map();
function makeTinted(src, col) {
  const key = (src === (ART && ART.ray) ? 'ray' : 'x') + ((col[0] >> 3) << 10 | (col[1] >> 3) << 5 | (col[2] >> 3));
  let c = tintCache.get(key);
  if (c) return c;
  if (tintCache.size > 64) tintCache.clear();
  c = makeCanvas(src.width, src.height);
  const g = c.getContext('2d');
  g.drawImage(src, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = rgb(col);
  g.fillRect(0, 0, c.width, c.height);
  tintCache.set(key, c);
  return c;
}

function drawBand(ctx, G, P, cel, sy0, sc, W, H, t) {
  const bh = BAND_H * sc;
  const y0 = sy0 - bh;
  if (y0 > H || sy0 < -4) return;
  // melt into the sky's own horizon colour when sky.js reports it
  const hc = cel.horizon;
  const haze = Array.isArray(hc) && hc.length >= 3 && isFinite(hc[0]) ? mixColor(P.haze, hc, 0.55) : P.haze;
  const g = ctx.createLinearGradient(0, y0 - 2, 0, sy0 + 2);
  g.addColorStop(0, rgba(haze, 0));
  g.addColorStop(0.2, rgba(haze, 0.75));
  g.addColorStop(0.42, rgb(mixColor(haze, P.band, 0.6)));
  g.addColorStop(0.75, rgb(P.band));
  g.addColorStop(1, rgb(P.surf));
  ctx.fillStyle = g;
  ctx.fillRect(0, y0 - 2, W, bh + 4);

  // reflection path of the sun or moon
  const useSun = cel.sunVisible && isFinite(cel.sunX);
  const useMoon = !useSun && cel.moonVisible && isFinite(cel.moonX);
  if (!useSun && !useMoon) return;
  const lx = useSun ? cel.sunX : cel.moonX, ly = useSun ? cel.sunY : cel.moonY;
  const col = useSun ? mixColor(cel.sunColor || P.glint, P.glint, 0.3) : [214, 228, 255];
  const low = clamp(1 - (sy0 - (isFinite(ly) ? ly : sy0 - 300)) / (H * 0.6), 0, 1);  // 1 = near horizon
  const strength = useSun ? 0.55 + 0.45 * low : 0.5;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  // soft glow where the light meets the horizon
  const R = (60 + 160 * low) * (useSun ? 1 : 0.6);
  ctx.translate(lx, sy0 - bh * 0.4);
  ctx.scale(1, 0.12);
  const rg = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
  rg.addColorStop(0, rgba(col, 0.45 * strength));
  rg.addColorStop(1, rgba(col, 0));
  ctx.fillStyle = rg;
  ctx.fillRect(-R, -R, R * 2, R * 2);
  ctx.restore();
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = rgb(col);
  const rows = Math.max(3, Math.round(bh / 1.6));
  const tb = Math.floor(t * 7);
  for (let k = 0; k < rows; k++) {
    const f = (k + 0.5) / rows;
    const yy = y0 + bh * (0.2 + 0.8 * f);
    const spread = (12 + 90 * f) * (0.5 + low) * (useSun ? 1 : 0.6);
    for (let j = 0; j < 4; j++) {
      const hh = hash1(k * 31 + j * 7 + tb * 131, 2), hw = hash1(k * 17 + j * 3 + tb * 71, 4);
      const x = lx + (hh - 0.5) * 2 * spread;
      const w = (2 + hw * 10) * (0.5 + f);
      const fall = 1 - Math.abs(hh - 0.5) * 1.6;
      ctx.globalAlpha = clamp(strength * fall * (0.35 + 0.5 * hw), 0, 1);
      ctx.fillRect(x - w / 2, yy, w, Math.max(0.8, 0.9 * sc * 0.6));
    }
  }
  ctx.restore();
}

// =====================================================================================
// seabed items
// =====================================================================================

const CH = 100;                                     // chunk width (world units)
const FORCED = { 2: 'wreck', 5: 'anchor', 9: 'helmet', 14: 'bones', 19: 'trash', 23: 'vent' };

function flattest(by, xa, xb) {
  let best = xa, bs = 1e9;
  for (let x = xa; x <= xb; x += 5) {
    const sl = Math.abs(by(x + 8) - by(x - 8));
    if (sl < bs) { bs = sl; best = x; }
  }
  return best;
}

function chunkItems(G, ci) {
  const S = S_(G);
  let items = S.chunks.get(ci);
  if (items) return items;
  if (S.chunks.size > 500) S.chunks.clear();
  items = [];
  const r = seeded((ci * 7919 + 104729) | 0);
  const x0 = ci * CH;
  const by = (x) => seabedY(G, x);
  const forest = smoothstep(0.4, 0.66, noise1(x0 * 0.0016 + 2.2, 77));
  const reef = smoothstep(0.38, 0.64, noise1(x0 * 0.0021 + 7.7, 91));

  let rare = FORCED[ci] || null;
  const q = r();
  if (!rare && ci > 26 && ci % 3 === 0) {
    rare = q < 0.08 ? 'wreck' : q < 0.15 ? 'helmet' : q < 0.25 ? 'bones' : q < 0.32 ? 'anchor' : q < 0.5 ? 'trash' : null;
  }
  const midY = by(x0 + CH / 2);
  if (!rare && midY > 1000 && r() < 0.35) rare = 'vent';

  if (rare === 'wreck') {
    const x = x0 + 50, y = Math.max(by(x - 70), by(x + 70), by(x)) + 8;
    items.push({ type: 'wreck', layer: 0, x, y, s: 1, v: Math.floor(r() * 2), ph: r(), flip: r() < 0.5 });
  } else if (rare === 'helmet') {
    const x = flattest(by, x0 + 20, x0 + 80);
    items.push({ type: 'helmet', layer: 0, x, y: by(x) + 16, s: 1.45, v: 0, ph: r(), flip: r() < 0.5 });
  } else if (rare === 'bones') {
    const x = x0 + 50;
    items.push({ type: 'bones', layer: 0, x, y: Math.max(by(x - 100), by(x), by(x + 100)) + 14, s: 1, v: 0, ph: r(), flip: r() < 0.5 });
  } else if (rare === 'anchor') {
    const x = flattest(by, x0 + 25, x0 + 75);
    items.push({ type: 'anchor', layer: 0, x, y: by(x) + 16, s: 1.35, v: 0, ph: r(), flip: false });
  } else if (rare === 'trash') {
    const n = 2 + Math.floor(r() * 2);
    for (let i = 0; i < n; i++) {
      const x = x0 + 15 + r() * 70;
      items.push({ type: 'trash', layer: 0, x, y: by(x) + 3, s: 0.9 + r() * 0.3, v: Math.floor(r() * 3), ph: r(), flip: r() < 0.5 });
    }
  } else if (rare === 'vent') {
    const x = x0 + 20 + r() * 60;
    items.push({ type: 'vent', layer: 1, x, y: by(x) + 4, s: 0.8 + r() * 0.6, v: Math.floor(r() * 2), ph: r(), h: 50, flip: r() < 0.5 });
  }

  // boulders (big ones half buried behind the sediment)
  const nr = 1 + Math.floor(r() * 3);
  for (let i = 0; i < nr; i++) {
    const x = x0 + r() * CH, big = r() < 0.32;
    const s = big ? 22 + r() * 34 : 6 + r() * 12;
    items.push({ type: 'rock', layer: big ? 0 : 2, x, y: by(x) + s * (big ? 0.28 : 0.15), s, v: Math.floor(r() * 6), ph: r(), flip: r() < 0.5 });
  }
  // kelp
  if (r() < 0.12 + 0.7 * forest && !rare) {
    const x = x0 + r() * CH;
    const n = 2 + Math.floor(r() * (3 + forest * 4));
    const strands = [];
    for (let i = 0; i < n; i++) strands.push({ dx: (r() - 0.5) * 34, h: 70 + r() * (130 + forest * 200), ph: r() * TAU, w: 1.6 + r() * 1.4 });
    items.push({ type: 'kelp', layer: 1, x, y: by(x) + 2, s: 1, ph: r(), strands, hmax: Math.max(...strands.map((s) => s.h)) });
  }
  // coral and sponges
  const coralP = reef * smoothstep(1050, 650, midY);
  const nc = r() < coralP ? 1 + Math.floor(r() * 3 * reef) : 0;
  for (let i = 0; i < nc; i++) {
    const x = x0 + r() * CH;
    const kind = r();
    const type = kind < 0.4 ? 'branch' : kind < 0.62 ? 'fan' : kind < 0.82 ? 'brain' : 'tube';
    items.push({ type: 'coral', sub: type, layer: 2, x, y: by(x) + 2, s: 0.7 + r() * 0.7, v: Math.floor(r() * 3), ph: r(), flip: r() < 0.5 });
  }
  // anemones (glow at night)
  if (r() < 0.16 + reef * 0.2) {
    const x = x0 + r() * CH;
    const hue = r();
    items.push({ type: 'anemone', layer: 3, x, y: by(x) + 1, s: 0.8 + r() * 0.6, ph: r(), hue,
      glow: hue < 0.55 ? [110, 220, 255] : [255, 140, 200] });
  }
  // sea grass
  const ng = Math.floor(r() * 3 + forest);
  for (let i = 0; i < ng; i++) {
    const x = x0 + r() * CH;
    items.push({ type: 'grass', layer: 3, x, y: by(x) + 1, s: 0.6 + r() * 0.8, ph: r() * TAU, n: 5 + Math.floor(r() * 7) });
  }
  // shells / starfish / bottles in the sand
  if (r() < 0.35) {
    const x = x0 + r() * CH;
    items.push({ type: 'trinket', layer: 3, x, y: by(x) + 0.5, s: 1, v: Math.floor(r() * 3), ph: r(), flip: r() < 0.5 });
  }
  items.sort((a, b) => a.layer - b.layer);
  S.chunks.set(ci, items);
  return items;
}

// =====================================================================================
// seabed prop sprites (RES px per world unit, drawn once)
// =====================================================================================

const RES = 3;

function spr(key, w, h, fn) {
  let s = ART.spr.get(key);
  if (s) return s;
  const c = makeCanvas(w * RES, h * RES);
  const g = c.getContext('2d');
  g.scale(RES, RES);
  g.lineJoin = 'round'; g.lineCap = 'round';
  const meta = fn(g, w, h) || {};
  s = { c, w, h, ax: meta.ax == null ? w / 2 : meta.ax, ay: meta.ay == null ? h : meta.ay, ring: meta.ring };
  ART.spr.set(key, s);
  return s;
}

function blob(g, pts) {
  const n = pts.length;
  g.beginPath();
  let m = [(pts[n - 1][0] + pts[0][0]) / 2, (pts[n - 1][1] + pts[0][1]) / 2];
  g.moveTo(m[0], m[1]);
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    g.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
  }
  g.closePath();
}

// light-from-above rim: stroke the current path shifted down, clipped to the shape
function topRim(g, pathFn, color, width, shift) {
  g.save();
  pathFn(); g.clip();
  g.translate(0, shift);
  pathFn();
  g.strokeStyle = color; g.lineWidth = width; g.stroke();
  g.restore();
}

function speckle(g, r, n, x, y, w, h, color, size) {
  g.fillStyle = color;
  for (let i = 0; i < n; i++) {
    g.beginPath(); g.arc(x + r() * w, y + r() * h, size * (0.4 + r()), 0, TAU); g.fill();
  }
}

function boulderSprite(v) {
  return spr('rock' + v, 40, 30, (g, w, h) => {
    const r = seeded(31 + v * 97);
    const n = 20, pts = [];
    const k1 = r() * TAU, k2 = r() * TAU;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      const rr = 1 + Math.sin(a * 2 + k1) * 0.08 + Math.sin(a * 3 + k2) * 0.06 + (r() - 0.5) * 0.12;
      pts.push([w * 0.5 + Math.cos(a) * w * 0.46 * rr, Math.min(h - 0.5, h * 0.62 + Math.sin(a) * h * 0.58 * rr)]);
    }
    const path = () => blob(g, pts);
    const gr = g.createLinearGradient(0, 2, w * 0.3, h);
    const base = [[58, 70, 74], [52, 58, 66], [62, 66, 62], [46, 60, 66], [66, 64, 70], [54, 66, 60]][v % 6];
    gr.addColorStop(0, rgb(base.map((c) => c * 1.45)));
    gr.addColorStop(0.45, rgb(base));
    gr.addColorStop(1, rgb(base.map((c) => c * 0.35)));
    path(); g.fillStyle = gr; g.fill();
    g.save(); path(); g.clip();
    speckle(g, r, 30, 0, 0, w, h, 'rgba(0,0,0,0.18)', 0.9);
    speckle(g, r, 18, 0, 0, w, h * 0.6, 'rgba(190,200,190,0.12)', 0.7);
    // cracks
    g.strokeStyle = 'rgba(10,14,18,0.55)'; g.lineWidth = 0.5;
    for (let i = 0; i < 2; i++) {
      g.beginPath(); let x = w * (0.25 + r() * 0.5), y = h * 0.25 + r() * 4;
      g.moveTo(x, y);
      for (let k = 0; k < 4; k++) { x += (r() - 0.5) * 6; y += 2 + r() * 4; g.lineTo(x, y); }
      g.stroke();
    }
    // moss/algae fuzz on top
    g.fillStyle = 'rgba(96,120,70,0.35)';
    for (let i = 0; i < 26; i++) { const a = Math.PI + r() * Math.PI; g.beginPath(); g.arc(w / 2 + Math.cos(a) * w * 0.4, h * 0.6 + Math.sin(a) * h * 0.55, 0.6 + r() * 1.2, 0, TAU); g.fill(); }
    // bottom shadow
    const sh = g.createLinearGradient(0, h * 0.55, 0, h);
    sh.addColorStop(0, 'rgba(0,0,0,0)'); sh.addColorStop(1, 'rgba(0,0,0,0.5)');
    g.fillStyle = sh; g.fillRect(0, 0, w, h);
    g.restore();
    topRim(g, path, 'rgba(200,225,220,0.35)', 1.2, 1);
    return { ax: w / 2, ay: h };
  });
}

const CORAL_COLS = [
  [[120, 54, 70], [214, 128, 132]],   // rose
  [[124, 72, 40], [222, 160, 92]],    // ochre
  [[70, 50, 104], [168, 126, 196]],   // violet
];

function coralSprite(sub, v) {
  if (sub === 'branch') return spr('cb' + v, 44, 48, (g, w, h) => {
    const r = seeded(201 + v * 13);
    const [dk, lt] = CORAL_COLS[v % 3];
    const gr = g.createLinearGradient(0, h, 0, 0);
    gr.addColorStop(0, rgb(dk.map((c) => c * 0.6))); gr.addColorStop(1, rgb(lt));
    g.strokeStyle = gr;
    const tips = [];
    const br = (x, y, a, len, wd, d) => {
      const x2 = x + Math.cos(a) * len, y2 = y + Math.sin(a) * len;
      g.lineWidth = wd;
      g.beginPath(); g.moveTo(x, y);
      g.quadraticCurveTo(x + Math.cos(a + 0.25) * len * 0.5, y + Math.sin(a + 0.25) * len * 0.5, x2, y2);
      g.stroke();
      if (d <= 0) { tips.push([x2, y2, wd]); return; }
      const nb = r() < 0.3 ? 3 : 2;
      for (let i = 0; i < nb; i++) br(x2, y2, a + (i - (nb - 1) / 2) * (0.45 + r() * 0.35) + (r() - 0.5) * 0.25, len * (0.66 + r() * 0.18), wd * 0.74, d - 1);
    };
    br(w / 2, h, -Math.PI / 2 + (r() - 0.5) * 0.2, h * 0.26, 4.2, 4);
    for (const [x, y, wd] of tips) {
      g.fillStyle = rgb(lt.map((c) => Math.min(255, c * 1.15)));
      g.beginPath(); g.arc(x, y, wd * 0.75, 0, TAU); g.fill();
    }
  });
  if (sub === 'fan') return spr('cf' + v, 50, 46, (g, w, h) => {
    const r = seeded(301 + v * 17);
    const [dk, lt] = CORAL_COLS[(v + 2) % 3];
    const stems = [];
    const n = 9;
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (i / (n - 1) - 0.5) * 2.1;
      const pts = [[w / 2, h]];
      let x = w / 2, y = h, ang = -Math.PI / 2;
      const len = h * (0.7 + r() * 0.25);
      for (let k = 1; k <= 8; k++) {
        ang = lerp(ang, a, 0.35) + (r() - 0.5) * 0.25;
        x += Math.cos(ang) * len / 8; y += Math.sin(ang) * len / 8;
        pts.push([x, y]);
      }
      stems.push(pts);
    }
    // the lacy mesh between stems
    g.strokeStyle = rgba(lt, 0.45); g.lineWidth = 0.35;
    for (let k = 2; k <= 8; k++) {
      g.beginPath();
      for (let i = 0; i < n; i++) { const p = stems[i][k]; i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]); }
      g.stroke();
      if (k < 8) for (let i = 0; i < n - 1; i++) {
        const a = stems[i][k], b = stems[i + 1][k + 1];
        g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
      }
    }
    const gr = g.createLinearGradient(0, h, 0, 0);
    gr.addColorStop(0, rgb(dk.map((c) => c * 0.7))); gr.addColorStop(1, rgb(lt));
    g.strokeStyle = gr;
    for (const pts of stems) {
      g.beginPath();
      pts.forEach((p, k) => { g.lineWidth = 1.8 - k * 0.15; k ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]); });
      g.lineWidth = 1.1; g.stroke();
    }
    g.lineWidth = 3; g.strokeStyle = rgb(dk); g.beginPath(); g.moveTo(w / 2, h); g.lineTo(w / 2, h - 5); g.stroke();
  });
  if (sub === 'brain') return spr('cr' + v, 36, 22, (g, w, h) => {
    const r = seeded(401 + v * 19);
    const [dk, lt] = CORAL_COLS[(v + 1) % 3];
    const path = () => { g.beginPath(); g.ellipse(w / 2, h, w * 0.47, h * 0.92, 0, Math.PI, TAU); g.closePath(); };
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, rgb(lt)); gr.addColorStop(1, rgb(dk.map((c) => c * 0.6)));
    path(); g.fillStyle = gr; g.fill();
    g.save(); path(); g.clip();
    g.strokeStyle = rgba(dk.map((c) => c * 0.5), 0.7); g.lineWidth = 0.6;
    for (let i = 0; i < 14; i++) {
      g.beginPath(); let x = r() * w, y = h * (0.1 + r() * 0.9), a = r() * TAU;
      g.moveTo(x, y);
      for (let k = 0; k < 9; k++) { a += (r() - 0.5) * 1.6; x += Math.cos(a) * 2.2; y += Math.sin(a) * 1.4; g.lineTo(x, y); }
      g.stroke();
    }
    g.restore();
    topRim(g, path, 'rgba(255,230,220,0.3)', 1, 0.8);
  });
  return spr('ct' + v, 30, 40, (g, w, h) => {
    const r = seeded(501 + v * 23);
    const [dk, lt] = CORAL_COLS[(v + 1) % 3];
    const n = 3 + Math.floor(r() * 3);
    for (let i = 0; i < n; i++) {
      const x = w * (0.2 + 0.6 * (i / (n - 1 || 1))) + (r() - 0.5) * 3;
      const th = h * (0.4 + r() * 0.55), tw = 4 + r() * 3, lean = (x - w / 2) * 0.25;
      const gr = g.createLinearGradient(x - tw, 0, x + tw, 0);
      gr.addColorStop(0, rgb(dk)); gr.addColorStop(0.4, rgb(lt)); gr.addColorStop(1, rgb(dk.map((c) => c * 0.6)));
      g.fillStyle = gr;
      g.beginPath();
      g.moveTo(x - tw * 0.6, h);
      g.quadraticCurveTo(x - tw * 0.7 + lean * 0.3, h - th * 0.6, x - tw / 2 + lean, h - th);
      g.lineTo(x + tw / 2 + lean, h - th);
      g.quadraticCurveTo(x + tw * 0.7 + lean * 0.3, h - th * 0.6, x + tw * 0.6, h);
      g.fill();
      g.fillStyle = rgb(dk.map((c) => c * 0.3));
      g.beginPath(); g.ellipse(x + lean, h - th, tw / 2, 1.2, 0, 0, TAU); g.fill();
      g.strokeStyle = rgba(lt.map((c) => Math.min(255, c * 1.2)), 0.8); g.lineWidth = 0.5;
      g.beginPath(); g.ellipse(x + lean, h - th, tw / 2, 1.2, 0, Math.PI, TAU); g.stroke();
    }
  });
}

function wreckSprite(v) {
  return spr('wreck' + v, 190, 120, (g, w, h) => {
    const r = seeded(611 + v * 7);
    g.translate(w / 2, h * 0.72);
    g.rotate(-0.1);
    g.translate(-w / 2, -h * 0.72);
    const oy = 34;
    const deck = (x) => oy + 20 - Math.sin((x / w) * Math.PI) * 4 - (x / w) * 10;
    const keel = (x) => oy + 76 - Math.pow(Math.abs(x / w - 0.45) * 2, 2.2) * 26;
    const hull = () => {
      g.beginPath();
      g.moveTo(12, deck(12));
      for (let x = 12; x <= 176; x += 8) g.lineTo(x, deck(x));
      g.quadraticCurveTo(186, deck(176) - 4, 182, oy + 30);
      g.quadraticCurveTo(176, oy + 56, keel(150), keel(150));
      for (let x = 150; x >= 18; x -= 8) g.lineTo(x, keel(x));
      g.lineTo(10, oy + 50);
      g.closePath();
    };
    // mast stump leaning out, with a torn sail and rope
    g.save();
    g.translate(112, deck(112)); g.rotate(0.55);
    const mg = g.createLinearGradient(-3, 0, 3, 0);
    mg.addColorStop(0, '#2a2018'); mg.addColorStop(0.5, '#5a4630'); mg.addColorStop(1, '#22190f');
    g.fillStyle = mg; g.fillRect(-2.5, -70, 5, 72);
    g.fillStyle = 'rgba(150,150,130,0.45)';
    g.beginPath(); g.moveTo(2, -66); g.quadraticCurveTo(26, -50, 18, -22); g.lineTo(24, -10); g.quadraticCurveTo(10, -30, 2, -30); g.fill();
    g.restore();
    g.strokeStyle = 'rgba(120,100,70,0.8)'; g.lineWidth = 0.8;
    g.beginPath(); g.moveTo(150, deck(150)); g.quadraticCurveTo(160, oy - 20, 168, oy - 50); g.stroke();
    // hull body
    const hg = g.createLinearGradient(0, oy + 10, 0, oy + 80);
    hg.addColorStop(0, '#6d5a42'); hg.addColorStop(0.35, '#4c3d2c'); hg.addColorStop(1, '#1e1812');
    hull(); g.fillStyle = hg; g.fill();
    g.save(); hull(); g.clip();
    // planking
    g.strokeStyle = 'rgba(20,14,8,0.55)'; g.lineWidth = 0.6;
    for (let f = 0.16; f < 1; f += 0.14) {
      g.beginPath();
      for (let x = 8; x <= 186; x += 6) { const y = lerp(deck(x), keel(x), f); x > 8 ? g.lineTo(x, y) : g.moveTo(x, y); }
      g.stroke();
    }
    for (let i = 0; i < 16; i++) { const x = 16 + r() * 160, y = lerp(deck(x), keel(x), r()); g.beginPath(); g.moveTo(x, y - 2); g.lineTo(x, y + 2); g.stroke(); }
    // the broken hole showing the ribs inside
    const hole = [[70, oy + 30], [86, oy + 24], [98, oy + 34], [112, oy + 28], [118, oy + 44], [108, oy + 62], [90, oy + 70], [74, oy + 60], [66, oy + 46]];
    g.fillStyle = '#07090a';
    g.beginPath(); hole.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.fill();
    g.strokeStyle = '#4a3a28'; g.lineWidth = 2.4;
    for (let x = 74; x < 116; x += 9) { g.beginPath(); g.moveTo(x, oy + 22); g.quadraticCurveTo(x + 4, oy + 46, x - 2, oy + 72); g.stroke(); }
    g.strokeStyle = 'rgba(10,8,6,0.6)'; g.lineWidth = 1;
    g.beginPath(); hole.forEach(([x, y], i) => (i ? g.lineTo(x + 0.6, y + 0.6) : g.moveTo(x, y))); g.closePath(); g.stroke();
    // algae and rust streaks
    for (let i = 0; i < 40; i++) {
      const x = r() * w, y = deck(x) + r() * 8;
      g.fillStyle = `rgba(${70 + r() * 30},${96 + r() * 30},${60},${0.3 + r() * 0.3})`;
      g.beginPath(); g.ellipse(x, y, 1 + r() * 3, 0.8 + r() * 1.4, 0, 0, TAU); g.fill();
    }
    g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(0, oy + 60, w, 40);
    g.restore();
    // gunwale rim light
    g.strokeStyle = 'rgba(190,200,170,0.35)'; g.lineWidth = 1.2;
    g.beginPath(); for (let x = 12; x <= 176; x += 8) x > 12 ? g.lineTo(x, deck(x) + 0.6) : g.moveTo(x, deck(x) + 0.6); g.stroke();
    // a little wheelhouse, its window black
    g.save(); g.translate(42, deck(42)); g.rotate(-0.04);
    g.fillStyle = '#3d3226'; g.fillRect(-2, -22, 30, 22);
    g.fillStyle = '#2a221a'; g.fillRect(-4, -25, 34, 4);
    g.fillStyle = '#050607'; g.fillRect(5, -17, 8, 7); g.fillRect(16, -17, 7, 7);
    g.fillStyle = 'rgba(160,200,200,0.25)'; g.fillRect(6, -16, 2, 2);
    g.restore();
    return { ax: w / 2, ay: oy + 74 };
  });
}

function helmetSprite() {
  return spr('helmet', 84, 84, (g, w, h) => {
    const r = seeded(919);
    g.translate(w / 2, h * 0.62); g.rotate(-0.28); g.translate(-w / 2, -h * 0.62);
    const cx = 42, cy = 38, R = 26;
    // breastplate
    const bp = g.createLinearGradient(0, 56, 0, 84);
    bp.addColorStop(0, '#7a5434'); bp.addColorStop(1, '#2a1a10');
    g.fillStyle = bp;
    g.beginPath(); g.moveTo(10, 84); g.quadraticCurveTo(14, 60, 30, 58); g.lineTo(56, 58); g.quadraticCurveTo(72, 60, 76, 84); g.closePath(); g.fill();
    // bolts on the collar
    g.fillStyle = '#a07a4c';
    for (let i = 0; i < 7; i++) { const x = 18 + i * 8.5; g.beginPath(); g.arc(x, 64 + Math.abs(i - 3) * 1.2, 1.6, 0, TAU); g.fill(); }
    // dome
    const dome = () => { g.beginPath(); g.arc(cx, cy, R, 0, TAU); };
    const dg = g.createRadialGradient(cx - 9, cy - 12, 3, cx, cy, R + 2);
    dg.addColorStop(0, '#c99a5c'); dg.addColorStop(0.35, '#8c5f36'); dg.addColorStop(0.8, '#4a2e1a'); dg.addColorStop(1, '#22150c');
    dome(); g.fillStyle = dg; g.fill();
    g.save(); dome(); g.clip();
    // verdigris and rust blooms
    for (let i = 0; i < 36; i++) {
      const a = r() * TAU, d = r() * R;
      g.fillStyle = r() < 0.5 ? `rgba(80,140,120,${0.25 + r() * 0.3})` : `rgba(120,60,30,${0.3 + r() * 0.3})`;
      g.beginPath(); g.ellipse(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 1 + r() * 4, 1 + r() * 2.5, r() * 3, 0, TAU); g.fill();
    }
    g.restore();
    // collar ring
    g.strokeStyle = '#5a3c22'; g.lineWidth = 4;
    g.beginPath(); g.ellipse(cx, 58, 20, 4, 0, 0, TAU); g.stroke();
    // side port
    const port = (x, y, rr, rim) => {
      g.fillStyle = '#6b4a2a'; g.beginPath(); g.arc(x, y, rr + rim, 0, TAU); g.fill();
      g.strokeStyle = '#b08850'; g.lineWidth = 0.9; g.beginPath(); g.arc(x, y, rr + rim - 0.6, Math.PI * 1.05, Math.PI * 1.75); g.stroke();
      const wg = g.createRadialGradient(x - rr * 0.3, y - rr * 0.3, 0, x, y, rr);
      wg.addColorStop(0, '#10161a'); wg.addColorStop(1, '#020304');
      g.fillStyle = wg; g.beginPath(); g.arc(x, y, rr, 0, TAU); g.fill();
    };
    port(cx - 17, cy + 1, 6, 2.5);
    // the big front port with its grille
    port(cx + 6, cy + 2, 11.5, 3.5);
    g.strokeStyle = '#7a5634'; g.lineWidth = 1.6;
    for (const dx of [-5, 0, 5]) { g.beginPath(); g.moveTo(cx + 6 + dx, cy + 2 - 10.5); g.lineTo(cx + 6 + dx, cy + 2 + 10.5); g.stroke(); }
    g.beginPath(); g.moveTo(cx + 6 - 11, cy + 2); g.lineTo(cx + 6 + 11, cy + 2); g.stroke();
    g.fillStyle = 'rgba(170,220,220,0.18)'; g.beginPath(); g.ellipse(cx + 1, cy - 4, 2.4, 1.2, -0.6, 0, TAU); g.fill();
    // top port and valve
    port(cx - 2, cy - 19, 4, 2);
    g.fillStyle = '#8c6038'; g.fillRect(cx + 16, cy - 22, 6, 5);
    g.fillStyle = '#4a2e1a'; g.fillRect(cx + 17, cy - 26, 4, 4);
    // highlight sweep
    g.strokeStyle = 'rgba(255,220,170,0.35)'; g.lineWidth = 1.5;
    g.beginPath(); g.arc(cx, cy, R - 2.5, Math.PI * 1.1, Math.PI * 1.45); g.stroke();
    // barnacles
    g.fillStyle = 'rgba(200,196,180,0.6)';
    for (let i = 0; i < 9; i++) { const a = Math.PI * (0.1 + r() * 0.8), d = R - 2; g.beginPath(); g.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 0.8 + r() * 1.2, 0, TAU); g.fill(); }
    return { ax: w / 2, ay: 78 };
  });
}

function bonesSprite() {
  return spr('bones', 270, 160, (g, w, h) => {
    const r = seeded(1201);
    const base = 140;
    const bone = (c) => { g.fillStyle = c; };
    const bg = g.createLinearGradient(0, 20, 0, base + 10);
    bg.addColorStop(0, '#b4ae98'); bg.addColorStop(0.6, '#8a8574'); bg.addColorStop(1, '#4a473e');
    // spine
    bone(bg);
    for (let i = 0; i < 20; i++) {
      const x = 14 + i * 11.5, y = base - 4 - Math.sin((i / 19) * Math.PI) * 10;
      g.beginPath(); g.ellipse(x, y, 5.4, 4.6, 0.2, 0, TAU); g.fill();
      g.beginPath(); g.moveTo(x - 1.5, y - 3); g.lineTo(x + 2 + r() * 2, y - 12 - r() * 4); g.lineTo(x + 3, y - 3); g.fill();
    }
    // ribs: tapered arcs curving up out of the sand
    for (let i = 0; i < 8; i++) {
      const x0 = 50 + i * 21, y0 = base - 8 - Math.sin(((x0 - 14) / 230) * Math.PI) * 10;
      const H = (70 + Math.sin(((i + 0.5) / 8) * Math.PI) * 60) * (i === 5 ? 0.45 : 1);
      const reach = 26 + r() * 10, th = 6.5 - i * 0.25;
      const outer = [], inner = [];
      for (let k = 0; k <= 16; k++) {
        const u = k / 16;
        const bx = x0 - Math.sin(u * Math.PI * 0.85) * reach + u * u * reach * 0.5;
        const by = y0 - H * Math.sin(u * Math.PI * 0.55);
        const wd = th * (1 - u * 0.72);
        outer.push([bx - wd / 2, by]); inner.push([bx + wd / 2, by]);
      }
      g.beginPath();
      [...outer, ...inner.reverse()].forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath(); g.fill();
      g.strokeStyle = 'rgba(40,36,30,0.5)'; g.lineWidth = 0.6;
      g.beginPath(); inner.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
    }
    // the skull, jaw open, one huge empty socket
    g.save();
    g.translate(232, base - 18); g.rotate(-0.12);
    const sg = g.createLinearGradient(0, -40, 0, 20);
    sg.addColorStop(0, '#c0b8a0'); sg.addColorStop(1, '#5a5446');
    g.fillStyle = sg;
    g.beginPath();
    g.moveTo(-26, 4); g.quadraticCurveTo(-30, -30, 0, -38); g.quadraticCurveTo(22, -40, 34, -22);
    g.quadraticCurveTo(44, -10, 40, 2); g.quadraticCurveTo(16, 8, -26, 4); g.fill();
    g.beginPath(); g.moveTo(-18, 8); g.lineTo(40, 6); g.quadraticCurveTo(44, 16, 30, 22); g.quadraticCurveTo(0, 26, -16, 18); g.closePath(); g.fill();
    g.fillStyle = '#d8d0b8';
    for (let i = 0; i < 6; i++) { const x = -8 + i * 8; g.beginPath(); g.moveTo(x, 3); g.lineTo(x + 2.5, 10); g.lineTo(x + 5, 3); g.fill(); }
    g.fillStyle = '#060708';
    g.beginPath(); g.ellipse(8, -20, 8, 7, -0.2, 0, TAU); g.fill();
    g.beginPath(); g.ellipse(32, -10, 2, 3, 0, 0, TAU); g.fill();
    g.strokeStyle = 'rgba(30,26,22,0.6)'; g.lineWidth = 0.7;
    g.beginPath(); g.moveTo(-12, -28); g.lineTo(-6, -18); g.lineTo(-10, -8); g.stroke();
    g.restore();
    // algae tufts
    for (let i = 0; i < 30; i++) { g.fillStyle = `rgba(80,${100 + r() * 30},60,${0.25 + r() * 0.3})`; g.beginPath(); g.arc(r() * w, base - r() * 120, 0.8 + r() * 1.5, 0, TAU); g.fill(); }
    return { ax: w / 2, ay: base };
  });
}

function anchorSprite() {
  return spr('anchor', 70, 84, (g, w, h) => {
    const cx = 35, top = 10, bot = 70;
    g.save();
    g.translate(cx, 60); g.rotate(0.55); g.translate(-cx, -60);
    const ag = g.createLinearGradient(cx - 6, 0, cx + 6, 0);
    ag.addColorStop(0, '#2a2420'); ag.addColorStop(0.45, '#6a5446'); ag.addColorStop(1, '#1e1814');
    g.fillStyle = ag;
    g.fillRect(cx - 3.2, top + 6, 6.4, bot - top - 6);
    g.fillRect(cx - 16, top + 12, 32, 4.5);
    g.beginPath(); g.arc(cx - 16, top + 14.25, 3, 0, TAU); g.arc(cx + 16, top + 14.25, 3, 0, TAU); g.fill();
    g.strokeStyle = '#4e4036'; g.lineWidth = 3;
    g.beginPath(); g.arc(cx, top + 3, 5, 0, TAU); g.stroke();
    g.lineWidth = 5.5;
    g.beginPath(); g.moveTo(cx - 24, bot - 18); g.quadraticCurveTo(cx - 20, bot + 2, cx, bot); g.quadraticCurveTo(cx + 20, bot + 2, cx + 24, bot - 18); g.stroke();
    g.fillStyle = '#3a302a';
    for (const s of [-1, 1]) { g.beginPath(); g.moveTo(cx + s * 24, bot - 26); g.lineTo(cx + s * 30, bot - 14); g.lineTo(cx + s * 19, bot - 14); g.closePath(); g.fill(); }
    // rust
    const r = seeded(77);
    for (let i = 0; i < 30; i++) { g.fillStyle = `rgba(${130 + r() * 40},${60 + r() * 20},30,${0.3 + r() * 0.3})`; g.beginPath(); g.arc(cx + (r() - 0.5) * 8, top + r() * (bot - top), 0.6 + r() * 1.4, 0, TAU); g.fill(); }
    g.restore();
    // ring position after the rotation (anchor local -> sprite)
    const a = 0.55, dx = 0, dy = top + 3 - 60;
    const ring = [cx + dx * Math.cos(a) - dy * Math.sin(a), 60 + dx * Math.sin(a) + dy * Math.cos(a)];
    return { ax: w / 2, ay: 74, ring };
  });
}

function trashSprite(v) {
  return spr('trash' + v, 30, 22, (g, w, h) => {
    const r = seeded(1401 + v);
    if (v === 0) {      // rusted oil drum lying on its side
      g.save(); g.translate(15, 15); g.rotate(-0.15);
      const dg = g.createLinearGradient(0, -8, 0, 8);
      dg.addColorStop(0, '#7a4a2c'); dg.addColorStop(0.5, '#4e2e1c'); dg.addColorStop(1, '#1e120a');
      g.fillStyle = dg; g.fillRect(-12, -8, 22, 16);
      g.fillStyle = '#3a2416'; g.beginPath(); g.ellipse(10, 0, 3, 8, 0, 0, TAU); g.fill();
      g.strokeStyle = '#2a180e'; g.lineWidth = 1.2;
      for (const x of [-6, 2]) { g.beginPath(); g.moveTo(x, -8); g.lineTo(x, 8); g.stroke(); }
      for (let i = 0; i < 14; i++) { g.fillStyle = `rgba(160,80,30,${0.3 + r() * 0.4})`; g.beginPath(); g.arc(-10 + r() * 20, -7 + r() * 14, 0.5 + r(), 0, TAU); g.fill(); }
      g.restore();
    } else if (v === 1) { // an old tyre half in the sand
      g.lineWidth = 5; g.strokeStyle = '#141618';
      g.beginPath(); g.ellipse(15, 13, 10, 8, 0.2, 0, TAU); g.stroke();
      g.lineWidth = 0.8; g.strokeStyle = 'rgba(120,130,130,0.35)';
      g.beginPath(); g.ellipse(15, 13, 12, 10, 0.2, Math.PI * 1.1, Math.PI * 1.7); g.stroke();
    } else {             // a crate with broken slats
      g.save(); g.translate(15, 13); g.rotate(0.2);
      g.fillStyle = '#4a3b28'; g.fillRect(-9, -8, 18, 16);
      g.strokeStyle = '#2a2016'; g.lineWidth = 1;
      for (const y of [-4, 0, 4]) { g.beginPath(); g.moveTo(-9, y); g.lineTo(9, y); g.stroke(); }
      g.fillStyle = '#08090a'; g.fillRect(-3, -8, 5, 6);
      g.restore();
    }
    return { ax: 15, ay: 20 };
  });
}

function ventSprite(v) {
  return spr('vent' + v, 30, 60, (g, w, h) => {
    const r = seeded(1501 + v * 3);
    const pts = [];
    const n = 12;
    for (let i = 0; i <= n; i++) { const t = i / n; pts.push([15 - (9 - t * 5) * (0.8 + r() * 0.4), h - t * (h - 6)]); }
    const rp = [];
    for (let i = n; i >= 0; i--) { const t = i / n; rp.push([15 + (9 - t * 5) * (0.8 + r() * 0.4), h - t * (h - 6)]); }
    const gr = g.createLinearGradient(4, 0, 26, 0);
    gr.addColorStop(0, '#0e1012'); gr.addColorStop(0.45, '#2c2a26'); gr.addColorStop(1, '#08090a');
    g.fillStyle = gr;
    g.beginPath(); [...pts, ...rp].forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.fill();
    g.fillStyle = 'rgba(200,120,60,0.35)';
    for (let i = 0; i < 8; i++) { g.beginPath(); g.arc(10 + r() * 10, 10 + r() * (h - 14), 0.6 + r(), 0, TAU); g.fill(); }
    g.fillStyle = 'rgba(255,140,60,0.5)'; g.beginPath(); g.ellipse(15, 7, 3, 1.2, 0, 0, TAU); g.fill();
    return { ax: 15, ay: h };
  });
}

function trinketSprite(v) {
  return spr('trk' + v, 12, 8, (g, w, h) => {
    if (v === 0) {  // starfish
      g.fillStyle = '#b06a4a';
      g.beginPath();
      for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? 1.6 : 4.6; g.lineTo(6 + Math.cos(a) * rr, 5 + Math.sin(a) * rr * 0.55); }
      g.closePath(); g.fill();
    } else if (v === 1) { // shell
      g.fillStyle = '#c8b8a0'; g.beginPath(); g.ellipse(6, 6, 4, 2.6, 0, Math.PI, TAU); g.fill();
      g.strokeStyle = 'rgba(90,70,60,0.6)'; g.lineWidth = 0.35;
      for (let i = -3; i <= 3; i++) { g.beginPath(); g.moveTo(6, 6); g.lineTo(6 + i * 1.2, 3.6); g.stroke(); }
    } else {      // a glass bottle half buried
      g.save(); g.translate(6, 6); g.rotate(-0.4);
      g.fillStyle = 'rgba(110,160,130,0.75)'; g.fillRect(-4, -1.6, 6, 3.2); g.fillRect(2, -0.8, 2.5, 1.6);
      g.fillStyle = 'rgba(220,255,240,0.5)'; g.fillRect(-3, -1.2, 4, 0.6);
      g.restore();
    }
    return { ax: 6, ay: 7 };
  });
}

function itemSprite(it) {
  switch (it.type) {
    case 'rock': return boulderSprite(it.v);
    case 'coral': return coralSprite(it.sub, it.v);
    case 'wreck': return wreckSprite(it.v);
    case 'helmet': return helmetSprite();
    case 'bones': return bonesSprite();
    case 'anchor': return anchorSprite();
    case 'trash': return trashSprite(it.v);
    case 'vent': return ventSprite(it.v);
    case 'trinket': return trinketSprite(it.v);
  }
  return null;
}

function drawSprite(ctx, s, x, y, scale, flip) {
  const w = s.w * scale, h = s.h * scale;
  if (flip) {
    ctx.save();
    ctx.translate(x, y); ctx.scale(-1, 1);
    ctx.drawImage(s.c, -s.ax * scale, -s.ay * scale, w, h);
    ctx.restore();
  } else ctx.drawImage(s.c, x - s.ax * scale, y - s.ay * scale, w, h);
}

// =====================================================================================
// seabed (world space)
// =====================================================================================

export function drawSeabed(ctx, G) {
  const v = G.view;
  if (!(v.w > 1) || !ensureArt()) return;
  const bottom = v.top + v.h + 12;
  if (bottom < 120) return;                    // the tallest kelp tips start around y≈130
  const P = palette(G);
  const t = G.time;
  const x0 = v.left - 12, x1 = v.left + v.w + 12;

  // terrain samples
  const step = 5;
  const n = Math.ceil((x1 - x0) / step) + 1;
  const ys = new Float32Array(n);
  let minY = 1e9;
  for (let i = 0; i < n; i++) { const y = seabedY(G, x0 + i * step); ys[i] = y; if (y < minY) minY = y; }
  const bodyVisible = minY < bottom + 4;

  // items
  const c0 = Math.floor((x0 - 150) / CH), c1 = Math.floor((x1 + 150) / CH);
  const vis = [];
  for (let ci = c0; ci <= c1; ci++) {
    for (const it of chunkItems(G, ci)) {
      const span = it.type === 'wreck' || it.type === 'bones' ? 150 : it.type === 'kelp' ? 40 : 60;
      if (it.x + span < x0 || it.x - span > x1) continue;
      const tall = it.type === 'kelp' ? it.hmax + 20 : it.type === 'anchor' ? 560 : it.type === 'wreck' ? 140 : 90;
      if (it.y - tall > bottom || it.y + 40 < v.top) continue;
      vis.push(it);
    }
  }
  vis.sort((a, b) => a.layer - b.layer);

  // layer 0: things half buried — drawn before the sediment covers their bases
  for (const it of vis) if (it.layer === 0) drawItem(ctx, G, it, t, P);

  if (bodyVisible) drawTerrain(ctx, G, x0, step, n, ys, bottom, P, t);

  for (const it of vis) if (it.layer > 0) drawItem(ctx, G, it, t, P);
}

function drawTerrain(ctx, G, x0, step, n, ys, bottom, P, t) {
  const pats = getPatterns(ctx);
  const xEnd = x0 + (n - 1) * step;
  const trace = (off) => {
    ctx.moveTo(x0, ys[0] + off(0));
    for (let i = 1; i < n; i++) ctx.lineTo(x0 + i * step, ys[i] + off(i));
  };
  const zero = () => 0;
  // rock body
  ctx.beginPath(); trace(zero); ctx.lineTo(xEnd, bottom); ctx.lineTo(x0, bottom); ctx.closePath();
  ctx.fillStyle = '#1b2329'; ctx.fill();
  if (pats.rock) {
    setPatternTransform(pats.rock, 0.5, 0.5, 0, 0);
    ctx.fillStyle = pats.rock; ctx.fill();
  }
  // depth shading following the contour (strata get darker inward)
  ctx.beginPath(); trace((i) => 14 + noise1((x0 + i * step) * 0.03, 5) * 16); ctx.lineTo(xEnd, bottom); ctx.lineTo(x0, bottom); ctx.closePath();
  ctx.fillStyle = 'rgba(2,6,10,0.32)'; ctx.fill();
  ctx.beginPath(); trace((i) => 50 + noise1((x0 + i * step) * 0.012, 6) * 40); ctx.lineTo(xEnd, bottom); ctx.lineTo(x0, bottom); ctx.closePath();
  ctx.fillStyle = 'rgba(1,4,8,0.45)'; ctx.fill();

  // sediment / sand where the slope is gentle
  const thick = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = ys[Math.max(0, i - 1)], b = ys[Math.min(n - 1, i + 1)];
    const slope = Math.abs(b - a) / (2 * step);
    thick[i] = 6 * (1 - smoothstep(0.45, 1.2, slope)) * (0.7 + 0.6 * noise1((x0 + i * step) * 0.05, 8));
  }
  ctx.beginPath();
  trace(() => -0.6);
  for (let i = n - 1; i >= 0; i--) ctx.lineTo(x0 + i * step, ys[i] + thick[i]);
  ctx.closePath();
  const sand = mixColor([78, 82, 72], P.mid, 0.3);
  ctx.fillStyle = rgb(sand); ctx.fill();
  // sand ripples
  ctx.beginPath();
  for (let i = 1; i < n - 1; i += 2) {
    if (thick[i] < 3) continue;
    const x = x0 + i * step + (hash1(Math.floor((x0 + i * step) / step), 3) - 0.5) * 3;
    const y = ys[i] + 2 + hash1(i, 4) * 2;
    ctx.moveTo(x - 2.6, y + 0.4); ctx.quadraticCurveTo(x, y - 1.1, x + 2.6, y + 0.4);
  }
  ctx.strokeStyle = 'rgba(150,160,140,0.22)'; ctx.lineWidth = 0.6; ctx.stroke();
  // lit rim along the top
  ctx.beginPath(); trace(() => 0.2);
  ctx.strokeStyle = rgba(mixColor([150, 160, 140], P.ray, 0.3), 0.45); ctx.lineWidth = 1.1; ctx.stroke();
}

function drawItem(ctx, G, it, t, P) {
  switch (it.type) {
    case 'kelp': return drawKelp(ctx, it, t);
    case 'grass': return drawGrass(ctx, it, t);
    case 'anemone': return drawAnemone(ctx, it, t, P);
    case 'anchor': {
      const s = anchorSprite();
      drawChain(ctx, G, it, s, t);
      return drawSprite(ctx, s, it.x, it.y, it.s, false);
    }
    case 'rock': {
      const s = boulderSprite(it.v);
      return drawSprite(ctx, s, it.x, it.y, it.s / 40, it.flip);
    }
    case 'coral': {
      const s = coralSprite(it.sub, it.v);
      return drawSprite(ctx, s, it.x, it.y, it.s * 0.6, it.flip);
    }
    case 'vent': {
      const s = ventSprite(it.v);
      drawSprite(ctx, s, it.x, it.y, it.s, it.flip);
      it.h = s.h * it.s;
      // faint heat shimmer glow at the mouth
      const a = 0.18 + 0.08 * Math.sin(t * 2 + it.ph * 9);
      ctx.fillStyle = `rgba(255,120,50,${a.toFixed(3)})`;
      ctx.beginPath(); ctx.ellipse(it.x, it.y - it.h + 7 * it.s, 4 * it.s, 2 * it.s, 0, 0, TAU); ctx.fill();
      return;
    }
    default: {
      const s = itemSprite(it);
      if (s) drawSprite(ctx, s, it.x, it.y, it.s, it.flip);
    }
  }
}

function drawKelp(ctx, it, t) {
  // giant kelp: a dark stipe with long drooping blades, each on a little gas bladder
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const blades = new Path2D(), stems = new Path2D(), floats = new Path2D(), ribs = new Path2D();
  for (const st of it.strands) {
    const bx = it.x + st.dx, by = it.y;
    const segs = Math.max(6, Math.round(st.h / 11)), sl = st.h / segs;
    let x = bx, y = by;
    stems.moveTo(x, y);
    for (let k = 1; k <= segs; k++) {
      const f = k / segs;
      const a = -Math.PI / 2 + Math.sin(t * 0.5 + st.ph + k * 0.27) * 0.12 * f + Math.sin(t * 0.19 + st.ph) * 0.1 * f + 0.06;
      x += Math.cos(a) * sl; y += Math.sin(a) * sl;
      stems.lineTo(x, y);
      if (k < 2) continue;
      const side = ((k + (st.ph * 3 | 0)) & 1) ? 1 : -1;
      const len = (15 + 7 * Math.sin(k * 1.7 + st.ph)) * (1 - f * 0.25) * st.w * 0.55;
      const wid = len * 0.24;
      // blades stream out and droop with the slow current
      const la = a + side * (0.85 + 0.25 * Math.sin(t * 0.7 + k * 0.9 + st.ph)) + 0.25;
      const bx0 = x + Math.cos(la) * 1.8, by0 = y + Math.sin(la) * 1.8;
      const ex = bx0 + Math.cos(la) * len, ey = by0 + Math.sin(la) * len + len * 0.35;
      const mx = (bx0 + ex) / 2, my = (by0 + ey) / 2 - len * 0.08;
      const nx = Math.cos(la + Math.PI / 2) * wid, ny = Math.sin(la + Math.PI / 2) * wid;
      blades.moveTo(bx0, by0);
      blades.bezierCurveTo(mx + nx, my + ny, ex + nx * 0.3, ey + ny * 0.3, ex, ey);
      blades.bezierCurveTo(ex - nx * 0.6, ey - ny * 0.6, mx - nx * 0.8, my - ny * 0.8, bx0, by0);
      ribs.moveTo(bx0, by0); ribs.quadraticCurveTo(mx, my, ex, ey);
      floats.moveTo(bx0 + 1.5, by0); floats.arc(bx0, by0, 1.5, 0, TAU);
    }
    // the floating tip
    floats.moveTo(x + 2.2, y); floats.arc(x, y, 2.2, 0, TAU);
  }
  ctx.strokeStyle = '#26321a'; ctx.lineWidth = 1.9; ctx.stroke(stems);
  ctx.fillStyle = '#41562a'; ctx.fill(blades);
  ctx.strokeStyle = 'rgba(150,176,96,0.35)'; ctx.lineWidth = 0.45; ctx.stroke(ribs);
  ctx.strokeStyle = 'rgba(20,28,12,0.55)'; ctx.lineWidth = 0.5; ctx.stroke(blades);
  ctx.fillStyle = '#6a7434'; ctx.fill(floats);
  ctx.restore();
}

function drawGrass(ctx, it, t) {
  ctx.beginPath();
  for (let i = 0; i < it.n; i++) {
    const h1 = hash1(i, it.ph * 10);
    const bx = it.x + (h1 - 0.5) * 12 * it.s, h = (8 + h1 * 14) * it.s;
    const sway = Math.sin(t * 0.9 + it.ph + i * 0.7) * 3 * it.s;
    ctx.moveTo(bx, it.y);
    ctx.quadraticCurveTo(bx + sway * 0.3, it.y - h * 0.6, bx + sway + (h1 - 0.5) * 4, it.y - h);
  }
  ctx.strokeStyle = '#3f5a2e'; ctx.lineWidth = 1; ctx.stroke();
}

function drawAnemone(ctx, it, t, P) {
  const s = it.s, x = it.x, y = it.y;
  const body = it.hue < 0.55 ? [180, 160, 190] : [200, 110, 120];
  // stalk
  const bg = ctx.createLinearGradient(x - 4 * s, 0, x + 4 * s, 0);
  bg.addColorStop(0, rgb(body.map((c) => c * 0.35))); bg.addColorStop(0.5, rgb(body.map((c) => c * 0.75))); bg.addColorStop(1, rgb(body.map((c) => c * 0.3)));
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.moveTo(x - 4.5 * s, y); ctx.quadraticCurveTo(x - 3 * s, y - 5 * s, x - 3.6 * s, y - 8 * s);
  ctx.lineTo(x + 3.6 * s, y - 8 * s); ctx.quadraticCurveTo(x + 3 * s, y - 5 * s, x + 4.5 * s, y); ctx.fill();
  // tentacles
  ctx.beginPath();
  const tips = [];
  for (let i = 0; i < 13; i++) {
    const u = i / 12 - 0.5;
    const bx = x + u * 7 * s, by = y - 8 * s;
    const sw = Math.sin(t * 1.4 + it.ph * 9 + i * 0.6) * 2.4 * s;
    const ex = bx + u * 10 * s + sw, ey = by - (7 + Math.cos(u * 3) * 4) * s;
    ctx.moveTo(bx, by); ctx.quadraticCurveTo(bx + u * 4 * s, by - 5 * s, ex, ey);
    tips.push(ex, ey);
  }
  ctx.strokeStyle = rgb(body.map((c) => c * 0.85)); ctx.lineWidth = 1.1 * s; ctx.stroke();
  // glowing tips at night / in the deep
  const glow = Math.max(P.night, smoothstep(400, 800, y));
  ctx.fillStyle = glow > 0.3 ? rgba(it.glow, 0.5 + 0.4 * glow) : rgb(body.map((c) => Math.min(255, c * 1.15)));
  ctx.beginPath();
  for (let i = 0; i < tips.length; i += 2) { ctx.moveTo(tips[i] + 1, tips[i + 1]); ctx.arc(tips[i], tips[i + 1], 0.9 * s, 0, TAU); }
  ctx.fill();
}

function drawChain(ctx, G, it, s, t) {
  // a chain from the anchor ring rising into the dark water, its far end lost in the murk
  const rx = it.x + (s.ring[0] - s.ax) * it.s, ry = it.y + (s.ring[1] - s.ay) * it.s;
  const v = G.view;
  const len = 360 + it.ph * 160;
  const topY = ry - len;
  if (ry < v.top - 10 || topY > v.top + v.h + 10) return;
  const link = 5.2;
  const nLinks = Math.floor(len / (link * 0.85));
  const ovals = new Path2D(), bars = new Path2D();
  for (let i = 0; i < nLinks; i++) {
    const u = i / nLinks;
    const y = ry - i * link * 0.85;
    if (y < v.top - 8 || y > v.top + v.h + 8) continue;
    // slack near the anchor, then rising almost straight up
    const x = rx + Math.sin(u * 2.4) * 22 * (1 - u) + Math.sin(t * 0.25 + u * 3) * 5 * u + u * 34;
    if (i % 2 === 0) { ovals.moveTo(x + 1.7, y); ovals.ellipse(x, y, 1.7, link * 0.55, 0, 0, TAU); }
    else bars.rect(x - 0.6, y - link * 0.5, 1.2, link);
  }
  const g = ctx.createLinearGradient(0, ry, 0, topY);
  g.addColorStop(0, 'rgba(66,56,50,1)');
  g.addColorStop(0.6, 'rgba(50,44,42,0.75)');
  g.addColorStop(1, 'rgba(40,40,44,0)');
  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = g; ctx.stroke(ovals);
  ctx.fillStyle = g; ctx.fill(bars);
  ctx.restore();
}

// =====================================================================================
// surface (world space, drawn over everything)
// =====================================================================================

export function drawSurface(ctx, G) {
  const v = G.view;
  if (!(v.w > 1) || !ensureArt()) return;
  const S = S_(G), P = palette(G);
  const t = G.time;
  const camY = G.cam.y;
  const x0 = v.left - 14, x1 = v.left + v.w + 14;
  const R = G.raft;
  const raftSpan = R && R.tiles && R.tiles.length && isFinite(R.x) ? [R.x + 1.5, R.x + R.tiles.length * C.TILE_W - 1.5] : null;
  const inRaft = (x) => raftSpan !== null && x > raftSpan[0] && x < raftSpan[1];
  const bottom = v.top + v.h + 14;
  const topVis = v.top - 14;
  const A = S.amp;
  if (bottom < -A - 4) return;   // view entirely in the sky

  // sample the surface
  const step = 4;
  const n = Math.ceil((x1 - x0) / step) + 1;
  let sy = S.sy;
  if (!sy || sy.length < n) sy = S.sy = new Float32Array(n + 64);
  for (let i = 0; i < n; i++) sy[i] = waterY(G, x0 + i * step);
  const xEnd = x0 + (n - 1) * step;
  const surfaceVisible = topVis < A + 4;

  // island columns: the water column ends at the island ground; dry land has none
  const spans = islandSpans(G);
  let gb = null;
  if (spans.length) {
    gb = S.gb && S.gb.length >= n ? S.gb : (S.gb = new Float32Array(n + 64));
    for (let i = 0; i < n; i++) {
      const g = islandGround(G, x0 + i * step, spans);
      gb[i] = g == null ? 1e9 : g;
    }
  }
  const dry = (i) => gb !== null && gb[i] < sy[i] + 0.5;

  const waterPath = () => {
    ctx.beginPath();
    const top = (i) => (surfaceVisible ? sy[i] : Math.max(topVis, sy[i]));
    ctx.moveTo(x0, top(0));
    for (let i = 1; i < n; i++) ctx.lineTo(x0 + i * step, top(i));
    if (gb) {
      for (let i = n - 1; i >= 0; i--) ctx.lineTo(x0 + i * step, clamp(gb[i], top(i), bottom));
    } else { ctx.lineTo(xEnd, bottom); ctx.lineTo(x0, bottom); }
    ctx.closePath();
  };

  // ---- translucent water over everything below the line
  const under = smoothstep(4, 60, camY + 72);      // camera close to / below the surface
  ctx.save();
  waterPath();
  // the same depth colours as the backdrop, so things sink into the water instead of
  // the water going milky; alpha grows with depth (fog)
  const tg = ctx.createLinearGradient(0, 0, 0, 1150);
  const a0 = lerp(0.13, 0.28, P.night), a1 = lerp(0.24, 0.36, P.night), a2 = lerp(0.36, 0.46, P.night);
  tg.addColorStop(0, rgba(mixColor(P.tint, P.surf, 0.5), a0));
  tg.addColorStop(0.12, rgba(mixColor(P.tint, P.mid, 0.6), a1));
  tg.addColorStop(0.3, rgba(P.mid, a2));
  tg.addColorStop(0.6, rgba(P.deep, a2));
  tg.addColorStop(1, rgba(P.abyss, a2));
  ctx.fillStyle = tg;
  ctx.fill();
  ctx.clip();

  // light just under the surface: a soft bright skin + caustics (day)
  if (P.day > 0.05 && topVis < 120) {
    const lg = ctx.createLinearGradient(0, -A, 0, 46);
    lg.addColorStop(0, rgba(P.ray, 0.2 * P.day));
    lg.addColorStop(1, rgba(P.ray, 0));
    ctx.fillStyle = lg;
    ctx.fillRect(x0, -A - 2, xEnd - x0, 50 + A);
    const pats = getPatterns(ctx);
    if (pats.caustic) {
      const ca = 0.13 * P.day * (1 - S.storm * 0.65);
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = pats.caustic;
      setPatternTransform(pats.caustic, 0.5, 0.5, t * 7.5, 0.5);
      ctx.globalAlpha = ca;
      ctx.fillRect(x0, 0, xEnd - x0, 64);
      if (!FX.low) {
        setPatternTransform(pats.caustic, 0.63, 0.45, -t * 5.2 + 41, 1.5);
        ctx.globalAlpha = ca * 0.8;
        ctx.fillRect(x0, 0, xEnd - x0, 58);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  // marine snow drifting in the water column
  drawSnow(ctx, G, v, P, t);

  // the mirror-like underside of the surface, seen from below
  if (under > 0.01 && surfaceVisible) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.beginPath();
    traceSurface(ctx, x0, step, n, sy, 2.2, (i) => dry(i) || inRaft(x0 + i * step));
    const uc = mixColor(P.ray, P.line, 0.5);
    ctx.strokeStyle = rgba(uc, 0.22 * under * (0.4 + 0.6 * P.day) + 0.05);
    ctx.lineWidth = 3.4; ctx.stroke();
    // moving silver highlights
    ctx.beginPath();
    for (let i = 0; i < n - 1; i++) {
      const x = x0 + i * step;
      const k = noise1((x + t * 26) * 0.045, 12) * noise1((x - t * 17) * 0.07, 13);
      if (k < 0.32 || dry(i) || inRaft(x)) continue;
      ctx.moveTo(x, sy[i] + 1.4); ctx.lineTo(x + step, sy[i + 1] + 1.4);
    }
    ctx.strokeStyle = rgba(P.line, 0.55 * under * (0.35 + 0.65 * P.day));
    ctx.lineWidth = 1.2; ctx.stroke();
    // reflected glow band
    const rg = ctx.createLinearGradient(0, -A, 0, 26);
    rg.addColorStop(0, rgba(uc, 0.14 * under * (0.3 + 0.7 * P.day)));
    rg.addColorStop(1, rgba(uc, 0));
    ctx.fillStyle = rg; ctx.fillRect(x0, -A - 2, xEnd - x0, 30 + A);
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.restore();

  if (!surfaceVisible) return;

  // ---- the surface line: a dark meniscus under a bright skin that flickers along the crests.
  // Broken where an island rises out of the water; only a faint wet line across the raft.
  ctx.save();
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  const skipOpen = (i) => dry(i) || inRaft(x0 + i * step);
  ctx.beginPath();
  traceSurface(ctx, x0, step, n, sy, 1.4, skipOpen);
  ctx.strokeStyle = rgba(mixColor(P.surf, [0, 0, 0], 0.4), 0.45);
  ctx.lineWidth = 1.8; ctx.stroke();
  ctx.beginPath();
  traceSurface(ctx, x0, step, n, sy, 0, skipOpen);
  const lineA = lerp(0.62, 0.38, P.night) * (1 - S.storm * 0.25);
  ctx.strokeStyle = rgba(P.line, lineA);
  ctx.lineWidth = 0.9; ctx.stroke();
  if (raftSpan) {
    ctx.beginPath();
    traceSurface(ctx, x0, step, n, sy, 0.4, (i) => dry(i) || !inRaft(x0 + i * step));
    ctx.strokeStyle = rgba(P.line, lineA * 0.3);
    ctx.lineWidth = 0.7; ctx.stroke();
  }
  const hi = new Path2D();
  const Aa = S.amp + 0.01;
  for (let i = 0; i < n - 1; i++) {
    const x = x0 + i * step;
    if (skipOpen(i) || skipOpen(i + 1)) continue;
    const crest = -sy[i] / Aa;
    const nz = noise1((x - t * 14) * 0.05, 17);
    if (crest * 0.6 + nz > 0.85) { hi.moveTo(x, sy[i] - 0.15); hi.lineTo(x + step, sy[i + 1] - 0.15); }
  }
  ctx.strokeStyle = rgba(mixColor(P.line, [255, 255, 255], 0.4), Math.min(1, lineA * 1.45));
  ctx.lineWidth = 1.5; ctx.stroke(hi);

  drawFoam(ctx, G, S, P, x0, step, n, sy, t, skipOpen);
  drawRaftFoam(ctx, G, P, t);
  drawGlints(ctx, G, S, P, t, spans, inRaft);
  drawRain(ctx, G, P, t, spans);
  ctx.restore();
}

// Polyline along the surface (offset dy), broken wherever skip(i) is true.
function traceSurface(ctx, x0, step, n, sy, dy, skip) {
  let pen = false;
  for (let i = 0; i < n; i++) {
    if (skip(i)) { pen = false; continue; }
    const x = x0 + i * step, y = sy[i] + dy;
    if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
  }
}

function drawSnow(ctx, G, v, P, t) {
  const cell = 46;
  const yTop = Math.max(v.top, 8), yBot = v.top + v.h;
  if (yBot < 12) return;
  const cx0 = Math.floor(v.left / cell) - 1, cx1 = Math.floor((v.left + v.w) / cell) + 1;
  const cy0 = Math.floor(yTop / cell) - 1, cy1 = Math.floor(yBot / cell) + 1;
  const a = 0.22 + 0.2 * (1 - P.day);
  ctx.fillStyle = rgba(P.snow, a);
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const h = hash1(cx * 7.13 + cy * 113.7, 21);
      if (h < 0.25) continue;
      const fall = t * (2 + h * 4);
      const px = cx * cell + hash1(cx + cy * 57, 22) * cell + Math.sin(t * 0.3 + h * 20) * 4;
      let py = cy * cell + ((hash1(cx * 3 + cy, 23) * cell + fall) % cell);
      if (py < 10 || py < yTop - 2 || py > yBot + 2) continue;
      const sz = 0.5 + h * 0.9;
      ctx.fillRect(px - sz / 2, py - sz / 2, sz, sz);
    }
  }
}

function drawFoam(ctx, G, S, P, x0, step, n, sy, t, skip) {
  const A = S.amp + 0.01, st = S.storm;
  const thr = lerp(1.0, 0.5, clamp(st + (A - 3) / 10, 0, 1));
  const bigP = new Path2D(), smallP = new Path2D(), lace = new Path2D();
  let any = false;
  for (let i = 1; i < n - 1; i++) {
    if (skip(i) || skip(i + 1)) continue;
    const x = x0 + i * step, y = sy[i];
    const crest = clamp(-y / A, -1, 1);
    const nn = noise1((x - t * 24) * 0.07, 3);
    const f = crest * 0.55 + nn * 0.6 - thr;
    if (f > 0) {
      any = true;
      const r = 0.6 + f * (2 + A * 0.25);
      const ox = (hash1(i + Math.floor(x / step), 6) - 0.5) * 3;
      bigP.moveTo(x + ox + r, y + 0.2);
      bigP.ellipse(x + ox, y + 0.2, r, r * 0.42, 0, 0, TAU);
      if (f > 0.15) { smallP.moveTo(x + ox + 2 + r * 0.4, y - r * 0.3); smallP.arc(x + ox + 2, y - r * 0.3, r * 0.4, 0, TAU); }
    }
    // foam lace trailing on the faces of the waves in rough seas
    if (st > 0.2 && noise1((x - t * 18) * 0.11, 7) > 0.6) {
      lace.moveTo(x, y + 1.6 + nn * 2); lace.lineTo(x + step, sy[i + 1] + 1.6 + nn * 2);
    }
  }
  if (any) {
    ctx.fillStyle = rgba(P.foam, 0.75 * lerp(1, 0.6, P.night)); ctx.fill(bigP);
    ctx.fillStyle = rgba(P.foam, 0.9 * lerp(1, 0.6, P.night)); ctx.fill(smallP);
  }
  if (st > 0.2) { ctx.strokeStyle = rgba(P.foam, 0.4 * st); ctx.lineWidth = 0.8; ctx.stroke(lace); }
}

function drawRaftFoam(ctx, G, P, t) {
  const R = G.raft;
  if (!R || !R.tiles || !R.tiles.length || !isFinite(R.x)) return;
  const w = R.tiles.length * C.TILE_W;
  const xa = R.x, xb = R.x + w;
  const v = G.view;
  if (xb + 140 < v.left || xa - 140 > v.left + v.w) return;
  const night = P.night;
  const foam = rgba(P.foam, 0.7 * lerp(1, 0.55, night));
  ctx.fillStyle = foam;
  const path = new Path2D();
  // lapping foam where the logs meet the water
  for (const ex of [xa, xb]) {
    for (let k = 0; k < 4; k++) {
      const x = ex + (k - 1.5) * 2.5 + Math.sin(t * 2 + k * 2 + ex) * 1.2;
      const y = waterY(G, x) + 0.3;
      const r = 1 + 0.8 * Math.abs(Math.sin(t * 1.7 + k * 1.3));
      path.moveTo(x + r, y); path.ellipse(x, y, r, r * 0.45, 0, 0, TAU);
    }
  }
  // the wake behind a drifting raft: world-fixed foam flecks fading with distance
  const speed = R.anchored ? 0 : (R.vx || 0);
  if (speed > 0.5) {
    const k = clamp(speed / 20, 0.3, 1);
    for (let x = Math.floor((xa - 120) / 3) * 3; x < xa; x += 3) {
      const d = (xa - x) / 120;
      const h = hash1(x / 3, 31);
      if (h > 0.55 * (1 - d) * k + 0.05) continue;
      const y = waterY(G, x) + 0.4 + h * 1.2;
      const r = 0.6 + h * 1.4;
      path.moveTo(x + r, y); path.ellipse(x, y, r, r * 0.4, 0, 0, TAU);
    }
  }
  ctx.fill(path);
  // faint bioluminescence stirred up by the raft at night
  if (night > 0.6) {
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 16; i++) {
      const h = hash1(i, 41), side = i & 1 ? xa : xb;
      const x = side + (h - 0.5) * 30 - (i & 1 ? 10 : -6);
      const y = waterY(G, x) + 2 + hash1(i, 42) * 8;
      const a = Math.pow(Math.max(0, Math.sin(t * (1.3 + h) + i * 2.1)), 6) * 0.7 * night;
      if (a < 0.03) continue;
      ctx.fillStyle = `rgba(110,220,255,${a.toFixed(3)})`;
      ctx.beginPath(); ctx.arc(x, y, 0.9, 0, TAU); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }
}

function drawGlints(ctx, G, S, P, t, spans, inRaft) {
  const v = G.view, cel = sun(G);
  let srcX = null, strength = 0, col = P.glint;
  if (cel.sunVisible && isFinite(cel.sunX)) { srcX = G.cam.x + (cel.sunX - v.cssW / 2) / v.scale; strength = P.day; }
  else if (cel.moonVisible && isFinite(cel.moonX)) { srcX = G.cam.x + (cel.moonX - v.cssW / 2) / v.scale; strength = 0.55 * P.night; col = [214, 228, 255]; }
  else if (P.day > 0.3) { srcX = G.cam.x; strength = P.day * 0.6; }
  strength *= 1 - S.storm * 0.7;
  if (strength < 0.03) return;
  const cell = 7;
  const c0 = Math.floor(v.left / cell), c1 = Math.floor((v.left + v.w) / cell);
  const spread = v.w * 0.32;
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = rgb(col);
  for (let c = c0; c <= c1; c++) {
    const h1 = hash1(c, 51), h2 = hash1(c, 52);
    const x = c * cell + h1 * cell;
    const dx = (x - srcX) / spread;
    const w = Math.exp(-dx * dx) * 0.9 + 0.12;
    const b = Math.pow(Math.max(0, Math.sin(t * (1.3 + h2 * 2.6) + h1 * 40)), 14) * w * strength;
    if (b < 0.06 || inRaft(x)) continue;
    const y = waterY(G, x) - 0.2;
    if (spans.length) { const g = islandGround(G, x, spans); if (g != null && g < y + 1) continue; }
    const s = 0.6 + b * 2.6;
    ctx.globalAlpha = clamp(b, 0, 1);
    ctx.fillRect(x - s, y - 0.18, s * 2, 0.36);
    ctx.fillRect(x - 0.18, y - s * 0.6, 0.36, s * 1.2);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

function drawRain(ctx, G, P, t, spans) {
  const rain = (G.weather && G.weather.rain) || 0;
  if (rain < 0.05) return;
  const v = G.view;
  const n = Math.floor(rain * 70);
  const life = 0.45;
  ctx.strokeStyle = rgba(P.foam, 0.45);
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  for (let k = 0; k < n; k++) {
    const off = hash1(k, 61) * life;
    const tb = Math.floor((t + off) / life);
    const age = ((t + off) % life) / life;
    const x = v.left + hash1(k * 13 + tb * 7.3, 62) * v.w;
    const y = waterY(G, x);
    if (spans.length) { const g = islandGround(G, x, spans); if (g != null && g < y + 1) continue; }
    const r = 0.8 + age * 4;
    ctx.moveTo(x - r, y + 0.3);
    ctx.ellipse(x, y + 0.3, r, r * 0.25, 0, Math.PI, TAU);
    if (age < 0.3) { ctx.moveTo(x, y); ctx.lineTo(x, y - 2.5 * (1 - age / 0.3)); }
  }
  ctx.stroke();
}
