'use strict';
/* e2e global settings modal: electron test/e2e-settings.js */
const { app, BrowserWindow, ipcMain } = require('electron');
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
const path = require('node:path');

const settings = {
  provider: 'cloudflare',
  cloudflare: { accountId: '', token: '', model: '@cf/meta/llama-3.3-70b-instruct' },
  openai: { apiKey: '', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  systemPrompt: '', editor: 'code', agent: 'direct',
  opencode: { model: '', agent: '' }, remember: false, window: null,
  memory: { url: 'postgres://postgres@localhost:5432/postgres' },
};

app.whenReady().then(() => {
  const modalCalls = [];
  let panelCalls = 0;
  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('store:status', () => ({ mode: 'file' }));
  ipcMain.handle('projects:list', () => []);
  ipcMain.handle('dev:status', () => ({ state: 'idle', folder: null, pm: null, port: null, url: null, error: null, external: false }));
  ipcMain.handle('dev:logs', () => []);
  ipcMain.handle('page:info', () => ({ url: '' }));
  ipcMain.handle('ui:panel', () => { panelCalls++; return true; });
  ipcMain.handle('ui:settingsModal', (_e, open) => { modalCalls.push(open); return true; });

  const win = new BrowserWindow({
    show: false, width: 1100, height: 800,
    webPreferences: { preload: path.join(__dirname, '..', 'main', 'preload-overlay.js'), contextIsolation: true, sandbox: true },
  });
  const fail = (why) => { console.log('SETTINGS_FAIL ' + why); app.exit(1); };
  const timer = setTimeout(() => fail('timeout'), 8000);

  win.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html')).then(async () => {
    await new Promise((r) => setTimeout(r, 350));
    await win.webContents.executeJavaScript(`document.querySelector('#settings-btn').click(); 'x'`, true);
    await new Promise((r) => setTimeout(r, 350));
    const open = await win.webContents.executeJavaScript(`
      (() => {
        const card = document.querySelector('.settings-card');
        const r = card.getBoundingClientRect();
        return {
          modalOpen: !document.querySelector('#settings').hidden,
          bodyClass: document.body.classList.contains('settings-on'),
          pillHidden: getComputedStyle(document.querySelector('#pill')).display === 'none',
          backdrop: !!document.querySelector('.settings-backdrop'),
          centeredX: Math.abs((r.left + r.width / 2) - window.innerWidth / 2) < 4,
          centeredY: Math.abs((r.top + r.height / 2) - window.innerHeight / 2) < 4,
          cardW: Math.round(r.width),
          hasAgent: !!document.querySelector('#agent-seg'),
          quickVisible: !!document.querySelector('#quick').offsetParent,
        };
      })()
    `, true);
    await win.webContents.executeJavaScript(`document.querySelector('#settings-backdrop').click(); 'x'`, true);
    await new Promise((r) => setTimeout(r, 250));
    const closed = await win.webContents.executeJavaScript(`
      (() => ({
        hidden: document.querySelector('#settings').hidden,
        bodyClass: document.body.classList.contains('settings-on'),
        pillVisible: getComputedStyle(document.querySelector('#pill')).display !== 'none',
      }))()
    `, true);

    clearTimeout(timer);
    const ok = open.modalOpen && open.bodyClass && open.pillHidden && open.backdrop &&
      open.centeredX && open.centeredY && open.cardW >= 700 && open.cardW <= 780 && open.hasAgent &&
      !open.quickVisible && closed.hidden && !closed.bodyClass && closed.pillVisible &&
      modalCalls.join(',') === 'true,false' && panelCalls === 0;
    console.log(ok ? 'SETTINGS_PASS' : 'SETTINGS_FAIL ' + JSON.stringify({ open, closed, modalCalls, panelCalls }));
    app.exit(ok ? 0 : 1);
  }).catch((e) => { clearTimeout(timer); fail(e.message); });
});
