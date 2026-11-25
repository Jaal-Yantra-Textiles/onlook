'use strict';
/* capture website screenshots: npx electron marketing/screenshot.js */
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const OUT = __dirname;
const SITE = path.join(__dirname, '..', 'website', 'index.html');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: '#09090b',
    webPreferences: { offscreen: true }, // renders in memory — not clamped by the screen size
  });
  await win.loadFile(SITE);
  await new Promise((r) => setTimeout(r, 1500)); // fonts + paint

  // hero / viewport shot
  win.setContentSize(1440, 900);
  await new Promise((r) => setTimeout(r, 600));
  const viewport = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'hero.png'), viewport.toPNG());
  console.log('saved hero.png ' + JSON.stringify(viewport.getSize()));

  // full-page shot: grow to the document height, then capture
  const h = await win.webContents.executeJavaScript('document.documentElement.scrollHeight', true);
  win.setContentSize(1440, Math.min(3000, Math.max(900, h + 8)));
  await new Promise((r) => setTimeout(r, 1200));
  const full = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'full.png'), full.toPNG());
  console.log('saved full.png ' + JSON.stringify(full.getSize()) + ' pageHeight=' + h);

  app.exit(0);
});
