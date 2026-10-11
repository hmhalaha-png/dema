// STUB — replaced by the items/UI worker. See CONTRACT.md.
let API = null;
export function initUI(api) {
  API = api;
  const b = document.createElement('button');
  b.textContent = '开始'; b.id = 'stub-start';
  b.style.cssText = 'position:fixed;left:50%;top:60%;pointer-events:auto;font-size:24px';
  b.onclick = () => { api.startNew(); b.remove(); };
  document.getElementById('ui').appendChild(b);
}
export function onStart(G, how) {}
export function frame(G, dt) {}
