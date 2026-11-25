'use strict';
/* E2E picker test: electron test/e2e-picker.js */
const { app, BrowserWindow, ipcMain } = require('electron');
// a closed stdout pipe (e.g. launched through `| head`) must never crash the test
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
const path = require('node:path');
const fs = require('node:fs');

const html = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><body>
  <div id="hero"><h1 class="title">Hello withlook</h1><button id="cta">Get started</button></div>
</body></html>`);

app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, '..', 'main', 'preload-page.js'), contextIsolation: true, sandbox: true } });
  let failTimer = setTimeout(() => { console.log('E2E_FAIL timeout'); app.exit(1); }, 8000);
  ipcMain.on('picker:result', (_e, data) => {
    clearTimeout(failTimer);
    try {
      const ok = data && data.tag === 'h1' && data.selector && /title|hero|h1/.test(data.selector) && /Hello withlook/.test(data.text) && data.html.includes('<h1');
      console.log(ok ? 'E2E_PASS' : 'E2E_FAIL ' + JSON.stringify(data).slice(0, 300));
      app.exit(ok ? 0 : 1);
    } catch (err) { console.log('E2E_FAIL ' + err.message); app.exit(1); }
  });
  ipcMain.on('picker:cancel', () => { console.log('E2E_FAIL cancelled'); app.exit(1); });
  win.webContents.loadURL(html).then(async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'picker-inject.js'), 'utf8');
    await win.webContents.executeJavaScript(src, true);
    await win.webContents.executeJavaScript(`
      const el = document.querySelector('h1.title');
      el.dispatchEvent(new MouseEvent('mousemove', {bubbles: true}));
      el.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
      'ok'
    `, true);
  }).catch((e) => { console.log('E2E_FAIL ' + e.message); app.exit(1); });
});
