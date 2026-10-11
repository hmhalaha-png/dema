// Optional painted art. If the player drops a PNG/JPG/WebP with one of these
// names into the `assets/` folder next to index.html, the game uses it instead
// of the procedural version. Missing files are silently ignored.
// (See ART_PROMPTS.md for the prompts that produce each file.)

export const ASSET_LIST = {
  sky_day:     'assets/sky_day',      // daytime sky panorama, horizon at ~62% height, no sea
  sky_dusk:    'assets/sky_dusk',     // sunset / dusk sky panorama
  sky_night:   'assets/sky_night',    // night sky with crescent moon and moonlit clouds
  horizon_day: 'assets/horizon_day',  // far horizon strip (distant islands / sea stacks), transparent
  horizon_night: 'assets/horizon_night',
  island:      'assets/island',       // side view of a small tropical island, transparent background
  lighthouse:  'assets/lighthouse',   // the lighthouse island (ending), transparent background
  title:       'assets/title',        // title screen key art
};

const EXTS = ['png', 'webp', 'jpg'];
const loaded = {};

export function loadAssets(onEach) {
  for (const [key, base] of Object.entries(ASSET_LIST)) tryLoad(key, base, 0, onEach);
}

function tryLoad(key, base, i, onEach) {
  if (i >= EXTS.length) return;
  const img = new Image();
  img.onload = () => { loaded[key] = img; onEach && onEach(key, img); };
  img.onerror = () => tryLoad(key, base, i + 1, onEach);
  img.src = base + '.' + EXTS[i];
}

// Returns a loaded HTMLImageElement or null.
export const getAsset = (key) => loaded[key] || null;
