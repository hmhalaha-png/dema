// =====================================================================================
// 少年与海 — sound (worker: AUDIO)
//
// Pure WebAudio synthesis: there is not a single audio file. Everything is noise
// buffers, oscillators, filters and a few small buffers rendered in JS once.
//
//   AudioContext ─ limiter ─ master(0.6)
//      ├─ worldOut ← uwLP (muffles everything when the boy's head is under water)
//      │               ← worldIn ← amb (ambience layers + one-shot ambience)
//      │                         ← sfx (gameplay sounds)
//      ├─ uw     (sounds that live under water: hum, bubbles — never muffled)
//      ├─ music  (music box / celesta cues, the night pad)  ─┐
//      ├─ ui     (menu ticks, heartbeat)                     │
//      └─ verbOut ← convolver ← verbLP ← verbWorld (sends)   │
//                             ← verbDirect ←─────────────────┘
//
// Rules this module keeps:
//   - Nothing is created or resumed before unlockAudio() has been called from a
//     user gesture (the HUD calls it; a one-time pointerdown/keydown listener added
//     in init() is the fallback). Before that, and while muted, everything is a
//     silent no-op and the AudioContext is suspended.
//   - Ambience layers are long-lived looped sources whose gains are crossfaded from
//     G every 50 ms; a layer that stays silent for a few seconds is torn down.
//   - One-shot sounds are "voices": every node they create is remembered and
//     disconnected after the voice ends. Each sfx name is throttled and capped.
//   - Music is sparse: short cues at sunrise, dusk, a first island landing, the
//     lighthouse, death and the ending. At night a slow uneasy pad breathes instead.
// =====================================================================================

import { C } from '../core/state.js';
import { waterY } from '../core/world.js';
import { clamp, lerp, smoothstep, noise1 } from '../core/util.js';
import { islandAt } from './islands.js';

const MUTE_KEY = 'shaonian-yu-hai:mute';
const HUD_MUTE_KEY = 'shaonian-yu-hai:muted'; // the HUD keeps its own copy; honour it too
const MASTER = 0.6;

const rnd = (a, b) => a + Math.random() * (b - a);
const rndi = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
const pickOne = (arr) => arr[(Math.random() * arr.length) | 0];
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const fin = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

function readMute() {
  try {
    const v = localStorage.getItem(MUTE_KEY);
    if (v === '1' || v === '0') return v === '1';
    return localStorage.getItem(HUD_MUTE_KEY) === '1';
  } catch (e) { return false; }
}

// ---------------------------------------------------------------- module state
let A = null;              // the engine; null until unlocked (and not muted)
let muted = readMute();
let gestured = false;      // a user gesture has reached unlockAudio()
let failures = 0;          // AudioContext creation failures (give up after a few)
let G0 = null;             // the last G seen by update() (sfx() has no G argument)
let hooked = false;        // fallback gesture + visibility listeners installed
let hidden = false;        // the page is hidden: the context is suspended
let suspendTimer = 0;
let warmTimer = 0;

// =====================================================================================
// low-level node helpers
// =====================================================================================

function gainNode(ctx, v, to) {
  const g = ctx.createGain();
  g.gain.value = v;
  if (to) g.connect(to);
  return g;
}
function filterNode(ctx, type, f, Q) {
  const n = ctx.createBiquadFilter();
  n.type = type;
  n.frequency.value = f;
  n.Q.value = Q == null ? 0.7 : Q;
  return n;
}
const nowOf = (E) => E.ctx.currentTime + E.offset;

// Smoothly move an AudioParam toward v. Skips redundant automation events.
function setP(E, p, v, tau) {
  if (!p || !Number.isFinite(v)) return;
  if (p._v !== undefined && Math.abs(p._v - v) <= Math.abs(v) * 0.004 + 1e-5) return;
  p._v = v;
  try { p.setTargetAtTime(v, E.ctx.currentTime, tau); } catch (e) { p.value = v; }
}

// attack → exponential decay. Returns a safe stop time for the sources feeding it.
function env(p, t, peak, a, d) {
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + a);
  p.setTargetAtTime(0, t + a, d / 4);
  return t + a + d * 1.5;
}
function sweep(p, t, a, b, dur) {
  p.setValueAtTime(a, t);
  p.exponentialRampToValueAtTime(Math.max(1, b), t + dur);
}

// =====================================================================================
// procedural buffers (rendered once, reused forever)
// =====================================================================================

function normalize(d, peak) {
  let m = 0;
  for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > m) m = a; }
  if (m > 0) { const k = peak / m; for (let i = 0; i < d.length; i++) d[i] *= k; }
}
function toBuffer(ctx, data, channels = 1) {
  const n = channels === 1 ? data.length : data[0].length;
  const b = ctx.createBuffer(channels, n, ctx.sampleRate);
  if (channels === 1) b.getChannelData(0).set(data);
  else for (let c = 0; c < channels; c++) b.getChannelData(c).set(data[c]);
  return b;
}

// Seamlessly looping noise. white: flat, pink: -3 dB/oct, brown: -6 dB/oct.
function noiseBuf(ctx, kind, secs) {
  const sr = ctx.sampleRate, n = Math.floor(sr * secs), xf = Math.floor(sr * 0.08);
  const raw = new Float32Array(n + xf);
  if (kind === 'white') {
    for (let i = 0; i < raw.length; i++) raw[i] = Math.random() * 2 - 1;
  } else if (kind === 'pink') {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < raw.length; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      raw[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
    }
  } else {
    let l = 0, x1 = 0, y1 = 0;
    for (let i = 0; i < raw.length; i++) {
      l = (l + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      const y = l - x1 + 0.9993 * y1; // remove the slow DC wander
      x1 = l; y1 = y; raw[i] = y;
    }
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = raw[i];
  for (let i = 0; i < xf; i++) { const a = i / xf; out[i] = raw[i] * a + raw[n + i] * (1 - a); }
  normalize(out, kind === 'white' ? 0.7 : 0.9);
  return toBuffer(ctx, out);
}

// A dark stereo hall for the music box and the far-away things.
function makeIR(ctx, secs) {
  const sr = ctx.sampleRate, n = Math.floor(sr * secs), pre = Math.floor(sr * 0.016);
  const chans = [new Float32Array(n), new Float32Array(n)];
  for (let c = 0; c < 2; c++) {
    const d = chans[c];
    let lp = 0;
    for (let i = pre; i < n; i++) {
      const u = (i - pre) / (n - pre);
      const e = Math.pow(1 - u, 2.3) * Math.min(1, (i - pre) / (sr * 0.012));
      const a = 0.78 - 0.62 * u; // the tail darkens as it decays
      lp += a * ((Math.random() * 2 - 1) - lp);
      d[i] = lp * e;
    }
  }
  return toBuffer(ctx, chans, 2);
}

// Wood under strain: a stick-slip pulse train exciting a few damped wood modes.
function synthCreak(ctx) {
  const sr = ctx.sampleRate;
  const dur = rnd(0.45, 1.15), n = Math.floor(sr * dur);
  const out = new Float32Array(n);
  const kl = Math.floor(sr * 0.05), ker = new Float32Array(kl);
  const modes = [[rnd(330, 520), 0.016, 1], [rnd(820, 1250), 0.008, 0.55], [rnd(1900, 2700), 0.0035, 0.28], [rnd(150, 220), 0.03, 0.45]];
  for (let j = 0; j < kl; j++) {
    const tt = j / sr; let s = 0;
    for (const [f, tau, a] of modes) s += a * Math.exp(-tt / tau) * Math.sin(6.283185 * f * tt);
    ker[j] = s;
  }
  const r0 = rnd(22, 48), r1 = rnd(70, 150), glide = Math.random() < 0.5;
  let pos = Math.floor(sr * 0.01);
  while (pos < n - 1) {
    const u = pos / n;
    const hump = Math.sin(Math.PI * Math.min(1, u * 1.08));
    const rate = r0 + (r1 - r0) * (glide ? u : hump);
    const amp = Math.pow(Math.max(0, hump), 0.7) * (0.5 + 0.5 * Math.random());
    const lim = Math.min(kl, n - pos);
    for (let j = 0; j < lim; j++) out[pos + j] += amp * ker[j];
    pos += Math.max(1, Math.floor(sr / (rate * (0.82 + 0.36 * Math.random()))));
  }
  const fo = Math.floor(sr * 0.012);
  for (let i = 0; i < fo; i++) out[n - 1 - i] *= i / fo;
  normalize(out, 0.85);
  return toBuffer(ctx, out);
}

// A herring gull: "kee-kee-kyaaw", harmonics through a nasal formant, rough AM.
function synthGull(ctx) {
  const sr = ctx.sampleRate;
  const notes = rndi(2, 4), base = rnd(0.86, 1.14), segs = [];
  let total = 0.02;
  for (let i = 0; i < notes; i++) {
    const last = i === notes - 1;
    const d = last ? rnd(0.3, 0.46) : rnd(0.15, 0.25);
    segs.push({ s: total, d, f0: 1120 * base * (last ? 0.9 : rnd(0.95, 1.08)) });
    total += d + rnd(0.07, 0.16);
  }
  const n = Math.floor(sr * (total + 0.05)), out = new Float32Array(n);
  for (const sg of segs) {
    const s0 = Math.floor(sg.s * sr), len = Math.floor(sg.d * sr);
    const fpk = sg.f0 * rnd(1.35, 1.6), fend = sg.f0 * rnd(0.68, 0.84), jit = rnd(55, 80);
    let ph = 0;
    for (let j = 0; j < len && s0 + j < n; j++) {
      const u = j / len, tt = j / sr;
      let f = u < 0.2 ? sg.f0 + (fpk - sg.f0) * Math.sin(u / 0.2 * Math.PI / 2) : fpk + (fend - fpk) * Math.pow((u - 0.2) / 0.8, 0.8);
      f *= 1 + 0.015 * Math.sin(6.283185 * 23 * tt);
      ph += 6.283185 * f / sr;
      let s = 0;
      for (let h = 1; h <= 7; h++) {
        const fh = f * h;
        if (fh > sr * 0.45) break;
        const w = Math.exp(-Math.pow((fh - 2700) / 1500, 2)) + 0.15 / h;
        s += w * Math.sin(h * ph);
      }
      const e = Math.min(1, u / 0.06) * Math.pow(1 - u, 0.9);
      const rough = 0.72 + 0.28 * Math.sin(6.283185 * jit * tt + 2 * Math.sin(6.283185 * 9 * tt));
      out[s0 + j] += (s * rough + (Math.random() * 2 - 1) * 0.12) * e;
    }
  }
  normalize(out, 0.8);
  return toBuffer(ctx, out);
}

// Rain on planks and water: sparse ticks and tiny plinks, wraps seamlessly.
function synthDrops(ctx, secs) {
  const sr = ctx.sampleRate, n = Math.floor(sr * secs), out = new Float32Array(n);
  const count = Math.floor(secs * 170);
  for (let k = 0; k < count; k++) {
    const pos = (Math.random() * n) | 0;
    const a = 0.06 + Math.pow(Math.random(), 3) * 0.9;
    if (Math.random() < 0.82) {
      const L = Math.floor(sr * rnd(0.0015, 0.005));
      let prev = 0;
      for (let j = 0; j < L; j++) { const w = Math.random() * 2 - 1; out[(pos + j) % n] += a * (w - prev) * Math.exp(-j / (L * 0.3)); prev = w; }
    } else {
      const f = rnd(1500, 4200), L = Math.floor(sr * rnd(0.01, 0.025));
      for (let j = 0; j < L; j++) out[(pos + j) % n] += a * 0.6 * Math.sin(6.283185 * f * j / sr) * Math.exp(-j / (L * 0.25));
    }
  }
  normalize(out, 0.9);
  return toBuffer(ctx, out);
}

// Three crickets with different rhythms. The loop is 4 s; two copies at different
// rates play together so the pattern never audibly repeats.
function synthCrickets(ctx) {
  const sr = ctx.sampleRate, secs = 4, n = sr * secs, out = new Float32Array(n);
  const bugs = [
    { f: 4650, every: 0.5, pulses: 3, gap: 0.032, plen: 0.016, a: 0.55, off: 0.05 },
    { f: 4180, every: 0.8, pulses: 4, gap: 0.028, plen: 0.014, a: 0.32, off: 0.31 },
    { f: 5250, every: 0.4, pulses: 2, gap: 0.036, plen: 0.018, a: 0.16, off: 0.17 },
  ];
  for (const b of bugs) {
    for (let c = b.off; c < secs; c += b.every) {
      if (Math.random() < 0.1) continue;
      for (let p = 0; p < b.pulses; p++) {
        const s = Math.floor((c + p * b.gap) * sr), L = Math.floor(b.plen * sr), amp = b.a * rnd(0.75, 1);
        for (let j = 0; j < L; j++) {
          const w = Math.sin(Math.PI * j / L);
          const idx = (s + j) % n;
          out[idx] += amp * w * w * Math.sin(6.283185 * b.f * (s + j) / sr);
        }
      }
    }
  }
  normalize(out, 0.8);
  return toBuffer(ctx, out);
}

function creakBuf(E) {
  if (!E.buf.creaks) E.buf.creaks = [synthCreak(E.ctx), synthCreak(E.ctx), synthCreak(E.ctx), synthCreak(E.ctx)];
  return pickOne(E.buf.creaks);
}
function gullBuf(E) {
  if (!E.buf.gulls) E.buf.gulls = [synthGull(E.ctx), synthGull(E.ctx), synthGull(E.ctx)];
  return pickOne(E.buf.gulls);
}
function dropsBuf(E) { return E.buf.drops || (E.buf.drops = synthDrops(E.ctx, 3)); }
function cricketBuf(E) { return E.buf.crickets || (E.buf.crickets = synthCrickets(E.ctx)); }

// Render the lazily built buffers a little after unlock so no gameplay frame pays for them.
function warm(E) {
  const jobs = [creakBuf, dropsBuf, gullBuf, cricketBuf];
  let i = 0;
  const next = () => {
    if (A !== E || i >= jobs.length) return;
    try { jobs[i++](E); } catch (e) { i++; }
    warmTimer = setTimeout(next, 120);
  };
  clearTimeout(warmTimer);
  warmTimer = setTimeout(next, 400);
}

// =====================================================================================
// the engine
// =====================================================================================

function buildEngine(ctx) {
  const E = {
    ctx, offset: 0,
    voices: [], byName: Object.create(null), last: Object.create(null),
    buf: {}, layers: {}, hasPan: typeof ctx.createStereoPanner === 'function',
    clock: 0, pt: 0, pdt: 0.05, under: false, ghostCue: false,
    s: {
      night: 0, day: 1, wv: 0, rain: 0, wind: 0.2, fog: 0, storm: 0, under: 0, depth: 0, deep: 0,
      nearRaft: 1, land: 0, gulls: 0, dolphin: 0, glow: 0, ghost: 0, danger: 0, beastNear: 0,
      grill: 0, flame: 0, sail: 0, gust: 0.5, mode: 'title', fade: 0,
    },
    swL: { waves: [], next: 0.2, body: 0.3, crest: 0 },
    swR: { waves: [], next: 1.7, body: 0.3, crest: 0 },
    ev: {
      gull: rnd(5, 12), creak: rnd(2, 6), lap: 0.6, moan: rnd(30, 60), groan: rnd(50, 90), bubble: 1,
      breath: 2, bird: 2, tinkle: 2, dolphin: 2, bell: rnd(4, 9), flap: rnd(3, 6),
    },
    pad: { on: false, t: rnd(3, 8), amp: 0, chord: 0, next: 10 },
    mus: { q: [], i: 0, busyUntil: 0, lastEnd: -999, cur: null, titleT: 1.2 },
  };

  E.buf.white = noiseBuf(ctx, 'white', 2.5);
  E.buf.pink = noiseBuf(ctx, 'pink', 4.5);
  E.buf.brown = noiseBuf(ctx, 'brown', 5);

  const lim = ctx.createDynamicsCompressor();
  lim.threshold.value = -9; lim.knee.value = 8; lim.ratio.value = 8;
  lim.attack.value = 0.004; lim.release.value = 0.28;
  lim.connect(ctx.destination);
  E.lim = lim;
  E.master = gainNode(ctx, 0, lim);

  E.uwLP = filterNode(ctx, 'lowpass', 20000, 0);
  E.worldOut = gainNode(ctx, 1, E.master);
  E.uwLP.connect(E.worldOut);
  E.worldIn = gainNode(ctx, 1, E.uwLP);
  E.amb = gainNode(ctx, 1, E.worldIn);
  E.sfx = gainNode(ctx, 0.9, E.worldIn);
  E.uw = gainNode(ctx, 1, E.master);
  E.music = gainNode(ctx, 0.8, E.master);
  E.ui = gainNode(ctx, 0.8, E.master);
  E.ghostLP = filterNode(ctx, 'lowpass', 1250, 1);
  E.ghostLP.connect(E.music);

  E.verb = ctx.createConvolver();
  E.verb.buffer = makeIR(ctx, 2.6);
  E.verbOut = gainNode(ctx, 0.5, E.master);
  E.verb.connect(E.verbOut);
  E.verbLP = filterNode(ctx, 'lowpass', 20000, 0);
  E.verbLP.connect(E.verb);
  E.verbWorld = gainNode(ctx, 1, E.verbLP);
  E.verbDirect = gainNode(ctx, 1, E.verb);
  E.music.connect(gainNode(ctx, 0.5, E.verbDirect));
  E.uw.connect(gainNode(ctx, 0.22, E.verbDirect));

  for (const k of Object.keys(BUILD)) E.layers[k] = { build: BUILD[k], n: null, quiet: 0, fail: 0 };

  const t = ctx.currentTime;
  E.master.gain.setValueAtTime(0, t);
  E.master.gain.setTargetAtTime(MASTER, t + 0.05, 0.6);
  return E;
}

function ensureEngine() {
  if (A || failures > 3) return A;
  const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  if (!AC) { failures = 99; return null; }
  let ctx = null;
  try {
    ctx = new AC({ latencyHint: 'interactive' });
    A = buildEngine(ctx);
    warm(A);
  } catch (e) {
    failures++;
    A = null;
    try { if (ctx) ctx.close(); } catch (er) { /* ignore */ }
  }
  return A;
}

// =====================================================================================
// voices (one-shot sounds)
// =====================================================================================

class Voice {
  constructor(E, name, bus, vol, pan) {
    const c = E.ctx;
    this.E = E; this.c = c; this.name = name;
    this.out = c.createGain();
    this.out.gain.value = vol;
    this.nodes = [this.out];
    if (pan && E.hasPan) {
      const p = c.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      this.out.connect(p); p.connect(bus);
      this.nodes.push(p);
    } else this.out.connect(bus);
    this.end = nowOf(E) + 0.1;
    E.voices.push(this);
    E.byName[name] = (E.byName[name] || 0) + 1;
  }
  g(v, to) {
    const n = this.c.createGain();
    n.gain.value = v;
    n.connect(to || this.out);
    this.nodes.push(n);
    return n;
  }
  f(type, freq, Q, to) {
    const n = filterNode(this.c, type, freq, Q);
    n.connect(to || this.out);
    this.nodes.push(n);
    return n;
  }
  osc(type, freq, t, stop, to) {
    const o = this.c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (to !== false) o.connect(to || this.out);
    o.start(t); o.stop(stop);
    this.nodes.push(o);
    if (stop > this.end) this.end = stop;
    return o;
  }
  noise(kind, t, stop, to, rate) {
    const s = this.c.createBufferSource(), b = this.E.buf[kind];
    s.buffer = b;
    const rr = rate || 1;
    s.playbackRate.value = rr;
    const need = (stop - t) * rr;
    if (need > b.duration - 0.05) { s.loop = true; s.start(t, Math.random() * b.duration * 0.5); }
    else s.start(t, Math.random() * Math.max(0, b.duration - need - 0.02));
    s.stop(stop);
    s.connect(to || this.out);
    this.nodes.push(s);
    if (stop > this.end) this.end = stop;
    return s;
  }
  play(buffer, t, rate, to) {
    const s = this.c.createBufferSource();
    s.buffer = buffer;
    s.playbackRate.value = rate || 1;
    s.connect(to || this.out);
    const stop = t + buffer.duration / (rate || 1) + 0.02;
    s.start(t); s.stop(stop);
    this.nodes.push(s);
    if (stop > this.end) this.end = stop;
    return s;
  }
  send(amt, world) {
    const s = this.c.createGain();
    s.gain.value = amt;
    this.out.connect(s);
    s.connect(world === false ? this.E.verbDirect : this.E.verbWorld);
    this.nodes.push(s);
  }
}

function reap(E) {
  const now = E.ctx.currentTime + E.offset, V = E.voices;
  let w = 0;
  for (let i = 0; i < V.length; i++) {
    const v = V[i];
    if (now > v.end + 0.15) {
      for (const n of v.nodes) { try { n.disconnect(); } catch (e) { /* already gone */ } }
      E.byName[v.name] = Math.max(0, (E.byName[v.name] || 1) - 1);
    } else V[w++] = v;
  }
  V.length = w;
}

// --- building blocks shared by the recipes
function hit(v, kind, t, type, f, Q, peak, a, d, to, rate) {
  const g = v.g(0, to);
  const fl = v.f(type, f, Q, g);
  const end = env(g.gain, t, peak, a, d);
  v.noise(kind, t, end, fl, rate);
  return fl;
}
function blip(v, t, f0, f1, d, peak, type, to) {
  const g = v.g(0, to);
  const o = v.osc(type || 'sine', f0, t, t + d * 1.6 + 0.03, g);
  o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + d);
  env(g.gain, t, peak, 0.002, d);
  return o;
}
// partials: [ratio, amplitude, decay multiplier]
const BOX = [[1, 1, 1], [2.01, 0.14, 0.32], [6.27, 0.05, 0.05]];
const CEL = [[1, 1, 0.8], [2, 0.3, 0.25], [3, 0.09, 0.1], [4.16, 0.035, 0.05]];
const GLASS = [[1, 1, 1], [2.76, 0.12, 0.25], [5.4, 0.04, 0.1]];
const BELL = [[0.5, 0.5, 1.2], [1, 1, 1], [1.19, 0.45, 0.7], [1.5, 0.3, 0.5], [2, 0.35, 0.4], [2.52, 0.15, 0.25], [3.01, 0.1, 0.15]];
function bell(v, f, t, peak, d, parts, to, detune) {
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i], fr = f * p[0];
    if (fr > 14000) continue;
    const dd = Math.max(0.03, d * p[2]);
    const g = v.g(0, to);
    const o = v.osc('sine', fr, t, t + dd * 1.5 + 0.03, g);
    if (detune) o.detune.value = detune;
    env(g.gain, t, peak * p[1], i === 0 ? 0.003 : 0.0015, dd);
  }
}
function bubbles(v, t, n, spread, gain, low, to) {
  for (let i = 0; i < n; i++) {
    const tt = t + Math.pow(Math.random(), 1.6) * spread;
    const f = rnd(260, 760) * (low || 1);
    blip(v, tt, f, f * rnd(1.6, 2.4), rnd(0.03, 0.06), rnd(0.08, 0.2) * gain, 'sine', to);
  }
}
function knock(v, t, a, p) {
  const k = p || 1;
  hit(v, 'white', t, 'bandpass', 1700 * k, 3, 0.5 * a, 0.001, 0.035);
  blip(v, t, 240 * k, 170 * k, 0.07, 0.55 * a, 'triangle');
}
function creakIn(v, t, peak, rate) {
  const g = v.g(peak);
  v.play(creakBuf(v.E), t, rate, g);
}
// a whale-like moan: a sawtooth through a moving vocal formant, slow glide + vibrato
function moan(v, t, p, to) {
  const dur = rnd(2.6, 3.8), f0 = 105 * p;
  const g = v.g(0, to);
  const lp = v.f('lowpass', 1100, 0, g);
  const bp = v.f('bandpass', 400, 2.2, lp);
  const o1 = v.osc('triangle', f0, t, t + dur + 1.2, bp);
  const o3 = v.osc('sawtooth', f0, t, t + dur + 1.2, v.g(0.18, bp)); // a little throat
  const o2 = v.osc('sine', f0 * 2, t, t + dur + 1.2, v.g(0.25, g)); // a quieter pure octave
  const contour = (prm, m) => {
    prm.setValueAtTime(f0 * m, t);
    prm.linearRampToValueAtTime(f0 * 1.55 * m, t + dur * 0.3);
    prm.linearRampToValueAtTime(f0 * 1.32 * m, t + dur * 0.62);
    prm.exponentialRampToValueAtTime(f0 * 0.78 * m, t + dur);
  };
  contour(o1.frequency, 1); contour(o2.frequency, 2); contour(o3.frequency, 1);
  o3.detune.value = rnd(6, 14);
  const lfo = v.osc('sine', rnd(4.2, 5.6), t, t + dur + 1.2, false);
  lfo.connect(v.g(f0 * 0.025, o1.frequency));
  lfo.connect(v.g(f0 * 0.025, o3.frequency));
  lfo.connect(v.g(f0 * 0.05, o2.frequency));
  bp.frequency.setValueAtTime(300, t);
  bp.frequency.linearRampToValueAtTime(820, t + dur * 0.35);
  bp.frequency.exponentialRampToValueAtTime(260, t + dur);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(1.1, t + 0.55);
  g.gain.setValueAtTime(1.1, t + dur * 0.7);
  g.gain.setTargetAtTime(0, t + dur * 0.7, dur * 0.12);
}

// =====================================================================================
// sound recipes — every name from CONTRACT.md §5
//   fn(E, t, vol, pan, opts)
// =====================================================================================

const SFX = {
  step(E, t, vol, pan, o) {
    const surf = o.surface || (G0 && G0.player && G0.player.onIsland ? 'island' : 'raft');
    const v = new Voice(E, 'step', E.sfx, 0.22 * vol * rnd(0.8, 1.1), pan);
    if (surf === 'island') {
      hit(v, 'white', t, 'bandpass', rnd(2400, 3800), 0.9, 0.35, 0.004, 0.045);
      hit(v, 'white', t + rnd(0.018, 0.03), 'bandpass', rnd(1800, 3000), 0.9, 0.22, 0.004, 0.05);
      hit(v, 'brown', t, 'lowpass', 380, 0, 0.6, 0.004, 0.06);
    } else if (surf === 'raft') {
      hit(v, 'brown', t, 'lowpass', rnd(650, 1000), 1, 1, 0.002, 0.06);
      hit(v, 'white', t, 'bandpass', rnd(1600, 2400), 2.5, 0.14, 0.001, 0.025);
      blip(v, t, rnd(150, 185), rnd(85, 100), 0.06, 0.45);
      if (Math.random() < 0.18) creakIn(v, t + 0.02, 0.16, rnd(1.4, 1.9));
    } else {
      hit(v, 'brown', t, 'lowpass', 320, 0, 0.9, 0.012, 0.12);
    }
  },
  jump(E, t, vol, pan) {
    const v = new Voice(E, 'jump', E.sfx, 0.3 * vol, pan);
    const fl = hit(v, 'pink', t, 'bandpass', 700, 1.4, 0.8, 0.03, 0.12);
    sweep(fl.frequency, t, 700, 1700, 0.13);
    const P = G0 && G0.player;
    if (!P || P.onRaft || P.onIsland) blip(v, t, 175, 95, 0.05, 0.35);
  },
  splash(E, t, vol, pan) {
    const big = clamp(vol, 0.2, 1.3);
    const v = new Voice(E, 'splash', E.sfx, 0.5 * big, pan);
    hit(v, 'white', t, 'bandpass', rnd(1100, 1600), 0.6, 0.7, 0.004, 0.25 + 0.3 * big);
    hit(v, 'white', t, 'highpass', 3500, 0, 0.25, 0.002, 0.12 + 0.2 * big);
    hit(v, 'brown', t, 'lowpass', 520, 0, 0.9, 0.008, 0.22 + 0.15 * big);
    const k = 3 + ((big * 4) | 0);
    for (let i = 0; i < k; i++) {
      const f = rnd(700, 1900);
      blip(v, t + rnd(0.06, 0.45 + 0.25 * big), f, f * rnd(1.4, 1.9), rnd(0.025, 0.05), rnd(0.05, 0.14));
    }
    v.send(0.12);
  },
  dive(E, t, vol, pan) {
    const v = new Voice(E, 'dive', E.uw, 0.42 * vol, pan);
    const fl = hit(v, 'brown', t, 'lowpass', 1400, 1, 1, 0.01, 0.5);
    sweep(fl.frequency, t, 1400, 220, 0.45);
    bubbles(v, t + 0.03, rndi(7, 11), 0.6, 1, 1);
    v.send(0.2, false);
  },
  surface(E, t, vol, pan) {
    const v = new Voice(E, 'surface', E.sfx, 0.6 * vol, pan);
    const fl = hit(v, 'white', t, 'bandpass', 2200, 0.8, 0.45, 0.01, 0.35);
    sweep(fl.frequency, t, 2200, 900, 0.4);
    // the gasp: breath through a moving formant
    const g = v.g(0);
    const f1 = v.f('bandpass', 1000, 3.5, g);
    const end = env(g.gain, t + 0.04, 0.55, 0.07, 0.32);
    v.noise('white', t + 0.04, end, f1);
    f1.frequency.setValueAtTime(950, t + 0.04);
    f1.frequency.linearRampToValueAtTime(1500, t + 0.3);
    for (let i = 0; i < 4; i++) { const f = rnd(900, 2000); blip(v, t + rnd(0.1, 0.6), f, f * 1.6, 0.03, rnd(0.04, 0.09)); }
  },
  swim(E, t, vol, pan) {
    const v = new Voice(E, 'swim', E.sfx, 0.42 * vol, pan);
    const fl = hit(v, 'pink', t, 'bandpass', 450, 0.9, 0.9, 0.07, 0.28);
    sweep(fl.frequency, t, rnd(380, 560), rnd(800, 1000), 0.25);
    if (Math.random() < 0.5) blip(v, t + rnd(0.05, 0.2), rnd(500, 800), rnd(900, 1300), 0.04, 0.08);
  },
  'throw'(E, t, vol, pan) {
    const v = new Voice(E, 'throw', E.sfx, 0.7 * vol, pan);
    const fl = hit(v, 'pink', t, 'bandpass', 600, 1.6, 1, 0.05, 0.22);
    fl.frequency.setValueAtTime(600, t);
    fl.frequency.exponentialRampToValueAtTime(2400, t + 0.1);
    fl.frequency.exponentialRampToValueAtTime(900, t + 0.3);
    for (let i = 0; i < 5; i++) hit(v, 'white', t + 0.06 + i * 0.035, 'highpass', 3000, 0, 0.1 * (1 - i / 6), 0.001, 0.012);
  },
  reel(E, t, vol, pan) {
    const v = new Voice(E, 'reel', E.sfx, 0.36 * vol, pan);
    const n = rndi(4, 6), sp = rnd(0.035, 0.05);
    for (let i = 0; i < n; i++) hit(v, 'white', t + i * sp, 'bandpass', rnd(2800, 3600), 2, 0.6, 0.001, 0.014);
  },
  hook(E, t, vol, pan) {
    const v = new Voice(E, 'hook', E.sfx, 0.17 * vol, pan);
    const b = rnd(0.92, 1.08);
    const parts = [[2150, 0.5, 0.22], [3110, 0.32, 0.14], [4480, 0.2, 0.07]];
    for (const [f, a, d] of parts) {
      const g = v.g(0);
      v.osc('sine', f * b, t, t + d * 1.6 + 0.03, g);
      env(g.gain, t, a, 0.001, d);
    }
    hit(v, 'brown', t, 'lowpass', 700, 1, 0.6, 0.002, 0.06);
    v.send(0.08);
  },
  pickup(E, t, vol, pan) {
    const v = new Voice(E, 'pickup', E.sfx, 0.2 * vol, pan);
    const base = pickOne([74, 76, 78, 81]);
    const up = pickOne([3, 5, 7]);
    bell(v, mtof(base), t, 0.5, 0.35, [[1, 1, 1], [2, 0.25, 0.4]]);
    bell(v, mtof(base + up), t + 0.07, 0.42, 0.45, [[1, 1, 1], [2, 0.2, 0.4]]);
    hit(v, 'pink', t, 'bandpass', 900, 1, 0.25, 0.003, 0.05);
    v.send(0.15);
  },
  craft(E, t, vol, pan) {
    const v = new Voice(E, 'craft', E.sfx, 0.34 * vol, pan);
    hit(v, 'pink', t, 'bandpass', 1300, 0.8, 0.35, 0.03, 0.2);
    knock(v, t + 0.12, 1, 1); knock(v, t + 0.27, 0.8, 1.08);
    const sq = v.g(0);
    const o = v.osc('triangle', 700, t + 0.34, t + 0.6, v.f('bandpass', 1000, 2, sq));
    o.frequency.linearRampToValueAtTime(1150, t + 0.46);
    env(sq.gain, t + 0.34, 0.12, 0.03, 0.1);
    bell(v, mtof(74), t + 0.5, 0.32, 1.2, CEL);
    bell(v, mtof(81), t + 0.6, 0.28, 1.4, CEL);
    v.send(0.2);
  },
  build(E, t, vol, pan) {
    const v = new Voice(E, 'build', E.sfx, 0.34 * vol, pan);
    hit(v, 'brown', t, 'lowpass', 600, 1, 1, 0.004, 0.18);
    blip(v, t, 120, 68, 0.16, 0.7);
    knock(v, t + 0.14, 0.7, 1.05); knock(v, t + 0.27, 0.55, 1.1);
    creakIn(v, t + 0.05, 0.3, rnd(0.9, 1.2));
    v.send(0.1);
  },
  hammer(E, t, vol, pan) {
    const v = new Voice(E, 'hammer', E.sfx, 0.38 * vol, pan);
    const p = rnd(0.92, 1.08);
    hit(v, 'white', t, 'bandpass', 2100 * p, 2.2, 0.8, 0.0008, 0.05);
    blip(v, t, 300 * p, 190 * p, 0.08, 0.7, 'triangle');
    const g = v.g(0);
    v.osc('sine', 3300 * p, t, t + 0.3, g);
    env(g.gain, t, 0.07, 0.001, 0.16);
    v.send(0.08);
  },
  eat(E, t, vol, pan) {
    const v = new Voice(E, 'eat', E.sfx, 0.32 * vol, pan);
    let tt = t;
    for (let i = 0; i < 3; i++) {
      hit(v, 'white', tt, 'bandpass', rnd(1800, 3200), 1.3, rnd(0.5, 0.8), 0.003, rnd(0.04, 0.07));
      hit(v, 'brown', tt, 'lowpass', 450, 0, 0.5, 0.004, 0.05);
      tt += rnd(0.12, 0.17);
    }
    blip(v, tt + 0.1, 160, 300, 0.07, 0.4);
  },
  drink(E, t, vol, pan) {
    const v = new Voice(E, 'drink', E.sfx, 0.34 * vol, pan);
    let tt = t;
    for (let i = 0; i < 3; i++) {
      blip(v, tt, rnd(170, 210), rnd(360, 440), 0.07, 0.55);
      hit(v, 'brown', tt, 'lowpass', 500, 0, 0.3, 0.01, 0.06);
      tt += rnd(0.28, 0.34);
    }
    hit(v, 'white', tt + 0.05, 'bandpass', 1000, 3, 0.18, 0.03, 0.2); // "ah"
  },
  hurt(E, t, vol, pan) {
    const v = new Voice(E, 'hurt', E.sfx, 0.5 * vol, pan);
    blip(v, t, 160, 52, 0.18, 0.9);
    hit(v, 'brown', t, 'lowpass', 900, 1, 0.8, 0.002, 0.12);
    hit(v, 'white', t, 'bandpass', 1300, 1.2, 0.35, 0.001, 0.05);
    // a short pained breath through two formants
    const g = v.g(0);
    const f1 = v.f('bandpass', 760, 6, g), f2 = v.f('bandpass', 1250, 7, g);
    const end = env(g.gain, t + 0.06, 0.7, 0.02, 0.18);
    const n = v.noise('white', t + 0.06, end, f1);
    n.connect(f2);
    f1.frequency.setValueAtTime(800, t + 0.06);
    f1.frequency.linearRampToValueAtTime(620, end);
    // a low, sour sting underneath
    const g2 = v.g(0);
    const lp = v.f('lowpass', 500, 0, g2);
    v.osc('triangle', 92.5, t, t + 1, lp);
    v.osc('triangle', 98, t, t + 1, lp);
    env(g2.gain, t, 0.16, 0.01, 0.5);
  },
  spear(E, t, vol, pan) {
    const v = new Voice(E, 'spear', E.sfx, 0.75 * vol, pan);
    const fl = hit(v, 'pink', t, 'bandpass', 1200, 2, 1, 0.012, 0.11);
    sweep(fl.frequency, t, 1200, 3400, 0.09);
    const g = v.g(0);
    v.osc('sine', 3900, t + 0.015, t + 0.2, g);
    env(g.gain, t + 0.015, 0.05, 0.002, 0.08);
  },
  fishcatch(E, t, vol, pan) {
    const v = new Voice(E, 'fishcatch', E.sfx, 0.4 * vol, pan);
    hit(v, 'white', t, 'bandpass', 900, 1.2, 0.6, 0.002, 0.06);
    hit(v, 'white', t + 0.09, 'bandpass', 1100, 1.2, 0.45, 0.002, 0.05);
    hit(v, 'white', t + 0.17, 'bandpass', 800, 1.2, 0.3, 0.002, 0.05);
    bell(v, mtof(79), t + 0.12, 0.26, 1.0, CEL);
    bell(v, mtof(86), t + 0.24, 0.22, 1.3, CEL);
    v.send(0.25);
  },
  shark(E, t, vol, pan) {
    const v = new Voice(E, 'shark', E.under ? E.uw : E.sfx, 0.3 * vol, pan);
    const g = v.g(0);
    const lp = v.f('lowpass', 240, 2, g);
    lp.frequency.setValueAtTime(160, t);
    lp.frequency.exponentialRampToValueAtTime(560, t + 0.5);
    lp.frequency.exponentialRampToValueAtTime(190, t + 1.7);
    for (const m of [33, 34, 45]) { const o = v.osc('sawtooth', mtof(m), t, t + 2.2, lp); o.detune.value = rnd(-8, 8); }
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.5, t + 0.45);
    g.gain.setTargetAtTime(0, t + 0.5, 0.35);
    hit(v, 'pink', t + 0.1, 'bandpass', 600, 0.7, 0.4, 0.25, 0.6);
    v.send(0.35);
  },
  whale(E, t, vol, pan) {
    const v = new Voice(E, 'whale', E.under ? E.uw : E.sfx, 0.42 * vol, pan);
    moan(v, t, rnd(0.9, 1.15));
    if (Math.random() < 0.6) moan(v, t + rnd(2.6, 3.6), rnd(1.1, 1.35));
    v.send(E.under ? 0.5 : 0.7, !E.under);
  },
  beast(E, t, vol, pan) {
    const v = new Voice(E, 'beast', E.sfx, 0.34 * clamp(vol, 0, 1.2), pan);
    const dur = rnd(1.1, 1.7);
    const inh = hit(v, 'white', t, 'bandpass', 700, 2, 0.12, 0.2, 0.15);
    inh.frequency.setValueAtTime(700, t);
    inh.frequency.linearRampToValueAtTime(1100, t + 0.3);
    const t1 = t + 0.3, stop = t1 + dur + 0.6;
    const g = v.g(0);
    const am = v.g(0.5, g);
    const bp = v.f('bandpass', rnd(220, 290), 1.8, am);
    v.noise('brown', t1, stop, bp);
    const lfo = v.osc('square', rnd(24, 34), t1, stop, false);
    lfo.connect(v.g(0.42, am.gain));
    const f = rnd(44, 56);
    const sub = v.osc('sawtooth', f, t1, stop, v.f('lowpass', 320, 3, am));
    sub.frequency.linearRampToValueAtTime(f * 0.8, t1 + dur);
    g.gain.setValueAtTime(0, t1);
    g.gain.linearRampToValueAtTime(1, t1 + 0.18);
    g.gain.setValueAtTime(1, t1 + dur * 0.7);
    g.gain.setTargetAtTime(0, t1 + dur * 0.7, 0.2);
    v.send(0.3);
  },
  thunder(E, t, vol, pan) {
    const near = vol > 0.8;
    const v = new Voice(E, 'thunder', E.sfx, 0.8 * clamp(vol, 0.2, 1.2), pan);
    if (near) {
      hit(v, 'white', t, 'highpass', 1800, 0, 0.8, 0.002, 0.3);
      hit(v, 'white', t + 0.02, 'bandpass', 700, 0.6, 0.6, 0.004, 0.5);
    }
    const dur = rnd(4, 6.5);
    const g = v.g(0);
    const lp = v.f('lowpass', near ? 420 : 240, 0, g);
    sweep(lp.frequency, t, near ? 420 : 240, 110, dur);
    v.noise('brown', t, t + dur + 0.1, lp, 0.9);
    const N = 96, cur = new Float32Array(N);
    const rolls = [];
    for (let i = rndi(3, 5); i > 0; i--) rolls.push([rnd(0.05, 0.75) * dur, rnd(0.3, 1), rnd(0.15, 0.5)]);
    let mx = 0;
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * dur;
      let b = 0;
      for (const [tc, a, w] of rolls) b += a * Math.exp(-Math.pow((x - tc) / w, 2));
      cur[i] = Math.min(1, x / 0.12) * Math.exp(-x * 0.55) * (0.45 + b);
      if (cur[i] > mx) mx = cur[i];
    }
    for (let i = 0; i < N; i++) cur[i] /= mx || 1;
    cur[N - 1] = 0;
    g.gain.setValueCurveAtTime(cur, t + (near ? 0.04 : 0), dur);
    v.send(0.4);
  },
  sail(E, t, vol, pan) {
    const v = new Voice(E, 'sail', E.sfx, 0.36 * vol, pan);
    flutter(v, t, 0.85, 1);
    creakIn(v, t + 0.1, 0.35, rnd(1.2, 1.5));
  },
  anchor(E, t, vol, pan) {
    const v = new Voice(E, 'anchor', E.sfx, 0.36 * vol, pan);
    let tt = t;
    const n = rndi(9, 13);
    for (let i = 0; i < n; i++) {
      const p = rnd(0.85, 1.2), a = rnd(0.4, 1) * (1 - (i / n) * 0.5);
      const g = v.g(0);
      v.osc('sine', 1650 * p, tt, tt + 0.16, g);
      v.osc('sine', 2470 * p, tt, tt + 0.16, g);
      env(g.gain, tt, 0.18 * a, 0.001, 0.08);
      hit(v, 'white', tt, 'highpass', 2500, 0, 0.25 * a, 0.001, 0.015);
      tt += rnd(0.05, 0.1);
    }
    hit(v, 'brown', tt + 0.05, 'lowpass', 600, 1, 0.8, 0.01, 0.3);
    bubbles(v, tt + 0.1, 5, 0.4, 0.6, 0.8);
    v.send(0.12);
  },
  ui(E, t, vol) {
    const v = new Voice(E, 'ui', E.ui, 0.24 * vol, 0);
    const g = v.g(0);
    const o = v.osc('triangle', 880, t, t + 0.12, g);
    o.frequency.exponentialRampToValueAtTime(700, t + 0.05);
    env(g.gain, t, 0.5, 0.002, 0.05);
    const g2 = v.g(0);
    v.osc('sine', 1760, t, t + 0.08, g2);
    env(g2.gain, t, 0.12, 0.001, 0.03);
    hit(v, 'white', t, 'highpass', 4000, 0, 0.08, 0.001, 0.008);
  },
  discover(E, t, vol) {
    const v = new Voice(E, 'discover', E.music, 0.9 * vol, 0);
    const a = pickOne([[74, 78, 81, 86], [69, 74, 76, 81], [71, 74, 78, 83], [76, 79, 83, 88]]);
    for (let i = 0; i < a.length; i++) bell(v, mtof(a[i]), t + i * 0.11, 0.2 * (1 - i * 0.08), 1.6, CEL);
    bell(v, mtof(a[3] + 12), t + 0.5, 0.06, 2.2, GLASS);
    for (let i = 0; i < 3; i++) bell(v, mtof(pickOne([93, 95, 98, 100, 102])), t + 0.6 + i * rnd(0.12, 0.25), 0.025, 1.6, GLASS);
  },
  sleep(E) {
    startCue(E, 'lullaby', 0.15);
  },
  heartbeat(E, t, vol) {
    const v = new Voice(E, 'heartbeat', E.ui, 0.32 * clamp(vol, 0, 1.2), 0);
    beat(v, t, 1); beat(v, t + 0.24, 0.7);
  },
  bubble(E, t, vol, pan) {
    const v = new Voice(E, 'bubble', E.uw, 0.3 * vol, pan);
    bubbles(v, t, rndi(1, 3), 0.15, 0.8, 1);
  },
  lantern(E, t, vol, pan) {
    const v = new Voice(E, 'lantern', E.sfx, 0.36 * vol, pan);
    const g = v.g(0);
    v.osc('sine', 2650, t, t + 0.25, g);
    v.osc('sine', 3920, t, t + 0.25, g);
    env(g.gain, t, 0.12, 0.001, 0.1);
    hit(v, 'white', t + 0.08, 'highpass', 3000, 0, 0.4, 0.002, 0.05);
    const fl = hit(v, 'brown', t + 0.1, 'lowpass', 250, 1, 0.9, 0.12, 0.45);
    sweep(fl.frequency, t + 0.1, 250, 1100, 0.2);
    for (let i = 0; i < 4; i++) hit(v, 'white', t + rnd(0.15, 0.6), 'bandpass', rnd(1800, 3200), 2, rnd(0.08, 0.2), 0.001, 0.01);
    v.send(0.1);
  },
  grill(E, t, vol, pan) {
    const v = new Voice(E, 'grill', E.sfx, 0.3 * vol, pan);
    const g = v.g(0);
    v.noise('white', t, t + 1.6, v.f('highpass', 3500, 0, g));
    const N = 64, cur = new Float32Array(N);
    for (let i = 0; i < N; i++) { const u = i / (N - 1); cur[i] = Math.min(1, u / 0.05) * Math.pow(1 - u, 1.3) * (0.55 + 0.45 * Math.random()); }
    cur[N - 1] = 0;
    g.gain.setValueCurveAtTime(cur, t, 1.5);
    for (let i = 0; i < 5; i++) hit(v, 'white', t + rnd(0.05, 1.2), 'bandpass', rnd(1400, 2600), 2, rnd(0.2, 0.45), 0.001, 0.012);
  },
  water(E, t, vol, pan) {
    const v = new Voice(E, 'water', E.sfx, 0.3 * vol, pan);
    const g = v.g(0);
    const bp = v.f('bandpass', 1200, 2.5, g);
    v.noise('white', t, t + 0.9, bp);
    const N = 24, cur = new Float32Array(N);
    for (let i = 0; i < N; i++) cur[i] = rnd(900, 1800);
    bp.frequency.setValueCurveAtTime(cur, t, 0.8);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.6, t + 0.06);
    g.gain.setValueAtTime(0.6, t + 0.45);
    g.gain.setTargetAtTime(0, t + 0.45, 0.08);
    for (let i = 0; i < 4; i++) { const f = rnd(1200, 2400); blip(v, t + rnd(0.1, 0.7), f, f * 1.3, 0.03, rnd(0.08, 0.16)); }
  },
};

function beat(v, t, a) {
  const g = v.g(0);
  const lp = v.f('lowpass', 190, 1, g);
  const o = v.osc('triangle', 80, t, t + 0.35, lp);
  o.frequency.exponentialRampToValueAtTime(44, t + 0.12);
  env(g.gain, t, 0.9 * a, 0.006, 0.13);
  const g2 = v.g(0);
  v.osc('sine', 54, t, t + 0.35, g2);
  env(g2.gain, t, 0.55 * a, 0.006, 0.16);
}
function flutter(v, t, dur, a) {
  const g = v.g(0);
  v.noise('pink', t, t + dur + 0.05, v.f('bandpass', rnd(550, 800), 0.8, g));
  const N = 48, cur = new Float32Array(N);
  let ph = Math.random() * 6;
  for (let i = 0; i < N; i++) {
    const u = i / (N - 1);
    ph += rnd(0.9, 2.2);
    cur[i] = a * Math.min(1, u / 0.08) * Math.pow(1 - u, 0.8) * (0.3 + 0.7 * Math.pow(Math.abs(Math.sin(ph)), 3));
  }
  cur[N - 1] = 0;
  g.gain.setValueCurveAtTime(cur, t, dur);
}

// per-name minimum interval (s) and concurrent cap; unknown names are ignored
const THROTTLE = {
  step: 0.08, jump: 0.15, splash: 0.07, dive: 0.3, surface: 0.4, swim: 0.15, throw: 0.2, reel: 0.1,
  hook: 0.1, pickup: 0.06, craft: 0.3, build: 0.15, hammer: 0.07, eat: 0.4, drink: 0.4, hurt: 0.25,
  spear: 0.12, fishcatch: 0.3, shark: 2, whale: 3, beast: 0.5, thunder: 0.25, sail: 0.4, anchor: 0.5,
  ui: 0.035, discover: 1.2, sleep: 3, heartbeat: 0.42, bubble: 0.04, lantern: 0.4, grill: 0.5, water: 0.4,
};
const MAXN = { splash: 3, beast: 2, whale: 2, thunder: 3, heartbeat: 2, shark: 1, step: 3, bubble: 4, pickup: 4, reel: 2, amb: 16, music: 96 };
const PRIORITY = { hurt: 1, ui: 1, discover: 1, heartbeat: 1, thunder: 1, beast: 1 };
const SFX_NAMES = Object.keys(SFX);

// =====================================================================================
// music
// =====================================================================================

const NOTE_IDX = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function noteNum(s) {
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(s);
  if (!m) return null;
  return 12 * (Number(m[3]) + 1) + NOTE_IDX[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}
const PARSED = new Map();
// "F#5/1 A5/0.5 r/1 D3.F#3.A3/3 |" → [{b: beat, d: beats, m: midi}]
function parseSeq(str) {
  let out = PARSED.get(str);
  if (out) return out;
  out = [];
  let b = 0;
  for (const tok of str.split(/\s+/)) {
    if (!tok || tok === '|') continue;
    const k = tok.lastIndexOf('/');
    const ns = k > 0 ? tok.slice(0, k) : tok;
    const d = k > 0 ? Number(tok.slice(k + 1)) || 1 : 1;
    if (ns !== 'r') for (const nn of ns.split('.')) { const m = noteNum(nn); if (m != null) out.push({ b, d, m }); }
    b += d;
  }
  PARSED.set(str, out);
  return out;
}

// Melodies: D major pentatonic sunrise waltz, A Dorian dusk, a bright G-major island
// theme, a hopeful lighthouse phrase, a lullaby, and a sad little death phrase.
const DAWN_PARTS = [
  { inst: 'box', vel: 1, str: 'r/1 F#5/1 A5/1 | B5/2 A5/1 | F#5/1.5 E5/0.5 D5/1 | E5/3 | r/1 F#5/1 A5/1 | B5/1 D6/1 C#6/1 | A5/1.5 F#5/0.5 E5/1 | D5/3' },
  { inst: 'low', vel: 0.8, str: 'D3/1 A3/1 F#4/1 | G2/1 D3/1 B3/1 | D3/1 A3/1 F#4/1 | A2/1 E3/1 C#4/1 | D3/1 A3/1 F#4/1 | G2/1 D3/1 B3/1 | A2/1 E3/1 G3/1 | D3/1 A3/1 D4/1' },
  { inst: 'pad', vel: 0.8, str: 'D3.F#3.A3/3 | G2.B2.D3/3 | D3.F#3.A3/3 | A2.C#3.E3/3 | D3.F#3.A3/3 | G2.B2.D3/3 | A2.C#3.G3/3 | D3.F#3.A3/3' },
  { inst: 'glass', vel: 0.7, str: 'r/22 A6/1 D7/2' },
];
const DUSK_PARTS = [
  { inst: 'box', vel: 1, str: 'A4/1.5 C5/0.5 D5/1 E5/1 | D5/2 C5/1 A4/1 | G4/1.5 A4/0.5 C5/1 D5/1 | A4/4 | A4/1.5 C5/0.5 D5/1 E5/1 | G5/2 F#5/1 E5/1 | D5/1 C5/1 A4/1 G4/1 | A4/4' },
  { inst: 'low', vel: 0.7, str: 'A2/1 E3/1 A3/1 C4/1 | D3/1 A3/1 F#3/1 A3/1 | G2/1 D3/1 G3/1 B3/1 | A2/1 E3/1 A3/1 E3/1 | C3/1 G3/1 C4/1 E4/1 | D3/1 A3/1 F#3/1 A3/1 | G2/1 D3/1 G3/1 B3/1 | A2/2 E3/2' },
  { inst: 'pad', vel: 0.75, str: 'A2.C3.E3/4 | D3.F#3.A3/4 | G2.B2.D3/4 | A2.C3.E3/4 | C3.E3.G3/4 | D3.F#3.A3/4 | G2.B2.D3/4 | A2.E3.A3/4' },
];
const LIGHT_PARTS = [
  { inst: 'box', vel: 1, str: 'A4/1 D5/1 E5/1 F#5/1 | A5/3 F#5/1 | B5/1 A5/1 F#5/1 E5/1 | D5/2 E5/1 F#5/1 | A5/2 B5/2 | D6/4' },
  { inst: 'low', vel: 0.75, str: 'D3/1 A3/1 D4/1 A3/1 | B2/1 F#3/1 B3/1 F#3/1 | G2/1 D3/1 G3/1 D3/1 | D3/1 A3/1 D4/1 A3/1 | G2/2 A2/2 | D3/1 A3/1 D4/2' },
  { inst: 'pad', vel: 0.85, str: 'D3.F#3.A3/4 | B2.D3.F#3/4 | G2.B2.D3/4 | D3.F#3.A3/4 | G2.B2.D3/2 A2.C#3.E3/2 | D3.F#3.A3.D4/4' },
  { inst: 'glass', vel: 0.6, str: 'r/20 F#6/1 A6/1 D7/2' },
];
const SONGS = {
  dawn: { bpm: 80, bar: 3, parts: DAWN_PARTS },
  dawnSlow: { bpm: 70, bar: 3, parts: DAWN_PARTS, gap: 0.8 },
  dusk: { bpm: 66, bar: 4, parts: DUSK_PARTS },
  title: { bpm: 62, bar: 4, parts: DUSK_PARTS },
  island: { bpm: 100, bar: 4, parts: [
    { inst: 'cel', vel: 1, str: 'D5/0.5 G5/0.5 A5/0.5 B5/1.5 r/1 | A5/0.5 G5/0.5 E5/0.5 D5/1.5 r/1 | E5/0.5 G5/0.5 A5/0.5 B5/0.5 D6/1 B5/1 | A5/3 r/1 | D5/0.5 G5/0.5 A5/0.5 B5/1.5 r/1 | C6/0.5 B5/0.5 A5/0.5 G5/1.5 r/1 | E5/0.5 G5/0.5 A5/1 B5/0.5 A5/0.5 F#5/1 | G5/4' },
    { inst: 'low', vel: 0.75, str: 'G2/1 D3/1 G3/1 D3/1 | E2/1 B2/1 E3/1 B2/1 | C3/1 G3/1 C4/1 G3/1 | D3/1 A3/1 D4/1 A3/1 | G2/1 D3/1 G3/1 D3/1 | A2/1 E3/1 G3/1 E3/1 | C3/2 D3/2 | G2/1 D3/1 G3/2' },
    { inst: 'pad', vel: 0.7, str: 'G2.B2.D3/4 | E2.G2.B2/4 | C3.E3.G3/4 | D3.F#3.A3/4 | G2.B2.D3/4 | A2.C3.E3/4 | C3.E3.G3/2 D3.F#3.A3/2 | G2.B2.D3/4' },
    { inst: 'glass', vel: 0.6, str: 'r/28 B6/1 D7/3' },
  ] },
  islandShort: { bpm: 96, bar: 4, parts: [
    { inst: 'cel', vel: 1, str: 'D5/0.5 G5/0.5 A5/0.5 B5/2.5 | A5/0.5 G5/0.5 D5/1 G5/2' },
    { inst: 'low', vel: 0.75, str: 'G2/2 D3/2 | C3/2 G2/2' },
    { inst: 'pad', vel: 0.6, str: 'G2.B2.D3/4 | C3.E3.G3/2 G2.B2.D3/2' },
  ] },
  motif: { bpm: 76, bar: 4, parts: [
    { inst: 'box', vel: 0.9, str: 'D5/0.5 E5/0.5 A5/1 F#5/2' },
    { inst: 'low', vel: 0.7, str: 'D3/4' },
  ] },
  lighthouse: { bpm: 70, bar: 4, parts: LIGHT_PARTS },
  // the moment the world changes: a slow falling semitone over an open, sour fifth
  nightfall: { bpm: 56, bar: 4, parts: [
    { inst: 'bell', vel: 0.8, str: 'E3/8' },
    { inst: 'box', vel: 0.7, str: 'r/1 E5/1.5 D#5/2.5 r/1 B4/4' },
    { inst: 'pad', vel: 0.75, str: 'r/0.5 E2.B2.F3/7.5' },
  ] },
  lullaby: { bpm: 72, bar: 5, parts: [
    { inst: 'box', vel: 0.85, str: 'A5/1 F#5/1 E5/1 D5/2 | B4/1 D5/1 A4/3' },
    { inst: 'low', vel: 0.6, str: 'D3/5 | G2/5' },
    { inst: 'pad', vel: 0.6, str: 'D3.F#3.A3/5 | G2.B2.D3/5' },
  ] },
  death: { bpm: 50, bar: 4, parts: [
    { inst: 'ghost', vel: 0.9, str: 'E5/1 D5/1 B4/2 | A4/1 G4/1 E4/2 | F#4/2 D#4/2 | E4/4' },
    { inst: 'low', vel: 0.6, str: 'E2.B2/4 | C2.G2/4 | B1.F#2/4 | E2.B2/4' },
    { inst: 'pad', vel: 0.6, str: 'E3.G3.B3/4 | C3.E3.G3/4 | B2.D#3.F#3/4 | E3.G3.B3/4' },
  ] },
  ghost: { bpm: 46, bar: 4, tr: -5, parts: [
    { inst: 'ghost', vel: 0.7, str: DUSK_PARTS[0].str },
    { inst: 'ghostlow', vel: 0.5, str: 'A2/4 | D3/4 | G2/4 | A2/4 | C3/4 | D3/4 | G2/4 | A2/4' },
  ] },
};
const SEQ = { ending: ['dawnSlow', 'lighthouse'] };

function startCue(E, name, delay) {
  const M = E.mus, now = E.ctx.currentTime + E.offset;
  const names = SEQ[name] || [name];
  const list = [];
  let t0 = now + (delay || 0), end = t0;
  for (const nmz of names) {
    const s = SONGS[nmz];
    if (!s) continue;
    const spb = 60 / s.bpm, bar = s.bar || 4, ghost = nmz === 'ghost' || nmz === 'death';
    let songEnd = t0;
    for (const p of s.parts) {
      for (const e of parseSeq(p.str)) {
        const accent = (p.inst === 'low' || p.inst === 'ghostlow') && Math.abs(e.b % bar) > 0.01 ? 0.72 : 1;
        const human = ghost ? rnd(-0.04, 0.06) : (p.inst === 'pad' ? 0 : rnd(-0.008, 0.012));
        list.push({
          t: t0 + e.b * spb + human, inst: p.inst, m: e.m + (s.tr || 0), dur: e.d * spb,
          vel: p.vel * accent * (p.inst === 'pad' ? 1 : rnd(0.88, 1.06)),
          pan: p.inst === 'low' ? -0.18 : p.inst === 'glass' ? 0.3 : p.inst === 'pad' ? 0 : 0.12,
        });
        songEnd = Math.max(songEnd, t0 + (e.b + e.d) * spb);
      }
    }
    end = songEnd;
    t0 = songEnd + (s.gap || 0);
  }
  if (!list.length) return false;
  list.sort((a, b) => a.t - b.t);
  M.q = list; M.i = 0;
  M.busyUntil = end + 2.5;
  M.lastEnd = end + 2.5;
  M.cur = name;
  return true;
}

function decayFor(m, base) { return clamp(base * Math.pow(0.5, (m - 72) / 18), 0.5, 4.5); }

function playNote(E, ev) {
  const t = ev.t, m = ev.m, vel = ev.vel, f = mtof(m);
  const ghost = ev.inst === 'ghost' || ev.inst === 'ghostlow';
  const v = new Voice(E, 'music', ghost ? E.ghostLP : E.music, 1, ev.pan);
  switch (ev.inst) {
    case 'box': bell(v, f, t, 0.2 * vel, decayFor(m, 2.6), BOX); break;
    case 'cel': bell(v, f, t, 0.2 * vel, decayFor(m, 1.9), CEL); break;
    case 'glass': bell(v, f, t, 0.07 * vel, 2.6, GLASS); break;
    case 'bell': bell(v, f, t, 0.14 * vel, 5, BELL); break;
    case 'ghost': bell(v, f, t, 0.2 * vel, decayFor(m, 3), BOX, null, rnd(-35, 35)); break;
    case 'low': case 'ghostlow': {
      const d = clamp(2.2 * Math.pow(0.5, (m - 48) / 24), 0.8, 2.8);
      const g = v.g(0);
      v.osc('triangle', f, t, t + d * 1.5 + 0.05, g);
      env(g.gain, t, 0.15 * vel, 0.008, d);
      const g2 = v.g(0);
      v.osc('sine', f * 2, t, t + d * 0.6 + 0.05, g2);
      env(g2.gain, t, 0.035 * vel, 0.006, d * 0.35);
      break;
    }
    case 'pad': {
      const g = v.g(0);
      const lp = v.f('lowpass', 600 + f * 1.5, 0, g);
      const end = t + ev.dur + 2.4;
      const o1 = v.osc('sawtooth', f, t, end, lp); o1.detune.value = -7;
      const o2 = v.osc('sawtooth', f, t, end, lp); o2.detune.value = 7;
      const pk = 0.02 * vel;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(pk, t + Math.min(1.2, ev.dur * 0.4));
      g.gain.setValueAtTime(pk, t + ev.dur);
      g.gain.setTargetAtTime(0, t + ev.dur, 0.5);
      break;
    }
    default: break;
  }
}

// =====================================================================================
// cue requests (decided from G even before the engine exists; consumed when it does)
// =====================================================================================

const T = { g: null, phase: -1, mode: '', lh: false, req: null, landT: 0 };

// prio 0: needs a long gap since the last cue · 1: waits until nothing plays · 2: preempts
function request(name, delay, prio) {
  if (T.req && T.req.prio > prio && nowMs() < T.req.until) return;
  T.req = { name, delay, prio, until: nowMs() + 15000 };
}

function track(G, dt) {
  const ph = fin(G.phase, 0);
  const flags = (G.persist && G.persist.flags) || null;
  if (T.g !== G) {
    T.g = G; T.phase = ph; T.mode = G.mode; T.lh = !!(flags && flags.sky_lighthouse); T.landT = 1;
    if (A) A.mus.titleT = G.mode === 'title' ? 2.5 : A.mus.titleT;
    if (!G.demo && G.mode === 'play') request(G.loaded ? 'motif' : 'dawn', G.loaded ? 2 : 3, 2);
    return;
  }
  const prev = T.phase;
  T.phase = ph;
  if (G.mode === 'play' && !G.demo) {
    if (prev > 0.8 && ph < 0.12) request('dawn', 1.5, 1);
    else if (prev < 0.535 && ph >= 0.535 && ph < 0.62) request('dusk', 0.5, 1);
    else if (prev < C.NIGHT_START && ph >= C.NIGHT_START && ph < 0.75) request('nightfall', 0.5, 1);
  }
  if (G.mode !== T.mode) {
    if (G.mode === 'dead') request('death', 1.2, 2);
    else if (G.mode === 'ending') request('ending', 1, 2);
    T.mode = G.mode;
  }
  if (G.demo || G.mode !== 'play') return;
  const lh = !!(flags && flags.sky_lighthouse);
  if (lh && !T.lh) request('lighthouse', 1.5, 2);
  T.lh = lh;
  // first landing on each island, by day
  T.landT -= dt;
  const P = G.player;
  if (T.landT <= 0 && P && P.onIsland && fin(G.light, 1) > 0.5) {
    T.landT = 0.5;
    let isl = null;
    try { isl = islandAt(G, P.x); } catch (e) { isl = null; }
    if (isl && G.persist) {
      const pa = G.persist.audio || (G.persist.audio = { landed: {} });
      if (!pa.landed || typeof pa.landed !== 'object') pa.landed = {};
      const id = String(isl.id != null ? isl.id : Math.round(fin(isl.x0, 0)));
      if (!pa.landed[id]) {
        const first = Object.keys(pa.landed).length === 0;
        pa.landed[id] = 1;
        request(first && isl.kind !== 'lighthouse' ? 'island' : 'islandShort', 0.6, 2);
      }
    }
  } else if (T.landT <= 0) T.landT = 0.5;
}

function serviceRequest(E) {
  const q = T.req;
  if (!q) return;
  if (nowMs() > q.until) { T.req = null; return; }
  const S = E.s, M = E.mus, now = E.ctx.currentTime + E.offset;
  if (q.prio < 2 && (S.storm > 0.45 || S.danger > 0.3)) { T.req = null; return; }
  if (q.prio < 2 && now < M.busyUntil) return;
  if (q.prio < 1 && now - M.lastEnd < 45) { T.req = null; return; }
  T.req = null;
  startCue(E, q.name, q.delay);
}

function music(E, G, dt) {
  const M = E.mus;
  if (G.mode === 'title') {
    M.titleT -= dt;
    if (M.titleT <= 0) { M.titleT = rnd(110, 170); request('title', 0, 1); }
  }
  serviceRequest(E);
  const now = E.ctx.currentTime + E.offset;
  while (M.i < M.q.length && M.q[M.i].t < now + 0.3) {
    const ev = M.q[M.i++];
    if (ev.t > now - 0.05) { try { playNote(E, ev); } catch (e) { /* keep going */ } }
  }
  if (M.q.length && M.i >= M.q.length) { M.q = []; M.i = 0; M.cur = null; }
}

// =====================================================================================
// ambience layers
// =====================================================================================

function shell(E, bus, pan) {
  const out = E.ctx.createGain();
  out.gain.value = 0;
  const n = { out, srcs: [], nodes: [out], p: {} };
  if (pan && E.hasPan) {
    const p = E.ctx.createStereoPanner();
    p.pan.value = pan;
    out.connect(p); p.connect(bus);
    n.nodes.push(p);
  } else out.connect(bus);
  return n;
}
function lsrc(E, n, buffer, rate) {
  const s = E.ctx.createBufferSource();
  s.buffer = buffer; s.loop = true; s.playbackRate.value = rate || 1;
  s.start(E.ctx.currentTime, Math.random() * buffer.duration * 0.95);
  n.srcs.push(s); n.nodes.push(s);
  return s;
}
function losc(E, n, type, f, detune) {
  const o = E.ctx.createOscillator();
  o.type = type; o.frequency.value = f; o.detune.value = detune || 0;
  o.start();
  n.srcs.push(o); n.nodes.push(o);
  return o;
}
function lfilt(E, n, type, f, Q) { const x = filterNode(E.ctx, type, f, Q); n.nodes.push(x); return x; }
function lgain(E, n, v) { const g = E.ctx.createGain(); g.gain.value = v; n.nodes.push(g); return g; }
function lpan(E, n, pan) {
  if (!E.hasPan) return lgain(E, n, 1);
  const p = E.ctx.createStereoPanner(); p.pan.value = pan; n.nodes.push(p); return p;
}

function surf(E, pan, rate) {
  const n = shell(E, E.amb, pan);
  const lp = lfilt(E, n, 'lowpass', 500, 0);
  lsrc(E, n, E.buf.brown, rate).connect(lp);
  const g2 = lgain(E, n, 0.35);
  lsrc(E, n, E.buf.pink, rate).connect(g2);
  g2.connect(lp); lp.connect(n.out);
  n.p.lp = lp.frequency;
  return n;
}

// Dark, slightly wrong chords for the night pad (MIDI). Semitone rubs on purpose.
const PAD_CHORDS = [
  [50, 57, 64, 65], // D3 A3 E4 F4
  [46, 53, 62, 64], // Bb2 F3 D4 E4
  [43, 50, 57, 58], // G2 D3 A3 Bb3
  [45, 52, 58, 61], // A2 E3 Bb3 C#4
  [50, 57, 63, 65], // D3 A3 Eb4 F4
  [41, 48, 55, 57], // F2 C3 G3 A3 — one warmer breath
];

const BUILD = {
  surfL: (E) => surf(E, -0.6, 1),
  surfR: (E) => surf(E, 0.6, 0.97),
  hiss(E) {
    const n = shell(E, E.amb, 0);
    const bp = lfilt(E, n, 'bandpass', 1600, 0.6);
    lsrc(E, n, E.buf.pink, 1.03).connect(bp); bp.connect(n.out);
    n.p.f = bp.frequency;
    return n;
  },
  wind(E) {
    const n = shell(E, E.amb, 0);
    const bp = lfilt(E, n, 'bandpass', 500, 0.9);
    lsrc(E, n, E.buf.white, 1).connect(bp); bp.connect(n.out);
    n.p.f = bp.frequency;
    return n;
  },
  whistle(E) {
    const n = shell(E, E.amb, 0.3);
    const bp = lfilt(E, n, 'bandpass', 900, 9);
    lsrc(E, n, E.buf.white, 0.9).connect(bp); bp.connect(n.out);
    n.p.f = bp.frequency;
    return n;
  },
  rain(E) {
    const n = shell(E, E.amb, 0);
    const hp = lfilt(E, n, 'highpass', 1100, 0), lp = lfilt(E, n, 'lowpass', 7800, 0);
    lsrc(E, n, E.buf.white, 1).connect(hp); hp.connect(lp); lp.connect(n.out);
    return n;
  },
  drops(E) {
    const n = shell(E, E.amb, 0);
    const hp = lfilt(E, n, 'highpass', 500, 0);
    const b = dropsBuf(E);
    const p1 = lpan(E, n, -0.5), p2 = lpan(E, n, 0.5);
    lsrc(E, n, b, 1).connect(p1); lsrc(E, n, b, 0.83).connect(p2);
    p1.connect(hp); p2.connect(hp); hp.connect(n.out);
    return n;
  },
  rumble(E) {
    const n = shell(E, E.amb, 0);
    const lp = lfilt(E, n, 'lowpass', 120, 0);
    lsrc(E, n, E.buf.brown, 0.6).connect(lp); lp.connect(n.out);
    return n;
  },
  drone(E) {
    const n = shell(E, E.amb, 0);
    const lp = lfilt(E, n, 'lowpass', 200, 2);
    losc(E, n, 'sawtooth', 73.42, -4).connect(lp);
    losc(E, n, 'sawtooth', 73.42, 5).connect(lp);
    const g3 = lgain(E, n, 0.6);
    losc(E, n, 'triangle', 110, 0).connect(g3);
    g3.connect(lp); lp.connect(n.out);
    n.p.lp = lp.frequency;
    return n;
  },
  hum(E) {
    const n = shell(E, E.uw, 0);
    const lp = lfilt(E, n, 'lowpass', 200, 1);
    lsrc(E, n, E.buf.brown, 0.7).connect(lp); lp.connect(n.out);
    const og = lgain(E, n, 0.16);
    losc(E, n, 'sine', 43, 0).connect(og); og.connect(n.out);
    const tg = lgain(E, n, 0.05);
    losc(E, n, 'triangle', 64.5, 0).connect(tg); tg.connect(n.out);
    n.p.lp = lp.frequency;
    return n;
  },
  crickets(E) {
    const n = shell(E, E.amb, 0);
    const b = cricketBuf(E);
    const p1 = lpan(E, n, -0.55), p2 = lpan(E, n, 0.55);
    lsrc(E, n, b, 1).connect(p1); lsrc(E, n, b, 0.94).connect(p2);
    p1.connect(n.out); p2.connect(n.out);
    return n;
  },
  leaves(E) {
    const n = shell(E, E.amb, 0.15);
    const bp = lfilt(E, n, 'bandpass', 3000, 0.5);
    lsrc(E, n, E.buf.pink, 1).connect(bp); bp.connect(n.out);
    n.p.f = bp.frequency;
    return n;
  },
  tension(E) {
    const n = shell(E, E.amb, 0);
    const lp = lfilt(E, n, 'lowpass', 420, 3);
    const am = lgain(E, n, 0.6);
    for (const f of [55, 58.27, 82.41]) losc(E, n, 'sawtooth', f, rnd(-5, 5)).connect(lp);
    lp.connect(am); am.connect(n.out);
    const lg = lgain(E, n, 0.38);
    losc(E, n, 'sine', 5.2, 0).connect(lg); lg.connect(am.gain);
    n.p.lp = lp.frequency;
    return n;
  },
  fire(E) {
    const n = shell(E, E.amb, 0.1);
    const bp = lfilt(E, n, 'bandpass', 1700, 0.8);
    lsrc(E, n, dropsBuf(E), 0.55).connect(bp); bp.connect(n.out);
    const lp = lfilt(E, n, 'lowpass', 320, 0), g = lgain(E, n, 0.6);
    lsrc(E, n, E.buf.brown, 1).connect(lp); lp.connect(g); g.connect(n.out);
    return n;
  },
  pad(E) {
    const n = shell(E, E.music, 0);
    const lp = lfilt(E, n, 'lowpass', 650, 1);
    lp.connect(n.out);
    n.p.lp = lp.frequency;
    n.osc = [];
    const ch = PAD_CHORDS[E.pad.chord] || PAD_CHORDS[0];
    for (let i = 0; i < 4; i++) {
      const g = lgain(E, n, i === 0 ? 0.9 : 0.6);
      for (const d of [-8, 8]) {
        const o = losc(E, n, 'sawtooth', mtof(ch[i]), d + rnd(-3, 3));
        o.connect(g);
        n.osc.push([o, i]);
      }
      g.connect(lp);
    }
    return n;
  },
};

function killLayer(n) {
  for (const s of n.srcs) { try { s.stop(); } catch (e) { /* ignore */ } }
  for (const x of n.nodes) { try { x.disconnect(); } catch (e) { /* ignore */ } }
}

// Crossfade a layer toward `level`; builds it on demand and tears it down after
// it has been silent for a while.
function drive(E, name, level, tau) {
  const L = E.layers[name];
  if (!L) return null;
  if (level > 0.0006) {
    if (!L.n) {
      if (L.fail > 3) return null;
      try { L.n = L.build(E); } catch (e) { L.fail++; L.n = null; return null; }
    }
    L.quiet = 0;
    setP(E, L.n.out.gain, level, tau);
    return L.n;
  }
  if (!L.n) return null;
  setP(E, L.n.out.gain, 0, tau);
  L.quiet += E.pdt;
  if (L.quiet > 6) { killLayer(L.n); L.n = null; return null; }
  return L.n;
}

// One side of the surf: individual waves swell in, break with a hiss, and draw back.
function swell(S, t, rough, dt) {
  S.next -= dt;
  if (S.next <= 0) {
    S.waves.push({ t0: t, dur: rnd(3.5, 6.5) / (0.8 + 0.4 * rough), amp: rnd(0.45, 1) });
    S.next = rnd(2.2, 5.5) / (0.75 + 0.6 * rough);
    if (S.waves.length > 6) S.waves.shift();
  }
  let body = 0, crest = 0;
  for (let i = S.waves.length - 1; i >= 0; i--) {
    const w = S.waves[i], x = (t - w.t0) / w.dur;
    if (x >= 1) { S.waves.splice(i, 1); continue; }
    if (x < 0.42) { const u = x / 0.42; body += w.amp * u * u * (3 - 2 * u); }
    else body += w.amp * Math.exp(-(x - 0.42) * 4.2) * (1 - smoothstep(0.82, 1, x));
    const c = (x - 0.4) / 0.1;
    if (c > -1 && x < 0.95) crest += w.amp * (c < 0 ? (1 + c) * (1 + c) : Math.exp(-c * 1.1));
  }
  S.body = Math.min(1.4, body);
  S.crest = Math.min(1.4, crest);
}

// =====================================================================================
// reading the world
// =====================================================================================

const SHARK_HOT = { stalk: 1, lunge: 1, biteGo: 0.7, biteRush: 1, chomp: 1, tell: 1, back: 0.6 };

function sense(G, E, dt) {
  const S = E.s, P = G.player || {}, W = G.weather || {};
  const light = fin(G.light, 1);
  S.mode = G.mode;
  S.fade = clamp(fin(G.fade, 0), 0, 1);
  S.night = clamp((0.6 - light) / 0.45, 0, 1);
  S.day = clamp((light - 0.3) / 0.5, 0, 1);
  S.wv = clamp((fin(W.wave, 1) - 1) / 2.2, 0, 1);
  S.rain = clamp(fin(W.rain, 0), 0, 1);
  S.wind = clamp(Math.abs(fin(W.wind, 0.3)) / 1.45, 0, 1.4);
  S.fog = clamp(fin(W.fog, 0), 0, 1);
  const stormT = W.kind === 'storm' ? 1 : smoothstep(0.6, 1, S.wv) * 0.5;
  S.storm += (stormT - S.storm) * (1 - Math.exp(-dt * 0.5));

  const cam = G.cam || {};
  const px = fin(P.x, fin(cam.x, 0)), py = fin(P.y, -10);
  let wy = 0;
  try { wy = fin(waterY(G, px), 0); } catch (e) { wy = 0; }
  const under = G.mode !== 'title' && (typeof P.underwater === 'boolean' ? P.underwater : py > wy + 10);
  S.under = under ? 1 : 0;
  S.depth = under ? Math.max(0, py - wy) : 0;
  S.deep = smoothstep(40, 650, S.depth);
  E.under = under;

  const R = G.raft || {};
  const tiles = Array.isArray(R.tiles) ? R.tiles : [];
  const camx = fin(cam.x, px);
  const rmid = fin(R.x, 0) + tiles.length * C.TILE_W * 0.5;
  S.nearRaft = tiles.length ? 1 - smoothstep(220, 620, Math.abs(camx - rmid)) : 0;
  let grill = 0, lamp = R.lampLit ? 1 : 0;
  for (let i = 0; i < tiles.length; i++) {
    const s = tiles[i] && tiles[i].s;
    if (!s) continue;
    if (s.type === 'grill' && s.state === 'cook') grill = 1;
    else if (s.type === 'lamp' && s.on) lamp = 1;
  }
  S.grill = grill;
  // little fires: the grill, the lamp post, the lantern in the boy's hand
  S.flame = Math.max(grill * S.nearRaft, 0.3 * lamp * S.nearRaft, P.lantern === true && !under ? 0.22 : 0);
  S.sail = R.sailUp ? 1 : 0;

  // dry land of an island under the camera
  let land = 0, isl = null;
  try { isl = islandAt(G, camx); } catch (e) { isl = null; }
  if (isl && Number.isFinite(isl.x0) && Number.isFinite(isl.x1) && isl.x1 > isl.x0) {
    const c = (isl.x0 + isl.x1) / 2, hw = (isl.x1 - isl.x0) / 2;
    land = 1 - smoothstep(0.45, 0.9, Math.abs(camx - c) / hw);
  }
  if (P.onIsland) land = 1;
  S.land += (land - S.land) * (1 - Math.exp(-dt * 0.8));

  let gulls = 0, dolphin = 0, glow = 0, ghost = 0, danger = 0;
  const cr = G.creatures;
  if (Array.isArray(cr)) {
    for (let i = 0; i < cr.length; i++) {
      const c = cr[i];
      if (!c || c.dead) continue;
      switch (c.kind) {
        case 'gulls': gulls = 1; break;
        case 'dolphin': dolphin = 1; break;
        case 'jelly': case 'plankton': case 'lanternfish': glow = 1; break;
        case 'ghost_ship': ghost = 1; break;
        case 'shark': case 'angler': {
          if (!(P.inWater || under) || !Number.isFinite(c.x) || !Number.isFinite(c.y)) break;
          const hot = c.kind === 'angler' ? (c.state === 'leave' ? 0 : 0.7) : (SHARK_HOT[c.state] != null ? SHARK_HOT[c.state] : c.state === 'flee' ? 0 : 0.35);
          const d = Math.hypot(c.x - px, c.y - py);
          danger = Math.max(danger, hot * (1 - smoothstep(110, 380, d)));
          break;
        }
        default: break;
      }
    }
  }
  let beastNear = 0;
  const bs = G.beasts;
  if (Array.isArray(bs)) {
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i];
      if (!b || !Number.isFinite(b.x)) continue;
      const a = b.alpha == null ? 1 : clamp(fin(b.alpha, 0), 0, 1);
      const d = Math.abs(b.x - px);
      beastNear = Math.max(beastNear, a * (1 - smoothstep(250, 900, d)));
      if (!under && !P.inWater && b.st !== 'retreat') danger = Math.max(danger, 0.9 * a * (1 - smoothstep(140, 520, d)));
    }
  }
  S.gulls = gulls; S.dolphin = dolphin; S.glow = glow; S.ghost = ghost;
  S.danger += (danger - S.danger) * (1 - Math.exp(-dt * (danger > S.danger ? 3 : 0.6)));
  S.beastNear += (beastNear - S.beastNear) * (1 - Math.exp(-dt * 1.5));
}

// =====================================================================================
// continuous mix (20 Hz)
// =====================================================================================

function params(E) {
  const S = E.s, t = E.clock, mode = S.mode;
  const modeDuck = mode === 'pause' ? 0.35 : mode === 'panel' ? 0.7 : mode === 'dead' ? 0.4 : mode === 'ending' ? 0.6 : 1;
  const duck = modeDuck * (1 - 0.65 * S.fade);
  const modeCut = mode === 'pause' ? 1500 : mode === 'dead' ? 800 : mode === 'panel' ? 7000 : 20000;
  let cut = S.under ? lerp(820, 230, S.deep) : lerp(20000, 5200, S.fog);
  cut = Math.min(cut, modeCut);
  const ct = S.under ? 0.05 : 0.12;
  setP(E, E.uwLP.frequency, cut, ct);
  setP(E, E.verbLP.frequency, cut, ct);
  setP(E, E.worldOut.gain, duck * (S.under ? lerp(0.85, 0.4, S.deep) : 1), 0.1);
  setP(E, E.uw.gain, duck, 0.1);
  setP(E, E.music.gain, 0.8 * (S.under ? 0.8 : 1) * (1 - 0.75 * S.danger) * (1 - 0.4 * S.storm) * (mode === 'pause' ? 0.75 : 1), 0.4);

  // the sea
  const rough = S.wv, sea = (1 - 0.45 * S.land) * (1 - 0.2 * S.night);
  for (const [nm, sw] of [['surfL', E.swL], ['surfR', E.swR]]) {
    const L = drive(E, nm, (0.24 + 0.26 * rough) * (0.3 + 0.7 * sw.body) * sea, 0.12);
    if (L) setP(E, L.p.lp, 260 + (420 + 1100 * rough) * sw.body + 300 * sw.crest, 0.1);
  }
  const crest = (E.swL.crest + E.swR.crest) * 0.5;
  const hs = drive(E, 'hiss', (0.018 + (0.05 + 0.1 * rough) * crest) * sea, 0.1);
  if (hs) setP(E, hs.p.f, 1300 + 1200 * rough + 400 * crest, 0.2);

  // air
  const gust = clamp(noise1(t * 0.21, 3) * 0.7 + noise1(t * 0.9, 7) * 0.3, 0, 1);
  S.gust = gust;
  const wd = drive(E, 'wind', 0.008 + 0.075 * S.wind * S.wind * (0.5 + 0.7 * gust), 0.25);
  if (wd) setP(E, wd.p.f, 280 + 420 * gust + 300 * S.wind, 0.3);
  const wh = drive(E, 'whistle', smoothstep(0.55, 1.15, S.wind) * 0.022 * (0.3 + gust), 0.3);
  if (wh) setP(E, wh.p.f, 650 + 900 * noise1(t * 0.13, 11), 0.4);
  drive(E, 'rain', S.rain * 0.075, 0.4);
  drive(E, 'drops', S.rain * 0.12 * (0.4 + 0.6 * S.nearRaft), 0.4);
  drive(E, 'rumble', S.storm * 0.26 * (0.55 + 0.45 * noise1(t * 0.35, 5)), 0.3);

  // night and the deep
  const dr = drive(E, 'drone', S.night * 0.022 + S.night * S.deep * 0.015, 0.8);
  if (dr) setP(E, dr.p.lp, 150 + 110 * noise1(t * 0.07, 13), 0.5);
  const hm = drive(E, 'hum', S.under * (0.15 - 0.04 * S.deep), 0.08);
  if (hm) setP(E, hm.p.lp, lerp(240, 105, S.deep), 0.3);

  // islands
  drive(E, 'crickets', S.land * S.night * (1 - S.beastNear) * (1 - S.rain) * 0.03, 0.6);
  const lv = drive(E, 'leaves', S.land * S.day * (0.006 + 0.03 * S.wind * (0.4 + 0.6 * gust)), 0.3);
  if (lv) setP(E, lv.p.f, 2600 + 900 * gust, 0.4);

  // danger, fire
  const tn = drive(E, 'tension', S.danger * 0.07, 0.25);
  if (tn) setP(E, tn.p.lp, 300 + 400 * S.danger, 0.3);
  drive(E, 'fire', S.flame * 0.05, 0.4);

  // the night pad breathes: on for half a minute, then gone for a while
  const pd = E.pad;
  pd.t -= E.pdt;
  if (pd.t <= 0) {
    pd.on = !pd.on;
    pd.t = pd.on ? rnd(26, 48) : rnd(14, 30);
    if (pd.on) { pd.chord = (pd.chord + rndi(1, PAD_CHORDS.length - 1)) % PAD_CHORDS.length; pd.next = rnd(9, 15); }
  }
  pd.amp += ((pd.on ? 1 : 0) - pd.amp) * (1 - Math.exp(-E.pdt / 5));
  const pad = drive(E, 'pad', S.night * pd.amp * 0.036 * (1 - 0.6 * S.danger), 0.5);
  if (pad) {
    pd.next -= E.pdt;
    if (pd.next <= 0) {
      pd.next = rnd(9, 15);
      pd.chord = (pd.chord + rndi(1, PAD_CHORDS.length - 1)) % PAD_CHORDS.length;
      const ch = PAD_CHORDS[pd.chord];
      for (const [o, i] of pad.osc) {
        try { o.frequency.setTargetAtTime(mtof(ch[i]), E.ctx.currentTime, 1.6); } catch (e) { /* ignore */ }
      }
    }
    setP(E, pad.p.lp, 450 + 400 * noise1(t * 0.05, 17), 1);
  }
}

// =====================================================================================
// one-shot ambience
// =====================================================================================

function gullCry(E, near) {
  const t = nowOf(E) + 0.02;
  const v = new Voice(E, 'amb', E.amb, near ? rnd(0.12, 0.2) : rnd(0.045, 0.08), rnd(-0.7, 0.7));
  const lp = v.f('lowpass', near ? 6500 : 2600, 0);
  v.play(gullBuf(E), t, rnd(0.9, 1.12), lp);
  if (Math.random() < (near ? 0.5 : 0.3)) v.play(gullBuf(E), t + rnd(0.6, 1.6), rnd(0.85, 1.15), lp);
  v.send(near ? 0.15 : 0.45);
}
function raftCreak(E, S) {
  const t = nowOf(E) + 0.02;
  const v = new Voice(E, 'amb', E.amb, rnd(0.05, 0.11) * (0.8 + S.wv + 0.4 * S.storm), rnd(-0.5, 0.5));
  v.play(creakBuf(E), t, rnd(0.75, 1.2));
  if (Math.random() < 0.4) v.play(creakBuf(E), t + rnd(0.3, 0.8), rnd(1.2, 1.6), v.g(0.6));
}
function lap(E, S) {
  const t = nowOf(E) + 0.02;
  const v = new Voice(E, 'amb', E.amb, rnd(0.05, 0.11) * (0.7 + 0.8 * S.wv), rnd(-0.4, 0.4));
  hit(v, 'brown', t, 'bandpass', rnd(260, 650), 1.1, 1, rnd(0.015, 0.05), rnd(0.12, 0.3));
  if (Math.random() < 0.35) blip(v, t + rnd(0.02, 0.1), rnd(250, 420), rnd(450, 700), 0.05, 0.25);
}
function sailFlap(E, S) {
  const t = nowOf(E) + 0.02;
  const v = new Voice(E, 'amb', E.amb, 0.1 + 0.12 * Math.min(1, S.wind), rnd(-0.3, 0.3));
  flutter(v, t, rnd(0.5, 1.1), 1);
  if (Math.random() < 0.5) creakIn(v, t + rnd(0.1, 0.4), 0.4, rnd(1.3, 1.8));
}
function distantMoan(E, S) {
  const t = nowOf(E) + 0.05;
  const v = new Voice(E, 'amb', S.under ? E.uw : E.amb, S.under ? rnd(0.1, 0.16) : rnd(0.06, 0.1), rnd(-0.8, 0.8));
  moan(v, t, rnd(0.75, 1.05), v.f('lowpass', S.under ? 1600 : 700, 0));
  v.send(0.9, !S.under);
}
function deepGroan(E, S) {
  const t = nowOf(E) + 0.05, dur = rnd(4, 6.5);
  const v = new Voice(E, 'amb', S.under ? E.uw : E.amb, rnd(0.06, 0.1), rnd(-0.6, 0.6));
  const g = v.g(0);
  const bp = v.f('bandpass', rnd(140, 200), 3, g);
  const f = rnd(36, 44);
  for (const k of [1, 1.06]) {
    const o = v.osc('sawtooth', f * k, t, t + dur + 1, bp);
    o.frequency.linearRampToValueAtTime(f * k * rnd(0.82, 0.9), t + dur);
  }
  v.noise('brown', t, t + dur + 1, v.f('lowpass', 160, 0, g));
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.8, t + dur * 0.4);
  g.gain.setTargetAtTime(0, t + dur * 0.55, dur * 0.15);
  v.send(0.8, !S.under);
}
function ambBubbles(E, S) {
  const v = new Voice(E, 'amb', E.uw, rnd(0.08, 0.16) * (1 - 0.4 * S.deep), rnd(-0.6, 0.6));
  bubbles(v, nowOf(E) + 0.02, rndi(1, 4), 0.5, 0.8, lerp(1, 0.6, S.deep));
}
function breathBubbles(E) {
  const v = new Voice(E, 'amb', E.uw, 0.2, 0);
  bubbles(v, nowOf(E) + 0.02, rndi(3, 6), 0.35, 1, 1.15);
}
function birdChirp(E) {
  const v = new Voice(E, 'amb', E.amb, rnd(0.035, 0.07), rnd(-0.7, 0.7));
  let tt = nowOf(E) + 0.02;
  const base = rnd(2600, 4200), n = rndi(2, 5);
  for (let i = 0; i < n; i++) {
    const g = v.g(0);
    const o = v.osc('sine', base * rnd(0.8, 1), tt, tt + 0.12, g);
    o.frequency.exponentialRampToValueAtTime(base * rnd(1.2, 1.6), tt + 0.05);
    env(g.gain, tt, 0.6, 0.004, 0.05);
    tt += rnd(0.07, 0.13);
  }
  v.send(0.25);
}
const HIGH_PENTA = [86, 88, 90, 93, 95, 98, 100, 102, 105];
function tinkle(E) {
  const v = new Voice(E, 'amb', E.music, rnd(0.25, 0.45), rnd(-0.8, 0.8));
  const t = nowOf(E) + 0.02;
  bell(v, mtof(pickOne(HIGH_PENTA)), t, 0.18, 2.4, GLASS);
  if (Math.random() < 0.4) bell(v, mtof(pickOne(HIGH_PENTA)), t + rnd(0.15, 0.4), 0.12, 2.2, GLASS);
}
function dolphinCall(E, S) {
  const t = nowOf(E) + 0.02;
  const v = new Voice(E, 'amb', S.under ? E.uw : E.amb, rnd(0.03, 0.06), rnd(-0.7, 0.7));
  const g = v.g(0);
  const o = v.osc('sine', 5200, t, t + 0.6, g);
  o.frequency.exponentialRampToValueAtTime(8600, t + 0.12);
  o.frequency.exponentialRampToValueAtTime(6100, t + 0.3);
  o.frequency.exponentialRampToValueAtTime(7400, t + 0.45);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.5, t + 0.03);
  g.gain.setValueAtTime(0.5, t + 0.38);
  g.gain.linearRampToValueAtTime(0, t + 0.5);
  if (Math.random() < 0.6) {
    let tt = t + rnd(0.55, 0.8);
    for (let i = rndi(8, 14); i > 0; i--) { hit(v, 'white', tt, 'highpass', 4000, 0, 0.5, 0.0005, 0.004); tt += rnd(0.008, 0.016); }
  }
}
function ghostBell(E) {
  const v = new Voice(E, 'amb', E.amb, rnd(0.07, 0.1), rnd(-0.6, 0.6));
  bell(v, mtof(rndi(43, 47)), nowOf(E) + 0.02, 0.5, 5, BELL, v.f('lowpass', 1600, 0));
  v.send(0.9);
}

function events(E, G, S, dt) {
  if (!(G.mode === 'play' || G.mode === 'title')) return;
  const ev = E.ev;
  for (const k in ev) ev[k] -= dt;
  if (ev.gull <= 0) {
    ev.gull = S.gulls ? rnd(2.5, 7) : rnd(16, 44);
    if (S.day > 0.5 && !S.under && S.rain < 0.35 && S.storm < 0.3 && S.fog < 0.6) gullCry(E, S.gulls > 0);
  }
  if (ev.creak <= 0) {
    ev.creak = rnd(5, 13) / (0.35 + 0.65 * S.night + 1.6 * S.wv + 0.6 * S.storm);
    if (S.nearRaft > 0.1) raftCreak(E, S);
  }
  if (ev.lap <= 0) {
    ev.lap = rnd(0.5, 1.8) / (0.7 + 0.7 * S.wv);
    if (S.nearRaft > 0.1 && S.depth < 200) lap(E, S);
  }
  if (ev.flap <= 0) {
    ev.flap = rnd(3, 9) / (0.5 + S.wind);
    if (S.sail && S.nearRaft > 0.2 && S.wind > 0.15) sailFlap(E, S);
  }
  if (ev.moan <= 0) {
    ev.moan = S.under ? rnd(25, 60) : rnd(45, 100);
    if (S.night > 0.7 && S.storm < 0.3) distantMoan(E, S);
  }
  if (ev.groan <= 0) {
    ev.groan = rnd(55, 120);
    if ((S.night > 0.8 || S.deep > 0.5) && S.storm < 0.5) deepGroan(E, S);
  }
  if (ev.bubble <= 0) { ev.bubble = rnd(0.5, 2.2); if (S.under) ambBubbles(E, S); }
  if (ev.breath <= 0) { ev.breath = rnd(2.2, 4); if (S.under && G.mode === 'play') breathBubbles(E); }
  if (ev.bird <= 0) { ev.bird = rnd(1.8, 6); if (S.land > 0.5 && S.day > 0.5 && S.rain < 0.3) birdChirp(E); }
  if (ev.tinkle <= 0) { ev.tinkle = rnd(1.2, 3.5); if (S.glow && S.night > 0.4) tinkle(E); }
  if (ev.dolphin <= 0) { ev.dolphin = rnd(1.2, 3.8); if (S.dolphin) dolphinCall(E, S); }
  if (ev.bell <= 0) { ev.bell = rnd(8, 15); if (S.ghost) ghostBell(E); }
  if (S.ghost && !E.ghostCue) { E.ghostCue = true; request('ghost', 2, 1); }
  else if (!S.ghost) E.ghostCue = false;
}

// =====================================================================================
// public API
// =====================================================================================

function onVisibility() {
  hidden = typeof document !== 'undefined' && !!document.hidden;
  if (!A) return;
  try {
    if (hidden) A.ctx.suspend();
    else if (!muted && gestured) A.ctx.resume();
  } catch (e) { /* ignore */ }
}

function installHooks() {
  if (hooked || typeof window === 'undefined') return;
  hooked = true;
  const once = () => {
    unlockAudio();
    if (A && A.ctx.state === 'running') {
      window.removeEventListener('pointerdown', once, true);
      window.removeEventListener('keydown', once, true);
      window.removeEventListener('touchend', once, true);
    }
  };
  window.addEventListener('pointerdown', once, true);
  window.addEventListener('keydown', once, true);
  window.addEventListener('touchend', once, true);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
}

export function init(G) {
  G0 = G || G0;
  installHooks();
  if (G && G.persist && G.persist.audio && typeof G.persist.audio !== 'object') G.persist.audio = { landed: {} };
}

export function update(G, dt) {
  if (!G) return;
  G0 = G;
  const d = typeof dt === 'number' && Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 1 / 60;
  try { track(G, d); } catch (e) { /* tracking must never break the frame */ }
  const E = A;
  if (!E || muted || hidden) return;
  if (E.ctx.state === 'closed') { A = null; return; }
  E.clock += d;
  reap(E);
  sense(G, E, d);
  swell(E.swL, E.clock, E.s.wv, d);
  swell(E.swR, E.clock, E.s.wv, d);
  E.pt += d;
  if (E.pt >= 0.05) { E.pdt = E.pt; E.pt = 0; params(E); }
  events(E, G, E.s, d);
  music(E, G, d);
}

export function sfx(name, opts) {
  const E = A;
  if (!E || muted || hidden) return;
  const fn = SFX[name];
  if (typeof fn !== 'function') return;
  try {
    if (E.ctx.state === 'closed') return;
    const o = opts && typeof opts === 'object' ? opts : (typeof opts === 'number' ? { vol: opts } : {});
    const now = nowOf(E);
    const thr = THROTTLE[name] != null ? THROTTLE[name] : 0.05;
    const last = E.last[name];
    if (last != null && now - last < thr && now >= last) return;
    if ((E.byName[name] || 0) >= (MAXN[name] || 6)) return;
    if (E.voices.length > 64 && !PRIORITY[name]) return;
    let vol = o.vol != null ? o.vol : o.volume != null ? o.volume : 1;
    vol = clamp(fin(Number(vol), 1), 0, 1.5);
    if (vol <= 0.001) return;
    let pan = 0;
    if (Number.isFinite(o.x) && G0 && G0.cam && G0.view) {
      const dx = o.x - fin(G0.cam.x, o.x), hw = Math.max(200, fin(G0.view.w, 720) * 0.5);
      pan = clamp(dx / (hw * 1.2), -1, 1) * 0.75;
      vol *= 1 - 0.75 * smoothstep(hw * 0.9, hw * 3, Math.abs(dx));
    }
    E.last[name] = now;
    fn(E, now + 0.006, vol, pan, o);
  } catch (e) { /* a sound must never break gameplay */ }
}

export function unlockAudio() {
  gestured = true;
  installHooks();
  if (muted) return;
  if (A && A.ctx.state === 'running') return;
  const fresh = !A;
  const E = ensureEngine();
  if (!E) return;
  try {
    if (E.ctx.state !== 'running' && !hidden) {
      const p = E.ctx.resume();
      if (p && p.catch) p.catch(() => {});
    }
    if (fresh) {
      // iOS needs a sound started inside the gesture to really unlock output
      const s = E.ctx.createBufferSource();
      s.buffer = E.ctx.createBuffer(1, 1, E.ctx.sampleRate);
      s.connect(E.ctx.destination);
      s.start(0);
    }
  } catch (e) { /* ignore */ }
}

export function setMuted(m) {
  muted = !!m;
  try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch (e) { /* ignore */ }
  clearTimeout(suspendTimer);
  if (muted) {
    if (A) {
      const E = A;
      try {
        const t = E.ctx.currentTime;
        E.master.gain.cancelScheduledValues(t);
        E.master.gain.setValueAtTime(E.master.gain.value, t);
        E.master.gain.setTargetAtTime(0, t, 0.05);
      } catch (e) { /* ignore */ }
      suspendTimer = setTimeout(() => { if (muted && A === E) { try { E.ctx.suspend(); } catch (e) { /* ignore */ } } }, 350);
    }
    return;
  }
  if (!gestured) return;
  const E = ensureEngine();
  if (!E) return;
  try {
    if (!hidden && E.ctx.state !== 'running') { const p = E.ctx.resume(); if (p && p.catch) p.catch(() => {}); }
    const t = E.ctx.currentTime;
    E.master.gain.cancelScheduledValues(t);
    E.master.gain.setValueAtTime(E.master.gain.value, t);
    E.master.gain.setTargetAtTime(MASTER, t + 0.02, 0.25);
  } catch (e) { /* ignore */ }
}

export function isMuted() { return muted; }

// ---- debug / test handle (not used by the game)
function stats() {
  const E = A;
  if (!E) return { engine: false, muted, gestured };
  const layers = {};
  for (const k of Object.keys(E.layers)) if (E.layers[k].n) layers[k] = +(E.layers[k].n.out.gain._v || 0).toFixed(4);
  return {
    engine: true, state: E.ctx.state, muted, voices: E.voices.length, music: E.mus.cur,
    queued: E.mus.q.length - E.mus.i, layers, s: { ...E.s },
  };
}
if (typeof window !== 'undefined') {
  window.__raftAudio = {
    stats,
    names: SFX_NAMES,
    songs: Object.keys(SONGS).concat(Object.keys(SEQ)),
    get engine() { return A; },
    build: buildEngine,
    use(E) { const prev = A; A = E; return prev; },
    cue(name) { return A ? startCue(A, name, 0.1) : false; },
    sfx: (name, opts) => sfx(name, opts),
    mute: (m) => setMuted(m),
    update: (G, dt) => update(G, dt),
  };
}
