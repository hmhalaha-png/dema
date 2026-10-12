// 少年与海 — ocean life and wonders (worker: LIFE).
//
//   fish schools (G.fish)  simple boids that flee the swimming boy and die to the spear;
//                           at night a school of lanternfish glows and circles his lantern
//   the shark              circles the raft with its fin cutting the surface, stalks and
//                           lunges at the boy in the water, now and then bites a raft edge
//   wonders                a scheduler for rare set pieces: seagulls, flying fish, dolphins,
//                           an old turtle, a manta, a whale passing under the raft (day);
//                           a jellyfish bloom, glowing plankton, a whale breaching against
//                           the moon, the leviathan on the horizon, a ghost ship in the fog
//                           (night); the angler and the eye in the seabed (deep)
//
// All art is painted procedurally; anything static is baked once into offscreen sprites.
// Exports (CONTRACT §5): init, update, drawHorizon, drawDeep, draw, debugSpawn.

import { C, discover, say } from '../core/state.js';
import { waterY, seabedY, onScreen, addLight, screenToWorld } from '../core/world.js';
import { emit } from '../core/particles.js';
import { TAU, clamp, lerp, smoothstep, rand, randi, pick, chance, hash1, noise1, makeCanvas, mixColor, gradientAt } from '../core/util.js';
import { addItem } from '../systems/inventory.js';
import { sfx } from '../systems/audio.js';
import { hurtPlayer } from './player.js';
import * as islands from '../systems/islands.js';
import { celestial } from '../render/sky.js';
import { spawnDebrisNear } from './debris.js';

// =====================================================================================
// small helpers
// =====================================================================================

const GLOW_CYAN = [110, 220, 255];
const sgn = (v) => (v < 0 ? -1 : 1);
const viewW = (G) => Math.max(720, (G.view && G.view.w > 2) ? G.view.w : 960);
const raftLen = (G) => ((G.raft && G.raft.tiles && G.raft.tiles.length) || 1) * C.TILE_W;
const raftMid = (G) => (isFinite(G.raft.x) ? G.raft.x : 0) + raftLen(G) / 2;
const wy = (G, x) => { const y = waterY(G, x); return isFinite(y) ? y : 0; };
const isDark = (G) => G.light < 0.3;

function islandGround(G, x) {
  let g = null;
  try { g = islands.groundAt(G, x); } catch (e) { g = null; }
  return g != null && isFinite(g) ? g : null;
}
// Lowest point a swimmer can reach at x: the seabed, or an island's underwater slope.
function floorAt(G, x) {
  let f = seabedY(G, x);
  if (!isFinite(f)) f = 800;
  const g = islandGround(G, x);
  return g != null && g < f ? g : f;
}

function playerInWater(G) {
  const P = G.player;
  if (!P || !isFinite(P.x) || !isFinite(P.y)) return false;
  if (typeof P.inWater === 'boolean') return P.inWater;
  if (typeof P.swimming === 'boolean') return P.swimming;
  if (P.state === 'swim' || P.state === 'dive') return true;
  return P.y > wy(G, P.x) + 3;
}

// Where the boy is this step (in the title demo: a point on the raft).
function boyInfo(G) {
  const P = G.player, L = G.life;
  const live = !G.demo && G.mode === 'play' && P && isFinite(P.x) && isFinite(P.y);
  const x = live ? P.x : raftMid(G), y = live ? P.y : -C.DECK_H;
  const inWater = live && playerInWater(G);
  const dt = G.dt || 1 / 60;
  const vx = L.bx == null ? 0 : (x - L.bx) / dt, vy = L.by == null ? 0 : (y - L.by) / dt;
  L.bx = x; L.by = y;
  return {
    live, x, y, cx: x, cy: y - 10, inWater,
    speed: Math.min(400, Math.hypot(vx, vy)),
    lantern: P && typeof P.lantern === 'boolean' ? P.lantern : (G.inv && G.inv.lantern > 0) && (isDark(G) || y > 120),
    deep: y > 230,
  };
}

function spearHits(G) {
  const out = [];
  for (const h of G.hits || []) {
    if (!h || !isFinite(h.x) || !isFinite(h.y)) continue;
    if (h.kind === 'spear' || h.kind === 'harpoon' || h.kind === 'stab') out.push(h);
  }
  return out;
}

function inView(G, x, y, inset = 10) {
  const v = G.view;
  return x > v.left + inset && x < v.left + v.w - inset && y > v.top + inset && y < v.top + v.h - inset;
}
function rectInView(G, x0, y0, x1, y1) {
  const v = G.view;
  return x1 > v.left && x0 < v.left + v.w && y1 > v.top && y0 < v.top + v.h;
}
function see(G, c, id) {
  if (c.seen) return;
  c.seen = true;
  discover(G, id);
}

// Is (x, y) inside island soil? (dry land columns, or below an island's underwater slope)
function inSoil(G, x, y) {
  const g = islandGround(G, x);
  return g != null && g < y;
}
// Is x a dry-land column: island ground standing above the water line?
function dryLand(G, x) {
  const g = islandGround(G, x);
  return g != null && g < wy(G, x) + 1;
}

function bubbles(G, x, y, n, spread = 6, size = 1.5) {
  for (let i = 0; i < n; i++) {
    const bx = x + rand(-spread, spread), by = y + rand(-spread, spread) * 0.6;
    if (inSoil(G, bx, by)) continue;
    emit(G, { x: bx, y: by, vx: rand(-6, 6), vy: rand(-36, -16), life: rand(1, 2.4), size: rand(size * 0.5, size * 1.3), kind: 'bubble', color: [215, 238, 248], alpha: 0.75, water: 'below' });
  }
}
function splash(G, x, n, power = 1) {
  if (dryLand(G, x)) return;
  const y = wy(G, x);
  for (let i = 0; i < n; i++) {
    const sx = x + rand(-6, 6) * power;
    if (i && dryLand(G, sx)) continue;
    emit(G, { x: sx, y: y - 1, vx: rand(-40, 40) * power, vy: rand(-120, -40) * power, life: rand(0.5, 1.0), size: rand(1, 2.4), gravity: 300, color: [232, 244, 248], alpha: 0.85, water: 'above' });
  }
  for (let i = 0; i < Math.ceil(n / 3); i++) {
    const bx = x + rand(-8, 8) * power, by = y + rand(2, 6);
    if (inSoil(G, bx, by)) continue;
    emit(G, { x: bx, y: by, vx: rand(-10, 10), vy: rand(-12, 4), life: rand(0.8, 1.6), size: rand(1, 2), kind: 'bubble', color: [220, 240, 250], alpha: 0.7, water: 'below' });
  }
}

// =====================================================================================
// state
// =====================================================================================

export function init(G) {
  G.fish = [];
  G.creatures = [];
  if (!G.persist) G.persist = { islands: {}, flags: {} };
  const PL = G.persist.life || (G.persist.life = {});
  if (typeof PL.levDay !== 'number') PL.levDay = -9;
  if (typeof PL.shipDay !== 'number') PL.shipDay = -9;
  if (typeof PL.whaleDay !== 'number') PL.whaleDay = -9;
  G.life = {
    t: 0, schools: [], sid: 1,
    cool: G.demo ? rand(4, 8) : rand(40, 70),   // until the next scheduled wonder
    gullT: G.demo ? 2 : rand(5, 9),
    sharkT: G.demo ? 0 : rand(30, 50),
    eyeCool: rand(8, 20), anglerCool: rand(15, 30), shipCheck: 4,
    stingCd: 0, last: null, bx: null, by: null, boy: null,
    nightPlankton: -1,
  };
  G.life.boy = boyInfo(G);
  for (let i = 0; i < (G.demo ? 3 : 5); i++) spawnSchool(G, null, true);
}

// =====================================================================================
// fish schools
// =====================================================================================

// L: length, H: height (world units); depth band; n: school size; speed: cruising speed
export const SPECIES = {
  sardine:  { L: 10.5, H: 2.8, depth: [60, 260], n: [9, 12], speed: 28, w: 4 },
  tang:     { L: 11.5, H: 5.4, depth: [60, 300], n: [5, 8], speed: 22, w: 3 },
  snapper:  { L: 15, H: 4.9, depth: [110, 440], n: [5, 8], speed: 21, w: 3 },
  mackerel: { L: 16, H: 3.7, depth: [80, 480], n: [6, 10], speed: 32, w: 3 },
  lantern:  { L: 9.5, H: 3.1, depth: [50, 460], n: [8, 11], speed: 22, w: 0, glow: true },
};
const DAY_SPECIES = Object.keys(SPECIES).filter((k) => SPECIES[k].w > 0);
function pickSpecies() {
  let tot = 0;
  for (const k of DAY_SPECIES) tot += SPECIES[k].w;
  let r = Math.random() * tot;
  for (const k of DAY_SPECIES) { r -= SPECIES[k].w; if (r <= 0) return k; }
  return 'sardine';
}

function spawnSchool(G, species, initial, at) {
  const L = G.life, B = L.boy || boyInfo(G);
  const W = viewW(G);
  if (!species) {
    const lanterns = L.schools.filter((s) => s.sp === 'lantern').length;
    species = isDark(G) && lanterns === 0 ? 'lantern' : (isDark(G) && lanterns < 2 && chance(0.3) ? 'lantern' : pickSpecies());
  }
  const sp = SPECIES[species];
  const side = chance(0.5) ? 1 : -1;
  let x = at ? at.x : initial ? B.x + rand(-W * 0.65, W * 0.65) : B.x + side * (W * 0.55 + rand(40, 260));
  let y;
  if (at) y = at.y;
  else if (B.y < 30) y = rand(Math.max(55, sp.depth[0]), Math.min(sp.depth[1], 210));
  else y = clamp(B.y + rand(-170, 170), sp.depth[0], sp.depth[1]);
  const fl = floorAt(G, x);
  if (fl < 45) return null;
  y = clamp(y, 24, fl - 22);
  const n = randi(sp.n[0], sp.n[1]);
  const dir = at && at.dir ? at.dir : (x > B.x ? -1 : 1) * (chance(0.8) ? 1 : -1);
  const s = { id: L.sid++, sp: species, fish: [], cx: x, cy: y, dir, depth: y, wt: Math.random() * 100, turnT: rand(6, 14), panic: 0, orbit: 0, seen: false };
  for (let i = 0; i < n; i++) {
    s.fish.push({
      x: x + rand(-16, 16), y: y + rand(-9, 9), vx: dir * sp.speed * rand(0.7, 1.1), vy: rand(-3, 3),
      ph: Math.random() * 10, face: dir, size: rand(0.85, 1.15), sp: species, school: s.id, fear: 0,
    });
  }
  L.schools.push(s);
  return s;
}

function updateSchools(G, dt, B) {
  const L = G.life, W = viewW(G);
  const dark = isDark(G);
  const want = G.demo ? 3 : (B.y > 40 ? 7 : 6);
  for (let i = L.schools.length - 1; i >= 0; i--) {
    const s = L.schools[i];
    if (s.fish.length < 2 && !onScreen(G, s.cx, s.cy, 40)) { L.schools.splice(i, 1); continue; }
    const far = Math.abs(s.cx - B.x) > W * 1.4 || Math.abs(s.cy - B.y) > 1000;
    const offView = !onScreen(G, s.cx, s.cy, 120);
    // lanternfish only by night; at night make room for one lantern school
    const wrong = s.sp === 'lantern' && !dark && offView;
    if (far || wrong || !s.fish.length) L.schools.splice(i, 1);
  }
  if (dark && !L.schools.some((s) => s.sp === 'lantern')) {
    const j = L.schools.findIndex((s) => !onScreen(G, s.cx, s.cy, 120));
    if (j >= 0 && L.schools.length >= want) L.schools.splice(j, 1);
  }
  let guard = 0;
  while (L.schools.length < want && guard++ < 2) spawnSchool(G);

  // spear hits: one fish per hit
  const hits = spearHits(G);
  for (const h of hits) {
    let best = null, bs = null, bd = 1e9;
    for (const s of L.schools) {
      if (Math.abs(s.cx - h.x) > 80 || Math.abs(s.cy - h.y) > 80) continue;
      for (const f of s.fish) {
        const d = Math.hypot(f.x - h.x, f.y - h.y);
        if (d < (h.r || 10) + SPECIES[f.sp].L * 0.45 && d < bd) { bd = d; best = f; bs = s; }
      }
    }
    if (best) catchFish(G, bs, best);
  }

  G.fish.length = 0;
  for (const s of L.schools) {
    stepSchool(G, s, dt, B);
    for (const f of s.fish) G.fish.push(f);
  }
}

function catchFish(G, s, f) {
  s.fish.splice(s.fish.indexOf(f), 1);
  s.panic = 3;
  if (!G.demo) {
    try { addItem(G, 'raw_fish', 1); } catch (e) { G.inv.raw_fish = (G.inv.raw_fish || 0) + 1; }
    sfx('fishcatch');
  }
  bubbles(G, f.x, f.y, 6, 4, 1.6);
  for (let i = 0; i < 7; i++) {
    emit(G, { x: f.x, y: f.y, vx: rand(-40, 40), vy: rand(-40, 30), life: rand(0.5, 1.1), size: rand(0.6, 1.3), drag: 3, color: f.sp === 'lantern' ? GLOW_CYAN : [225, 236, 240], alpha: 0.9, kind: f.sp === 'lantern' ? 'glow' : 'dot', water: 'below' });
  }
}

const FLEE_R = 60, FLEE_SPEED = 20, FLEE_CLOSE = 32, PANIC_MAX = 52;   // the boy swims 64 u/s
function stepSchool(G, s, dt, B) {
  const sp = SPECIES[s.sp], fish = s.fish, n = fish.length;
  if (!n) return;
  const W = viewW(G);
  let cx = 0, cy = 0, avx = 0, avy = 0;
  for (const f of fish) { cx += f.x; cy += f.y; avx += f.vx; avy += f.vy; }
  cx /= n; cy /= n; avx /= n; avy /= n;
  s.cx = cx; s.cy = cy;
  s.wt += dt;
  s.panic = Math.max(0, s.panic - dt);
  const fl = floorAt(G, cx);

  // where the school wants to be
  let tx, ty;
  const lanternCall = s.sp === 'lantern' && B.inWater && B.lantern && Math.hypot(cx - B.cx, cy - B.cy) < 280;
  if (lanternCall) {
    s.orbit += dt * 0.8;
    tx = B.cx + Math.cos(s.orbit) * 42;
    ty = B.cy + Math.sin(s.orbit) * 26;
  } else {
    s.turnT -= dt;
    // stay around the boy: turn back when straying, sometimes turn on a whim
    if ((s.dir > 0 && cx > B.x + W * 0.75) || (s.dir < 0 && cx < B.x - W * 0.75)) s.dir = -s.dir, s.turnT = rand(8, 16);
    else if (s.turnT <= 0) { s.turnT = rand(7, 16); if (chance(0.45)) s.dir = -s.dir; }
    s.depth += (noise1(s.wt * 0.11, s.id * 3.1) - 0.5) * 24 * dt;
    s.depth = clamp(s.depth, sp.depth[0], Math.min(sp.depth[1], fl - 25));
    tx = cx + s.dir * 70;
    ty = s.depth + Math.sin(s.wt * 0.4 + s.id) * 14;
  }
  // panic: the whole school bolts away from the boy
  if (s.panic > 0 && B.inWater) {
    const dx = cx - B.cx, dy = cy - B.cy, d = Math.hypot(dx, dy) || 1;
    tx = cx + (dx / d) * 120; ty = cy + (dy / d) * 60;
  }
  const t = G.time;
  const sepR = sp.L * 1.15;
  // Fish shy away from a swimming boy, but a still or slowly gliding diver can get within a
  // spear's reach; once they bolt they are only a little slower than he is.
  const fleeR = FLEE_R;
  const cruise = sp.speed * (lanternCall ? 1.1 : 1);
  for (let i = 0; i < n; i++) {
    const f = fish[i];
    let ax = (cx - f.x) * 0.9 + (avx - f.vx) * 1.1 + (tx - f.x) * 0.45;
    let ay = (cy - f.y) * 0.9 + (avy - f.vy) * 1.1 + (ty - f.y) * 0.45;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const o = fish[j];
      const dx = f.x - o.x, dy = f.y - o.y;
      if (dx > sepR || dx < -sepR || dy > sepR || dy < -sepR) continue;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      if (d < sepR) { const k = (sepR - d) * 9 / d; ax += dx * k; ay += dy * k * 1.4; }
    }
    ax += Math.sin(t * 1.7 + f.ph * 3) * 14;
    ay += Math.cos(t * 1.3 + f.ph * 5) * 9;
    if (B.inWater) {
      const dx = f.x - B.cx, dy = f.y - B.cy;
      if (dx < fleeR && dx > -fleeR && dy < fleeR && dy > -fleeR) {
        const d = Math.hypot(dx, dy) || 1;
        if (d < fleeR && (B.speed > FLEE_SPEED || d < FLEE_CLOSE)) {
          const k = (1 - d / fleeR) * 1100;
          ax += (dx / d) * k; ay += (dy / d) * k;
          s.panic = Math.max(s.panic, 1.2);
        }
      }
    }
    const fy = floorAt(G, f.x);
    const surf = wy(G, f.x) + 14;
    if (f.y < surf + 10) ay += (surf + 10 - f.y) * 9;
    if (f.y > fy - 16) ay -= (f.y - fy + 16) * 9;
    f.vx += ax * dt; f.vy += ay * dt;
    f.vy *= 1 - Math.min(1, dt * 1.2);
    const maxS = s.panic > 0 ? Math.min(cruise * 3.4, PANIC_MAX) : cruise * 1.5, minS = cruise * 0.35;
    const spd = Math.hypot(f.vx, f.vy) || 0.01;
    if (spd > maxS) { f.vx *= maxS / spd; f.vy *= maxS / spd; } else if (spd < minS) { f.vx *= minS / spd; f.vy *= minS / spd; }
    f.x += f.vx * dt; f.y += f.vy * dt;
    if (f.y < surf) f.y = surf;
    f.ph += dt * (5 + spd * 0.22);
    if (f.vx > 5) f.face = 1; else if (f.vx < -5) f.face = -1;
  }
  // a lanternfish school glows
  if (s.sp === 'lantern') {
    const k = 0.5 + 0.12 * Math.sin(t * 2.1 + s.id);
    if (onScreen(G, cx, cy, 90)) addLight(G, cx, cy, 58, GLOW_CYAN, k);
    if (lanternCall) addLight(G, B.cx + Math.cos(s.orbit + 2) * 30, B.cy + Math.sin(s.orbit + 2) * 18, 34, [150, 235, 255], 0.35);
    if (!s.seen && inView(G, cx, cy, 30) && (G.light < 0.5 || B.y > 300)) { s.seen = true; discover(G, 'lanternfish'); }
  }
}

// =====================================================================================
// the shark
// =====================================================================================

const SHARK_L = 96;
const LAMP_PATROL = 250;   // patrol radius past the raft ends while the raft lamp is lit at night
const LAMP_CLEAR = 190;    // jellyfish keep this far from the raft ends while the lamp is lit

// Is the raft's lamp burning in the dark? (it keeps night things away from the raft)
const lampGuarding = (G) => !!(G.raft && G.raft.lampLit) && isDark(G);

function makeShark(G, x, y, dir) {
  return {
    kind: 'shark', layer: 'main', x, y, dir, face: dir, pitch: 0, speed: 40,
    state: 'patrol', st: 0, hp: 3, invuln: 0, flash: 0, side: dir, depthT: rand(4, 9), surf: chance(0.5),
    biteT: G.demo ? 1e9 : rand(60, 90), cd: 4, orbit: 0, hidden: false, fleeT: 0, seen: false,
    tail: 0, bit: false, wakeT: 0,
  };
}

function updShark(G, c, dt, B) {
  const R = G.raft;
  const mid = raftMid(G), half = raftLen(G) / 2;
  const W = viewW(G);
  c.st += dt;
  c.invuln = Math.max(0, c.invuln - dt);
  c.flash = Math.max(0, c.flash - dt * 3);
  c.cd = Math.max(0, c.cd - dt);

  if (c.hidden) {
    c.fleeT -= dt;
    if (c.fleeT <= 0) {
      const side = chance(0.5) ? -1 : 1;
      Object.assign(c, { hidden: false, state: 'patrol', st: 0, hp: 3, x: mid + side * (W * 0.75), y: 60, dir: -side, face: -side, speed: 50, biteT: rand(60, 90) });
    }
    return;
  }

  // shallow water around the raft (beached at an island): keep to the deep behind it
  const shallow = floorAt(G, mid) < 130;
  // a lit lamp on the raft at night keeps the shark out of its light: it circles wider and
  // never bites the raft; in the dark without a lamp it grows bolder
  const lampGuard = lampGuarding(G);
  const home = shallow ? mid - W * 0.6 : mid;
  const sx = c.x + c.face * SHARK_L * 0.44 * Math.cos(c.pitch), sy = c.y + Math.sin(c.pitch) * SHARK_L * 0.44;
  const boyD = Math.hypot(B.cx - c.x, B.cy - c.y);
  const boyNear = B.inWater && boyD < 460 && floorAt(G, B.x) > 70;

  // spear hits anywhere along the body
  if (c.invuln <= 0) {
    for (const h of spearHits(G)) {
      const ax = c.x - c.face * SHARK_L * 0.45, bx = c.x + c.face * SHARK_L * 0.45;
      const lo = Math.min(ax, bx), hi = Math.max(ax, bx);
      const px = clamp(h.x, lo, hi);
      if (Math.hypot(h.x - px, h.y - c.y) < (h.r || 10) + 11) {
        c.hp--; c.invuln = 0.7; c.flash = 1;
        bubbles(G, h.x, h.y, 10, 6, 1.8);
        G.shake = (G.shake || 0) + 0.15;
        if (c.hp <= 0) {
          c.state = 'flee'; c.st = 0;
          if (!G.demo) say(G, '鲨鱼被赶跑了，暂时不会回来。', 'info');
        } else { c.state = 'retreat'; c.st = 0; }
        break;
      }
    }
  }

  let tx = c.x, ty = c.y, want = 40;
  switch (c.state) {
    case 'patrol': {
      c.depthT -= dt;
      if (c.depthT <= 0) { c.depthT = rand(5, 11); c.surf = chance(0.55); }
      const R0 = half + (lampGuard ? LAMP_PATROL : 120);
      if ((c.side > 0 && c.x > home + R0 - 25) || (c.side < 0 && c.x < home - R0 + 25)) c.side = -c.side;
      tx = home + c.side * (R0 + 40);
      ty = c.surf ? 17 : 52 + Math.sin(c.st * 0.3) * 30;
      want = c.surf ? 36 : 44;
      if (lampGuard) c.biteT = Math.max(c.biteT, 30);
      else c.biteT -= dt * (isDark(G) ? 1.7 : 1);
      if (boyNear && c.cd <= 0) { c.state = 'stalk'; c.st = 0; c.orbit = Math.atan2(c.y - B.cy, c.x - B.cx); }
      else if (c.biteT <= 0 && !shallow && !B.inWater && G.mode === 'play' && R.tiles && R.tiles.length >= 2 && G.time > 100) {
        c.state = 'biteGo'; c.st = 0; c.biteSide = c.x < mid ? -1 : 1; c.bit = false;
      }
      break;
    }
    case 'stalk': {
      if (!boyNear) { c.state = 'patrol'; c.st = 0; break; }
      c.orbit += dt * 0.55 * c.dir;
      tx = B.cx + Math.cos(c.orbit) * 115;
      ty = clamp(B.cy + Math.sin(c.orbit) * 45, 20, floorAt(G, B.cx) - 30);
      want = 55;
      if (c.st > 3.5 && boyD < 230 && boyD > 60 && chance(dt * 0.9)) { c.state = 'lunge'; c.st = 0; sfx('shark'); }
      break;
    }
    case 'lunge': {
      tx = B.cx; ty = B.cy; want = 235;
      const md = Math.hypot(B.cx - sx, B.cy - sy);
      if (B.inWater && md < 20) {
        try { hurtPlayer(G, 18, c.x, 'shark'); } catch (e) { /* player not ready */ }
        G.shake = (G.shake || 0) + 0.35;
        bubbles(G, sx, sy, 14, 8, 2);
        c.state = 'retreat'; c.st = 0; c.cd = rand(6, 9);
      } else if (c.st > 1.5 || !B.inWater) { c.state = 'retreat'; c.st = 0; c.cd = rand(3, 5); }
      break;
    }
    case 'retreat': {
      const away = sgn(c.x - B.cx) || c.dir;
      tx = c.x + away * 200; ty = Math.min(floorAt(G, c.x) - 40, 150);
      want = 120;
      if (c.st > 3.2) { c.state = 'patrol'; c.st = 0; c.cd = Math.max(c.cd, 4); }
      break;
    }
    case 'flee': {
      const away = sgn(c.x - mid) || 1;
      tx = c.x + away * 400; ty = Math.min(floorAt(G, c.x) - 40, 320);
      want = 190;
      if (c.st > 2 && !onScreen(G, c.x, c.y, SHARK_L)) { c.hidden = true; c.fleeT = 60; }
      if (c.st > 12) { c.hidden = true; c.fleeT = 60; }
      break;
    }
    case 'biteGo': {
      if (boyNear) { c.state = 'stalk'; c.st = 0; break; }
      if (lampGuard) { c.state = 'patrol'; c.st = 0; c.biteT = rand(30, 50); break; }
      const edge = c.biteSide < 0 ? R.x : R.x + raftLen(G);
      tx = edge + c.biteSide * (SHARK_L * 0.9); ty = 34; want = 60;
      if (Math.abs(c.x - tx) < 26 || c.st > 14) { c.state = 'biteRush'; c.st = 0; }
      break;
    }
    case 'biteRush': {
      if (lampGuard) { c.state = 'retreat'; c.st = 0; c.biteT = rand(30, 50); break; }
      const edge = c.biteSide < 0 ? R.x : R.x + raftLen(G);
      tx = edge - c.biteSide * 6; ty = 7; want = 130;
      if (Math.abs(sx - edge) < 9 || c.st > 3) {
        c.state = 'chomp'; c.st = 0; c.bit = false;
        c.dir = -c.biteSide;
      }
      break;
    }
    case 'chomp': {
      const edge = c.biteSide < 0 ? R.x : R.x + raftLen(G);
      c.face += (c.dir - c.face) * Math.min(1, dt * 8);
      c.x += (edge + c.biteSide * SHARK_L * 0.4 - c.x) * Math.min(1, dt * 6);
      c.y += (10 + Math.sin(c.st * 26) * 1.6 - c.y) * Math.min(1, dt * 8);
      c.pitch = -0.22 + Math.sin(c.st * 21) * 0.14;
      c.tail += dt * 22;
      if (chance(dt * 20)) splash(G, edge + c.biteSide * rand(0, 14), 2, 0.8);
      if (!c.bit && c.st > 0.35) {
        c.bit = true;
        const tiles = R.tiles;
        const tile = c.biteSide < 0 ? tiles[0] : tiles[tiles.length - 1];
        if (tile && isFinite(tile.hp)) tile.hp -= 25;
        sfx('shark');
        G.shake = (G.shake || 0) + 0.4;
        splash(G, edge, 10, 1.2);
        if (!G.demo) say(G, '鲨鱼在啃木筏的边缘！', 'warn');
      }
      if (c.st > 1.4) { c.state = 'retreat'; c.st = 0; c.biteT = rand(60, 90); c.cd = 3; }
      return finishShark(G, c, dt);
    }
  }

  // steering: turn around through a squash (a 2.5D turn), pitch toward the target
  const dx = tx - c.x, dy = ty - c.y;
  if (Math.abs(dx) > 24) c.dir = sgn(dx);
  c.face += clamp(c.dir - c.face, -dt * 2.2, dt * 2.2);
  const pt = clamp(Math.atan2(dy, Math.max(40, Math.abs(dx))), -0.5, 0.5);
  c.pitch += (pt - c.pitch) * Math.min(1, dt * 2.2);
  c.speed += clamp(want - c.speed, -dt * 160, dt * (c.state === 'lunge' ? 600 : 90));
  const turnSlow = 0.35 + 0.65 * Math.abs(c.face);
  c.x += c.face * Math.cos(c.pitch) * c.speed * dt * turnSlow;
  c.y += Math.sin(c.pitch) * c.speed * dt;
  c.tail += dt * (2.5 + c.speed * 0.06);
  return finishShark(G, c, dt);
}

function finishShark(G, c, dt) {
  // stay in the water column
  const fl = floorAt(G, c.x);
  const minY = c.state === 'chomp' ? 6 : 14;
  if (c.y < minY) c.y += (minY - c.y) * Math.min(1, dt * 6);
  if (c.y > fl - 26) c.y = fl - 26;
  // the dorsal fin cutting the surface leaves a wake
  const finY = c.y - 24;
  if (finY < wy(G, c.x) && Math.abs(c.speed) > 20) {
    c.wakeT -= dt;
    if (c.wakeT <= 0 && onScreen(G, c.x, 0, 40)) {
      c.wakeT = 0.06;
      emit(G, { x: c.x + c.face * 2, y: wy(G, c.x) - 0.5, vx: -c.face * rand(10, 30), vy: rand(-25, -8), life: rand(0.3, 0.7), size: rand(0.8, 1.6), gravity: 120, color: [235, 245, 250], alpha: 0.8, water: 'above' });
    }
  }
  if (!c.seen && inView(G, c.x, c.y - 10, 20) && (c.y < 140 || G.light > 0.4)) see(G, c, 'shark');
}

// =====================================================================================
// wonders — spawning
// =====================================================================================

const has = (G, kind) => G.creatures.some((c) => c.kind === kind && !c.dead);
const stormy = (G) => { const W = G.weather || {}; return W.kind === 'storm' || W.kind === 'rain' || (W.rain || 0) > 0.4; };
const MAJOR = { flying_fish: 1, dolphin: 1, turtle: 1, manta: 1, whale: 1, jelly: 1, moon_whale: 1, leviathan: 1, ghost_ship: 1 };

function spawnGulls(G, n) {
  const mid = raftMid(G);
  const birds = [];
  n = n || randi(2, 4);
  for (let i = 0; i < n; i++) {
    const w = rand(0.32, 0.5) * (chance(0.5) ? 1 : -1);
    birds.push({
      ang: rand(0, TAU), w, rx: rand(70, 170), ry: rand(18, 40), y0: rand(-90, 60), ph: rand(0, 10),
      size: rand(0.9, 1.12), flapT: rand(0, 2), flapping: chance(0.5), flap: 0, x: 0, y: 0, face: 1, gone: false,
      lx: 0, ly: 0, vx: 0, vy: 0,
    });
  }
  const c = { kind: 'gulls', layer: 'main', birds, t: 0, dur: rand(50, 85), cx: mid + rand(-60, 60), cy: -228, seen: false, leaving: false };
  // start already circling, but enter from the sky above the frame
  for (const b of birds) { placeGull(c, b, 0); b.y -= 260; b.enter = 1; }
  G.creatures.push(c);
  return c;
}

function placeGull(c, b, t) {
  const x = c.cx + Math.cos(b.ang) * b.rx;
  const y = c.cy + b.y0 + Math.sin(b.ang) * b.ry + Math.sin(t * 0.7 + b.ph) * 7;
  b.x = x; b.y = y;
}

function spawnFlyingFish(G, dir, x0) {
  dir = dir || (chance(0.5) ? 1 : -1);
  const W = viewW(G);
  const fish = [];
  x0 = x0 != null ? x0 : G.cam.x - dir * (W * 0.5 + 40);
  const n = randi(10, 15);
  for (let i = 0; i < n; i++) {
    fish.push({ x: x0 - dir * rand(0, 220), y: rand(12, 34), vx: dir * rand(125, 150), vy: 0, mode: 'swim', delay: rand(0, 2.4) + i * 0.08, skips: randi(1, 2), ang: 0, s: rand(0.85, 1.12), ph: rand(0, 6) });
  }
  const c = { kind: 'flying_fish', layer: 'main', fish, t: 0, dir, seen: false, major: true };
  G.creatures.push(c);
  return c;
}

function spawnDolphins(G, dir, x0) {
  dir = dir || (chance(0.5) ? 1 : -1);
  const W = viewW(G);
  x0 = x0 != null ? x0 : G.cam.x - dir * (W * 0.55 + 80);
  const pod = [];
  const n = randi(3, 5);
  for (let i = 0; i < n; i++) {
    pod.push({ x: x0 - dir * (i * rand(40, 70)), y: rand(18, 36), vx: dir * rand(108, 124), vy: 0, mode: 'swim', leapT: rand(0.2, 2.6) + i * 0.4, rising: false, s: rand(0.82, 1.05) * (i === 0 ? 1.08 : 1), ang: 0, ph: rand(0, 6), tail: rand(0, 6) });
  }
  const c = { kind: 'dolphin', layer: 'main', pod, t: 0, dir, seen: false, major: true };
  G.creatures.push(c);
  sfx('splash');
  return c;
}

function spawnTurtle(G, dir, x) {
  dir = dir || (chance(0.5) ? 1 : -1);
  const W = viewW(G);
  const c = { kind: 'turtle', layer: 'main', x: x != null ? x : G.cam.x - dir * (W * 0.5 + 60), y: rand(48, 66), base: rand(48, 66), dir, t: 0, ph: rand(0, 6), seen: false, major: true, breathed: false };
  G.creatures.push(c);
  return c;
}

function spawnManta(G, dir, x) {
  dir = dir || (chance(0.5) ? 1 : -1);
  const W = viewW(G);
  const base = rand(84, 104);
  const c = { kind: 'manta', layer: 'main', x: x != null ? x : G.cam.x - dir * (W * 0.5 + 120), y: base, base, dir, t: 0, ph: rand(0, 6), seen: false, major: true };
  G.creatures.push(c);
  return c;
}

const WHALE_L = 560;
// The whale glides in deep and rises under the raft: its back (~65 units above its centre)
// stays below the raft's logs and the floating debris, but the giant fills the lower half
// of the frame (above the hotbar) as it passes.
const WHALE_DEEP = 265, WHALE_APEX = 104;
function spawnWhale(G, dir, x) {
  dir = dir || (chance(0.5) ? 1 : -1);
  const W = viewW(G);
  const c = { kind: 'whale', layer: 'deep', x: x != null ? x : G.cam.x - dir * (W * 0.5 + WHALE_L * 0.55), y: WHALE_DEEP, dir, t: 0, seen: false, major: true, sang: 0, fin: 0, tail: 0, pitch: 0, dark: 0 };
  G.creatures.push(c);
  G.persist.life.whaleDay = G.day;
  sfx('whale');
  return c;
}

function spawnJelly(G, near) {
  const B = G.life.boy || boyInfo(G);
  const ax = B.inWater ? B.x : raftMid(G);
  const jellies = [];
  const n = randi(11, 15);
  const cols = [[110, 220, 255], [255, 140, 220], [180, 150, 255], [140, 255, 210], [120, 200, 255]];
  // a lit raft lamp keeps the bloom out of its light
  const lamp = lampGuarding(G), mid = raftMid(G), clear = raftLen(G) / 2 + LAMP_CLEAR;
  const lit = (x) => lamp && Math.abs(x - mid) < clear;
  for (let i = 0; i < n; i++) {
    let x = ax + rand(-360, 360);
    for (let tries = 0; tries < 8 && (floorAt(G, x) < 90 || lit(x)); tries++) x = ax + rand(-360, 360);
    if (lit(x)) x = mid + (x < mid ? -1 : 1) * (clear + rand(10, 220));
    const fl = floorAt(G, x);
    if (fl < 90) continue;
    const ty = clamp(rand(28, 160), 20, fl - 40);
    jellies.push({
      x, y: near ? ty + rand(-10, 30) : ty + rand(160, 260), ty, vx: rand(-3, 3), vy: 0,
      r: rand(6, 12.5), col: pick(cols), ph: rand(0, TAU), freq: rand(1.1, 1.7), sting: 0, a: 1, hurt: false, arms: randi(4, 7),
    });
  }
  const c = { kind: 'jelly', layer: 'main', jellies, t: 0, dur: rand(85, 115), seen: false, major: true };
  G.creatures.push(c);
  return c;
}

function spawnPlankton(G) {
  const c = { kind: 'plankton', layer: 'main', t: 0, dur: rand(95, 130), seen: false, emitAcc: 0 };
  G.creatures.push(c);
  return c;
}

function moonInfo(G) {
  try { return celestial(G); } catch (e) { return null; }
}

// The moon whale breaches right under the moon, sized and lifted so that its body rises
// across the moon's face ("它跃出水面的时候，正好挡住了月亮").
function spawnMoonWhale(G) {
  const W = G.view.cssW || 1280;
  const mb = moonBreach(G);
  const fx = mb ? clamp(mb.x / W, 0.03, 0.97) : 0.64;
  const c = {
    kind: 'moon_whale', layer: 'horizon', t: 0, dur: 11, fx, cx0: G.cam.x, side: chance(0.5) ? 1 : -1, drops: [], seen: false, major: true, hit: false, sang: false, spray: 0,
    k: mb ? mb.k : 1, lift: mb ? mb.lift : MW_LIFT0, track: !!mb,
  };
  G.creatures.push(c);
  return c;
}

function spawnLeviathan(G) {
  const cel = moonInfo(G);
  const W = G.view.cssW || 1280;
  let fx = rand(0.18, 0.82);
  if (cel && cel.moonVisible && isFinite(cel.moonX)) {
    const m = cel.moonX / W;
    if (Math.abs(fx - m) < 0.18) fx = m < 0.5 ? m + rand(0.22, 0.38) : m - rand(0.22, 0.38);
  }
  const c = { kind: 'leviathan', layer: 'horizon', t: 0, dur: 64, fx: clamp(fx, 0.1, 0.9), cx0: G.cam.x, seen: false, major: true, beat: false, look: chance(0.5) ? 1 : -1 };
  G.creatures.push(c);
  G.persist.life.levDay = G.day;
  return c;
}

function spawnGhostShip(G) {
  const dir = chance(0.5) ? 1 : -1;
  const c = { kind: 'ghost_ship', layer: 'horizon', t: 0, dur: 75, dir, fx0: dir > 0 ? -0.22 : 1.22, span: 1.44, cx0: G.cam.x, seen: false, major: true, a: 0 };
  G.creatures.push(c);
  G.persist.life.shipDay = G.day;
  return c;
}

const ANGLER_L = 120;
function spawnAngler(G, B, x, y) {
  const side = x != null ? sgn(x - B.x) : (chance(0.5) ? 1 : -1);
  x = x != null ? x : B.x + side * rand(210, 260);
  const fl = floorAt(G, x);
  y = y != null ? y : clamp(B.cy + rand(10, 80), 110, fl - 50);
  const dir = -side;
  const c = { kind: 'angler', layer: 'main', x, y, dir, face: dir, state: 'lure', st: 0, t: 0, jaw: 0, attacks: 0, lureA: 0, life: rand(50, 75), seen: false, flash: 0 };
  G.creatures.push(c);
  return c;
}

const EYE_SCALE = 1.5, EYE_LIFT = 24;
function spawnEye(G, x) {
  const y = seabedY(G, x);
  const c = { kind: 'deep_eye', layer: 'deep', x, y: y + 4, open: 0, lx: 0, ly: 0, blink: 0, blinkT: rand(3, 7), t: 0, seen: false, beat: false, seed: Math.random() * 100 };
  G.creatures.push(c);
  return c;
}

function spawnShark(G, x, y, dir) {
  const W = viewW(G);
  const side = chance(0.5) ? -1 : 1;
  const c = makeShark(G, x != null ? x : raftMid(G) + side * (W * 0.7), y != null ? y : 50, dir || -side);
  G.creatures.push(c);
  return c;
}

const STARTERS = {
  flying_fish: (G) => spawnFlyingFish(G),
  dolphin: (G) => spawnDolphins(G),
  turtle: (G) => spawnTurtle(G),
  manta: (G) => spawnManta(G),
  whale: (G) => spawnWhale(G),
  jelly: (G) => spawnJelly(G),
  plankton: (G) => spawnPlankton(G),
  moon_whale: (G) => spawnMoonWhale(G),
  leviathan: (G) => spawnLeviathan(G),
};

// =====================================================================================
// wonders — scheduler
// =====================================================================================

function scheduler(G, dt, B) {
  const L = G.life, PL = G.persist.life;
  const ph = G.phase;
  const dayTime = ph > 0.03 && ph < 0.5;

  // seagulls: the companions of every sunny day
  if (G.light > 0.55 && ph < 0.52 && !has(G, 'gulls') && !stormy(G)) {
    L.gullT -= dt;
    if (G.day === 1 && !G.codex.seagull && L.t > 5 && !G.demo) L.gullT = Math.min(L.gullT, 0);
    if (L.gullT <= 0) { spawnGulls(G); L.gullT = rand(70, 150); }
  }
  // the shark arrives a little after the start (on the title screen it is already there)
  if (!G.creatures.some((c) => c.kind === 'shark')) {
    L.sharkT -= dt;
    if (L.sharkT <= 0) spawnShark(G);
  }
  if (G.demo) {
    // the title screen: now and then something leaps at the sunset
    L.cool -= dt;
    if (L.cool <= 0 && !G.creatures.some((c) => MAJOR[c.kind])) {
      if (chance(0.5)) spawnDolphins(G); else spawnFlyingFish(G);
      L.cool = rand(25, 45);
    }
    return;
  }

  const majorActive = G.creatures.some((c) => MAJOR[c.kind] && !c.dead);

  // first-day promises: flying fish in the morning, plankton on the first night
  if (G.day === 1 && !G.codex.flying_fish && L.t > 26 && ph < 0.5 && !has(G, 'flying_fish')) {
    spawnFlyingFish(G); L.cool = Math.max(L.cool, 70); L.last = 'flying_fish';
  }
  if (!G.codex.plankton && ph > 0.67 && ph < 0.93 && !has(G, 'plankton')) spawnPlankton(G);

  // the ghost ship only sails in thick fog at night
  L.shipCheck -= dt;
  if (L.shipCheck <= 0) {
    L.shipCheck = 4;
    const fog = (G.weather && G.weather.fog) || 0;
    if (isDark(G) && fog > 0.4 && PL.shipDay !== G.day && !has(G, 'ghost_ship') && chance(0.5)) spawnGhostShip(G);
  }

  // the deep: the angler's lure and the eye in the seabed
  L.anglerCool -= dt;
  if (B.inWater && ((isDark(G) && B.y > 250) || B.y > 520) && !has(G, 'angler') && L.anglerCool <= 0 && chance(dt * 0.14)) {
    spawnAngler(G, B); L.anglerCool = rand(70, 120);
  }
  L.eyeCool -= dt;
  if (B.inWater && L.eyeCool <= 0 && !has(G, 'deep_eye') && chance(dt * 0.25)) {
    const fl = floorAt(G, B.x);
    if (fl > 360 && fl - B.y < 170) {
      const P = G.player;
      const ex = B.x + ((P && P.facing) || 1) * rand(90, 190);
      if (floorAt(G, ex) > 360 && islandGround(G, ex) == null) { spawnEye(G, ex); L.eyeCool = rand(45, 70); }
    }
  }

  // the rare set pieces: 2-4 a day
  L.cool -= dt;
  if (L.cool > 0 || majorActive) return;
  const cand = [];
  const w = (k, v) => { if (v > 0 && k !== L.last) cand.push([k, v * (G.codex[k] ? 1 : 2.5)]); };
  const deepBelow = floorAt(G, raftMid(G)) > 430 && islandGround(G, raftMid(G) + 400) == null && islandGround(G, raftMid(G) - 400) == null;
  const wet = stormy(G) ? 0.25 : 1;
  if (dayTime) {
    w('flying_fish', 3 * wet); w('dolphin', 3 * wet); w('turtle', 2.2); w('manta', 2);
    if (deepBelow && G.day - PL.whaleDay >= 2) w('whale', 1.3);
  } else if (ph >= 0.5 && ph < 0.6) {
    w('dolphin', 2); w('flying_fish', 1.4);
    if (deepBelow && G.day - PL.whaleDay >= 2) w('whale', 0.8);
  } else if (isDark(G)) {
    w('jelly', 3);
    if (!has(G, 'plankton')) w('plankton', 2.4);
    const mb = moonBreach(G);
    if (mb && mb.ok && G.view.seaScreenY > 80) w('moon_whale', mb.k < 1.5 ? 2.6 : 1.9);
    if (G.day >= 2 && G.day - PL.levDay >= 2 && G.view.seaScreenY > 120) w('leviathan', 0.9);
  }
  if (!cand.length) { L.cool = 12; return; }
  let tot = 0;
  for (const [, v] of cand) tot += v;
  let r = Math.random() * tot, pickK = cand[0][0];
  for (const [k, v] of cand) { r -= v; if (r <= 0) { pickK = k; break; } }
  STARTERS[pickK](G);
  L.last = pickK;
  L.cool = rand(110, 175);
}

// =====================================================================================
// wonders — behaviour
// =====================================================================================

function updGulls(G, c, dt) {
  c.t += dt;
  const mid = raftMid(G);
  c.cx += (mid + 20 - c.cx) * Math.min(1, dt * 0.4);
  if (c.t > c.dur || G.light < 0.4 || stormy(G)) c.leaving = true;
  let alive = 0;
  for (const b of c.birds) {
    if (b.gone) continue;
    alive++;
    const px = b.x, py = b.y;
    if (c.leaving) {
      if (!b.lv) { b.lv = 1; b.vx = (b.x > c.cx ? 1 : -1) * rand(60, 90); b.vy = rand(-30, -12); }
      b.x += b.vx * dt; b.y += b.vy * dt;
      b.face = sgn(b.vx);
      b.lvT = (b.lvT || 0) + dt;
      if (!onScreen(G, b.x, b.y, 60) && b.lvT > 1.5) b.gone = true;
      if (b.lvT > 30) b.gone = true;
    } else {
      b.ang += b.w * dt;
      placeGull(c, b, c.t);
      if (b.enter > 0) { b.enter = Math.max(0, b.enter - dt * 0.35); b.y -= 260 * b.enter * b.enter; }
      const dx = b.x - px;
      if (Math.abs(dx) > 0.01) b.face = sgn(dx);
    }
    // flap for a while, then glide
    b.flapT -= dt;
    if (b.flapT <= 0) { b.flapping = !b.flapping; b.flapT = b.flapping ? rand(0.8, 1.8) : rand(1.6, 3.6); }
    b.flap += dt * (b.flapping ? 9 : 0);
    b.vy2 = (b.y - py) / Math.max(dt, 1e-3);
  }
  if (!alive) c.dead = true;
  if (!c.seen && c.birds.some((b) => !b.gone && inView(G, b.x, b.y, 10))) see(G, c, 'seagull');
}

function updFlyingFish(G, c, dt) {
  c.t += dt;
  const W = viewW(G);
  let alive = 0;
  let anyAir = false;
  for (const f of c.fish) {
    if (f.gone) continue;
    alive++;
    if (f.delay > 0) { f.delay -= dt; continue; }
    const w = wy(G, f.x);
    // an island in the way: the fish slips away under the water (gone) instead of flying,
    // swimming or splashing inside the soil — in the water at a dry-land column or at an
    // underwater slope, or coming down onto the ground in the air
    const g = islandGround(G, f.x);
    if (g != null && (f.y > g - 3 || (f.mode !== 'air' && g < w + 1))) { f.gone = true; continue; }
    if (f.mode === 'swim') {
      f.x += f.vx * dt;
      f.vy += (-70 - f.vy) * Math.min(1, dt * 3);
      f.y += f.vy * dt;
      if (f.y <= w + 1) {
        f.mode = 'air'; f.vy = -rand(150, 215); f.vx = c.dir * rand(185, 240);
        if (onScreen(G, f.x, f.y, 30)) splash(G, f.x, 3, 0.45);
      }
    } else if (f.mode === 'air') {
      anyAir = true;
      f.vy += (f.vy < 0 ? 400 : 125) * dt;
      f.x += f.vx * dt; f.y += f.vy * dt;
      if (f.y > w && f.vy > 0) {
        if (onScreen(G, f.x, f.y, 30)) splash(G, f.x, 4, 0.55);
        if (f.skips > 0 && chance(0.75)) { f.skips--; f.y = w - 0.5; f.vy = -rand(100, 150); f.vx *= 0.92; }
        else { f.mode = 'dive'; f.vy = 60; }
      }
    } else {
      f.x += f.vx * 0.6 * dt; f.vy += (25 - f.vy) * dt; f.y += f.vy * dt;
      if (f.y > 70) f.gone = true;
    }
    f.ang = Math.atan2(f.vy, Math.abs(f.vx));
    f.ph += dt * 30;
    if ((f.x - G.cam.x) * c.dir > W * 0.7) f.gone = true;
    if (!c.seen && f.mode === 'air' && inView(G, f.x, f.y, 10)) see(G, c, 'flying_fish');
  }
  if (anyAir && !c.sfx) { c.sfx = 1; sfx('splash'); }
  if (!alive || c.t > 18) c.dead = true;
}

function updDolphins(G, c, dt) {
  c.t += dt;
  const W = viewW(G);
  let alive = 0;
  for (const d of c.pod) {
    if (d.gone) continue;
    alive++;
    const w = wy(G, d.x);
    d.tail += dt * (d.mode === 'air' ? 3 : 7);
    if (d.mode === 'air') {
      d.vy += 380 * dt;
      d.x += d.vx * dt; d.y += d.vy * dt;
      if (d.y > w + 2 && d.vy > 0) {
        d.mode = 'swim'; d.vy *= 0.45; d.leapT = rand(1.4, 3.4); d.rising = false;
        if (onScreen(G, d.x, d.y, 40)) { splash(G, d.x, 9, 0.9); bubbles(G, d.x, d.y + 8, 6, 8, 1.6); }
      }
    } else {
      d.x += d.vx * dt;
      d.leapT -= dt;
      if (d.leapT <= 0) d.rising = true;
      if (d.rising) {
        d.vy += (-150 - d.vy) * Math.min(1, dt * 4);
        if (d.y <= w + 3) {
          d.mode = 'air'; d.vy = -rand(175, 235);
          if (onScreen(G, d.x, d.y, 40)) { splash(G, d.x, 8, 0.8); if (chance(0.5)) sfx('splash'); }
        }
      } else {
        const ty = 24 + Math.sin(c.t * 1.4 + d.ph) * 8;
        d.vy += ((ty - d.y) * 3 - d.vy * 1.6) * dt;
      }
      d.y += d.vy * dt;
    }
    d.ang = Math.atan2(d.vy, Math.abs(d.vx));
    if ((d.x - G.cam.x) * c.dir > W * 0.75) d.gone = true;
    if (!c.seen && inView(G, d.x, d.y, 20)) see(G, c, 'dolphin');
  }
  if (!alive || c.t > 40) c.dead = true;
}

function updTurtle(G, c, dt) {
  c.t += dt;
  c.x += c.dir * 15 * dt;
  const mid = raftMid(G);
  // comes up for a breath when passing the raft
  const near = Math.abs(c.x - mid) < 90 && !c.breathed;
  if (near && c.y < 16) { c.breathed = true; bubbles(G, c.x + c.dir * 30, c.y - 4, 5, 3, 1.3); }
  const ty = near ? 10 : c.base + Math.sin(c.t * 0.35 + c.ph) * 6;
  c.y += (ty - c.y) * Math.min(1, dt * 0.6);
  c.y = Math.min(c.y, floorAt(G, c.x) - 30);
  if (chance(dt * 0.4)) bubbles(G, c.x + c.dir * 32, c.y - 3, 1, 2, 1.1);
  if (!c.seen && inView(G, c.x, c.y, 20)) see(G, c, 'turtle');
  if ((c.x - G.cam.x) * c.dir > viewW(G) * 0.65 + 60 && c.t > 4) c.dead = true;
  if (c.t > 140) c.dead = true;
}

function updManta(G, c, dt) {
  c.t += dt;
  c.x += c.dir * 30 * dt;
  c.y = Math.min(c.base + Math.sin(c.t * 0.42 + c.ph) * 11, floorAt(G, c.x) - 50);
  if (!c.seen && inView(G, c.x, c.y, 30)) see(G, c, 'manta');
  if ((c.x - G.cam.x) * c.dir > viewW(G) * 0.65 + 120 && c.t > 4) c.dead = true;
  if (c.t > 90) c.dead = true;
}

function updWhale(G, c, dt) {
  c.t += dt;
  const mid = raftMid(G);
  c.x += c.dir * 26 * dt;
  const u = Math.exp(-Math.pow((c.x - mid) / 430, 2));
  const ty = lerp(WHALE_DEEP, WHALE_APEX, u);
  const vy = (ty - c.y) * Math.min(1, dt * 0.5);
  c.y += vy;
  c.pitch += (clamp(vy / dt / 26 * 0.6, -0.12, 0.12) * c.dir - c.pitch) * Math.min(1, dt);
  c.tail += dt * 1.25;
  c.fin += dt * 0.7;
  c.dark = u;
  if (u > 0.85 && c.sang < 2) { c.sang = 2; sfx('whale'); }
  if (chance(dt * 0.6)) {
    const hx = c.x + c.dir * WHALE_L * 0.32;
    if (onScreen(G, hx, c.y, 40)) bubbles(G, hx, c.y - 40, 3, 10, 2.4);
  }
  const half = WHALE_L * 0.55;
  if (!c.seen && rectInView(G, c.x - half, c.y - 50, c.x + half, c.y + 40)) see(G, c, 'whale');
  if ((c.x - mid) * c.dir > viewW(G) * 0.7 + WHALE_L * 0.7 && c.t > 5) c.dead = true;
  if (c.t > 160) c.dead = true;
}

function updJelly(G, c, dt, B) {
  c.t += dt;
  const L = G.life;
  const fading = c.t > c.dur;
  const lamp = lampGuarding(G), mid = raftMid(G), clear = raftLen(G) / 2 + LAMP_CLEAR;
  let alive = 0;
  for (const j of c.jellies) {
    if (j.a <= 0.01) continue;
    alive++;
    j.ph += dt * j.freq * TAU * 0.5;
    const thrust = Math.pow(Math.max(0, Math.sin(j.ph)), 3);
    j.th = thrust;
    const sinking = fading || j.hurt;
    const target = sinking ? 12 : (j.y > j.ty ? -16 * thrust - 2.5 : 3 - thrust * 6);
    j.vy += (target - j.vy) * Math.min(1, dt * 2.5);
    // jellies drifting into the light of a lit raft lamp slowly pulse back out of it
    const shy = lamp && j.y < 240 && Math.abs(j.x - mid) < clear ? (j.x < mid ? -1 : 1) * (6 + 10 * thrust) : 0;
    j.x += (j.vx + shy + Math.sin(c.t * 0.3 + j.ph * 0.1) * 2) * dt;
    j.y += j.vy * dt;
    j.y = Math.max(j.y, wy(G, j.x) + j.r + 4);
    if (sinking) j.a = Math.max(0, j.a - dt * (j.hurt ? 0.25 : 0.08));
    j.sting = Math.max(0, j.sting - dt);
    // the sting
    if (B.inWater && L.stingCd <= 0 && j.sting <= 0 && j.a > 0.3) {
      const dx = B.cx - j.x, dy = B.cy - (j.y + j.r * 0.8);
      if (Math.abs(dx) < j.r + 10 && dy > -j.r - 8 && dy < j.r * 3.2) {
        try { hurtPlayer(G, 6, j.x, 'jelly'); } catch (e) { /* player not ready */ }
        j.sting = 2.2; L.stingCd = 0.9;
        for (let i = 0; i < 8; i++) emit(G, { x: B.cx + rand(-5, 5), y: B.cy + rand(-6, 6), vx: rand(-30, 30), vy: rand(-30, 30), life: rand(0.4, 0.8), size: rand(1, 2), kind: 'glow', color: j.col, alpha: 0.9, drag: 4, water: 'below' });
      }
    }
    if (onScreen(G, j.x, j.y, 50)) {
      addLight(G, j.x, j.y + j.r * 0.4, 22 + j.r * 1.9, j.col, (0.42 + 0.22 * thrust) * j.a);
      if (!c.seen && inView(G, j.x, j.y, 20)) see(G, c, 'jelly');
    }
  }
  for (const h of spearHits(G)) {
    for (const j of c.jellies) if (!j.hurt && Math.hypot(h.x - j.x, h.y - j.y) < j.r + (h.r || 8)) { j.hurt = true; bubbles(G, j.x, j.y, 4, 3, 1); }
  }
  if (!alive || c.t > c.dur + 40) c.dead = true;
}

function updPlankton(G, c, dt, B) {
  c.t += dt;
  const k = smoothstep(0, 6, c.t) * (1 - smoothstep(c.dur - 10, c.dur, c.t)) * smoothstep(0.45, 0.25, G.light);
  if (c.t > c.dur) { c.dead = true; return; }
  if (k < 0.02) return;
  const R = G.raft;
  const len = raftLen(G);
  const vx = Math.abs(R.vx || 0);
  const cols = [[110, 220, 255], [150, 240, 255], [80, 190, 255], [170, 255, 240]];
  const visible = onScreen(G, R.x + len / 2, 0, len + 120);
  // the wake: the water behind and under the raft lights up
  if (visible) {
    // stray sparks wherever a wave breaks near the raft
    c.twAcc = (c.twAcc || 0) + dt * k * 16;
    while (c.twAcc > 1) {
      c.twAcc--;
      const x = R.x + len / 2 + rand(-260, 260);
      emit(G, { x, y: wy(G, x) + rand(1, 26), vx: rand(-3, 3), vy: rand(-2, 2), life: rand(0.8, 1.8), size: rand(0.6, 1.3), kind: 'dot', color: pick(cols), alpha: rand(0.6, 1), water: 'below' });
    }
    c.emitAcc += dt * k * (22 + vx * 3.2);
    while (c.emitAcc > 1) {
      c.emitAcc--;
      const behind = chance(0.65);
      const x = behind ? R.x - rand(0, 26 + vx * 5) : R.x + rand(0, len);
      const big = chance(0.18);
      emit(G, { x, y: wy(G, x) + rand(1.5, 11), vx: rand(-5, 3) - (behind ? vx * 0.15 : 0), vy: rand(-2, 3), life: rand(1.6, 3.2), size: big ? rand(0.8, 1.5) : rand(0.7, 1.4), kind: big ? 'glow' : 'dot', color: pick(cols), alpha: rand(0.7, 1), drag: 1, water: 'below' });
    }
    const pulse = 0.85 + 0.15 * Math.sin(c.t * 2.3);
    addLight(G, R.x - 12, 8, 56, GLOW_CYAN, 0.5 * k * pulse);
    addLight(G, R.x - 56 - vx * 2, 9, 48, GLOW_CYAN, 0.32 * k);
    addLight(G, R.x + len * 0.5, 10, 36 + len * 0.4, [120, 225, 255], 0.26 * k);
    addLight(G, R.x + len + 8, 7, 34, GLOW_CYAN, 0.26 * k);
    // the whole near sea glimmers faintly
    addLight(G, R.x + len / 2 - 150, 16, 120, [90, 190, 240], 0.1 * k);
    addLight(G, R.x + len / 2 + 160, 16, 120, [90, 190, 240], 0.1 * k);
  }
  // around the swimming boy
  if (B.inWater && B.y < 260) {
    const n = Math.min(4, 1 + Math.floor(B.speed / 25));
    for (let i = 0; i < n; i++) {
      if (!chance(0.65 * k)) continue;
      const big = chance(0.25);
      emit(G, { x: B.cx + rand(-9, 9), y: B.cy + rand(-8, 10), vx: rand(-8, 8), vy: rand(-6, 6), life: rand(1.2, 2.6), size: big ? rand(0.8, 1.5) : rand(0.7, 1.3), kind: big ? 'glow' : 'dot', color: pick(cols), alpha: 0.95, drag: 1.5, water: 'below' });
    }
    addLight(G, B.cx, B.cy, 34 + Math.min(20, B.speed * 0.2), GLOW_CYAN, (0.3 + Math.min(0.25, B.speed * 0.004)) * k * (B.y < 180 ? 1 : 0.5));
  }
  if (!c.seen && k > 0.5 && (visible || (B.inWater && B.y < 260))) see(G, c, 'plankton');
}

const MW_LEN = 210;   // the breaching whale's length on screen at 720p (before scaling to the moon)
const MW_LIFT0 = 0.28;                    // apex height of its centre above the horizon (body lengths) when no moon
const MW_BELLY = 0.15;                    // the thick of the body sits this far ahead of the centre (head up)
const MW_KMIN = 0.85, MW_KMAX = 2;        // how much it may be scaled to reach the moon
const MW_LIFTMIN = 0.15, MW_LIFTMAX = 0.5;
const mwLen = (G, c) => MW_LEN * unitOf(G) * (c.k || 1);

// Where the moon hangs on screen and how to stage the breach so the body crosses it:
// {x, H (moon height above the far horizon, px), k (size), lift, ok (the whale can reach it)}.
function moonBreach(G) {
  const cel = moonInfo(G);
  const v = G.view;
  if (!cel || !cel.moonVisible || !isFinite(cel.moonX) || !isFinite(cel.moonY) || !v) return null;
  const L0 = MW_LEN * unitOf(G);
  const hy = v.seaScreenY - 7 * v.scale;
  const H = hy - cel.moonY;
  const r = isFinite(cel.moonR) ? cel.moonR : 20;
  const k = clamp(H / ((0.42 + MW_BELLY) * L0), MW_KMIN, MW_KMAX);
  const lift = clamp(H / (k * L0) - MW_BELLY, MW_LIFTMIN, MW_LIFTMAX);
  const reach = (lift + MW_BELLY) * k * L0;
  const ok = H > r * 0.5 && Math.abs(reach - H) < Math.max(10, r * 0.5) && cel.moonX > r && cel.moonX < v.cssW - r;
  return { x: cel.moonX, H, k, lift, ok };
}
function horizonScreenX(G, c, fx) {
  const v = G.view;
  return fx * v.cssW - (G.cam.x - c.cx0) * v.scale * 0.035;
}
function horizonVisible(G) {
  const v = G.view;
  return v.seaScreenY > 30 && v.seaScreenY < v.cssH + 40;
}
const unitOf = (G) => Math.max(0.5, (G.view.cssH || 720) / 720);

function updMoonWhale(G, c, dt) {
  c.t += dt;
  const u = unitOf(G);
  const v = G.view;
  // keep right under the (slowly travelling) moon until the apex
  if (c.track && c.t < 3.3) {
    const cel = moonInfo(G);
    if (cel && isFinite(cel.moonX) && v.cssW > 0) c.fx = (cel.moonX + (G.cam.x - c.cx0) * v.scale * 0.035) / v.cssW;
  }
  if (c.t > 0.4 && !c.sang) { c.sang = true; if (horizonVisible(G)) sfx('whale'); }
  if (c.t > 1.2 && horizonVisible(G) && !c.seen) see(G, c, 'moon_whale');
  // spray running off the body while it rises, the big splash when it falls back
  const sx = horizonScreenX(G, c, c.fx);
  const hy = v.seaScreenY - 7 * v.scale;
  const Lw = mwLen(G, c);
  if (c.t > 0.7 && c.t < 3.6 && chance(dt * 45 * Math.min(2, c.k || 1))) {
    const pose = whalePose(c, Lw);
    const s = rand(-0.45, 0.35) * Lw;
    const py = hy - pose.h + Math.sin(pose.a) * s;
    if (py < hy - 3) c.drops.push({ x: sx + pose.x + Math.cos(pose.a) * s + rand(-0.06, 0.06) * Lw, y: py, vx: rand(-14, 14) * u, vy: rand(-10, 20) * u, life: rand(0.8, 1.6), s: rand(0.8, 1.8) * u });
  }
  if (c.t > 4.85 && !c.hit) {
    c.hit = true;
    if (horizonVisible(G)) sfx('splash');
    const bx = sx + whalePose(c, Lw).x + c.side * Lw * 0.35;
    for (let i = 0; i < 110; i++) { const k = Math.random(); c.drops.push({ x: bx + (k - 0.5) * 0.7 * Lw, y: hy - rand(0, 6) * u, vx: (k - 0.5) * 90 * u + rand(-15, 15) * u, vy: -rand(40, 170) * u * (1 - Math.abs(k - 0.5)), life: rand(1.2, 2.8), s: rand(0.8, 2.6) * u }); }
  }
  for (const d of c.drops) { d.life -= dt; d.vy += 120 * u * dt; d.x += d.vx * dt; d.y += d.vy * dt; }
  c.drops = c.drops.filter((d) => d.life > 0 && d.y < hy + 2);
  // the splash catches a little moonlight in the dark
  if (c.hit && c.t < 8 && horizonVisible(G)) {
    const w = screenToWorld(G, sx + c.side * Lw * 0.35, hy - 20 * u);
    addLight(G, w.x, w.y, 110, [200, 220, 255], 0.45 * (1 - smoothstep(5, 8, c.t)));
  }
  if (c.t > c.dur) c.dead = true;
}

// Pose of the breaching whale (Lw: its length in px): centre x offset (screen), height of its
// centre above the horizon, body angle.
function whalePose(c, Lw) {
  const t = c.t;
  const top = Lw * (c.lift != null ? c.lift : MW_LIFT0);
  let h, a;
  const up = -Math.PI / 2;
  if (t < 0.6) { h = -Lw * 0.6; a = up + 0.1 * c.side; }
  else if (t < 2.7) { const p = (t - 0.6) / 2.1; h = lerp(-Lw * 0.6, top, 1 - Math.pow(1 - p, 2.2)); a = up + 0.1 * c.side; }
  else if (t < 3.3) { h = top + Math.sin((t - 2.7) / 0.6 * Math.PI) * Lw * 0.02; a = up + (0.1 + 0.25 * (t - 2.7) / 0.6) * c.side; }
  else { const p = Math.min(1, (t - 3.3) / 1.6); h = lerp(top, -Lw * 0.3, p * p); a = up + lerp(0.35, 1.5, p * (2 - p)) * c.side; }
  const drift = t < 3.3 ? 0 : Math.min(1, (t - 3.3) / 1.6) * Lw * 0.22 * c.side;
  return { h, a, x: drift };
}

function updLeviathan(G, c, dt) {
  c.t += dt;
  const a = smoothstep(0, 10, c.t) * (1 - smoothstep(c.dur - 10, c.dur, c.t)) * smoothstep(0.42, 0.25, G.light);
  c.a = a;
  if (a > 0.45 && horizonVisible(G) && !c.seen) see(G, c, 'leviathan');
  if (!c.beat && c.t > 25 && horizonVisible(G)) { c.beat = true; sfx('heartbeat'); }
  if (c.t > c.dur) c.dead = true;
}

function updGhostShip(G, c, dt) {
  c.t += dt;
  const fog = (G.weather && G.weather.fog) || 0;
  const v = G.view;
  if (fog < 0.22 && c.t > 8 && !c.lift) { c.lift = true; c.dur = Math.min(c.dur, c.t + 8); }
  c.a = smoothstep(0, 7, c.t) * (1 - smoothstep(c.dur - 7, c.dur, c.t)) * smoothstep(0.5, 0.3, G.light);
  if (c.t > c.dur) { c.dead = true; return; }
  if (!horizonVisible(G) || c.a < 0.05) return;
  const u = unitOf(G);
  const sx = horizonScreenX(G, c, c.fx0 + c.dir * c.span * (c.t / c.dur));
  const hy = v.seaScreenY - 7 * v.scale;
  if (sx < -300 * u || sx > v.cssW + 300 * u) return;
  if (!c.seen && c.a > 0.45 && sx > 40 && sx < v.cssW - 40) see(G, c, 'ghost_ship');
  // lanterns: bow, stern and the cabin windows
  const sc = SHIP_SCALE * u;
  const pts = [[-118, -104, 30, 0.75], [122, -70, 28, 0.7], [-96, -50, 42, 0.55]];
  for (const [lx, ly, r, k] of pts) {
    const w = screenToWorld(G, sx + lx * sc * c.dir, hy + ly * sc);
    addLight(G, w.x, w.y, r, [255, 196, 120], k * c.a * (0.85 + 0.15 * Math.sin(c.t * 3 + lx)));
  }
}

function updAngler(G, c, dt, B) {
  c.t += dt; c.st += dt;
  c.flash = Math.max(0, c.flash - dt * 2);
  const L = ANGLER_L;
  const lx = c.x + c.face * L * 0.6, ly = c.y - L * 0.1 + Math.sin(c.t * 1.6) * 3;
  c.lx = lx; c.ly = ly;
  const mx = c.x + c.face * L * 0.46, my = c.y + L * 0.05;
  const boyD = Math.hypot(B.cx - lx, B.cy - ly);
  let tx = c.x, ty = c.y, spd = 0;
  const leave = () => { c.state = 'leave'; c.st = 0; };
  for (const h of spearHits(G)) {
    if (c.state !== 'leave' && Math.hypot(h.x - (c.x + c.face * L * 0.2), h.y - c.y) < L * 0.35 + (h.r || 8)) {
      c.flash = 1; bubbles(G, h.x, h.y, 10, 6, 1.6); leave(); break;
    }
  }
  if (c.t > c.life && c.state === 'lure') leave();
  switch (c.state) {
    case 'lure':
      c.lureA += (1 - c.lureA) * Math.min(1, dt * 0.8);
      if (!B.inWater || B.y < 150 || boyD > 650) { if (c.t > 6) leave(); break; }
      tx = B.cx - c.face * L * 0.62; ty = B.cy + L * 0.08; spd = 13;
      c.dir = sgn(B.cx - c.x);
      if (boyD < 72) { c.state = 'tell'; c.st = 0; sfx('heartbeat'); }
      c.jaw += (0.08 - c.jaw) * dt * 2;
      break;
    case 'tell':
      c.lureA = 0.45 + 0.55 * (Math.sin(c.st * 40) > 0 ? 1 : 0.2);
      c.jaw += (0.35 - c.jaw) * dt * 4;
      tx = c.x + c.face * 5; spd = 6;
      if (c.st > 0.75) { c.state = 'lunge'; c.st = 0; }
      break;
    case 'lunge': {
      c.lureA = 1;
      c.jaw += (1 - c.jaw) * Math.min(1, dt * 14);
      tx = B.cx; ty = B.cy; spd = 320;
      if (B.inWater && Math.hypot(B.cx - mx, B.cy - my) < 30) {
        try { hurtPlayer(G, 25, c.x, 'angler'); } catch (e) { /* player not ready */ }
        G.shake = (G.shake || 0) + 0.4;
        bubbles(G, mx, my, 12, 8, 2);
        c.state = 'back'; c.st = 0; c.attacks++;
      } else if (c.st > 0.45) { c.state = 'back'; c.st = 0; c.attacks++; }
      break;
    }
    case 'back':
      c.jaw += (0 - c.jaw) * Math.min(1, dt * 3);
      tx = c.x - c.face * 100; ty = c.y + 30; spd = 65;
      if (c.st > 3) { if (c.attacks >= 2) leave(); else { c.state = 'lure'; c.st = 0; } }
      break;
    case 'leave':
      c.lureA = Math.max(0, c.lureA - dt * 0.5);
      c.jaw += (0 - c.jaw) * Math.min(1, dt * 3);
      tx = c.x - c.face * 200; ty = c.y + 120; spd = 70;
      if (c.st > 7 || (c.st > 2 && !onScreen(G, c.x, c.y, L))) c.dead = true;
      break;
  }
  if (c.state !== 'lunge' && c.state !== 'back' && c.state !== 'leave') c.face += clamp(c.dir - c.face, -dt * 1.2, dt * 1.2);
  else if (c.state === 'lunge') c.face = sgn(c.face) || c.dir;
  if (spd > 0) {
    const dx = tx - c.x, dy = ty - c.y, d = Math.hypot(dx, dy);
    if (d > 1) { const k = Math.min(d, spd * dt); c.x += dx / d * k * (c.state === 'lunge' ? 1 : (0.3 + 0.7 * Math.abs(c.face))); c.y += dy / d * k; }
  }
  c.y = Math.min(c.y, floorAt(G, c.x) - 30);
  c.y = Math.max(c.y, 60);
  if (c.lureA > 0.02) {
    addLight(G, lx, ly, 54, [170, 255, 225], 0.9 * c.lureA);
    addLight(G, c.x + c.face * L * 0.25, c.y - 4, 95, [110, 190, 175], 0.22 * c.lureA);
  }
  if (c.state === 'lunge' || c.state === 'tell') addLight(G, mx, my, 50, [140, 220, 200], 0.25 * c.lureA);
  if (!c.seen && c.lureA > 0.5 && inView(G, lx, ly, 10)) see(G, c, 'angler');
}

function updEye(G, c, dt, B) {
  c.t += dt;
  const ex = c.x, ey = c.y - EYE_LIFT;
  const d = Math.hypot(B.cx - ex, B.cy - ey);
  const near = B.inWater && d < 290;
  const target = near ? 1 : 0;
  c.open += clamp(target - c.open, -dt * 0.7, dt * 0.45);
  c.blinkT -= dt;
  if (c.blinkT <= 0 && c.open > 0.8) { c.blink = 0.28; c.blinkT = rand(3.5, 8); }
  c.blink = Math.max(0, c.blink - dt);
  const ang = Math.atan2(B.cy - ey, B.cx - ex);
  const k = Math.min(1, d / 120);
  c.lx += (Math.cos(ang) * k - c.lx) * Math.min(1, dt * 3);
  c.ly += (Math.sin(ang) * k - c.ly) * Math.min(1, dt * 3);
  if (c.open > 0.3 && !c.beat) { c.beat = true; sfx('heartbeat'); }
  const o = c.open * (c.blink > 0 ? Math.abs(Math.cos(c.blink / 0.28 * Math.PI)) : 1);
  c.o = o;
  if (o > 0.05) addLight(G, ex, ey + 4, 40 + 50 * o, [214, 204, 140], 0.38 * o);
  if (!c.seen && o > 0.6 && inView(G, ex, ey, 20)) see(G, c, 'deep_eye');
  if (d > 950 && c.open < 0.05) c.dead = true;
}

const UPD = {
  shark: updShark, gulls: updGulls, flying_fish: updFlyingFish, dolphin: updDolphins, turtle: updTurtle,
  manta: updManta, whale: updWhale, jelly: updJelly, plankton: updPlankton, moon_whale: updMoonWhale,
  leviathan: updLeviathan, ghost_ship: updGhostShip, angler: updAngler, deep_eye: updEye,
};

// =====================================================================================
// update
// =====================================================================================

const reported = new Set();
export function update(G, dt) {
  if (!G.life || !G.persist || !G.persist.life) init(G);
  const L = G.life;
  L.t += dt;
  L.stingCd = Math.max(0, L.stingCd - dt);
  const B = L.boy = boyInfo(G);
  updateSchools(G, dt, B);
  scheduler(G, dt, B);
  const arr = G.creatures;
  for (let i = 0; i < arr.length; i++) {
    const c = arr[i];
    const u = UPD[c.kind];
    if (!u) continue;
    try { u(G, c, dt, B); } catch (e) {
      c.dead = true;
      if (!reported.has(c.kind)) { reported.add(c.kind); console.warn('[life] ' + c.kind + ' failed:', e); }
    }
  }
  let w = 0;
  for (let i = 0; i < arr.length; i++) if (!arr[i].dead) arr[w++] = arr[i];
  arr.length = w;
}

// =====================================================================================
// debug
// =====================================================================================

export function debugSpawn(G, kind) {
  if (!G.life) init(G);
  const B = G.life.boy = boyInfo(G);
  const W = viewW(G);
  const cx = G.cam.x;
  const deepY = (y) => clamp(y, 40, floorAt(G, B.x) - 40);
  switch (kind) {
    case 'whale': {
      const c = spawnWhale(G, 1, cx + 170 - WHALE_L * 0.5);
      c.y = WHALE_APEX + 14; c.seen = false;
      return true;
    }
    case 'manta': spawnManta(G, -1, cx + 150); return true;
    case 'turtle': { const c = spawnTurtle(G, -1, cx + 140); c.y = c.base = 52; return true; }
    case 'dolphin': {
      const c = spawnDolphins(G, 1, cx - W * 0.3);
      c.pod.forEach((d, i) => { d.leapT = 0.1 + i * 0.5; d.y = 10; d.rising = true; });
      return true;
    }
    case 'flying_fish': {
      const c = spawnFlyingFish(G, 1, cx - W * 0.42);
      c.fish.forEach((f, i) => { f.delay = i * 0.12; f.y = rand(4, 14); });
      return true;
    }
    case 'seagull': case 'gulls': {
      G.creatures = G.creatures.filter((c) => c.kind !== 'gulls');
      const c = spawnGulls(G, 4);
      for (const b of c.birds) { b.enter = 0; placeGull(c, b, 0); }
      return true;
    }
    case 'shark': {
      G.creatures = G.creatures.filter((c) => c.kind !== 'shark');
      const c = spawnShark(G, cx + 170, 18, -1);
      c.surf = true; c.depthT = 12;
      return true;
    }
    case 'jelly': spawnJelly(G, true); return true;
    case 'plankton': { const c = spawnPlankton(G); c.t = 6; return true; }
    case 'lanternfish': case 'fish': {
      const sp = kind === 'fish' ? pickSpecies() : 'lantern';
      const y = B.inWater ? deepY(B.cy + 30) : rand(60, 120);
      spawnSchool(G, sp, false, { x: B.x + rand(60, 140) * (chance(0.5) ? 1 : -1), y, dir: chance(0.5) ? 1 : -1 });
      return true;
    }
    case 'moon_whale': { const c = spawnMoonWhale(G); c.t = 1.2; return true; }
    case 'leviathan': { const c = spawnLeviathan(G); c.t = 10; return true; }
    case 'ghost_ship': { const c = spawnGhostShip(G); c.dir = 1; c.fx0 = 0.6 - c.span * (9 / c.dur); c.t = 9; return true; }
    case 'angler': {
      const side = chance(0.5) ? 1 : -1;
      const c = spawnAngler(G, B, B.x + side * 170, deepY(B.cy + 30));
      c.lureA = 0.8;
      return true;
    }
    case 'deep_eye': {
      const P = G.player;
      const c = spawnEye(G, B.x + ((P && P.facing) || 1) * 90);
      c.open = 0.5;
      return true;
    }
    case 'debris': spawnDebrisNear(G, B.x + 110, 5); return true;
  }
  return false;
}

// =====================================================================================
// drawing — entry points
// =====================================================================================

export function drawHorizon(ctx, G) {
  if (!G.creatures || !G.creatures.length || !horizonVisible(G)) return;
  for (const c of G.creatures) {
    if (c.layer !== 'horizon') continue;
    try {
      if (c.kind === 'leviathan') drawLeviathan(ctx, G, c);
      else if (c.kind === 'ghost_ship') drawGhostShip(ctx, G, c);
      else if (c.kind === 'moon_whale') drawMoonWhale(ctx, G, c);
    } catch (e) { c.dead = true; }
  }
}

export function drawDeep(ctx, G) {
  if (!G.creatures) return;
  for (const c of G.creatures) {
    if (c.layer !== 'deep') continue;
    try {
      if (c.kind === 'whale') drawWhale(ctx, G, c);
      else if (c.kind === 'deep_eye') drawEye(ctx, G, c);
    } catch (e) { c.dead = true; }
  }
}

const MAIN_ORDER = ['manta', 'turtle', 'dolphin', 'shark', 'fish', 'jelly', 'angler', 'flying_fish', 'gulls'];
const MAIN_DRAW = {
  manta: (ctx, G, c) => drawManta(ctx, G, c),
  turtle: (ctx, G, c) => drawTurtle(ctx, G, c),
  dolphin: (ctx, G, c) => drawDolphins(ctx, G, c),
  shark: (ctx, G, c) => drawShark(ctx, G, c),
  jelly: (ctx, G, c) => drawJellies(ctx, G, c),
  angler: (ctx, G, c) => drawAngler(ctx, G, c),
  flying_fish: (ctx, G, c) => drawFlyingFish(ctx, G, c),
  gulls: (ctx, G, c) => drawGulls(ctx, G, c),
};

// Clip creature drawing to the open water/air above island terrain, so nothing ever
// shows inside an island's solid cross-section. No-op when no island is in view.
function clipAboveIslands(ctx, G) {
  const v = G.view;
  const x0 = v.left - 20, x1 = v.left + v.w + 20, bottom = v.top + v.h + 40;
  const pts = [];
  let any = false;
  for (let x = x0; x <= x1 + 8; x += 8) {
    const g = islandGround(G, x);
    if (g != null) any = true;
    pts.push(x, g != null ? g : bottom);
  }
  if (!any) return false;
  ctx.beginPath();
  ctx.moveTo(x0, v.top - 400);
  ctx.lineTo(x1 + 8, v.top - 400);
  for (let i = pts.length - 2; i >= 0; i -= 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.closePath();
  ctx.clip();
  return true;
}

export function draw(ctx, G) {
  if (!G.life) return;
  ctx.save();
  clipAboveIslands(ctx, G);
  try { drawMain(ctx, G); } finally { ctx.restore(); }
}

function drawMain(ctx, G) {
  for (const k of MAIN_ORDER) {
    if (k === 'fish') { drawSchools(ctx, G); continue; }
    for (const c of G.creatures) {
      if (c.kind !== k) continue;
      try { MAIN_DRAW[k](ctx, G, c); } catch (e) { c.dead = true; }
    }
  }
}

// =====================================================================================
// sprite baking
// =====================================================================================

const SPR = new Map();
function bake(key, w, h, res, paint) {
  let s = SPR.get(key);
  if (s) return s;
  const c = makeCanvas(Math.ceil(w * res), Math.ceil(h * res));
  const g = c.getContext('2d');
  g.scale(res, res);
  g.translate(w / 2, h / 2);
  g.lineJoin = 'round'; g.lineCap = 'round';
  try { paint(g); } catch (e) { console.warn('[life] sprite ' + key, e); }
  s = { c, w, h };
  SPR.set(key, s);
  return s;
}
const put = (ctx, s, dx = 0, dy = 0) => ctx.drawImage(s.c, dx - s.w / 2, dy - s.h / 2, s.w, s.h);

// ---- the water between the camera and a creature: a tint layer per sprite, re-filled only
// when the (coarsely quantised) water colour changes over the day
const WATER_KEYS = [
  [0, [104, 104, 140]], [0.05, [66, 126, 140]], [0.25, [56, 122, 140]], [0.47, [64, 118, 134]],
  [0.53, [108, 92, 128]], [0.6, [72, 62, 104]], [0.68, [16, 26, 52]], [0.93, [16, 26, 52]], [0.98, [86, 84, 124]], [1, [104, 104, 140]],
];
const DEEP_COL = [6, 18, 28];
const NO_TINT = { k: 0, col: null };
function waterTint(G, depth) {
  if (!(depth > 2)) return NO_TINT;
  const base = gradientAt(WATER_KEYS, ((G.phase % 1) + 1) % 1);
  const f = clamp(depth / 520, 0, 1);
  return { col: mixColor(base, DEEP_COL, f * 0.85), k: clamp(0.16 + depth / 430, 0.16, 0.72) };
}
const TINTS = new WeakMap();
function tintLayer(s, col) {
  const q = [col[0] & ~7, col[1] & ~7, col[2] & ~7];
  const key = (q[0] << 16) | (q[1] << 8) | q[2];
  let t = TINTS.get(s);
  if (t && t.key === key) return t.c;
  if (!t) { t = { key: -1, c: makeCanvas(s.c.width, s.c.height) }; TINTS.set(s, t); }
  const g = t.c.getContext('2d');
  g.globalCompositeOperation = 'copy';
  g.drawImage(s.c, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = `rgb(${q[0]},${q[1]},${q[2]})`;
  g.fillRect(0, 0, t.c.width, t.c.height);
  g.globalCompositeOperation = 'source-over';
  t.key = key;
  return t.c;
}
// draw a sprite, then veil it with the water colour
function putT(ctx, s, tint, dx = 0, dy = 0) {
  ctx.drawImage(s.c, dx - s.w / 2, dy - s.h / 2, s.w, s.h);
  if (tint && tint.k > 0.02) {
    const a = ctx.globalAlpha;
    ctx.globalAlpha = a * tint.k;
    ctx.drawImage(tintLayer(s, tint.col), dx - s.w / 2, dy - s.h / 2, s.w, s.h);
    ctx.globalAlpha = a;
  }
}

const GLOWS = new Map();
function glow(col) {
  const key = (col[0] | 0) + ',' + (col[1] | 0) + ',' + (col[2] | 0);
  let c = GLOWS.get(key);
  if (c) return c;
  const S = 64;
  c = makeCanvas(S, S);
  const g = c.getContext('2d');
  const rg = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  rg.addColorStop(0, `rgba(${key},1)`);
  rg.addColorStop(0.25, `rgba(${key},0.45)`);
  rg.addColorStop(0.6, `rgba(${key},0.12)`);
  rg.addColorStop(1, `rgba(${key},0)`);
  g.fillStyle = rg;
  g.fillRect(0, 0, S, S);
  GLOWS.set(key, c);
  return c;
}
const rgbaC = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${clamp(a, 0, 1).toFixed(3)})`;

// Catmull-Rom through key rows [u, top, bottom].
function cr(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}
function prof(keys, u, col) {
  let i = 1;
  while (i < keys.length - 1 && u > keys[i][0]) i++;
  const a = keys[i - 1], b = keys[i];
  const f = clamp((u - a[0]) / ((b[0] - a[0]) || 1), 0, 1);
  return cr((keys[i - 2] || a)[col], a[col], b[col], (keys[i + 1] || b)[col], f);
}
// A body outline from the nose (xn) to the tail root (xt); top values are heights above the axis.
function bodyPath(xn, xt, keys, n = 40, bump) {
  const p = new Path2D();
  const top = [], bot = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n, x = lerp(xn, xt, u);
    let tp = prof(keys, u, 1);
    if (bump) tp += bump(u);
    top.push([x, -tp]);
    bot.push([x, prof(keys, u, 2)]);
  }
  p.moveTo(top[0][0], top[0][1]);
  for (let i = 1; i <= n; i++) p.lineTo(top[i][0], top[i][1]);
  for (let i = n; i >= 0; i--) p.lineTo(bot[i][0], bot[i][1]);
  p.closePath();
  return { path: p, top, bot };
}
function rim(g, path, color, width, dx, dy) {
  g.save();
  g.clip(path);
  g.translate(dx, dy);
  g.strokeStyle = color;
  g.lineWidth = width;
  g.stroke(path);
  g.restore();
}
function vgrad(g, y0, y1, stops) {
  const gr = g.createLinearGradient(0, y0, 0, y1);
  for (const [t, c] of stops) gr.addColorStop(t, c);
  return gr;
}
function mottle(g, rnd, x0, y0, w, h, n, col, r0, r1) {
  g.fillStyle = col;
  for (let i = 0; i < n; i++) {
    const r = r0 + rnd() * (r1 - r0);
    g.beginPath(); g.ellipse(x0 + rnd() * w, y0 + rnd() * h, r, r * (0.5 + rnd() * 0.5), rnd() * 3, 0, TAU); g.fill();
  }
}
function lcg(seed) {
  let s = (seed * 9301 + 49297) % 233280 || 1;
  return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
}
function barnacleCluster(g, rnd, cx, cy, n, spread, size) {
  for (let i = 0; i < n; i++) {
    const x = cx + (rnd() - 0.5) * spread, y = cy + (rnd() - 0.5) * spread * 0.6, s = size * (0.5 + rnd() * 0.8);
    g.fillStyle = 'rgba(70,72,70,0.6)';
    g.beginPath(); g.ellipse(x + s * 0.2, y + s * 0.25, s, s * 0.8, 0, 0, TAU); g.fill();
    g.fillStyle = `rgba(${200 + rnd() * 30 | 0},${196 + rnd() * 25 | 0},${180 + rnd() * 20 | 0},0.95)`;
    g.beginPath(); g.ellipse(x, y, s, s * 0.8, rnd(), 0, TAU); g.fill();
    g.fillStyle = 'rgba(60,58,52,0.85)';
    g.beginPath(); g.ellipse(x, y - s * 0.1, s * 0.38, s * 0.26, 0, 0, TAU); g.fill();
  }
}
function tri(g, x0, y0, x1, y1, x2, y2) { g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.lineTo(x2, y2); g.closePath(); g.fill(); }

// =====================================================================================
// fish
// =====================================================================================

const FISH_PAL = {
  sardine:  { top: '#2c5272', mid: '#91b2c6', belly: '#f0f4f5', fin: 'rgba(196,220,232,0.55)', tail: 'rgba(160,196,218,0.8)' },
  tang:     { top: '#1b3a86', mid: '#3a6dc6', belly: '#8ab1e8', fin: 'rgba(28,48,118,0.85)', tail: '#f1c43a' },
  snapper:  { top: '#9a382d', mid: '#df7d64', belly: '#f7dfce', fin: 'rgba(228,112,90,0.75)', tail: 'rgba(210,92,70,0.88)' },
  mackerel: { top: '#22504f', mid: '#86aea6', belly: '#eff3f0', fin: 'rgba(150,182,176,0.6)', tail: 'rgba(52,92,92,0.85)' },
  lantern:  { top: '#151b25', mid: '#2b3543', belly: '#48525e', fin: 'rgba(70,84,104,0.6)', tail: 'rgba(40,50,66,0.85)' },
};
const FRAME_SEQ = [0, 1, 2, 3, 2, 1];
const TAIL_ANG = [-0.36, -0.12, 0.12, 0.36];

function fishSprite(species, frame) {
  const sp = SPECIES[species];
  return bake('fish:' + species + ':' + frame, sp.L * 1.7, sp.H * 3.2, 9, (g) => paintFish(g, species, sp, TAIL_ANG[frame]));
}

function paintFish(g, species, sp, ta) {
  const L = sp.L, H = sp.H, P = FISH_PAL[species];
  const rnd = lcg(species.length * 13 + 7);
  const xn = L * 0.5, xt = -L * 0.5 + L * 0.24;
  const deep = species === 'tang';
  const keys = deep
    ? [[0, 0.08 * H, 0.08 * H], [0.12, 0.36 * H, 0.3 * H], [0.38, 0.56 * H, 0.5 * H], [0.72, 0.34 * H, 0.3 * H], [1, 0.1 * H, 0.1 * H]]
    : [[0, 0.05 * H, 0.07 * H], [0.1, 0.3 * H, 0.27 * H], [0.36, 0.5 * H, 0.46 * H], [0.75, 0.27 * H, 0.23 * H], [1, 0.09 * H, 0.09 * H]];
  // tail
  g.save();
  g.translate(xt + 0.2, 0);
  g.rotate(ta);
  const tl = L * 0.27;
  const tail = new Path2D();
  tail.moveTo(0.4, -H * 0.12);
  tail.quadraticCurveTo(-tl * 0.45, -H * 0.2, -tl, -H * 0.62);
  tail.quadraticCurveTo(-tl * 0.62, 0, -tl, H * 0.62);
  tail.quadraticCurveTo(-tl * 0.45, H * 0.2, 0.4, H * 0.12);
  tail.closePath();
  g.fillStyle = P.tail; g.fill(tail);
  g.strokeStyle = 'rgba(255,255,255,0.22)'; g.lineWidth = 0.07;
  for (let i = -3; i <= 3; i++) { g.beginPath(); g.moveTo(0, 0); g.lineTo(-tl * (0.8 + Math.abs(i) * 0.06), H * 0.18 * i); g.stroke(); }
  g.restore();
  // dorsal + anal fins
  g.fillStyle = P.fin;
  const dors = new Path2D();
  dors.moveTo(L * 0.14, -H * 0.47); dors.quadraticCurveTo(-L * 0.02, -H * (deep ? 1.15 : 0.9), -L * 0.2, -H * 0.36); dors.closePath();
  g.fill(dors);
  const anal = new Path2D();
  anal.moveTo(-L * 0.04, H * 0.42); anal.quadraticCurveTo(-L * 0.12, H * (deep ? 1.0 : 0.72), -L * 0.22, H * 0.26); anal.closePath();
  g.fill(anal);
  // body
  const B = bodyPath(xn, xt, keys, 30);
  const body = B.path;
  g.fillStyle = vgrad(g, -H * 0.55, H * 0.5, [[0, P.top], [0.42, P.mid], [0.62, P.belly], [1, P.belly]]);
  g.fill(body);
  g.save();
  g.clip(body);
  if (species === 'sardine') {
    g.fillStyle = 'rgba(230,245,255,0.45)'; g.fillRect(-L, -H * 0.08, L * 2, H * 0.12);
    g.fillStyle = 'rgba(20,40,60,0.6)';
    for (let i = 0; i < 5; i++) { g.beginPath(); g.arc(L * 0.18 - i * L * 0.08, -H * 0.2, H * 0.06, 0, TAU); g.fill(); }
  } else if (species === 'tang') {
    g.strokeStyle = 'rgba(10,20,60,0.35)'; g.lineWidth = 0.12;
    for (let i = 0; i < 6; i++) { const x = L * 0.2 - i * L * 0.09; g.beginPath(); g.moveTo(x, -H); g.lineTo(x - L * 0.03, H); g.stroke(); }
    g.fillStyle = 'rgba(12,22,60,0.75)';
    g.beginPath(); g.ellipse(-L * 0.12, -H * 0.1, L * 0.16, H * 0.12, -0.15, 0, TAU); g.fill();
    g.fillStyle = '#f3d24a'; g.beginPath(); g.ellipse(xt + 1, 0, 0.9, 0.35, 0, 0, TAU); g.fill();
  } else if (species === 'snapper') {
    g.strokeStyle = 'rgba(255,214,150,0.45)'; g.lineWidth = 0.18;
    for (let i = 0; i < 3; i++) { const y = -H * 0.18 + i * H * 0.16; g.beginPath(); g.moveTo(xn - L * 0.15, y); g.quadraticCurveTo(0, y - 0.3, xt, y * 0.5); g.stroke(); }
  } else if (species === 'mackerel') {
    g.strokeStyle = 'rgba(12,30,34,0.75)'; g.lineWidth = 0.22;
    for (let i = 0; i < 10; i++) {
      const x = L * 0.24 - i * L * 0.065;
      g.beginPath(); g.moveTo(x, -H * 0.6); g.quadraticCurveTo(x - 0.5, -H * 0.35, x + 0.2, -H * 0.12); g.stroke();
    }
    g.fillStyle = 'rgba(120,200,210,0.25)'; g.fillRect(-L, -H * 0.12, L * 2, H * 0.1);
  } else if (species === 'lantern') {
    g.fillStyle = 'rgba(160,190,210,0.2)'; g.fillRect(-L, -H * 0.05, L * 2, H * 0.1);
  }
  // faint scales
  g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 0.06;
  for (let r = -1; r <= 1; r++) {
    for (let i = 0; i < 8; i++) {
      const x = L * 0.2 - i * L * 0.075, y = r * H * 0.2;
      g.beginPath(); g.arc(x, y, H * 0.12, -1.2, 1.2); g.stroke();
    }
  }
  g.restore();
  // lateral line, gill, highlights
  g.strokeStyle = 'rgba(255,255,255,0.32)'; g.lineWidth = 0.08;
  g.beginPath(); g.moveTo(xn - L * 0.24, -H * 0.12); g.quadraticCurveTo(0, -H * 0.18, xt + 0.3, -H * 0.02); g.stroke();
  g.strokeStyle = 'rgba(10,20,30,0.4)'; g.lineWidth = 0.12;
  g.beginPath(); g.arc(xn - L * 0.16, 0, H * 0.32, Math.PI * 0.62, Math.PI * 1.38, false); g.stroke();
  rim(g, body, 'rgba(255,255,255,0.45)', 0.3, 0, 0.2);
  rim(g, body, 'rgba(0,10,20,0.35)', 0.35, 0, -0.2);
  // pectoral fin
  g.fillStyle = P.fin;
  g.beginPath();
  g.moveTo(xn - L * 0.26, H * 0.08);
  g.quadraticCurveTo(xn - L * 0.36, H * 0.25, xn - L * 0.44, H * 0.34);
  g.quadraticCurveTo(xn - L * 0.36, H * 0.12, xn - L * 0.26, H * 0.08);
  g.fill();
  // eye
  const lan = species === 'lantern';
  const er = H * (lan ? 0.2 : 0.14);
  const ex = xn - L * (lan ? 0.12 : 0.11), ey = -H * 0.07;
  g.fillStyle = lan ? '#c9d6dd' : species === 'snapper' ? '#e8b85c' : '#e8ece6';
  g.beginPath(); g.arc(ex, ey, er, 0, TAU); g.fill();
  g.fillStyle = '#05080b';
  g.beginPath(); g.arc(ex + er * 0.12, ey, er * 0.62, 0, TAU); g.fill();
  g.fillStyle = 'rgba(255,255,255,0.9)';
  g.beginPath(); g.arc(ex - er * 0.15, ey - er * 0.3, er * 0.22, 0, TAU); g.fill();
  // mouth
  g.strokeStyle = 'rgba(30,20,20,0.5)'; g.lineWidth = 0.08;
  g.beginPath(); g.moveTo(xn - 0.1, H * 0.04); g.lineTo(xn - L * 0.05, H * 0.08); g.stroke();
  // lanternfish photophores
  if (lan) {
    for (let i = 0; i < 7; i++) {
      const x = xn - L * 0.22 - i * L * 0.075, y = H * (0.3 - Math.abs(i - 3) * 0.02);
      g.fillStyle = 'rgba(140,240,255,0.95)';
      g.beginPath(); g.arc(x, y, H * 0.055, 0, TAU); g.fill();
    }
    for (let i = 0; i < 3; i++) { g.beginPath(); g.arc(xn - L * 0.3 - i * L * 0.1, H * 0.05, H * 0.045, 0, TAU); g.fill(); }
    g.beginPath(); g.arc(ex - er * 1.4, ey + er * 1.2, H * 0.06, 0, TAU); g.fill();
  }
  rnd();
}

function drawSchools(ctx, G) {
  const L = G.life;
  if (!L || !L.schools) return;
  const t = G.time;
  for (const s of L.schools) {
    if (!onScreen(G, s.cx, s.cy, 140)) continue;
    const sp = SPECIES[s.sp];
    const lan = s.sp === 'lantern';
    for (const f of s.fish) {
      if (!onScreen(G, f.x, f.y, 16)) continue;
      const fr = FRAME_SEQ[Math.floor(f.ph) % 6];
      const S = fishSprite(s.sp, fr);
      const ang = clamp(Math.atan2(f.vy, Math.abs(f.vx) + 0.01), -0.6, 0.6);
      ctx.save();
      ctx.translate(f.x, f.y);
      ctx.rotate(ang * f.face);
      ctx.scale(f.face * f.size, f.size);
      putT(ctx, S, lan ? NO_TINT : waterTint(G, f.y));
      ctx.restore();
    }
    if (lan) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const gl = glow(GLOW_CYAN);
      for (const f of s.fish) {
        if (!onScreen(G, f.x, f.y, 16)) continue;
        const k = 0.55 + 0.25 * Math.sin(t * 3 + f.ph * 0.2);
        ctx.globalAlpha = k;
        const r = sp.L * 0.9;
        ctx.drawImage(gl, f.x - r, f.y - r * 0.6, r * 2, r * 1.6);
      }
      ctx.restore();
    }
  }
}

// =====================================================================================
// shark
// =====================================================================================

function sharkSprite() {
  return bake('shark', 132, 66, 4.5, (g) => {
    const L = SHARK_L;
    const rnd = lcg(91);
    const keys = [[0, 0.5, 1.4], [0.05, 3.3, 3.6], [0.14, 6.6, 6.3], [0.3, 9.3, 8.5], [0.45, 10.0, 8.8], [0.62, 8.4, 6.6], [0.8, 5.0, 3.8], [0.93, 2.8, 2.2], [1, 2.3, 1.9]];
    const xn = L * 0.5, xt = -L * 0.36;
    const finCol = vgrad(g, -26, 24, [[0, '#33404c'], [0.5, '#4d5a66'], [1, '#2f3a45']]);
    // fins behind the body
    g.fillStyle = finCol;
    const dorsal = new Path2D();
    dorsal.moveTo(10, -9.4); dorsal.quadraticCurveTo(3, -19, -6.5, -27); dorsal.quadraticCurveTo(-5, -16, -11, -8.4); dorsal.closePath();
    g.fill(dorsal);
    g.save(); g.clip(dorsal);
    g.fillStyle = 'rgba(200,215,225,0.18)'; g.fillRect(-8, -28, 4, 20);
    g.restore();
    rim(g, dorsal, 'rgba(190,210,225,0.5)', 0.9, 0.35, 0.3);
    g.fillStyle = '#3d4955';
    tri(g, -21.5, -4.5, -25, -9.5, -27.5, -3.5);
    tri(g, -14, 7.2, -21, 12.5, -22.5, 5.6);
    tri(g, -24, 3.5, -27.5, 7.8, -29.5, 3);
    // body
    const B = bodyPath(xn, xt, keys, 44);
    const body = B.path;
    g.fillStyle = vgrad(g, -11, 9.5, [[0, '#3c4854'], [0.38, '#5b6874'], [0.52, '#7d8892'], [0.6, '#cdd2d2'], [1, '#b9bfbf']]);
    g.fill(body);
    g.save();
    g.clip(body);
    mottle(g, rnd, -36, -11, 84, 12, 40, 'rgba(25,32,40,0.12)', 0.6, 2.2);
    mottle(g, rnd, -36, -11, 84, 10, 20, 'rgba(200,210,215,0.06)', 0.6, 2);
    // the line where the dark back meets the pale belly, slightly ragged
    g.strokeStyle = 'rgba(70,80,90,0.35)'; g.lineWidth = 0.9;
    g.beginPath();
    for (let x = 46; x >= -34; x -= 2) { const y = 2.2 + Math.sin(x * 0.35) * 0.5 + (x < 0 ? x * -0.02 : 0); x === 46 ? g.moveTo(x, y) : g.lineTo(x, y); }
    g.stroke();
    // scars
    g.strokeStyle = 'rgba(225,230,232,0.35)'; g.lineWidth = 0.35;
    for (const [x, y, l] of [[6, -4, 7], [3, -2.5, 6], [-14, -5, 5]]) { g.beginPath(); g.moveTo(x, y); g.lineTo(x - l, y + l * 0.35); g.stroke(); }
    g.restore();
    // gill slits
    for (let i = 0; i < 5; i++) {
      const x = 27 - i * 1.9;
      g.strokeStyle = 'rgba(22,28,36,0.65)'; g.lineWidth = 0.55;
      g.beginPath(); g.moveTo(x, -3.2 + i * 0.2); g.quadraticCurveTo(x - 1, 1, x - 0.3, 4.6); g.stroke();
      g.strokeStyle = 'rgba(210,220,225,0.25)'; g.lineWidth = 0.3;
      g.beginPath(); g.moveTo(x + 0.6, -3 + i * 0.2); g.quadraticCurveTo(x - 0.4, 1, x + 0.3, 4.4); g.stroke();
    }
    // mouth with a row of teeth
    g.fillStyle = 'rgba(20,14,16,0.85)';
    g.beginPath(); g.moveTo(45, 3.6); g.quadraticCurveTo(38, 6.6, 31.5, 5.6); g.quadraticCurveTo(38, 5.6, 45, 3.6); g.fill();
    g.strokeStyle = '#1b1e22'; g.lineWidth = 0.6;
    g.beginPath(); g.moveTo(45.5, 3.4); g.quadraticCurveTo(38, 7.4, 31, 5.8); g.stroke();
    g.fillStyle = '#ebe5d2';
    for (let i = 0; i < 9; i++) {
      const f = i / 8, x = 44 - f * 12, y = 4.0 + Math.sin(f * Math.PI) * 2.6;
      tri(g, x - 0.55, y - 0.2, x + 0.55, y - 0.2, x + 0.1, y + 1.1 + (i % 3 === 0 ? 0.5 : 0));
    }
    // nostril, eye
    g.strokeStyle = 'rgba(20,24,30,0.6)'; g.lineWidth = 0.45;
    g.beginPath(); g.moveTo(45.2, 0.6); g.lineTo(43.6, 1.1); g.stroke();
    g.fillStyle = 'rgba(20,24,30,0.55)'; g.beginPath(); g.ellipse(35.6, -1.3, 2.0, 1.6, 0, 0, TAU); g.fill();
    g.fillStyle = '#050608'; g.beginPath(); g.ellipse(35.6, -1.3, 1.25, 1.1, 0, 0, TAU); g.fill();
    g.fillStyle = 'rgba(200,210,215,0.55)'; g.beginPath(); g.arc(35.2, -1.7, 0.3, 0, TAU); g.fill();
    rim(g, body, 'rgba(200,218,230,0.5)', 1.1, 0, 0.7);
    rim(g, body, 'rgba(15,20,26,0.35)', 1.3, 0, -0.8);
    // near pectoral fin
    const pec = new Path2D();
    pec.moveTo(23, 4.6); pec.quadraticCurveTo(13, 13, -3, 23); pec.quadraticCurveTo(6, 13.5, 11.5, 7.6); pec.closePath();
    g.fillStyle = vgrad(g, 4, 23, [[0, '#56636e'], [1, '#3a4652']]);
    g.fill(pec);
    rim(g, pec, 'rgba(210,225,235,0.45)', 0.8, 0.3, 0.3);
    g.strokeStyle = 'rgba(20,26,32,0.35)'; g.lineWidth = 0.5; g.stroke(pec);
  });
}
function sharkTailSprite() {
  return bake('sharkTail', 64, 60, 4.5, (g) => {
    const t = new Path2D();
    t.moveTo(2, -2.4); t.quadraticCurveTo(-10, -9, -26, -26); t.quadraticCurveTo(-19, -12, -13.5, -1.5);
    t.quadraticCurveTo(-18, 6, -16.5, 13.5); t.quadraticCurveTo(-8, 5.5, 2, 2.2); t.closePath();
    g.fillStyle = vgrad(g, -26, 14, [[0, '#33404c'], [0.6, '#56636f'], [1, '#7f8a92']]);
    g.fill(t);
    rim(g, t, 'rgba(200,218,230,0.45)', 0.9, 0.3, 0.4);
    g.strokeStyle = 'rgba(20,26,32,0.3)'; g.lineWidth = 0.4; g.stroke(t);
  });
}

function drawShark(ctx, G, c) {
  if (c.hidden || !onScreen(G, c.x, c.y, SHARK_L)) return;
  const body = sharkSprite(), tail = sharkTailSprite();
  const f = c.face;
  const sx = Math.abs(f) < 0.1 ? 0.1 * sgn(f) : f;
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate(c.pitch * sgn(f));
  ctx.scale(sx, 1);
  // tail: beats from side to side — in profile that reads as a flex and a change of width
  const beat = Math.sin(c.tail);
  const tint = waterTint(G, c.y - wy(G, c.x));
  ctx.save();
  ctx.translate(-SHARK_L * 0.36 + 0.4, 0.2);
  ctx.rotate(beat * 0.14);
  ctx.scale(0.72 + 0.28 * Math.abs(Math.cos(c.tail)), 1);
  putT(ctx, tail, tint);
  ctx.restore();
  putT(ctx, body, tint);
  if (c.flash > 0.01) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = c.flash * 0.35;
    put(ctx, body);
  }
  ctx.restore();
  // a V of foam where the fin cuts the water
  const w = wy(G, c.x);
  if (c.y - 24 < w && G.view.top < 10) {
    const fx = c.x - sgn(f) * 2;
    const depth = clamp((w - (c.y - 24)) / 10, 0, 1);
    ctx.save();
    ctx.strokeStyle = `rgba(236,244,248,${(0.55 * depth).toFixed(3)})`;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(fx + sgn(f) * 3, w);
    ctx.quadraticCurveTo(fx - sgn(f) * 10, w - 1.6, fx - sgn(f) * 24, w + 0.3);
    ctx.moveTo(fx + sgn(f) * 3, w + 0.4);
    ctx.quadraticCurveTo(fx - sgn(f) * 12, w + 1.4, fx - sgn(f) * 30, w + 0.8);
    ctx.stroke();
    ctx.restore();
  }
}

// =====================================================================================
// gulls
// =====================================================================================

function drawGulls(ctx, G, c) {
  const t = G.time;
  for (const b of c.birds) {
    if (b.gone || !onScreen(G, b.x, b.y, 30)) continue;
    drawGull(ctx, b, t);
  }
}

function drawGull(ctx, b, t) {
  const up = b.flapping ? Math.sin(b.flap) : 0.42 + Math.sin(t * 1.3 + b.ph) * 0.06;
  ctx.save();
  ctx.translate(b.x, b.y);
  ctx.rotate(clamp((b.vy2 || 0) * 0.004, -0.3, 0.3) * b.face);
  ctx.scale(b.face * b.size * 1.55, b.size * 1.55);
  // far wing
  wing(ctx, 1.2, -0.9, up * 0.82, 0.78, '#8e979f', '#6c757d', '#2a2c30');
  // tail
  ctx.fillStyle = '#c9ced2';
  ctx.beginPath(); ctx.moveTo(-4.5, -0.6); ctx.lineTo(-8.6, -0.4); ctx.lineTo(-8.2, 1.2); ctx.lineTo(-4.5, 0.9); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#2a2c30'; ctx.fillRect(-8.7, -0.4, 0.8, 1.5);
  // body
  ctx.fillStyle = '#f3f3ef';
  ctx.beginPath(); ctx.ellipse(0, 0, 5.4, 2.2, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = 'rgba(150,160,170,0.55)';
  ctx.beginPath(); ctx.ellipse(-0.8, 1.1, 4.4, 1.0, 0, 0, Math.PI); ctx.fill();
  // head
  ctx.fillStyle = '#f7f7f3';
  ctx.beginPath(); ctx.arc(5.2, -1.3, 1.9, 0, TAU); ctx.fill();
  ctx.fillStyle = '#e4b03c';
  ctx.beginPath(); ctx.moveTo(6.8, -1.6); ctx.lineTo(9.4, -0.9); ctx.lineTo(6.8, -0.5); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#c4402f'; ctx.fillRect(8.2, -0.9, 0.5, 0.4);
  ctx.fillStyle = '#111'; ctx.beginPath(); ctx.arc(5.9, -1.7, 0.36, 0, TAU); ctx.fill();
  // near wing
  wing(ctx, 0.4, -0.6, up, 1, '#c9d0d5', '#7d868e', '#1f2125');
  ctx.restore();
}

// A gull wing with the elbow crook; up = -1 (down) .. 1 (raised).
function wing(ctx, sx, sy, up, k, light, dark, tip) {
  const ex = sx - 2.4 * k, ey = sy - 7 * up * k;
  const tx = sx - 10.5 * k, ty = sy - 12.5 * up * k + 2.6 * k;
  ctx.fillStyle = light;
  ctx.beginPath();
  ctx.moveTo(sx + 1.4, sy);
  ctx.quadraticCurveTo(ex + 1.2, ey - 0.8 * sgn(up), ex, ey);
  ctx.quadraticCurveTo(tx + 3, ty - 1.2 * sgn(up), tx, ty);
  ctx.quadraticCurveTo(ex - 2.5, ey + 1.6 * sgn(up) + 1, sx - 2.8, sy + 0.6);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = dark; ctx.lineWidth = 0.35;
  ctx.beginPath(); ctx.moveTo(sx + 1.4, sy); ctx.quadraticCurveTo(ex + 1.2, ey - 0.8 * sgn(up), ex, ey); ctx.quadraticCurveTo(tx + 3, ty - 1.2 * sgn(up), tx, ty); ctx.stroke();
  // black wing tip
  ctx.fillStyle = tip;
  ctx.beginPath();
  const mx = lerp(ex, tx, 0.62), my = lerp(ey, ty, 0.62);
  ctx.moveTo(mx, my - 0.5); ctx.lineTo(tx, ty); ctx.lineTo(mx - 0.8, my + 1.4); ctx.closePath(); ctx.fill();
}

// =====================================================================================
// flying fish
// =====================================================================================

function flyerSprite(spread) {
  return bake('flyer:' + spread, 30, 22, 8, (g) => {
    const keys = [[0, 0.4, 0.5], [0.1, 1.2, 1.1], [0.35, 1.9, 1.7], [0.7, 1.2, 1.0], [1, 0.5, 0.45]];
    const xn = 6.8, xt = -4.6;
    // tail: the lower lobe is the long one
    g.fillStyle = 'rgba(90,130,170,0.85)';
    g.beginPath(); g.moveTo(xt + 0.4, -0.4); g.lineTo(-9.2, -3.2); g.lineTo(-7.2, 0.2); g.lineTo(-10.8, 3.9); g.lineTo(xt + 0.4, 0.5); g.closePath(); g.fill();
    // far wing
    if (spread) {
      g.fillStyle = 'rgba(120,165,210,0.4)';
      g.beginPath(); g.moveTo(2.4, -1.0); g.quadraticCurveTo(-1, -9, -7.4, -9.6); g.quadraticCurveTo(-4, -5, -1.5, -0.8); g.closePath(); g.fill();
    }
    const B = bodyPath(xn, xt, keys, 24);
    g.fillStyle = vgrad(g, -2, 1.8, [[0, '#24548a'], [0.45, '#7fa6c6'], [0.6, '#d5e2ec'], [1, '#f4f8fa']]);
    g.fill(B.path);
    rim(g, B.path, 'rgba(255,255,255,0.55)', 0.3, 0, 0.2);
    g.fillStyle = '#e8eef0'; g.beginPath(); g.arc(5.0, -0.4, 0.55, 0, TAU); g.fill();
    g.fillStyle = '#05080b'; g.beginPath(); g.arc(5.1, -0.4, 0.34, 0, TAU); g.fill();
    // near wing: a big translucent fin with rays
    const w = new Path2D();
    if (spread) { w.moveTo(3.2, -0.4); w.quadraticCurveTo(0.5, -10.5, -8.6, -11.4); w.quadraticCurveTo(-5.4, -5.6, -2.2, 0.2); }
    else { w.moveTo(3.2, 0); w.quadraticCurveTo(-1, -1.6, -5, -1.0); w.quadraticCurveTo(-2, 0.4, 0, 0.8); }
    w.closePath();
    g.fillStyle = 'rgba(160,200,235,0.55)'; g.fill(w);
    g.save(); g.clip(w);
    g.strokeStyle = 'rgba(40,80,130,0.45)'; g.lineWidth = 0.14;
    for (let i = 0; i < 7; i++) { g.beginPath(); g.moveTo(2.8, -0.2); g.lineTo(-9 + i * 1.4, -12 + i * 1.6); g.stroke(); }
    g.restore();
    g.strokeStyle = 'rgba(230,245,255,0.6)'; g.lineWidth = 0.2; g.stroke(w);
    // pelvic fins
    g.fillStyle = 'rgba(150,190,225,0.5)';
    g.beginPath(); g.moveTo(-1.2, 1); g.lineTo(-4.8, spread ? 3.8 : 1.8); g.lineTo(-3.2, 0.8); g.closePath(); g.fill();
  });
}

function drawFlyingFish(ctx, G, c) {
  const t = G.time;
  for (const f of c.fish) {
    if (f.gone || f.delay > 0 || !onScreen(G, f.x, f.y, 20)) continue;
    const S = flyerSprite(f.mode === 'air' ? 1 : 0);
    ctx.save();
    ctx.translate(f.x, f.y);
    ctx.rotate(f.ang * c.dir);
    ctx.scale(c.dir * f.s, f.s);
    putT(ctx, S, f.mode === 'air' ? NO_TINT : waterTint(G, f.y - wy(G, f.x)));
    ctx.restore();
    // sun glint off the wet wings
    if (f.mode === 'air' && G.light > 0.5) {
      const k = Math.pow(Math.max(0, Math.sin(t * 9 + f.ph)), 10);
      if (k > 0.05) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = k * 0.8;
        ctx.drawImage(glow([255, 250, 230]), f.x - 4, f.y - 6, 8, 8);
        ctx.restore();
      }
    }
  }
}

// =====================================================================================
// dolphins
// =====================================================================================

function dolphinSprite() {
  return bake('dolphin', 64, 40, 5, (g) => {
    const rnd = lcg(5);
    const keys = [[0, 0.6, 0.3], [0.06, 1.4, 1.2], [0.1, 2.2, 1.9], [0.14, 4.4, 2.9], [0.21, 5.7, 4.4], [0.38, 6.7, 5.6], [0.55, 5.8, 4.6], [0.75, 3.4, 2.6], [0.92, 1.6, 1.4], [1, 1.2, 1.1]];
    const xn = 23, xt = -16;
    // dorsal fin
    const d = new Path2D();
    d.moveTo(9, -6.4); d.quadraticCurveTo(3, -10, -4, -15.5); d.quadraticCurveTo(-1.6, -9, -3, -5.4); d.closePath();
    g.fillStyle = '#34495b'; g.fill(d);
    rim(g, d, 'rgba(200,220,235,0.45)', 0.6, 0.2, 0.2);
    // far flipper
    g.fillStyle = '#2c3f50';
    g.beginPath(); g.moveTo(13.5, 3.2); g.bezierCurveTo(12.6, 5.6, 10.6, 7.4, 7.8, 8.2); g.bezierCurveTo(9, 6.6, 10, 4.8, 10.2, 3.2); g.closePath(); g.fill();
    const B = bodyPath(xn, xt, keys, 40);
    g.fillStyle = vgrad(g, -6.8, 5.8, [[0, '#33485b'], [0.35, '#5f7a8e'], [0.55, '#97adbb'], [0.66, '#dfe6e8'], [1, '#e9eef0']]);
    g.fill(B.path);
    g.save(); g.clip(B.path);
    // pale flank blaze
    g.fillStyle = 'rgba(170,190,205,0.35)';
    g.beginPath(); g.ellipse(-2, 0.4, 10, 2.2, -0.12, 0, TAU); g.fill();
    mottle(g, rnd, -16, -6, 38, 8, 14, 'rgba(20,30,40,0.08)', 0.4, 1.4);
    g.restore();
    rim(g, B.path, 'rgba(220,235,245,0.6)', 0.7, 0, 0.45);
    rim(g, B.path, 'rgba(10,20,30,0.3)', 0.7, 0, -0.45);
    // mouth line (the smile), eye, blowhole
    g.strokeStyle = 'rgba(30,40,50,0.6)'; g.lineWidth = 0.32;
    g.beginPath(); g.moveTo(22.6, 0.3); g.quadraticCurveTo(19.5, 1.4, 16.8, 0.7); g.stroke();
    g.fillStyle = 'rgba(30,45,60,0.5)'; g.beginPath(); g.ellipse(14.6, -0.7, 1.4, 0.9, -0.2, 0, TAU); g.fill();
    g.fillStyle = '#06090c'; g.beginPath(); g.arc(14.6, -0.7, 0.55, 0, TAU); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.8)'; g.beginPath(); g.arc(14.4, -0.9, 0.18, 0, TAU); g.fill();
    g.strokeStyle = 'rgba(20,30,40,0.55)'; g.lineWidth = 0.35;
    g.beginPath(); g.arc(8.6, -6.2, 0.6, Math.PI * 1.1, Math.PI * 1.9); g.stroke();
    // near flipper
    const p = new Path2D();
    p.moveTo(15.2, 3.0); p.bezierCurveTo(14.4, 6.0, 11.8, 8.6, 8.2, 9.7); p.bezierCurveTo(9.6, 7.8, 10.8, 5.4, 11.2, 3.3); p.closePath();
    g.fillStyle = vgrad(g, 3, 10, [[0, '#5d7486'], [1, '#3a5064']]); g.fill(p);
    rim(g, p, 'rgba(210,228,240,0.45)', 0.45, 0.15, 0.2);
  });
}
function dolphinTailSprite() {
  return bake('dolphinTail', 30, 14, 5, (g) => {
    g.fillStyle = '#4a6175';
    g.beginPath(); g.moveTo(1, -1.2); g.quadraticCurveTo(-6, -2.6, -11.5, -1.6); g.lineTo(-10.2, 0.1); g.lineTo(-11.6, 1.7); g.quadraticCurveTo(-6, 2.4, 1, 1.1); g.closePath(); g.fill();
    g.fillStyle = 'rgba(150,175,195,0.5)';
    g.beginPath(); g.moveTo(-1, -1); g.quadraticCurveTo(-6, -4, -10.5, -3.6); g.quadraticCurveTo(-6, -2.4, -1, -0.6); g.closePath(); g.fill();
  });
}

function drawDolphins(ctx, G, c) {
  const body = dolphinSprite(), tail = dolphinTailSprite();
  for (const d of c.pod) {
    if (d.gone || !onScreen(G, d.x, d.y, 40)) continue;
    ctx.save();
    ctx.translate(d.x, d.y);
    ctx.rotate(d.ang * c.dir);
    ctx.scale(c.dir * d.s * 1.3, d.s * 1.3);
    const tint = d.mode === 'air' ? NO_TINT : waterTint(G, d.y - wy(G, d.x));
    ctx.save();
    ctx.translate(-16, 0.2);
    ctx.rotate(Math.sin(d.tail) * (d.mode === 'air' ? 0.15 : 0.32));
    putT(ctx, tail, tint);
    ctx.restore();
    putT(ctx, body, tint);
    ctx.restore();
  }
}

// =====================================================================================
// turtle
// =====================================================================================

function turtleSprite() {
  return bake('turtle', 84, 46, 4, (g) => {
    const rnd = lcg(33);
    // neck + head
    const skin = '#7a826a';
    g.fillStyle = vgrad(g, -6, 6, [[0, '#8b9378'], [1, '#5c634e']]);
    g.beginPath(); g.moveTo(21, -4); g.quadraticCurveTo(27, -6.4, 30, -5.4); g.lineTo(30, 3); g.quadraticCurveTo(26, 4.6, 21, 4.4); g.closePath(); g.fill();
    const head = new Path2D();
    head.moveTo(27, -2); head.bezierCurveTo(28, -7.6, 36, -8.2, 39.5, -3.6);
    head.quadraticCurveTo(41.2, -1.2, 39.6, 0.6); head.quadraticCurveTo(36.5, 3.6, 31, 3.4); head.quadraticCurveTo(27.4, 2.6, 27, -2);
    head.closePath();
    g.fillStyle = vgrad(g, -8, 4, [[0, '#919a7e'], [0.6, skin], [1, '#5d6450']]);
    g.fill(head);
    g.save(); g.clip(head);
    g.strokeStyle = 'rgba(40,44,32,0.55)'; g.lineWidth = 0.3;
    g.fillStyle = 'rgba(190,196,160,0.55)';
    for (const [x, y, w, h] of [[30.5, -5.5, 2.6, 1.8], [33.5, -6, 2.4, 1.6], [29.5, -2.6, 2, 1.8], [36.4, -5, 1.8, 1.4]]) {
      g.beginPath(); g.ellipse(x, y, w, h, 0.3, 0, TAU); g.fill(); g.stroke();
    }
    g.restore();
    rim(g, head, 'rgba(240,240,210,0.45)', 0.6, 0, 0.35);
    // beak, mouth, the old eye
    g.strokeStyle = 'rgba(30,30,22,0.75)'; g.lineWidth = 0.4;
    g.beginPath(); g.moveTo(40.3, -0.6); g.quadraticCurveTo(37, 1.0, 33.6, 0.4); g.stroke();
    g.fillStyle = '#d8d0a8'; g.beginPath(); g.moveTo(39.6, -3.6); g.quadraticCurveTo(41.4, -1.8, 40.3, -0.5); g.lineTo(39.2, -1.6); g.closePath(); g.fill();
    g.fillStyle = '#121310'; g.beginPath(); g.ellipse(35.2, -3.2, 1.0, 0.8, 0, 0, TAU); g.fill();
    g.fillStyle = 'rgba(255,255,240,0.75)'; g.beginPath(); g.arc(34.9, -3.5, 0.25, 0, TAU); g.fill();
    g.strokeStyle = 'rgba(40,40,30,0.7)'; g.lineWidth = 0.35;
    g.beginPath(); g.arc(35.2, -3.0, 1.6, Math.PI * 1.15, Math.PI * 1.85); g.stroke();
    // plastron edge
    g.fillStyle = vgrad(g, 0, 9, [[0, '#d0bf86'], [1, '#8d7c4c']]);
    g.beginPath(); g.moveTo(22, 1.5); g.bezierCurveTo(10, 9.6, -12, 9.8, -22, 3); g.lineTo(-20, 1); g.closePath(); g.fill();
    // carapace
    const shell = new Path2D();
    shell.moveTo(-25, 2.4);
    shell.bezierCurveTo(-23, -10.5, -10, -15.5, 2, -15.5);
    shell.bezierCurveTo(14, -15.5, 23, -9.5, 25.5, 1.4);
    shell.bezierCurveTo(18, 6.4, -14, 7.4, -25, 2.4);
    shell.closePath();
    g.fillStyle = vgrad(g, -15.5, 7, [[0, '#857547'], [0.5, '#5b512f'], [1, '#332d1b']]);
    g.fill(shell);
    g.save(); g.clip(shell);
    // scutes: a central row and the costals, each with a warm amber centre
    const vert = [[-15, -11.5], [-6, -13.6], [3.5, -14], [12.5, -12]];
    for (const [x, y] of vert) {
      const rg = g.createRadialGradient(x, y + 2, 0.5, x, y + 2, 6);
      rg.addColorStop(0, 'rgba(176,150,84,0.55)'); rg.addColorStop(1, 'rgba(176,150,84,0)');
      g.fillStyle = rg; g.fillRect(x - 7, y - 5, 14, 14);
    }
    g.strokeStyle = 'rgba(30,25,14,0.7)'; g.lineWidth = 0.55;
    const seam = (pts) => { g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke(); };
    seam([[-20, -6.5], [-15, -8], [-10, -9.6], [-1.5, -10.4], [8, -10], [16, -8], [21, -4.5]]);
    seam([[-10.5, -9.6], [-10.5, -15]]); seam([[-1.5, -10.4], [-1.5, -16]]); seam([[8, -10], [8.5, -15.5]]);
    seam([[-23, -0.5], [-18, -1.4], [-10, -2], [0, -2.2], [10, -2], [18, -1.2], [24, 0]]);
    seam([[-15, -8], [-16, -1.6]]); seam([[-4, -10.2], [-5, -2.2]]); seam([[8, -10], [7, -2.1]]); seam([[16, -8], [17, -1.4]]);
    // marginal scutes along the rim
    g.lineWidth = 0.35;
    for (let x = -22; x < 24; x += 3.2) seam([[x, -0.4 - Math.abs(x) * 0.02], [x + 0.6, 4.2]]);
    // growth rings, scratches, algae fuzz
    g.strokeStyle = 'rgba(200,180,120,0.18)'; g.lineWidth = 0.25;
    for (const [x, y] of vert) for (let r = 2; r < 6; r += 1.6) { g.beginPath(); g.ellipse(x, y + 2, r, r * 0.6, 0, Math.PI, TAU); g.stroke(); }
    g.strokeStyle = 'rgba(230,220,190,0.35)'; g.lineWidth = 0.25;
    seam([[2, -12], [9, -7.5]]); seam([[3.5, -12.4], [9.6, -8.6]]);
    mottle(g, rnd, -25, -16, 50, 10, 30, 'rgba(96,128,62,0.35)', 0.4, 1.6);
    g.fillStyle = vgrad(g, -2, 7, [[0, 'rgba(0,0,0,0)'], [1, 'rgba(10,8,4,0.45)']]);
    g.fillRect(-26, -2, 52, 10);
    g.restore();
    rim(g, shell, 'rgba(255,236,190,0.5)', 1.0, 0, 0.6);
    // barnacles on the back of the shell, weed trailing from the rim
    barnacleCluster(g, rnd, -12, -12.5, 7, 6, 0.85);
    barnacleCluster(g, rnd, -19, -6.5, 5, 4, 0.8);
    barnacleCluster(g, rnd, 6, -14.2, 3, 3, 0.7);
    g.strokeStyle = 'rgba(92,120,58,0.85)'; g.lineWidth = 0.45;
    for (let i = 0; i < 6; i++) {
      const x = -23 + i * 2.6, y = -4 - Math.sin(i) * 3;
      g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x - 3, y + 2, x - 5 - rnd() * 3, y + 4 + rnd() * 3); g.stroke();
    }
  });
}
function turtleFlipperSprite(front) {
  return bake('turtleF' + front, front ? 60 : 30, front ? 56 : 26, 4, (g) => {
    const p = new Path2D();
    if (front) { p.moveTo(2.4, -2.2); p.bezierCurveTo(5, 7, 0, 18, -12, 25); p.bezierCurveTo(-7, 15, -4.5, 6, -3.2, 1.4); }
    else { p.moveTo(1.4, -1.4); p.bezierCurveTo(1.6, 4, -3, 8, -9, 9.5); p.bezierCurveTo(-5.6, 5.4, -3.4, 2.4, -2.2, 1); }
    p.closePath();
    g.fillStyle = vgrad(g, -2, front ? 25 : 10, [[0, '#7f876d'], [1, '#596048']]);
    g.fill(p);
    g.save(); g.clip(p);
    g.fillStyle = 'rgba(190,196,160,0.5)'; g.strokeStyle = 'rgba(40,44,32,0.5)'; g.lineWidth = 0.25;
    const n = front ? 9 : 4;
    for (let i = 0; i < n; i++) {
      const f = i / n, x = lerp(1, front ? -9 : -6, f), y = lerp(0.5, front ? 21 : 8, f);
      g.beginPath(); g.ellipse(x, y, 1.6, 1.1, 0.8, 0, TAU); g.fill(); g.stroke();
    }
    g.restore();
    rim(g, p, 'rgba(240,240,210,0.4)', 0.5, 0.2, 0.2);
    g.strokeStyle = 'rgba(30,32,24,0.45)'; g.lineWidth = 0.35; g.stroke(p);
  });
}

function drawTurtle(ctx, G, c) {
  if (!onScreen(G, c.x, c.y, 60)) return;
  const t = c.t;
  const body = turtleSprite(), ff = turtleFlipperSprite(1), rf = turtleFlipperSprite(0);
  const stroke = Math.sin(t * 1.5 + c.ph);
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate(Math.sin(t * 0.5) * 0.04 * c.dir);
  ctx.scale(c.dir, 1);
  // far flippers (darker, out of phase)
  const tint = waterTint(G, c.y - wy(G, c.x));
  const far = { col: tint.col || DEEP_COL, k: Math.min(0.85, tint.k + 0.25) };
  ctx.save(); ctx.translate(15, 0.5); ctx.rotate(-0.7 - stroke * 0.55); putT(ctx, ff, far); ctx.restore();
  ctx.save(); ctx.translate(-19, 2); ctx.rotate(-0.2 + stroke * 0.2); putT(ctx, rf, far); ctx.restore();
  putT(ctx, body, tint);
  ctx.save(); ctx.translate(13, 3); ctx.rotate(-0.55 + stroke * 0.6); putT(ctx, ff, tint); ctx.restore();
  ctx.save(); ctx.translate(-20, 3.5); ctx.rotate(0.1 - stroke * 0.22); putT(ctx, rf, tint); ctx.restore();
  ctx.restore();
}

// =====================================================================================
// manta — drawn live, the wings flex as it glides
// =====================================================================================

function drawManta(ctx, G, c) {
  if (!onScreen(G, c.x, c.y, 130)) return;
  const t = c.t;
  const ph = t * 1.15 + c.ph;
  const p = Math.sin(ph);
  // the wingtips lag behind the stroke and the span breathes as the wings rise and fall
  const tipX = -24 + p * 13;
  const yL = 56 * (0.86 + 0.14 * Math.cos(ph));
  const yU = yL * 0.8;
  const curl = Math.sin(ph - 0.9) * 6;
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.scale(c.dir, 1);
  ctx.rotate(Math.sin(t * 0.42 + c.ph) * 0.05);
  // the thin whip of a tail
  ctx.strokeStyle = 'rgba(22,32,40,0.9)';
  ctx.lineCap = 'round';
  let px = -34, py = 0;
  for (let i = 1; i <= 10; i++) {
    const f = i / 10, x = -34 - f * 70, y = Math.sin(t * 1.8 - f * 3) * 3.5 * f;
    ctx.lineWidth = 1.8 * (1 - f) + 0.3;
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(x, y); ctx.stroke();
    px = x; py = y;
  }
  const path = new Path2D();
  path.moveTo(47, 0);
  // near (lower) horn, leading edge, wingtip, trailing edge
  path.bezierCurveTo(50, 4, 55, 9, 51, 14);
  path.quadraticCurveTo(45, 13, 41, 9.5);
  path.bezierCurveTo(30, 22, 6, yL * 0.78, tipX, yL + curl);
  path.bezierCurveTo(tipX + 9, yL * 0.74, -4, yL * 0.5, -16, yL * 0.24);
  path.quadraticCurveTo(-27, 9, -34, 2.5);
  path.quadraticCurveTo(-37, 0, -34, -2.5);
  // far (upper) wing
  path.quadraticCurveTo(-27, -7, -16, -yU * 0.24);
  path.bezierCurveTo(-4, -yU * 0.5, tipX + 12, -yU * 0.74, tipX + 5, -yU - curl * 0.7);
  path.bezierCurveTo(8, -yU * 0.78, 30, -17, 41, -7.5);
  path.quadraticCurveTo(45, -11, 50.5, -11.5);
  path.bezierCurveTo(53.5, -7, 49, -3, 47, 0);
  path.closePath();
  const gr = ctx.createLinearGradient(0, -yU, 0, yL);
  gr.addColorStop(0, '#3b5263'); gr.addColorStop(0.3, '#23323e'); gr.addColorStop(0.47, '#141e27'); gr.addColorStop(0.62, '#1d2a35'); gr.addColorStop(1, '#3a5163');
  ctx.fillStyle = gr;
  ctx.fill(path);
  ctx.save();
  ctx.clip(path);
  // pale shoulder patches, soft
  ctx.fillStyle = 'rgba(196,210,216,0.26)';
  ctx.beginPath(); ctx.ellipse(15, 15, 15, 5, 0.55, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.ellipse(15, -11, 11, 3.6, -0.55, 0, TAU); ctx.fill();
  ctx.fillStyle = 'rgba(196,210,216,0.12)';
  ctx.beginPath(); ctx.ellipse(8, 22, 20, 7, 0.6, 0, TAU); ctx.fill();
  // freckles
  ctx.fillStyle = 'rgba(8,14,20,0.45)';
  for (let i = 0; i < 11; i++) { ctx.beginPath(); ctx.arc(-14 + hash1(i, 3) * 30, (hash1(i, 5) - 0.5) * 26, 0.8 + hash1(i, 7) * 1.2, 0, TAU); ctx.fill(); }
  // a soft ridge down the back, and the wings' muscle lines
  ctx.strokeStyle = 'rgba(120,150,170,0.2)'; ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.moveTo(42, 0); ctx.quadraticCurveTo(4, -1.5, -32, 0); ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,0.18)'; ctx.lineWidth = 0.8;
  for (const k of [1, -0.7]) { ctx.beginPath(); ctx.moveTo(20, 4 * k); ctx.quadraticCurveTo(0, 22 * k, tipX * 0.6, (k > 0 ? yL : yU) * 0.75 * Math.sign(k)); ctx.stroke(); }
  ctx.restore();
  // light from above along the far leading edge
  ctx.strokeStyle = 'rgba(190,215,230,0.42)'; ctx.lineWidth = 1.1;
  ctx.beginPath(); ctx.moveTo(41, -7.5); ctx.bezierCurveTo(30, -17, 8, -yU * 0.78, tipX + 5, -yU - curl * 0.7); ctx.stroke();
  ctx.strokeStyle = 'rgba(190,215,230,0.16)'; ctx.lineWidth = 0.8;
  ctx.beginPath(); ctx.moveTo(41, 9.5); ctx.bezierCurveTo(30, 22, 6, yL * 0.78, tipX, yL + curl); ctx.stroke();
  // the mouth between the horns
  ctx.fillStyle = 'rgba(210,222,226,0.45)';
  ctx.beginPath(); ctx.ellipse(46, 0, 1.6, 4.2, 0, 0, TAU); ctx.fill();
  const tint = waterTint(G, c.y);
  if (tint.k > 0.02) { ctx.fillStyle = rgbaC(tint.col, tint.k); ctx.fill(path); }
  ctx.restore();
}

// =====================================================================================
// jellyfish
// =====================================================================================

function drawJellies(ctx, G, c) {
  const t = G.time;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const j of c.jellies) {
    if (j.a <= 0.01 || !onScreen(G, j.x, j.y, j.r * 6)) continue;
    const r = j.r, a = j.a * (j.hurt ? 0.5 : 1);
    const th = j.th || 0;
    const sx = 1 + th * 0.14, sy = 1 - th * 0.18;
    const col = j.col, hi = mixColor(col, [255, 255, 255], 0.55);
    // halo
    ctx.globalAlpha = 0.42 * a;
    ctx.drawImage(glow(col), j.x - r * 3, j.y - r * 2.6, r * 6, r * 6);
    ctx.globalAlpha = 1;
    // tentacles
    const len = r * (5 + (j.arms % 3));
    ctx.lineWidth = 0.45;
    ctx.strokeStyle = rgbaC(col, 0.38 * a);
    ctx.beginPath();
    for (let k = 0; k < j.arms; k++) {
      const x0 = j.x + (k / (j.arms - 1) - 0.5) * r * 1.7 * sx;
      ctx.moveTo(x0, j.y + r * 0.1);
      for (let s = 1; s <= 9; s++) {
        const f = s / 9;
        ctx.lineTo(x0 + Math.sin(t * 1.6 + k * 1.3 + f * 4 + j.ph * 0.3) * f * r * 0.45 - (j.vx || 0) * f * 0.3, j.y + r * 0.1 + f * len * (1 - th * 0.15));
      }
    }
    ctx.stroke();
    // frilly oral arms
    ctx.lineWidth = r * 0.22;
    ctx.strokeStyle = rgbaC(hi, 0.22 * a);
    ctx.beginPath();
    for (let k = -1; k <= 1; k += 2) {
      const x0 = j.x + k * r * 0.18;
      ctx.moveTo(x0, j.y);
      for (let s = 1; s <= 6; s++) { const f = s / 6; ctx.lineTo(x0 + Math.sin(t * 2.2 + f * 5 + k) * r * 0.28, j.y + f * r * 2.6); }
    }
    ctx.stroke();
    // the bell
    ctx.save();
    ctx.translate(j.x, j.y);
    ctx.scale(sx, sy);
    const bell = new Path2D();
    bell.moveTo(-r, 0);
    bell.bezierCurveTo(-r * 1.02, -r * 1.25, r * 1.02, -r * 1.25, r, 0);
    for (let s = 6; s > 0; s--) {
      const x1 = r - (2 * r) * ((6 - s + 0.5) / 6), x2 = r - (2 * r) * ((6 - s + 1) / 6);
      bell.quadraticCurveTo(x1, r * 0.22, x2, 0);
    }
    bell.closePath();
    ctx.fillStyle = rgbaC(col, 0.26 * a);
    ctx.fill(bell);
    ctx.strokeStyle = rgbaC(hi, 0.6 * a);
    ctx.lineWidth = 0.55;
    ctx.stroke(bell);
    // inner glow + gonads
    ctx.globalAlpha = 0.5 * a;
    ctx.drawImage(glow(hi), -r * 0.8, -r * 1.05, r * 1.6, r * 1.3);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = rgbaC([255, 255, 255], 0.35 * a);
    ctx.lineWidth = 0.4;
    for (let k = 0; k < 4; k++) {
      ctx.beginPath(); ctx.ellipse((k - 1.5) * r * 0.3, -r * 0.42, r * 0.13, r * 0.2, 0, 0, TAU); ctx.stroke();
    }
    ctx.restore();
  }
  ctx.restore();
}

// =====================================================================================
// the angler
// =====================================================================================

function anglerSprite() {
  return bake('angler', 170, 120, 3, (g) => {
    const rnd = lcg(77);
    const keys = [[0, 9, 7], [0.08, 26, 14], [0.25, 40, 18], [0.42, 38, 22], [0.62, 24, 18], [0.85, 11, 9], [1, 7, 6]];
    const xn = 52, xt = -52;
    // tail fan
    g.fillStyle = '#120f0d';
    g.beginPath(); g.moveTo(xt + 2, -5); g.lineTo(-74, -16); g.quadraticCurveTo(-70, 0, -75, 15); g.lineTo(xt + 2, 5); g.closePath(); g.fill();
    g.strokeStyle = 'rgba(70,60,50,0.4)'; g.lineWidth = 0.5;
    for (let i = -3; i <= 3; i++) { g.beginPath(); g.moveTo(xt, 0); g.lineTo(-72, i * 5); g.stroke(); }
    const B = bodyPath(xn, xt, keys, 40);
    g.fillStyle = vgrad(g, -40, 22, [[0, '#2a221c'], [0.5, '#16120f'], [1, '#0b0908']]);
    g.fill(B.path);
    g.save(); g.clip(B.path);
    // lumpy, warty skin
    for (let i = 0; i < 90; i++) {
      const x = -50 + rnd() * 100, y = -40 + rnd() * 60, r = 0.8 + rnd() * 2.6;
      g.fillStyle = `rgba(${60 + rnd() * 30 | 0},${48 + rnd() * 20 | 0},${40},${0.25 + rnd() * 0.3})`;
      g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.beginPath(); g.arc(x + r * 0.3, y + r * 0.35, r * 0.7, 0, TAU); g.fill();
    }
    // the upper lip + mouth cavity line
    g.fillStyle = 'rgba(30,8,10,0.9)';
    g.beginPath(); g.moveTo(54, 6); g.quadraticCurveTo(32, 14, 8, 10); g.lineTo(8, 20); g.lineTo(54, 20); g.closePath(); g.fill();
    g.restore();
    rim(g, B.path, 'rgba(120,100,80,0.45)', 1.6, 0, 1.0);
    rim(g, B.path, 'rgba(120,170,160,0.35)', 2.2, -1.2, 0.6);
    // upper teeth: long, crooked needles
    g.fillStyle = '#d9d1b9';
    for (let i = 0; i < 12; i++) {
      const f = i / 11, x = 52 - f * 40, y = 7.5 + Math.sin(f * Math.PI) * 3.5;
      const len = 4 + rnd() * 7 * (1 - f * 0.5), lean = (rnd() - 0.5) * 2.5;
      tri(g, x - 0.7, y - 0.5, x + 0.7, y - 0.5, x + lean, y + len);
    }
    // tiny blind eye
    g.fillStyle = 'rgba(150,165,170,0.9)';
    g.beginPath(); g.arc(30, -13, 2.6, 0, TAU); g.fill();
    g.fillStyle = 'rgba(220,230,235,0.6)';
    g.beginPath(); g.arc(29.3, -13.7, 0.9, 0, TAU); g.fill();
    // filaments
    g.strokeStyle = 'rgba(80,66,54,0.6)'; g.lineWidth = 0.5;
    for (let i = 0; i < 6; i++) {
      const x = -30 + i * 9, y = 14 + Math.sin(i) * 3;
      g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x - 2, y + 6, x + 1, y + 10 + i % 3 * 3); g.stroke();
    }
    // pectoral fin
    g.fillStyle = 'rgba(40,32,26,0.95)';
    g.beginPath(); g.moveTo(-4, 6); g.quadraticCurveTo(-14, 18, -22, 20); g.quadraticCurveTo(-14, 10, -10, 3); g.closePath(); g.fill();
  });
}
function anglerJawSprite() {
  return bake('anglerJaw', 130, 60, 3, (g) => {
    const rnd = lcg(19);
    // pivot at the origin (the hinge); the jaw juts forward beyond the upper lip
    const jaw = new Path2D();
    jaw.moveTo(0, -2); jaw.quadraticCurveTo(30, -4, 58, -9);
    jaw.quadraticCurveTo(61, -4, 56, 2); jaw.quadraticCurveTo(30, 16, 0, 12); jaw.closePath();
    g.fillStyle = vgrad(g, -9, 14, [[0, '#231c17'], [1, '#0a0807']]);
    g.fill(jaw);
    rim(g, jaw, 'rgba(120,100,80,0.4)', 1.3, 0, 0.8);
    g.fillStyle = '#ded6be';
    for (let i = 0; i < 13; i++) {
      const f = i / 12, x = 4 + f * 52, y = -2.4 - f * 6.4;
      const len = 5 + rnd() * 9 * (0.4 + f * 0.6), lean = (rnd() - 0.5) * 3;
      tri(g, x - 0.8, y + 0.6, x + 0.8, y + 0.6, x + lean, y - len);
    }
  });
}

function drawAngler(ctx, G, c) {
  if (!onScreen(G, c.x, c.y, ANGLER_L)) return;
  const L = ANGLER_L;
  const body = anglerSprite(), jaw = anglerJawSprite();
  const f = c.face, sx = Math.abs(f) < 0.12 ? 0.12 * sgn(f) : f;
  const t = c.t;
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.scale(sx, 1);
  ctx.rotate(Math.sin(t * 0.7) * 0.03);
  // open mouth: the dark throat behind the jaw
  if (c.jaw > 0.05) {
    ctx.fillStyle = 'rgba(18,4,6,0.95)';
    ctx.beginPath(); ctx.moveTo(10, 8); ctx.lineTo(56, 6); ctx.lineTo(54, 8 + c.jaw * 44); ctx.lineTo(10, 18); ctx.closePath(); ctx.fill();
  }
  ctx.save();
  ctx.translate(8, 12);
  ctx.rotate(c.jaw * 0.75);
  put(ctx, jaw);
  ctx.restore();
  put(ctx, body);
  if (c.flash > 0.01) { ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = c.flash * 0.3; put(ctx, body); ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1; }
  // the illicium and its lure
  const lx = L * 0.6, ly = -L * 0.1 + Math.sin(t * 1.6) * 3;
  ctx.strokeStyle = 'rgba(60,50,42,0.95)'; ctx.lineWidth = 1.1;
  ctx.beginPath(); ctx.moveTo(24, -36); ctx.quadraticCurveTo(52, -66 + Math.sin(t * 1.2) * 3, lx, ly - 3); ctx.stroke();
  ctx.restore();
  // the glow lives in world space so it never squashes during a turn
  const wx = c.x + f * L * 0.6, wyy = c.y + ly;
  const a = c.lureA;
  if (a > 0.01) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = a;
    ctx.drawImage(glow([150, 255, 220]), wx - 16, wyy - 16, 32, 32);
    ctx.globalAlpha = Math.min(1, a * 1.2);
    ctx.drawImage(glow([235, 255, 245]), wx - 4, wyy - 4, 8, 8);
    ctx.restore();
  }
  ctx.fillStyle = `rgba(220,255,240,${(0.3 + 0.7 * a).toFixed(3)})`;
  ctx.beginPath(); ctx.arc(wx, wyy, 1.8, 0, TAU); ctx.fill();
}

// =====================================================================================
// the whale (drawDeep)
// =====================================================================================

function whaleSprite() {
  return bake('whale', 620, 200, 1.8, (g) => {
    const rnd = lcg(404);
    const keys = [[0, 4, 14], [0.03, 13, 24], [0.1, 30, 44], [0.2, 46, 60], [0.32, 56, 64], [0.45, 56, 56], [0.58, 48, 44], [0.7, 40, 34], [0.82, 31, 25], [0.92, 24, 19], [1, 20, 16]];
    const xn = 280, xt = -210;
    const bump = (u) => {
      let b = 0;
      const d = u - 0.655;
      b += 17 * Math.exp(-Math.pow(d / (d < 0 ? 0.04 : 0.016), 2));
      for (const k of [0.74, 0.79, 0.84, 0.89]) b += 3.2 * Math.exp(-Math.pow((u - k) / 0.012, 2));
      return b;
    };
    const B = bodyPath(xn, xt, keys, 90, bump);
    const body = B.path;
    g.fillStyle = vgrad(g, -66, 64, [[0, '#111922'], [0.35, '#1b2631'], [0.52, '#283541'], [0.66, '#46535d'], [0.82, '#66737b'], [1, '#76828a']]);
    g.fill(body);
    g.save();
    g.clip(body);
    // mottling and pale scars
    mottle(g, rnd, -200, -70, 480, 140, 160, 'rgba(10,16,22,0.10)', 2, 9);
    mottle(g, rnd, -200, -70, 480, 80, 60, 'rgba(200,210,215,0.05)', 2, 8);
    g.strokeStyle = 'rgba(200,210,215,0.13)'; g.lineWidth = 0.9;
    for (let i = 0; i < 7; i++) {
      const x = -120 + rnd() * 300, y = -34 + rnd() * 40, l = 10 + rnd() * 26;
      g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x - l * 0.5, y + (rnd() - 0.5) * 6, x - l, y + l * 0.12); g.stroke();
    }
    // the lower jaw is a shade lighter
    g.fillStyle = 'rgba(130,145,152,0.18)';
    g.beginPath(); g.moveTo(281, 7); g.quadraticCurveTo(212, 28, 150, 12); g.lineTo(150, 70); g.lineTo(281, 70); g.closePath(); g.fill();
    // throat grooves: long pleats from the chin to the navel
    const botAt = (x) => {
      const u = clamp((xn - x) / (xn - xt), 0, 1);
      return prof(keys, u, 2);
    };
    for (let k = 0; k < 11; k++) {
      const d = 3 + k * 5.4;
      const x0 = 268 - k * 5, x1 = 30 + k * 16;
      g.beginPath();
      for (let x = x0; x >= x1; x -= 6) { const y = botAt(x) - d; x === x0 ? g.moveTo(x, y) : g.lineTo(x, y); }
      g.strokeStyle = 'rgba(16,22,28,0.4)'; g.lineWidth = 1.4; g.stroke();
      g.save(); g.translate(0, -1.6);
      g.strokeStyle = 'rgba(190,200,206,0.2)'; g.lineWidth = 0.9; g.stroke();
      g.restore();
    }
    // tubercles on the rostrum
    for (let i = 0; i < 9; i++) {
      const u = 0.015 + i * 0.016, x = lerp(xn, xt, u), y = -prof(keys, u, 1) + 4 + (i % 2) * 5;
      g.fillStyle = 'rgba(10,14,18,0.5)'; g.beginPath(); g.arc(x + 0.8, y + 1, 3.0, 0, TAU); g.fill();
      g.fillStyle = '#3a4754'; g.beginPath(); g.arc(x, y, 2.7, 0, TAU); g.fill();
      g.fillStyle = 'rgba(190,205,215,0.4)'; g.beginPath(); g.arc(x - 0.8, y - 0.9, 1.0, 0, TAU); g.fill();
    }
    g.restore();
    // mouth line, eye
    g.strokeStyle = 'rgba(12,16,20,0.85)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(279, 6); g.quadraticCurveTo(212, 27, 150, 11); g.stroke();
    g.strokeStyle = 'rgba(180,195,205,0.3)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(276, 8.5); g.quadraticCurveTo(212, 29.5, 152, 13.5); g.stroke();
    g.fillStyle = 'rgba(18,24,30,0.8)'; g.beginPath(); g.ellipse(139, 5, 9, 6, -0.1, 0, TAU); g.fill();
    g.fillStyle = '#05070a'; g.beginPath(); g.ellipse(139, 5, 4.4, 3.2, -0.1, 0, TAU); g.fill();
    g.fillStyle = 'rgba(200,215,225,0.55)'; g.beginPath(); g.arc(137.6, 3.8, 1.0, 0, TAU); g.fill();
    g.strokeStyle = 'rgba(160,175,185,0.35)'; g.lineWidth = 0.9;
    for (let k = 0; k < 3; k++) { g.beginPath(); g.arc(139, 5, 11 + k * 3.5, Math.PI * 1.1, Math.PI * 1.6); g.stroke(); }
    // barnacles: chin, throat, head
    barnacleCluster(g, rnd, 262, 18, 16, 16, 2.6);
    barnacleCluster(g, rnd, 236, 34, 10, 14, 2.2);
    barnacleCluster(g, rnd, 200, 46, 8, 12, 2.0);
    barnacleCluster(g, rnd, 246, -22, 7, 10, 2.0);
    barnacleCluster(g, rnd, -150, 6, 6, 12, 1.8);
    rim(g, body, 'rgba(170,200,222,0.35)', 3.2, 0, 2);
    rim(g, body, 'rgba(0,0,0,0.3)', 3, 0, -2);
  });
}
function whaleFinSprite() {
  return bake('whaleFin', 360, 70, 1.8, (g) => {
    const rnd = lcg(808);
    const fin = new Path2D();
    fin.moveTo(8, -13);
    fin.bezierCurveTo(-40, -15, -110, -8, -166, 4);
    fin.quadraticCurveTo(-172, 7, -164, 9);
    // the knobbly leading edge, back toward the body
    let x = -164;
    while (x < 4) {
      const nx = Math.min(4, x + 11);
      const w0 = lerp(14, 4, (x + 164) / 168), w1 = lerp(14, 4, (nx + 164) / 168);
      fin.quadraticCurveTo((x + nx) / 2, 15 - w0 * 0.5 + 3.2, nx, 15 - w1 * 0.5);
      x = nx;
    }
    fin.lineTo(8, 14);
    fin.closePath();
    g.fillStyle = vgrad(g, -14, 16, [[0, '#4f5c66'], [0.35, '#8d989e'], [0.7, '#bcc5c8'], [1, '#d3dadb']]);
    g.fill(fin);
    g.save(); g.clip(fin);
    mottle(g, rnd, -170, -14, 180, 14, 22, 'rgba(30,40,50,0.22)', 2, 6);
    g.fillStyle = vgrad(g, -14, 16, [[0, 'rgba(14,20,26,0.6)'], [0.4, 'rgba(14,20,26,0)']]);
    g.fillRect(-175, -16, 190, 34);
    g.restore();
    barnacleCluster(g, rnd, -36, 11, 6, 16, 1.6);
    barnacleCluster(g, rnd, -104, 9, 4, 10, 1.4);
    rim(g, fin, 'rgba(230,240,245,0.35)', 1.6, 0, 1.2);
    g.strokeStyle = 'rgba(20,28,36,0.35)'; g.lineWidth = 0.8; g.stroke(fin);
  });
}
function whaleTailSprite() {
  return bake('whaleTail', 300, 150, 1.8, (g) => {
    // tail stock
    const st = new Path2D();
    st.moveTo(34, -23); st.lineTo(4, -21); st.quadraticCurveTo(-34, -15, -64, -8); st.lineTo(-64, 7); st.quadraticCurveTo(-34, 13, 4, 17); st.lineTo(34, 18); st.closePath();
    g.fillStyle = vgrad(g, -66, 64, [[0, '#111922'], [0.35, '#1b2631'], [0.52, '#283541'], [0.66, '#46535d'], [0.82, '#66737b'], [1, '#76828a']]);
    g.fill(st);
    rim(g, st, 'rgba(170,200,222,0.3)', 2.4, 0, 1.4);
    // flukes, seen a little from above: the far one up, the near one down
    g.save();
    g.translate(14, 0);
    const fl = new Path2D();
    fl.moveTo(-74, -6);
    fl.bezierCurveTo(-92, -26, -118, -50, -138, -60);
    fl.quadraticCurveTo(-128, -40, -116, -26);
    fl.quadraticCurveTo(-108, -12, -104, -2);
    fl.quadraticCurveTo(-110, 14, -122, 32);
    fl.quadraticCurveTo(-132, 52, -142, 66);
    fl.bezierCurveTo(-120, 56, -94, 30, -74, 6);
    fl.closePath();
    g.fillStyle = vgrad(g, -60, 66, [[0, '#0f171f'], [0.45, '#1b2631'], [0.6, '#2c3945'], [1, '#202c37']]);
    g.fill(fl);
    g.save(); g.clip(fl);
    // the pale underside pattern of the near fluke
    g.fillStyle = 'rgba(170,182,188,0.38)';
    g.beginPath(); g.moveTo(-96, 12); g.quadraticCurveTo(-118, 30, -134, 56); g.quadraticCurveTo(-112, 40, -100, 18); g.closePath(); g.fill();
    g.fillStyle = 'rgba(20,28,36,0.6)';
    g.beginPath(); g.ellipse(-118, 36, 5, 2.4, 0.9, 0, TAU); g.fill();
    g.restore();
    // scalloped trailing edge
    g.strokeStyle = 'rgba(180,195,205,0.25)'; g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(-138, -60); g.quadraticCurveTo(-128, -40, -116, -26); g.quadraticCurveTo(-108, -12, -104, -2); g.quadraticCurveTo(-110, 14, -122, 32); g.quadraticCurveTo(-132, 52, -142, 66); g.stroke();
    rim(g, fl, 'rgba(170,200,222,0.3)', 2, 0, 1.4);
    g.restore();
    // fade the front of the stock so it melts into the body
    g.globalCompositeOperation = 'destination-in';
    const fg = g.createLinearGradient(34, 0, 0, 0);
    fg.addColorStop(0, 'rgba(0,0,0,0)'); fg.addColorStop(1, 'rgba(0,0,0,1)');
    g.fillStyle = fg;
    g.fillRect(-150, -75, 300, 150);
    g.globalCompositeOperation = 'source-over';
  });
}

function drawWhale(ctx, G, c) {
  const half = WHALE_L * 0.7;
  if (!rectInView(G, c.x - half, c.y - 260, c.x + half, c.y + 140)) return;
  const fade = smoothstep(0, 3, c.t);
  // the water darkens around the giant (only below the surface)
  const v = G.view;
  ctx.save();
  ctx.beginPath(); ctx.rect(c.x - WHALE_L * 1.4, 3, WHALE_L * 2.8, v.top + v.h + 40); ctx.clip();
  ctx.translate(c.x, c.y);
  ctx.scale(1, 0.62);
  const R = WHALE_L * 0.95;
  const rg = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
  const a = (0.28 + 0.2 * c.dark) * fade;
  rg.addColorStop(0, `rgba(2,8,14,${a.toFixed(3)})`);
  rg.addColorStop(0.5, `rgba(2,8,14,${(a * 0.6).toFixed(3)})`);
  rg.addColorStop(1, 'rgba(2,8,14,0)');
  ctx.fillStyle = rg;
  ctx.fillRect(-R, -R, R * 2, R * 2);
  ctx.restore();

  const body = whaleSprite(), fin = whaleFinSprite(), tail = whaleTailSprite();
  ctx.save();
  ctx.globalAlpha = fade;
  ctx.translate(c.x, c.y);
  ctx.rotate(c.pitch);
  ctx.scale(c.dir, 1);
  // far pectoral fin, in shadow
  const fa = 0.42 + Math.sin(c.fin) * 0.36;
  const tint = waterTint(G, c.y);
  ctx.save(); ctx.translate(158, 30); ctx.rotate(-(fa * 0.8 + 0.05)); ctx.scale(0.9, 0.75);
  putT(ctx, fin, { col: tint.col, k: Math.min(0.9, tint.k + 0.3) }); ctx.restore();
  putT(ctx, body, tint);
  ctx.save(); ctx.translate(-204, 1); ctx.rotate(Math.sin(c.tail) * 0.15); putT(ctx, tail, tint); ctx.restore();
  ctx.save(); ctx.translate(148, 40); ctx.rotate(-fa); putT(ctx, fin, tint); ctx.restore();
  ctx.restore();
}

// =====================================================================================
// the eye in the seabed (drawDeep)
// =====================================================================================

function eyeRockSprite() {
  return bake('eyeRock', 180, 90, 3, (g) => {
    const rnd = lcg(1313);
    const pts = [];
    for (let i = 0; i <= 24; i++) {
      const a = Math.PI + (i / 24) * Math.PI;
      const r = 1 + (rnd() - 0.5) * 0.12;
      pts.push([Math.cos(a) * 80 * r, Math.sin(a) * 40 * r + 22]);
    }
    const rock = new Path2D();
    rock.moveTo(-86, 40);
    for (const [x, y] of pts) rock.lineTo(x, y);
    rock.lineTo(86, 40);
    rock.closePath();
    g.fillStyle = vgrad(g, -20, 40, [[0, '#3a4046'], [0.5, '#24292e'], [1, '#121518']]);
    g.fill(rock);
    g.save(); g.clip(rock);
    for (let i = 0; i < 120; i++) {
      const x = -84 + rnd() * 168, y = -20 + rnd() * 60, r = 1.5 + rnd() * 5;
      g.fillStyle = `rgba(${70 + rnd() * 40 | 0},${74 + rnd() * 40 | 0},${78 + rnd() * 40 | 0},${0.18 + rnd() * 0.2})`;
      g.beginPath(); g.ellipse(x, y, r, r * 0.7, rnd() * 3, 0, TAU); g.fill();
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.beginPath(); g.ellipse(x + r * 0.25, y + r * 0.35, r * 0.8, r * 0.5, 0, 0, TAU); g.fill();
    }
    // the socket and the closed, rocky lids
    const so = g.createRadialGradient(0, 0, 4, 0, 0, 46);
    so.addColorStop(0, 'rgba(0,0,0,0.75)'); so.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = so; g.beginPath(); g.ellipse(0, 0, 46, 24, 0, 0, TAU); g.fill();
    g.fillStyle = '#2b3036';
    g.beginPath(); g.moveTo(-33, 0); g.quadraticCurveTo(0, -24, 33, 0); g.quadraticCurveTo(0, 22, -33, 0); g.fill();
    g.strokeStyle = 'rgba(8,9,10,0.95)'; g.lineWidth = 1.8;
    g.beginPath(); g.moveTo(-33, 0); g.quadraticCurveTo(0, 7, 33, 0); g.stroke();
    g.strokeStyle = 'rgba(150,160,170,0.18)'; g.lineWidth = 1;
    for (let k = 0; k < 3; k++) { g.beginPath(); g.moveTo(-28 + k * 4, -7 - k * 4); g.quadraticCurveTo(0, -20 - k * 4, 28 - k * 4, -7 - k * 4); g.stroke(); }
    g.restore();
    // pale sponges and tube worms growing on it
    for (let i = 0; i < 7; i++) {
      const x = -70 + rnd() * 140, y = 22 - Math.sqrt(Math.max(0, 1 - (x / 80) ** 2)) * 40 + 3;
      g.fillStyle = `rgba(${180 + rnd() * 50 | 0},${150 + rnd() * 40 | 0},${120 + rnd() * 30 | 0},0.7)`;
      g.beginPath(); g.ellipse(x, y, 2 + rnd() * 3, 1.5 + rnd() * 2, 0, 0, TAU); g.fill();
    }
    g.strokeStyle = 'rgba(200,190,170,0.55)'; g.lineWidth = 1.2;
    for (let i = 0; i < 5; i++) { const x = 40 + i * 5, y = -10 + i * 3; g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + 2, y - 8, x + 1, y - 13 - i); g.stroke(); }
    rim(g, rock, 'rgba(150,165,180,0.25)', 2.4, 0, 1.6);
  });
}

function drawEye(ctx, G, c) {
  if (!onScreen(G, c.x, c.y, 150)) return;
  const rock = eyeRockSprite();
  ctx.save();
  ctx.translate(c.x, c.y - EYE_LIFT);
  ctx.scale(EYE_SCALE, EYE_SCALE);
  put(ctx, rock);
  const o = c.o == null ? c.open : c.o;
  if (o < 0.03) { ctx.restore(); return; }
  const hw = 32, hh = 15 * o;
  ctx.save();
  const alm = new Path2D();
  alm.moveTo(-hw, 0); alm.quadraticCurveTo(0, -hh * 2, hw, 0); alm.quadraticCurveTo(0, hh * 1.6, -hw, 0); alm.closePath();
  ctx.save();
  ctx.clip(alm);
  const sc = ctx.createRadialGradient(0, 0, 2, 0, 0, hw);
  sc.addColorStop(0, '#e4dcb6'); sc.addColorStop(0.6, '#b5a978'); sc.addColorStop(1, '#4e4630');
  ctx.fillStyle = sc;
  ctx.fillRect(-hw, -hh * 2, hw * 2, hh * 4);
  // veins
  ctx.strokeStyle = 'rgba(140,40,30,0.5)'; ctx.lineWidth = 0.5;
  for (let i = 0; i < 9; i++) {
    const s = hash1(i, c.seed), side = i % 2 ? 1 : -1;
    ctx.beginPath(); ctx.moveTo(side * hw, (s - 0.5) * 10);
    ctx.quadraticCurveTo(side * hw * 0.6, (s - 0.5) * 18, side * hw * (0.25 + s * 0.2), (hash1(i, c.seed + 1) - 0.5) * 12);
    ctx.stroke();
  }
  // iris and pupil, following the boy
  const ix = c.lx * 12, iy = c.ly * 5;
  const ir = ctx.createRadialGradient(ix, iy, 2, ix, iy, 11);
  ir.addColorStop(0, '#f0cf62'); ir.addColorStop(0.55, '#a87c22'); ir.addColorStop(1, '#2e2008');
  ctx.fillStyle = ir;
  ctx.beginPath(); ctx.arc(ix, iy, 11, 0, TAU); ctx.fill();
  ctx.strokeStyle = 'rgba(60,40,10,0.5)'; ctx.lineWidth = 0.4;
  for (let i = 0; i < 18; i++) { const a = (i / 18) * TAU; ctx.beginPath(); ctx.moveTo(ix + Math.cos(a) * 4, iy + Math.sin(a) * 4); ctx.lineTo(ix + Math.cos(a) * 10, iy + Math.sin(a) * 10); ctx.stroke(); }
  ctx.fillStyle = '#030303';
  ctx.beginPath(); ctx.ellipse(ix, iy, 3.2, 4.6, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,240,0.85)';
  ctx.beginPath(); ctx.ellipse(-8, -hh * 0.55, 2.6, 1.4, -0.3, 0, TAU); ctx.fill();
  // lid shadow
  const ls = ctx.createLinearGradient(0, -hh * 1.2, 0, 0);
  ls.addColorStop(0, 'rgba(0,0,0,0.65)'); ls.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = ls; ctx.fillRect(-hw, -hh * 2, hw * 2, hh * 1.6);
  ctx.restore();
  ctx.strokeStyle = 'rgba(10,10,12,0.95)'; ctx.lineWidth = 2.6;
  ctx.stroke(alm);
  ctx.strokeStyle = 'rgba(210,220,225,0.25)'; ctx.lineWidth = 0.7;
  ctx.beginPath(); ctx.moveTo(-hw * 0.7, -hh * 0.9); ctx.quadraticCurveTo(0, -hh * 1.75, hw * 0.7, -hh * 0.9); ctx.stroke();
  ctx.restore();
  ctx.restore();
}

// =====================================================================================
// the horizon: leviathan, moon whale, ghost ship (screen space)
// =====================================================================================

function limb(ctx, pts, w0, w1) {
  // a tapered stroke through pts, drawn as overlapping round-capped segments
  const n = pts.length - 1;
  for (let i = 0; i < n; i++) {
    ctx.lineWidth = lerp(w0, w1, (i + 0.5) / n);
    ctx.beginPath(); ctx.moveTo(pts[i][0], pts[i][1]); ctx.lineTo(pts[i + 1][0], pts[i + 1][1]); ctx.stroke();
  }
}

function drawLeviathan(ctx, G, c) {
  const a = c.a || 0;
  if (a < 0.01) return;
  const v = G.view, u = unitOf(G);
  const hy = v.seaScreenY - 7 * v.scale + 3;
  const x0 = horizonScreenX(G, c, c.fx);
  const Hl = Math.min(Math.max(140, (hy - 40)) * 0.86, 420 * u);
  const t = c.t;
  // head turn: profile -> staring at you -> away
  let turn;
  if (t < 16) turn = c.look;
  else if (t < 24) turn = lerp(c.look, 0, smoothstep(16, 24, t));
  else if (t < 40) turn = 0;
  else turn = lerp(0, -c.look, smoothstep(40, 48, t));
  const sway = Math.sin(t * 0.22) * 0.008;
  const P = (fx, fy) => [x0 + (fx + sway * (-fy)) * Hl, hy + fy * Hl];
  const col = `rgba(5,7,16,${(0.92 * a).toFixed(3)})`;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = col; ctx.fillStyle = col;
  // legs disappearing into the sea
  limb(ctx, [P(-0.014, -0.56), P(-0.03, -0.3), P(-0.022, 0.03)], 0.016 * Hl, 0.007 * Hl);
  limb(ctx, [P(0.014, -0.56), P(0.026, -0.29), P(0.034, 0.03)], 0.016 * Hl, 0.007 * Hl);
  // torso, hunched
  ctx.beginPath();
  const tp = [P(-0.02, -0.56), P(-0.015, -0.64), P(-0.03, -0.76), P(-0.026, -0.815), P(0.03, -0.81), P(0.032, -0.76), P(0.016, -0.64), P(0.02, -0.56)];
  ctx.moveTo(tp[0][0], tp[0][1]);
  for (let i = 1; i < tp.length; i++) ctx.lineTo(tp[i][0], tp[i][1]);
  ctx.closePath(); ctx.fill();
  // ribs, faintly
  ctx.strokeStyle = `rgba(40,48,72,${(0.35 * a).toFixed(3)})`; ctx.lineWidth = 0.003 * Hl;
  for (let k = 0; k < 4; k++) { const y = -0.68 - k * 0.03; const l = P(-0.022, y), r = P(0.024, y + 0.008); ctx.beginPath(); ctx.moveTo(l[0], l[1]); ctx.quadraticCurveTo((l[0] + r[0]) / 2, l[1] + 0.012 * Hl, r[0], r[1]); ctx.stroke(); }
  ctx.strokeStyle = col;
  // arms, far too long, fingers almost touching the water
  const swing = Math.sin(t * 0.3) * 0.006;
  limb(ctx, [P(-0.03, -0.8), P(-0.05, -0.56), P(-0.044 + swing, -0.3), P(-0.042 + swing, -0.2)], 0.01 * Hl, 0.005 * Hl);
  limb(ctx, [P(0.03, -0.8), P(0.052, -0.56), P(0.048 - swing, -0.31), P(0.05 - swing, -0.21)], 0.01 * Hl, 0.005 * Hl);
  ctx.lineWidth = 0.0025 * Hl;
  for (const s of [-1, 1]) {
    const w = P(s * 0.044 + (s < 0 ? swing : -swing), -0.205);
    for (let k = -1; k <= 1; k++) { const e = P(s * 0.044 + k * 0.006 + (s < 0 ? swing : -swing), -0.16 + Math.abs(k) * 0.01); ctx.beginPath(); ctx.moveTo(w[0], w[1]); ctx.lineTo(e[0], e[1]); ctx.stroke(); }
  }
  // neck and the long head
  limb(ctx, [P(0.002, -0.81), P(0.006, -0.87)], 0.008 * Hl, 0.006 * Hl);
  const hc = P(0.008, -0.905);
  ctx.beginPath(); ctx.ellipse(hc[0], hc[1], 0.017 * Hl, 0.042 * Hl, 0, 0, TAU); ctx.fill();
  // the face: a long snout in profile, flattening as it turns toward you
  const fx = hc[0] + turn * 0.022 * Hl;
  ctx.beginPath(); ctx.ellipse(fx, hc[1] + 0.012 * Hl, (0.012 + 0.008 * Math.abs(turn)) * Hl, 0.024 * Hl, turn * 0.5, 0, TAU); ctx.fill();
  // moonlit rim on one side
  ctx.strokeStyle = `rgba(150,172,215,${(0.22 * a).toFixed(3)})`;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.ellipse(hc[0], hc[1], 0.017 * Hl, 0.042 * Hl, 0, -Math.PI * 0.45, Math.PI * 0.2); ctx.stroke();
  // eyes, only when it looks at you
  const eyeA = a * (1 - smoothstep(0.15, 0.45, Math.abs(turn)));
  if (eyeA > 0.02) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const s of [-1, 1]) {
      const ex = hc[0] + s * 0.007 * Hl, ey = hc[1] - 0.004 * Hl;
      ctx.globalAlpha = eyeA * 0.7;
      ctx.drawImage(glow([230, 236, 205]), ex - 5, ey - 5, 10, 10);
      ctx.globalAlpha = eyeA;
      ctx.fillStyle = 'rgba(240,244,220,1)';
      ctx.beginPath(); ctx.arc(ex, ey, Math.max(0.8, 0.0022 * Hl), 0, TAU); ctx.fill();
    }
    ctx.restore();
  }
  // mist around its legs
  const mg = ctx.createLinearGradient(0, hy - 0.2 * Hl, 0, hy + 4);
  mg.addColorStop(0, 'rgba(60,70,100,0)');
  mg.addColorStop(1, `rgba(64,74,104,${(0.5 * a).toFixed(3)})`);
  ctx.fillStyle = mg;
  ctx.fillRect(x0 - 0.18 * Hl, hy - 0.2 * Hl, 0.36 * Hl, 0.2 * Hl + 4);
  ctx.restore();
}

// Breaching-whale silhouette in unit length (nose +0.5 .. flukes -0.5).
let MW_PATH = null, MW_FIN = null;
function moonWhalePaths() {
  if (MW_PATH) return;
  const keys = [[0, 0.01, 0.03], [0.05, 0.03, 0.05], [0.15, 0.07, 0.09], [0.32, 0.1, 0.11], [0.5, 0.095, 0.09], [0.7, 0.065, 0.05], [0.88, 0.035, 0.028], [1, 0.022, 0.02]];
  const B = bodyPath(0.5, -0.36, keys, 40, (u) => 0.025 * Math.exp(-Math.pow((u - 0.66) / 0.03, 2)));
  const p = new Path2D(B.path);
  // flukes, spread
  p.moveTo(-0.35, -0.01); p.quadraticCurveTo(-0.42, -0.06, -0.5, -0.11); p.quadraticCurveTo(-0.46, -0.02, -0.44, 0);
  p.quadraticCurveTo(-0.46, 0.03, -0.5, 0.12); p.quadraticCurveTo(-0.42, 0.06, -0.35, 0.015); p.closePath();
  MW_PATH = p;
  const f = new Path2D();
  f.moveTo(0.03, -0.035); f.quadraticCurveTo(-0.12, -0.05, -0.36, 0.0); f.quadraticCurveTo(-0.14, 0.03, 0.03, 0.035); f.closePath();
  MW_FIN = f;
}

function drawMoonWhale(ctx, G, c) {
  moonWhalePaths();
  const v = G.view, u = unitOf(G);
  const hy = v.seaScreenY - 7 * v.scale;
  const sx = horizonScreenX(G, c, c.fx);
  const Lw = mwLen(G, c);
  const pose = whalePose(c, Lw);
  const fade = 1 - smoothstep(c.dur - 2, c.dur, c.t);
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, v.cssW, hy + 1); ctx.clip();
  // moonlit haze and spray behind it, so the silhouette reads against the night
  const vis = smoothstep(0.4, 1.4, c.t) * (1 - smoothstep(4.4, 6, c.t));
  if (vis > 0.01) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.32 * vis;
    const bx = sx + pose.x + Math.cos(pose.a) * Lw * 0.1, by = hy - pose.h + Math.sin(pose.a) * Lw * 0.1;
    ctx.drawImage(glow([120, 140, 190]), bx - Lw * 0.75, by - Lw * 0.7, Lw * 1.5, Lw * 1.5);
    ctx.globalAlpha = 0.22 * vis;
    ctx.drawImage(glow([170, 190, 230]), sx - Lw * 0.5, hy - Lw * 0.3, Lw, Lw * 0.36);
    ctx.restore();
  }
  // the whale
  if (c.t < 5.2) {
    ctx.save();
    ctx.translate(sx + pose.x, hy - pose.h);
    ctx.rotate(pose.a);
    ctx.scale(Lw, Lw);
    const fin = c.t > 1.2 ? Math.min(1, (c.t - 1.2) / 1.2) : 0;
    ctx.fillStyle = '#060a18';
    for (const s of [-1, 1]) {
      ctx.save(); ctx.translate(0.22, s * 0.02); ctx.rotate(s * (0.3 + fin * 0.9)); ctx.fill(MW_FIN); ctx.restore();
    }
    ctx.fill(MW_PATH);
    // moonlight along the upper edge
    ctx.save();
    ctx.clip(MW_PATH);
    ctx.strokeStyle = 'rgba(150,170,215,0.28)';
    ctx.lineWidth = 2.4 / Lw;
    ctx.stroke(MW_PATH);
    ctx.translate(0, c.side * 0.014);
    ctx.strokeStyle = 'rgba(205,220,255,0.7)';
    ctx.lineWidth = 3.2 / Lw;
    ctx.stroke(MW_PATH);
    ctx.restore();
    // water sheeting off the flanks while it rises
    if (c.t > 0.7 && c.t < 3.4) {
      const k = 1 - smoothstep(2.6, 3.4, c.t);
      ctx.strokeStyle = `rgba(200,215,245,${(0.35 * k).toFixed(3)})`;
      ctx.lineWidth = 1.2 / Lw;
      for (let i = 0; i < 7; i++) {
        const xx = 0.35 - i * 0.1, side = i % 2 ? 1 : -1;
        ctx.beginPath(); ctx.moveTo(xx, side * 0.09); ctx.lineTo(xx - 0.12, side * (0.1 + 0.02 * Math.sin(c.t * 9 + i))); ctx.stroke();
      }
    }
    // pleats catching light
    ctx.strokeStyle = 'rgba(150,170,210,0.25)'; ctx.lineWidth = 1 / Lw;
    for (let k = 0; k < 4; k++) { ctx.beginPath(); ctx.moveTo(0.46, 0.03 + k * 0.012); ctx.quadraticCurveTo(0.25, 0.09 + k * 0.01, 0.05, 0.07 + k * 0.006); ctx.stroke(); }
    ctx.restore();
  }
  // sheets of water around its base while it rises
  if (c.t > 0.5 && c.t < 3.6) {
    const k = smoothstep(0.5, 1.1, c.t) * (1 - smoothstep(2.6, 3.6, c.t));
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.55 * k;
    ctx.drawImage(glow([200, 218, 245]), sx - Lw * 0.35, hy - Lw * 0.22, Lw * 0.7, Lw * 0.36);
    ctx.restore();
  }
  // the fall: a white plume
  if (c.hit) {
    const p = clamp((c.t - 4.85) / 2.6, 0, 1);
    const hgt = Lw * 0.62 * Math.sin(Math.min(1, p * 1.6) * Math.PI * 0.5) * (1 - p * 0.6);
    const bx = sx + pose.x + c.side * Lw * 0.35;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let k = 0; k < 6; k++) {
      const f = k / 5;
      ctx.globalAlpha = (0.9 - f * 0.4) * (1 - p) * fade;
      const r = Lw * (0.34 - f * 0.13) * (0.7 + p * 0.6);
      ctx.drawImage(glow([210, 225, 250]), bx - r + Math.sin(k * 2.1) * Lw * 0.04, hy - hgt * f - r * 0.8, r * 2, r * 2);
    }
    ctx.restore();
    // foam spreading on the far water
    ctx.fillStyle = `rgba(200,215,240,${(0.4 * (1 - p)).toFixed(3)})`;
    ctx.beginPath(); ctx.ellipse(bx, hy - 1, Lw * (0.25 + p * 0.5), 2.2 * u, 0, Math.PI, TAU); ctx.fill();
  }
  // droplets
  ctx.fillStyle = 'rgba(214,226,250,0.85)';
  for (const d of c.drops) {
    ctx.globalAlpha = clamp(d.life, 0, 1) * fade;
    ctx.fillRect(d.x - d.s / 2, d.y - d.s / 2, d.s, d.s);
  }
  ctx.restore();
}

const SHIP_SCALE = 1.0;
function shipSprite() {
  return bake('ghostship', 330, 300, 2.2, (g) => {
    const rnd = lcg(2024);
    // the sprite's origin is the waterline under the main mast; +x is the bow
    g.translate(0, 110);
    const hullTop = (x) => (x < -78 ? -76 : x < -60 ? lerp(-76, -34, (x + 78) / 18) : x > 104 ? -40 : -30 - (x > 70 ? (x - 70) * 0.25 : 0));
    // masts and rigging behind the sails
    const masts = [[-50, -232], [14, -258], [78, -206]];
    g.strokeStyle = '#1d1c1b'; g.lineCap = 'round';
    for (const [x, top] of masts) { g.lineWidth = 3; g.beginPath(); g.moveTo(x, hullTop(x)); g.lineTo(x + 2, top); g.stroke(); }
    g.lineWidth = 0.7; g.strokeStyle = 'rgba(30,30,30,0.85)';
    g.beginPath();
    g.moveTo(-128, -78); g.lineTo(-50, -232); g.lineTo(14, -258); g.lineTo(78, -206); g.lineTo(150, -46);
    for (const [x, top] of masts) for (let k = -1; k <= 1; k += 2) { g.moveTo(x + 2, top + 6); g.lineTo(x + k * 30, hullTop(x + k * 30)); }
    g.stroke();
    // tattered sails
    for (const [x, top] of masts) {
      for (let s = 0; s < 3; s++) {
        const y0 = top + 14 + s * 52, w = 36 - s * 2 + (x === 14 ? 6 : 0), h = 42;
        g.strokeStyle = '#1d1c1b'; g.lineWidth = 2;
        g.beginPath(); g.moveTo(x - w, y0); g.lineTo(x + w, y0 + 2); g.stroke();
        if (rnd() < 0.18) continue;
        const sail = new Path2D();
        sail.moveTo(x - w + 2, y0 + 1);
        sail.lineTo(x + w - 2, y0 + 3);
        const n = 7;
        for (let i = 0; i <= n; i++) {
          const fx = x + w - 2 - (i / n) * (2 * w - 4);
          const fy = y0 + h * (0.55 + rnd() * 0.45) + Math.sin(i * 1.7) * 4;
          sail.lineTo(fx, fy);
        }
        sail.closePath();
        g.fillStyle = `rgba(${140 + rnd() * 20 | 0},${150 + rnd() * 15 | 0},${140 + rnd() * 10 | 0},0.55)`;
        g.fill(sail);
        g.save(); g.clip(sail);
        g.fillStyle = 'rgba(40,46,40,0.35)';
        for (let k = 0; k < 4; k++) { g.beginPath(); g.ellipse(x - w + rnd() * w * 2, y0 + 8 + rnd() * h * 0.6, 3 + rnd() * 6, 2 + rnd() * 5, rnd(), 0, TAU); g.fill(); }
        g.strokeStyle = 'rgba(255,255,240,0.15)'; g.lineWidth = 0.5;
        for (let k = -2; k <= 2; k++) { g.beginPath(); g.moveTo(x + k * w * 0.4, y0); g.quadraticCurveTo(x + k * w * 0.45, y0 + h * 0.5, x + k * w * 0.4, y0 + h); g.stroke(); }
        g.restore();
        // holes torn through
        g.save(); g.globalCompositeOperation = 'destination-out';
        for (let k = 0; k < 2; k++) { g.beginPath(); g.ellipse(x - w * 0.6 + rnd() * w * 1.2, y0 + 10 + rnd() * h * 0.5, 2 + rnd() * 5, 2 + rnd() * 4, rnd(), 0, TAU); g.fill(); }
        g.restore();
      }
    }
    // hull
    const hull = new Path2D();
    hull.moveTo(-132, -80); hull.lineTo(-78, -78); hull.lineTo(-74, -38); hull.lineTo(70, -30);
    hull.quadraticCurveTo(110, -36, 124, -44); hull.lineTo(152, -48); hull.lineTo(126, -40);
    hull.quadraticCurveTo(120, -8, 96, 8); hull.lineTo(-110, 8); hull.quadraticCurveTo(-130, -20, -132, -80);
    hull.closePath();
    g.fillStyle = vgrad(g, -80, 8, [[0, '#35312c'], [0.5, '#25221f'], [1, '#141312']]);
    g.fill(hull);
    g.save(); g.clip(hull);
    g.strokeStyle = 'rgba(0,0,0,0.45)'; g.lineWidth = 0.8;
    for (let y = -76; y < 8; y += 5.5) { g.beginPath(); g.moveTo(-140, y); g.quadraticCurveTo(0, y + 4, 140, y - 3); g.stroke(); }
    g.fillStyle = 'rgba(80,100,70,0.3)';
    for (let i = 0; i < 18; i++) { const x = -120 + rnd() * 230; g.fillRect(x, -18 + rnd() * 10, 1.4, 10 + rnd() * 18); }
    // window frames (lit separately)
    g.fillStyle = '#0b0a09';
    for (let i = 0; i < 4; i++) g.fillRect(-118 + i * 9.5, -60, 6, 9);
    for (let i = 0; i < 8; i++) { g.beginPath(); g.arc(-50 + i * 20, -16, 2.6, 0, TAU); g.fill(); }
    g.restore();
    g.strokeStyle = 'rgba(170,180,190,0.25)'; g.lineWidth = 1; g.stroke(hull);
    // broken railing
    g.strokeStyle = '#1d1c1b'; g.lineWidth = 0.9;
    for (let x = -70; x < 118; x += 7) { if (rnd() < 0.2) continue; const y = hullTop(x); g.beginPath(); g.moveTo(x, y); g.lineTo(x, y - 6 - rnd() * 2); g.stroke(); }
    g.beginPath(); g.moveTo(-70, -36); g.lineTo(20, -36.5); g.moveTo(34, -37); g.lineTo(110, -48); g.stroke();
    // lantern poles
    g.lineWidth = 1.4;
    g.beginPath(); g.moveTo(-118, -80); g.lineTo(-118, -98); g.moveTo(122, -48); g.lineTo(122, -64); g.stroke();
  });
}

function drawGhostShip(ctx, G, c) {
  const a = c.a || 0;
  if (a < 0.01) return;
  const v = G.view, u = unitOf(G);
  const hy = v.seaScreenY - 7 * v.scale + 2;
  const sx = horizonScreenX(G, c, c.fx0 + c.dir * c.span * (c.t / c.dur));
  const sc = SHIP_SCALE * u;
  if (sx < -260 * sc || sx > v.cssW + 260 * sc) return;
  const S = shipSprite();
  const t = c.t;
  ctx.save();
  ctx.translate(sx, hy + Math.sin(t * 0.7) * 1.2 * u);
  ctx.rotate(Math.sin(t * 0.45) * 0.02);
  ctx.scale(sc * c.dir, sc);
  ctx.globalAlpha = a * 0.92;
  ctx.drawImage(S.c, -S.w / 2, -S.h / 2 - 110, S.w, S.h);
  // lit windows and lanterns, flickering
  ctx.globalCompositeOperation = 'lighter';
  const fl = (k) => 0.75 + 0.25 * Math.sin(t * 7 + k * 3.1) * Math.sin(t * 3.3 + k);
  ctx.fillStyle = 'rgba(255,190,110,1)';
  for (let i = 0; i < 4; i++) { ctx.globalAlpha = a * 0.8 * fl(i); ctx.fillRect(-117 + i * 9.5, -59, 4, 7); }
  for (let i = 0; i < 8; i++) { if (i % 3 === 1) continue; ctx.globalAlpha = a * 0.6 * fl(i + 5); ctx.beginPath(); ctx.arc(-50 + i * 20, -16, 1.8, 0, TAU); ctx.fill(); }
  const gw = glow([255, 186, 110]);
  for (const [x, y, r, k] of [[-118, -102, 22, 1], [122, -68, 18, 2], [-102, -56, 34, 3]]) {
    ctx.globalAlpha = a * 0.75 * fl(k);
    ctx.drawImage(gw, x - r, y - r, r * 2, r * 2);
  }
  ctx.fillStyle = 'rgba(255,220,160,1)';
  for (const [x, y] of [[-118, -102], [122, -68]]) { ctx.globalAlpha = a * fl(x); ctx.beginPath(); ctx.arc(x, y, 2.2, 0, TAU); ctx.fill(); }
  ctx.restore();
  // mist drifting in front of it
  ctx.save();
  const mist = glow([170, 182, 196]);
  for (let k = 0; k < 6; k++) {
    const mx = sx + ((k * 97 + t * (8 + k * 2)) % 520 - 260) * u, my = hy - (10 + (k % 3) * 34) * u;
    const r = (90 + (k % 2) * 60) * u;
    ctx.globalAlpha = a * 0.16;
    ctx.drawImage(mist, mx - r, my - r * 0.35, r * 2, r * 0.7);
  }
  ctx.restore();
}
