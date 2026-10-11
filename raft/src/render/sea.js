// STUB — replaced by the sea/underwater worker. See CONTRACT.md.
export function init(G) {}
export function update(G, dt) {}
export function waterY(G, x) { return Math.sin(x * 0.02 + G.time * 1.3) * 3 * G.weather.wave; }
export function seabedY(G, x) { return 620 + Math.sin(x * 0.003) * 120; }
export function drawBackdrop(ctx, G) {
  const v = G.view;
  ctx.fillStyle = '#1d3a4a'; ctx.fillRect(0, Math.max(0, v.seaScreenY), v.cssW, v.cssH);
}
export function drawSeabed(ctx, G) {
  const v = G.view; ctx.fillStyle = '#1a1a1a';
  ctx.beginPath(); ctx.moveTo(v.left, v.top + v.h + 50);
  for (let x = v.left; x <= v.left + v.w + 10; x += 10) ctx.lineTo(x, seabedY(G, x));
  ctx.lineTo(v.left + v.w + 10, v.top + v.h + 50); ctx.fill();
}
export function drawSurface(ctx, G) {
  const v = G.view; ctx.strokeStyle = '#cfe'; ctx.lineWidth = 1;
  ctx.beginPath(); for (let x = v.left; x <= v.left + v.w + 10; x += 6) ctx.lineTo(x, waterY(G, x)); ctx.stroke();
}
