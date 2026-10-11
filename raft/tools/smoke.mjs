// Headless smoke test: builds the game to a temp file, plays through scripted
// scenarios, saves screenshots and reports runtime errors per module.
//
//   node tools/smoke.mjs                         all scenarios -> /tmp/raft-smoke/
//   node tools/smoke.mjs --out DIR               screenshot directory
//   node tools/smoke.mjs --only night,deep       run only some scenarios (title always runs first)
//   node tools/smoke.mjs --size 844x390 --touch  phone-landscape viewport with touch
//   node tools/smoke.mjs --list                  print scenario names
//
// Exit code 1 if any module threw or the page logged an error.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : def; };
const flag = (name) => process.argv.includes('--' + name);

const SCENARIOS = {
  'raft-day':   async (p) => { await p.ev(() => { __raft.setPhase(0.2); }); await p.wait(2000); await p.shot(); },
  'hook':       async (p) => {
    await p.ev(() => { __raft.setPhase(0.25); __raft.G.player.tool = 'hook'; });
    const s = await p.ev(() => { const G = __raft.G, v = G.view; return { x: v.cssW * 0.78, y: v.seaScreenY + 6 }; });
    await p.page.mouse.move(s.x, s.y); await p.page.mouse.down(); await p.wait(700); await p.page.mouse.up();
    await p.wait(500); await p.shot('hook-flying');
    await p.page.mouse.down(); await p.wait(1600); await p.page.mouse.up(); await p.shot('hook-reel');
  },
  'dusk':       async (p) => { await p.ev(() => { __raft.setPhase(0.57); }); await p.wait(2000); await p.shot(); },
  'night':      async (p) => { await p.ev(() => { __raft.give('lantern', 1); __raft.setPhase(0.78); }); await p.wait(2000); await p.shot(); },
  'storm':      async (p) => { await p.ev(() => { __raft.setPhase(0.35); __raft.weather('storm'); }); await p.wait(2500); await p.shot(); await p.ev(() => __raft.weather('clear')); },
  'underwater': async (p) => { await p.ev(() => { __raft.setPhase(0.25); const G = __raft.G; __raft.tp(G.raft.x + 70, 140); }); await p.wait(2000); await p.shot(); },
  'deep':       async (p) => { await p.ev(() => { __raft.setPhase(0.25); const G = __raft.G; __raft.tp(G.raft.x + 90, 520); }); await p.wait(2000); await p.shot(); },
  'deep-night': async (p) => { await p.ev(() => { __raft.give('lantern', 1); __raft.setPhase(0.8); const G = __raft.G; __raft.tp(G.raft.x + 90, 480); }); await p.wait(2500); await p.shot(); },
  'island-day': async (p) => { await p.ev(() => { __raft.setPhase(0.3); __raft.island(0); }); await p.wait(2500); await p.shot(); },
  'island-night': async (p) => { await p.ev(() => { __raft.island(0); __raft.setPhase(0.8); }); await p.wait(3500); await p.shot(); },
  'wonders':    async (p) => {
    for (const k of ['whale', 'manta', 'flying_fish', 'shark']) {
      await p.ev((kind) => { __raft.setPhase(0.3); __raft.tp(__raft.G.raft.x + 60, -10); __raft.spawn(kind); }, k);
      await p.wait(2500); await p.shot('wonder-' + k);
    }
    for (const k of ['jelly', 'moon_whale', 'leviathan']) {
      await p.ev((kind) => { __raft.setPhase(0.8); __raft.spawn(kind); }, k);
      await p.wait(2500); await p.shot('wonder-' + k);
    }
  },
  'craft':      async (p) => { await p.ev(() => { Object.assign(__raft.G.inv, { wood: 20, rope: 10, plastic: 10, metal: 6, cloth: 6 }); __raft.mode('panel', 'craft'); }); await p.wait(600); await p.shot(); await p.ev(() => __raft.mode('play')); },
  'journal':    async (p) => { await p.ev(() => { __raft.mode('panel', 'journal'); }); await p.wait(600); await p.shot(); await p.ev(() => __raft.mode('play')); },
  'build':      async (p) => { await p.ev(() => { const G = __raft.G; Object.assign(G.inv, { wood: 20, rope: 10, purifier: 1 }); G.player.tool = 'hammer'; __raft.setPhase(0.3); }); await p.wait(1200); await p.shot(); await p.ev(() => { __raft.G.player.tool = 'hook'; }); },
  'survive':    async (p) => {
    // fast-forward three in-game days with the player idle on the raft
    const r = await p.ev(() => { __raft.sim(60 * 7 * 3); const G = __raft.G; return { day: G.day, hp: G.player.hp, hunger: G.player.hunger, thirst: G.player.thirst, mode: G.mode, debris: G.debris.length, fish: G.fish.length, raftX: G.raft.x }; });
    p.log('after 3 simulated days: ' + JSON.stringify(r));
    await p.wait(800); await p.shot();
  },
};

if (flag('list')) { console.log(Object.keys(SCENARIOS).join('\n')); process.exit(0); }

const outDir = path.resolve(arg('out', '/tmp/raft-smoke'));
fs.mkdirSync(outDir, { recursive: true });
const htmlPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'raft-build-')), 'index.html');
execFileSync('node', [path.join(root, 'build.mjs'), '--out', htmlPath], { stdio: 'inherit' });

const { chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs');
const [vw, vh] = arg('size', '1280x720').split('x').map(Number);
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1, hasTouch: flag('touch'), isMobile: flag('touch') });
const page = await context.newPage();
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_FILE_NOT_FOUND/.test(m.text())) consoleErrors.push(m.text().slice(0, 300)); });

const shots = [];
let current = 'title';
const p = {
  page,
  wait: (ms) => page.waitForTimeout(ms),
  ev: (fn, a) => page.evaluate(fn, a),
  log: (s) => console.log('  ' + s),
  shot: async (name) => { const f = path.join(outDir, (name || current) + '.png'); await page.screenshot({ path: f }); shots.push(f); },
};

await page.goto('file://' + htmlPath);
await p.wait(1500);
await p.shot('title');
await p.ev(() => __raft.start());
await p.wait(1200);
await p.shot('start');

const only = arg('only', null);
const names = only ? only.split(',').map((s) => s.trim()).filter(Boolean) : Object.keys(SCENARIOS);
for (const name of names) {
  if (!SCENARIOS[name]) { console.log('unknown scenario: ' + name); continue; }
  current = name;
  console.log('scenario: ' + name);
  try { await SCENARIOS[name](p); } catch (e) { consoleErrors.push('scenario ' + name + ' failed: ' + e.message); }
}

const moduleErrors = await page.evaluate(() => window.__raftErrors || {});
await browser.close();

console.log('\nscreenshots: ' + outDir);
const modKeys = Object.keys(moduleErrors);
if (modKeys.length) {
  console.log('\nMODULE ERRORS:');
  for (const k of modKeys) console.log('  [' + k + '] x' + moduleErrors[k].count + ': ' + moduleErrors[k].msg + '\n      ' + moduleErrors[k].stack);
}
if (consoleErrors.length) {
  console.log('\nPAGE ERRORS:');
  for (const e of [...new Set(consoleErrors)].slice(0, 30)) console.log('  ' + e);
}
if (!modKeys.length && !consoleErrors.length) console.log('no errors');
process.exit(modKeys.length || consoleErrors.length ? 1 : 0);
