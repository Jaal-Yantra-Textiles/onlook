'use strict';
/* e2e settings combobox test: electron test/e2e-combo.js */
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
  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('store:status', () => ({ mode: 'file' }));
  ipcMain.handle('projects:list', () => []);
  ipcMain.handle('dev:status', () => ({ state: 'idle', folder: null, pm: null, port: null, url: null, error: null, external: false }));
  ipcMain.handle('dev:logs', () => []);
  ipcMain.handle('page:info', () => ({ url: '' }));
  ipcMain.handle('ui:panel', () => true);
  ipcMain.handle('opencode:list', () => ({ ok: true, models: ['anthropic/claude-sonnet-4', 'openai/gpt-5'], agents: ['build', 'plan'] }));

  const win = new BrowserWindow({
    show: false, width: 780, height: 720,
    webPreferences: { preload: path.join(__dirname, '..', 'main', 'preload-overlay.js'), contextIsolation: true, sandbox: true },
  });
  const fail = (why) => { console.log('COMBO_FAIL ' + why); app.exit(1); };
  const timer = setTimeout(() => fail('timeout'), 10000);

  win.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html')).then(async () => {
    await new Promise((r) => setTimeout(r, 400)); // boot IPC round-trips
    const result = await win.webContents.executeJavaScript(`
      (async () => {
        const out = {};
        out.spinnerGone = !document.querySelector('#pill-spinner');
        document.querySelector('#settings-btn').click();
        await new Promise((r) => setTimeout(r, 250));
        const input = document.querySelector('#cf-model');
        const btn = input.parentElement.querySelector('.combo-btn');
        btn.click();
        const pop = document.querySelector('.combo-pop');
        out.opened = !pop.hidden;
        out.count = pop.querySelectorAll('.combo-opt').length;
        out.width = pop.getBoundingClientRect().width;
        const third = pop.querySelectorAll('.combo-opt')[2];
        out.third = third && third.textContent;
        third.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        out.value = input.value;
        out.closed = pop.hidden;
        // typing filters the list
        btn.click();
        input.value = 'gpt';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        out.filtered = pop.querySelectorAll('.combo-opt').length;
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        out.escaped = pop.hidden;
        return out;
      })()
    `, true);
    clearTimeout(timer);
    const ok = result.spinnerGone && result.opened && result.count === 7 && result.width > 150 &&
      result.third === '@cf/zai-org/glm-4.6' && result.value === result.third &&
      result.closed && result.filtered === 2 && result.escaped;
    console.log(ok ? 'COMBO_PASS' : 'COMBO_FAIL ' + JSON.stringify(result));
    app.exit(ok ? 0 : 1);
  }).catch((e) => { clearTimeout(timer); fail(e.message); });
});
