// Whole-window screenshot for native tests, without OS screen capture or focus: capture
// every visible child view of the olive window (chrome ui, tabs, panels, overlays) and
// draw them, in stacking order, onto one canvas at the window's content size.
// usage: await windowShot(app, '/abs/file.png')  (app = playwright ElectronApplication)
import fs from 'node:fs';

export async function windowShot(app, file, windowIndex = 0) {
  const dataUrl = await app.evaluate(async ({ WebContentsView }, i) => {
    const w = global.olive.windows[i]; const win = w.win;
    const { width, height } = win.getContentBounds();
    const layers = [];
    for (const v of win.contentView.children) {
      if (!v.getVisible?.() || !v.webContents || v.webContents.isDestroyed()) continue;
      const b = v.getBounds(); if (b.width < 1 || b.height < 1) continue;
      const img = await v.webContents.capturePage(undefined, { stayHidden: true }).catch(() => null);
      if (!img || img.isEmpty()) continue;
      layers.push({ x: b.x, y: b.y, w: b.width, h: b.height, src: img.toDataURL() });
    }
    const painter = new WebContentsView({ webPreferences: { offscreen: false, sandbox: true } });
    await painter.webContents.loadURL('about:blank');
    try {
      return await painter.webContents.executeJavaScript(`(async () => {
        const layers = ${JSON.stringify(layers)};
        const c = document.createElement('canvas'); c.width = ${width}; c.height = ${height};
        const g = c.getContext('2d'); g.fillStyle = '#d9d9d9'; g.fillRect(0, 0, c.width, c.height);
        for (const l of layers) { const im = new Image(); im.src = l.src; await im.decode(); g.drawImage(im, l.x, l.y, l.w, l.h); }
        return c.toDataURL('image/png');
      })()`);
    } finally { painter.webContents.close(); }
  }, windowIndex);
  fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
  return file;
}
