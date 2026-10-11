// 少年与海 — floating debris (worker: LIFE).
//
// The sea brings the boy his building materials: planks, plastic bottles, tangled nets,
// rusty sheet metal, soaked cloth, palm fronds, barrels, the odd crate hanging under the
// surface and — at most once a day — a message bottle with a letter from a girl who also
// drifted. Everything is painted procedurally into small cached sprites (one per
// type × variant) and drawn bobbing and rolling on the waves.
//
// Exports (CONTRACT §5): init, update, draw, hookCatch, collectAttached.
// Extra: spawnDebrisNear(G, x, n) (used by life.debugSpawn), LETTERS.

import { C, say, journal } from '../core/state.js';
import { waterY, seabedY, onScreen, addLight } from '../core/world.js';
import { emit } from '../core/particles.js';
import { TAU, clamp, rand, randi, chance, hash1, seeded, makeCanvas } from '../core/util.js';
import { addItem } from '../systems/inventory.js';
import { sfx } from '../systems/audio.js';
import * as islands from '../systems/islands.js';

// =====================================================================================
// the letters (message bottles). Read in order; G.persist.flags.notes counts them.
// =====================================================================================

export const LETTERS = [
  '如果你看到这封信……说明海上不止我一个人。我叫小满，今年十二岁。暴风雨那天晚上船翻了，我抱着一只木箱漂到了天亮。你也是这样吗？',
  '第三天。我用捡来的木板和绳子绑了一只歪歪扭扭的木筏。淡水快喝完了，我学会了用塑料布接雨水。你也要记得接雨水，还有，别喝海水。',
  '昨天有一条好大好大的鲸，从我脚底下慢慢游过去，整片海都暗了。我一点也不怕。它的眼睛很温柔，我觉得它是在给我带路。',
  '晚上海里会亮起蓝光，像有人把星星打碎了撒进水里。可是远处……有个很高很高的影子站在海上。我把头埋进膝盖里数到一千，它就不见了。不要一直看它。',
  '我在一座小岛上待了两天。白天有椰子，还有背着瓶盖的小螃蟹。可是天一黑，树林里就有东西在走，喘气声很重。千万别在岛上过夜。',
  '妈妈说过，海是圆的，所有漂走的东西，最后都会漂到同一个地方。所以我一直往瓶子里写信。也许你就是那个地方。',
  '今天在地平线上看见一点光，一闪，一闪。是灯塔！我要朝着它漂过去。如果你也看见了，就一直往前漂，别回头。',
  '我到了。灯塔里住着一位守塔的老爷爷，他说每隔几年就会有孩子漂到这里。我每天晚上都爬上去，把灯擦得亮亮的。我在等你。——小满',
];

// =====================================================================================
// types
// =====================================================================================

// w,h: rough footprint in world units (for hook / touch distance).
// sub: [min,max] how far the centre sits below the wave line. variants: painted sprites.
const TYPES = {
  plank:  { w: 32, h: 6,  sub: [0.4, 2.2], variants: 4, weight: 28 },
  bottle: { w: 15, h: 6,  sub: [-0.4, 1.2], variants: 4, weight: 17 },
  net:    { w: 30, h: 14, sub: [3.0, 5.5], variants: 3, weight: 11 },
  scrap:  { w: 22, h: 12, sub: [1.0, 3.0], variants: 4, weight: 10 },
  cloth:  { w: 18, h: 10, sub: [1.5, 3.5], variants: 4, weight: 10 },
  frond:  { w: 38, h: 10, sub: [0.2, 1.4], variants: 3, weight: 12 },
  barrel: { w: 22, h: 22, sub: [3.0, 5.0], variants: 3, weight: 5 },
  crate:  { w: 24, h: 20, sub: [0, 0], variants: 2, weight: 0 },
  note:   { w: 14, h: 6,  sub: [-0.2, 1.0], variants: 1, weight: 0 },
};
const K = 1.3;             // painted sprites are drawn this much larger than their paint units
for (const t of Object.values(TYPES)) { t.w *= K; t.h *= K; }
const SPAWN_TABLE = Object.entries(TYPES).filter(([, t]) => t.weight > 0);
const SPAWN_TOTAL = SPAWN_TABLE.reduce((s, [, t]) => s + t.weight, 0);

const MIXED = [['wood', 5], ['plastic', 4], ['rope', 3], ['cloth', 3], ['metal', 2]];
function pickMixed() {
  let r = Math.random() * 17;
  for (const [id, w] of MIXED) { r -= w; if (r <= 0) return id; }
  return 'wood';
}
function mixedLoot(total, canChance, waterChance) {
  const items = {};
  for (let i = 0; i < total; i++) { const id = pickMixed(); items[id] = (items[id] || 0) + 1; }
  if (chance(canChance)) items.can = 1;
  if (waterChance && chance(waterChance)) items.water = 1;
  return Object.entries(items);
}

function lootFor(type) {
  switch (type) {
    case 'plank': return [['wood', randi(1, 2)]];
    case 'bottle': return [['plastic', 1]];
    case 'net': return [['rope', randi(1, 2)]];
    case 'scrap': return [['metal', 1]];
    case 'cloth': return [['cloth', randi(1, 2)]];
    case 'frond': return [['leaf', randi(1, 2)]];
    case 'barrel': return mixedLoot(randi(3, 5), 0.3, 0);
    case 'crate': return mixedLoot(randi(4, 6), 0.4, 0.25);
    case 'note': return [['note', 1]];
  }
  return [['wood', 1]];
}

// =====================================================================================
// state
// =====================================================================================

let uid = 1;

export function init(G) {
  G.debris = [];
  G.debrisState = {
    cursor: null,       // world x up to which the sea ahead has been populated
    upT: rand(3, 6),    // upstream spawn timer (anchored / beached raft)
    crateT: rand(40, 90),
    hookLost: 0,
  };
  const F = flags(G);
  if (typeof F.notes !== 'number') F.notes = 0;
  // populate the sea around the raft so the very first look already offers something
  const R = G.raft;
  const W = viewW(G);
  const x0 = R.x - W * 0.5, x1 = R.x + W * 1.5;
  for (let x = x0 + rand(10, 60); x < x1; x += rand(58, 92)) {
    const a = R.x - 14, b = R.x + raftLen(G) + 14;
    if (x > a && x < b) continue;
    spawn(G, x, null, true);
  }
  G.debrisState.cursor = x1;
}

const flags = (G) => {
  if (!G.persist) G.persist = { islands: {}, flags: {} };
  if (!G.persist.flags) G.persist.flags = {};
  return G.persist.flags;
};
const viewW = (G) => Math.max(720, (G.view && G.view.w > 2) ? G.view.w : 960);
const raftLen = (G) => ((G.raft && G.raft.tiles && G.raft.tiles.length) || 1) * C.TILE_W;

function chooseType() {
  let r = Math.random() * SPAWN_TOTAL;
  for (const [type, t] of SPAWN_TABLE) { r -= t.weight; if (r <= 0) return type; }
  return 'plank';
}

// Land rising out of the water at x? (debris must not spawn on an island)
function landAt(G, x) {
  let g = null;
  try { g = islands.groundAt(G, x); } catch (e) { g = null; }
  return g != null && isFinite(g) ? g : null;
}

function spawn(G, x, forceType, initial) {
  if (!isFinite(x)) return null;
  const land = landAt(G, x);
  if (land != null && land < 14) return null;
  let type = forceType || chooseType();

  // a message bottle: at most one per day, only while unread letters remain
  const F = flags(G);
  if (!forceType && !G.demo && !initial && F.noteDay !== G.day && (F.notes | 0) < LETTERS.length
    && G.phase > 0.08 && G.phase < 0.9 && chance(0.07) && !G.debris.some((d) => d.type === 'note')) {
    type = 'note';
  }
  if (!forceType && type !== 'note' && chance(0.035)) type = 'crate';
  if (type === 'note') F.noteDay = G.day;

  const T = TYPES[type];
  const d = {
    id: uid++, type, x,
    y: 0, vx: rand(1.2, 4.2) * (chance(0.15) ? -0.4 : 1),
    sub: rand(T.sub[0], T.sub[1]) * K,
    sink: 0, rot: rand(-0.3, 0.3), roll: rand(0.5, 1.2), seed: Math.random() * 1000,
    variant: randi(0, T.variants - 1),
    items: lootFor(type),
    attached: false, ox: 0, oy: 0,
    r: Math.max(T.w, T.h) * 0.5,
    t: 0, fade: initial ? 1 : 0, flip: chance(0.5) ? -1 : 1,
    depth: 0, rest: false, restT: 0, bubbleT: rand(0.5, 2),
  };
  if (type === 'crate') {
    d.depth = rand(40, 120);
    d.vx = rand(0.8, 2.4);
    d.flip = 1;
  } else if ((type === 'scrap' && chance(0.45)) || (type !== 'note' && type !== 'barrel' && type !== 'net' && chance(0.06))) {
    d.sink = rand(1.6, 3.6);   // waterlogged, going down slowly
  }
  d.y = type === 'crate' ? d.depth : safeWaterY(G, x) + d.sub;
  G.debris.push(d);
  return d;
}

// Spawn n pieces near x (debug / scripted). Returns how many were placed.
export function spawnDebrisNear(G, x, n = 4) {
  if (!G.debris) init(G);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const d = spawn(G, x + (i - (n - 1) / 2) * rand(36, 52) + rand(-8, 8), i === n - 1 && n > 3 ? 'barrel' : null, true);
    if (d) k++;
  }
  return k;
}

const safeWaterY = (G, x) => { const y = waterY(G, x); return isFinite(y) ? y : 0; };

// =====================================================================================
// update
// =====================================================================================

export function update(G, dt) {
  if (!G.debris || !G.debrisState) init(G);
  const D = G.debrisState, R = G.raft, W = viewW(G);
  const rx = isFinite(R.x) ? R.x : 0;

  // ---- spawning ahead as the raft travels (one piece per ~60-90 units)
  const a0 = rx + W * 0.55, a1 = rx + W * 1.5;
  if (D.cursor == null || !isFinite(D.cursor)) D.cursor = a1;
  if (D.cursor < a0) D.cursor = a0;                      // teleported / fast travel
  if (D.cursor > a1 + 2000) D.cursor = a1;               // went backwards
  let guard = 0;
  while (D.cursor < a1 && guard++ < 40) {
    D.cursor += rand(60, 90);
    spawn(G, D.cursor + rand(-15, 15));
  }

  // ---- anchored or beached: the current keeps bringing things from upstream
  const slow = !(Math.abs(R.vx || 0) > 2);
  if (slow) {
    D.upT -= dt;
    if (D.upT <= 0) {
      D.upT = rand(7, 11);
      let near = 0;
      for (const d of G.debris) if (!d.attached && d.x > rx - W * 0.7 && d.x < rx + W * 0.9) near++;
      if (near < 9) spawn(G, rx - W * 0.55 - rand(0, 80));
    }
  }
  // the odd crate drifting under the surface
  D.crateT -= dt;
  if (D.crateT <= 0) { D.crateT = rand(70, 140); spawn(G, rx + W * rand(0.7, 1.3), 'crate'); }

  // ---- the hook
  const H = G.hook;
  const hookOk = H && isFinite(H.x) && isFinite(H.y);
  D.hookLost = hookOk ? 0 : D.hookLost + dt;

  // ---- the boy (touch to collect while swimming)
  const P = G.player;
  const swim = !G.demo && G.mode === 'play' && playerSwimming(G);
  const px = P ? P.x : 0, py = P ? P.y - 10 : 0;

  const t = G.time;
  const arr = G.debris;
  let w = 0;
  for (let i = 0; i < arr.length; i++) {
    const d = arr[i];
    d.t += dt;
    if (d.fade < 1) d.fade = Math.min(1, d.fade + dt * 0.8);
    const T = TYPES[d.type];

    if (d.attached) {
      if (hookOk) {
        const k = Math.min(1, dt * 14);
        d.x += (H.x + d.ox - d.x) * k;
        d.y += (H.y + d.oy - d.y) * k;
        const wy = safeWaterY(G, d.x);
        d.rot += (Math.sin(t * 3 + d.seed) * 0.25 + (d.y < wy - 2 ? 0.5 * d.flip : 0) - d.rot) * Math.min(1, dt * 4);
        arr[w++] = d;
        continue;
      }
      if (D.hookLost > 0.35) { d.attached = false; d.sink = 0; d.sub = rand(T.sub[0], T.sub[1]) * K; }
      else { arr[w++] = d; continue; }
    }

    // ---- drift
    const wind = (G.weather && isFinite(G.weather.wind)) ? G.weather.wind : 0.3;
    const land = landAt(G, d.x);
    if (d.type === 'crate') {
      d.x += d.vx * dt;
      const floor = Math.min(seabedY(G, d.x), land == null ? 1e9 : land);
      const target = Math.min(d.depth, floor - 14);
      d.y += (target + Math.sin(t * 0.7 + d.seed) * 3 - d.y) * Math.min(1, dt * 1.5);
      d.rot = Math.sin(t * 0.5 + d.seed) * 0.08;
      d.bubbleT -= dt;
      if (d.bubbleT <= 0) {
        d.bubbleT = rand(0.6, 2.2);
        if (onScreen(G, d.x, d.y, 40)) emit(G, { x: d.x + rand(-6, 6), y: d.y - 8, vx: rand(-3, 3), vy: rand(-28, -18), life: rand(1.6, 3), size: rand(0.8, 1.8), kind: 'bubble', color: [210, 235, 245], alpha: 0.7, water: 'below' });
      }
    } else if (d.rest) {
      d.restT += dt;
      d.rot += (Math.sin(d.seed) * 0.3 - d.rot) * dt;
    } else {
      const wy = safeWaterY(G, d.x);
      if (land != null && land < wy + d.sub + 2) {
        // washed up on a beach: lie on the sand at the waterline
        d.y += (Math.min(land - 1.5, wy + d.sub) - d.y) * Math.min(1, dt * 3);
        d.vx *= Math.max(0, 1 - dt * 2);
        d.x += d.vx * dt * 0.2;
      } else {
        d.x += (d.vx + wind * 1.2) * dt;
        if (d.sink > 0) {
          d.sub += d.sink * dt;
          d.sink = Math.min(d.sink + dt * 0.05, 5);
          const floor = Math.min(seabedY(G, d.x), land == null ? 1e9 : land);
          if (wy + d.sub > floor - 3) { d.sub = floor - 3 - wy; d.rest = true; }
        }
        d.y = wy + d.sub;
      }
      // roll with the wave slope
      if (!d.rest) {
        const hw = T.w * 0.42;
        const slope = (safeWaterY(G, d.x + hw) - safeWaterY(G, d.x - hw)) / (2 * hw);
        const follow = d.sink > 0 ? 0.25 : d.type === 'barrel' ? 0.45 : 0.95;
        const target = Math.atan(slope) * follow + Math.sin(t * d.roll + d.seed) * (d.type === 'bottle' || d.type === 'note' ? 0.16 : 0.05);
        d.rot += (target - d.rot) * Math.min(1, dt * 5);
      }
    }

    // ---- touch collection while swimming
    // (a generous box around the boy: upright he is tall, swimming prone he is long)
    if (swim && Math.abs(d.x - px) < 12 + d.r * 0.6 && Math.abs(d.y - py) < 15 + d.r * 0.4) {
      give(G, d);
      splash(G, d, 4);
      continue;
    }

    // ---- glint of the message bottle at night (so it can still be found)
    if (d.type === 'note' && G.light < 0.6 && onScreen(G, d.x, d.y, 20)) {
      addLight(G, d.x, d.y - 3, 22, [240, 230, 200], 0.35 + 0.15 * Math.sin(t * 2.3 + d.seed));
    }

    // ---- despawn
    const far = d.x < rx - 900 || d.x > rx + W * 1.5 + 500 || (d.rest && d.restT > 90) || d.y > 1500;
    if (far) {
      if (d.type === 'note') { const F = flags(G); if (F.noteDay === G.day) F.noteDay = -1; }
      continue;
    }
    arr[w++] = d;
  }
  arr.length = w;
}

function playerSwimming(G) {
  const P = G.player;
  if (!P || !isFinite(P.x) || !isFinite(P.y)) return false;
  if (typeof P.inWater === 'boolean') return P.inWater;
  if (typeof P.swimming === 'boolean') return P.swimming;
  if (P.state === 'swim' || P.state === 'dive') return true;
  const wy = safeWaterY(G, P.x);
  return P.y > wy + 3;
}

// =====================================================================================
// hook & collection
// =====================================================================================

// Attach every free debris within r of (x, y) to the hook. Returns how many attached.
export function hookCatch(G, x, y, r) {
  if (!G.debris || !isFinite(x) || !isFinite(y)) return 0;
  let n = 0;
  let count = 0;
  for (const d of G.debris) if (d.attached) count++;
  for (const d of G.debris) {
    if (d.attached || d.fade < 0.3) continue;
    const reach = r + Math.min(d.r, 14) * 0.6;
    const dx = d.x - x, dy = d.y - y;
    if (dx * dx + dy * dy > reach * reach) continue;
    d.attached = true;
    d.rest = false; d.sink = 0;
    // cluster around the hook with a little offset, the first one right on it
    const k = count + n;
    const ang = k * 2.4;
    d.ox = k === 0 ? clamp(dx * 0.3, -4, 4) : Math.cos(ang) * (5 + k * 2.5);
    d.oy = k === 0 ? 2 : 2 + Math.abs(Math.sin(ang)) * 4;
    n++;
    splash(G, d, 3);
  }
  if (n) sfx('hook');
  return n;
}

// Give the boy everything on the hook. Returns [{id, n}].
export function collectAttached(G) {
  if (!G.debris) return [];
  const got = {};
  let w = 0;
  const arr = G.debris;
  for (let i = 0; i < arr.length; i++) {
    const d = arr[i];
    if (!d.attached) { arr[w++] = d; continue; }
    for (const [id, n] of give(G, d, true)) got[id] = (got[id] || 0) + n;
  }
  arr.length = w;
  const out = Object.entries(got).map(([id, n]) => ({ id, n }));
  if (out.length) sfx('pickup');
  return out;
}

// Hand a piece's loot to the boy (does not remove it from the list).
function give(G, d, quietSfx) {
  const items = d.items || [];
  for (const [id, n] of items) {
    try { addItem(G, id, n); } catch (e) { G.inv[id] = (G.inv[id] || 0) + n; }
  }
  if (d.type === 'note') readLetter(G);
  if (!quietSfx) sfx('pickup');
  return items;
}

function readLetter(G) {
  const F = flags(G);
  const i = clamp(F.notes | 0, 0, LETTERS.length - 1);
  if ((F.notes | 0) >= LETTERS.length) return;
  F.notes = (F.notes | 0) + 1;
  const text = LETTERS[i];
  journal(G, '漂流瓶里的信（' + (i + 1) + '/' + LETTERS.length + '）：「' + text + '」');
  const first = text.split(/[。！？]/)[0];
  say(G, '漂流瓶里有一封信：「' + (first.length > 22 ? first.slice(0, 21) + '……' : first + '……') + '」', 'story');
  sfx('discover');
}

function splash(G, d, n) {
  for (let i = 0; i < n; i++) {
    emit(G, { x: d.x + rand(-d.r * 0.5, d.r * 0.5), y: d.y - 2, vx: rand(-25, 25), vy: rand(-70, -30), life: rand(0.4, 0.8), size: rand(1, 1.8), gravity: 260, color: [225, 240, 245], alpha: 0.8, water: 'above' });
  }
}

// =====================================================================================
// drawing
// =====================================================================================

export function draw(ctx, G) {
  if (!G.debris || !G.debris.length) return;
  const t = G.time;
  const v = G.view;
  const above = v.top < 12;
  ctx.save();
  for (const d of G.debris) {
    const S = getSprite(d.type, d.variant);
    const m = Math.max(S.w, S.h) * K;
    if (!onScreen(G, d.x, d.y, m)) continue;
    const floating = !d.attached && d.type !== 'crate' && !d.rest && d.sub < 7;
    // ripple rings on the water around floating things
    if (floating && above && G.light > 0.12) {
      const wy = safeWaterY(G, d.x);
      const ph = (t * 0.45 + d.seed) % 1;
      const rr = TYPES[d.type].w * 0.45 + ph * 12;
      ctx.strokeStyle = `rgba(235,245,250,${(0.22 * (1 - ph) * d.fade * G.light).toFixed(3)})`;
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.ellipse(d.x, wy + 0.6, rr, 1.1 + ph * 1.4, 0, 0, TAU);
      ctx.stroke();
    }
    ctx.save();
    ctx.translate(d.x, d.y);
    ctx.rotate(d.rot);
    ctx.scale(d.flip < 0 ? -K : K, K);
    ctx.globalAlpha = d.fade;
    ctx.drawImage(S.c, -S.w / 2, -S.h / 2, S.w, S.h);
    ctx.restore();

    // crates trail a couple of swaying weeds
    if (d.type === 'crate') drawWeeds(ctx, d, t);

    // a little foam where the thing breaks the surface
    if (floating && above) {
      const wy = safeWaterY(G, d.x);
      const hw = TYPES[d.type].w * 0.5;
      ctx.strokeStyle = `rgba(240,248,250,${(0.5 * d.fade * (0.35 + 0.65 * G.light)).toFixed(3)})`;
      ctx.lineWidth = 0.8;
      ctx.lineCap = 'round';
      ctx.beginPath();
      const s1 = Math.sin(t * 2.2 + d.seed) * 1.5;
      ctx.moveTo(d.x - hw - 2 + s1, wy + 0.3); ctx.lineTo(d.x - hw + 3 + s1, wy - 0.2);
      ctx.moveTo(d.x + hw - 3 - s1, wy - 0.2); ctx.lineTo(d.x + hw + 2 - s1, wy + 0.3);
      ctx.stroke();
    }
    // glint on glass
    if (d.type === 'note' || (d.type === 'bottle' && d.variant === 3)) {
      const k = Math.pow(Math.max(0, Math.sin(t * 1.7 + d.seed)), 12);
      if (k > 0.02) {
        const gx = d.x + Math.cos(d.rot) * 2 * (d.flip || 1), gy = d.y - 2.5;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = k * d.fade;
        ctx.drawImage(glintSprite(), gx - 7, gy - 7, 14, 14);
        ctx.restore();
      }
    }
  }
  ctx.restore();
}

function drawWeeds(ctx, d, t) {
  ctx.save();
  ctx.strokeStyle = 'rgba(70,96,58,0.75)';
  ctx.lineWidth = 0.9;
  ctx.lineCap = 'round';
  for (let k = 0; k < 3; k++) {
    const bx = d.x - 8 + k * 7 + (k === 1 ? 2 : 0), by = d.y + 9;
    const len = 10 + hash1(d.id * 7 + k) * 12;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    for (let s = 1; s <= 5; s++) {
      const f = s / 5;
      ctx.lineTo(bx + Math.sin(t * 1.3 + k * 2 + f * 3) * 2.2 * f, by + len * f);
    }
    ctx.stroke();
  }
  ctx.restore();
}

// =====================================================================================
// sprites — painted once per type/variant into offscreen canvases
// =====================================================================================

const SS = 5;              // sprite pixels per world unit
const SPR = new Map();
let GLINT = null;

function getSprite(type, variant) {
  const key = type + ':' + variant;
  let s = SPR.get(key);
  if (s) return s;
  const T = TYPES[type];
  const pad = 6;
  const w = T.w / K + pad * 2, h = Math.max(T.h / K + pad * 2, 16);
  const c = makeCanvas(w * SS, h * SS);
  const g = c.getContext('2d');
  g.scale(SS, SS);
  g.translate(w / 2, h / 2);
  g.lineJoin = 'round'; g.lineCap = 'round';
  const rnd = seeded(type.length * 7919 + variant * 104729 + type.charCodeAt(0) * 31 + 17);
  try { PAINT[type](g, rnd, variant); } catch (e) { /* keep an empty sprite */ }
  s = { c, w, h };
  SPR.set(key, s);
  return s;
}

function glintSprite() {
  if (GLINT) return GLINT;
  const S = 64, c = makeCanvas(S, S), g = c.getContext('2d');
  const rg = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  rg.addColorStop(0, 'rgba(255,255,240,1)');
  rg.addColorStop(0.15, 'rgba(255,250,220,0.55)');
  rg.addColorStop(1, 'rgba(255,240,200,0)');
  g.fillStyle = rg; g.fillRect(0, 0, S, S);
  g.strokeStyle = 'rgba(255,255,245,0.9)';
  g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(S / 2, 4); g.lineTo(S / 2, S - 4); g.moveTo(4, S / 2); g.lineTo(S - 4, S / 2); g.stroke();
  GLINT = c;
  return c;
}

// ---- painting helpers ----------------------------------------------------------------

function jitterPoly(rnd, pts, j) {
  return pts.map(([x, y]) => [x + (rnd() - 0.5) * j, y + (rnd() - 0.5) * j]);
}
function polyPath(pts, close = true) {
  const p = new Path2D();
  p.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) p.lineTo(pts[i][0], pts[i][1]);
  if (close) p.closePath();
  return p;
}
// Smooth closed path through points (midpoint quadratic).
function smoothPath(pts) {
  const p = new Path2D();
  const n = pts.length;
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  let m = mid(pts[n - 1], pts[0]);
  p.moveTo(m[0], m[1]);
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    m = mid(a, b);
    p.quadraticCurveTo(a[0], a[1], m[0], m[1]);
  }
  p.closePath();
  return p;
}
function blobPts(rnd, rx, ry, n, jit, squash = 0) {
  const pts = [];
  const ph = rnd() * 10;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    const k = 1 + (Math.sin(a * 3 + ph) * 0.5 + (rnd() - 0.5)) * jit;
    let y = Math.sin(a) * ry * k;
    if (squash && y > 0) y *= 1 - squash;
    pts.push([Math.cos(a) * rx * k, y]);
  }
  return pts;
}
// Inner rim light / shade along an edge: stroke the shape offset inside its own clip.
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
function speckle(g, rnd, x0, y0, w, h, n, color, r0, r1) {
  g.fillStyle = color;
  for (let i = 0; i < n; i++) {
    const x = x0 + rnd() * w, y = y0 + rnd() * h, r = r0 + rnd() * (r1 - r0);
    g.beginPath(); g.ellipse(x, y, r, r * (0.6 + rnd() * 0.5), rnd() * 3, 0, TAU); g.fill();
  }
}
function barnacles(g, rnd, pts) {
  for (const [x, y, s] of pts) {
    g.fillStyle = 'rgba(206,200,184,0.95)';
    g.beginPath(); g.ellipse(x, y, 0.9 * s, 0.7 * s, rnd(), 0, TAU); g.fill();
    g.fillStyle = 'rgba(120,112,98,0.9)';
    g.beginPath(); g.ellipse(x, y - 0.1 * s, 0.35 * s, 0.25 * s, 0, 0, TAU); g.fill();
    g.strokeStyle = 'rgba(255,250,236,0.6)'; g.lineWidth = 0.15;
    g.beginPath(); g.arc(x, y, 0.8 * s, Math.PI * 1.1, Math.PI * 1.7); g.stroke();
  }
}

const WOODS = [
  ['#9a7148', '#6f4d2e', '#47301b'],    // weathered brown
  ['#b1a58f', '#857a68', '#5a5145'],    // sun-bleached driftwood
  ['#8d6a45', '#6a4b2d', '#432e1b'],    // painted (teal flakes on top)
  ['#6a4c34', '#4d3522', '#2f2015'],    // tarred, dark
];

const PAINT = {
  // ---------------------------------------------------------------- plank
  plank(g, rnd, v) {
    const L = 27 + rnd() * 6, T = 4.2 + rnd() * 1.4;
    const [c0, c1, c2] = WOODS[v % WOODS.length];
    const top = [], bot = [];
    const n = 9;
    for (let i = 0; i <= n; i++) {
      const x = -L / 2 + (L - 3) * (i / n);
      top.push([x, -T / 2 + (rnd() - 0.5) * 0.35]);
      bot.push([x, T / 2 + (rnd() - 0.5) * 0.35]);
    }
    // splintered right end
    const ex = L / 2 - 3;
    const end = [[ex + 1.8, -T / 2 + 0.2], [ex + 3.2, -T / 2 + T * 0.25], [ex + 1.4, -T / 2 + T * 0.45], [ex + 3.0, T * 0.15], [ex + 0.8, T * 0.32], [ex + 2.0, T / 2]];
    const pts = [...top, ...end, ...bot.reverse(), [-L / 2 - 0.4, T * 0.2], [-L / 2 - 0.5, -T * 0.25]];
    const body = polyPath(pts);
    g.fillStyle = vgrad(g, -T / 2, T / 2, [[0, c0], [0.45, c1], [1, c2]]);
    g.fill(body);
    g.save();
    g.clip(body);
    // grain
    for (let i = 0; i < 7; i++) {
      const y = -T / 2 + T * (i + 0.5) / 7;
      g.strokeStyle = `rgba(30,18,8,${0.18 + rnd() * 0.2})`;
      g.lineWidth = 0.18 + rnd() * 0.15;
      g.beginPath();
      g.moveTo(-L / 2, y);
      for (let x = -L / 2; x <= L / 2; x += 2) g.lineTo(x, y + Math.sin(x * 0.3 + i * 1.7) * 0.25 + (rnd() - 0.5) * 0.1);
      g.stroke();
    }
    // a knot
    const kx = -L / 2 + 5 + rnd() * (L - 12), ky = (rnd() - 0.5) * T * 0.3;
    for (let k = 3; k >= 1; k--) {
      g.strokeStyle = `rgba(40,22,10,${0.25 + 0.1 * (3 - k)})`;
      g.lineWidth = 0.22;
      g.beginPath(); g.ellipse(kx, ky, k * 0.9, k * 0.38, 0, 0, TAU); g.stroke();
    }
    g.fillStyle = 'rgba(35,20,10,0.6)';
    g.beginPath(); g.ellipse(kx, ky, 0.6, 0.3, 0, 0, TAU); g.fill();
    // flaking teal paint
    if (v === 2) {
      g.fillStyle = 'rgba(78,140,134,0.85)';
      for (let i = 0; i < 6; i++) {
        const px = -L / 2 + rnd() * L, pw = 2 + rnd() * 5;
        g.fill(smoothPath(blobPts(rnd, pw, T * 0.3, 8, 0.5).map(([x, y]) => [x + px, y - T * 0.22])));
      }
      g.fillStyle = 'rgba(200,226,214,0.35)';
      for (let i = 0; i < 4; i++) g.fillRect(-L / 2 + rnd() * L, -T / 2 + 0.2, 1.5 + rnd() * 2, 0.3);
    }
    // wet, algae-stained underside
    g.fillStyle = vgrad(g, 0, T / 2, [[0, 'rgba(50,80,40,0)'], [1, 'rgba(56,92,48,0.55)']]);
    g.fillRect(-L, 0, L * 2, T);
    g.restore();
    // splinter lines at the broken end
    g.strokeStyle = 'rgba(214,180,130,0.55)'; g.lineWidth = 0.2;
    for (let i = 0; i < 3; i++) { const y = -T / 2 + T * (0.2 + i * 0.3); g.beginPath(); g.moveTo(ex - 2, y); g.lineTo(ex + 1.6, y + (rnd() - 0.5) * 0.4); g.stroke(); }
    // sunlit top edge, dark bottom edge
    rim(g, body, 'rgba(255,232,190,0.55)', 0.7, 0, 0.45);
    rim(g, body, 'rgba(15,8,4,0.5)', 0.8, 0, -0.5);
    // rusty nails, one bent and sticking out
    const nails = 1 + Math.floor(rnd() * 2);
    for (let i = 0; i < nails; i++) {
      const nx = -L / 2 + 3 + rnd() * (L - 8), ny = (rnd() - 0.5) * T * 0.4;
      const rg = g.createRadialGradient(nx, ny, 0, nx, ny, 1.6);
      rg.addColorStop(0, 'rgba(140,70,30,0.6)'); rg.addColorStop(1, 'rgba(140,70,30,0)');
      g.fillStyle = rg; g.fillRect(nx - 2, ny - 2, 4, 4);
      g.fillStyle = '#2b2522';
      g.beginPath(); g.arc(nx, ny, 0.55, 0, TAU); g.fill();
      g.fillStyle = 'rgba(220,200,180,0.5)';
      g.beginPath(); g.arc(nx - 0.15, ny - 0.18, 0.2, 0, TAU); g.fill();
    }
    const bx = -L / 2 + 4 + rnd() * (L - 10);
    g.strokeStyle = '#3a312c'; g.lineWidth = 0.42;
    g.beginPath(); g.moveTo(bx, -T / 2 + 0.2); g.lineTo(bx + 0.3, -T / 2 - 2.2); g.lineTo(bx + 1.9, -T / 2 - 2.9); g.stroke();
    g.strokeStyle = 'rgba(170,96,50,0.7)'; g.lineWidth = 0.18;
    g.beginPath(); g.moveTo(bx + 0.15, -T / 2 - 1); g.lineTo(bx + 0.3, -T / 2 - 2.1); g.stroke();
    if (v === 1 || v === 3) barnacles(g, rnd, [[-L / 2 + 3 + rnd() * 6, T / 2 - 0.5, 0.9], [-L / 2 + 6 + rnd() * 8, T / 2 - 0.3, 0.7], [L / 2 - 9, T / 2 - 0.4, 0.8]]);
  },

  // ---------------------------------------------------------------- plastic bottle
  bottle(g, rnd, v) {
    const L = 12 + rnd() * 1.5, R = 2.3 + rnd() * 0.3;
    const x0 = -L / 2, sx = L / 2 - 4.2, nx = L / 2 - 2.2;
    const body = new Path2D();
    body.moveTo(x0 + 1.2, -R);
    body.lineTo(sx, -R);
    body.bezierCurveTo(sx + 1.4, -R, sx + 1.4, -0.95, nx, -0.95);
    body.lineTo(nx + 0.9, -0.95); body.lineTo(nx + 0.9, 0.95); body.lineTo(nx, 0.95);
    body.bezierCurveTo(sx + 1.4, 0.95, sx + 1.4, R, sx, R);
    body.lineTo(x0 + 1.2, R);
    body.quadraticCurveTo(x0 - 0.2, R, x0 - 0.2, 0);
    body.quadraticCurveTo(x0 - 0.2, -R, x0 + 1.2, -R);
    body.closePath();
    const tints = [[210, 228, 222], [196, 214, 232], [222, 226, 206], [170, 214, 196]];
    const [r, gg, b] = tints[v % 4];
    g.fillStyle = vgrad(g, -R, R, [[0, `rgba(${r + 20},${gg + 20},${b + 20},0.72)`], [0.5, `rgba(${r},${gg},${b},0.5)`], [1, `rgba(${r - 60},${gg - 50},${b - 40},0.65)`]]);
    g.fill(body);
    g.save();
    g.clip(body);
    // a little sea water sloshing inside
    g.fillStyle = 'rgba(70,120,130,0.4)';
    g.fillRect(x0 - 1, R * 0.35, L, R);
    // ribs + crumples
    g.strokeStyle = 'rgba(255,255,255,0.28)'; g.lineWidth = 0.22;
    for (let i = 0; i < 3; i++) { const x = x0 + 1.6 + i * 0.9; g.beginPath(); g.moveTo(x, -R); g.lineTo(x, R); g.stroke(); }
    g.strokeStyle = 'rgba(80,100,100,0.35)'; g.lineWidth = 0.25;
    for (let i = 0; i < 2; i++) { const x = x0 + 4 + rnd() * 4; g.beginPath(); g.moveTo(x, -R); g.lineTo(x + 1.5, R * 0.3); g.lineTo(x + 0.8, R); g.stroke(); }
    // faded label (torn)
    if (v !== 3) {
      const lab = ['rgba(120,160,190,0.8)', 'rgba(190,130,118,0.8)', 'rgba(140,180,130,0.8)'][v % 3];
      const lx0 = x0 + 3.2, lx1 = sx - 0.6;
      const lp = new Path2D();
      lp.moveTo(lx0, -R); lp.lineTo(lx1, -R); lp.lineTo(lx1, R * 0.2); lp.lineTo(lx1 - 0.8, R * 0.5); lp.lineTo(lx1 - 0.2, R);
      lp.lineTo(lx0, R); lp.closePath();
      g.fillStyle = lab; g.fill(lp);
      g.fillStyle = 'rgba(245,240,226,0.75)';
      g.fillRect(lx0, -R * 0.25, lx1 - lx0 - 0.4, R * 0.42);
      g.fillStyle = 'rgba(60,60,70,0.45)';
      for (let i = 0; i < 4; i++) g.fillRect(lx0 + 0.6 + i * 1.05, -R * 0.14, 0.7, 0.22);
      g.fillStyle = 'rgba(255,255,255,0.18)';
      g.fillRect(lx0, -R, lx1 - lx0, 0.6);
    }
    g.restore();
    // cap
    const cap = ['#c4513f', '#3f6fa8', '#e2dccb', '#d9a33c'][v % 4];
    g.fillStyle = cap;
    g.beginPath(); g.roundRect ? g.roundRect(nx + 0.7, -1.3, 1.6, 2.6, 0.3) : g.rect(nx + 0.7, -1.3, 1.6, 2.6); g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.3)'; g.lineWidth = 0.15;
    for (let i = 0; i < 3; i++) { g.beginPath(); g.moveTo(nx + 1 + i * 0.45, -1.3); g.lineTo(nx + 1 + i * 0.45, 1.3); g.stroke(); }
    // glossy highlight
    g.strokeStyle = 'rgba(255,255,255,0.75)'; g.lineWidth = 0.45;
    g.beginPath(); g.moveTo(x0 + 1.1, -R + 0.65); g.lineTo(sx - 0.3, -R + 0.65); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 0.25;
    g.stroke(body);
  },

  // ---------------------------------------------------------------- fishing net
  net(g, rnd, v) {
    // three overlapping tangles of mesh held together by loose ropes
    const clumps = [[-7, 0.5, 7.5, 4.2], [2, -0.6, 8.5, 4.8], [9.5, 1, 5.5, 3.4]];
    const col = ['#7a9a66', '#8a9656', '#66947f'][v % 3];
    const paths = clumps.map(([cx, cy, rx, ry]) => smoothPath(blobPts(rnd, rx, ry, 12, 0.42, 0.05).map(([x, y]) => [x + cx, y + cy])));
    const all = new Path2D();
    for (const p of paths) all.addPath(p);
    g.fillStyle = 'rgba(44,66,44,0.32)';
    g.fill(all);
    g.save();
    g.clip(all);
    g.strokeStyle = col; g.lineWidth = 0.34;
    for (let k = -34; k < 30; k += 1.9) {
      for (const dir of [1, -1]) {
        g.beginPath();
        for (let s = 0; s <= 10; s++) {
          const f = s / 10, y = -8 + f * 16;
          const x = (dir > 0 ? k + f * 12 : k + 12 - f * 12) + Math.sin(y * 0.9 + k * dir) * 0.7;
          s ? g.lineTo(x, y) : g.moveTo(x, y);
        }
        g.stroke();
      }
    }
    // knots at the crossings
    g.fillStyle = 'rgba(40,62,36,0.6)';
    for (let i = 0; i < 40; i++) { g.beginPath(); g.arc((rnd() - 0.5) * 30, (rnd() - 0.5) * 10, 0.28, 0, TAU); g.fill(); }
    g.fillStyle = vgrad(g, -6, 6, [[0, 'rgba(255,255,220,0.14)'], [1, 'rgba(8,26,18,0.42)']]);
    g.fill(all);
    g.restore();
    // folded edges of the tangles
    for (const p of paths) {
      g.strokeStyle = 'rgba(52,78,46,0.9)'; g.lineWidth = 0.6; g.stroke(p);
      rim(g, p, 'rgba(230,240,190,0.35)', 0.6, 0, 0.4);
    }
    // loose ropes looping between and out of the tangles
    const rope = (pts, w) => {
      g.lineWidth = w; g.strokeStyle = '#8f7d50';
      g.beginPath(); g.moveTo(pts[0], pts[1]); g.bezierCurveTo(pts[2], pts[3], pts[4], pts[5], pts[6], pts[7]); g.stroke();
      g.lineWidth = w * 0.35; g.strokeStyle = 'rgba(245,225,170,0.5)'; g.setLineDash([0.45, 0.6]);
      g.beginPath(); g.moveTo(pts[0], pts[1] - 0.15); g.bezierCurveTo(pts[2], pts[3] - 0.15, pts[4], pts[5] - 0.15, pts[6], pts[7] - 0.15); g.stroke();
      g.setLineDash([]);
    };
    rope([-13, -1, -10, -5.5, -3, 4.5, 3, -3.5], 0.7);
    rope([6, 2.5, 10, 6.5, 14, -2.5, 16.5, 1.5], 0.65);
    rope([-14.5, 2, -16.5, 0.5, -16, 3.5, -17.5, 4.2], 0.55);
    // a few short weeds caught in it
    g.strokeStyle = 'rgba(96,112,52,0.7)'; g.lineWidth = 0.5;
    for (let i = 0; i < 3; i++) {
      const sx = -9 + i * 8 + rnd() * 2, sy = 3 + rnd();
      g.beginPath(); g.moveTo(sx, sy); g.quadraticCurveTo(sx + 1.2, sy + 1.6, sx + 0.2, sy + 2.8 + rnd()); g.stroke();
    }
    // floats bobbing on top (they keep the tangle afloat)
    const floats = v === 1 ? 1 : 2;
    for (let i = 0; i < floats; i++) {
      const fx = (i ? 6 : -5) + rnd() * 2, fy = -4.6, fr = 2.1;
      const orange = (v + i) % 2 === 0;
      const rg = g.createRadialGradient(fx - 0.7, fy - 0.8, 0.2, fx, fy, fr);
      rg.addColorStop(0, orange ? '#f4b07a' : '#fbf7ee');
      rg.addColorStop(0.55, orange ? '#d36a35' : '#ddd7c6');
      rg.addColorStop(1, orange ? '#7c3518' : '#8f897a');
      g.fillStyle = rg;
      g.beginPath(); g.arc(fx, fy, fr, 0, TAU); g.fill();
      g.strokeStyle = 'rgba(50,25,10,0.55)'; g.lineWidth = 0.18;
      g.beginPath(); g.moveTo(fx - 0.6, fy - 1.9); g.lineTo(fx - 0.1, fy - 0.8); g.lineTo(fx + 0.5, fy - 0.4); g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.7)';
      g.beginPath(); g.ellipse(fx - 0.8, fy - 0.9, 0.5, 0.3, -0.6, 0, TAU); g.fill();
    }
  },

  // ---------------------------------------------------------------- rusty scrap metal
  scrap(g, rnd, v) {
    if (v === 3) {
      // a dented tin can lying on its side
      const w = 7.5, r = 3.2;
      const body = new Path2D();
      body.moveTo(-w, -r); body.lineTo(w, -r); body.lineTo(w, r); body.lineTo(-w, r); body.closePath();
      g.fillStyle = vgrad(g, -r, r, [[0, '#b9b4a7'], [0.35, '#8e8a80'], [1, '#4c4842']]);
      g.fill(body);
      g.save(); g.clip(body);
      g.strokeStyle = 'rgba(40,36,30,0.35)'; g.lineWidth = 0.3;
      for (let x = -w + 1.5; x < w; x += 1.6) { g.beginPath(); g.moveTo(x, -r); g.lineTo(x, r); g.stroke(); }
      speckle(g, rnd, -w, -r, w * 2, r * 2, 14, 'rgba(150,70,25,0.55)', 0.4, 1.4);
      g.fillStyle = 'rgba(180,90,40,0.55)';
      g.fillRect(-w * 0.3, -r, w * 0.9, r * 2);
      g.fillStyle = 'rgba(235,225,200,0.4)';
      g.fillRect(-w * 0.1, -r * 0.4, w * 0.5, r * 0.6);
      g.restore();
      g.fillStyle = '#6d6a62';
      g.beginPath(); g.ellipse(w, 0, 1.2, r, 0, 0, TAU); g.fill();
      g.strokeStyle = '#a9a69c'; g.lineWidth = 0.3; g.stroke();
      rim(g, body, 'rgba(255,245,225,0.5)', 0.6, 0, 0.4);
      return;
    }
    if (v === 2) {
      // a broken styrofoam block carrying a twisted sheet
      const foam = smoothPath(jitterPoly(rnd, [[-9, -1], [8, -1.5], [9.5, 1.5], [7, 4.2], [-8, 4.5], [-10, 2]], 0.8));
      g.fillStyle = vgrad(g, -2, 5, [[0, '#ece8dc'], [1, '#a8a496']]);
      g.fill(foam);
      speckle(g, rnd, -9, -1, 18, 5, 26, 'rgba(120,115,100,0.35)', 0.15, 0.4);
      g.fillStyle = 'rgba(80,110,70,0.4)'; g.fillRect(-10, 3, 20, 2);
    }
    // corrugated sheet, torn and bent
    const n = 8, W = v === 2 ? 15 : 19, H = v === 2 ? 5 : 8;
    const top = [], bot = [];
    for (let i = 0; i <= n; i++) {
      const f = i / n, x = -W / 2 + W * f;
      const bend = Math.sin(f * Math.PI) * (v === 1 ? -2.2 : 1.2);
      top.push([x + (rnd() - 0.5) * 0.6, -H / 2 + bend + (rnd() - 0.5) * (i === 0 || i === n ? 1.4 : 0.4)]);
      bot.push([x + (rnd() - 0.5) * 0.6, H / 2 + bend * 0.6 + (rnd() - 0.5) * 0.4]);
    }
    const pts = [...top, [W / 2 + 0.8, 0], ...bot.reverse(), [-W / 2 - 1, -0.6], [-W / 2 + 0.6, -1.2], [-W / 2 - 0.8, -2]];
    const body = polyPath(pts);
    const oy = v === 2 ? -4 : 0;
    g.save();
    g.translate(0, oy);
    g.fillStyle = vgrad(g, -H / 2, H / 2, [[0, '#9b9a92'], [0.5, '#6e6c66'], [1, '#45423d']]);
    g.fill(body);
    g.save();
    g.clip(body);
    for (let x = -W / 2; x < W / 2; x += 1.5) {
      g.fillStyle = 'rgba(255,250,235,0.16)'; g.fillRect(x, -H, 0.5, H * 2);
      g.fillStyle = 'rgba(20,18,14,0.22)'; g.fillRect(x + 0.75, -H, 0.5, H * 2);
    }
    // rust blooms
    for (let i = 0; i < 7; i++) {
      const rx = (rnd() - 0.5) * W, ry = (rnd() - 0.5) * H, rr = 1 + rnd() * 3;
      const rg = g.createRadialGradient(rx, ry, 0, rx, ry, rr);
      rg.addColorStop(0, 'rgba(120,52,18,0.85)'); rg.addColorStop(0.6, 'rgba(168,84,34,0.5)'); rg.addColorStop(1, 'rgba(168,84,34,0)');
      g.fillStyle = rg; g.fillRect(rx - rr, ry - rr, rr * 2, rr * 2);
    }
    // rust streaks running down
    g.strokeStyle = 'rgba(140,64,24,0.45)'; g.lineWidth = 0.4;
    for (let i = 0; i < 4; i++) { const x = (rnd() - 0.5) * W; g.beginPath(); g.moveTo(x, -H / 2); g.lineTo(x + 0.3, H / 2 * rnd()); g.stroke(); }
    // holes
    for (let i = 0; i < 2; i++) {
      const hx = (rnd() - 0.5) * W * 0.6, hy = (rnd() - 0.5) * H * 0.4;
      g.fillStyle = 'rgba(30,14,6,0.9)';
      g.beginPath(); g.ellipse(hx, hy, 0.8, 0.55, 0.3, 0, TAU); g.fill();
      g.strokeStyle = 'rgba(190,100,40,0.7)'; g.lineWidth = 0.3; g.stroke();
    }
    g.restore();
    // rivets along an edge
    g.fillStyle = '#3a3631';
    for (let x = -W / 2 + 1.5; x < W / 2 - 1; x += 2.6) { g.beginPath(); g.arc(x, -H / 2 + 1.1 + Math.sin(((x + W / 2) / W) * Math.PI) * (v === 1 ? -2.2 : 1.2), 0.32, 0, TAU); g.fill(); }
    rim(g, body, 'rgba(255,240,215,0.55)', 0.6, 0, 0.4);
    rim(g, body, 'rgba(0,0,0,0.45)', 0.7, 0, -0.45);
    g.restore();
  },

  // ---------------------------------------------------------------- soaked cloth bundle
  cloth(g, rnd, v) {
    const cols = [
      ['#c06a52', '#9a4a38', '#5e2a20'],
      ['#6f88a8', '#4f6787', '#2d3e55'],
      ['#d6c7a0', '#b3a27c', '#7a6b4e'],
      ['#7f9a68', '#5f7a4b', '#3a4d2e'],
    ][v % 4];
    const body = smoothPath(blobPts(rnd, 8.2, 4.4, 11, 0.28, 0.05));
    g.fillStyle = vgrad(g, -5, 5, [[0, cols[0]], [0.5, cols[1]], [1, cols[2]]]);
    g.fill(body);
    g.save();
    g.clip(body);
    if (v === 0 || v === 3) {
      // faded check pattern
      g.fillStyle = 'rgba(30,20,15,0.18)';
      for (let x = -10; x < 10; x += 2.4) g.fillRect(x, -6, 0.9, 12);
      for (let y = -6; y < 6; y += 2.4) g.fillRect(-10, y, 20, 0.9);
      g.fillStyle = 'rgba(255,240,220,0.12)';
      for (let x = -9; x < 10; x += 4.8) g.fillRect(x, -6, 0.5, 12);
    } else if (v === 1) {
      g.strokeStyle = 'rgba(230,200,140,0.6)'; g.lineWidth = 0.2; g.setLineDash([0.6, 0.5]);
      g.beginPath(); g.moveTo(-8, -1); g.bezierCurveTo(-3, -3, 3, 1, 8, -1.5); g.stroke();
      g.setLineDash([]);
    } else {
      g.fillStyle = 'rgba(120,80,50,0.4)';
      g.fillRect(-2, -1, 4.5, 3.2);
      g.strokeStyle = 'rgba(60,40,25,0.5)'; g.lineWidth = 0.15; g.setLineDash([0.4, 0.4]);
      g.strokeRect(-2, -1, 4.5, 3.2); g.setLineDash([]);
    }
    // folds: shadow + highlight pairs
    for (let i = 0; i < 5; i++) {
      const fx = (rnd() - 0.5) * 12, fy = (rnd() - 0.5) * 5, l = 2 + rnd() * 4, a = (rnd() - 0.5) * 1.6;
      g.strokeStyle = 'rgba(15,8,5,0.35)'; g.lineWidth = 0.5;
      g.beginPath(); g.moveTo(fx, fy); g.quadraticCurveTo(fx + Math.cos(a) * l * 0.5, fy + Math.sin(a) * l * 0.5 - 1, fx + Math.cos(a) * l, fy + Math.sin(a) * l); g.stroke();
      g.strokeStyle = 'rgba(255,240,220,0.22)'; g.lineWidth = 0.35;
      g.beginPath(); g.moveTo(fx, fy - 0.5); g.quadraticCurveTo(fx + Math.cos(a) * l * 0.5, fy + Math.sin(a) * l * 0.5 - 1.5, fx + Math.cos(a) * l, fy + Math.sin(a) * l - 0.5); g.stroke();
    }
    // soaked lower half
    g.fillStyle = vgrad(g, -1, 5, [[0, 'rgba(10,15,20,0)'], [1, 'rgba(10,15,20,0.45)']]);
    g.fillRect(-10, -1, 20, 7);
    g.restore();
    rim(g, body, 'rgba(255,236,210,0.45)', 0.7, 0, 0.45);
    // knot + string ends
    g.fillStyle = cols[1];
    g.beginPath(); g.ellipse(1.5, -4.2, 1.8, 1.2, 0.2, 0, TAU); g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.3)'; g.lineWidth = 0.25; g.stroke();
    g.strokeStyle = '#d8cda6'; g.lineWidth = 0.32;
    g.beginPath(); g.moveTo(-6, -2.2); g.quadraticCurveTo(0, -5.4, 6.5, -2.6); g.stroke();
    g.beginPath(); g.moveTo(1.5, -4.6); g.quadraticCurveTo(3.5, -6.6, 5.2, -6.1); g.moveTo(1.5, -4.6); g.quadraticCurveTo(0.5, -6.8, -1.2, -6.4); g.stroke();
  },

  // ---------------------------------------------------------------- palm frond
  frond(g, rnd, v) {
    const dry = v === 2;
    const L = 17;
    const at = (f) => { const x = -L + f * 2 * L; return [x, -Math.sin(f * Math.PI) * 2.2 + f * 0.8]; };
    // leaflets behind the rachis, then in front
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 2; i < 40; i++) {
        const f = i / 40;
        const [x, y] = at(f);
        const side = (i % 2 ? 1 : -1);
        if ((pass === 0) !== (side < 0)) continue;
        const len = (6.5 - Math.abs(f - 0.45) * 7) * (0.8 + rnd() * 0.35);
        const ang = (side < 0 ? -2.5 : 2.6) + (rnd() - 0.5) * 0.35 + f * 0.25 * side;
        const ex = x + Math.cos(ang) * len, ey = y + Math.sin(ang) * len * 0.62;
        const mx = (x + ex) / 2, my = (y + ey) / 2;
        const nx = -(ey - y) / len * 0.6, ny = (ex - x) / len * 0.6;
        const brown = dry ? rnd() < 0.6 : rnd() < 0.18;
        const base = brown ? [160, 120, 62] : [104 + rnd() * 30, 146 + rnd() * 24, 62 + rnd() * 18];
        const k = pass ? 1 : 0.72;
        g.fillStyle = `rgb(${base[0] * k | 0},${base[1] * k | 0},${base[2] * k | 0})`;
        g.beginPath();
        g.moveTo(x, y);
        g.quadraticCurveTo(mx + nx, my + ny, ex, ey);
        g.quadraticCurveTo(mx - nx, my - ny, x, y);
        g.fill();
        g.strokeStyle = `rgba(230,240,170,${pass ? 0.35 : 0.15})`; g.lineWidth = 0.12;
        g.beginPath(); g.moveTo(x, y); g.lineTo(ex, ey); g.stroke();
        // ragged, browned tips
        if (rnd() < 0.35) {
          g.fillStyle = 'rgba(120,84,40,0.75)';
          g.beginPath(); g.arc(ex, ey, 0.35, 0, TAU); g.fill();
        }
      }
    }
    // the rachis
    g.beginPath();
    for (let i = 0; i <= 20; i++) { const [x, y] = at(i / 20); i ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.strokeStyle = dry ? '#8f7a44' : '#7e8c3c'; g.lineWidth = 0.95; g.stroke();
    g.strokeStyle = 'rgba(240,240,180,0.45)'; g.lineWidth = 0.3;
    g.beginPath();
    for (let i = 0; i <= 20; i++) { const [x, y] = at(i / 20); i ? g.lineTo(x, y - 0.3) : g.moveTo(x, y - 0.3); }
    g.stroke();
    // torn base of the stalk
    g.fillStyle = '#6e5a30';
    g.beginPath(); g.moveTo(-L - 1.5, 0.4); g.lineTo(-L + 1.5, -0.8); g.lineTo(-L + 1.4, 1.2); g.closePath(); g.fill();
  },

  // ---------------------------------------------------------------- barrel / drum
  barrel(g, rnd, v) {
    if (v === 1) {
      // blue plastic drum lying on its side
      const w = 10.5, r = 6.8;
      const body = new Path2D();
      body.moveTo(-w, -r + 1); body.quadraticCurveTo(-w, -r, -w + 1.5, -r);
      body.lineTo(w - 1.5, -r); body.quadraticCurveTo(w, -r, w, -r + 1);
      body.lineTo(w, r - 1); body.quadraticCurveTo(w, r, w - 1.5, r);
      body.lineTo(-w + 1.5, r); body.quadraticCurveTo(-w, r, -w, r - 1); body.closePath();
      g.fillStyle = vgrad(g, -r, r, [[0, '#6f98c4'], [0.3, '#3f6c9e'], [0.75, '#2a4b72'], [1, '#18304c']]);
      g.fill(body);
      g.save(); g.clip(body);
      for (const x of [-w * 0.55, 0, w * 0.55]) {
        g.fillStyle = 'rgba(10,20,40,0.35)'; g.fillRect(x - 0.6, -r, 1.2, r * 2);
        g.fillStyle = 'rgba(200,225,255,0.25)'; g.fillRect(x - 1, -r, 0.4, r * 2);
      }
      g.fillStyle = 'rgba(235,235,225,0.55)';
      g.fillRect(-w * 0.45, -r * 0.45, w * 0.7, r * 0.7);
      g.fillStyle = 'rgba(40,50,70,0.5)';
      for (let i = 0; i < 3; i++) g.fillRect(-w * 0.4, -r * 0.3 + i * 1.3, w * 0.5 * (1 - i * 0.25), 0.5);
      speckle(g, rnd, -w, -r, w * 2, r * 2, 18, 'rgba(255,255,255,0.12)', 0.3, 1.0);
      g.fillStyle = vgrad(g, 0, r, [[0, 'rgba(40,80,50,0)'], [1, 'rgba(46,86,52,0.5)']]);
      g.fillRect(-w, 0, w * 2, r);
      g.restore();
      g.fillStyle = '#e8e3d2';
      g.beginPath(); g.ellipse(w + 0.4, -r * 0.45, 0.8, 1.5, 0, 0, TAU); g.fill();
      rim(g, body, 'rgba(230,240,255,0.6)', 0.8, 0, 0.5);
      return;
    }
    // upright barrel: wooden (v0) or rusty oil drum (v2)
    const wood = v === 0;
    const H = 9.5, rT = 6.6, rM = wood ? 8.2 : 7.2;
    const body = new Path2D();
    body.moveTo(-rT, -H);
    body.bezierCurveTo(-rM - 0.6, -H * 0.4, -rM - 0.6, H * 0.4, -rT, H);
    body.ellipse(0, H, rT, 1.5, 0, Math.PI, 0, true);
    body.bezierCurveTo(rM + 0.6, H * 0.4, rM + 0.6, -H * 0.4, rT, -H);
    body.closePath();
    const hg = g.createLinearGradient(-rM, 0, rM, 0);
    if (wood) { hg.addColorStop(0, '#3e2816'); hg.addColorStop(0.32, '#9a7045'); hg.addColorStop(0.55, '#7a5432'); hg.addColorStop(1, '#2e1d10'); }
    else { hg.addColorStop(0, '#3d1a12'); hg.addColorStop(0.3, '#a54a32'); hg.addColorStop(0.55, '#7f3624'); hg.addColorStop(1, '#2a110b'); }
    g.fillStyle = hg;
    g.fill(body);
    g.save(); g.clip(body);
    if (wood) {
      for (let x = -rM; x < rM; x += 2.2) {
        g.strokeStyle = 'rgba(20,10,4,0.5)'; g.lineWidth = 0.25;
        g.beginPath(); g.moveTo(x * 0.82, -H - 1); g.quadraticCurveTo(x * 1.02, 0, x * 0.82, H + 1); g.stroke();
      }
      speckle(g, rnd, -rM, -H, rM * 2, H * 2, 20, 'rgba(30,18,8,0.25)', 0.2, 0.6);
    } else {
      for (const y of [-H * 0.33, H * 0.33]) {
        g.fillStyle = 'rgba(20,6,3,0.45)'; g.fillRect(-rM, y - 0.4, rM * 2, 0.8);
        g.fillStyle = 'rgba(255,200,170,0.25)'; g.fillRect(-rM, y - 0.8, rM * 2, 0.35);
      }
      for (let i = 0; i < 6; i++) {
        const x = (rnd() - 0.5) * rM * 1.6;
        g.strokeStyle = 'rgba(70,30,12,0.55)'; g.lineWidth = 0.6 + rnd() * 0.6;
        g.beginPath(); g.moveTo(x, -H + rnd() * 4); g.lineTo(x + 0.2, H * (0.2 + rnd() * 0.8)); g.stroke();
      }
      // faded hazard diamond
      g.fillStyle = 'rgba(230,190,90,0.55)';
      g.beginPath(); g.moveTo(1, -3.5); g.lineTo(4, -0.5); g.lineTo(1, 2.5); g.lineTo(-2, -0.5); g.closePath(); g.fill();
      g.fillStyle = 'rgba(40,20,10,0.6)'; g.fillRect(0.6, -1.8, 0.8, 2);
    }
    g.fillStyle = vgrad(g, 0, H, [[0, 'rgba(40,70,40,0)'], [1, 'rgba(50,84,44,0.55)']]);
    g.fillRect(-rM - 1, 0, rM * 2 + 2, H + 2);
    g.restore();
    // hoops
    if (wood) {
      for (const [y, r] of [[-H * 0.78, rT + 0.7], [-H * 0.28, rM - 0.1], [H * 0.28, rM - 0.1], [H * 0.78, rT + 0.7]]) {
        g.strokeStyle = '#2f2b27'; g.lineWidth = 1.0;
        g.beginPath(); g.ellipse(0, y, r + 0.2, 0.9, 0, 0.05, Math.PI - 0.05); g.stroke();
        g.strokeStyle = 'rgba(190,110,60,0.6)'; g.lineWidth = 0.35;
        g.beginPath(); g.ellipse(0, y - 0.3, r, 0.8, 0, 0.6, 1.4); g.stroke();
        g.strokeStyle = 'rgba(230,220,200,0.35)'; g.lineWidth = 0.25;
        g.beginPath(); g.ellipse(0, y - 0.45, r, 0.8, 0, 1.9, 2.4); g.stroke();
      }
    }
    // lid
    g.fillStyle = wood ? '#8a6640' : '#6f2e1f';
    g.beginPath(); g.ellipse(0, -H, rT, 1.6, 0, 0, TAU); g.fill();
    g.strokeStyle = wood ? '#3d2816' : '#2e120a'; g.lineWidth = 0.45; g.stroke();
    if (wood) {
      g.strokeStyle = 'rgba(40,24,12,0.5)'; g.lineWidth = 0.18;
      for (let x = -4; x <= 4; x += 2.2) { g.beginPath(); g.moveTo(x, -H - 1.4); g.lineTo(x, -H + 1.4); g.stroke(); }
    }
    g.fillStyle = '#1e140d';
    g.beginPath(); g.ellipse(2.4, -H, 0.8, 0.35, 0, 0, TAU); g.fill();
    g.strokeStyle = 'rgba(255,230,190,0.45)'; g.lineWidth = 0.35;
    g.beginPath(); g.ellipse(0, -H, rT - 0.4, 1.2, 0, Math.PI * 1.05, Math.PI * 1.7); g.stroke();
    rim(g, body, 'rgba(255,220,180,0.25)', 0.8, 0.5, 0);
  },

  // ---------------------------------------------------------------- crate (under the surface)
  crate(g, rnd, v) {
    const W = 10.5, H = 8.5;
    const box = new Path2D();
    box.rect(-W, -H, W * 2, H * 2);
    const c = v ? ['#9b8a6a', '#76664a', '#4a3f2c'] : ['#8a6644', '#664a30', '#3f2c1b'];
    g.fillStyle = vgrad(g, -H, H, [[0, c[0]], [0.5, c[1]], [1, c[2]]]);
    g.fill(box);
    g.save(); g.clip(box);
    // planks with gaps
    for (let i = 0; i < 4; i++) {
      const y = -H + i * (H / 2);
      g.fillStyle = 'rgba(10,6,2,0.65)'; g.fillRect(-W, y - 0.35, W * 2, 0.7);
      g.strokeStyle = 'rgba(30,18,8,0.25)'; g.lineWidth = 0.18;
      for (let k = 0; k < 3; k++) { const yy = y + 0.9 + k * 1.1; g.beginPath(); g.moveTo(-W, yy); g.bezierCurveTo(-3, yy + 0.4, 3, yy - 0.4, W, yy); g.stroke(); }
    }
    // stenciled mark (faded)
    g.strokeStyle = 'rgba(20,14,8,0.45)'; g.lineWidth = 0.7;
    g.beginPath(); g.arc(-2.5, 0, 2.4, 0, TAU); g.stroke();
    g.beginPath(); g.moveTo(2, 2); g.lineTo(2, -2.5); g.moveTo(0.8, -1.2); g.lineTo(2, -2.6); g.lineTo(3.2, -1.2); g.stroke();
    g.fillStyle = 'rgba(20,14,8,0.4)';
    g.fillRect(4.5, -1, 3.5, 0.6); g.fillRect(4.5, 0.4, 2.6, 0.6);
    // algae bloom on the lower part
    g.fillStyle = vgrad(g, -H, H, [[0, 'rgba(60,96,52,0)'], [0.6, 'rgba(60,96,52,0.25)'], [1, 'rgba(64,104,54,0.7)']]);
    g.fillRect(-W, -H, W * 2, H * 2);
    speckle(g, rnd, -W, 0, W * 2, H, 30, 'rgba(90,130,70,0.45)', 0.2, 0.8);
    g.restore();
    // frame boards and brace
    g.fillStyle = c[1];
    g.strokeStyle = 'rgba(10,6,2,0.55)'; g.lineWidth = 0.35;
    for (const x of [-W, W - 2.2]) { g.fillRect(x, -H, 2.2, H * 2); g.strokeRect(x, -H, 2.2, H * 2); }
    g.save();
    g.beginPath(); g.rect(-W + 2.2, -H, W * 2 - 4.4, H * 2); g.clip();
    g.translate(0, 0); g.rotate(Math.atan2(H * 2, W * 2 - 4.4));
    g.fillStyle = c[0]; g.fillRect(-W * 1.2, -1.1, W * 2.4, 2.2);
    g.strokeRect(-W * 1.2, -1.1, W * 2.4, 2.2);
    g.restore();
    // nails
    g.fillStyle = '#2a2420';
    for (const [x, y] of [[-W + 1.1, -H + 1.2], [-W + 1.1, H - 1.2], [W - 1.1, -H + 1.2], [W - 1.1, H - 1.2], [-W + 1.1, 0], [W - 1.1, 0]]) { g.beginPath(); g.arc(x, y, 0.38, 0, TAU); g.fill(); }
    rim(g, box, 'rgba(255,240,210,0.4)', 0.9, 0, 0.6);
    barnacles(g, rnd, [[-W + 3, H - 0.6, 1], [-W + 5.4, H - 0.4, 0.8], [W - 5, H - 0.5, 1.1], [W - 0.4, H - 3, 0.8], [-W + 0.5, H - 4, 0.7]]);
  },

  // ---------------------------------------------------------------- message bottle
  note(g, rnd) {
    const L = 11.5, R = 2.5;
    const x0 = -L / 2, sx = L / 2 - 3.6, nx = L / 2 - 1.6;
    const body = new Path2D();
    body.moveTo(x0 + 1, -R);
    body.lineTo(sx, -R);
    body.bezierCurveTo(sx + 1.6, -R, sx + 1.2, -1, nx, -0.95);
    body.lineTo(nx + 0.6, -1.05); body.lineTo(nx + 0.6, 1.05); body.lineTo(nx, 0.95);
    body.bezierCurveTo(sx + 1.2, 1, sx + 1.6, R, sx, R);
    body.lineTo(x0 + 1, R);
    body.quadraticCurveTo(x0, R, x0, 0); body.quadraticCurveTo(x0, -R, x0 + 1, -R);
    body.closePath();
    g.fillStyle = vgrad(g, -R, R, [[0, 'rgba(150,200,160,0.55)'], [0.6, 'rgba(70,130,90,0.45)'], [1, 'rgba(30,70,45,0.7)']]);
    g.fill(body);
    // the rolled letter inside
    g.save(); g.clip(body);
    g.fillStyle = '#efe3c2';
    g.beginPath(); g.roundRect ? g.roundRect(x0 + 1.3, -1.3, sx - x0 - 0.8, 2.5, 1.2) : g.rect(x0 + 1.3, -1.3, sx - x0 - 0.8, 2.5); g.fill();
    g.fillStyle = 'rgba(160,140,100,0.5)';
    g.fillRect(x0 + 1.3, 0.5, sx - x0 - 0.8, 0.7);
    g.strokeStyle = 'rgba(90,80,70,0.45)'; g.lineWidth = 0.14;
    for (let i = 0; i < 3; i++) { g.beginPath(); g.moveTo(x0 + 2.2, -0.7 + i * 0.5); g.lineTo(sx - 1.2 - i, -0.7 + i * 0.5); g.stroke(); }
    g.fillStyle = '#b8352b';
    g.fillRect(x0 + (sx - x0) * 0.55, -1.35, 0.6, 2.6);
    g.fillStyle = vgrad(g, -R, R, [[0, 'rgba(120,190,140,0.12)'], [1, 'rgba(20,60,40,0.35)']]);
    g.fillRect(x0, -R, L, R * 2);
    g.restore();
    // cork
    g.fillStyle = '#b48a5a';
    g.fillRect(nx + 0.5, -1.1, 1.5, 2.2);
    g.fillStyle = 'rgba(80,50,20,0.5)';
    for (let i = 0; i < 4; i++) g.fillRect(nx + 0.7 + rnd() * 1.1, -0.9 + rnd() * 1.6, 0.25, 0.25);
    // glass edge + highlights
    g.strokeStyle = 'rgba(200,240,210,0.6)'; g.lineWidth = 0.3; g.stroke(body);
    g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = 0.45;
    g.beginPath(); g.moveTo(x0 + 1.2, -R + 0.6); g.lineTo(sx - 0.4, -R + 0.6); g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.8)';
    g.beginPath(); g.arc(sx + 0.6, -1.4, 0.35, 0, TAU); g.fill();
  },
};
