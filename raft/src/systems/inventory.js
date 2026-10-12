// Items: the registry of everything the boy can carry, the inventory helpers every
// module uses, eating / drinking / healing, and the hand-drawn item icons.
//
// Icons are painted once with canvas 2D (ink outline, muted washes, a pale paper rim so
// they read on the dark UI) and cached as data URLs: iconURL(id) or ITEMS[id].icon.

import { C, say, statClamp } from '../core/state.js';
import { TAU, seeded, makeCanvas } from '../core/util.js';
import { sfx } from './audio.js';
import { hint } from '../core/input.js';

// =====================================================================================
// registry
// =====================================================================================
// cat: material | food | tool | placeable | story
// use: stat changes when eaten / drunk / applied (hunger, thirst, hp)

const DEFS = {
  wood:        { name: '木板',     cat: 'material',  desc: '泡过海水的旧木板，还很结实。造东西、扩建木筏都离不开它。' },
  plastic:     { name: '塑料',     cat: 'material',  desc: '瓶子、袋子、碎片……海上从来不缺这个。' },
  rope:        { name: '绳子',     cat: 'material',  desc: '从渔网上拆下来的绳子，打个结什么都能绑。' },
  cloth:       { name: '布',       cat: 'material',  desc: '一块褪了色的帆布，晒干了还能用。' },
  metal:       { name: '废铁',     cat: 'material',  desc: '生锈的铁皮和螺丝，敲一敲还能派上用场。' },
  leaf:        { name: '棕榈叶',   cat: 'material',  desc: '又宽又韧的叶子，可以编成垫子。' },
  stone:       { name: '石头',     cat: 'material',  desc: '岛上捡来的石头，沉甸甸的，压得住火。' },

  cooked_fish: { name: '烤鱼',     cat: 'food', desc: '外焦里嫩，还冒着热气。', use: { hunger: 35 } },
  can:         { name: '罐头',     cat: 'food', desc: '不知道是哪一年的罐头。', use: { hunger: 30 } },
  coconut:     { name: '椰子',     cat: 'food', desc: '椰汁解渴，椰肉顶饿。', use: { hunger: 15, thirst: 20 } },
  raw_fish:    { name: '生鱼',     cat: 'food', desc: '能吃，但又腥又凉，可能会闹肚子。最好烤一烤。', use: { hunger: 12 } },
  berry:       { name: '野果',     cat: 'food', desc: '岛上灌木里的小果子，酸酸甜甜。', use: { hunger: 8 } },
  water:       { name: '淡水',     cat: 'food', desc: '四周全是水，只有这一点能喝。', use: { thirst: 40 } },
  bandage:     { name: '绷带',     cat: 'food', desc: '把伤口缠起来，会好受很多。', use: { hp: 30 } },

  hook:        { name: '钩索',     cat: 'tool',
    get desc() { return hint('按住鼠标左键蓄力，松开抛出；钩住漂流物以后再按住，把它收回来。', '按住「使用」蓄力，松开抛出；钩住漂流物以后再按住，把它收回来。'); } },
  spear:       { name: '鱼叉',     cat: 'tool', desc: '刺鱼用的，也能把鲨鱼赶走。水下也能用。' },
  hammer:      { name: '锤子',     cat: 'tool', desc: '扩建、修补木筏，安装做好的东西。' },
  lantern:     { name: '提灯',     cat: 'tool', desc: '夜里和深水里会自己点亮。黑暗里的东西怕光。' },
  flippers:    { name: '脚蹼',     cat: 'tool', desc: '穿上以后，在水里游得更快。' },

  purifier:    { name: '净水器',   cat: 'placeable', desc: '让太阳把海水晒成淡水。下雨时接得更快。' },
  grill:       { name: '烤架',     cat: 'placeable', desc: '把生鱼烤熟。每次要烧掉一块木板。' },
  sail:        { name: '船帆',     cat: 'placeable', desc: '升起来，木筏会漂得快很多。' },
  lamp:        { name: '灯柱',     cat: 'placeable', desc: '夜里点亮它，鲨鱼就不敢来咬木筏；岛上林子里的东西也怕它的光。' },
  bed:         { name: '吊床',     cat: 'placeable', desc: '天黑以后躺上去，一觉睡到天亮。' },

  note:        { name: '漂流瓶信', cat: 'story', desc: '一个叫小满的女孩写的信。在日记里可以重新读。' },

  // names other modules may look up; never shown in the bag
  anchor:      { name: '锚',       cat: 'placeable', desc: '木筏的锚。', hidden: true },
  tile:        { name: '木筏板',   cat: 'placeable', desc: '多一块木筏，就多一块站的地方。', hidden: true },
};

export const ITEMS = {};
for (const [id, d] of Object.entries(DEFS)) {
  // copy property descriptors so texts that are getters (they follow keyboard vs touch) stay live
  ITEMS[id] = Object.defineProperties({ id }, Object.getOwnPropertyDescriptors(d));
  ITEMS[id].category = d.cat;
  Object.defineProperty(ITEMS[id], 'icon', { enumerable: false, get: () => iconURL(id) });
}

// Order in which items are listed in the bag.
export const ITEM_ORDER = Object.keys(DEFS).filter((id) => !DEFS[id].hidden);
export const CATEGORY_NAMES = { material: '材料', food: '食物 · 药品', tool: '工具', placeable: '木筏设施', story: '故事' };
export const itemName = (id) => (ITEMS[id] && ITEMS[id].name) || id;
export const isUsable = (id) => !!(ITEMS[id] && ITEMS[id].use);

// =====================================================================================
// inventory helpers
// =====================================================================================

const inv = (G) => (G.inv && typeof G.inv === 'object' ? G.inv : (G.inv = {}));

export function init(G) {
  const I = inv(G);
  for (const k of Object.keys(I)) {
    const n = Number(I[k]);
    I[k] = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }
  G.invRt = { lastPickSfx: 0 };
}

export const count = (G, id) => {
  const n = G && G.inv ? G.inv[id] : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
};

// Adds n of an item. Unless quiet, a "+2 木板" toast (merged with other pickups that
// arrive in the same moment) and a pickup sound.
export function addItem(G, id, n = 1, quiet = false) {
  n = Math.floor(Number(n) || 0);
  if (!id || n <= 0) return;
  const I = inv(G);
  I[id] = count(G, id) + n;
  if (quiet || G.demo) return;
  pickupToast(G, id, n);
  const rt = G.invRt || (G.invRt = { lastPickSfx: 0 });
  const now = G.time || 0;
  if (!(Math.abs(now - rt.lastPickSfx) < 0.12)) { rt.lastPickSfx = now; sfx('pickup'); }
}

function pickupToast(G, id, n) {
  const T = G.toasts;
  if (!Array.isArray(T)) return;
  const last = T[T.length - 1];
  if (last && last.pick && (last.t < 1.1 || last.text === pickText({ [id]: n }))) {
    last.pick[id] = (last.pick[id] || 0) + n;
    last.text = pickText(last.pick);
    last.t = Math.min(last.t, 0.25);
    return;
  }
  const pick = { [id]: n };
  say(G, pickText(pick), 'pickup');
  const t = T[T.length - 1];
  if (t && t.text === pickText(pick)) t.pick = pick;
}

function pickText(pick) {
  return Object.entries(pick).map(([k, v]) => '+' + v + ' ' + itemName(k)).join('　');
}

export function hasItems(G, cost) {
  if (!cost) return true;
  for (const k in cost) if (count(G, k) < cost[k]) return false;
  return true;
}

export function takeItems(G, cost) {
  if (!hasItems(G, cost)) return false;
  const I = inv(G);
  for (const k in cost) I[k] = count(G, k) - cost[k];
  return true;
}

// =====================================================================================
// eating, drinking, healing
// =====================================================================================

const EAT_LINES = {
  cooked_fish: ['烤鱼外焦里嫩，好香。', '热乎乎的烤鱼，吃完整个人都暖了。'],
  can: ['撬开罐头，是黄桃！甜得想哭。', '罐头里是午餐肉，咸咸的，真好吃。', '是一罐豆子。也很好吃。'],
  coconut: ['敲开椰子，椰汁甜甜的。', '椰汁凉凉的，椰肉也能吃。'],
  raw_fish: ['生鱼又腥又凉……总比饿着强。', '闭着眼睛把生鱼咽了下去。'],
  berry: ['野果酸酸甜甜的。', '一口一个，有点涩。'],
  water: ['咕嘟咕嘟……淡水真好喝。', '省着点喝。'],
  bandage: ['用绷带把伤口缠好了。', '伤口不那么疼了。'],
};
const pickLine = (id) => { const a = EAT_LINES[id] || ['……']; return a[Math.floor(Math.random() * a.length)]; };

export function useItem(G, id) {
  const it = ITEMS[id];
  const P = G && G.player;
  if (!it || !it.use || !P) return false;
  if (G.demo || P.dead || P.hp <= 0 || G.mode === 'dead') return false;
  if (count(G, id) <= 0) { say(G, '没有' + it.name + '了。'); return false; }
  if (P.underwater) { say(G, id === 'water' ? '在水下没法喝水' : id === 'bandage' ? '在水下没法包扎' : '在水下没法吃东西'); return false; }

  const u = it.use;
  const max = C.MAX_STAT;
  const needH = u.hunger ? max - (P.hunger || 0) : 0;
  const needT = u.thirst ? max - (P.thirst || 0) : 0;
  const needHp = u.hp ? max - (P.hp || 0) : 0;
  if (u.hp && needHp < 1) { say(G, '没有受伤，先留着吧。'); return false; }
  if (!u.hp && needH < 2 && needT < 2) {
    say(G, u.thirst && !u.hunger ? '还不渴。' : '已经吃饱了。');
    return false;
  }

  inv(G)[id] = count(G, id) - 1;
  if (u.hunger) P.hunger = statClamp((P.hunger || 0) + u.hunger);
  if (u.thirst) P.thirst = statClamp((P.thirst || 0) + u.thirst);
  if (u.hp) P.hp = statClamp((P.hp || 0) + u.hp);

  let line = pickLine(id);
  let kind = 'info';
  if (id === 'raw_fish' && (P.hunger > 70 || Math.random() < 0.35)) {
    P.hp = statClamp((P.hp || 0) - 4);
    if (P.hp < 1) P.hp = 1;   // a stomach ache never kills
    line = '生鱼又腥又凉……肚子有点不舒服。';
    kind = 'warn';
  }
  say(G, line, kind);
  sfx(id === 'water' || id === 'coconut' ? 'drink' : id === 'bandage' ? 'ui' : 'eat');
  return true;
}

// =====================================================================================
// hand-drawn icons
// =====================================================================================
// A tiny ink-and-wash kit, also used by the HUD for the codex drawings.

export const INK = '#20160f';
let RND = Math.random;
const J = (r) => (RND() - 0.5) * 2 * r;

export const ink = {
  INK, TAU,
  seed(s) { RND = seeded(s); },
  j: J,
  // closed / open smooth path through points (quadratic through midpoints)
  smooth(c, pts, closed = true) {
    const n = pts.length;
    if (n < 2) return;
    if (closed) {
      c.moveTo((pts[n - 1][0] + pts[0][0]) / 2, (pts[n - 1][1] + pts[0][1]) / 2);
      for (let i = 0; i < n; i++) {
        const p = pts[i], q = pts[(i + 1) % n];
        c.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
      }
      c.closePath();
    } else {
      c.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < n - 1; i++) {
        const p = pts[i], q = pts[i + 1];
        c.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
      }
      c.lineTo(pts[n - 1][0], pts[n - 1][1]);
    }
  },
  // irregular ellipse
  blob(c, cx, cy, rx, ry, jit = 0.05, n = 18, rot = 0) {
    const pts = [], cr = Math.cos(rot), sr = Math.sin(rot);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU, k = 1 + J(jit);
      const x = Math.cos(a) * rx * k, y = Math.sin(a) * ry * k;
      pts.push([cx + x * cr - y * sr, cy + x * sr + y * cr]);
    }
    c.beginPath(); ink.smooth(c, pts, true);
  },
  // polygon with slightly wavering straight edges
  poly(c, pts, jit = 0.6, sub = 3) {
    const n = pts.length;
    c.beginPath();
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      for (let s = 0; s < sub; s++) {
        const t = s / sub;
        const x = a[0] + (b[0] - a[0]) * t + (s ? J(jit) : 0), y = a[1] + (b[1] - a[1]) * t + (s ? J(jit) : 0);
        if (i === 0 && s === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
    }
    c.closePath();
  },
  // a hand-drawn line
  line(c, x0, y0, x1, y1, jit = 0.6, segs = 4) {
    c.beginPath(); c.moveTo(x0, y0);
    for (let i = 1; i <= segs; i++) {
      const t = i / segs;
      c.lineTo(x0 + (x1 - x0) * t + (i < segs ? J(jit) : 0), y0 + (y1 - y0) * t + (i < segs ? J(jit) : 0));
    }
  },
  lg(c, x0, y0, x1, y1, stops) {
    const g = c.createLinearGradient(x0, y0, x1, y1);
    for (const [t, col] of stops) g.addColorStop(t, col);
    return g;
  },
  rg(c, x, y, r0, r1, stops, fx, fy) {
    const g = c.createRadialGradient(fx == null ? x : fx, fy == null ? y : fy, r0, x, y, r1);
    for (const [t, col] of stops) g.addColorStop(t, col);
    return g;
  },
  // fill the current path, then ink its outline
  fs(c, fill, lw = 2.3, stroke = INK) {
    if (fill) { c.fillStyle = fill; c.fill(); }
    if (lw) { c.strokeStyle = stroke; c.lineWidth = lw; c.lineJoin = 'round'; c.lineCap = 'round'; c.stroke(); }
  },
  // a thick inked stroke with a colored core (ropes, shafts, handles)
  tube(c, buildPath, core, w = 4, lw = 2.2, hi) {
    c.lineJoin = 'round'; c.lineCap = 'round';
    buildPath(); c.strokeStyle = INK; c.lineWidth = w + lw * 2 * 0.8; c.stroke();
    buildPath(); c.strokeStyle = core; c.lineWidth = w; c.stroke();
    if (hi) { c.save(); c.translate(-w * 0.18, -w * 0.22); buildPath(); c.strokeStyle = hi; c.lineWidth = Math.max(0.8, w * 0.28); c.stroke(); c.restore(); }
  },
  glow(c, x, y, r, col, a = 0.5) {
    c.fillStyle = ink.rg(c, x, y, 0, r, [[0, `rgba(${col},${a})`], [0.45, `rgba(${col},${a * 0.35})`], [1, `rgba(${col},0)`]]);
    c.fillRect(x - r, y - r, r * 2, r * 2);
  },
};

const S = 64;
const WOOD = ['#a3744a', '#6b4a2e'];
const WOOD_L = ['#b88a5c', '#7a5434'];
const METAL = ['#a9aeb0', '#5b6166'];

function plank(c, x, y, w, h, a, cols) {
  c.save(); c.translate(x, y); c.rotate(a);
  ink.poly(c, [[-w / 2, -h / 2], [w / 2, -h / 2 + J(0.8)], [w / 2 - 1, h / 2], [-w / 2 + 1, h / 2 + J(0.6)]], 0.45, 3);
  ink.fs(c, ink.lg(c, 0, -h / 2, 0, h / 2, [[0, cols[0]], [1, cols[1]]]), 2.4);
  c.strokeStyle = 'rgba(40,24,12,0.55)'; c.lineWidth = 1;
  for (let k = 0; k < 2; k++) {
    const gy = -h / 2 + h * (0.34 + k * 0.32);
    c.beginPath(); c.moveTo(-w / 2 + 4, gy); c.bezierCurveTo(-w / 6, gy + J(1.6), w / 6, gy + J(1.6), w / 2 - 7, gy + J(1)); c.stroke();
  }
  c.beginPath(); c.ellipse(w * 0.14, h * 0.05, 2.8, 1.5, 0, 0, TAU); c.stroke();
  c.strokeStyle = 'rgba(255,232,196,0.38)'; c.lineWidth = 1.2;
  c.beginPath(); c.moveTo(-w / 2 + 3, -h / 2 + 1.9); c.lineTo(w / 2 - 4, -h / 2 + 1.7); c.stroke();
  c.fillStyle = '#2a2522';
  for (const nx of [-w / 2 + 4.5, w / 2 - 5.5]) { c.beginPath(); c.arc(nx, 0.5, 1.35, 0, TAU); c.fill(); }
  c.restore();
}

function fishBody(c, cooked) {
  c.beginPath();
  c.moveTo(22, 0);
  c.bezierCurveTo(17, -11, -3, -12.5, -14, -2.5);
  c.lineTo(-23, -10.5); c.quadraticCurveTo(-20, 0, -23, 10.5); c.lineTo(-14, 2.5);
  c.bezierCurveTo(-3, 12.5, 17, 11, 22, 0);
  c.closePath();
  const g = cooked
    ? ink.lg(c, 0, -11, 0, 11, [[0, '#6e3f1c'], [0.45, '#b9813f'], [1, '#e0b26a']])
    : ink.lg(c, 0, -11, 0, 11, [[0, '#4c6673'], [0.5, '#a3b9c2'], [1, '#e2e8e2']]);
  ink.fs(c, g, 2.4);
}

const DRAW = {
  wood(c) {
    plank(c, 31, 42, 50, 11.5, -0.1, WOOD);
    plank(c, 33, 26, 46, 10.5, 0.17, WOOD_L);
  },
  plastic(c) {
    c.save(); c.translate(32, 35); c.rotate(-0.55);
    c.beginPath();
    ink.smooth(c, [[-4.5, -17], [-4.5, -13], [-10, -6], [-10.5, 5], [-9.5, 16], [-5, 19.5], [5, 19.5], [9.5, 16], [10, 8.5], [7.5, 3], [10.5, -4], [4.5, -13], [4.5, -17]], true);
    ink.fs(c, ink.lg(c, -10, 0, 10, 0, [[0, 'rgba(120,175,182,0.92)'], [0.4, 'rgba(196,226,228,0.9)'], [1, 'rgba(88,138,148,0.92)']]), 2.3);
    ink.poly(c, [[-9.6, 0], [9.6, -0.5], [9.8, 8], [-9.8, 8.4]], 0.4, 2);
    ink.fs(c, 'rgba(222,196,140,0.85)', 1.2, 'rgba(32,22,15,0.7)');
    c.strokeStyle = 'rgba(32,22,15,0.55)'; c.lineWidth = 1;
    ink.line(c, -6, -8, -1, -5, 0.6, 2); c.stroke();
    ink.line(c, 3, 11, 7, 15, 0.6, 2); c.stroke();
    ink.line(c, 2, -7, 6, -10, 0.6, 2); c.stroke();
    c.strokeStyle = 'rgba(255,255,255,0.6)'; c.lineWidth = 1.6;
    c.beginPath(); c.moveTo(-6.5, -3); c.lineTo(-7, 14); c.stroke();
    ink.poly(c, [[-5.2, -23], [5.2, -23], [5.4, -16.5], [-5.4, -16.5]], 0.3, 2);
    ink.fs(c, ink.lg(c, 0, -23, 0, -16, [[0, '#5d88ad'], [1, '#2f5578']]), 2.1);
    c.restore();
  },
  rope(c) {
    const col = '#c8aa70', dk = 'rgba(110,86,44,0.95)';
    const rings = [[21, 12.5, 5], [15.5, 9, 3], [9.5, 5.5, 1.5]];
    for (const [rx, ry, dy] of rings) {
      const path = () => { c.beginPath(); c.ellipse(31, 32 + dy, rx, ry, -0.08, 0, TAU); };
      ink.tube(c, path, col, 4.4, 2.1);
      c.strokeStyle = dk; c.lineWidth = 1;
      for (let a = 0; a < TAU; a += 0.5) {
        const x = 31 + Math.cos(a) * rx, y = 32 + dy + Math.sin(a) * ry;
        c.beginPath(); c.moveTo(x - 1.4, y - 1.7); c.lineTo(x + 1.4, y + 1.7); c.stroke();
      }
    }
    const tail = () => { c.beginPath(); c.moveTo(51, 38); c.bezierCurveTo(57, 42, 52, 50, 58, 55); };
    ink.tube(c, tail, col, 4.2, 2);
    c.strokeStyle = INK; c.lineWidth = 1.1;
    for (const [dx, dy] of [[-2, 3], [0, 4], [2, 3]]) { c.beginPath(); c.moveTo(58, 55); c.lineTo(58 + dx, 55 + dy); c.stroke(); }
    c.strokeStyle = 'rgba(255,240,205,0.4)'; c.lineWidth = 1.2;
    c.beginPath(); c.ellipse(31, 37, 21, 12.5, -0.08, 3.6, 4.6); c.stroke();
  },
  cloth(c) {
    const layer = (x, y, w, h, a, c0, c1, stripe) => {
      c.save(); c.translate(x, y); c.rotate(a);
      c.beginPath();
      ink.smooth(c, [[-w / 2, -h / 2 + 2], [-w / 4, -h / 2 - 0.5], [w / 4, -h / 2 + 1], [w / 2, -h / 2], [w / 2 + 2, 0], [w / 2 + 1, h / 2], [0, h / 2 + 1.5], [-w / 2 - 1, h / 2 - 0.5], [-w / 2 - 2, 0]], true);
      ink.fs(c, ink.lg(c, 0, -h / 2, 0, h / 2, [[0, c0], [1, c1]]), 2.3);
      if (stripe) {
        c.strokeStyle = stripe; c.lineWidth = 2;
        for (const sy of [-h * 0.12, h * 0.2]) { c.beginPath(); c.moveTo(-w / 2 + 2, sy); c.quadraticCurveTo(0, sy + J(1.5), w / 2, sy - 1); c.stroke(); }
      }
      c.strokeStyle = 'rgba(32,20,14,0.55)'; c.lineWidth = 1.1;
      c.beginPath(); c.moveTo(w * 0.28, -h / 2 + 1); c.quadraticCurveTo(w * 0.36, 0, w * 0.3, h / 2); c.stroke();
      c.setLineDash([2.2, 2]); c.strokeStyle = 'rgba(245,230,200,0.7)'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(-w / 2 + 3, -h / 2 + 3.5); c.lineTo(w / 2 - 3, -h / 2 + 3); c.stroke();
      c.setLineDash([]);
      c.restore();
    };
    layer(32, 43, 44, 13, 0.04, '#8a4337', '#5d2b24');
    layer(31, 30, 40, 13, -0.07, '#b99158', '#7f6037', 'rgba(140,58,45,0.75)');
  },
  metal(c) {
    c.save(); c.translate(31, 33); c.rotate(-0.16);
    ink.poly(c, [[-21, -11], [5, -16], [21, -8], [19, 10], [-3, 15], [-20, 8]], 0.6, 2);
    ink.fs(c, ink.lg(c, -20, -14, 18, 14, [[0, METAL[0]], [1, METAL[1]]]), 2.4);
    c.beginPath(); c.moveTo(4, -15.5); c.lineTo(21, -8); c.lineTo(19, 10); c.lineTo(-2.5, 14.5); c.closePath();
    c.fillStyle = 'rgba(20,24,30,0.22)'; c.fill();
    c.strokeStyle = 'rgba(28,26,26,0.7)'; c.lineWidth = 1.3;
    ink.line(c, 4, -15.5, -2.5, 14.5, 0.5, 3); c.stroke();
    for (const [x, y, r] of [[-12, 3, 5], [12, -4, 4], [8, 8, 3.5], [-6, -8, 3]]) {
      ink.blob(c, x, y, r, r * 0.7, 0.25, 9); c.fillStyle = 'rgba(146,72,34,0.6)'; c.fill();
    }
    c.fillStyle = '#3a3634';
    for (const [x, y] of [[-16, -7], [-15, 5], [14, -6], [13, 7]]) {
      c.beginPath(); c.arc(x, y, 1.8, 0, TAU); c.fill();
      c.fillStyle = 'rgba(255,255,255,0.45)'; c.fillRect(x - 1, y - 1.2, 0.9, 0.9); c.fillStyle = '#3a3634';
    }
    c.strokeStyle = 'rgba(255,255,255,0.4)'; c.lineWidth = 1.2;
    c.beginPath(); c.moveTo(-18, -9); c.lineTo(3, -13.5); c.stroke();
    c.restore();
    c.save(); c.translate(48, 48); c.rotate(0.3);
    c.beginPath();
    for (let i = 0; i < 6; i++) { const a = (i / 6) * TAU; c[i ? 'lineTo' : 'moveTo'](Math.cos(a) * 6, Math.sin(a) * 6); }
    c.closePath(); ink.fs(c, '#7d8387', 2.1);
    c.beginPath(); c.arc(0, 0, 2.3, 0, TAU); ink.fs(c, '#2e2d2c', 1);
    c.restore();
  },
  leaf(c) {
    const P0 = [10, 56], P1 = [20, 32], P2 = [38, 16], P3 = [56, 9];
    const bz = (t) => {
      const u = 1 - t;
      return [u * u * u * P0[0] + 3 * u * u * t * P1[0] + 3 * u * t * t * P2[0] + t * t * t * P3[0],
        u * u * u * P0[1] + 3 * u * u * t * P1[1] + 3 * u * t * t * P2[1] + t * t * t * P3[1]];
    };
    let k = 0;
    for (let t = 0.14; t < 0.97; t += 0.085) {
      const p = bz(t), q = bz(t + 0.01);
      const a = Math.atan2(q[1] - p[1], q[0] - p[0]);
      for (const side of [-1, 1]) {
        const L = 17 * (1 - t * 0.55) + J(1.5);
        const d = a + side * (1.0 - t * 0.25) + 0.25;
        const tx = p[0] + Math.cos(d) * L, ty = p[1] + Math.sin(d) * L;
        const nx = -Math.sin(d) * 2.6, ny = Math.cos(d) * 2.6;
        const mx = (p[0] + tx) / 2, my = (p[1] + ty) / 2;
        c.beginPath(); c.moveTo(p[0], p[1]);
        c.quadraticCurveTo(mx + nx, my + ny, tx, ty);
        c.quadraticCurveTo(mx - nx, my - ny, p[0], p[1]);
        ink.fs(c, (k++ % 2) ? '#6f8f45' : '#58763a', 1.4);
      }
    }
    const stem = () => { c.beginPath(); c.moveTo(...P0); c.bezierCurveTo(...P1, ...P2, ...P3); };
    ink.tube(c, stem, '#8fa560', 2.2, 1.6);
  },
  stone(c) {
    ink.blob(c, 46, 45, 10, 7.5, 0.1, 12);
    ink.fs(c, ink.rg(c, 46, 45, 1, 11, [[0, '#8f8d86'], [1, '#55534f']], 43, 41), 2.2);
    ink.blob(c, 28, 38, 21, 15.5, 0.07, 15, -0.1);
    ink.fs(c, ink.rg(c, 28, 38, 2, 22, [[0, '#a8a69e'], [0.6, '#7c7a74'], [1, '#55534f']], 21, 30), 2.4);
    c.strokeStyle = 'rgba(30,26,22,0.7)'; c.lineWidth = 1.2;
    c.beginPath(); c.moveTo(33, 25); c.lineTo(30, 32); c.lineTo(34, 37); c.lineTo(31, 44); c.stroke();
    c.fillStyle = 'rgba(40,36,32,0.45)';
    for (let i = 0; i < 9; i++) { c.beginPath(); c.arc(16 + RND() * 24, 33 + RND() * 13, 0.8, 0, TAU); c.fill(); }
    c.strokeStyle = 'rgba(255,250,235,0.45)'; c.lineWidth = 1.8;
    c.beginPath(); c.ellipse(26, 35, 15, 10, -0.1, 3.5, 4.6); c.stroke();
  },
  coconut(c) {
    ink.blob(c, 31, 35, 19.5, 18, 0.04, 20);
    ink.fs(c, ink.rg(c, 31, 35, 2, 21, [[0, '#8a643d'], [0.7, '#5a3b20'], [1, '#3a2513']], 24, 28), 2.5);
    c.lineWidth = 0.9;
    for (let i = 0; i < 38; i++) {
      const a = RND() * TAU, r = 6 + RND() * 12;
      const x = 31 + Math.cos(a) * r, y = 35 + Math.sin(a) * r * 0.92;
      c.strokeStyle = i % 2 ? 'rgba(25,14,6,0.45)' : 'rgba(205,165,110,0.32)';
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a + 1.3) * 3.2, y + Math.sin(a + 1.3) * 3.2); c.stroke();
    }
    c.fillStyle = '#1d120a';
    for (const [x, y] of [[37, 25], [43, 29.5], [37.5, 31.5]]) { c.beginPath(); c.ellipse(x, y, 2.2, 1.7, 0.4, 0, TAU); c.fill(); }
    c.strokeStyle = 'rgba(255,226,180,0.35)'; c.lineWidth = 2;
    c.beginPath(); c.arc(31, 35, 14, 3.5, 4.4); c.stroke();
  },
  berry(c) {
    const leafAt = (x, y, a, l) => {
      c.save(); c.translate(x, y); c.rotate(a);
      c.beginPath(); c.moveTo(0, 0); c.quadraticCurveTo(l * 0.5, -5, l, 0); c.quadraticCurveTo(l * 0.5, 5, 0, 0);
      ink.fs(c, '#5e7a3c', 1.6);
      c.strokeStyle = 'rgba(30,40,16,0.6)'; c.lineWidth = 0.8; c.beginPath(); c.moveTo(1, 0); c.lineTo(l - 2, 0); c.stroke();
      c.restore();
    };
    c.strokeStyle = INK; c.lineWidth = 1.6;
    c.beginPath(); c.moveTo(34, 14); c.quadraticCurveTo(30, 20, 24, 30); c.moveTo(33, 16); c.quadraticCurveTo(38, 22, 41, 30); c.moveTo(32, 18); c.lineTo(32, 26); c.stroke();
    leafAt(34, 14, -0.5, 16); leafAt(33, 15, -2.6, 13);
    for (const [x, y, r] of [[22, 40, 8.5], [42, 39, 8], [32, 31, 7.6], [33, 47, 8.2]]) {
      ink.blob(c, x, y, r, r * 0.95, 0.04, 14);
      ink.fs(c, ink.rg(c, x, y, 0.5, r + 1, [[0, '#b84a68'], [0.55, '#7a2340'], [1, '#43101f']], x - r * 0.35, y - r * 0.4), 2.1);
      c.fillStyle = 'rgba(255,240,240,0.75)'; c.beginPath(); c.arc(x - r * 0.38, y - r * 0.38, r * 0.2, 0, TAU); c.fill();
    }
  },
  raw_fish(c) {
    c.save(); c.translate(32, 35); c.rotate(-0.12);
    c.beginPath(); c.moveTo(-1, -10.5); c.quadraticCurveTo(4, -17, 10, -9.5); ink.fs(c, '#566f7a', 1.8);
    fishBody(c, false);
    c.strokeStyle = 'rgba(30,40,46,0.5)'; c.lineWidth = 0.9;
    for (let i = 0; i < 4; i++) { c.beginPath(); c.arc(-6 + i * 5, -1, 3, -1, 1); c.stroke(); }
    c.strokeStyle = INK; c.lineWidth = 1.4;
    c.beginPath(); c.arc(12, 0, 6.5, -1.1, 1.1); c.stroke();
    c.beginPath(); c.moveTo(3, 4); c.quadraticCurveTo(0, 9, -4, 8); c.stroke();
    c.beginPath(); c.arc(16, -3, 2.7, 0, TAU); ink.fs(c, '#f0ece0', 1.2);
    c.fillStyle = INK; c.beginPath(); c.arc(16.5, -3, 1.4, 0, TAU); c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.65)'; c.lineWidth = 1.4;
    c.beginPath(); c.moveTo(-10, -6); c.quadraticCurveTo(2, -10, 14, -7); c.stroke();
    c.restore();
  },
  cooked_fish(c) {
    c.save(); c.translate(32, 38); c.rotate(-0.12);
    fishBody(c, true);
    c.strokeStyle = 'rgba(40,18,6,0.75)'; c.lineWidth = 2;
    for (const x of [-8, -1, 6]) { c.beginPath(); c.moveTo(x - 3, -6); c.lineTo(x + 3, 6); c.stroke(); }
    c.strokeStyle = INK; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(14.5, -5); c.lineTo(18, -1.5); c.moveTo(18, -5); c.lineTo(14.5, -1.5); c.stroke();
    c.strokeStyle = 'rgba(255,236,190,0.55)'; c.lineWidth = 1.4;
    c.beginPath(); c.moveTo(-10, -6); c.quadraticCurveTo(2, -10, 14, -7); c.stroke();
    c.restore();
    c.strokeStyle = 'rgba(245,240,230,0.85)'; c.lineWidth = 1.7; c.lineCap = 'round';
    for (const x of [24, 33, 42]) {
      c.beginPath(); c.moveTo(x, 22); c.bezierCurveTo(x - 4, 18, x + 4, 14, x, 9); c.stroke();
    }
  },
  can(c) {
    const x0 = 19, x1 = 45, top = 17, bot = 52, ry = 4.2, cx = 32;
    const body = () => {
      c.beginPath(); c.moveTo(x0, top); c.lineTo(x0 + J(0.4), bot); c.ellipse(cx, bot, (x1 - x0) / 2, ry, 0, Math.PI, 0, true);
      c.lineTo(x1, top); c.closePath();
    };
    body();
    ink.fs(c, ink.lg(c, x0, 0, x1, 0, [[0, '#62686c'], [0.3, '#c6c9c4'], [0.55, '#8f9497'], [1, '#4d5154']]), 0);
    c.save(); body(); c.clip();
    c.fillStyle = ink.lg(c, x0, 0, x1, 0, [[0, '#6a2a22'], [0.35, '#a24638'], [1, '#5a231d']]);
    c.fillRect(x0 - 2, 24, x1 - x0 + 4, 21);
    c.beginPath(); c.arc(cx, 34.5, 5.6, 0, TAU); c.fillStyle = '#e6b468'; c.fill();
    c.strokeStyle = 'rgba(40,20,10,0.6)'; c.lineWidth = 0.9; c.stroke();
    c.beginPath(); c.moveTo(cx, 29); c.quadraticCurveTo(cx + 4, 26, cx + 6, 27.5); c.strokeStyle = '#5e7a3c'; c.lineWidth = 1.6; c.stroke();
    c.strokeStyle = 'rgba(240,220,190,0.45)'; c.lineWidth = 0.9;
    c.beginPath(); c.moveTo(x0, 24.5); c.lineTo(x1, 24.5); c.moveTo(x0, 44.5); c.lineTo(x1, 44.5); c.stroke();
    c.restore();
    body(); ink.fs(c, null, 2.4);
    c.beginPath(); c.ellipse(cx, top, (x1 - x0) / 2, ry, 0, 0, TAU);
    ink.fs(c, ink.lg(c, x0, 0, x1, 0, [[0, '#8d9294'], [0.5, '#d6d8d3'], [1, '#7a7f82']]), 2.2);
    c.beginPath(); c.ellipse(cx, top, (x1 - x0) / 2 - 3, ry - 1.4, 0, 0, TAU); c.strokeStyle = 'rgba(40,40,40,0.5)'; c.lineWidth = 1; c.stroke();
    c.beginPath(); c.ellipse(cx + 4, top - 0.5, 3.4, 1.4, 0.1, 0, TAU); ink.fs(c, '#b9bcb8', 1);
    c.strokeStyle = 'rgba(30,30,30,0.6)'; c.lineWidth = 1.2;
    c.beginPath(); c.moveTo(x1 - 1, 38); c.quadraticCurveTo(x1 - 4, 41, x1 - 1, 45); c.stroke();
    c.strokeStyle = 'rgba(255,255,255,0.5)'; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(25, 47); c.lineTo(25, 50.5); c.moveTo(25, 19.5); c.lineTo(25, 23); c.stroke();
  },
  water(c) {
    const bottle = () => {
      c.beginPath();
      ink.smooth(c, [[28, 11], [28, 19], [22, 26], [20.5, 36], [21, 52], [25, 56], [39, 56], [43, 52], [43.5, 36], [42, 26], [36, 19], [36, 11]], true);
    };
    bottle(); ink.fs(c, 'rgba(206,232,236,0.42)', 0);
    c.save(); bottle(); c.clip();
    c.fillStyle = ink.lg(c, 0, 30, 0, 56, [[0, 'rgba(110,182,210,0.92)'], [1, 'rgba(38,104,140,0.95)']]);
    c.fillRect(16, 32, 32, 26);
    c.strokeStyle = 'rgba(220,245,250,0.85)'; c.lineWidth = 1.4;
    c.beginPath(); c.moveTo(18, 32.5); c.bezierCurveTo(26, 30.5, 34, 34.5, 46, 32); c.stroke();
    c.restore();
    bottle(); ink.fs(c, null, 2.4);
    c.strokeStyle = 'rgba(255,255,255,0.75)'; c.lineWidth = 1.8;
    c.beginPath(); c.moveTo(25, 30); c.quadraticCurveTo(23.5, 40, 25, 50); c.stroke();
    ink.poly(c, [[27.5, 5], [36.5, 5], [36, 12], [28, 12]], 0.35, 2);
    ink.fs(c, ink.lg(c, 0, 5, 0, 12, [[0, '#b88b5b'], [1, '#86603a']]), 2.1);
    c.strokeStyle = '#c8aa70'; c.lineWidth = 1.6;
    c.beginPath(); c.moveTo(27.5, 16); c.lineTo(36.5, 16); c.stroke();
  },
  hook(c) {
    const rope = () => { c.beginPath(); c.moveTo(35, 11); c.bezierCurveTo(24, 2, 9, 9, 13, 22); c.bezierCurveTo(16, 31, 6, 34, 7, 44); };
    ink.tube(c, rope, '#c8aa70', 3.2, 1.8);
    const steel = '#8e9598', hi = 'rgba(255,255,255,0.55)';
    const shank = () => { c.beginPath(); c.moveTo(35, 15); c.lineTo(35, 45); };
    ink.tube(c, shank, steel, 4.6, 2.2, hi);
    const prong = (dir) => () => { c.beginPath(); c.moveTo(35, 45); c.bezierCurveTo(35 + dir * 3, 52, 35 + dir * 15, 52, 35 + dir * 15.5, 37); };
    ink.tube(c, prong(-1), steel, 4, 2.1, hi);
    ink.tube(c, prong(1), steel, 4, 2.1, hi);
    const front = () => { c.beginPath(); c.moveTo(35, 45); c.quadraticCurveTo(33, 55, 26.5, 53.5); };
    ink.tube(c, front, '#737a7d', 3.6, 2);
    for (const [x, y, d] of [[19.5, 37, -1], [50.5, 37, 1]]) {
      c.beginPath(); c.moveTo(x - 2.8, y + 1.5); c.lineTo(x + d * 0.5, y - 5.5); c.lineTo(x + 2.8, y + 1.5); c.closePath();
      ink.fs(c, steel, 1.6);
    }
    c.beginPath(); c.arc(35, 11, 4.2, 0, TAU);
    c.strokeStyle = INK; c.lineWidth = 5.2; c.stroke(); c.strokeStyle = steel; c.lineWidth = 2.4; c.stroke();
  },
  spear(c) {
    c.save(); c.translate(31, 34); c.rotate(-Math.PI / 4);
    const shaft = () => { c.beginPath(); c.moveTo(-30, 0.5); c.lineTo(12, 0); };
    ink.tube(c, shaft, '#9a6d43', 3.6, 2, 'rgba(255,225,180,0.5)');
    c.beginPath();
    c.moveTo(11, -3.4); c.lineTo(31, 0); c.lineTo(11, 3.4);
    c.lineTo(14, 0.5); c.lineTo(9, 6.5); c.lineTo(9.5, 0); c.lineTo(9, -6.5); c.lineTo(14, -0.5); c.closePath();
    ink.fs(c, ink.lg(c, 10, -4, 30, 4, [[0, '#c4c8c6'], [1, '#6b7174']]), 2.1);
    c.strokeStyle = 'rgba(255,255,255,0.6)'; c.lineWidth = 1; c.beginPath(); c.moveTo(14, -1.2); c.lineTo(27, -0.2); c.stroke();
    c.strokeStyle = '#c8aa70'; c.lineWidth = 1.5;
    for (let x = 2; x <= 9; x += 2.2) { c.beginPath(); c.moveTo(x, -3); c.lineTo(x + 1.4, 3); c.stroke(); }
    c.strokeStyle = INK; c.lineWidth = 0.9;
    c.beginPath(); c.moveTo(1.5, -3.2); c.lineTo(1.5, 3.2); c.moveTo(10, -3.2); c.lineTo(10, 3.2); c.stroke();
    c.beginPath(); c.moveTo(-30, -4); c.lineTo(-26, 0.5); c.lineTo(-30, 5); c.strokeStyle = '#b8352b'; c.lineWidth = 2.2; c.stroke();
    c.restore();
  },
  hammer(c) {
    c.save(); c.translate(31, 33); c.rotate(0.72);
    ink.poly(c, [[-3, -7], [3, -7], [3.4, 26], [-3.4, 26]], 0.4, 3);
    ink.fs(c, ink.lg(c, -3, 0, 3, 0, [[0, '#b0804f'], [1, '#6b4a2e']]), 2.3);
    c.strokeStyle = '#c8aa70'; c.lineWidth = 1.8;
    for (let y = 13; y <= 23; y += 2.6) { c.beginPath(); c.moveTo(-3.2, y); c.lineTo(3.2, y + 1.8); c.stroke(); }
    c.beginPath();
    c.moveTo(-15, -16); c.lineTo(5, -16.5); c.quadraticCurveTo(13, -16, 17, -21); c.quadraticCurveTo(16, -12, 6, -7); c.lineTo(-15, -7.5); c.closePath();
    ink.fs(c, ink.lg(c, 0, -17, 0, -7, [[0, '#b7bcbd'], [1, '#575d61']]), 2.4);
    ink.poly(c, [[-18, -17], [-14, -17], [-14, -6.5], [-18, -6.5]], 0.3, 2);
    ink.fs(c, '#4d5357', 2);
    c.strokeStyle = 'rgba(255,255,255,0.5)'; c.lineWidth = 1.2; c.beginPath(); c.moveTo(-13, -14.5); c.lineTo(4, -14.8); c.stroke();
    c.restore();
  },
  lantern(c) {
    ink.glow(c, 32, 33, 30, '255,190,110', 0.6);
    c.strokeStyle = INK; c.lineWidth = 2.2;
    c.beginPath(); c.moveTo(25, 14); c.bezierCurveTo(25, 4, 39, 4, 39, 14); c.stroke();
    ink.poly(c, [[22.5, 19], [41.5, 19], [37.5, 12.5], [26.5, 12.5]], 0.3, 2);
    ink.fs(c, ink.lg(c, 0, 12, 0, 19, [[0, '#5a5650'], [1, '#2f2c29']]), 2.2);
    ink.poly(c, [[23.5, 19], [40.5, 19], [40, 45], [24, 45]], 0.35, 2);
    ink.fs(c, ink.rg(c, 32, 33, 1, 15, [[0, '#fff6d6'], [0.35, '#ffd58e'], [0.75, '#f0a24e'], [1, '#a65a22']]), 2.3);
    c.beginPath(); c.moveTo(32, 26); c.bezierCurveTo(36, 31, 35, 37, 32, 37.5); c.bezierCurveTo(29, 37, 28, 31, 32, 26);
    c.fillStyle = 'rgba(255,255,240,0.95)'; c.fill();
    c.strokeStyle = 'rgba(40,28,18,0.85)'; c.lineWidth = 1.5;
    for (const x of [28, 36]) { c.beginPath(); c.moveTo(x, 19.5); c.lineTo(x, 44.5); c.stroke(); }
    ink.poly(c, [[21, 45], [43, 45], [42, 50.5], [22, 50.5]], 0.3, 2);
    ink.fs(c, ink.lg(c, 0, 45, 0, 51, [[0, '#57534d'], [1, '#2a2725']]), 2.2);
  },
  flippers(c) {
    const fin = (x, y, a, c0, c1) => {
      c.save(); c.translate(x, y); c.rotate(a);
      c.beginPath();
      ink.smooth(c, [[-5, -19], [5, -19], [7, -8], [11, 5], [12.5, 16], [7, 19.5], [3, 16.5], [0, 19.5], [-3, 16.5], [-7, 19.5], [-12.5, 16], [-11, 5], [-7, -8]], true);
      ink.fs(c, ink.lg(c, 0, -19, 0, 19, [[0, c0], [1, c1]]), 2.3);
      c.beginPath(); c.ellipse(0, -14, 4, 3, 0, 0, TAU); ink.fs(c, '#1d2626', 1.2);
      c.strokeStyle = 'rgba(15,28,28,0.55)'; c.lineWidth = 1.2;
      for (const d of [-1, 0, 1]) { c.beginPath(); c.moveTo(d * 3, -7); c.lineTo(d * 8, 15); c.stroke(); }
      c.strokeStyle = 'rgba(230,250,245,0.4)'; c.lineWidth = 1.2;
      c.beginPath(); c.moveTo(-6, -6); c.lineTo(-10, 12); c.stroke();
      c.restore();
    };
    fin(24, 33, -0.32, '#6b9c98', '#3d6566');
    fin(40, 34, 0.24, '#d5a24a', '#9a6a28');
  },
  purifier(c) {
    ink.poly(c, [[16, 37], [48, 37], [44, 57], [20, 57]], 0.4, 3);
    ink.fs(c, ink.lg(c, 16, 0, 48, 0, [[0, '#6b4a2e'], [0.45, '#a3744a'], [1, '#5c3f26']]), 2.4);
    c.strokeStyle = 'rgba(35,22,12,0.6)'; c.lineWidth = 1;
    for (const x of [25, 32, 39]) { c.beginPath(); c.moveTo(x, 38); c.lineTo(x + (x - 32) * 0.12, 56); c.stroke(); }
    c.strokeStyle = '#555c60'; c.lineWidth = 2.4;
    c.beginPath(); c.moveTo(17.5, 44); c.lineTo(46.5, 44); c.moveTo(19, 52); c.lineTo(45, 52); c.stroke();
    c.beginPath(); c.ellipse(32, 37, 16, 3, 0, 0, TAU); ink.fs(c, 'rgba(78,148,182,0.95)', 1.8);
    c.beginPath(); c.moveTo(12, 38.5); c.quadraticCurveTo(31, 4, 32, 10); c.quadraticCurveTo(33, 4, 52, 38.5); c.closePath();
    ink.fs(c, 'rgba(210,236,240,0.38)', 2.1);
    c.strokeStyle = 'rgba(255,255,255,0.7)'; c.lineWidth = 1.4;
    c.beginPath(); c.moveTo(18, 35); c.quadraticCurveTo(27, 20, 30, 13); c.stroke();
    for (const [x, y, s] of [[32, 20, 1], [29, 28, 0.8], [35, 30, 0.9]]) {
      c.beginPath(); c.moveTo(x, y - 4 * s); c.quadraticCurveTo(x + 2.6 * s, y, x, y + 1.6 * s); c.quadraticCurveTo(x - 2.6 * s, y, x, y - 4 * s);
      ink.fs(c, '#5aa8d0', 1);
    }
    c.strokeStyle = 'rgba(255,214,140,0.85)'; c.lineWidth = 1.5;
    for (let i = 0; i < 5; i++) { const a = -2.6 + i * 0.32; c.beginPath(); c.moveTo(52 + Math.cos(a) * 5, 12 + Math.sin(a) * 5); c.lineTo(52 + Math.cos(a) * 9, 12 + Math.sin(a) * 9); c.stroke(); }
    c.beginPath(); c.arc(52, 12, 3.4, 0, TAU); ink.fs(c, '#f2c46e', 1.2);
  },
  grill(c) {
    c.strokeStyle = INK; c.lineWidth = 2.6;
    c.beginPath(); c.moveTo(20, 42); c.lineTo(14, 58); c.moveTo(44, 42); c.lineTo(50, 58); c.moveTo(32, 45); c.lineTo(32, 59); c.stroke();
    ink.glow(c, 32, 33, 22, '255,150,70', 0.55);
    c.beginPath(); c.moveTo(12, 33); c.quadraticCurveTo(14, 47, 32, 47); c.quadraticCurveTo(50, 47, 52, 33); c.closePath();
    ink.fs(c, ink.lg(c, 0, 33, 0, 47, [[0, '#4a4642'], [1, '#26231f']]), 2.4);
    for (const [x, r, col] of [[22, 3.4, '#ff9a4a'], [28, 3, '#ffbe62'], [34, 3.6, '#f07a36'], [40, 3, '#ffb054'], [45, 2.4, '#e86a2e']]) {
      c.beginPath(); c.arc(x, 33.5, r, Math.PI, 0); c.fillStyle = col; c.fill();
    }
    c.beginPath(); c.ellipse(32, 33, 20, 4.2, 0, 0, TAU); c.strokeStyle = INK; c.lineWidth = 2.2; c.stroke();
    c.strokeStyle = '#7a7f82'; c.lineWidth = 1.1;
    for (let x = 16; x <= 48; x += 4) { c.beginPath(); c.moveTo(x, 29.5); c.lineTo(x, 36.5); c.stroke(); }
    c.save(); c.translate(32, 27.5); c.scale(0.55, 0.5); c.rotate(-0.06);
    fishBody(c, true);
    c.restore();
    c.strokeStyle = 'rgba(220,220,215,0.55)'; c.lineWidth = 1.5;
    for (const x of [24, 38]) { c.beginPath(); c.moveTo(x, 20); c.bezierCurveTo(x - 3, 15, x + 3, 11, x, 6); c.stroke(); }
  },
  sail(c) {
    const mast = () => { c.beginPath(); c.moveTo(22, 6); c.lineTo(22.5, 59); };
    ink.tube(c, mast, '#8a6040', 2.8, 1.8);
    c.beginPath(); c.moveTo(25, 9); c.bezierCurveTo(42, 18, 53, 33, 53, 49); c.lineTo(25, 49.5); c.closePath();
    ink.fs(c, ink.lg(c, 25, 10, 52, 48, [[0, '#e3d5b0'], [1, '#b19c74']]), 2.3);
    c.strokeStyle = 'rgba(70,55,35,0.45)'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(25, 22); c.quadraticCurveTo(38, 24, 46, 30); c.moveTo(25, 36); c.quadraticCurveTo(40, 37, 51, 40); c.stroke();
    c.save(); c.translate(34, 41); c.rotate(-0.12);
    ink.poly(c, [[-5, -4], [5, -4], [5, 4], [-5, 4]], 0.3, 2); ink.fs(c, '#9a4436', 1.5);
    c.setLineDash([1.6, 1.6]); c.strokeStyle = 'rgba(240,225,195,0.8)'; c.lineWidth = 0.9;
    c.strokeRect(-3.6, -2.6, 7.2, 5.2); c.setLineDash([]);
    c.restore();
    const boom = () => { c.beginPath(); c.moveTo(20, 50.5); c.lineTo(55, 50); };
    ink.tube(c, boom, '#8a6040', 2.4, 1.6);
    c.beginPath(); c.moveTo(22.5, 6); c.lineTo(11, 8.5); c.lineTo(22.5, 11.5); c.closePath(); ink.fs(c, '#b8352b', 1.4);
  },
  lamp(c) {
    ink.glow(c, 42, 29, 24, '255,196,120', 0.65);
    const post = () => { c.beginPath(); c.moveTo(21, 9); c.lineTo(21.5, 57); };
    ink.tube(c, post, '#8a6040', 3.2, 1.8);
    const bar = () => { c.beginPath(); c.moveTo(18, 11); c.lineTo(44, 10.5); };
    ink.tube(c, bar, '#8a6040', 2.6, 1.6);
    c.strokeStyle = INK; c.lineWidth = 1.8;
    c.beginPath(); c.moveTo(21.5, 20); c.lineTo(31, 11); c.stroke();
    c.beginPath(); c.moveTo(13, 57); c.lineTo(30, 57); c.lineWidth = 2.6; c.stroke();
    c.lineWidth = 1.2; c.beginPath(); c.moveTo(42, 11); c.lineTo(42, 18); c.stroke();
    ink.poly(c, [[37.5, 22], [46.5, 22], [44, 18], [40, 18]], 0.2, 1); ink.fs(c, '#36322e', 1.6);
    ink.poly(c, [[38, 22], [46, 22], [45.6, 34], [38.4, 34]], 0.25, 2);
    ink.fs(c, ink.rg(c, 42, 28, 0.5, 8, [[0, '#fff4cf'], [0.5, '#ffc478'], [1, '#c9772f']]), 1.8);
    ink.poly(c, [[37, 34], [47, 34], [46, 37], [38, 37]], 0.2, 1); ink.fs(c, '#36322e', 1.6);
  },
  bed(c) {
    const p1 = () => { c.beginPath(); c.moveTo(10, 12); c.lineTo(12, 58); };
    const p2 = () => { c.beginPath(); c.moveTo(54, 12); c.lineTo(52, 58); };
    ink.tube(c, p1, '#8a6040', 3.2, 1.8); ink.tube(c, p2, '#8a6040', 3.2, 1.8);
    c.strokeStyle = INK; c.lineWidth = 1.3;
    c.beginPath(); c.moveTo(11, 19); c.lineTo(19, 31); c.moveTo(11, 19); c.lineTo(18, 35); c.moveTo(53, 19); c.lineTo(45, 31); c.moveTo(53, 19); c.lineTo(46, 35); c.stroke();
    c.beginPath(); c.moveTo(18, 30); c.quadraticCurveTo(32, 44, 46, 30); c.lineTo(46.5, 35); c.quadraticCurveTo(32, 55, 17.5, 35); c.closePath();
    ink.fs(c, ink.lg(c, 0, 30, 0, 50, [[0, '#c9a467'], [1, '#86663a']]), 2.3);
    c.save(); c.clip();
    c.strokeStyle = 'rgba(150,56,44,0.85)'; c.lineWidth = 2.2;
    for (const k of [0.35, 0.65]) { c.beginPath(); c.moveTo(17, 30 + k * 6); c.quadraticCurveTo(32, 44 + k * 10, 47, 30 + k * 6); c.stroke(); }
    c.restore();
    c.strokeStyle = 'rgba(255,240,205,0.4)'; c.lineWidth = 1.2;
    c.beginPath(); c.moveTo(21, 32.5); c.quadraticCurveTo(32, 41, 43, 32.5); c.stroke();
  },
  bandage(c) {
    c.beginPath(); c.moveTo(30, 41); c.bezierCurveTo(40, 46, 46, 40, 52, 44); c.lineTo(57, 51); c.bezierCurveTo(50, 48, 44, 54, 33, 50); c.closePath();
    ink.fs(c, ink.lg(c, 30, 40, 57, 52, [[0, '#ece3cc'], [1, '#c2b392']]), 2.1);
    c.strokeStyle = 'rgba(162,58,48,0.8)'; c.lineWidth = 1.6;
    c.beginPath(); c.moveTo(32, 45.5); c.bezierCurveTo(41, 49, 47, 44.5, 54.5, 47.5); c.stroke();
    ink.blob(c, 26, 34, 15, 15, 0.03, 18);
    ink.fs(c, ink.rg(c, 26, 34, 1, 15, [[0, '#f3ecd8'], [0.7, '#ddd1b4'], [1, '#b7a886']], 22, 30), 2.4);
    c.strokeStyle = 'rgba(120,100,70,0.6)'; c.lineWidth = 1;
    c.beginPath();
    for (let a = 0; a < TAU * 2.6; a += 0.2) { const r = 2.5 + a * 0.68; const x = 26 + Math.cos(a) * r, y = 34 + Math.sin(a) * r; if (a === 0) c.moveTo(x, y); else c.lineTo(x, y); }
    c.stroke();
    c.beginPath(); c.arc(26, 34, 2.6, 0, TAU); ink.fs(c, '#8d7b5a', 1);
  },
  note(c) {
    c.save(); c.translate(31, 34); c.rotate(-0.5);
    const bottle = () => {
      c.beginPath();
      ink.smooth(c, [[-22, -8], [6, -9.5], [12, -4.5], [19, -3.5], [19, 3.5], [12, 4.5], [6, 9.5], [-22, 8], [-24.5, 0]], true);
    };
    bottle(); ink.fs(c, 'rgba(126,170,132,0.5)', 0);
    c.save(); c.translate(-6, 0); c.rotate(0.04);
    ink.poly(c, [[-12, -4.5], [10, -4], [10, 4.5], [-12, 4]], 0.3, 2);
    ink.fs(c, ink.lg(c, 0, -4, 0, 4, [[0, '#efe2c2'], [1, '#c7b48c']]), 1.4);
    c.strokeStyle = 'rgba(60,40,25,0.55)'; c.lineWidth = 0.8;
    for (const y of [-1.6, 1.2]) { c.beginPath(); c.moveTo(-9, y); c.lineTo(7, y + 0.3); c.stroke(); }
    c.strokeStyle = '#b8352b'; c.lineWidth = 1.8; c.beginPath(); c.moveTo(0, -4.6); c.lineTo(0.4, 4.8); c.stroke();
    c.restore();
    bottle(); ink.fs(c, 'rgba(150,200,160,0.18)', 2.3);
    c.strokeStyle = 'rgba(255,255,255,0.65)'; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(-19, -5.5); c.lineTo(4, -6.5); c.stroke();
    ink.poly(c, [[18, -3.2], [25, -3.4], [25, 3.4], [18, 3.2]], 0.25, 2);
    ink.fs(c, '#a57a4c', 1.8);
    c.restore();
  },
  hand(c) {
    const parts = [];
    const cap = (x0, y0, x1, y1, r) => parts.push(() => {
      const a = Math.atan2(y1 - y0, x1 - x0);
      c.beginPath(); c.arc(x0, y0, r, a + Math.PI / 2, a - Math.PI / 2); c.arc(x1, y1, r, a - Math.PI / 2, a + Math.PI / 2); c.closePath();
    });
    parts.push(() => { ink.blob(c, 33, 41, 12.5, 12, 0.03, 14); });
    cap(24.5, 36, 21.5, 19.5, 3.6);
    cap(30.5, 33, 30, 14, 3.7);
    cap(36.5, 33, 38.5, 15.5, 3.6);
    cap(41.5, 37, 46, 23, 3.3);
    cap(23, 44, 12.5, 35, 3.8);
    for (const p of parts) { p(); c.strokeStyle = INK; c.lineWidth = 4.6; c.lineJoin = 'round'; c.stroke(); }
    const skin = ink.lg(c, 0, 14, 0, 54, [[0, '#d9b08c'], [1, '#a77a58']]);
    for (const p of parts) { p(); c.fillStyle = skin; c.fill(); }
    c.strokeStyle = 'rgba(80,45,25,0.5)'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(27, 44); c.quadraticCurveTo(33, 48, 40, 43); c.stroke();
    c.strokeStyle = 'rgba(255,235,210,0.45)'; c.lineWidth = 1.3;
    c.beginPath(); c.moveTo(29, 17); c.lineTo(29, 28); c.stroke();
  },
  anchor(c) {
    const steel = '#7e8589';
    const shaft = () => { c.beginPath(); c.moveTo(32, 14); c.lineTo(32, 52); };
    ink.tube(c, shaft, steel, 4, 2);
    const stock = () => { c.beginPath(); c.moveTo(22, 20); c.lineTo(42, 20); };
    ink.tube(c, stock, steel, 3.4, 2);
    const arms = () => { c.beginPath(); c.moveTo(14, 38); c.quadraticCurveTo(17, 54, 32, 53); c.quadraticCurveTo(47, 54, 50, 38); };
    ink.tube(c, arms, steel, 4, 2);
    c.beginPath(); c.arc(32, 10, 4.2, 0, TAU); c.strokeStyle = INK; c.lineWidth = 5; c.stroke(); c.strokeStyle = steel; c.lineWidth = 2.4; c.stroke();
  },
  unknown(c) {
    ink.blob(c, 32, 36, 18, 15, 0.08, 12);
    ink.fs(c, ink.lg(c, 0, 20, 0, 52, [[0, '#a68d64'], [1, '#6d5838']]), 2.4);
    c.strokeStyle = '#c8aa70'; c.lineWidth = 2;
    c.beginPath(); c.moveTo(32, 21); c.lineTo(32, 51); c.moveTo(15, 36); c.lineTo(49, 36); c.stroke();
  },
};
DRAW.tile = (c) => { plank(c, 32, 26, 50, 10, 0.02, WOOD_L); plank(c, 32, 40, 50, 10, -0.02, WOOD); };

// Paint an icon into a fresh canvas: shadow, a pale paper rim (so it reads on the dark
// UI), then the drawing itself.
export function paintIcon(id, size = S) {
  const fn = DRAW[id] || DRAW.unknown;
  let seed = 7;
  for (let i = 0; i < id.length; i++) seed = (seed * 31 + id.charCodeAt(i)) >>> 0;
  ink.seed(seed);
  const art = makeCanvas(S, S), a = art.getContext('2d');
  a.lineJoin = 'round'; a.lineCap = 'round';
  try { fn(a); } catch (e) { /* keep whatever was drawn */ }
  RND = Math.random;

  const tint = (col) => {
    const cv = makeCanvas(S, S), t = cv.getContext('2d');
    t.drawImage(art, 0, 0);
    t.globalCompositeOperation = 'source-in';
    t.fillStyle = col; t.fillRect(0, 0, S, S);
    return cv;
  };
  const sil = tint('#efe5cf'), shadow = tint('#000');

  const out = makeCanvas(size, size), o = out.getContext('2d');
  const k = size / S;
  o.scale(k, k);
  o.globalAlpha = 0.16;
  for (const [dx, dy] of [[1, 2.5], [0, 3], [2, 2], [1, 3.5]]) o.drawImage(shadow, dx, dy);
  o.globalAlpha = 0.5;
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * TAU;
    o.drawImage(sil, Math.cos(ang) * 1.7, Math.sin(ang) * 1.7);
  }
  o.globalAlpha = 1;
  o.drawImage(art, 0, 0);
  return out;
}

const URLS = {};
export function iconURL(id) {
  if (URLS[id]) return URLS[id];
  try { URLS[id] = paintIcon(id).toDataURL('image/png'); } catch (e) { URLS[id] = ''; }
  return URLS[id];
}
export const ICON_IDS = [...Object.keys(DEFS), 'hand', 'unknown'];
