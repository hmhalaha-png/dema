// The whole DOM UI: title poster, HUD (gauges, sun/moon dial, distance, hotbar, toasts,
// interaction prompt), bag / crafting, journal / codex, pause, death, the intro and the
// ending, story beats, and touch controls.
//
// Look: Little Nightmares — dark, muted, worn paper and ink, slightly irregular shapes,
// warm lantern light only for what matters. Everything is plain DOM + CSS injected here;
// nothing is redrawn unless it changed, so the HUD costs almost nothing per frame.

import { C, say, journal, isNight } from '../core/state.js';
import { input, bindTouchButton } from '../core/input.js';
import { worldToScreen } from '../core/world.js';
import { loadGame } from '../core/save.js';
import { clamp, seeded, makeCanvas, TAU } from '../core/util.js';
import { CODEX, CODEX_IDS } from '../data/codex.js';
import { getAsset } from '../core/assets.js';
import { ITEMS, ITEM_ORDER, CATEGORY_NAMES, count, useItem, iconURL, itemName, ink } from '../systems/inventory.js';
import { RECIPES, RECIPE_ORDER, craft, blockReason } from '../systems/craft.js';
import { sfx, unlockAudio, setMuted, isMuted } from '../systems/audio.js';

let API = null;
let U = null;            // root element inside #ui
const E = {};            // element refs
const S = {              // UI runtime
  G: null, mode: null, panel: null, modeKey: '', t: 0, touch: null, coarse: false,
  toasts: new Map(), rings: {}, dialA: null, day: null, dist: null, trackP: null,
  slotKey: '', chipKey: '', tool: null, toolHintT: 0, promptLabel: null, promptOn: false, promptTouch: null,
  hurt: 0, hurtShown: -1, lastHp: null, playT: 0,
  bagSig: '', jSig: '', jTab: 'diary', detail: null, madeId: null, madeT: 0, usedId: null, usedT: 0,
  intro: null, cont: null, dayCard: null, lastDay: null, pending: null,
  end: null, deadInfo: null, menuSel: 0, confirmNew: 0, muted: false, deadAt: null, saveFlashT: 0, fontFallback: false,
};
const MUTE_KEY = 'shaonian-yu-hai:muted';
const FONT_BRUSH = '"Ma Shan Zheng","Noto Serif SC","Songti SC","STSong","SimSun",serif';
const FONT_BODY = '"Noto Serif SC","Songti SC","STSong","SimSun",serif';

// =====================================================================================
// helpers
// =====================================================================================

const h = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const flags = (G) => {
  if (!G.persist) G.persist = { islands: {}, flags: {} };
  return G.persist.flags || (G.persist.flags = {});
};
const isTouch = () => !!(input.touch || S.coarse);
const fmtDist = (G) => {
  const x = G.raft && Number.isFinite(G.raft.x) ? G.raft.x : 0;
  const nm = Math.max(0, (C.GOAL_X - x) / 100);
  return nm < 10 ? nm.toFixed(1) : String(Math.round(nm));
};
const lettersFound = (G) => (G.persist && G.persist.flags && G.persist.flags.notes) | 0;
const codexFound = (G) => CODEX_IDS.filter((id) => G.codex && G.codex[id]).length;

function setText(el, text) { if (el && el.textContent !== text) el.textContent = text; }
function toggle(el, cls, on) { if (el && el.classList.contains(cls) !== !!on) el.classList.toggle(cls, !!on); }

// A slightly wobbly circle as an SVG path, starting at 12 o'clock (so pathLength-based
// dashes grow clockwise from the top).
function wobblyCircle(cx, cy, r, seed, amp = 0.035, n = 60) {
  const rnd = seeded(seed), p1 = rnd() * TAU, p2 = rnd() * TAU;
  let d = '';
  for (let i = 0; i <= n; i++) {
    const a = -Math.PI / 2 + (i / n) * TAU;
    const k = 1 + amp * 0.6 * Math.sin(a * 3 + p1) + amp * 0.4 * Math.sin(a * 5 + p2);
    d += (i ? 'L' : 'M') + (cx + Math.cos(a) * r * k).toFixed(2) + ' ' + (cy + Math.sin(a) * r * k).toFixed(2);
  }
  return d;
}

// Irregular paper edge as a CSS clip-path polygon (pixel jitter, any element size).
function ragged(seed, amp = 3.5, n = 30) {
  const r = seeded(seed), pts = [], m = Math.round(n * 0.6);
  const j = () => (r() * amp).toFixed(1) + 'px';
  for (let i = 0; i <= n; i++) pts.push(((i / n) * 100).toFixed(2) + '% ' + j());
  for (let i = 1; i < m; i++) pts.push('calc(100% - ' + j() + ') ' + ((i / m) * 100).toFixed(2) + '%');
  for (let i = n; i >= 0; i--) pts.push(((i / n) * 100).toFixed(2) + '% calc(100% - ' + j() + ')');
  for (let i = m - 1; i > 0; i--) pts.push(j() + ' ' + ((i / m) * 100).toFixed(2) + '%');
  return 'polygon(' + pts.join(',') + ')';
}

// Paper / cloth textures, painted once.
function texture(w, hgt, base, seed, o) {
  const c = makeCanvas(w, hgt), x = c.getContext('2d'), r = seeded(seed);
  x.fillStyle = base; x.fillRect(0, 0, w, hgt);
  for (let i = 0; i < o.stains; i++) {
    const sx = r() * w, sy = r() * hgt, sr = (0.12 + r() * 0.4) * w, a = o.stainA * (0.35 + r() * 0.65);
    for (const ox of [-w, 0, w]) for (const oy of [-hgt, 0, hgt]) {
      const g = x.createRadialGradient(sx + ox, sy + oy, 0, sx + ox, sy + oy, sr);
      g.addColorStop(0, 'rgba(' + o.stain + ',' + a + ')');
      g.addColorStop(1, 'rgba(' + o.stain + ',0)');
      x.fillStyle = g; x.fillRect(sx + ox - sr, sy + oy - sr, sr * 2, sr * 2);
    }
  }
  x.lineWidth = 0.7;
  for (let i = 0; i < o.fibers; i++) {
    x.strokeStyle = 'rgba(' + o.fiber + ',' + (0.03 + r() * 0.08) + ')';
    const fx = r() * w, fy = r() * hgt, a = r() * TAU, l = 5 + r() * 24;
    x.beginPath(); x.moveTo(fx, fy);
    x.quadraticCurveTo(fx + Math.cos(a + 0.7) * l * 0.5, fy + Math.sin(a + 0.7) * l * 0.5, fx + Math.cos(a) * l, fy + Math.sin(a) * l);
    x.stroke();
  }
  try {
    const id = x.getImageData(0, 0, w, hgt), d = id.data;
    for (let i = 0; i < d.length; i += 4) { const n = (r() - 0.5) * o.grain; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
    x.putImageData(id, 0, 0);
  } catch (e) { /* tainted / unsupported: skip grain */ }
  return c.toDataURL('image/jpeg', 0.85);
}

// =====================================================================================
// codex drawings (ink and wash on paper)
// =====================================================================================

const INKC = 'rgba(34,25,17,0.93)';
const HI = 'rgba(244,232,204,0.55)';
const KIND_WASH = { day: '206,160,92', night: '78,98,168', deep: '44,108,118', island: '106,136,72' };
const KIND_NAME = { day: '白天的海', night: '夜晚的海', deep: '深海', island: '小岛' };
const KIND_HINT = { day: '白天在海上多留意。', night: '也许要等到天黑。', deep: '在很深很深的地方。', island: '在某座岛上。' };

function fillInk(c, col = INKC) { c.fillStyle = col; c.fill(); }
function hiStroke(c, w = 1.2, col = HI) { c.strokeStyle = col; c.lineWidth = w; c.lineCap = 'round'; c.stroke(); }
function glowDot(c, x, y, r, col, a = 0.8) {
  const g = c.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, 'rgba(' + col + ',' + a + ')'); g.addColorStop(0.35, 'rgba(' + col + ',' + a * 0.4 + ')'); g.addColorStop(1, 'rgba(' + col + ',0)');
  c.fillStyle = g; c.fillRect(x - r, y - r, r * 2, r * 2);
}

const CD = {
  seagull(c) {
    c.beginPath(); c.moveTo(56, 41); c.bezierCurveTo(48, 28, 38, 20, 18, 25); c.bezierCurveTo(32, 28, 42, 35, 49, 45); c.closePath(); fillInk(c);
    c.beginPath(); c.moveTo(64, 40); c.bezierCurveTo(70, 26, 82, 15, 104, 17); c.bezierCurveTo(88, 22, 78, 31, 70, 44); c.closePath(); fillInk(c);
    ink.blob(c, 60, 43, 15, 5.4, 0.03, 14, -0.08); fillInk(c);
    c.beginPath(); c.arc(74, 39.5, 4.8, 0, TAU); fillInk(c);
    c.beginPath(); c.moveTo(78, 39); c.lineTo(87, 41.5); c.lineTo(78, 42.5); c.closePath(); fillInk(c, 'rgba(176,122,48,0.95)');
    c.beginPath(); c.moveTo(47, 42); c.lineTo(36, 39); c.lineTo(39, 44); c.lineTo(35, 48); c.lineTo(47, 46); c.closePath(); fillInk(c);
    c.beginPath(); c.moveTo(24, 26); c.quadraticCurveTo(40, 26, 50, 40); hiStroke(c, 1);
    c.beginPath(); c.moveTo(100, 18); c.quadraticCurveTo(80, 22, 70, 38); hiStroke(c, 1);
    c.fillStyle = HI; c.beginPath(); c.arc(75.5, 38.5, 1, 0, TAU); c.fill();
    c.strokeStyle = INKC; c.lineWidth = 1.3;
    c.beginPath(); c.moveTo(90, 56); c.quadraticCurveTo(94, 52, 97, 56); c.quadraticCurveTo(100, 52, 104, 56); c.stroke();
    c.beginPath(); c.moveTo(20, 60); c.quadraticCurveTo(23, 57, 25, 60); c.quadraticCurveTo(27, 57, 30, 60); c.stroke();
  },
  flying_fish(c) {
    const ff = (x, y, a, s) => {
      c.save(); c.translate(x, y); c.rotate(a); c.scale(s, s);
      c.beginPath(); c.moveTo(5, -1); c.quadraticCurveTo(-4, -24, -22, -21); c.quadraticCurveTo(-10, -10, -6, 0); c.closePath();
      fillInk(c, 'rgba(34,25,17,0.42)'); c.strokeStyle = INKC; c.lineWidth = 0.9; c.stroke();
      for (const [ex, ey] of [[-20, -20], [-14, -17], [-9, -11]]) { c.beginPath(); c.moveTo(3, -1); c.lineTo(ex, ey); c.strokeStyle = 'rgba(34,25,17,0.6)'; c.lineWidth = 0.7; c.stroke(); }
      c.beginPath(); c.moveTo(19, 0); c.quadraticCurveTo(8, -5.5, -12, -1.5); c.lineTo(-21, -7); c.lineTo(-17, 0); c.lineTo(-22, 7); c.lineTo(-12, 1.5); c.quadraticCurveTo(8, 5.5, 19, 0); c.closePath(); fillInk(c);
      c.beginPath(); c.moveTo(-8, -1); c.quadraticCurveTo(4, -3.5, 14, -1.2); hiStroke(c, 0.9);
      c.fillStyle = HI; c.beginPath(); c.arc(13.5, -0.8, 1.2, 0, TAU); c.fill();
      c.restore();
    };
    ff(50, 40, -0.25, 1.15); ff(88, 28, -0.12, 0.8); ff(28, 56, -0.32, 0.62);
    c.strokeStyle = 'rgba(34,25,17,0.5)'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(6, 70); c.quadraticCurveTo(30, 66, 60, 70); c.quadraticCurveTo(90, 74, 116, 69); c.stroke();
    c.fillStyle = 'rgba(34,25,17,0.5)';
    for (let i = 0; i < 9; i++) { c.beginPath(); c.arc(20 + i * 4, 64 - Math.sin(i * 0.7) * 4, 0.9, 0, TAU); c.fill(); }
  },
  dolphin(c) {
    c.beginPath();
    c.moveTo(104, 41); c.quadraticCurveTo(97, 36, 90, 34.5);
    c.bezierCurveTo(80, 21, 52, 18, 34, 30); c.bezierCurveTo(26, 36, 20, 44, 16, 51);
    c.lineTo(5, 48); c.quadraticCurveTo(12, 55, 13, 63); c.lineTo(18, 55);
    c.bezierCurveTo(28, 46, 44, 41, 62, 42); c.bezierCurveTo(78, 43, 92, 43, 104, 41); c.closePath(); fillInk(c);
    c.beginPath(); c.moveTo(57, 23); c.quadraticCurveTo(55, 10, 45, 7); c.quadraticCurveTo(52, 16, 46, 27); c.closePath(); fillInk(c);
    c.beginPath(); c.moveTo(77, 40); c.quadraticCurveTo(73, 50, 66, 52); c.quadraticCurveTo(70, 45, 70, 40); c.closePath(); fillInk(c);
    c.beginPath(); c.moveTo(40, 39); c.bezierCurveTo(56, 37, 80, 39, 98, 40); hiStroke(c, 1.3);
    c.beginPath(); c.moveTo(40, 27); c.bezierCurveTo(56, 20, 76, 22, 88, 32); hiStroke(c, 0.9, 'rgba(244,232,204,0.35)');
    c.fillStyle = HI; c.beginPath(); c.arc(89, 36, 1.3, 0, TAU); c.fill();
    c.strokeStyle = 'rgba(34,25,17,0.55)'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(4, 70); c.quadraticCurveTo(40, 64, 70, 70); c.quadraticCurveTo(95, 75, 118, 68); c.stroke();
  },
  turtle(c) {
    c.beginPath(); c.moveTo(74, 45); c.bezierCurveTo(86, 52, 97, 62, 104, 72); c.bezierCurveTo(92, 68, 78, 59, 67, 51); c.closePath(); fillInk(c);
    c.beginPath(); c.moveTo(72, 31); c.bezierCurveTo(82, 22, 90, 14, 100, 10); c.bezierCurveTo(92, 20, 84, 30, 76, 36); c.closePath(); fillInk(c, 'rgba(34,25,17,0.7)');
    c.beginPath(); c.moveTo(36, 46); c.quadraticCurveTo(26, 54, 20, 60); c.quadraticCurveTo(30, 56, 40, 50); c.closePath(); fillInk(c);
    ink.blob(c, 55, 39, 27, 15.5, 0.025, 22); fillInk(c);
    c.beginPath(); c.ellipse(88, 40, 8.5, 6, 0.12, 0, TAU); fillInk(c);
    c.fillStyle = HI; c.beginPath(); c.arc(91, 38.5, 1.1, 0, TAU); c.fill();
    c.strokeStyle = 'rgba(244,232,204,0.42)'; c.lineWidth = 1;
    c.beginPath();
    c.moveTo(46, 30); c.lineTo(58, 28); c.lineTo(66, 34); c.lineTo(60, 44); c.lineTo(48, 45); c.lineTo(42, 37); c.closePath();
    c.moveTo(46, 30); c.lineTo(40, 25); c.moveTo(58, 28); c.lineTo(60, 24); c.moveTo(66, 34); c.lineTo(76, 32);
    c.moveTo(60, 44); c.lineTo(66, 52); c.moveTo(48, 45); c.lineTo(44, 52); c.moveTo(42, 37); c.lineTo(30, 38);
    c.stroke();
    c.fillStyle = 'rgba(244,232,204,0.5)';
    for (const [x, y, r] of [[36, 32, 1.6], [39, 30, 1.1], [70, 42, 1.3], [67, 28, 1]]) { c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill(); }
  },
  manta(c) {
    c.beginPath();
    c.moveTo(60, 20);
    c.bezierCurveTo(48, 24, 30, 34, 8, 47);
    c.bezierCurveTo(30, 48, 46, 52, 56, 60);
    c.lineTo(64, 60);
    c.bezierCurveTo(74, 52, 90, 48, 112, 47);
    c.bezierCurveTo(90, 34, 72, 24, 60, 20); c.closePath(); fillInk(c);
    for (const d of [-1, 1]) { c.beginPath(); c.moveTo(60 + d * 4, 22); c.quadraticCurveTo(60 + d * 10, 14, 60 + d * 7, 9); c.quadraticCurveTo(60 + d * 5, 16, 60 + d * 1.5, 21); c.closePath(); fillInk(c); }
    c.beginPath(); c.moveTo(60, 58); c.bezierCurveTo(61, 66, 66, 74, 78, 78); c.strokeStyle = INKC; c.lineWidth = 1.5; c.stroke();
    c.beginPath(); c.moveTo(18, 45); c.bezierCurveTo(36, 36, 48, 30, 58, 28); hiStroke(c, 1);
    c.beginPath(); c.moveTo(102, 45); c.bezierCurveTo(84, 36, 72, 30, 62, 28); hiStroke(c, 1);
    for (let i = 0; i < 3; i++) { c.beginPath(); c.moveTo(54 + i * 0.5, 40 + i * 4); c.lineTo(57, 40 + i * 4); c.moveTo(66, 40 + i * 4); c.lineTo(63 - i * 0.5, 40 + i * 4); hiStroke(c, 0.8, 'rgba(244,232,204,0.35)'); }
  },
  whale(c) {
    c.beginPath();
    c.moveTo(126, 24); c.bezierCurveTo(100, 15, 60, 20, 36, 33); c.bezierCurveTo(28, 37, 22, 39, 16, 37);
    c.lineTo(3, 27); c.quadraticCurveTo(8, 37, 4, 50); c.lineTo(16, 43);
    c.bezierCurveTo(30, 49, 50, 59, 80, 61); c.bezierCurveTo(100, 63, 116, 60, 126, 57); c.closePath(); fillInk(c);
    c.beginPath(); c.moveTo(84, 57); c.quadraticCurveTo(76, 68, 64, 75); c.quadraticCurveTo(72, 64, 76, 56); c.closePath(); fillInk(c);
    for (let i = 0; i < 5; i++) { c.beginPath(); c.moveTo(92 + i * 2, 55 + i * 0.7); c.quadraticCurveTo(108, 55 + i * 1.2, 126, 51 + i * 1.6); hiStroke(c, 0.8, 'rgba(244,232,204,0.32)'); }
    c.beginPath(); c.moveTo(40, 33); c.bezierCurveTo(64, 22, 96, 18, 124, 25); hiStroke(c, 1, 'rgba(244,232,204,0.35)');
    c.fillStyle = HI; c.beginPath(); c.arc(102, 46, 1.6, 0, TAU); c.fill();
    c.fillStyle = 'rgba(244,232,204,0.45)';
    for (const [x, y] of [[70, 26], [73, 27.5], [110, 24], [58, 30]]) { c.beginPath(); c.arc(x, y, 1, 0, TAU); c.fill(); }
    c.strokeStyle = INKC; c.lineWidth = 1.2;
    c.beginPath(); c.moveTo(52, 8); c.lineTo(62, 8); c.stroke();
    c.fillStyle = INKC; c.fillRect(57, 4.2, 1.4, 3.6);
    c.fillStyle = 'rgba(184,53,43,0.9)'; c.fillRect(58.2, 5, 1.6, 0.9);
    c.strokeStyle = 'rgba(34,25,17,0.45)'; c.lineWidth = 0.9;
    c.beginPath(); c.moveTo(30, 9.5); c.quadraticCurveTo(57, 7.5, 92, 9.5); c.stroke();
  },
  shark(c) {
    c.beginPath();
    c.moveTo(109, 42); c.quadraticCurveTo(101, 34, 85, 32); c.bezierCurveTo(66, 30, 44, 32, 28, 38);
    c.lineTo(9, 25); c.quadraticCurveTo(16, 40, 11, 56); c.lineTo(28, 44);
    c.bezierCurveTo(48, 51, 76, 51, 92, 47); c.quadraticCurveTo(102, 46, 109, 42); c.closePath(); fillInk(c);
    c.beginPath(); c.moveTo(64, 32); c.quadraticCurveTo(58, 20, 54, 11); c.quadraticCurveTo(52, 24, 47, 33); c.closePath(); fillInk(c);
    c.beginPath(); c.moveTo(78, 47); c.quadraticCurveTo(72, 58, 64, 63); c.quadraticCurveTo(68, 54, 68, 47); c.closePath(); fillInk(c);
    for (let i = 0; i < 3; i++) { c.beginPath(); c.moveTo(85 + i * 2.6, 37); c.quadraticCurveTo(84 + i * 2.6, 41, 85.5 + i * 2.6, 44); hiStroke(c, 0.8); }
    c.beginPath(); c.moveTo(36, 44); c.bezierCurveTo(56, 47, 80, 47, 100, 43); hiStroke(c, 1.1, 'rgba(244,232,204,0.4)');
    c.fillStyle = HI; c.beginPath(); c.arc(98, 37.5, 1.2, 0, TAU); c.fill();
    c.strokeStyle = 'rgba(244,232,204,0.5)'; c.lineWidth = 0.8;
    c.beginPath(); c.moveTo(106, 44); c.lineTo(95, 45.5); c.stroke();
    c.strokeStyle = 'rgba(34,25,17,0.5)'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(4, 18); c.quadraticCurveTo(50, 14, 116, 18); c.stroke();
  },
  crab(c) {
    c.strokeStyle = INKC; c.lineWidth = 1.7; c.lineCap = 'round';
    for (const [x0, x1, x2, y2] of [[50, 40, 34, 68], [54, 46, 42, 70], [66, 74, 80, 69], [70, 80, 88, 66]]) {
      c.beginPath(); c.moveTo(x0, 54); c.quadraticCurveTo(x1, 52, x2, y2); c.stroke();
    }
    ink.blob(c, 60, 56, 13, 7, 0.06, 12); fillInk(c);
    c.beginPath(); c.ellipse(80, 57, 6.5, 5, -0.3, 0, TAU); fillInk(c);
    c.beginPath(); c.moveTo(80, 57); c.lineTo(88, 54); c.lineTo(86, 59); c.closePath(); fillInk(c, 'rgba(250,240,220,0.0)');
    c.strokeStyle = INKC; c.lineWidth = 1.2;
    c.beginPath(); c.moveTo(70, 50); c.lineTo(72, 40); c.moveTo(74, 51); c.lineTo(78, 42); c.stroke();
    c.fillStyle = INKC; c.beginPath(); c.arc(72, 39, 2, 0, TAU); c.arc(78.4, 41, 2, 0, TAU); c.fill();
    c.beginPath();
    c.moveTo(34, 47); c.quadraticCurveTo(34, 26, 56, 25); c.quadraticCurveTo(76, 25, 76, 46);
    for (let i = 0; i <= 14; i++) { const x = 76 - (i / 14) * 42; c.lineTo(x, 47 + (i % 2 ? 2.4 : 0)); }
    c.closePath();
    c.fillStyle = 'rgba(150,52,40,0.92)'; c.fill(); c.strokeStyle = INKC; c.lineWidth = 1.6; c.stroke();
    c.beginPath(); c.ellipse(55, 34, 12, 4.5, 0, Math.PI, TAU); hiStroke(c, 1.4, 'rgba(255,230,210,0.5)');
    c.strokeStyle = 'rgba(255,236,210,0.55)'; c.lineWidth = 1; c.beginPath(); c.arc(55, 38.5, 4.2, 0, TAU); c.stroke();
    c.fillStyle = 'rgba(255,236,210,0.55)'; c.beginPath(); c.arc(55, 38.5, 1.4, 0, TAU); c.fill();
    c.strokeStyle = 'rgba(34,25,17,0.45)'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(6, 72); c.quadraticCurveTo(60, 68, 116, 73); c.stroke();
  },
  jelly(c) {
    glowDot(c, 60, 34, 46, '110,220,255', 0.55);
    c.lineCap = 'round';
    for (let i = 0; i < 7; i++) {
      const x0 = 45 + i * 5;
      c.beginPath(); c.moveTo(x0, 36);
      for (let y = 36; y <= 76; y += 4) c.lineTo(x0 + Math.sin(y * 0.18 + i) * 3 + (i - 3) * (y - 36) * 0.05, y);
      c.strokeStyle = 'rgba(34,40,64,0.7)'; c.lineWidth = i % 2 ? 0.9 : 1.4; c.stroke();
    }
    c.beginPath(); c.moveTo(41, 36); c.bezierCurveTo(40, 12, 80, 12, 79, 36);
    for (let i = 0; i <= 10; i++) c.lineTo(79 - i * 3.8, 36 + (i % 2 ? 3 : 0));
    c.closePath();
    c.fillStyle = 'rgba(30,44,80,0.72)'; c.fill(); c.strokeStyle = INKC; c.lineWidth = 1.3; c.stroke();
    c.beginPath(); c.ellipse(60, 28, 9, 6, 0, 0, TAU); c.fillStyle = 'rgba(150,235,255,0.55)'; c.fill();
    c.beginPath(); c.moveTo(46, 26); c.quadraticCurveTo(52, 16, 64, 17); hiStroke(c, 1.2, 'rgba(210,245,255,0.7)');
  },
  plankton(c) {
    ink.blob(c, 60, 42, 54, 30, 0.12, 16); c.fillStyle = 'rgba(14,22,48,0.85)'; c.fill();
    for (let i = 0; i < 150; i++) {
      const t = i / 150, a = t * TAU * 2.3, r = 5 + t * 36;
      const x = 60 + Math.cos(a) * r * 1.25 + ink.j(2), y = 42 + Math.sin(a) * r * 0.62 + ink.j(2);
      if (i % 6 === 0) glowDot(c, x, y, 5, '110,220,255', 0.45);
      c.fillStyle = 'rgba(170,240,255,' + (0.5 + t * 0.4) + ')';
      c.beginPath(); c.arc(x, y, 0.5 + Math.abs(Math.sin(i)) * 0.9, 0, TAU); c.fill();
    }
    c.strokeStyle = 'rgba(244,232,204,0.6)'; c.lineWidth = 1.6;
    c.beginPath(); c.moveTo(98, 8); c.lineTo(78, 34); c.stroke();
    c.beginPath(); c.ellipse(76, 37, 4, 2, -0.9, 0, TAU); c.fillStyle = 'rgba(244,232,204,0.6)'; c.fill();
  },
  lanternfish(c) {
    const lf = (x, y, s, f) => {
      c.save(); c.translate(x, y); c.scale(s * f, s);
      c.beginPath(); c.moveTo(16, 0); c.quadraticCurveTo(10, -8, -6, -5); c.lineTo(-14, -9); c.lineTo(-12, 0); c.lineTo(-14, 9); c.lineTo(-6, 5); c.quadraticCurveTo(10, 8, 16, 0); c.closePath(); fillInk(c);
      c.beginPath(); c.arc(9, -1.5, 3.6, 0, TAU); c.fillStyle = 'rgba(232,222,196,0.9)'; c.fill();
      c.beginPath(); c.arc(9.8, -1.5, 1.9, 0, TAU); c.fillStyle = INKC; c.fill();
      for (let i = 0; i < 6; i++) glowDot(c, 6 - i * 3.2, 3.6 - i * 0.2, 3.2, '120,230,255', 0.9);
      c.restore();
    };
    lf(40, 30, 1.4, 1); lf(80, 46, 1.15, -1); lf(58, 62, 0.9, 1); lf(94, 20, 0.7, -1);
  },
  moon_whale(c) {
    ink.blob(c, 74, 30, 46, 30, 0.14, 16); c.fillStyle = 'rgba(32,42,90,0.62)'; c.fill();
    ink.blob(c, 80, 26, 30, 22, 0.12, 14); c.fillStyle = 'rgba(24,32,74,0.5)'; c.fill();
    glowDot(c, 82, 24, 34, '220,230,255', 0.55);
    c.beginPath(); c.moveTo(82, 6); c.arc(82, 24, 18, -Math.PI / 2, Math.PI / 2, true); c.arc(88, 24, 19, Math.PI / 2 + 0.33, -Math.PI / 2 - 0.33, false); c.closePath();
    c.fillStyle = 'rgba(250,240,206,0.98)'; c.fill();
    c.beginPath();
    c.moveTo(20, 72); c.bezierCurveTo(28, 32, 64, 10, 96, 28); c.bezierCurveTo(101, 31, 104, 37, 99, 41);
    c.bezierCurveTo(76, 30, 46, 42, 38, 72); c.closePath(); fillInk(c);
    c.beginPath(); c.moveTo(78, 33); c.quadraticCurveTo(86, 44, 86, 54); c.quadraticCurveTo(80, 44, 72, 36); c.closePath(); fillInk(c);
    c.beginPath(); c.moveTo(30, 54); c.bezierCurveTo(40, 30, 66, 18, 92, 30); hiStroke(c, 1.2, 'rgba(220,232,255,0.6)');
    c.strokeStyle = 'rgba(34,25,17,0.55)'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(2, 72); c.quadraticCurveTo(60, 68, 118, 72); c.stroke();
    c.fillStyle = 'rgba(220,232,255,0.7)';
    for (let i = 0; i < 14; i++) { c.beginPath(); c.arc(14 + i * 2.5 + ink.j(2), 66 - Math.sin(i * 0.4) * 8 + ink.j(2), 0.9, 0, TAU); c.fill(); }
  },
  leviathan(c) {
    ink.blob(c, 60, 30, 56, 28, 0.12, 16); c.fillStyle = 'rgba(40,48,96,0.32)'; c.fill();
    ink.blob(c, 60, 70, 62, 9, 0.06, 14); c.fillStyle = 'rgba(30,36,70,0.28)'; c.fill();
    c.strokeStyle = 'rgba(34,25,17,0.55)'; c.lineWidth = 0.9;
    c.beginPath(); c.moveTo(2, 63); c.quadraticCurveTo(60, 62, 118, 63); c.stroke();
    const limb = (pts, w0, w1) => {
      for (let i = 0; i < pts.length - 1; i++) {
        const t = i / (pts.length - 1);
        c.beginPath(); c.moveTo(pts[i][0], pts[i][1]); c.lineTo(pts[i + 1][0], pts[i + 1][1]);
        c.strokeStyle = INKC; c.lineWidth = w0 + (w1 - w0) * t; c.lineCap = 'round'; c.stroke();
      }
    };
    // legs wading into the sea
    limb([[60, 40], [57, 50], [55, 63]], 2.2, 1.4);
    limb([[64, 40], [67, 51], [69, 63]], 2.2, 1.4);
    // a thin hunched body, head bowed forward
    c.beginPath();
    c.moveTo(55, 18); c.quadraticCurveTo(61, 12, 69, 16); c.quadraticCurveTo(68, 30, 65, 42);
    c.lineTo(59, 42); c.quadraticCurveTo(56, 30, 55, 18); c.closePath(); fillInk(c);
    c.beginPath(); c.ellipse(64.5, 11.5, 3.1, 3.8, 0.5, 0, TAU); fillInk(c);
    // arms far too long, hanging to the water
    limb([[56, 18], [49, 34], [45, 50], [43, 60]], 1.8, 0.9);
    limb([[68, 17], [75, 33], [79, 49], [82, 59]], 1.8, 0.9);
    c.strokeStyle = INKC; c.lineWidth = 0.6;
    for (const [x, y, d] of [[43, 60, -1], [82, 59, 1]]) for (let k = -1; k <= 1; k++) { c.beginPath(); c.moveTo(x, y); c.lineTo(x + d * 0.8 + k * 1.3, y + 4); c.stroke(); }
    c.fillStyle = 'rgba(255,238,200,0.9)'; c.beginPath(); c.arc(65.6, 11.8, 0.55, 0, TAU); c.arc(67.2, 12.6, 0.55, 0, TAU); c.fill();
    // its reflection, broken by the waves
    c.strokeStyle = 'rgba(34,25,17,0.28)'; c.lineWidth = 1.2;
    for (let i = 0; i < 5; i++) { const y = 66 + i * 2.6; c.beginPath(); c.moveTo(56 - i, y); c.lineTo(68 + i, y); c.stroke(); }
    // a tiny raft for scale
    c.fillStyle = INKC; c.fillRect(14, 61.4, 9, 1.4); c.fillRect(17.6, 57.6, 0.8, 4); c.beginPath(); c.arc(21, 60.2, 0.9, 0, TAU); c.fill();
    c.fillStyle = 'rgba(255,200,120,0.95)'; c.beginPath(); c.arc(22.4, 60.6, 0.6, 0, TAU); c.fill();
  },
  ghost_ship(c) {
    c.fillStyle = 'rgba(200,210,220,0.35)';
    for (const [y, w] of [[60, 110], [50, 90], [68, 120]]) { ink.blob(c, 60, y, w / 2, 3.5, 0.2, 12); c.fill(); }
    c.beginPath(); c.moveTo(18, 54); c.quadraticCurveTo(60, 58, 104, 50); c.lineTo(96, 66); c.lineTo(28, 67); c.closePath(); fillInk(c);
    c.beginPath(); c.moveTo(80, 52); c.lineTo(80, 43); c.lineTo(100, 42); c.lineTo(101, 51); c.closePath(); fillInk(c);
    c.strokeStyle = INKC; c.lineWidth = 1.5;
    for (const [x, t] of [[40, 14], [60, 8], [82, 18]]) { c.beginPath(); c.moveTo(x, 56); c.lineTo(x + 1, t); c.stroke(); }
    const sail = (x, y0, y1, w) => {
      c.beginPath(); c.moveTo(x - w, y0); c.lineTo(x + w, y0 + 1);
      for (let i = 0; i <= 6; i++) c.lineTo(x + w - (i / 6) * w * 2 + ink.j(1), y1 + (i % 2 ? -3 : 1) + ink.j(1.5));
      c.closePath(); fillInk(c, 'rgba(34,25,17,0.55)');
    };
    sail(40, 18, 34, 10); sail(40, 37, 48, 11); sail(61, 12, 28, 12); sail(61, 31, 46, 13); sail(82, 22, 38, 9);
    glowDot(c, 92, 47, 10, '255,196,120', 0.9);
    c.fillStyle = 'rgba(255,214,150,0.95)'; c.fillRect(90.5, 45.5, 3, 3);
    c.strokeStyle = 'rgba(230,236,244,0.55)'; c.lineWidth = 1.6; c.lineCap = 'round';
    for (const [x, y, l] of [[8, 40, 30], [70, 34, 40], [20, 62, 50], [76, 70, 36]]) { c.beginPath(); c.moveTo(x, y); c.quadraticCurveTo(x + l / 2, y - 2, x + l, y); c.stroke(); }
  },
  angler(c) {
    c.beginPath(); c.moveTo(60, 22); c.bezierCurveTo(70, 4, 92, 4, 98, 17); c.strokeStyle = INKC; c.lineWidth = 1.3; c.stroke();
    glowDot(c, 99, 19, 16, '160,240,255', 0.9);
    c.beginPath(); c.arc(99, 19, 2.6, 0, TAU); c.fillStyle = 'rgba(230,255,255,0.95)'; c.fill();
    ink.blob(c, 52, 44, 30, 24, 0.04, 20); fillInk(c);
    c.beginPath(); c.moveTo(22, 42); c.lineTo(8, 32); c.lineTo(12, 46); c.lineTo(8, 58); c.closePath(); fillInk(c);
    c.beginPath(); c.moveTo(66, 36); c.lineTo(90, 30); c.quadraticCurveTo(84, 48, 88, 62); c.lineTo(64, 52); c.closePath(); fillInk(c, 'rgba(8,6,4,0.98)');
    c.fillStyle = 'rgba(240,232,210,0.9)';
    for (let i = 0; i < 6; i++) {
      const x = 68 + i * 3.8, y = 35.5 - i * 0.9;
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + 1.4, y + 4.5 + (i % 2) * 2); c.lineTo(x + 2.6, y - 0.5); c.closePath(); c.fill();
      const by = 52 + i * 1.6;
      c.beginPath(); c.moveTo(x - 1, by); c.lineTo(x + 0.6, by - 4 - (i % 2) * 2); c.lineTo(x + 2, by + 0.6); c.closePath(); c.fill();
    }
    c.beginPath(); c.arc(60, 32, 2.6, 0, TAU); c.fillStyle = 'rgba(220,210,180,0.9)'; c.fill();
    c.beginPath(); c.arc(60.6, 32, 1.1, 0, TAU); c.fillStyle = INKC; c.fill();
    c.beginPath(); c.moveTo(30, 28); c.quadraticCurveTo(44, 20, 58, 22); hiStroke(c, 1, 'rgba(244,232,204,0.3)');
  },
  deep_eye(c) {
    glowDot(c, 60, 46, 30, '220,200,120', 0.35);
    ink.blob(c, 60, 52, 50, 24, 0.07, 16); fillInk(c);
    c.strokeStyle = 'rgba(244,232,204,0.18)'; c.lineWidth = 1;
    for (const [x, y, l] of [[22, 58, 14], [84, 62, 18], [30, 44, 10], [92, 46, 8]]) { c.beginPath(); c.moveTo(x, y); c.lineTo(x + l * 0.6, y - 4); c.lineTo(x + l, y + 1); c.stroke(); }
    c.beginPath(); c.moveTo(38, 47); c.quadraticCurveTo(60, 27, 82, 47); c.quadraticCurveTo(60, 63, 38, 47); c.closePath();
    c.fillStyle = 'rgba(222,208,166,0.96)'; c.fill(); c.strokeStyle = INKC; c.lineWidth = 1.6; c.stroke();
    c.strokeStyle = 'rgba(150,50,40,0.55)'; c.lineWidth = 0.7;
    for (const [x0, y0, x1, y1] of [[41, 46, 50, 44], [79, 47, 70, 45], [44, 50, 51, 50], [76, 43, 69, 47]]) { c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke(); }
    c.beginPath(); c.arc(60, 46.5, 8.2, 0, TAU);
    const g = c.createRadialGradient(60, 46.5, 1, 60, 46.5, 8.2); g.addColorStop(0, '#e2b84e'); g.addColorStop(1, '#7a5a1e');
    c.fillStyle = g; c.fill();
    c.beginPath(); c.ellipse(60, 46.5, 1.6, 6.6, 0, 0, TAU); c.fillStyle = '#0c0805'; c.fill();
    c.fillStyle = 'rgba(255,255,240,0.85)'; c.beginPath(); c.arc(57, 43.5, 1.3, 0, TAU); c.fill();
  },
  island_beast(c) {
    c.strokeStyle = INKC; c.lineCap = 'round';
    c.lineWidth = 4; c.beginPath(); c.moveTo(16, 80); c.quadraticCurveTo(12, 40, 22, 6); c.stroke();
    c.lineWidth = 3.4; c.beginPath(); c.moveTo(104, 80); c.quadraticCurveTo(110, 44, 98, 10); c.stroke();
    for (const [x, y, d] of [[22, 6, 1], [98, 10, -1]]) for (let k = 0; k < 4; k++) {
      c.beginPath(); c.moveTo(x, y); c.quadraticCurveTo(x + d * (8 + k * 3), y - 6 + k * 3, x + d * (14 + k * 4), y + 4 + k * 4);
      c.lineWidth = 1.6; c.stroke();
    }
    c.beginPath();
    c.moveTo(56, 16); c.quadraticCurveTo(62, 10, 70, 14); c.quadraticCurveTo(76, 24, 70, 34);
    c.quadraticCurveTo(70, 46, 66, 52); c.lineTo(58, 52); c.quadraticCurveTo(52, 40, 54, 30); c.quadraticCurveTo(50, 22, 56, 16); c.closePath(); fillInk(c);
    c.lineWidth = 2.6; c.strokeStyle = INKC;
    c.beginPath(); c.moveTo(56, 24); c.quadraticCurveTo(42, 40, 40, 76); c.stroke();
    c.beginPath(); c.moveTo(70, 24); c.quadraticCurveTo(84, 42, 86, 74); c.stroke();
    c.lineWidth = 2.2;
    c.beginPath(); c.moveTo(59, 51); c.quadraticCurveTo(52, 62, 56, 78); c.moveTo(65, 51); c.quadraticCurveTo(72, 62, 68, 78); c.stroke();
    c.lineWidth = 0.9;
    for (const [x, y] of [[40, 76], [86, 74]]) for (let k = -1; k <= 1; k++) { c.beginPath(); c.moveTo(x, y); c.lineTo(x + k * 2.6, y + 4); c.stroke(); }
    glowDot(c, 61, 19, 7, '255,214,110', 0.9); glowDot(c, 67, 19.5, 7, '255,214,110', 0.9);
    c.fillStyle = 'rgba(255,240,170,1)'; c.beginPath(); c.arc(61, 19, 1.1, 0, TAU); c.arc(67, 19.5, 1.1, 0, TAU); c.fill();
  },
};

const CODEX_ART = {};
function codexArt(id, known) {
  const key = id + (known ? ':k' : ':u');
  if (CODEX_ART[key] != null) return CODEX_ART[key];
  const W = 180, H = 120, k = 1.5;
  const kind = (CODEX[id] && CODEX[id].kind) || 'day';
  const art = makeCanvas(W, H), c = art.getContext('2d');
  c.scale(k, k);
  let seed = 11;
  for (let i = 0; i < id.length; i++) seed = (seed * 33 + id.charCodeAt(i)) >>> 0;
  ink.seed(seed);
  if (known) {
    const col = KIND_WASH[kind];
    for (let i = 0; i < 3; i++) {
      ink.blob(c, 60 + ink.j(14), 42 + ink.j(8), 40 + ink.j(10), 22 + ink.j(6), 0.16, 14, ink.j(0.4));
      c.fillStyle = 'rgba(' + col + ',' + (0.16 + i * 0.06) + ')'; c.fill();
    }
  }
  try { (CD[id] || CD.seagull)(c); } catch (e) { /* partial art is fine */ }
  ink.seed(Date.now() & 0xffff);
  let out = art;
  if (!known) {
    const small = makeCanvas(W / 6, H / 6), s = small.getContext('2d');
    s.drawImage(art, 0, 0, W / 6, H / 6);
    s.globalCompositeOperation = 'source-in'; s.fillStyle = 'rgba(30,22,16,0.9)'; s.fillRect(0, 0, W, H);
    out = makeCanvas(W, H);
    const o = out.getContext('2d');
    o.imageSmoothingEnabled = true; o.globalAlpha = 0.5;
    o.drawImage(small, 0, 0, W, H);
  }
  try { CODEX_ART[key] = out.toDataURL('image/png'); } catch (e) { CODEX_ART[key] = ''; }
  return CODEX_ART[key];
}

// =====================================================================================
// static SVG bits
// =====================================================================================

const RING_ICON = {
  hp: '<path d="M12 20.6C6.2 16.4 2.8 12.9 3.3 8.6 3.8 4.9 8.4 3.7 12 7.7c3.6-4 8.2-2.8 8.7.9.5 4.3-2.9 7.8-8.7 12z"/>',
  hunger: '<path d="M2.4 12.2C5.3 7.3 11.6 6.2 16.3 9.9l4.7-3.3-1.1 5.5 1.2 5.3-4.8-3.2c-4.7 3.7-11 2.6-13.9-2z"/><circle class="hole" cx="7" cy="11.3" r="1.15"/>',
  thirst: '<path d="M12 2.6c3 4.9 6.7 8.5 6.7 12.4a6.7 6.7 0 0 1-13.4 0c0-3.9 3.7-7.5 6.7-12.4z"/><path class="shine" d="M8.7 14.6c0 2 1 3.5 2.5 4.1"/>',
  o2: '<circle class="bub" cx="9" cy="15.2" r="4.4"/><circle class="bub" cx="16.4" cy="8.4" r="3"/><circle class="bub" cx="17.2" cy="17.6" r="2"/>',
};
const RING_INFO = { hp: ['生命', 3], hunger: ['饱食', 5], thirst: ['水分', 7], o2: ['氧气', 11] };

function ringSVG(kind) {
  const seed = RING_INFO[kind][1];
  const track = wobblyCircle(24, 24, 18.4, seed, 0.035);
  return '<svg viewBox="0 0 48 48" aria-hidden="true">'
    + '<path class="rd" d="' + wobblyCircle(24, 24, 22.6, seed + 40, 0.045) + 'Z"/>'
    + '<path class="rt" d="' + track + '"/>'
    + '<path class="rv" d="' + track + '" pathLength="100" stroke-dasharray="100 100"/>'
    + '<g class="ri" transform="translate(12.4 12.6) scale(0.97)"><g class="rb">' + RING_ICON[kind] + '</g></g></svg>';
}

function dialSVG() {
  let stars = '';
  for (const [x, y, r] of [[19, 44, 0.8], [45, 46, 0.9], [25, 57, 0.7], [41, 58, 0.6], [12, 37, 0.6], [52, 38, 0.7], [33, 45, 0.5]]) stars += '<circle cx="' + x + '" cy="' + y + '" r="' + r + '"/>';
  let sea = 'M1 34.5';
  for (let x = 1; x < 63; x += 4) sea += ' q2 -1.3 4 0';
  return '<svg viewBox="0 0 64 38" aria-hidden="true">'
    + '<defs><clipPath id="u-dclip"><path d="M4 34.5A28 28 0 0 1 60 34.5Z"/></clipPath>'
    + '<linearGradient id="u-dsky" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0" stop-color="#a7cfdf"/><stop offset=".3" stop-color="#e9dcbc"/><stop offset=".45" stop-color="#f2b27a"/>'
    + '<stop offset=".5" stop-color="#c9768a"/><stop offset=".56" stop-color="#2e3a6b"/><stop offset=".75" stop-color="#13204a"/><stop offset="1" stop-color="#070b1e"/></linearGradient>'
    + '<radialGradient id="u-dsun"><stop offset="0" stop-color="#fff3cf"/><stop offset=".45" stop-color="#ffd27e" stop-opacity=".9"/><stop offset="1" stop-color="#ffb35a" stop-opacity="0"/></radialGradient></defs>'
    + '<g clip-path="url(#u-dclip)"><g class="dial-rot">'
    + '<circle cx="32" cy="34" r="29" fill="url(#u-dsky)"/>'
    + '<circle cx="32" cy="15" r="9" fill="url(#u-dsun)"/><circle class="sun" cx="32" cy="15" r="4"/>'
    + '<g class="stars">' + stars + '</g>'
    + '<path class="moon" d="M32 48.4A4.6 4.6 0 1 0 32 57.6A6 6 0 0 1 32 48.4Z"/>'
    + '</g></g>'
    + '<path class="dial-rim" d="' + 'M3.6 34.6C3.4 19 15.6 6.2 32.2 6.1 48 6 60.6 18.6 60.4 34.6' + '"/>'
    + '<path class="dial-sea" d="' + sea + '"/></svg>';
}

const LH_SVG = '<svg viewBox="0 0 12 16" aria-hidden="true"><path d="M4.4 15 5 6.2h2L7.6 15z"/><path d="M4.6 6.2h2.8V4.4H4.6z" class="lamp"/><path d="M4 4.5 6 2.6 8 4.5z"/><path d="M1 15.4h10" class="base"/></svg>';
const ARROW = {
  left: '<svg viewBox="0 0 24 24"><path d="M15.5 4.8 7.2 12l8.3 7.2" /></svg>',
  right: '<svg viewBox="0 0 24 24"><path d="M8.5 4.8 16.8 12l-8.3 7.2" /></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M4.8 15.5 12 7.2l7.2 8.3" /></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M4.8 8.5 12 16.8l7.2-8.3" /></svg>',
};
const XSVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.2 5.6c4 3.6 7.6 8.2 11.8 12.6M17.6 5.8C13.4 9.6 9.8 13.8 6 18.4"/></svg>';

function keysHTML(touch) {
  const row = (k, v) => '<div class="kr"><span class="kk">' + k + '</span><span>' + v + '</span></div>';
  if (touch) {
    return row('◂ ▸', '移动') + row('▴', '跳 · 向上游') + row('▾', '下潜')
      + row('使用', '按住蓄力抛钩索 / 刺鱼 / 建造') + row('互动', '靠近东西时会亮起来')
      + row('工具栏', '点一下换工具') + row('吃 · 喝', '工具栏两边');
  }
  return row('<kbd>A</kbd><kbd>D</kbd>', '移动') + row('<kbd>空格</kbd>', '跳 · 向上游')
    + row('<kbd>S</kbd>', '下潜') + row('<kbd>鼠标左键</kbd>', '用工具 · 按住蓄力')
    + row('<kbd>1</kbd>–<kbd>4</kbd>', '换工具') + row('<kbd>E</kbd>', '互动')
    + row('<kbd>F</kbd> <kbd>R</kbd>', '吃东西 · 喝水') + row('<kbd>Tab</kbd> <kbd>J</kbd>', '背包 · 日记')
    + row('<kbd>Q</kbd>', '建造时换部件') + row('<kbd>Esc</kbd>', '暂停');
}

// =====================================================================================
// CSS
// =====================================================================================

function css(tex) {
  return `
.U{position:absolute;inset:0;font-family:${FONT_BODY};color:var(--ink);font-size:clamp(11px,2.05vmin,17px);line-height:1.5;letter-spacing:.02em;
 --ink:#ece2cc;--ink2:#b8af9b;--ink3:#7d766a;--paper:#d7c9a6;--pink:#2a1f16;--warm:#ffc478;--warm2:#e7a058;--red:#b8352b;--rd:#c8564a;
 --fd:${FONT_BRUSH};--fb:${FONT_BODY};--tex-paper:url(${tex.paper});--tex-board:url(${tex.board});
 --sl:env(safe-area-inset-left,0px);--sr:env(safe-area-inset-right,0px);--st:env(safe-area-inset-top,0px);--sb:env(safe-area-inset-bottom,0px)}
:where(.U) *{box-sizing:border-box}
:where(.U) button{font:inherit;color:inherit;background:none;border:0;padding:0;margin:0;cursor:pointer;outline:none;-webkit-tap-highlight-color:transparent;letter-spacing:inherit}
:where(.U) img{display:block;-webkit-user-drag:none;pointer-events:none}
.U kbd{display:inline-grid;place-items:center;min-width:1.55em;height:1.55em;padding:0 .32em;margin:0 .08em;font:inherit;font-size:.8em;line-height:1;color:var(--pink);
 background:linear-gradient(#e2d5b5,#c4b48e);border-radius:.32em .4em .28em .36em;box-shadow:0 2px 0 rgba(0,0,0,.45),inset 0 -1px 0 rgba(0,0,0,.15)}
.scr{position:absolute;inset:0;opacity:0;visibility:hidden;transition:opacity .7s ease,visibility 0s linear .7s}
.U[data-mode=title] .title,.U[data-mode=pause] .pause,.U[data-mode=panel] .pwrap,.U[data-mode=dead] .dead,.U[data-mode=ending] .ending{opacity:1;visibility:visible;transition:opacity .7s ease,visibility 0s}
.U[data-mode=panel] .pwrap,.U[data-mode=pause] .pause{transition-duration:.22s}

/* ---------------------------------------------------------------- menus */
.menu{display:flex;flex-direction:column;align-items:center;gap:.3em}
.mb{position:relative;font-family:var(--fd);font-size:1.6em;line-height:1.25;padding:.12em 1.1em;color:rgba(236,226,204,.66);letter-spacing:.12em;text-shadow:0 2px 8px rgba(0,0,0,.7);pointer-events:auto;transition:color .25s,transform .25s}
.mb small{display:block;font-family:var(--fb);font-size:max(.42em,10px);letter-spacing:.1em;color:var(--ink3);margin-top:.35em}
.mb::before{content:'';position:absolute;left:.2em;top:.78em;width:.42em;height:.42em;margin-top:-.21em;border-radius:50%;background:radial-gradient(circle,#fff1cf,#ffc478 45%,rgba(255,170,80,0) 72%);opacity:0;transform:scale(.4);transition:opacity .25s,transform .25s}
.mt{position:relative;display:inline-block}
.mt::after{content:'';position:absolute;left:-.1em;right:-.1em;bottom:-.12em;height:.32em;background:no-repeat center/100% 100% url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 8' preserveAspectRatio='none'%3E%3Cpath d='M2 5.2C20 3.4 38 6.4 56 4.6S86 3.2 98 4.4' fill='none' stroke='%23ffc478' stroke-width='1.6' stroke-linecap='round' opacity='.85'/%3E%3C/svg%3E");transform:scaleX(0);transform-origin:left;transition:transform .35s ease}
.mb.sel,.mb:hover{color:#f6ead0;transform:translateX(.08em)}
.mb.sel::before,.mb:hover::before{opacity:1;transform:scale(1)}
.mb.sel .mt::after,.mb:hover .mt::after{transform:scaleX(1)}
.mb.warn{color:#e7b0a2}
.mb.minor{font-size:1.05em;font-family:var(--fb);letter-spacing:.2em;margin-top:.4em}

/* ---------------------------------------------------------------- title poster */
.title{z-index:8}
.tshade{position:absolute;inset:0;background:
 linear-gradient(180deg,rgba(6,8,16,.78) 0%,rgba(6,8,16,.38) 26%,rgba(6,8,16,0) 46%,rgba(4,6,10,0) 62%,rgba(4,6,10,.55) 82%,rgba(3,4,7,.86) 100%),
 radial-gradient(ellipse 80% 70% at 50% 52%,rgba(0,0,0,0) 50%,rgba(0,0,0,.5) 100%)}
.bars::before,.bars::after{content:'';position:absolute;left:0;right:0;height:7vh;background:#040508;transition:transform 1.2s cubic-bezier(.6,0,.2,1)}
.bars::before{top:0}.bars::after{bottom:0}
.thead{position:absolute;left:0;right:0;top:calc(9vh + var(--st));display:flex;flex-direction:column;align-items:center;text-align:center}
.tkick{font-size:.82em;letter-spacing:.9em;margin-right:-.9em;color:rgba(236,226,204,.55);margin-bottom:.4em}
.tlogo{position:relative;margin:0;font-family:var(--fd);font-weight:400;font-size:clamp(46px,13.5vmin,128px);line-height:1;letter-spacing:.14em;margin-right:-.14em;color:#efe4ca;
 text-shadow:0 0 .5em rgba(255,196,120,.18),0 .04em 0 rgba(0,0,0,.35),0 .1em .5em rgba(0,0,0,.55);animation:u-logo 3.2s cubic-bezier(.2,.6,.2,1) both}
.tlogo .yu{font-size:.62em;color:#d7b98a;margin:0 .02em;vertical-align:.12em}
.tseal{position:absolute;right:-1.15em;top:.05em;width:.86em;padding:.12em 0;font-size:.3em;line-height:1.05;letter-spacing:0;margin:0;color:#f3e5cf;background:var(--red);
 border-radius:.08em .14em .1em .12em;text-shadow:none;writing-mode:vertical-rl;text-orientation:upright;transform:rotate(4deg);opacity:.9;
 box-shadow:inset 0 0 0 .06em rgba(243,229,207,.55),inset 0 0 .3em rgba(60,10,6,.6);filter:saturate(.85)}
.tsub{margin:.7em 0 0;font-size:1.18em;letter-spacing:.38em;margin-right:-.38em;color:rgba(236,226,204,.82);text-shadow:0 2px 8px rgba(0,0,0,.8);animation:u-fade 2s 1.2s both}
.torn{display:flex;align-items:center;gap:.8em;margin-top:.55em;color:rgba(236,226,204,.45);animation:u-fade 2s 1.5s both}
.torn i{display:block;width:5.5em;height:1px;background:linear-gradient(90deg,rgba(236,226,204,0),rgba(236,226,204,.5))}
.torn i+svg+i{background:linear-gradient(270deg,rgba(236,226,204,0),rgba(236,226,204,.5))}
.torn svg{width:.9em;height:1.2em;fill:currentColor}
.torn svg .lamp{fill:var(--warm)}
.torn svg .base{stroke:currentColor;stroke-width:.8;fill:none}
.tmenu{position:absolute;left:0;right:0;bottom:calc(13vh + var(--sb));animation:u-fade 1.6s 1.8s both}
.tfoot{position:absolute;left:0;right:0;bottom:calc(7vh + .7em + var(--sb));text-align:center;font-size:.74em;letter-spacing:.3em;color:rgba(236,226,204,.5);animation:u-fade 2s 2.6s both}
.howto{position:absolute;left:calc(1.6em + var(--sl));bottom:calc(9vh + var(--sb));width:17em;padding:.9em 1.1em 1em;color:var(--ink2);font-size:.82em;
 background:rgba(9,10,13,.62);border:1px solid rgba(236,226,204,.1);border-radius:.6em 1em .7em .9em/.9em .6em 1em .7em;animation:u-fade 2s 2.2s both;transition:opacity .3s}
.howto h4{margin:0 0 .45em;font-family:var(--fd);font-weight:400;font-size:1.25em;letter-spacing:.2em;color:var(--ink)}
.kr{display:flex;gap:.7em;align-items:center;line-height:1.85}
.kk{flex:0 0 6.6em;text-align:right;color:var(--ink)}
.howto .kk{flex-basis:6.2em}
.title .ht-btn{display:none}
@keyframes u-logo{0%{opacity:0;filter:blur(10px);letter-spacing:.32em}100%{opacity:1;filter:blur(0);letter-spacing:.14em}}
@keyframes u-fade{0%{opacity:0}100%{opacity:1}}

/* ---------------------------------------------------------------- HUD */
.hud{position:absolute;inset:0;opacity:0;visibility:hidden;transition:opacity .6s,visibility 0s .6s}
.U[data-mode=play] .hud,.U[data-mode=panel] .hud,.U[data-mode=pause] .hud{opacity:1;visibility:visible;transition:opacity .6s}
.hud.cine{opacity:0!important}
.hud .stats,.hud .clock,.hud .bottom{transition:opacity 2s}
.hud.night .stats,.hud.night .clock,.hud.night .bottom{opacity:.8}
.stats{position:absolute;left:calc(14px + var(--sl));top:calc(12px + var(--st));display:flex;gap:.42em}
.ring{position:relative;width:3.3em;height:3.3em;flex:none;filter:drop-shadow(0 3px 4px rgba(0,0,0,.5));transition:width .4s,opacity .4s,margin .4s}
.ring svg{width:100%;height:100%;overflow:visible}
.rd{fill:rgba(11,12,16,.74);stroke:rgba(236,226,204,.2);stroke-width:1}
.rt{fill:none;stroke:rgba(236,226,204,.09);stroke-width:3.6}
.rv{fill:none;stroke:var(--rc);stroke-width:3.7;stroke-linecap:round;transition:stroke-dasharray .4s ease,stroke .4s}
.ri path,.ri circle{fill:rgba(236,226,204,.86)}
.ri .hole{fill:rgba(11,12,16,.9)}
.ri .shine{fill:none;stroke:rgba(11,12,16,.55);stroke-width:1.3;stroke-linecap:round}
.ri .bub{fill:none;stroke:rgba(236,226,204,.86);stroke-width:1.7}
.ring.hp{--rc:#c8564a}.ring.hunger{--rc:#d39b54}.ring.thirst{--rc:#6fa6bf}.ring.o2{--rc:#a8dbe6}
.ring.o2{width:0;opacity:0;margin-left:-.42em}
.ring.o2.show{width:3.3em;opacity:1;margin-left:0}
.ring.low .rb{animation:u-beat 1.1s ease-in-out infinite;transform-box:fill-box;transform-origin:center}
.ring.low .ri path,.ring.low .ri circle{fill:#f0a08e}
.ring.low .rd{stroke:rgba(200,86,74,.6)}
.ring.up{filter:drop-shadow(0 0 7px var(--rc)) drop-shadow(0 3px 4px rgba(0,0,0,.5))}
.ring .rn{position:absolute;left:0;right:0;bottom:-1.15em;text-align:center;font-size:.66em;color:var(--ink3);opacity:0;transition:opacity .3s}
.ring:hover .rn,.ring.low .rn{opacity:1}
.ring.low .rn{color:#e59a88}
@keyframes u-beat{0%,100%{transform:scale(1)}14%{transform:scale(1.18)}28%{transform:scale(.98)}42%{transform:scale(1.1)}}

.clock{position:absolute;right:calc(14px + var(--sr));top:calc(10px + var(--st));display:flex;align-items:flex-start;gap:.55em;text-align:right}
.dial{width:4.5em;height:2.7em;flex:none;filter:drop-shadow(0 3px 4px rgba(0,0,0,.55))}
.dial svg{width:100%;height:100%;overflow:visible}
.dial .sun{fill:#fff1c8}.dial .moon{fill:#eef0f6}.dial .stars circle{fill:#dfe6ff}
.dial-rim{fill:none;stroke:rgba(236,226,204,.55);stroke-width:1.3;stroke-linecap:round}
.dial-sea{fill:none;stroke:rgba(236,226,204,.6);stroke-width:1.2;stroke-linecap:round}
.dayl{font-family:var(--fd);font-size:1.5em;line-height:1.05;letter-spacing:.1em;color:var(--ink);text-shadow:0 2px 6px rgba(0,0,0,.7);white-space:nowrap}
.dayl b{font-weight:400;color:#f6ead0;margin:0 .06em}
.dist{font-size:.8em;color:var(--ink2);text-shadow:0 1px 4px rgba(0,0,0,.8);white-space:nowrap;margin-top:.15em}
.dist b{font-weight:400;color:var(--ink);font-size:1.1em}
.track{position:relative;width:8.4em;height:.9em;margin:.3em 0 0 auto}
.track .tl{position:absolute;left:0;right:.9em;top:50%;border-top:1px dashed rgba(236,226,204,.32)}
.track .tf{position:absolute;left:0;top:50%;height:1px;margin-top:-.5px;background:rgba(236,226,204,.7);width:0}
.track .tr{position:absolute;top:50%;width:.46em;height:.46em;margin:-.23em 0 0 -.23em;border-radius:40% 60% 50% 50%;background:var(--warm);box-shadow:0 0 6px var(--warm)}
.track svg{position:absolute;right:0;top:-.25em;width:.8em;height:1.15em;fill:rgba(236,226,204,.75)}
.track svg .lamp{fill:var(--warm)}.track svg .base{stroke:rgba(236,226,204,.5);stroke-width:.8;fill:none}

.bottom{position:absolute;left:50%;bottom:calc(10px + var(--sb));transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:.35em}
.thint{font-size:.86em;color:var(--ink);text-shadow:0 1px 6px rgba(0,0,0,.9),0 0 2px rgba(0,0,0,.9);opacity:0;transform:translateY(4px);transition:opacity .4s,transform .4s;white-space:nowrap}
.thint b{font-family:var(--fd);font-weight:400;font-size:1.15em;color:var(--warm);margin-right:.4em;letter-spacing:.1em}
.thint.on{opacity:1;transform:none}
.bar{display:flex;align-items:center;gap:.55em}
.slots{display:flex;gap:.36em}
.slot{position:relative;width:3.35em;height:3.35em;pointer-events:auto;display:grid;place-items:center;
 background:radial-gradient(circle at 50% 38%,rgba(58,54,48,.82),rgba(14,15,18,.86) 72%);border:1px solid rgba(236,226,204,.16);
 border-radius:.62em .42em .7em .38em/.42em .66em .4em .6em;box-shadow:0 4px 10px rgba(0,0,0,.42);transition:transform .2s,border-color .2s,box-shadow .2s}
.slot:nth-child(2){border-radius:.42em .66em .4em .62em/.6em .4em .7em .44em}
.slot:nth-child(3){border-radius:.7em .4em .55em .5em/.45em .62em .42em .66em}
.slot:nth-child(4){border-radius:.45em .6em .66em .4em/.66em .44em .5em .6em}
.slot img{width:2.35em;height:2.35em;transition:opacity .2s,filter .2s}
.slot .k{position:absolute;left:.32em;top:.12em;font-size:.68em;color:var(--ink3);line-height:1.3}
.slot.sel{border-color:rgba(255,196,120,.72);transform:translateY(-.22em);box-shadow:0 0 0 1px rgba(255,196,120,.18),0 0 16px rgba(255,170,90,.3),0 6px 12px rgba(0,0,0,.5)}
.slot.sel .k{color:var(--warm)}
.slot.locked img{opacity:.28;filter:grayscale(1) brightness(.8)}
.slot.locked::after{content:'';position:absolute;inset:.42em;border:1px dashed rgba(236,226,204,.2);border-radius:inherit}
.slot .lt{position:absolute;right:.05em;top:.05em;width:1.15em;height:1.15em;display:none}
.slot .lt img{width:100%;height:100%}
.slot.lant .lt{display:block}
.slot.lant.lit .lt{filter:drop-shadow(0 0 4px rgba(255,190,110,.95))}
.slot.is-down{transform:translateY(0) scale(.95)}
.chip{display:flex;align-items:center;gap:.25em;height:2.3em;padding:0 .55em 0 .35em;pointer-events:auto;font-size:.86em;color:var(--ink2);
 background:rgba(11,12,16,.66);border:1px solid rgba(236,226,204,.12);border-radius:.5em .7em .45em .65em/.65em .45em .7em .5em;box-shadow:0 3px 8px rgba(0,0,0,.35);transition:opacity .3s}
.chip img{width:1.65em;height:1.65em}
.chip .cn{min-width:1.6em;color:var(--ink)}
.chip .cl{display:none}
.chip.none{opacity:.42}
.chip.is-down{transform:scale(.95)}
.keys{position:absolute;right:calc(14px + var(--sr));bottom:calc(12px + var(--sb));font-size:.74em;color:rgba(236,226,204,.42);text-shadow:0 1px 4px rgba(0,0,0,.9)}
.keys kbd{font-size:.86em;opacity:.8}
.hurt{position:absolute;inset:0;opacity:0;pointer-events:none;will-change:opacity;background:radial-gradient(ellipse 75% 70% at 50% 50%,rgba(90,0,0,0) 45%,rgba(110,10,6,.55) 82%,rgba(60,0,0,.85) 100%)}

.prompt{position:absolute;left:0;top:0;display:flex;align-items:center;gap:.42em;padding:.22em .7em .22em .26em;white-space:nowrap;font-size:.95em;color:#f3e8cf;
 background:rgba(10,11,14,.8);border:1px solid rgba(255,196,120,.42);border-radius:.5em .72em .55em .62em/.62em .5em .7em .55em;
 box-shadow:0 0 18px rgba(255,170,90,.2),0 4px 10px rgba(0,0,0,.4);opacity:0;transition:opacity .15s;pointer-events:none;will-change:transform}
.prompt.on{opacity:1}
.prompt::after{content:'';position:absolute;left:50%;bottom:-.42em;margin-left:-.4em;border:.4em solid transparent;border-top-color:rgba(255,196,120,.42);border-bottom:0}
.prompt kbd{font-size:.9em}
.U.tmode .prompt{padding:0;width:16px;height:16px;border-radius:50%;background:radial-gradient(circle,#fff1cf,#ffc478 40%,rgba(255,170,80,.0) 72%);border:0;box-shadow:none}
.U.tmode .prompt.on{animation:u-pulse 1.2s ease-in-out infinite}
.U.tmode .prompt span,.U.tmode .prompt::after{display:none}
@keyframes u-pulse{0%,100%{opacity:.55}50%{opacity:1}}

.toasts{position:absolute;left:50%;top:calc(12px + var(--st));transform:translateX(-50%);width:min(34em,56vw);display:flex;flex-direction:column;align-items:center;gap:.38em;z-index:9;pointer-events:none;transition:opacity .3s}
.U[data-mode=pause] .toasts,.U[data-mode=dead] .toasts,.U[data-mode=ending] .toasts,.U[data-mode=title] .toasts{opacity:0}
.U[data-mode=panel] .toast:not(:nth-last-child(-n+2)){display:none}
.toast{max-width:100%;padding:.42em 1.05em;font-size:.95em;line-height:1.45;text-align:center;color:var(--ink);background:rgba(11,12,16,.8);border:1px solid rgba(236,226,204,.13);
 border-radius:.6em .9em .7em .8em/.8em .6em .9em .7em;box-shadow:0 6px 18px rgba(0,0,0,.38);opacity:0;transform:translateY(-.5em);transition:opacity .35s,transform .35s}
.toast.on{opacity:1;transform:none}
.toast.out{opacity:0;transform:translateY(-.3em)}
.toast.k-warn{color:#f3d6ca;background:rgba(40,12,9,.84);border-color:rgba(200,86,74,.5)}
.toast.k-warn::before{content:'';display:inline-block;width:.46em;height:.46em;border-radius:50%;background:#d0594a;margin-right:.55em;vertical-align:.1em;box-shadow:0 0 7px #d0594a}
.toast.k-pickup{display:flex;flex-wrap:wrap;justify-content:center;gap:.2em .8em;padding:.26em .85em;font-size:.88em;color:var(--ink2);background:rgba(11,12,16,.6)}
.toast .pk{display:inline-flex;align-items:center;gap:.25em;white-space:nowrap}
.toast .pk img{width:1.6em;height:1.6em}
.toast .pk b{font-weight:400;color:#f2e2bd}
.toast.k-story{color:var(--pink);background:var(--tex-paper) #d2c39f;background-size:256px;border:0;font-size:1em;padding:.6em 1.3em;border-radius:.2em .5em .3em .45em;
 box-shadow:0 8px 22px rgba(0,0,0,.5),inset 0 0 1.2em rgba(90,60,25,.35);transform:translateY(-.5em) rotate(-.4deg)}
.toast.k-story.on{transform:rotate(-.4deg)}
.toast.k-discover{display:flex;align-items:center;gap:.8em;text-align:left;padding:.4em 1.1em .4em .5em;color:var(--pink);background:var(--tex-paper) #d2c39f;background-size:256px;
 border:0;border-radius:.3em .5em .35em .55em;box-shadow:0 0 0 1px rgba(255,196,120,.5),0 0 26px rgba(255,180,100,.28),0 8px 22px rgba(0,0,0,.5),inset 0 0 1.2em rgba(90,60,25,.3)}
.toast.k-discover img{width:5.6em;height:3.73em}
.toast.k-discover small{display:block;font-size:.72em;letter-spacing:.25em;color:#8a3b2c}
.toast.k-discover b{display:block;font-family:var(--fd);font-weight:400;font-size:1.35em;line-height:1.2;letter-spacing:.08em}

/* ---------------------------------------------------------------- cinematic overlays */
.wake{position:absolute;inset:0;background:#030406;opacity:0;pointer-events:none;will-change:opacity}
.cine{position:absolute;inset:0;pointer-events:none;opacity:0;transition:opacity 1.2s}
.cine.on{opacity:1}
.cine .bars::before{transform:translateY(-100%)}.cine .bars::after{transform:translateY(100%)}
.cine.on .bars::before,.cine.on .bars::after{transform:none}
.cine .lines{position:absolute;left:0;right:0;top:24vh;display:flex;flex-direction:column;align-items:center;gap:.9em;text-align:center;padding:0 1.5em}
.cine p{margin:0;font-family:var(--fd);font-size:1.75em;letter-spacing:.16em;color:#f1e6cc;text-shadow:0 2px 14px rgba(0,0,0,.9),0 0 3px rgba(0,0,0,.8);opacity:0;transform:translateY(.4em);transition:opacity 1.6s,transform 1.6s}
.cine p.on{opacity:1;transform:none}
.cine p.sm{font-family:var(--fb);font-size:1em;letter-spacing:.3em;color:rgba(236,226,204,.7)}
.daycard{position:absolute;left:0;right:0;top:15vh;text-align:center;pointer-events:none;opacity:0;transition:opacity 1.4s}
.daycard.on{opacity:1}
.daycard b{display:block;font-family:var(--fd);font-weight:400;font-size:2.6em;letter-spacing:.3em;margin-right:-.3em;color:#f3e8cf;text-shadow:0 2px 16px rgba(0,0,0,.85)}
.daycard span{display:block;font-size:.9em;letter-spacing:.4em;color:rgba(236,226,204,.7);text-shadow:0 1px 8px rgba(0,0,0,.9)}

/* ---------------------------------------------------------------- panels */
.pwrap{z-index:7}
.pback{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 50%,rgba(4,5,9,.5),rgba(2,3,6,.84))}
.U[data-mode=panel] .pback{pointer-events:auto}
.panel{position:absolute;left:50%;top:50%;width:min(62em,94vw);height:min(38.5em,90vh);display:flex;flex-direction:column;
 opacity:0;visibility:hidden;transform:translate(-50%,-48.5%);transition:opacity .22s,transform .22s,visibility 0s .22s}
.U[data-panel=craft] .craftp,.U[data-panel=journal] .journalp{opacity:1;visibility:visible;pointer-events:auto;transform:translate(-50%,-50%);transition:opacity .22s,transform .22s}
.panel .shadow{position:absolute;inset:.6em;border-radius:1em;box-shadow:0 1.4em 3em rgba(0,0,0,.65),0 0 0 1px rgba(0,0,0,.2)}
.panel .skin{position:absolute;inset:0}
.panel .x{position:absolute;right:.55em;top:.5em;width:2.3em;height:2.3em;display:grid;place-items:center;z-index:3;border-radius:50%;transition:background .2s}
.panel .x svg{width:1.3em;height:1.3em;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round}
.panel .x:hover{background:rgba(255,196,120,.14)}
.scroll{overflow-y:auto;overscroll-behavior:contain;touch-action:pan-y;-webkit-overflow-scrolling:touch;scrollbar-width:thin;scrollbar-color:rgba(236,226,204,.22) transparent}
.scroll::-webkit-scrollbar{width:6px}.scroll::-webkit-scrollbar-thumb{background:rgba(236,226,204,.2);border-radius:3px}

.craftp .skin{background:var(--tex-board) #17181b;background-size:256px;box-shadow:inset 0 0 4em rgba(0,0,0,.75),inset 0 0 0 1px rgba(236,226,204,.08)}
.craftp header,.journalp header{position:relative;z-index:2;display:flex;align-items:baseline;gap:.9em;padding:.9em 1.6em .2em}
.craftp h2,.pause h2{margin:0;font-family:var(--fd);font-weight:400;font-size:2em;letter-spacing:.24em;line-height:1.1;color:var(--ink)}
.craftp header span{font-size:.82em;color:var(--ink3)}
.craftp .cols{position:relative;z-index:2;flex:1;min-height:0;display:flex;gap:1.1em;padding:.5em 1.4em 0}
.craftp footer{position:relative;z-index:2;padding:.45em 1.6em .8em;font-size:.76em;color:var(--ink3)}
.craftp h3{margin:.5em 0 .35em;font-weight:400;font-size:.8em;letter-spacing:.32em;color:var(--ink3);display:flex;align-items:center;gap:.6em}
.craftp h3::after{content:'';flex:1;height:1px;background:linear-gradient(90deg,rgba(236,226,204,.18),rgba(236,226,204,0))}
.craftp h3 em{font-style:normal;letter-spacing:.1em;color:rgba(255,196,120,.6)}
.bag{flex:0 0 44%;display:flex;flex-direction:column;min-height:0}
.bag .scroll{flex:1;min-height:0;padding-right:.3em}
.grid{display:flex;flex-wrap:wrap;gap:.42em}
.cell{position:relative;width:3.6em;height:3.6em;display:grid;place-items:center;background:var(--tex-paper) #cbbb95;background-size:256px;
 border-radius:.3em .45em .28em .4em/.42em .3em .45em .32em;box-shadow:0 3px 6px rgba(0,0,0,.45),inset 0 0 .9em rgba(90,60,25,.38);transition:transform .15s,box-shadow .15s}
.cell:nth-child(3n+1){transform:rotate(-1.2deg)}.cell:nth-child(3n+2){transform:rotate(.9deg)}.cell:nth-child(5n){transform:rotate(-.5deg)}
.cell img{width:2.55em;height:2.55em}
.cell .n{position:absolute;right:.22em;bottom:.02em;font-size:.84em;color:var(--pink);font-weight:bold;text-shadow:0 0 3px rgba(230,215,180,.9),0 0 2px rgba(230,215,180,.9)}
.cell:hover,.cell.cur{transform:translateY(-2px) rotate(0);box-shadow:0 0 0 2px rgba(255,196,120,.6),0 6px 12px rgba(0,0,0,.5),inset 0 0 .9em rgba(90,60,25,.38)}
.cell.use::before{content:'用';position:absolute;left:.18em;top:.1em;font-size:.68em;line-height:1.2;color:#f6e9cc;background:#8a3b2c;padding:0 .25em;border-radius:.2em .3em .25em .2em}
.cell.pop{animation:u-pop .45s ease}
@keyframes u-pop{0%{transform:scale(1)}35%{transform:scale(1.14)}100%{transform:scale(1)}}
.empty{font-size:.85em;color:var(--ink3);padding:.4em 0}
.detail{display:flex;gap:.8em;align-items:center;min-height:4.4em;margin:.5em 0 0;padding:.55em .8em;background:rgba(0,0,0,.28);border-radius:.4em .6em .45em .55em;border:1px solid rgba(236,226,204,.07)}
.detail img{width:2.9em;height:2.9em;flex:none}
.detail b{font-family:var(--fd);font-weight:400;font-size:1.2em;letter-spacing:.08em;color:var(--ink)}
.detail b small{font-family:var(--fb);font-size:.62em;color:var(--ink3);letter-spacing:.1em;margin-left:.6em}
.detail p{margin:.1em 0 0;font-size:.84em;color:var(--ink2);line-height:1.45}
.detail .eff{color:#9fc4a0}
.recipes{flex:1;display:flex;flex-direction:column;min-height:0}
.recipes .scroll{flex:1;min-height:0;padding-right:.35em}
.rrow{position:relative;display:flex;align-items:center;gap:.75em;padding:.5em .6em .5em .5em;margin-bottom:.38em;border-radius:.45em .7em .5em .6em/.6em .45em .7em .5em;
 background:linear-gradient(90deg,rgba(236,226,204,.05),rgba(236,226,204,.02));border:1px solid rgba(236,226,204,.07);transition:background .2s,border-color .2s}
.rrow.ok{border-color:rgba(255,196,120,.3);background:linear-gradient(90deg,rgba(255,196,120,.1),rgba(255,196,120,.02))}
.rrow.own{opacity:.5}
.rrow .ri{flex:none;width:3.1em;height:3.1em;display:grid;place-items:center;background:var(--tex-paper) #cbbb95;background-size:256px;border-radius:50% 45% 52% 48%/48% 52% 45% 50%;box-shadow:inset 0 0 .7em rgba(90,60,25,.4),0 2px 5px rgba(0,0,0,.4)}
.rrow .ri img{width:2.3em;height:2.3em}
.rrow.no .ri img{opacity:.55;filter:saturate(.4)}
.rmid{flex:1;min-width:0}
.rname{font-family:var(--fd);font-size:1.18em;line-height:1.2;letter-spacing:.08em;color:var(--ink)}
.rname small{font-family:var(--fb);font-size:.6em;color:var(--ink3);margin-left:.6em;letter-spacing:.1em}
.rdesc{font-size:.78em;color:var(--ink2);line-height:1.4;margin:.08em 0 .25em}
.cost{display:flex;flex-wrap:wrap;gap:.25em .65em}
.cc{display:inline-flex;align-items:center;gap:.15em;font-size:.8em;color:#a7c8a2;white-space:nowrap}
.cc img{width:1.45em;height:1.45em}
.cc.lack{color:#d98a7c}
.cc b{font-weight:400}
.rbtn{flex:none;min-width:4.6em;padding:.38em .9em;font-family:var(--fd);font-size:1.05em;letter-spacing:.2em;color:var(--pink);
 background:linear-gradient(#e9d6a8,#c8a96c);border-radius:.4em .55em .38em .5em/.5em .38em .55em .4em;box-shadow:0 3px 0 #5e4526,0 4px 10px rgba(0,0,0,.4);transition:transform .1s,box-shadow .1s,filter .2s}
.rbtn:hover{filter:brightness(1.08)}
.rbtn:active{transform:translateY(2px);box-shadow:0 1px 0 #5e4526}
.rbtn[disabled]{cursor:default;color:var(--ink3);background:rgba(236,226,204,.06);box-shadow:none;font-family:var(--fb);font-size:.82em;letter-spacing:.1em}
.rrow.made{animation:u-made .9s ease}
@keyframes u-made{0%{box-shadow:0 0 0 0 rgba(255,196,120,.0)}25%{box-shadow:0 0 0 3px rgba(255,196,120,.7),0 0 26px rgba(255,180,100,.5)}100%{box-shadow:0 0 0 0 rgba(255,196,120,0)}}
.rnote{margin:.3em 0 .4em;font-size:.76em;color:var(--ink3);line-height:1.5}

.journalp .skin{background:var(--tex-paper) #d3c4a0;background-size:256px;box-shadow:inset 0 0 3.5em rgba(80,50,20,.55),inset 0 0 .5em rgba(80,50,20,.4)}
.journalp .skin::after{content:'';position:absolute;left:3.6em;top:0;bottom:0;width:1px;background:rgba(150,50,40,.28)}
.journalp{color:var(--pink)}
.journalp .x{color:#4a3726}
.journalp .x:hover{background:rgba(120,70,30,.14)}
.tabs{position:relative;z-index:2;display:flex;gap:.3em;padding:1em 0 0 4.4em}
.tab{position:relative;padding:.25em 1.1em .35em;font-family:var(--fd);font-size:1.45em;letter-spacing:.2em;color:rgba(42,31,22,.5);transition:color .2s}
.tab small{font-family:var(--fb);font-size:.52em;letter-spacing:.05em;margin-left:.3em}
.tab.on{color:var(--pink)}
.tab.on::after{content:'';position:absolute;left:.8em;right:.8em;bottom:.15em;height:.3em;background:no-repeat center/100% 100% url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 8' preserveAspectRatio='none'%3E%3Cpath d='M2 5C22 3 40 6.4 60 4.2S88 3.4 98 4.6' fill='none' stroke='%23963c2c' stroke-width='2' stroke-linecap='round'/%3E%3C/svg%3E")}
.pages{position:relative;z-index:2;flex:1;min-height:0;display:flex}
.page{flex:1;min-height:0;padding:.6em 2.2em 1.4em 4.6em;display:none}
.page.on{display:block}
.journalp .scroll{scrollbar-color:rgba(60,40,20,.3) transparent}
.journalp .scroll::-webkit-scrollbar-thumb{background:rgba(60,40,20,.3)}
.dgroup{margin:0 0 1em}
.dday{font-family:var(--fd);font-size:1.25em;letter-spacing:.14em;color:#8a3b2c;margin:.2em 0 .25em;display:flex;align-items:center;gap:.6em}
.dday::after{content:'';flex:1;height:1px;background:repeating-linear-gradient(90deg,rgba(90,60,30,.35) 0 6px,transparent 6px 10px)}
.de{margin:0 0 .55em;font-size:.98em;line-height:1.75;color:#33261a}
.de.cdx{display:flex;gap:.7em;align-items:center;color:#4a3a2a}
.de.cdx img{width:3.9em;height:2.6em;flex:none}
.letter{position:relative;margin:.4em 0 .9em;padding:.9em 1.2em 1em;background:rgba(246,238,214,.7);border-radius:.15em .3em .2em .25em;color:#2c3a4a;line-height:1.85;
 box-shadow:0 3px 8px rgba(60,40,20,.25),inset 0 0 1.4em rgba(150,120,70,.25);transform:rotate(-.5deg)}
.letter:nth-of-type(2n){transform:rotate(.45deg)}
.letter small{display:block;font-size:.76em;letter-spacing:.2em;color:#8a6a48;margin-bottom:.3em}
.letter p{margin:0;font-family:var(--fd);font-size:1.1em;letter-spacing:.04em}
.letter::before{content:'';position:absolute;right:1em;top:-.5em;width:2.2em;height:1em;background:rgba(220,200,150,.6);transform:rotate(4deg);box-shadow:0 1px 2px rgba(0,0,0,.15)}
.oldpage{margin:.4em 0 .9em;padding:.8em 1.1em;background:rgba(120,90,50,.16);border-left:3px solid rgba(120,70,40,.35);color:#3a2a1a;line-height:1.8;font-size:.96em}
.oldpage small{display:block;font-family:var(--fd);font-size:1.05em;color:#6a4a2a;letter-spacing:.1em}
.jempty{margin-top:2em;color:rgba(42,31,22,.55);font-size:.95em}
.cgroup h4{margin:.3em 0 .5em;font-family:var(--fd);font-weight:400;font-size:1.2em;letter-spacing:.2em;color:#6a4a2a;display:flex;align-items:center;gap:.6em}
.cgroup h4::after{content:'';flex:1;height:1px;background:repeating-linear-gradient(90deg,rgba(90,60,30,.35) 0 6px,transparent 6px 10px)}
.cgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(14.5em,1fr));gap:.7em 1em;margin-bottom:1.1em}
.card{display:flex;gap:.7em;align-items:flex-start;padding:.5em .6em;background:rgba(250,244,226,.42);border-radius:.25em .4em .3em .35em;box-shadow:0 2px 5px rgba(60,40,20,.18)}
.card img{width:6em;height:4em;flex:none}
.card b{display:block;font-family:var(--fd);font-weight:400;font-size:1.12em;letter-spacing:.06em;color:#2a1f16;line-height:1.3}
.card p{margin:.15em 0 0;font-size:.78em;line-height:1.5;color:#4a3a2a}
.card small{display:block;font-size:.7em;color:#8a6a48;margin-top:.2em;letter-spacing:.08em}
.card.unk{background:rgba(60,40,20,.08);box-shadow:none}
.card.unk b{color:rgba(42,31,22,.45);letter-spacing:.3em}
.card.unk p{color:rgba(42,31,22,.45)}
.ccount{font-size:.9em;color:#6a4a2a;margin:.1em 0 .6em;letter-spacing:.1em}
.ccount b{font-family:var(--fd);font-weight:400;font-size:1.3em;color:#8a3b2c}

/* ---------------------------------------------------------------- pause */
.pause{z-index:7;background:radial-gradient(ellipse at 50% 45%,rgba(5,6,10,.55),rgba(2,3,6,.88));display:flex;align-items:center;justify-content:center;gap:3.5em}
.pcard{display:flex;flex-direction:column;align-items:center}
.pause h2{font-size:2.6em;letter-spacing:.5em;margin-right:-.5em;margin-bottom:.15em}
.pinfo{margin:0 0 1.2em;font-size:.86em;color:var(--ink3);letter-spacing:.15em}
.pause .menu .mb{font-size:1.4em}
.pkeys{font-size:.82em;color:var(--ink2);padding:1em 1.3em;background:rgba(9,10,13,.55);border:1px solid rgba(236,226,204,.08);border-radius:.6em 1em .7em .9em/.9em .6em 1em .7em}
.pkeys h4{margin:0 0 .4em;font-family:var(--fd);font-weight:400;font-size:1.2em;letter-spacing:.2em;color:var(--ink)}

/* ---------------------------------------------------------------- death */
.dead{z-index:7;background:linear-gradient(180deg,rgba(6,14,24,.55),rgba(2,6,12,.94) 60%,#010306);transition:opacity .8s ease,visibility 0s linear .8s}
.U[data-mode=dead] .dead{transition:opacity 2.6s ease,visibility 0s}
.dead .bub{position:absolute;bottom:-2em;border-radius:50%;border:1px solid rgba(170,215,230,.35);opacity:0}
.U[data-mode=dead] .dead .bub{animation:u-rise linear infinite}
@keyframes u-rise{0%{transform:translate(0,0);opacity:0}10%{opacity:.8}100%{transform:translate(1.5em,-105vh);opacity:0}}
.dcon{position:absolute;left:0;right:0;top:50%;transform:translateY(-55%);display:flex;flex-direction:column;align-items:center;text-align:center;padding:0 2em}
.dcon h2{margin:0;font-family:var(--fd);font-weight:400;font-size:3em;letter-spacing:.24em;margin-right:-.24em;color:#dfe6ea;text-shadow:0 0 30px rgba(120,180,210,.25),0 2px 12px rgba(0,0,0,.8)}
.dline{max-width:32em;margin:1.1em 0 .4em;font-size:1em;line-height:1.8;color:rgba(214,224,230,.75)}
.dstat{margin:.2em 0 1.8em;font-size:.86em;letter-spacing:.2em;color:rgba(190,205,215,.5)}
.dcon>*{opacity:0;transition:opacity 2s}
.dead.go .dcon>*{opacity:1}
.dead.go .dcon h2{transition-delay:1s}.dead.go .dline{transition-delay:2.4s}.dead.go .dstat{transition-delay:3.2s}.dead.go .menu{transition-delay:3.8s}
.dead:not(.ready) .mb{pointer-events:none}
.dead .mb{color:rgba(214,224,230,.6)}.dead .mb.sel,.dead .mb:hover{color:#eef4f6}

/* ---------------------------------------------------------------- ending */
.ending{z-index:9;background:linear-gradient(180deg,#020306 0%,#04060b 52%,#0c0f18 84%,#111521 90%);transition:opacity 1.6s ease,visibility 0s linear 1.6s;overflow:hidden}
.U[data-mode=pause] .pause,.U[data-mode=dead] .dead,.U[data-mode=ending] .ending{pointer-events:auto}
.U[data-mode=ending] .ending{transition:opacity 3.5s ease,visibility 0s}
.eglow{position:absolute;left:50%;bottom:calc(9vh + 25.4vmin);width:90vmin;height:90vmin;margin:0 0 -45vmin -45vmin;background:radial-gradient(closest-side,rgba(255,206,140,.34),rgba(255,176,96,.12) 30%,rgba(255,160,80,.04) 62%,rgba(255,160,80,0) 100%);animation:u-glow 5s ease-in-out infinite}
@keyframes u-glow{0%,100%{opacity:.75;transform:scale(1)}50%{opacity:1;transform:scale(1.06)}}
.estars i{position:absolute;width:2px;height:2px;border-radius:50%;background:#dfe6ff;animation:u-tw 3s ease-in-out infinite}
@keyframes u-tw{0%,100%{opacity:.2}50%{opacity:.9}}
.lh{position:absolute;left:50%;bottom:9vh;width:13vmin;height:30vmin;margin-left:-6.5vmin}
.lh svg{width:100%;height:100%;overflow:visible}
.lh .tw{fill:#07080c}.lh .lamp{fill:#ffd9a0}.lh .isl{fill:#050608}
.beam{position:absolute;left:50%;bottom:calc(9vh + 25.4vmin);width:90vmax;height:9vmin;margin:-4.5vmin 0 0;transform-origin:0 50%;
 background:linear-gradient(90deg,rgba(255,214,150,.55),rgba(255,214,150,.12) 45%,rgba(255,214,150,0));clip-path:polygon(0 46%,100% 0,100% 100%,0 54%);animation:u-beam 7s linear infinite}
@keyframes u-beam{0%{transform:scaleX(1);opacity:.9}25%{transform:scaleX(.02);opacity:.15}50%{transform:scaleX(-1);opacity:.9}75%{transform:scaleX(.02);opacity:.15}100%{transform:scaleX(1);opacity:.9}}
.esea{position:absolute;left:0;right:0;bottom:0;height:10vh;background:linear-gradient(#070910,#020305)}
.esea::before{content:'';position:absolute;left:0;right:0;top:0;height:1px;background:linear-gradient(90deg,rgba(255,214,150,0),rgba(255,214,150,.35) 50%,rgba(255,214,150,0))}
.esea::after{content:'';position:absolute;left:50%;top:1px;width:5vmin;height:100%;margin-left:-2.5vmin;background:repeating-linear-gradient(180deg,rgba(255,214,150,.38) 0 2px,rgba(255,214,150,0) 2px 7px);-webkit-mask:linear-gradient(180deg,#000,transparent);mask:linear-gradient(180deg,#000,transparent);animation:u-glow 3s ease-in-out infinite}
.eraft{position:absolute;left:calc(50% - 30vmin);bottom:calc(10vh - 1px);width:9vmin;height:5.6vmin;animation:u-bob 4s ease-in-out infinite}
.eraft svg{width:100%;height:100%;overflow:visible;fill:#030406}
.eraft .lt{fill:#ffd08a;filter:drop-shadow(0 0 3px #ffb060)}
@keyframes u-bob{0%,100%{transform:translateY(0) rotate(-1deg)}50%{transform:translateY(.25vmin) rotate(1deg)}}
.eline{position:absolute;left:0;right:0;top:20vh;padding:0 2em;text-align:center;font-family:var(--fd);font-size:1.75em;line-height:1.7;letter-spacing:.12em;color:#f1e6cc;text-shadow:0 2px 14px rgba(0,0,0,.9);opacity:0;transition:opacity 1.4s}
.eline.on{opacity:1}
.ecred{position:absolute;left:0;right:0;top:12vh;display:flex;flex-direction:column;align-items:center;text-align:center;opacity:0;visibility:hidden;transition:opacity 2.4s,visibility 0s 2.4s}
.ecred.on{opacity:1;visibility:visible;transition:opacity 2.4s}
.ecred h1{margin:0;font-family:var(--fd);font-weight:400;font-size:clamp(40px,10vmin,96px);letter-spacing:.16em;margin-right:-.16em;color:#efe4ca;text-shadow:0 0 .6em rgba(255,196,120,.25)}
.ecred p{margin:.3em 0;font-size:.95em;letter-spacing:.2em;color:rgba(236,226,204,.65)}
.ecred .thx{margin:1em 0 1.2em;font-family:var(--fd);font-size:1.7em;letter-spacing:.4em;color:var(--warm);text-shadow:0 0 18px rgba(255,170,90,.4)}
.eskip{position:absolute;right:calc(1.4em + var(--sr));bottom:calc(1.2em + var(--sb));font-size:.74em;letter-spacing:.2em;color:rgba(236,226,204,.3)}

/* ---------------------------------------------------------------- touch */
.touch{position:absolute;inset:0;pointer-events:none;display:none}
.U.tmode[data-mode=play] .touch{display:block}
.tb{position:absolute;pointer-events:auto;display:grid;place-items:center;width:58px;height:58px;color:rgba(236,226,204,.85);font-size:15px;letter-spacing:.1em;
 background:radial-gradient(circle at 50% 40%,rgba(48,46,42,.55),rgba(10,11,14,.6));border:1px solid rgba(236,226,204,.2);border-radius:46% 54% 50% 50%/52% 48% 54% 46%;
 box-shadow:0 4px 12px rgba(0,0,0,.4);touch-action:none;transition:transform .08s,background .15s}
.tb svg{width:26px;height:26px;fill:none;stroke:currentColor;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round}
.tb.is-down{transform:scale(.92);background:radial-gradient(circle at 50% 40%,rgba(255,196,120,.4),rgba(40,26,12,.65));border-color:rgba(255,196,120,.6)}
.tb-l{left:calc(16px + var(--sl));bottom:calc(18px + var(--sb))}
.tb-r{left:calc(86px + var(--sl));bottom:calc(18px + var(--sb))}
.tb-u{right:calc(86px + var(--sr));bottom:calc(84px + var(--sb))}
.tb-d{right:calc(86px + var(--sr));bottom:calc(18px + var(--sb))}
.tb-use{right:calc(14px + var(--sr));bottom:calc(18px + var(--sb));width:64px;height:64px;font-family:var(--fd);font-size:17px}
.tb-act{right:calc(14px + var(--sr));bottom:calc(92px + var(--sb));width:64px;height:52px;font-size:13px;padding:0 4px;line-height:1.15;text-align:center;overflow:hidden}
.tb-act.long{font-size:11px;letter-spacing:0;line-height:1.2}
.tb-act.live{color:#2a1f16;background:radial-gradient(circle at 50% 40%,#f5dcae,#d7a865);border-color:rgba(255,220,170,.9);box-shadow:0 0 16px rgba(255,180,100,.55)}
.tb-cyc{right:calc(86px + var(--sr));bottom:calc(150px + var(--sb));width:58px;height:40px;font-size:13px;display:none}
.U.hammer .tb-cyc{display:grid}
.tb-m{width:44px;height:38px;font-size:13px;right:calc(14px + var(--sr))}
.tb-m1{top:calc(66px + var(--st))}.tb-m2{top:calc(110px + var(--st))}.tb-m3{top:calc(154px + var(--st))}
.U.tmode .keys,.U.tmode .slot .k,.U.tmode .chip kbd,.U.tmode .prompt kbd{display:none}
.U.tmode .chip .cl{display:inline}
.U.tmode .slot{width:46px;height:46px}
.U.tmode .slot img{width:32px;height:32px}
.U.tmode .chip{height:40px;font-size:13px}
.U.tmode .bottom{bottom:calc(8px + var(--sb))}
.U.tmode .clock{right:calc(68px + var(--sr))}

/* ---------------------------------------------------------------- small / short screens */
@media (max-height:560px){
 .thead{top:calc(5vh + var(--st))}
 .tsub{font-size:1em;margin-top:.45em}
 .torn{display:none}
 .tmenu{bottom:calc(9vh + var(--sb))}
 .tmenu .mb{font-size:1.35em}
 .tfoot{display:none}
 .howto{display:none;left:50%;bottom:auto;top:50%;transform:translate(-50%,-50%);z-index:3;width:min(24em,80vw)}
 .title.showkeys .howto{display:block}
 .title .ht-btn{display:block}
 .bars::before,.bars::after{height:5vh}
 .pause{gap:1.5em}
 .pkeys{display:none}
 .panel{height:94vh;width:96vw}
 .cine .lines{top:18vh}
 .cine p{font-size:1.45em}
 .dcon h2{font-size:2.2em}
 .eline{font-size:1.35em;top:12vh}
}
@media (max-width:700px){
 .bag{flex-basis:46%}
 .craftp header span{display:none}
}
`;
}

// =====================================================================================
// build
// =====================================================================================

function loadFonts() {
  const q = 'family=Ma+Shan+Zheng&family=Noto+Serif+SC:wght@400;700&display=swap';
  const add = (host) => {
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = 'https://' + host + '/css2?' + q;
    document.head.appendChild(l);
    return l;
  };
  try {
    for (const href of ['https://fonts.googleapis.com', 'https://fonts.gstatic.com']) {
      const p = document.createElement('link'); p.rel = 'preconnect'; p.href = href; if (href.includes('gstatic')) p.crossOrigin = 'anonymous';
      document.head.appendChild(p);
    }
    const main = add('fonts.googleapis.com');
    let ok = false;
    main.onload = () => { ok = true; };
    // Google Fonts can be unreachable (e.g. mainland China): try the .cn mirror once.
    const fallback = () => { if (!ok && !S.fontFallback) { S.fontFallback = true; add('fonts.googleapis.cn'); } };
    main.onerror = fallback;
    setTimeout(fallback, 4500);
  } catch (e) { /* the serif stack is fine */ }
}

function build() {
  U = h('div', 'U');
  U.setAttribute('data-mode', 'title');
  ROOT.appendChild(U);

  // ---- HUD
  const hud = E.hud = h('div', 'hud');
  E.hurt = h('div', 'hurt'); U.appendChild(E.hurt);
  const stats = h('div', 'stats');
  for (const k of ['hp', 'hunger', 'thirst', 'o2']) {
    const r = h('div', 'ring ' + k, ringSVG(k) + '<span class="rn"></span>');
    r.title = RING_INFO[k][0];
    stats.appendChild(r);
    S.rings[k] = { el: r, v: -1, arc: r.querySelector('.rv'), num: r.querySelector('.rn'), low: false, upT: 0 };
  }
  hud.appendChild(stats);

  const clock = h('div', 'clock');
  E.dial = h('div', 'dial', dialSVG());
  E.dialRot = E.dial.querySelector('.dial-rot');
  const daybox = h('div', 'daybox',
    '<div class="dayl">第<b>1</b>天</div><div class="dist">距灯塔 <b>200</b> 海里</div>'
    + '<div class="track"><i class="tl"></i><i class="tf"></i><i class="tr"></i>' + LH_SVG + '</div>');
  E.dayN = daybox.querySelector('.dayl b');
  E.distN = daybox.querySelector('.dist b');
  E.trackR = daybox.querySelector('.tr');
  E.trackF = daybox.querySelector('.tf');
  clock.appendChild(daybox); clock.appendChild(E.dial);
  hud.appendChild(clock);

  const bottom = h('div', 'bottom');
  E.thint = h('div', 'thint');
  bottom.appendChild(E.thint);
  const bar = h('div', 'bar');
  E.eat = h('button', 'chip eat', '<kbd>F</kbd><span class="cl">吃</span><img alt=""><span class="cn"></span>');
  E.drink = h('button', 'chip drink', '<kbd>R</kbd><span class="cl">喝</span><img alt=""><span class="cn"></span>');
  E.eat.title = '吃东西（F）'; E.drink.title = '喝水（R）';
  bindTouchButton(E.eat, 'eat'); bindTouchButton(E.drink, 'drink');
  const slots = h('div', 'slots');
  E.slots = [];
  const TOOLS = [['hook', '钩索'], ['spear', '鱼叉'], ['hammer', '锤子'], ['hand', '空手']];
  TOOLS.forEach(([id, name], i) => {
    const b = h('button', 'slot', '<img alt=""><span class="k">' + (i + 1) + '</span>' + (id === 'hand' ? '<i class="lt"><img alt=""></i>' : ''));
    b.querySelector('img').src = iconURL(id);
    if (id === 'hand') b.querySelector('.lt img').src = iconURL('lantern');
    b.title = name + '（' + (i + 1) + '）';
    bindTouchButton(b, 'tool' + (i + 1));
    slots.appendChild(b);
    E.slots.push({ el: b, id, name });
  });
  bar.appendChild(E.eat); bar.appendChild(slots); bar.appendChild(E.drink);
  bottom.appendChild(bar);
  hud.appendChild(bottom);
  hud.appendChild(h('div', 'keys', '<kbd>Tab</kbd> 背包　<kbd>J</kbd> 日记　<kbd>Esc</kbd> 暂停'));
  U.appendChild(hud);

  E.prompt = h('div', 'prompt', '<kbd>E</kbd><span></span>');
  E.promptL = E.prompt.querySelector('span');
  U.appendChild(E.prompt);

  // ---- cinematic overlays (intro, continue, new day)
  E.wake = h('div', 'wake'); U.appendChild(E.wake);
  E.cine = h('div', 'cine', '<div class="bars"></div><div class="lines"></div>');
  E.cineLines = E.cine.querySelector('.lines');
  U.appendChild(E.cine);
  E.dayCard = h('div', 'daycard', '<b></b><span></span>');
  U.appendChild(E.dayCard);

  // ---- touch controls
  const touch = h('div', 'touch');
  const tb = (cls, key, html) => { const b = h('button', 'tb ' + cls, html); bindTouchButton(b, key); touch.appendChild(b); return b; };
  tb('tb-l', 'left', ARROW.left); tb('tb-r', 'right', ARROW.right);
  tb('tb-u', 'up', ARROW.up); tb('tb-d', 'down', ARROW.down);
  tb('tb-use', 'use', '使用');
  E.tAct = tb('tb-act', 'interact', '互动');
  tb('tb-cyc', 'cycle', '切换');
  tb('tb-m tb-m1', 'craft', '背包');
  const jb = tb('tb-m tb-m2', 'journal', '图鉴');
  jb.addEventListener('pointerdown', () => { S.jTab = 'codex'; });
  tb('tb-m tb-m3', 'pause', '暂停');
  U.appendChild(touch);

  // ---- panels
  const pw = E.pwrap = h('div', 'scr pwrap');
  const back = h('div', 'pback');
  back.addEventListener('click', () => closePanel());
  pw.appendChild(back);
  pw.appendChild(buildCraftPanel());
  pw.appendChild(buildJournalPanel());
  U.appendChild(pw);

  // ---- pause
  const pause = E.pause = h('div', 'scr pause',
    '<div class="pcard"><h2>暂停</h2><p class="pinfo"></p><nav class="menu">'
    + '<button class="mb" data-act="resume"><span class="mt">继续</span></button><button class="mb" data-act="save"><span class="mt">保存</span></button>'
    + '<button class="mb" data-act="mute"><span class="mt">声音：开</span></button><button class="mb" data-act="title"><span class="mt">回到标题</span></button></nav></div>'
    + '<div class="pkeys"><h4>操作</h4><div class="pk-list"></div></div>');
  E.pinfo = pause.querySelector('.pinfo');
  E.pkeys = pause.querySelector('.pk-list');
  E.muteBtn = pause.querySelector('[data-act=mute]');
  E.saveBtn = pause.querySelector('[data-act=save]');
  wireMenu(pause);
  U.appendChild(pause);

  // ---- death
  let bubs = '';
  for (let i = 0; i < 16; i++) {
    const s = 0.3 + ((i * 37) % 10) / 10;
    bubs += '<i class="bub" style="left:' + ((i * 61) % 100) + '%;width:' + s + 'em;height:' + s + 'em;animation-duration:' + (7 + ((i * 13) % 9)) + 's;animation-delay:' + ((i * 0.83) % 7).toFixed(2) + 's"></i>';
  }
  const dead = E.dead = h('div', 'scr dead', bubs
    + '<div class="dcon"><h2></h2><p class="dline"></p><p class="dstat"></p><nav class="menu">'
    + '<button class="mb" data-act="restart"><span class="mt">再试一次</span></button><button class="mb" data-act="load"><span class="mt">回到今天早上</span></button>'
    + '<button class="mb" data-act="title"><span class="mt">回到标题</span></button></nav></div>');
  E.dTitle = dead.querySelector('h2'); E.dLine = dead.querySelector('.dline'); E.dStat = dead.querySelector('.dstat');
  E.dLoad = dead.querySelector('[data-act=load]');
  wireMenu(dead);
  U.appendChild(dead);

  // ---- ending
  let stars = '';
  for (let i = 0; i < 46; i++) {
    stars += '<i style="left:' + ((i * 53.3) % 100).toFixed(1) + '%;top:' + ((i * 29.7) % 62).toFixed(1) + '%;animation-delay:' + ((i * 0.37) % 3).toFixed(2) + 's;opacity:.4"></i>';
  }
  const ending = E.ending = h('div', 'scr ending',
    '<div class="estars">' + stars + '</div><div class="eglow"></div><div class="beam"></div>'
    + '<div class="lh"><svg viewBox="0 0 40 92"><path class="isl" d="M-40 92C-20 80 0 77 10 76h22c12 1 30 6 48 16z"/>'
    + '<path class="tw" d="M13 77 15.4 22h9.2L27 77z"/><path class="tw" d="M12 22h16v-2.4H12z"/><path class="lamp" d="M15 19.6h10v-7.4H15z"/>'
    + '<path class="tw" d="M13.6 12.4 20 6.4l6.4 6z"/><path class="tw" d="M19.4 6.6h1.2V3h-1.2z"/></svg></div>'
    + '<div class="esea"></div><div class="eraft"><svg viewBox="0 0 60 36"><path d="M2 30h50l-3 4H5z"/><path d="M20 30 21 2h1.4l.8 28z"/><path d="M23 4c9 5 15 13 16 24H23z" opacity=".9"/><path d="M44 30v-8.6c0-1.6 1-2.6 2.2-2.6s2.2 1 2.2 2.6V30z"/><circle cx="46.2" cy="16.6" r="2.6"/><circle class="lt" cx="51.4" cy="24.6" r="1.5"/></svg></div><div class="eline"></div>'
    + '<div class="ecred"><h1>少年与海</h1><p class="es1"></p><p class="es2"></p><div class="thx">谢谢游玩</div>'
    + '<nav class="menu"><button class="mb" data-act="title"><span class="mt">回到标题</span></button></nav></div>'
    + '<div class="eskip">点击继续</div>');
  E.eLine = ending.querySelector('.eline'); E.eCred = ending.querySelector('.ecred');
  E.es1 = ending.querySelector('.es1'); E.es2 = ending.querySelector('.es2'); E.eSkip = ending.querySelector('.eskip');
  ending.addEventListener('click', (e) => { if (!e.target.closest('.mb')) advanceEnding(); });
  wireMenu(ending);
  U.appendChild(ending);

  // ---- title poster
  const title = E.title = h('div', 'scr title',
    '<div class="tshade"></div><div class="bars"></div>'
    + '<header class="thead"><div class="tkick">暴风雨过后</div>'
    + '<h1 class="tlogo">少年<span class="yu">与</span>海<span class="tseal">漂流</span></h1>'
    + '<p class="tsub">一只木筏，一片没有尽头的海</p>'
    + '<div class="torn"><i></i>' + LH_SVG + '<i></i></div></header>'
    + '<nav class="menu tmenu"><button class="mb" data-act="continue"><span class="mt">继续旅程</span><small></small></button>'
    + '<button class="mb" data-act="new"><span class="mt">新的旅程</span></button><button class="mb minor ht-btn" data-act="howto"><span class="mt">操作说明</span></button></nav>'
    + '<aside class="howto"><h4>操作</h4><div class="ht-list"></div></aside>'
    + '<footer class="tfoot">按 Enter 开始 · 戴上耳机更好</footer>');
  E.tCont = title.querySelector('[data-act=continue]');
  E.tNew = title.querySelector('[data-act=new]');
  E.tHow = title.querySelector('.ht-list');
  wireMenu(title);
  U.appendChild(title);

  // ---- toasts on top of everything
  E.toasts = h('div', 'toasts');
  U.appendChild(E.toasts);
}

function buildCraftPanel() {
  const p = E.craftp = h('div', 'panel craftp',
    '<div class="shadow"></div><div class="skin"></div><button class="x" title="关闭">' + XSVG + '</button>'
    + '<header><h2>背包</h2><span>捡来的东西都在这里，也能用它们做点什么</span></header>'
    + '<div class="cols"><section class="bag"><div class="scroll"></div><div class="detail"></div></section>'
    + '<section class="recipes"><h3>制作</h3><div class="scroll"></div></section></div>'
    + '<footer></footer>');
  p.querySelector('.skin').style.clipPath = ragged(17, 4);
  E.bagList = p.querySelector('.bag .scroll');
  E.detail = p.querySelector('.detail');
  E.rList = p.querySelector('.recipes .scroll');
  E.cFoot = p.querySelector('footer');
  p.querySelector('.x').addEventListener('click', () => closePanel());
  p.addEventListener('click', (e) => {
    const G = API && API.G;
    if (!G) return;
    const cell = e.target.closest('.cell');
    if (cell) { onCell(G, cell.dataset.id, cell); return; }
    const btn = e.target.closest('.rbtn');
    if (btn && !btn.disabled) {
      const id = btn.dataset.id;
      if (craft(G, id)) { S.madeId = id; S.madeT = S.t; S.detail = id; }
      S.bagSig = '';
      btn.blur();
    }
  });
  p.addEventListener('pointerover', (e) => {
    const cell = e.target.closest('.cell');
    if (cell && cell.dataset.id !== S.detail && e.pointerType === 'mouse') { S.detail = cell.dataset.id; renderDetail(API.G); }
    const row = e.target.closest('.rrow');
    if (row && row.dataset.id !== S.detail && e.pointerType === 'mouse') { S.detail = row.dataset.id; renderDetail(API.G); }
  });
  return p;
}

function buildJournalPanel() {
  const p = E.journalp = h('div', 'panel journalp',
    '<div class="shadow"></div><div class="skin"></div><button class="x" title="关闭">' + XSVG + '</button>'
    + '<div class="tabs"><button class="tab" data-tab="diary">日记</button><button class="tab" data-tab="codex">图鉴<small></small></button></div>'
    + '<div class="pages"><div class="page diary scroll"></div><div class="page codex scroll"></div></div>');
  p.querySelector('.skin').style.clipPath = ragged(29, 3);
  E.jDiary = p.querySelector('.page.diary');
  E.jCodex = p.querySelector('.page.codex');
  E.jTabs = [...p.querySelectorAll('.tab')];
  E.jCount = p.querySelector('.tab small');
  p.querySelector('.x').addEventListener('click', () => closePanel());
  for (const t of E.jTabs) t.addEventListener('click', () => { S.jTab = t.dataset.tab; S.jSig = ''; sfx('ui'); t.blur(); });
  return p;
}

// Menus: hover selects, click / Enter / Space activates.
function wireMenu(root) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('.mb');
    if (!b || !root.contains(b)) return;
    b.blur();
    menuAction(b.dataset.act, b);
  });
  root.addEventListener('pointerover', (e) => {
    const b = e.target.closest('.mb');
    if (!b) return;
    const list = menuButtons();
    const i = list.indexOf(b);
    if (i >= 0 && i !== S.menuSel) { S.menuSel = i; markSel(); }
  });
}

function menuButtons() {
  let root = null;
  const m = S.mode;
  if (m === 'title') root = E.title;
  else if (m === 'pause') root = E.pause;
  else if (m === 'dead') root = E.dead;
  else if (m === 'ending' && S.end && S.end.cred) root = E.ending;
  if (!root) return [];
  return [...root.querySelectorAll('.mb')].filter((b) => !b.hidden && b.offsetParent !== null);
}
function markSel() {
  const list = menuButtons();
  if (!list.length) return;
  S.menuSel = clamp(S.menuSel, 0, list.length - 1);
  list.forEach((b, i) => toggle(b, 'sel', i === S.menuSel));
}

function onKey(e) {
  const m = S.mode;
  if (m === 'ending' && !(S.end && S.end.cred)) {
    if (['Enter', 'Space', 'KeyE', 'Escape'].includes(e.code)) advanceEnding();
    return;
  }
  if (m !== 'title' && m !== 'pause' && m !== 'dead' && m !== 'ending') return;
  if (m === 'dead' && !E.dead.classList.contains('ready')) return;   // still sinking: ignore mashed keys
  const list = menuButtons();
  if (!list.length) return;
  if (e.code === 'ArrowUp' || e.code === 'KeyW') { S.menuSel = (S.menuSel - 1 + list.length) % list.length; markSel(); sfx('ui'); }
  else if (e.code === 'ArrowDown' || e.code === 'KeyS') { S.menuSel = (S.menuSel + 1) % list.length; markSel(); sfx('ui'); }
  else if ((e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space') && !e.repeat) {
    const b = list[clamp(S.menuSel, 0, list.length - 1)];
    if (b) { e.preventDefault(); menuAction(b.dataset.act, b); }
  }
}

function menuAction(act, btn) {
  const G = API && API.G;
  try { unlockAudio(); } catch (e) { /* ignore */ }
  switch (act) {
    case 'continue': sfx('ui'); API.continueGame(); break;
    case 'new':
      if (API.hasSave() && S.t - S.confirmNew > 4) {
        S.confirmNew = S.t;
        btn.innerHTML = '<span class="mt">再按一次：重新开始</span><small>旧的旅程会被抹去</small>';
        btn.classList.add('warn');
        sfx('ui');
        return;
      }
      sfx('ui'); API.startNew(); break;
    case 'howto': E.title.classList.toggle('showkeys'); sfx('ui'); break;
    case 'resume': if (G) { G.mode = 'play'; } sfx('ui'); break;
    case 'save': {
      const ok = API.save();
      setText(btn.querySelector('.mt'), ok ? '已保存' : '保存失败');
      S.saveFlashT = S.t;
      sfx('ui');
      break;
    }
    case 'mute': {
      const m = !S.muted;
      S.muted = m;
      try { setMuted(m); } catch (e) { /* ignore */ }
      try { localStorage.setItem(MUTE_KEY, m ? '1' : '0'); } catch (e) { /* ignore */ }
      refreshMute();
      if (!m) sfx('ui');
      break;
    }
    case 'title': sfx('ui'); API.toTitle(); break;
    case 'restart': sfx('ui'); API.restart(); break;
    case 'load': sfx('ui'); API.continueGame(); break;
  }
}

function refreshMute() {
  const m = !!S.muted;
  if (E.muteBtn) setText(E.muteBtn.querySelector('.mt'), '声音：' + (m ? '关' : '开'));
}

// =====================================================================================
// public API
// =====================================================================================

let ROOT = null;

export function initUI(api) {
  API = api;
  ROOT = document.getElementById('ui') || document.body;
  if (U) return;
  try { S.coarse = !!(window.matchMedia && window.matchMedia('(pointer:coarse)').matches); } catch (e) { S.coarse = false; }
  loadFonts();
  const tex = {
    paper: texture(256, 256, '#d4c5a1', 5, { stains: 9, stainA: 0.16, stain: '120,84,40', fibers: 140, fiber: '90,60,30', grain: 16 }),
    board: texture(256, 256, '#18191c', 9, { stains: 8, stainA: 0.22, stain: '60,52,44', fibers: 120, fiber: '210,200,180', grain: 12 }),
  };
  const style = document.createElement('style');
  style.textContent = css(tex);
  document.head.appendChild(style);
  build();

  const unlock = () => { try { unlockAudio(); } catch (e) { /* ignore */ } };
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);
  window.addEventListener('touchend', unlock, true);
  window.addEventListener('keydown', onKey);
  // the UI keeps the mute choice itself (remembered across sessions) and tells audio.js
  let saved = null;
  try { saved = localStorage.getItem(MUTE_KEY); } catch (e) { saved = null; }
  if (saved === '1' || saved === '0') S.muted = saved === '1';
  else { try { S.muted = !!isMuted(); } catch (e) { S.muted = false; } }
  try { if (S.muted) setMuted(true); } catch (e) { /* ignore */ }
  E.tHow.innerHTML = keysHTML(S.coarse);
  warmUp();
}

// Paint the remaining item icons and codex drawings a few at a time while the browser
// is idle, so opening the bag or the codex for the first time never hitches.
function warmUp() {
  const jobs = [];
  for (const id of ITEM_ORDER) jobs.push(() => iconURL(id));
  for (const id of CODEX_IDS) { jobs.push(() => codexArt(id, false)); jobs.push(() => codexArt(id, true)); }
  const idle = window.requestIdleCallback || ((fn) => setTimeout(() => fn({ timeRemaining: () => 8 }), 60));
  const run = (dl) => {
    let n = 0;
    while (jobs.length && (n++ < 1 || dl.timeRemaining() > 4)) { try { jobs.shift()(); } catch (e) { /* ignore */ } }
    if (jobs.length) idle(run);
  };
  setTimeout(() => idle(run), 1500);
}

export function onStart(G, how) {
  S.pending = { G, how };
}

// Optional painted key art (assets/title.*): shown behind the title poster once it loads.
let titleArtDone = false;
function applyTitleArt() {
  if (titleArtDone || !E.title) return;
  const img = getAsset('title');
  if (!img) return;
  titleArtDone = true;
  const art = document.createElement('div');
  art.style.cssText = 'position:absolute;inset:0;z-index:-1;background:#05070c center/cover no-repeat;opacity:0;transition:opacity 1.2s ease';
  art.style.backgroundImage = 'url("' + img.src + '")';
  E.title.insertBefore(art, E.title.firstChild);
  requestAnimationFrame(() => { art.style.opacity = '1'; });
}

export function frame(G, dt) {
  applyTitleArt();
  if (!U || !G) return;
  dt = Math.min(Math.max(dt || 0, 0), 0.1);
  S.t += dt;
  if (G !== S.G) attach(G);

  // touch mode
  const tm = isTouch();
  if (tm !== S.touch) {
    S.touch = tm;
    toggle(U, 'tmode', tm);
    if (E.pkeys) E.pkeys.innerHTML = keysHTML(tm);
    if (E.tHow) E.tHow.innerHTML = keysHTML(tm);
  }

  handleToggles(G);
  syncMode(G);
  const m = G.mode;
  if (m === 'play' || m === 'panel' || m === 'pause') updateHud(G, dt);
  updateToasts(G, dt);
  updatePrompt(G);
  if (m === 'panel') updatePanel(G);
  if (m === 'pause' && S.saveFlashT && S.t - S.saveFlashT > 2) { S.saveFlashT = 0; setText(E.saveBtn.querySelector('.mt'), '保存'); }
  if (m === 'ending') updateEnding(G, dt);
  if (m === 'dead' && S.deadAt != null && S.t - S.deadAt > 3.9) toggle(E.dead, 'ready', true);
  updateCine(G, dt);
  updateHurt(G, dt);
  if (m === 'play') { S.playT += dt; story(G, dt); }
}

// A new G object: new game, loaded game, or back to the title demo.
function attach(G) {
  S.G = G;
  for (const rec of S.toasts.values()) rec.el.remove();
  S.toasts.clear();
  S.rings.hp && Object.values(S.rings).forEach((r) => { r.v = -1; });
  S.day = null; S.dist = null; S.trackP = null; S.dialA = null; S.slotKey = ''; S.chipKey = '';
  S.tool = G.player ? G.player.tool : null; S.toolHintT = 0;
  S.lastHp = null; S.hurt = 0; S.playT = 0; S.bagSig = ''; S.jSig = ''; S.detail = null;
  S.lastDay = G.day; S.dayCard = null;
  S.intro = null; S.cont = null; S.end = null;
  S.modeKey = '';
  // clear any cinematic left over from the previous G
  toggle(E.cine, 'on', false); toggle(E.hud, 'cine', false); toggle(E.dayCard, 'on', false);
  E.cineLines.innerHTML = '';
  E.wake.style.opacity = '0';
  const p = S.pending;
  S.pending = null;
  if (p && p.G === G && !G.demo) {
    // Automated runs (smoke tests, screenshots) skip the cinematic so the very first
    // frames of play are not hidden behind a black fade. window.__raftIntro forces it.
    let auto = false;
    try { auto = !!navigator.webdriver && !window.__raftIntro; } catch (e) { auto = false; }
    if (p.how === 'new') startIntro(G, auto);
    else if (!auto) startContinue(G);
  }
}

// =====================================================================================
// modes & toggles
// =====================================================================================

function handleToggles(G) {
  const m = G.mode;
  if (G.demo) return;
  if (m === 'play') {
    if (input.pausePressed) { G.mode = 'pause'; G.panel = null; }
    else if (input.craftPressed) openPanel(G, 'craft');
    else if (input.journalPressed) openPanel(G, 'journal');
  } else if (m === 'panel') {
    if (input.pausePressed) closePanel();
    else if (input.craftPressed) { if (G.panel === 'craft') closePanel(); else { G.panel = 'craft'; sfx('ui'); } }
    else if (input.journalPressed) { if (G.panel === 'journal') closePanel(); else { G.panel = 'journal'; sfx('ui'); } }
  } else if (m === 'pause') {
    if (input.pausePressed) G.mode = 'play';
  }
  input.pausePressed = false; input.craftPressed = false; input.journalPressed = false;
}

function openPanel(G, which) {
  if (G.player && (G.player.dead || G.player.hp <= 0)) return;
  G.mode = 'panel'; G.panel = which;
  sfx('ui');
}
function closePanel() {
  const G = API && API.G;
  if (G && G.mode === 'panel') { G.mode = 'play'; G.panel = null; sfx('ui'); }
}

function syncMode(G) {
  const panel = G.mode === 'panel' ? (G.panel === 'journal' ? 'journal' : 'craft') : '';
  const key = G.mode + '|' + panel;
  if (key === S.modeKey) return;
  const prev = S.mode;
  S.modeKey = key; S.mode = G.mode; S.panel = panel;
  U.setAttribute('data-mode', G.mode);
  U.setAttribute('data-panel', panel);
  if (document.activeElement && document.activeElement !== document.body && U.contains(document.activeElement)) document.activeElement.blur();
  S.menuSel = 0;
  if (G.mode === 'title') enterTitle();
  else if (G.mode === 'pause') enterPause(G);
  else if (G.mode === 'panel') { S.bagSig = ''; S.jSig = ''; if (panel === 'craft' && E.bagList) { E.bagList.scrollTop = 0; } }
  else if (G.mode === 'dead') enterDead(G);
  else if (G.mode === 'ending' && prev !== 'ending') enterEnding(G);
  if (G.mode !== 'ending') toggle(E.ending, 'go', false);
  if (G.mode !== 'dead') toggle(E.dead, 'go', false);
  markSel();
}

function enterTitle() {
  let has = false;
  try { has = !!API.hasSave(); } catch (e) { has = false; }
  E.tCont.hidden = !has;
  E.tNew.innerHTML = '<span class="mt">新的旅程</span>';
  E.tNew.classList.remove('warn');
  S.confirmNew = -99;
  let info = '';
  if (has) {
    try {
      const g = loadGame();
      if (g) info = '第 ' + g.day + ' 天 · 距灯塔 ' + fmtDist(g) + ' 海里';
    } catch (e) { info = ''; }
  }
  E.tCont.querySelector('small').textContent = info;
  E.title.classList.remove('showkeys');
}

function enterPause(G) {
  setText(E.pinfo, '第 ' + G.day + ' 天 · 距灯塔 ' + fmtDist(G) + ' 海里 · 图鉴 ' + codexFound(G) + ' / ' + CODEX_IDS.length);
  setText(E.saveBtn.querySelector('.mt'), '保存');
  refreshMute();
}

// =====================================================================================
// HUD
// =====================================================================================

function setRing(k, v, dt, show) {
  const r = S.rings[k];
  if (!r) return;
  v = clamp(Number.isFinite(v) ? v : 0, 0, 100);
  if (show !== undefined) toggle(r.el, 'show', show);
  if (r.v >= 0 && v > r.v + 2.5) r.upT = 0.8;
  if (r.upT > 0) r.upT -= dt;
  toggle(r.el, 'up', r.upT > 0);
  if (Math.abs(v - r.v) >= 0.35 || r.v < 0) {
    r.v = v;
    r.arc.setAttribute('stroke-dasharray', Math.max(0.01, v).toFixed(1) + ' 100');
    setText(r.num, String(Math.round(v)));
    r.el.title = RING_INFO[k][0] + ' ' + Math.round(v);
  }
  const low = v < 25;
  if (low !== r.low) { r.low = low; toggle(r.el, 'low', low); }
}

function bestFood(G) {
  for (const id of ['cooked_fish', 'can', 'coconut', 'berry', 'raw_fish']) if (count(G, id) > 0) return id;
  return null;
}

const TOOL_HINT = {
  hook: '按住蓄力，松开抛出钩索；钩住了再按住，拉回来',
  spear: '点一下刺出去。水下也能用，鲨鱼挨三下就会跑',
  hammer: '建造：Q / 滚轮 换部件，左键放下；也能修补木筏',
  hand: '空着手。有提灯的话，夜里它会自己亮起来',
};
const TOOL_HINT_TOUCH = {
  hook: '按住「使用」蓄力，松开抛出钩索；再按住拉回来',
  spear: '点「使用」刺出去。水下也能用',
  hammer: '建造：「切换」换部件，「使用」放下',
  hand: '空着手。有提灯的话，夜里它会自己亮起来',
};

function updateHud(G, dt) {
  const P = G.player || {};
  const dim = (G.light || 1) < 0.3;
  if (dim !== S.dim) { S.dim = dim; toggle(E.hud, 'night', dim); }
  setRing('hp', P.hp, dt);
  setRing('hunger', P.hunger, dt);
  setRing('thirst', P.thirst, dt);
  const o2 = Number.isFinite(P.oxygen) ? P.oxygen : 100;
  setRing('o2', o2, dt, !!P.underwater || o2 < 99.5);

  // sun / moon dial
  const a = ((G.phase || 0) - 0.25) * 360;
  if (S.dialA == null || Math.abs(a - S.dialA) > 0.25) {
    S.dialA = a;
    E.dialRot.setAttribute('transform', 'rotate(' + a.toFixed(2) + ' 32 34)');
  }
  if (S.day !== G.day) { S.day = G.day; setText(E.dayN, String(G.day)); }
  const dist = fmtDist(G);
  if (dist !== S.dist) { S.dist = dist; setText(E.distN, dist); }
  const prog = clamp(((G.raft && G.raft.x) || 0) / C.GOAL_X, 0, 1);
  if (S.trackP == null || Math.abs(prog - S.trackP) > 0.002) {
    S.trackP = prog;
    const pc = (prog * 88).toFixed(2) + '%';
    E.trackR.style.left = pc; E.trackF.style.width = pc;
  }

  // hotbar
  const tool = P.tool;
  const lantern = count(G, 'lantern') > 0;
  const lit = !!P.lantern;
  const key = tool + '|' + count(G, 'hook') + count(G, 'spear') + count(G, 'hammer') + '|' + lantern + lit + '|' + (G.mode === 'play');
  if (key !== S.slotKey) {
    S.slotKey = key;
    for (const s of E.slots) {
      const own = s.id === 'hand' || count(G, s.id) > 0;
      toggle(s.el, 'sel', tool === s.id);
      toggle(s.el, 'locked', !own);
      s.el.title = s.name + (own ? '' : '（还没有）');
      if (s.id === 'hand') { toggle(s.el, 'lant', lantern); toggle(s.el, 'lit', lit); }
    }
    toggle(U, 'hammer', tool === 'hammer');
  }
  if (tool !== S.tool) {
    if (S.tool != null && tool) {
      const name = (E.slots.find((s) => s.id === tool) || {}).name || '';
      E.thint.innerHTML = '<b>' + esc(name) + '</b>' + esc((S.touch ? TOOL_HINT_TOUCH : TOOL_HINT)[tool] || '');
      S.toolHintT = 3.8;
    }
    S.tool = tool;
  }
  if (S.toolHintT > 0) S.toolHintT -= dt;
  toggle(E.thint, 'on', S.toolHintT > 0 && G.mode === 'play');

  // eat / drink chips
  const food = bestFood(G);
  let nFood = 0;
  for (const id of ['cooked_fish', 'can', 'coconut', 'berry', 'raw_fish']) nFood += count(G, id);
  const drink = count(G, 'water') > 0 ? 'water' : count(G, 'coconut') > 0 ? 'coconut' : null;
  const nDrink = count(G, 'water') + count(G, 'coconut');
  const ck = food + nFood + '|' + drink + nDrink;
  if (ck !== S.chipKey) {
    S.chipKey = ck;
    const ei = E.eat.querySelector('img'), di = E.drink.querySelector('img');
    const fsrc = iconURL(food || 'raw_fish'), dsrc = iconURL(drink || 'water');
    if (ei.getAttribute('src') !== fsrc) ei.src = fsrc;
    if (di.getAttribute('src') !== dsrc) di.src = dsrc;
    setText(E.eat.querySelector('.cn'), '×' + nFood);
    setText(E.drink.querySelector('.cn'), '×' + nDrink);
    toggle(E.eat, 'none', !nFood); toggle(E.drink, 'none', !nDrink);
    E.eat.title = food ? '吃' + itemName(food) + '（F）' : '没有吃的了';
    E.drink.title = drink ? '喝' + itemName(drink) + '（R）' : '没有淡水了';
  }
}

function updateHurt(G, dt) {
  const P = G.player || {};
  const playing = G.mode === 'play' || G.mode === 'panel' || G.mode === 'pause';
  if (!playing || G.demo) {
    S.hurt = Math.max(0, S.hurt - dt * 2);
    S.lastHp = null;
  } else {
    const hp = Number.isFinite(P.hp) ? P.hp : 100;
    if (S.lastHp != null && hp < S.lastHp - 0.6) S.hurt = Math.min(1, S.hurt + 0.45 + (S.lastHp - hp) / 25);
    S.lastHp = hp;
    S.hurt = Math.max(0, S.hurt - dt * 1.4);
  }
  let a = S.hurt;
  if (playing && !G.demo && Number.isFinite(P.hp) && P.hp < 25 && P.hp > 0) {
    const beat = Math.pow(Math.max(0, Math.sin(S.t * 5.2)), 6);
    a = Math.max(a, 0.22 + 0.22 * beat + (25 - P.hp) / 60);
  }
  if (G.mode === 'dead') a = 0;
  a = clamp(a, 0, 1);
  if (Math.abs(a - S.hurtShown) > 0.01) { S.hurtShown = a; E.hurt.style.opacity = a.toFixed(3); }
}

// =====================================================================================
// toasts
// =====================================================================================

const TOAST_DUR = { info: 3.2, warn: 3.8, pickup: 2.4, story: 6.5, discover: 4.8 };
const LIVE = new Set();

function toastHTML(t) {
  if (t.kind === 'discover') {
    const name = String(t.text).replace(/^图鉴\s*·\s*/, '');
    const id = CODEX_IDS.find((k) => CODEX[k].name === name);
    if (id) return '<img alt="" src="' + codexArt(id, true) + '"><div><small>图鉴 · 新发现</small><b>' + esc(name) + '</b></div>';
  }
  if (t.pick && typeof t.pick === 'object') {
    return Object.entries(t.pick).map(([id, n]) => '<span class="pk"><img alt="" src="' + iconURL(id) + '"><b>+' + n + '</b>' + esc(itemName(id)) + '</span>').join('');
  }
  return esc(t.text);
}

function updateToasts(G, dt) {
  const T = Array.isArray(G.toasts) ? G.toasts : null;
  const live = LIVE;
  live.clear();
  const tick = G.mode === 'play' || G.mode === 'panel';
  if (T) {
    for (let i = 0; i < T.length; i++) {
      const t = T[i];
      if (!t || typeof t !== 'object') continue;
      live.add(t);
      let rec = S.toasts.get(t);
      const kind = TOAST_DUR[t.kind] ? t.kind : 'info';
      if (!rec) {
        const el = h('div', 'toast k-' + (t.pick ? 'pickup' : kind), toastHTML(t));
        E.toasts.appendChild(el);
        rec = { el, text: t.text, dead: false };
        S.toasts.set(t, rec);
        requestAnimationFrame(() => el.classList.add('on'));
      } else if (rec.text !== t.text) {
        rec.text = t.text;
        rec.el.innerHTML = toastHTML(t);
      }
      if (tick) t.t = (Number.isFinite(t.t) ? t.t : 0) + dt;
    }
    // expire
    let w = 0;
    for (let i = 0; i < T.length; i++) {
      const t = T[i];
      const kind = t && TOAST_DUR[t.kind] ? t.kind : 'info';
      if (t && t.t >= (t.pick ? TOAST_DUR.pickup : TOAST_DUR[kind]) + Math.min(2.5, String(t.text).length * 0.03)) { live.delete(t); continue; }
      T[w++] = t;
    }
    T.length = w;
  }
  for (const [t, rec] of S.toasts) {
    if (live.has(t)) continue;
    S.toasts.delete(t);
    rec.el.classList.add('out');
    rec.el.classList.remove('on');
    setTimeout(() => rec.el.remove(), 420);
  }
}

// =====================================================================================
// interaction prompt
// =====================================================================================

function updatePrompt(G) {
  const p = G.mode === 'play' && !G.demo ? G.prompt : null;
  const ok = !!(p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.label);
  if (ok) {
    if (p.label !== S.promptLabel) { S.promptLabel = p.label; setText(E.promptL, p.label); }
    const s = worldToScreen(G, p.x, p.y);
    const v = G.view || {};
    const x = clamp(s.x, 60, (v.cssW || 800) - 60), y = clamp(s.y - 18, 70, (v.cssH || 600) - 40);
    E.prompt.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px) translate(-50%,-100%)';
  }
  if (ok !== S.promptOn) { S.promptOn = ok; toggle(E.prompt, 'on', ok); }
  const tl = ok ? p.label : '互动';
  if (tl !== S.promptTouch) {
    S.promptTouch = tl;
    setText(E.tAct, tl.length > 8 ? tl.slice(0, 7) + '…' : tl);
    toggle(E.tAct, 'live', ok);
    toggle(E.tAct, 'long', tl.length > 4);
  }
}

// =====================================================================================
// bag & crafting panel
// =====================================================================================

function bagSignature(G) {
  let s = '';
  for (const id of ITEM_ORDER) s += count(G, id) + ',';
  const tiles = (G.raft && G.raft.tiles) || [];
  for (const t of tiles) s += (t && t.s ? t.s.type[0] : '-');
  return s + '|' + (S.madeId || '');
}

function updatePanel(G) {
  if (S.panel === 'craft') {
    const sig = bagSignature(G);
    if (sig !== S.bagSig) { S.bagSig = sig; renderBag(G); renderRecipes(G); renderDetail(G); }
    if (S.madeId && S.t - S.madeT > 1) { S.madeId = null; }
  } else {
    const sig = S.jTab + '|' + (G.journal ? G.journal.length : 0) + '|' + codexFound(G);
    if (sig !== S.jSig) { S.jSig = sig; renderJournal(G); }
  }
}

function renderBag(G) {
  const groups = {};
  for (const id of ITEM_ORDER) {
    const n = count(G, id);
    if (n <= 0) continue;
    const cat = ITEMS[id].cat;
    (groups[cat] || (groups[cat] = [])).push([id, n]);
  }
  let html = '';
  for (const cat of ['food', 'material', 'tool', 'placeable', 'story']) {
    const list = groups[cat];
    if (!list) continue;
    html += '<h3>' + CATEGORY_NAMES[cat] + (cat === 'food' ? '<em>点击使用</em>' : cat === 'placeable' ? '<em>用锤子装到木筏上</em>' : '') + '</h3><div class="grid">';
    for (const [id, n] of list) {
      const use = ITEMS[id].use ? ' use' : '';
      const cur = S.detail === id ? ' cur' : '';
      const pop = S.usedId === id && S.t - S.usedT < 0.5 ? ' pop' : '';
      html += '<button class="cell' + use + cur + pop + '" data-id="' + id + '" title="' + esc(ITEMS[id].name) + '"><img alt="" src="' + iconURL(id) + '"><b class="n">' + n + '</b></button>';
    }
    html += '</div>';
  }
  if (!html) html = '<p class="empty">什么都没有。去海上捞点东西吧。</p>';
  const top = E.bagList.scrollTop;
  E.bagList.innerHTML = html;
  E.bagList.scrollTop = top;
  E.cFoot.innerHTML = S.touch ? '点空白处关闭 · 点食物吃掉 · 做好的东西用锤子装到木筏上' : '<kbd>Tab</kbd> 关闭　<kbd>J</kbd> 日记　点击食物吃掉　做好的设施拿锤子（3）装到木筏上';
}

function effText(u) {
  const p = [];
  if (u.hunger) p.push('饱食 +' + u.hunger);
  if (u.thirst) p.push('水分 +' + u.thirst);
  if (u.hp) p.push('生命 +' + u.hp);
  return p.join('　');
}

function renderDetail(G) {
  if (!G) return;
  const id = S.detail;
  for (const c of E.bagList.querySelectorAll('.cell')) toggle(c, 'cur', c.dataset.id === id);
  const it = id && ITEMS[id];
  if (!it) { E.detail.innerHTML = '<p>' + (S.touch ? '点一下东西，看看它是什么。' : '把指针移到东西上看看。') + '</p>'; return; }
  const catName = (CATEGORY_NAMES[it.cat] || '').replace(' · 药品', '');
  let extra = '';
  if (it.use) extra = '<span class="eff">' + effText(it.use) + '</span>　';
  if (id === 'raw_fish') extra = '<span class="eff">饱食 +12</span>　';
  E.detail.innerHTML = '<img alt="" src="' + iconURL(id) + '"><div><b>' + esc(it.name) + '<small>' + esc(catName) + (count(G, id) ? ' · 有 ' + count(G, id) : '') + '</small></b><p>' + extra + esc(it.desc || '') + '</p></div>';
}

function renderRecipes(G) {
  let html = '';
  for (const id of RECIPE_ORDER) {
    const r = RECIPES[id];
    const why = blockReason(G, id);
    const cls = !why ? 'ok' : why === '已经有了' ? 'own' : 'no';
    const made = S.madeId === id ? ' made' : '';
    let cost = '';
    for (const [k, n] of Object.entries(r.cost)) {
      const have = count(G, k);
      cost += '<span class="cc' + (have >= n ? '' : ' lack') + '"><img alt="" src="' + iconURL(k) + '">' + esc(itemName(k)) + ' <b>' + have + '/' + n + '</b></span>';
    }
    const kind = r.cat === 'placeable' ? '设施' : r.cat === 'food' ? '药品' : '工具';
    const btn = cls === 'ok' ? '<button class="rbtn" data-id="' + id + '">制作</button>'
      : '<button class="rbtn" disabled>' + (cls === 'own' ? '已经有了' : '材料不够') + '</button>';
    html += '<div class="rrow ' + cls + made + '" data-id="' + id + '"><div class="ri"><img alt="" src="' + iconURL(id) + '"></div>'
      + '<div class="rmid"><div class="rname">' + esc(r.name) + '<small>' + kind + (count(G, id) ? ' · 有 ' + count(G, id) : '') + '</small></div>'
      + '<div class="rdesc">' + esc(r.desc) + '</div><div class="cost">' + cost + '</div></div>' + btn + '</div>';
  }
  html += '<p class="rnote">扩建木筏不在这里：拿起锤子（3），在木筏两头放下新木板，每块要 木板×2、绳子×1。</p>';
  const top = E.rList.scrollTop;
  E.rList.innerHTML = html;
  E.rList.scrollTop = top;
}

function onCell(G, id, cell) {
  S.detail = id;
  const it = ITEMS[id];
  if (it && it.use) {
    const ok = useItem(G, id);
    if (ok) { S.usedId = id; S.usedT = S.t; }
    else sfx('ui');
  } else if (id === 'note') {
    S.jTab = 'diary';
    G.panel = 'journal';
    sfx('ui');
  } else sfx('ui');
  S.bagSig = '';
}

// =====================================================================================
// journal & codex
// =====================================================================================

function renderJournal(G) {
  for (const t of E.jTabs) toggle(t, 'on', t.dataset.tab === S.jTab);
  toggle(E.jDiary, 'on', S.jTab === 'diary');
  toggle(E.jCodex, 'on', S.jTab === 'codex');
  const found = codexFound(G);
  setText(E.jCount, ' ' + found + '/' + CODEX_IDS.length);
  if (S.jTab === 'diary') renderDiary(G); else renderCodex(G);
}

function diaryEntry(text) {
  const s = String(text);
  if (s.startsWith('漂流瓶里的信')) {
    const m = s.match(/^漂流瓶里的信（?([^）]*)）?：?「([\s\S]*)」\s*$/);
    const n = m ? m[1] : '';
    const body = m ? m[2] : s;
    return '<div class="letter"><small>漂流瓶里的信' + (n ? ' · ' + esc(n) : '') + '</small><p>' + esc(body) + '</p></div>';
  }
  if (s.startsWith('【旧日记')) {
    const m = s.match(/^【([^】]*)】([\s\S]*)$/);
    return '<div class="oldpage"><small>' + esc(m ? m[1] : '旧日记') + '</small>' + esc(m ? m[2] : s) + '</div>';
  }
  const cm = s.match(/^第一次看见了「([^」]+)」/);
  if (cm) {
    const id = CODEX_IDS.find((k) => CODEX[k].name === cm[1]);
    if (id) return '<p class="de cdx"><img alt="" src="' + codexArt(id, true) + '"><span>' + esc(s) + '</span></p>';
  }
  return '<p class="de">' + esc(s) + '</p>';
}

function renderDiary(G) {
  const J = Array.isArray(G.journal) ? G.journal : [];
  if (!J.length) { E.jDiary.innerHTML = '<p class="jempty">还什么都没写。</p>'; return; }
  let html = '', curDay = null;
  for (let i = J.length - 1; i >= 0; i--) {
    const e = J[i] || {};
    const day = e.day || 1;
    if (day !== curDay) {
      if (curDay !== null) html += '</div>';
      curDay = day;
      html += '<div class="dgroup"><div class="dday">第 ' + day + ' 天</div>';
    }
    html += diaryEntry(e.text);
  }
  html += '</div>';
  E.jDiary.innerHTML = html;
  E.jDiary.scrollTop = 0;
}

function renderCodex(G) {
  const found = codexFound(G);
  let html = '<p class="ccount">已经遇见 <b>' + found + '</b> / ' + CODEX_IDS.length + '　海里还有很多没见过的东西。</p>';
  for (const kind of ['day', 'night', 'deep', 'island']) {
    const ids = CODEX_IDS.filter((id) => CODEX[id].kind === kind);
    if (!ids.length) continue;
    html += '<div class="cgroup"><h4>' + KIND_NAME[kind] + '</h4><div class="cgrid">';
    for (const id of ids) {
      const day = G.codex && G.codex[id];
      if (day) {
        html += '<div class="card"><img alt="" src="' + codexArt(id, true) + '"><div><b>' + esc(CODEX[id].name) + '</b><p>' + esc(CODEX[id].desc) + '</p><small>第 ' + day + ' 天遇见</small></div></div>';
      } else {
        html += '<div class="card unk"><img alt="" src="' + codexArt(id, false) + '"><div><b>？？？</b><p>' + KIND_HINT[kind] + '</p></div></div>';
      }
    }
    html += '</div></div>';
  }
  E.jCodex.innerHTML = html;
}

// =====================================================================================
// death
// =====================================================================================

function enterDead(G) {
  const cause = G.deathCause || '';
  setText(E.dTitle, cause === 'beast' ? '黑暗吞没了你……' : '你沉入了海里……');
  const last = Array.isArray(G.journal) && G.journal.length ? G.journal[G.journal.length - 1] : null;
  setText(E.dLine, last && last.text ? last.text : '少年的旅程，在这片海上结束了。');
  setText(E.dStat, '在海上漂了 ' + G.day + ' 天 · 离灯塔还有 ' + fmtDist(G) + ' 海里 · 图鉴 ' + codexFound(G) + ' / ' + CODEX_IDS.length);
  let has = false;
  try { has = !!API.hasSave(); } catch (e) { has = false; }
  E.dLoad.hidden = !has;
  toggle(E.dead, 'go', false);
  toggle(E.dead, 'ready', false);
  void E.dead.offsetWidth;
  toggle(E.dead, 'go', true);
  S.deadAt = S.t;
  S.intro = null; S.cont = null;
  sfx('heartbeat');
}

// =====================================================================================
// ending
// =====================================================================================

function endingLines(G) {
  const notes = lettersFound(G);
  const L = [
    '推开那扇沉重的木门，石阶一圈一圈地往上盘。',
    '越往上走，光就越暖。',
    '塔顶的灯还亮着。灯旁边，站着一个扎着辫子的女孩。',
    '“你终于来了。”她说，“我叫小满。”',
  ];
  if (notes > 0) L.push('这个名字你认得。漂流瓶里的每一封信，最后都签着它。');
  else L.push('“我往海里扔了好多好多封信。总觉得，会有人顺着它们找过来。”');
  L.push('“我每天晚上都把灯擦得亮亮的。”');
  L.push('“因为我知道，海上一定还有人，在黑暗里找光。”');
  L.push('那天夜里，你们并肩坐在灯下，看光一圈一圈地扫过海面——');
  L.push('扫过鲸的脊背，扫过发光的水母，扫过很远很远的，另一只小小的木筏。');
  return L;
}

function enterEnding(G) {
  S.end = { t: 0, i: -1, lineT: 0, lines: endingLines(G), cred: false, fadeT: 0 };
  setText(E.es1, '第 ' + G.day + ' 天，少年抵达了灯塔。');
  setText(E.es2, '图鉴 ' + codexFound(G) + ' / ' + CODEX_IDS.length + ' · 找到的信 ' + lettersFound(G) + ' / 8');
  toggle(E.eCred, 'on', false);
  toggle(E.eLine, 'on', false);
  E.eSkip.hidden = false;
  S.intro = null; S.cont = null;
  sfx('discover');
}

function lineDur(text) { return 3.2 + String(text).length * 0.085; }

function updateEnding(G, dt) {
  const st = S.end;
  if (!st) return;
  st.t += dt;
  if (st.cred) return;
  if (st.t < 3.2) return;                 // the screen fades to night first
  if (st.i < 0) { showEndingLine(0); return; }
  st.lineT += dt;
  const cur = st.lines[st.i];
  if (st.fading) {
    if (st.lineT >= 1.5) showEndingLine(st.i + 1);
  } else if (st.lineT >= lineDur(cur)) {
    st.fading = true; st.lineT = 0;
    toggle(E.eLine, 'on', false);
  }
}

function showEndingLine(i) {
  const st = S.end;
  if (!st) return;
  if (i >= st.lines.length) {
    st.cred = true;
    toggle(E.eLine, 'on', false);
    toggle(E.eCred, 'on', true);
    E.eSkip.hidden = true;
    S.menuSel = 0;
    setTimeout(markSel, 50);
    return;
  }
  st.i = i; st.lineT = 0; st.fading = false;
  setText(E.eLine, st.lines[i]);
  toggle(E.eLine, 'on', true);
}

function advanceEnding() {
  const st = S.end;
  if (!st || st.cred) return;
  if (st.t < 3.2) { st.t = 3.2; return; }
  showEndingLine(st.i + 1);
}

// =====================================================================================
// intro, continue, new day
// =====================================================================================

const INTRO = [
  [0.6, '暴风雨过去了。'],
  [3.4, '醒来的时候，只剩下这只小木筏，和一片望不到边的海。'],
  [6.6, '往东漂吧。听说海的尽头，有一座亮着灯的塔。'],
];

function startIntro(G, quiet) {
  const F = flags(G);
  if (!F.ui_intro) {
    F.ui_intro = 1;
    journal(G, '暴风雨过后，我在一只小木筏上醒来。船不见了，大人们也不见了。四周只有海。');
  }
  if (quiet) return;
  S.intro = { t: 0, shown: 0 };
  E.cineLines.innerHTML = INTRO.map(([, t]) => '<p>' + esc(t) + '</p>').join('');
  toggle(E.cine, 'on', true);
  toggle(E.hud, 'cine', true);
  E.wake.style.opacity = '1';
}

function startContinue(G) {
  S.cont = { t: 0 };
  E.cineLines.innerHTML = '<p>第 ' + G.day + ' 天</p><p class="sm">旅程继续 · 距灯塔 ' + esc(fmtDist(G)) + ' 海里</p>';
  toggle(E.cine, 'on', true);
  E.wake.style.opacity = '1';
  requestAnimationFrame(() => E.cineLines.querySelectorAll('p').forEach((p) => p.classList.add('on')));
}

function updateCine(G, dt) {
  const ps = () => E.cineLines.querySelectorAll('p');
  if (S.intro) {
    const I = S.intro;
    I.t += dt;
    E.wake.style.opacity = String(clamp(1 - (I.t - 1.5) / 3.5, 0, 1).toFixed(3));
    const list = ps();
    for (let k = 0; k < INTRO.length; k++) if (I.t >= INTRO[k][0] && list[k] && !list[k].classList.contains('on')) list[k].classList.add('on');
    if (I.t > 11.5 && !I.out) { I.out = true; toggle(E.cine, 'on', false); toggle(E.hud, 'cine', false); }
    if (I.t > 13) { S.intro = null; E.cineLines.innerHTML = ''; E.wake.style.opacity = '0'; }
    if (G.mode !== 'play' && G.mode !== 'panel' && G.mode !== 'pause') { S.intro = null; toggle(E.cine, 'on', false); toggle(E.hud, 'cine', false); E.wake.style.opacity = '0'; }
  } else if (S.cont) {
    const K = S.cont;
    K.t += dt;
    E.wake.style.opacity = String(clamp(1 - K.t / 1.6, 0, 1).toFixed(3));
    if (K.t > 3.4 && !K.out) { K.out = true; toggle(E.cine, 'on', false); }
    if (K.t > 5) { S.cont = null; E.cineLines.innerHTML = ''; E.wake.style.opacity = '0'; }
  }

  // a title card when a new day begins
  if (G.mode === 'play' && !G.demo) {
    if (S.lastDay != null && G.day > S.lastDay && !S.intro && !S.cont) {
      S.dayCard = { t: 0 };
      E.dayCard.querySelector('b').textContent = '第 ' + G.day + ' 天';
      E.dayCard.querySelector('span').textContent = '距灯塔 ' + fmtDist(G) + ' 海里';
      toggle(E.dayCard, 'on', true);
    }
    S.lastDay = G.day;
  }
  if (S.dayCard) {
    S.dayCard.t += dt;
    if (S.dayCard.t > 3.6) { toggle(E.dayCard, 'on', false); if (S.dayCard.t > 5.2) S.dayCard = null; }
    if (G.mode === 'dead' || G.mode === 'title') { toggle(E.dayCard, 'on', false); S.dayCard = null; }
  }
}

// =====================================================================================
// story beats
// =====================================================================================

function story(G) {
  if (G.demo) return;
  const F = flags(G);
  const night = isNight(G);

  if (!F.ui_night1 && G.phase >= C.NIGHT_START && night) {
    F.ui_night1 = 1;
    say(G, '天黑了。海变得很安静，安静得让人害怕。', 'story');
    journal(G, '第一个夜晚。海变得很安静，安静得让人害怕。我抱着膝盖坐在木筏中间，不敢看木筏边上的黑水。');
  }

  if (!F.ui_lighthouse && night && G.raft && G.raft.x > 15000) {
    if (F.sky_lighthouse) F.ui_lighthouse = 1;          // the sky already showed and told it
    else if (G.phase > C.NIGHT_START + 0.035 && !(G.weather && G.weather.fog > 0.6)) {
      F.ui_lighthouse = 1; F.sky_lighthouse = 1;
      say(G, '远处……有一束光。是灯塔！', 'story');
      journal(G, '远处有一束光，一圈一圈地转。是灯塔！原来海真的有尽头。');
    }
  }

  // first-time tutorial nudges (new journeys only, after the intro)
  if (S.intro) return;
  const touch = S.touch;
  if (!F.ui_tut1 && S.playT > 3 && G.day === 1) {
    F.ui_tut1 = 1;
    say(G, touch ? '按住「使用」蓄力，松开把钩索抛向海上漂着的东西。' : '按住鼠标左键蓄力，松开把钩索抛向海上漂着的东西。');
  } else if (F.ui_tut1 && !F.ui_tut2 && S.playT > 16 && G.day === 1) {
    F.ui_tut2 = 1;
    say(G, touch ? '钩住以后再按住「使用」，把东西拉回来。' : '钩住以后再按住左键，把东西拉回来。');
  } else if (F.ui_tut2 && !F.ui_tut3 && S.playT > 45) {
    F.ui_tut3 = 1;
    say(G, touch ? '点「背包」看看捡到了什么，还能做工具。' : '按 Tab 打开背包，用捡来的东西做工具。');
  }
}
