// ============================================================================
// 少年与海 · sky.js  (worker: SKY)
//
// Everything above the horizon, plus the weather:
//   - keyframed sky gradient over the whole day (dawn, day, golden hour, dusk,
//     night, pre-dawn), graded by storms / rain / fog
//   - sun with bloom and a sunset band, thin crescent moon with halo, a
//     twinkling star field with a milky band, shooting stars
//   - painterly towering cumulus baked once into sprites (lit tops, shadowed
//     bellies, rim light) and re-tinted for the time of day in the background,
//     composited in parallax layers; thin cirrus; distant rain shafts
//   - distant mountains / sea stacks on the horizon, and the lighthouse that
//     appears late in the journey
//   - weather state machine that owns G.weather; rain, mist, fog banks and
//     lightning drawn in screen space after the lighting pass
//   - the sky's own lights are re-lit after the lighting pass (drawWeather) so the
//     night grade cannot grey them: the moon (colour-dodge mask with the clouds in
//     front cut out, warm cream halo) and the far lighthouse's beam and lamp.
//     celestial() also reports how much cloud / land hides the sun and the moon,
//     which post uses for the sun bloom and the vignette
//
// Exports: init, update, drawSky, drawWeather, debugWeather, celestial.
// ============================================================================

import { C, say, journal } from '../core/state.js';
import { TAU, clamp, lerp, smoothstep, hash1, noise1, seeded, mixColor, hexToRgb, makeCanvas, gradientAt } from '../core/util.js';
import { getAsset } from '../core/assets.js';
import { sfx } from '../systems/audio.js';
import { groundAt as islandGroundAt } from '../systems/islands.js';

// ------------------------------------------------------------------ constants
const RS = 0.75;          // cloud sprites are baked at this many px per 720p screen px
const SKY_REF = 560;      // height of the painted gradient above the horizon (u = cssH/720)
const SUN_ARC = 280;      // how far above the horizon the sun climbs at noon (u); low enough to stay clear of the toasts
const MOON_ARC = 350;
const MTN_W = 2400;       // far horizon strip (tiles horizontally), baked at u = 1
const MTN_H = 130;

const WEATHER = {
  clear:  { wave: 1.0, rain: 0,    wind: 0.30, fog: 0.00, cover: 0.44, dur: [110, 230] },
  cloudy: { wave: 1.3, rain: 0,    wind: 0.55, fog: 0.04, cover: 0.74, dur: [80, 170] },
  rain:   { wave: 1.8, rain: 0.8,  wind: 0.80, fog: 0.16, cover: 0.92, dur: [55, 110] },
  storm:  { wave: 3.2, rain: 1.0,  wind: 1.45, fog: 0.22, cover: 1.00, dur: [50, 90] },
  fog:    { wave: 1.0, rain: 0,    wind: 0.12, fog: 0.90, cover: 0.50, dur: [80, 150] },
};

// Cloud parallax layers. Positions are in u (720p px); cells tile an endless strip.
const LAYERS = [
  // a band of small heaped clouds resting on the far horizon
  { id: 0, set: 'far', cell: 240, jit: 0.85, par: 0.010, speed: 1.4, y0: -6, y1: 16, s0: 0.6, s1: 1.2, cMul: 1.0, cAdd: 0.04, seed: 11 },
  // the hero: towering cumulus
  { id: 1, set: 'mid', cell: 540, jit: 0.45, par: 0.026, speed: 3.6, y0: 30, y1: 115, s0: 0.82, s1: 1.15, cMul: 1.0, cAdd: 0.02, seed: 23 },
  // close decks hanging into the top of the frame
  { id: 2, set: 'high', cell: 700, jit: 0.4, par: 0.055, speed: 7.5, y0: 345, y1: 430, s0: 0.95, s1: 1.35, cMul: 0.95, cAdd: -0.2, seed: 37 },
];
const CIRRUS = { cell: 820, par: 0.006, speed: 1.1, seed: 53 };

// ------------------------------------------------------------- color tables
function prep(rows) {
  return rows.map((r) => ({ p: r[0], v: r.slice(1).map((x) => (typeof x === 'string' ? hexToRgb(x) : x)) }));
}
// Sky: zenith, upper, middle, low, horizon
const SKY_KEYS = prep([
  [0.000, '#3a5088', '#6a76a6', '#c08f9c', '#f6b48e', '#ffd596'],
  [0.035, '#4a7cad', '#7ba7c8', '#bccfd6', '#ecdcc2', '#fbe2b6'],
  [0.100, '#4a8cbf', '#7bb5d5', '#a5cfe0', '#d1e4e2', '#f1e6cc'],
  [0.250, '#4186bd', '#75b1d4', '#9fcadf', '#cce3e5', '#eee8d3'],
  [0.440, '#4982b2', '#7daccc', '#a9c8d3', '#d9d8c6', '#f3dbb0'],
  [0.505, '#436e9d', '#7a92b3', '#b6a9b0', '#e6bb99', '#f9ca88'],
  [0.545, '#33477a', '#68608e', '#b07890', '#ea9a7e', '#ffbb6e'],
  [0.565, '#2b3769', '#574e84', '#9c6488', '#d8788a', '#ffa862'],
  [0.600, '#1b2553', '#34396c', '#5f4c7c', '#9a5f7c', '#d77e62'],
  [0.635, '#0e1639', '#1a2451', '#2a335f', '#433d69', '#664d6c'],
  [0.680, '#060b1e', '#0a1431', '#0f1d42', '#162852', '#1f325e'],
  [0.900, '#060b1e', '#0a1431', '#0f1d42', '#162852', '#1f325e'],
  [0.945, '#0b1230', '#172251', '#283062', '#47406e', '#715478'],
  [0.975, '#22305f', '#434c84', '#7a6898', '#c88a96', '#f4a67e'],
]);
// Clouds: shadow, lit, highlight, rim, glow (silver lining), rim strength
const CLOUD_KEYS = prep([
  [0.000, '#5a5683', '#d48f98', '#ffd3a6', '#ffe4c4', '#ffb27a', 0.8],
  [0.035, '#8790b2', '#e3d3cf', '#fff3e4', '#ffffff', '#fff0d0', 0.5],
  [0.100, '#8a9db8', '#dde5ec', '#fffdf8', '#ffffff', '#fff8e8', 0.42],
  [0.250, '#8ea4bd', '#e2eaf1', '#ffffff', '#ffffff', '#ffffff', 0.38],
  [0.440, '#919eb6', '#e6e0d8', '#fff8ea', '#fffaf0', '#fff1d8', 0.45],
  [0.505, '#8682a4', '#dfbfb0', '#ffe8c2', '#fff0d0', '#ffd49a', 0.6],
  [0.545, '#72648e', '#d4989d', '#ffd09e', '#ffdcae', '#ffb070', 0.75],
  [0.565, '#5b4e80', '#c27790', '#f5ab82', '#ffc68e', '#ff9a5c', 0.85],
  [0.600, '#383565', '#785b86', '#c58388', '#eea486', '#e07a5c', 0.6],
  [0.635, '#222a52', '#424a78', '#6e709c', '#a6a2c8', '#9a98c8', 0.6],
  [0.680, '#2a3c66', '#6478a6', '#b4c4de', '#f4f8ff', '#dce8ff', 1.0],
  [0.900, '#2a3c66', '#6478a6', '#b4c4de', '#f4f8ff', '#dce8ff', 1.0],
  [0.945, '#2a3060', '#545688', '#9a8eb4', '#d6c6e4', '#c8b0d8', 0.7],
  [0.975, '#3c3c70', '#93708d', '#e59f8d', '#ffd0b0', '#ffa880', 0.75],
]);
// Far mountains: body, lit slopes, haze at their feet
const MTN_KEYS = prep([
  [0.000, '#5e5b86', '#b98d9b', '#efb59c'],
  [0.060, '#8ea3b8', '#bdcbd4', '#e9e5d4'],
  [0.250, '#86a2b9', '#bacdd8', '#e2e9e6'],
  [0.440, '#8c9db1', '#c6c6c6', '#efdcbc'],
  [0.505, '#8885a5', '#d4ab98', '#f5c99a'],
  [0.565, '#594d7b', '#a8708a', '#ea9c7c'],
  [0.610, '#2a2d5c', '#4b4a7e', '#7a5872'],
  [0.680, '#0f1a42', '#2c4a93', '#1c2d5a'],
  [0.900, '#0f1a42', '#2c4a93', '#1c2d5a'],
  [0.960, '#2a2b5a', '#59578c', '#8f6e8c'],
]);
const STORM_CLOUD = { sh: hexToRgb('#262a32'), lit: hexToRgb('#474e59'), hi: hexToRgb('#737a86'), rim: hexToRgb('#a6b0c2'), glow: hexToRgb('#c8d2ea'), rs: 0.3 };
const SUN_RAMP = [
  [0.00, [255, 92, 56]], [0.06, [255, 132, 74]], [0.15, [255, 190, 122]],
  [0.30, [255, 228, 182]], [0.48, [255, 248, 232]], [1.0, [255, 252, 240]],
];

function sampleKeys(keys, p) {
  const n = keys.length;
  let i1 = 0;
  while (i1 < n && keys[i1].p <= p) i1++;
  const a = keys[(i1 - 1 + n) % n], b = keys[i1 % n];
  let span = b.p - a.p; if (span <= 0) span += 1;
  let d = p - a.p; if (d < 0) d += 1;
  const t = smoothstep(0, 1, d / span);
  const out = new Array(a.v.length);
  for (let j = 0; j < a.v.length; j++) {
    const va = a.v[j], vb = b.v[j];
    out[j] = typeof va === 'number' ? lerp(va, vb, t) : mixColor(va, vb, t);
  }
  return out;
}

// ------------------------------------------------------------- small helpers
const rgbS = (c) => 'rgb(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ')';
const rgbaS = (c, a) => 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + (a <= 0 ? 0 : a >= 1 ? 1 : a.toFixed(3)) + ')';
const luma = (c) => c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11;
const scaleC = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
const unitOf = (v) => clamp((v.cssH || 720) / 720, 0.45, 2.4);
const pmod = (a, m) => ((a % m) + m) % m;
const rnd = (a, b) => a + Math.random() * (b - a);

// Desaturate toward a slightly cool grey and scale brightness.
function grade(c, desat, k) {
  const l = luma(c);
  return [lerp(c[0], l * 0.9, desat) * k, lerp(c[1], l * 1.0, desat) * k, lerp(c[2], l * 1.05, desat) * k];
}

// Integer hash -> [0,1) and 2D value noise (bake time only).
function h2(ix, iy, s) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(s, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vn2(x, y, s) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = h2(ix, iy, s), b = h2(ix + 1, iy, s), c = h2(ix, iy + 1, s), d = h2(ix + 1, iy + 1, s);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
// Periodic 1D value noise (period in lattice cells) for the tiling horizon strip.
function pn1(x, period, seed) {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  const a = hash1(pmod(i, period), seed), b = hash1(pmod(i + 1, period), seed);
  return a + (b - a) * u;
}
function boxBlur(src, w, h, r) {
  const n = src.length, tmp = new Float32Array(n), out = new Float32Array(n);
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[row + (x < 0 ? 0 : x >= w ? w - 1 : x)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc * inv;
      const xa = x + r + 1, xb = x - r;
      acc += src[row + (xa < w ? xa : w - 1)] - src[row + (xb > 0 ? xb : 0)];
    }
  }
  // vertical pass row by row (cache friendly), one running sum per column
  const acc = new Float64Array(w);
  for (let y = -r; y <= r; y++) {
    const row = (y < 0 ? 0 : y >= h ? h - 1 : y) * w;
    for (let x = 0; x < w; x++) acc[x] += tmp[row + x];
  }
  for (let y = 0; y < h; y++) {
    const o = y * w, ya = y + r + 1, yb = y - r;
    const ra = (ya < h ? ya : h - 1) * w, rb = (yb > 0 ? yb : 0) * w;
    for (let x = 0; x < w; x++) { out[o + x] = acc[x] * inv; acc[x] += tmp[ra + x] - tmp[rb + x]; }
  }
  return out;
}
// White canvas whose alpha is the mask (0..1 floats).
function maskCanvas(w, h, arr) {
  const c = makeCanvas(w, h);
  const x = c.getContext('2d');
  const img = x.createImageData(w, h);
  const d = img.data;
  for (let i = 0, j = 0; i < arr.length; i++, j += 4) {
    d[j] = 255; d[j + 1] = 255; d[j + 2] = 255; d[j + 3] = arr[i] * 255;
  }
  x.putImageData(img, 0, 0);
  return c;
}

// ============================================================================
// Baking (once, at first init)
// ============================================================================
const SPR = {
  built: false, scratch: null, sctx: null,
  far: [], mid: [], high: [], cirrus: [], fog: [], shafts: null,
  moon: null, beam: null, glint: null, rays: null, mtnBack: null, mtnFront: null, stars: null,
};
// [set, slot, bake now?, kind, seed, w, h, rim glow]
const CLOUD_JOBS = [
  ['mid', 0, true, 'tower', 101, 640, 440, true], ['far', 0, true, 'far', 606, 360, 130, false], ['high', 0, true, 'deck', 1111, 780, 210, true],
  ['mid', 2, false, 'heap', 303, 620, 300, true], ['mid', 5, false, 'twin', 2121, 700, 430, true], ['high', 1, false, 'deck', 1212, 680, 190, true],
  ['far', 1, false, 'far', 707, 300, 110, false], ['mid', 1, false, 'tower', 202, 560, 410, true], ['mid', 3, false, 'heap', 404, 520, 270, true],
  ['far', 2, false, 'far', 808, 420, 125, false], ['mid', 6, false, 'mound', 2222, 600, 330, true], ['high', 2, false, 'deck', 1313, 860, 230, true],
  ['mid', 4, false, 'heap', 505, 700, 280, true], ['far', 3, false, 'far', 909, 260, 100, false], ['mid', 7, false, 'tower', 2323, 500, 470, true],
];
const BAKE = { queue: [], gen: null };
const tintables = [];
let tintCursor = 0;
let lastSkySig = null;
// Per-cell cloud presence eases toward 0/1 so clouds grow and dissolve over a
// few seconds when the cover changes, and are never left half-transparent.
const cellPres = new Map();
let presFrame = 0, presSnap = true, presStep = 0, lastDrawT = 0;
function cellPresence(key, target) {
  let e = cellPres.get(key);
  if (!e) { e = { p: target, f: presFrame }; cellPres.set(key, e); return target; }
  e.f = presFrame;
  if (presSnap) e.p = target;
  else if (e.p < target) e.p = Math.min(target, e.p + presStep);
  else if (e.p > target) e.p = Math.max(target, e.p - presStep);
  return e.p;
}
function tickPresence() {
  const t = performance.now();
  const dt = lastDrawT ? clamp((t - lastDrawT) / 1000, 0, 0.1) : 0;
  lastDrawT = t;
  presStep = dt / 7;
  presFrame++;
  if (presFrame % 180 === 0) for (const [k, e] of cellPres) if (presFrame - e.f > 90) cellPres.delete(k);
}

// Light set-ups for the cloud bake. 0: high light (day sun, night moon); 1: a low sun to
// the LEFT of the cloud; 2: a low sun to the RIGHT. `l` points toward the light in 3D
// (screen y down, z toward the viewer), `m` is the 2D direction the shadow march takes.
const LIT_A = 0.18, LIT_B = 0.48, HI_A = 0.41, HI_B = 0.7;   // luminance ramps of the cloud masks
const CLOUD_LIGHTS = [
  { l: [-0.27, -0.9, 0.34], m: [-0.27, -0.96] },
  { l: [-0.86, -0.36, 0.36], m: [-0.92, -0.39] },
  { l: [0.86, -0.36, 0.36], m: [0.92, -0.39] },
];

// Silhouette envelope of a cloud: gaussian bumps [centre, width, height] along x.
function cloudBumps(kind, rr, R) {
  const bumps = [];
  if (kind === 'tower') {
    const c = rr(0.42, 0.58);
    bumps.push([c, rr(0.12, 0.16), 1]);
    bumps.push([c + rr(-0.27, -0.18), rr(0.09, 0.13), rr(0.42, 0.6)]);
    bumps.push([c + rr(0.16, 0.27), rr(0.09, 0.13), rr(0.48, 0.68)]);
    bumps.push([c + rr(-0.05, 0.05), rr(0.24, 0.3), rr(0.28, 0.36)]);
  } else if (kind === 'twin') {
    const a = rr(0.27, 0.35), b = rr(0.62, 0.7);
    bumps.push([a, rr(0.1, 0.13), 1], [b, rr(0.09, 0.12), rr(0.6, 0.76)], [(a + b) / 2, rr(0.2, 0.26), rr(0.3, 0.38)]);
    bumps.push([a - rr(0.13, 0.18), rr(0.06, 0.09), rr(0.3, 0.42)], [b + rr(0.13, 0.18), rr(0.06, 0.09), rr(0.26, 0.38)]);
  } else if (kind === 'mound') {
    bumps.push([rr(0.45, 0.55), rr(0.16, 0.2), 1], [rr(0.24, 0.31), rr(0.09, 0.12), rr(0.5, 0.64)], [rr(0.69, 0.77), rr(0.09, 0.12), rr(0.46, 0.62)]);
    bumps.push([0.5, 0.36, 0.3]);
  } else if (kind === 'heap') {
    const n = 3 + ((R() * 2) | 0);
    for (let i = 0; i < n; i++) bumps.push([rr(0.2, 0.8), rr(0.08, 0.15), rr(0.45, 1)]);
    bumps.push([0.5, 0.3, 0.3]);
  } else if (kind === 'far') {
    const n = 2 + ((R() * 3) | 0);
    for (let i = 0; i < n; i++) bumps.push([rr(0.2, 0.8), rr(0.07, 0.16), rr(0.45, 1)]);
    bumps.push([0.5, 0.3, 0.3]);
  } else { // deck
    const n = 6 + ((R() * 4) | 0);
    for (let i = 0; i < n; i++) bumps.push([rr(0.1, 0.9), rr(0.05, 0.1), rr(0.4, 1)]);
    bumps.push([0.5, 0.4, 0.45]);
  }
  return bumps;
}

// Blur of `val` weighted by coverage, so edges keep their own value instead of fading
// toward the empty sky around them.
function coverageBlur(val, cov, w, h, r) {
  const n = val.length, vw = new Float32Array(n);
  for (let i = 0; i < n; i++) vw[i] = val[i] * cov[i];
  const a = boxBlur(boxBlur(vw, w, h, r), w, h, r), c = boxBlur(boxBlur(cov, w, h, r), w, h, r);
  for (let i = 0; i < n; i++) a[i] = c[i] > 1e-4 ? a[i] / c[i] : 0;
  return a;
}

// A cumulus cloud from many overlapping, slightly lumpy lobes. Their normals are blended
// with a soft-max on depth (no hard seams between lobes), lit by a half-lambert term times
// the light that survives a march through the cloud mass toward the light. Masks for three
// light directions (high, low-left, low-right) are kept as bytes and tinted on the CPU.
function* bakeCloudGen(kind, seed, wU, hU, withRimC) {
  const w = Math.round(wU * RS), h = Math.round(hU * RS);
  const R = seeded(seed);
  const rr = (a, b) => a + (b - a) * R();
  const deck = kind === 'deck';
  const base = h * (deck ? 0.78 : 0.86);
  const maxThick = base - h * 0.04;

  const bumps = cloudBumps(kind, rr, R);
  const thick = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const fx = x / w;
    let e = 0;
    for (const b of bumps) { const d = (fx - b[0]) / b[1]; const v = b[2] * Math.exp(-d * d); e = e + v - e * v; }
    const taper = smoothstep(0.03, 0.2, fx) * smoothstep(0.97, 0.8, fx);
    thick[x] = maxThick * Math.min(1, e) * taper * (0.88 + 0.24 * noise1(x * 0.025, seed));
  }
  const thickAt = (x) => thick[clamp(x | 0, 0, w - 1)];
  const minR = Math.max(3, h * 0.025);
  const maxR = h * (kind === 'tower' || kind === 'twin' ? 0.19 : deck ? 0.3 : 0.24);
  const x0 = w * 0.06, x1 = w * 0.94;
  const lobes = [];
  // lobe sizes vary in patches, and every lobe is a little lumpy (not a perfect ball)
  const jit = (x, y) => 0.78 + 0.44 * vn2(x * 0.04, y * 0.04, seed + 31);
  const lobe = (x, y, r, z, tone, surf) => {
    const a2 = rr(0.02, 0.07), a3 = rr(0.015, 0.05), a5 = rr(0.01, 0.035);
    const p2 = rr(0, TAU), p3 = rr(0, TAU), p5 = rr(0, TAU);
    lobes.push({
      x, y, r, z, tone, surf,
      c2: a2 * Math.cos(p2), s2: a2 * Math.sin(p2), c3: a3 * Math.cos(p3), s3: a3 * Math.sin(p3),
      c5: a5 * Math.cos(p5), s5: a5 * Math.sin(p5), wm: a2 + a3 + a5,
    });
  };
  // surface billows that make the silhouette
  for (let x = x0; x < x1;) {
    const t = thickAt(x);
    if (t < minR * 1.5) { x += minR; continue; }
    const r = clamp(t * rr(0.2, 0.34) * jit(x, base - t), minR, maxR);
    const cx = x + rr(-0.2, 0.2) * r;
    lobe(cx, base - thickAt(cx) + r * rr(0.82, 1.0), r, rr(0, 0.15) * t, rr(-0.05, 0.05), true);
    x += r * rr(0.62, 0.95);
  }
  // body lobes: lower ones sit in front, which stacks the cauliflower
  const nBody = Math.round((w * h) / (maxR * maxR) * 0.8);
  for (let i = 0; i < nBody; i++) {
    const cx = rr(x0, x1), t = thickAt(cx);
    if (t < minR * 2) continue;
    const top = base - t;
    const r = clamp(t * rr(0.24, 0.42), minR, maxR * 1.05);
    const cy = rr(top + r * 1.15, base - r * 0.1);
    const depth = (cy - top) / t;
    lobe(cx, cy, clamp(r * jit(cx, cy), minR, maxR * 1.05), depth * t * 0.55 + rr(0, 0.12) * t, rr(-0.06, 0.04), false);
  }
  // flat base row
  for (let x = x0; x < x1;) {
    const t = thickAt(x);
    const r = clamp(t * rr(0.25, 0.4), minR, maxR);
    if (t > minR) lobe(x, base - r * 0.35, r, t * rr(0.4, 0.6), -0.04, false);
    x += r * rr(0.8, 1.2);
  }
  // cauliflower detail on the billows
  const nSurf = lobes.length;
  for (let i = 0; i < nSurf; i++) {
    const L = lobes[i];
    if (!L.surf) continue;
    const n = 3 + ((R() * 3) | 0);
    for (let k = 0; k < n; k++) {
      const a = rr(-Math.PI * 0.95, -Math.PI * 0.05);
      const d = L.r * rr(0.6, 0.88);
      lobe(L.x + Math.cos(a) * d, L.y + Math.sin(a) * d, Math.max(2, L.r * rr(0.2, 0.42)), L.z + L.r * 0.5, rr(-0.02, 0.06), false);
    }
  }

  yield;
  // rasterize in one pass: coverage, the front-most lobe, and a soft-max (online log-sum-exp
  // over depth) blend of the lobe normals so lobes melt into each other without seams
  const N = w * h;
  const zb = new Float32Array(N).fill(-1e9);
  const idb = new Int32Array(N).fill(-1);
  const cov = new Float32Array(N);
  const sW = new Float32Array(N), sX = new Float32Array(N), sY = new Float32Array(N), sZ = new Float32Array(N);
  const invKz = 1 / Math.max(1.5, maxR * 0.08);
  for (let li = 0; li < lobes.length; li++) {
    if ((li & 31) === 31) yield;
    const L = lobes[li];
    const lx = L.x, ly = L.y, lr = L.r, lz = L.z, ir = 1 / lr;
    const k2c = L.c2, k2s = L.s2, k3c = L.c3, k3s = L.s3, k5c = L.c5, k5s = L.s5;
    const R1 = lr * (1 + L.wm) + 1, R12 = R1 * R1;
    const xa = Math.max(0, Math.floor(lx - R1)), xb = Math.min(w - 1, Math.ceil(lx + R1));
    const ya = Math.max(0, Math.floor(ly - R1)), yb = Math.min(h - 1, Math.ceil(ly + R1));
    for (let y = ya; y <= yb; y++) {
      const dy = y + 0.5 - ly;
      for (let x = xa; x <= xb; x++) {
        const dx = x + 0.5 - lx;
        const d2 = dx * dx + dy * dy;
        if (d2 >= R12) continue;
        const d = Math.sqrt(d2);
        let rad = lr;
        if (d > 1e-3) {
          const id = 1 / d, c = dx * id, s = dy * id;
          const c2 = c * c - s * s, s2 = 2 * s * c;
          const c3 = c * (4 * c * c - 3), s3 = s * (3 - 4 * s * s);
          const c4 = c2 * c2 - s2 * s2, s4 = 2 * s2 * c2;
          rad *= 1 + k2c * c2 + k2s * s2 + k3c * c3 + k3s * s3 + k5c * (c4 * c - s4 * s) + k5s * (s4 * c + c4 * s);
        }
        const e = rad - d + 0.5;
        if (e <= 0) continue;
        const i = y * w + x;
        if (e > cov[i]) cov[i] = e > 1 ? 1 : e;
        if (d >= rad) continue;
        const hz = Math.sqrt(rad * rad - d2), z = lz + hz;
        const nx = dx * ir, ny = dy * ir, nz = hz * ir;
        const m = zb[i];
        if (z > m) {
          const sc = m > -1e8 ? Math.exp((m - z) * invKz) : 0;
          sW[i] = sW[i] * sc + 1; sX[i] = sX[i] * sc + nx; sY[i] = sY[i] * sc + ny; sZ[i] = sZ[i] * sc + nz;
          zb[i] = z; idb[i] = li;
        } else {
          const wt = Math.exp((z - m) * invKz);
          if (wt < 0.004) continue;
          sW[i] += wt; sX[i] += wt * nx; sY[i] += wt * ny; sZ[i] += wt * nz;
        }
      }
    }
  }
  yield;
  // close pinholes between lobes, which would let the sky show through the cloud
  {
    const cb = boxBlur(boxBlur(cov, w, h, 3), w, h, 2);
    for (let i = 0; i < N; i++) {
      const c = cb[i];
      if (c > 0.55 && cov[i] < 1) { const f = smoothstep(0.55, 0.82, c); if (f > cov[i]) cov[i] = f; }
    }
  }
  // per-column top (for the belly / depth terms)
  const colTop = new Float32Array(w);
  let cloudTop = h;
  for (let x = 0; x < w; x++) {
    let t = base;
    for (let y = 0; y < h; y++) if (cov[y * w + x] > 0.5) { t = y; break; }
    colTop[x] = t;
    if (t < cloudTop) cloudTop = t;
  }
  const colTopS = boxBlur(colTop, w, 1, Math.max(2, Math.round(maxR * 0.35)));
  const covS = boxBlur(cov, w, h, 1);                       // soft outline, no stair steps when scaled
  const covB = boxBlur(boxBlur(covS, w, h, 3), w, h, 3);    // the band just inside the silhouette
  // large-scale volume: a heavily blurred silhouette gives a "pillow" normal that holds the
  // lobes together into one mass
  const gb = Math.max(3, Math.round(maxR * 0.5));
  const covL = boxBlur(boxBlur(cov, w, h, gb), w, h, gb);
  const gk = gb * 2.4;
  const span = Math.max(1, base - cloudTop);
  yield;
  // creases: where a lobe sits deeper than its neighbours it is tucked under them (soft AO)
  const zf = new Float32Array(N);
  for (let i = 0; i < N; i++) zf[i] = idb[i] >= 0 ? zb[i] : 0;
  const zAvg = coverageBlur(zf, cov, w, h, Math.max(2, Math.round(maxR * 0.25)));
  const creaseK = 1 / Math.max(2, maxR * 0.4);

  yield;
  // low-resolution helpers: light that survives the trip through the cloud toward each
  // light (a short march through the coverage), and smooth noise for the painterly wobble
  const f = 3, lw = Math.ceil(w / f), lh = Math.ceil(h / f), nLo = lw * lh;
  const covLo = new Float32Array(nLo);
  const inv9 = 1 / (f * f);
  for (let y = 0; y < h; y++) {
    const ro = ((y / f) | 0) * lw, row = y * w;
    for (let x = 0; x < w; x++) covLo[ro + ((x / f) | 0)] += cov[row + x] * inv9;
  }
  const dScale = Math.max(3, (h * 0.26) / f), stepL = 1.5;
  const trans = CLOUD_LIGHTS.map((Lt) => {
    const T = new Float32Array(nLo).fill(1);
    const M = Math.min(60, Math.ceil((dScale * 3) / stepL)), mx = Lt.m[0] * stepL, my = Lt.m[1] * stepL;
    for (let y = 0; y < lh; y++) {
      for (let x = 0; x < lw; x++) {
        const k = y * lw + x;
        if (covLo[k] <= 0) continue;
        let px = x + 0.5, py = y + 0.5, s = covLo[k] * 0.5;
        for (let j = 0; j < M; j++) {
          px += mx; py += my;
          if (px < 0 || py < 0 || px >= lw || py >= lh) break;
          s += covLo[(py | 0) * lw + (px | 0)];
        }
        T[k] = Math.exp((-s * stepL) / dScale);
      }
    }
    return T;
  });
  const nfq = f / (maxR * 0.45);
  const noiseLo = [new Float32Array(nLo), new Float32Array(nLo), new Float32Array(nLo)];
  for (let y = 0; y < lh; y++) {
    for (let x = 0; x < lw; x++) {
      const k = y * lw + x;
      noiseLo[0][k] = vn2(x * nfq, y * nfq, seed) - 0.5;
      noiseLo[1][k] = vn2(x * nfq + 17.3, y * nfq + 5.1, seed + 3) - 0.5;
      noiseLo[2][k] = vn2(x * f * 0.06, y * f * 0.035, seed + 9) - 0.5;
    }
  }
  const invf = 1 / f;
  const lo = (T, x, y) => {
    let fx = (x + 0.5) * invf - 0.5, fy = (y + 0.5) * invf - 0.5;
    fx = fx < 0 ? 0 : fx > lw - 1.001 ? lw - 1.001 : fx;
    fy = fy < 0 ? 0 : fy > lh - 1.001 ? lh - 1.001 : fy;
    const ix = fx | 0, iy = fy | 0, tx = fx - ix, ty = fy - iy, k = iy * lw + ix;
    const k1 = ix + 1 < lw ? k + 1 : k, k2 = iy + 1 < lh ? k + lw : k, k3 = ix + 1 < lw ? k2 + 1 : k2;
    const a = T[k] + (T[k1] - T[k]) * tx, b = T[k2] + (T[k3] - T[k2]) * tx;
    return a + (b - a) * ty;
  };

  yield;
  // shade
  const lum = [new Float32Array(N), new Float32Array(N), new Float32Array(N)];
  const rimF = [new Float32Array(N), new Float32Array(N), new Float32Array(N)];
  const LL = CLOUD_LIGHTS;
  for (let y = 0; y < h; y++) {
    if ((y & 15) === 15) yield;
    const yu = Math.max(0, y - 1) * w, yd = Math.min(h - 1, y + 1) * w, row = y * w;
    const vy = (y - cloudTop) / span;
    const belly = smoothstep(0.5, 1.05, vy);
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (cov[i] <= 0) continue;
      const xl = row + (x > 0 ? x - 1 : 0), xr = row + (x < w - 1 ? x + 1 : x);
      let nx = 0, ny = 0, nz = 1;
      if (sW[i] > 0) { const q = 1 / sW[i]; nx = sX[i] * q; ny = sY[i] * q; nz = sZ[i] * q; }
      const gx = -(covL[xr] - covL[xl]) * gk, gy = -(covL[yd + x] - covL[yu + x]) * gk;
      const gl = 1 / Math.sqrt(gx * gx + gy * gy + 1);
      nx = nx * 0.5 + gx * gl * 0.5 + lo(noiseLo[0], x, y) * 0.45;
      ny = ny * 0.5 + gy * gl * 0.5 + lo(noiseLo[1], x, y) * 0.35;
      nz = nz * 0.5 + gl * 0.5;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz + 1e-6);
      nx *= inv; ny *= inv; nz *= inv;
      const depth = clamp((y - colTopS[x]) / span, 0, 1);
      const crease = idb[i] >= 0 ? clamp((zAvg[i] - zb[i]) * creaseK, 0, 1) : 0;
      const shade = (1 - 0.16 * smoothstep(0.15, 0.9, depth)) * (1 - 0.32 * crease);
      const tone = (idb[i] >= 0 ? lobes[idb[i]].tone * 0.5 : 0) + lo(noiseLo[2], x, y) * 0.1;
      // silhouette band and which way it faces
      const edge = smoothstep(0.05, 0.56, 1 - covB[i]);
      let ox = 0, oy = 0;
      if (edge > 0.002) {
        ox = covB[xl] - covB[xr]; oy = covB[yu + x] - covB[yd + x];
        const ol = Math.sqrt(ox * ox + oy * oy);
        if (ol > 1e-6) { ox /= ol; oy /= ol; } else { ox = 0; oy = 0; }
      }
      for (let v = 0; v < 3; v++) {
        const Lt = LL[v];
        const T = lo(trans[v], x, y);
        const lam = nx * Lt.l[0] + ny * Lt.l[1] + nz * Lt.l[2];
        const l = (0.5 + 0.5 * lam) * (0.3 + 0.7 * T) * (1 - (v ? 0.22 : 0.3) * belly) * shade;
        lum[v][i] = l + tone;
        if (edge > 0.002) {
          const face = (ox * Lt.m[0] + oy * Lt.m[1]) * 1.25 + 0.05;
          if (face > 0) rimF[v][i] = edge * (face > 1 ? 1 : face) * (0.3 + 0.7 * T) * (1 - 0.8 * belly);
        }
      }
    }
  }
  yield;
  const body = new Uint8Array(N);
  const fadeA = base - h * (deck ? 0.14 : 0.09), fadeB = base + h * 0.08;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (covS[i] <= 0) continue;
      const n = (vn2(x * 0.03, y * 0.02, seed + 21) - 0.5) * h * 0.16;
      body[i] = 255 * covS[i] * (1 - smoothstep(fadeA, fadeB, y + n));
    }
  }
  const lit = [], hi = [], rim = [];
  const covW = boxBlur(boxBlur(cov, w, h, 2), w, h, 2);
  for (let v = 0; v < 3; v++) {
    yield;
    const lv = lum[v];
    for (let i = 0; i < N; i++) lv[i] *= cov[i];
    const lb = boxBlur(boxBlur(lv, w, h, 2), w, h, 2), rf = rimF[v];
    const L8 = new Uint8Array(N), H8 = new Uint8Array(N), R8 = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (!body[i]) continue;
      const l = covW[i] > 1e-4 ? lb[i] / covW[i] : 0;
      L8[i] = 255 * smoothstep(LIT_A, LIT_B, l);
      H8[i] = 255 * smoothstep(HI_A, HI_B, l);
      R8[i] = 255 * (rf[i] > 1 ? 1 : rf[i]);
    }
    lit.push(L8); hi.push(H8); rim.push(R8);
  }
  const spr = {
    w, h, baseFrac: base / h, kind, body, lit, hi, rim, sideK: 0,
    img: new ImageData(w, h),
    tinted: [makeCanvas(w, h), makeCanvas(w, h)],
    rimC: withRimC ? [makeCanvas(w, h), makeCanvas(w, h)] : null,
  };
  spr.tctx = spr.tinted.map((c) => c.getContext('2d'));
  spr.rctx = spr.rimC ? spr.rimC.map((c) => c.getContext('2d')) : null;
  return spr;
}

function bakeCloud(kind, seed, wU, hU, withRimC) {
  const g = bakeCloudGen(kind, seed, wU, hU, withRimC);
  let r;
  do { r = g.next(); } while (!r.done);
  return r.value;
}

// Coverage (0..1) of a cloud sprite at a fractional position inside it.
function cloudBodyAt(spr, fx, fy) {
  if (!(fx >= 0 && fy >= 0 && fx < 1 && fy < 1)) return 0;
  return spr.body[((fy * spr.h) | 0) * spr.w + ((fx * spr.w) | 0)] / 255;
}

// Thin high cirrus streaks.
function bakeCirrus(seed, wU, hU) {
  const sc = 0.6;
  const w = Math.round(wU * sc), h = Math.round(hU * sc);
  const c = makeCanvas(w, h), x = c.getContext('2d');
  const R = seeded(seed);
  x.fillStyle = '#fff';
  const nVeil = 7 + ((R() * 4) | 0);
  for (let s = 0; s < nVeil; s++) {
    const y0 = h * (0.28 + 0.44 * R()), xs = w * R() * 0.35, len = w * (0.3 + 0.45 * R());
    const bend = h * (R() - 0.5) * 0.5, th = 3 + R() * 6, slant = (R() - 0.5) * 0.16;
    const path = (t) => {
      const px = xs + t * len;
      return [px, y0 + Math.sin(t * Math.PI) * bend + t * len * slant + (noise1(px * 0.02, seed + s) - 0.5) * 10];
    };
    // the soft veil
    const steps = Math.ceil(len / 3);
    for (let j = 0; j < steps; j++) {
      const t = j / steps, [px, py] = path(t);
      const env = Math.pow(Math.sin(t * Math.PI), 1.4);
      x.globalAlpha = env * 0.03 * (0.3 + 0.7 * noise1(px * 0.025, s + 7));
      x.beginPath();
      x.ellipse(px, py, th * 3.2, th * (0.6 + 0.5 * noise1(px * 0.04, s)), slant, 0, TAU);
      x.fill();
    }
    // fine fibres combed along it
    const fib = 5 + ((R() * 6) | 0);
    for (let f = 0; f < fib; f++) {
      const o = (R() - 0.5) * th * 1.6, f0 = R() * 0.4, f1 = f0 + 0.3 + R() * 0.5;
      for (let j = 0; j < steps; j++) {
        const t = j / steps;
        if (t < f0 || t > f1) continue;
        const [px, py] = path(t);
        const env = Math.sin(((t - f0) / (f1 - f0)) * Math.PI);
        x.globalAlpha = env * 0.05 * noise1(px * 0.06, s * 13 + f);
        x.beginPath();
        x.ellipse(px, py + o + (t - f0) * th * 2 * (R() < 0.5 ? 1 : 0), 6, 0.7, slant, 0, TAU);
        x.fill();
      }
    }
  }
  x.globalAlpha = 1;
  const spr = { w, h, sc, body: c, tinted: makeCanvas(w, h) };
  spr.tctx = spr.tinted.getContext('2d');
  return spr;
}

// Soft fog bank that tiles horizontally.
function bakeFog(seed, wU, hU) {
  const sc = 0.5;
  const w = Math.round(wU * sc), h = Math.round(hU * sc);
  const c = makeCanvas(w, h), x = c.getContext('2d');
  const R = seeded(seed);
  for (let i = 0; i < 90; i++) {
    const bx = R() * w, by = h * (0.5 + (R() - 0.5) * 0.38);
    const r = Math.min((18 + R() * 46) * (1 - Math.abs(by / h - 0.5)), by * 0.95, (h - by) * 0.95);
    const a = 0.06 + R() * 0.1;
    for (const ox of [-w, 0, w]) {
      const cx = bx + ox;
      if (cx + r * 3.5 < 0 || cx - r * 3.5 > w) continue;
      x.save();
      x.translate(cx, by);
      x.scale(3.4, 1);
      const g = x.createRadialGradient(0, 0, 0, 0, 0, r);
      g.addColorStop(0, 'rgba(255,255,255,' + a + ')');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = g;
      x.fillRect(-r, -r, r * 2, r * 2);
      x.restore();
    }
  }
  const spr = { w, h, sc, body: c, tinted: makeCanvas(w, h) };
  spr.tctx = spr.tinted.getContext('2d');
  return spr;
}

// Distant rain shafts hanging from cloud bases.
function bakeShafts() {
  const w = 90, h = 220;
  const c = makeCanvas(w, h), x = c.getContext('2d');
  const R = seeded(808);
  for (let i = 0; i < 70; i++) {
    const px = w * (0.15 + 0.7 * R()), lw = 1 + R() * 4;
    const g = x.createLinearGradient(0, 0, 0, h);
    const a = 0.04 + R() * 0.07;
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.15 + R() * 0.15, 'rgba(255,255,255,' + a + ')');
    g.addColorStop(0.75 + R() * 0.2, 'rgba(255,255,255,' + a * 0.8 + ')');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    x.strokeStyle = g;
    x.lineWidth = lw;
    x.beginPath();
    x.moveTo(px, 0);
    x.lineTo(px - 10 - R() * 8, h);
    x.stroke();
  }
  const spr = { w, h, body: c, tinted: makeCanvas(w, h) };
  spr.tctx = spr.tinted.getContext('2d');
  return spr;
}

// Thin crescent moon with halo (lit limb lower-left, like the reference still).
function bakeMoon() {
  const r = 30, size = r * 12;
  const c = makeCanvas(size, size), x = c.getContext('2d');
  const halo = makeCanvas(size, size), hx = halo.getContext('2d');
  const cx = size / 2, cy = size / 2;
  // night-only halo and earthshine live on their own sprite
  let g = hx.createRadialGradient(cx, cy, r * 0.8, cx, cy, size / 2);
  g.addColorStop(0, 'rgba(210,222,255,0.30)');
  g.addColorStop(0.16, 'rgba(175,198,255,0.12)');
  g.addColorStop(0.45, 'rgba(140,170,240,0.04)');
  g.addColorStop(1, 'rgba(120,150,230,0)');
  hx.fillStyle = g;
  hx.fillRect(0, 0, size, size);
  hx.fillStyle = 'rgba(120,140,190,0.13)';
  hx.beginPath(); hx.arc(cx, cy, r * 0.985, 0, TAU); hx.fill();

  const ms = Math.ceil(r * 3), mc = ms / 2;
  const m = makeCanvas(ms, ms), mx = m.getContext('2d');
  g = mx.createRadialGradient(mc - r * 0.35, mc + r * 0.3, r * 0.1, mc, mc, r);
  g.addColorStop(0, '#fffae2');
  g.addColorStop(0.65, '#f5eac4');
  g.addColorStop(1, '#ddcd9c');
  mx.fillStyle = g;
  mx.beginPath(); mx.arc(mc, mc, r, 0, TAU); mx.fill();
  // faint maria
  const R = seeded(5);
  for (let i = 0; i < 7; i++) {
    mx.fillStyle = 'rgba(170,160,130,' + (0.06 + R() * 0.07) + ')';
    mx.beginPath();
    mx.arc(mc + (R() - 0.6) * r * 1.2, mc + (R() - 0.3) * r * 1.1, r * (0.12 + R() * 0.2), 0, TAU);
    mx.fill();
  }
  // carve the crescent with a soft terminator
  mx.globalCompositeOperation = 'destination-out';
  const ox = mc + r * 0.47, oy = mc - r * 0.37, orr = r * 0.98;
  g = mx.createRadialGradient(ox, oy, orr * 0.9, ox, oy, orr * 1.05);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  mx.fillStyle = g;
  mx.beginPath(); mx.arc(ox, oy, orr * 1.06, 0, TAU); mx.fill();
  mx.globalCompositeOperation = 'source-over';

  x.save();
  x.shadowColor = 'rgba(255,240,205,0.85)';
  x.shadowBlur = r * 0.9;
  x.drawImage(m, cx - mc, cy - mc);
  x.restore();
  x.drawImage(m, cx - mc, cy - mc);
  return { c, halo, r, size, disc: m };
}

// The far lighthouse beam: a warm cone, feathered across its width, fading along its length.
// Drawn additively after the lighting pass. Length runs along x (lamp at x = 0).
function bakeBeam() {
  const w = 256, h = 64, c = makeCanvas(w, h), g = c.getContext('2d');
  const img = g.createImageData(w, h), d = img.data;
  for (let y = 0; y < h; y++) {
    const yy = (y + 0.5) / h * 2 - 1;
    for (let x = 0; x < w; x++) {
      const t = (x + 0.5) / w;
      const half = 0.07 + 0.93 * t;                       // the cone widens away from the lamp
      const q = yy / half;
      const along = Math.pow(1 - t, 1.3) * (0.45 + 0.55 * Math.exp(-t * 5));
      const core = Math.exp(-q * q * 2.6);
      const a = along * core;
      // warm white along the axis near the lamp, amber toward the soft edges and the far end
      const k = core * (1 - 0.6 * t);
      const i = (y * w + x) * 4;
      d[i] = 255; d[i + 1] = 160 + 70 * k; d[i + 2] = 78 + 104 * k * k;
      d[i + 3] = 255 * clamp(a, 0, 1);
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

function bakeGlint() {
  const s = 32, c = makeCanvas(s, s), x = c.getContext('2d'), m = s / 2;
  let g = x.createRadialGradient(m, m, 0, m, m, m);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.12, 'rgba(235,242,255,0.8)');
  g.addColorStop(0.35, 'rgba(190,210,255,0.16)');
  g.addColorStop(1, 'rgba(190,210,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, s, s);
  x.globalCompositeOperation = 'lighter';
  for (const [dx, dy] of [[1, 0], [0, 1]]) {
    g = dx ? x.createLinearGradient(0, m, s, m) : x.createLinearGradient(m, 0, m, s);
    g.addColorStop(0, 'rgba(220,230,255,0)');
    g.addColorStop(0.5, 'rgba(240,245,255,0.75)');
    g.addColorStop(1, 'rgba(220,230,255,0)');
    x.fillStyle = g;
    if (dx) x.fillRect(0, m - 0.6, s, 1.2); else x.fillRect(m - 0.6, 0, 1.2, s);
  }
  return c;
}

// Fan of soft crepuscular rays (warm white), drawn around a low sun.
function bakeRays() {
  const S = 512, c = makeCanvas(S, S), x = c.getContext('2d'), m = S / 2;
  const R = seeded(99);
  for (let i = 0; i < 26; i++) {
    const a = R() * TAU, wd = 0.015 + R() * 0.05;
    const g = x.createRadialGradient(m, m, S * 0.04, m, m, m);
    const al = 0.05 + R() * 0.12;
    g.addColorStop(0, 'rgba(255,240,210,0)');
    g.addColorStop(0.12, 'rgba(255,240,210,' + al + ')');
    g.addColorStop(0.55, 'rgba(255,236,200,' + al * 0.45 + ')');
    g.addColorStop(1, 'rgba(255,236,200,0)');
    x.fillStyle = g;
    x.beginPath();
    x.moveTo(m, m);
    x.arc(m, m, m, a - wd, a + wd);
    x.closePath();
    x.fill();
  }
  return c;
}

// Distant mountains and sea stacks on a horizontally tiling strip.
function bakeMountains() {
  const w = MTN_W, h = MTN_H;
  const R = seeded(4242);
  const back = new Float32Array(w), front = new Float32Array(w);
  const clusters = [];
  for (let x = 60; x < w - 220;) {
    const cw = 170 + R() * 430;
    clusters.push({ c: x + cw / 2, hw: cw / 2, h: 26 + R() * 64, sharp: 0.6 + R() * 1.2 });
    x += cw + 170 + R() * 420;
  }
  for (let i = 0; i < w; i++) {
    let hb = 0;
    for (const cl of clusters) {
      let dx = i - cl.c; dx -= Math.round(dx / w) * w;
      const t = Math.abs(dx) / cl.hw;
      if (t >= 1) continue;
      const env = Math.pow(1 - t * t, 1.25);
      const ridge = Math.pow(1 - Math.abs(pn1(i / 60, w / 60, 3) * 2 - 1), cl.sharp);
      const v = env * (0.5 * ridge + 0.36 * pn1(i / 120, w / 120, 5) + 0.14 * pn1(i / 12, w / 12, 8)) * cl.h * 1.3;
      hb = Math.max(hb, v);
    }
    back[i] = hb;
  }
  // front: sea stacks and low islets
  const put = (i, v) => { const k = pmod(Math.round(i), w); if (v > front[k]) front[k] = v; };
  for (let fx = 180 + R() * 200; fx < w - 60;) {
    if (R() < 0.55) {
      const n = 1 + ((R() * 3) | 0);
      for (let k = 0; k < n; k++) {
        const c = fx + k * (12 + R() * 18), hw = 3 + R() * 8, hh = 10 + R() * 30, lean = (R() - 0.5) * 0.5;
        for (let i = Math.floor(c - hw - 2); i <= c + hw + 2; i++) {
          const t = Math.abs(i - c) / hw;
          if (t >= 1) continue;
          put(i, hh * (1 - Math.pow(t, 4)) * (0.82 + 0.18 * pn1(i / 4, w / 4, 11)) * (1 + lean * (i - c) / hw * 0.3));
        }
      }
    } else {
      const hw = 40 + R() * 100, hh = 4 + R() * 10, c = fx + hw;
      for (let i = Math.floor(c - hw); i <= c + hw; i++) {
        const t = Math.abs(i - c) / hw;
        if (t >= 1) continue;
        put(i, hh * Math.pow(1 - t * t, 0.8) * (0.75 + 0.25 * pn1(i / 10, w / 10, 13)));
      }
    }
    fx += 240 + R() * 560;
  }
  const mk = (H, litFn) => {
    const body = new Float32Array(w * h), lit = new Float32Array(w * h);
    for (let i = 0; i < w; i++) {
      const hh = H[i];
      if (hh < 0.3) continue;
      const top = h - hh;
      const slope = (H[(i + 1) % w] - H[(i - 1 + w) % w]) * 0.5;
      for (let y = Math.max(0, Math.floor(top)); y < h; y++) {
        const a = clamp(y + 1 - top, 0, 1);
        const k = y * w + i;
        body[k] = a;
        lit[k] = litFn(i, y, y - top, slope);
      }
    }
    return { body: maskCanvas(w, h, body), lit: maskCanvas(w, h, lit) };
  };
  const bk = mk(back, (i, y, depth, slope) => {
    const streak = vn2(i * 0.32, y * 0.04, 5);
    let l = smoothstep(-0.12, 0.5, slope + (streak - 0.5) * 0.8) * (1 - 0.8 * smoothstep(3, 44, depth));
    return Math.max(l, (1 - smoothstep(0, 2.4, depth)) * 0.6);
  });
  const fr = mk(front, (i, y, depth, slope) => (1 - smoothstep(0, 2, depth)) * 0.7 + smoothstep(0, 0.8, slope) * 0.25 * (1 - smoothstep(2, 14, depth)));
  const strip = (m, hts) => { const s = { w, h, hts, body: m.body, lit: m.lit, tinted: makeCanvas(w, h) }; s.tctx = s.tinted.getContext('2d'); return s; };
  return { back: strip(bk, back), front: strip(fr, front) };
}

// Star field (depends on the screen size; rebuilt on resize).
function ensureStarField(v, u) {
  const key = v.cssW + 'x' + v.cssH + 'x' + v.dpr;
  if (SPR.stars && SPR.stars.key === key) return SPR.stars;
  const w = Math.ceil(v.cssW * 1.2), h = Math.ceil(SKY_REF * u * 1.05);
  const d = clamp(v.dpr || 1, 1, 2);
  const c = makeCanvas(w * d, h * d), x = c.getContext('2d');
  x.scale(d, d);
  const R = seeded(31337);
  const gauss = () => (R() + R() + R() + R() - 2) / 2;
  // milky band, from low on the left up to the right
  const bx0 = w * 0.06, by0 = h * 0.98, bx1 = w * 0.94, by1 = h * 0.04;
  const bl = Math.hypot(bx1 - bx0, by1 - by0), ux = (bx1 - bx0) / bl, uy = (by1 - by0) / bl, px = -uy, py = ux;
  for (let i = 0; i < 120; i++) {
    const t = R(), off = gauss() * 64 * u;
    const cx = bx0 + ux * bl * t + px * off, cy = by0 + uy * bl * t + py * off;
    const r = (50 + R() * 110) * u;
    const g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
    const warm = R() < 0.3;
    g.addColorStop(0, warm ? 'rgba(205,185,225,0.06)' : 'rgba(155,175,240,0.06)');
    g.addColorStop(1, 'rgba(140,160,230,0)');
    x.fillStyle = g;
    x.fillRect(cx - r, cy - r, r * 2, r * 2);
  }
  x.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 26; i++) {
    const t = R(), off = gauss() * 14 * u + 10 * u;
    const cx = bx0 + ux * bl * t + px * off, cy = by0 + uy * bl * t + py * off;
    const r = (14 + R() * 34) * u;
    const g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, 'rgba(0,0,0,0.35)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g;
    x.fillRect(cx - r, cy - r, r * 2, r * 2);
  }
  x.globalCompositeOperation = 'source-over';
  const cols = ['230,236,255', '205,220,255', '255,240,220', '255,226,200', '220,230,255'];
  for (let i = 0; i < 2600; i++) {
    const t = R(), off = gauss() * 54 * u;
    const sx = bx0 + ux * bl * t + px * off, sy = by0 + uy * bl * t + py * off;
    const s = (0.6 + R() * 0.7) * Math.max(0.8, u);
    x.fillStyle = 'rgba(' + cols[(R() * cols.length) | 0] + ',' + (0.22 + R() * 0.5).toFixed(2) + ')';
    x.fillRect(sx, sy, s, s);
  }
  for (let i = 0; i < 1100; i++) {
    const sx = R() * w, sy = h * Math.pow(R(), 1.1);
    const s = (0.8 + R() * 0.9) * Math.max(0.8, u);
    x.fillStyle = 'rgba(' + cols[(R() * cols.length) | 0] + ',' + (0.35 + R() * 0.65).toFixed(2) + ')';
    x.fillRect(sx, sy, s, s);
  }
  // atmospheric extinction near the horizon
  x.globalCompositeOperation = 'destination-out';
  const g = x.createLinearGradient(0, h * 0.5, 0, h);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.95)');
  x.fillStyle = g;
  x.fillRect(0, 0, w, h);
  x.globalCompositeOperation = 'source-over';
  const tw = [];
  for (let i = 0; i < 170; i++) {
    const yy = h * Math.pow(R(), 1.25) * 0.9;
    tw.push({
      x: R() * w, y: yy, s: (1.1 + R() * 1.4) * Math.max(0.8, u), a: (0.6 + R() * 0.4) * (1 - smoothstep(h * 0.55, h * 0.95, yy)),
      f: 0.8 + R() * 3.2, ph: R() * TAU, g: i < 22, c: (R() * 3) | 0,
    });
  }
  SPR.stars = { key, canvas: c, w, h, tw };
  return SPR.stars;
}

// ----------------------------------------------------------------- tinting
function overlay(t, mask, col, alpha, w, h) {
  const s = SPR.sctx;
  s.globalCompositeOperation = 'source-over';
  s.globalAlpha = 1;
  s.clearRect(0, 0, w, h);
  s.drawImage(mask, 0, 0);
  s.globalCompositeOperation = 'source-in';
  s.fillStyle = rgbS(col);
  s.fillRect(0, 0, w, h);
  s.globalCompositeOperation = 'source-over';
  t.globalCompositeOperation = 'source-atop';
  t.globalAlpha = clamp(alpha, 0, 1);
  t.drawImage(SPR.scratch, 0, 0, w, h, 0, 0, w, h);
  t.globalAlpha = 1;
  t.globalCompositeOperation = 'source-over';
}
function fillMask(t, mask, col, w, h) {
  t.globalCompositeOperation = 'source-over';
  t.globalAlpha = 1;
  t.clearRect(0, 0, w, h);
  t.drawImage(mask, 0, 0);
  t.globalCompositeOperation = 'source-in';
  t.fillStyle = rgbS(col);
  t.fillRect(0, 0, w, h);
  t.globalCompositeOperation = 'source-over';
}
// CPU tint of a cloud: shadow -> lit -> highlight -> silhouette rim, with the masks of the
// high light blended toward a side light by k (a low sun). Canvas 0 is for clouds with the
// sun on their left, canvas 1 for the sun on their right.
function tintCloudSide(spr, p, v, k) {
  const d = spr.img.data, N = spr.w * spr.h, B = spr.body;
  const L0 = spr.lit[0], H0 = spr.hi[0], R0 = spr.rim[0], L1 = spr.lit[v], H1 = spr.hi[v], R1 = spr.rim[v];
  const ka = (1 - k) / 255, kb = k / 255, rs = p.rs;
  const sh = p.sh, li = p.lit, hi = p.hi, rm = p.rim;
  for (let i = 0, j = 0; i < N; i++, j += 4) {
    const a = B[i];
    if (a === 0) { d[j + 3] = 0; continue; }
    const l = L0[i] * ka + L1[i] * kb, hh = H0[i] * ka + H1[i] * kb, q = (R0[i] * ka + R1[i] * kb) * rs;
    let r = sh[0] + (li[0] - sh[0]) * l, g = sh[1] + (li[1] - sh[1]) * l, b = sh[2] + (li[2] - sh[2]) * l;
    r += (hi[0] - r) * hh; g += (hi[1] - g) * hh; b += (hi[2] - b) * hh;
    r += (rm[0] - r) * q; g += (rm[1] - g) * q; b += (rm[2] - b) * q;
    d[j] = r; d[j + 1] = g; d[j + 2] = b; d[j + 3] = a;
  }
  spr.tctx[v - 1].putImageData(spr.img, 0, 0);
  if (spr.rctx) {
    const gc = p.glow;
    for (let i = 0, j = 0; i < N; i++, j += 4) {
      d[j] = gc[0]; d[j + 1] = gc[1]; d[j + 2] = gc[2];
      d[j + 3] = R0[i] * (1 - k) + R1[i] * k;
    }
    spr.rctx[v - 1].putImageData(spr.img, 0, 0);
  }
}
function tintCloud(spr, p, k) {
  const two = k > 0.01;
  tintCloudSide(spr, p, 1, two ? k : 0);
  if (two) tintCloudSide(spr, p, 2, k);
  spr.sideK = two ? k : 0;
}
function tintStrip(s, body, lit, litA, haze, hazeA) {
  const t = s.tctx, w = s.w, h = s.h;
  fillMask(t, s.body, body, w, h);
  overlay(t, s.lit, lit, litA, w, h);
  t.globalCompositeOperation = 'source-atop';
  const g = t.createLinearGradient(0, h * 0.2, 0, h);
  g.addColorStop(0, rgbaS(haze, 0));
  g.addColorStop(0.7, rgbaS(haze, hazeA * 0.55));
  g.addColorStop(1, rgbaS(haze, hazeA));
  t.fillStyle = g;
  t.fillRect(0, 0, w, h);
  t.globalCompositeOperation = 'source-over';
}
const sigCloud = (p) => [p.sh[0], p.sh[1], p.sh[2], p.lit[0], p.lit[1], p.lit[2], p.hi[0], p.hi[1], p.hi[2], p.rim[0], p.rim[2], p.glow[0], p.glow[1], p.glow[2], p.rs * 255];

function registerCloud(spr, id) {
  // CPU tints: re-tinted only when a colour moved by ~2% (or the side light by ~3%)
  tintables.push({
    cost: spr.w * spr.h * 1.5, last: null, tol: 5,
    sig: (pal) => { const a = sigCloud(pal.cl[id]); a.push(pal.side * 150); return a; },
    apply: (pal) => tintCloud(spr, pal.cl[id], pal.side),
  });
}
function registerTintables() {
  for (const L of LAYERS) for (const spr of SPR[L.set]) if (spr) registerCloud(spr, L.id);
  for (const spr of SPR.cirrus) {
    tintables.push({ cost: spr.w * spr.h * 0.3, last: null, sig: (pal) => pal.cirrus.slice(), apply: (pal) => fillMask(spr.tctx, spr.body, pal.cirrus, spr.w, spr.h) });
  }
  for (const spr of SPR.fog) {
    tintables.push({ cost: spr.w * spr.h * 0.3, last: null, sig: (pal) => pal.wispC.slice(), apply: (pal) => fillMask(spr.tctx, spr.body, pal.wispC, spr.w, spr.h) });
  }
  const sh = SPR.shafts;
  tintables.push({ cost: 2e4, last: null, sig: (pal) => pal.shaftC.slice(), apply: (pal) => fillMask(sh.tctx, sh.body, pal.shaftC, sh.w, sh.h) });
  const mb = SPR.mtnBack, mf = SPR.mtnFront;
  tintables.push({
    cost: mb.w * mb.h * 0.6, last: null,
    sig: (pal) => [...pal.mtn.body, ...pal.mtn.lit, ...pal.mtn.haze, pal.mtn.litA * 255],
    apply: (pal) => tintStrip(mb, pal.mtn.body, pal.mtn.lit, pal.mtn.litA, pal.mtn.haze, pal.mtn.hazeA),
  });
  tintables.push({
    cost: mf.w * mf.h * 0.6, last: null,
    sig: (pal) => [...pal.mtn.front, ...pal.mtn.lit, pal.mtn.litA * 255],
    apply: (pal) => tintStrip(mf, pal.mtn.front, mixColor(pal.mtn.front, pal.mtn.lit, 0.7), pal.mtn.litA, pal.mtn.haze, pal.mtn.hazeA * 0.45),
  });
}

function sigDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > m) m = d; }
  return m;
}
// Re-tint stale sprites round-robin with a per-frame budget; everything at once
// on the first frame or when the clock jumps (sleep, debug).
function updateTints(pal) {
  if (!tintables.length) return;
  const skySig = [...pal.sky[0], ...pal.sky[4], ...pal.cl[1].lit];
  const jump = !lastSkySig || sigDiff(skySig, lastSkySig) > 28;
  lastSkySig = skySig;
  if (jump) presSnap = true;
  let budget = 140000;
  const t0 = performance.now();
  for (let n = 0; n < tintables.length; n++) {
    const t = tintables[tintCursor];
    tintCursor = (tintCursor + 1) % tintables.length;
    const sig = t.sig(pal);
    if (!t.last || jump || sigDiff(sig, t.last) > (t.tol || 2.5)) {
      if (t.last && !jump && (budget <= 0 || performance.now() - t0 > 2.5)) continue;
      t.apply(pal);
      t.last = sig;
      budget -= t.cost;
    }
  }
}

function buildOnce() {
  if (SPR.built) return true;
  if (typeof document === 'undefined') return false;
  SPR.built = true;
  SPR.scratch = makeCanvas(MTN_W, 360);
  SPR.sctx = SPR.scratch.getContext('2d');
  // A few clouds are baked right away so the first frame has a sky; the rest are baked a
  // slice per frame (pumpBake) and drift in as they become ready.
  for (const j of CLOUD_JOBS) SPR[j[0]][j[1]] = null;
  for (const j of CLOUD_JOBS) {
    if (j[2]) SPR[j[0]][j[1]] = bakeCloud(...j.slice(3));
    else BAKE.queue.push(j);
  }
  SPR.cirrus.push(bakeCirrus(1414, 900, 150), bakeCirrus(1515, 760, 130));
  SPR.fog.push(bakeFog(1616, 1200, 150), bakeFog(1717, 1000, 120));
  SPR.shafts = bakeShafts();
  SPR.moon = bakeMoon();
  SPR.beam = bakeBeam();
  SPR.glint = bakeGlint();
  SPR.rays = bakeRays();
  const m = bakeMountains();
  SPR.mtnBack = m.back;
  SPR.mtnFront = m.front;
  registerTintables();
  return true;
}

const SET_LAYER = { far: 0, mid: 1, high: 2 };
// Spread the remaining cloud bakes over frames (~budget ms each).
function pumpBake(budget) {
  if (!BAKE.queue.length) return;
  const t0 = performance.now();
  while (BAKE.queue.length) {
    const j = BAKE.queue[0];
    if (!BAKE.gen) BAKE.gen = bakeCloudGen(...j.slice(3));
    let r;
    do { r = BAKE.gen.next(); } while (!r.done && performance.now() - t0 < budget);
    if (!r.done) return;
    BAKE.queue.shift();
    BAKE.gen = null;
    SPR[j[0]][j[1]] = r.value;
    registerCloud(r.value, SET_LAYER[j[0]]);
    if (performance.now() - t0 >= budget) return;
  }
}

// ============================================================================
// Palette for the current moment
// ============================================================================
function nightOf(G) { return 1 - smoothstep(0.12, 0.55, G.light == null ? 1 : G.light); }

function computePalette(G, st) {
  const p = G.phase || 0, W = G.weather;
  const S = st.storm, rainA = W.rain || 0, fog = W.fog || 0, cover = st.cover;
  const gloom = clamp(Math.max(S, rainA * 0.62), 0, 1);
  const light = G.light == null ? 1 : G.light;
  const darkK = lerp(0.42, 1, smoothstep(0.08, 0.9, light));

  const sk = sampleKeys(SKY_KEYS, p);
  // "how night does the sky look": from the painted zenith, not G.light, which
  // is still low at sunrise while the sky is already bright and warm
  const night = 1 - smoothstep(20, 75, luma(sk[0]));
  const cl = sampleKeys(CLOUD_KEYS, p);
  const mt = sampleKeys(MTN_KEYS, p);

  // fog colour is derived from the low sky before grading; by day it is a neutral pearl
  // (warmer around a low sun), so a fog bank reads as fog and not as more sky
  const lowMix = mixColor(sk[3], sk[4], 0.5);
  const se = sunElev(p);
  const pearlK = (1 - night) * lerp(0.3, 0.78, smoothstep(0.08, 0.4, se));
  const fogC = mixColor(mixColor(lowMix, [luma(lowMix), luma(lowMix), luma(lowMix) * 1.08], 0.45), [222, 225, 223], pearlK);

  const greyAmt = clamp((cover - 0.6) * 0.45, 0, 0.18) + gloom * 0.78;
  const skyK = lerp(1, 0.6, gloom);
  for (let i = 0; i < 5; i++) sk[i] = grade(sk[i], greyAmt, skyK);
  if (fog > 0) {
    sk[2] = mixColor(sk[2], fogC, fog * 0.2);
    sk[3] = mixColor(sk[3], fogC, fog * 0.45);
    sk[4] = mixColor(sk[4], fogC, fog * 0.62);
  }

  const base = { sh: cl[0], lit: cl[1], hi: cl[2], rim: cl[3], glow: cl[4], rs: cl[5] };
  const storm = {
    sh: scaleC(STORM_CLOUD.sh, darkK), lit: scaleC(STORM_CLOUD.lit, darkK), hi: scaleC(STORM_CLOUD.hi, darkK),
    rim: scaleC(STORM_CLOUD.rim, darkK), glow: STORM_CLOUD.glow, rs: STORM_CLOUD.rs,
  };
  const g2 = gloom * 0.92;
  const mid = {
    sh: mixColor(base.sh, storm.sh, g2), lit: mixColor(base.lit, storm.lit, g2), hi: mixColor(base.hi, storm.hi, g2),
    rim: mixColor(base.rim, storm.rim, g2), glow: mixColor(base.glow, storm.glow, gloom), rs: lerp(base.rs, storm.rs, g2),
  };
  if (fog > 0) {
    mid.sh = mixColor(mid.sh, fogC, fog * 0.25);
    mid.lit = mixColor(mid.lit, fogC, fog * 0.25);
  }
  const hz = sk[4], hzk = 0.3 + 0.25 * fog;
  const far = {
    sh: mixColor(mid.sh, hz, hzk + 0.08), lit: mixColor(mid.lit, hz, hzk), hi: mixColor(mid.hi, hz, hzk * 0.8),
    rim: mixColor(mid.rim, hz, hzk), glow: mid.glow, rs: mid.rs * 0.7,
  };
  const high = {
    sh: scaleC(mid.sh, 0.86), lit: mixColor(scaleC(mid.lit, 0.94), mid.sh, 0.12), hi: mid.hi,
    rim: mid.rim, glow: mid.glow, rs: mid.rs,
  };
  const cirrus = mixColor(mixColor(mid.hi, mid.glow, 0.35), sk[1], 0.15 + 0.3 * night);
  // a low sun lights the clouds from the side (sun-facing flanks glow, the far side goes lilac)
  const side = (1 - smoothstep(0.1, 0.5, se)) * smoothstep(-0.3, -0.04, se) * (1 - gloom);

  const mtnBody = grade(mt[0], gloom * 0.6, lerp(1, 0.7, gloom));
  const mtnLit = grade(mt[1], gloom * 0.6, lerp(1, 0.7, gloom));
  const mtnHaze = mixColor(mt[2], sk[4], 0.5);
  const mtn = {
    body: mtnBody, lit: mtnLit, haze: mtnHaze, litA: lerp(0.85, 0.35, gloom),
    front: mixColor(scaleC(mtnBody, 0.78), [6, 10, 22], night * 0.35), hazeA: lerp(0.62, 0.35, night),
  };

  return {
    sky: sk, cl: [far, mid, high], cirrus, mtn, gloom, night, light, side: side < 0.02 ? 0 : side,
    fogC, shaftC: mixColor(mid.sh, fogC, 0.4),
    wispC: mixColor(mixColor(fogC, [255, 255, 255], 0.2), [118, 136, 172], night * 0.6),
    starA: smoothstep(0.42, 0.12, light) * (1 - smoothstep(30, 78, luma(sk[0]))) * (1 - gloom) * (1 - 0.8 * fog) * (1 - 0.4 * clamp((cover - 0.55) * 2.2, 0, 1)),
    sunA: clamp(1 - 0.94 * S - 0.45 * rainA - 0.5 * fog, 0.04, 1),
    moonA: clamp(1 - 0.95 * S - 0.5 * rainA - 0.45 * fog, 0, 1),
    stormDark: scaleC([24, 28, 36], darkK),
  };
}

// ============================================================================
// Sun / moon geometry (screen space)
// ============================================================================
// Sun elevation over the day: 0 on the horizon, 1 at noon, negative below the horizon.
function sunElev(phase) {
  let p = phase || 0;
  if (p > 0.8) p -= 1;
  return Math.sin(Math.PI * clamp(p / C.SUNSET, -0.45, 1.45));
}
function sunPos(G, v, u) {
  let p = G.phase || 0;
  if (p > 0.8) p -= 1;
  const t = p / C.SUNSET;
  const e = sunElev(G.phase);
  return {
    x: v.cssW * lerp(0.14, 0.8, t),
    y: v.seaScreenY - e * SUN_ARC * u,
    e, t,
    r: lerp(23, 14, smoothstep(0, 0.5, e)) * u,
  };
}
function moonPos(G, v, u) {
  let p = G.phase || 0;
  if (p < 0.3) p += 1;
  const t = (p - 0.6) / 0.41;
  const s = Math.sin(Math.PI * clamp(t, -0.45, 1.45));
  const e = Math.sign(s) * Math.pow(Math.abs(s), 0.6);
  return { x: v.cssW * lerp(0.2, 0.84, t), y: v.seaScreenY - e * MOON_ARC * u, e, t, r: 29 * u };
}
const sunColorAt = (e) => gradientAt(SUN_RAMP, clamp(e, 0, 1));

// ============================================================================
// Runtime state & weather machine
// ============================================================================
function newState() {
  return {
    timer: 120, cover: 0.36, storm: 0, windBase: 0.3, gustT: Math.random() * 100,
    target: { wave: 1, rain: 0, wind: 0.3, fog: 0, cover: 0.36 },
    windOff: [Math.random() * 4000, Math.random() * 4000, Math.random() * 4000], cirrusOff: Math.random() * 3000,
    strikeT: -1, strikePow: 0, boltTimer: 3, thunderT: -1, thunderVol: 1, bolt: null,
    shoot: null, stormCooldown: 0, lighthouseCheck: 0,
  };
}
function ensureState(G) {
  if (!G.weather) G.weather = { kind: 'clear', wave: 1, rain: 0, wind: 0.3, fog: 0, lightning: 0 };
  const W = G.weather;
  if (!WEATHER[W.kind]) W.kind = 'clear';
  if (!(W.wave >= 1)) W.wave = 1;
  for (const k of ['rain', 'fog', 'lightning']) if (!Number.isFinite(W[k])) W[k] = 0;
  if (!Number.isFinite(W.wind)) W.wind = 0.3;
  if (!G.skyState) {
    G.skyState = newState();
    setKind(G, G.skyState, W.kind, true, null, true);
  }
  return G.skyState;
}

function setKind(G, st, kind, snap, dur, silent) {
  const W = G.weather, K = WEATHER[kind] || WEATHER.clear;
  const prev = W.kind;
  W.kind = WEATHER[kind] ? kind : 'clear';
  st.timer = dur != null ? dur : rnd(K.dur[0], K.dur[1]);
  const T = st.target;
  T.wave = K.wave;
  T.rain = K.rain * (kind === 'rain' ? rnd(0.75, 1) : 1);
  T.fog = K.fog;
  T.cover = clamp(K.cover + (kind === 'clear' || kind === 'cloudy' ? rnd(-0.08, 0.08) : 0), 0, 1);
  let ws = K.wind * rnd(0.85, 1.15);
  if ((kind === 'clear' || kind === 'cloudy' || kind === 'fog') && Math.random() < 0.25) ws = -ws * 0.6;
  T.wind = ws;
  if (snap) {
    presSnap = true;
    W.wave = T.wave; W.rain = T.rain; W.fog = T.fog; W.wind = T.wind;
    st.windBase = T.wind; st.cover = T.cover; st.storm = kind === 'storm' ? 1 : 0;
  }
  if (kind === 'storm') {
    st.stormCooldown = 480 + st.timer;
    st.boltTimer = snap ? 1.2 : rnd(7, 13);
    if (!silent && prev !== 'storm') say(G, '暴风雨要来了，抓紧木筏！', 'warn');
  } else if (!silent && !G.demo && G.persist) {
    const flags = G.persist.flags || (G.persist.flags = {});
    if (kind === 'rain' && !flags.sky_rain) { flags.sky_rain = 1; say(G, '下雨了。净水器能接到更多雨水。'); }
    if (kind === 'fog' && !flags.sky_fog && nightOf(G) > 0.5) { flags.sky_fog = 1; say(G, '起雾了……什么都看不清。'); }
  }
}

function pickKind(G, st) {
  const W = G.weather, p = G.phase || 0;
  const nightish = p > 0.58 && p < 0.97, evening = p > 0.47 && p <= 0.58;
  const w = { clear: 0.46, cloudy: 0.32, rain: 0.12, storm: 0.05, fog: nightish ? 0.22 : evening ? 0.1 : 0.015 };
  if (W.kind === 'storm') { w.clear = 0.05; w.cloudy = 0.5; w.rain = 0.45; w.storm = 0; w.fog = 0.04; }
  else if (W.kind === 'rain') { w.storm *= 2.4; w.rain = 0.08; w.cloudy = 0.45; }
  else if (W.kind === 'fog') w.fog *= 0.35;
  if ((G.day || 1) <= 1 || st.stormCooldown > 0 || G.demo) w.storm = 0;
  if (G.demo) { w.rain = 0; w.fog = 0; }
  let sum = 0;
  for (const k in w) sum += w[k];
  let r = Math.random() * sum;
  for (const k in w) { r -= w[k]; if (r <= 0) return k; }
  return 'clear';
}

function strike(G, st) {
  const near = Math.random();
  st.strikeT = 0;
  st.strikePow = lerp(0.5, 1, near);
  st.boltTimer = rnd(3, 9) * (1.3 - 0.3 * st.storm);
  st.thunderT = lerp(1.7, 0.1, near);
  st.thunderVol = lerp(0.4, 1, near);
  st.bolt = Math.random() < 0.65 ? makeBolt(near) : null;
}
function makeBolt(near) {
  const ax = rnd(0.12, 0.88);
  const jag = (x1, h1, x2, h2, disp, depth, out) => {
    if (depth === 0) { out.push(x2, h2); return; }
    const mx = (x1 + x2) / 2 + rnd(-disp, disp), mh = (h1 + h2) / 2 + rnd(-disp, disp) * 0.25;
    jag(x1, h1, mx, mh, disp * 0.55, depth - 1, out);
    jag(mx, mh, x2, h2, disp * 0.55, depth - 1, out);
  };
  const top = rnd(330, 420), bottom = near > 0.55 ? -4 : rnd(20, 70);
  const main = [0, top];
  jag(0, top, rnd(-90, 90), bottom, 60, 6, main);
  const paths = [{ pts: main, w: 1 }];
  const nb = 1 + ((Math.random() * 3) | 0);
  for (let b = 0; b < nb; b++) {
    const k = 2 * (4 + ((Math.random() * (main.length / 2 - 10)) | 0));
    const sx = main[k], sh = main[k + 1];
    const br = [sx, sh];
    jag(sx, sh, sx + rnd(-140, 140), sh - rnd(50, 150), 30, 4, br);
    paths.push({ pts: br, w: 0.55 });
  }
  return { ax, paths };
}

export function init(G) {
  buildOnce();
  if (!G.weather) G.weather = { kind: 'clear', wave: 1, rain: 0, wind: 0.3, fog: 0, lightning: 0 };
  const W = G.weather;
  const st = (G.skyState = newState());
  W.lightning = 0;
  const saved = G.persist && G.persist.sky;
  if (G.demo) {
    setKind(G, st, 'cloudy', true, rnd(120, 200), true);
    st.cover = st.target.cover = 0.62;
  } else if (G.loaded && saved && WEATHER[saved.kind]) {
    setKind(G, st, saved.kind, true, clamp(Number(saved.left) || 60, 10, 300), true);
  } else if (!G.loaded) {
    // the boy wakes after a storm: heavy sky and swell, clearing over the first minute
    setKind(G, st, 'cloudy', true, rnd(50, 80), true);
    W.wave = 1.7; W.wind = st.windBase = 0.85; W.fog = 0.2; st.cover = 0.95; st.storm = 0.25;
  } else {
    setKind(G, st, WEATHER[W.kind] ? W.kind : 'clear', true, null, true);
  }
}

export function update(G, dt) {
  const st = ensureState(G);
  const W = G.weather;
  if (!(dt > 0)) return;
  dt = Math.min(dt, 0.25);
  st.timer -= dt;
  st.stormCooldown = Math.max(0, st.stormCooldown - dt);
  if (st.timer <= 0) setKind(G, st, pickKind(G, st), false, null, false);
  // morning sun burns the fog off
  if (W.kind === 'fog' && G.phase > 0.1 && G.phase < 0.5 && st.timer > 30) st.timer = 30;

  const T = st.target;
  const k = (rate) => 1 - Math.exp(-dt * rate);
  W.wave += (T.wave - W.wave) * k(0.1);
  W.rain += (T.rain - W.rain) * k(W.kind === 'storm' ? 0.2 : 0.12);
  W.fog += (T.fog - W.fog) * k(0.07);
  st.windBase += (T.wind - st.windBase) * k(0.08);
  st.cover += (T.cover - st.cover) * k(0.05);
  st.storm += ((W.kind === 'storm' ? 1 : 0) - st.storm) * k(0.09);
  if (W.wave < 1) W.wave = 1;
  st.gustT += dt;
  const gust = Math.sin(st.gustT * 0.37) * Math.sin(st.gustT * 0.13 + 1.7);
  W.wind = st.windBase * (1 + gust * (0.15 + 0.3 * st.storm));

  const wdir = W.wind >= 0 ? 1 : -1;
  const wmag = 0.35 + Math.abs(W.wind);
  for (let i = 0; i < LAYERS.length; i++) st.windOff[i] -= dt * LAYERS[i].speed * wmag * wdir;
  st.cirrusOff -= dt * CIRRUS.speed * wmag * wdir;

  // lightning
  if (W.kind === 'storm' && st.storm > 0.5) {
    st.boltTimer -= dt;
    if (st.boltTimer <= 0) strike(G, st);
  }
  if (st.strikeT >= 0) {
    st.strikeT += dt;
    const t = st.strikeT;
    let f = t < 0.06 ? 1 : Math.exp(-(t - 0.06) * 11);
    if (t > 0.17) f = Math.max(f, 0.75 * Math.exp(-(t - 0.17) * 13));
    if (t > 0.36 && st.strikePow > 0.8) f = Math.max(f, 0.4 * Math.exp(-(t - 0.36) * 14));
    W.lightning = clamp(f * st.strikePow, 0, 1);
    if (t > 1.3) { st.strikeT = -1; st.bolt = null; }
  } else {
    W.lightning = Math.max(0, W.lightning - dt * 4);
  }
  if (st.thunderT >= 0) {
    st.thunderT -= dt;
    if (st.thunderT < 0) {
      try { sfx('thunder', { volume: st.thunderVol }); } catch (e) { /* audio is optional */ }
      if (st.thunderVol > 0.85) G.shake = (G.shake || 0) + 0.18;
    }
  }

  // shooting stars
  if (st.shoot) {
    st.shoot.t += dt;
    if (st.shoot.t > st.shoot.life) st.shoot = null;
  } else if (G.light < 0.2 && W.rain < 0.2 && W.fog < 0.5 && st.storm < 0.1 && Math.random() < dt / 24) {
    st.shoot = {
      x: rnd(0.15, 0.85), h: rnd(250, 420), vx: (Math.random() < 0.5 ? -1 : 1) * rnd(260, 430),
      vh: -rnd(80, 170), t: 0, life: rnd(0.6, 1.1), len: rnd(70, 130),
    };
  }

  // story beat: the lighthouse light on the horizon
  st.lighthouseCheck -= dt;
  if (st.lighthouseCheck <= 0 && !G.demo) {
    st.lighthouseCheck = 1;
    const flags = G.persist && (G.persist.flags || (G.persist.flags = {}));
    const rx = G.raft && Number.isFinite(G.raft.x) ? G.raft.x : 0;
    if (flags && !flags.sky_lighthouse && rx > 15000 && rx < 19200 && nightOf(G) > 0.7 && st.storm < 0.5 && W.fog < 0.6) {
      flags.sky_lighthouse = 1;
      say(G, '远处的海面上，有一道光在转……是灯塔！', 'story');
      journal(G, '夜里，我第一次看见了远方的灯塔。它一圈一圈地转着光，好像在叫我过去。');
    }
  }

  // the far lighthouse lamp is a real light for the darkness pass
  const v = G.view;
  if (v && v.cssW > 0 && v.scale > 0 && Array.isArray(G.lights)) {
    const u = unitOf(v);
    const lh = lighthouseGeom(G, u, v.cssW);
    const la = lh.vis * smoothstep(0.25, 0.75, nightOf(G));
    if (la > 0.02 && v.seaScreenY > 0) {
      const sy = v.seaScreenY - 27.8 * lh.s;
      const wx = G.cam.x + (lh.x - v.cssW / 2) / v.scale, wy = G.cam.y + (sy - v.cssH / 2) / v.scale;
      let gy = null;
      try { gy = islandGroundAt(G, wx); } catch (e) { gy = null; }
      // an island in front hides the lamp
      if (gy == null || gy >= wy + 4) {
        G.lights.push({ x: wx, y: wy, r: (21 + 13 * lh.s / u) * u / v.scale, color: [255, 222, 160], a: 0.85 * la });
      }
    }
  }

  // persist the weather so a loaded game resumes under the same sky
  if (!G.demo && G.persist) {
    const ps = G.persist.sky || (G.persist.sky = {});
    ps.kind = W.kind;
    ps.left = Math.round(st.timer);
  }
}

export function debugWeather(G, kind) {
  const st = ensureState(G);
  if (!WEATHER[kind]) return false;
  setKind(G, st, kind, true, 150, false);
  if (kind === 'storm') st.boltTimer = 0.9;
  return true;
}

// Screen-space sun / moon for reflections and lighting (CSS px).
export function celestial(G) {
  const v = G.view;
  const u = unitOf(v);
  const st = G.skyState;
  const W = G.weather || {};
  const S = st ? st.storm : 0, rain = W.rain || 0, fog = W.fog || 0;
  const light = G.light == null ? 1 : G.light;
  const s = sunPos(G, v, u), m = moonPos(G, v, u);
  const sunA = clamp(1 - 0.94 * S - 0.45 * rain - 0.5 * fog, 0.04, 1) * smoothstep(-0.06, 0.02, s.e);
  const moonA = clamp(1 - 0.95 * S - 0.5 * rain - 0.45 * fog, 0, 1) * (1 - smoothstep(0.15, 0.6, light)) * smoothstep(-0.05, 0.03, m.e);
  const sky = sampleKeys(SKY_KEYS, G.phase || 0);
  return {
    sunX: s.x, sunY: s.y, sunVisible: sunA > 0.05 && s.y < v.seaScreenY + s.r, sunAlpha: sunA, sunR: s.r,
    moonX: m.x, moonY: m.y, moonVisible: moonA > 0.05 && m.y < v.seaScreenY + m.r, moonAlpha: moonA, moonR: m.r,
    sunColor: sunColorAt(s.e), moonColor: [236, 230, 205],
    horizon: sky[4], zenith: sky[0], storm: S, cloudCover: st ? st.cover : 0.4,
    // elevation above the horizon (1 = highest), and how much cloud / far land hides each
    // disc in the last drawn frame (0 clear .. 1 hidden)
    sunE: s.e, moonE: m.e,
    sunCover: STAMP.sunOn ? STAMP.sunOcc : 0, moonCover: STAMP.moonOn ? STAMP.moonOcc : 0,
  };
}

// ============================================================================
// Drawing — sky
// ============================================================================
function assetWeights(p) {
  // [day, dusk, night] weights over the day; dawn reuses the dusk painting
  const K = [[0, 0.35, 0.65, 0], [0.06, 1, 0, 0], [0.46, 1, 0, 0], [0.54, 0, 1, 0], [0.6, 0, 1, 0], [0.67, 0, 0, 1], [0.92, 0, 0, 1], [0.98, 0, 0.75, 0.25], [1, 0.35, 0.65, 0]];
  for (let i = 1; i < K.length; i++) {
    if (p <= K[i][0]) {
      const a = K[i - 1], b = K[i], t = smoothstep(0, 1, (p - a[0]) / (b[0] - a[0] || 1));
      return [lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t)];
    }
  }
  return [0.35, 0.65, 0];
}

function drawCover(ctx, img, W, sea, H) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  if (!iw || !ih) return;
  const hz = 0.62 * ih;
  const s = Math.max(W / iw, sea / hz, (H - sea) / (ih - hz) || 0);
  const dw = iw * s, dh = ih * s;
  ctx.drawImage(img, (W - dw) / 2, sea - hz * s, dw, dh);
}

function drawBase(ctx, G, pal, W, H, sea, u) {
  const imgs = [getAsset('sky_day'), getAsset('sky_dusk'), getAsset('sky_night')];
  const any = imgs[0] || imgs[1] || imgs[2];
  const res = { assetW: 0, nightImg: 0 };
  let wts = null, missing = 1;
  if (any) {
    wts = assetWeights(G.phase || 0);
    missing = 0;
    for (let i = 0; i < 3; i++) if (!imgs[i]) missing += wts[i];
  }
  if (missing > 0.001) {
    const sk = pal.sky;
    const g = ctx.createLinearGradient(0, sea - SKY_REF * u, 0, sea);
    g.addColorStop(0, rgbS(sk[0]));
    g.addColorStop(0.32, rgbS(sk[1]));
    g.addColorStop(0.62, rgbS(sk[2]));
    g.addColorStop(0.86, rgbS(sk[3]));
    g.addColorStop(1, rgbS(sk[4]));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  if (any) {
    let acc = missing;
    for (let i = 0; i < 3; i++) {
      if (!imgs[i] || wts[i] < 0.002) continue;
      acc += wts[i];
      ctx.globalAlpha = clamp(wts[i] / acc, 0, 1);
      drawCover(ctx, imgs[i], W, sea, H);
      res.assetW += wts[i];
    }
    ctx.globalAlpha = 1;
    if (imgs[2]) res.nightImg = wts[2];
    if (pal.gloom > 0.01) {
      // storms still darken and grey a painted sky
      ctx.fillStyle = rgbaS(pal.stormDark, pal.gloom * 0.55);
      ctx.fillRect(0, 0, W, H);
    }
  }
  return res;
}

function drawAtmosphere(ctx, pal, sun, moon, W, sea, u) {
  // warm glow on the horizon under the sun; strongest at dawn and dusk
  const low = smoothstep(-0.32, -0.04, sun.e) * (1 - smoothstep(0.1, 0.55, sun.e));
  const bandA = (0.14 + 0.72 * low) * (1 - 0.8 * pal.gloom) * (1 - pal.night * 0.85);
  if (low > 0.02 && bandA > 0.01) {
    // the deep orange band lying along the whole horizon at dusk and dawn
    const hb = ctx.createLinearGradient(0, sea - 70 * u, 0, sea);
    const oc = mixColor([255, 150, 78], pal.sky[4], 0.25);
    hb.addColorStop(0, rgbaS(oc, 0));
    hb.addColorStop(0.7, rgbaS(oc, 0.22 * low * bandA));
    hb.addColorStop(1, rgbaS(oc, 0.42 * low * bandA));
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = hb;
    ctx.fillRect(0, sea - 70 * u, W, 70 * u + 4);
    ctx.globalCompositeOperation = 'source-over';
  }
  if (bandA > 0.01) {
    const col = mixColor(pal.sky[4], [255, 128, 70], low * 0.75);
    const R = 820 * u;
    ctx.save();
    ctx.translate(clamp(sun.x, -200 * u, W + 200 * u), sea);
    ctx.scale(1, 0.3);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
    g.addColorStop(0, rgbaS(col, bandA));
    g.addColorStop(0.35, rgbaS(col, bandA * 0.45));
    g.addColorStop(1, rgbaS(col, 0));
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = g;
    ctx.fillRect(-R, -R, R * 2, R);
    ctx.restore();
  }
  // cold moon glow on a clear night sky
  const mA = pal.moonA * pal.night * smoothstep(-0.05, 0.1, moon.e);
  if (mA > 0.01) {
    const R = 330 * u;
    const g = ctx.createRadialGradient(moon.x, moon.y, 0, moon.x, moon.y, R);
    g.addColorStop(0, rgbaS([96, 124, 186], 0.34 * mA));
    g.addColorStop(0.4, rgbaS([60, 86, 150], 0.13 * mA));
    g.addColorStop(1, rgbaS([40, 60, 120], 0));
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = g;
    ctx.fillRect(moon.x - R, moon.y - R, R * 2, R * 2);
    ctx.globalCompositeOperation = 'source-over';
  }
}

function drawStars(ctx, G, v, pal, st, sea, u, now, fieldA, twA) {
  const f = ensureStarField(v, u);
  const drift = -smoothstep(0.5, 1.05, (G.phase || 0) < 0.3 ? G.phase + 1 : G.phase) * f.w * 0.15;
  const y0 = sea - f.h;
  if (fieldA > 0.01) {
    ctx.globalAlpha = fieldA;
    ctx.drawImage(f.canvas, drift, y0, f.w, f.h);
  }
  if (twA > 0.01) {
    const cols = ['rgb(236,242,255)', 'rgb(206,222,255)', 'rgb(255,238,214)'];
    const gs = 12 * u;
    for (let c = 0; c < 3; c++) {
      ctx.fillStyle = cols[c];
      for (const s of f.tw) {
        if (s.c !== c) continue;
        const a = s.a * (0.55 + 0.45 * Math.sin(now * s.f + s.ph)) * twA;
        if (a < 0.02) continue;
        const x = s.x + drift, y = s.y + y0;
        if (x < -4 || x > v.cssW + 4 || y > sea) continue;
        ctx.globalAlpha = a;
        if (s.g) ctx.drawImage(SPR.glint, x - gs * s.s * 0.5, y - gs * s.s * 0.5, gs * s.s, gs * s.s);
        else ctx.fillRect(x - s.s * 0.5, y - s.s * 0.5, s.s, s.s);
      }
    }
  }
  ctx.globalAlpha = 1;
  // shooting star
  const sh = st.shoot;
  if (sh && twA > 0.05) {
    const k = sh.t / sh.life;
    const a = Math.sin(Math.PI * clamp(k, 0, 1)) * twA;
    const hx = sh.x * v.cssW + sh.vx * sh.t * u, hy = sea - (sh.h + sh.vh * sh.t) * u;
    const sp = Math.hypot(sh.vx, sh.vh), dx = sh.vx / sp, dy = -sh.vh / sp;
    const tx = hx - dx * sh.len * u * Math.min(1, k * 3), ty = hy - dy * sh.len * u * Math.min(1, k * 3);
    const g = ctx.createLinearGradient(tx, ty, hx, hy);
    g.addColorStop(0, 'rgba(200,220,255,0)');
    g.addColorStop(1, rgbaS([240, 246, 255], a));
    ctx.strokeStyle = g;
    ctx.lineWidth = 1.5 * u;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(hx, hy); ctx.stroke();
    ctx.globalAlpha = a;
    ctx.drawImage(SPR.glint, hx - 7 * u, hy - 7 * u, 14 * u, 14 * u);
    ctx.globalAlpha = 1;
  }
}

function drawSunBehind(ctx, sun, pal, sunA, col) {
  if (sunA < 0.01) return;
  const r = sun.r;
  const day = smoothstep(0.1, 0.6, sun.e);
  // wide warm haze (mixed, not added, so a blue sky never clips to cyan)
  const warm = mixColor(col, [255, 247, 230], 0.45 * day);
  const R = r * 15;
  let g = ctx.createRadialGradient(sun.x, sun.y, r * 0.5, sun.x, sun.y, R);
  g.addColorStop(0, rgbaS(warm, 0.7 * sunA));
  g.addColorStop(0.07, rgbaS(warm, 0.36 * sunA));
  g.addColorStop(0.28, rgbaS(warm, 0.11 * sunA));
  g.addColorStop(1, rgbaS(warm, 0));
  ctx.fillStyle = g;
  ctx.fillRect(sun.x - R, sun.y - R, R * 2, R * 2);
  // tight additive glow around the disc
  const R2 = r * 3.2;
  ctx.globalCompositeOperation = 'lighter';
  g = ctx.createRadialGradient(sun.x, sun.y, r * 0.6, sun.x, sun.y, R2);
  g.addColorStop(0, rgbaS(col, 0.32 * sunA));
  g.addColorStop(1, rgbaS(col, 0));
  ctx.fillStyle = g;
  ctx.fillRect(sun.x - R2, sun.y - R2, R2 * 2, R2 * 2);
  ctx.globalCompositeOperation = 'source-over';
  // disc, slightly flattened by refraction near the horizon
  const flat = lerp(0.84, 1, smoothstep(0, 0.09, sun.e));
  ctx.save();
  ctx.translate(sun.x, sun.y);
  ctx.scale(1, flat);
  g = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 1.18);
  const core = mixColor([255, 222, 150], [255, 254, 248], day);
  const mid = mixColor(col, core, 0.55);
  g.addColorStop(0, rgbaS(core, sunA));
  g.addColorStop(0.45, rgbaS(core, sunA));
  g.addColorStop(0.72, rgbaS(mid, sunA));
  g.addColorStop(0.88, rgbaS(col, sunA * 0.8));
  g.addColorStop(1, rgbaS(col, 0));
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(0, 0, r * 1.18, 0, TAU); ctx.fill();
  ctx.restore();
}

function drawMoon(ctx, moon, a, night) {
  if (a < 0.01 || !SPR.moon) return;
  const m = SPR.moon, k = moon.r / m.r, s = m.size * k;
  const ha = a * night;
  if (ha > 0.01) {
    ctx.globalAlpha = ha;
    ctx.drawImage(m.halo, moon.x - s / 2, moon.y - s / 2, s, s);
  }
  // a pale daytime moon is fainter than a night one
  ctx.globalAlpha = a * lerp(0.55, 1, night);
  ctx.drawImage(m.c, moon.x - s / 2, moon.y - s / 2, s, s);
  ctx.globalAlpha = 1;
}

function drawCirrus(ctx, G, v, st, u, sea, W, alpha) {
  if (alpha < 0.01) return;
  const cell = CIRRUS.cell * u;
  const off = G.cam.x * v.scale * CIRRUS.par + st.cirrusOff * u;
  const k0 = Math.floor((off - 900 * u) / cell), k1 = Math.floor((off + W) / cell) + 1;
  for (let k = k0; k <= k1; k++) {
    const h0 = hash1(k, CIRRUS.seed);
    if (h0 > 0.7) continue;
    const spr = SPR.cirrus[(hash1(k, CIRRUS.seed + 1) * SPR.cirrus.length) | 0];
    const sc = lerp(1, 1.5, hash1(k, CIRRUS.seed + 2)) * u / spr.sc;
    const dw = spr.w * sc, dh = spr.h * sc;
    const x = k * cell + hash1(k, CIRRUS.seed + 3) * cell * 0.5 - off;
    if (x > W || x + dw < 0) continue;
    const y = sea - lerp(310, 450, hash1(k, CIRRUS.seed + 4)) * u - dh / 2;
    const a = alpha * lerp(0.55, 1, hash1(k, CIRRUS.seed + 5));
    ctx.globalAlpha = a;
    ctx.drawImage(spr.tinted, x, y, dw, dh);
    occlude(spr.tinted, x, y, dw, dh, a * 0.6, null);
  }
  ctx.globalAlpha = 1;
}

function drawCloudLayer(ctx, G, v, L, pal, st, u, sea, W, H, glow) {
  const set = SPR[L.set];
  if (!set.length) return;
  const S = st.storm;
  const cell = L.cell * u;
  const off = G.cam.x * v.scale * L.par + st.windOff[L.id] * u;
  const maxW = 900 * u;
  const k0 = Math.floor((off - maxW) / cell), k1 = Math.floor((off + W) / cell) + 1;
  const cov = clamp(st.cover * L.cMul + L.cAdd, 0, 1.2);
  const lightning = G.weather.lightning || 0;
  for (let k = k0; k <= k1; k++) {
    const h0 = hash1(k, L.seed);
    const spr = set[(hash1(k, L.seed + 1) * set.length) | 0];
    // a sprite that is still baking stays away and drifts in once it is ready
    const target = spr && (cov > h0 || (L.id > 0 && S > h0 * 0.5 + 0.12)) ? 1 : 0;
    const pres = cellPresence(L.id + k * 4, target);
    if (pres <= 0.01 || !spr) continue;
    const sz = lerp(L.s0, L.s1, hash1(k, L.seed + 3)) * (L.id === 2 ? 1 + 0.35 * S : 1) * (0.5 + 0.5 * pres);
    const sc = (sz * u) / RS;
    const dw = spr.w * sc, dh = spr.h * sc;
    const x = k * cell + hash1(k, L.seed + 2) * cell * L.jit - off;
    if (x > W || x + dw < 0) continue;
    const baseY = sea - (lerp(L.y0, L.y1, hash1(k, L.seed + 4)) - (L.id === 2 ? 70 * S : 0)) * u;
    const y = baseY - spr.baseFrac * dh;
    if (y > H || y + dh < 0) continue;
    const pa = smoothstep(0, 0.45, pres);
    const a = pa * glow.alpha;
    // a low sun lights each cloud from the side the sun is on
    const cx = x + dw * 0.5, cy = y + dh * 0.45;
    const two = spr.sideK > 0.01;
    const wR = two ? smoothstep(-1, 1, (glow.sx - cx) / (dw * 0.5 + 160 * u)) : 0;
    const main = wR > 0.5 ? 1 : 0, wMinor = main ? 1 - wR : wR;
    // the dominant variant first, then the other at its weight: exact inside the cloud, and
    // its soft edge doesn't pick up the other variant's rim
    ctx.globalAlpha = a;
    ctx.drawImage(spr.tinted[main], x, y, dw, dh);
    if (two && wMinor > 0.02) {
      ctx.globalAlpha = a * wMinor;
      ctx.drawImage(spr.tinted[1 - main], x, y, dw, dh);
    }
    occlude(spr.tinted[0], x, y, dw, dh, a, spr);
    if (spr.rimC) {
      let gl = lightning * 0.9;
      if (glow.sunA > 0.01) {
        const dx = (cx - glow.sx) / (dw * 0.5 + 260 * u), dy = (cy - glow.sy) / (dh * 0.5 + 200 * u);
        gl += glow.sunA * Math.exp(-(dx * dx + dy * dy) * 1.4);
      }
      if (glow.moonA > 0.01) {
        const dx = (cx - glow.mx) / (dw * 0.5 + 240 * u), dy = (cy - glow.my) / (dh * 0.5 + 180 * u);
        gl += glow.moonA * Math.exp(-(dx * dx + dy * dy) * 1.4);
      }
      if (gl > 0.05) {
        // rims live on the upper part of the cloud; skip the belly to save fill
        const hf = 0.72;
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = clamp(gl, 0, 1) * a;
        ctx.drawImage(spr.rimC[two ? main : 0], 0, 0, spr.w, spr.h * hf, x, y, dw, dh * hf);
        ctx.globalCompositeOperation = 'source-over';
      }
    }
  }
  ctx.globalAlpha = 1;
}

// ----------------------------------------------------------------------------
// What drawSky leaves for drawWeather and post in the same frame: how much cloud (or
// mountain) covers the sun and the moon, and the moon's re-light mask with everything
// drawn in front of it cut away.
const STAMP = {
  sunOn: false, sx: 0, sy: 0, sr: 0, sunOcc: 0,
  moonOn: false, mx: 0, my: 0, mr: 0, moonOcc: 0, restA: 0,
  maskOn: false, layer: null, lctx: null, lx: 0, ly: 0, lw: 0, lk: 1,
};
function resetStamp() {
  const S = STAMP;
  S.sunOn = false; S.moonOn = false; S.maskOn = false;
  S.sunOcc = 0; S.moonOcc = 0; S.restA = 0;
}
function coverAt(spr, x, y, dw, dh, px, py, r) {
  const fx = (px - x) / dw, fy = (py - y) / dh, ox = (r * 0.7) / dw, oy = (r * 0.7) / dh;
  return (cloudBodyAt(spr, fx, fy) * 2 + cloudBodyAt(spr, fx - ox, fy) + cloudBodyAt(spr, fx + ox, fy)
    + cloudBodyAt(spr, fx, fy - oy) + cloudBodyAt(spr, fx, fy + oy)) / 6;
}
const addCover = (o, c) => 1 - (1 - o) * (1 - clamp(c, 0, 1));
// How much of a disc at screen (px, py), radius r, an island standing in front of it hides.
// (The islands are drawn after the sky; their ground line is all we can ask for.)
function islandCover(G, v, px, py, r) {
  if (!G.cam || !(v.scale > 0)) return 0;
  let c = 0;
  for (const ox of [-0.7, 0, 0.7]) {
    const wx = G.cam.x + (px + ox * r - v.cssW / 2) / v.scale;
    let gy = null;
    try { gy = islandGroundAt(G, wx); } catch (e) { gy = null; }
    if (gy == null || !isFinite(gy)) continue;
    const top = v.cssH / 2 + (gy - G.cam.y) * v.scale;      // ground line on screen
    c += clamp((py + r - top) / (2 * r), 0, 1) / 3;
  }
  return c;
}
// Something was drawn in front of the sun / moon: track the cover, cut it out of the moon mask.
function occlude(img, x, y, dw, dh, a, spr) {
  if (a < 0.01) return;
  const S = STAMP;
  if (S.maskOn && x < S.lx + S.lw && x + dw > S.lx && y < S.ly + S.lw && y + dh > S.ly) {
    S.lctx.globalAlpha = a > 1 ? 1 : a;
    S.lctx.drawImage(img, (x - S.lx) * S.lk, (y - S.ly) * S.lk, dw * S.lk, dh * S.lk);
  }
  if (!spr) return;
  if (S.sunOn && S.sx > x && S.sx < x + dw && S.sy > y && S.sy < y + dh) {
    S.sunOcc = addCover(S.sunOcc, a * coverAt(spr, x, y, dw, dh, S.sx, S.sy, S.sr));
  }
  if (S.moonOn && S.mx > x && S.mx < x + dw && S.my > y && S.my < y + dh) {
    S.moonOcc = addCover(S.moonOcc, a * coverAt(spr, x, y, dw, dh, S.mx, S.my, S.mr));
  }
}
// A far horizon strip (mountains, sea stacks) in front of a low sun or moon.
function occludeStrip(s, x0, sw, u, sea, yOff, a) {
  const S = STAMP;
  if (!s.hts || a < 0.01) return;
  const ridge = (px) => {
    const i = Math.floor(pmod(px - x0, sw) / u) % s.w;
    return sea + yOff - s.hts[i] * u;
  };
  if (S.sunOn && S.sy + S.sr > sea - s.h * u) {
    const c = clamp((S.sy + S.sr * 0.8 - ridge(S.sx)) / (S.sr * 1.6), 0, 1);
    if (c > 0) S.sunOcc = addCover(S.sunOcc, c * a);
  }
  if (S.moonOn && S.my + S.mr > sea - s.h * u) {
    const c = clamp((S.my + S.mr * 0.8 - ridge(S.mx)) / (S.mr * 1.6), 0, 1);
    if (c > 0) S.moonOcc = addCover(S.moonOcc, c * a);
  }
}
// The moon's re-light mask: the crescent, tinted with the gain that brings it back to warm
// cream after the night grade (applied with colour-dodge in drawWeather: it brightens the
// moon that is already there, and does next to nothing to a dark shape that happens to be
// in front of it).
const MOON_GAIN = [124, 86, 32];
function prepareMoonMask(v, moon, restA) {
  const S = STAMP;
  S.moonOn = true; S.mx = moon.x; S.my = moon.y; S.mr = moon.r; S.restA = restA;
  const m = SPR.moon;
  if (!m || !m.disc || restA < 0.01) return;
  const k = clamp(v.dpr || 1, 1, 2);
  const size = moon.r * 3.2;
  const px = Math.max(8, Math.ceil(size * k));
  if (!S.layer) { S.layer = makeCanvas(px, px); S.lctx = S.layer.getContext('2d'); }
  if (S.layer.width !== px) { S.layer.width = px; S.layer.height = px; }
  const c = S.lctx;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalCompositeOperation = 'source-over';
  c.globalAlpha = 1;
  c.clearRect(0, 0, px, px);
  const ds = (m.disc.width * (moon.r / m.r)) * k;
  c.drawImage(m.disc, (px - ds) / 2, (px - ds) / 2, ds, ds);
  c.globalCompositeOperation = 'source-in';
  c.fillStyle = rgbS(MOON_GAIN);
  c.fillRect(0, 0, px, px);
  c.globalCompositeOperation = 'destination-out';
  S.lx = moon.x - size / 2; S.ly = moon.y - size / 2; S.lw = size; S.lk = k;
  S.maskOn = true;
}

// After the lighting pass: the moon comes back warm cream, with a soft cream halo.
function drawMoonRestamp(ctx) {
  const S = STAMP;
  if (!S.moonOn || S.restA < 0.01) return;
  const clear = 1 - S.moonOcc;
  const ha = S.restA * (0.25 + 0.75 * clear);
  ctx.save();
  if (ha > 0.01) {
    const R = S.mr * 6;
    const g = ctx.createRadialGradient(S.mx, S.my, S.mr * 0.7, S.mx, S.my, R);
    g.addColorStop(0, rgbaS([255, 232, 188], 0.24 * ha));
    g.addColorStop(0.18, rgbaS([246, 222, 186], 0.09 * ha));
    g.addColorStop(0.5, rgbaS([214, 206, 200], 0.025 * ha));
    g.addColorStop(1, rgbaS([200, 200, 210], 0));
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = g;
    ctx.fillRect(S.mx - R, S.my - R, R * 2, R * 2);
  }
  if (S.maskOn && clear > 0.02) {
    ctx.globalCompositeOperation = 'color-dodge';
    ctx.globalAlpha = clamp(S.restA, 0, 1);
    ctx.drawImage(S.layer, 0, 0, S.layer.width, S.layer.height, S.lx, S.ly, S.lw, S.lw);
  }
  ctx.restore();
}

// The far lighthouse's light, drawn after the lighting pass so the night grade cannot turn it
// cold and grey. Things in front of it (an island, the raft, the boy) still hide it: the beam
// fades out before it reaches them and the lamp dims when it is behind land.
const LHB = { c: null, g: null };
function drawLighthouseLight(ctx, G, v, u, sea, now, night) {
  const W = v.cssW;
  const lh = lighthouseGeom(G, u, W);
  const la0 = lh.vis * smoothstep(0.25, 0.75, night);
  if (la0 < 0.01 || !(sea > 10) || sea > v.cssH + 80 || !SPR.beam) return;
  const s = lh.s, lx = lh.x, ly = sea - 27.8 * s;
  const sc = v.scale, cxs = W / 2;
  const lampWy = (ly - sea) / sc;                      // world height of the lamp above the sea
  const R = G.raft, P = G.player;
  const r0 = R && R.tiles && isFinite(R.x) ? R.x - 4 : null;
  const r1 = r0 != null ? R.x + R.tiles.length * C.TILE_W + 4 : null;
  const pAbove = P && isFinite(P.x) && isFinite(P.y) && P.y < 6;
  const blocked = (sx) => {
    const wx = G.cam.x + (sx - cxs) / sc;
    if (r0 != null && wx > r0 && wx < r1) return true;
    if (pAbove && Math.abs(wx - P.x) < 12) return true;
    let gy = null;
    try { gy = islandGroundAt(G, wx); } catch (e) { gy = null; }
    return gy != null && gy < lampWy + 4;
  };
  const lampVis = (blocked(lx) ? 0 : 0.5) + (blocked(lx - 3 * s) || blocked(lx + 3 * s) ? 0 : 0.5);
  const la = la0 * lampVis;
  if (la < 0.01) return;
  const th = now * 1.15;
  const c = Math.cos(th), ac = Math.abs(c), face = Math.pow(Math.max(0, Math.sin(th)), 6);
  const warm = [255, 222, 158];
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  // the beam: projected length shrinks as it swings toward / away from us
  const len = (110 + 560 * ac) * s;
  const dir = c >= 0 ? 1 : -1;
  const half = (5 + 30 * ac) * s;
  let reach = len;
  const stepPx = 10;
  for (let d = stepPx; d < len; d += stepPx) {
    const sx = lx + dir * d;
    if (sx < -20 || sx > W + 20) break;
    if (blocked(sx)) { reach = d; break; }
  }
  const beamA = la * (0.3 + 0.7 * ac);
  if (reach > 12 * s && beamA > 0.01) {
    const k = 0.5;
    const bw = Math.max(8, Math.ceil(len * k)), bh = Math.max(8, Math.ceil(half * 2 * k));
    if (!LHB.c) { LHB.c = makeCanvas(bw, bh); LHB.g = LHB.c.getContext('2d'); }
    const b = LHB.c, g = LHB.g;
    if (b.width < bw || b.height < bh) { b.width = Math.max(b.width, bw); b.height = Math.max(b.height, bh); }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.clearRect(0, 0, bw, bh);
    g.drawImage(SPR.beam, 0, 0, bw, bh);
    if (reach < len) {
      // feather the beam out before whatever stands in front of it
      const e = reach * k, f = Math.min(e * 0.6, 70 * k * u);
      const fg = g.createLinearGradient(e - f, 0, e, 0);
      fg.addColorStop(0, 'rgba(0,0,0,1)');
      fg.addColorStop(1, 'rgba(0,0,0,0)');
      g.globalCompositeOperation = 'destination-in';
      g.fillStyle = fg;
      g.fillRect(0, 0, bw, bh);
    }
    ctx.translate(lx, ly);
    ctx.rotate(dir > 0 ? -0.035 : Math.PI + 0.035);
    ctx.globalAlpha = clamp(beamA, 0, 1);
    ctx.drawImage(b, 0, 0, bw, bh, 0, -half, len, half * 2);
  }
  ctx.restore();
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  // the lamp: a hot core, a soft warm glow, and the flash when the beam faces us
  const gr = (18 + 64 * face) * s;
  const g2 = ctx.createRadialGradient(lx, ly, 0, lx, ly, gr);
  g2.addColorStop(0, rgbaS([255, 248, 226], la));
  g2.addColorStop(0.1, rgbaS([255, 232, 184], la * (0.7 + 0.3 * face)));
  g2.addColorStop(0.35, rgbaS(warm, la * (0.2 + 0.32 * face)));
  g2.addColorStop(0.7, rgbaS([255, 200, 140], la * 0.05 * (1 + face)));
  g2.addColorStop(1, rgbaS([255, 190, 130], 0));
  ctx.fillStyle = g2;
  ctx.fillRect(lx - gr, ly - gr, gr * 2, gr * 2);
  if (face > 0.05) {
    const fw = 120 * s * face, fh = 2.2 * s;
    const fg = ctx.createLinearGradient(lx - fw, 0, lx + fw, 0);
    fg.addColorStop(0, rgbaS(warm, 0));
    fg.addColorStop(0.5, rgbaS(warm, la * face * 0.75));
    fg.addColorStop(1, rgbaS(warm, 0));
    ctx.fillStyle = fg;
    ctx.fillRect(lx - fw, ly - fh / 2, fw * 2, fh);
  }
  ctx.restore();
}

function drawShafts(ctx, G, v, st, pal, u, sea, W) {
  const a = clamp((G.weather.rain || 0) * 0.9 + st.storm * 0.3, 0, 1);
  if (a < 0.03 || !SPR.shafts) return;
  const sp = SPR.shafts;
  const cell = 330 * u;
  const off = G.cam.x * v.scale * 0.014 + st.windOff[0] * u * 1.3;
  const k0 = Math.floor((off - 300 * u) / cell), k1 = Math.floor((off + W) / cell) + 1;
  for (let k = k0; k <= k1; k++) {
    const h = hash1(k, 71);
    if (h > a * 0.9) continue;
    const dw = lerp(70, 150, hash1(k, 72)) * u, dh = lerp(90, 170, hash1(k, 73)) * u;
    const x = k * cell + hash1(k, 74) * cell * 0.6 - off;
    if (x > W || x + dw < 0) continue;
    ctx.globalAlpha = a * lerp(0.35, 0.75, hash1(k, 75));
    ctx.drawImage(sp.tinted, x, sea - dh + 3 * u, dw, dh);
  }
  ctx.globalAlpha = 1;
}

function drawStrip(ctx, s, off, u, sea, W, alpha, yOff) {
  if (alpha < 0.01) return;
  const sw = s.w * u, sh = s.h * u, y = sea - sh + (yOff || 0);
  const x0 = -pmod(off, sw);
  ctx.globalAlpha = alpha;
  for (let x = x0; x < W; x += sw) {
    ctx.drawImage(s.tinted, x, y, sw + 0.5, sh);
    occlude(s.tinted, x, y, sw + 0.5, sh, alpha, null);
  }
  occludeStrip(s, x0, sw, u, sea, yOff || 0, alpha);
  ctx.globalAlpha = 1;
}

function drawHorizonAssets(ctx, G, v, pal, u, sea, W, alpha) {
  const d = getAsset('horizon_day'), n = getAsset('horizon_night');
  if (!d && !n) return false;
  const off = G.cam.x * v.scale * 0.015;
  const draw = (img, a) => {
    if (!img || a < 0.01) return;
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    if (!iw || !ih) return;
    const s = (130 * u) / ih, sw = iw * s, sh = ih * s;
    ctx.globalAlpha = a;
    for (let x = -pmod(off, sw); x < W; x += sw) ctx.drawImage(img, x, sea - sh + 2 * u, sw + 0.5, sh);
  };
  const nw = n ? pal.night : 0;
  if (d) draw(d, alpha * (n ? 1 : 1 - 0.6 * pal.night));
  if (n) draw(n, alpha * (d ? nw : 1));
  ctx.globalAlpha = 1;
  return true;
}

// Where the far lighthouse stands on screen (it exists late in the journey).
function lighthouseGeom(G, u, W) {
  const rx = G.raft && Number.isFinite(G.raft.x) ? G.raft.x : 0;
  const vis = smoothstep(15000, 15400, rx) * (1 - smoothstep(19000, 19600, rx)) * (1 - 0.8 * ((G.weather && G.weather.fog) || 0));
  const k = smoothstep(15000, 19500, rx);
  return { vis, x: W * lerp(0.93, 0.78, k), s: lerp(1.05, 1.55, k) * u };
}

function drawLighthouse(ctx, G, pal, u, sea, W) {
  const lh = lighthouseGeom(G, u, W);
  const vis = lh.vis;
  if (vis < 0.01) return;
  const x = lh.x, s = lh.s;
  const night = pal.night;
  const col = mixColor(pal.mtn.body, [8, 12, 24], night * 0.4);
  ctx.globalAlpha = vis * lerp(0.55, 1, night);
  ctx.fillStyle = rgbS(col);
  // islet
  ctx.beginPath();
  ctx.moveTo(x - 30 * s, sea + 1);
  ctx.quadraticCurveTo(x - 16 * s, sea - 7 * s, x - 3 * s, sea - 6.5 * s);
  ctx.lineTo(x + 5 * s, sea - 7.5 * s);
  ctx.quadraticCurveTo(x + 20 * s, sea - 5 * s, x + 34 * s, sea + 1);
  ctx.closePath();
  ctx.fill();
  // tower, gallery and lantern room
  ctx.beginPath();
  ctx.moveTo(x - 3 * s, sea - 6 * s);
  ctx.lineTo(x - 1.9 * s, sea - 25 * s);
  ctx.lineTo(x + 1.9 * s, sea - 25 * s);
  ctx.lineTo(x + 3 * s, sea - 6 * s);
  ctx.closePath();
  ctx.fill();
  ctx.fillRect(x - 2.8 * s, sea - 26.2 * s, 5.6 * s, 1.3 * s);
  ctx.fillRect(x - 1.5 * s, sea - 29.5 * s, 3 * s, 3.4 * s);
  ctx.beginPath();
  ctx.moveTo(x - 2 * s, sea - 29.4 * s);
  ctx.lineTo(x, sea - 31.6 * s);
  ctx.lineTo(x + 2 * s, sea - 29.4 * s);
  ctx.fill();
  ctx.globalAlpha = 1;
  // its light is drawn by drawWeather, after the lighting pass (drawLighthouseLight)
}

export function drawSky(ctx, G) {
  const v = G.view;
  const sea = v.seaScreenY;
  resetStamp();
  if (!(v.cssW > 0) || !buildOnce()) return;
  // the remaining cloud sprites bake a slice per frame (the title screen can spare more)
  pumpBake(G.mode === 'title' ? 9 : 5);
  if (!(sea > 0)) return;
  const st = ensureState(G);
  const W = v.cssW, u = unitOf(v);
  const H = Math.min(v.cssH, sea + 4);
  const now = performance.now() / 1000;
  const pal = computePalette(G, st);
  updateTints(pal);
  tickPresence();
  const sun = sunPos(G, v, u), moon = moonPos(G, v, u);
  const sunCol = sunColorAt(sun.e);
  const S = st.storm;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.clip();

  // 1. sky body (procedural gradient or painted panoramas)
  const base = drawBase(ctx, G, pal, W, H, sea, u);
  const procA = 1 - base.assetW;        // how much of the procedural art is still needed
  const cloudA = lerp(1, S, base.assetW);

  // 2. atmosphere glows
  drawAtmosphere(ctx, pal, sun, moon, W, sea, u);

  // 3. stars
  if (pal.starA > 0.01) drawStars(ctx, G, v, pal, st, sea, u, now, pal.starA * procA, pal.starA * (1 - 0.5 * base.assetW));

  // 4. sun (behind clouds) and moon
  const sunA = pal.sunA * smoothstep(-0.06, 0.02, sun.e);
  if (sun.e > -0.1 && sun.y - sun.r * 12 < H) {
    drawSunBehind(ctx, sun, pal, sunA, sunCol);
    STAMP.sunOn = true; STAMP.sx = sun.x; STAMP.sy = sun.y; STAMP.sr = sun.r;
    STAMP.sunOcc = islandCover(G, v, sun.x, sun.y, sun.r);
  }
  const moonA = pal.moonA * (1 - smoothstep(0.15, 0.6, pal.light)) * smoothstep(-0.05, 0.03, moon.e) * (1 - base.nightImg);
  if (moonA > 0.01) {
    drawMoon(ctx, moon, moonA, pal.night);
    // at night the moon is re-lit after the lighting pass (drawWeather); low on the horizon
    // things stand in front of it, so it is left alone there
    const restA = moonA * pal.night * (1 - pal.gloom) * smoothstep(20 * u, 90 * u, sea - moon.y) * (moon.y > -moon.r * 2 ? 1 : 0);
    prepareMoonMask(v, moon, restA);
    STAMP.moonOcc = islandCover(G, v, moon.x, moon.y, moon.r);
  }

  // 5. cirrus and clouds
  drawCirrus(ctx, G, v, st, u, sea, W, cloudA * (0.85 - 0.6 * S) * lerp(1, 0.7, pal.night));
  const glow = {
    alpha: cloudA,
    sx: sun.x, sy: sun.y, sunA: sunA * lerp(0.35, 1, 1 - smoothstep(0.2, 0.7, sun.e)) * (1 - pal.gloom),
    mx: moon.x, my: moon.y, moonA: moonA * 0.7 * (1 - pal.gloom),
  };
  drawCloudLayer(ctx, G, v, LAYERS[0], pal, st, u, sea, W, H, glow);
  drawShafts(ctx, G, v, st, pal, u, sea, W);
  drawCloudLayer(ctx, G, v, LAYERS[1], pal, st, u, sea, W, H, glow);

  // 6. far horizon: mountains, sea stacks, lighthouse
  const mtnA = (1 - 0.88 * (G.weather.fog || 0)) * (1 - 0.55 * S);
  if (!drawHorizonAssets(ctx, G, v, pal, u, sea, W, mtnA)) {
    drawStrip(ctx, SPR.mtnBack, G.cam.x * v.scale * 0.012 + 300, u, sea, W, mtnA * 0.95, 2 * u);
    drawStrip(ctx, SPR.mtnFront, G.cam.x * v.scale * 0.02 + 900, u, sea, W, mtnA, 1.5 * u);
  }
  drawLighthouse(ctx, G, pal, u, sea, W);
  // a soft line of haze along the horizon
  const hzA = 0.35 + 0.35 * (G.weather.fog || 0);
  const hg = ctx.createLinearGradient(0, sea - 26 * u, 0, sea + 4);
  hg.addColorStop(0, rgbaS(pal.sky[4], 0));
  hg.addColorStop(1, rgbaS(mixColor(pal.sky[4], [255, 255, 255], 0.08 * (1 - pal.night)), hzA));
  ctx.fillStyle = hg;
  ctx.fillRect(0, sea - 26 * u, W, 30 * u + 4);

  // 7. close high clouds
  drawCloudLayer(ctx, G, v, LAYERS[2], pal, st, u, sea, W, H, glow);

  // 8. sun veil over the clouds and crepuscular rays
  if (sunA > 0.02 && sun.e > -0.05) {
    const R = sun.r * 5;
    const g = ctx.createRadialGradient(sun.x, sun.y, 0, sun.x, sun.y, R);
    g.addColorStop(0, rgbaS(sunCol, 0.3 * sunA));
    g.addColorStop(1, rgbaS(sunCol, 0));
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = g;
    ctx.fillRect(sun.x - R, sun.y - R, R * 2, R * 2);
    const raysA = sunA * (0.05 + 0.3 * (1 - smoothstep(0.08, 0.45, sun.e))) * (0.5 + 0.5 * st.cover) * (1 - pal.gloom);
    if (raysA > 0.02 && SPR.rays) {
      const rs = 1100 * u;
      ctx.save();
      ctx.translate(sun.x, sun.y);
      ctx.rotate((G.time || 0) * 0.004);
      ctx.globalAlpha = clamp(raysA, 0, 1);
      ctx.drawImage(SPR.rays, -rs / 2, -rs / 2, rs, rs);
      ctx.restore();
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  // 9. storm ceiling and lightning inside the clouds
  if (S > 0.01 || pal.gloom > 0.01) {
    const gA = Math.max(S, pal.gloom * 0.5);
    const top = sea - SKY_REF * u * 0.85;
    const g = ctx.createLinearGradient(0, top, 0, sea);
    g.addColorStop(0, rgbaS(pal.stormDark, 0.78 * gA));
    g.addColorStop(0.5, rgbaS(pal.stormDark, 0.36 * gA));
    g.addColorStop(0.82, rgbaS(pal.stormDark, 0.05 * gA));
    g.addColorStop(1, rgbaS(pal.stormDark, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // a pale break of light far away under the cloud deck
    const hb = ctx.createLinearGradient(0, sea - 80 * u, 0, sea);
    const bc = scaleC([150, 168, 166], lerp(0.35, 1, pal.light));
    hb.addColorStop(0, rgbaS(bc, 0));
    hb.addColorStop(1, rgbaS(bc, 0.3 * S));
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = hb;
    ctx.fillRect(0, sea - 80 * u, W, 80 * u + 4);
    ctx.globalCompositeOperation = 'source-over';
  }
  const L = G.weather.lightning || 0;
  if (L > 0.02) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = rgbaS([120, 132, 190], 0.28 * L);
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.restore();
  presSnap = false;
}

// ============================================================================
// Drawing — weather (screen space, after lighting)
// ============================================================================
const DROPS = [];
for (let i = 0; i < 820; i++) DROPS.push({ x: Math.random(), y: Math.random(), l: rnd(0.6, 1.25), s: rnd(0.85, 1.2), near: i % 3 === 0 });

function drawRain(ctx, G, v, u, sea, now, light, L) {
  const rain = G.weather.rain || 0;
  if (rain < 0.01 || sea <= 0) return;
  const W = v.cssW;
  const wind = G.weather.wind || 0;
  const vy = 1150 * u, vx = wind * 420 * u;
  const sp = Math.hypot(vx, vy), ux = vx / sp, uy = vy / sp;
  const Wd = W + 400 * u, Hd = v.cssH + 120 * u;
  const n = Math.floor(DROPS.length * clamp(rain, 0, 1));
  const bright = lerp(0.32, 1, light) + L * 0.8;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, Math.min(v.cssH, sea + 4 * u));
  ctx.clip();
  ctx.lineCap = 'round';
  for (let pass = 0; pass < 2; pass++) {
    const near = pass === 1;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const d = DROPS[i];
      if (d.near !== near) continue;
      const spd = (near ? 1.2 : 0.8) * d.s;
      const px = pmod(d.x * Wd + now * vx * spd, Wd) - 200 * u;
      const py = pmod(d.y * Hd + now * vy * spd, Hd) - 60 * u;
      const len = (near ? 36 : 17) * u * d.l;
      ctx.moveTo(px, py);
      ctx.lineTo(px - ux * len, py - uy * len);
    }
    ctx.strokeStyle = near ? rgbaS([200, 212, 228], 0.34 * bright * (0.6 + 0.4 * rain)) : rgbaS([176, 192, 214], 0.22 * bright);
    ctx.lineWidth = (near ? 1.1 : 0.7) * u;
    ctx.stroke();
  }
  ctx.restore();
  // splashes on the water line
  const ns = Math.floor(70 * rain);
  if (ns > 0 && sea < v.cssH) {
    ctx.beginPath();
    for (let i = 0; i < ns; i++) {
      const x = Math.random() * W, y = sea + rnd(-1, 9) * u, s = rnd(1.5, 3.2) * u;
      ctx.moveTo(x - s, y);
      ctx.lineTo(x - s * 0.3, y - s * 1.3);
      ctx.moveTo(x + s, y);
      ctx.lineTo(x + s * 0.3, y - s * 1.3);
    }
    ctx.strokeStyle = rgbaS([215, 225, 240], 0.35 * bright);
    ctx.lineWidth = 0.9 * u;
    ctx.stroke();
  }
}

// How thick the fog banks look. By day a bright sky gives them little contrast, so the day
// term is nearly as strong as the night one.
function fogStrength(G, night) {
  const W = G.weather;
  const f = clamp((W.fog || 0) + (W.rain || 0) * 0.2, 0, 1);
  return f < 0.02 ? 0 : f * (0.82 + 0.18 * night);
}
function drawFogBanks(ctx, G, v, pal, u, sea, now) {
  const W = G.weather;
  if (sea < -150 * u || !SPR.fog.length) return;
  const night = pal.night;
  const strength = fogStrength(G, night);
  if (strength < 0.035) return;
  const fc = pal.fogC;
  // haze wall over the sea surface
  const top = sea - 280 * u, bot = sea + 220 * u;
  const g = ctx.createLinearGradient(0, top, 0, bot);
  const dayK = 1 - night;
  g.addColorStop(0, rgbaS(fc, 0));
  g.addColorStop(0.3, rgbaS(fc, (0.12 + 0.1 * dayK) * strength));
  g.addColorStop(0.45, rgbaS(fc, (0.3 + 0.14 * dayK) * strength));
  g.addColorStop(0.56, rgbaS(fc, (0.24 + 0.16 * dayK) * strength));
  g.addColorStop(0.8, rgbaS(fc, 0.08 * dayK * strength));
  g.addColorStop(1, rgbaS(fc, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, Math.max(0, top), v.cssW, bot - Math.max(0, top));
  // drifting wisps, nearer ones move with the world
  const bands = [-95, -55, -25, 5, 32];
  const wdir = (W.wind || 0) >= 0 ? 1 : -1;
  for (let i = 0; i < bands.length; i++) {
    const spr = SPR.fog[i % SPR.fog.length];
    const sc = (u / spr.sc) * (1 + i * 0.12);
    const sw = spr.w * sc, sh = spr.h * sc;
    const par = 0.35 + i * 0.18;
    const speed = (5 + i * 4) * u * (0.4 + Math.abs(W.wind || 0)) * wdir;
    const off = G.cam.x * v.scale * par - now * speed + i * 517;
    const y = sea + bands[i] * u - sh / 2;
    if (y > v.cssH || y + sh < 0) continue;
    ctx.globalAlpha = clamp(strength * (i < 2 ? 0.42 : 0.26 - 0.03 * i) * (1 + 0.35 * (1 - night)), 0, 0.8);
    for (let x = -pmod(off, sw); x < v.cssW; x += sw) ctx.drawImage(spr.tinted, x, y, sw + 0.5, sh);
  }
  ctx.globalAlpha = 1;
}

function drawBolt(ctx, G, v, st, u, sea, L) {
  const b = st.bolt;
  if (!b || L < 0.12 || sea <= 0) return;
  const a = clamp((L - 0.1) * 1.6, 0, 1);
  const ox = b.ax * v.cssW;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, v.cssW, Math.min(v.cssH, sea));
  ctx.clip();
  ctx.globalCompositeOperation = 'lighter';
  // the cloud base glows where the bolt leaves it
  const tx = ox + b.paths[0].pts[0] * u, ty = sea - b.paths[0].pts[1] * u, gr = 120 * u;
  const g = ctx.createRadialGradient(tx, ty, 0, tx, ty, gr);
  g.addColorStop(0, rgbaS([190, 200, 255], 0.55 * a));
  g.addColorStop(0.35, rgbaS([150, 165, 240], 0.18 * a));
  g.addColorStop(1, rgbaS([120, 140, 230], 0));
  ctx.fillStyle = g;
  ctx.fillRect(tx - gr, ty - gr, gr * 2, gr * 2);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const passes = [[9, [140, 160, 255], 0.12], [3.2, [190, 205, 255], 0.45], [1.3, [255, 255, 255], 1]];
  for (const [lw, col, al] of passes) {
    ctx.strokeStyle = rgbaS(col, al * a);
    for (const p of b.paths) {
      ctx.lineWidth = lw * u * p.w;
      ctx.beginPath();
      for (let i = 0; i < p.pts.length; i += 2) {
        const x = ox + p.pts[i] * u, y = sea - p.pts[i + 1] * u;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }
  ctx.restore();
}

// "How night does the sky look" (from the painted zenith), without building a palette.
function skyNight(G) {
  return 1 - smoothstep(20, 75, luma(sampleKeys(SKY_KEYS, G.phase || 0)[0]));
}

export function drawWeather(ctx, G) {
  const v = G.view;
  if (!(v.cssW > 0) || !buildOnce()) return;
  const st = ensureState(G);
  const W = G.weather;
  const sea = v.seaScreenY, u = unitOf(v);
  const now = performance.now() / 1000;
  const light = G.light == null ? 1 : G.light;
  const L = W.lightning || 0;
  // the lights of the night sky come back after the darkness pass: the moon, the far lighthouse
  drawMoonRestamp(ctx);
  const night = skyNight(G);
  drawLighthouseLight(ctx, G, v, u, sea, now, night);

  const needFog = fogStrength(G, night) >= 0.035;
  if (!needFog && (W.rain || 0) < 0.01 && L < 0.01) return;
  const pal = needFog ? computePalette(G, st) : null;

  if (pal) drawFogBanks(ctx, G, v, pal, u, sea, now);
  drawRain(ctx, G, v, u, sea, now, light, L);
  // fine mist that greys everything a little in rain
  const mist = (W.rain || 0) * 0.07 + st.storm * 0.06;
  const mistH = Math.min(v.cssH, sea + 30 * u);
  if (mist > 0.005 && mistH > 0) {
    // only the air is hazy with rain; it thins out just under the surface
    const mc = pal ? pal.fogC : [120, 130, 145], ma = mist * lerp(0.5, 1, light);
    const g = ctx.createLinearGradient(0, sea - 30 * u, 0, sea + 30 * u);
    g.addColorStop(0, rgbaS(mc, ma));
    g.addColorStop(1, rgbaS(mc, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, v.cssW, mistH);
  }
  if (L > 0.01) {
    const depthK = sea > 0 ? 1 : Math.exp(sea / (220 * u));
    drawBolt(ctx, G, v, st, u, sea, L);
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = rgbaS([196, 208, 255], L * 0.36 * depthK);
    ctx.fillRect(0, 0, v.cssW, v.cssH);
    ctx.globalCompositeOperation = 'source-over';
  }
}
