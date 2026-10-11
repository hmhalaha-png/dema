// 少年与海 — 岛屿 (islands).
//
// The islands along the journey and everything that lives on them.
//
//  • Layout: five deterministic islands (x ≈ 2600, 6200, 10000, 14200, 17800) and the
//    lighthouse rock at C.GOAL_X. Each one is a side-view terrain profile — a reef slope
//    rising from the seabed to a shallow sandy shelf, a beach, hills, rock outcrops and
//    sometimes a small cliff — sampled into a height table, so groundAt() is a lookup.
//  • Resources (palms, driftwood, rocks, berry bushes, one chest per island) register
//    interactables and remember their depletion in G.persist.islands[id] (plain JSON).
//  • Hermit crabs scuttle along the beaches; fireflies and glowing mushrooms come out at
//    night; chimes of shells and bottles swing on the last island.
//  • The night beast (林中野兽): it steps out of the tree line when the boy is ashore after
//    dark, stalks, winds up and charges, cannot enter the water (paces the shoreline and
//    stares instead), hesitates in lantern light, flinches from the spear and melts back
//    into the trees at dawn.
//  • The lighthouse: a tall stone tower on a rock whose beam sweeps the night sky; its door
//    ends the game by day. (The far silhouette on the horizon is drawn by sky.js; this
//    module takes over with the real tower and beam as it comes close.)
//
// Art: static terrain, back vegetation and the reef are pre-rendered per island into
// offscreen canvases (a day and a night variant, crossfaded with G.light), built lazily
// as an island approaches and released when it is far away. Everything that moves is
// drawn per frame and culled.

import { C, isNight, say, journal, discover } from '../core/state.js';
import { seabedY, addLight, addInteract, onScreen } from '../core/world.js';
import { emit } from '../core/particles.js';
import { TAU, clamp, lerp, smoothstep, noise1, fbm1, hash1, seeded, mixColor, makeCanvas, approach } from '../core/util.js';
import { getAsset } from '../core/assets.js';
import { addItem, ITEMS } from './inventory.js';
import { hurtPlayer } from '../entities/player.js';
import { sfx } from './audio.js';

// =====================================================================================
// tuning
// =====================================================================================

const STEP = 2;                  // terrain table resolution (world units)
const LAND_BOTTOM = 58;          // the land canvas reaches this far below sea level
const UNDER_TOP = 26;            // the reef canvas starts here
const UNDER_SPLIT = 300;         // shallow reef / deep reef canvases meet here
const RES_LAND = 1.6, RES_BACK = 1.3, RES_UNDER = 1.0, RES_DEEP = 0.45, RES_TOWER = 1.8;
const KEEP_NEAR = 1500;          // build art for islands this close to the view
const DROP_FAR = 2600;           // release art for islands further than this
const DAY = C.DAY_LEN;
const REGROW = { palm: 1, bush: 1.5, rock: 1, wood: 2 };   // in-game days
const BEAST_DMG = 30;

// ---- the journey -------------------------------------------------------------------
const LAYOUT = [
  { x: 2600, w: 640, seed: 11, theme: 'palms', name: '椰子岛', palms: 5, wood: 1, rocks: 1, bushes: 2, crabs: 3, peak: 62, cliff: false },
  { x: 6200, w: 820, seed: 23, theme: 'drift', name: '浮木湾', palms: 3, wood: 4, rocks: 1, bushes: 2, crabs: 4, peak: 96, cliff: true },
  { x: 10000, w: 560, seed: 37, theme: 'rocky', name: '石头岛', palms: 2, wood: 1, rocks: 4, bushes: 1, crabs: 2, peak: 124, cliff: true },
  { x: 14200, w: 900, seed: 41, theme: 'forest', name: '雾林岛', palms: 3, wood: 2, rocks: 2, bushes: 3, crabs: 3, peak: 108, cliff: false },
  { x: 17800, w: 720, seed: 59, theme: 'chimes', name: '风铃岛', palms: 4, wood: 2, rocks: 1, bushes: 2, crabs: 3, peak: 78, cliff: true },
];

const LANDING = [
  ['踏上了一座无名小岛', '木筏搁浅在一座无名小岛上。沙子很软，椰子树在风里沙沙作响。我给它起名叫「椰子岛」。'],
  ['踏上了第二座小岛', '这座岛的海湾里堆满了被冲上岸的浮木，还有半截旧船。就叫它「浮木湾」吧。'],
  ['踏上了一座石头岛', '一座全是石头的岛。风钻过石缝，发出呜呜的声音，像有人在很远的地方吹口哨。'],
  ['踏上了一座树林很深的岛', '这座岛的林子又黑又密，树枝像手指一样伸向沙滩。我决定不往太深的地方走。'],
  ['踏上了一座挂满风铃的岛', '树上挂着一串串贝壳和玻璃瓶，风一吹就叮当作响。有人在这里住过——而且住了很久。'],
  ['终于……到灯塔了。', '木筏靠上了灯塔脚下的岩石。灯塔比我想象的还要高，石墙上爬满了藤蔓，门就在山坡顶上。'],
];

const PAGES = [
  '【旧日记·一】第十七天。我把小船拖上了这片沙滩。椰子很甜，螃蟹很吵。夜里林子里有脚步声，比人重，比熊轻。我告诉自己，那只是风。',
  '【旧日记·二】昨晚它来了。它站在火光外面，一动不动，看了我一整夜。天亮以后，沙滩上只剩一排很长很长的脚印，一直通进林子里。记住：天黑以前，回到水上去。',
  '【旧日记·三】它不会游泳。我坐在船上，它就站在浪花碰不到的地方，来回踱步，一直盯着我。那一刻我忽然觉得，它好像也很孤单。',
  '【旧日记·四】它怕光。我把提灯举高，它就后退一步；我把提灯放低，它就往前一步。我们就这样，在沙滩上跳了一整夜的舞。',
  '【旧日记·五】从这里已经能看见灯塔了。那是我的灯塔。我离开它，是为了去找一个被浪卷走的孩子。如果你读到这一页——孩子，往东走，白天推门进去。灯，我一直替你留着。',
];

const NAMES = {
  wood: '木板', plastic: '塑料', rope: '绳子', cloth: '布', metal: '废铁', leaf: '棕榈叶', stone: '石头',
  coconut: '椰子', berry: '野果', can: '罐头', bandage: '绷带', water: '淡水',
};

// =====================================================================================
// palettes (terrain caches use DAY/NIGHT; per-frame props mix OBJ_DAY/OBJ_NIGHT)
// =====================================================================================

const PDAY = {
  sand: [222, 197, 152], sandLit: [250, 236, 204], sandDeep: [178, 146, 104], sandWet: [150, 126, 96], sandDot: [196, 168, 124],
  soil: [104, 80, 56], soilDeep: [60, 46, 38], body: [46, 42, 42], strata: [26, 20, 18], core: [36, 29, 26], water: [22, 54, 62],
  grass: [90, 124, 62], grassHi: [164, 186, 98], grassLo: [52, 82, 48], flower: [[248, 240, 206], [242, 186, 112], [230, 150, 162]],
  rock: [124, 120, 112], rockLit: [190, 184, 166], rockDark: [70, 68, 68], moss: [100, 130, 66],
  canopy: [50, 84, 62], canopyHi: [104, 140, 82], canopyLo: [24, 44, 40], trunk: [80, 64, 52], trunkDark: [44, 36, 32],
  haze: [168, 198, 206], hazeK: 0.14, rim: [255, 244, 214], rimK: 0.5,
  pool: [140, 196, 206], poolHi: [236, 248, 250],
  wood: [176, 160, 138], woodDark: [112, 98, 82],
  reed: [150, 146, 92],
};
const PNIGHT = {
  sand: [78, 86, 118], sandLit: [150, 166, 210], sandDeep: [44, 50, 76], sandWet: [38, 44, 66], sandDot: [64, 72, 102],
  soil: [34, 36, 52], soilDeep: [18, 20, 30], body: [13, 15, 22], strata: [6, 7, 12], core: [10, 11, 17], water: [10, 20, 38],
  grass: [28, 42, 54], grassHi: [76, 98, 132], grassLo: [14, 22, 32], flower: null,
  rock: [48, 54, 74], rockLit: [112, 128, 168], rockDark: [20, 22, 34], moss: [28, 42, 54],
  canopy: [16, 23, 36], canopyHi: [76, 96, 146], canopyLo: [7, 10, 18], trunk: [20, 22, 32], trunkDark: [10, 11, 18],
  haze: [24, 34, 68], hazeK: 0.12, rim: [168, 190, 238], rimK: 0.55,
  pool: [36, 52, 92], poolHi: [178, 198, 240],
  wood: [66, 70, 88], woodDark: [32, 34, 48],
  reed: [40, 48, 60],
};

const OBJ_DAY = {
  frond: [68, 110, 60], frondDark: [40, 72, 50], frondHi: [156, 188, 100],
  ptrunk: [134, 106, 78], ptrunkDark: [86, 66, 50], ptrunkHi: [196, 166, 124],
  coconut: [102, 76, 42], coconutHi: [160, 126, 76],
  bush: [56, 94, 56], bushDark: [32, 60, 42], bushHi: [112, 152, 86], berry: [200, 44, 62], berryHi: [255, 160, 160],
  drift: [184, 170, 150], driftDark: [116, 102, 86], driftHi: [232, 222, 204],
  rock: [128, 124, 116], rockLit: [194, 188, 170], rockDark: [76, 74, 74], moss: [104, 134, 68],
  chest: [124, 80, 44], chestDark: [70, 44, 26], chestHi: [176, 124, 76], iron: [56, 54, 58], ironHi: [138, 132, 124], brass: [214, 174, 86],
  crab: [210, 104, 72], crabDark: [130, 56, 40],
  grassF: [36, 62, 40], grassF2: [56, 88, 52], duneF: [128, 126, 78], leafF: [26, 50, 36],
  mush: [236, 226, 204], mushStem: [214, 204, 186],
  chime: [238, 228, 212], string: [120, 100, 80], post: [118, 96, 72],
  sand: [222, 197, 152], soil: [88, 68, 50],
};
const OBJ_NIGHT = {
  frond: [15, 22, 34], frondDark: [8, 12, 20], frondHi: [72, 92, 134],
  ptrunk: [30, 32, 44], ptrunkDark: [15, 16, 25], ptrunkHi: [92, 106, 144],
  coconut: [22, 22, 30], coconutHi: [60, 66, 90],
  bush: [16, 24, 34], bushDark: [8, 12, 20], bushHi: [52, 70, 100], berry: [70, 30, 52], berryHi: [140, 110, 160],
  drift: [72, 78, 98], driftDark: [34, 36, 50], driftHi: [130, 142, 178],
  rock: [50, 56, 76], rockLit: [112, 128, 168], rockDark: [20, 22, 34], moss: [28, 42, 54],
  chest: [40, 32, 36], chestDark: [20, 16, 20], chestHi: [80, 72, 92], iron: [20, 20, 26], ironHi: [90, 98, 126], brass: [120, 110, 100],
  crab: [96, 70, 80], crabDark: [40, 30, 40],
  grassF: [4, 7, 11], grassF2: [8, 12, 18], duneF: [10, 13, 18], leafF: [3, 6, 10],
  mush: [150, 230, 255], mushStem: [70, 110, 130],
  chime: [170, 186, 220], string: [40, 40, 50], post: [30, 30, 40],
  sand: [78, 86, 118], soil: [26, 28, 40],
};

// Distant hazy hills behind each island, by phase (matches the sky's horizon keys)
const HAZE_KEYS = [
  [0.000, [118, 110, 150]], [0.040, [150, 168, 186]], [0.100, [152, 180, 192]], [0.250, [146, 178, 190]],
  [0.440, [154, 168, 176]], [0.505, [160, 146, 160]], [0.545, [126, 104, 136]], [0.600, [62, 58, 96]],
  [0.640, [30, 36, 72]], [0.690, [16, 26, 56]], [0.900, [16, 26, 56]], [0.945, [34, 38, 76]], [0.975, [96, 84, 120]],
  [1.000, [118, 110, 150]],
];

// =====================================================================================
// small helpers
// =====================================================================================

const rgb = (c) => 'rgb(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ')';
const rgba = (c, a) => 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + clamp(a, 0, 1).toFixed(3) + ')';
const bump = (t) => (t <= -1 || t >= 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * t));
const ramp = (u) => { u = clamp(u, 0, 1); return 1 - (1 - u) * (1 - u); };
const frac = (v) => v - Math.floor(v);
const rnd = (a, b) => a + Math.random() * (b - a);
const sign = (v) => (v < 0 ? -1 : 1);

function keyAt(keys, p) {
  if (p <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (p <= keys[i][0]) {
      const [a, ca] = keys[i - 1], [b, cb] = keys[i];
      return mixColor(ca, cb, (p - a) / (b - a));
    }
  }
  return keys[keys.length - 1][1];
}

const reported = new Set();
function oops(tag, e) {
  if (reported.has(tag)) return;
  reported.add(tag);
  try { console.warn('[islands → ' + tag + ']', e); } catch (er) { /* ignore */ }
}
function play(name, opts) { try { sfx(name, opts); } catch (e) { oops('sfx', e); } }
function give(G, id, n, quiet) {
  try { addItem(G, id, n, quiet); } catch (e) { oops('addItem', e); G.inv[id] = (G.inv[id] || 0) + n; }
}
function itemName(id) {
  try { const it = ITEMS && ITEMS[id]; if (it && (it.name || it.label)) return it.name || it.label; } catch (e) { /* stub */ }
  return NAMES[id] || id;
}
function seabed(G, x) {
  try { const y = seabedY(G, x); return Number.isFinite(y) ? y : 900; } catch (e) { return 900; }
}

// 0 = full day … 1 = deep night (smooth through dusk)
function nightK(G) { return clamp((1 - (G.light == null ? 1 : G.light)) / 0.88, 0, 1); }

// =====================================================================================
// static island data (deterministic; built once per page and shared by every game)
// =====================================================================================

let ISL = null;

function ensureStatic(G) {
  if (ISL) return ISL;
  const list = [];
  LAYOUT.forEach((def, i) => list.push(buildNormal(G, def, i)));
  list.push(buildLighthouse(G, LAYOUT.length));
  ISL = list;
  return ISL;
}

// Ground y at x on island I (clamped to its table).
function gy(I, x) {
  const f = (x - I.x0) / STEP;
  if (f <= 0) return I.hs[0];
  let k = f | 0;
  if (k >= I.n - 1) return I.hs[I.n - 1];
  const t = f - k;
  return I.hs[k] + (I.hs[k + 1] - I.hs[k]) * t;
}
const slopeAt = (I, x) => Math.abs(gy(I, x + 5) - gy(I, x - 5)) / 10;

// Fill the height table for I from a land profile and an underwater profile.
function tabulate(G, I, hLand, under) {
  let dl = 0;
  for (; dl < 1400; dl += STEP) { const x = I.shoreL - dl; if (dl > 0 && under(dl, -1, x) >= seabed(G, x)) break; }
  let dr = 0;
  for (; dr < 1400; dr += STEP) { const x = I.shoreR + dr; if (dr > 0 && under(dr, 1, x) >= seabed(G, x)) break; }
  I.x0 = I.shoreL - dl;
  I.n = Math.round((I.shoreR + dr - I.x0) / STEP) + 1;
  I.x1 = I.x0 + (I.n - 1) * STEP;
  I.hs = new Float32Array(I.n);
  let maxH = 0, maxD = 0;
  for (let k = 0; k < I.n; k++) {
    const x = I.x0 + k * STEP;
    let y;
    if (x < I.shoreL) y = under(I.shoreL - x, -1, x);
    else if (x > I.shoreR) y = under(x - I.shoreR, 1, x);
    else y = -hLand(x - I.shoreL);
    y = Math.min(y, seabed(G, x));
    I.hs[k] = y;
    if (-y > maxH) maxH = -y;
    if (y > maxD) maxD = y;
  }
  I.maxH = maxH; I.maxD = maxD;
  // dry land the beast may walk on
  let s = 0;
  while (s < I.W && -gy(I, I.shoreL + s) < 4.5) s += 1;
  I.dryL = I.shoreL + s;
  s = 0;
  while (s < I.W && -gy(I, I.shoreR - s) < 4.5) s += 1;
  I.dryR = I.shoreR - s;
  // the land canvas covers the shelf down to LAND_BOTTOM
  let a = I.shoreL; while (a > I.x0 && gy(I, a) < LAND_BOTTOM + 4) a -= STEP;
  let b = I.shoreR; while (b < I.x1 && gy(I, b) < LAND_BOTTOM + 4) b += STEP;
  I.landX0 = a - 6; I.landX1 = b + 6;
  I.info = { id: I.id, x0: I.x0, x1: I.x1, kind: I.kind };
}

function underProfile(seed, shelfL, slopeL, shelfR, slopeR, dropK) {
  return (d, side, x) => {
    const shelf = side < 0 ? shelfL : shelfR, slope = side < 0 ? slopeL : slopeR;
    const e = Math.max(0, d - shelf);
    let y = slope * d + dropK * Math.pow(e, 1.55);
    y += (fbm1(x * 0.019, 3, seed + 5) - 0.5) * 46 * smoothstep(0, 90, e);
    // bulging reef walls and flat ledges
    y += Math.sin(e * 0.034 + seed) * 22 * smoothstep(20, 120, e);
    const k = e / 85 + seed * 0.13, f = k - Math.floor(k);
    y -= (smoothstep(0.55, 0.9, f) - 0.5) * 16 * smoothstep(40, 140, e);
    y += (noise1(x * 0.11, seed + 6) - 0.5) * 3 * smoothstep(0, 30, d);
    return y;
  };
}

function buildNormal(G, def, idx) {
  const rng = seeded(def.seed * 7919 + 101);
  const W = def.w;
  const I = {
    idx, id: 'i' + idx, kind: 'normal', def, theme: def.theme, name: def.name, seed: def.seed,
    W, shoreL: Math.round(def.x - W / 2), cx: def.x,
  };
  I.shoreR = I.shoreL + W;
  const beachL = lerp(78, 112, rng()), beachR = lerp(70, 108, rng());
  const Bh = lerp(8.5, 11.5, rng());
  I.beachL = beachL; I.beachR = beachR;
  const hills = [];
  const nh = W > 700 ? 3 : 2;
  const a0 = beachL + 40, a1 = W - beachR - 40;
  for (let k = 0; k < nh; k++) {
    const c = lerp(a0, a1, (k + 0.3 + rng() * 0.4) / nh);
    hills.push({ c, a: lerp(0.55, 1, rng()), w: lerp(110, 190, rng()) * (W / 700) });
  }
  const crops = [];
  const nc = def.theme === 'rocky' ? 3 : 1 + (rng() < 0.5 ? 1 : 0);
  for (let k = 0; k < nc; k++) crops.push({ c: lerp(beachL + 30, W - beachR - 30, rng()), h: lerp(9, 20, rng()), w: lerp(16, 30, rng()) });
  let cliff = null;
  if (def.cliff) {
    const c = lerp(W * 0.38, W * 0.52, rng());
    cliff = { c, h: lerp(17, 23, rng()), d1: lerp(70, 120, rng()), d2: lerp(90, 140, rng()) };
  }
  const pools = [];
  if (def.theme !== 'forest') pools.push({ c: beachL * lerp(0.42, 0.62, rng()), w: lerp(10, 14, rng()), d: 2.6 });
  if (rng() < 0.6) pools.push({ c: W - beachR * lerp(0.4, 0.6, rng()), w: lerp(9, 13, rng()), d: 2.4 });
  I.crops = crops; I.cliff = cliff; I.pools = pools;
  const seed = def.seed;
  const env = (s) => smoothstep(beachL * 0.45, beachL * 1.2, s) * smoothstep(beachR * 0.45, beachR * 1.2, W - s);
  const hillRaw = (s) => {
    let h = 0;
    for (const hl of hills) h += hl.a * bump((s - hl.c) / hl.w);
    h += (fbm1((I.shoreL + s) * 0.011, 3, seed) - 0.5) * 0.4;
    return Math.max(0, h) * env(s);
  };
  let M = 0.001;
  for (let s = 0; s <= W; s += 4) M = Math.max(M, hillRaw(s));
  const scale = Math.max(0, def.peak - Bh - (cliff ? cliff.h * 0.6 : 0)) / M;
  const hLand = (s) => {
    let h = Bh * Math.min(ramp(s / beachL), ramp((W - s) / beachR));
    h += hillRaw(s) * scale;
    for (const o of crops) { const b = bump((s - o.c) / o.w); if (b > 0) h += o.h * Math.pow(b, 0.55); }
    if (cliff) h += cliff.h * smoothstep(cliff.c - 1.2, cliff.c + 1.2, s) * (1 - smoothstep(cliff.c + cliff.d1, cliff.c + cliff.d1 + cliff.d2, s));
    for (const p of pools) h -= p.d * bump((s - p.c) / p.w);
    h += (noise1((I.shoreL + s) * 0.12, seed + 4) - 0.5) * 1.1 * Math.min(1, s / 24, (W - s) / 24);
    return Math.max(0, h);
  };
  I.hLand = hLand;
  const under = underProfile(seed, lerp(46, 74, rng()), lerp(0.2, 0.27, rng()), lerp(44, 70, rng()), lerp(0.2, 0.27, rng()), lerp(0.075, 0.1, rng()));
  tabulate(G, I, hLand, under);
  placeProps(I, def, rng);
  return I;
}

function buildLighthouse(G, idx) {
  const W = 800;
  const I = {
    idx, id: 'lighthouse', kind: 'lighthouse', def: { theme: 'lighthouse', crabs: 2 }, theme: 'lighthouse', name: '灯塔岛', seed: 77,
    W, shoreL: C.GOAL_X - 340, cx: C.GOAL_X,
  };
  I.shoreR = I.shoreL + W;
  I.beachL = 64; I.beachR = 30;
  const towerS = 452, plat = 66;
  I.towerX = I.shoreL + towerS;
  I.crops = [{ c: 196, h: 12, w: 20 }, { c: 600, h: 14, w: 26 }, { c: 690, h: 10, w: 18 }];
  I.cliff = null; I.pools = [{ c: 34, w: 10, d: 2.2 }];
  const hLand = (s) => {
    let h = 7.5 * ramp(s / 64);
    h += (plat - 7.5) * smoothstep(64, 380, s);
    // the tower stands on a level pad
    const pad = Math.pow(bump((s - towerS) / 120), 0.5);
    h += (fbm1((I.shoreL + s) * 0.02, 3, 77) - 0.5) * 12 * smoothstep(60, 140, s) * (1 - pad);
    for (const o of I.crops) { const b = bump((s - o.c) / o.w); if (b > 0) h += o.h * Math.pow(b, 0.55); }
    // steep rocky fall on the far (east) side
    h *= Math.pow(1 - smoothstep(560, W, s), 0.62);
    for (const p of I.pools) h -= p.d * bump((s - p.c) / p.w);
    return Math.max(0, h);
  };
  I.hLand = hLand;
  const under = underProfile(77, 52, 0.22, 10, 0.5, 0.12);
  tabulate(G, I, hLand, under);
  I.safe = [I.towerX - 125, I.towerX + 125];
  placeProps(I, I.def, seeded(4242));
  return I;
}

// =====================================================================================
// props (deterministic per island)
// =====================================================================================

function placeProps(I, def, rng) {
  const W = I.W, L = I.shoreL, theme = I.theme;
  const used = [];
  const free = (x, r) => used.every(([a, b]) => Math.abs(a - x) >= b + r);
  const nearCliff = (x) => I.cliff && Math.abs(x - (L + I.cliff.c)) < 30;
  const tryPlace = (s0, s1, r, maxSlope, tries = 60) => {
    for (let k = 0; k < tries; k++) {
      const x = L + lerp(s0, s1, rng());
      if (free(x, r) && slopeAt(I, x) <= maxSlope && !nearCliff(x) && -gy(I, x) > 5) { used.push([x, r]); return x; }
    }
    return null;
  };
  const P = I.props = [];
  const add = (o) => { o.isl = I; o.y = gy(I, o.x); P.push(o); return o; };

  // big set pieces claim their ground first
  let wreckX = null;
  if (theme === 'drift') { wreckX = tryPlace(W - I.beachR * 1.3, W - 36, 34, 0.5); }
  if (I.kind === 'lighthouse') {
    used.push([I.towerX, 70]);
    I.door = add({ type: 'door', key: 'door', x: I.towerX });
    I.door.act = (G) => openDoor(G, I);
  }
  // palms
  const nPalm = def.palms || 0;
  for (let i = 0; i < nPalm; i++) {
    const onBeach = i % 2 === 0;
    const x = onBeach
      ? (rng() < 0.5 ? tryPlace(I.beachL * 0.5, I.beachL * 1.3, 22, 0.45) : tryPlace(W - I.beachR * 1.3, W - I.beachR * 0.5, 22, 0.45))
      : tryPlace(I.beachL, W - I.beachR, 22, 0.45);
    if (x == null) continue;
    const h = lerp(78, 132, rng());
    const lean = (x < L + W / 2 ? -1 : 1) * lerp(0.08, 0.3, rng());
    const nf = 8 + (rng() < 0.5 ? 1 : 0);
    const fa = [], fl = [];
    for (let k = 0; k < nf; k++) {
      const u = k / (nf - 1);
      fa.push(lerp(-Math.PI + 0.12, -0.12, u) + (rng() - 0.5) * 0.25);
      fl.push(lerp(38, 56, rng()) * (h / 110 * 0.35 + 0.68));
    }
    add({ type: 'palm', key: 'p' + i, x, h, lean, bend: (rng() - 0.5) * 14, thick: lerp(0.9, 1.15, rng()), ph: rng() * TAU, fa, fl, nc: 2 + (rng() < 0.6 ? 1 : 0) + (rng() < 0.3 ? 1 : 0) });
  }
  // driftwood piles on the beaches
  for (let i = 0; i < (def.wood || 0); i++) {
    const left = i % 2 === 0;
    const onL = () => tryPlace(14, I.beachL + 20, 16, 0.5), onR = () => tryPlace(W - I.beachR - 20, W - 14, 16, 0.5);
    const x = left ? (onL() ?? onR()) : (onR() ?? onL());
    if (x == null) continue;
    const logs = [];
    const n = 2 + (rng() < 0.6 ? 1 : 0) + (rng() < 0.3 ? 1 : 0);
    for (let k = 0; k < n; k++) {
      logs.push({ dx: (rng() - 0.5) * 10, dy: -k * 2.6 - 1.4, len: lerp(14, 26, rng()), r: lerp(1.6, 2.6, rng()), rot: (rng() - 0.5) * 0.28, knot: rng() });
    }
    add({ type: 'wood', key: 'w' + i, x, logs, branch: rng() < 0.6 ? (rng() - 0.5) * 2 : 0 });
  }
  // rocks to knock stones off
  for (let i = 0; i < (def.rocks || 0); i++) {
    const x = tryPlace(I.beachL * 0.7, W - I.beachR * 0.7, 18, 0.5);
    if (x == null) continue;
    add({ type: 'rock', key: 'r' + i, x, w: lerp(17, 26, rng()), h: lerp(11, 17, rng()), poly: rockPoly(rng, 13), moss: rng() });
  }
  // berry bushes
  for (let i = 0; i < (def.bushes || 0); i++) {
    const x = tryPlace(I.beachL * 0.9, W - I.beachR * 0.9, 18, 0.55);
    if (x == null) continue;
    const blobs = [];
    const nb = 6 + Math.floor(rng() * 3);
    for (let k = 0; k < nb; k++) {
      const a = lerp(Math.PI * 1.05, Math.PI * 1.95, k / (nb - 1));
      blobs.push({ dx: Math.cos(a) * lerp(6, 10, rng()), dy: Math.sin(a) * lerp(4, 8, rng()) - 3, r: lerp(4.5, 7.5, rng()) });
    }
    blobs.push({ dx: 0, dy: -9, r: 8 });
    const berries = [];
    for (let k = 0; k < 11; k++) berries.push({ dx: (rng() - 0.5) * 20, dy: -2 - rng() * 13, r: lerp(1.1, 1.7, rng()) });
    add({ type: 'bush', key: 'b' + i, x, blobs, berries, ph: rng() * TAU });
  }
  // one chest per island
  if (I.kind === 'normal') {
    const x = tryPlace(I.beachL * 0.75, W - I.beachR * 0.75, 20, 0.35) || tryPlace(20, W - 20, 16, 0.6, 100);
    if (x != null) { const sx = x - L; I.chest = add({ type: 'chest', key: 'c', x, tilt: (rng() - 0.5) * 0.16, sunk: lerp(2, 4, rng()), onSand: sx < I.beachL * 1.05 || sx > W - I.beachR * 1.05 }); }
  }
  for (const p of P) {
    if (p.type === 'palm') p.act = (G) => harvest(G, I, p);
    else if (p.type === 'wood' || p.type === 'rock' || p.type === 'bush') p.act = (G) => harvest(G, I, p);
    else if (p.type === 'chest') p.act = (G) => openChest(G, I, p);
  }

  // ---- static decoration (baked into the land canvas)
  I.deco = [];
  const deco = (type, s0, s1, r, extra) => { const x = tryPlace(s0, s1, r, 0.5); if (x != null) I.deco.push(Object.assign({ type, x, y: gy(I, x) }, extra || {})); };
  if (theme === 'palms') { if (I.chest) { const x = I.chest.x + 34 * (I.chest.x < L + W / 2 ? 1 : -1); if (free(x, 10)) { used.push([x, 12]); I.deco.push({ type: 'firepit', x, y: gy(I, x) }); } } deco('tally', I.beachL, W - I.beachR, 10); }
  if (theme === 'drift') { if (wreckX != null) I.deco.push({ type: 'wreck', x: wreckX, y: gy(I, wreckX) }); deco('oar', 20, I.beachL, 10); }
  if (theme === 'rocky') { deco('cairn', I.beachL, W - I.beachR, 10); deco('tally', I.beachL, W - I.beachR, 10); }
  if (theme === 'forest') { deco('leanto', I.beachL, W - I.beachR, 22); deco('firepit', I.beachL, W - I.beachR, 12); }
  if (theme === 'chimes') { deco('sign', W - I.beachR * 1.6, W - I.beachR * 0.7, 12); }
  if (theme === 'lighthouse') { I.deco.push({ type: 'hut', x: I.towerX - 62, y: gy(I, I.towerX - 62) }); }
  // chime frames swing per frame (wind)
  I.chimes = [];
  if (theme === 'chimes') {
    for (let k = 0; k < 2; k++) {
      const x = tryPlace(I.beachL, W - I.beachR, 22, 0.45);
      if (x == null) continue;
      const strings = [];
      for (let j = 0; j < 5; j++) strings.push({ dx: lerp(-15, 15, j / 4) + (rng() - 0.5) * 2, len: lerp(12, 22, rng()), n: 2 + Math.floor(rng() * 3), ph: rng() * TAU, glass: rng() < 0.4 });
      I.chimes.push({ x, y: gy(I, x), w: 36, h: lerp(40, 48, rng()), strings });
    }
  }

  // ---- back trees (the tree line), baked into the back canvas
  const T = I.trees = [];
  const mix = {
    palms: [0.5, 0.45, 0.05, 0], drift: [0.3, 0.58, 0.12, 0], rocky: [0.2, 0.3, 0.1, 0.4], forest: [0.08, 0.72, 0.2, 0],
    chimes: [0.38, 0.47, 0.15, 0], lighthouse: [0, 0.25, 0.15, 0.6],
  }[theme];
  const spacing = theme === 'forest' ? [14, 26] : theme === 'rocky' || theme === 'lighthouse' ? [34, 64] : [18, 36];
  for (let s = I.beachL * 0.62 + rng() * 10; s < W - I.beachR * 0.62; s += lerp(spacing[0], spacing[1], rng())) {
    const x = L + s;
    if (I.kind === 'lighthouse' && Math.abs(x - I.towerX) < 60) continue;
    if (I.kind === 'lighthouse' && s > W - 120) continue;
    const r = rng();
    let type = 'broad';
    if (r < mix[0]) type = 'palm'; else if (r < mix[0] + mix[1]) type = 'broad'; else if (r < mix[0] + mix[1] + mix[2]) type = 'dead'; else type = 'shrub';
    const big = theme === 'forest' ? 1.25 : theme === 'rocky' ? 0.8 : 1;
    const edge = Math.min(1, (s - I.beachL * 0.5) / 120, (W - I.beachR * 0.5 - s) / 120);
    const hh = { palm: lerp(80, 140, rng()), broad: lerp(70, 150, rng()) * big, dead: lerp(70, 130, rng()) * big, shrub: lerp(18, 34, rng()) }[type] * lerp(0.6, 1, clamp(edge, 0, 1));
    T.push({ type, x, base: gy(I, x) + lerp(3, 8, rng()), h: hh, lean: (rng() - 0.5) * 0.24, seed: Math.floor(rng() * 1e6), depth: rng() });
  }
  T.sort((a, b) => a.depth - b.depth);
  I.treeTop = 0;
  for (const t of T) I.treeTop = Math.min(I.treeTop, t.base - t.h * 1.25 - 20);

  // ---- a far hazy peak / ridge behind the tree line (per frame, parallax)
  const far = I.far = [];
  const peakH = { palms: 70, drift: 120, rocky: 220, forest: 165, chimes: 105, lighthouse: 0 }[theme] || 100;
  const pc = lerp(0.38, 0.62, rng()) * W, pw = W * lerp(0.3, 0.42, rng());
  const jag = theme === 'rocky' ? 1 : 0.35;
  for (let s = I.beachL * 0.35; s <= W - I.beachR * 0.35; s += 8) {
    const x = L + s;
    const e = smoothstep(0, 1, clamp(Math.min((s - I.beachL * 0.35) / 110, (W - I.beachR * 0.35 - s) / 110), 0, 1));
    const ridge = peakH * Math.pow(bump((s - pc) / pw), 0.75) + (fbm1(x * 0.018, 3, I.seed + 31) - 0.3) * 50 + (noise1(x * 0.09, I.seed + 32) - 0.5) * 22 * jag;
    const hgt = Math.max(-gy(I, x) * 0.9 + 30, I.maxH * 0.55 + ridge) * e;
    far.push([x, -hgt]);
  }
  if (theme === 'lighthouse') far.length = 0;

  // ---- foreground grass and leaves (per frame, in front of the boy)
  const F = I.front = [];
  for (let s = 24 + rng() * 20; s < W - 24; s += lerp(36, 82, rng())) {
    const x = L + s;
    const h0 = -gy(I, x);
    if (h0 < 4.5 || slopeAt(I, x) > 0.9 || nearCliff(x)) continue;
    if (I.kind === 'lighthouse' && Math.abs(x - I.towerX) < 40) continue;
    const beach = s < I.beachL * 0.9 || s > W - I.beachR * 0.9;
    const blades = [];
    const nb = beach ? 4 + Math.floor(rng() * 4) : 6 + Math.floor(rng() * 7);
    for (let k = 0; k < nb; k++) {
      blades.push({ dx: (rng() - 0.5) * (beach ? 10 : 16), h: (beach ? lerp(6, 12, rng()) : lerp(7, 18, rng())) * (theme === 'forest' ? 1.2 : 1), lean: (rng() - 0.5) * 0.9, w: lerp(1.1, 2, rng()), alt: rng() < 0.35 });
    }
    const leaf = !beach && rng() < (theme === 'forest' ? 0.55 : 0.3) ? { a: (rng() < 0.5 ? -1 : 1), len: lerp(12, 20, rng()) } : null;
    F.push({ x, beach, blades, leaf, ph: rng() * TAU });
  }

  // ---- glowing mushrooms, fireflies, crabs
  I.mush = [];
  const nm = theme === 'forest' ? 8 : theme === 'lighthouse' ? 0 : 4;
  for (let k = 0; k < nm; k++) {
    const x = L + lerp(I.beachL, W - I.beachR, rng());
    if (slopeAt(I, x) > 0.7) continue;
    const caps = [];
    const nc = 2 + Math.floor(rng() * 3);
    for (let j = 0; j < nc; j++) caps.push({ dx: (rng() - 0.5) * 7, h: lerp(2, 5, rng()), r: lerp(1.2, 2.4, rng()) });
    I.mush.push({ x, y: gy(I, x), caps, ph: rng() * TAU });
  }
  // pairs of eyes deep in the tree line at night (they close when you come near)
  I.watch = [];
  const nw = theme === 'forest' ? 6 : theme === 'lighthouse' ? 1 : 3;
  for (let k = 0; k < nw; k++) {
    const x = L + lerp(I.beachL * 1.1, W - I.beachR * 1.1, rng());
    I.watch.push({ x, y: gy(I, x) - lerp(14, 46, rng()), ph: rng() * TAU, sp: lerp(0.09, 0.16, rng()), gap: lerp(2.4, 4, rng()), s: lerp(0.8, 1.3, rng()) });
  }
  // low mist that drifts through the trees after dark
  I.mist = [];
  const nmist = theme === 'forest' ? 9 : 6;
  for (let k = 0; k < nmist; k++) I.mist.push({ u: rng(), w: lerp(80, 170, rng()), h: lerp(18, 32, rng()), sp: lerp(2, 6, rng()) * (rng() < 0.5 ? 1 : -1), dy: lerp(-6, 6, rng()), a: lerp(0.6, 1, rng()) });
  I.flies = [];
  const nfl = theme === 'lighthouse' ? 4 : 12;
  for (let k = 0; k < nfl; k++) {
    const x = L + lerp(I.beachL * 0.8, W - I.beachR * 0.8, rng());
    I.flies.push({ x, y: gy(I, x) - lerp(8, 48, rng()), ax: lerp(6, 18, rng()), ay: lerp(3, 9, rng()), sx: lerp(0.2, 0.5, rng()), sy: lerp(0.3, 0.7, rng()), ph: rng() * TAU, bl: lerp(0.6, 1.4, rng()) });
  }
  I.crabZones = [[L + 8, L + I.beachL * 0.95], [L + W - I.beachR * 0.95, L + W - 8]];
  I.nCrabs = def.crabs || 2;
  I.crabSeed = I.seed * 31 + 7;
}

// Irregular rock outline: points on a unit half-ellipse (y ≤ 0 is up), flattened base.
function rockPoly(rng, n) {
  const pts = [];
  for (let k = 0; k <= n; k++) {
    const a = Math.PI + (k / n) * Math.PI;
    const r = 1 + (rng() - 0.5) * 0.28;
    pts.push([Math.cos(a) * r, Math.sin(a) * r * (0.85 + rng() * 0.2)]);
  }
  return pts;
}

// =====================================================================================
// runtime state
// =====================================================================================

export function init(G) {
  ensureStatic(G);
  if (!G.persist) G.persist = { islands: {}, flags: {} };
  if (!G.persist.islands) G.persist.islands = {};
  if (!G.persist.flags) G.persist.flags = {};
  G.islands = ISL.map((I) => ({ id: I.id, x0: I.x0, x1: I.x1, kind: I.kind, cx: I.cx, name: I.name, shoreL: I.shoreL, shoreR: I.shoreR }));
  G.beasts = [];
  G.islandsRt = {
    beast: null, crabs: {}, anim: {}, falls: [],
    spawnT: 1.2, away: 0, wasNight: isNight(G), duskDay: -1,
    boyIsl: -1, hbT: 0,
  };
}

function RT(G) { if (!G.islandsRt) init(G); return G.islandsRt; }

function pget(G, I) { const a = G.persist && G.persist.islands; return (a && a[I.id]) || null; }
function pset(G, I) {
  if (!G.persist) G.persist = { islands: {}, flags: {} };
  const a = G.persist.islands || (G.persist.islands = {});
  const s = a[I.id] || (a[I.id] = { v: 0, c: 0, t: {} });
  if (!s.t) s.t = {};
  return s;
}
function available(G, I, p) {
  const s = pget(G, I);
  if (p.type === 'chest') return !(s && s.c);
  const t = s && s.t && s.t[p.key];
  if (t == null) return true;
  const days = REGROW[p.type] || 0;
  return days > 0 && G.time - t >= days * DAY;
}
// 0..1 regrowth progress (1 = ready), for drawing small green coconuts / sparse berries
function regrowth(G, I, p) {
  const s = pget(G, I);
  const t = s && s.t && s.t[p.key];
  if (t == null) return 1;
  const days = REGROW[p.type] || 1;
  return clamp((G.time - t) / (days * DAY), 0, 1);
}
function anim(G, key) { const A = RT(G).anim; return A[key] || (A[key] = { shake: 0, open: 0, hit: 0 }); }

// =====================================================================================
// public queries
// =====================================================================================

export function groundAt(G, x) {
  const L = ISL || ensureStatic(G);
  for (let i = 0; i < L.length; i++) {
    const I = L[i];
    if (x < I.x0) return null;
    if (x <= I.x1) return gy(I, x);
  }
  return null;
}

// The island whose span contains x (land + underwater slopes), or null.
export function islandAt(G, x) {
  const L = ISL || ensureStatic(G);
  for (let i = 0; i < L.length; i++) {
    const I = L[i];
    if (x < I.x0) return null;
    if (x <= I.x1) return I.info;
  }
  return null;
}

function islandIndexAt(x) {
  if (!ISL) return -1;
  for (let i = 0; i < ISL.length; i++) { const I = ISL[i]; if (x >= I.x0 && x <= I.x1) return i; }
  return -1;
}

// Is the boy standing (or walking / jumping) on dry land of an island? → index or -1
function boyIsland(G) {
  const P = G.player;
  if (!P || !Number.isFinite(P.x) || !Number.isFinite(P.y) || P.dead) return -1;
  const i = islandIndexAt(P.x);
  if (i < 0) return -1;
  const I = ISL[i];
  if (P.x < I.shoreL - 2 || P.x > I.shoreR + 2) return -1;
  if (P.onRaft || P.inWater) return -1;
  const g = gy(I, P.x);
  if (g > -2) return -1;                             // at the water's edge or wading: not ashore
  if (P.onIsland) return i;
  if (P.y <= g + 3 && P.y > g - 70) return i;        // on the ground or hopping over it
  return -1;
}

function lanternLit(G) {
  const P = G.player;
  if (P && P.lantern === true) return true;
  return !!(G.inv && G.inv.lantern > 0 && isNight(G));
}

// =====================================================================================
// update
// =====================================================================================

export function update(G, dt) {
  const L = ensureStatic(G);
  const rt = RT(G);
  const P = G.player;
  const v = G.view;
  const camX = G.cam ? G.cam.x : P.x;
  const night = isNight(G);

  // which islands matter this step
  const near = [];
  for (const I of L) if (I.x1 > camX - 1400 && I.x0 < camX + 1400) near.push(I);

  // ---- the boy ashore: first landing, dusk warning
  const bi = G.demo ? -1 : boyIsland(G);
  rt.boyIsl = bi;
  if (bi >= 0) {
    const I = L[bi];
    const st = pget(G, I);
    if (!st || !st.v) {
      const s = pset(G, I);
      s.v = 1;
      const [line, entry] = LANDING[Math.min(bi, LANDING.length - 1)];
      say(G, line, 'story');
      journal(G, entry);
    }
    if (!night && G.phase > 0.52 && G.phase < C.NIGHT_START && rt.duskDay !== G.day) {
      rt.duskDay = G.day;
      say(G, '天快黑了……岛上好像有什么东西', 'warn');
    }
  }

  // ---- interactables for islands near the boy
  if (!G.demo && P && Number.isFinite(P.x)) {
    for (const I of near) {
      if (P.x < I.shoreL - 160 || P.x > I.shoreR + 160) continue;
      for (const p of I.props) {
        if (Math.abs(p.x - P.x) > 90) continue;
        if (p.type === 'door') { addInteract(G, p.x, p.y - 13, 30, '推开灯塔的门', p.act, 2); continue; }
        if (!available(G, I, p)) continue;
        if (p.type === 'palm') addInteract(G, p.x + p.lean * 10, p.y - 14, 26, '摇椰子', p.act, 0);
        else if (p.type === 'wood') addInteract(G, p.x, p.y - 8, 24, '捡木头', p.act, 0);
        else if (p.type === 'rock') addInteract(G, p.x, p.y - 9, 24, '敲石头', p.act, 0);
        else if (p.type === 'bush') addInteract(G, p.x, p.y - 9, 24, '摘野果', p.act, 0);
        else if (p.type === 'chest') addInteract(G, p.x, p.y - 8, 24, '打开箱子', p.act, 1);
      }
    }
  }

  // ---- animations, falling coconuts, crabs
  for (const k in rt.anim) {
    const a = rt.anim[k];
    a.shake = Math.max(0, a.shake - dt * 1.4);
    a.hit = Math.max(0, a.hit - dt * 3);
    if (a.opening) a.open = Math.min(1, a.open + dt * 1.6);
  }
  updateFalls(G, rt, dt);
  for (const I of near) updateCrabs(G, rt, I, dt);

  // ---- night life: fireflies and glowing mushrooms (lights)
  const nk = nightK(G);
  if (nk > 0.35 && v && v.w > 1) {
    let budget = 7;
    for (const I of near) {
      if (I.x1 < v.left - 50 || I.x0 > v.left + v.w + 50) continue;
      for (const m of I.mush) {
        if (budget <= 0) break;
        if (!onScreen(G, m.x, m.y, 30)) continue;
        addLight(G, m.x, m.y - 3, 22, [110, 220, 255], 0.38 * smoothstep(0.35, 0.9, nk) * (0.8 + 0.2 * Math.sin(G.time * 1.3 + m.ph)));
        budget--;
      }
    }
    let fb = 8;
    for (const I of near) {
      if (I.x1 < v.left - 50 || I.x0 > v.left + v.w + 50) continue;
      for (const f of I.flies) {
        if (fb <= 0) break;
        const p = flyPos(f, G.time);
        if (p.b < 0.35 || !onScreen(G, p.x, p.y, 10)) continue;
        addLight(G, p.x, p.y, 11, [220, 255, 150], 0.45 * p.b * smoothstep(0.35, 0.8, nk));
        fb--;
      }
    }
  }

  // ---- eyes in the tree line
  if (nk > 0.6 && v && v.w > 1 && !G.demo) {
    let wb = 4;
    for (const I of near) {
      if (I.x1 < v.left - 50 || I.x0 > v.left + v.w + 50) continue;
      for (const w of I.watch) {
        if (wb <= 0) break;
        const k = watcherOpen(G, w);
        if (k < 0.1 || !onScreen(G, w.x, w.y, 10)) continue;
        addLight(G, w.x, w.y, 7 * w.s, [200, 226, 255], 0.45 * k);
        wb--;
      }
    }
  }

  // ---- the lighthouse lamp at night (a real light for the darkness pass)
  const LH = L[L.length - 1];
  if (v && v.w > 1) {
    const lamp = towerLamp(LH);
    const d = Math.abs(lamp.x - camX);
    const on = lampOn(G);
    if (on > 0.02 && d < 1500) {
      const k = beamK(G, d);
      addLight(G, lamp.x, lamp.y, 110, [255, 220, 150], 0.95 * on * (1 - smoothstep(900, 1500, d)));
      const th = G.time * 0.9;
      for (const sgn of [1, -1]) {
        const c = Math.cos(th) * sgn;
        if (c < 0.15) continue;
        const len = 1600 * c;
        for (let j = 1; j <= 4; j++) {
          const bx = lamp.x + sgn * len * j / 4.4, by = lamp.y + len * j / 4.4 * 0.05;
          if (!onScreen(G, bx, by, 160)) continue;
          addLight(G, bx, by, 70 + 25 * j, [255, 226, 170], 0.32 * k * c * (1 - j * 0.15));
        }
      }
    }
  }

  // ---- the night beast
  if (!G.demo) updateBeastLife(G, rt, dt, bi, night);
  rt.wasNight = night;

  // ---- art caches: build ahead of time, release far ones
  manageCaches(G, camX);
}

// ------------------------------------------------------------------ harvesting
function harvest(G, I, p) {
  if (!available(G, I, p)) return;
  const s = pset(G, I);
  s.t[p.key] = Math.round(G.time);
  const a = anim(G, I.id + ':' + p.key);
  const P = G.player;
  if (p.type === 'palm') {
    a.shake = 1;
    const n = 1 + (Math.random() < 0.5 ? 1 : 0);
    give(G, 'coconut', n);
    if (Math.random() < 0.45) give(G, 'leaf', 1 + (Math.random() < 0.3 ? 1 : 0));
    const top = palmTop(p, G.time, 0);
    const rt = RT(G);
    for (let k = 0; k < n; k++) rt.falls.push({ kind: 'coconut', x: top.x + rnd(-3, 3), y: top.y + 3, vx: rnd(-14, 14), vy: rnd(-10, 10), t: 0, life: 2.4, rot: 0, vr: rnd(-6, 6), isl: I.idx });
    for (let k = 0; k < 6; k++) emit(G, { x: top.x + rnd(-14, 14), y: top.y + rnd(-6, 4), vx: rnd(-16, 16), vy: rnd(-10, 6), life: rnd(1.2, 2.2), size: rnd(1, 2.2), color: [92, 128, 72], alpha: 0.85, gravity: 40, drag: 1.8, water: 'above' });
    play('pickup', { volume: 0.7 });
  } else if (p.type === 'wood') {
    give(G, 'wood', 2 + (Math.random() < 0.5 ? 1 : 0));
    for (let k = 0; k < 8; k++) emit(G, { x: p.x + rnd(-10, 10), y: p.y - 2, vx: rnd(-20, 20), vy: rnd(-30, -8), life: rnd(0.5, 1), size: rnd(0.8, 1.6), color: [214, 196, 160], alpha: 0.7, gravity: 160, drag: 1 });
    play('pickup');
  } else if (p.type === 'rock') {
    a.hit = 1;
    give(G, 'stone', 1 + (Math.random() < 0.5 ? 1 : 0));
    G.shake = (G.shake || 0) + 0.12;
    for (let k = 0; k < 12; k++) emit(G, { x: p.x + rnd(-6, 6), y: p.y - p.h * 0.6, vx: rnd(-55, 55), vy: rnd(-90, -30), life: rnd(0.5, 1), size: rnd(0.9, 2), color: [150, 146, 136], alpha: 0.95, gravity: 420, drag: 0.6 });
    play('hammer');
  } else if (p.type === 'bush') {
    a.shake = 0.7;
    give(G, 'berry', 2 + (Math.random() < 0.5 ? 1 : 0));
    for (let k = 0; k < 5; k++) emit(G, { x: p.x + rnd(-9, 9), y: p.y - rnd(4, 14), vx: rnd(-12, 12), vy: rnd(-14, 4), life: rnd(0.8, 1.6), size: rnd(1, 1.8), color: [74, 116, 66], alpha: 0.8, gravity: 50, drag: 2 });
    play('pickup');
  }
  if (P) P.facing = p.x >= P.x ? 1 : -1;
}

function openChest(G, I, p) {
  if (!available(G, I, p)) return;
  const s = pset(G, I);
  s.c = 1;
  const a = anim(G, I.id + ':c');
  a.opening = true;
  const loot = { metal: 1 + (Math.random() < 0.5 ? 1 : 0), cloth: 1 + (Math.random() < 0.5 ? 1 : 0), rope: 1 + (Math.random() < 0.5 ? 1 : 0) };
  let total = loot.metal + loot.cloth + loot.rope;
  const extras = ['can', 'plastic', 'bandage', 'rope', 'metal'];
  while (total < 4 || (total < 6 && Math.random() < 0.45)) {
    const id = extras[Math.floor(Math.random() * extras.length)];
    loot[id] = (loot[id] || 0) + 1; total++;
  }
  const parts = [];
  for (const id in loot) { give(G, id, loot[id], true); parts.push(itemName(id) + '×' + loot[id]); }
  say(G, '箱子里有：' + parts.join('、'), 'pickup');
  journal(G, PAGES[Math.min(I.idx, PAGES.length - 1)]);
  say(G, '箱底压着一页旧日记……（按 J 查看）', 'story');
  for (let k = 0; k < 14; k++) emit(G, { x: p.x + rnd(-7, 7), y: p.y - 9, vx: rnd(-12, 12), vy: rnd(-34, -12), life: rnd(1, 2), size: rnd(1, 2.4), color: [255, 214, 150], alpha: 0.7, kind: 'glow', drag: 1.5, water: 'above' });
  play('pickup', { volume: 0.9 });
  const P = G.player;
  if (P) P.facing = p.x >= P.x ? 1 : -1;
}

function openDoor(G, I) {
  if (isNight(G)) { say(G, '门锁着……等天亮再来吧。'); play('ui'); return; }
  journal(G, '推开了灯塔沉重的木门。石阶一圈一圈地盘上去，一直通到光里。');
  play('ui');
  G.mode = 'ending';
}

// ------------------------------------------------------------------ falling things
function updateFalls(G, rt, dt) {
  const F = rt.falls;
  let w = 0;
  for (let i = 0; i < F.length; i++) {
    const f = F[i];
    f.t += dt;
    if (f.t > f.life) continue;
    const I = ISL[f.isl];
    f.vy += 520 * dt;
    f.x += f.vx * dt; f.y += f.vy * dt; f.rot += f.vr * dt;
    const g = gy(I, f.x) - 2.4;
    if (f.y > g) {
      f.y = g;
      if (f.vy > 60) { f.vy *= -0.35; f.vx *= 0.6; f.vr *= 0.5; play('step', { volume: 0.25 }); } else { f.vy = 0; f.vx *= 0.85; f.vr *= 0.8; }
    }
    F[w++] = f;
  }
  F.length = w;
}

// ------------------------------------------------------------------ hermit crabs
const CAPS = [[196, 52, 48], [52, 96, 170], [70, 150, 88], [226, 186, 64], [236, 236, 230], [150, 70, 150]];

function updateCrabs(G, rt, I, dt) {
  let list = rt.crabs[I.id];
  if (!list) {
    list = rt.crabs[I.id] = [];
    const rng = seeded(I.crabSeed);
    for (let k = 0; k < I.nCrabs; k++) {
      const z = I.crabZones[k % 2];
      list.push({ x: lerp(z[0], z[1], rng()), z: k % 2, dir: rng() < 0.5 ? -1 : 1, st: 'idle', t: rng() * 2, hide: 0, ph: rng() * 10, cap: CAPS[Math.floor(rng() * CAPS.length)], s: lerp(0.85, 1.15, rng()), face: rng() < 0.5 ? -1 : 1 });
    }
  }
  const P = G.player;
  for (const c of list) {
    const z = I.crabZones[c.z];
    c.t -= dt;
    const d = P ? Math.abs(P.x - c.x) : 999;
    const close = d < 30 && P && Math.abs(P.y - gy(I, c.x)) < 30;
    if (close && c.st !== 'hide' && c.st !== 'flee') { c.st = 'hide'; c.t = rnd(1.5, 3); }
    if (c.st === 'hide') {
      c.hide = Math.min(1, c.hide + dt * 8);
      if (c.t <= 0) { if (d < 34) { c.st = 'flee'; c.dir = P && P.x > c.x ? -1 : 1; c.t = rnd(1, 2); } else { c.st = 'idle'; c.t = rnd(0.6, 2); } }
    } else {
      c.hide = Math.max(0, c.hide - dt * 3);
      if (c.st === 'walk' || c.st === 'flee') {
        const sp = c.st === 'flee' ? 30 : 13;
        c.x += c.dir * sp * dt * c.s;
        c.ph += dt * (c.st === 'flee' ? 26 : 14);
        if (c.x < z[0]) { c.x = z[0]; c.dir = 1; }
        if (c.x > z[1]) { c.x = z[1]; c.dir = -1; }
        if (c.t <= 0) { c.st = 'idle'; c.t = rnd(1, 4); }
      } else if (c.t <= 0) { c.st = 'walk'; c.dir = Math.random() < 0.5 ? -1 : 1; c.t = rnd(0.8, 2.6); }
    }
    if (!G.demo && !G.codex.crab && c.hide < 0.5 && onScreen(G, c.x, gy(I, c.x), -40)) discover(G, 'crab');
  }
}

// ------------------------------------------------------------------ watchers in the dark
function watcherOpen(G, w) {
  const nk = nightK(G);
  if (nk < 0.6) return 0;
  const rt = G.islandsRt;
  if (rt && rt.beast && Math.abs(rt.beast.x - w.x) < 140) return 0;
  const P = G.player;
  const near = P ? clamp((Math.abs(P.x - w.x) - 70) / 80, 0, 1) : 1;      // they close as you come close
  const on = smoothstep(0.55, 0.75, Math.sin(G.time * w.sp + w.ph));
  const blink = Math.sin(G.time * 2.3 + w.ph * 5) > 0.97 ? 0.1 : 1;
  return on * near * blink * smoothstep(0.6, 0.9, nk);
}

// ------------------------------------------------------------------ fireflies
function flyPos(f, t) {
  const x = f.x + Math.sin(t * f.sx + f.ph) * f.ax + Math.sin(t * f.sx * 2.3 + f.ph * 1.7) * f.ax * 0.3;
  const y = f.y + Math.sin(t * f.sy + f.ph * 0.7) * f.ay;
  const b = Math.pow(Math.max(0, Math.sin(t * f.bl + f.ph * 3)), 2);
  return { x, y, b };
}

// =====================================================================================
// the night beast
// =====================================================================================

function updateBeastLife(G, rt, dt, bi, night) {
  if (rt.away > 0) rt.away -= dt;
  let B = rt.beast;
  if (!B) {
    if (night && bi >= 0 && rt.away <= 0) {
      rt.spawnT -= dt;
      if (rt.spawnT <= 0) B = spawnBeast(G, ISL[bi], G.player.x);
    } else rt.spawnT = rt.wasNight || !night ? rnd(1.0, 1.6) : rnd(1.2, 2.0);
  }
  if (!B) { G.beasts = []; return; }
  updateBeast(G, rt, B, dt, bi, night);
  G.beasts = rt.beast ? [rt.beast] : [];
}

function beastRange(I, x) {
  let a = I.dryL + 4, b = I.dryR - 4;
  if (I.safe) { if (x < (I.safe[0] + I.safe[1]) / 2) b = Math.min(b, I.safe[0]); else a = Math.max(a, I.safe[1]); }
  return [a, b];
}

function spawnBeast(G, I, nearX, debug) {
  const rt = RT(G);
  const [a0, b0] = beastRange(I, nearX < (I.dryL + I.dryR) / 2 ? I.dryL + 30 : I.dryR - 30);
  let a = a0, b = b0;
  if (I.safe && nearX > I.safe[0] && nearX < I.safe[1]) { a = I.dryL + 4; b = I.safe[0]; }
  if (b - a < 40) { a = I.dryL + 4; b = I.dryR - 4; }
  // a spot in the tree line, a good distance from the boy
  let best = null, bestS = -1e9;
  const cands = I.trees.length ? I.trees.map((t) => t.x) : [];
  for (let k = 0; k < 12; k++) cands.push(lerp(a, b, k / 11));
  // come out on the far side from the boy's nearest shore, so the sea stays an escape
  const escape = nearX - I.dryL < I.dryR - nearX ? -1 : 1;
  for (const x of cands) {
    if (x < a || x > b) continue;
    const d = Math.abs(x - nearX);
    const want = debug ? 170 : 270;
    let s = -Math.abs(d - want);
    if (d < 120) s -= 400;
    if (Math.sign(x - nearX) === escape) s -= 150;
    if (!onScreenX(G, x)) s -= 60;
    if (s > bestS) { bestS = s; best = x; }
  }
  if (best == null) best = clamp(nearX + 200, a, b);
  const B = {
    isl: I.idx, x: best, y: gy(I, best), vx: 0, f: nearX > best ? 1 : -1, st: 'emerge', stT: 0, t: rnd(0, 10),
    alpha: 0, eyes: 0, rise: 0, crouch: 0.6, lean: 0, jaw: 0, headTilt: 0, reachK: 0,
    phF: 0, phH: 0.3, handN: null, handF: null, chargeCD: 1.4, braveT: 0, hesT: 0, flinches: 0,
    mistT: 0.8, growlT: rnd(5, 9), home: best, blinkT: rnd(2, 5), blink: 0, third: 0, thirdT: rnd(3, 8),
    pauseT: 0, listenT: rnd(3, 6), dir: 1, debugT: debug ? 40 : 0, hitT: 0, seen: false, away: false,
  };
  rt.beast = B;
  for (let k = 0; k < 10; k++) emit(G, { x: best + rnd(-24, 24), y: B.y - rnd(30, 90), vx: rnd(-20, 20), vy: rnd(-6, 10), life: rnd(1.4, 2.4), size: rnd(1, 2), color: [40, 60, 52], alpha: 0.9, gravity: 30, drag: 1.5, water: 'above' });
  return B;
}
function onScreenX(G, x) { const v = G.view; return v && x > v.left + 30 && x < v.left + v.w - 30; }

function setState(B, st) { B.st = st; B.stT = 0; }

function updateBeast(G, rt, B, dt, bi, night) {
  const I = ISL[B.isl];
  const P = G.player;
  B.t += dt; B.stT += dt;
  if (B.debugT > 0) B.debugT -= dt;
  const active = night || B.debugT > 0;
  const [a, b] = beastRange(I, B.x);
  const reach = bi === B.isl && P.x >= a - 8 && P.x <= b + 8 && !P.dead && G.mode === 'play';
  const dx = P.x - B.x, dist = Math.abs(dx);
  const lamp = lanternLit(G);
  B.chargeCD -= dt; B.braveT -= dt; B.hitT -= dt;

  if (!active && B.st !== 'retreat') setState(B, 'retreat');
  if (B.st !== 'retreat' && (dist > 1300 || (bi >= 0 && bi !== B.isl))) setState(B, 'retreat');

  let targetV = 0, accel = 260;
  let crouch = 0.3, lean = 0, jaw = 0, tilt = 0, reachK = 0;
  const face = () => { if (dist > 3) B.f = dx > 0 ? 1 : -1; };
  // the lantern: hesitate and keep away for a few seconds at a time
  const canFear = lamp && reach && dist < 120 && B.braveT <= 0 && (B.st === 'stalk' || B.st === 'windup' || B.st === 'recover');
  if (canFear) {
    setState(B, 'hesitate');
    B.hesT = rnd(3, 4.5);
    play('beast', { volume: 0.45, x: B.x });
    const fl = G.persist.flags || (G.persist.flags = {});
    if (!fl.beastLight) { fl.beastLight = 1; say(G, '它怕提灯的光……', 'info'); }
  }

  switch (B.st) {
    case 'emerge': {
      face();
      B.rise = smoothstep(0.7, 2.5, B.stT);
      B.alpha = smoothstep(0.55, 2.1, B.stT);
      B.eyes = B.stT > 0.25 ? Math.min(1, (B.stT - 0.25) * 3) : 0;
      crouch = lerp(1, 0.35, B.rise);
      if (B.stT - dt < 0.85 && B.stT >= 0.85) play('beast', { volume: 0.6, x: B.x });
      if (B.stT > 2.7) setState(B, reach ? 'stalk' : 'shore');
      break;
    }
    case 'stalk': {
      if (!reach) { setState(B, 'shore'); break; }
      face();
      B.listenT -= dt;
      if (B.listenT <= 0) { B.pauseT = rnd(0.7, 1.3); B.listenT = rnd(3.5, 7); }
      if (B.pauseT > 0) { B.pauseT -= dt; tilt = Math.sin(B.stT * 2) * 0.5 + 0.4; targetV = 0; }
      else targetV = B.f * (dist > 220 ? 50 : 40);
      lean = 0.3;
      if (dist < 150 && B.chargeCD <= 0 && Math.abs(P.y - B.y) < 80) {
        setState(B, 'windup'); B.dir = B.f;
        play('beast', { volume: 1, x: B.x });
        const fl = G.persist.flags || (G.persist.flags = {});
        if (!fl.beastHint) { fl.beastHint = 1; say(G, '快跑——回到水里去！它不会下水。', 'warn'); }
      }
      break;
    }
    case 'windup': {
      crouch = 1; jaw = 1; lean = -0.4; targetV = 0; accel = 600;
      if (B.stT > 0.55) { setState(B, 'charge'); B.dir = B.f; }
      break;
    }
    case 'charge': {
      B.f = B.dir;
      targetV = B.dir * 215; accel = 1100; crouch = 0.75; lean = 1; jaw = 0.8;
      const hitX = B.x + B.dir * 20;
      if (reach && B.hitT <= 0 && Math.abs(P.x - hitX) < 30 && P.y > B.y - 120 && P.y < B.y + 26) {
        try { hurtPlayer(G, BEAST_DMG, B.x, 'beast'); } catch (e) { oops('hurtPlayer', e); }
        B.hitT = 0.6;
        G.shake = (G.shake || 0) + 0.3;
        setState(B, 'recover'); B.chargeCD = rnd(1.6, 2.6);
        break;
      }
      const passed = B.dir * (P.x - B.x) < -50;
      const wall = (B.dir > 0 && B.x >= b - 1) || (B.dir < 0 && B.x <= a + 1);
      if (B.stT > 1.05 || passed || wall) { setState(B, 'recover'); B.chargeCD = rnd(1.4, 2.4); }
      break;
    }
    case 'recover': {
      targetV = 0; accel = 420; crouch = 0.7; lean = 0.4; jaw = 0.25;
      if (B.stT > 0.4) face();
      if (B.stT > 1.3) setState(B, reach ? 'stalk' : 'shore');
      break;
    }
    case 'hesitate': {
      face();
      B.hesT -= dt;
      const want = 74;
      if (dist < want) targetV = -B.f * 55; else if (dist > want + 26) targetV = B.f * 14; else targetV = 0;
      accel = 300; crouch = 0.55; lean = -0.5; tilt = -0.3;
      if (B.hesT <= 0 || !lamp || !reach) {
        if (B.hesT <= 0) B.braveT = rnd(2.5, 4);
        setState(B, reach ? 'stalk' : 'shore');
        B.chargeCD = Math.min(B.chargeCD, 0.5);
      }
      break;
    }
    case 'flinch': {
      accel = 380; targetV = 0; crouch = 0.8; lean = -0.8; jaw = 1; tilt = -0.6;
      if (B.stT > 0.9) {
        if (B.flinches >= 3) { setState(B, 'retreat'); B.flinches = 0; B.away = true; }
        else { setState(B, reach ? 'recover' : 'shore'); B.chargeCD = rnd(1.2, 2); }
      }
      break;
    }
    case 'shore': {
      if (reach && B.stT > 0.5) { setState(B, 'stalk'); break; }
      face();
      // pace up and down the edge of the dry land nearest the boy, staring at him
      const sway = 14 + Math.sin(B.stT * 0.7) * 14;
      const goal = P.x < a ? a + sway : P.x > b ? b - sway : clamp(P.x, a, b);
      const dd = goal - B.x;
      targetV = Math.abs(dd) > 4 ? sign(dd) * Math.min(42, Math.abs(dd) * 2) : 0;
      accel = 160;
      crouch = 0.45; lean = 0.2;
      // turn to stare at the boy even while pacing
      if (dist > 3) B.f = dx > 0 ? 1 : -1;
      const cyc = (B.stT % 6.5);
      reachK = dist < 200 ? smoothstep(2.2, 3.0, cyc) * (1 - smoothstep(4.4, 5.2, cyc)) : 0;
      tilt = 0.2 + Math.sin(B.stT * 0.6) * 0.15;
      break;
    }
    case 'retreat': {
      const home = B.home;
      const dd = home - B.x;
      B.f = dd > 0 ? 1 : -1;
      targetV = Math.abs(dd) > 6 ? sign(dd) * 46 : 0;
      crouch = 0.5; lean = 0.2;
      if (Math.abs(dd) < 10 || B.stT > 5) {
        B.alpha = Math.max(0, B.alpha - dt * 0.7);
        B.eyes = Math.max(0, B.eyes - dt * 0.9);
        B.rise = Math.max(0.2, B.rise - dt * 0.4);
      }
      if (B.alpha <= 0) {
        if (B.away && active) rt.away = 18;
        rt.beast = null;
        return;
      }
      break;
    }
  }

  // spear: flinch, never die
  if (G.hits && G.hits.length && B.alpha > 0.5 && B.st !== 'retreat') {
    for (const h of G.hits) {
      if (!h || h.kind !== 'spear') continue;
      const cx = B.x + B.f * 6, cy = B.y - 56;
      if (Math.hypot(h.x - cx, (h.y - cy) * 0.75) < 44 + (h.r || 0)) {
        if (B.st === 'flinch' && B.stT < 0.45) break;
        setState(B, 'flinch');
        B.flinches++;
        B.vx = (P.x > B.x ? -1 : 1) * 150;
        play('beast', { volume: 1, x: B.x });
        G.shake = (G.shake || 0) + 0.15;
        for (let k = 0; k < 8; k++) emit(G, { x: h.x + rnd(-4, 4), y: h.y + rnd(-4, 4), vx: rnd(-40, 40), vy: rnd(-50, 0), life: rnd(0.4, 0.9), size: rnd(0.8, 1.6), color: [20, 24, 32], alpha: 0.9, gravity: 200, drag: 1 });
        break;
      }
    }
  }

  // motion along the dry land only
  B.vx = approach(B.vx, targetV, accel * dt);
  let nx = B.x + B.vx * dt;
  if (B.st !== 'retreat') nx = clamp(nx, a, b);
  else nx = clamp(nx, I.dryL + 2, I.dryR - 2);
  if (nx === a || nx === b) { if (Math.abs(B.vx) > 80) { emit(G, { x: nx + B.f * 10, y: B.y - 2, vx: B.f * 30, vy: -30, life: 0.6, size: 2.5, color: [200, 200, 190], alpha: 0.4, gravity: 60, drag: 2, grow: 4 }); } B.vx *= 0.5; }
  B.x = nx;
  const g = gy(I, B.x);
  B.y += (g - B.y) * Math.min(1, dt * 14);
  const k = Math.min(1, dt * 6);
  B.crouch += (crouch - B.crouch) * k;
  B.lean += (lean - B.lean) * k;
  B.jaw += (jaw - B.jaw) * Math.min(1, dt * 10);
  B.headTilt += (tilt - B.headTilt) * Math.min(1, dt * 4);
  B.reachK += (reachK - B.reachK) * Math.min(1, dt * 3);
  if (B.st !== 'emerge' && B.st !== 'retreat') { B.alpha = Math.min(1, B.alpha + dt); B.eyes = Math.min(1, B.eyes + dt); B.rise = Math.min(1, B.rise + dt); }
  const spd = Math.abs(B.vx);
  B.phF += spd * dt * 0.62 / 24;
  B.phH += spd * dt * 0.62 / 40;

  // blinking, the third eye, breath, sounds
  B.blinkT -= dt;
  if (B.blinkT <= 0) { B.blink = 0.16; B.blinkT = rnd(2.5, 6); }
  B.blink = Math.max(0, B.blink - dt);
  B.thirdT -= dt;
  if (B.thirdT <= 0) { B.thirdT = rnd(5, 11); B.thirdOpen = rnd(1.2, 2.5); }
  if (B.thirdOpen > 0) B.thirdOpen -= dt;
  B.third += ((B.thirdOpen > 0 ? 1 : 0) - B.third) * Math.min(1, dt * 5);

  updateHands(I, B, dt);
  const pose = beastPose(B);
  const head = toWorld(B, pose.head[0], pose.head[1]);
  B.headW = head;
  B.mistT -= dt;
  if (B.mistT <= 0 && B.alpha > 0.4) {
    const heavy = B.st === 'recover' || B.st === 'windup' || B.st === 'charge';
    B.mistT = heavy ? rnd(0.35, 0.6) : rnd(1.5, 2.4);
    const m = toWorld(B, pose.head[0] + 15, pose.head[1] + 5);
    const n = heavy ? 3 : 4;
    for (let j = 0; j < n; j++) emit(G, { x: m.x, y: m.y, vx: B.f * rnd(8, 20) + rnd(-3, 3), vy: rnd(-8, -2), life: rnd(1.4, 2.2), size: rnd(2.5, 4), color: [196, 210, 230], alpha: heavy ? 0.16 : 0.12, kind: 'glow', drag: 0.8, grow: 5, water: 'above' });
  }
  B.growlT -= dt;
  if (B.growlT <= 0) { B.growlT = rnd(6, 12); if (B.alpha > 0.5 && dist < 700) play('beast', { volume: 0.35 + 0.4 * (1 - clamp(dist / 700, 0, 1)), x: B.x }); }
  // heartbeat as it gets close
  rt.hbT -= dt;
  if (B.alpha > 0.3 && dist < 340 && B.st !== 'retreat') {
    if (rt.hbT <= 0) {
      const c = clamp((dist - 50) / 290, 0, 1);
      rt.hbT = lerp(0.42, 1.2, c);
      play('heartbeat', { volume: lerp(1, 0.35, c) });
    }
  }
  // eyes glow through the dark
  if (B.eyes > 0.05) {
    const open = B.blink > 0 ? 0.15 : 1;
    const e = toWorld(B, pose.eye[0], pose.eye[1]);
    addLight(G, e.x, e.y, 15, [190, 222, 255], 0.75 * B.eyes * open);
  }
  // codex
  if (!B.seen && B.alpha > 0.45 && onScreen(G, B.x, B.y - 50, -30)) { B.seen = true; discover(G, 'island_beast'); }
}

// Local (facing +x) → world.
function toWorld(B, lx, ly) {
  const sink = (1 - B.rise) * 30;
  return { x: B.x + B.f * lx, y: B.y + ly + sink };
}

// The body's key points in local space (facing right, origin = feet centre, y up < 0).
function beastPose(B) {
  const br = Math.sin(B.t * 1.6);
  const c = B.crouch, ln = B.lean;
  const hip = [-12, -42 + c * 8];
  const hump = [-6 + ln * 6, -104 + c * 17 + br * 2];
  const sh = [12 + ln * 10, -90 + c * 17 + br * 1.4];      // the arms hang from here
  const neck = [sh[0] + 12 + ln * 2, sh[1] + 6];
  const head = [neck[0] + 12 + ln * 6, neck[1] + 17 + B.headTilt * 5 + br * 0.8];   // skull centre, hanging low
  return { br, hip, sh, hump, neck, head, eye: [head[0] + 6, head[1] - 3] };
}

// Hands: a crutch-walk on impossibly long arms by default, posed by state, smoothed.
function updateHands(I, B, dt) {
  const pose = beastPose(B);
  const sh = pose.sh;
  const lg = (lx) => gy(I, B.x + B.f * lx) - B.y;
  const gait = (ph, c) => {
    const u = frac(ph);
    const half = 22;
    if (u < 0.62) { const x = c + half * (1 - 2 * u / 0.62); return [x, lg(x)]; }
    const v = (u - 0.62) / 0.38;
    const x = lerp(c - half, c + half, v);
    return [x, lg(x) - Math.sin(v * Math.PI) * 18];
  };
  let n = gait(B.phH, sh[0] + 54), f = gait(B.phH + 0.5, sh[0] + 40);
  const hd = pose.head;
  switch (B.st) {
    case 'windup': n = [sh[0] + 34, sh[1] - 52]; f = [sh[0] + 16, sh[1] - 58]; break;
    case 'charge': n = [sh[0] + 92, sh[1] + 44]; f = [sh[0] + 80, sh[1] + 30]; break;
    case 'hesitate': n = [hd[0] + 3, hd[1] - 9]; f = [sh[0] + 24, lg(sh[0] + 24)]; break;
    case 'flinch': n = [sh[0] + 20, sh[1] - 56]; f = [sh[0] - 4, sh[1] - 50]; break;
    case 'emerge': n = [sh[0] + 40, lg(sh[0] + 40)]; f = [sh[0] + 26, lg(sh[0] + 26)]; break;
    case 'recover': n = [sh[0] + 44, lg(sh[0] + 44)]; f = [sh[0] + 30, lg(sh[0] + 30)]; break;
    case 'shore':
      if (B.reachK > 0.02) n = [lerp(n[0], sh[0] + 112, B.reachK), lerp(n[1], sh[1] + 34, B.reachK)];
      break;
  }
  if (!B.handN) { B.handN = n.slice(); B.handF = f.slice(); }
  const posed = B.st !== 'stalk' && B.st !== 'retreat' && !(B.st === 'shore' && B.reachK < 0.02);
  const r = Math.min(1, dt * (posed ? 9 : 24));
  B.handN[0] += (n[0] - B.handN[0]) * r; B.handN[1] += (n[1] - B.handN[1]) * r;
  B.handF[0] += (f[0] - B.handF[0]) * r; B.handF[1] += (f[1] - B.handF[1]) * r;
}

// Two-bone IK: returns the joint and the (reach-clamped) end point.
function ik(ax, ay, bx, by, l1, l2, bend) {
  let dx = bx - ax, dy = by - ay;
  let d = Math.hypot(dx, dy) || 0.001;
  const maxD = l1 + l2 - 0.4;
  if (d > maxD) { dx *= maxD / d; dy *= maxD / d; d = maxD; }
  const minD = Math.abs(l1 - l2) + 0.5;
  if (d < minD) d = minD;
  const a = Math.acos(clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1));
  const ang = Math.atan2(dy, dx) - bend * a;
  return [ax + Math.cos(ang) * l1, ay + Math.sin(ang) * l1, ax + dx, ay + dy];
}

// =====================================================================================
// debug hooks
// =====================================================================================

export function debugTeleport(G, i) {
  const L = ensureStatic(G);
  if (!G.islandsRt) init(G);
  const I = L[clamp(i | 0, 0, L.length - 1)];
  const R = G.raft, P = G.player;
  const n = (R.tiles && R.tiles.length) || 4;
  R.x = I.shoreL - n * C.TILE_W - 1.5;
  R.anchored = true;
  R.vx = 0;
  if (Array.isArray(R.tiles)) for (const t of R.tiles) if (t && t.s && t.s.type === 'anchor') t.s.down = true;
  const px = I.shoreL + 46;
  P.x = px; P.y = gy(I, px); P.vx = 0; P.vy = 0; P.facing = 1;
  if (G.cam) { G.cam.x = P.x + 34; G.cam.y = P.y - 72; }
  RT(G).spawnT = rnd(1.0, 1.5);
  return true;
}

export function debugSpawn(G, kind) {
  const L = ensureStatic(G);
  const rt = RT(G);
  const P = G.player;
  const i = islandIndexAt(P.x);
  if (kind === 'beast' || kind === 'island_beast') {
    if (i < 0) return false;
    rt.beast = null;
    rt.away = 0;
    spawnBeast(G, L[i], P.x, true);
    return true;
  }
  if (kind === 'crab') {
    if (i < 0) return false;
    const I = L[i];
    const list = rt.crabs[I.id] || (rt.crabs[I.id] = []);
    const z = P.x < I.cx ? 0 : 1;
    list.push({ x: clamp(P.x + 30, I.crabZones[z][0], I.crabZones[z][1]), z, dir: 1, st: 'walk', t: 2, hide: 0, ph: 0, cap: CAPS[list.length % CAPS.length], s: 1, face: 1 });
    return true;
  }
  return false;
}

// =====================================================================================
// art caches
// =====================================================================================

const CACHE = new Map();   // island index → { land:[day,night], back:[day,night], under, deep, tower:[day,night] }

function cacheOf(I) { let c = CACHE.get(I.idx); if (!c) { c = { land: [null, null], back: [null, null], under: null, deep: null, tower: [null, null], far: false }; CACHE.set(I.idx, c); } return c; }

// Build missing pieces for nearby islands (one piece per call when not urgent).
function manageCaches(G, camX) {
  if (typeof document === 'undefined' || !ISL) return;
  const wN = cacheNight(G);
  let budget = 1;
  for (const I of ISL) {
    const d = Math.max(0, I.x0 - camX, camX - I.x1);
    if (d > DROP_FAR) { if (CACHE.has(I.idx)) CACHE.delete(I.idx); continue; }
    if (d > KEEP_NEAR + 600) continue;
    const c = cacheOf(I);
    const need = [];
    if (wN < 0.999) need.push(['land', 0], ['back', 0]);
    if (wN > 0.001 || nightK(G) > 0.2) need.push(['land', 1], ['back', 1]);
    need.push(['under', -1]);
    if (I.kind === 'lighthouse') need.push(['tower', 0], ['tower', 1]);
    for (const [k, vi] of need) {
      if (budget <= 0) return;
      if (vi < 0 ? c[k] : c[k][vi]) continue;
      buildPiece(I, c, k, vi);
      budget--;
    }
  }
}

function buildPiece(I, c, k, vi) {
  try {
    if (k === 'land') c.land[vi] = renderLand(I, vi === 1);
    else if (k === 'back') c.back[vi] = renderBack(I, vi === 1);
    else if (k === 'under') { c.under = renderUnder(I, UNDER_TOP, UNDER_SPLIT + 24, RES_UNDER); c.deep = I.maxD > UNDER_SPLIT ? renderUnder(I, UNDER_SPLIT, I.maxD + 14, RES_DEEP) : null; }
    else if (k === 'tower') c.tower[vi] = renderTower(I, vi === 1);
  } catch (e) { oops('render ' + k, e); if (k === 'under') c.under = { failed: true }; else c[k][vi] = { failed: true }; }
}

function piece(I, k, vi) {
  const c = cacheOf(I);
  let p = vi < 0 ? c[k] : c[k][vi];
  if (!p) { buildPiece(I, c, k, vi); p = vi < 0 ? c[k] : c[k][vi]; }
  return p && !p.failed ? p : null;
}

// weight of the night variant of the cached art
function cacheNight(G) { return smoothstep(0.3, 0.92, nightK(G)); }

// A cached canvas with its world rectangle.
function surface(X0, Y0, X1, Y1, res) {
  const cv = makeCanvas((X1 - X0) * res, (Y1 - Y0) * res);
  const g = cv.getContext('2d');
  g.setTransform(res, 0, 0, res, -X0 * res, -Y0 * res);
  g.lineJoin = 'round'; g.lineCap = 'round';
  return { cv, g, X0, Y0, X1, Y1, res };
}
function blit(ctx, s, alpha) {
  if (!s || alpha <= 0.002) return;
  ctx.globalAlpha = alpha;
  ctx.drawImage(s.cv, s.X0, s.Y0, s.X1 - s.X0, s.Y1 - s.Y0);
  ctx.globalAlpha = 1;
}

// A scalloped blob (leaf clump / cloud-like) path.
function blobPath(g, x, y, r, n, seed, k = 0.16) {
  g.moveTo(x + r, y);
  for (let i = 1; i <= n; i++) {
    const a0 = ((i - 0.5) / n) * TAU, a1 = (i / n) * TAU;
    const rr = r * (1 + k * (hash1(i, seed) - 0.3));
    g.quadraticCurveTo(x + Math.cos(a0) * rr * 1.18, y + Math.sin(a0) * rr * 1.18, x + Math.cos(a1) * r, y + Math.sin(a1) * r);
  }
  g.closePath();
}

function rockShape(g, x, y, w, h, poly) {
  g.beginPath();
  poly.forEach(([px, py], i) => { const X = x + px * w * 0.5, Y = y + py * h; i ? g.lineTo(X, Y) : g.moveTo(X, Y); });
  g.closePath();
}

// ------------------------------------------------------------------ land (terrain above ~sea level)
function renderLand(I, night) {
  const P = night ? PNIGHT : PDAY;
  const rng = seeded(I.seed * 13 + 5);   // same sequence for both variants → same geometry
  const X0 = I.landX0, X1 = I.landX1, Y0 = -(I.maxH + 42), Y1 = LAND_BOTTOM;
  const S = surface(X0, Y0, X1, Y1, RES_LAND), g = S.g;
  const L = I.shoreL, W = I.W;
  const G_ = (x) => gy(I, x);
  const xs = [];
  for (let x = X0; x <= X1 + 0.1; x += 2) xs.push(x);
  const s = (x) => x - L;
  const beachW = (x) => {
    const a = s(x), bL = I.beachL, bR = I.beachR;
    if (a <= 0 || a >= W) return 1;
    return Math.max(1 - smoothstep(bL * 0.75, bL * 1.25, a), smoothstep(W - bR * 1.25, W - bR * 0.75, a));
  };
  const rocky = (x) => {
    let r = 0;
    for (const o of I.crops) r = Math.max(r, bump((s(x) - o.c) / (o.w * 1.3)));
    if (I.cliff) r = Math.max(r, bump((s(x) - I.cliff.c - 6) / 20));
    if (I.kind === 'lighthouse') r = Math.max(r, 0.35 + 0.3 * noise1(x * 0.02, 9));
    if (I.theme === 'rocky') r = Math.max(r, 0.25 * smoothstep(0.45, 0.7, noise1(x * 0.015, 3)));
    return r;
  };
  const surf = () => { g.moveTo(xs[0], G_(xs[0])); for (let i = 1; i < xs.length; i++) g.lineTo(xs[i], G_(xs[i])); };

  // ---- body: a dark heart with a soft soil layer that follows the contour
  g.beginPath(); surf(); g.lineTo(X1, Y1 + 4); g.lineTo(X0, Y1 + 4); g.closePath();
  g.fillStyle = rgb(P.core); g.fill();
  g.save();
  g.clip();
  const layer = (d0, d1, col, a) => {
    g.beginPath(); g.moveTo(xs[0], G_(xs[0]) + d0(xs[0]));
    for (let i = 1; i < xs.length; i++) g.lineTo(xs[i], G_(xs[i]) + d0(xs[i]));
    for (let i = xs.length - 1; i >= 0; i--) g.lineTo(xs[i], G_(xs[i]) + d1(xs[i]));
    g.closePath(); g.fillStyle = rgba(col, a); g.fill();
  };
  const z = () => -2;
  for (const [d, a] of [[30, 0.18], [20, 0.26], [13, 0.32], [8, 0.36], [4, 0.4]]) layer(z, (x) => d * (0.75 + 0.5 * noise1(x * 0.035, I.seed + d)), P.soil, a);
  // faint strata lines
  g.strokeStyle = rgba(P.strata, 0.5); g.lineWidth = 0.7;
  for (const off of [17, 33, 52]) {
    g.beginPath();
    for (let i = 0; i < xs.length; i++) { const y = G_(xs[i]) + off + (noise1(xs[i] * 0.03, I.seed + off) - 0.5) * 10; i ? g.lineTo(xs[i], y) : g.moveTo(xs[i], y); }
    g.stroke();
  }
  // embedded stones
  for (let k = 0; k < W / 12; k++) {
    const x = lerp(X0, X1, rng()), d = lerp(5, 46, rng() * rng());
    const y = G_(x) + d;
    if (y > Y1) continue;
    const r = lerp(1.2, 3.4, rng());
    g.beginPath(); g.ellipse(x, y, r * 1.4, r, (rng() - 0.5) * 0.6, 0, TAU);
    g.fillStyle = rgba(mixColor(P.core, P.rock, 0.25 + rng() * 0.35), 0.9); g.fill();
    g.beginPath(); g.ellipse(x - r * 0.2, y - r * 0.4, r * 0.85, r * 0.35, 0, 0, TAU);
    g.fillStyle = rgba(P.rockLit, 0.12); g.fill();
  }
  // roots under the grass
  g.strokeStyle = rgba(mixColor(P.core, P.soil, 0.25), 0.9);
  for (let k = 0; k < W / 20; k++) {
    const x = lerp(L + I.beachL, L + W - I.beachR, rng());
    if (beachW(x) > 0.3) continue;
    const y = G_(x) + 2;
    g.lineWidth = lerp(0.5, 1.1, rng());
    g.beginPath(); g.moveTo(x, y);
    let px = x, py = y;
    for (let j = 0; j < 4; j++) { const nx = px + (rng() - 0.5) * 8, ny = py + lerp(3, 6, rng()); g.quadraticCurveTo(px + (rng() - 0.5) * 6, (py + ny) / 2, nx, ny); px = nx; py = ny; }
    g.stroke();
  }
  // sand body on the beaches and the shelf
  const sandT = (x) => (3 + 14 * beachW(x)) * (0.75 + 0.5 * noise1(x * 0.05, I.seed + 7));
  layer((x) => -1, (x) => sandT(x) + 5, P.sandDeep, 0.55);
  g.beginPath(); g.moveTo(xs[0], G_(xs[0]) - 1);
  for (let i = 1; i < xs.length; i++) g.lineTo(xs[i], G_(xs[i]) - 1);
  for (let i = xs.length - 1; i >= 0; i--) g.lineTo(xs[i], G_(xs[i]) + sandT(xs[i]));
  g.closePath();
  const sg = g.createLinearGradient(0, -20, 0, 26);
  sg.addColorStop(0, rgb(P.sand)); sg.addColorStop(1, rgb(P.sandDeep));
  g.fillStyle = sg; g.globalAlpha = 1; g.fill();
  // speckles
  for (let k = 0; k < W * 0.9; k++) {
    const x = lerp(X0, X1, rng());
    const bw = beachW(x);
    if (rng() > bw) continue;
    const y = G_(x) + rng() * sandT(x);
    g.fillStyle = rgba(rng() < 0.5 ? P.sandDot : P.sandLit, 0.5);
    g.fillRect(x, y, 0.7, 0.7);
  }
  // wet sand near the water line
  g.beginPath(); g.moveTo(xs[0], G_(xs[0]));
  for (let i = 1; i < xs.length; i++) g.lineTo(xs[i], G_(xs[i]));
  for (let i = xs.length - 1; i >= 0; i--) g.lineTo(xs[i], G_(xs[i]) + 8);
  g.closePath();
  const wg = g.createLinearGradient(0, -6, 0, 4);
  wg.addColorStop(0, rgba(P.sandWet, 0)); wg.addColorStop(0.5, rgba(P.sandWet, 0.65)); wg.addColorStop(1, rgba(P.sandWet, 0.85));
  g.fillStyle = wg; g.fill();
  // below sea level everything is drowned in the colour of the water
  const tg = g.createLinearGradient(0, -2, 0, Y1);
  tg.addColorStop(0, rgba(P.water, 0)); tg.addColorStop(0.25, rgba(P.water, 0.22)); tg.addColorStop(0.6, rgba(P.water, 0.42)); tg.addColorStop(1, rgba(P.water, 0.5));
  g.fillStyle = tg; g.fillRect(X0, -2, X1 - X0, Y1 + 6);
  g.restore();

  // ---- the ground line: AO under the lip, lit top edge
  g.beginPath(); surf();
  g.strokeStyle = rgba(P.rim, P.rimK * (night ? 0.95 : 0.7)); g.lineWidth = night ? 1.3 : 0.9; g.stroke();

  // ---- grass (inland) — a band with an overhanging lip and blades
  const grassW = (x) => (1 - beachW(x)) * (1 - rocky(x) * 0.9) * smoothstep(0.18, 0.4, noise1(x * 0.025, I.seed + 8) + 0.2) * (I.kind === 'lighthouse' ? 0.6 : 1);
  g.beginPath();
  let open = false;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i], gw = grassW(x);
    if (gw < 0.15) { if (open) { for (let j = i - 1; j >= 0 && grassW(xs[j]) >= 0.15; j--) g.lineTo(xs[j], G_(xs[j]) + 2 + gw * 0 + 4 * grassW(xs[j]) * (0.6 + 0.6 * hash1(j, 3))); g.closePath(); open = false; } continue; }
    if (!open) { g.moveTo(x, G_(x) - 0.8); open = true; } else g.lineTo(x, G_(x) - 0.8);
  }
  if (open) { for (let j = xs.length - 1; j >= 0 && grassW(xs[j]) >= 0.15; j--) g.lineTo(xs[j], G_(xs[j]) + 2 + 4 * grassW(xs[j]) * (0.6 + 0.6 * hash1(j, 3))); g.closePath(); }
  g.fillStyle = rgb(P.grassLo); g.fill();
  // blades: three tones, one stroke each
  const tones = [P.grassLo, P.grass, P.grassHi];
  for (let ti = 0; ti < 3; ti++) {
    g.beginPath();
    for (let x = X0; x < X1; x += 0.9) {
      const gw = grassW(x);
      if (gw < 0.2 || hash1(Math.round(x * 10), 11 + ti) > gw * (ti === 2 ? 0.35 : 0.8)) continue;
      const y = G_(x) + 0.6;
      const h = (2.5 + hash1(Math.round(x * 10), 21 + ti) * 6) * (0.6 + gw * 0.6) * (ti === 2 ? 0.7 : 1);
      const lean = (hash1(Math.round(x * 10), 31 + ti) - 0.5) * 3;
      g.moveTo(x, y); g.quadraticCurveTo(x + lean * 0.3, y - h * 0.6, x + lean, y - h);
    }
    g.strokeStyle = rgb(tones[ti]); g.lineWidth = ti === 0 ? 1 : 0.75; g.stroke();
  }
  // flowers by day
  if (P.flower) {
    for (let k = 0; k < W / 10; k++) {
      const x = lerp(X0, X1, rng());
      if (grassW(x) < 0.5) continue;
      const c = P.flower[Math.floor(rng() * P.flower.length)];
      const y = G_(x) - lerp(2, 6, rng());
      g.fillStyle = rgb(c);
      g.beginPath(); g.arc(x, y, lerp(0.6, 1.1, rng()), 0, TAU); g.fill();
    }
  }
  // dune grass tufts on the upper beach
  g.beginPath();
  for (let k = 0; k < W / 7; k++) {
    const x = lerp(L + 10, L + W - 10, rng());
    const bw = beachW(x);
    if (bw < 0.3 || -G_(x) < 5 || rng() > 0.5) continue;
    const y = G_(x) + 0.5;
    for (let j = 0; j < 4; j++) { const h = lerp(3, 8, rng()), l = (rng() - 0.5) * 6; g.moveTo(x + j * 0.6, y); g.quadraticCurveTo(x + l * 0.2, y - h * 0.6, x + l, y - h); }
  }
  g.strokeStyle = rgb(P.reed); g.lineWidth = 0.6; g.stroke();

  // ---- beach details: pebbles, shells, wrack line
  for (let k = 0; k < W / 6; k++) {
    const x = lerp(X0 + 10, X1 - 10, rng());
    if (beachW(x) < 0.5) continue;
    const y = G_(x);
    if (y > 6) continue;
    const t = rng();
    if (t < 0.5) {
      const r = lerp(0.8, 1.8, rng());
      g.beginPath(); g.ellipse(x, y + 0.2, r * 1.3, r * 0.8, 0, Math.PI, TAU); g.fillStyle = rgb(mixColor(P.rock, P.rockLit, rng())); g.fill();
    } else if (t < 0.7) {
      g.beginPath(); g.moveTo(x - 1.6, y); g.quadraticCurveTo(x, y - 2.6, x + 1.6, y); g.closePath();
      g.fillStyle = rgb(night ? P.sandLit : [244, 222, 214]); g.fill();
      g.strokeStyle = rgba(P.sandDeep, 0.8); g.lineWidth = 0.3; g.beginPath(); g.moveTo(x, y - 2.2); g.lineTo(x, y); g.moveTo(x - 0.8, y - 1.6); g.lineTo(x - 1.1, y); g.moveTo(x + 0.8, y - 1.6); g.lineTo(x + 1.1, y); g.stroke();
    } else if (y > -4 && y < 1.5) {
      // seaweed left by the tide
      g.strokeStyle = rgba(night ? [20, 30, 34] : [70, 82, 46], 0.9); g.lineWidth = 0.9;
      g.beginPath(); g.moveTo(x - 3, y - 0.2); g.quadraticCurveTo(x, y - 1.6, x + 3.5, y - 0.3); g.stroke();
    }
  }
  // tide pools
  for (const p of I.pools) {
    const x = L + p.c;
    const y = G_(x - p.w * 0.6) + 0.3;
    g.save();
    g.beginPath();
    g.moveTo(x - p.w, G_(x - p.w));
    for (let xx = x - p.w; xx <= x + p.w; xx += 1) g.lineTo(xx, Math.max(y, G_(xx)));
    g.closePath();
    g.clip();
    g.fillStyle = rgb(P.pool); g.fillRect(x - p.w - 1, y - 0.5, p.w * 2 + 2, 6);
    g.fillStyle = rgba(P.poolHi, 0.6); g.fillRect(x - p.w - 1, y - 0.3, p.w * 2 + 2, 0.5);
    g.restore();
    for (let j = 0; j < 3; j++) {
      const rx = x + (j - 1) * p.w * 0.9 + (rng() - 0.5) * 2;
      g.beginPath(); g.ellipse(rx, G_(rx) - 0.4, lerp(1.5, 2.6, rng()), lerp(1.1, 1.8, rng()), 0, Math.PI, TAU);
      g.fillStyle = rgb(mixColor(P.rockDark, P.rock, 0.5)); g.fill();
    }
  }

  // ---- rock outcrops and the cliff face
  const rockCluster = (cx, w, h, seed) => {
    const r2 = seeded(seed);
    const n = 3 + Math.floor(r2() * 3);
    for (let k = 0; k < n; k++) {
      const x = cx + (r2() - 0.5) * w * 0.9;
      const rw = lerp(0.35, 0.7, r2()) * w, rh = lerp(0.5, 1, r2()) * h;
      const base = G_(x) + rh * 0.35;
      const poly = rockPoly(r2, 11);
      rockShape(g, x, base, rw, rh, poly);
      const rg = g.createLinearGradient(x - rw * 0.4, base - rh, x + rw * 0.4, base);
      rg.addColorStop(0, rgb(P.rockLit)); rg.addColorStop(0.45, rgb(P.rock)); rg.addColorStop(1, rgb(P.rockDark));
      g.fillStyle = rg; g.fill();
      // facet + cracks
      g.save(); g.clip();
      g.beginPath(); g.moveTo(x - rw * 0.1, base - rh * 1.1); g.lineTo(x + rw * 0.25, base - rh * 0.3); g.lineTo(x + rw * 0.6, base); g.lineTo(x + rw * 0.6, base - rh * 1.1); g.closePath();
      g.fillStyle = rgba(P.rockDark, 0.35); g.fill();
      g.strokeStyle = rgba(P.rockDark, 0.7); g.lineWidth = 0.5;
      g.beginPath(); g.moveTo(x - rw * 0.2, base - rh * 0.7); g.lineTo(x - rw * 0.05, base - rh * 0.35); g.lineTo(x - rw * 0.15, base - rh * 0.05); g.stroke();
      // moss cap
      g.beginPath(); g.ellipse(x - rw * 0.08, base - rh * 0.95, rw * 0.32, rh * 0.18, 0, 0, TAU);
      g.fillStyle = rgba(P.moss, I.kind === 'lighthouse' ? 0.45 : 0.75); g.fill();
      g.restore();
      rockShape(g, x, base, rw, rh, poly);
      g.strokeStyle = rgba(P.rim, P.rimK * 0.35); g.lineWidth = 0.5; g.stroke();
    }
  };
  for (const o of I.crops) rockCluster(L + o.c, o.w * 1.25, o.h * 0.95 + 4, I.seed * 3 + Math.round(o.c));
  if (I.cliff) {
    // a natural rock step: three stacked, weathered slabs with grass spilling over the lip
    const cx = L + I.cliff.c;
    const top = G_(cx + 4), bot = G_(cx - 4);
    const hh = bot - top;
    const r2 = seeded(I.seed * 7 + 3);
    const slabs = [[0, 0.42, 0], [0.36, 0.74, 3], [0.7, 1.04, 1.5]];
    for (const [u0, u1, ox] of slabs) {
      const y0 = top + hh * u0 - 1, y1 = top + hh * u1 + 1;
      const x0 = cx - 3 + ox + (r2() - 0.5) * 2, x1 = cx + 13 + r2() * 4;
      g.beginPath();
      g.moveTo(x0 + 2, y0);
      g.lineTo(x1 - 2, y0 - 0.6);
      g.quadraticCurveTo(x1, y0, x1, y0 + 2);
      g.lineTo(x1 - 1, y1 - 1.5);
      g.quadraticCurveTo(x1 - 2, y1, x1 - 4, y1);
      g.lineTo(x0 + 1.5, y1 + 0.5);
      g.quadraticCurveTo(x0 - 1, y1 - 1, x0 - 0.5, y1 - 3);
      g.lineTo(x0, y0 + 2.5);
      g.quadraticCurveTo(x0, y0, x0 + 2, y0);
      g.closePath();
      const cg = g.createLinearGradient(x0, y0, x0 + 10, y1);
      cg.addColorStop(0, rgb(P.rockLit)); cg.addColorStop(0.3, rgb(P.rock)); cg.addColorStop(1, rgb(P.rockDark));
      g.fillStyle = cg; g.fill();
      g.strokeStyle = rgba(P.rockDark, 0.7); g.lineWidth = 0.5;
      g.beginPath(); g.moveTo(x0 + 3, y0 + (y1 - y0) * 0.45); g.lineTo(x0 + 7 + r2() * 3, y0 + (y1 - y0) * 0.5); g.lineTo(x0 + 9, y1 - 1); g.stroke();
      g.strokeStyle = rgba(P.rim, P.rimK * 0.55); g.lineWidth = 0.6;
      g.beginPath(); g.moveTo(x0 + 1, y0 + 2); g.quadraticCurveTo(x0 + 1, y0, x0 + 4, y0 - 0.2); g.lineTo(x1 - 3, y0 - 0.6); g.stroke();
    }
    // moss in the cracks and grass hanging over the lip
    g.fillStyle = rgba(P.moss, 0.8);
    g.beginPath(); g.ellipse(cx + 2, top + hh * 0.4, 3, 1.1, 0, 0, TAU); g.ellipse(cx + 5, top + hh * 0.73, 2.4, 1, 0, 0, TAU); g.fill();
    g.strokeStyle = rgb(P.grass); g.lineWidth = 0.6;
    g.beginPath();
    for (let k = 0; k < 10; k++) { const x = cx - 1 + k * 1.5; g.moveTo(x, top); g.quadraticCurveTo(x - 1.5, top + 2, x - 2.5 - r2() * 2, top + 3 + r2() * 6); }
    g.stroke();
  }
  // carved steps on the lighthouse path
  if (I.kind === 'lighthouse') {
    g.strokeStyle = rgba(P.rockDark, 0.55); g.lineWidth = 0.8;
    for (let x = L + 150; x < I.towerX - 70; x += 9) {
      const y = G_(x);
      g.beginPath(); g.moveTo(x - 3.5, y + 0.6); g.lineTo(x + 3.5, y + 0.6); g.lineTo(x + 3.5, y + 2.4); g.stroke();
    }
  }

  // ---- static deco
  for (const d of I.deco) drawDeco(g, d, P, night, I);

  // ---- fade the bottom edge into the reef canvas below
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'destination-out';
  const fy0 = (UNDER_TOP + 8 - Y0) * RES_LAND, fy1 = (Y1 - Y0) * RES_LAND;
  const fg = g.createLinearGradient(0, fy0, 0, fy1);
  fg.addColorStop(0, 'rgba(0,0,0,0)'); fg.addColorStop(1, 'rgba(0,0,0,1)');
  g.fillStyle = fg; g.fillRect(0, fy0, S.cv.width, fy1 - fy0 + 2);
  g.restore();
  return S;
}

function drawDeco(g, d, P, night, I) {
  const x = d.x, y = d.y;
  const wood = P.wood, woodD = P.woodDark;
  if (d.type === 'firepit') {
    g.fillStyle = rgba(night ? [10, 10, 14] : [40, 34, 30], 0.8);
    g.beginPath(); g.ellipse(x, y + 0.5, 7, 1.6, 0, 0, TAU); g.fill();
    g.strokeStyle = rgb(night ? [14, 12, 14] : [34, 26, 22]); g.lineWidth = 1.3;
    g.beginPath(); g.moveTo(x - 4, y); g.lineTo(x + 3, y - 3); g.moveTo(x + 4, y); g.lineTo(x - 2, y - 3.5); g.moveTo(x, y); g.lineTo(x + 0.5, y - 4); g.stroke();
    for (let k = 0; k < 6; k++) {
      const sx = x - 8 + k * 3.2;
      g.beginPath(); g.ellipse(sx, y - 0.6, 1.8, 1.4, 0, 0, TAU);
      g.fillStyle = rgb(mixColor(P.rockDark, P.rock, 0.3 + 0.12 * k % 0.5)); g.fill();
      g.fillStyle = rgba(P.rockLit, 0.4); g.fillRect(sx - 1, y - 1.9, 1.4, 0.5);
    }
  } else if (d.type === 'tally') {
    g.save(); g.translate(x, y + 2); g.rotate(-0.08);
    g.fillStyle = rgb(woodD); g.fillRect(-1.8, -26, 3.6, 27);
    g.fillStyle = rgb(wood); g.fillRect(-1.8, -26, 1.6, 27);
    g.strokeStyle = rgba(night ? [10, 10, 16] : [60, 44, 30], 0.9); g.lineWidth = 0.35;
    for (let k = 0; k < 14; k++) {
      const yy = -23 + Math.floor(k / 5) * 6, xx = -1.3 + (k % 5) * 0.65;
      g.beginPath();
      if (k % 5 === 4) { g.moveTo(-1.6, yy + 3); g.lineTo(1.6, yy); } else { g.moveTo(xx, yy); g.lineTo(xx, yy + 3); }
      g.stroke();
    }
    g.restore();
  } else if (d.type === 'cairn') {
    const sizes = [6, 5, 4, 3, 2.2];
    let yy = y + 1;
    sizes.forEach((r, k) => {
      g.beginPath(); g.ellipse(x + (k % 2 ? 0.6 : -0.5), yy - r * 0.55, r, r * 0.6, 0, 0, TAU);
      g.fillStyle = rgb(mixColor(P.rockDark, P.rock, 0.5 + k * 0.08)); g.fill();
      g.fillStyle = rgba(P.rockLit, 0.35); g.beginPath(); g.ellipse(x - r * 0.25, yy - r * 0.85, r * 0.5, r * 0.18, 0, 0, TAU); g.fill();
      yy -= r * 1.1;
    });
  } else if (d.type === 'oar') {
    g.save(); g.translate(x, y + 0.5); g.rotate(-0.12);
    g.fillStyle = rgb(woodD); g.fillRect(-14, -1, 22, 1.6);
    g.beginPath(); g.ellipse(10, -0.2, 6, 2.2, 0, 0, TAU); g.fillStyle = rgb(wood); g.fill();
    g.restore();
  } else if (d.type === 'wreck') {
    // a broken rowboat lying on its side, half swallowed by the sand; follows the slope
    const gl = gy(I, x - 34), gr = gy(I, x + 34);
    const ang = Math.atan2(gr - gl, 68);
    const hull = night ? [36, 40, 54] : [96, 74, 54], hullD = night ? [16, 18, 26] : [58, 44, 34], paint = night ? [48, 56, 78] : [74, 112, 122];
    g.save(); g.translate(x, (gl + gr) / 2 + 4); g.rotate(ang - 0.06);
    // hull: keel line along the bottom, gunwale on top, broken open at the stern (right)
    g.beginPath();
    g.moveTo(-40, 0); g.quadraticCurveTo(-42, -16, -26, -24); g.quadraticCurveTo(-4, -30, 22, -27);
    g.lineTo(18, -21); g.lineTo(24, -15); g.lineTo(19, -9); g.lineTo(23, -3); g.lineTo(18, 2); g.closePath();
    g.fillStyle = rgb(hull); g.fill();
    g.save(); g.clip();
    g.strokeStyle = rgb(hullD); g.lineWidth = 0.6;
    for (let k = 1; k < 7; k++) { g.beginPath(); g.moveTo(-44, -k * 4.2); g.quadraticCurveTo(-20, -k * 4.6 - 2, 26, -k * 4); g.stroke(); }
    g.fillStyle = rgba(paint, 0.55); g.fillRect(-44, -30, 72, 5);
    g.fillStyle = rgba(hullD, 0.5); g.fillRect(-44, -8, 72, 10);
    g.restore();
    // exposed ribs where it broke
    g.strokeStyle = rgb(hullD); g.lineWidth = 1.5;
    for (let k = 0; k < 3; k++) { const rx = 21 + k * 5; g.beginPath(); g.moveTo(rx, 1); g.quadraticCurveTo(rx + 5, -12, rx + 1, -25 + k * 3); g.stroke(); }
    // mast stump
    g.fillStyle = rgb(hullD); g.save(); g.translate(-8, -26); g.rotate(-1.0); g.fillRect(-1.4, -20, 2.8, 20); g.restore();
    g.restore();
    // sand banked against it, following the ground
    g.beginPath();
    g.moveTo(x - 50, gy(I, x - 50) + 1);
    for (let dx = -50; dx <= 44; dx += 4) { const m = Math.sin(clamp((dx + 50) / 94, 0, 1) * Math.PI); g.lineTo(x + dx, gy(I, x + dx) - m * (dx < 0 ? 7 : 4)); }
    g.lineTo(x + 44, gy(I, x + 44) + 2);
    g.closePath();
    g.fillStyle = rgb(P.sand); g.fill();
  } else if (d.type === 'leanto') {
    g.strokeStyle = rgb(woodD); g.lineWidth = 1.6;
    g.beginPath(); g.moveTo(x - 14, y + 1); g.lineTo(x + 6, y - 20); g.moveTo(x + 12, y + 1); g.lineTo(x + 4, y - 22); g.stroke();
    const leaf = night ? [16, 24, 30] : [116, 120, 66];
    for (let k = 0; k < 6; k++) {
      const t = k / 5, lx = lerp(x - 12, x + 4, t), ly = lerp(y - 1, y - 19, t);
      g.beginPath(); g.moveTo(lx, ly); g.quadraticCurveTo(lx - 6, ly + 2, lx - 12, ly + 7); g.quadraticCurveTo(lx - 5, ly + 5, lx + 1, ly + 3); g.closePath();
      g.fillStyle = rgb(mixColor(leaf, [0, 0, 0], k * 0.05)); g.fill();
    }
  } else if (d.type === 'sign') {
    g.fillStyle = rgb(woodD); g.fillRect(x - 1.2, y - 24, 2.4, 25);
    g.save(); g.translate(x, y - 21); g.rotate(-0.05);
    g.beginPath(); g.moveTo(-12, -4.5); g.lineTo(9, -4.5); g.lineTo(14, 0); g.lineTo(9, 4.5); g.lineTo(-12, 4.5); g.closePath();
    g.fillStyle = rgb(wood); g.fill();
    g.strokeStyle = rgb(woodD); g.lineWidth = 0.5; g.stroke();
    g.fillStyle = rgb(night ? [14, 14, 22] : [62, 42, 28]);
    g.font = 'bold 6px "Songti SC","Noto Serif SC",serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('灯塔', -1.5, 0.3);
    g.restore();
  } else if (d.type === 'hut') {
    const st = night ? [44, 48, 64] : [168, 160, 146], stD = night ? [22, 24, 34] : [108, 100, 90], roof = night ? [26, 28, 38] : [96, 70, 56];
    g.fillStyle = rgb(st); g.fillRect(x - 16, y - 20, 30, 21);
    g.fillStyle = rgb(stD); g.fillRect(x + 8, y - 20, 6, 21);
    g.strokeStyle = rgba(stD, 0.8); g.lineWidth = 0.4;
    for (let k = 1; k < 5; k++) { g.beginPath(); g.moveTo(x - 16, y - 20 + k * 4.2); g.lineTo(x + 14, y - 20 + k * 4.2); g.stroke(); }
    g.beginPath(); g.moveTo(x - 20, y - 19); g.lineTo(x - 2, y - 31); g.lineTo(x + 17, y - 19); g.closePath(); g.fillStyle = rgb(roof); g.fill();
    g.fillStyle = rgb(night ? [8, 8, 12] : [40, 34, 32]); g.fillRect(x - 9, y - 13, 6, 7);
    g.fillStyle = rgb(stD); g.fillRect(x + 4, y - 36, 4, 9);
  }
}

// ------------------------------------------------------------------ back vegetation (the tree line)
function renderBack(I, night) {
  const P = night ? PNIGHT : PDAY;
  const X0 = I.shoreL - 30, X1 = I.shoreR + 30, Y0 = I.treeTop - 10, Y1 = 14;
  const S = surface(X0, Y0, X1, Y1, RES_BACK), g = S.g;
  // undergrowth band hugging the ground behind everything
  const L = I.shoreL, W = I.W;
  const ug = (x) => {
    const s = x - L;
    const e = Math.min(1, (s - I.beachL * 0.55) / 50, (W - I.beachR * 0.55 - s) / 50);
    if (e <= 0) return 0;
    return e * (I.kind === 'lighthouse' ? 8 : 16) * (0.5 + noise1(x * 0.05, I.seed + 12));
  };
  g.beginPath();
  g.moveTo(X0, gy(I, X0) + 6);
  for (let x = X0; x <= X1; x += 3) g.lineTo(x, gy(I, x) + 5 - ug(x));
  g.lineTo(X1, Y1); g.lineTo(X0, Y1); g.closePath();
  g.fillStyle = rgb(mixColor(P.canopyLo, P.canopy, 0.25)); g.fill();
  for (const t of I.trees) drawBackTree(g, t, P, night, I);
  // a second, nearer undergrowth row (ferns and big leaves)
  const r = seeded(I.seed * 17 + 3);
  for (let x = L + I.beachL * 0.6; x < L + W - I.beachR * 0.6; x += lerp(8, 18, r())) {
    if (ug(x) < 4) continue;
    const by = gy(I, x) + 4;
    const n = 4 + Math.floor(r() * 4);
    const col = mixColor(P.canopyLo, P.canopy, 0.35 + r() * 0.3);
    g.fillStyle = rgb(col);
    for (let k = 0; k < n; k++) {
      const a = lerp(-2.6, -0.5, k / (n - 1)) + (r() - 0.5) * 0.3;
      const len = lerp(8, 18, r());
      const tx = x + Math.cos(a) * len, ty = by + Math.sin(a) * len * 0.9;
      g.beginPath(); g.moveTo(x, by);
      g.quadraticCurveTo(x + Math.cos(a - 0.4) * len * 0.6, by + Math.sin(a - 0.4) * len * 0.6, tx, ty + 2);
      g.quadraticCurveTo(x + Math.cos(a + 0.4) * len * 0.6, by + Math.sin(a + 0.4) * len * 0.6, x + 1, by);
      g.fill();
    }
  }
  // atmospheric depth: push the whole tree line back a little
  g.save();
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = rgba(P.haze, P.hazeK);
  g.fillRect(X0, Y0, X1 - X0, Y1 - Y0);
  g.restore();
  return S;
}

function drawBackTree(g, t, P, night, I) {
  const r = seeded(t.seed);
  const x = t.x, base = t.base, h = t.h;
  const fade = t.depth;                 // deeper trees: darker, hazier
  const lo = mixColor(P.canopyLo, P.haze, 0.18 * (1 - fade) * (night ? 0.5 : 1));
  const mid = mixColor(P.canopy, P.haze, 0.2 * (1 - fade) * (night ? 0.5 : 1));
  const hi = mixColor(P.canopyHi, P.haze, 0.15 * (1 - fade));
  const trunk = mixColor(P.trunk, P.haze, 0.15 * (1 - fade));
  if (t.type === 'broad') {
    const tx = x + t.lean * h * 0.4, ty = base - h * 0.62;
    const hue = hash1(t.seed, 5);
    const tint = (c) => mixColor(c, hue < 0.33 ? [96, 104, 52] : hue < 0.66 ? [30, 70, 78] : c, 0.18);
    const lo2 = tint(lo), mid2 = tint(mid), hi2 = tint(hi);
    // trunk with buttress roots and a few branches
    g.fillStyle = rgb(trunk);
    g.beginPath();
    g.moveTo(x - 6, base + 2); g.quadraticCurveTo(x - 2.6, base - 4, x - 2.4 + t.lean * h * 0.12, base - h * 0.3);
    g.lineTo(tx - 1.2, ty); g.lineTo(tx + 1.2, ty);
    g.lineTo(x + 2.4 + t.lean * h * 0.12, base - h * 0.3); g.quadraticCurveTo(x + 2.6, base - 4, x + 6, base + 2);
    g.closePath(); g.fill();
    g.strokeStyle = rgb(trunk); g.lineWidth = 1.3;
    for (let k = 0; k < 3; k++) { const by = lerp(base - h * 0.35, ty, r()); const sd = r() < 0.5 ? -1 : 1; g.beginPath(); g.moveTo(lerp(x, tx, (base - by) / (base - ty)), by); g.quadraticCurveTo(tx + sd * h * 0.1, by - h * 0.1, tx + sd * h * lerp(0.15, 0.3, r()), by - h * lerp(0.1, 0.22, r())); g.stroke(); }
    // canopy: many lobed clumps, darker at the bottom, lit from above
    const n = 7 + Math.floor(r() * 5);
    const cw = h * lerp(0.26, 0.36, r());
    const clumps = [];
    for (let k = 0; k < n; k++) clumps.push({ x: tx + (r() - 0.5) * cw * 2.2, y: ty - h * 0.06 + (r() - 0.62) * cw * 1.3, r: cw * lerp(0.4, 0.7, r()), s: Math.floor(r() * 999) });
    clumps.sort((a2, b2) => b2.y - a2.y);
    const topY = Math.min(...clumps.map((c) => c.y - c.r));
    for (const c of clumps) { g.beginPath(); blobPath(g, c.x, c.y + c.r * 0.1, c.r * 1.05, 11, c.s, 0.4); g.fillStyle = rgb(lo2); g.fill(); }
    for (const c of clumps) {
      g.beginPath(); blobPath(g, c.x - c.r * 0.14, c.y - c.r * 0.22, c.r * 0.74, 10, c.s + 1, 0.38);
      g.fillStyle = rgb(mixColor(lo2, mid2, 0.35 + 0.65 * clamp((ty + cw * 0.3 - c.y) / (cw * 1.2), 0, 1))); g.fill();
    }
    // light catching the upper edges: crescents (sun by day, moon by night)
    g.fillStyle = rgba(hi2, night ? 0.5 : 0.55);
    for (const c of clumps) {
      if (c.y - c.r > topY + cw * 0.7) continue;
      const ox = c.x - c.r * 0.14, oy = c.y - c.r * 0.22, orr = c.r * 0.74;
      g.save();
      g.beginPath(); blobPath(g, ox, oy, orr, 10, c.s + 1, 0.38); g.clip();
      g.beginPath();
      g.rect(ox - orr * 1.6, oy - orr * 1.6, orr * 3.2, orr * 3.2);
      const ix = ox + orr * 0.2, iy = oy + orr * 0.26, ir = orr * 0.86;
      g.moveTo(ix + ir, iy); g.arc(ix, iy, ir, 0, TAU);
      g.fill('evenodd');
      g.restore();
    }
    // leaf fringe on the outline
    g.fillStyle = rgba(mid2, 0.9);
    for (let k = 0; k < 26; k++) {
      const c = clumps[k % clumps.length];
      const a = -Math.PI + r() * Math.PI * 1.1;
      const lx = c.x + Math.cos(a) * c.r * 1.02, ly = c.y + Math.sin(a) * c.r * 0.95;
      g.beginPath(); g.ellipse(lx, ly, 2.2, 1, a + 1.2, 0, TAU); g.fill();
    }
    // shadow under the crown
    g.fillStyle = rgba(P.canopyLo, 0.5);
    g.beginPath(); g.ellipse(tx, ty + cw * 0.55, cw * 0.9, cw * 0.22, 0, 0, TAU); g.fill();
  } else if (t.type === 'palm') {
    const tx = x + t.lean * h, ty = base - h;
    g.strokeStyle = rgb(trunk); g.lineWidth = 2.6;
    g.beginPath(); g.moveTo(x, base); g.quadraticCurveTo(x + t.lean * h * 0.15, base - h * 0.6, tx, ty); g.stroke();
    const nf = 7;
    for (let k = 0; k < nf; k++) {
      const a = lerp(-Math.PI + 0.2, -0.2, k / (nf - 1)) + (r() - 0.5) * 0.2;
      const len = lerp(22, 34, r()) * (h / 110 * 0.4 + 0.7);
      frondShape(g, tx, ty, a, len, 0.42, 7);
      g.fillStyle = rgb(k % 2 ? lo : mid); g.fill();
    }
  } else if (t.type === 'dead') {
    // crooked bare tree: branches like long fingers
    g.strokeStyle = rgb(mixColor(P.trunkDark, P.haze, 0.1 * (1 - fade)));
    const branch = (x0, y0, a, len, w, depth) => {
      const x1 = x0 + Math.cos(a) * len, y1 = y0 + Math.sin(a) * len;
      g.lineWidth = w;
      g.beginPath(); g.moveTo(x0, y0); g.quadraticCurveTo((x0 + x1) / 2 + (r() - 0.5) * len * 0.3, (y0 + y1) / 2, x1, y1); g.stroke();
      if (depth <= 0) return;
      const nb = depth > 1 ? 2 : 3;
      for (let k = 0; k < nb; k++) branch(x1, y1, a + (r() - 0.5) * 1.3, len * lerp(0.5, 0.75, r()), w * 0.6, depth - 1);
    };
    branch(x, base, -Math.PI / 2 + t.lean, h * 0.5, 3.4, 3);
  } else {
    // shrub
    const n = 4 + Math.floor(r() * 3);
    for (let k = 0; k < n; k++) {
      const cx = x + (r() - 0.5) * h * 0.9, cy = base - h * lerp(0.3, 0.6, r()), cr = h * lerp(0.3, 0.45, r());
      g.beginPath(); blobPath(g, cx, cy, cr, 8, t.seed + k, 0.3);
      g.fillStyle = rgb(k % 2 ? lo : mid); g.fill();
    }
  }
}

// A palm frond as a closed feathery path (leaflets hang down with gravity).
function frondShape(g, x, y, a, len, droop, n) {
  const ca = Math.cos(a), sa = Math.sin(a);
  const tipX = x + ca * len, tipY = y + sa * len + droop * len * (0.6 + 0.4 * Math.abs(ca));
  const cx = x + ca * len * 0.55, cy = y + sa * len * 0.55 - len * 0.12;
  const pt = (u) => {
    const iu = 1 - u;
    return [iu * iu * x + 2 * iu * u * cx + u * u * tipX, iu * iu * y + 2 * iu * u * cy + u * u * tipY];
  };
  const tan = (u) => {
    const dx = 2 * (1 - u) * (cx - x) + 2 * u * (tipX - cx), dy = 2 * (1 - u) * (cy - y) + 2 * u * (tipY - cy);
    const l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  };
  const left = [], right = [];
  for (let i = 1; i <= n; i++) {
    const u = i / (n + 0.6);
    const [px, py] = pt(u), [tx, ty] = tan(u);
    const w = Math.sin(Math.PI * Math.pow(u, 0.75)) * len * 0.26;
    const nx = -ty, ny = tx;
    const bx = px + tx * len * 0.012, by = py + ty * len * 0.012;
    left.push([bx, by], [px + nx * w * 0.8 - tx * w * 0.45, py + ny * w * 0.8 - ty * w * 0.45 + w * 0.7]);
    right.push([bx, by], [px - nx * w * 0.8 - tx * w * 0.45, py - ny * w * 0.8 - ty * w * 0.45 + w * 0.7]);
  }
  g.beginPath();
  g.moveTo(x, y);
  for (const p of left) g.lineTo(p[0], p[1]);
  g.lineTo(tipX, tipY);
  for (let i = right.length - 1; i >= 0; i--) g.lineTo(right[i][0], right[i][1]);
  g.closePath();
  return [tipX, tipY, cx, cy];
}

// ------------------------------------------------------------------ the reef (under water)
function renderUnder(I, Y0, Y1, res) {
  const X0 = I.x0 - 4, X1 = I.x1 + 4;
  const S = surface(X0, Y0, X1, Y1, res), g = S.g;
  const rng = seeded(I.seed * 29 + Math.round(Y0));
  const xs = [];
  for (let x = X0; x <= X1 + 0.1; x += 3) xs.push(x);
  const G_ = (x) => gy(I, x);
  // body
  g.beginPath(); g.moveTo(xs[0], G_(xs[0]));
  for (let i = 1; i < xs.length; i++) g.lineTo(xs[i], G_(xs[i]));
  g.lineTo(X1, Y1 + 4); g.lineTo(X0, Y1 + 4); g.closePath();
  g.fillStyle = rgb(mixColor(PDAY.core, PDAY.water, 0.5)); g.fill();
  g.save(); g.clip();
  const band = (off, col) => {
    g.beginPath(); g.moveTo(xs[0], G_(xs[0]) + off(xs[0]));
    for (let i = 1; i < xs.length; i++) g.lineTo(xs[i], G_(xs[i]) + off(xs[i]));
    for (let i = xs.length - 1; i >= 0; i--) g.lineTo(xs[i], G_(xs[i]) - 2);
    g.closePath();
    g.fillStyle = col; g.fill();
  };
  // a lighter living skin over the rock, thicker in the shallows
  for (const [d, a] of [[40, 0.14], [26, 0.2], [14, 0.26], [6, 0.32]]) band((x) => d * (0.7 + 0.6 * noise1(x * 0.03, d)) * (1 - 0.5 * smoothstep(80, 500, G_(x))), 'rgba(92,120,116,' + a + ')');
  g.strokeStyle = 'rgba(8,14,18,0.5)'; g.lineWidth = 1;
  for (const off of [26, 58, 104]) {
    g.beginPath();
    for (let i = 0; i < xs.length; i++) { const y = G_(xs[i]) + off + (noise1(xs[i] * 0.02, off) - 0.5) * 18; i ? g.lineTo(xs[i], y) : g.moveTo(xs[i], y); }
    g.stroke();
  }
  // embedded boulders
  for (let k = 0; k < (X1 - X0) / 14; k++) {
    const x = lerp(X0, X1, rng());
    const y = G_(x) + lerp(2, 40, rng() * rng());
    if (y < Y0 - 10 || y > Y1 + 10) continue;
    const r = lerp(3, 10, rng());
    g.beginPath(); g.ellipse(x, y, r * 1.3, r, (rng() - 0.5) * 0.5, 0, TAU);
    g.fillStyle = `rgba(${20 + rng() * 30 | 0},${28 + rng() * 30 | 0},${32 + rng() * 26 | 0},0.8)`; g.fill();
    g.beginPath(); g.ellipse(x - r * 0.25, y - r * 0.4, r * 0.8, r * 0.35, 0, 0, TAU);
    g.fillStyle = 'rgba(160,170,160,0.08)'; g.fill();
  }
  g.restore();
  // sandy lip along the surface (shallow, gentle parts)
  g.beginPath();
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i], y = G_(x);
    if (i === 0) g.moveTo(x, y - 0.4); else g.lineTo(x, y - 0.4);
  }
  for (let i = xs.length - 1; i >= 0; i--) {
    const x = xs[i], y = G_(x);
    const sl = Math.abs(G_(x + 3) - G_(x - 3)) / 6;
    g.lineTo(x, y + (1 - smoothstep(0.4, 1.2, sl)) * 4.5 * (1 - smoothstep(60, 400, y)) + 0.3);
  }
  g.closePath();
  g.fillStyle = 'rgba(128,134,114,0.7)'; g.fill();
  // reef boulders sitting on the slope: ledges to swim around, algae on their backs
  for (let x = X0 + 20 + rng() * 30; x < X1 - 20; x += lerp(18, 46, rng())) {
    const y = G_(x);
    if (y < Math.max(Y0 - 20, 14) || y > Y1 + 20 || (x > I.shoreL - 10 && x < I.shoreR + 10)) continue;
    const sl = (G_(x + 6) - G_(x - 6)) / 12;
    const big = rng() < 0.3 ? 2 : 1;
    const w = lerp(12, 28, rng()) * big, h = lerp(7, 16, rng()) * big;
    const poly = rockPoly(rng, 10);
    g.save(); g.translate(x, y + h * 0.35); g.rotate(Math.atan(sl) * 0.6);
    rockShape(g, 0, 0, w, h, poly);
    const rg = g.createLinearGradient(0, -h, 0, 0);
    rg.addColorStop(0, 'rgb(74,96,96)'); rg.addColorStop(1, 'rgb(26,38,44)');
    g.fillStyle = rg; g.fill();
    g.beginPath(); g.ellipse(-w * 0.06, -h * 0.92, w * 0.3, h * 0.2, 0, 0, TAU);
    g.fillStyle = 'rgba(96,132,92,0.55)'; g.fill();
    g.restore();
  }

  // reef life on the slope
  const corals = [[200, 118, 116], [214, 140, 92], [130, 96, 152], [206, 184, 104], [96, 152, 140], [176, 74, 74], [226, 200, 190]];
  const shallow = (y) => 1 - smoothstep(150, 420, y);
  for (let k = 0; k < (X1 - X0) / 7; k++) {
    const x = lerp(X0 + 6, X1 - 6, rng());
    const y = G_(x);
    if (y < Math.max(Y0 - 30, 6) || y > Y1 + 30) continue;
    const sh = shallow(y);
    if (rng() > 0.25 + sh * 0.75) continue;
    const col = corals[Math.floor(rng() * corals.length)];
    const dim = mixColor(col, [30, 44, 52], 0.25 + (1 - sh) * 0.55);
    const t = rng();
    const s = lerp(0.7, 1.4, rng()) * (0.7 + sh * 0.5);
    if (t < 0.28) {
      // branching coral
      g.strokeStyle = rgb(dim); g.lineCap = 'round';
      const br = (bx, by, a, len, w, d) => {
        const ex = bx + Math.cos(a) * len, ey = by + Math.sin(a) * len;
        g.lineWidth = w; g.beginPath(); g.moveTo(bx, by); g.lineTo(ex, ey); g.stroke();
        if (d > 0) { br(ex, ey, a - lerp(0.3, 0.6, rng()), len * 0.75, w * 0.75, d - 1); br(ex, ey, a + lerp(0.3, 0.6, rng()), len * 0.75, w * 0.75, d - 1); }
      };
      br(x, y + 1, -Math.PI / 2 + (rng() - 0.5) * 0.4, 6 * s, 2 * s, 3);
    } else if (t < 0.45) {
      // sea fan
      g.strokeStyle = rgba(dim, 0.85); g.lineWidth = 0.5;
      const fh = 16 * s, fw = 12 * s;
      g.beginPath();
      for (let j = 0; j <= 9; j++) { const a = -Math.PI / 2 + lerp(-0.9, 0.9, j / 9); g.moveTo(x, y); g.quadraticCurveTo(x + Math.cos(a) * fw * 0.5, y + Math.sin(a) * fh * 0.5, x + Math.cos(a) * fw, y + Math.sin(a) * fh); }
      for (let j = 1; j <= 3; j++) { g.moveTo(x - fw * j / 3.4, y - fh * j / 3.6); g.quadraticCurveTo(x, y - fh * j / 2.8, x + fw * j / 3.4, y - fh * j / 3.6); }
      g.stroke();
    } else if (t < 0.62) {
      // brain coral dome
      const r = 5 * s;
      g.beginPath(); g.ellipse(x, y + 1, r * 1.2, r, 0, Math.PI, TAU); g.closePath();
      g.fillStyle = rgb(dim); g.fill();
      g.strokeStyle = rgba(mixColor(dim, [0, 0, 0], 0.4), 0.8); g.lineWidth = 0.4;
      g.beginPath(); for (let j = 1; j < 4; j++) { g.moveTo(x - r * 1.1 + j * 0.4, y + 0.5); g.quadraticCurveTo(x + (rng() - 0.5) * 2, y - r * j / 3.6, x + r * 1.1 - j * 0.4, y + 0.5); } g.stroke();
    } else if (t < 0.76) {
      // tube sponges
      const n = 2 + Math.floor(rng() * 3);
      for (let j = 0; j < n; j++) {
        const tx = x + (j - n / 2) * 2.6 * s, th = lerp(5, 12, rng()) * s;
        g.fillStyle = rgb(mixColor(dim, [0, 0, 0], j * 0.08));
        g.beginPath(); g.moveTo(tx - 1.1 * s, y + 1); g.lineTo(tx - 1.3 * s, y - th); g.lineTo(tx + 1.3 * s, y - th); g.lineTo(tx + 1.1 * s, y + 1); g.closePath(); g.fill();
        g.fillStyle = 'rgba(10,14,18,0.6)'; g.beginPath(); g.ellipse(tx, y - th, 1.1 * s, 0.5 * s, 0, 0, TAU); g.fill();
      }
    } else if (t < 0.86 && y < 140) {
      // sea grass
      g.strokeStyle = rgba(mixColor([70, 120, 70], [30, 44, 52], 0.3), 0.85); g.lineWidth = 0.7;
      g.beginPath();
      for (let j = 0; j < 6; j++) { const gx = x + (j - 3) * 1.2, h = lerp(6, 14, rng()); g.moveTo(gx, y + 0.5); g.quadraticCurveTo(gx + 2, y - h * 0.5, gx + (rng() - 0.5) * 5, y - h); }
      g.stroke();
    } else {
      // anemone
      g.strokeStyle = rgb(dim); g.lineWidth = 0.7;
      g.beginPath();
      for (let j = 0; j < 9; j++) { const a = -Math.PI / 2 + lerp(-1.1, 1.1, j / 8); g.moveTo(x, y - 1.5 * s); g.quadraticCurveTo(x + Math.cos(a) * 3 * s, y - 2 * s + Math.sin(a) * 3 * s, x + Math.cos(a) * 5 * s, y - 1.5 * s + Math.sin(a) * 5 * s); }
      g.stroke();
      g.fillStyle = rgb(mixColor(dim, [0, 0, 0], 0.3)); g.beginPath(); g.ellipse(x, y, 2 * s, 1.6 * s, 0, Math.PI, TAU); g.fill();
    }
  }
  // fade the bottom of the shallow canvas into the deep one, and both ends into the seabed
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'destination-out';
  const W = S.cv.width, H = S.cv.height;
  if (Y1 < I.maxD) {
    const fy = H - 24 * res;
    const fg = g.createLinearGradient(0, fy, 0, H);
    fg.addColorStop(0, 'rgba(0,0,0,0)'); fg.addColorStop(1, 'rgba(0,0,0,1)');
    g.fillStyle = fg; g.fillRect(0, fy, W, H - fy);
  }
  const ew = 50 * res;
  let eg = g.createLinearGradient(0, 0, ew, 0);
  eg.addColorStop(0, 'rgba(0,0,0,1)'); eg.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = eg; g.fillRect(0, 0, ew, H);
  eg = g.createLinearGradient(W - ew, 0, W, 0);
  eg.addColorStop(0, 'rgba(0,0,0,0)'); eg.addColorStop(1, 'rgba(0,0,0,1)');
  g.fillStyle = eg; g.fillRect(W - ew, 0, ew, H);
  g.restore();
  return S;
}

// ------------------------------------------------------------------ the lighthouse tower
const TOWER = { h: 236, wb: 60, wt: 40 };
function towerLamp(I) { return { x: I.towerX, y: gy(I, I.towerX) - TOWER.h - 20 }; }
function lampOn(G) { return smoothstep(0.35, 0.8, nightK(G)); }
// How strongly the real beam shows at distance d. sky.js paints the far lighthouse (and its
// beam) on the horizon until the raft reaches x ≈ 19000–19600; the real beam takes over in
// step with that fade so the two never sweep the sky at the same time.
function beamK(G, d) {
  const rx = G.raft && Number.isFinite(G.raft.x) ? G.raft.x : 0;
  const skyVis = smoothstep(15000, 15400, rx) * (1 - smoothstep(19000, 19600, rx));
  return lampOn(G) * (1 - smoothstep(900, 1500, d)) * (1 - skyVis);
}

function renderTower(I, night) {
  const cx = I.towerX, base = gy(I, cx) + 4;
  const X0 = cx - 50, X1 = cx + 50, Y0 = base - TOWER.h - 66, Y1 = base + 6;
  const S = surface(X0, Y0, X1, Y1, RES_TOWER), g = S.g;
  const rng = seeded(909);
  const white = night ? [74, 82, 108] : [226, 218, 198], whiteD = night ? [30, 34, 50] : [150, 140, 126], whiteL = night ? [126, 140, 182] : [248, 244, 230];
  const rust = night ? [58, 40, 52] : [150, 76, 54], iron = night ? [16, 18, 26] : [44, 46, 52], ironL = night ? [80, 92, 126] : [120, 124, 128];
  const H = TOWER.h, top = base - H;
  const wAt = (y) => lerp(TOWER.wb, TOWER.wt, (base - y) / H) / 2;
  // plinth
  g.fillStyle = rgb(mixColor(whiteD, [0, 0, 0], 0.15));
  g.beginPath(); g.moveTo(cx - 42, base + 4); g.lineTo(cx - 38, base - 8); g.lineTo(cx + 38, base - 8); g.lineTo(cx + 42, base + 4); g.closePath(); g.fill();
  g.fillStyle = rgba(whiteL, 0.35); g.fillRect(cx - 38, base - 8, 76, 1.2);
  // body (cylindrical shading)
  g.beginPath(); g.moveTo(cx - wAt(base - 8), base - 8); g.lineTo(cx - wAt(top), top); g.lineTo(cx + wAt(top), top); g.lineTo(cx + wAt(base - 8), base - 8); g.closePath();
  const bg = g.createLinearGradient(cx - 32, 0, cx + 32, 0);
  bg.addColorStop(0, rgb(mixColor(white, whiteD, 0.5)));
  bg.addColorStop(0.28, rgb(whiteL));
  bg.addColorStop(0.55, rgb(white));
  bg.addColorStop(0.85, rgb(whiteD));
  bg.addColorStop(1, rgb(mixColor(whiteD, [0, 0, 0], 0.3)));
  g.fillStyle = bg; g.fill();
  g.save(); g.clip();
  // stone courses
  g.strokeStyle = rgba(whiteD, 0.55); g.lineWidth = 0.35;
  for (let y = base - 8, row = 0; y > top; y -= 7.5, row++) {
    g.beginPath(); g.moveTo(cx - 40, y); g.lineTo(cx + 40, y); g.stroke();
    const w = wAt(y);
    for (let x = -w + ((row % 2) ? 5 : 0); x < w; x += 10) { g.beginPath(); g.moveTo(cx + x, y); g.lineTo(cx + x, y - 7.5); g.stroke(); }
  }
  // the faded rust band and weathering streaks
  g.fillStyle = rgba(rust, 0.75); g.fillRect(cx - 40, top + 36, 80, 22);
  g.fillStyle = rgba(rust, 0.5); g.fillRect(cx - 40, top + 118, 80, 14);
  for (let k = 0; k < 26; k++) {
    const x = cx + lerp(-28, 28, rng()), y = lerp(top, base - 30, rng()), len = lerp(10, 50, rng());
    const sg = g.createLinearGradient(0, y, 0, y + len);
    sg.addColorStop(0, rgba(mixColor(whiteD, rust, 0.4), 0.4)); sg.addColorStop(1, rgba(whiteD, 0));
    g.fillStyle = sg; g.fillRect(x, y, lerp(0.6, 1.8, rng()), len);
  }
  // vines from the bottom
  g.strokeStyle = rgb(night ? [16, 26, 30] : [62, 92, 54]); g.lineWidth = 1;
  for (let k = 0; k < 7; k++) {
    let x = cx + lerp(-30, 30, rng()), y = base - 8;
    g.beginPath(); g.moveTo(x, y);
    const n = 6 + Math.floor(rng() * 8);
    for (let j = 0; j < n; j++) { const nx = x + (rng() - 0.5) * 8, ny = y - lerp(4, 9, rng()); g.quadraticCurveTo(x + (rng() - 0.5) * 6, (y + ny) / 2, nx, ny); x = nx; y = ny; }
    g.stroke();
  }
  g.fillStyle = rgb(night ? [18, 30, 34] : [76, 108, 62]);
  for (let k = 0; k < 40; k++) { const x = cx + lerp(-30, 30, rng()), y = base - 8 - Math.pow(rng(), 2) * 80; g.beginPath(); g.ellipse(x, y, 1.6, 1, rng() * 3, 0, TAU); g.fill(); }
  g.restore();
  // windows climbing the tower
  const win = (x, y) => {
    g.fillStyle = rgb(mixColor(whiteD, [0, 0, 0], 0.3));
    g.beginPath(); g.moveTo(x - 4, y + 7); g.lineTo(x - 4, y); g.arc(x, y, 4, Math.PI, 0); g.lineTo(x + 4, y + 7); g.closePath(); g.fill();
    g.fillStyle = rgb(night ? [6, 8, 14] : [36, 40, 52]);
    g.beginPath(); g.moveTo(x - 2.8, y + 6); g.lineTo(x - 2.8, y); g.arc(x, y, 2.8, Math.PI, 0); g.lineTo(x + 2.8, y + 6); g.closePath(); g.fill();
    g.fillStyle = rgba(whiteL, 0.6); g.fillRect(x - 4.5, y + 6.6, 9, 1.2);
  };
  win(cx - 6, base - 78); win(cx + 5, base - 140); win(cx - 3, base - 196);
  // the door
  const dx = cx, dy = base - 8;
  g.fillStyle = rgb(mixColor(whiteD, [0, 0, 0], 0.35));
  g.beginPath(); g.moveTo(dx - 10, dy); g.lineTo(dx - 10, dy - 19); g.arc(dx, dy - 19, 10, Math.PI, 0); g.lineTo(dx + 10, dy); g.closePath(); g.fill();
  g.fillStyle = rgb(night ? [26, 22, 26] : [96, 64, 40]);
  g.beginPath(); g.moveTo(dx - 7.5, dy); g.lineTo(dx - 7.5, dy - 19); g.arc(dx, dy - 19, 7.5, Math.PI, 0); g.lineTo(dx + 7.5, dy); g.closePath(); g.fill();
  g.strokeStyle = rgb(night ? [12, 10, 14] : [60, 38, 24]); g.lineWidth = 0.5;
  for (let k = -1; k <= 1; k++) { g.beginPath(); g.moveTo(dx + k * 2.6, dy); g.lineTo(dx + k * 2.6, dy - 24); g.stroke(); }
  g.fillStyle = rgb(iron); g.fillRect(dx - 7.5, dy - 18, 15, 1.2); g.fillRect(dx - 7.5, dy - 7, 15, 1.2);
  g.fillStyle = rgb(night ? [110, 100, 80] : [214, 176, 90]); g.beginPath(); g.arc(dx + 4.6, dy - 12, 0.9, 0, TAU); g.fill();
  // steps up to the door
  g.fillStyle = rgb(whiteD); g.fillRect(dx - 12, dy, 24, 2.4); g.fillRect(dx - 14, dy + 2.4, 28, 2.4);
  // gallery
  const gy0 = top;
  g.fillStyle = rgb(iron);
  g.beginPath(); g.moveTo(cx - 32, gy0); g.lineTo(cx + 32, gy0); g.lineTo(cx + 26, gy0 + 6); g.lineTo(cx - 26, gy0 + 6); g.closePath(); g.fill();
  g.fillStyle = rgba(ironL, 0.6); g.fillRect(cx - 32, gy0 - 0.5, 64, 1);
  g.strokeStyle = rgb(iron); g.lineWidth = 0.7;
  g.beginPath(); g.moveTo(cx - 31, gy0 - 10); g.lineTo(cx + 31, gy0 - 10);
  for (let x = -30; x <= 30; x += 4) { g.moveTo(cx + x, gy0); g.lineTo(cx + x, gy0 - 10); }
  g.stroke();
  // lantern room
  const lw = 15, lh = 26, ly = gy0 - lh;
  g.fillStyle = rgb(iron); g.fillRect(cx - lw - 2, gy0 - 4, (lw + 2) * 2, 4);
  if (!night) {
    const glass = g.createLinearGradient(cx - lw, ly, cx + lw, gy0);
    glass.addColorStop(0, 'rgb(190,214,222)'); glass.addColorStop(0.5, 'rgb(120,150,164)'); glass.addColorStop(1, 'rgb(70,86,98)');
    g.fillStyle = glass;
  } else g.fillStyle = 'rgb(40,36,40)';
  g.fillRect(cx - lw, ly, lw * 2, lh - 4);
  g.strokeStyle = rgb(iron); g.lineWidth = 1.4;
  for (let x = -lw; x <= lw; x += 7.5) { g.beginPath(); g.moveTo(cx + x, ly); g.lineTo(cx + x, gy0 - 4); g.stroke(); }
  // dome, finial, vane
  g.fillStyle = rgb(night ? [26, 40, 44] : [70, 112, 104]);
  g.beginPath(); g.moveTo(cx - lw - 4, ly); g.quadraticCurveTo(cx - lw, ly - 18, cx, ly - 20); g.quadraticCurveTo(cx + lw, ly - 18, cx + lw + 4, ly); g.closePath(); g.fill();
  g.fillStyle = rgba(whiteL, night ? 0.25 : 0.35);
  g.beginPath(); g.ellipse(cx - 6, ly - 10, 4, 6, -0.5, 0, TAU); g.fill();
  g.fillStyle = rgb(iron);
  g.beginPath(); g.arc(cx, ly - 22, 2.2, 0, TAU); g.fill();
  g.fillRect(cx - 0.5, ly - 36, 1, 14);
  g.beginPath(); g.moveTo(cx, ly - 34); g.lineTo(cx + 9, ly - 32.5); g.lineTo(cx + 6, ly - 31); g.lineTo(cx, ly - 31.5); g.closePath(); g.fill();
  return S;
}

// =====================================================================================
// drawing — back layer (behind debris, raft, creatures and the boy)
// =====================================================================================

export function drawBack(ctx, G) {
  const L = ensureStatic(G);
  const v = G.view;
  if (!(v && v.w > 1)) return;
  const left = v.left - 60, right = v.left + v.w + 60;
  const t = G.time;
  const FP = framePal(G);
  const wN = cacheNight(G);
  for (const I of L) {
    if (I.x1 < left - 300 || I.x0 > right + 300) {
      if (I.kind === 'lighthouse') drawBeam(ctx, G, I, FP);
      continue;
    }
    if (I.kind === 'lighthouse') drawBeam(ctx, G, I, FP);
    const asset = getAsset(I.kind === 'lighthouse' ? 'lighthouse' : 'island');
    const aboveVisible = v.top < 20;
    // far hazy hills (parallax)
    if (aboveVisible && !asset) drawFar(ctx, G, I, FP);
    // the tree line
    if (aboveVisible && !asset) {
      const sway = Math.sin(t * 0.55 + I.seed) * 0.012 * (0.5 + windOf(G));
      ctx.save();
      // shear around sea level (y = 0) so the roots stay put while the crowns sway
      ctx.transform(1, 0, sway, 1, 0, 0);
      if (wN < 0.999) blit(ctx, piece(I, 'back', 0), 1);
      if (wN > 0.001) blit(ctx, piece(I, 'back', 1), wN);
      ctx.restore();
    }
    // the reef below
    if (v.top + v.h > UNDER_TOP) {
      if (v.top + v.h > UNDER_SPLIT - 10) { const c = cacheOf(I); if (!c.under) piece(I, 'under', -1); if (c.deep && !c.deep.failed) blit(ctx, c.deep, 1); }
      blit(ctx, piece(I, 'under', -1), 1);
    }
    // the land
    if (v.top < LAND_BOTTOM) {
      if (wN < 0.999) blit(ctx, piece(I, 'land', 0), 1);
      if (wN > 0.001) blit(ctx, piece(I, 'land', 1), wN);
      if (asset) drawAsset(ctx, G, I, asset, wN);
    }
    if (I.kind === 'lighthouse' && !asset && v.top < 20) drawTower(ctx, G, I, FP, wN);
    if (!aboveVisible && v.top > LAND_BOTTOM) continue;
    drawProps(ctx, G, I, FP, left, right);
  }
}

function windOf(G) { const w = G.weather && G.weather.wind; return Number.isFinite(w) ? clamp(Math.abs(w), 0, 1.5) : 0.3; }

// Optional painted art (assets/island.*, assets/lighthouse.*): laid over the procedural
// terrain, bottom edge on the sea surface; darkened toward night like the rest.
function drawAsset(ctx, G, I, img, wN) {
  if (!img || !img.width) return;
  let x, y, w, h;
  if (I.kind === 'lighthouse') { h = 520; w = h * img.width / img.height; x = I.towerX - w / 2; y = 14 - h; }
  else { w = I.W * 1.12; h = w * img.height / img.width; x = I.cx - w / 2; y = 12 - h; }
  ctx.drawImage(img, x, y, w, h);
  if (wN > 0.01) {
    // toward night: multiply the painting by itself (deeper, darker; transparent parts stay clear)
    ctx.save();
    ctx.globalAlpha = 0.7 * wN;
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(img, x, y, w, h);
    ctx.restore();
  }
}

function drawFar(ctx, G, I, FP) {
  const pts = I.far;
  if (!pts.length) return;
  const camX = G.cam.x;
  const dx = clamp((camX - I.cx) * 0.1, -90, 90);
  const a = I.shoreL + I.beachL * 0.35, b = I.shoreR - I.beachR * 0.35;
  ctx.beginPath();
  ctx.moveTo(clamp(pts[0][0] + dx, a, b), 4);
  for (const p of pts) ctx.lineTo(clamp(p[0] + dx, a, b), p[1]);
  ctx.lineTo(clamp(pts[pts.length - 1][0] + dx, a, b), 4);
  ctx.closePath();
  ctx.fillStyle = FP.far;
  ctx.fill();
}

// ------------------------------------------------------------------ per-frame props
function drawProps(ctx, G, I, FP, left, right) {
  const t = G.time;
  const wind = windOf(G);
  // glowing mushrooms (tiny by day)
  for (const m of I.mush) {
    if (m.x < left || m.x > right) continue;
    drawMush(ctx, m, FP, t);
  }
  for (const p of I.props) {
    if (p.x < left - 80 || p.x > right + 80) continue;
    const a = RT(G).anim[I.id + ':' + p.key];
    switch (p.type) {
      case 'palm': drawPalm(ctx, p, t, FP, wind, a ? a.shake : 0, available(G, I, p) ? 1 : regrowth(G, I, p) * 0.7); break;
      case 'bush': drawBush(ctx, p, t, FP, wind, a ? a.shake : 0, available(G, I, p) ? 1 : 0); break;
      case 'rock': drawRock(ctx, p, FP, a ? a.hit : 0, available(G, I, p)); break;
      case 'wood': if (available(G, I, p)) drawWood(ctx, p, FP); break;
      case 'chest': { const st = pget(G, I); const opened = !!(st && st.c); const op = a && a.opening ? a.open : opened ? 1 : 0; drawChest(ctx, p, FP, op, t, G); break; }
    }
  }
  for (const ch of I.chimes) if (ch.x > left - 40 && ch.x < right + 40) drawChimes(ctx, ch, FP, t, wind, G);
  // crabs
  const crabs = RT(G).crabs[I.id];
  if (crabs) for (const c of crabs) if (c.x > left && c.x < right) drawCrab(ctx, c, gy(I, c.x), FP, t);
  // falling coconuts
  for (const f of RT(G).falls) {
    if (f.isl !== I.idx) continue;
    const k = 1 - smoothstep(f.life - 0.5, f.life, f.t);
    ctx.globalAlpha = k;
    ctx.save(); ctx.translate(f.x, f.y); ctx.rotate(f.rot);
    ctx.fillStyle = FP.coconut; ctx.beginPath(); ctx.arc(0, 0, 2.6, 0, TAU); ctx.fill();
    ctx.fillStyle = FP.coconutHi; ctx.beginPath(); ctx.arc(-0.8, -0.9, 1, 0, TAU); ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 1;
  }
  // sun glints on the tide pools
  if (FP.n < 0.4) {
    for (const p of I.pools) {
      const x = I.shoreL + p.c;
      if (x < left || x > right) continue;
      const y = gy(I, x - p.w * 0.6) + 0.1;
      for (let j = 0; j < 2; j++) {
        const gl = Math.pow(Math.max(0, Math.sin(t * (1.7 + j * 0.6) + p.c + j * 2)), 14) * (1 - FP.n * 2.5);
        if (gl < 0.03) continue;
        const gx = x + (j ? 0.35 : -0.3) * p.w;
        ctx.strokeStyle = 'rgba(255,252,236,' + gl.toFixed(3) + ')'; ctx.lineWidth = 0.5;
        ctx.beginPath(); ctx.moveTo(gx - 2.2, y); ctx.lineTo(gx + 2.2, y); ctx.moveTo(gx, y - 1.6); ctx.lineTo(gx, y + 1); ctx.stroke();
      }
    }
  }
  // eyes watching from the tree line
  if (FP.n > 0.6) {
    for (const w of I.watch) {
      if (w.x < left || w.x > right) continue;
      const k = watcherOpen(G, w);
      if (k < 0.02) continue;
      ctx.fillStyle = 'rgba(220,236,255,' + (0.9 * k).toFixed(3) + ')';
      for (const sx of [-w.gap / 2, w.gap / 2]) { ctx.beginPath(); ctx.ellipse(w.x + sx, w.y, 0.9 * w.s, 0.5 * w.s, 0, 0, TAU); ctx.fill(); }
    }
  }
  // fireflies
  if (FP.n > 0.3) {
    const k = smoothstep(0.3, 0.8, FP.n);
    for (const f of I.flies) {
      if (f.x < left || f.x > right) continue;
      const p = flyPos(f, t);
      if (p.b < 0.05) continue;
      ctx.fillStyle = 'rgba(214,255,150,' + (0.18 * p.b * k).toFixed(3) + ')';
      ctx.beginPath(); ctx.arc(p.x, p.y, 3.2, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(240,255,200,' + (0.95 * p.b * k).toFixed(3) + ')';
      ctx.beginPath(); ctx.arc(p.x, p.y, 0.9, 0, TAU); ctx.fill();
    }
  }
  drawMist(ctx, G, I, FP, left, right);
}

// Low mist after dark (and a little at dawn): soft sprites drifting along the ground.
let MIST = null;
function mistSprite() {
  if (MIST || typeof document === 'undefined') return MIST;
  const c = makeCanvas(96, 48), g = c.getContext('2d');
  const gr = g.createRadialGradient(48, 24, 0, 48, 24, 48);
  gr.addColorStop(0, 'rgba(214,226,246,1)'); gr.addColorStop(0.5, 'rgba(214,226,246,0.45)'); gr.addColorStop(1, 'rgba(214,226,246,0)');
  g.setTransform(1, 0, 0, 0.5, 0, 12);
  g.fillStyle = gr; g.fillRect(0, 0, 96, 96);
  MIST = c;
  return c;
}
function drawMist(ctx, G, I, FP, left, right) {
  const ph = G.phase || 0;
  const dawn = smoothstep(0.93, 0.99, ph) + (1 - smoothstep(0.02, 0.1, ph)) * (ph < 0.5 ? 1 : 0);
  const k = Math.max(smoothstep(0.55, 0.95, FP.n), clamp(dawn, 0, 1) * 0.7);
  if (k < 0.02 || !I.mist.length) return;
  const sp = mistSprite();
  if (!sp) return;
  const L = I.shoreL + I.beachL * 0.5, W = I.W - (I.beachL + I.beachR) * 0.5;
  ctx.save();
  for (const m of I.mist) {
    const x = L + frac(m.u + G.time * m.sp / W) * W;
    if (x + m.w < left || x - m.w > right) continue;
    const edge = Math.min(1, (x - L) / 60, (L + W - x) / 60);
    const y = gy(I, x) + m.dy - m.h * 0.15;
    ctx.globalAlpha = 0.3 * k * m.a * clamp(edge, 0, 1);
    ctx.drawImage(sp, x - m.w, y - m.h, m.w * 2, m.h * 2);
  }
  ctx.restore();
}

function palmTop(p, t, sway) {
  return { x: p.x + p.lean * p.h + sway, y: p.y + 2 - p.h };
}

function drawPalm(ctx, p, t, FP, wind, shake, coco) {
  const sway = (Math.sin(t * 0.8 + p.ph) * 0.65 + Math.sin(t * 1.9 + p.ph * 2) * 0.35) * (1.2 + wind * 2.4) + Math.sin(t * 34) * shake * 3.5;
  const bx = p.x, by = p.y + 2;
  const top = palmTop(p, t, sway);
  const cx = bx + p.lean * p.h * 0.25 + p.bend, cy = by - p.h * 0.55;
  // trunk
  const N = 14;
  const L = [], R = [];
  for (let i = 0; i <= N; i++) {
    const u = i / N, iu = 1 - u;
    const x = iu * iu * bx + 2 * iu * u * cx + u * u * top.x;
    const y = iu * iu * by + 2 * iu * u * cy + u * u * top.y;
    const dx = 2 * iu * (cx - bx) + 2 * u * (top.x - cx), dy = 2 * iu * (cy - by) + 2 * u * (top.y - cy);
    const l = Math.hypot(dx, dy) || 1;
    const w = lerp(3.4, 1.9, Math.pow(u, 0.8)) * p.thick + (i === 0 ? 1.2 : 0);
    L.push([x - (dy / l) * w, y + (dx / l) * w]); R.push([x + (dy / l) * w, y - (dx / l) * w]);
  }
  ctx.beginPath();
  ctx.moveTo(L[0][0], L[0][1]);
  for (let i = 1; i <= N; i++) ctx.lineTo(L[i][0], L[i][1]);
  for (let i = N; i >= 0; i--) ctx.lineTo(R[i][0], R[i][1]);
  ctx.closePath();
  ctx.fillStyle = FP.ptrunk; ctx.fill();
  // shaded side + ring scars
  ctx.beginPath();
  for (let i = 0; i <= N; i++) { const m = [(L[i][0] * 0.45 + R[i][0] * 0.55), (L[i][1] * 0.45 + R[i][1] * 0.55)]; i ? ctx.lineTo(m[0], m[1]) : ctx.moveTo(m[0], m[1]); }
  for (let i = N; i >= 0; i--) ctx.lineTo(R[i][0], R[i][1]);
  ctx.closePath();
  ctx.fillStyle = FP.ptrunkDark; ctx.fill();
  ctx.strokeStyle = FP.ptrunkDark; ctx.lineWidth = 0.55;
  ctx.beginPath();
  for (let i = 1; i < N * 2; i++) {
    const u = i / (N * 2), k = Math.floor(u * N), f = u * N - k;
    if (k >= N) break;
    const lx = lerp(L[k][0], L[k + 1][0], f), ly = lerp(L[k][1], L[k + 1][1], f);
    const rx = lerp(R[k][0], R[k + 1][0], f), ry = lerp(R[k][1], R[k + 1][1], f);
    ctx.moveTo(lx, ly); ctx.quadraticCurveTo((lx + rx) / 2, (ly + ry) / 2 + 1.1, rx, ry);
  }
  ctx.stroke();
  ctx.strokeStyle = FP.ptrunkHi; ctx.lineWidth = 0.7; ctx.globalAlpha = 0.6;
  ctx.beginPath();
  for (let i = 0; i <= N; i++) { const m = [(L[i][0] * 0.8 + R[i][0] * 0.2), (L[i][1] * 0.8 + R[i][1] * 0.2)]; i ? ctx.lineTo(m[0], m[1]) : ctx.moveTo(m[0], m[1]); }
  ctx.stroke();
  ctx.globalAlpha = 1;
  // fronds behind the coconuts
  const nf = p.fa.length;
  const fr = (k, col, hiAlpha) => {
    const wob = Math.sin(t * 2.1 + k * 1.3 + p.ph) * 0.05 * (1 + wind * 1.5) + Math.sin(t * 30 + k) * shake * 0.18;
    const a = p.fa[k] + sway * 0.012 + wob;
    const tip = frondShape(ctx, top.x, top.y, a, p.fl[k], 0.38 + 0.08 * Math.sin(t * 1.3 + k), 12);
    ctx.fillStyle = col; ctx.fill();
    if (hiAlpha > 0) {
      ctx.strokeStyle = FP.frondHi; ctx.globalAlpha = hiAlpha; ctx.lineWidth = 0.6;
      // the spine, starting a little away from the crown so the strokes don't pile up there
      const sx = lerp(top.x, tip[2], 0.3), sy = lerp(top.y, tip[3], 0.3);
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.quadraticCurveTo(tip[2], tip[3], tip[0], tip[1]); ctx.stroke();
      ctx.globalAlpha = 1;
    }
  };
  for (let k = 1; k < nf; k += 2) fr(k, FP.frondDark, 0);
  // coconuts
  if (coco > 0.05) {
    const n = p.nc;
    for (let i = 0; i < n; i++) {
      const ox = (i - (n - 1) / 2) * 3.2, oy = 3 + (i % 2) * 1.6;
      const r = 2.5 * (0.5 + 0.5 * coco);
      ctx.fillStyle = coco < 1 ? FP.frond : FP.coconut;
      ctx.beginPath(); ctx.arc(top.x + ox, top.y + oy, r, 0, TAU); ctx.fill();
      ctx.fillStyle = FP.coconutHi; ctx.globalAlpha = 0.7;
      ctx.beginPath(); ctx.arc(top.x + ox - r * 0.35, top.y + oy - r * 0.35, r * 0.38, 0, TAU); ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
  for (let k = 0; k < nf; k += 2) fr(k, FP.frond, 0.55);
  // crown knot
  ctx.fillStyle = FP.ptrunkDark;
  ctx.beginPath(); ctx.ellipse(top.x, top.y + 0.5, 2.6, 1.8, 0, 0, TAU); ctx.fill();
}

function drawBush(ctx, p, t, FP, wind, shake, berries) {
  const sw = Math.sin(t * 1.4 + p.ph) * 0.6 * (0.5 + wind) + Math.sin(t * 28) * shake * 1.5;
  ctx.save();
  ctx.translate(p.x, p.y + 2);
  ctx.transform(1, 0, sw * 0.03, 1, 0, 0);
  for (const b of p.blobs) { ctx.beginPath(); blobPath(ctx, b.dx, b.dy, b.r, 8, (b.dx * 10) | 0, 0.3); ctx.fillStyle = FP.bushDark; ctx.fill(); }
  for (const b of p.blobs) { ctx.beginPath(); blobPath(ctx, b.dx - b.r * 0.12, b.dy - b.r * 0.2, b.r * 0.78, 7, (b.dy * 10) | 0, 0.3); ctx.fillStyle = FP.bush; ctx.fill(); }
  ctx.fillStyle = FP.bushHi; ctx.globalAlpha = 0.65;
  for (const b of p.blobs) { if (b.dy > -4) continue; ctx.beginPath(); ctx.ellipse(b.dx - b.r * 0.3, b.dy - b.r * 0.5, b.r * 0.35, b.r * 0.22, -0.4, 0, TAU); ctx.fill(); }
  ctx.globalAlpha = 1;
  if (berries > 0) {
    for (const be of p.berries) {
      ctx.fillStyle = FP.berry; ctx.beginPath(); ctx.arc(be.dx, be.dy, be.r, 0, TAU); ctx.fill();
      ctx.fillStyle = FP.berryHi; ctx.beginPath(); ctx.arc(be.dx - be.r * 0.35, be.dy - be.r * 0.35, be.r * 0.35, 0, TAU); ctx.fill();
    }
  }
  ctx.restore();
}

function drawRock(ctx, p, FP, hit, avail) {
  const jx = hit > 0 ? Math.sin(hit * 60) * hit * 1.2 : 0;
  const x = p.x + jx, base = p.y + 3;
  const w = p.w * (avail ? 1 : 0.86), h = p.h * (avail ? 1 : 0.8);
  rockShape(ctx, x, base, w, h, p.poly);
  ctx.fillStyle = FP.rock; ctx.fill();
  ctx.save(); ctx.clip();
  ctx.beginPath(); ctx.ellipse(x - w * 0.18, base - h * 0.9, w * 0.42, h * 0.45, -0.2, 0, TAU);
  ctx.fillStyle = FP.rockLit; ctx.globalAlpha = 0.65; ctx.fill(); ctx.globalAlpha = 1;
  ctx.beginPath(); ctx.moveTo(x + w * 0.1, base - h * 1.2); ctx.lineTo(x + w * 0.3, base - h * 0.4); ctx.lineTo(x + w * 0.6, base); ctx.lineTo(x + w * 0.6, base - h * 1.2); ctx.closePath();
  ctx.fillStyle = FP.rockDark; ctx.globalAlpha = 0.45; ctx.fill(); ctx.globalAlpha = 1;
  if (p.moss > 0.35) { ctx.beginPath(); ctx.ellipse(x - w * 0.12, base - h * 1.0, w * 0.3, h * 0.2, 0, 0, TAU); ctx.fillStyle = FP.moss; ctx.fill(); }
  ctx.strokeStyle = FP.rockDark; ctx.lineWidth = 0.6;
  ctx.beginPath(); ctx.moveTo(x - w * 0.05, base - h * 0.85); ctx.lineTo(x + w * 0.05, base - h * 0.5); ctx.lineTo(x - w * 0.08, base - h * 0.15);
  if (!avail) { ctx.moveTo(x + w * 0.05, base - h * 0.5); ctx.lineTo(x + w * 0.28, base - h * 0.62); }
  ctx.stroke();
  if (!avail) { ctx.fillStyle = FP.rockLit; ctx.globalAlpha = 0.5; ctx.beginPath(); ctx.moveTo(x + w * 0.1, base - h * 0.95); ctx.lineTo(x + w * 0.32, base - h * 0.6); ctx.lineTo(x + w * 0.12, base - h * 0.45); ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1; }
  ctx.restore();
  if (!avail) { ctx.fillStyle = FP.rock; for (let k = 0; k < 3; k++) { ctx.beginPath(); ctx.ellipse(x + w * 0.45 + k * 2.2, p.y + 0.6, 1.3, 0.9, 0, 0, TAU); ctx.fill(); } }
}

function drawWood(ctx, p, FP) {
  for (const lg of p.logs) {
    ctx.save();
    ctx.translate(p.x + lg.dx, p.y + lg.dy + 1.5);
    ctx.rotate(lg.rot);
    const l = lg.len, r = lg.r;
    ctx.fillStyle = FP.drift;
    ctx.beginPath(); ctx.moveTo(-l / 2, -r); ctx.lineTo(l / 2, -r * 0.85); ctx.quadraticCurveTo(l / 2 + r * 0.6, 0, l / 2, r * 0.85); ctx.lineTo(-l / 2, r); ctx.closePath(); ctx.fill();
    ctx.fillStyle = FP.driftDark; ctx.fillRect(-l / 2, r * 0.25, l, r * 0.75);
    ctx.fillStyle = FP.driftHi; ctx.globalAlpha = 0.7; ctx.fillRect(-l / 2 + 1, -r * 0.8, l - 2, r * 0.35); ctx.globalAlpha = 1;
    ctx.strokeStyle = FP.driftDark; ctx.lineWidth = 0.4;
    ctx.beginPath(); ctx.moveTo(-l * 0.3, -r * 0.2); ctx.lineTo(l * 0.1, -r * 0.1); ctx.moveTo(-l * 0.1, r * 0.1); ctx.lineTo(l * 0.35, 0); ctx.stroke();
    // end grain
    ctx.fillStyle = FP.driftHi; ctx.beginPath(); ctx.ellipse(-l / 2, 0, r * 0.45, r, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = FP.driftDark; ctx.beginPath(); ctx.ellipse(-l / 2, 0, r * 0.22, r * 0.5, 0, 0, TAU); ctx.stroke();
    if (lg.knot > 0.6) { ctx.fillStyle = FP.driftDark; ctx.beginPath(); ctx.ellipse(l * (lg.knot - 0.75), -r * 0.2, 1, 0.6, 0, 0, TAU); ctx.fill(); }
    ctx.restore();
  }
  if (p.branch) {
    ctx.strokeStyle = FP.driftDark; ctx.lineWidth = 0.9;
    ctx.beginPath(); ctx.moveTo(p.x + 4, p.y - 4); ctx.quadraticCurveTo(p.x + 8, p.y - 9, p.x + 12 + p.branch * 3, p.y - 11); ctx.stroke();
  }
}

function drawChest(ctx, p, FP, open, t, G) {
  ctx.save();
  ctx.translate(p.x, p.y + p.sunk);
  ctx.rotate(p.tilt);
  const w = 19, h = 11;
  // box
  ctx.fillStyle = FP.chest; ctx.fillRect(-w / 2, -h, w, h);
  ctx.fillStyle = FP.chestDark; ctx.fillRect(-w / 2, -h * 0.35, w, h * 0.35);
  ctx.strokeStyle = FP.chestDark; ctx.lineWidth = 0.4;
  ctx.beginPath(); ctx.moveTo(-w / 2, -h * 0.66); ctx.lineTo(w / 2, -h * 0.66); ctx.stroke();
  ctx.fillStyle = FP.iron; ctx.fillRect(-w / 2 + 2.4, -h, 2, h); ctx.fillRect(w / 2 - 4.4, -h, 2, h);
  ctx.fillStyle = FP.ironHi; ctx.globalAlpha = 0.5; ctx.fillRect(-w / 2 + 2.4, -h, 0.6, h); ctx.fillRect(w / 2 - 4.4, -h, 0.6, h); ctx.globalAlpha = 1;
  // inside glow when open
  if (open > 0.02) {
    ctx.fillStyle = FP.chestDark; ctx.fillRect(-w / 2 + 0.8, -h - 2.2, w - 1.6, 2.4);
    const n = 1 - FP.n * 0.5;
    ctx.fillStyle = 'rgba(255,214,140,' + (0.35 * open * n).toFixed(3) + ')';
    ctx.beginPath(); ctx.ellipse(0, -h - 1, w * 0.4, 2.4, 0, 0, TAU); ctx.fill();
  }
  // lid (hinged at the back-left)
  ctx.save();
  ctx.translate(-w / 2, -h);
  ctx.rotate(-open * 1.95);
  ctx.fillStyle = FP.chest;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -3); ctx.quadraticCurveTo(w / 2, -6.5, w, -3); ctx.lineTo(w, 0); ctx.closePath(); ctx.fill();
  ctx.fillStyle = FP.chestHi; ctx.globalAlpha = 0.55;
  ctx.beginPath(); ctx.moveTo(1, -3.2); ctx.quadraticCurveTo(w / 2, -6.2, w - 1, -3.2); ctx.quadraticCurveTo(w / 2, -5, 1, -2.4); ctx.closePath(); ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = FP.iron; ctx.fillRect(2.4, -4.2, 2, 4.2); ctx.fillRect(w - 4.4, -4.2, 2, 4.2);
  ctx.restore();
  // lock plate + a glint that invites a look
  if (open < 0.1) {
    ctx.fillStyle = FP.brass; ctx.fillRect(-1.6, -h - 0.5, 3.2, 3.6);
    ctx.fillStyle = FP.chestDark; ctx.fillRect(-0.4, -h + 1, 0.8, 1.5);
    const gl = Math.pow(Math.max(0, Math.sin(t * 1.3 + p.x)), 30) * (1 - FP.n);
    if (gl > 0.02) {
      ctx.strokeStyle = 'rgba(255,250,220,' + gl.toFixed(3) + ')'; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(0, -h - 4); ctx.lineTo(0, -h + 3); ctx.moveTo(-3.5, -h + 0.8); ctx.lineTo(3.5, -h + 0.8); ctx.stroke();
    }
  }
  ctx.restore();
  // sand drifted against its foot (on the beach) or soil and grass grown over it (inland)
  ctx.fillStyle = p.onSand ? FP.sand : FP.soil;
  ctx.beginPath(); ctx.moveTo(p.x - 13, p.y + 2); ctx.quadraticCurveTo(p.x - 6, p.y - 1.6, p.x, p.y - 0.6); ctx.quadraticCurveTo(p.x + 7, p.y - 1.4, p.x + 13, p.y + 2); ctx.closePath(); ctx.fill();
  if (!p.onSand) {
    ctx.strokeStyle = FP.grassF2; ctx.lineWidth = 0.6;
    ctx.beginPath();
    for (let k = 0; k < 9; k++) { const gx = p.x - 11 + k * 2.7, h = 3 + ((k * 7) % 5); ctx.moveTo(gx, p.y + 0.5); ctx.quadraticCurveTo(gx + 0.5, p.y - h * 0.6, gx + (k % 2 ? 1.5 : -1.2), p.y - h); }
    ctx.stroke();
  }
}

function drawMush(ctx, m, FP, t) {
  const glow = smoothstep(0.35, 0.9, FP.n);
  for (const c of m.caps) {
    const x = m.x + c.dx, y = m.y + 1;
    ctx.strokeStyle = FP.mushStem; ctx.lineWidth = 0.6;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 0.3, y - c.h); ctx.stroke();
    if (glow > 0.02) {
      ctx.fillStyle = 'rgba(110,220,255,' + (0.22 * glow * (0.8 + 0.2 * Math.sin(t * 1.3 + m.ph))).toFixed(3) + ')';
      ctx.beginPath(); ctx.arc(x, y - c.h, c.r * 2.6, 0, TAU); ctx.fill();
    }
    ctx.fillStyle = FP.mush;
    ctx.beginPath(); ctx.ellipse(x + 0.3, y - c.h, c.r, c.r * 0.6, 0, Math.PI, TAU); ctx.closePath(); ctx.fill();
  }
}

function drawChimes(ctx, ch, FP, t, wind, G) {
  const x = ch.x, y = ch.y;
  // a driftwood frame: two posts and a crossbar
  ctx.strokeStyle = FP.post; ctx.lineWidth = 2; ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x - ch.w / 2, y + 1); ctx.lineTo(x - ch.w / 2 + 2, y - ch.h);
  ctx.moveTo(x + ch.w / 2, y + 1); ctx.lineTo(x + ch.w / 2 - 1, y - ch.h - 1);
  ctx.moveTo(x - ch.w / 2 - 3, y - ch.h + 1); ctx.quadraticCurveTo(x, y - ch.h - 4, x + ch.w / 2 + 4, y - ch.h);
  ctx.stroke();
  const glint = 1 - FP.n * 0.4;
  for (const s of ch.strings) {
    const sx = x + s.dx, sy = y - ch.h - 1.5;
    const sw = Math.sin(t * (1.6 + s.len * 0.03) + s.ph) * (0.12 + wind * 0.25);
    const ex = sx + Math.sin(sw) * s.len, ey = sy + Math.cos(sw) * s.len;
    ctx.strokeStyle = FP.string; ctx.lineWidth = 0.35;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
    for (let j = 1; j <= s.n; j++) {
      const u = j / s.n;
      const px = lerp(sx, ex, u), py = lerp(sy, ey, u);
      if (s.glass && j === s.n) {
        ctx.fillStyle = 'rgba(120,190,170,' + (0.75 * glint).toFixed(3) + ')';
        ctx.beginPath(); ctx.ellipse(px, py + 2.6, 1.6, 3, sw, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,' + (0.5 * glint).toFixed(3) + ')'; ctx.fillRect(px - 0.8, py + 1, 0.5, 2);
      } else {
        ctx.fillStyle = FP.chime;
        ctx.beginPath(); ctx.moveTo(px - 1.4, py + 0.6); ctx.quadraticCurveTo(px, py - 1.6, px + 1.4, py + 0.6); ctx.closePath(); ctx.fill();
      }
    }
  }
}

function drawCrab(ctx, c, gyv, FP, t) {
  const s = c.s;
  const hide = c.hide;
  const x = c.x, y = gyv + 1;
  const walk = c.st === 'walk' || c.st === 'flee';
  const bob = walk ? Math.abs(Math.sin(c.ph)) * 0.5 : 0;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s * (c.dir || 1), s);
  // legs
  if (hide < 0.9) {
    ctx.strokeStyle = FP.crabDark; ctx.lineWidth = 0.55;
    ctx.beginPath();
    for (let k = 0; k < 3; k++) {
      const ph = c.ph + k * 2.1;
      const lx = -1.5 + k * 1.6, kx = lx + 1.2 + Math.sin(ph) * 0.8 * (walk ? 1 : 0), ky = -2.6 - Math.max(0, Math.cos(ph)) * 0.6 * (walk ? 1 : 0);
      ctx.moveTo(lx, -2 + hide * 2); ctx.lineTo(kx, ky + hide * 2); ctx.lineTo(kx + 1.2, 0);
    }
    ctx.stroke();
    // body + claws + eyes
    ctx.fillStyle = FP.crab;
    ctx.beginPath(); ctx.ellipse(1.8, -2.4 - bob + hide * 2, 2.2, 1.4, 0, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(4.4, -2.2 - bob + hide * 2, 1.4, 1, -0.4, 0, TAU); ctx.fill();
    ctx.strokeStyle = FP.crab; ctx.lineWidth = 0.4;
    ctx.beginPath(); ctx.moveTo(2.6, -3.4 - bob + hide * 2); ctx.lineTo(3, -5 - bob + hide * 2.5); ctx.moveTo(1.6, -3.4 - bob + hide * 2); ctx.lineTo(1.7, -4.8 - bob + hide * 2.5); ctx.stroke();
    ctx.fillStyle = '#111'; ctx.fillRect(2.8, -5.4 - bob + hide * 2.5, 0.7, 0.7); ctx.fillRect(1.4, -5.2 - bob + hide * 2.5, 0.7, 0.7);
  }
  // the bottle-cap shell
  const capCol = mixColor(c.cap, [16, 22, 36], FP.n * 0.75);
  ctx.save();
  ctx.translate(-0.8, -2.6 - bob + hide * 1.6);
  ctx.rotate(-0.25 + hide * 0.25);
  ctx.fillStyle = rgb(capCol);
  ctx.beginPath(); ctx.moveTo(-3.6, 1.6); ctx.lineTo(-3.2, -2.2); ctx.lineTo(3.2, -2.2); ctx.lineTo(3.6, 1.6); ctx.closePath(); ctx.fill();
  ctx.fillStyle = rgba(mixColor(capCol, [0, 0, 0], 0.35), 1);
  for (let k = -3; k <= 3; k += 1.2) ctx.fillRect(k, -1.8, 0.45, 3.2);
  ctx.fillStyle = rgba([255, 255, 255], 0.35 * (1 - FP.n * 0.6)); ctx.fillRect(-3, -2.2, 6, 0.6);
  ctx.restore();
  ctx.restore();
}

// ------------------------------------------------------------------ the lighthouse
function drawTower(ctx, G, I, FP, wN) {
  if (wN < 0.999) blit(ctx, piece(I, 'tower', 0), 1);
  if (wN > 0.001) blit(ctx, piece(I, 'tower', 1), wN);
  const on = lampOn(G);
  if (on <= 0.01) return;
  const L = towerLamp(I);
  const top = gy(I, I.towerX) + 4 - TOWER.h;
  const fl = 0.92 + 0.08 * noise1(G.time * 3, 5);
  // the glowing lantern room
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createLinearGradient(0, top - 26, 0, top - 4);
  g.addColorStop(0, 'rgba(255,236,180,' + (0.85 * on * fl).toFixed(3) + ')');
  g.addColorStop(1, 'rgba(255,170,90,' + (0.7 * on * fl).toFixed(3) + ')');
  ctx.fillStyle = g;
  ctx.fillRect(I.towerX - 15, top - 26, 30, 22);
  const r = 46;
  const rg = ctx.createRadialGradient(L.x, L.y, 0, L.x, L.y, r);
  rg.addColorStop(0, 'rgba(255,240,200,' + (0.9 * on).toFixed(3) + ')');
  rg.addColorStop(0.25, 'rgba(255,214,150,' + (0.4 * on).toFixed(3) + ')');
  rg.addColorStop(1, 'rgba(255,190,120,0)');
  ctx.fillStyle = rg;
  ctx.fillRect(L.x - r, L.y - r, r * 2, r * 2);
  ctx.restore();
}

function drawBeam(ctx, G, I, FP) {
  const on = lampOn(G);
  if (on <= 0.01) return;
  const L = towerLamp(I);
  const d = Math.abs(L.x - G.cam.x);
  const k = beamK(G, d);
  if (k <= 0.01) return;
  const th = G.time * 0.9;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const sgn of [1, -1]) {
    const c = Math.cos(th) * sgn;
    const face = Math.pow(Math.max(0, Math.sin(th) * sgn), 8);
    if (c > 0.02) {
      const len = 1700 * c;
      const half = 10 + 70 * c;
      const ex = L.x + len, ey = L.y + len * 0.05;
      const g = ctx.createLinearGradient(L.x, L.y, ex, ey);
      g.addColorStop(0, 'rgba(255,236,190,' + (0.42 * k * (0.4 + 0.6 * c)).toFixed(3) + ')');
      g.addColorStop(0.4, 'rgba(255,226,170,' + (0.14 * k * c).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(255,220,160,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(L.x, L.y - 3);
      ctx.lineTo(ex, ey - half);
      ctx.lineTo(ex, ey + half * 0.75);
      ctx.lineTo(L.x, L.y + 3);
      ctx.closePath();
      ctx.fill();
    } else if (c < -0.02) {
      // the opposite lens points the other way
      const cc = -c, len = 1700 * cc, half = 10 + 70 * cc;
      const ex = L.x - len, ey = L.y + len * 0.05;
      const g = ctx.createLinearGradient(L.x, L.y, ex, ey);
      g.addColorStop(0, 'rgba(255,236,190,' + (0.42 * k * (0.4 + 0.6 * cc)).toFixed(3) + ')');
      g.addColorStop(0.4, 'rgba(255,226,170,' + (0.14 * k * cc).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(255,220,160,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(L.x, L.y - 3); ctx.lineTo(ex, ey - half); ctx.lineTo(ex, ey + half * 0.75); ctx.lineTo(L.x, L.y + 3); ctx.closePath();
      ctx.fill();
    }
    if (face > 0.02 && sgn > 0) {
      const r = 30 + 120 * face;
      const rg = ctx.createRadialGradient(L.x, L.y, 0, L.x, L.y, r);
      rg.addColorStop(0, 'rgba(255,250,230,' + (0.9 * k * face).toFixed(3) + ')');
      rg.addColorStop(0.2, 'rgba(255,230,180,' + (0.35 * k * face).toFixed(3) + ')');
      rg.addColorStop(1, 'rgba(255,220,160,0)');
      ctx.fillStyle = rg;
      ctx.fillRect(L.x - r, L.y - r, r * 2, r * 2);
    }
  }
  ctx.restore();
}

// =====================================================================================
// drawing — front layer (over the boy): the beast, then foreground grass and leaves
// =====================================================================================

export function drawFront(ctx, G) {
  const L = ensureStatic(G);
  const v = G.view;
  if (!(v && v.w > 1)) return;
  const FP = framePal(G);
  const rt = G.islandsRt;
  const B = rt && rt.beast;
  if (B && B.alpha + B.eyes > 0.01) drawBeast(ctx, G, B, FP);
  if (v.top > 20) return;
  const left = v.left - 30, right = v.left + v.w + 30;
  const t = G.time, wind = windOf(G);
  const P = G.player;
  for (const I of L) {
    if (I.x1 < left || I.x0 > right) continue;
    for (const c of I.front) {
      if (c.x < left || c.x > right) continue;
      drawFrontClump(ctx, I, c, FP, t, wind, P);
    }
  }
}

function drawFrontClump(ctx, I, c, FP, t, wind, P) {
  const base = gy(I, c.x) + 2.5;
  const sway = Math.sin(t * 1.2 + c.ph) * (0.6 + wind) + Math.sin(t * 2.7 + c.ph * 2) * 0.4;
  const near = P && Math.abs(P.x - c.x) < 22 && Math.abs(P.y - base) < 26 ? P.x : null;
  // big leaf behind the blades
  if (c.leaf) {
    const a = c.leaf.a, len = c.leaf.len;
    const tipX = c.x + a * len + sway * 0.6, tipY = base - len * 0.55;
    ctx.beginPath();
    ctx.moveTo(c.x, base);
    ctx.quadraticCurveTo(c.x + a * len * 0.2, base - len * 0.85, tipX, tipY);
    ctx.quadraticCurveTo(c.x + a * len * 0.75, base - len * 0.05, c.x + a * 2, base);
    ctx.closePath();
    ctx.fillStyle = FP.leafF; ctx.fill();
    ctx.strokeStyle = FP.grassF2; ctx.lineWidth = 0.5; ctx.globalAlpha = 0.6;
    ctx.beginPath(); ctx.moveTo(c.x, base); ctx.quadraticCurveTo(c.x + a * len * 0.35, base - len * 0.5, tipX, tipY); ctx.stroke();
    ctx.globalAlpha = 1;
  }
  const paint = (alt) => {
    ctx.beginPath();
    for (const b of c.blades) {
      if (b.alt !== alt) continue;
      const bx = c.x + b.dx;
      let lean = b.lean * b.h + sway * (b.h / 14);
      if (near != null) { const d = bx - near; if (Math.abs(d) < 12) lean += sign(d) * (12 - Math.abs(d)) * 0.7; }
      const tx = bx + lean, ty = base - b.h * (1 - Math.min(0.35, Math.abs(lean) / b.h * 0.3));
      ctx.moveTo(bx - b.w, base);
      ctx.quadraticCurveTo(bx - b.w * 0.3 + lean * 0.35, base - b.h * 0.55, tx, ty);
      ctx.quadraticCurveTo(bx + b.w * 0.3 + lean * 0.35, base - b.h * 0.5, bx + b.w, base);
      ctx.closePath();
    }
    ctx.fill();
  };
  ctx.fillStyle = c.beach ? FP.duneF : FP.grassF2; paint(true);
  ctx.fillStyle = c.beach ? FP.duneF : FP.grassF; paint(false);
}

// ------------------------------------------------------------------ the beast
function drawBeast(ctx, G, B, FP) {
  const I = ISL[B.isl];
  if (!onScreen(G, B.x, B.y - 60, 160)) return;
  const pose = beastPose(B);
  const t = B.t;
  const sink = (1 - B.rise) * 30;
  const f = B.f;
  const body = B.alpha;
  const P = G.player;
  const warm = lanternLit(G) && P ? clamp(1 - Math.abs(P.x - B.x) / 170, 0, 1) : 0;
  const lg = (lx) => gy(I, B.x + f * lx) - B.y - sink;
  ctx.save();
  ctx.translate(B.x, B.y + sink);
  ctx.scale(f, 1);
  const { hip, sh, hump, neck, head } = pose;
  const jaw = B.jaw;
  const dark = 'rgb(8,9,14)', darker = 'rgb(3,4,7)';
  const rimA = (0.5 + 0.3 * FP.n) * body;
  const rim = 'rgba(160,182,228,' + rimA.toFixed(3) + ')';
  const warmRim = 'rgba(255,184,116,' + (0.65 * warm * body).toFixed(3) + ')';
  // outline key points
  const P0 = [hip[0] - 4, hip[1] + 2];
  const lowBack = [hip[0] - 12, hip[1] - 20];
  const shTop = [sh[0] + 2, sh[1] - 8];
  const neckTop = [neck[0] + 2, neck[1] - 4];
  const skullTop = [head[0] - 2, head[1] - 7.5];
  const snout = [head[0] + 13, head[1] + 1.5];
  const jawTip = [head[0] + 10 - jaw * 2, head[1] + 5 + jaw * 7];
  const chin = [head[0] - 2, head[1] + 6 + jaw * 3];
  const throat = [neck[0] - 2, neck[1] + 10];
  const chest = [sh[0] - 2, sh[1] + 24];
  const belly = [hip[0] + 8, hip[1] + 2];
  const backPath = () => {
    ctx.moveTo(lowBack[0], lowBack[1]);
    ctx.bezierCurveTo(lowBack[0] - 6, lowBack[1] - 26, hump[0] - 16, hump[1], hump[0], hump[1]);
    ctx.bezierCurveTo(hump[0] + 10, hump[1] - 2, shTop[0] - 4, shTop[1] - 4, shTop[0], shTop[1]);
    ctx.quadraticCurveTo(neckTop[0] - 4, neckTop[1] - 6, neckTop[0], neckTop[1]);
    ctx.quadraticCurveTo(skullTop[0] - 4, skullTop[1] - 2, skullTop[0], skullTop[1]);
    ctx.quadraticCurveTo(snout[0] - 2, snout[1] - 9, snout[0], snout[1]);
  };
  const backAt = (u) => bez(lowBack[0], lowBack[1], lowBack[0] - 6, lowBack[1] - 26, hump[0] - 16, hump[1], hump[0], hump[1], u);

  if (body > 0.01) {
    ctx.globalAlpha = body;
    // ---- far limbs, darker, behind the body
    const footF = footPos(B, 0.5, lg, hip);
    limb(ctx, hip[0] + 4, hip[1] - 2, footF[0], footF[1], 24, 26, 1, 9, 3.4, darker);
    toes(ctx, footF[0], footF[1], darker, 0.8);
    const shF = [sh[0] - 5, sh[1] + 3];
    const hf = B.handF || [sh[0] + 40, 0];
    const armF = limb(ctx, shF[0], shF[1], hf[0], hf[1], 60, 64, 1, 4.4, 2.2, darker);
    fingers(ctx, armF, B, darker, false, lg);
    // ---- hair hanging from the back like a torn cloak
    ctx.fillStyle = dark;
    ctx.beginPath();
    for (let k = 0; k < 15; k++) {
      const u = 0.04 + k / 15 * 0.96;
      const [px, py] = backAt(u);
      const len = (12 + hash1(k, 31) * 20) * (0.6 + 0.6 * (1 - u));
      const sw = Math.sin(t * 1.3 + k * 0.7) * 2.2 + B.vx * -0.02;
      const w = 2.6 + hash1(k, 32) * 2;
      ctx.moveTo(px - w, py + 2);
      ctx.quadraticCurveTo(px - w * 0.6 + sw * 0.4, py + len * 0.5, px - 1 + sw, py + len);
      ctx.quadraticCurveTo(px + w * 0.5 + sw * 0.4, py + len * 0.5, px + w, py + 3);
    }
    ctx.fill();
    // ---- body: hunched, gaunt, the head hanging below the shoulders
    ctx.beginPath();
    ctx.moveTo(P0[0], P0[1]);
    ctx.quadraticCurveTo(P0[0] - 10, P0[1] - 6, lowBack[0], lowBack[1]);
    ctx.bezierCurveTo(lowBack[0] - 6, lowBack[1] - 26, hump[0] - 16, hump[1], hump[0], hump[1]);
    ctx.bezierCurveTo(hump[0] + 10, hump[1] - 2, shTop[0] - 4, shTop[1] - 4, shTop[0], shTop[1]);
    ctx.quadraticCurveTo(neckTop[0] - 4, neckTop[1] - 6, neckTop[0], neckTop[1]);
    ctx.quadraticCurveTo(skullTop[0] - 4, skullTop[1] - 2, skullTop[0], skullTop[1]);
    ctx.quadraticCurveTo(snout[0] - 2, snout[1] - 9, snout[0], snout[1]);
    ctx.lineTo(jawTip[0], jawTip[1]);
    ctx.quadraticCurveTo(head[0] + 3, jawTip[1] + 1, chin[0], chin[1]);
    ctx.quadraticCurveTo(throat[0] + 4, throat[1] + 2, throat[0], throat[1]);
    ctx.quadraticCurveTo(chest[0] + 6, chest[1] - 6, chest[0], chest[1]);
    ctx.quadraticCurveTo(chest[0] - 9, chest[1] + 12, belly[0], belly[1]);
    ctx.quadraticCurveTo(P0[0] + 6, P0[1] + 4, P0[0], P0[1]);
    ctx.closePath();
    ctx.fillStyle = dark; ctx.fill();
    // haunch: the weight sits low on short bent legs
    ctx.beginPath(); ctx.ellipse(hip[0] - 3, hip[1] - 4, 10, 13, -0.3, 0, TAU); ctx.fill();
    // ragged fur along the back, swept backwards; long strands under the belly and arms
    ctx.beginPath();
    for (let k = 0; k < 30; k++) {
      const u = k / 29;
      const [px, py] = backAt(u);
      const [qx, qy] = backAt(Math.min(1, u + 0.02));
      let tx = qx - px, ty = qy - py;
      const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
      const nx = ty, ny = -tx;
      const len = 3 + hash1(k, 41) * 6 + (u < 0.3 ? 4 : 0);
      const sw = Math.sin(t * 2 + k * 0.8) * 0.9;
      const w = 1.6 + hash1(k, 42) * 1.2;
      ctx.moveTo(px - tx * w, py - ty * w);
      ctx.lineTo(px + nx * len - len * 0.5 + sw, py + ny * len + len * 0.3);
      ctx.lineTo(px + tx * w, py + ty * w);
    }
    const under = [[chest[0], chest[1]], [lerp(chest[0], belly[0], 0.5), lerp(chest[1], belly[1], 0.5) + 2], [belly[0], belly[1]], [P0[0] + 3, P0[1]]];
    for (let k = 0; k < 9; k++) {
      const u = k / 8 * (under.length - 1), i = Math.min(under.length - 2, Math.floor(u)), f2 = u - i;
      const px = lerp(under[i][0], under[i + 1][0], f2), py = lerp(under[i][1], under[i + 1][1], f2);
      const len = 6 + hash1(k, 51) * 12;
      const sw = Math.sin(t * 1.5 + k) * 1.5 - B.vx * 0.015;
      ctx.moveTo(px - 2, py - 1); ctx.quadraticCurveTo(px + sw * 0.5, py + len * 0.6, px + sw - 1, py + len); ctx.lineTo(px + 2, py - 1);
    }
    ctx.fill();
    // spine knuckles and ribs, barely there
    ctx.strokeStyle = 'rgba(46,52,70,0.75)'; ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (let k = 0; k < 4; k++) { const ry = chest[1] - 14 + k * 5; ctx.moveTo(chest[0] - 16 + k * 2, ry - 3); ctx.quadraticCurveTo(chest[0] - 6, ry + 2, chest[0] + 2 - k, ry + 1); }
    ctx.stroke();
    ctx.fillStyle = dark;
    for (let k = 0; k < 6; k++) { const [px, py] = backAt(0.35 + k * 0.11); ctx.beginPath(); ctx.arc(px + 0.6, py - 0.6, 2.2, 0, TAU); ctx.fill(); }
    // long strands hanging from the jaw
    ctx.strokeStyle = 'rgba(8,9,14,0.95)'; ctx.lineWidth = 0.7;
    ctx.beginPath();
    for (let k = 0; k < 6; k++) {
      const sx = head[0] - 3 + k * 2.6, sy = head[1] + 5 + jaw * 3;
      const len = 9 + hash1(k, 3) * 12;
      const sw = Math.sin(t * 1.4 + k * 0.9) * 2;
      ctx.moveTo(sx, sy); ctx.quadraticCurveTo(sx + sw, sy + len * 0.5, sx + sw * 1.6 - B.lean * 3, sy + len);
    }
    ctx.stroke();
    // teeth when the jaw opens: too many, too thin
    if (jaw > 0.15) {
      ctx.fillStyle = 'rgba(224,220,206,' + (0.9 * jaw * body).toFixed(3) + ')';
      ctx.beginPath();
      for (let k = 0; k < 10; k++) {
        const u = k / 9;
        const tx = lerp(head[0] - 1, snout[0] - 1, u), ty = lerp(head[1] + 4, snout[1] + 1, u);
        ctx.moveTo(tx - 0.5, ty); ctx.lineTo(tx + 0.1, ty + 2.8 * jaw); ctx.lineTo(tx + 0.6, ty);
        const bx = lerp(chin[0] + 1, jawTip[0] - 1, u), by = lerp(chin[1] - 0.5, jawTip[1] - 0.5, u);
        ctx.moveTo(bx - 0.5, by); ctx.lineTo(bx + 0.1, by - 2.4 * jaw); ctx.lineTo(bx + 0.6, by);
      }
      ctx.fill();
    }
    // moonlight along the top of the silhouette (soft halo + thin edge); lantern light on its face and chest
    ctx.beginPath(); backPath();
    ctx.globalAlpha = body * 0.25; ctx.lineWidth = 3; ctx.strokeStyle = rim; ctx.stroke();
    ctx.globalAlpha = body; ctx.lineWidth = 0.8; ctx.stroke();
    if (warm > 0.02) {
      ctx.beginPath();
      ctx.moveTo(snout[0], snout[1]); ctx.lineTo(jawTip[0], jawTip[1]);
      ctx.quadraticCurveTo(head[0] + 3, jawTip[1] + 1, chin[0], chin[1]);
      ctx.quadraticCurveTo(throat[0] + 4, throat[1] + 2, throat[0], throat[1]);
      ctx.quadraticCurveTo(chest[0] + 6, chest[1] - 6, chest[0], chest[1]);
      ctx.quadraticCurveTo(belly[0] + 6, belly[1] - 10, belly[0], belly[1]);
      ctx.lineWidth = 1.6; ctx.strokeStyle = warmRim; ctx.stroke();
    }
    // ---- near limbs
    const footN = footPos(B, 0, lg, hip);
    limb(ctx, hip[0], hip[1], footN[0], footN[1], 24, 26, 1, 10, 3.8, dark);
    toes(ctx, footN[0], footN[1], dark, 1);
    const hn = B.handN || [sh[0] + 54, 0];
    const armN = limb(ctx, sh[0], sh[1], hn[0], hn[1], 60, 64, 1, 5, 2.4, dark);
    fingers(ctx, armN, B, dark, true, lg);
    ctx.lineWidth = 0.8; ctx.strokeStyle = rim;
    ctx.beginPath(); ctx.moveTo(sh[0] + 1, sh[1] - 2.5); ctx.lineTo(armN[0], armN[1] - 2); ctx.lineTo(armN[2], armN[3] - 1); ctx.stroke();
    if (warm > 0.02) { ctx.strokeStyle = warmRim; ctx.beginPath(); ctx.moveTo(armN[0] + 2, armN[1]); ctx.lineTo(armN[2] + 1, armN[3]); ctx.stroke(); }
  }
  ctx.globalAlpha = 1;

  // ---- the eyes: pale, almost never blinking, visible before the body is
  if (B.eyes > 0.01) {
    const open = B.blink > 0 ? 0.12 : B.st === 'hesitate' ? 0.45 : 1;
    const ex = pose.eye[0], ey = pose.eye[1];
    const ea = B.eyes;
    const g = ctx.createRadialGradient(ex, ey, 0, ex, ey, 16);
    g.addColorStop(0, 'rgba(206,230,255,' + (0.55 * ea * open).toFixed(3) + ')');
    g.addColorStop(0.35, 'rgba(180,214,255,' + (0.16 * ea * open).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(160,200,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(ex - 16, ey - 16, 32, 32);
    ctx.fillStyle = 'rgba(238,247,255,' + (0.96 * ea).toFixed(3) + ')';
    ctx.beginPath(); ctx.ellipse(ex, ey, 2.2, 1.2 * open, -0.3, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(ex - 5, ey + 1, 1.5, 0.85 * open, -0.3, 0, TAU); ctx.fill();
    // a third eye that should not be there
    if (B.third > 0.05) {
      ctx.fillStyle = 'rgba(238,247,255,' + (0.85 * ea * B.third).toFixed(3) + ')';
      ctx.beginPath(); ctx.ellipse(ex - 2.2, ey - 4.2, 1.1, 0.75 * B.third, -0.3, 0, TAU); ctx.fill();
    }
  }
  ctx.restore();
}

function bez(x0, y0, x1, y1, x2, y2, x3, y3, u) {
  const iu = 1 - u;
  const a = iu * iu * iu, b = 3 * iu * iu * u, c = 3 * iu * u * u, d = u * u * u;
  return [a * x0 + b * x1 + c * x2 + d * x3, a * y0 + b * y1 + c * y2 + d * y3];
}

function footPos(B, off, lg, hip) {
  const u = frac(B.phF + off);
  const c = hip[0] + 6, half = 12;
  let x, lift = 0;
  if (u < 0.62) x = c + half * (1 - 2 * u / 0.62);
  else { const v = (u - 0.62) / 0.38; x = lerp(c - half, c + half, v); lift = Math.sin(v * Math.PI) * 6; }
  if (B.st === 'windup' || B.st === 'flinch') x = c + (off ? -10 : 8);
  return [x, lg(x) - lift];
}

// A tapered two-segment limb with knobbly joints. Returns [jx, jy, ex, ey].
function limb(ctx, ax, ay, bx, by, l1, l2, bend, w0, w1, col) {
  const [jx, jy, ex, ey] = ik(ax, ay, bx, by, l1, l2, bend);
  ctx.fillStyle = col;
  seg(ctx, ax, ay, jx, jy, w0, w0 * 0.5 + w1 * 0.3);
  seg(ctx, jx, jy, ex, ey, w0 * 0.55, w1 * 0.6);
  ctx.beginPath(); ctx.arc(jx, jy, w0 * 0.42, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.arc(ex, ey, w1 * 0.5, 0, TAU); ctx.fill();
  return [jx, jy, ex, ey];
}
function seg(ctx, ax, ay, bx, by, wa, wb) {
  const dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy) || 1;
  const nx = -dy / l, ny = dx / l;
  ctx.beginPath();
  ctx.moveTo(ax + nx * wa / 2, ay + ny * wa / 2);
  ctx.lineTo(bx + nx * wb / 2, by + ny * wb / 2);
  ctx.lineTo(bx - nx * wb / 2, by - ny * wb / 2);
  ctx.lineTo(ax - nx * wa / 2, ay - ny * wa / 2);
  ctx.closePath();
  ctx.fill();
}
function toes(ctx, x, y, col, k) {
  ctx.strokeStyle = col; ctx.lineWidth = 1.3 * k;
  ctx.beginPath();
  for (let i = 0; i < 3; i++) { ctx.moveTo(x, y - 1); ctx.quadraticCurveTo(x + 3 + i * 2, y - 2.5, x + 7 + i * 3, y); }
  ctx.moveTo(x, y - 1); ctx.lineTo(x - 4, y);
  ctx.stroke();
}
function fingers(ctx, arm, B, col, near, lg) {
  const [jx, jy, hx, hy] = arm;
  const dir = Math.atan2(hy - jy, hx - jx);
  const ground = lg(hx);
  const planted = hy > ground - 3;
  const spread = B.st === 'windup' || B.st === 'charge' || B.st === 'flinch' || (B.st === 'shore' && B.reachK > 0.3 && near);
  ctx.strokeStyle = col; ctx.lineWidth = near ? 1.3 : 1.1;
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    const s = i - 1.5;
    const tw = Math.sin(B.t * 3 + i * 1.7) * 0.12;
    let a1, a2;
    if (planted && !spread) { a1 = (i === 0 ? Math.PI - 0.3 : 0.1 + s * 0.3) + tw; a2 = a1 + (i === 0 ? -0.5 : 0.7); }
    else if (spread) { a1 = dir + s * 0.36 + tw; a2 = a1 + 0.3 * Math.sin(B.t * 4 + i); }
    else { a1 = dir + s * 0.2 + tw; a2 = a1 + 0.9; }
    const l1 = 9 + (i === 1 || i === 2 ? 3 : 0), l2 = 8;
    const mx = hx + Math.cos(a1) * l1, my = hy + Math.sin(a1) * l1;
    let ex = mx + Math.cos(a2) * l2, ey = my + Math.sin(a2) * l2;
    if (planted && !spread) { const gyy = lg(ex); if (ey > gyy) ey = gyy; if (my > gyy - 1.5) { /* knuckles up */ } }
    ctx.moveTo(hx, hy); ctx.quadraticCurveTo(mx, planted && !spread ? Math.min(my, hy) - 3 : my, ex, ey);
  }
  ctx.stroke();
}

// =====================================================================================
// per-frame palette
// =====================================================================================

let FPC = null;
function framePal(G) {
  const n = nightK(G);
  const ph = G.phase || 0;
  if (FPC && Math.abs(FPC.n - n) < 0.002 && Math.abs(FPC.ph - ph) < 0.002) return FPC;
  const out = { n, ph };
  for (const k in OBJ_DAY) out[k] = rgb(mixColor(OBJ_DAY[k], OBJ_NIGHT[k], n));
  // the far hills: the horizon haze of this hour, a touch darker and greener
  const hz = keyAt(HAZE_KEYS, ph);
  out.far = rgb(mixColor(hz, [30, 52, 50], 0.18 * (1 - n)));
  FPC = out;
  return out;
}
