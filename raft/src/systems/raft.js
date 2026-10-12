// 少年与海 — 木筏 (the raft).
//
// update(G, dt): drift with the current (sail + wind), beaching on islands, the deck that
//   floats on the waves tile by tile (a spring per tile, a slight bend, a dip under the
//   boy's weight), tiles breaking off, the structures (anchor, purifier, grill, sail, lamp,
//   hammock) with their timers / interactables / lights, the short fade cutscenes (sailing
//   around an island, sleeping through the night) and the hammer build mode.
// deckAt(G, x): deck-top y under x (piecewise linear between tile centres), null off the raft.
// draw(ctx, G): a weathered junk raft — board ends, a half-sunk stringer log with barnacles,
//   rope lashings, salvaged floats — and its structures. Everything is painted once into
//   cached sprites, then composed every frame into an offscreen buffer where it receives
//   the scene light (sun / moon rim, dusk silhouette, cold night tint, warm lamp light).
// drawBuildGhost(ctx, G): (drawn above the water surface) lamp reflections on the water and
//   the build-mode ghost + its label.
//
// Persistent: G.raft {x, tiles:[{hp, s, v}], anchored, sailUp}. `v` is a per-tile art seed.
//   Structures: anchor{down} purifier{water,prog} grill{state,t} sail{up} lamp{on} bed{}.
// Runtime: G.raftRt, plus G.raft.y / vx / beached (island id or null) / aground (bool) / lampLit /
//   lampPos ({x,y} of the lit lamp's flame, or null) / busy (a fade cutscene is running: sailing
//   around an island or sleeping; the player ignores movement and tool input, saves are refused).

import { C, say, journal, skipToPhase, statClamp } from '../core/state.js';
import { input, hint } from '../core/input.js';
import { waterY, addLight, addInteract, onScreen, worldToScreen } from '../core/world.js';
import { emit } from '../core/particles.js';
import { TAU, clamp, lerp, smoothstep, noise1, seeded, makeCanvas, rand, pick, mixColor } from '../core/util.js';
import { count, hasItems, takeItems, addItem, ITEMS } from './inventory.js';
import { sfx } from './audio.js';
import { groundAt as isleGroundAt, islandAt } from './islands.js';
import { celestial } from '../render/sky.js';

// =====================================================================================
// tuning
// =====================================================================================

const TW = C.TILE_W;
const MAX_TILES = 14;
const TILE_COST = { wood: 2, rope: 1 };
const REPAIR_COST = { wood: 1 };
const PLACEABLES = ['purifier', 'grill', 'sail', 'lamp', 'bed'];
const UNIQUE = { sail: true, bed: true, anchor: true };
const NAMES = {
  tile: '木筏', purifier: '净水器', grill: '烤架', sail: '船帆', lamp: '灯柱', bed: '吊床', anchor: '锚',
  wood: '木板', rope: '绳子', water: '淡水', raw_fish: '生鱼', cooked_fish: '烤鱼',
};
const WATER_MAX = 3;
const WATER_TIME = 45;        // seconds per bottle in full daylight
const COOK_TIME = 10;
const REACH_X = 76, REACH_Y = 56;
const MAX_SPEED = 34;         // drift + sail + storm never outrun the boy swimming after the raft
const SLACK = 0.5;            // share of the sail's push left while nobody is aboard to trim it
const BEACH_STEP = 6;         // a beached raft's front deck end stays at most this far above the sand
const SLEEP_FROM = 0.72;      // the first part of every night is played, not slept through
const SLEEP_COST = 45;        // hunger and thirst spent by a night's sleep
let SPR = 4;                  // sprite pixels per world unit (matched to the device scale, see art())
const NV = 10;                // tile art variants
const FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC","Noto Sans SC","WenQuanYi Zen Hei",sans-serif';

const DREAMS = [
  '在吊床上睡着了。梦里有一座很高的灯塔，灯一直亮着，好像在等谁。',
  '夜里醒过一次，听见木筏下面有很大的东西慢慢游过去。再睁眼，天已经亮了。',
  '海浪摇了一整夜。梦见了家门口那棵树，和树下的秋千。',
  '睡得很沉。醒来的时候，有一只海鸥站在桅杆上，歪着头看我。',
  '梦见自己变得很小很小，木筏变成了一片叶子。醒来以后，手还紧紧抓着吊床的绳子。',
];

// =====================================================================================
// small safe wrappers around other modules (they may still be stubs)
// =====================================================================================

const warned = new Set();
function oops(tag, e) {
  if (warned.has(tag)) return;
  warned.add(tag);
  try { console.warn('[raft → ' + tag + ']', e); } catch (er) { /* ignore */ }
}
function play(name, opts) { try { sfx(name, opts); } catch (e) { oops('sfx', e); } }
function wy(G, x) {
  try { const y = waterY(G, x); return Number.isFinite(y) ? y : 0; } catch (e) { oops('waterY', e); return 0; }
}
function isleGround(G, x) {
  try { const y = isleGroundAt(G, x); return Number.isFinite(y) ? y : null; } catch (e) { oops('islands.groundAt', e); return null; }
}
function isleAt(G, x) {
  try { return islandAt(G, x) || null; } catch (e) { oops('islands.islandAt', e); return null; }
}
function have(G, id) {
  try { const n = count(G, id); return Number.isFinite(n) ? n : 0; } catch (e) { return (G.inv && G.inv[id]) || 0; }
}
function canPay(G, cost) {
  try { return !!hasItems(G, cost); } catch (e) { return Object.keys(cost).every((k) => have(G, k) >= cost[k]); }
}
function pay(G, cost) {
  try { return !!takeItems(G, cost); } catch (e) {
    if (!canPay(G, cost)) return false;
    for (const k of Object.keys(cost)) G.inv[k] -= cost[k];
    return true;
  }
}
function give(G, id, n) {
  try { addItem(G, id, n); } catch (e) { G.inv[id] = (G.inv[id] || 0) + n; }
}
function itemName(id) {
  try { const it = ITEMS && ITEMS[id]; if (it && typeof it.name === 'string') return it.name; } catch (e) { /* stub */ }
  return NAMES[id] || id;
}

// =====================================================================================
// runtime state
// =====================================================================================

function rt(G) {
  let r = G.raftRt;
  if (!r) {
    r = G.raftRt = {
      ys: [], vs: [], as: [], yc: 0, slope: 0, lastX: NaN,
      sel: 'tile', build: null, wasBuilding: false, selT: 9,
      seq: null, beachSaid: null, wreck: [],
      wasOn: false, airVY: 0, sailK: 0, crewK: 1, dripT: 0,
      lampPos: null, grillPos: null,
    };
  }
  return r;
}

const findStruct = (R, type) => {
  for (let i = 0; i < R.tiles.length; i++) { const s = R.tiles[i] && R.tiles[i].s; if (s && s.type === type) return { i, s }; }
  return null;
};

function newStruct(type) {
  switch (type) {
    case 'anchor': return { type, down: false };
    case 'purifier': return { type, water: 0, prog: 0 };
    case 'grill': return { type, state: 'idle', t: 0 };
    case 'sail': return { type, up: false };
    case 'lamp': return { type, on: true };
    case 'bed': return { type };
    default: return null;
  }
}

function newSeed() { return (Math.random() * 1e6) | 0; }

function sanitize(R) {
  if (!Array.isArray(R.tiles)) R.tiles = [];
  R.tiles = R.tiles.filter((t) => t && typeof t === 'object');
  if (!R.tiles.length) {
    for (let i = 0; i < 4; i++) R.tiles.push({ hp: 100, s: null });
    R.tiles[0].s = newStruct('anchor');
  }
  while (R.tiles.length > MAX_TILES) R.tiles.pop();
  for (const t of R.tiles) {
    if (!Number.isFinite(t.hp)) t.hp = 100;
    t.hp = clamp(t.hp, -50, 100);
    if (!Number.isFinite(t.v)) t.v = newSeed();
    const s = t.s;
    if (!s || typeof s !== 'object' || !newStruct(s.type)) { t.s = null; continue; }
    if (s.type === 'purifier') { s.water = clamp(Number.isFinite(s.water) ? s.water | 0 : 0, 0, WATER_MAX); if (!Number.isFinite(s.prog)) s.prog = 0; }
    if (s.type === 'grill') { if (!['idle', 'cook', 'done'].includes(s.state)) s.state = 'idle'; if (!Number.isFinite(s.t)) s.t = 0; }
    if (s.type === 'lamp' && typeof s.on !== 'boolean') s.on = true;
  }
  if (!Number.isFinite(R.x)) R.x = 0;
}

// =====================================================================================
// init
// =====================================================================================

export function init(G) {
  if (!G.raft || typeof G.raft !== 'object') G.raft = { x: 0, tiles: [], anchored: false, sailUp: false };
  const R = G.raft;
  sanitize(R);
  G.raftRt = null;
  const r = rt(G);
  const sail = findStruct(R, 'sail');
  R.sailUp = !!sail && (!!R.sailUp || !!sail.s.up);
  if (sail) sail.s.up = R.sailUp;
  const anc = findStruct(R, 'anchor');
  R.anchored = !!R.anchored || !!(anc && anc.s.down);
  if (anc) anc.s.down = R.anchored;
  r.sailK = R.sailUp ? 1 : 0;
  R.vx = 0;
  R.busy = false;
  R.lampPos = null;
  R.beached = null;
  R.aground = false;
  R.lampLit = R.tiles.some((t) => t.s && t.s.type === 'lamp' && t.s.on);
  snapDeck(G, r);
  r.crewK = G.demo || boyOnRaft(G) ? 1 : SLACK;
  // already sitting against an island (loaded game): don't announce it again
  const fx = R.x + R.tiles.length * TW;
  const g = isleGround(G, fx + 2.5);
  if (g != null && g < 0) {
    const isl = isleAt(G, fx + 2.5);
    R.beached = isl && isl.id != null ? isl.id : true;
    R.aground = true;
    r.beachSaid = R.beached;
  }
}

// =====================================================================================
// the deck: one spring per tile following the waves, a gentle bend, the boy's weight
// =====================================================================================

function deckTargets(G, r, out) {
  const R = G.raft, n = R.tiles.length, len = n * TW, mid = R.x + len / 2;
  const flex = clamp(0.24 + n * 0.018, 0.24, 0.46);
  for (let i = 0; i < n; i++) {
    const cx = R.x + (i + 0.5) * TW;
    const rigid = r.yc + (cx - mid) * r.slope;
    out[i] = lerp(rigid, wy(G, cx) - C.DECK_H, flex);
  }
}

function rigidFit(G) {
  const R = G.raft, n = R.tiles.length, len = n * TW, mid = R.x + len / 2;
  const wl = wy(G, R.x + 3), wr = wy(G, R.x + len - 3), wm = wy(G, mid);
  return {
    yc: (n > 2 ? wm * 0.5 + (wl + wr) * 0.25 : wm) - C.DECK_H,
    slope: clamp(((wr - wl) / Math.max(TW, len - 6)) * 0.8, -0.24, 0.24),
  };
}

function snapDeck(G, r) {
  const R = G.raft, n = R.tiles.length;
  const fit = rigidFit(G);
  r.yc = fit.yc; r.slope = fit.slope;
  r.ys.length = n; r.vs.length = n; r.as.length = n;
  deckTargets(G, r, r.ys);
  for (let i = 0; i < n; i++) r.vs[i] = 0;
  angles(r);
  r.lastX = R.x;
  R.y = deckAt(G, R.x + n * TW / 2);
  if (!Number.isFinite(R.y)) R.y = -C.DECK_H;
}

function angles(r) {
  const ys = r.ys, n = ys.length;
  for (let i = 0; i < n; i++) {
    const a = ys[Math.max(0, i - 1)], b = ys[Math.min(n - 1, i + 1)];
    const span = (Math.min(n - 1, i + 1) - Math.max(0, i - 1)) * TW;
    r.as[i] = span > 0 ? Math.atan((b - a) / span) : 0;
  }
}

const tgt = [];
function stepDeck(G, r, dt) {
  const R = G.raft, n = R.tiles.length;
  const fit = rigidFit(G);
  r.yc += (fit.yc - r.yc) * Math.min(1, dt * 7);
  r.slope += (fit.slope - r.slope) * Math.min(1, dt * 5);
  tgt.length = n;
  deckTargets(G, r, tgt);

  // the boy's weight, and a little bounce when he lands
  const P = G.player;
  const on = boyStanding(G);
  if (P && on && !r.wasOn && !G.demo) {
    const imp = clamp(Math.max(r.airVY, 90) * 0.075, 4, 26);
    for (let i = 0; i < n; i++) {
      const d = Math.abs(R.x + (i + 0.5) * TW - P.x) / TW;
      if (d < 1.6) r.vs[i] += imp * (1 - d / 1.6);
    }
  }
  r.wasOn = on;
  r.airVY = P && Number.isFinite(P.vy) ? P.vy : 0;
  for (let i = 0; i < n; i++) {
    let load = 0;
    if (P && on) load = 0.9 * Math.max(0, 1 - Math.abs(R.x + (i + 0.5) * TW - P.x) / (TW * 1.2));
    const a = 95 * (tgt[i] + load - r.ys[i]) - 13 * r.vs[i];
    r.vs[i] += a * dt;
    r.ys[i] += r.vs[i] * dt;
    if (!Number.isFinite(r.ys[i])) { r.ys[i] = tgt[i]; r.vs[i] = 0; }
  }
  if (R.beached != null) restOnBeach(G, r);
  angles(r);
  R.y = deckAt(G, R.x + n * TW / 2);
}

// Beached: the nose rests on the sand. A wave may lift the rest of the raft, but the front
// deck end stays within a small step of the beach, so the boy can walk between the two.
function restOnBeach(G, r) {
  const R = G.raft, n = R.tiles.length, len = n * TW, fx = R.x + len;
  let g = null;
  for (const x of [fx, fx + 2.5]) { const y = isleGround(G, x); if (y != null && (g == null || y < g)) g = y; }
  if (g == null) return;
  const ys = r.ys;
  const edge = n === 1 ? ys[0] : ys[n - 1] + 0.5 * (ys[n - 1] - ys[n - 2]);
  const over = (g - BEACH_STEP) - edge;          // > 0: the deck end sits too high above the sand
  if (!(over > 0)) return;
  // press the front down, fading out over the last couple of tiles (the raft pivots on its nose)
  const w = (i) => clamp(1 - (len - (i + 0.5) * TW) / (2.5 * TW), 0, 1);
  const gain = n === 1 ? w(0) : 1.5 * w(n - 1) - 0.5 * w(n - 2);
  if (!(gain > 0.05)) return;
  const d = over / gain;
  for (let i = Math.max(0, n - 3); i < n; i++) {
    const k = w(i);
    if (k <= 0) continue;
    ys[i] += d * k;
    if (r.vs[i] < 0) r.vs[i] = 0;
  }
}

export function deckAt(G, x) {
  const R = G && G.raft;
  if (!R || !Array.isArray(R.tiles) || !R.tiles.length || !Number.isFinite(R.x) || !Number.isFinite(x)) return null;
  const n = R.tiles.length;
  if (x < R.x || x > R.x + n * TW) return null;
  const r = G.raftRt;
  if (!r || r.ys.length !== n) return Number.isFinite(R.y) ? R.y : null;
  const ys = r.ys;
  const u = (x - R.x) / TW - 0.5;
  if (n === 1) return ys[0] + u * TW * Math.tan(r.as[0] || 0);
  if (u <= 0) return ys[0] + u * (ys[1] - ys[0]);
  if (u >= n - 1) return ys[n - 1] + (u - (n - 1)) * (ys[n - 1] - ys[n - 2]);
  const i = Math.floor(u), f = u - i;
  return ys[i] + (ys[i + 1] - ys[i]) * f;
}

// feet on the deck right now
function boyStanding(G) {
  const P = G.player;
  if (!P || !Number.isFinite(P.x) || !Number.isFinite(P.y) || G.demo || P.dead) return false;
  if (typeof P.onRaft === 'boolean') return P.onRaft;
  const d = deckAt(G, P.x);
  return d != null && Math.abs(P.y - d) < 2.5;
}

// standing on the deck (or hopping just above it)
function boyOnRaft(G) {
  const P = G.player, R = G.raft;
  if (!P || !Number.isFinite(P.x) || !Number.isFinite(P.y) || G.demo || P.dead || !R.tiles.length) return false;
  if (P.onRaft === true) return true;
  if (P.inWater || P.onIsland) return false;
  const d = deckAt(G, P.x);
  return d != null && P.y <= d + 2 && P.y > d - 60;
}

// a tile's frame: centre x, deck-top y, tilt
function frameOf(G, r, i) {
  const R = G.raft;
  return { x: R.x + (i + 0.5) * TW, y: r.ys[i], a: r.as[i] || 0 };
}
function toWorld(f, lx, ly) {
  const c = Math.cos(f.a), s = Math.sin(f.a);
  return { x: f.x + lx * c - ly * s, y: f.y + lx * s + ly * c };
}

// =====================================================================================
// update
// =====================================================================================

export function update(G, dt) {
  const R = G.raft;
  if (!R || typeof R !== 'object') return;
  if (!Array.isArray(R.tiles) || !R.tiles.length || !Number.isFinite(R.x)) { init(G); return; }
  const r = rt(G);
  if (!(dt > 0)) dt = 0;
  if (r.ys.length !== R.tiles.length || !(Math.abs(R.x - r.lastX) < 60)) snapDeck(G, r);

  updateSeq(G, r, dt);
  breakTiles(G, r);
  syncFlags(G, r, dt);
  drift(G, r, dt);
  stepDeck(G, r, dt);
  structures(G, r, dt);
  buildMode(G, r);
  updateWreck(G, r, dt);
  r.lastX = R.x;
  R.busy = !!r.seq;
}

function syncFlags(G, r, dt) {
  const R = G.raft;
  const sail = findStruct(R, 'sail');
  if (!sail) R.sailUp = false; else sail.s.up = !!R.sailUp;
  const anc = findStruct(R, 'anchor');
  if (anc) anc.s.down = !!R.anchored;
  r.sailK = clamp(r.sailK + (R.sailUp ? 1 : -1) * dt * 1.4, 0, 1);
}

// ------------------------------------------------------------------ drifting & beaching
function drift(G, r, dt) {
  const R = G.raft, n = R.tiles.length, len = n * TW;
  const W = G.weather || {};
  const wind = Number.isFinite(W.wind) ? Math.max(0, W.wind) : 0.3;
  // nobody aboard to trim it: the sail slackens to half its push (and fills again when he's back)
  const crew = G.demo || boyOnRaft(G) ? 1 : SLACK;
  r.crewK += clamp(crew - r.crewK, -dt * 0.8, dt * 0.8);
  let v = 0;
  if (!R.anchored && !r.seq) {
    v = C.DRIFT * clamp(0.82 + 0.6 * wind, 0.8, 1.7);
    if (R.sailUp) v += C.SAIL_BOOST * clamp(0.55 + wind, 0.6, 2.2) * r.sailK * r.crewK;
    v = Math.min(v, MAX_SPEED);
  }
  const blocked = (fx) => { const g = isleGround(G, fx); return g != null && g < 0; };
  const front = R.x + len;
  let beached = blocked(front + 2.5);
  const x0 = R.x;
  if (!beached && v > 0 && dt > 0) {
    let nx = R.x + v * dt;
    if (blocked(nx + len + 2)) {
      let lo = R.x, hi = nx;
      for (let k = 0; k < 14; k++) { const m = (lo + hi) / 2; if (blocked(m + len + 2)) hi = m; else lo = m; }
      nx = lo; beached = true;
    }
    R.x = nx;
  }
  R.vx = dt > 0 ? (R.x - x0) / dt : 0;
  if (beached) {
    const fx = R.x + len;
    const isl = isleAt(G, fx + 2.5) || isleAt(G, fx + 8) || isleAt(G, fx);
    const id = isl && isl.id != null ? isl.id : true;
    if (R.beached == null) {
      if (r.beachSaid !== id && !G.demo) {
        say(G, '木筏搁浅在小岛边上了');
        G.shake = (G.shake || 0) + 0.25;
        play('splash', { volume: 0.5 });
        for (let k = 0; k < 10; k++) emit(G, { x: fx + rand(-2, 4), y: wy(G, fx) - 1, vx: rand(-30, 30), vy: rand(-70, -25), life: rand(0.4, 0.9), size: rand(0.8, 1.8), gravity: 260, color: [225, 235, 240], alpha: 0.8 });
      }
      r.beachSaid = id;
    }
    R.beached = id;
  } else R.beached = null;
  R.aground = R.beached != null;     // convenience boolean (an island id can be 0)
}

// ------------------------------------------------------------------ tiles breaking off
function breakTiles(G, r) {
  const R = G.raft;
  for (let i = R.tiles.length - 1; i >= 0; i--) {
    const t = R.tiles[i];
    if (!(t.hp <= 0)) continue;
    if (R.tiles.length <= 1) { t.hp = 1; continue; }
    const f = frameOf(G, r, i);
    const lost = t.s;
    R.tiles.splice(i, 1);
    r.ys.splice(i, 1); r.vs.splice(i, 1); r.as.splice(i, 1);
    if (i === 0) R.x += TW;
    r.lastX = R.x;
    // the anchor can't be crafted again: it gets dragged onto the next free tile
    let gone = lost;
    if (lost && lost.type === 'anchor') {
      gone = null;
      const order = R.tiles.map((_, k) => k).sort((a, b) => Math.abs(a - i) - Math.abs(b - i));
      let k = order.find((j) => !R.tiles[j].s);
      if (k == null) {
        k = order[0];
        const s = R.tiles[k].s;
        if (s && PLACEABLES.includes(s.type)) give(G, s.type, 1);
      }
      if (k != null) R.tiles[k].s = lost;
    }
    if (gone && gone.type === 'sail') R.sailUp = false;
    // a piece of it floats away
    r.wreck.push({ x: f.x, y: f.y, vx: rand(-4, 4), rot: f.a, vr: rand(-0.4, 0.4), t: 0, life: 26, v: t.v, s: gone ? gone.type : null });
    if (r.wreck.length > 8) r.wreck.shift();
    if (!G.demo) {
      say(G, '木筏被咬掉了一块！', 'warn');
      if (gone) say(G, itemName(gone.type) + '跟着一起沉进了海里……', 'warn');
    }
    G.shake = (G.shake || 0) + 0.45;
    play('splash');
    for (let k = 0; k < 18; k++) {
      emit(G, { x: f.x + rand(-12, 12), y: wy(G, f.x) - 1, vx: rand(-60, 60), vy: rand(-120, -30), life: rand(0.5, 1.1), size: rand(0.8, 2.2), gravity: 300, color: [220, 232, 240], alpha: 0.85 });
    }
    for (let k = 0; k < 9; k++) {
      emit(G, { x: f.x + rand(-10, 10), y: f.y + rand(-1, 4), vx: rand(-50, 50), vy: rand(-90, -20), life: rand(0.6, 1.3), size: rand(0.8, 1.6), gravity: 320, color: [120, 86, 54], alpha: 1 });
    }
  }
}

function updateWreck(G, r, dt) {
  const W = r.wreck;
  for (let k = W.length - 1; k >= 0; k--) {
    const w = W[k];
    w.t += dt;
    w.x += w.vx * dt;
    w.vx *= 1 / (1 + dt * 0.3);
    const target = wy(G, w.x) - 1 + smoothstep(w.life - 6, w.life, w.t) * 12;
    w.y += (target - w.y) * Math.min(1, dt * 3);
    w.rot += w.vr * dt;
    w.vr += (-w.rot * 0.8 + (wy(G, w.x + 6) - wy(G, w.x - 6)) / 12) * dt;
    w.vr *= 1 / (1 + dt * 1.5);
    if (w.t > w.life) W.splice(k, 1);
  }
}

// ------------------------------------------------------------------ structures
const LAMP_PIVOT = [7.4, -45.6];
const LANT_L = 5.6;

function lampSwing(G, i) {
  const t = G.time || 0;
  const W = G.weather || {};
  const wind = Number.isFinite(W.wind) ? W.wind : 0.3;
  return 0.1 * Math.sin(t * 1.25 + i * 1.7) + 0.05 * Math.sin(t * 2.9 + i) * (0.4 + wind) + 0.06 * clamp(wind, -1.5, 1.5);
}
function lanternLocal(G, i, a) {
  const th = lampSwing(G, i) - (a || 0) * 0.85; // it keeps hanging roughly straight down
  return { x: LAMP_PIVOT[0] + Math.sin(th) * LANT_L, y: LAMP_PIVOT[1] + Math.cos(th) * LANT_L, th };
}

function structures(G, r, dt) {
  const R = G.raft, P = G.player;
  const canAct = !G.demo && G.mode === 'play' && !r.seq;
  const W = G.weather || {};
  const rain = clamp(W.rain || 0, 0, 1);
  let lampLit = false;
  r.lampPos = null; r.grillPos = null;
  const t = G.time || 0;

  for (let i = 0; i < R.tiles.length; i++) {
    const s = R.tiles[i].s;
    if (!s) continue;
    const f = frameOf(G, r, i);
    const at = (lx, ly) => toWorld(f, lx, ly);

    if (s.type === 'anchor') {
      if (canAct) {
        const p = at(-4, -10);
        if (R.beached != null) addInteract(G, p.x, p.y, 24, '绕过小岛继续漂流', (g) => startAround(g), 2);
        else {
          addInteract(G, p.x, p.y, 22, R.anchored ? '起锚' : '抛锚', (g) => {
            const RR = g.raft;
            RR.anchored = !RR.anchored;
            s.down = RR.anchored;
            play('anchor');
            const q = at(-14, 0);
            if (RR.anchored) {
              for (let k = 0; k < 12; k++) emit(g, { x: q.x + rand(-3, 3), y: wy(g, q.x) - 1, vx: rand(-40, 40), vy: rand(-100, -30), life: rand(0.4, 0.9), size: rand(0.8, 1.8), gravity: 300, color: [220, 232, 240], alpha: 0.8 });
              for (let k = 0; k < 6; k++) emit(g, { x: q.x + rand(-2, 2), y: wy(g, q.x) + rand(4, 16), vy: rand(-12, -4), life: rand(0.8, 1.6), size: rand(0.8, 1.6), kind: 'bubble', color: [200, 230, 240], water: 'below' });
            }
          });
        }
      }
    } else if (s.type === 'purifier') {
      const day = smoothstep(0.25, 0.85, G.light || 0);
      const rate = (Math.max(day, rain * 0.85) / WATER_TIME) * (1 + 2 * smoothstep(0.15, 0.6, rain));
      if (s.water < WATER_MAX) {
        s.prog += rate * dt;
        if (s.prog >= 1) { s.prog = 0; s.water = Math.min(WATER_MAX, s.water + 1); if (canAct) play('water', { volume: 0.35 }); }
      } else s.prog = 0;
      if (canAct) {
        const p = at(0, -11);
        if (s.water > 0) {
          const thirsty = P && Number.isFinite(P.thirst) && P.thirst <= 75;
          if (thirsty) {
            addInteract(G, p.x, p.y, 21, '喝水', (g) => {
              if (s.water <= 0) return;
              s.water--;
              g.player.thirst = statClamp((g.player.thirst || 0) + 40);
              play('drink');
              say(g, '喝到了干净的淡水。');
            });
          } else {
            addInteract(G, p.x, p.y, 21, '装水', (g) => {
              if (s.water <= 0) return;
              s.water--;
              give(g, 'water', 1);
              play('water');
            });
          }
        } else {
          addInteract(G, p.x, p.y, 16, '净水中', (g) => {
            say(g, '还没有接到水。白天晒一晒，下雨的时候会快很多。');
          }, -1);
        }
      }
    } else if (s.type === 'grill') {
      if (s.state === 'cook') {
        s.t += dt;
        if (s.t >= COOK_TIME) { s.state = 'done'; s.t = 0; if (canAct) { play('grill', { volume: 0.6 }); say(G, '鱼烤好了，闻起来真香。'); } }
      } else if (s.state === 'done') s.t += dt;
      const burning = s.state === 'cook';
      const embers = s.state === 'done' ? 1 - smoothstep(10, 50, s.t) : 0;
      const fl = 0.86 + 0.1 * noise1(t * 7.3 + i, 5) + 0.04 * Math.sin(t * 23 + i);
      const c = at(0, -14);
      if (burning) {
        r.grillPos = c;
        addLight(G, c.x, c.y, 112 * fl, [255, 150, 78], 0.92);
        if (Math.random() < dt * 9) emit(G, { x: c.x + rand(-4, 4), y: c.y - 2, vx: rand(-4, 4) + (W.wind || 0.3) * 10, vy: rand(-26, -16), life: rand(1.6, 2.8), size: rand(1.5, 2.6), grow: 2.2, drag: 0.4, color: [140, 132, 128], alpha: 0.28 });
        if (Math.random() < dt * 5) emit(G, { x: c.x + rand(-4, 4), y: c.y, vx: rand(-10, 10), vy: rand(-48, -22), life: rand(0.5, 1.2), size: rand(0.5, 0.9), kind: 'glow', color: [255, 170, 80], alpha: 0.9 });
      } else if (embers > 0.02) {
        addLight(G, c.x, c.y + 1, 52 * embers * fl, [255, 120, 60], 0.6 * embers);
        if (Math.random() < dt * 2.5 * embers) emit(G, { x: c.x + rand(-3, 3), y: c.y - 1, vx: rand(-3, 3), vy: rand(-18, -10), life: rand(1.5, 2.4), size: rand(1.2, 2), grow: 1.8, drag: 0.4, color: [130, 124, 120], alpha: 0.18 });
      }
      if (canAct) {
        const p = at(0, -11);
        if (s.state === 'idle' && have(G, 'raw_fish') > 0) {
          addInteract(G, p.x, p.y, 21, '烤鱼', (g) => {
            if (s.state !== 'idle') return;
            if (have(g, 'raw_fish') < 1) return;
            if (have(g, 'wood') < 1) { say(g, '还需要一块木板当柴火。'); return; }
            if (!pay(g, { raw_fish: 1, wood: 1 })) return;
            s.state = 'cook'; s.t = 0;
            play('grill');
          });
        } else if (s.state === 'done') {
          addInteract(G, p.x, p.y, 21, '取烤鱼', (g) => {
            if (s.state !== 'done') return;
            give(g, 'cooked_fish', 1);
            s.state = 'idle'; s.t = 0;
            play('pickup');
          }, 1);
        }
      }
    } else if (s.type === 'sail') {
      if (canAct) {
        const p = at(-2, -14);
        addInteract(G, p.x, p.y, 22, R.sailUp ? '收帆' : '升帆', (g) => {
          g.raft.sailUp = !g.raft.sailUp;
          s.up = g.raft.sailUp;
          play('sail');
        });
      }
    } else if (s.type === 'lamp') {
      if (s.on) {
        lampLit = true;
        const L = lanternLocal(G, i, f.a);
        const c = at(L.x, L.y);
        r.lampPos = c;
        const fl = 0.92 + 0.06 * noise1(t * 6.1 + i * 3, 9) + 0.02 * Math.sin(t * 29);
        addLight(G, c.x, c.y, 220 * fl, [255, 196, 120], 0.96);
      }
      if (canAct) {
        const p = at(0, -14);
        addInteract(G, p.x, p.y, 22, s.on ? '熄灯' : '点灯', (g) => {
          s.on = !s.on;
          play('lantern');
        });
      }
    } else if (s.type === 'bed') {
      if (canAct) {
        const p = at(0, -12);
        addInteract(G, p.x, p.y, 23, '睡觉', (g) => startSleep(g));
      }
    }
  }
  R.lampLit = lampLit;
  // where the lit lamp's flame hangs (the frontmost one if there are several): islands.js lets
  // the night beast fear it like a lantern
  R.lampPos = r.lampPos ? { x: r.lampPos.x, y: r.lampPos.y } : null;
}

// ------------------------------------------------------------------ cutscenes (fades)
const NOT_ABOARD = '得先回到木筏上，才能带着它离开。';

function startAround(G) {
  const R = G.raft, r = rt(G);
  if (r.seq) return;
  if (!boyOnRaft(G)) { say(G, NOT_ABOARD); return; }
  const fx = R.x + R.tiles.length * TW;
  const isl = isleAt(G, fx + 2.5) || isleAt(G, fx + 8) || isleAt(G, fx);
  const goal = isl && ((typeof isl.kind === 'string' && /light|goal|end|灯塔/i.test(isl.kind)) ||
    (Number.isFinite(isl.x0) && Number.isFinite(isl.x1) && isl.x0 <= C.GOAL_X + 50 && isl.x1 >= C.GOAL_X - 50));
  if (goal) { say(G, '灯塔就在眼前了，不用再绕路。'); return; }
  r.seq = { kind: 'around', t: 0, t2: 0, moved: false, isl };
  R.busy = true;
  play('sail');
}

// The screen is black: move the raft past the island. Returns false (nothing moved) when the
// boy is no longer aboard — the raft never leaves without him.
function doAround(G, r) {
  if (!boyOnRaft(G)) { say(G, NOT_ABOARD); return false; }
  const R = G.raft, P = G.player, n = R.tiles.length, len = n * TW;
  const fx = R.x + len;
  const isl = r.seq.isl || isleAt(G, fx + 2.5) || isleAt(G, fx);
  let target = isl && Number.isFinite(isl.x1) ? isl.x1 + 30 : R.x + len + 160;
  // make sure the new spot is open, deep enough water
  for (let k = 0; k < 40; k++) {
    let ok = true;
    for (let x = target - 6; x <= target + len + 8; x += 6) {
      const g = isleGround(G, x);
      if (g != null && g < 16) { ok = false; break; }
    }
    if (ok) break;
    target += 30;
  }
  const carry = boyOnRaft(G);
  const dx = target - R.x;
  R.x += dx;
  R.anchored = false;
  const anc = findStruct(R, 'anchor');
  if (anc) anc.s.down = false;
  R.beached = null; R.aground = false;
  snapDeck(G, r);
  if (carry && P) {
    P.x += dx;
    const d = deckAt(G, P.x);
    if (d != null) P.y = d;
    P.vx = 0; P.vy = 0;
    if (G.cam && Number.isFinite(G.cam.x)) G.cam.x += dx;
  }
  say(G, '绕过了小岛，木筏又漂回了大海上。');
  return true;
}

function startSleep(G) {
  const r = rt(G);
  if (r.seq) return;
  if (G.phase >= C.NIGHT_END) { say(G, '天快亮了，不睡了。'); return; }
  if (G.phase < SLEEP_FROM) { say(G, G.phase >= C.SUNSET ? '再等等，天才刚黑。' : '还不困。'); return; }
  if (!boyOnRaft(G)) { say(G, '得先爬上木筏才能睡觉。'); return; }
  r.seq = { kind: 'sleep', t: 0, done: false, slept: false };
  G.raft.busy = true;
  play('sleep');
}

function doSleep(G) {
  const P = G.player, R = G.raft;
  try { skipToPhase(G, 0.01); } catch (e) { oops('skipToPhase', e); }
  if (P) {
    P.hunger = statClamp((P.hunger || 0) - SLEEP_COST);
    P.thirst = statClamp((P.thirst || 0) - SLEEP_COST);
  }
  // the night passes for the raft too
  for (const t of R.tiles) {
    const s = t.s;
    if (!s) continue;
    if (s.type === 'grill' && s.state === 'cook') { s.state = 'done'; s.t = 60; }
    if (s.type === 'grill' && s.state === 'done') s.t = Math.max(s.t, 60);
  }
  journal(G, DREAMS[(G.day + (G.journal ? G.journal.length : 0)) % DREAMS.length]);
}

function updateSeq(G, r, dt) {
  const q = r.seq;
  if (!q) return;
  q.t += dt;
  if (q.kind === 'around') {
    if (!q.moved) {
      G.fade = Math.max(G.fade || 0, smoothstep(0, 0.8, q.t));
      if (q.t >= 0.85) { G.fade = 1; doAround(G, r); q.moved = true; q.t2 = 0; }   // (or cancelled: fade back in)
    } else {
      q.t2 += dt;
      G.fade = 1 - smoothstep(0.35, 1.35, q.t2);
      if (q.t2 >= 1.35) { G.fade = 0; r.seq = null; }
    }
  } else if (q.kind === 'sleep') {
    if (q.t < 1.4) G.fade = Math.max(G.fade || 0, smoothstep(0, 1.3, q.t));
    else if (!q.done) {
      G.fade = 1; q.done = true;
      // he slipped off the raft while the screen went dark (a hop, a wave): no sleep in the sea
      if (boyOnRaft(G)) { doSleep(G); q.slept = true; } else { say(G, '得先爬上木筏才能睡觉。'); q.t = 2.6; }
    } else {
      G.fade = 1 - smoothstep(2.6, 4.2, q.t);
      if (q.t >= 4.2) { G.fade = 0; r.seq = null; if (q.slept) say(G, '天亮了。'); }
    }
  } else r.seq = null;
}

// ------------------------------------------------------------------ build mode
function buildOptions(G) {
  const R = G.raft;
  const opts = ['tile'];
  for (const id of PLACEABLES) if (have(G, id) > 0 && !(UNIQUE[id] && findStruct(R, id))) opts.push(id);
  return opts;
}

function buildMode(G, r) {
  const P = G.player, R = G.raft;
  const on = !G.demo && G.mode === 'play' && P && P.tool === 'hammer' && !r.seq && !P.dead && !(P.hp <= 0);
  if (!on) { r.build = null; r.wasBuilding = false; return; }
  const opts = buildOptions(G);
  if (!r.wasBuilding && r.sel === 'tile' && opts.length > 1) r.sel = opts[1];   // just crafted something: place it
  if (!opts.includes(r.sel)) r.sel = 'tile';
  r.wasBuilding = true;
  if (input.cyclePressed && opts.length > 1) {
    r.sel = opts[(opts.indexOf(r.sel) + 1) % opts.length];
    r.selT = 0;
    play('ui');
  }
  r.selT += G.dt || 0.016;

  const n = R.tiles.length, len = n * TW;
  const slots = [];
  const sel = r.sel;
  if (sel === 'tile') {
    for (const side of [-1, 1]) {
      const x = side < 0 ? R.x - TW / 2 : R.x + len + TW / 2;
      const y = side < 0 ? r.ys[0] - Math.tan(r.as[0]) * TW : r.ys[n - 1] + Math.tan(r.as[n - 1]) * TW;
      let reason = null;
      if (n >= MAX_TILES) reason = '木筏已经够大了';
      else {
        for (let k = -TW / 2 - 2; k <= TW / 2 + 2; k += 4) {
          const g = isleGround(G, x + k);
          if (g != null && g < 10) { reason = '这边被小岛挡住了'; break; }
        }
      }
      slots.push({ kind: 'tile', side, x, y, a: side < 0 ? r.as[0] : r.as[n - 1], reason });
    }
  } else {
    for (let i = 0; i < n; i++) if (!R.tiles[i].s) slots.push({ kind: 'place', i, type: sel, x: R.x + (i + 0.5) * TW, y: r.ys[i], a: r.as[i] });
  }
  for (let i = 0; i < n; i++) {
    if (R.tiles[i].hp < 100) slots.push({ kind: 'repair', i, x: R.x + (i + 0.5) * TW, y: r.ys[i], a: r.as[i] });
  }

  let ax, ay;
  if (input.aimFromPointer && Number.isFinite(input.mouse.wx)) { ax = input.mouse.wx; ay = input.mouse.wy; }
  else { ax = P.x + (P.facing || 1) * 16; ay = P.y - 6; }
  let best = null, bd = Infinity;
  for (const s of slots) {
    const sy = s.kind === 'repair' ? s.y + 3 : s.kind === 'place' ? s.y - 12 : s.y - 4;
    let d = Math.hypot(s.x - ax, (sy - ay) * 0.7);
    if (s.kind === 'repair' && sel !== 'tile') d += 6;
    if (d < bd) { bd = d; best = s; }
  }
  if (best) best.far = Math.abs(best.x - P.x) > REACH_X + TW / 2 || Math.abs(best.y - P.y) > REACH_Y;
  r.build = { sel, opts, slots, target: best, noRoom: sel !== 'tile' && !slots.some((s) => s.kind === 'place') };

  if (input.usePressed) {
    if (!best) {
      if (r.build.noRoom) say(G, '木筏上没有空位了，先扩建木筏吧。');
      return;
    }
    doBuild(G, r, best);
  }
}

function doBuild(G, r, t) {
  const R = G.raft;
  if (t.far) { say(G, '离得太远了。'); return; }
  if (t.reason) { say(G, t.reason + '。'); return; }
  if (t.kind === 'tile') {
    if (!canPay(G, TILE_COST)) { say(G, '需要 ' + costText(TILE_COST) + '。'); return; }
    if (!pay(G, TILE_COST)) return;
    const tile = { hp: 100, s: null, v: newSeed() };
    const y = t.y;
    if (t.side < 0) {
      R.tiles.unshift(tile); R.x -= TW;
      r.ys.unshift(y); r.vs.unshift(6); r.as.unshift(r.as[0] || 0);
    } else {
      R.tiles.push(tile);
      r.ys.push(y); r.vs.push(6); r.as.push(r.as[r.as.length - 1] || 0);
    }
    r.lastX = R.x;
    buildFx(G, t.x, y, true);
  } else if (t.kind === 'place') {
    const tile = R.tiles[t.i];
    if (!tile || tile.s) return;
    if (UNIQUE[t.type] && findStruct(R, t.type)) { say(G, '已经有一个' + itemName(t.type) + '了。'); return; }
    if (!pay(G, { [t.type]: 1 })) { say(G, '没有' + itemName(t.type) + '了。'); return; }
    tile.s = newStruct(t.type);
    if (t.type === 'sail') { R.sailUp = false; say(G, hint('船帆装好了。按 E 升帆，木筏会漂得更快。', '船帆装好了。点「互动」升帆，木筏会漂得更快。')); }
    else if (t.type === 'purifier') say(G, '净水器装好了，太阳会把海水晒成淡水。');
    else if (t.type === 'grill') say(G, '烤架搭好了。有生鱼和木板就能烤鱼。');
    else if (t.type === 'lamp') say(G, '灯柱立起来了。夜里，光会让那些东西离远一点。');
    else if (t.type === 'bed') say(G, '吊床挂好了。天黑以后可以在这里睡一觉。');
    buildFx(G, t.x, t.y, false);
    const before = r.build ? r.build.opts.indexOf(r.sel) : 0;
    const opts = buildOptions(G);
    if (!opts.includes(r.sel)) r.sel = opts[clamp(before, 0, opts.length - 1)] || 'tile';
  } else if (t.kind === 'repair') {
    const tile = R.tiles[t.i];
    if (!tile) return;
    if (!canPay(G, REPAIR_COST)) { say(G, '需要一块木板来修补。'); return; }
    if (!pay(G, REPAIR_COST)) return;
    tile.hp = 100;
    play('hammer');
    for (let k = 0; k < 8; k++) emit(G, { x: t.x + rand(-9, 9), y: t.y + rand(-1, 2), vx: rand(-30, 30), vy: rand(-60, -15), life: rand(0.4, 0.9), size: rand(0.6, 1.2), gravity: 260, color: [196, 160, 110], alpha: 0.9 });
  }
}

function buildFx(G, x, y, splash) {
  play('hammer');
  play('build');
  G.shake = (G.shake || 0) + 0.08;
  for (let k = 0; k < 12; k++) emit(G, { x: x + rand(-10, 10), y: y + rand(-3, 1), vx: rand(-35, 35), vy: rand(-70, -15), life: rand(0.5, 1.1), size: rand(0.6, 1.4), gravity: 240, color: pick([[196, 160, 110], [150, 116, 78], [230, 214, 180]]), alpha: 0.9 });
  if (splash) for (let k = 0; k < 10; k++) emit(G, { x: x + rand(-10, 10), y: wy(G, x) - 1, vx: rand(-30, 30), vy: rand(-80, -20), life: rand(0.4, 0.8), size: rand(0.8, 1.6), gravity: 300, color: [220, 232, 240], alpha: 0.8 });
}

function costText(cost) {
  return Object.keys(cost).map((k) => itemName(k) + '×' + cost[k]).join(' ');
}

// =====================================================================================
// art: hand-painted sprites, cached once
// =====================================================================================

let ART = null;

function sprite(x0, y0, w, h, fn) {
  const c = makeCanvas(Math.ceil(w * SPR), Math.ceil(h * SPR));
  const g = c.getContext('2d');
  g.scale(SPR, SPR);
  g.translate(-x0, -y0);
  g.lineCap = 'round'; g.lineJoin = 'round';
  fn(g);
  return { c, x0, y0, w, h };
}
function blit(g, sp, x = 0, y = 0) { g.drawImage(sp.c, x + sp.x0, y + sp.y0, sp.w, sp.h); }

const hex = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const css = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const shade = (c, k) => (k < 0 ? mixColor(c, [18, 12, 9], -k) : mixColor(c, [255, 238, 205], k));

// a tapered, slightly crooked stick from (x0,y0) to (x1,y1)
function stick(g, r, x0, y0, x1, y1, w0, w1, col, segs = 6, bend = 0.5) {
  const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1;
  const nx = -dy / L, ny = dx / L;
  const L1 = [], L2 = [];
  let off = 0;
  for (let k = 0; k <= segs; k++) {
    const u = k / segs;
    if (k > 0 && k < segs) off += (r() - 0.5) * bend;
    const w = lerp(w0, w1, u) / 2 * (0.9 + r() * 0.2);
    const cx = x0 + dx * u + nx * off, cy = y0 + dy * u + ny * off;
    L1.push([cx + nx * w, cy + ny * w]); L2.push([cx - nx * w, cy - ny * w]);
  }
  g.beginPath();
  g.moveTo(L1[0][0], L1[0][1]);
  for (const p of L1) g.lineTo(p[0], p[1]);
  for (let k = L2.length - 1; k >= 0; k--) g.lineTo(L2[k][0], L2[k][1]);
  g.closePath();
  g.fillStyle = css(col); g.fill();
  // shaded side + lit side
  g.lineWidth = Math.max(0.25, w0 * 0.22);
  g.strokeStyle = css(shade(col, -0.45), 0.8);
  g.beginPath(); g.moveTo(L2[0][0], L2[0][1]); for (const p of L2) g.lineTo(p[0], p[1]); g.stroke();
  g.strokeStyle = css(shade(col, 0.35), 0.55);
  g.lineWidth = Math.max(0.18, w0 * 0.14);
  g.beginPath(); g.moveTo(L1[0][0], L1[0][1]); for (const p of L1) g.lineTo(p[0], p[1]); g.stroke();
  // bark nicks
  g.strokeStyle = css(shade(col, -0.55), 0.55);
  g.lineWidth = 0.18;
  for (let k = 0; k < L / 5; k++) {
    const u = r(), cx = x0 + dx * u, cy = y0 + dy * u, w = lerp(w0, w1, u) * 0.35;
    g.beginPath(); g.moveTo(cx + nx * w * (r() - 0.5), cy + ny * w * (r() - 0.5)); g.lineTo(cx + dx / L * (0.6 + r()) + nx * w * 0.3, cy + dy / L * (0.6 + r()) + ny * w * 0.3); g.stroke();
  }
}

// a few turns of rope around a point
function wrap(g, x, y, w, h, turns = 3, slant = 0.6) {
  for (let k = 0; k < turns; k++) {
    const yy = y - h / 2 + (k + 0.5) * (h / turns);
    g.strokeStyle = '#5d4529'; g.lineWidth = h / turns * 1.15;
    g.beginPath(); g.moveTo(x - w / 2, yy + slant * 0.5); g.lineTo(x + w / 2, yy - slant * 0.5); g.stroke();
    g.strokeStyle = '#b9955e'; g.lineWidth = h / turns * 0.75;
    g.beginPath(); g.moveTo(x - w / 2, yy + slant * 0.5); g.lineTo(x + w / 2, yy - slant * 0.5); g.stroke();
    g.strokeStyle = 'rgba(255,236,190,0.45)'; g.lineWidth = h / turns * 0.22;
    g.beginPath(); g.moveTo(x - w / 2 + 0.2, yy + slant * 0.5 - h / turns * 0.18); g.lineTo(x + w / 2 - 0.2, yy - slant * 0.5 - h / turns * 0.18); g.stroke();
  }
}

function roundRect(g, x, y, w, h, rr) {
  g.beginPath();
  g.moveTo(x + rr, y);
  g.lineTo(x + w - rr, y); g.quadraticCurveTo(x + w, y, x + w, y + rr);
  g.lineTo(x + w, y + h - rr); g.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  g.lineTo(x + rr, y + h); g.quadraticCurveTo(x, y + h, x, y + h - rr);
  g.lineTo(x, y + rr); g.quadraticCurveTo(x, y, x + rr, y);
  g.closePath();
}

const BOARD = ['#7b5a3a', '#6b4a2e', '#866548', '#5e4630', '#8b7a64', '#74583d', '#7f6a52'].map(hex);
const PAINT = ['#8e3b2e', '#4f6b4a', '#56697a', '#9a7b3a'].map(hex);

// ------------------------------------------------------------------ the tile
function paintTile(g, seed) {
  const r = seeded(seed * 7919 + 13);
  const kind = r();
  // floats wedged under the log (salvage)
  if (kind < 0.26) paintDrum(g, r, 2 + r() * 2, 21 - r() * 2.5);
  else if (kind < 0.46) paintBottles(g, r);
  else if (kind < 0.6) paintFoam(g, r);

  // the stringer log
  paintLog(g, r, -0.8, TW + 0.8, 6.9, 4.6);

  // a cross log running into the picture: its sawn end shows under the boards
  if (r() < 0.45) logEnd(g, r, 5 + r() * 14, 4.9, 2.3 + r() * 0.5);

  // shadow of the boards on the log
  g.fillStyle = 'rgba(12,8,5,0.55)';
  g.beginPath(); g.moveTo(-0.6, 2.2); g.lineTo(TW + 0.6, 2.2); g.lineTo(TW + 0.6, 4.4); g.bezierCurveTo(16, 3.4, 8, 4.6, -0.6, 3.8); g.closePath(); g.fill();

  paintBoards(g, r);

  // odd bits of salvage nailed or tied on
  const ex = r();
  if (ex < 0.3) batten(g, r);
  else if (ex < 0.42) tire(g, r);

  // one lashing at the joint with the neighbour, sometimes one more
  lashing(g, r, 0.7);
  if (r() < 0.3) lashing(g, r, 9 + r() * 7);

  // waterline salt crust
  g.strokeStyle = 'rgba(226,222,200,0.3)';
  g.lineWidth = 0.45;
  g.beginPath();
  for (let x = -0.6; x <= TW + 0.6; x += 1.2) { const y = 5.5 + Math.sin(x * 1.3 + seed) * 0.25 + (r() - 0.5) * 0.2; if (x < 0) g.moveTo(x, y); else g.lineTo(x, y); }
  g.stroke();
}

function logEnd(g, r, x, y, rad) {
  g.fillStyle = '#2e2017';
  g.beginPath(); g.ellipse(x, y, rad + 0.35, rad + 0.25, 0, 0, TAU); g.fill();
  const eg = g.createRadialGradient(x - rad * 0.3, y - rad * 0.3, 0, x, y, rad);
  eg.addColorStop(0, '#b38c62'); eg.addColorStop(0.7, '#8b6844'); eg.addColorStop(1, '#5d4329');
  g.fillStyle = eg;
  g.beginPath(); g.ellipse(x, y, rad, rad * 0.95, 0, 0, TAU); g.fill();
  g.strokeStyle = 'rgba(60,38,20,0.5)'; g.lineWidth = 0.13;
  for (let k = 1; k <= 3; k++) { g.beginPath(); g.ellipse(x + 0.15, y + 0.1, rad * k / 3.6, rad * k / 3.8, 0, 0, TAU); g.stroke(); }
  g.strokeStyle = 'rgba(20,12,6,0.6)'; g.lineWidth = 0.16;
  g.beginPath(); g.moveTo(x, y); g.lineTo(x + rad * 0.8, y - rad * 0.5); g.stroke();
}

// a weathered plank nailed across the board ends
function batten(g, r) {
  const xa = 1.2 + r() * 2, xb = TW - 1 - r() * 2, y0 = 0.5 + r() * 0.3, h = 1.6 + r() * 0.4;
  const col = mixColor(hex('#8b7c68'), hex('#6e5a44'), r());
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.fillRect(xa + 0.3, y0 + 0.4, xb - xa, h);
  g.fillStyle = css(col);
  g.beginPath(); g.moveTo(xa, y0 + 0.2); g.lineTo(xb, y0); g.lineTo(xb + 0.2, y0 + h * 0.6); g.lineTo(xb - 0.3, y0 + h); g.lineTo(xa + 0.2, y0 + h + 0.1); g.closePath(); g.fill();
  g.strokeStyle = css(shade(col, 0.4), 0.45); g.lineWidth = 0.2;
  g.beginPath(); g.moveTo(xa + 0.2, y0 + 0.3); g.lineTo(xb - 0.2, y0 + 0.1); g.stroke();
  g.strokeStyle = css(shade(col, -0.4), 0.5); g.lineWidth = 0.12;
  for (let k = 0; k < 3; k++) { const y = y0 + 0.5 + r() * (h - 0.8); g.beginPath(); g.moveTo(xa + r() * 4, y); g.lineTo(xb - r() * 4, y + (r() - 0.5) * 0.2); g.stroke(); }
  g.fillStyle = '#231c17';
  for (const x of [xa + 1, (xa + xb) / 2 + (r() - 0.5) * 3, xb - 1]) { g.beginPath(); g.arc(x, y0 + h / 2, 0.24, 0, TAU); g.fill(); }
  g.fillStyle = 'rgba(160,80,40,0.45)';
  g.beginPath(); g.ellipse(xa + 1.1, y0 + h / 2 + 0.5, 0.3, 0.55, 0, 0, TAU); g.fill();
}

// an old tyre hung over the side as a fender
function tire(g, r) {
  const x = 6 + r() * 12, y = 6.6;
  g.strokeStyle = '#4c3720'; g.lineWidth = 0.5;
  g.beginPath(); g.moveTo(x - 1.2, -0.4); g.lineTo(x - 0.6, y - 2.6); g.moveTo(x + 1.2, -0.4); g.lineTo(x + 0.6, y - 2.6); g.stroke();
  g.fillStyle = '#1c1a19';
  g.beginPath(); g.ellipse(x, y, 3.6, 3.3, 0, 0, TAU); g.ellipse(x, y, 1.8, 1.6, 0, 0, TAU); g.fill('evenodd');
  g.strokeStyle = 'rgba(140,135,125,0.45)'; g.lineWidth = 0.3;
  g.beginPath(); g.ellipse(x, y, 3.2, 2.9, 0, Math.PI * 1.1, Math.PI * 1.85); g.stroke();
  g.strokeStyle = 'rgba(90,88,82,0.5)'; g.lineWidth = 0.18;
  for (let k = 0; k < 9; k++) { const a = Math.PI * (1.05 + k * 0.1); g.beginPath(); g.moveTo(x + Math.cos(a) * 2.2, y + Math.sin(a) * 2.0); g.lineTo(x + Math.cos(a) * 3.4, y + Math.sin(a) * 3.1); g.stroke(); }
  g.strokeStyle = '#b8945d'; g.lineWidth = 0.45;
  g.beginPath(); g.moveTo(x - 1.2, -0.4); g.lineTo(x - 0.6, y - 2.6); g.moveTo(x + 1.2, -0.4); g.lineTo(x + 0.6, y - 2.6); g.stroke();
}

function paintLog(g, r, xa, xb, cy, rad) {
  const top = [], bot = [];
  for (let x = xa; x <= xb + 0.01; x += 1.5) {
    top.push([x, cy - rad + (r() - 0.5) * 0.35]);
    bot.push([x, cy + rad + (r() - 0.5) * 0.45]);
  }
  const path = () => {
    g.beginPath();
    g.moveTo(top[0][0], top[0][1]);
    for (const p of top) g.lineTo(p[0], p[1]);
    for (let k = bot.length - 1; k >= 0; k--) g.lineTo(bot[k][0], bot[k][1]);
    g.closePath();
  };
  const base = mixColor(hex('#6a4c31'), hex('#5a4a3c'), r() * 0.6);
  const gr = g.createLinearGradient(0, cy - rad, 0, cy + rad);
  gr.addColorStop(0, css(shade(base, 0.32)));
  gr.addColorStop(0.22, css(base));
  gr.addColorStop(0.55, css(shade(base, -0.35)));
  gr.addColorStop(1, css(shade(base, -0.72)));
  path(); g.fillStyle = gr; g.fill();
  g.save(); path(); g.clip();
  // bark streaks
  for (let k = 0; k < 18; k++) {
    const y = cy - rad + r() * rad * 2, x = xa + r() * (xb - xa), l = 2 + r() * 7;
    g.strokeStyle = r() < 0.7 ? 'rgba(25,16,10,0.45)' : 'rgba(210,180,140,0.16)';
    g.lineWidth = 0.18 + r() * 0.3;
    g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + l / 2, y + (r() - 0.5) * 0.6, x + l, y + (r() - 0.5) * 0.5); g.stroke();
  }
  // a knot
  if (r() < 0.6) {
    const kx = xa + 3 + r() * (xb - xa - 6), ky = cy - rad * 0.35 + r() * rad * 0.4;
    g.fillStyle = 'rgba(30,20,12,0.75)'; g.beginPath(); g.ellipse(kx, ky, 1.25, 0.8, 0, 0, TAU); g.fill();
    g.strokeStyle = 'rgba(160,125,90,0.5)'; g.lineWidth = 0.22; g.beginPath(); g.ellipse(kx, ky, 0.7, 0.42, 0, 0, TAU); g.stroke();
    g.strokeStyle = 'rgba(25,16,10,0.4)'; g.lineWidth = 0.2;
    g.beginPath(); g.ellipse(kx, ky, 2.0, 1.1, 0, Math.PI * 1.1, Math.PI * 1.9); g.stroke();
  }
  // wet, slimy lower half
  const wg = g.createLinearGradient(0, cy - 1.2, 0, cy + rad);
  wg.addColorStop(0, 'rgba(28,52,40,0)');
  wg.addColorStop(0.35, 'rgba(28,54,40,0.38)');
  wg.addColorStop(1, 'rgba(14,30,24,0.7)');
  g.fillStyle = wg; g.fillRect(xa - 1, cy - 1.2, xb - xa + 2, rad + 2);
  g.restore();
  // top highlight
  g.strokeStyle = 'rgba(235,205,160,0.32)'; g.lineWidth = 0.35;
  g.beginPath(); g.moveTo(top[0][0], top[0][1] + 0.4); for (const p of top) g.lineTo(p[0], p[1] + 0.4); g.stroke();
  // barnacles + mussels along the bottom
  const nb = 6 + Math.floor(r() * 9);
  for (let k = 0; k < nb; k++) {
    const x = xa + 0.8 + r() * (xb - xa - 1.6), y = cy + rad * (0.35 + r() * 0.55), s = 0.4 + r() * 0.55;
    if (r() < 0.3) {
      g.fillStyle = '#1c2230'; g.beginPath(); g.ellipse(x, y, s * 1.5, s * 0.75, r() * 0.8 - 0.4, 0, TAU); g.fill();
      g.strokeStyle = 'rgba(120,140,170,0.35)'; g.lineWidth = 0.15; g.stroke();
    } else {
      g.fillStyle = '#8d887b'; g.beginPath(); g.ellipse(x, y, s, s * 0.85, 0, 0, TAU); g.fill();
      g.fillStyle = '#c9c3b2'; g.beginPath(); g.ellipse(x - s * 0.2, y - s * 0.25, s * 0.55, s * 0.45, 0, 0, TAU); g.fill();
      g.fillStyle = '#2b2925'; g.beginPath(); g.ellipse(x, y - s * 0.1, s * 0.28, s * 0.2, 0, 0, TAU); g.fill();
    }
  }
  // weed hair under the log
  g.lineWidth = 0.32;
  for (let k = 0; k < 16; k++) {
    const x = xa + r() * (xb - xa), y = cy + rad - 0.3, l = 0.8 + r() * 2.2;
    g.strokeStyle = r() < 0.5 ? 'rgba(46,78,46,0.85)' : 'rgba(70,84,40,0.75)';
    g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + (r() - 0.5) * 1.2, y + l * 0.6, x + (r() - 0.5) * 1.6, y + l); g.stroke();
  }
}

function paintDrum(g, r, xa, xb) {
  const y0 = 7.6, y1 = 16.6;
  const col = r() < 0.6 ? hex('#2f6390') : hex('#2f6e5c');
  const gr = g.createLinearGradient(0, y0, 0, y1);
  gr.addColorStop(0, css(shade(col, 0.25)));
  gr.addColorStop(0.4, css(col));
  gr.addColorStop(1, css(shade(col, -0.65)));
  roundRect(g, xa, y0, xb - xa, y1 - y0, 2.4);
  g.fillStyle = gr; g.fill();
  // ridges
  for (const u of [0.3, 0.7]) {
    const x = lerp(xa, xb, u);
    g.fillStyle = css(shade(col, -0.35), 0.6); g.fillRect(x - 0.5, y0 + 0.3, 1, y1 - y0 - 0.6);
    g.fillStyle = css(shade(col, 0.3), 0.5); g.fillRect(x - 0.9, y0 + 0.3, 0.35, y1 - y0 - 0.6);
  }
  // faded label + scratches
  g.fillStyle = 'rgba(230,220,190,0.22)'; g.fillRect(lerp(xa, xb, 0.4), y0 + 2, (xb - xa) * 0.18, 3.5);
  g.strokeStyle = 'rgba(220,235,245,0.25)'; g.lineWidth = 0.15;
  for (let k = 0; k < 5; k++) { const x = xa + r() * (xb - xa), y = y0 + 1 + r() * 4; g.beginPath(); g.moveTo(x, y); g.lineTo(x + 1 + r() * 2, y + (r() - 0.5)); g.stroke(); }
  // bung
  g.fillStyle = css(shade(col, -0.5)); g.beginPath(); g.arc(xb - 1.6, y0 + 2.2, 0.55, 0, TAU); g.fill();
}

function paintBottles(g, r) {
  const nb = 4 + Math.floor(r() * 3);
  for (let k = 0; k < nb; k++) {
    const x = 1 + r() * 15, y = 9 + r() * 4.6, l = 5.5 + r() * 2.5, h = 2.1 + r() * 0.8;
    const tint = pick([[205, 228, 232], [190, 220, 200], [215, 215, 225], [170, 205, 225]]);
    roundRect(g, x, y, l, h, h * 0.45);
    g.fillStyle = css(tint, 0.5); g.fill();
    g.strokeStyle = css(shade(tint, 0.3), 0.6); g.lineWidth = 0.18; g.stroke();
    g.fillStyle = css(shade(tint, 0.5), 0.5); g.fillRect(x + 0.8, y + 0.35, l - 1.8, 0.3);
    // neck + cap
    const capc = pick([[47, 111, 176], [184, 53, 43], [235, 235, 225], [60, 140, 90]]);
    g.fillStyle = css(tint, 0.5); g.fillRect(x + l - 0.2, y + h * 0.3, 1.0, h * 0.4);
    g.fillStyle = css(capc); g.fillRect(x + l + 0.7, y + h * 0.22, 0.65, h * 0.56);
  }
  // fishing net holding them
  g.strokeStyle = 'rgba(70,90,80,0.7)'; g.lineWidth = 0.18;
  for (let k = 0; k < 7; k++) { const x = 1 + k * 3; g.beginPath(); g.moveTo(x, 8.4); g.lineTo(x + 3.5, 15.5); g.moveTo(x + 3.5, 8.4); g.lineTo(x, 15.5); g.stroke(); }
}

function paintFoam(g, r) {
  const xa = 2.5 + r() * 2, xb = 20 - r() * 2, y0 = 7.8, y1 = 13.8;
  g.beginPath();
  g.moveTo(xa, y0 + 0.6); g.lineTo(xa + 1.2, y0); g.lineTo(xb - 0.5, y0 + 0.2); g.lineTo(xb, y0 + 1.6);
  g.lineTo(xb - 0.3, y1 - 0.4); g.lineTo(xb - 2.4, y1); g.lineTo(xa + 0.6, y1 - 0.2); g.lineTo(xa - 0.2, y1 - 1.8);
  g.closePath();
  const gr = g.createLinearGradient(0, y0, 0, y1);
  gr.addColorStop(0, '#d6cfb8'); gr.addColorStop(0.5, '#b8b09a'); gr.addColorStop(1, '#6f6a5a');
  g.fillStyle = gr; g.fill();
  g.fillStyle = 'rgba(80,70,50,0.35)';
  for (let k = 0; k < 20; k++) { g.beginPath(); g.arc(xa + r() * (xb - xa), y0 + r() * (y1 - y0), 0.15 + r() * 0.25, 0, TAU); g.fill(); }
  g.fillStyle = 'rgba(60,80,40,0.4)'; g.fillRect(xa, y1 - 1.6, xb - xa, 1.6);
}

function paintBoards(g, r) {
  // dark gaps between the boards' top faces
  g.fillStyle = '#1b130c';
  g.beginPath(); g.moveTo(-0.4, -2.5); g.lineTo(TW + 0.4, -2.5); g.lineTo(TW + 0.4, 2.3); g.lineTo(-0.4, 2.3); g.closePath(); g.fill();
  let x = 0.15;
  while (x < TW - 1.2) {
    let w = 3.3 + r() * 2.1;
    if (x + w > TW - 0.15) w = TW - 0.15 - x;
    if (w < 1.4) break;
    const col = r() < 0.12 ? null : BOARD[Math.floor(r() * BOARD.length)];
    const paint = col == null ? PAINT[Math.floor(r() * PAINT.length)] : null;
    const base = col || mixColor(paint, BOARD[1], 0.25);
    const dy = (r() - 0.5) * 0.35;
    const L = 2.5 + r() * 1.4;
    const sk = (r() - 0.5) * 0.5;
    // top face, receding into the picture (a touch of perspective)
    const tg = g.createLinearGradient(0, -2.5, 0, 0);
    tg.addColorStop(0, css(shade(base, -0.2)));
    tg.addColorStop(1, css(shade(base, 0.28)));
    g.fillStyle = tg;
    g.beginPath(); g.moveTo(x + 0.35, -2.45 + dy); g.lineTo(x + w + 0.35, -2.45 + dy); g.lineTo(x + w, 0.05); g.lineTo(x, 0.05); g.closePath(); g.fill();
    // grain on top
    g.strokeStyle = css(shade(base, -0.45), 0.45); g.lineWidth = 0.14;
    for (let k = 0; k < 2; k++) { const gx = x + 0.6 + r() * (w - 1.2); g.beginPath(); g.moveTo(gx, -0.1); g.lineTo(gx + 0.3, -2.3 + dy); g.stroke(); }
    // nail
    if (r() < 0.45) {
      const nx = x + w * (0.3 + r() * 0.4);
      g.fillStyle = '#2a2420'; g.beginPath(); g.ellipse(nx, -1.15, 0.32, 0.2, 0, 0, TAU); g.fill();
      g.fillStyle = 'rgba(190,120,70,0.5)'; g.beginPath(); g.ellipse(nx + 0.3, -0.95, 0.35, 0.16, 0, 0, TAU); g.fill();
    }
    // front: the end grain
    const fx0 = x + sk * 0.3, fx1 = x + w + sk * 0.3;
    g.beginPath();
    g.moveTo(x, 0); g.lineTo(x + w, 0);
    g.lineTo(fx1 - 0.15, L + (r() - 0.5) * 0.5);
    g.lineTo(lerp(fx0, fx1, 0.5), L + (r() - 0.5) * 0.7);
    g.lineTo(fx0 + 0.1, L + (r() - 0.5) * 0.5);
    g.closePath();
    const end = shade(base, -0.22);
    g.fillStyle = css(end); g.fill();
    g.save(); g.clip();
    // rings
    const rx = lerp(x, x + w, 0.3 + r() * 0.4), ry = L + 0.6 + r() * 1.2;
    g.strokeStyle = css(shade(end, -0.4), 0.5); g.lineWidth = 0.16;
    for (let k = 1; k <= 4; k++) { g.beginPath(); g.arc(rx, ry, k * 0.85, 0, TAU); g.stroke(); }
    if (paint) {
      g.fillStyle = css(paint, 0.85); g.fillRect(x - 1, -0.1, w + 2, L + 1);
      g.fillStyle = css(end, 0.95);
      for (let k = 0; k < 4; k++) { g.beginPath(); g.ellipse(x + r() * w, r() * L, 0.4 + r() * 0.9, 0.3 + r() * 0.5, r() * 3, 0, TAU); g.fill(); }
    }
    // a vertical check (crack in the end grain)
    if (r() < 0.4) { g.strokeStyle = 'rgba(15,9,5,0.6)'; g.lineWidth = 0.15; const cx = x + r() * w; g.beginPath(); g.moveTo(cx, 0.2); g.lineTo(cx + (r() - 0.5) * 0.6, L * (0.4 + r() * 0.5)); g.stroke(); }
    // bottom shadow
    g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(x - 1, L - 0.7, w + 2, 1.4);
    g.restore();
    // lip highlight
    g.strokeStyle = css(shade(base, 0.38), 0.18 + r() * 0.2); g.lineWidth = 0.24;
    g.beginPath(); g.moveTo(x + 0.25 + r() * 0.4, 0.12); g.lineTo(x + w - 0.25 - r() * 0.6, 0.12); g.stroke();
    x += w + 0.22 + r() * 0.3;
  }
}

function lashing(g, r, x) {
  const top = -1.0, bot = 10.2;
  const sl = 0.5 + r() * 0.3;
  for (let k = 0; k < 2; k++) {
    const ox = (k - 0.5) * 0.95 + (r() - 0.5) * 0.15;
    g.strokeStyle = 'rgba(40,28,16,0.85)'; g.lineWidth = 0.9;
    g.beginPath(); g.moveTo(x + ox - sl, top); g.lineTo(x + ox + sl, bot); g.stroke();
    const rg = g.createLinearGradient(0, top, 0, bot);
    rg.addColorStop(0, '#a88a5e'); rg.addColorStop(0.35, '#8a6f48'); rg.addColorStop(0.65, '#5a4e36'); rg.addColorStop(1, '#3a3a2a');
    g.strokeStyle = rg; g.lineWidth = 0.58;
    g.beginPath(); g.moveTo(x + ox - sl, top); g.lineTo(x + ox + sl, bot); g.stroke();
    // twist ticks
    g.strokeStyle = 'rgba(40,26,14,0.55)'; g.lineWidth = 0.11;
    for (let y = top + 0.5; y < bot; y += 0.8) {
      const u = (y - top) / (bot - top), cx = x + ox - sl + 2 * sl * u;
      g.beginPath(); g.moveTo(cx - 0.26, y - 0.18); g.lineTo(cx + 0.26, y + 0.18); g.stroke();
    }
  }
  // the knot on top + a frayed tail
  g.fillStyle = '#9c7f55'; g.beginPath(); g.ellipse(x, top + 0.15, 0.9, 0.45, 0, 0, TAU); g.fill();
  g.strokeStyle = 'rgba(50,34,18,0.8)'; g.lineWidth = 0.16; g.stroke();
  g.strokeStyle = '#9c7f55'; g.lineWidth = 0.28;
  g.beginPath(); g.moveTo(x + 0.6, top + 0.3); g.quadraticCurveTo(x + 1.4, top + 1.2, x + 1.1 + r() * 0.6, top + 2.2); g.stroke();
}

// sawn log end + a protruding board at the raft's ends (drawn for the left end; mirrored for the right)
function paintCap(g, seed, lash) {
  const r = seeded(seed);
  // log end: a short rounded stub with end grain
  const cy = 6.9, rad = 4.6;
  g.fillStyle = '#4a3424';
  g.beginPath(); g.moveTo(0.2, cy - rad); g.lineTo(-1.6, cy - rad + 0.3); g.quadraticCurveTo(-2.9, cy, -1.7, cy + rad - 0.2); g.lineTo(0.2, cy + rad); g.closePath(); g.fill();
  const eg = g.createLinearGradient(0, cy - rad, 0, cy + rad);
  eg.addColorStop(0, '#b08a60'); eg.addColorStop(0.5, '#8a6845'); eg.addColorStop(1, '#3b3a2a');
  g.fillStyle = eg;
  g.beginPath(); g.ellipse(-1.75, cy, 1.05, rad - 0.35, 0, 0, TAU); g.fill();
  g.strokeStyle = 'rgba(50,30,15,0.55)'; g.lineWidth = 0.15;
  for (let k = 1; k <= 3; k++) { g.beginPath(); g.ellipse(-1.75, cy + 0.3, 1.05 * k / 3.6, (rad - 0.6) * k / 3.6, 0, 0, TAU); g.stroke(); }
  g.strokeStyle = 'rgba(15,10,5,0.5)'; g.lineWidth = 0.2;
  g.beginPath(); g.moveTo(-1.7, cy - 2); g.lineTo(-1.5, cy + 1.5); g.stroke();
  // a board sticking out further than the rest
  const L = 2.6 + r() * 1.4;
  g.fillStyle = '#5e4630';
  g.beginPath(); g.moveTo(0.5, -2.4); g.lineTo(-L + 0.3, -2.2); g.lineTo(-L, 0.2); g.lineTo(-L + 0.2, 2.9); g.lineTo(0.5, 3.1); g.closePath(); g.fill();
  g.fillStyle = '#8a6c4c';
  g.beginPath(); g.moveTo(0.5, -2.4); g.lineTo(-L + 0.3, -2.2); g.lineTo(-L + 0.1, -0.2); g.lineTo(0.5, -0.1); g.closePath(); g.fill();
  g.strokeStyle = 'rgba(230,200,160,0.45)'; g.lineWidth = 0.25;
  g.beginPath(); g.moveTo(-L + 0.2, 0.05); g.lineTo(0.4, 0.05); g.stroke();
  g.strokeStyle = 'rgba(20,12,6,0.5)'; g.lineWidth = 0.15;
  g.beginPath(); g.moveTo(-L + 0.4, 1.2); g.lineTo(-0.5, 1.0); g.stroke();
  // salt line + barnacles on the stub
  g.fillStyle = '#c9c3b2';
  for (let k = 0; k < 3; k++) { g.beginPath(); g.arc(-1.4 + r() * 1.2, cy + 1.5 + r() * 2.5, 0.35 + r() * 0.3, 0, TAU); g.fill(); }
  if (lash) lashing(g, r, 1.2);
}

// ------------------------------------------------------------------ deck clutter
function paintCup(g) {
  // a dented tin cup
  const gr = g.createLinearGradient(-1.3, 0, 1.3, 0);
  gr.addColorStop(0, '#5d6063'); gr.addColorStop(0.45, '#a9adb0'); gr.addColorStop(1, '#4a4c50');
  g.fillStyle = gr;
  g.beginPath(); g.moveTo(-1.3, -3.1); g.lineTo(1.3, -3.1); g.lineTo(1.15, -0.2); g.quadraticCurveTo(0, 0.15, -1.15, -0.2); g.closePath(); g.fill();
  g.fillStyle = '#2c2d30'; g.beginPath(); g.ellipse(0, -3.1, 1.3, 0.38, 0, 0, TAU); g.fill();
  g.strokeStyle = '#c9ccce'; g.lineWidth = 0.18; g.beginPath(); g.ellipse(0, -3.1, 1.3, 0.38, 0, 0, TAU); g.stroke();
  g.strokeStyle = '#6f7275'; g.lineWidth = 0.35; g.beginPath(); g.arc(1.6, -1.8, 0.75, -1.3, 1.3); g.stroke();
  g.fillStyle = 'rgba(140,70,30,0.5)'; g.beginPath(); g.ellipse(-0.5, -0.9, 0.5, 0.35, 0, 0, TAU); g.fill();
  g.strokeStyle = 'rgba(30,30,32,0.5)'; g.lineWidth = 0.15; g.beginPath(); g.moveTo(0.3, -2.4); g.quadraticCurveTo(0.6, -1.8, 0.2, -1.2); g.stroke();
}

function paintCoil(g, rx, turns) {
  for (let k = 0; k < turns; k++) {
    const y = -0.75 - k * 0.62, w = rx - k * 0.42;
    g.strokeStyle = '#4c3720'; g.lineWidth = 0.95;
    g.beginPath(); g.ellipse(0, y, w, w * 0.3, 0, 0, TAU); g.stroke();
    g.strokeStyle = '#b8945d'; g.lineWidth = 0.62;
    g.beginPath(); g.ellipse(0, y, w, w * 0.3, 0, 0, TAU); g.stroke();
    g.strokeStyle = 'rgba(70,48,24,0.7)'; g.lineWidth = 0.14;
    g.setLineDash([0.35, 0.45]);
    g.beginPath(); g.ellipse(0, y, w, w * 0.3, 0, 0, TAU); g.stroke();
    g.setLineDash([]);
  }
  const y = -0.75 - (turns - 1) * 0.62, w = rx - (turns - 1) * 0.42;
  g.fillStyle = 'rgba(20,14,8,0.85)'; g.beginPath(); g.ellipse(0, y, w * 0.55, w * 0.14, 0, 0, TAU); g.fill();
  g.strokeStyle = '#d2b07a'; g.lineWidth = 0.18;
  g.beginPath(); g.ellipse(0, y - 0.1, w, w * 0.3, 0, Math.PI * 1.1, Math.PI * 1.7); g.stroke();
}

function paintBones(g) {
  g.strokeStyle = '#d8d2c0'; g.lineWidth = 0.22;
  g.beginPath(); g.moveTo(-2.6, -0.5); g.lineTo(2.2, -0.6); g.stroke();
  for (let k = 0; k < 6; k++) { const x = -1.8 + k * 0.7; g.beginPath(); g.moveTo(x, -0.55); g.lineTo(x + 0.2, -1.5); g.moveTo(x, -0.55); g.lineTo(x + 0.25, 0.2); g.stroke(); }
  g.fillStyle = '#d8d2c0'; g.beginPath(); g.moveTo(2.2, -0.6); g.lineTo(3.6, -1.3); g.lineTo(3.4, -0.1); g.closePath(); g.fill();
  g.beginPath(); g.ellipse(-2.9, -0.55, 0.7, 0.5, 0, 0, TAU); g.fill();
  g.fillStyle = '#2a2420'; g.beginPath(); g.arc(-3.0, -0.65, 0.18, 0, TAU); g.fill();
}

function paintShells(g) {
  g.fillStyle = '#e3cbb0'; g.beginPath(); g.moveTo(-1.6, -0.2); g.quadraticCurveTo(-0.8, -2.2, 0, -0.2); g.closePath(); g.fill();
  g.strokeStyle = 'rgba(150,100,70,0.6)'; g.lineWidth = 0.12;
  for (let k = 0; k < 4; k++) { g.beginPath(); g.moveTo(-0.8, -0.2); g.lineTo(-1.4 + k * 0.4, -1.3); g.stroke(); }
  g.fillStyle = '#c99a86'; g.beginPath(); g.ellipse(1.4, -0.55, 0.9, 0.55, 0.3, 0, TAU); g.fill();
  g.fillStyle = '#f2e6d8'; g.beginPath(); g.ellipse(1.2, -0.75, 0.4, 0.22, 0.3, 0, TAU); g.fill();
}

function paintBottleLying(g) {
  const gr = g.createLinearGradient(0, -2.2, 0, 0);
  gr.addColorStop(0, 'rgba(120,170,120,0.85)'); gr.addColorStop(1, 'rgba(40,80,50,0.9)');
  g.fillStyle = gr;
  roundRect(g, -3, -2.1, 4.6, 2.0, 0.9); g.fill();
  g.fillRect(1.4, -1.55, 1.6, 0.9);
  g.fillStyle = '#5b3a24'; g.fillRect(2.9, -1.6, 0.6, 1.0);
  g.fillStyle = 'rgba(230,255,230,0.5)'; g.fillRect(-2.4, -1.8, 3.2, 0.3);
  g.fillStyle = 'rgba(230,220,190,0.6)'; g.fillRect(-1.6, -1.6, 1.4, 1.1);
}

// ------------------------------------------------------------------ structures (static parts)
function paintAnchorUp(g) {
  const iron = '#3a302b', hi = '#9b6a48', rust = 'rgba(150,78,34,0.85)';
  g.save();
  g.translate(5.5, -1.2);
  g.rotate(-0.42);
  g.lineCap = 'round';
  // shank
  g.strokeStyle = iron; g.lineWidth = 1.7;
  g.beginPath(); g.moveTo(0, -13.5); g.lineTo(0, -0.6); g.stroke();
  // stock
  g.lineWidth = 1.2; g.beginPath(); g.moveTo(-3.8, -11.4); g.lineTo(3.8, -11.0); g.stroke();
  g.fillStyle = iron; g.beginPath(); g.arc(-3.9, -11.4, 0.75, 0, TAU); g.arc(3.9, -11.0, 0.75, 0, TAU); g.fill();
  // arms
  g.lineWidth = 1.6;
  g.beginPath(); g.moveTo(-6.2, -5.6); g.quadraticCurveTo(-5.7, -0.4, 0, -0.9); g.quadraticCurveTo(5.7, -0.4, 6.2, -5.6); g.stroke();
  // flukes
  g.fillStyle = iron;
  for (const sx of [-1, 1]) {
    g.beginPath(); g.moveTo(sx * 6.2, -7.9); g.lineTo(sx * 7.7, -4.3); g.lineTo(sx * 6.4, -4.7); g.lineTo(sx * 4.9, -4.0); g.closePath(); g.fill();
  }
  // ring
  g.strokeStyle = iron; g.lineWidth = 0.75;
  g.beginPath(); g.arc(0, -15.2, 1.6, 0, TAU); g.stroke();
  // highlights (left / top) and rust
  g.strokeStyle = hi; g.lineWidth = 0.32;
  g.beginPath(); g.moveTo(-0.55, -13); g.lineTo(-0.55, -1.8); g.stroke();
  g.beginPath(); g.moveTo(-5.9, -5.2); g.quadraticCurveTo(-5.4, -1.3, -1, -1.4); g.stroke();
  g.beginPath(); g.arc(0, -15.2, 1.6, Math.PI * 0.9, Math.PI * 1.6); g.stroke();
  g.fillStyle = rust;
  for (const [x, y, s] of [[0.2, -9, 0.7], [-0.1, -4, 0.55], [-3.2, -1.8, 0.6], [4.4, -2.6, 0.5], [2.5, -11.1, 0.45], [6.3, -6.2, 0.4]]) {
    g.beginPath(); g.ellipse(x, y, s, s * 1.6, 0, 0, TAU); g.fill();
  }
  g.strokeStyle = 'rgba(150,78,34,0.6)'; g.lineWidth = 0.25;
  g.beginPath(); g.moveTo(0.3, -8.4); g.lineTo(0.4, -6.4); g.moveTo(-3, -1.3); g.lineTo(-3.1, 0.2); g.stroke();
  g.restore();
}

function paintBollard(g) {
  const r = seeded(404);
  stick(g, r, -6.4, -0.6, -6.6, -9.6, 3.0, 2.6, hex('#5a4129'), 4, 0.2);
  // cut top
  g.fillStyle = '#8f6d4a'; g.beginPath(); g.ellipse(-6.6, -9.6, 1.3, 0.45, 0, 0, TAU); g.fill();
  g.strokeStyle = 'rgba(40,25,12,0.5)'; g.lineWidth = 0.12; g.beginPath(); g.ellipse(-6.6, -9.6, 0.6, 0.2, 0, 0, TAU); g.stroke();
  // rope turns
  wrap(g, -6.5, -5.6, 3.3, 2.6, 3, 0.7);
}

// a solar still: a cloth sheet tied between three stick tips, sagging to a drip point
const PUR_DRIP = [-1.8, -10.6];
function paintPurifierFrame(g) {
  const r = seeded(77);
  const wood = hex('#6e5236');
  const L = [-9.4, -17.4], M = [-1.4, -21.4], Rt = [6.0, -17.0], S = PUR_DRIP;
  // back stick (behind the cloth)
  stick(g, r, -1.6, -0.8, M[0], M[1] - 0.6, 1.0, 0.8, shade(wood, -0.2), 5, 0.3);
  // the reservoir: a cut-down bottle (water drawn live)
  roundRect(g, -4.0, -7.6, 4.2, 6.8, 0.9);
  g.fillStyle = 'rgba(190,220,228,0.3)'; g.fill();
  g.strokeStyle = 'rgba(225,240,245,0.75)'; g.lineWidth = 0.22; g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 0.3; g.beginPath(); g.moveTo(-3.4, -6.8); g.lineTo(-3.4, -1.8); g.stroke();
  g.strokeStyle = 'rgba(200,220,230,0.8)'; g.lineWidth = 0.2;
  g.beginPath(); g.ellipse(-1.9, -7.6, 2.1, 0.45, 0, 0, TAU); g.stroke();
  // inside of the sheet (seen from above): tied at three points, sagging between them
  const inner = g.createLinearGradient(0, M[1], 0, S[1]);
  inner.addColorStop(0, '#e6dbc0'); inner.addColorStop(0.5, '#c9bb99'); inner.addColorStop(1, '#8a7f63');
  g.fillStyle = inner;
  const backEdge = () => {
    g.moveTo(L[0], L[1]);
    g.quadraticCurveTo(-5.6, -17.2, M[0], M[1]);
    g.quadraticCurveTo(2.6, -17.0, Rt[0], Rt[1]);
  };
  g.beginPath();
  backEdge();
  g.quadraticCurveTo(0.6, -12.6, S[0], S[1]);
  g.quadraticCurveTo(-5.6, -12.2, L[0], L[1]);
  g.closePath(); g.fill();
  // a couple of soft sags toward the drip point, and the wet patch where the water runs
  g.strokeStyle = 'rgba(110,92,64,0.35)'; g.lineWidth = 0.22;
  g.beginPath(); g.moveTo(-5.4, -17.0); g.quadraticCurveTo(-3.6, -13.4, S[0] - 0.3, S[1] - 0.8); g.stroke();
  g.beginPath(); g.moveTo(2.0, -17.0); g.quadraticCurveTo(0.2, -13.6, S[0] + 0.2, S[1] - 0.8); g.stroke();
  g.strokeStyle = 'rgba(255,250,235,0.45)'; g.lineWidth = 0.25;
  g.beginPath(); backEdge(); g.stroke();
  g.fillStyle = 'rgba(70,110,120,0.3)';
  g.beginPath(); g.ellipse(S[0], S[1] - 1.4, 1.4, 0.8, 0, 0, TAU); g.fill();
  // the outside of the sheet hanging in front (darker, it faces down/away from the sky)
  const outer = g.createLinearGradient(0, -18, 0, S[1]);
  outer.addColorStop(0, '#c4b490'); outer.addColorStop(1, '#7f735a');
  g.fillStyle = outer;
  g.beginPath();
  g.moveTo(L[0], L[1]);
  g.quadraticCurveTo(-5.6, -12.2, S[0], S[1]);
  g.quadraticCurveTo(0.6, -12.6, Rt[0], Rt[1]);
  g.quadraticCurveTo(-0.8, -13.6, S[0] + 0.2, S[1] - 2.2);
  g.quadraticCurveTo(-5.0, -13.8, L[0], L[1]);
  g.closePath(); g.fill();
  g.strokeStyle = '#efe5cc'; g.lineWidth = 0.32;
  g.beginPath(); g.moveTo(L[0], L[1]); g.quadraticCurveTo(-5.0, -13.8, S[0] + 0.2, S[1] - 2.2); g.quadraticCurveTo(-0.8, -13.6, Rt[0], Rt[1]); g.stroke();
  // stains + a stitched patch
  g.fillStyle = 'rgba(120,90,50,0.25)';
  g.beginPath(); g.ellipse(-5.8, -13.6, 0.9, 0.5, 0.5, 0, TAU); g.fill();
  g.fillStyle = '#9d8262';
  g.beginPath(); g.moveTo(1.2, -14.4); g.lineTo(2.9, -15.0); g.lineTo(2.8, -13.6); g.lineTo(1.4, -13.3); g.closePath(); g.fill();
  g.strokeStyle = 'rgba(50,35,20,0.6)'; g.lineWidth = 0.1; g.setLineDash([0.3, 0.3]); g.stroke(); g.setLineDash([]);
  // front sticks + ties at the corners
  stick(g, r, -8.4, -0.8, L[0] - 0.4, L[1] - 1.4, 1.15, 0.85, wood, 5, 0.3);
  stick(g, r, 4.8, -0.8, Rt[0] + 0.4, Rt[1] - 1.4, 1.15, 0.85, shade(wood, 0.08), 5, 0.3);
  for (const p of [L, Rt]) {
    g.fillStyle = '#b08d58'; g.beginPath(); g.ellipse(p[0], p[1], 0.75, 0.5, 0, 0, TAU); g.fill();
    g.strokeStyle = '#5a4228'; g.lineWidth = 0.14; g.stroke();
  }
  wrap(g, M[0], M[1] - 0.4, 1.6, 1.1, 2, 0.3);
  // a short spout of twisted cloth at the drip point
  g.strokeStyle = '#8f8467'; g.lineWidth = 0.55;
  g.beginPath(); g.moveTo(S[0], S[1] - 0.6); g.lineTo(S[0] - 0.1, S[1] + 0.9); g.stroke();
}

function paintBottle(g) {
  // empty bottle, cap at top; inner body x -1.1..1.1, y -6.4..-1.2
  g.fillStyle = 'rgba(200,226,234,0.28)';
  roundRect(g, -1.2, -6.6, 2.4, 5.6, 0.8); g.fill();
  g.beginPath(); g.moveTo(-1.0, -6.4); g.quadraticCurveTo(-0.5, -7.4, -0.5, -7.8); g.lineTo(0.5, -7.8); g.quadraticCurveTo(0.5, -7.4, 1.0, -6.4); g.closePath(); g.fill();
  g.strokeStyle = 'rgba(230,244,248,0.7)'; g.lineWidth = 0.16;
  roundRect(g, -1.2, -6.6, 2.4, 5.6, 0.8); g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.6)'; g.lineWidth = 0.22;
  g.beginPath(); g.moveTo(-0.7, -6.0); g.lineTo(-0.7, -1.8); g.stroke();
  g.strokeStyle = 'rgba(160,190,200,0.5)'; g.lineWidth = 0.12;
  g.beginPath(); g.moveTo(-1.2, -4.6); g.lineTo(1.2, -4.6); g.moveTo(-1.2, -2.8); g.lineTo(1.2, -2.8); g.stroke();
}

function paintGrill(g) {
  const r = seeded(31);
  // stones
  for (const [x, w] of [[-4.2, 2.6], [4.0, 2.4]]) {
    const sg = g.createLinearGradient(0, -2.4, 0, -0.4);
    sg.addColorStop(0, '#8d8984'); sg.addColorStop(1, '#4b4844');
    g.fillStyle = sg;
    g.beginPath(); g.moveTo(x - w, -0.5); g.quadraticCurveTo(x - w * 0.9, -2.5, x, -2.6); g.quadraticCurveTo(x + w, -2.4, x + w, -0.5); g.closePath(); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.18)'; g.beginPath(); g.ellipse(x - w * 0.3, -2.0, w * 0.4, 0.3, -0.1, 0, TAU); g.fill();
  }
  // firewood stack
  for (let k = 0; k < 3; k++) {
    const y = -0.9 - k * 1.25 + (k === 2 ? 0.2 : 0), x0 = 7.2 + (k === 2 ? 0.8 : 0), x1 = 11.2 - (k === 2 ? 0.5 : 0) + r() * 0.4;
    stick(g, r, x0, y, x1, y + (r() - 0.5) * 0.3, 1.3, 1.2, hex(k % 2 ? '#6b4a2e' : '#7e5c3c'), 3, 0.1);
    g.fillStyle = '#b48b62'; g.beginPath(); g.ellipse(x1, y, 0.35, 0.62, 0, 0, TAU); g.fill();
    g.strokeStyle = 'rgba(60,35,18,0.6)'; g.lineWidth = 0.1; g.beginPath(); g.ellipse(x1, y, 0.18, 0.32, 0, 0, TAU); g.stroke();
  }
  // the drum
  const x0 = -6.1, x1 = 6.1, y0 = -13.3, y1 = -2.2;
  const dg = g.createLinearGradient(x0, 0, x1, 0);
  dg.addColorStop(0, '#231b18'); dg.addColorStop(0.25, '#4a3427'); dg.addColorStop(0.55, '#6e4a33'); dg.addColorStop(0.78, '#7f5a40'); dg.addColorStop(1, '#2a1f1a');
  g.fillStyle = dg;
  g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y0); g.quadraticCurveTo(x1 + 0.35, (y0 + y1) / 2, x1, y1); g.quadraticCurveTo(0, y1 + 0.8, x0, y1); g.quadraticCurveTo(x0 - 0.35, (y0 + y1) / 2, x0, y0); g.closePath(); g.fill();
  g.save(); g.clip();
  // rust patches + drips
  for (let k = 0; k < 14; k++) {
    g.fillStyle = pick(['rgba(150,74,32,0.55)', 'rgba(176,96,44,0.45)', 'rgba(110,52,24,0.6)']);
    g.beginPath(); g.ellipse(x0 + r() * 12, y0 + r() * 11, 0.6 + r() * 1.6, 0.4 + r() * 1.1, r() * 3, 0, TAU); g.fill();
  }
  g.strokeStyle = 'rgba(160,82,36,0.5)'; g.lineWidth = 0.3;
  for (let k = 0; k < 7; k++) { const x = x0 + 1 + r() * 10, y = -9 + r() * 4; g.beginPath(); g.moveTo(x, y); g.lineTo(x + (r() - 0.5) * 0.3, y + 1.5 + r() * 3); g.stroke(); }
  // ribs
  for (const y of [-9.6, -5.8]) {
    g.fillStyle = 'rgba(15,10,8,0.55)'; g.fillRect(x0 - 1, y, 14, 0.7);
    g.fillStyle = 'rgba(200,140,100,0.35)'; g.fillRect(x0 - 1, y - 0.3, 14, 0.3);
  }
  // a dent
  g.fillStyle = 'rgba(10,6,5,0.35)'; g.beginPath(); g.ellipse(2.4, -7.6, 1.4, 1.0, 0.3, 0, TAU); g.fill();
  g.strokeStyle = 'rgba(220,160,120,0.35)'; g.lineWidth = 0.2; g.beginPath(); g.arc(2.2, -7.8, 1.3, Math.PI, Math.PI * 1.6); g.stroke();
  g.restore();
  // air holes (lit live when burning)
  g.fillStyle = '#0f0907';
  for (let k = 0; k < 4; k++) { g.beginPath(); g.ellipse(-3.6 + k * 2.4, -3.7, 0.55, 0.45, 0, 0, TAU); g.fill(); }
  // top lip, dark inside
  g.fillStyle = '#120c0a'; g.beginPath(); g.ellipse(0, y0, 6.1, 1.25, 0, 0, TAU); g.fill();
  g.strokeStyle = '#7d5a43'; g.lineWidth = 0.45; g.beginPath(); g.ellipse(0, y0, 6.1, 1.25, 0, 0, Math.PI); g.stroke();
  g.strokeStyle = '#3a2a22'; g.lineWidth = 0.35; g.beginPath(); g.ellipse(0, y0, 6.1, 1.25, 0, Math.PI, TAU); g.stroke();
}

function paintGrate(g) {
  g.strokeStyle = '#2d2724'; g.lineWidth = 0.35;
  g.beginPath(); g.moveTo(-6.6, -13.9); g.lineTo(6.6, -13.7); g.stroke();
  g.lineWidth = 0.2;
  for (let k = 0; k < 9; k++) { const x = -6 + k * 1.5; g.beginPath(); g.moveTo(x, -14.4); g.lineTo(x + 0.15, -13.3); g.stroke(); }
  g.strokeStyle = 'rgba(190,160,140,0.4)'; g.lineWidth = 0.12;
  g.beginPath(); g.moveTo(-6.4, -14.05); g.lineTo(6.4, -13.85); g.stroke();
}

function paintMast(g) {
  const r = seeded(91);
  const wood = hex('#6a4c32');
  stick(g, r, -2.2, -0.4, -1.6, -41, 2.6, 2.1, wood, 6, 0.35);
  stick(g, r, -1.2, -37.5, -2.3, -80, 2.1, 1.4, shade(wood, 0.06), 6, 0.4);
  wrap(g, -1.5, -39.2, 3.0, 3.8, 4, 0.8);
  wrap(g, -2.1, -2.6, 3.4, 1.8, 2, 0.4);
  // cleat
  g.fillStyle = '#4b3523'; g.fillRect(-0.6, -12.5, 1.9, 0.8);
  g.fillStyle = '#8d6b48'; g.fillRect(-0.6, -12.6, 1.9, 0.25);
  // braces at the foot
  stick(g, r, -7.5, -0.6, -2.3, -8.5, 0.9, 0.7, shade(wood, -0.1), 3, 0.15);
  stick(g, r, 3.4, -0.6, -1.6, -8, 0.9, 0.7, shade(wood, -0.05), 3, 0.15);
  // the cap
  g.fillStyle = '#8b6a48'; g.beginPath(); g.ellipse(-2.3, -80, 0.75, 0.3, 0, 0, TAU); g.fill();
}

function paintSailCloth(g) {
  const r = seeded(1234);
  const W = 34, H = 60;
  g.fillStyle = '#d8cbab'; g.fillRect(0, 0, W, H);
  // cloth strips with seams
  for (let x = 0, k = 0; x < W; x += 6.6, k++) {
    g.fillStyle = k % 2 ? 'rgba(120,98,66,0.08)' : 'rgba(255,250,235,0.07)';
    g.fillRect(x, 0, 6.6, H);
    g.strokeStyle = 'rgba(96,78,54,0.5)'; g.lineWidth = 0.22;
    g.beginPath(); g.moveTo(x + 6.6, 0); g.lineTo(x + 6.6 + (r() - 0.5) * 0.6, H); g.stroke();
    g.setLineDash([0.55, 0.5]); g.strokeStyle = 'rgba(80,62,40,0.4)'; g.lineWidth = 0.14;
    g.beginPath(); g.moveTo(x + 6.0, 0); g.lineTo(x + 6.0, H); g.stroke(); g.setLineDash([]);
  }
  // weave noise
  for (let k = 0; k < 260; k++) {
    g.fillStyle = r() < 0.5 ? 'rgba(90,70,45,0.06)' : 'rgba(255,250,235,0.07)';
    g.fillRect(r() * W, r() * H, 0.3 + r() * 1.5, 0.15);
  }
  const patch = (x, y, w, h, col, a, hatch) => {
    g.save(); g.translate(x + w / 2, y + h / 2); g.rotate(a);
    g.beginPath();
    g.moveTo(-w / 2 + r() * 0.4, -h / 2 + r() * 0.4); g.lineTo(w / 2 - r() * 0.4, -h / 2 + r() * 0.3);
    g.lineTo(w / 2 - r() * 0.3, h / 2 - r() * 0.4); g.lineTo(-w / 2 + r() * 0.3, h / 2 - r() * 0.3); g.closePath();
    g.fillStyle = col; g.fill();
    if (hatch) {
      g.save(); g.clip();
      g.strokeStyle = 'rgba(60,45,25,0.22)'; g.lineWidth = 0.12;
      for (let k = -h; k < w + h; k += 0.6) { g.beginPath(); g.moveTo(-w / 2 + k, -h / 2); g.lineTo(-w / 2 + k - h, h / 2); g.stroke(); }
      g.restore();
    }
    g.setLineDash([0.5, 0.45]); g.strokeStyle = 'rgba(40,30,18,0.65)'; g.lineWidth = 0.16;
    g.strokeRect(-w / 2 + 0.5, -h / 2 + 0.5, w - 1, h - 1); g.setLineDash([]);
    g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(-w / 2, h / 2 - 0.4, w, 0.4);
    g.restore();
  };
  patch(4, 9, 9, 10, '#984636', 0.05, false);
  patch(18, 31, 10, 12, '#566f86', -0.04, false);
  patch(7, 41, 8, 8, '#a68b5e', 0.08, true);
  patch(22, 6, 6, 6, '#c9b993', -0.1, true);
  // a faded painted circle (an old sign of something)
  g.strokeStyle = 'rgba(140,60,40,0.22)'; g.lineWidth = 1.2;
  g.beginPath(); g.arc(20, 21, 4.5, 0.3, TAU - 0.6); g.stroke();
  // stains + salt
  for (let k = 0; k < 10; k++) {
    g.fillStyle = r() < 0.6 ? 'rgba(110,84,50,0.1)' : 'rgba(255,255,245,0.1)';
    g.beginPath(); g.ellipse(r() * W, r() * H, 1 + r() * 3, 0.8 + r() * 2.2, r() * 3, 0, TAU); g.fill();
  }
  // a darned tear
  g.strokeStyle = 'rgba(40,30,20,0.6)'; g.lineWidth = 0.14;
  for (let k = 0; k < 6; k++) { g.beginPath(); g.moveTo(26 + k * 0.5, 47); g.lineTo(26.3 + k * 0.5, 49.4); g.stroke(); }
  g.beginPath(); g.moveTo(25.8, 48.2); g.quadraticCurveTo(27.5, 47.6, 29.2, 48.4); g.stroke();
  // grime toward the foot
  const gg = g.createLinearGradient(0, H * 0.6, 0, H);
  gg.addColorStop(0, 'rgba(70,55,35,0)'); gg.addColorStop(1, 'rgba(70,55,35,0.3)');
  g.fillStyle = gg; g.fillRect(0, H * 0.6, W, H * 0.4);
}

function paintLampPole(g) {
  const r = seeded(55);
  const wood = hex('#5f452e');
  stick(g, r, -2.6, -0.5, -1.5, -47, 2.0, 1.5, wood, 7, 0.5);
  stick(g, r, -2.4, -44.3, LAMP_PIVOT[0] + 0.8, LAMP_PIVOT[1] - 1.2, 1.25, 0.9, shade(wood, 0.08), 4, 0.25);
  stick(g, r, -1.8, -36.5, 3.6, -44.4, 0.8, 0.6, shade(wood, -0.1), 3, 0.15);   // brace
  wrap(g, -1.7, -44.6, 2.4, 2.0, 3, 0.5);
  wrap(g, -2.4, -2.4, 3.0, 1.6, 2, 0.4);
  stick(g, r, -7, -0.5, -2.6, -7.5, 0.8, 0.6, shade(wood, -0.15), 3, 0.12);
  // hook wire
  g.strokeStyle = '#2b2622'; g.lineWidth = 0.28;
  g.beginPath(); g.moveTo(LAMP_PIVOT[0], LAMP_PIVOT[1] - 1.0); g.lineTo(LAMP_PIVOT[0], LAMP_PIVOT[1] + 0.2); g.stroke();
  // a tied rag (wind tell)
  g.fillStyle = '#8f3a2e'; g.beginPath(); g.moveTo(-1.5, -30); g.lineTo(1.2, -29.2); g.lineTo(0.8, -27.6); g.lineTo(-1.4, -28.2); g.closePath(); g.fill();
}

function paintLantern(g) {
  // hook at (0,0); glass centre at (0, LANT_L)
  const metal = '#2d2824';
  g.strokeStyle = metal; g.lineWidth = 0.3;
  g.beginPath(); g.moveTo(-1.6, 2.4); g.quadraticCurveTo(-1.6, -0.3, 0, -0.2); g.quadraticCurveTo(1.6, -0.3, 1.6, 2.4); g.stroke();
  // cap
  g.fillStyle = '#3b332c';
  g.beginPath(); g.moveTo(-0.7, 1.4); g.lineTo(0.7, 1.4); g.lineTo(2.3, 2.9); g.lineTo(-2.3, 2.9); g.closePath(); g.fill();
  g.fillStyle = 'rgba(150,90,50,0.5)'; g.fillRect(-1.6, 2.4, 1.4, 0.4);
  // glass (dark when unlit)
  g.fillStyle = 'rgba(40,46,52,0.82)'; g.fillRect(-1.95, 2.9, 3.9, 5.6);
  g.fillStyle = 'rgba(200,220,230,0.22)'; g.fillRect(-1.6, 3.2, 0.5, 4.8);
  // frame bars
  g.fillStyle = metal;
  g.fillRect(-2.3, 2.8, 0.55, 5.8); g.fillRect(1.75, 2.8, 0.55, 5.8); g.fillRect(-0.2, 2.9, 0.4, 5.6);
  // base
  g.fillStyle = '#3b332c'; g.fillRect(-2.5, 8.5, 5.0, 1.15);
  g.fillStyle = 'rgba(200,170,130,0.3)'; g.fillRect(-2.5, 8.5, 5.0, 0.25);
  g.fillStyle = 'rgba(150,80,40,0.55)'; g.fillRect(0.8, 8.9, 1.2, 0.6);
}

function paintPosts(g) {
  const r = seeded(808);
  const wood = hex('#62482f');
  stick(g, r, -10.8, -0.5, -11.6, -21.5, 1.7, 1.3, wood, 5, 0.35);
  stick(g, r, 10.6, -0.5, 11.5, -21.2, 1.7, 1.3, shade(wood, 0.06), 5, 0.35);
  wrap(g, -11.5, -19.6, 2.2, 1.8, 3, 0.4);
  wrap(g, 11.4, -19.4, 2.2, 1.8, 3, 0.4);
  stick(g, r, -15, -0.5, -11.0, -7, 0.8, 0.6, shade(wood, -0.12), 3, 0.1);
  stick(g, r, 14.8, -0.5, 10.8, -7, 0.8, 0.6, shade(wood, -0.12), 3, 0.1);
  g.fillStyle = '#8d6b48';
  g.beginPath(); g.ellipse(-11.6, -21.5, 0.65, 0.25, 0, 0, TAU); g.ellipse(11.5, -21.2, 0.65, 0.25, 0, 0, TAU); g.fill();
}

function paintWreck(g) {
  const r = seeded(5150);
  paintLog(g, r, -9, 9, 2.6, 2.4);
  for (let k = 0; k < 3; k++) {
    const x = -7 + k * 4.6 + r();
    g.fillStyle = css(BOARD[k + 1]);
    g.beginPath(); g.moveTo(x, -1.2); g.lineTo(x + 3.8, -1.4); g.lineTo(x + 3.6, 1.6); g.lineTo(x + 1.5, 2.2); g.lineTo(x + 0.2, 1.4); g.closePath(); g.fill();
    g.strokeStyle = 'rgba(230,200,160,0.4)'; g.lineWidth = 0.2; g.beginPath(); g.moveTo(x + 0.2, -1.1); g.lineTo(x + 3.6, -1.3); g.stroke();
  }
  g.strokeStyle = '#b08d58'; g.lineWidth = 0.6; g.beginPath(); g.moveTo(-8, -1); g.quadraticCurveTo(-10, 3, -8.5, 6); g.stroke();
  // splintered end
  g.fillStyle = '#c29a6a';
  g.beginPath(); g.moveTo(9, 0.4); g.lineTo(10.4, 1.4); g.lineTo(9.3, 2.0); g.lineTo(10.2, 3.0); g.lineTo(9, 4.6); g.closePath(); g.fill();
}

function makeGlow(rgb, size = 64) {
  const c = makeCanvas(size, size), g = c.getContext('2d');
  const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gr.addColorStop(0, css(rgb, 1)); gr.addColorStop(0.25, css(rgb, 0.55)); gr.addColorStop(0.6, css(rgb, 0.14)); gr.addColorStop(1, css(rgb, 0));
  g.fillStyle = gr; g.fillRect(0, 0, size, size);
  return c;
}

// Sprites are painted at a resolution a little above the current device scale so that
// blitting them every frame is close to 1:1 (cheap); repainted only when the zoom changes.
function sprScaleFor(sa) { return clamp(Math.ceil((sa || 1.5) * 1.2 * 2) / 2, 1.5, 6); }
function art(sa) {
  const want = sprScaleFor(sa);
  if (ART && (sa == null || ART.spr === want)) return ART;
  if (typeof document === 'undefined') return null;
  SPR = want;
  const A = { spr: want };
  A.tiles = [];
  for (let k = 0; k < NV; k++) A.tiles.push(sprite(-3, -4, TW + 6, 23, (g) => paintTile(g, k + 1)));
  A.caps = [sprite(-5, -4, 8, 16, (g) => paintCap(g, 11, false)), sprite(-5, -4, 8, 16, (g) => paintCap(g, 29, true))];
  A.cup = sprite(-2, -4, 5, 4.5, paintCup);
  A.coil = sprite(-3.5, -3.6, 7, 4, (g) => paintCoil(g, 2.8, 3));
  A.bigCoil = sprite(-5, -4.6, 10, 5, (g) => paintCoil(g, 4.2, 4));
  A.smallCoil = sprite(-4, -2.6, 8, 3, (g) => paintCoil(g, 3.4, 2));
  A.bones = sprite(-4, -2, 8.5, 3, paintBones);
  A.shells = sprite(-2.5, -2.5, 5, 3, paintShells);
  A.bottleLying = sprite(-3.5, -2.6, 7.5, 3, paintBottleLying);
  A.anchor = sprite(-6, -20, 20, 21, paintAnchorUp);
  A.bollard = sprite(-10, -11, 7, 11.5, paintBollard);
  A.purifier = sprite(-11, -24, 18, 24.5, paintPurifierFrame);
  A.bottle = sprite(-1.6, -8.2, 3.2, 7.6, paintBottle);
  A.grill = sprite(-8, -15.5, 21, 15.5, paintGrill);
  A.grate = sprite(-7, -15, 14, 2.2, paintGrate);
  A.mast = sprite(-9, -82, 14, 82.5, paintMast);
  A.cloth = (() => { const c = makeCanvas(34 * SPR, 60 * SPR); const g = c.getContext('2d'); g.scale(SPR, SPR); paintSailCloth(g); return c; })();
  A.lampPole = sprite(-9, -50, 19, 50.5, paintLampPole);
  A.lantern = sprite(-3, -1, 6, 11, paintLantern);
  A.posts = sprite(-16, -23, 32, 23.5, paintPosts);
  A.wreck = sprite(-11, -3, 22, 11, paintWreck);
  A.glowWarm = makeGlow([255, 196, 120]);
  A.glowFire = makeGlow([255, 128, 48]);
  A.glowWhite = makeGlow([255, 236, 200]);
  ART = A;
  return A;
}

// =====================================================================================
// draw
// =====================================================================================

const BUF = { c: null, g: null, m: null, mg: null };
function ensureBuf(w, h) {
  if (!BUF.c || BUF.c.width < w || BUF.c.height < h) {
    const W = Math.max(w, BUF.c ? BUF.c.width : 0) + 32, H = Math.max(h, BUF.c ? BUF.c.height : 0) + 32;
    BUF.c = makeCanvas(W, H); BUF.g = BUF.c.getContext('2d');
    BUF.m = makeCanvas(W, H); BUF.mg = BUF.m.getContext('2d');
  }
  return BUF.g && BUF.mg;
}

// rim / shade: the body shifted against itself, coloured, laid back on top (source-atop)
function band(w, h, lx, ly, wpx, col, alpha) {
  if (!(alpha > 0.01)) return;
  const m = BUF.mg, b = BUF.g;
  m.setTransform(1, 0, 0, 1, 0, 0);
  m.globalAlpha = 1;
  m.globalCompositeOperation = 'copy';
  m.drawImage(BUF.c, 0, 0, w, h, 0, 0, w, h);
  m.globalCompositeOperation = 'source-in';
  m.fillStyle = col; m.fillRect(0, 0, w, h);
  m.globalCompositeOperation = 'destination-out';
  m.drawImage(BUF.c, 0, 0, w, h, -lx * wpx, -ly * wpx, w, h);
  m.globalCompositeOperation = 'source-over';
  b.setTransform(1, 0, 0, 1, 0, 0);
  b.globalCompositeOperation = 'source-atop';
  b.globalAlpha = alpha;
  b.drawImage(BUF.m, 0, 0, w, h, 0, 0, w, h);
  b.globalAlpha = 1;
  b.globalCompositeOperation = 'source-over';
}
function lowSun(G) {
  const p = G.phase || 0;
  const dusk = smoothstep(0.46, 0.55, p) * (1 - smoothstep(0.6, 0.66, p));
  const dawn = p < 0.5 ? 1 - smoothstep(0.03, 0.1, p) : smoothstep(0.95, 0.99, p);
  return Math.max(dusk, dawn * 0.8);
}

function keyLight(G, wx, wyy) {
  const res = { lx: 0.3, ly: -1, col: [190, 205, 230], a: 0.22 };
  let cel = null;
  try { cel = celestial(G); } catch (e) { cel = null; }
  const s = worldToScreen(G, wx, wyy);
  if (cel && G.light > 0.25 && cel.sunVisible && Number.isFinite(cel.sunX)) {
    res.lx = cel.sunX - s.x; res.ly = cel.sunY - s.y;
    res.col = Array.isArray(cel.sunColor) ? mixColor(cel.sunColor, [255, 240, 215], 0.3) : [255, 226, 180];
    res.a = 0.72;
  } else if (cel && cel.moonVisible && Number.isFinite(cel.moonX)) {
    res.lx = cel.moonX - s.x; res.ly = cel.moonY - s.y;
    res.col = [176, 200, 255]; res.a = 0.6;
  } else if (G.light > 0.5) { res.col = [255, 236, 205]; res.a = 0.4; }
  // the deck is lit from above more than from the side
  res.ly = Math.min(res.ly, -Math.abs(res.lx) * 0.35);
  const l = Math.hypot(res.lx, res.ly) || 1;
  res.lx /= l; res.ly /= l;
  return res;
}

export function draw(ctx, G) {
  const R = G.raft, r = G.raftRt;
  if (!R || !r || !Array.isArray(R.tiles) || !R.tiles.length || r.ys.length !== R.tiles.length || !Number.isFinite(R.x)) return;
  const m = ctx.getTransform();
  const sa = m.a, se = m.e, sf = m.f;
  if (!(sa > 0.05)) return;
  const A = art(sa);
  if (!A) return;
  const n = R.tiles.length, len = n * TW;
  const t = G.time || 0;
  let ymin = Infinity, ymax = -Infinity;
  for (const y of r.ys) { if (y < ymin) ymin = y; if (y > ymax) ymax = y; }
  if (!Number.isFinite(ymin)) return;
  const sail = findStruct(R, 'sail'), lamp = findStruct(R, 'lamp');
  const top = ymin - (sail ? 96 : lamp ? 60 : 34);
  const x0 = R.x - 22, x1 = R.x + len + (sail ? 40 : 24), y1 = ymax + 26;

  drawWreck(ctx, G, r, A);
  const v = G.view;
  if (x1 < v.left - 10 || x0 > v.left + v.w + 10 || y1 < v.top - 10 || top > v.top + v.h + 10) return;

  drawUnder(ctx, G, r, t);

  // ---- compose the raft in an offscreen buffer at device resolution (visible part only)
  const cw = ctx.canvas.width, ch = ctx.canvas.height;
  let px0 = Math.floor(sa * x0 + se), py0 = Math.floor(sa * top + sf);
  let px1 = Math.ceil(sa * x1 + se), py1 = Math.ceil(sa * y1 + sf);
  px0 = Math.max(px0, -4); py0 = Math.max(py0, -4); px1 = Math.min(px1, cw + 4); py1 = Math.min(py1, ch + 4);
  const bw = px1 - px0, bh = py1 - py0;
  if (bw < 2 || bh < 2 || bw > 4096 || bh > 4096 || !ensureBuf(bw, bh)) return;
  const b = BUF.g;
  b.setTransform(1, 0, 0, 1, 0, 0);
  b.globalAlpha = 1; b.globalCompositeOperation = 'source-over';
  b.clearRect(0, 0, bw + 2, bh + 2);
  b.setTransform(sa, 0, 0, sa, se - px0, sf - py0);
  b.lineCap = 'round'; b.lineJoin = 'round';

  const post = [];
  drawBody(b, G, r, A, t, post, false);

  // ---- light passes (pixel space)
  const night = 1 - smoothstep(0.12, 0.72, G.light || 0);
  const low = lowSun(G);
  const W = G.weather || {};
  const rain = clamp(W.rain || 0, 0, 1);
  const key = keyLight(G, R.x + len / 2, (ymin + ymax) / 2 - 20);
  // one combined tint: dusk silhouette, cold night, wet rain — and a vertical falloff
  // (structures catch the sky, the wet logs under the deck sink into shadow)
  const layers = [[[32, 22, 48], 0.48 * low], [[12, 20, 48], 0.6 * night], [[16, 22, 30], 0.2 * rain]];
  let ta = 0, tr = 0, tg = 0, tb = 0;
  for (const [c, a] of layers) {
    if (!(a > 0.003)) continue;
    tr = c[0] * a + tr * (1 - a); tg = c[1] * a + tg * (1 - a); tb = c[2] * a + tb * (1 - a);
    ta = a + ta * (1 - a);
  }
  const tc = ta > 0 ? [tr / ta, tg / ta, tb / ta] : [12, 10, 20];
  const yDeck = sa * ((ymin + ymax) / 2) + sf - py0;
  const yLow = sa * (ymax + 12) + sf - py0;
  const gv = b.createLinearGradient(0, 0, 0, Math.max(yLow, 1));
  const shadeA = 0.12 + 0.1 * (G.light || 0);
  gv.addColorStop(0, css(tc, ta * 0.85));
  gv.addColorStop(clamp(yDeck / Math.max(yLow, 1), 0.05, 0.95), css(tc, ta));
  gv.addColorStop(1, css(mixColor(tc, [6, 8, 14], 0.6), Math.min(1, ta + shadeA + 0.18)));
  b.setTransform(1, 0, 0, 1, 0, 0);
  b.globalCompositeOperation = 'source-atop';
  b.fillStyle = gv; b.fillRect(0, 0, bw, bh);
  b.globalCompositeOperation = 'source-over';
  band(bw, bh, key.lx, key.ly, Math.max(1, 0.75 * sa), `rgb(${key.col[0] | 0},${key.col[1] | 0},${key.col[2] | 0})`, Math.min(1, key.a * (1 + 0.6 * low)));
  warmPass(G, r, bw, bh, sa, se - px0, sf - py0, night);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(BUF.c, 0, 0, bw, bh, px0, py0, bw, bh);
  ctx.restore();

  // ---- on top: the anchor line, fire, lantern glass
  drawPost(ctx, G, r, A, t, post, night);
}

// warm lamp / fire light added onto the raft only
function warmPass(G, r, bw, bh, sa, ox, oy, night) {
  const src = [];
  if (r.lampPos) {
    src.push([r.lampPos.x, r.lampPos.y, 96, [255, 178, 96], 0.6]);
    src.push([r.lampPos.x - 4, (G.raft.y || 0) - 2, 58, [255, 160, 80], 0.45]);     // the pool on the deck below
  }
  if (r.grillPos) src.push([r.grillPos.x, r.grillPos.y, 56, [255, 140, 64], 0.62]);
  // other warm lights standing on / near the raft (the boy's lantern...)
  const R = G.raft, L = G.lights;
  if (Array.isArray(L) && night > 0.15) {
    const x0 = R.x - 30, x1 = R.x + R.tiles.length * TW + 30, yd = R.y || 0;
    for (let k = 0; k < L.length && src.length < 6; k++) {
      const l = L[k];
      if (!l || !(l.r >= 30) || !Number.isFinite(l.x) || !Number.isFinite(l.y)) continue;
      if (l.x + l.r * 0.5 < x0 || l.x - l.r * 0.5 > x1 || Math.abs(l.y - yd) > 70) continue;
      if ((r.lampPos && Math.hypot(l.x - r.lampPos.x, l.y - r.lampPos.y) < 3) || (r.grillPos && Math.hypot(l.x - r.grillPos.x, l.y - r.grillPos.y) < 3)) continue;
      const c = Array.isArray(l.color) ? l.color : [255, 200, 130];
      src.push([l.x, l.y, clamp(l.r * 0.42, 14, 80), c, 0.5 * clamp(l.a == null ? 1 : l.a, 0, 1)]);
    }
  }
  if (!src.length) return;
  // tint the raft toward the light's colour inside each pool (source-atop: raft pixels only)
  const k = 0.3 + 0.7 * Math.max(night, lowSun(G) * 0.6);
  const b = BUF.g;
  b.setTransform(sa, 0, 0, sa, ox, oy);
  b.globalCompositeOperation = 'source-atop';
  for (const [x, y, rad, c, a] of src) {
    const gr = b.createRadialGradient(x, y, 0, x, y, rad);
    const hot = mixColor(c, [255, 236, 200], 0.25);
    gr.addColorStop(0, css(hot, Math.min(0.85, a * k * 1.25)));
    gr.addColorStop(0.3, css(c, a * k * 0.6));
    gr.addColorStop(1, css(c, 0));
    b.fillStyle = gr;
    b.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  b.globalCompositeOperation = 'source-over';
  b.setTransform(1, 0, 0, 1, 0, 0);
}

// seaweed, dangling rope ends — behind the raft, under the water
function drawUnder(ctx, G, r, t) {
  const R = G.raft, n = R.tiles.length;
  ctx.save();
  ctx.lineCap = 'round';
  for (let i = 0; i < n; i++) {
    const f = frameOf(G, r, i);
    const seed = R.tiles[i].v || i;
    for (let k = 0; k < 2; k++) {
      const h1 = ((seed * (k + 3) * 2654435761) >>> 0) / 4294967296;
      const lx = -9 + h1 * 18 + k * 3;
      const L = 4 + h1 * 11;
      const p = toWorld(f, lx, 11.2);
      const sw = Math.sin(t * 1.3 + seed * 0.01 + k * 2) * 2.2;
      ctx.strokeStyle = k ? 'rgba(52,78,40,0.85)' : 'rgba(66,88,44,0.8)';
      ctx.lineWidth = 0.9 - k * 0.25;
      ctx.beginPath(); ctx.moveTo(p.x, p.y);
      ctx.quadraticCurveTo(p.x + sw * 0.4 - 1.5, p.y + L * 0.5, p.x + sw - 3, p.y + L);
      ctx.stroke();
    }
  }
  // a frayed rope end trailing from the back end
  const f0 = frameOf(G, r, 0);
  const p = toWorld(f0, -TW / 2 + 0.5, 4);
  ctx.strokeStyle = 'rgba(150,120,80,0.85)'; ctx.lineWidth = 0.7;
  ctx.beginPath(); ctx.moveTo(p.x, p.y);
  const s2 = Math.sin(t * 1.1) * 2;
  ctx.bezierCurveTo(p.x - 3, p.y + 5, p.x - 7 + s2, p.y + 9, p.x - 12 + s2 * 1.5, p.y + 13);
  ctx.stroke();
  ctx.restore();
}

function drawWreck(ctx, G, r, A) {
  for (const w of r.wreck) {
    if (!onScreen(G, w.x, w.y, 30)) continue;
    const a = 1 - smoothstep(w.life - 4, w.life, w.t);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(w.x, w.y);
    ctx.rotate(w.rot);
    blit(ctx, A.wreck, 0, 0);
    ctx.restore();
  }
}

// everything that receives the scene light
function drawBody(b, G, r, A, t, post, ghost) {
  const R = G.raft, n = R.tiles.length;
  // tiles
  for (let i = 0; i < n; i++) {
    const tile = R.tiles[i], f = frameOf(G, r, i);
    b.save();
    b.translate(f.x, f.y); b.rotate(f.a); b.translate(-TW / 2, 0);
    blit(b, A.tiles[Math.abs(tile.v | 0) % NV]);
    if (i === 0) blit(b, A.caps[0]);
    if (i === n - 1) { b.save(); b.translate(TW, 0); b.scale(-1, 1); blit(b, A.caps[1]); b.restore(); }
    if (tile.hp < 100) drawDamage(b, tile, i, n);
    if (!tile.s) drawClutter(b, A, tile);
    b.restore();
  }
  // structures: the sail first (it reaches over its neighbours), then the rest
  for (const pass of [0, 1]) {
    for (let i = 0; i < n; i++) {
      const s = R.tiles[i].s;
      if (!s || (s.type === 'sail') !== (pass === 0)) continue;
      const f = frameOf(G, r, i);
      b.save();
      b.translate(f.x, f.y); b.rotate(f.a);
      drawStruct(b, G, r, A, s, i, f, t, post, ghost);
      b.restore();
    }
  }
}

function drawClutter(b, A, tile) {
  const v = Math.abs(tile.v | 0);
  const kind = v % 9;
  const x = TW / 2 + ((((v >> 4) % 13) - 6) * 0.9);
  switch (kind) {
    case 0: blit(b, A.cup, x, -0.9); break;
    case 1: blit(b, A.coil, x, -0.8); break;
    case 2: blit(b, A.bones, x, -0.9); break;
    case 3: blit(b, A.shells, x, -0.9); break;
    case 5: blit(b, A.bottleLying, x, -0.8); break;
    case 7: blit(b, A.cup, x - 3, -0.9); blit(b, A.shells, x + 3, -0.9); break;
    default: break;
  }
}

// cracks, a split board, shark bites on the log
function drawDamage(b, tile, i, n) {
  const dmg = clamp(1 - tile.hp / 100, 0, 1);
  const r = seeded((Math.abs(tile.v | 0) * 31 + 7) >>> 0);
  const nc = Math.min(5, 1 + Math.floor(dmg * 5));
  b.lineCap = 'round';
  for (let k = 0; k < nc; k++) {
    let x = 2 + r() * 20, y = -1.6 + r() * 1.4;
    const pts = [[x, y]];
    const steps = 3 + Math.floor(r() * 3);
    for (let s = 0; s < steps; s++) { x += (r() - 0.5) * 2.4; y += 0.7 + r() * 1.3; pts.push([x, y]); }
    b.strokeStyle = 'rgba(14,8,4,0.9)'; b.lineWidth = 0.34;
    b.beginPath(); b.moveTo(pts[0][0], pts[0][1]); for (const p of pts) b.lineTo(p[0], p[1]); b.stroke();
    b.strokeStyle = 'rgba(225,195,150,0.35)'; b.lineWidth = 0.16;
    b.beginPath(); b.moveTo(pts[0][0] + 0.25, pts[0][1] + 0.15); for (const p of pts) b.lineTo(p[0] + 0.25, p[1] + 0.15); b.stroke();
  }
  if (dmg > 0.45) {
    // a board end split off
    const x = 3 + r() * 16;
    b.fillStyle = '#140c07';
    b.beginPath(); b.moveTo(x, 3.6); b.lineTo(x + 1.0, 0.9); b.lineTo(x + 1.8, 2.0); b.lineTo(x + 2.6, 0.6); b.lineTo(x + 3.4, 3.8); b.closePath(); b.fill();
    b.strokeStyle = '#c9a274'; b.lineWidth = 0.18;
    b.beginPath(); b.moveTo(x + 1.0, 0.9); b.lineTo(x + 1.3, -0.2); b.moveTo(x + 2.6, 0.6); b.lineTo(x + 2.4, -0.4); b.stroke();
  }
  if (dmg > 0.6) {
    // bite marks on the outer end of the log
    const side = i === 0 ? 0 : i === n - 1 ? 1 : (r() < 0.5 ? 0 : 1);
    const bx = side ? TW - 2.5 : 2.5;
    b.save();
    b.globalCompositeOperation = 'destination-out';
    for (let k = 0; k < 3; k++) { b.beginPath(); b.arc(bx + (side ? -1 : 1) * k * 2.1, 11.6, 1.25, 0, TAU); b.fill(); }
    b.restore();
    b.strokeStyle = 'rgba(20,12,6,0.85)'; b.lineWidth = 0.25;
    for (let k = 0; k < 3; k++) { b.beginPath(); b.arc(bx + (side ? -1 : 1) * k * 2.1, 11.6, 1.3, Math.PI * 1.05, Math.PI * 1.95); b.stroke(); }
  }
}

// ------------------------------------------------------------------ structures (live)
function drawStruct(b, G, r, A, s, i, f, t, post, ghost) {
  const W = G.weather || {};
  const wind = Number.isFinite(W.wind) ? W.wind : 0.3;
  switch (s.type) {
    case 'anchor': {
      blit(b, A.bollard);
      if (!s.down) { blit(b, A.bigCoil, 1.2, -0.7); blit(b, A.anchor); ropeToRing(b); }
      else { blit(b, A.smallCoil, 0.5, -0.7); if (!ghost) post.push({ k: 'anchorLine', f, i }); }
      break;
    }
    case 'purifier': {
      blit(b, A.purifier);
      // water in the reservoir
      const lvl = clamp(s.prog || 0, 0, 1);
      if (lvl > 0.02) {
        const h = 5.6 * lvl;
        b.fillStyle = 'rgba(120,190,215,0.6)'; b.fillRect(-3.75, -1.05 - h, 3.7, h);
        b.fillStyle = 'rgba(225,245,255,0.7)'; b.fillRect(-3.75, -1.05 - h, 3.7, 0.28);
      }
      // drip from the funnel tip (daylight / rain)
      const day = smoothstep(0.25, 0.85, G.light || 0), rain = clamp(W.rain || 0, 0, 1);
      if (s.water < WATER_MAX && Math.max(day, rain) > 0.2) {
        const ph = (t * (0.7 + rain * 1.5) + i * 0.37) % 1;
        const dy = PUR_DRIP[1] + 1.2 + ph * ph * 3.4;
        b.fillStyle = 'rgba(200,235,250,0.85)';
        b.beginPath(); b.ellipse(PUR_DRIP[0] - 0.1, dy, 0.3, 0.42, 0, 0, TAU); b.fill();
      }
      // three bottles: how much is stored
      for (let k = 0; k < WATER_MAX; k++) {
        const bx = 6.7 + k * 2.65;
        blit(b, A.bottle, bx, 0);
        if (k < s.water) {
          b.fillStyle = 'rgba(64,150,196,0.72)';
          roundRect(b, bx - 1.0, -5.6, 2.0, 4.45, 0.65); b.fill();
          b.fillStyle = 'rgba(210,240,255,0.85)'; b.fillRect(bx - 0.95, -5.6, 1.9, 0.28);
          b.fillStyle = 'rgba(255,255,255,0.45)'; b.fillRect(bx - 0.75, -5.0, 0.32, 3.4);
        }
        b.fillStyle = ['#2f6fb0', '#b8352b', '#e8e4d8'][k]; b.fillRect(bx - 0.55, -8.5, 1.1, 0.75);
      }
      break;
    }
    case 'grill': {
      blit(b, A.grill);
      const cooking = s.state === 'cook', done = s.state === 'done';
      // the fish on the grate
      if (cooking || done) {
        const u = cooking ? clamp(s.t / COOK_TIME, 0, 1) : 1;
        drawFish(b, u, t);
      }
      blit(b, A.grate);
      const embers = cooking ? 1 : done ? 1 - smoothstep(10, 50, s.t) : 0;
      if (!ghost && embers > 0.02) post.push({ k: 'fire', f, i, cooking, embers });
      break;
    }
    case 'sail': drawSail(b, G, r, A, s, i, t, wind, ghost); break;
    case 'lamp': {
      blit(b, A.lampPole);
      const L = lanternLocal(G, i, f.a);
      b.save();
      b.translate(LAMP_PIVOT[0], LAMP_PIVOT[1]);
      b.rotate(-L.th);
      blit(b, A.lantern);
      b.restore();
      if (s.on && !ghost) post.push({ k: 'lantern', f, i, L });
      break;
    }
    case 'bed': drawHammock(b, A, t + i, wind); break;
    default: break;
  }
}

function ropeToRing(b) {
  // rope from the coil up to the anchor ring
  b.strokeStyle = '#4c3720'; b.lineWidth = 0.75;
  b.beginPath(); b.moveTo(1.6, -2.6); b.quadraticCurveTo(-1.6, -9, -0.8, -14.6); b.stroke();
  b.strokeStyle = '#b8945d'; b.lineWidth = 0.45;
  b.beginPath(); b.moveTo(1.6, -2.6); b.quadraticCurveTo(-1.6, -9, -0.8, -14.6); b.stroke();
}

function drawFish(b, u, t) {
  const raw = [168, 186, 196], cooked = [184, 120, 58], charred = [128, 74, 34];
  const c = u < 0.7 ? mixColor(raw, cooked, u / 0.7) : mixColor(cooked, charred, (u - 0.7) / 0.3);
  b.fillStyle = css(c);
  b.beginPath();
  b.moveTo(-4.6, -14.5);
  b.quadraticCurveTo(-2.6, -16.4, 1.6, -15.2);
  b.lineTo(3.4, -14.6);
  b.lineTo(5.0, -15.7); b.lineTo(4.6, -14.3); b.lineTo(5.1, -13.4); b.lineTo(3.3, -14.0);
  b.quadraticCurveTo(-1, -13.4, -4.6, -14.1);
  b.closePath(); b.fill();
  b.fillStyle = css(shade(c, 0.35), 0.8);
  b.beginPath(); b.ellipse(-1.2, -15.3, 2.6, 0.35, -0.08, 0, TAU); b.fill();
  if (u > 0.4) {
    b.strokeStyle = `rgba(40,20,8,${(0.35 + 0.4 * u).toFixed(2)})`; b.lineWidth = 0.28;
    for (let k = 0; k < 3; k++) { const x = -2.5 + k * 1.6; b.beginPath(); b.moveTo(x, -15.6); b.lineTo(x + 0.7, -14.2); b.stroke(); }
  }
  b.fillStyle = u < 0.5 ? '#1a1d22' : '#f0e8d8';
  b.beginPath(); b.arc(-3.4, -14.75, 0.32, 0, TAU); b.fill();
}

function drawSail(b, G, r, A, s, i, t, wind, ghost) {
  const k = ghost ? 0 : r.sailK;
  const R = G.raft;
  const wv = clamp(Math.abs(wind), 0, 1.6);
  const flap = Math.sin(t * 1.7 + i) * 0.8 + Math.sin(t * 4.3 + i * 2) * 0.35 * (0.3 + wv);
  const Wd = 26;
  // back stay
  b.strokeStyle = 'rgba(70,52,32,0.85)'; b.lineWidth = 0.35;
  b.beginPath(); b.moveTo(-2.2, -78); b.lineTo(-13, -0.6); b.stroke();
  const boomY = -17;
  const headY = lerp(boomY - 3.5, -72, k);
  if (k > 0.04) {
    // nobody aboard to trim it: the sail spills its wind and luffs
    const slack = ghost ? 0 : clamp((1 - (Number.isFinite(r.crewK) ? r.crewK : 1)) / (1 - SLACK), 0, 1);
    const bil = (3 + wv * 4.5 * (1 - 0.55 * slack) + flap * (1 + 1.2 * slack)) * k;
    const hx = -1, top = headY;
    const path = () => {
      b.beginPath();
      b.moveTo(hx, top);
      b.quadraticCurveTo(Wd * 0.5, top - 1.2, Wd, top + 0.8);
      b.bezierCurveTo(Wd + bil, lerp(top, boomY, 0.3), Wd + bil * 1.15, lerp(top, boomY, 0.7), Wd + 1.6, boomY - 0.6);
      b.quadraticCurveTo(Wd * 0.5, boomY + 0.6 + bil * 0.22, hx, boomY);
      b.closePath();
    };
    b.save();
    path(); b.clip();
    b.drawImage(A.cloth, hx, top - 1.5, Wd + bil * 1.2 + 3, (boomY - top) + 3);
    const sg = b.createLinearGradient(hx, 0, Wd + bil, 0);
    sg.addColorStop(0, 'rgba(36,26,18,0.42)');
    sg.addColorStop(0.3, 'rgba(255,248,230,0)');
    sg.addColorStop(0.62, 'rgba(255,250,236,0.14)');
    sg.addColorStop(1, 'rgba(36,26,18,0.3)');
    b.fillStyle = sg; b.fillRect(hx, top - 2, Wd + bil + 4, boomY - top + 4);
    // folds following the billow
    b.strokeStyle = 'rgba(70,54,36,0.28)'; b.lineWidth = 0.45;
    for (let q = 0; q < 3; q++) {
      const yy = lerp(top, boomY, 0.25 + q * 0.22);
      b.beginPath(); b.moveTo(hx + 1, lerp(top, boomY, 0.08 + q * 0.12));
      b.quadraticCurveTo(Wd * 0.55, yy - 1.5 + flap * 0.3, Wd + bil * 0.85, yy + 2);
      b.stroke();
    }
    b.restore();
    b.strokeStyle = 'rgba(66,50,34,0.8)'; b.lineWidth = 0.4; path(); b.stroke();
    // frayed leech threads
    b.strokeStyle = 'rgba(200,185,150,0.7)'; b.lineWidth = 0.15;
    for (let q = 0; q < 4; q++) {
      const yy = lerp(top, boomY, 0.3 + q * 0.13), xx = Wd + bil * 1.05;
      b.beginPath(); b.moveTo(xx, yy); b.lineTo(xx + 1 + Math.sin(t * 6 + q) * 0.4, yy + 0.4); b.stroke();
    }
    // yard
    b.strokeStyle = '#3f2c1c'; b.lineWidth = 1.4;
    b.beginPath(); b.moveTo(-3.5, top - 0.2); b.lineTo(Wd + 1.8, top + 0.5); b.stroke();
    b.strokeStyle = 'rgba(190,150,105,0.6)'; b.lineWidth = 0.35;
    b.beginPath(); b.moveTo(-3.3, top - 0.6); b.lineTo(Wd + 1.6, top + 0.1); b.stroke();
    // halyard
    b.strokeStyle = 'rgba(70,52,32,0.8)'; b.lineWidth = 0.3;
    b.beginPath(); b.moveTo(-1.2, -78.5); b.lineTo(0.3, top); b.stroke();
  } else {
    // furled: a fat, lumpy roll of cloth lashed along the boom, the yard resting on top
    const y0 = boomY - 0.4;
    const bump = (x) => 4.4 + Math.sin(x * 0.9 + 1.3) * 0.8 + Math.sin(x * 2.3) * 0.4;
    b.beginPath();
    b.moveTo(-1.2, y0);
    for (let x = -1; x <= Wd - 1; x += 1.5) b.lineTo(x, y0 - bump(x) * (x > Wd - 5 ? 0.6 + 0.1 * (Wd - 1 - x) : 1));
    b.lineTo(Wd - 0.4, y0 - 1.2);
    b.quadraticCurveTo(Wd, y0 + 0.6, Wd - 1.5, y0 + 1.5);
    b.quadraticCurveTo(Wd * 0.5, y0 + 2.4, -1.2, y0 + 1.2);
    b.closePath();
    const fg = b.createLinearGradient(0, y0 - 5.2, 0, y0 + 2);
    fg.addColorStop(0, '#ece0c2'); fg.addColorStop(0.35, '#cdbd98'); fg.addColorStop(0.75, '#8e7f60'); fg.addColorStop(1, '#5a4e3a');
    b.fillStyle = fg; b.fill();
    b.strokeStyle = 'rgba(70,54,36,0.6)'; b.lineWidth = 0.25; b.stroke();
    // folds and a glimpse of the patches
    b.strokeStyle = 'rgba(90,72,50,0.45)'; b.lineWidth = 0.22;
    for (let x = 1.5; x < Wd - 3; x += 2.6) { b.beginPath(); b.moveTo(x, y0 - bump(x) + 0.4); b.quadraticCurveTo(x + 1.2, y0 - 1.4, x + 0.6, y0 + 1.2); b.stroke(); }
    b.fillStyle = 'rgba(150,68,52,0.75)'; b.beginPath(); b.ellipse(6, y0 - 2.4, 1.9, 1.1, -0.2, 0, TAU); b.fill();
    b.fillStyle = 'rgba(86,111,134,0.75)'; b.beginPath(); b.ellipse(15.5, y0 - 2.0, 1.7, 1.0, 0.2, 0, TAU); b.fill();
    for (let x = 3; x < Wd - 3; x += 5.5) wrapLive(b, x, y0 - bump(x) * 0.45, 0.9, bump(x) + 1.4);
    // yard resting on the roll
    b.strokeStyle = '#3f2c1c'; b.lineWidth = 1.3;
    b.beginPath(); b.moveTo(-3.5, y0 - 5.6); b.lineTo(Wd - 0.5, y0 - 4.6); b.stroke();
    b.strokeStyle = 'rgba(190,150,105,0.55)'; b.lineWidth = 0.3;
    b.beginPath(); b.moveTo(-3.3, y0 - 6.0); b.lineTo(Wd - 0.7, y0 - 5.0); b.stroke();
  }
  // boom + sheet
  b.strokeStyle = '#3f2c1c'; b.lineWidth = 1.5;
  b.beginPath(); b.moveTo(-3.5, boomY); b.lineTo(Wd + 3, boomY - 0.6); b.stroke();
  b.strokeStyle = 'rgba(190,150,105,0.55)'; b.lineWidth = 0.35;
  b.beginPath(); b.moveTo(-3.3, boomY - 0.5); b.lineTo(Wd + 2.8, boomY - 1.0); b.stroke();
  b.strokeStyle = 'rgba(70,52,32,0.85)'; b.lineWidth = 0.32;
  b.beginPath(); b.moveTo(Wd + 1.5, boomY - 0.4); b.quadraticCurveTo(Wd * 0.7, -6, 9.5, -0.8); b.stroke();
  // mast in front
  blit(b, A.mast);
  // pennant at the masthead (the same red as his scarf)
  const pw = 7 + wv * 2;
  b.fillStyle = '#a8322a';
  b.beginPath();
  b.moveTo(-2.3, -80.8);
  for (let q = 1; q <= 4; q++) { const u = q / 4; b.lineTo(-2.3 + pw * u, -80.8 + u * 1.2 + Math.sin(t * 7 - q * 1.2 + i) * u * 1.1); }
  for (let q = 4; q >= 0; q--) { const u = q / 4; b.lineTo(-2.3 + pw * u * 0.98, -78.8 - u * 0.2 + Math.sin(t * 7 - q * 1.2 + i) * u * 1.1 + u * 0.6); }
  b.closePath(); b.fill();
  b.fillStyle = 'rgba(255,200,170,0.25)'; b.fillRect(-2.3, -80.8, 2.4, 0.4);
}

function wrapLive(b, x, y, w, h) {
  b.strokeStyle = '#5d4529'; b.lineWidth = w;
  b.beginPath(); b.moveTo(x - 0.3, y - h / 2); b.lineTo(x + 0.3, y + h / 2); b.stroke();
  b.strokeStyle = '#b9955e'; b.lineWidth = w * 0.6;
  b.beginPath(); b.moveTo(x - 0.3, y - h / 2); b.lineTo(x + 0.3, y + h / 2); b.stroke();
}

function drawHammock(b, A, t, wind) {
  blit(b, A.posts);
  const sw = Math.sin(t * 0.9) * 0.9 + Math.sin(t * 2.1) * 0.25 * (0.4 + Math.abs(wind));
  const lx = -8.6, rx = 8.5, ey = -16.6;
  const low = -7.6 + Math.sin(t * 0.9 + 1) * 0.3;      // lowest point of the cloth
  const cy = low * 2 - ey;                              // quadratic control for that low point
  // ropes fanning from the post tops to the gathered ends
  b.strokeStyle = 'rgba(80,60,36,0.9)'; b.lineWidth = 0.26;
  for (const [px, py, hx] of [[-11.5, -20.2, lx], [11.4, -20.0, rx]]) {
    for (let q = -1; q <= 1; q++) { b.beginPath(); b.moveTo(px, py); b.lineTo(hx, ey - 0.6 + q * 0.9); b.stroke(); }
  }
  const topEdge = () => { b.moveTo(lx, ey - 1.0); b.quadraticCurveTo(sw, cy - 4.2, rx, ey - 1.0); };
  // inside of the hammock (seen from above), then the outside belly
  b.beginPath();
  topEdge();
  b.quadraticCurveTo(sw * 0.8, cy - 1.0, lx, ey - 1.0);
  b.closePath();
  b.fillStyle = '#6f5a3e'; b.fill();
  b.beginPath();
  topEdge();
  b.lineTo(rx, ey + 0.6);
  b.quadraticCurveTo(sw, cy + 3.0, lx, ey + 0.6);
  b.closePath();
  b.fillStyle = '#cbb68f'; b.fill();
  b.save(); b.clip();
  for (const [off, col, w] of [[-2.6, 'rgba(142,59,46,0.8)', 0.9], [-0.7, 'rgba(77,109,116,0.75)', 0.6], [1.1, 'rgba(142,59,46,0.65)', 0.5]]) {
    b.strokeStyle = col; b.lineWidth = w;
    b.beginPath(); b.moveTo(lx, ey + off * 0.3); b.quadraticCurveTo(sw, cy + off, rx, ey + off * 0.3); b.stroke();
  }
  b.fillStyle = 'rgba(30,20,12,0.32)';
  b.beginPath(); b.moveTo(lx, ey + 1.2); b.quadraticCurveTo(sw, cy + 3.2, rx, ey + 1.2); b.lineTo(rx, ey + 5); b.lineTo(lx, ey + 5); b.closePath(); b.fill();
  b.restore();
  b.strokeStyle = 'rgba(245,230,195,0.55)'; b.lineWidth = 0.25;
  b.beginPath(); topEdge(); b.stroke();
  // tassels along the lower edge
  b.strokeStyle = 'rgba(190,170,130,0.8)'; b.lineWidth = 0.18;
  for (let q = 1; q < 8; q++) {
    const u = q / 8, x = lerp(lx, rx, u);
    const y = (1 - u) * (1 - u) * (ey + 0.6) + 2 * u * (1 - u) * (cy + 3.0) + u * u * (ey + 0.6);
    b.beginPath(); b.moveTo(x + sw * 2 * u * (1 - u), y - 0.2); b.lineTo(x + sw * 2 * u * (1 - u) + Math.sin(t * 2 + q) * 0.3, y + 1.0); b.stroke();
  }
  // a rolled blanket resting inside
  b.fillStyle = '#7f8f7a';
  b.beginPath(); b.ellipse(-4.6 + sw * 0.3, -11.6 + sw * 0.05, 2.3, 1.25, -0.32, 0, TAU); b.fill();
  b.strokeStyle = 'rgba(30,40,30,0.5)'; b.lineWidth = 0.2; b.beginPath(); b.ellipse(-4.3 + sw * 0.3, -11.7, 1.1, 0.6, -0.32, 0, TAU); b.stroke();
}

// ------------------------------------------------------------------ additive / on-top bits
function drawPost(ctx, G, r, A, t, post, night) {
  for (const p of post) {
    const f = p.f;
    if (p.k === 'anchorLine') {
      // taut line from the bollard over the back of the raft, fading down into the dark water
      const a = toWorld(f, -6.6, -6.4);
      const e = toWorld(f, -TW / 2 - 1, 1.5);
      const sway = Math.sin(t * 0.8) * 3;
      const c1x = e.x - 10 + sway, c1y = e.y + 40, ex = e.x - 30 + sway * 2, ey = e.y + 150;
      ctx.save();
      ctx.lineCap = 'round';
      for (const [col, w] of [['rgba(40,28,16,0.9)', 0.9], ['rgba(176,142,92,0.85)', 0.5]]) {
        ctx.strokeStyle = col; ctx.lineWidth = w;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(e.x + 1, e.y - 4, e.x, e.y); ctx.stroke();
      }
      const N = 10;
      let px = e.x, py = e.y;
      for (let k = 1; k <= N; k++) {
        const u = k / N, v1 = 1 - u;
        const x = v1 * v1 * e.x + 2 * v1 * u * c1x + u * u * ex, y = v1 * v1 * e.y + 2 * v1 * u * c1y + u * u * ey;
        const al = 1 - (k - 0.5) / N;
        ctx.strokeStyle = `rgba(40,28,16,${(0.9 * al).toFixed(3)})`; ctx.lineWidth = 0.9;
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(x, y); ctx.stroke();
        ctx.strokeStyle = `rgba(176,142,92,${(0.8 * al * al).toFixed(3)})`; ctx.lineWidth = 0.5;
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(x, y); ctx.stroke();
        px = x; py = y;
      }
      ctx.restore();
    } else if (p.k === 'fire') {
      ctx.save();
      ctx.translate(f.x, f.y); ctx.rotate(f.a);
      ctx.globalCompositeOperation = 'lighter';
      const e = p.embers;
      const fl = 0.8 + 0.2 * noise1(t * 8 + p.i, 3);
      // glowing holes + coals
      ctx.fillStyle = `rgba(255,${(110 + 50 * fl) | 0},40,${(0.85 * e).toFixed(3)})`;
      for (let k = 0; k < 4; k++) { ctx.beginPath(); ctx.ellipse(-3.6 + k * 2.4, -3.7, 0.5, 0.4, 0, 0, TAU); ctx.fill(); }
      ctx.globalAlpha = 0.5 * e;
      ctx.drawImage(A.glowFire, -7, -15.5, 14, 4);
      ctx.globalAlpha = 1;
      ctx.fillStyle = `rgba(255,120,40,${(0.65 * e * fl).toFixed(3)})`;
      ctx.beginPath(); ctx.ellipse(0, -13.2, 5.2, 0.9, 0, 0, TAU); ctx.fill();
      if (p.cooking) {
        // soft flame tongues licking up around the fish, leaning with the wind
        const W = G.weather || {};
        const lean0 = clamp((W.wind || 0.3) * 1.4, -2, 2.5);
        const base = -13.3;
        for (let k = 0; k < 5; k++) {
          const bx = -4.4 + k * 2.2 + (noise1(t * 1.3 + k * 7, 2) - 0.5) * 0.8;
          const h = (2.6 + 4.2 * noise1(t * 4.6 + k * 2.3 + p.i, 11)) * (k === 0 || k === 4 ? 0.7 : 1);
          const lean = lean0 + Math.sin(t * 8.5 + k * 1.9) * 0.7;
          const w = 1.25 + 0.3 * Math.sin(t * 6 + k);
          ctx.fillStyle = 'rgba(255,92,22,0.5)';
          ctx.beginPath();
          ctx.moveTo(bx - w, base);
          ctx.bezierCurveTo(bx - w * 1.1, base - h * 0.45, bx + lean * 0.4 - w * 0.4, base - h * 0.8, bx + lean, base - h);
          ctx.bezierCurveTo(bx + lean * 0.4 + w * 0.3, base - h * 0.7, bx + w * 1.1, base - h * 0.4, bx + w, base);
          ctx.closePath(); ctx.fill();
          const h2 = h * 0.62, w2 = w * 0.55;
          ctx.fillStyle = 'rgba(255,190,80,0.7)';
          ctx.beginPath();
          ctx.moveTo(bx - w2, base);
          ctx.bezierCurveTo(bx - w2, base - h2 * 0.5, bx + lean * 0.3 - w2 * 0.3, base - h2 * 0.8, bx + lean * 0.6, base - h2);
          ctx.bezierCurveTo(bx + lean * 0.3 + w2 * 0.3, base - h2 * 0.7, bx + w2, base - h2 * 0.4, bx + w2, base);
          ctx.closePath(); ctx.fill();
          ctx.fillStyle = 'rgba(255,246,210,0.55)';
          ctx.beginPath(); ctx.ellipse(bx + lean * 0.12, base - h * 0.14, w2 * 0.6, h * 0.16, 0, 0, TAU); ctx.fill();
        }
        ctx.globalAlpha = 0.5 * fl;
        ctx.drawImage(A.glowFire, -12, -27, 24, 22);
        ctx.globalAlpha = 1;
      }
      ctx.restore();
    } else if (p.k === 'lantern') {
      const L = p.L;
      ctx.save();
      ctx.translate(f.x, f.y); ctx.rotate(f.a);
      ctx.translate(LAMP_PIVOT[0], LAMP_PIVOT[1]); ctx.rotate(-L.th);
      ctx.globalCompositeOperation = 'lighter';
      const fl = 0.88 + 0.12 * noise1(t * 7 + p.i * 5, 4);
      ctx.fillStyle = `rgba(255,${(150 + 40 * fl) | 0},70,${(0.75 * fl).toFixed(3)})`;
      ctx.fillRect(-1.75, 3.0, 1.5, 5.4); ctx.fillRect(0.25, 3.0, 1.5, 5.4);
      // flame
      ctx.fillStyle = 'rgba(255,236,170,0.95)';
      ctx.beginPath(); ctx.moveTo(0, 4.0 - fl * 0.6); ctx.quadraticCurveTo(0.75, 6.2, 0, 7.4); ctx.quadraticCurveTo(-0.75, 6.2, 0, 4.0 - fl * 0.6); ctx.fill();
      ctx.globalAlpha = 0.9 * fl;
      ctx.drawImage(A.glowWarm, -7, LANT_L - 7, 14, 14);
      ctx.globalAlpha = 0.22 * fl * (0.4 + 0.6 * night);
      ctx.drawImage(A.glowWarm, -26, LANT_L - 26, 52, 52);
      ctx.restore();
      // moths circling the light at night
      if (night > 0.3) {
        const c = toWorld(f, L.x, L.y);
        if (c) {
          ctx.save();
          ctx.fillStyle = `rgba(255,230,190,${(0.75 * night).toFixed(3)})`;
          for (let k = 0; k < 3; k++) {
            const a = t * (2.1 + k * 0.7) + k * 2.1, rad = 5 + k * 2.5 + Math.sin(t * 3 + k) * 1.5;
            const mx = c.x + Math.cos(a) * rad, my = c.y + Math.sin(a * 1.3) * rad * 0.6 - 2;
            const flap = Math.abs(Math.sin(t * 30 + k)) * 0.6 + 0.3;
            ctx.beginPath(); ctx.ellipse(mx, my, 0.55, flap * 0.5, a, 0, TAU); ctx.fill();
          }
          ctx.restore();
        }
      }
    }
  }
}

// =====================================================================================
// layer 14: reflections on the water + the build ghost
// =====================================================================================

export function drawBuildGhost(ctx, G) {
  const R = G.raft, r = G.raftRt;
  if (!R || !r || !Array.isArray(R.tiles) || r.ys.length !== R.tiles.length) return;
  drawReflections(ctx, G, r);
  const B = r.build;
  if (!B || G.mode !== 'play') return;
  const A = art();
  if (!A) return;
  const t = G.time || 0;
  const pulse = 0.5 + 0.5 * Math.sin(t * 5);
  const sc = (G.view && G.view.scale) || 1.4;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';

  // faint markers on the other slots
  for (const s of B.slots) {
    if (s === B.target || s.kind === 'repair') continue;
    ctx.save();
    ctx.translate(s.x, s.y); ctx.rotate(s.a || 0);
    ctx.strokeStyle = 'rgba(220,235,255,0.28)';
    ctx.lineWidth = 1 / sc;
    ctx.setLineDash([3 / sc, 3 / sc]);
    if (s.kind === 'tile') ctx.strokeRect(-TW / 2 + 1, -2.5, TW - 2, 13);
    else { ctx.beginPath(); ctx.moveTo(-8, -0.6); ctx.lineTo(8, -0.6); ctx.stroke(); }
    ctx.restore();
  }

  const T = B.target;
  if (T) {
    const ok = !T.far && !T.reason && (T.kind === 'tile' ? canPay(G, TILE_COST) : T.kind === 'repair' ? canPay(G, REPAIR_COST) : have(G, T.type) > 0);
    const col = T.far ? [190, 196, 205] : ok ? [226, 240, 255] : [255, 128, 108];
    const tcol = T.far ? [200, 206, 215] : ok ? [196, 228, 255] : [255, 140, 120];
    const frame = (g) => { g.translate(T.x, T.y); g.rotate(T.a || 0); };
    ctx.save();
    if (T.kind === 'tile') {
      ghostPaint(ctx, T.x - TW, T.y - 6, T.x + TW, T.y + 16, (g) => {
        frame(g);
        blit(g, A.tiles[(R.tiles.length + 3) % NV], -TW / 2, 0);
        if (T.side < 0) blit(g, A.caps[0], -TW / 2, 0);
        else { g.translate(TW / 2, 0); g.scale(-1, 1); blit(g, A.caps[1]); }
      }, tcol, 0.5 + 0.18 * pulse);
      ctx.translate(T.x, T.y); ctx.rotate(T.a || 0);
      ghostOutline(ctx, -TW / 2 - 0.5, -3, TW + 1, 14.5, col, pulse, sc, t);
    } else if (T.kind === 'place') {
      const fake = newStruct(T.type);
      const h = T.type === 'sail' ? 82 : T.type === 'lamp' ? 50 : T.type === 'bed' ? 23 : 24;
      const w = T.type === 'sail' ? 34 : T.type === 'bed' ? 30 : 22;
      const x0 = T.type === 'sail' ? -6 : -w / 2;
      ghostPaint(ctx, T.x + x0 - 8, T.y - h - 8, T.x + x0 + w + 8, T.y + 4, (g) => {
        frame(g);
        drawStruct(g, G, r, A, fake, T.i, { x: T.x, y: T.y, a: T.a || 0 }, t, [], true);
      }, tcol, 0.42 + 0.16 * pulse);
      ctx.translate(T.x, T.y); ctx.rotate(T.a || 0);
      ghostOutline(ctx, x0, -h - 1, w, h + 1.5, col, pulse, sc, t);
    } else {
      // repair: the damaged tile glows
      ctx.translate(T.x, T.y); ctx.rotate(T.a || 0);
      ghostOutline(ctx, -TW / 2 + 0.5, -3, TW - 1, 14.5, col, pulse, sc, t);
      // a little hammer mark
      ctx.strokeStyle = 'rgba(10,14,22,0.55)'; ctx.lineWidth = 3.2 / sc;
      ctx.beginPath(); ctx.moveTo(-2.5, -9); ctx.lineTo(2.5, -14); ctx.stroke();
      ctx.strokeStyle = css(col, 0.95); ctx.lineWidth = 1.4 / sc;
      ctx.beginPath(); ctx.moveTo(-2.5, -9); ctx.lineTo(2.5, -14); ctx.stroke();
      ctx.lineWidth = 2.8 / sc;
      ctx.beginPath(); ctx.moveTo(0.6, -15.6); ctx.lineTo(4.4, -12.2); ctx.stroke();
    }
    ctx.restore();

    // label: name + cost (+ why not)
    const name = T.kind === 'tile' ? '扩建木筏' : T.kind === 'repair' ? '修补木筏' : '放置' + itemName(T.type);
    const cost = T.kind === 'tile' ? TILE_COST : T.kind === 'repair' ? REPAIR_COST : { [T.type]: 1 };
    const segs = [];
    for (const id of Object.keys(cost)) {
      const enough = have(G, id) >= cost[id];
      segs.push([itemName(id) + '×' + cost[id], enough ? 'rgba(236,228,210,0.95)' : 'rgba(255,140,120,0.95)']);
    }
    let note = null;
    if (T.reason) note = T.reason;
    else if (T.far) note = '离得太远了';
    else if (B.opts.length > 1) note = hint('[Q] 切换  ', '「切换」 ') + B.opts.map((o) => (o === B.sel ? '「' + itemName(o === 'tile' ? 'tile' : o) + '」' : itemName(o))).join(' ');
    const lh = T.kind !== 'place' ? 22 : T.type === 'sail' ? 88 : T.type === 'lamp' ? 56 : 30;
    drawLabel(ctx, G, T.x, T.y - lh, name, segs, note, sc);
  } else if (B.noRoom) {
    const n = R.tiles.length;
    drawLabel(ctx, G, R.x + n * TW / 2, (R.y || 0) - 26, '放置' + itemName(B.sel), [], '木筏上没有空位了，先扩建木筏', sc);
  }
  ctx.restore();
}

// paint something offscreen, flood it with a pale tint (a 'blueprint' silhouette), lay it on top
function ghostPaint(ctx, wx0, wy0, wx1, wy1, paint, col, alpha) {
  const m = ctx.getTransform();
  const sa = m.a, se = m.e, sf = m.f;
  if (!(sa > 0.05)) return;
  const cw = ctx.canvas.width, ch = ctx.canvas.height;
  const px0 = Math.max(-2, Math.floor(sa * wx0 + se)), py0 = Math.max(-2, Math.floor(sa * wy0 + sf));
  const px1 = Math.min(cw + 2, Math.ceil(sa * wx1 + se)), py1 = Math.min(ch + 2, Math.ceil(sa * wy1 + sf));
  const bw = px1 - px0, bh = py1 - py0;
  if (bw < 2 || bh < 2 || bw > 4096 || bh > 4096 || !ensureBuf(bw, bh)) return;
  const g = BUF.mg;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
  g.clearRect(0, 0, bw + 2, bh + 2);
  g.setTransform(sa, 0, 0, sa, se - px0, sf - py0);
  g.lineCap = 'round'; g.lineJoin = 'round';
  g.save(); paint(g); g.restore();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = css(col, 0.72); g.fillRect(0, 0, bw, bh);
  g.globalCompositeOperation = 'source-over';
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = clamp(alpha, 0, 1);
  ctx.drawImage(BUF.m, 0, 0, bw, bh, px0, py0, bw, bh);
  ctx.restore();
}

function ghostOutline(ctx, x, y, w, h, col, pulse, sc, t) {
  ctx.save();
  ctx.strokeStyle = 'rgba(10,14,22,0.45)';
  ctx.lineWidth = 3 / sc;
  roundRect(ctx, x, y, w, h, 2);
  ctx.stroke();
  ctx.strokeStyle = css(col, 0.55 + 0.35 * pulse);
  ctx.lineWidth = 1.2 / sc;
  ctx.setLineDash([4 / sc, 3 / sc]);
  ctx.lineDashOffset = -t * 12 / sc;
  roundRect(ctx, x, y, w, h, 2);
  ctx.stroke();
  ctx.setLineDash([]);
  // corner ticks
  ctx.lineWidth = 1.9 / sc;
  ctx.strokeStyle = css(col, 0.95);
  const c = 3;
  ctx.beginPath();
  ctx.moveTo(x, y + c); ctx.lineTo(x, y); ctx.lineTo(x + c, y);
  ctx.moveTo(x + w - c, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + c);
  ctx.moveTo(x, y + h - c); ctx.lineTo(x, y + h); ctx.lineTo(x + c, y + h);
  ctx.moveTo(x + w - c, y + h); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w, y + h - c);
  ctx.stroke();
  ctx.restore();
}

function drawLabel(ctx, G, x, y, name, segs, note, sc) {
  const fs = 12.5 / sc, fs2 = 10.5 / sc;
  ctx.save();
  ctx.textBaseline = 'middle';
  ctx.font = `600 ${fs.toFixed(2)}px ${FONT}`;
  const nameW = ctx.measureText(name).width;
  ctx.font = `${fs2.toFixed(2)}px ${FONT}`;
  const gap = 6 / sc;
  const segW = segs.map((s) => ctx.measureText(s[0]).width);
  const costW = segW.reduce((a, b) => a + b, 0) + Math.max(0, segs.length - 1) * gap;
  const noteW = note ? ctx.measureText(note).width : 0;
  const line1 = nameW + (segs.length ? gap * 1.6 + costW : 0);
  const W = Math.max(line1, noteW) + 14 / sc;
  const H = (note ? fs * 1.35 + fs2 * 1.45 : fs * 1.45) + 6 / sc;
  // keep the label on screen
  const v = G.view;
  const left = v.left + 4 / sc, right = v.left + v.w - 4 / sc, topLim = v.top + 4 / sc;
  let bx = clamp(x - W / 2, left, Math.max(left, right - W));
  let by = Math.max(topLim, y - H);
  ctx.fillStyle = 'rgba(8,10,16,0.62)';
  roundRect(ctx, bx, by, W, H, 3 / sc); ctx.fill();
  ctx.strokeStyle = 'rgba(236,228,210,0.18)'; ctx.lineWidth = 1 / sc; ctx.stroke();
  let cx = bx + 7 / sc;
  const y1 = by + 3 / sc + fs * 0.72;
  ctx.font = `600 ${fs.toFixed(2)}px ${FONT}`;
  ctx.fillStyle = 'rgba(250,244,230,0.98)';
  ctx.textAlign = 'left';
  ctx.fillText(name, cx, y1);
  cx += nameW + gap * 1.6;
  ctx.font = `${fs2.toFixed(2)}px ${FONT}`;
  segs.forEach((s, k) => { ctx.fillStyle = s[1]; ctx.fillText(s[0], cx, y1 + 0.5 / sc); cx += segW[k] + gap; });
  if (note) {
    ctx.fillStyle = 'rgba(205,200,190,0.8)';
    ctx.fillText(note, bx + 7 / sc, y1 + fs * 0.62 + fs2 * 0.9);
  }
  ctx.restore();
}

// shimmering warm streaks on the water under the lamp / fire
function drawReflections(ctx, G, r) {
  const night = 1 - smoothstep(0.15, 0.6, G.light || 0);
  if (night < 0.05) return;
  const t = G.time || 0;
  const src = [];
  if (r.lampPos) src.push([r.lampPos.x, 1, 11]);
  if (r.grillPos) src.push([r.grillPos.x, 0.6, 6]);
  if (!src.length) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const [x, a0, n] of src) {
    if (!onScreen(G, x, 0, 60)) continue;
    for (let k = 0; k < n; k++) {
      const u = k / n;
      const wx = x + Math.sin(t * 1.7 + k * 1.9) * (1.5 + u * 5) + (noise1(t * 0.9 + k * 3.3, 21) - 0.5) * 6;
      const yy = wy(G, wx) + 0.8 + k * 2.4 + Math.sin(t * 2.3 + k) * 0.4;
      const w = (3 + u * 9) * (0.5 + noise1(t * 2.2 + k * 1.7, 13));
      const a = a0 * night * 0.5 * (1 - u) * (0.6 + 0.4 * Math.sin(t * 6 + k * 2.7));
      if (a <= 0.01) continue;
      ctx.fillStyle = `rgba(255,${(170 + 30 * (1 - u)) | 0},100,${a.toFixed(3)})`;
      ctx.fillRect(wx - w / 2, yy, w, 0.7);
    }
  }
  ctx.restore();
}
