// popups (window.open with features: oauth, payment, a google doc "open in new window") are
// plain BrowserWindows (window.js setWindowOpenHandler, disposition 'new-window'). dj wants to
// double-click the window's thin border to fill the screen and double-click again to go back,
// with no extra bar and no visual change.
//
// the native resize zone sits on/outside the frame and appkit owns it (a click there starts a
// resize loop, a drag in the title bar moves the window), so we don't touch it. what we add: a
// double-click whose mousedown lands in the outermost EDGE px of the popup's page (top, left,
// right or bottom) toggles zoom. we watch the popup's own input stream (before-mouse-event)
// and only swallow that second mousedown and its mouseup: single clicks, drags, the first click
// of a double-click, moves and wheel all reach the page as before, no view or css is added, so
// drag-move, edge resize and the look of the border stay exactly as they were. a double-click
// anywhere else in the page is the page's.
//
// zoom: save the frame, fill the display's workArea (menu bar and dock respected). the next
// border double-click while still at that zoomed frame puts the saved frame back exactly. if the
// user moved/resized in between, the next double-click zooms again from the new frame.
const { BrowserWindow, screen } = require('electron');

const EDGE = 6;
const state = new WeakMap();

// which border band a page point is in, or null. x/y are page (dip) coordinates, size the
// content size of the popup.
function edgeAt(x, y, size, edge = EDGE) {
  const [w, h] = size;
  if (!(x >= 0 && y >= 0 && x < w && y < h)) return null;
  if (y < edge) return 'top';
  if (y >= h - edge) return 'bottom';
  if (x < edge) return 'left';
  if (x >= w - edge) return 'right';
  return null;
}

const same = (a, b) => !!a && !!b && ['x', 'y', 'width', 'height'].every((k) => Math.abs(a[k] - b[k]) <= 2);

function isZoomed(win) {
  const s = state.get(win);
  return !!(s && s.saved && same(win.getBounds(), s.zoomed));
}

function togglePopupZoom(win) {
  if (!win || win.isDestroyed() || win.isFullScreen()) return null;
  const s = state.get(win) || {};
  state.set(win, s);
  if (s.saved && same(win.getBounds(), s.zoomed)) {
    const back = s.saved;
    s.saved = null;
    s.zoomed = null;
    win.setBounds(back, true);
    return 'restored';
  }
  s.saved = win.getBounds();
  const area = screen.getDisplayMatching(s.saved).workArea;
  s.zoomed = { x: area.x, y: area.y, width: area.width, height: area.height };
  win.setBounds(s.zoomed, true);
  return 'zoomed';
}

function wirePopupZoom(win) {
  if (!(win instanceof BrowserWindow) || win.isDestroyed() || state.has(win)) return;
  state.set(win, {});
  const wc = win.webContents;
  let eatUp = false;
  wc.on('before-mouse-event', (e, m) => {
    if (m.type === 'mouseUp' && eatUp) { eatUp = false; e.preventDefault(); return; }
    if (m.type !== 'mouseDown' || m.button !== 'left' || m.clickCount !== 2) return;
    if (!edgeAt(m.x, m.y, win.getContentSize())) return;
    e.preventDefault();
    eatUp = true;
    togglePopupZoom(win);
  });
  // a popup's own popups get the same border
  wc.on('did-create-window', (child) => wirePopupZoom(child));
}

module.exports = { EDGE, edgeAt, togglePopupZoom, wirePopupZoom, isZoomed };
