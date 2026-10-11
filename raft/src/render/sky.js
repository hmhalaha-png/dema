// STUB — replaced by the sky/weather worker. See CONTRACT.md.
export function init(G) {}
export function update(G, dt) {}
export function drawSky(ctx, G) {
  const v = G.view;
  const g = ctx.createLinearGradient(0, 0, 0, v.seaScreenY);
  g.addColorStop(0, '#3a5a7a'); g.addColorStop(1, '#c9a98a');
  ctx.fillStyle = g; ctx.fillRect(0, 0, v.cssW, Math.max(0, v.seaScreenY));
}
export function drawWeather(ctx, G) {}
export function debugWeather(G, kind) { G.weather.kind = kind; }
// Screen-space positions of the sun and moon for reflections / lighting.
export function celestial(G) {
  return { sunX: G.view.cssW * 0.7, sunY: G.view.seaScreenY - 200, sunVisible: G.light > 0.3, moonX: G.view.cssW * 0.4, moonY: G.view.seaScreenY - 250, moonVisible: G.light < 0.3, sunColor: [255, 220, 170] };
}
