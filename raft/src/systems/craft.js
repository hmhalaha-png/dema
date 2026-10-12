// Crafting: recipes, checks, and the act of making something.
// Raft tiles are not crafted here: the hammer's build mode (raft.js) places them directly.

import { say, journal } from '../core/state.js';
import { ITEMS, count, hasItems, takeItems, addItem, itemName } from './inventory.js';
import { sfx } from './audio.js';
import { hint } from '../core/input.js';

// once: you never need two of these (tools are carried, sail and bed are one per raft)
// Texts that name a control are getters, so they follow the player's current input
// (keyboard / mouse vs touchscreen) through hint().
const HAMMER = () => hint('拿起锤子（按 3）', '拿起锤子（点工具栏第 3 格）');
export const RECIPES = {
  spear:    { cost: { wood: 3, rope: 2 },              once: true,
    get desc() { return hint('刺鱼用，也能把鲨鱼赶走。按 2 拿在手上。', '刺鱼用，也能把鲨鱼赶走。点工具栏第 2 格拿在手上。'); },
    get done() { return hint('鱼叉做好了。按 2 拿起来，下水去抓鱼吧。', '鱼叉做好了。点工具栏第 2 格拿起来，下水去抓鱼吧。'); } },
  lantern:  { cost: { metal: 2, plastic: 2, rope: 1 }, once: true, desc: '夜里和深水里自己会亮。黑暗里的东西怕光。',
    done: '提灯做好了。天黑以后，它会一直陪着我。' },
  flippers: { cost: { plastic: 3, rope: 2 },           once: true, desc: '穿上以后在水里游得更快。',
    done: '脚蹼做好了，游起来快多了。' },
  bandage:  { cost: { cloth: 2 },
    get desc() { return hint('受伤的时候缠上，生命 +30。在背包里点击使用。', '受伤的时候缠上，生命 +30。在背包里点两下使用。'); },
    done: '做了一卷绷带。' },
  purifier: { cost: { plastic: 4, wood: 2 },           desc: '把海水晒成淡水。用锤子装到木筏上。',
    get done() { return '净水器做好了。' + HAMMER() + '，把它装到木筏上。'; } },
  grill:    { cost: { metal: 2, wood: 3, stone: 2 },   desc: '把生鱼烤熟。用锤子装到木筏上。',
    get done() { return '烤架做好了。' + HAMMER() + '，把它装到木筏上。'; } },
  // the sail is the big goal of the second day: it needs a long day of hooking (cloth is rare)
  sail:     { cost: { wood: 8, cloth: 5, rope: 4, metal: 1 }, once: true, desc: '升起帆，木筏会漂得快很多。用锤子装到木筏上。',
    get done() { return '船帆做好了。' + HAMMER() + '，把它竖到木筏上。'; } },
  lamp:     { cost: { metal: 2, plastic: 1, wood: 2 }, desc: '夜里点亮它，鲨鱼就不敢来咬木筏；岛上林子里的东西也怕它的光。',
    get done() { return '灯柱做好了。' + HAMMER() + '，把它立到木筏上。夜里记得点亮。'; } },
  bed:      { cost: { wood: 4, cloth: 3, leaf: 2 },    once: true, desc: '天黑以后躺上去，一觉睡到天亮。',
    get done() { return '吊床编好了。' + HAMMER() + '，把它挂到木筏上。'; } },
};
for (const [id, r] of Object.entries(RECIPES)) {
  r.id = id;
  r.n = r.n || 1;
  r.name = itemName(id);
  r.cat = (ITEMS[id] && ITEMS[id].cat) || 'tool';
}
export const RECIPE_ORDER = Object.keys(RECIPES);

// Is a one-per-journey thing already owned (carried, or built into the raft)?
export function owned(G, id) {
  if (count(G, id) > 0) return true;
  const tiles = G && G.raft && Array.isArray(G.raft.tiles) ? G.raft.tiles : [];
  return tiles.some((t) => t && t.s && t.s.type === id);
}

// Why a recipe can't be made right now (or '' if it can).
export function blockReason(G, id) {
  const r = RECIPES[id];
  if (!r) return '没有这个配方';
  if (r.once && owned(G, id)) return '已经有了';
  if (!hasItems(G, r.cost)) return '材料不够';
  return '';
}

export function init(G) {
  // the first nudge waits until the opening moments (and the intro titles) are over
  G.craftRt = { hintT: 16 };
}

// Gentle nudges: tell the boy the first time he could make something important.
const HINTS = [
  ['spear', '材料够做一把鱼叉了。'],
  ['purifier', '塑料和木板够做净水器了，以后就不怕没水喝。'],
  ['lantern', '材料够做提灯了。夜里有光，会安心很多。'],
];
const bagKey = () => hint('按 Tab 打开背包看看。', '点「背包」看看。');
export function update(G, dt) {
  if (G.demo || G.mode !== 'play') return;
  const rt = G.craftRt || (G.craftRt = { hintT: 16 });
  rt.hintT -= dt;
  if (rt.hintT > 0) return;
  rt.hintT = 1.5;
  const F = G.persist && (G.persist.flags || (G.persist.flags = {}));
  if (!F) return;
  for (const [id, text] of HINTS) {
    const key = 'craftHint_' + id;
    if (F[key]) continue;
    if (owned(G, id)) { F[key] = 1; continue; }
    if (canCraft(G, id)) { F[key] = 1; say(G, text + bagKey(), 'info'); return; }
  }
}

export function canCraft(G, id) {
  return !!RECIPES[id] && !blockReason(G, id);
}

export function craft(G, id) {
  const r = RECIPES[id];
  if (!r) return false;
  const why = blockReason(G, id);
  if (why) {
    say(G, why === '已经有了' ? '已经有' + r.name + '了。' : '材料不够，做不了' + r.name + '。');
    sfx('ui');
    return false;
  }
  if (!takeItems(G, r.cost)) return false;
  addItem(G, id, r.n, true);
  sfx('craft');
  say(G, r.done || ('做好了' + r.name + '。'), 'info');
  const F = G.persist && (G.persist.flags || (G.persist.flags = {}));
  if (F && !F['made_' + id]) {
    F['made_' + id] = 1;
    if (id === 'spear') journal(G, '用三块木板和两段绳子，绑了一把鱼叉。握在手里，好像没那么怕水下的东西了。');
    else if (id === 'lantern') journal(G, '做了一盏提灯。点亮的那一刻，木筏周围的黑暗往后退了一步。');
    else if (id === 'purifier') journal(G, '做了一个净水器。太阳很毒，但它能把海水变成能喝的水。');
    else if (id === 'sail') journal(G, '缝了一面歪歪扭扭的帆。风一吹，木筏终于开始自己往前走了。');
    else if (id === 'bed') journal(G, '编了一张吊床。晚上终于不用缩在木板上睡了。');
    else if (id === 'lamp') journal(G, '做了一根灯柱。夜里点亮它，鲨鱼就只敢在光圈外面打转，林子里的那个东西也不敢靠近。');
  }
  return true;
}
