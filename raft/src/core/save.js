// localStorage save/load of the persistent part of G (see state.js newGame()).

import { C, newGame, syncTime } from './state.js';

const KEY = 'shaonian-yu-hai:save:v1';
const PERSISTENT = ['version', 'time', 'raft', 'inv', 'codex', 'journal', 'persist'];
const PLAYER_KEYS = ['x', 'y', 'facing', 'hp', 'hunger', 'thirst', 'oxygen', 'tool'];

export function hasSave() {
  try { return !!localStorage.getItem(KEY); } catch (e) { return false; }
}

// A save must never capture a moment the player cannot survive after reloading.
export function isSafeToSave(G) {
  const P = G.player;
  if (!P || G.demo || G.mode !== 'play' && G.mode !== 'pause' && G.mode !== 'panel') return false;
  if (P.dead || P.hp <= 25 || P.underwater || P.inWater) return false;
  if (G.fade > 0.01 || (G.raft && G.raft.busy)) return false;
  if (P.onIsland && G.phase >= C.NIGHT_START - 0.04 && G.phase < C.NIGHT_END) return false;   // the beast is out
  if (G.beasts && G.beasts.some((b) => b && b.st !== 'hide' && b.st !== 'flee' && Math.abs(b.x - P.x) < 500)) return false;
  return true;
}

export function saveGame(G) {
  if (G.demo || G.mode === 'dead') return false;
  try {
    const data = {};
    for (const k of PERSISTENT) data[k] = G[k];
    data.player = {};
    for (const k of PLAYER_KEYS) data.player[k] = G.player[k];
    localStorage.setItem(KEY, JSON.stringify(data));
    return true;
  } catch (e) { return false; }
}

export function loadGame() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    const G = newGame();
    for (const k of PERSISTENT) if (data[k] !== undefined) G[k] = data[k];
    Object.assign(G.player, data.player || {});
    G.player.vx = 0; G.player.vy = 0;
    // Be forgiving with older or unlucky saves: never load straight into a death.
    const P = G.player;
    P.hp = Math.max(P.hp || 0, 30); P.hunger = Math.max(P.hunger || 0, 15); P.thirst = Math.max(P.thirst || 0, 15); P.oxygen = 100;
    if (!(P.y < 2)) { P.x = G.raft.x + G.raft.tiles.length * C.TILE_W / 2; P.y = -C.DECK_H; }
    G.persist = Object.assign({ islands: {}, flags: {} }, G.persist || {});
    G.inv = Object.assign(newGame().inv, G.inv || {});
    syncTime(G);
    G.loaded = true;
    return G;
  } catch (e) { return null; }
}

export function deleteSave() {
  try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
}
