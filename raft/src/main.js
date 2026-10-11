// Core: boot, main loop, camera, draw order, error isolation, debug hooks.
// Gameplay and art live in the modules imported below (see CONTRACT.md).

import { C, newGame, syncTime } from './core/state.js';
import { input, initInput, endInputFrame } from './core/input.js';
import { updateParticles, drawParticles } from './core/particles.js';
import { waterY, screenToWorld } from './core/world.js';
import { saveGame, loadGame, hasSave, deleteSave } from './core/save.js';
import { loadAssets } from './core/assets.js';
import { clamp, rand } from './core/util.js';

import * as sky from './render/sky.js';
import * as sea from './render/sea.js';
import * as post from './render/post.js';
import * as player from './entities/player.js';
import * as debris from './entities/debris.js';
import * as life from './entities/life.js';
import * as raft from './systems/raft.js';
import * as islands from './systems/islands.js';
import * as inventory from './systems/inventory.js';
import * as craft from './systems/craft.js';
import * as audio from './systems/audio.js';
import * as hud from './ui/hud.js';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let G = null;

// ---------- error isolation: one broken module must not stop the others ----------
const errors = {};
window.__raftErrors = errors;
function run(tag, fn) {
  try { return fn(); } catch (e) {
    const rec = errors[tag] || (errors[tag] = { count: 0, msg: String(e && e.message), stack: String(e && e.stack).split('\n').slice(0, 4).join(' | ') });
    rec.count++;
    if (rec.count === 1) console.error('[' + tag + ']', e);
    return undefined;
  }
}

// ---------- game lifecycle ----------
const INIT_ORDER = [['sky', sky], ['sea', sea], ['post', post], ['inventory', inventory], ['craft', craft], ['raft', raft],
  ['islands', islands], ['debris', debris], ['life', life], ['player', player], ['audio', audio]];

function initModules(g) {
  for (const [name, m] of INIT_ORDER) if (m.init) run(name + '.init', () => m.init(g));
}

function makeDemo() {
  const g = newGame();
  g.demo = true;
  g.mode = 'title';
  g.time = 0.53 * C.DAY_LEN;
  g.raft.anchored = true;
  g.raft.tiles.push({ hp: 100, s: { type: 'lamp', on: true } }, { hp: 100, s: null });
  g.raft.tiles[2].s = { type: 'sail', up: true };
  syncTime(g);
  initModules(g);
  return g;
}

const api = {
  hasSave,
  startNew() {
    deleteSave();
    G = newGame();
    G.mode = 'play';
    initModules(G);
    run('hud.onStart', () => hud.onStart && hud.onStart(G, 'new'));
    snapCamera();
  },
  continueGame() {
    const g = loadGame();
    if (!g) return api.startNew();
    G = g;
    G.mode = 'play';
    initModules(G);
    run('hud.onStart', () => hud.onStart && hud.onStart(G, 'continue'));
    snapCamera();
  },
  save() { return G ? saveGame(G) : false; },
  toTitle() { if (G && !G.demo && G.mode !== 'dead') saveGame(G); G = makeDemo(); snapCamera(); },
  restart() { api.startNew(); },
  get G() { return G; },
};

// ---------- view / camera ----------
function resize() {
  const cssW = Math.max(1, window.innerWidth), cssH = Math.max(1, window.innerHeight);
  let dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  if (cssW * cssH * dpr * dpr > 2.6e6) dpr = Math.sqrt(2.6e6 / (cssW * cssH));
  canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
  const v = G.view;
  v.cssW = cssW; v.cssH = cssH; v.dpr = dpr;
  v.scale = Math.min(cssH / C.VIEW_H, cssW / C.MIN_VIEW_W);
  v.w = cssW / v.scale; v.h = cssH / v.scale;
  run('post.resize', () => post.resize && post.resize(G));
}
function syncView() {
  const v = G.view, wv = window.innerWidth, hv = window.innerHeight;
  if (v.cssW !== wv || v.cssH !== hv || canvas.width === 0) resize();
  v.left = G.cam.x - v.w / 2; v.top = G.cam.y - v.h / 2;
  v.seaScreenY = (0 - G.cam.y) * v.scale + v.cssH / 2;
}

function camTarget() {
  const P = G.player;
  if (G.mode === 'title') return { x: G.raft.x + G.raft.tiles.length * C.TILE_W * 0.5 - 30, y: -95 };
  const above = P.y < 30;
  return { x: P.x + P.facing * 34, y: above ? P.y - 72 : P.y - 10 };
}
function snapCamera() {
  syncView();
  const t = camTarget();
  G.cam.x = t.x; G.cam.y = t.y;
}
function updateCamera(dt) {
  const t = camTarget();
  const k = Math.min(1, dt * 3.2);
  G.cam.x += (t.x - G.cam.x) * k;
  G.cam.y += (t.y - G.cam.y) * Math.min(1, dt * 2.6);
  G.shake = Math.max(0, G.shake - dt * 2.5);
  const s = Math.min(1, G.shake) * 7;
  G.cam.shakeX = s ? rand(-s, s) : 0; G.cam.shakeY = s ? rand(-s, s) : 0;
}

// ---------- one simulation step ----------
function step(dt, demo) {
  G.dt = dt; G.time += dt; G.frame++;
  const prevDay = G.day;
  syncTime(G);
  G.lights.length = 0;
  G.interactablesLast = G.interactables; G.interactables = [];
  run('sky.update', () => sky.update(G, dt));
  run('sea.update', () => sea.update(G, dt));
  run('raft.update', () => raft.update(G, dt));
  if (!demo) run('player.update', () => player.update(G, dt));
  run('debris.update', () => debris.update(G, dt));
  run('life.update', () => life.update(G, dt));
  run('islands.update', () => islands.update(G, dt));
  run('craft.update', () => craft.update && craft.update(G, dt));
  run('particles', () => updateParticles(G, dt, waterY));
  G.hits.length = 0;
  if (!demo && G.day !== prevDay) saveGame(G);
}

// ---------- draw order (see CONTRACT.md §4) ----------
function render() {
  const v = G.view, d = v.dpr;
  const screenT = () => ctx.setTransform(d, 0, 0, d, 0, 0);
  const worldT = () => ctx.setTransform(v.scale * d, 0, 0, v.scale * d,
    (v.cssW / 2 - (G.cam.x + G.cam.shakeX) * v.scale) * d, (v.cssH / 2 - (G.cam.y + G.cam.shakeY) * v.scale) * d);
  const layer = (tag, fn, world) => { ctx.save(); world ? worldT() : screenT(); run(tag, fn); ctx.restore(); };

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#05070c'; ctx.fillRect(0, 0, canvas.width, canvas.height);

  layer('sky.drawSky', () => sky.drawSky(ctx, G), false);
  layer('life.drawHorizon', () => life.drawHorizon(ctx, G), false);
  layer('sea.drawBackdrop', () => sea.drawBackdrop(ctx, G), false);
  layer('sea.drawSeabed', () => sea.drawSeabed(ctx, G), true);
  layer('life.drawDeep', () => life.drawDeep(ctx, G), true);
  layer('islands.drawBack', () => islands.drawBack(ctx, G), true);
  layer('debris.draw', () => debris.draw(ctx, G), true);
  layer('raft.draw', () => raft.draw(ctx, G), true);
  layer('life.draw', () => life.draw(ctx, G), true);
  layer('player.draw', () => player.draw(ctx, G), true);
  layer('islands.drawFront', () => islands.drawFront(ctx, G), true);
  layer('particles.draw', () => drawParticles(ctx, G), true);
  layer('sea.drawSurface', () => sea.drawSurface(ctx, G), true);
  layer('raft.drawBuildGhost', () => raft.drawBuildGhost(ctx, G), true);
  layer('post.drawLighting', () => post.drawLighting(ctx, G), false);
  layer('sky.drawWeather', () => sky.drawWeather(ctx, G), false);
  layer('post.drawPost', () => post.drawPost(ctx, G), false);
}

// ---------- main loop ----------
let last = 0;
function frame(now) {
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;
  syncView();
  const m = input.mouse, w = screenToWorld(G, m.sx, m.sy);
  m.wx = w.x; m.wy = w.y;
  run('hud.frame', () => hud.frame(G, dt));
  if (G.mode === 'play') step(dt, false);
  else if (G.mode === 'title') step(dt, true);
  run('audio.update', () => audio.update(G, dt));
  updateCamera(dt);
  syncView();
  render();
  endInputFrame();
  requestAnimationFrame(frame);
}

// ---------- boot ----------
function boot() {
  G = makeDemo();
  initInput(canvas);
  resize();
  snapCamera();
  loadAssets();
  run('hud.initUI', () => hud.initUI(api));
  window.addEventListener('resize', () => resize());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && G && G.mode === 'play') { saveGame(G); G.mode = 'pause'; }
  });
  requestAnimationFrame((t) => { last = t; frame(t); });
}

// ---------- debug / test hooks (used by tools/smoke.mjs) ----------
window.__raft = {
  get G() { return G; },
  api,
  errors,
  start() { api.startNew(); },
  setPhase(p) { G.time = (G.day - 1 + p) * C.DAY_LEN; syncTime(G); },
  tp(x, y) { const P = G.player; P.x = x; P.y = y; P.vx = 0; P.vy = 0; snapCamera(); },
  give(id, n = 1) { G.inv[id] = (G.inv[id] || 0) + n; },
  sim(seconds, dt = 1 / 30) { for (let t = 0; t < seconds; t += dt) step(dt, false); snapCamera(); },
  spawn(kind) { return run('debugSpawn', () => (life.debugSpawn && life.debugSpawn(G, kind)) || (islands.debugSpawn && islands.debugSpawn(G, kind))); },
  island(i = 0) { return run('islands.debugTeleport', () => islands.debugTeleport && islands.debugTeleport(G, i)); },
  weather(kind) { return run('sky.debugWeather', () => sky.debugWeather && sky.debugWeather(G, kind)); },
  mode(m, panel = null) { G.mode = m; G.panel = panel; },
  snap: snapCamera,
};

boot();
