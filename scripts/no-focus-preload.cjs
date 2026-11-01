// Test-only boot shim for disposable Electron fixtures: patches native window focus
// before Olive's main runs, then loads Olive. show() becomes showInactive() and
// win.focus()/app.focus() become no-ops, so the fixture never activates or steals the
// user's keyboard. webContents.focus() still moves focus *within* the window, so
// injected input (webContents.sendInputEvent) can be routed like the real thing.
// Usage: write {"main": "<this file>"} plus OLIVE_FIXTURE_MAIN=<repo>/src/main/main.js.
const electron = require('electron');
for (const C of [electron.BaseWindow, electron.BrowserWindow]) {
  if (!C) continue;
  C.prototype.show = function () { return this.showInactive(); };
  C.prototype.focus = function () {};
}
electron.app.focus = function () {};
if (electron.app.setActivationPolicy) electron.app.setActivationPolicy('prohibited');
global.__oliveNoFocus = true;
require(process.env.OLIVE_FIXTURE_MAIN);
