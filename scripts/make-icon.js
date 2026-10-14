// render assets/icon.svg to a transparent 1024px png and build assets/icon.icns
// run: ./node_modules/.bin/electron scripts/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
app.dock?.hide();
app.whenReady().then(async () => {
  const dir = path.join(__dirname, '..', 'assets');
  const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, useContentSize: true, webPreferences: { offscreen: true } });
  win.webContents.setZoomFactor(1);
  await win.loadURL('data:text/html,' + encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`));
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  const png = img.resize({ width: 1024, height: 1024 }).toPNG();
  fs.writeFileSync(path.join(dir, 'icon.png'), png);
  const set = path.join(dir, 'icon.iconset');
  fs.rmSync(set, { recursive: true, force: true });
  fs.mkdirSync(set);
  for (const s of [16, 32, 128, 256, 512]) {
    for (const k of [1, 2]) {
      const px = s * k;
      const name = `icon_${s}x${s}${k === 2 ? '@2x' : ''}.png`;
      fs.writeFileSync(path.join(set, name), img.resize({ width: px, height: px, quality: 'best' }).toPNG());
    }
  }
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', set, '-o', path.join(dir, 'icon.icns')]);
  fs.rmSync(set, { recursive: true, force: true });
  console.log('wrote assets/icon.png and assets/icon.icns');
  app.quit();
});
