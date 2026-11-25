'use strict';
/* render build/icon.png (1024×1024, transparent) from build/icon.svg
   usage: npx electron tools/icon.js */
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const SVG = fs.readFileSync(path.join(ROOT, 'build', 'icon.svg'), 'utf8');
const HTML = `<!doctype html><html><body style="margin:0;background:transparent">
${SVG}</body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML));
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), img.toPNG());
  console.log('saved build/icon.png ' + JSON.stringify(img.getSize()));
  app.exit(0);
});
