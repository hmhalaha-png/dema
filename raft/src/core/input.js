// Keyboard, mouse and touch → one input snapshot read by gameplay modules.
// Held keys are booleans; "*Pressed" fields are true for exactly one step.

export const input = {
  left: false, right: false, up: false, down: false, // held
  use: false,             // held: primary action (mouse button / touch on canvas / 使用 button)
  usePressed: false, useReleased: false,
  jumpPressed: false,     // Space / W / ↑ / ▲ button (also "swim up" while held via `up`)
  interactPressed: false, // E / 互动 button
  cyclePressed: false,    // Q / mouse wheel / 切换 button (build-mode piece)
  craftPressed: false,    // Tab / C / 背包 button
  journalPressed: false,  // J / 图鉴 button
  pausePressed: false,    // Esc / P
  eatPressed: false,      // F: eat best food
  drinkPressed: false,    // R: drink water
  toolPressed: 0,         // 1..4 number keys / tool buttons; 0 = none
  aimFromPointer: false,  // true while the pointer gives a real aim point
  mouse: { sx: 0, sy: 0, wx: 0, wy: 0, inside: false },
  touch: false,           // last input came from a touchscreen
};

const held = { left: new Set(), right: new Set(), up: new Set(), down: new Set(), use: new Set() };
const swallowed = new Set();   // key codes ignored until released (see swallowInput)
const down = new Set();        // key codes physically down right now
function setHeld(name, src, on) {
  const s = held[name];
  if (on) s.add(src); else s.delete(src);
  const was = input[name];
  input[name] = s.size > 0;
  if (name === 'use') {
    if (input.use && !was) input.usePressed = true;
    if (!input.use && was) input.useReleased = true;
  }
  if (name === 'up' && input.up && !was) input.jumpPressed = true;
}

const KEYMAP = {
  ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
  ArrowUp: 'up', KeyW: 'up', Space: 'up', ArrowDown: 'down', KeyS: 'down',
};

export function initInput(canvas) {
  // a phone counts as touch from the start, so hints name the on-screen buttons before the first tap
  try { if (window.matchMedia('(pointer: coarse)').matches) input.touch = true; } catch (e) { /* ignore */ }
  // any tap or click anywhere (menus included) tells us which wording to use
  window.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') input.touch = true;
    else if (e.pointerType === 'mouse') input.touch = false;
  }, true);
  // capture phase, so `down` is current before any menu handler calls swallowInput()
  window.addEventListener('keydown', (e) => down.add(e.code), true);
  window.addEventListener('keyup', (e) => down.delete(e.code), true);
  window.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    input.touch = false;
    if (e.code === 'Tab') { e.preventDefault(); if (!e.repeat) input.craftPressed = true; return; }
    if (swallowed.has(e.code)) { e.preventDefault(); return; }
    const k = KEYMAP[e.code];
    if (k) { setHeld(k, 'key:' + e.code, true); e.preventDefault(); return; }
    if (e.repeat) return;
    switch (e.code) {
      case 'KeyE': input.interactPressed = true; break;
      case 'KeyQ': input.cyclePressed = true; break;
      case 'KeyC': input.craftPressed = true; break;
      case 'KeyJ': input.journalPressed = true; break;
      case 'Escape': case 'KeyP': input.pausePressed = true; break;
      case 'KeyF': input.eatPressed = true; break;
      case 'KeyR': input.drinkPressed = true; break;
      case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4':
        input.toolPressed = Number(e.code.slice(5)); break;
    }
  });
  window.addEventListener('keyup', (e) => {
    swallowed.delete(e.code);
    const k = KEYMAP[e.code];
    if (k) setHeld(k, 'key:' + e.code, false);
  });
  window.addEventListener('blur', () => {
    down.clear(); swallowed.clear();
    for (const name of Object.keys(held)) { held[name].clear(); input[name] = false; }
  });

  canvas.addEventListener('pointerdown', (e) => {
    input.touch = e.pointerType === 'touch';
    trackPointer(e);
    input.aimFromPointer = true;
    setHeld('use', 'ptr:' + e.pointerId, true);
    try { canvas.setPointerCapture(e.pointerId); } catch (er) { /* ignore */ }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse') { input.touch = false; input.aimFromPointer = true; }
    trackPointer(e);
  });
  const up = (e) => { setHeld('use', 'ptr:' + e.pointerId, false); if (e.pointerType === 'touch') input.aimFromPointer = false; };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') input.mouse.inside = false; });
  canvas.addEventListener('wheel', (e) => { input.cyclePressed = true; e.preventDefault(); }, { passive: false });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

function trackPointer(e) {
  input.mouse.sx = e.clientX; input.mouse.sy = e.clientY; input.mouse.inside = true;
}

// On-screen touch buttons (built by the HUD). `key` is one of:
// left right up down use  (held)  |  interact cycle craft journal pause eat drink tool1..tool4 (tap)
export function bindTouchButton(el, key) {
  const HELD = ['left', 'right', 'up', 'down', 'use'];
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
    input.touch = e.pointerType === 'touch';
    try { el.setPointerCapture(e.pointerId); } catch (er) { /* ignore */ }
    el.classList.add('is-down');
    if (HELD.includes(key)) {
      if (key === 'use') input.aimFromPointer = false;
      setHeld(key, 'btn:' + e.pointerId + key, true);
    } else tap(key);
  });
  const release = (e) => {
    el.classList.remove('is-down');
    if (HELD.includes(key)) setHeld(key, 'btn:' + e.pointerId + key, false);
  };
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

export function tap(key) {
  switch (key) {
    case 'interact': input.interactPressed = true; break;
    case 'cycle': input.cyclePressed = true; break;
    case 'craft': input.craftPressed = true; break;
    case 'journal': input.journalPressed = true; break;
    case 'pause': input.pausePressed = true; break;
    case 'eat': input.eatPressed = true; break;
    case 'drink': input.drinkPressed = true; break;
    default:
      if (key && key.startsWith('tool')) input.toolPressed = Number(key.slice(4)) || 0;
  }
}

// Call when a menu/screen consumes a key press (e.g. Space or Enter on 继续): releases every
// held key and ignores the keys still physically down until they are released, so closing a
// menu with Space doesn't also make the boy jump.
export function swallowInput() {
  for (const name of Object.keys(held)) {
    for (const src of held[name]) if (src.startsWith('key:')) swallowed.add(src.slice(4));
    held[name].clear(); input[name] = false;
  }
  for (const code of down) swallowed.add(code);
  endInputFrame();
}

// Pick the right wording for a control hint: keyboard text, or the touch-button text when the
// player is using a touchscreen. Example: hint('按 F 吃东西', '点「吃」吃东西').
export const hint = (keyboard, touch) => (input.touch ? touch : keyboard);

// Called by the core once per rendered frame after gameplay has read input.
export function endInputFrame() {
  input.usePressed = false; input.useReleased = false; input.jumpPressed = false;
  input.interactPressed = false; input.cyclePressed = false; input.craftPressed = false;
  input.journalPressed = false; input.pausePressed = false; input.eatPressed = false;
  input.drinkPressed = false; input.toolPressed = 0;
}
