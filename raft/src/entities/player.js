// 少年与海 — 少年 (the boy).
//
// update(G, dt): physics (walk, jump, wade, tread water at the surface, dive and swim in
//   eight directions, climb back onto the raft, walk up island beaches), oxygen and the
//   survival stats, death, picking the interactable under the prompt, tools (hook + rope,
//   spear, hammer swing, bare hands), eating and drinking, his own small light and the
//   lantern. While a raft cutscene runs (G.raft.busy) he ignores movement and tool input.
// draw(ctx, G): a procedurally animated little boy — big head, messy dark hair, an
//   oversized navy knit sweater with rolled sleeves, shorts, bare feet and a long red
//   scarf (a verlet ribbon that flutters in the wind and floats under water). He is drawn
//   into a small offscreen buffer so he can carry a rim light from the sun, the moon, the
//   water above, a nearby lamp or his own lantern. Then the rope, the hook and the aim arc.
//
// Runtime state lives in G.playerRt. A few read-only conveniences are published on
// G.player every step for other modules: state, onRaft, onIsland, inWater, underwater,
// depth, invuln, dead, charge, lantern.

import { C, isNight, say, journal } from '../core/state.js';
import { input, hint } from '../core/input.js';
import { waterY, seabedY, groundAt, addLight, addInteract, addHit, onScreen, worldToScreen } from '../core/world.js';
import { emit } from '../core/particles.js';
import { TAU, clamp, lerp, smoothstep, approach, noise1, rand, makeCanvas } from '../core/util.js';
import { deckAt } from '../systems/raft.js';
import { islandAt, groundAt as isleGroundAt } from '../systems/islands.js';
import { hookCatch, collectAttached } from './debris.js';
import { useItem } from '../systems/inventory.js';
import { sfx } from '../systems/audio.js';
import { celestial } from '../render/sky.js';

// =====================================================================================
// tuning
// =====================================================================================

const PELVIS = 9.5;            // feet → pelvis when standing (world units; the boy is 28 tall)
const HEAD_UP = 13;            // pelvis → centre of the head along the body axis
const WALK = 70;
const ACC_GROUND = 640, FRICTION = 900, ACC_AIR = 430;
const JUMP_V = Math.sqrt(2 * C.GRAVITY * 40);    // ≈ 40 units high
const STEP_UP = 9;             // ledges up to this height are walked up
const STEP_RAFT = STEP_UP + 7; // from a beach onto a beached raft whose deck end a wave has lifted
const WADE_MAX = 17;           // feet deeper than this under the surface → swimming
const SWIM_SURF = 48, SWIM_DEEP = 64, FLIPPERS = 1.4;
const O2_DRAIN = 100 / 22, O2_FILL = 100 / 2.2, DROWN_DPS = 6;
const HUNGER_RATE = 100 / 360, THIRST_RATE = 100 / 240;
const HOOK_G = 560, ROPE_MAX = 280, REEL_SPEED = 200, CHARGE_TIME = 0.8;
const SPEAR_CD = 0.45, SPEAR_CD_WATER = 0.62, SPEAR_REACH = 34, SPEAR_R = 14;   // reach ≈ the drawn tip at full thrust
const SWIM_IDLE_RISE = 3;      // idle under water he drifts up this slowly (≈ holding still, so fish don't startle)
const HP_REGEN = 0.25;         // hp/s while fed and watered (slow: bandages should matter)
const CLIMB_SLACK = 3;         // the raft can be climbed from within this many units inside either end, never from beneath
const RAFT_UNDER = 12;         // deck top → underside of the logs
const FOODS = ['cooked_fish', 'can', 'coconut', 'berry', 'raw_fish'];
const TOOLS = ['hook', 'spear', 'hammer', 'hand'];

const COL = {
  skin: '#c8957a', skinFar: '#86604f', ear: '#a97a63',
  sweater: '#27324f', sweaterFar: '#161d31', sweaterDark: '#1a2138', sweaterLight: '#3c4a74',
  cuff: '#34426a', cuffFar: '#1e2742',
  shorts: '#4b3d2c', shortsFar: '#2d251b',
  hair: '#17120f', hairHi: '#4d3c31',
  scarf: '#b8352b', scarfDark: '#7d2019', scarfHi: '#dd6150', scarfBack: '#8f281f',
  eye: '#140d0b', blush: 'rgba(222,104,90,0.42)',
  rope: '#b9a27c', wood: '#7b5a3a', woodDark: '#4e3824', metal: '#5a5f66', metalHi: '#aab1b8',
};

const DEATH_LINES = {
  drown: '海水灌满了胸口。他最后看见的，是头顶那一小片越来越远的光。',
  hunger: '饥饿抽走了最后一点力气。他蜷在木板上，像是睡着了。',
  thirst: '四周全是水，却没有一口能喝。他倒下的时候，嘴唇已经裂开了。',
  shark: '灰色的背鳍绕了最后一圈。海面很快又恢复了平静。',
  beast: '林子里的东西找到了他。天亮以后，沙滩上只剩下一条红围巾。',
  jelly: '发光的触须缠住了他。那片蓝光很美，也很冷。',
  angler: '黑暗里那盏小灯晃了晃。他游近的时候，灯后面的嘴合上了。',
  default: '少年的旅程，在这片海上结束了。',
};

const easeOut = (t) => 1 - (1 - t) * (1 - t);
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const has = (G, id) => (G.inv && G.inv[id]) || 0;

// =====================================================================================
// defensive wrappers around other modules (they may still be stubs, or throw)
// =====================================================================================

const reported = new Set();
function oops(tag, e) {
  if (reported.has(tag)) return;
  reported.add(tag);
  console.error('[player → ' + tag + ']', e);
}
function play(name, opts) { try { sfx(name, opts); } catch (e) { oops('sfx', e); } }
function deck(G, x) {
  try { const y = deckAt(G, x); return Number.isFinite(y) ? y : null; } catch (e) { oops('deckAt', e); return null; }
}
function islandHere(G, x) { try { return islandAt(G, x) || null; } catch (e) { oops('islandAt', e); return null; } }
function ground(G, x, fromY) {
  try {
    const g = groundAt(G, x, fromY);
    return g && Number.isFinite(g.y) ? g : null;
  } catch (e) {
    oops('groundAt', e);
    let best = null;
    const r = deck(G, x);
    if (r != null && r >= fromY - 2) best = { y: r, kind: 'raft' };
    const s = seabedY(G, x);
    if (s >= fromY - 2 && (!best || s < best.y)) best = { y: s, kind: 'seabed' };
    return best;
  }
}
// The highest solid surface at x (raft deck, island, seabed) wherever the boy is.
const topAt = (G, x) => ground(G, x, -1e9);
// Island terrain height at x (incl. its underwater slopes), or null.
function isleY(G, x) {
  try { const y = isleGroundAt(G, x); return Number.isFinite(y) ? y : null; } catch (e) { oops('islands.groundAt', e); return null; }
}
// The floor at x WITHOUT the raft (island terrain or seabed): the highest one at or below fromY - 2.
function floorAt(G, x, fromY = -1e9) {
  let best = null;
  const i = isleY(G, x);
  if (i != null && i >= fromY - 2) best = { y: i, kind: 'island' };
  let s = null;
  try { s = seabedY(G, x); } catch (e) { oops('seabedY', e); }
  if (Number.isFinite(s) && s >= fromY - 2 && (!best || s < best.y)) best = { y: s, kind: 'seabed' };
  return best;
}
// Where a thrown hook comes to rest at x: dry land / deck, or the water surface.
function surfaceTop(G, x) {
  const wy = waterY(G, x);
  const t = topAt(G, x);
  if (t && t.y < wy) return { y: t.y, land: true };
  return { y: wy, land: false };
}
function raftSpan(G) {
  const R = G.raft;
  if (!R || !Array.isArray(R.tiles) || !Number.isFinite(R.x) || !R.tiles.length) return null;
  return {
    x0: R.x, x1: R.x + R.tiles.length * C.TILE_W,
    y: Number.isFinite(R.y) ? R.y : null,
    vx: Number.isFinite(R.vx) ? R.vx : 0,
  };
}

// =====================================================================================
// runtime state
// =====================================================================================

function newRt(G) {
  const P = G.player;
  return {
    mode: 'ground', gk: 'raft', under: false, rot: 0, headUnder: false, depth: 0,
    lastX: P.x, lastY: P.y, fresh: true,
    invuln: 0, hurtT: 9, hurtDir: 1, coyote: 0, jumpBuf: 0, landT: 9, landPow: 0,
    walkPh: 0, swimPh: 0, underT: 0, bubbleT: 0.8, glowT: 0, wetT: 0, wadeT: 0,
    charging: false, charge: 0, throwT: 9, swingT: 9, eatT: 9, spear: null, spearCD: 0, reelT: 0,
    climb: null, airCarry: 0, frozen: false,
    warn: { o2: false, far: false, hunger: false, thirst: false, nohook: false },
    lantern: false, cause: '', dead: false, deadT: 0, deadWater: false, deadRot: 0, sink: 0,
    starve: '',
    // world offsets from (P.x, P.y) of points measured on the last drawn pose
    off: { hand: [5, -15], shoulder: [1, -17], lantern: [6, -9], head: [1, -22] },
    lightHalo: null, lightLantern: null,
    // draw-time animation
    pose: null, fx: P.facing < 0 ? -1 : 1, lastNow: 0, t: Math.random() * 100,
    blinkT: 2.5, blink: 0, glanceT: 6, glanceOn: 0, swing: 0,
    scarf: null, scarfAX: NaN, scarfAY: NaN,
  };
}
const rt = (G) => G.playerRt || (G.playerRt = newRt(G));

// The held controls as the boy obeys them this step. While a raft cutscene runs
// (G.raft.busy: sailing around an island, sleeping) he ignores movement and tool input.
const ctl = { up: false, down: false, use: false };

// =====================================================================================
// init
// =====================================================================================

export function init(G) {
  const P = G.player;
  if (!P) return;
  const num = (v, d) => (Number.isFinite(v) ? v : d);
  P.x = num(P.x, 2 * C.TILE_W); P.y = num(P.y, -C.DECK_H);
  P.vx = num(P.vx, 0); P.vy = num(P.vy, 0);
  P.facing = P.facing < 0 ? -1 : 1;
  P.hp = clamp(num(P.hp, 100), 0, C.MAX_STAT);
  P.hunger = clamp(num(P.hunger, 85), 0, C.MAX_STAT);
  P.thirst = clamp(num(P.thirst, 80), 0, C.MAX_STAT);
  P.oxygen = clamp(num(P.oxygen, 100), 0, C.MAX_STAT);
  if (P.hp <= 0) P.hp = 1;                       // a loaded game never starts dead
  if (!TOOLS.includes(P.tool)) P.tool = 'hook';
  if (P.tool === 'spear' && !(has(G, 'spear') > 0)) P.tool = 'hook';
  G.hook = null;
  G.prompt = null;
  G.playerRt = newRt(G);
  publish(G, P, G.playerRt);
}

// =====================================================================================
// update
// =====================================================================================

export function update(G, dt) {
  const P = G.player;
  if (!P) return;
  const R = rt(G);
  if (R.dead || !(dt > 0)) return;
  dt = Math.min(dt, 0.05);
  G.prompt = null;

  R.invuln = Math.max(0, R.invuln - dt);
  R.hurtT += dt; R.landT += dt; R.throwT += dt; R.swingT += dt; R.eatT += dt;
  R.spearCD = Math.max(0, R.spearCD - dt);
  R.frozen = !!(G.raft && G.raft.busy);
  ctl.up = !R.frozen && input.up;
  ctl.down = !R.frozen && input.down;
  ctl.use = !R.frozen && input.use;
  R.jumpBuf = Math.max(0, R.jumpBuf - dt);
  if (R.frozen) R.jumpBuf = 0;
  else if (input.jumpPressed) R.jumpBuf = 0.13;

  // the raft has not reported its deck yet (first frame of a session): hold still
  const span = raftSpan(G);
  if (span && span.y == null && R.mode !== 'swim' && P.x >= span.x0 - 2 && P.x <= span.x1 + 2 && P.y <= 1) {
    R.lastX = P.x; R.lastY = P.y;
    publish(G, P, R);
    return;
  }

  // teleports (debug, loading, the raft sailing around an island): re-read the situation
  if (R.fresh || Math.abs(P.x - R.lastX) > 40 || Math.abs(P.y - R.lastY) > 40) classify(G, P, R);
  R.fresh = false;

  if (input.toolPressed && !R.frozen) selectTool(G, P, R, input.toolPressed);
  if (P.tool === 'spear' && !(has(G, 'spear') > 0)) P.tool = 'hand';

  // ---- movement
  const dir = R.frozen ? 0 : (input.right ? 1 : 0) - (input.left ? 1 : 0);
  const busy = R.charging || (G.hook && G.hook.state === 'reeling' && !G.hook.fast) || (R.spear && R.mode !== 'swim');
  const mul = (busy ? 0.55 : 1) * (tired(P) ? 0.82 : 1);
  if (dir && R.mode !== 'climb' && !R.charging && !(R.spear && R.spear.t < R.spear.dur)) P.facing = dir;
  else if (!dir && G.hook && !G.hook.fast && G.hook.state !== 'flying' && Math.abs(G.hook.x - P.x) > 6) P.facing = G.hook.x > P.x ? 1 : -1;

  if (R.mode === 'ground') stepGround(G, P, R, dt, dir, mul);
  else if (R.mode === 'air') stepAir(G, P, R, dt, dir, mul);
  else if (R.mode === 'swim') stepSwim(G, P, R, dt, dir, mul);
  else if (R.mode === 'climb') stepClimb(G, P, R, dt);
  if (!Number.isFinite(P.x) || !Number.isFinite(P.y)) { P.x = R.lastX; P.y = R.lastY; P.vx = P.vy = 0; }
  unstick(G, P, R, dt);

  // ---- head, depth, oxygen
  const wy = waterY(G, P.x);
  R.depth = Math.max(0, P.y - wy);
  const head = headPos(P, R);
  const wasUnder = R.headUnder;
  R.headUnder = R.mode !== 'climb' && head[1] + 1.5 > waterY(G, head[0]);
  if (R.headUnder && !wasUnder && R.mode === 'swim') R.bubbleT = Math.min(R.bubbleT, 0.25);
  if (R.headUnder) R.underT += dt;
  else {
    if (wasUnder && R.underT > 0.35) play('surface', { volume: clamp(R.underT / 4, 0.4, 1) });
    R.underT = 0;
  }
  breathe(G, P, R, dt);
  survive(G, P, R, dt);

  // ---- tools, items, interaction
  if (R.mode !== 'climb') {
    const act = !R.frozen;
    if (act) hookInput(G, P, R, dt); else R.charging = false;
    spearAndHammer(G, P, R, dt, act);
    if (act) eatDrink(G, P, R);
  } else R.charging = false;
  updateHook(G, P, R, dt);
  if (!R.frozen) pickInteractable(G, P, R);

  // ---- light, little effects, warnings
  lights(G, P, R);
  effects(G, P, R, dt);
  farFromRaft(G, P, R);

  R.lastX = P.x; R.lastY = P.y;
  publish(G, P, R);
  if (P.hp <= 0) die(G, R.headUnder && P.oxygen <= 0 ? 'drown' : (R.starve || 'default'));
}

// starving, parched or badly hurt: he slows down and slumps
const tired = (P) => P.hunger < 12 || P.thirst < 12 || P.hp < 25;

function publish(G, P, R) {
  P.state = R.dead ? 'dead' : R.mode;
  P.onRaft = R.mode === 'ground' && R.gk === 'raft';
  P.onIsland = R.mode === 'ground' && R.gk === 'island';
  P.inWater = R.mode === 'swim';
  P.underwater = !!R.headUnder;
  P.depth = R.depth;
  P.invuln = R.invuln;
  P.dead = R.dead;
  P.charge = R.charging ? R.charge : 0;
  P.lantern = R.lantern;
}

function headPos(P, R) {
  if (R.mode === 'swim') {
    return [P.x + P.facing * HEAD_UP * Math.sin(R.rot), P.y - PELVIS - HEAD_UP * Math.cos(R.rot)];
  }
  return [P.x + P.facing * 0.8, P.y - PELVIS - HEAD_UP];
}

// Body extent above / below the pelvis for a body rotated by `rot` (0 upright, π/2 prone).
function extents(rot) {
  const c = Math.cos(rot), s = Math.abs(Math.sin(rot));
  return { up: Math.max(19 * c, -9.5 * c) + 3.5 * s, down: Math.max(9.5 * c, -19 * c) + 3.5 * s };
}

// Never end a step inside island terrain (a solid column from its surface down) — also when
// a beached raft's deck lies above that sand and is the highest surface there.
function unstick(G, P, R, dt) {
  if (R.mode === 'climb') return;
  const iy = isleY(G, P.x);
  if (iy == null || P.y - PELVIS * 0.6 <= iy) return;
  const d = deck(G, P.x);
  if (d != null && d < iy) {
    // under the logs: rest on the sand, and if the body doesn't fit there, back out to open water
    const span = raftSpan(G);
    const ex = extents(R.mode === 'swim' ? R.rot : 0);
    const lim = R.mode === 'swim' ? iy + PELVIS - ex.down : iy;
    if (P.y <= lim + 0.5) return;
    P.y = lim;
    if (P.vy > 0) P.vy = 0;
    const c = raftCeil(G, span, P.x, ex);
    if (span && c != null && c > lim) escapeRaft(G, P, span, dt);
    return;
  }
  P.y = iy;
  if (P.vy > 0) P.vy = 0;
  if (iy - waterY(G, P.x) < WADE_MAX) { R.mode = 'ground'; R.gk = 'island'; R.under = false; R.rot = 0; R.airCarry = 0; }
}

function classify(G, P, R) {
  R.climb = null;
  R.airCarry = 0;
  const wy = waterY(G, P.x);
  const g = ground(G, P.x, P.y - STEP_UP);
  if (g && g.y - P.y < 12 && g.y - wy < WADE_MAX) {
    P.y = g.y; P.vy = 0; R.mode = 'ground'; R.gk = g.kind;
  } else if (P.y - wy > 4) {
    R.mode = 'swim';
    R.under = P.y - wy > 24;
    R.rot = R.under ? 0.25 : 0;
  } else {
    R.mode = 'air';
  }
}

// ------------------------------------------------------------------ on the ground
function stepGround(G, P, R, dt, dir, mul) {
  const span = raftSpan(G);
  const carry = R.gk === 'raft' && span ? span.vx : 0;
  const wade = clamp((P.y - waterY(G, P.x)) / WADE_MAX, 0, 1);
  const vmax = WALK * mul * (1 - 0.5 * wade);
  const accel = dir && (P.vx === 0 || Math.sign(P.vx) === dir) ? ACC_GROUND : FRICTION;
  P.vx = approach(P.vx, dir * vmax, accel * dt);

  const dx = P.vx * dt;
  let nx = P.x + dx + carry * dt;
  // island terrain is a solid column: rising more than a step is a wall (or a ledge to jump)
  const top = topAt(G, nx);
  if (top && top.kind === 'island' && top.y < P.y - (2 + Math.abs(dx) * 2.4)) {
    nx = P.x + carry * dt; P.vx = 0;
  }
  // a raft deck is a step up; from island sand onto a beached raft it may be a taller one,
  // because a wave can lift the deck end well above the beach
  const reach = R.gk === 'island' ? STEP_RAFT : STEP_UP;
  let g = ground(G, nx, P.y - reach);
  // too steep: a wall or a high ledge (the raft deck can be stepped onto from a beach)
  if (g && g.y < P.y - (g.kind === 'raft' ? reach : 2 + Math.abs(dx) * 2.4)) {
    nx = P.x + carry * dt; P.vx = 0;
    g = ground(G, nx, P.y - reach);
  }
  P.x = nx;
  if (g && g.y <= P.y + 5 + Math.abs(dx) * 2.5) {
    P.y = g.y; P.vy = 0; R.gk = g.kind;
  } else {
    R.mode = 'air'; R.coyote = 0.1; P.vy = 0;    // walked off an edge
    R.airCarry = carry;                          // still moving with the raft he stepped off
    return;
  }
  const depth = P.y - waterY(G, P.x);
  if (depth > WADE_MAX) { R.mode = 'swim'; R.under = false; R.rot = 0; R.airCarry = 0; return; }

  if (R.jumpBuf > 0) {
    R.jumpBuf = 0;
    P.vy = -JUMP_V * (wade > 0.4 ? 0.75 : 1);
    R.mode = 'air'; R.coyote = 0;
    R.airCarry = carry;                          // a jump on a drifting raft keeps its speed
    play('jump');
    if (depth > 2) splash(G, P.x, 0.35, false);
    return;
  }

  // walk cycle, footsteps, wading splashes
  const sp = Math.abs(P.vx);
  if (sp > 3) {
    const prev = R.walkPh;
    R.walkPh += P.vx * P.facing * dt / 3.1;
    if (Math.floor(prev / Math.PI) !== Math.floor(R.walkPh / Math.PI) && sp > 22) {
      if (depth > 1.5) {
        play('swim', { volume: 0.35 });
        splash(G, P.x + P.facing * 2, 0.22, false);
      } else play('step', { surface: R.gk, volume: 0.5 + 0.5 * (sp / WALK) });
    }
  }
}

// ------------------------------------------------------------------ in the air
function stepAir(G, P, R, dt, dir, mul) {
  R.coyote -= dt;
  if (R.jumpBuf > 0 && R.coyote > 0) {
    R.jumpBuf = 0; R.coyote = 0; P.vy = -JUMP_V; play('jump');
  }
  P.vx = approach(P.vx, dir * WALK * mul, ACC_AIR * dt);
  P.vy += C.GRAVITY * dt;
  if (P.vy < 0 && !ctl.up) P.vy += C.GRAVITY * 1.3 * dt;   // let go early = shorter hop
  if (P.vy > 560) P.vy = 560;
  // the speed of the raft he jumped (or stepped) off stays with him through the air
  const carry = Number.isFinite(R.airCarry) ? R.airCarry : 0;
  let nx = P.x + (P.vx + carry) * dt;
  const ny = P.y + P.vy * dt;
  // island cliffs are walls
  const t1 = topAt(G, nx);
  if (t1 && t1.kind === 'island' && t1.y < Math.min(P.y, ny) - 3) { nx = P.x; P.vx = 0; R.airCarry = 0; }
  // landing
  if (P.vy >= 0) {
    const g = ground(G, nx, P.y);
    if (g && ny >= g.y && g.y - waterY(G, nx) < WADE_MAX) {
      P.x = nx; P.y = g.y; R.gk = g.kind; R.mode = 'ground'; R.airCarry = 0;
      R.landPow = clamp(P.vy / 420, 0, 1); R.landT = 0;
      if (P.vy > 120) play('step', { surface: g.kind, volume: 0.55 + 0.45 * R.landPow });
      P.vy = 0;
      return;
    }
  }
  P.x = nx; P.y = ny;
  if (P.y - waterY(G, P.x) > 2) enterWater(G, P, R);
}

function enterWater(G, P, R) {
  const v = Math.abs(P.vy);
  P.vx += Number.isFinite(R.airCarry) ? R.airCarry : 0;   // the raft's speed becomes his own
  R.airCarry = 0;
  R.mode = 'swim';
  R.under = !!ctl.down;
  R.rot = R.under ? 0.5 : 0;
  splash(G, P.x, clamp(v / 300, 0.3, 1.3), true);
  play('splash', { volume: clamp(v / 320, 0.35, 1) });
  if (R.under) play('dive');
  P.vy *= 0.42; P.vx *= 0.6;
}

// ------------------------------------------------------------------ in the water
function stepSwim(G, P, R, dt, dir, mul) {
  const flip = has(G, 'flippers') > 0 ? FLIPPERS : 1;
  const span = raftSpan(G);
  const wy = waterY(G, P.x);
  const sp0 = Math.hypot(P.vx, P.vy);

  if (!R.under) {
    // ---- treading water: buoyancy keeps the head above the surface
    const moving = dir !== 0 && !R.charging;
    R.rot += ((moving ? 0.95 : 0) - R.rot) * Math.min(1, dt * 5);
    P.vx = approach(P.vx, dir * SWIM_SURF * flip * mul, 150 * dt);
    const target = wy + 6.3 + HEAD_UP * Math.cos(R.rot);
    P.vy += ((target - P.y) * 60 - P.vy * 10) * dt;
    let nx = P.x + P.vx * dt;
    // the raft is a wall at the surface; climb it with Space / E
    if (span && span.y != null) {
      const a = span.x0 - 4, b = span.x1 + 4, mid = (span.x0 + span.x1) / 2;
      if (nx > a && nx < b) {
        if (P.x < mid) nx = a; else nx = b;
        if (Math.sign(P.vx) === (P.x < mid ? 1 : -1)) P.vx = 0;
      }
    }
    nx = swimWall(G, P, nx);
    P.x = nx;
    P.y += P.vy * dt;
    // dive
    if (ctl.down && R.jumpBuf <= 0) {
      R.under = true;
      P.vy = Math.max(P.vy, 55);
      play('dive');
      bubbleBurst(G, P.x + P.facing * 2, wy + 4, 5);
      splash(G, P.x, 0.3, false);
    }
  } else {
    // ---- free swimming under water, eight directions
    const iy = (ctl.down ? 1 : 0) - (ctl.up ? 1 : 0);
    const len = Math.hypot(dir, iy) || 1;
    const sp = SWIM_DEEP * flip * mul;
    P.vx = approach(P.vx, (dir / len) * sp, (dir ? 230 : 110) * dt);
    P.vy = approach(P.vy, iy ? (iy / len) * sp : -SWIM_IDLE_RISE, (iy ? 230 : 70) * dt);   // idle: drift up very slowly
    const spd = Math.hypot(P.vx, P.vy);
    const surge = spd > 15 ? 0.84 + 0.32 * Math.max(0, Math.sin(R.swimPh * TAU)) : 1;
    let nx = P.x + P.vx * dt * surge;
    let tRot = spd > 14 ? Math.atan2(Math.abs(P.vx), -P.vy) : 0.25;
    // in a low gap under the raft he stays stretched out instead of turning upright or head-down
    if (raftRoom(G, span, P.x, extents(tRot)) < 0) tRot = Math.PI / 2;
    R.rot += (tRot - R.rot) * Math.min(1, dt * 5);
    nx = swimWall(G, P, nx);
    // the gap between the raft's logs and a beach slope narrows: no squeezing in where he doesn't fit
    if (span && span.y != null && nx !== P.x) {
      const exm = extents(R.rot);
      const r1 = raftRoom(G, span, nx, exm);
      if (r1 < 0 && r1 < raftRoom(G, span, P.x, exm) - 0.01) { nx = P.x; P.vx *= 0.2; }
    }
    P.x = nx;
    P.y += P.vy * dt * surge;
  }

  // ---- the floor (seabed, island slopes) and the raft's underside
  const ex = extents(R.rot);
  const fl = floorAt(G, P.x, P.y - PELVIS);
  const flim = fl ? fl.y + PELVIS - ex.down : Infinity;
  if (P.y > flim) { P.y = flim; if (P.vy > 0) P.vy = 0; }
  let underRaft = false;
  const rlim = raftCeil(G, span, P.x, ex);
  if (rlim != null && P.y < rlim) {
    underRaft = true; R.under = true;
    if (rlim <= flim) { P.y = rlim; if (P.vy < 0) P.vy = 0; }
    else escapeRaft(G, P, span, dt);   // no room between the logs and the sand: never into the sand, back out
  }

  // ---- surfacing
  if (R.under && !underRaft) {
    const hy = P.y - PELVIS - HEAD_UP * Math.cos(R.rot);
    const hx = P.x + P.facing * HEAD_UP * Math.sin(R.rot);
    const hw = waterY(G, hx);
    if (hy < hw + 1 && !ctl.down) {
      R.under = false;
      P.vy *= 0.3;
      splash(G, hx, 0.35, false);
    } else if (P.y < wy + 8) { P.y = wy + 8; if (P.vy < 0) P.vy *= 0.5; }
  }

  // ---- strokes
  const spd = Math.hypot(P.vx, P.vy);
  const prevPh = R.swimPh;
  R.swimPh += dt * (0.42 + Math.min(1.4, spd / 60) * (R.under ? 0.95 : 1.15));
  if (Math.floor(prevPh) !== Math.floor(R.swimPh)) {
    R.swimPh -= Math.floor(R.swimPh);
    if (spd > 15 || sp0 > 15) {
      play('swim', { volume: R.under ? 0.4 : 0.65 });
      if (R.under) bubbleBurst(G, P.x + P.facing * 4 * Math.sin(R.rot), P.y - PELVIS - 6 * Math.cos(R.rot), 2);
      else splash(G, P.x + P.facing * 6, 0.18, false);
    }
  }

  // ---- out of the water: onto an island beach, or climbing onto the raft
  if (!R.under) {
    const g = ground(G, P.x, P.y - STEP_UP);
    if (g && g.kind === 'island' && P.y >= g.y - 1.5 && g.y - waterY(G, P.x) < WADE_MAX - 1) {
      R.mode = 'ground'; R.gk = 'island'; P.y = g.y; P.vy = 0; R.rot = 0;
      return;
    }
  }
  const edge = raftEdge(G, P, R);
  if (edge) {
    addInteract(G, edge.ex + edge.side * 2, edge.y - 2, 34, '爬上木筏', (g) => startClimb(g), 4);
    const it = G.interactables[G.interactables.length - 1];
    if (it) it.who = 'player-climb';
    if (R.jumpBuf > 0) { R.jumpBuf = 0; startClimb(G); return; }
  } else if (!R.under && R.jumpBuf > 0) {
    // a little hop up onto a rock or beach ledge right in front
    const ahead = topAt(G, P.x + P.facing * 9);
    if (ahead && ahead.kind === 'island' && ahead.y < wy + 2 && ahead.y > wy - 18) {
      R.jumpBuf = 0;
      R.mode = 'air'; R.coyote = 0; R.airCarry = 0;
      P.vy = -270; P.vx = P.facing * 55;
      play('jump'); splash(G, P.x, 0.35, false);
    }
  }
}

// Horizontal movement in water stops against steep terrain (island cliffs, seabed walls) —
// also under the raft, where the deck would otherwise hide the slope beneath it.
function swimWall(G, P, nx) {
  if (Math.abs(nx - P.x) < 1e-4) return nx;
  const t0 = floorAt(G, P.x), t1 = floorAt(G, nx);
  if (t1 && t1.y < P.y - 3 && (!t0 || t1.y < t0.y - 4)) { P.vx *= 0.2; return P.x; }
  return nx;
}

// The highest the swimming body's reference point (P.y) may be at x under the raft's logs,
// or null when x is not under the raft.
function raftCeil(G, span, x, ex) {
  if (!span || span.y == null || !(x > span.x0 + 1 && x < span.x1 - 1)) return null;
  const d = deck(G, x);
  return (d != null ? d : span.y) + RAFT_UNDER + PELVIS + ex.up;
}
// Spare room for a swimming body between the raft's underside and the floor at x
// (negative: he doesn't fit; Infinity: not under the raft).
function raftRoom(G, span, x, ex) {
  const c = raftCeil(G, span, x, ex);
  if (c == null) return Infinity;
  const fl = floorAt(G, x);
  return fl ? fl.y + PELVIS - ex.down - c : Infinity;
}
// Squeezed between the logs and the sand (a beached raft): drift back out toward open water,
// i.e. toward the raft end over the deeper floor.
function escapeRaft(G, P, span, dt) {
  const a = floorAt(G, span.x0 - 8), b = floorAt(G, span.x1 + 8);
  const side = (a ? a.y : 1e4) >= (b ? b.y : 1e4) ? -1 : 1;
  P.x += side * 45 * dt;
  if (P.vx * side < 0) P.vx = 0;
}

function raftEdge(G, P, R) {
  const span = raftSpan(G);
  if (!span || span.y == null || R.mode !== 'swim') return null;
  if (P.x < span.x0 - 18 || P.x > span.x1 + 18) return null;
  // only from beside either end, never up through the logs from underneath
  if (P.x > span.x0 + CLIMB_SLACK && P.x < span.x1 - CLIMB_SLACK) return null;
  const hy = P.y - PELVIS - HEAD_UP * Math.cos(R.rot);
  if (hy - waterY(G, P.x) > 16) return null;
  const side = P.x < (span.x0 + span.x1) / 2 ? -1 : 1;
  return { side, ex: side < 0 ? span.x0 : span.x1, y: span.y };
}

function startClimb(G) {
  const P = G.player, R = rt(G);
  if (R.mode !== 'swim' || R.dead || R.frozen) return;
  const span = raftSpan(G);
  if (!span || span.y == null || !raftEdge(G, P, R)) return;   // the prompt may be a step old
  const side = P.x < (span.x0 + span.x1) / 2 ? -1 : 1;
  const edge = side < 0 ? span.x0 : span.x1;
  // stored relative to the raft edge and the water, so the drifting raft carries the climb
  R.climb = { t: 0, side, dx0: clamp(P.x - edge, -6, 6) + side * 3, d0: clamp(P.y - waterY(G, P.x), 8, 24) };
  R.mode = 'climb'; R.under = false; R.rot = 0;
  R.charging = false;
  P.facing = -side; P.vx = 0; P.vy = 0;
  play('swim', { volume: 0.7 });
  splash(G, P.x, 0.4, false);
}

function stepClimb(G, P, R, dt) {
  const span = raftSpan(G);
  const c = R.climb;
  if (!c || !span || span.y == null) { R.climb = null; R.mode = 'swim'; return; }
  c.t += dt / 0.62;
  const k = Math.min(1, c.t);
  const edge = c.side < 0 ? span.x0 : span.x1;
  const sx = edge + c.dx0, ix = edge - c.side * 7;
  const kx = smoothstep(0.42, 1, k), ky = easeInOut(clamp(k * 1.2, 0, 1));
  const top = deck(G, ix);
  const deckY = top != null ? top : span.y;
  P.x = lerp(sx, ix, kx);
  P.y = lerp(waterY(G, sx) + c.d0, deckY, ky);
  if (c.t >= 1) {
    R.climb = null; R.mode = 'ground'; R.gk = 'raft';
    P.x = ix; P.y = deckY; P.vx = 0; P.vy = 0;
    R.wetT = 2.4; R.landT = 0; R.landPow = 0.25;
    play('step', { surface: 'raft', volume: 0.6 });
  }
}

// =====================================================================================
// oxygen, hunger, thirst, health, death
// =====================================================================================

function breathe(G, P, R, dt) {
  if (R.headUnder) {
    P.oxygen = Math.max(0, P.oxygen - O2_DRAIN * dt);
    if (P.oxygen <= 0) P.hp -= DROWN_DPS * dt;
    if (P.oxygen < 30 && !R.warn.o2) { R.warn.o2 = true; say(G, hint('快没气了！按住 W 或空格浮上去换气', '快没气了！按住「上」浮上去换气'), 'warn'); }
  } else {
    P.oxygen = Math.min(C.MAX_STAT, P.oxygen + O2_FILL * dt);
  }
  if (P.oxygen > 60) R.warn.o2 = false;
}

function survive(G, P, R, dt) {
  const thirstMul = G.light > 0.9 ? 1.25 : isNight(G) ? 0.75 : 1;
  P.hunger = clamp(P.hunger - HUNGER_RATE * dt, 0, C.MAX_STAT);
  P.thirst = clamp(P.thirst - THIRST_RATE * thirstMul * dt, 0, C.MAX_STAT);
  if (P.hunger <= 0 || P.thirst <= 0) {
    P.hp -= dt;
    R.starve = P.thirst <= 0 ? 'thirst' : 'hunger';
  } else {
    R.starve = '';
    if (P.hunger > 60 && P.thirst > 60 && P.oxygen > 0) P.hp += HP_REGEN * dt;
  }
  P.hp = clamp(P.hp, 0, C.MAX_STAT);

  if (P.hunger < 20 && !R.warn.hunger) {
    R.warn.hunger = true;
    say(G, FOODS.some((f) => has(G, f) > 0)
      ? hint('肚子饿得咕咕叫……按 F 吃点东西', '肚子饿得咕咕叫……点「吃」吃点东西')
      : '肚子饿得咕咕叫……去钩点漂流物，或者下水抓鱼', 'warn');
  }
  if (P.hunger > 35) R.warn.hunger = false;
  if (P.thirst < 20 && !R.warn.thirst) {
    R.warn.thirst = true;
    say(G, has(G, 'water') > 0 || has(G, 'coconut') > 0
      ? hint('嗓子干得冒烟……按 R 喝水', '嗓子干得冒烟……点「喝」喝水')
      : noWaterText(G, '嗓子干得冒烟……'), 'warn');
  }
  if (P.thirst > 35) R.warn.thirst = false;
}

function die(G, cause) {
  const P = G.player, R = rt(G);
  if (R.dead) return;
  R.dead = true; R.deadT = 0;
  R.cause = cause || 'default';
  R.deadWater = R.mode === 'swim' || R.mode === 'climb';
  R.deadRot = R.rot;
  R.charging = false; R.spear = null;
  P.hp = 0; P.vx = 0; P.vy = 0;
  G.prompt = null;
  G.deathCause = R.cause;
  publish(G, P, R);
  if (G.demo) return;
  G.mode = 'dead';
  journal(G, DEATH_LINES[R.cause] || DEATH_LINES.default);
}

// Damage from creatures, beasts, falls… (other modules call this).
export function hurtPlayer(G, dmg, fromX, kind) {
  const P = G && G.player;
  if (!P) return;
  const R = rt(G);
  if (G.demo || R.dead || G.mode === 'dead' || P.hp <= 0 || R.invuln > 0) return;
  dmg = Number(dmg) || 0;
  if (dmg <= 0) return;
  P.hp = clamp(P.hp - dmg, 0, C.MAX_STAT);
  R.invuln = 0.8; R.hurtT = 0;
  const d = Number.isFinite(fromX) && fromX !== P.x ? (P.x > fromX ? 1 : -1) : -P.facing;
  R.hurtDir = d;
  if (R.mode === 'swim') { P.vx = d * 110; P.vy -= 25; }
  else if (R.mode === 'climb') { /* hold on */ }
  else {
    // knocked off his feet; on a drifting raft he keeps its speed through the air
    const span = raftSpan(G);
    R.airCarry = R.mode === 'ground' && R.gk === 'raft' && span ? span.vx : R.mode === 'air' ? R.airCarry || 0 : 0;
    P.vx = d * 150; P.vy = -150; R.mode = 'air'; R.coyote = 0;
  }
  R.charging = false;
  G.shake = (G.shake || 0) + 0.35;
  play('hurt');
  if (P.hp <= 0) die(G, kind ? (DEATH_LINES[kind] ? kind : 'default') : 'default');
}

// =====================================================================================
// tools
// =====================================================================================

function selectTool(G, P, R, n) {
  let next = null;
  if (n === 1) next = 'hook';
  else if (n === 2) {
    if (has(G, 'spear') > 0) next = 'spear';
    else { say(G, hint('还没有鱼叉——按 Tab 打开背包制作', '还没有鱼叉——点「背包」制作')); return; }
  } else if (n === 3) {
    if (has(G, 'hammer') > 0) next = 'hammer';
    else { say(G, '锤子不见了……'); return; }
  }
  else if (n === 4) next = 'hand';
  if (!next || next === P.tool) return;
  P.tool = next;
  R.charging = false; R.charge = 0;
  R.spear = null;
}

function throwOrigin(G, P, R) {
  if (R.mode === 'swim') return { x: P.x + P.facing * 3, y: P.y - PELVIS - 11 };
  return { x: P.x + P.facing * 2.5, y: P.y - 21 };
}

// Launch velocity so that a full charge lands on the aim point (pointer), or a forward
// lob whose length grows with the charge (keyboard / touch).
function throwVel(G, P, R, ox, oy, charge) {
  const f = lerp(0.22, 1, clamp(charge, 0, 1));
  if (input.aimFromPointer && Number.isFinite(input.mouse.wx)) {
    const dx = input.mouse.wx - ox, dy = input.mouse.wy - oy;
    const face = Math.abs(dx) > 3 ? Math.sign(dx) : P.facing;
    const adx = clamp(Math.abs(dx), 28, ROPE_MAX + 20);
    const theta = clamp(Math.max(0.62, Math.atan2(-dy, adx) + 0.42), 0.3, 1.3);
    const c = Math.cos(theta), t = Math.tan(theta);
    const denom = 2 * c * c * (dy + adx * t);
    let v = denom > 1 ? Math.sqrt((HOOK_G * adx * adx) / denom) : 430;
    v = clamp(v * Math.sqrt(f), 80, 470);
    return { vx: face * v * c, vy: -v * Math.sin(theta), face };
  }
  const theta = 0.72;
  const range = lerp(60, 260, clamp(charge, 0, 1));
  const v = Math.sqrt((HOOK_G * range) / Math.sin(2 * theta));
  return { vx: P.facing * v * Math.cos(theta), vy: -v * Math.sin(theta), face: P.facing };
}

function hookInput(G, P, R, dt) {
  const canThrow = P.tool === 'hook' && !G.hook && !(R.mode === 'swim' && R.under);
  if (!canThrow) { R.charging = false; return; }
  if (input.usePressed) {
    if (!(has(G, 'hook') > 0)) {
      if (!R.warn.nohook) { R.warn.nohook = true; say(G, '钩索不见了……'); }
      return;
    }
    R.charging = true; R.charge = 0;
  }
  if (!R.charging) return;
  if (input.aimFromPointer && Math.abs(input.mouse.wx - P.x) > 4) P.facing = input.mouse.wx > P.x ? 1 : -1;
  if (ctl.use) {
    R.charge = Math.min(1, R.charge + dt / CHARGE_TIME);
  } else {
    // released: throw
    const o = throwOrigin(G, P, R);
    const v = throwVel(G, P, R, o.x, o.y, R.charge);
    P.facing = v.face;
    G.hook = {
      state: 'flying', x: o.x, y: o.y, vx: v.vx, vy: v.vy, t: 0, len: 0, caught: 0,
      a: Math.atan2(v.vy, v.vx), land: false, fast: false, seed: Math.random() * 10,
    };
    R.charging = false; R.charge = 0; R.throwT = 0;
    play('throw');
  }
}

function handWorld(P, R) { return [P.x + R.off.hand[0], P.y + R.off.hand[1]]; }

function updateHook(G, P, R, dt) {
  const h = G.hook;
  if (!h) return;
  if (!Number.isFinite(h.x) || !Number.isFinite(h.y)) { finishHook(G, false); return; }
  const [hx, hy] = handWorld(P, R);
  h.t += dt;
  // put away (tool switched, diving, climbing): the rope is pulled in fast
  if (P.tool !== 'hook' || R.mode === 'climb' || (R.mode === 'swim' && R.under)) { h.fast = true; h.state = 'reeling'; }
  let dx = h.x - hx, dy = h.y - hy, d = Math.hypot(dx, dy);
  if (d > ROPE_MAX + 140) { finishHook(G, true); return; }   // snapped back (teleport…)

  if (h.state === 'flying') {
    // integrate exactly like the aim solver (half-step gravity) so a full charge lands on target
    h.x += h.vx * dt;
    h.y += (h.vy + HOOK_G * dt * 0.5) * dt;
    h.vy += HOOK_G * dt;
    h.a = Math.atan2(h.vy, h.vx);
    dx = h.x - hx; dy = h.y - hy; d = Math.hypot(dx, dy);
    if (d > ROPE_MAX) {                             // the rope goes taut and swings it down
      const ux = dx / d, uy = dy / d;
      h.x = hx + ux * ROPE_MAX; h.y = hy + uy * ROPE_MAX;
      const out = h.vx * ux + h.vy * uy;
      if (out > 0) { h.vx -= out * ux; h.vy -= out * uy; }
      d = ROPE_MAX;
    }
    h.len = Math.max(h.len, d);
    const top = surfaceTop(G, h.x);
    if (h.y >= top.y && h.vy > 0) {
      h.y = top.y; h.state = 'floating'; h.land = top.land; h.t = 0;
      if (top.land) play('step', { volume: 0.35 });
      else { play('splash', { volume: 0.3 }); hookSplash(G, h.x, top.y); }
      h.vx = 0; h.vy = 0;
    }
  } else if (h.state === 'floating') {
    const top = surfaceTop(G, h.x);
    h.land = top.land;
    h.y = top.y;
    if (d > ROPE_MAX) {                             // dragged along by the drifting raft
      h.x = hx + (dx / d) * ROPE_MAX;
      d = ROPE_MAX;
    }
    h.len = Math.max(d, Math.min(h.len, d + 50));
    if (ctl.use && P.tool === 'hook' && !R.charging) h.state = 'reeling';
  } else if (h.state === 'reeling') {
    if (!h.fast && !ctl.use) h.state = 'floating';
    else {
      const step = (h.fast ? 430 : REEL_SPEED) * dt;
      const ax = hx - h.x;
      h.x += Math.sign(ax) * Math.min(Math.abs(ax), step);
      const top = surfaceTop(G, h.x);
      const near = smoothstep(30, 0, Math.abs(hx - h.x));
      const base = top.land ? top.y : Math.max(top.y, Math.min(hy, top.y + 2));
      h.y = lerp(base, hy, near);
      if (h.y > top.y + 2 && !top.land && near < 0.5) h.y = top.y;
      h.a = Math.atan2(hy - h.y, hx - h.x);
      d = Math.hypot(hx - h.x, hy - h.y);
      h.len = d;
      R.reelT -= dt;
      if (R.reelT <= 0) { R.reelT = 0.3; play('reel', h.fast ? { volume: 0.6 } : undefined); }
      if (d < 7) { finishHook(G, true); return; }
    }
  }
  // debris near the hook gets caught
  let n = 0;
  try { n = hookCatch(G, h.x, h.y, 20) || 0; } catch (e) { oops('hookCatch', e); }
  if (n > 0) { h.caught += n; play('hook'); }
}

function finishHook(G, collect) {
  const h = G.hook;
  let got = [];
  if (collect) {
    try { got = collectAttached(G) || []; } catch (e) { oops('collectAttached', e); }
    if ((Array.isArray(got) && got.length) || (h && h.caught > 0)) play('pickup');
  }
  G.hook = null;
}

function spearAndHammer(G, P, R, dt, act) {
  const under = R.mode === 'swim' && R.under;
  if (act && P.tool === 'spear' && input.usePressed && R.spearCD <= 0 && has(G, 'spear') > 0) {
    const sx = P.x + R.off.shoulder[0], sy = P.y + R.off.shoulder[1];
    let a;
    if (input.aimFromPointer && Number.isFinite(input.mouse.wx)) a = Math.atan2(input.mouse.wy - sy, input.mouse.wx - sx);
    else {
      const iy = R.mode === 'swim' ? (ctl.down ? 1 : 0) - (ctl.up ? 1 : 0) : 0;
      a = Math.atan2(iy * 0.8, P.facing);
    }
    P.facing = Math.cos(a) >= 0 ? 1 : -1;
    R.spear = { t: 0, dur: under ? 0.42 : 0.3, a, hit: false };
    R.spearCD = under ? SPEAR_CD_WATER : SPEAR_CD;
    play('spear');
    if (under) { P.vx += Math.cos(a) * 26; P.vy += Math.sin(a) * 26; }
    else if (R.mode === 'ground') P.vx += Math.cos(a) * 30;
  }
  const S = R.spear;
  if (S) {
    S.t += dt;
    if (!S.hit && S.t >= S.dur * 0.26) {
      S.hit = true;
      const sx = P.x + R.off.shoulder[0], sy = P.y + R.off.shoulder[1];
      const tx = sx + Math.cos(S.a) * SPEAR_REACH, ty = sy + Math.sin(S.a) * SPEAR_REACH;
      addHit(G, tx, ty, SPEAR_R, 25, 'spear', 'player');
      if (ty > waterY(G, tx)) bubbleBurst(G, tx, ty, 3);
    }
    if (S.t >= S.dur) R.spear = null;
  }
  if (act && P.tool === 'hammer' && input.usePressed && R.swingT > 0.3) R.swingT = 0;
}

// No bottled water (or coconut) left: point at the purifier if there is one, else suggest
// building one. `lead` opens the sentence ('没有淡水了……').
function noWaterText(G, lead) {
  const tiles = G.raft && Array.isArray(G.raft.tiles) ? G.raft.tiles : [];
  let n = 0, water = 0;
  for (const t of tiles) {
    const s = t && t.s;
    if (s && s.type === 'purifier') { n++; water += Number(s.water) > 0 ? Number(s.water) : 0; }
  }
  if (water > 0) return lead + hint('净水器里接到了水，走过去按 E 喝', '净水器里接到了水，走过去点「互动」喝');
  if (n > 0) return lead + '净水器还在收集，白天晒一晒，下雨时会快很多';
  if (has(G, 'purifier') > 0) return lead + hint('背包里有净水器，按 3 拿锤子把它装到木筏上', '背包里有净水器，拿起锤子把它装到木筏上');
  return lead + hint('按 Tab 打开背包，造一个净水器吧', '点「背包」造一个净水器吧');
}

function eatDrink(G, P, R) {
  if (input.eatPressed) {
    if (R.headUnder) say(G, '在水下没法吃东西');
    else {
      const id = FOODS.find((f) => has(G, f) > 0);
      if (!id) say(G, '没有能吃的东西了……去钩点漂流物，或者下水抓鱼');
      else {
        let ok = false;
        try { ok = useItem(G, id); } catch (e) { oops('useItem', e); }
        if (ok !== false) R.eatT = 0;
      }
    }
  }
  if (input.drinkPressed) {
    if (R.headUnder) say(G, '在水下没法喝水');
    else {
      const id = has(G, 'water') > 0 ? 'water' : has(G, 'coconut') > 0 ? 'coconut' : null;
      if (!id) say(G, noWaterText(G, '没有淡水了……'));
      else {
        let ok = false;
        try { ok = useItem(G, id); } catch (e) { oops('useItem', e); }
        if (ok !== false) R.eatT = 0.05;
      }
    }
  }
}

// =====================================================================================
// interaction, lights, effects, warnings
// =====================================================================================

function pickInteractable(G, P, R) {
  const list = G.interactablesLast;
  if (!Array.isArray(list) || !list.length || R.mode === 'climb') return;
  const cx = P.x, cy = P.y - 12;
  let best = null, bestP = -Infinity, bestD = Infinity;
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    if (!it || !Number.isFinite(it.x) || !Number.isFinite(it.y)) continue;
    if (it.who === 'player-climb' && R.mode !== 'swim') continue;
    const d = Math.hypot(it.x - cx, it.y - cy);
    if (!(d <= (it.r || 0))) continue;
    const pr = it.priority || 0;
    if (pr > bestP || (pr === bestP && d < bestD)) { best = it; bestP = pr; bestD = d; }
  }
  if (!best) return;
  G.prompt = { x: best.x, y: best.y, label: best.label };
  if (input.interactPressed && typeof best.act === 'function') {
    try { best.act(G); } catch (e) { oops('interact:' + best.label, e); }
  }
}

function lanternWanted(G, R) {
  if (!(has(G, 'lantern') > 0)) return false;
  const W = G.weather || {};
  return isNight(G) || G.light < 0.3 || (R.mode === 'swim' && R.depth > 120) || (W.kind === 'storm' && G.light < 0.75);
}

function lights(G, P, R) {
  addLight(G, P.x, P.y - 13, 34, [255, 214, 170], 0.35);
  R.lightHalo = G.lights[G.lights.length - 1] || null;
  const on = lanternWanted(G, R);
  if (on && !R.lantern) play('lantern');
  R.lantern = on;
  R.lightLantern = null;
  if (on) {
    const fl = 0.9 + 0.08 * noise1(G.time * 9.3, 7) + 0.03 * Math.sin(G.time * 31.7);
    const a = clamp(fl, 0, 1) * (R.mode === 'swim' && R.depth > 60 ? 0.85 : 1);
    addLight(G, P.x + R.off.lantern[0], P.y + R.off.lantern[1], 170 * (0.97 + 0.03 * fl), [255, 196, 120], a);
    R.lightLantern = G.lights[G.lights.length - 1] || null;
  }
}

function effects(G, P, R, dt) {
  const night = isNight(G) || G.light < 0.3;
  // breath bubbles from the mouth
  if (R.headUnder) {
    R.bubbleT -= dt * (P.oxygen < 30 ? 2.4 : 1);
    if (R.bubbleT <= 0) {
      R.bubbleT = rand(0.7, 1.7);
      const head = headPos(P, R);
      const mx = head[0] + P.facing * 3.6 * Math.cos(R.rot * 0.6), my = head[1] + 1.5;
      bubbleBurst(G, mx, my, 1 + ((Math.random() * 3) | 0));
    }
  }
  // stirring the water at night lights up the plankton
  if (R.mode === 'swim' && night) {
    const sp = Math.hypot(P.vx, P.vy);
    R.glowT -= dt * (sp > 16 ? 1 : 0.25);
    if (R.glowT <= 0) {
      R.glowT = 0.1;
      const s = Math.sin(R.rot), c = Math.cos(R.rot);
      const back = Math.random() < 0.6;
      const x = P.x - P.facing * (back ? 8 * s : -6 * s) + rand(-2, 2);
      const y = P.y - PELVIS + (back ? 8 * c : -6 * c) + rand(-2, 2);
      if (y > waterY(G, x) + 1) {
        emit(G, { x, y, vx: -P.vx * 0.15 + rand(-4, 4), vy: -P.vy * 0.15 + rand(-4, 4), drag: 1.5,
          life: rand(0.9, 1.6), size: rand(1.1, 2.0), color: [110, 220, 255], alpha: 0.6, kind: 'glow', water: 'below' });
      }
    }
  }
  // dripping wet after climbing out
  if (R.wetT > 0) {
    R.wetT -= dt;
    if (Math.random() < dt * 16 * Math.min(1, R.wetT)) {
      emit(G, { x: P.x + rand(-3.5, 3.5), y: P.y - rand(3, 18), vy: rand(5, 25), gravity: 420,
        size: rand(0.6, 1.0), life: rand(0.35, 0.6), color: [205, 228, 236], alpha: 0.75 });
    }
  }
}

function farFromRaft(G, P, R) {
  const span = raftSpan(G);
  if (!span) return;
  const d = Math.abs(P.x - (span.x0 + span.x1) / 2);
  if (R.mode === 'swim' && d > 650 && !R.warn.far && !islandHere(G, P.x)) {
    R.warn.far = true;
    say(G, '木筏漂远了！快游回去', 'warn');
  } else if (d < 400) R.warn.far = false;
}

function splash(G, x, power, big) {
  const wy = waterY(G, x);
  const glow = isNight(G);
  const n = Math.round(clamp(power, 0.15, 1.4) * (big ? 18 : 10));
  for (let i = 0; i < n; i++) {
    emit(G, { x: x + rand(-4, 4), y: wy - 0.5, vx: rand(-55, 55) * power, vy: -rand(50, 165) * power,
      gravity: 520, life: rand(0.35, 0.75), size: rand(0.8, 1.9), color: glow ? [150, 225, 245] : [222, 238, 242], alpha: 0.85 });
  }
  if (big) {
    for (let i = 0; i < n * 0.6; i++) {
      emit(G, { x: x + rand(-5, 5), y: wy + rand(3, 14), vx: rand(-20, 20), vy: -rand(10, 40), kind: 'bubble',
        size: rand(0.7, 1.7), life: rand(0.6, 1.4), color: [210, 236, 250], alpha: 0.7, water: 'below' });
    }
    if (glow) {
      for (let i = 0; i < 5; i++) {
        emit(G, { x: x + rand(-8, 8), y: wy + rand(2, 10), vx: rand(-10, 10), vy: rand(-6, 6), drag: 1.2, kind: 'glow',
          size: rand(1.2, 2.2), life: rand(0.8, 1.5), color: [110, 220, 255], alpha: 0.6, water: 'below' });
      }
    }
  }
}

function hookSplash(G, x, y) {
  for (let i = 0; i < 7; i++) {
    emit(G, { x: x + rand(-1.5, 1.5), y: y - 0.5, vx: rand(-30, 30), vy: -rand(40, 95), gravity: 480,
      life: rand(0.3, 0.55), size: rand(0.6, 1.3), color: [222, 238, 242], alpha: 0.8 });
  }
}

function bubbleBurst(G, x, y, n) {
  for (let i = 0; i < n; i++) {
    emit(G, { x: x + rand(-1, 1), y: y + rand(-1, 1), vx: rand(-5, 5), vy: -rand(16, 36), kind: 'bubble',
      size: rand(0.6, 1.6), life: rand(1.8, 3.4), color: [205, 235, 250], alpha: 0.75, water: 'below' });
  }
}

// =====================================================================================
// drawing — skeleton and poses
// =====================================================================================
//
// Body space: origin at the pelvis, +x = the way he faces, +y = down. The whole body is
// rotated by pose.rot around the pelvis (0 upright, π/2 swimming prone, π head-down).
// Feet targets are relative to the pelvis, hand targets relative to each shoulder.

const KEYS = ['rot', 'px', 'py', 'lean', 'tilt', 'glance', 'fNx', 'fNy', 'fFx', 'fFy',
  'hNx', 'hNy', 'hFx', 'hFy', 'toolA', 'eye', 'mouth', 'toe', 'lant', 'bN'];
const FOOT_Y = 9.0;

function basePose() {
  return {
    rot: 0, px: 0, py: 0, lean: 0.04, tilt: 0, glance: 0,
    fNx: 0.9, fNy: FOOT_Y, fFx: -0.6, fFy: FOOT_Y,
    hNx: 0.6, hNy: 7.0, hFx: -0.4, hFy: 6.9,
    toolA: 0.3, eye: 1, mouth: 0, toe: 0, lant: 0, bN: 1, k: 12,
  };
}

function ik(ax, ay, tx, ty, l1, l2, bend) {
  let dx = tx - ax, dy = ty - ay;
  let d = Math.hypot(dx, dy);
  const max = (l1 + l2) * 0.999;
  if (d > max) { dx *= max / d; dy *= max / d; d = max; }
  if (d < 0.001) { d = 0.001; dx = 0; dy = 0.001; }
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const ux = dx / d, uy = dy / d;
  return { jx: ax + ux * a - bend * uy * h, jy: ay + uy * a + bend * ux * h, ex: ax + dx, ey: ay + dy };
}

function skeleton(p) {
  const cl = Math.cos(p.lean), sl = Math.sin(p.lean);
  const T = (x, y) => [x * cl - y * sl, x * sl + y * cl];
  const sk = { T };
  sk.neck = T(0.4, -8.6);
  sk.shN = T(0.7, -7.3);
  sk.shF = T(-0.6, -7.5);
  sk.hipN = [0.6, 0.3];
  sk.hipF = [-0.5, 0.2];
  sk.headA = p.lean + p.tilt;
  const hc = Math.cos(sk.headA), hs = Math.sin(sk.headA);
  sk.head = [sk.neck[0] + 0.8 * hc + 4.4 * hs, sk.neck[1] + 0.8 * hs - 4.4 * hc];
  sk.legN = ik(sk.hipN[0], sk.hipN[1], p.fNx, p.fNy, 4.7, 4.5, -1);
  sk.legF = ik(sk.hipF[0], sk.hipF[1], p.fFx, p.fFy, 4.7, 4.5, -1);
  sk.armN = ik(sk.shN[0], sk.shN[1], sk.shN[0] + p.hNx, sk.shN[1] + p.hNy, 3.9, 3.7, p.bN);
  sk.armF = ik(sk.shF[0], sk.shF[1], sk.shF[0] + p.hFx, sk.shF[1] + p.hFy, 3.9, 3.7, 1);
  sk.knot = T(-3.0, -8.1);
  sk.front = T(2.0, -7.4);
  return sk;
}

// world-space aim angle → body-space angle
function bodyAngle(a, face, rot) { return (face >= 0 ? a : Math.PI - a) - rot; }

function targetPose(G, P, R, t, demo, face) {
  const p = basePose();
  if (demo) { sitPose(p, t); return p; }
  if (R.dead) { deadPose(p, R, t); return p; }
  const cold = G.light < 0.3 && !R.lantern;
  if (R.mode === 'ground') groundPose(G, P, R, p, t, cold);
  else if (R.mode === 'air') airPose(P, p);
  else if (R.mode === 'climb') climbPose(R, p);
  else if (R.under) underPose(P, R, p, t);
  else surfacePose(P, R, p, t);
  if (R.mode !== 'climb') {
    toolPose(G, P, R, p, t, face);
    if (R.lantern) lanternPose(P, R, p, t);
    if (R.eatT < 0.8) {
      const w = Math.sin(clamp(R.eatT / 0.8, 0, 1) * Math.PI);
      p.hNx = lerp(p.hNx, 3.3, Math.min(1, w * 2)); p.hNy = lerp(p.hNy, -4.6 + Math.sin(t * 18) * 0.35, Math.min(1, w * 2));
      p.mouth = Math.abs(Math.sin(t * 16)) * 0.8 * w; p.tilt += 0.08 * w; p.k = Math.max(p.k, 14);
    }
  }
  if (R.hurtT < 0.42) {
    const w = 1 - R.hurtT / 0.42;
    p.lean -= 0.35 * w; p.tilt -= 0.3 * w; p.px -= 0.8 * w;
    p.hNx = lerp(p.hNx, 2.6, w); p.hNy = lerp(p.hNy, -3.4, w);
    p.hFx = lerp(p.hFx, 1.8, w); p.hFy = lerp(p.hFy, -4.6, w);
    p.mouth = Math.max(p.mouth, 0.7 * w);
    if (w > 0.35) p.eye = 0.1;
    p.k = 22;
  }
  if (R.blink > 0) p.eye = Math.min(p.eye, 0.1);
  return p;
}

function groundPose(G, P, R, p, t, cold) {
  const sp = Math.abs(P.vx);
  const wade = clamp((P.y - waterY(G, P.x)) / WADE_MAX, 0, 1);
  if (sp > 6) {
    const s = clamp(sp / WALK, 0, 1), ph = R.walkPh;
    const amp = lerp(1.5, 4.2, s), lift = lerp(1.0, 3.0, s);
    p.py = 0.25 * s - Math.abs(Math.cos(ph)) * 0.7 * s;
    p.fNx = 0.5 + Math.sin(ph) * amp; p.fNy = FOOT_Y - Math.max(0, Math.cos(ph)) * lift - p.py;
    p.fFx = 0.5 - Math.sin(ph) * amp; p.fFy = FOOT_Y - Math.max(0, -Math.cos(ph)) * lift - p.py;
    p.lean = 0.06 + 0.17 * s;
    const arm = amp * 0.75;
    p.hNx = 0.7 - Math.sin(ph) * arm; p.hNy = 6.6 - 1.4 * s - Math.abs(Math.sin(ph)) * 0.6 * s;
    p.hFx = 0.7 + Math.sin(ph) * arm; p.hFy = 6.6 - 1.4 * s - Math.abs(Math.sin(ph)) * 0.6 * s;
    p.tilt = -0.05;
    p.k = 60;
  } else {
    const br = Math.sin(t * 2.0);
    p.lean = 0.03 + 0.015 * br;
    p.px = Math.sin(t * 0.45) * 0.25;
    p.py = 0.12 * br;
    p.fNx = 1.0 - p.px; p.fNy = FOOT_Y - p.py;
    p.fFx = -0.7 - p.px; p.fFy = FOOT_Y - p.py;
    // looking around: up at the sky, out to sea, sometimes back over the shoulder
    p.tilt = (noise1(t * 0.32, 3) - 0.56) * 0.6;
    p.glance = R.glanceOn;
    p.hNx = 0.7 + 0.25 * Math.sin(t * 0.8); p.hNy = 6.9 - 0.2 * br;
    p.hFx = -0.3 + 0.25 * Math.sin(t * 0.8 + 1); p.hFy = 6.8 - 0.2 * br;
    if (tired(P)) {                                 // slumped, head hanging
      p.lean += 0.12; p.tilt = 0.28 + (noise1(t * 0.2, 5) - 0.5) * 0.2; p.py += 0.5;
      p.fNy -= 0.5; p.fFy -= 0.5; p.glance = 0;
    }
    if (cold) {                                     // hugging himself in the cold dark
      p.hNx = 3.1; p.hNy = 1.7; p.hFx = 3.5; p.hFy = 0.7;
      p.px += Math.sin(t * 43) * 0.06;
      p.lean += 0.06; p.tilt += 0.08;
    }
    p.k = 9;
  }
  if (wade > 0.25) {                                // arms out for balance in the water
    p.hNx = lerp(p.hNx, 3.0, wade); p.hNy = lerp(p.hNy, 3.6 + Math.sin(t * 2.4) * 0.6, wade);
    p.hFx = lerp(p.hFx, -2.6, wade); p.hFy = lerp(p.hFy, 3.9 - Math.sin(t * 2.4) * 0.6, wade);
  }
  if (R.landT < 0.22) {                             // landing squash
    const w = (1 - R.landT / 0.22) * (0.4 + R.landPow);
    p.py += 2.0 * w; p.fNy -= 2.0 * w; p.fFy -= 2.0 * w; p.lean += 0.14 * w;
    p.k = Math.max(p.k, 30);
  }
}

function airPose(P, p) {
  const u = clamp(0.5 - P.vy / 500, 0, 1);         // 1 = rising fast, 0 = falling fast
  p.fNx = lerp(1.6, 2.7, u); p.fNy = lerp(8.8, 5.2, u);
  p.fFx = lerp(-1.8, -1.2, u); p.fFy = lerp(8.4, 7.8, u);
  p.hNx = lerp(3.3, 1.6, u); p.hNy = lerp(-1.2, -4.4, u);
  p.hFx = lerp(-3.0, -2.3, u); p.hFy = lerp(-0.4, -2.6, u);
  p.lean = 0.1; p.tilt = lerp(0.2, -0.12, u);
  p.k = 14;
}

function surfacePose(P, R, p, t) {
  p.rot = R.rot;
  if (Math.abs(P.vx) > 10 && R.rot > 0.4) {
    const th = R.swimPh * TAU;                     // doggy-paddle crawl, head up
    p.hNx = 1.6 + Math.sin(th) * 3.2; p.hNy = -Math.cos(th) * 6.2;
    p.hFx = 1.0 - Math.sin(th) * 3.2; p.hFy = Math.cos(th) * 6.2;
    p.fNx = 0.5 + Math.sin(t * 10) * 1.3; p.fNy = 9.2;
    p.fFx = 0.2 - Math.sin(t * 10) * 1.3; p.fFy = 9.2;
    p.tilt = -0.62; p.toe = 1; p.k = 20;
  } else {
    const w = t * 3.2;                             // treading water
    p.hNx = 2.4 + Math.sin(w) * 2.5; p.hNy = 3.0 + Math.cos(w) * 0.5;
    p.hFx = 1.6 - Math.sin(w) * 2.5; p.hFy = 3.2 - Math.cos(w) * 0.5;
    p.fNx = 0.6 + Math.cos(t * 4.4) * 1.7; p.fNy = 8.1 + Math.sin(t * 4.4) * 1.1;
    p.fFx = -0.2 - Math.cos(t * 4.4) * 1.7; p.fFy = 8.1 - Math.sin(t * 4.4) * 1.1;
    p.tilt = -0.12 + (noise1(t * 0.4, 9) - 0.5) * 0.35;
    p.glance = R.glanceOn;
    p.toe = 0.6; p.lean = 0.05; p.k = 10;
  }
}

function underPose(P, R, p, t) {
  p.rot = R.rot;
  const sp = Math.hypot(P.vx, P.vy);
  if (sp > 14) {
    const f = R.swimPh;                            // breaststroke + frog kick
    let ax, ay;
    if (f < 0.35) { const u = f / 0.35; ax = lerp(1.0, 2.4, u) + Math.sin(u * Math.PI) * 3.0; ay = lerp(-7.8, 1.4, easeInOut(u)); }
    else if (f < 0.55) { const u = (f - 0.35) / 0.2; ax = lerp(2.4, 2.4, u); ay = lerp(1.4, -2.2, u); }
    else { const u = (f - 0.55) / 0.45; ax = lerp(2.4, 1.0, u); ay = lerp(-2.2, -7.8, easeOut(u)); }
    p.hNx = ax; p.hNy = ay; p.hFx = ax - 0.9; p.hFy = ay + 0.4;
    let fx, fy;
    if (f < 0.4) { fx = 0.3; fy = 9.2; }
    else if (f < 0.65) { const u = (f - 0.4) / 0.25; fx = lerp(0.3, -1.6, u); fy = lerp(9.2, 5.2, u); }
    else { const u = easeOut((f - 0.65) / 0.35); fx = lerp(-1.6, 0.3, u); fy = lerp(5.2, 9.2, u); }
    p.fNx = fx + 0.4; p.fNy = fy; p.fFx = fx - 0.5; p.fFy = fy - 0.3;
    p.tilt = -0.32; p.toe = 1; p.k = 22;
  } else {
    const w = t * 1.7;                             // hovering, sculling slowly
    p.hNx = 2.0 + Math.sin(w) * 2.2; p.hNy = 2.4 + Math.cos(w) * 0.8;
    p.hFx = 1.4 - Math.sin(w) * 2.2; p.hFy = 2.6 - Math.cos(w) * 0.8;
    p.fNx = 0.6 + Math.sin(t * 1.9) * 1.5; p.fNy = 8.7 + Math.cos(t * 1.9) * 0.4;
    p.fFx = -0.3 - Math.sin(t * 1.9) * 1.5; p.fFy = 8.6;
    p.tilt = -0.15 + (noise1(t * 0.3, 4) - 0.5) * 0.5;
    p.glance = R.glanceOn;
    p.toe = 0.8; p.k = 8;
  }
}

function climbPose(R, p) {
  const u = R.climb ? clamp(R.climb.t, 0, 1) : 1;
  p.rot = Math.sin(u * Math.PI) * 0.35;
  if (u < 0.5) {
    p.hNx = 2.5; p.hNy = -8.0 + u * 2; p.hFx = 1.8; p.hFy = -7.7 + u * 2;
    p.fNx = 0.6; p.fNy = 8.8; p.fFx = -0.4; p.fFy = 9.0; p.tilt = -0.3;
  } else {
    const v = (u - 0.5) / 0.5;
    p.hNx = 2.7; p.hNy = lerp(-6.0, 5.4, v); p.hFx = 2.0; p.hFy = lerp(-5.6, 5.6, v);
    p.fNx = lerp(3.4, 0.9, v); p.fNy = lerp(4.2, FOOT_Y, v); p.fFx = -0.6; p.fFy = FOOT_Y;
    p.tilt = 0.1;
  }
  p.k = 16;
}

function sitPose(p, t) {
  const w = t * 1.3;
  p.lean = -0.16 + 0.015 * Math.sin(t * 2);
  p.fNx = 5.6 + Math.sin(w) * 0.8; p.fNy = 6.6 + Math.cos(w) * 0.3;
  p.fFx = 5.0 + Math.sin(w + 2.1) * 0.8; p.fFy = 6.9;
  p.hNx = -3.6; p.hNy = 6.6; p.hFx = -4.2; p.hFy = 6.8;
  p.tilt = -0.24 + (noise1(t * 0.25, 2) - 0.5) * 0.3;
  p.k = 6;
}

function deadPose(p, R, t) {
  const u = smoothstep(0, 1.1, R.deadT);
  if (R.deadWater) {
    p.rot = lerp(R.deadRot, -0.55, u);
    p.hNx = lerp(1.0, -1.2, u); p.hNy = lerp(3.0, -5.4, u) + Math.sin(t * 0.8) * 0.6;
    p.hFx = lerp(0.6, -0.2, u); p.hFy = lerp(3.0, -6.2, u) + Math.sin(t * 0.7 + 1) * 0.6;
    p.fNx = 1.6; p.fNy = 8.2; p.fFx = -0.2; p.fFy = 8.8; p.toe = 0.8;
    p.tilt = lerp(0, 0.5, u);
  } else {
    p.rot = -u * 1.42;
    p.py = u * 5.2 - Math.sin(u * Math.PI) * 1.5;
    p.fNx = lerp(0.9, 2.6, u); p.fNy = lerp(FOOT_Y, 8.0, u); p.fFx = lerp(-0.6, 1.0, u); p.fFy = lerp(FOOT_Y, 8.8, u);
    p.hNx = lerp(0.6, -2.4, u); p.hNy = lerp(7.0, 5.6, u); p.hFx = -3.0; p.hFy = 5.2;
    p.tilt = 0.25 * u;
  }
  p.eye = 1 - u;
  p.k = 10;
}

function toolPose(G, P, R, p, t, face) {
  const tool = P.tool;
  const underMoving = R.mode === 'swim' && R.under && Math.hypot(P.vx, P.vy) > 14;
  if (tool === 'hook') {
    const h = G.hook;
    if (R.charging) {
      // wind-up: elbow back, the hook swinging behind his head, the free hand aiming
      const c = R.charge;
      p.hNx = -5.0 - 0.6 * c; p.hNy = -3.6 - 0.9 * c + Math.sin(t * 9) * 0.15 * c;
      p.bN = -1;
      p.hFx = 4.6; p.hFy = -2.0;
      p.lean -= 0.06 + 0.12 * c; p.tilt -= 0.12;
      p.k = Math.max(p.k, 16);
    } else if (R.throwT < 0.4) {
      const u = R.throwT / 0.4;
      const e = easeOut(Math.min(1, u / 0.4));
      const w = 1 - smoothstep(0.45, 1, u);
      p.hNx = lerp(p.hNx, lerp(-5.4, 5.0, e), w); p.hNy = lerp(p.hNy, lerp(-4.4, -0.6, e), w);
      p.bN = lerp(-1, 1, Math.min(1, e * 1.6));
      p.lean += 0.2 * Math.sin(u * Math.PI);
      p.k = 40;
    } else if (h && h.state === 'reeling' && !h.fast) {
      const s = Math.sin(t * 13);
      p.hNx = 3.4; p.hNy = 1.4 + s * 1.7; p.hFx = 3.0; p.hFy = 1.2 - s * 1.7;
      p.lean -= 0.06; p.k = 30;
    } else if (h && !h.fast) {
      p.hNx = 3.2; p.hNy = 2.6;
      p.k = Math.max(p.k, 12);
    }
  } else if (tool === 'spear' && has(G, 'spear') > 0) {
    const S = R.spear;
    if (S) {
      const k = clamp(S.t / S.dur, 0, 1);
      const ext = k < 0.28 ? easeOut(k / 0.28) : 1 - smoothstep(0.28, 1, k);
      const a = bodyAngle(S.a, face, p.rot);
      const dx = Math.cos(a), dy = Math.sin(a);
      // hands along the shaft, relative to their shoulders (≈ same point)
      p.hNx = dx * (1.6 + 5.4 * ext) - dy * 0.5; p.hNy = dy * (1.6 + 5.4 * ext) + dx * 0.5 + 1.2;
      p.hFx = dx * (4.6 + 5.2 * ext) + 1.2; p.hFy = dy * (4.6 + 5.2 * ext) + 1.4;
      p.toolA = a;
      p.lean += 0.14 * ext * Math.max(0, dx);
      p.k = 45;
    } else if (underMoving) {
      p.hNx = 1.8; p.hNy = 1.6; p.toolA = -Math.PI / 2 + 0.12;
    } else if (R.mode === 'swim') {
      p.hNx = 2.6; p.hNy = 2.4; p.toolA = -0.55;
    } else {
      p.hNx = 2.0; p.hNy = 5.0 + (Math.abs(P.vx) > 6 ? Math.sin(R.walkPh * 2) * 0.4 : 0); p.toolA = -1.28;
    }
  } else if (tool === 'hammer') {
    if (R.swingT < 0.42) {
      const u = R.swingT / 0.42;
      if (u < 0.36) {
        const e = easeOut(u / 0.36);
        p.hNx = lerp(1.6, -0.6, e); p.hNy = lerp(6.0, -6.0, e); p.toolA = lerp(0.35, -2.7, e);
      } else {
        const e = Math.min(1, (u - 0.36) / 0.28);
        p.hNx = lerp(-0.6, 4.2, e); p.hNy = lerp(-6.0, 1.6, e); p.toolA = lerp(-2.7, 0.95, e);
      }
      p.lean += 0.12 * Math.sin(u * Math.PI);
      p.k = 45;
    } else if (!underMoving) {
      p.hNx = Math.max(p.hNx, 1.3); p.hNy = Math.min(p.hNy, 6.4); p.toolA = 0.35;
    } else p.toolA = -Math.PI / 2 + 0.2;
  }
}

function lanternPose(P, R, p, t) {
  const near = P.tool === 'hand';
  let x, y;
  if (R.mode === 'swim' && !R.under) { x = 2.0; y = -4.6; }        // held up out of the water
  else if (R.mode === 'swim') { x = 3.2; y = -1.6; }
  else if (R.mode === 'air') { x = 3.4; y = 1.0; }
  else { x = 5.4; y = 4.4 + (Math.abs(P.vx) > 6 ? Math.sin(R.walkPh * 2) * 0.4 : Math.sin(t * 1.3) * 0.15); }
  if (near) {
    if (R.mode === 'ground' && !(Math.abs(P.vx) > 6)) { x = 4.6; y = 3.8; }
    p.hNx = x; p.hNy = y;
  } else { p.hFx = x; p.hFy = y; }
  p.lant = 1;
}

function blendPose(R, tp, dt) {
  if (!R.pose) { R.pose = Object.assign({}, tp); return R.pose; }
  const k = 1 - Math.exp(-(tp.k || 12) * dt);
  const cur = R.pose;
  for (let i = 0; i < KEYS.length; i++) {
    const key = KEYS[i];
    const v = tp[key];
    cur[key] = Number.isFinite(cur[key]) ? cur[key] + (v - cur[key]) * k : v;
  }
  return cur;
}

// =====================================================================================
// drawing — the scarf (verlet ribbon in world space)
// =====================================================================================

function makeChain(n, seg, x, y) {
  const c = { n, seg, x: new Float32Array(n), y: new Float32Array(n), px: new Float32Array(n), py: new Float32Array(n) };
  for (let i = 0; i < n; i++) { c.x[i] = c.px[i] = x - i * seg * 0.3; c.y[i] = c.py[i] = y + i * seg * 0.9; }
  return c;
}

function simScarf(G, R, ax, ay, fx2, fy2, dt, t) {
  if (!R.scarf || !Number.isFinite(R.scarfAX) || Math.hypot(ax - R.scarfAX, ay - R.scarfAY) > 30) {
    // two long tails from the knot at the back, one short end hanging over the chest
    R.scarf = [makeChain(9, 1.7, ax, ay), makeChain(7, 1.6, ax, ay), makeChain(4, 1.45, fx2, fy2)];
  }
  R.scarfAX = ax; R.scarfAY = ay;
  if (dt <= 0) return;
  const W = G.weather || {};
  const wind = Number.isFinite(W.wind) ? W.wind : 0.3;
  const windV = Math.max(0.35, Math.abs(wind)) * (wind < 0 ? -1 : 1) * 62;   // air speed (units/s)
  const dt2 = dt * dt;
  for (let ci = 0; ci < R.scarf.length; ci++) {
    const ch = R.scarf[ci];
    const x0 = ci === 2 ? fx2 : ax, y0 = ci === 2 ? fy2 : ay;
    ch.x[0] = x0; ch.y[0] = y0; ch.px[0] = x0; ch.py[0] = y0;
    for (let i = 1; i < ch.n; i++) {
      const x = ch.x[i], y = ch.y[i];
      const vx = (x - ch.px[i]) / dt, vy = (y - ch.py[i]) / dt;
      let fx, fy;
      if (y > waterY(G, x) + 0.5) {                // floats and sways in the water
        fx = -vx * 4.5 + Math.sin(t * 1.3 + i * 0.7 + ci) * 10;
        fy = -vy * 4.5 - 24 + Math.cos(t * 1.1 + i * 0.9) * 7;
      } else {
        // drag towards the wind, gravity, and a travelling flutter across the cloth
        const gust = 0.8 + 0.3 * Math.sin(t * 2.3 + ci * 2) + 0.2 * Math.sin(t * 5.9 + i);
        const rvx = vx - windV * gust, rvy = vy;
        fx = -rvx * 2.7;
        fy = 160 - rvy * 2.7;
        let sx = x - ch.x[i - 1], sy = y - ch.y[i - 1];
        const sl = Math.hypot(sx, sy) || 1;
        sx /= sl; sy /= sl;
        const flap = Math.sin(t * 13 - i * 1.15 + ci * 1.7) * (14 + Math.min(130, Math.hypot(rvx, rvy)) * 1.5) * (i / ch.n);
        fx -= sy * flap; fy += sx * flap;
      }
      ch.px[i] = x; ch.py[i] = y;
      ch.x[i] = x + vx * dt * 0.995 + fx * dt2;
      ch.y[i] = y + vy * dt * 0.995 + fy * dt2;
    }
    // follow-the-leader: inextensible, most of the correction is not turned into speed
    for (let i = 1; i < ch.n; i++) {
      const dx = ch.x[i] - ch.x[i - 1], dy = ch.y[i] - ch.y[i - 1];
      const d = Math.hypot(dx, dy) || 1e-4;
      const nx = ch.x[i - 1] + (dx / d) * ch.seg, ny = ch.y[i - 1] + (dy / d) * ch.seg;
      ch.px[i] += (nx - ch.x[i]) * 0.9; ch.py[i] += (ny - ch.y[i]) * 0.9;
      ch.x[i] = nx; ch.y[i] = ny;
    }
  }
}

function drawRibbon(c, ch, w0, w1, col, hi, t, ph) {
  const n = ch.n;
  const L = [], Rr = [];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    let tx = ch.x[b] - ch.x[a], ty = ch.y[b] - ch.y[a];
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl; ty /= tl;
    const twist = 0.62 + 0.38 * Math.abs(Math.sin(t * 4.2 + i * 0.85 + ph));
    const w = lerp(w0, w1, i / (n - 1)) * (i === 0 ? 1 : twist);
    L.push([ch.x[i] - ty * w, ch.y[i] + tx * w]);
    Rr.push([ch.x[i] + ty * w, ch.y[i] - tx * w]);
  }
  c.fillStyle = col;
  c.beginPath();
  c.moveTo(L[0][0], L[0][1]);
  for (let i = 1; i < n; i++) c.lineTo(L[i][0], L[i][1]);
  for (let i = n - 1; i >= 0; i--) c.lineTo(Rr[i][0], Rr[i][1]);
  c.closePath();
  c.fill();
  // a lighter crease down the middle
  c.strokeStyle = hi; c.lineWidth = 0.45; c.globalAlpha = 0.55;
  c.beginPath(); c.moveTo(ch.x[0], ch.y[0]);
  for (let i = 1; i < n - 1; i++) c.lineTo(ch.x[i], ch.y[i]);
  c.stroke();
  c.globalAlpha = 1;
  // frayed fringe at the end
  const e = n - 1;
  const fx = ch.x[e] - ch.x[e - 1], fy = ch.y[e] - ch.y[e - 1];
  const fl = Math.hypot(fx, fy) || 1;
  c.strokeStyle = col; c.lineWidth = 0.35;
  c.beginPath();
  for (let k = -1; k <= 1; k++) {
    const ox = L[e][0] + (Rr[e][0] - L[e][0]) * (0.5 + k * 0.4), oy = L[e][1] + (Rr[e][1] - L[e][1]) * (0.5 + k * 0.4);
    c.moveTo(ox, oy);
    c.lineTo(ox + (fx / fl) * 1.3, oy + (fy / fl) * 1.3);
  }
  c.stroke();
}

// =====================================================================================
// drawing — body parts (body space)
// =====================================================================================

function line(c, ax, ay, bx, by) { c.beginPath(); c.moveTo(ax, ay); c.lineTo(bx, by); c.stroke(); }

function smoothClosed(c, pts, sy = 1) {
  const n = pts.length;
  c.beginPath();
  c.moveTo((pts[n - 1][0] + pts[0][0]) / 2, ((pts[n - 1][1] + pts[0][1]) / 2) * sy);
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    c.quadraticCurveTo(a[0], a[1] * sy, (a[0] + b[0]) / 2, ((a[1] + b[1]) / 2) * sy);
  }
  c.closePath();
}

function drawLeg(c, hip, L, p, far) {
  const skin = far ? COL.skinFar : COL.skin;
  c.strokeStyle = skin;
  c.lineWidth = 1.9; line(c, L.jx, L.jy, L.ex, L.ey);          // shin
  c.lineWidth = 2.3; line(c, hip[0], hip[1], L.jx, L.jy);       // knee and thigh
  // shorts over the upper thigh
  c.strokeStyle = far ? COL.shortsFar : COL.shorts;
  c.lineWidth = 3.5;
  line(c, hip[0], hip[1], lerp(hip[0], L.jx, 0.6), lerp(hip[1], L.jy, 0.6));
  // bare foot
  const a = Math.atan2(L.ey - L.jy, L.ex - L.jx);
  const fa = a - lerp(Math.PI / 2, 0.12, p.toe);
  c.fillStyle = skin;
  c.beginPath();
  c.ellipse(L.ex + Math.cos(fa) * 0.9, L.ey + Math.sin(fa) * 0.9, 1.6, 0.8, fa, 0, TAU);
  c.fill();
}

function drawArm(c, sh, A, far) {
  const ex = A.jx, ey = A.jy;
  c.strokeStyle = far ? COL.sweaterFar : COL.sweater;
  c.lineWidth = 2.7; line(c, sh[0], sh[1], ex, ey);             // sleeve
  const cx = lerp(ex, A.ex, 0.36), cy = lerp(ey, A.ey, 0.36);
  c.strokeStyle = far ? COL.skinFar : COL.skin;
  c.lineWidth = 1.55; line(c, cx, cy, A.ex, A.ey);              // bare forearm
  c.strokeStyle = far ? COL.cuffFar : COL.cuff;
  c.lineWidth = 3.0; line(c, ex, ey, cx, cy);                   // rolled-up cuff
  c.fillStyle = far ? COL.skinFar : COL.skin;
  c.beginPath(); c.arc(A.ex, A.ey, 1.0, 0, TAU); c.fill();
}

const SWEATER = [[-1.9, -8.6], [-3.3, -7.9], [-4.2, -6.1], [-4.3, -3.2], [-4.8, -0.3], [-4.9, 1.9],
  [-2.0, 2.35], [1.5, 2.45], [4.4, 2.0], [4.45, -0.5], [3.95, -3.4], [3.55, -6.0], [2.5, -7.9], [1.1, -8.7]];

function drawSweater(c, p, br) {
  c.save();
  c.rotate(p.lean);
  const sy = 1 + 0.018 * br;
  c.fillStyle = COL.sweater;
  smoothClosed(c, SWEATER, sy);
  c.fill();
  c.save();
  c.clip();
  // folds in the back, a faded knit stripe across the chest, a ribbed hem
  c.fillStyle = COL.sweaterDark;
  c.globalAlpha = 0.55;
  c.beginPath(); c.ellipse(-4.4, -2.6 * sy, 1.9, 4.6, 0.1, 0, TAU); c.fill();
  c.globalAlpha = 0.5;
  c.fillStyle = COL.sweaterLight;
  c.fillRect(-6, -5.0 * sy, 12, 0.9);
  c.globalAlpha = 0.3;
  c.fillRect(-6, -3.4 * sy, 12, 0.45);
  c.globalAlpha = 1;
  c.fillStyle = COL.sweaterDark;
  c.fillRect(-6, 0.8, 12, 2.2);
  c.strokeStyle = COL.sweaterLight;
  c.globalAlpha = 0.45; c.lineWidth = 0.3;
  c.beginPath();
  for (let x = -4.6; x < 4.6; x += 1.15) { c.moveTo(x, 1.0); c.lineTo(x + 0.15, 2.4); }
  c.stroke();
  c.restore();
  c.restore();
}

// hair: alternating [tip, valley-control] points from the fringe over the crown to the nape
const HAIR_TIPS = [
  [4.6, -0.9], [5.0, -2.6], [6.1, -3.5], [4.3, -4.6], [4.6, -6.7], [2.6, -5.7], [1.9, -8.0], [0.6, -6.1],
  [-1.0, -7.7], [-2.0, -5.8], [-3.9, -7.0], [-3.9, -4.8], [-6.5, -4.8], [-5.1, -3.0], [-7.3, -1.4],
  [-5.4, -0.4], [-6.6, 1.7], [-4.8, 2.0], [-5.0, 4.1],
];
const HAIR_LINE = [[-3.2, 3.0], [-2.2, 1.2], [-1.8, -0.9], [-0.6, -2.3], [1.4, -2.7], [2.9, -2.3], [3.3, -1.0], [3.9, -2.0]];

function drawHair(c, t, env) {
  c.fillStyle = COL.hair;
  c.beginPath();
  const n = HAIR_TIPS.length;
  const pt = (i) => {
    const q = HAIR_TIPS[i];
    const tip = i % 2 === 0 ? 1 : 0.3;
    const w = Math.sin(t * env.hairFreq + i * 1.9) * env.flutter;
    return [q[0] + (env.hairSway + w * 0.5) * tip * 0.55, q[1] + (env.hairLift + w * 0.25) * tip * (q[1] < 0 ? 0.6 : 1)];
  };
  let q = pt(0);
  c.moveTo(q[0], q[1]);
  for (let i = 1; i + 1 < n; i += 2) {
    const v = pt(i), tp = pt(i + 1);
    c.quadraticCurveTo(v[0], v[1], tp[0], tp[1]);
  }
  for (let i = 0; i < HAIR_LINE.length; i++) {
    const a = HAIR_LINE[i], b = HAIR_LINE[i + 1] || HAIR_TIPS[0];
    c.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
  }
  q = HAIR_TIPS[0];
  c.lineTo(q[0], q[1]);
  c.closePath();
  c.fill();
  c.strokeStyle = COL.hairHi;
  c.globalAlpha = 0.6; c.lineWidth = 0.55;
  c.beginPath(); c.moveTo(-3.4, -4.4); c.quadraticCurveTo(-0.2, -6.4, 3.2, -4.3); c.stroke();
  c.globalAlpha = 1;
}

function drawHead(c, sk, p, t, env) {
  c.save();
  c.translate(sk.head[0], sk.head[1]);
  c.rotate(sk.headA);
  c.scale(0.95, 0.95);
  if (p.glance > 0.5) c.scale(-1, 1);
  c.fillStyle = COL.skin;
  c.beginPath(); c.ellipse(0, 0.1, 5.15, 4.85, 0, 0, TAU); c.fill();
  c.beginPath(); c.arc(4.95, 0.9, 0.85, 0, TAU); c.fill();       // nose
  c.beginPath(); c.arc(3.4, 3.3, 1.4, 0, TAU); c.fill();         // round cheek / chin
  c.fillStyle = COL.blush;
  c.beginPath(); c.arc(2.4, 1.8, 1.15, 0, TAU); c.fill();
  c.fillStyle = COL.ear;
  c.beginPath(); c.ellipse(-0.5, 0.9, 1.05, 1.35, 0.2, 0, TAU); c.fill();
  drawHair(c, t, env);
  if (p.eye > 0.25) {
    c.fillStyle = COL.eye;
    c.beginPath(); c.ellipse(3.0, -0.05, 0.68, 0.92 * p.eye, 0, 0, TAU); c.fill();
  } else {
    c.strokeStyle = COL.eye; c.lineWidth = 0.42;
    line(c, 2.3, 0.25, 3.6, 0.15);
  }
  if (p.mouth > 0.05) {
    c.fillStyle = '#3a1a16';
    c.beginPath(); c.ellipse(3.9, 2.7, 0.6, 0.65 * p.mouth, 0, 0, TAU); c.fill();
  }
  c.restore();
}

const SCARF_WRAP = [[-3.0, -8.9], [-0.9, -9.8], [1.7, -9.6], [3.1, -8.9], [2.8, -7.5], [0.7, -7.0], [-1.9, -7.2], [-3.4, -7.9]];

function drawScarfWrap(c, p) {
  c.save();
  c.rotate(p.lean);
  c.fillStyle = COL.scarf;
  smoothClosed(c, SCARF_WRAP);
  c.fill();
  c.strokeStyle = COL.scarfDark; c.lineWidth = 0.5;
  c.beginPath(); c.moveTo(-2.9, -8.3); c.quadraticCurveTo(0.3, -8.7, 3.0, -8.2); c.stroke();
  c.strokeStyle = COL.scarfHi; c.lineWidth = 0.4; c.globalAlpha = 0.7;
  c.beginPath(); c.moveTo(-2.2, -9.3); c.quadraticCurveTo(0.4, -9.9, 2.4, -9.3); c.stroke();
  c.globalAlpha = 1;
  c.fillStyle = COL.scarfDark;
  c.beginPath(); c.arc(-3.1, -8.1, 1.0, 0, TAU); c.fill();       // the knot
  c.restore();
}

function drawSpear(c, hx, hy, a) {
  const dx = Math.cos(a), dy = Math.sin(a), nx = -dy, ny = dx;
  const tx = hx + dx * 20, ty = hy + dy * 20;
  c.lineCap = 'round';
  c.strokeStyle = COL.woodDark; c.lineWidth = 1.0;
  line(c, hx - dx * 5, hy - dy * 5, tx, ty);
  c.strokeStyle = COL.wood; c.lineWidth = 0.5;
  line(c, hx - dx * 4.6 + nx * 0.2, hy - dy * 4.6 + ny * 0.2, tx + nx * 0.2, ty + ny * 0.2);
  c.strokeStyle = COL.rope; c.lineWidth = 1.35;
  line(c, tx - dx * 1.8, ty - dy * 1.8, tx - dx * 0.3, ty - dy * 0.3);
  c.fillStyle = '#9fa19b';
  c.beginPath();
  c.moveTo(tx + dx * 4.0, ty + dy * 4.0);
  c.lineTo(tx + nx * 1.0 + dx * 0.4, ty + ny * 1.0 + dy * 0.4);
  c.lineTo(tx - nx * 1.0 + dx * 0.4, ty - ny * 1.0 + dy * 0.4);
  c.closePath();
  c.fill();
  c.strokeStyle = COL.metalHi; c.lineWidth = 0.3;
  line(c, tx + nx * 0.5 + dx * 0.6, ty + ny * 0.5 + dy * 0.6, tx + dx * 3.6, ty + dy * 3.6);
}

function drawHammer(c, hx, hy, a) {
  const dx = Math.cos(a), dy = Math.sin(a), nx = -dy, ny = dx;
  const ex = hx + dx * 7.0, ey = hy + dy * 7.0;
  c.lineCap = 'round';
  c.strokeStyle = COL.wood; c.lineWidth = 0.95;
  line(c, hx - dx * 1.5, hy - dy * 1.5, ex, ey);
  c.fillStyle = COL.metal;
  c.beginPath();
  c.moveTo(ex - dx * 0.9 + nx * 2.4, ey - dy * 0.9 + ny * 2.4);
  c.lineTo(ex + dx * 0.9 + nx * 2.4, ey + dy * 0.9 + ny * 2.4);
  c.lineTo(ex + dx * 0.9 - nx * 1.6, ey + dy * 0.9 - ny * 1.6);
  c.lineTo(ex - dx * 0.4 - nx * 2.0, ey - dy * 0.4 - ny * 2.0);
  c.lineTo(ex - dx * 0.9 - nx * 1.2, ey - dy * 0.9 - ny * 1.2);
  c.closePath();
  c.fill();
  c.strokeStyle = COL.metalHi; c.lineWidth = 0.35;
  line(c, ex + dx * 0.9 + nx * 2.4, ey + dy * 0.9 + ny * 2.4, ex + dx * 0.9 - nx * 1.4, ey + dy * 0.9 - ny * 1.4);
}

// A small three-pronged grapple. `ang` points from the ring to the crown.
function drawGrapple(c, x, y, ang, s) {
  c.save();
  c.translate(x, y);
  c.rotate(ang - Math.PI / 2);
  c.scale(s, s);
  c.lineCap = 'round'; c.lineJoin = 'round';
  c.strokeStyle = '#4c535d'; c.lineWidth = 0.85;
  c.beginPath(); c.arc(0, -0.6, 0.75, 0, TAU); c.stroke();
  line(c, 0, 0, 0, 4.4);
  c.beginPath();
  c.moveTo(0, 4.4); c.quadraticCurveTo(-2.4, 5.0, -2.5, 2.6);
  c.moveTo(0, 4.4); c.quadraticCurveTo(2.4, 5.0, 2.5, 2.6);
  c.moveTo(0, 4.4); c.quadraticCurveTo(0.9, 4.6, 1.0, 3.1);
  c.stroke();
  c.strokeStyle = COL.metalHi; c.lineWidth = 0.32;
  line(c, 0.25, 0.4, 0.25, 3.8);
  c.restore();
}

function drawLantern(c, hx, hy, ang, lit) {
  c.save();
  c.translate(hx, hy);
  c.rotate(ang - Math.PI / 2);
  c.lineCap = 'round';
  c.strokeStyle = '#2f2b27'; c.lineWidth = 0.38;
  c.beginPath(); c.ellipse(0, 1.3, 1.15, 1.35, 0, Math.PI, TAU); c.stroke();     // bail
  c.fillStyle = '#35302b';
  c.beginPath();                                                                   // cap
  c.moveTo(-1.55, 2.75); c.lineTo(1.55, 2.75); c.lineTo(0.9, 1.75); c.lineTo(-0.9, 1.75); c.closePath(); c.fill();
  c.fillStyle = lit ? '#ffc979' : '#6b5a3c';                                      // glass
  c.fillRect(-1.25, 2.75, 2.5, 3.0);
  if (lit) {
    c.fillStyle = '#fff3d2';
    c.beginPath(); c.ellipse(0, 4.25, 0.55, 0.95, 0, 0, TAU); c.fill();
  }
  c.strokeStyle = '#2f2b27'; c.lineWidth = 0.35;
  line(c, -1.3, 2.75, -1.3, 5.75); line(c, 1.3, 2.75, 1.3, 5.75);
  c.fillStyle = '#35302b';
  c.fillRect(-1.6, 5.7, 3.2, 0.75);                                                // base
  c.restore();
}

// =====================================================================================
// drawing — offscreen buffer + rim light
// =====================================================================================

const BUF = { size: 0, body: null, bc: null, mask: null, mc: null, glow: null };

function ensureBuf(px) {
  if (BUF.bc && BUF.size >= px) return true;
  const s = Math.ceil(px / 64) * 64;
  BUF.body = makeCanvas(s, s); BUF.bc = BUF.body.getContext('2d');
  BUF.mask = makeCanvas(s, s); BUF.mc = BUF.mask.getContext('2d');
  BUF.size = s;
  return !!(BUF.bc && BUF.mc);
}

function glowSprite() {
  if (BUF.glow) return BUF.glow;
  const c = makeCanvas(64, 64), g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,240,200,1)');
  gr.addColorStop(0.22, 'rgba(255,200,125,0.55)');
  gr.addColorStop(0.6, 'rgba(255,170,90,0.12)');
  gr.addColorStop(1, 'rgba(255,160,80,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  BUF.glow = c;
  return c;
}

// Light only the edge of the silhouette that faces (lx, ly).
function band(n, lx, ly, wpx, col, alpha) {
  if (!(alpha > 0.01)) return;
  const m = BUF.mc, b = BUF.bc;
  m.setTransform(1, 0, 0, 1, 0, 0);
  m.globalAlpha = 1;
  m.globalCompositeOperation = 'source-over';
  m.clearRect(0, 0, n, n);
  m.drawImage(BUF.body, 0, 0);
  m.globalCompositeOperation = 'source-in';
  m.fillStyle = col; m.fillRect(0, 0, n, n);
  m.globalCompositeOperation = 'destination-out';
  m.drawImage(BUF.body, -lx * wpx, -ly * wpx);
  m.globalCompositeOperation = 'source-over';
  b.globalCompositeOperation = 'source-atop';
  b.globalAlpha = alpha;
  b.drawImage(BUF.mask, 0, 0);
  b.globalAlpha = 1;
  b.globalCompositeOperation = 'source-over';
}

// 0 by day and at night, → 1 while the sun sits low over the horizon.
function lowSun(G) {
  const p = G.phase || 0;
  const dusk = smoothstep(0.46, 0.55, p) * (1 - smoothstep(0.6, 0.66, p));
  const dawn = p < 0.5 ? 1 - smoothstep(0.03, 0.1, p) : smoothstep(0.95, 0.99, p);
  return Math.max(dusk, dawn * 0.8);
}

const rgbStr = (c) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;

function keyLight(G, P, R, ax, cy, under, depth) {
  const res = { lx: 0.25, ly: -1, col: [190, 205, 230], a: 0.22 };
  if (under) {
    const k = Math.exp(-depth / 260) * (0.25 + 0.75 * G.light);
    res.lx = 0.12; res.col = [140, 215, 235]; res.a = 0.6 * k;
  } else {
    let cel = null;
    try { cel = celestial(G); } catch (e) { cel = null; }
    const bs = worldToScreen(G, ax, cy);
    if (cel && G.light > 0.25 && cel.sunVisible && Number.isFinite(cel.sunX)) {
      res.lx = cel.sunX - bs.x; res.ly = cel.sunY - bs.y;
      res.col = Array.isArray(cel.sunColor) ? mix(cel.sunColor, [255, 240, 215], 0.3) : [255, 226, 180];
      res.a = 0.75 * Math.max(0.35, cel.sunAlpha == null ? 1 : cel.sunAlpha);
    } else if (cel && cel.moonVisible && Number.isFinite(cel.moonX)) {
      res.lx = cel.moonX - bs.x; res.ly = cel.moonY - bs.y;
      res.col = [178, 202, 255];
      res.a = 0.6 * Math.max(0.3, cel.moonAlpha == null ? 1 : cel.moonAlpha);
    } else if (G.light > 0.5) {
      res.col = [255, 236, 205]; res.a = 0.4;
    }
  }
  const l = Math.hypot(res.lx, res.ly) || 1;
  res.lx /= l; res.ly /= l;
  return res;
}

const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// The brightest other light the boy stands in (a lamp, the grill…), for a second rim.
function nearLight(G, R, x, y) {
  const L = G.lights;
  if (!Array.isArray(L)) return null;
  let best = null, bs = 0.15;
  for (let i = 0; i < L.length; i++) {
    const l = L[i];
    if (!l || l === R.lightHalo || l === R.lightLantern || !(l.r > 40)) continue;
    const d = Math.hypot(l.x - x, l.y - y);
    if (d >= l.r || d < 4) continue;
    const s = (l.a == null ? 1 : l.a) * (1 - d / l.r);
    if (s > bs) { bs = s; best = { lx: (l.x - x) / d, ly: (l.y - y) / d, col: l.color || [255, 200, 130], a: Math.min(0.75, s * 1.1) }; }
  }
  return best;
}

// =====================================================================================
// draw
// =====================================================================================

export function draw(ctx, G) {
  const P = G.player;
  if (!P) return;
  const R = rt(G);
  const now = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
  let dt = R.lastNow ? now - R.lastNow : 0;
  R.lastNow = now;
  dt = clamp(dt, 0, 0.05);
  if (G.mode === 'pause' || G.mode === 'panel') dt = 0;
  R.t += dt;
  if (R.dead) R.deadT += dt;

  const demo = G.mode === 'title' || !!G.demo;
  let ax = P.x, ay = P.y;
  if (demo) {
    const sp = raftSpan(G);
    if (!sp || sp.y == null) return;
    ax = sp.x1 - 1.2;
    const top = deck(G, sp.x1 - 3);
    ay = (top != null ? top : sp.y) - 2.0 + PELVIS;
  }
  if (R.dead && R.deadWater) { R.sink = Math.min(70, R.deadT * 5.5); ay += R.sink; }
  if (!Number.isFinite(ax) || !Number.isFinite(ay)) return;

  // facing turns over ~0.1 s (a quick squash through the profile)
  const want = demo ? 1 : (P.facing < 0 ? -1 : 1);
  if (!Number.isFinite(R.fx)) R.fx = want;
  if (dt > 0) R.fx = approach(R.fx, want, dt * 14);
  const face = R.fx < 0 ? -1 : 1;
  const fx = Math.abs(R.fx) < 0.14 ? 0.14 * face : R.fx;

  idleTimers(G, P, R, dt);
  const tp = targetPose(G, P, R, R.t, demo, face);
  const p = blendPose(R, tp, dt);
  const sk = skeleton(p);
  const cr = Math.cos(p.rot), sr = Math.sin(p.rot);
  const pelX = ax, pelY = ay - PELVIS;
  const W = (bx, by) => {
    const rx = bx * cr - by * sr, ry = bx * sr + by * cr;
    return [pelX + fx * (p.px + rx), pelY + p.py + ry];
  };

  // world positions of the hands, lantern etc. (the update reads them next step)
  const handN = W(sk.armN.ex, sk.armN.ey);
  const shoulder = W(sk.shN[0], sk.shN[1]);
  const headW = W(sk.head[0], sk.head[1]);
  const lantHand = R.lantern && !(R.mode === 'climb' && !R.dead) ? (P.tool === 'hand' || demo ? sk.armN : sk.armF) : null;
  const downA = Math.atan2(cr, sr);                          // world "down" in body space
  if (dt > 0) {
    const tgt = clamp(-P.vx * 0.006 * face, -0.5, 0.5) + Math.sin(R.t * 2.1) * 0.08;
    R.swing += (tgt - R.swing) * Math.min(1, dt * 4);
  }
  const hangA = downA + R.swing;
  let lantW = null;
  if (lantHand) {
    const gx = lantHand.ex + Math.cos(hangA) * 4.2, gy = lantHand.ey + Math.sin(hangA) * 4.2;
    lantW = W(gx, gy);
  }
  if (!demo && !R.dead) {
    R.off.hand[0] = handN[0] - P.x; R.off.hand[1] = handN[1] - P.y;
    R.off.shoulder[0] = shoulder[0] - P.x; R.off.shoulder[1] = shoulder[1] - P.y;
    R.off.head[0] = headW[0] - P.x; R.off.head[1] = headW[1] - P.y;
    if (lantW) { R.off.lantern[0] = lantW[0] - P.x; R.off.lantern[1] = lantW[1] - P.y; }
  }
  // keep this step's lights glued to what is drawn (also while the world is frozen)
  if (R.lightLantern && lantW) { R.lightLantern.x = lantW[0]; R.lightLantern.y = lantW[1]; }
  if (R.dead && R.lightHalo) { R.lightHalo.x = ax; R.lightHalo.y = ay - 13; }

  // scarf
  const knot = W(sk.knot[0], sk.knot[1]);
  const front = W(sk.front[0], sk.front[1]);
  simScarf(G, R, knot[0], knot[1], front[0], front[1], dt, R.t);

  const visible = onScreen(G, ax, ay - 12, 70);
  if (visible) {
    const wyHere = waterY(G, ax);
    const depth = Math.max(0, ay - 12 - wyHere);
    const under = depth > 6;
    drawShadow(ctx, G, P, R, ax, ay, demo);
    const env = {
      demo, lantern: !!lantHand, hangA, downA,
      breath: Math.sin(R.t * 2.0),
      water: under,
      hairFreq: under ? 1.6 : 7,
      flutter: under ? 0.7 : 0.25 + Math.min(1, Math.abs((G.weather && G.weather.wind) || 0.3)) * 0.35,
      hairSway: under ? Math.sin(R.t * 0.9) * 0.4 : -face * clamp(((G.weather && G.weather.wind) || 0.3) * 0.8, -1, 1),
      hairLift: under ? -0.9 : 0,
    };
    renderBoy(ctx, G, P, R, p, sk, { ax, ay, fx, face, pelX, pelY, W, lantHand, lantW, env, under, depth });
  }
  if (!demo) {
    drawRopeAndHook(ctx, G, R, handN);
    drawAim(ctx, G, P, R);
  }
}

function idleTimers(G, P, R, dt) {
  if (dt <= 0) return;
  R.blinkT -= dt;
  if (R.blink > 0) R.blink -= dt;
  if (R.blinkT <= 0) { R.blink = 0.13; R.blinkT = rand(2.2, 5.5); }
  R.glanceT -= dt;
  if (R.glanceOn) { if (R.glanceT <= 0) { R.glanceOn = 0; R.glanceT = rand(4, 9) * (isNight(G) ? 0.6 : 1); } }
  else if (R.glanceT <= 0) {
    const idle = (R.mode === 'ground' || R.mode === 'swim') && Math.abs(P.vx) < 6 && !R.charging && !G.hook && !R.dead;
    if (idle) { R.glanceOn = 1; R.glanceT = rand(0.9, 1.6); } else R.glanceT = rand(1, 3);
  }
}

function drawShadow(ctx, G, P, R, ax, ay, demo) {
  if (demo || R.mode !== 'ground' || R.dead) return;
  const a = 0.16 + 0.14 * G.light;
  ctx.fillStyle = `rgba(8,10,16,${a.toFixed(3)})`;
  ctx.beginPath();
  ctx.ellipse(ax, ay + 0.4, 6.5, 1.2, 0, 0, TAU);
  ctx.fill();
}

function renderBoy(ctx, G, P, R, p, sk, o) {
  const m = ctx.getTransform ? ctx.getTransform() : null;
  let sa, se, sf;
  if (m) { sa = m.a; se = m.e; sf = m.f; }
  else {
    const v = G.view;
    sa = v.scale * v.dpr;
    se = (v.cssW / 2 - (G.cam.x + (G.cam.shakeX || 0)) * v.scale) * v.dpr;
    sf = (v.cssH / 2 - (G.cam.y + (G.cam.shakeY || 0)) * v.scale) * v.dpr;
  }
  if (!(sa > 0.05)) return;
  const half = 46;
  const cx = o.ax, cy = o.ay - 12;
  const n = Math.ceil(half * 2 * sa) + 4;
  if (n > 2048 || !ensureBuf(n)) return;
  const ox = Math.floor(sa * (cx - half) + se), oy = Math.floor(sa * (cy - half) + sf);
  const b = BUF.bc;
  b.setTransform(1, 0, 0, 1, 0, 0);
  b.globalCompositeOperation = 'source-over';
  b.globalAlpha = 1;
  b.clearRect(0, 0, BUF.size, BUF.size);
  b.setTransform(sa, 0, 0, sa, se - ox, sf - oy);
  b.lineCap = 'round'; b.lineJoin = 'round';

  // scarf tails behind the body (world space)
  if (R.scarf) {
    drawRibbon(b, R.scarf[1], 1.0, 0.75, COL.scarfBack, COL.scarf, R.t, 2.1);
    drawRibbon(b, R.scarf[0], 1.2, 0.85, COL.scarf, COL.scarfHi, R.t, 0);
  }

  // the body (body space)
  b.save();
  b.translate(o.pelX, o.pelY);
  b.scale(o.fx, 1);
  b.translate(p.px, p.py);
  b.rotate(p.rot);
  drawArm(b, sk.shF, sk.armF, true);
  drawLeg(b, sk.hipF, sk.legF, p, true);
  drawLeg(b, sk.hipN, sk.legN, p, false);
  drawSweater(b, p, o.env.breath);
  b.strokeStyle = COL.skinFar; b.lineWidth = 2.4;
  line(b, sk.neck[0], sk.neck[1], sk.head[0] - 0.4, sk.head[1] + 1.5);
  drawHead(b, sk, p, R.t, o.env);
  drawScarfWrap(b, p);
  b.restore();
  if (R.scarf && R.scarf[2]) drawRibbon(b, R.scarf[2], 1.05, 0.8, COL.scarf, COL.scarfHi, R.t, 4.3);
  b.save();
  b.translate(o.pelX, o.pelY);
  b.scale(o.fx, 1);
  b.translate(p.px, p.py);
  b.rotate(p.rot);
  if (o.lantHand === sk.armF) drawLantern(b, sk.armF.ex, sk.armF.ey, o.env.hangA, true);
  drawHeldTool(b, G, P, R, p, sk, o.env);
  drawArm(b, sk.shN, sk.armN, false);
  if (o.lantHand === sk.armN) drawLantern(b, sk.armN.ex, sk.armN.ey, o.env.hangA, true);
  b.restore();

  // ---- light passes in pixel space
  b.setTransform(1, 0, 0, 1, 0, 0);
  const key = keyLight(G, P, R, cx, cy, o.under, o.depth);
  const shadeA = o.under ? 0.32 : 0.22 + 0.18 * G.light;
  band(n, -key.lx, -key.ly, 2.8 * sa, 'rgb(8,10,22)', shadeA);
  // low sun (dawn, dusk): he turns into a silhouette against the sky, edged with warm light
  const low = o.under ? 0 : lowSun(G);
  if (low > 0.01) {
    b.globalCompositeOperation = 'source-atop';
    b.fillStyle = `rgba(28,22,44,${(0.5 * low).toFixed(3)})`;
    b.fillRect(0, 0, n, n);
    b.globalCompositeOperation = 'source-over';
  }
  band(n, key.lx, key.ly, Math.max(1, (0.85 + 0.45 * low) * sa), rgbStr(key.col), Math.min(1, key.a * (1 + 0.5 * low)));
  if (o.lantW) {
    const dx = o.lantW[0] - cx, dy = o.lantW[1] - (cy - 2);
    const l = Math.hypot(dx, dy) || 1;
    band(n, dx / l, dy / l, Math.max(1, 1.1 * sa), 'rgb(255,192,112)', 0.75);
  } else if (G.light < 0.6 || o.under) {
    const nl = nearLight(G, R, cx, cy);
    if (nl) band(n, nl.lx, nl.ly, Math.max(1, 0.95 * sa), rgbStr(nl.col), nl.a);
  }
  if (R.hurtT < 0.35 && !R.dead) {
    b.globalCompositeOperation = 'source-atop';
    b.fillStyle = `rgba(215,45,35,${(0.55 * (1 - R.hurtT / 0.35)).toFixed(3)})`;
    b.fillRect(0, 0, n, n);
    b.globalCompositeOperation = 'source-over';
  }

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(BUF.body, 0, 0, n, n, ox, oy, n, n);
  ctx.restore();

  // the lantern's warm glow on top (additive)
  if (o.lantW) {
    const fl = 0.85 + 0.15 * noise1(R.t * 9, 3);
    const r = 6 * fl;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = o.under ? 0.4 : 0.6;
    ctx.drawImage(glowSprite(), o.lantW[0] - r, o.lantW[1] - r, r * 2, r * 2);
    ctx.restore();
  }
}

function drawHeldTool(c, G, P, R, p, sk, env) {
  if (env.demo || (R.dead && !R.deadWater && R.deadT > 0.6)) return;
  const hx = sk.armN.ex, hy = sk.armN.ey;
  const tool = P.tool;
  if (tool === 'spear' && has(G, 'spear') > 0) drawSpear(c, hx, hy, p.toolA);
  else if (tool === 'hammer') drawHammer(c, hx, hy, p.toolA);
  else if (tool === 'hook' && !G.hook && has(G, 'hook') > 0) {
    // a coil of rope in the hand and the hook dangling from it
    c.strokeStyle = COL.rope; c.lineWidth = 0.5;
    c.beginPath(); c.ellipse(hx + 0.3, hy + 0.6, 1.4, 0.95, 0.3, 0, TAU); c.stroke();
    const a = env.downA + Math.sin(R.t * 2.7) * 0.22 + (R.charging ? Math.sin(R.t * 11) * 0.25 : 0);
    const ex = hx + Math.cos(a) * 3.8, ey = hy + Math.sin(a) * 3.8;
    c.lineWidth = 0.4;
    line(c, hx, hy, ex, ey);
    drawGrapple(c, ex, ey, a, 0.62);
  }
}

// =====================================================================================
// drawing — rope, hook, aim
// =====================================================================================

function drawRopeAndHook(ctx, G, R, hand) {
  const h = G.hook;
  if (!h || !Number.isFinite(h.x)) return;
  const hx = hand[0], hy = hand[1];
  const floating = h.state === 'floating' && !h.land;
  const bob = floating ? Math.sin(G.time * 2.6 + h.seed) * 0.5 : 0;
  const kx = h.x, ky = h.y - (floating ? 1.0 : 0) + bob;       // where the rope is tied (the float)
  const dx = kx - hx, dy = ky - hy, d = Math.hypot(dx, dy);
  if (!onScreen(G, (hx + kx) / 2, (hy + ky) / 2, d / 2 + 80)) return;
  let sag;
  if (h.state === 'flying') sag = d * 0.045;
  else if (h.state === 'reeling') sag = 0.6 + d * 0.018;
  else sag = clamp(((h.len || d) - d) * 0.5 + d * 0.07, 2, 46);
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(40,32,24,0.35)';
  ctx.lineWidth = 1.1;
  ctx.beginPath(); ctx.moveTo(hx, hy); ctx.quadraticCurveTo((hx + kx) / 2, (hy + ky) / 2 + sag * 2, kx, ky); ctx.stroke();
  ctx.strokeStyle = COL.rope;
  ctx.lineWidth = 0.65;
  ctx.beginPath(); ctx.moveTo(hx, hy); ctx.quadraticCurveTo((hx + kx) / 2, (hy + ky) / 2 + sag * 2, kx, ky); ctx.stroke();

  if (floating) {
    // ripples around the float
    const ph = (G.time * 0.8 + h.seed) % 1;
    ctx.strokeStyle = `rgba(225,240,245,${(0.35 * (1 - ph)).toFixed(3)})`;
    ctx.lineWidth = 0.45;
    ctx.beginPath(); ctx.ellipse(h.x, h.y + 0.3, 3 + ph * 9, (3 + ph * 9) * 0.22, 0, 0, TAU); ctx.stroke();
    // the grapple hangs under the float
    ctx.strokeStyle = COL.rope; ctx.lineWidth = 0.4;
    line(ctx, kx, ky, kx + 0.4, ky + 3.4);
    drawGrapple(ctx, kx + 0.4, ky + 3.4, Math.PI / 2 + Math.sin(G.time * 1.7 + h.seed) * 0.25, 0.85);
    drawFloat(ctx, kx, ky);
  } else {
    const a = h.state === 'flying' ? h.a : h.state === 'reeling' ? Math.atan2(h.y - hy, h.x - hx) : Math.PI / 2 + 0.6;
    drawFloat(ctx, kx - Math.cos(a) * 1.8, ky - Math.sin(a) * 1.8);
    drawGrapple(ctx, kx, ky, a, 0.85);
  }
}

function drawFloat(ctx, x, y) {
  ctx.fillStyle = '#e8e2d4';
  ctx.beginPath(); ctx.ellipse(x, y - 0.35, 1.35, 0.95, 0, Math.PI, TAU); ctx.fill();
  ctx.fillStyle = '#b8352b';
  ctx.beginPath(); ctx.ellipse(x, y - 0.35, 1.35, 1.0, 0, 0, Math.PI); ctx.fill();
}

function drawAim(ctx, G, P, R) {
  if (!R.charging || R.dead) return;
  const o = throwOrigin(G, P, R);
  const v = throwVel(G, P, R, o.x, o.y, R.charge);
  let x = o.x, y = o.y, vx = v.vx, vy = v.vy;
  const step = 1 / 30;
  ctx.fillStyle = 'rgb(255,238,205)';
  for (let i = 1; i < 72; i++) {
    x += vx * step;
    y += (vy + HOOK_G * step * 0.5) * step;
    vy += HOOK_G * step;
    if (Math.hypot(x - o.x, y - o.y) > ROPE_MAX) break;
    const top = surfaceTop(G, x).y;
    if (y >= top) {
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = 'rgb(255,238,205)'; ctx.lineWidth = 0.6;
      ctx.beginPath(); ctx.ellipse(x, top, 4, 1.1, 0, 0, TAU); ctx.stroke();
      break;
    }
    if (i % 2 === 0) {
      ctx.globalAlpha = 0.45 * (1 - i / 90);
      ctx.beginPath(); ctx.arc(x, y, 0.75, 0, TAU); ctx.fill();
    }
  }
  // the charge arc over his head
  const full = R.charge >= 1;
  ctx.globalAlpha = full ? 0.55 + 0.3 * (0.5 + 0.5 * Math.sin(R.t * 12)) : 0.5;
  ctx.strokeStyle = full ? 'rgb(255,214,150)' : 'rgb(255,236,200)';
  ctx.lineWidth = 1.0;
  ctx.lineCap = 'round';
  const cx = P.x, cy = P.y - 14;
  const span = 0.05 + R.charge * 1.25;
  ctx.beginPath(); ctx.arc(cx, cy, 18, -Math.PI / 2 - span, -Math.PI / 2 + span); ctx.stroke();
  ctx.globalAlpha = 1;
}
