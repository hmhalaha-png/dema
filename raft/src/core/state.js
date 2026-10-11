// The single game-state object G and its constants. Every module receives G.
// Persistent fields (saved to localStorage) are created here in newGame();
// modules add their own RUNTIME fields in init() and must not rename these.

import { CODEX } from '../data/codex.js';
import { clamp, smoothstep } from './util.js';

export const C = {
  VIEW_H: 540,          // world units visible vertically (at least)
  MIN_VIEW_W: 720,      // world units visible horizontally (at least)
  DAY_LEN: 420,         // seconds per full day/night cycle
  START_PHASE: 0.05,    // new game starts just after sunrise
  SUNSET: 0.56,         // phase where the sun touches the horizon
  NIGHT_START: 0.64,    // phase after which it counts as night
  NIGHT_END: 0.97,      // phase before which it is still night
  TILE_W: 24,           // raft tile width (world units)
  DECK_H: 6,            // raft deck height above water line
  GOAL_X: 20000,        // the lighthouse island sits here
  DRIFT: 9,             // raft drift speed (units/s) without sail
  SAIL_BOOST: 14,       // extra speed with the sail raised
  GRAVITY: 900,
  PLAYER_H: 28,         // the boy is small; the world is big
  MAX_STAT: 100,
};

// 0 = sunrise, 0.25 = noon, C.SUNSET = sunset, night until C.NIGHT_END.
export function daylight(phase) {
  if (phase < 0.06) return 0.18 + 0.82 * smoothstep(0, 0.06, phase);
  if (phase < 0.52) return 1;
  if (phase < 0.66) return 1 - 0.92 * smoothstep(0.52, 0.66, phase);
  if (phase < 0.94) return 0.08;
  return 0.08 + 0.1 * smoothstep(0.94, 1, phase);
}
export const isNight = (G) => G.phase >= C.NIGHT_START && G.phase < C.NIGHT_END;
export const isDusk = (G) => G.phase >= 0.5 && G.phase < C.NIGHT_START;

export function newGame() {
  const tiles = [];
  for (let i = 0; i < 4; i++) tiles.push({ hp: 100, s: null });
  tiles[0].s = { type: 'anchor', down: false };
  const G = {
    // ---- persistent ----
    version: 1,
    time: C.START_PHASE * C.DAY_LEN,   // seconds since the first sunrise
    player: {
      x: 2 * C.TILE_W, y: -C.DECK_H, vx: 0, vy: 0, facing: 1,
      hp: 100, hunger: 85, thirst: 80, oxygen: 100,
      tool: 'hook',
    },
    raft: { x: 0, tiles, anchored: false, sailUp: false },
    inv: { hook: 1, hammer: 1, wood: 4, plastic: 2, rope: 2, cloth: 0, metal: 0, leaf: 0, stone: 0,
      coconut: 1, raw_fish: 0, cooked_fish: 0, can: 0, water: 1, berry: 0 },
    codex: {},            // id -> day first seen
    journal: [],          // [{day, text}]
    persist: { islands: {}, flags: {} },  // module-owned saved data (plain JSON only)

    // ---- runtime (rebuilt every session) ----
    mode: 'title',        // 'title' | 'play' | 'pause' | 'panel' | 'dead' | 'ending'
    panel: null,          // 'craft' | 'journal' while mode === 'panel'
    demo: false,          // true for the title-screen backdrop instance
    phase: 0, day: 1, light: 1, dt: 0, frame: 0,
    cam: { x: 2 * C.TILE_W, y: -70, shakeX: 0, shakeY: 0 },
    shake: 0,             // add to this (0..1) for screen shake; core decays it
    fade: 0,              // 0..1 full-screen black (cutscene fades); post.drawPost paints it
    view: { cssW: 1, cssH: 1, dpr: 1, scale: 1, w: 1, h: 1, left: 0, top: 0, seaScreenY: 0 },
    lights: [],           // cleared each step: {x, y, r, color:[r,g,b], a}
    interactables: [],    // filled during a step: {x, y, r, label, act(G), priority}
    interactablesLast: [],// the complete list from the previous step (player picks from this)
    hits: [],             // cleared each step: {x, y, r, dmg, kind, from}
    particles: [],
    toasts: [],           // {text, kind, t}
    prompt: null,         // {x, y, label} chosen interactable (set by player)
    weather: { kind: 'clear', wave: 1, rain: 0, wind: 0.3, fog: 0, lightning: 0 },
    hook: null,           // owned by player.js
    debris: [], fish: [], creatures: [], beasts: [],
    islands: [],          // built by islands.js from persist + journey layout
  };
  syncTime(G);
  return G;
}

export function syncTime(G) {
  const d = G.time / C.DAY_LEN;
  G.day = Math.floor(d) + 1;
  G.phase = d - Math.floor(d);
  G.light = daylight(G.phase);
}

// Jump the clock forward to the next time the phase equals `phase`.
export function skipToPhase(G, phase) {
  const cur = G.phase;
  const add = (phase - cur + 1) % 1 || 1;
  G.time += add * C.DAY_LEN;
  syncTime(G);
}

export function say(G, text, kind = 'info') {
  if (G.demo) return;
  if (G.toasts.length && G.toasts[G.toasts.length - 1].text === text) return;
  G.toasts.push({ text, kind, t: 0 });
  if (G.toasts.length > 5) G.toasts.shift();
}

export function journal(G, text) {
  if (G.demo) return;
  G.journal.push({ day: G.day, text });
}

// First sighting of a codex creature. Returns true if it was new.
export function discover(G, id) {
  if (G.demo || !CODEX[id] || G.codex[id]) return false;
  G.codex[id] = G.day;
  say(G, '图鉴 · ' + CODEX[id].name, 'discover');
  journal(G, '第一次看见了「' + CODEX[id].name + '」。' + CODEX[id].desc);
  G.onDiscover && G.onDiscover(id);
  return true;
}

export const statClamp = (v) => clamp(v, 0, C.MAX_STAT);
