# 少年与海 — engine contract & design bible

A 2D side-view deep-sea raft survival game in the browser (canvas 2D, no libraries).
A small boy drifts on a raft across an endless sea toward a lighthouse. He hooks floating
trash for materials, dives to spear fish, expands the raft, meets wondrous sea creatures,
and lands on islands that are safe by day and hunted by an unknown beast at night.

Everything is drawn procedurally in code. Optional painted images can override a few
backgrounds (see `src/core/assets.js`), but the game must look finished without them.

---

## 1. Art direction (the most important section)

**Mood: "Little Nightmares" × Ghibli skies × a boy's adventure film.**

- **Little Nightmares**: the boy is tiny (28 units tall) in an enormous world. Oppressive
  darkness at the edges, heavy vignette, film grain, silhouettes, desaturated cold shadows
  against small pools of warm light (lantern, lamp, grill fire). Things in the dark are
  *bigger than they should be* and slightly wrong — long limbs, too many teeth, an eye where
  a rock should be. Unsettling, never gory.
- **Ghibli skies** (reference stills: `/tmp/claude-0/-home-user-dema/f727b1db-8bda-5293-81d5-14ee5cc6daa7/images/4.png`
  night, `.../images/5.webp` dusk — open them with the Read tool): towering painterly
  cumulus with lit tops and soft shadowed bottoms. Night = deep navy/indigo, a thin
  crescent moon, stars, clouds rim-lit cold blue-white, distant mountains/horizon in
  dark blue. Dusk = warm peach, rose and lilac clouds over a dusty gold horizon.
- **Day vs night must feel like two different worlds.** Day: warm, open, readable,
  hopeful, sparkles on water, light shafts underwater. Night: the camera world shrinks to
  what your lights reach; the sea turns ink-black; bioluminescence and the moon are the
  only colors; strange silhouettes on the horizon.
- Shapes: soft, hand-made, slightly irregular (use noise/jitter, not perfect geometry).
  No pixel art, no flat vector clip-art look, no emoji. Layered parallax for depth.
- Palette anchors (use as a guide, not a cage):
  day sky `#8fc3d9 → #f3e2c4`, dusk `#2e3a6b → #c9768a → #f2b27a`, night `#070b1e → #13204a`,
  surface water day `#3f7f8f`, deep `#06121c`, raft wood `#6b4a2e`, lantern light `rgb(255,196,120)`,
  bioluminescence `rgb(110,220,255)`, the boy's red scarf `#b8352b`.
- Text in the game is **Simplified Chinese**.

## 2. Coordinates & view

- World units. **Sea level is y = 0. Up is negative y** (canvas convention). Sky is y < 0,
  underwater is y > 0. The seabed lies roughly at y = 450…1400 depending on x.
- The journey goes **left → right**: the raft drifts toward +x. `C.GOAL_X` (20000) is the
  lighthouse. Distance shown to the player = `G.raft.x`.
- The core sets two transforms before calling a draw function:
  - **world** layers: `ctx` is already transformed so you draw in world units.
  - **screen** layers: `ctx` is in CSS pixels (0..`G.view.cssW`, 0..`G.view.cssH`).
- `G.view`: `{cssW, cssH, dpr, scale, w, h, left, top, seaScreenY}` — `w,h,left,top` are the
  visible world rect; `seaScreenY` is where y=0 is on screen (CSS px). `scale` = CSS px per
  world unit (≈1.3–2 on desktop). Never assume a fixed resolution.
- Helpers in `src/core/world.js`: `waterY(G,x)`, `seabedY(G,x)`, `groundAt(G,x,fromY)`,
  `addLight`, `addInteract`, `addHit`, `screenToWorld`, `worldToScreen`, `onScreen`.
- Cull everything off-screen (`onScreen`) — this must run at 60fps on a laptop.

## 3. Time, state, ownership

- `src/core/state.js`: constants `C`, `newGame()`, `daylight(phase)`, `isNight(G)`, `isDusk(G)`,
  `say(G,text,kind)` (toast), `journal(G,text)`, `discover(G,id)` (codex), `skipToPhase`.
- Day/night: `G.phase` in [0,1): 0 sunrise, 0.25 noon, `C.SUNSET`=0.56 sunset,
  night from `C.NIGHT_START`=0.64 to `C.NIGHT_END`=0.97. `G.light` = daylight 0.08…1.
  `G.day` counts days. One cycle = `C.DAY_LEN` = 420 s.
- **Persistent state** (saved; created in `newGame()`, do not rename):
  `G.time, G.player{x,y,facing,hp,hunger,thirst,oxygen,tool}, G.raft{x,tiles,anchored,sailUp},
  G.inv{itemId:count}, G.codex, G.journal, G.persist{islands:{},flags:{}}`.
  Raft tiles: `[{hp, s}]`, `s` = structure or null, e.g. `{type:'anchor',down:false}`.
  Anything a module needs saved goes in `G.persist.<module>` as plain JSON.
- **Runtime state**: create in your `init(G)`; `init` runs for new games AND loaded games
  (`G.loaded === true`) and for the title-screen demo (`G.demo === true`, no toasts, no
  stats). Never assume runtime arrays survive; never put functions in persistent state.
- `G.mode`: `'title'|'play'|'pause'|'panel'|'dead'|'ending'`; `G.panel`: `'craft'|'journal'`.
  The world only steps in `'play'` (and in `'title'` without `player.update`).
- Per-step scratch arrays (cleared by the core every step before updates):
  `G.lights` `{x,y,r,color:[r,g,b],a}`, `G.interactables` `{x,y,r,label,act(G),priority}`,
  `G.hits` `{x,y,r,dmg,kind,from}` (cleared AFTER all updates).
  Everyone pushes interactables during their update; the **player picks from `G.interactablesLast`**
  (the complete list from the previous step) because islands/life update after the player.
- `G.fade` 0..1: full-screen black overlay painted by `post.drawPost` (cutscenes; the raft's
  "sail around the island" transition animates it).
- `G.shake += 0.3` for screen shake. `emit(G,{...})` in `src/core/particles.js` for particles
  (kinds `dot|bubble|streak|glow`).
- Input: `import { input } from '../core/input.js'` — see the file for fields
  (`left,right,up,down,use` held; `usePressed,useReleased,jumpPressed,interactPressed,
  cyclePressed,craftPressed,journalPressed,pausePressed,eatPressed,drinkPressed,toolPressed`
  one-shot; `mouse.wx/wy` world aim; `aimFromPointer`; `touch`). On touch devices there is
  no hover aim: when `!input.aimFromPointer`, aim toward `G.player.facing` with a sensible arc.

## 4. Update and draw order (core, `src/main.js`)

Update each step (only in `play`): `sky → sea → raft → player → debris → life → islands → craft → particles`.
Audio and HUD run every frame in every mode (`audio.update`, `hud.frame`).

Draw order:

| # | layer | space | owner fn |
|---|---|---|---|
| 1 | sky, sun/moon, stars, clouds, far horizon line | screen | `sky.drawSky` |
| 2 | giant silhouettes on the horizon (leviathan, moon whale breach far away) | screen | `life.drawHorizon` |
| 3 | sea body behind everything: distant water band + underwater gradient + far parallax | screen | `sea.drawBackdrop` |
| 4 | seabed, rocks, kelp, wrecks, god rays | world | `sea.drawSeabed` |
| 5 | huge creatures behind the action (whale under the raft, deep eye) | world | `life.drawDeep` |
| 6 | islands (terrain, trees, back props) | world | `islands.drawBack` |
| 7 | floating debris | world | `debris.draw` |
| 8 | raft + structures | world | `raft.draw` |
| 9 | fish, shark, jellyfish, mantas, turtles… | world | `life.draw` |
| 10 | the boy, hook + rope, held tool | world | `player.draw` |
| 11 | island foreground leaves, night beast | world | `islands.drawFront` |
| 12 | particles | world | core |
| 13 | water surface: translucent water over everything below y≈0, surface line, foam | world | `sea.drawSurface` |
| 14 | build-mode ghost | world | `raft.drawBuildGhost` |
| 15 | darkness + light pools (uses `G.lights`), depth fog | screen | `post.drawLighting` |
| 16 | rain, lightning flash | screen | `sky.drawWeather` |
| 17 | color grade, vignette, film grain | screen | `post.drawPost` |

Each call is wrapped in try/catch by the core; a throw is logged once and the frame goes on.

## 5. Module APIs (every export listed is REQUIRED — other modules call them)

### `src/render/sky.js` (worker: SKY)
`init(G)`, `update(G,dt)`, `celestial(G) → {sunX,sunY,sunVisible,moonX,moonY,moonVisible,sunColor}` (screen
CSS px, used by sea for reflections) — owns `G.weather` `{kind:'clear'|'cloudy'|'rain'|'storm'|'fog', wave (≥1 wave amplitude
multiplier), rain 0..1, wind, fog 0..1, lightning 0..1}` with a weather state machine; `drawSky`, `drawWeather`,
`debugWeather(G, kind)`. Uses `getAsset('sky_day'|'sky_dusk'|'sky_night'|'horizon_day'|'horizon_night')` when present.

### `src/render/sea.js` + `src/render/post.js` (worker: SEA)
sea: `init, update, waterY(G,x), seabedY(G,x), drawBackdrop, drawSeabed, drawSurface`.
post: `init, resize(G), drawLighting, drawPost`.

### `src/entities/player.js` (worker: PLAYER)
`init, update, draw, hurtPlayer(G, dmg, fromX, kind)`. Owns `G.hook`, survival stats, death
(`G.mode='dead'`), choosing the nearest interactable (`G.prompt = {x,y,label}` and calling `act(G)` on E),
tool use (hook / spear / hammer handled by raft build mode / hands), eat (F) and drink (R) via `inventory.useItem`.

### `src/entities/debris.js` + `src/entities/life.js` (worker: LIFE)
debris: `init, update, draw, hookCatch(G,x,y,r) → number newly attached, collectAttached(G) → [{id,n}]`.
life: `init, update, drawHorizon, drawDeep, draw, debugSpawn(G, kind) → bool`.

### `src/systems/raft.js` (worker: RAFT)
`init, update, deckAt(G,x) → y|null, draw, drawBuildGhost`. Sets runtime `G.raft.y` (deck top y) and `G.raft.vx`.

### `src/systems/islands.js` (worker: ISLANDS)
`init, update, groundAt(G,x) → y|null, islandAt(G,x) → {id,x0,x1,kind}|null, drawBack, drawFront,
debugTeleport(G,i) → bool, debugSpawn(G,kind) → bool`.
`groundAt` covers the whole island span including the underwater slopes (y > 0 there).

### `src/systems/inventory.js`, `src/systems/craft.js`, `src/ui/hud.js` (worker: UI)
inventory: `ITEMS`, `init`, `count(G,id)`, `addItem(G,id,n,quiet)`, `hasItems(G,cost)`, `takeItems(G,cost)`,
`useItem(G,id) → bool` (eat/drink/heal effects).
craft: `RECIPES`, `init`, `update`, `canCraft(G,id)`, `craft(G,id) → bool`.
hud: `initUI(api)`, `onStart(G, 'new'|'continue')`, `frame(G, dt)` (every frame, every mode).
`api` = `{hasSave(), startNew(), continueGame(), save(), toTitle(), restart(), G}`.

### `src/systems/audio.js` (worker: AUDIO)
`init(G), update(G,dt), sfx(name, opts?), unlockAudio(), setMuted(bool), isMuted()`.
Sound names everyone may call (unknown names must be ignored silently):
`step jump splash dive surface swim throw reel hook pickup craft build hammer eat drink hurt spear
fishcatch shark whale beast thunder sail anchor ui discover sleep heartbeat bubble lantern grill water`.

Cross-module imports are allowed only through the exports above plus `src/core/*`.

## 6. Game design

**Items** (`G.inv` ids, Chinese names owned by `inventory.ITEMS`):
`wood 木板, plastic 塑料, rope 绳子, cloth 布, metal 废铁, leaf 棕榈叶, stone 石头,
coconut 椰子, berry 野果, raw_fish 生鱼, cooked_fish 烤鱼, can 罐头, water 淡水`,
tools `hook 钩索, hammer 锤子, spear 鱼叉, lantern 提灯, flippers 脚蹼`,
placeables `purifier 净水器, grill 烤架, sail 船帆, lamp 灯柱, bed 吊床`,
consumables `bandage 绷带`, story `note 漂流瓶信`.

**Recipes** (craft.js): spear{wood3,rope2} · lantern{metal2,plastic2,rope1} · flippers{plastic3,rope2} ·
bandage{cloth2} · purifier{plastic4,wood2} · grill{metal2,wood3,stone2} · sail{wood6,cloth4,rope3} ·
lamp{metal2,plastic1,wood2} · bed{wood4,cloth3,leaf2}. Raft tiles are not crafted: build mode places
them directly for {wood2,rope1}.

**Survival**: hunger −100 over ~6 min, thirst −100 over ~4 min (faster in the sun, slower at night).
At 0 hunger or thirst, hp drains 1/s. hp regenerates slowly if both > 60. Oxygen 100 lasts ~22 s
with the head underwater (flippers: swim faster). Food: raw_fish +12 hunger (−5 hp if hunger>…, it's raw),
cooked_fish +35, coconut +15 hunger +20 thirst, berry +8, can +30, water +40 thirst, bandage +30 hp.

**Tools** (hotbar 1–4: hook, spear, hammer, hands/lantern):
- Hook (钩索): hold to charge, release to throw in an arc toward the aim; it floats; hold again to reel
  in. Debris within ~20 units of the floating/reeling hook attaches (`debris.hookCatch`) and is collected
  when the hook reaches the boy (`debris.collectAttached`). Rope line drawn from hand to hook.
- Spear (鱼叉): stab toward aim; creates a `G.hits` entry (dmg 25, kind 'spear'). Works in water and on land.
- Hammer (锤子): build mode (raft.js): ghost slots at both raft ends (new tile) and on empty tiles
  (placeables in inventory). `input.cyclePressed` cycles the piece; `usePressed` places. Also repairs
  damaged tiles (+1 wood).
- Lantern: passive — if owned, the boy carries it lit at night and underwater (big warm light).

**Raft** (raft.js): row of tiles, deck bobs on `waterY`. Drifts at `C.DRIFT` (+`C.SAIL_BOOST` with the sail up),
0 when anchored. The boy standing on it is carried along (player adds `G.raft.vx`). Structures:
anchor (E: drop/raise), purifier (fills 1 water per ~45 s by day, faster in rain; E: drink/collect),
grill (E with raw fish: cooks in 10 s using 1 wood; E: take cooked fish), sail (E: raise/lower),
lamp (E: on/off; lit lamp = warm light that keeps night horrors further from the raft), bed (E at night: sleep
to next sunrise; hunger/thirst −25). Shark bites can damage edge tiles; a tile at 0 hp breaks off.
**Islands block the raft** (side view): when the raft's front edge reaches island ground above the
water (`islands.groundAt` < 0) it **beaches** there and stops. While beached, the anchor offers
「绕过小岛继续漂流」: fade `G.fade` to black, move the raft (and the boy if he's on it) to just past
`islandAt(...).x1`, fade back in. The boy cannot leave with the raft while he is on the island.

**Ocean** (debris.js/life.js): debris drifts in a band near the surface ahead of the raft: plank(wood),
bottle(plastic), net(rope), scrap(metal), cloth bundle(cloth), palm frond(leaf), barrel (3–5 mixed items +
sometimes a can), message bottle (note → journal lore, rare). Fish schools at 60–500 depth (spear → raw_fish).
Shark: circles the raft, attacks the boy in water, sometimes bites the raft edge; 3 spear hits make it flee.
Wonders (rare scripted events, each calls `discover`): seagulls, flying fish, dolphins, turtle, manta, whale
passing under the raft (day); jellyfish bloom, glowing plankton trails, lantern fish, moon whale breaching,
leviathan silhouette on the horizon, ghost ship in fog (night); angler and the deep eye (deep, mostly night).
Codex ids: see `src/data/codex.js`.

**Islands** (islands.js): deterministic layout along the journey (e.g. x≈2600, 6200, 10000, 14200,
17800) and the lighthouse at `C.GOAL_X`. Side-view terrain rising out of the sea with beach slopes that
continue underwater. Day: palms (coconut, leaf), driftwood (wood), rocks (stone), bushes (berry), a
chest (mixed loot + a journal page), crabs. Anchor the raft next to it and walk/jump across. Night: the
beast comes out of the tree line, hunts the boy on land (big, dark, glowing eyes, long limbs), cannot
enter the water, hates light (a lantern slows it). Lighthouse island: arriving in daytime and pressing E
at the lighthouse door ends the game (`G.mode='ending'`).

**Story beats** (UI writes text; others call `journal`/`say`): wake on a raft after a storm at sunrise;
first night; first island; message bottles from a girl who also drifted ("如果你看到这封信……");
the lighthouse light visible on the horizon at night once x > 15000; ending.

## 7. Testing

- `node build.mjs` must succeed. `node tools/smoke.mjs --out /tmp/<you>` runs scenarios and reports errors
  per module (`--only a,b` to pick; `--list`). Look at the screenshots with the Read tool.
- Debug hooks in the page: `__raft.G`, `start()`, `setPhase(p)`, `tp(x,y)`, `give(id,n)`, `sim(seconds)`,
  `spawn(kind)`, `island(i)`, `weather(kind)`, `mode(m,panel)`.
- Other workers are editing their own files at the same time; if the smoke run shows errors in someone
  else's module, ignore them. Only edit the files you own.

## 8. Additions after integration

- `G.raft.busy` (runtime, set by raft.js): true while a raft cutscene runs (sail-around, sleep). The player
  module ignores movement/tool input while it is true, and saves are refused.
- `swallowInput()` (core/input.js): a menu that consumes Space/Enter calls it so the key doesn't also make
  the boy jump after the menu closes.
- `hint(keyboardText, touchText)` (core/input.js): pick control wording for keyboard vs touchscreen players.
  Every toast that names a key must use it (e.g. hint('按 F 吃东西', '点「吃」吃东西')).
- Saving: `isSafeToSave(G)` (core/save.js). Autosave happens at the first safe moment after a new day starts.
  `api.save()` returns false when it is not safe; the HUD must then say why.
- After the ending, returning to the title deletes the save (the journey is finished).
