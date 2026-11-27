'use strict';
/* Figma import modal: electron test/e2e-figma.js */
const { app, BrowserWindow, ipcMain } = require('electron');
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
const path = require('node:path');

const settings = {
  provider: 'cloudflare', agent: 'direct', systemPrompt: '', editor: 'code', sandbox: true,
  cloudflare: { accountId: '', token: '', model: '@cf/meta/llama-3.3-70b-instruct' },
  openai: { apiKey: '', baseUrl: '', model: '' },
  local: { baseUrl: '', apiKey: '', model: '' },
  opencode: { model: '', agent: '' },
  memory: { url: '' },
  mcp: { figma: { url: 'http://127.0.0.1:3845/mcp', enabled: true } },
};

app.whenReady().then(async () => {
  const calls = [];
  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:save', () => true);
  ipcMain.handle('app:info', () => ({ version: '0.1.0', releases: '' }));
  ipcMain.handle('store:status', () => ({ mode: 'postgres' }));
  ipcMain.handle('projects:list', () => []);
  ipcMain.handle('dev:status', () => ({ state: 'running', folder: '/tmp/p', projectFolder: '/tmp/p', pm: 'npm', framework: { id: 'next', name: 'Next.js' }, port: 3000, url: 'http://localhost:3000', error: null, external: false, sandbox: null }));
  ipcMain.handle('dev:logs', () => []);
  ipcMain.handle('page:info', () => ({ url: 'http://localhost:3000/', title: 'Home' }));
  ipcMain.handle('ui:panel', () => ({ open: true, dock: false }));
  ipcMain.handle('ui:settingsModal', () => true);
  ipcMain.handle('refs:list', () => ({ items: [], open: false, full: false, project: '/tmp/p' }));
  ipcMain.handle('mcp:status', () => ({ status: 'connected', url: 'http://127.0.0.1:3845/mcp', tools: ['get_code', 'get_screenshot', 'get_variable_defs'], server: 'Figma Dev Mode MCP', error: null }));
  ipcMain.handle('mcp:connect', (_e, url) => { calls.push('connect:' + url); return { ok: true, status: { status: 'connected', url, tools: ['get_code'], server: 'Figma', error: null } }; });
  ipcMain.handle('figma:import', (_e, url) => {
    calls.push('import:' + url);
    return { ok: true, nodeId: '12:345', fileKey: 'abc', code: 'export function Hero() {}', variables: '--brand: #6ea8ff', hasImage: true, tools: ['get_code', 'get_screenshot'] };
  });

  const win = new BrowserWindow({
    show: false, width: 780, height: 760, backgroundColor: '#09090b',
    webPreferences: { preload: path.join(__dirname, '..', 'main', 'preload-overlay.js'), contextIsolation: true, sandbox: true },
  });
  const fail = (why) => { console.log('FIGMA_UI_FAIL ' + why); app.exit(1); };
  const timer = setTimeout(() => fail('timeout'), 12000);
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    await win.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));
    await wait(600);
    await js(`document.querySelector('#logo').click(); 'x'`);
    await wait(300);
    await js(`document.querySelector('#figma-btn').click(); 'x'`);
    await wait(250);

    const open = await js(`!document.querySelector('#figma-modal').hidden`);
    if (!open) return fail('modal did not open');

    await js(`(() => {
      const u = document.querySelector('#fm-url');
      u.value = 'https://www.figma.com/design/abc/File?node-id=12-345';
      document.querySelector('#fm-import').click();
    })()`);
    await wait(400);

    const out = await js(`(() => ({
      status: document.querySelector('#fm-status').textContent,
      code: document.querySelector('#fm-code').textContent,
      chip: document.querySelector('#figma-chip').textContent,
      chipClass: (document.querySelector('#figma-chip .chip') || {}).className || '',
      result: !document.querySelector('#fm-result').hidden,
    }))()`);
    if (!/12:345/.test(out.status)) return fail('status ' + out.status);
    if (!/Hero/.test(out.code)) return fail('code ' + out.code);
    if (!/figma · 12:345/.test(out.chip)) return fail('chip ' + out.chip);
    if (!/figma/.test(out.chipClass)) return fail('chip class ' + out.chipClass);
    if (!out.result) return fail('result hidden');
    if (!calls.some((c) => c.startsWith('import:https://www.figma.com/'))) return fail('import call ' + JSON.stringify(calls));

    // Esc closes
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); 'x'`);
    await wait(200);
    const closed = await js(`document.querySelector('#figma-modal').hidden`);
    if (!closed) return fail('modal did not close');

    clearTimeout(timer);
    console.log('FIGMA_UI_PASS');
    app.exit(0);
  } catch (e) {
    clearTimeout(timer);
    fail(e.message);
  }
});
