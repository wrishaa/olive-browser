// Match Electron before-input-event against profile accelerators without relying
// on native menu dispatch (which cannot preserve a held MRU walk).
const { normalize } = require('./shortcuts');
const MODIFIERS = { Cmd: 'meta', Ctrl: 'control', Alt: 'alt', Shift: 'shift' };
const RELEASE_KEYS = { Meta: 'meta', Command: 'meta', Control: 'control', Alt: 'alt', Shift: 'shift' };
const CODES = { Equal:'=', Minus:'-', BracketLeft:'[', BracketRight:']', Backslash:'\\', Semicolon:';', Quote:"'", Comma:',', Period:'.', Slash:'/', Backquote:'`' };
const KEYS = { ' ':'Space', ArrowUp:'Up', ArrowDown:'Down', ArrowLeft:'Left', ArrowRight:'Right', '+':'Plus', Esc:'Escape', Return:'Enter' };
function inputKey(input) {
  return CODES[input.code] || KEYS[input.key] || input.key?.toUpperCase();
}
function matchesInput(accelerator, input) {
  if (!accelerator) return false;
  const parts = normalize(accelerator).split('+');
  const key = parts.pop();
  if (Object.entries(MODIFIERS).some(([name, flag]) => parts.includes(name) !== !!input[flag])) return false;
  // Named keys in the normalizer are title-cased; compare case-insensitively.
  return key.toUpperCase() === inputKey(input)?.toUpperCase();
}
function holdForInput(input) {
  // Shift is intentionally not a commit modifier: adding/releasing it reverses
  // the default walk without ending the frozen snapshot.
  const modifiers = ['meta', 'control', 'alt'].filter(flag => input[flag]);
  if (!modifiers.length && input.shift) modifiers.push('shift');
  return { modifiers, key: input.code || input.key };
}
function holdReleased(hold, input) {
  if (!hold) return true;
  if (!hold.modifiers.length) return input.type === 'keyUp' && (input.code || input.key) === hold.key;
  const released = input.type === 'keyUp' && RELEASE_KEYS[input.key];
  // Check key explicitly too: Electron can report the modifier as still down on
  // its own keyUp event. Flags catch releases that happened outside this view.
  return hold.modifiers.some(flag => released === flag || !input[flag]);
}
// A keyDown of one of the hold's own modifier keys: it was released and pressed again.
function holdRepressed(hold, input) {
  if (!hold?.modifiers.length || input.type !== 'keyDown') return false;
  return hold.modifiers.includes(RELEASE_KEYS[input.key]);
}
// Escape keyDown cancels an open walk (whatever modifiers are still down).
function cancelsWalk(input) {
  return input.type === 'keyDown' && (input.key === 'Escape' || input.key === 'Esc' || input.code === 'Escape');
}
module.exports = { matchesInput, holdForInput, holdReleased, holdRepressed, cancelsWalk };
