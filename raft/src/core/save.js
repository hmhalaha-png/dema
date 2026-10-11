// localStorage save/load of the persistent part of G (see state.js newGame()).

import { newGame, syncTime } from './state.js';

const KEY = 'shaonian-yu-hai:save:v1';
const PERSISTENT = ['version', 'time', 'raft', 'inv', 'codex', 'journal', 'persist'];
const PLAYER_KEYS = ['x', 'y', 'facing', 'hp', 'hunger', 'thirst', 'oxygen', 'tool'];

export function hasSave() {
  try { return !!localStorage.getItem(KEY); } catch (e) { return false; }
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
