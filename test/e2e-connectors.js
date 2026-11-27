'use strict';
/* connectors modal: electron test/e2e-connectors.js */
const { app, BrowserWindow, ipcMain } = require('electron');
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
const path = require('node:path');

const servers = [
  { id: 'figma', name: 'Figma', transport: 'http', url: 'http://127.0.0.1:3845/mcp', command: '', args: [], enabled: true, status: 'connected', tools: ['get_code', 'get_screenshot'], server: 'Figma Dev Mode MCP', error: null },
  { id: 'local', name: 'Files', transport: 'stdio', command: 'npx', args: ['-y', 'server'], url: '', enabled: false, status: 'disconnected', tools: [], server: null, error: null },
];
const calls = [];
let saved = [];
let current = servers;

app.whenReady().then(async () => {
  ipcMain.handle('settings:get', () => ({ provider: 'cloudflare', agent: 'direct', systemPrompt: '', editor: 'code', sandbox: true, cloudflare: { accountId: '', token: '', model: '' }, openai: { apiKey: '', baseUrl: '', model: '' }, local: { baseUrl: '', apiKey: '', model: '' }, opencode: { model: '', agent: '' }, memory: { url: '' }, mcp: { servers } }));
  ipcMain.handle('app:info', () => ({ version: '0.1.0', releases: '' }));
  ipcMain.handle('store:status', () => ({ mode: 'file' }));
  ipcMain.handle('projects:list', () => []);
  ipcMain.handle('dev:status', () => ({ state: 'idle' }));
  ipcMain.handle('dev:logs', () => []);
  ipcMain.handle('page:info', () => ({ url: '' }));
  ipcMain.handle('ui:panel', () => ({ open: false, dock: false }));
  ipcMain.handle('ui:settingsModal', () => true);
  ipcMain.handle('refs:list', () => ({ items: [], open: false, full: false }));
  ipcMain.handle('mcp:servers', () => ({ servers: current }));
  ipcMain.handle('mcp:connect', (_e, id) => {
    calls.push('connect:' + id);
    const s = current.find((x) => x.id === id);
    if (s) { s.status = 'connected'; s.tools = ['tool']; }
    return { ok: true, server: s };
  });
  ipcMain.handle('mcp:preset-figma', () => {
    calls.push('preset-figma');
    const s = { id: 'figma-remote', name: 'Figma (remote)', transport: 'http', url: 'https://mcp.figma.com/mcp', command: '', args: [], enabled: false, oauth: true, status: 'disconnected', tools: [], server: null, error: null };
    current = [...current, s];
    return { ok: true, id: s.id };
  });
  ipcMain.handle('mcp:preset-figma-local', () => {
    calls.push('preset-figma-local');
    return { ok: true, id: 'figma' };
  });
  ipcMain.handle('mcp:disconnect', (_e, id) => { calls.push('disconnect:' + id); return { servers }; });
  ipcMain.handle('mcp:save', (_e, list) => {
    calls.push('save:' + list.length);
    saved = list;
    current = list.map((s) => ({ ...s, status: s.enabled ? 'connected' : 'disconnected', tools: [], server: null, error: null }));
    return { servers: current };
  });

  const win = new BrowserWindow({
    show: false, width: 780, height: 760, backgroundColor: '#09090b',
    webPreferences: { preload: path.join(__dirname, '..', 'main', 'preload-overlay.js'), contextIsolation: true, sandbox: true },
  });
  const fail = (why) => { console.log('CONNECTORS_FAIL ' + why); app.exit(1); };
  const timer = setTimeout(() => fail('timeout'), 12000);
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    await win.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));
    await wait(600);
    win.webContents.send('ui:openConnectors', {});
    await wait(500);

    const open = await js(`(() => ({
      open: !document.querySelector('#connectors').hidden,
      rows: document.querySelectorAll('.connector-row').length,
      names: [...document.querySelectorAll('.connector-name')].map((n) => n.textContent),
      status: [...document.querySelectorAll('.connector-status')].map((n) => n.textContent),
      body: document.body.classList.contains('settings-on'),
    }))()`);
    if (!open.open || open.rows !== 2) return fail('rows ' + JSON.stringify(open));
    if (open.names.join(',') !== 'Figma,Files') return fail('names ' + JSON.stringify(open));
    if (!/connected/.test(open.status[0]) || !/off/.test(open.status[1])) return fail('status ' + JSON.stringify(open));
    if (!open.body) return fail('backdrop');

    // connect the second connector
    await js(`document.querySelectorAll('.connector-row')[1].querySelector('button').click(); 'x'`);
    await wait(400);
    if (!calls.includes('connect:local')) return fail('connect ' + JSON.stringify(calls));

    // add a new HTTP connector with OAuth sign-in
    await js(`document.querySelector('#connector-add').click(); 'x'`);
    await wait(150);
    await js(`document.querySelector('#cf-oauth').click(); 'x'`);
    const oauthUi = await js(`({ on: !document.querySelector('#cf-oauth-wrap').hidden, label: document.querySelector('#cf-oauth').textContent })`);
    if (!oauthUi.on || !/on/.test(oauthUi.label)) return fail('oauth toggle ' + JSON.stringify(oauthUi));
    await js(`(() => {
      document.querySelector('#cf-name').value = 'Filesystem';
      document.querySelector('#cf-url').value = 'http://localhost:7777/mcp';
      document.querySelector('#cf-client-id').value = 'cid';
      document.querySelector('#cf-client-secret').value = 'cs';
      document.querySelector('#cf-redirect').value = 'http://127.0.0.1:19876/mcp/oauth/callback';
      document.querySelector('#cf-pat').value = 'figd_test';
      document.querySelector('#cf-save').click();
    })()`);
    await wait(400);
    const added = saved.find((s) => s.name === 'Filesystem');
    if (!added || added.url !== 'http://localhost:7777/mcp') return fail('save add ' + JSON.stringify(saved));
    if (!added.oauth || added.clientId !== 'cid' || added.clientSecret !== 'cs') return fail('oauth add ' + JSON.stringify(added));
    if (added.pat !== 'figd_test' || added.redirectUri !== 'http://127.0.0.1:19876/mcp/oauth/callback') return fail('oauth fields ' + JSON.stringify(added));
    const signInLabel = await js(`[...document.querySelectorAll('.connector-row')].find((r) => r.textContent.includes('Filesystem')).querySelector('button').textContent`);
    if (signInLabel !== 'disconnect') return fail('connect label ' + signInLabel);
    const afterAdd = await js(`({ rows: document.querySelectorAll('.connector-row').length, form: document.querySelector('#connector-form').hidden })`);
    if (afterAdd.rows !== 3 || !afterAdd.form) return fail('after add ' + JSON.stringify(afterAdd));

    // edit the stdio connector and check the transport fields
    await js(`document.querySelectorAll('.connector-row')[1].querySelectorAll('button')[1].click(); 'x'`);
    await wait(150);
    const edit = await js(`(() => ({
      name: document.querySelector('#cf-name').value,
      command: document.querySelector('#cf-command').value,
      stdio: !document.querySelector('#cf-stdio').hidden,
      http: document.querySelector('#cf-http').hidden,
    }))()`);
    if (edit.name !== 'Files' || edit.command !== 'npx' || !edit.stdio || !edit.http) return fail('edit ' + JSON.stringify(edit));
    await js(`document.querySelector('#cf-cancel').click(); 'x'`);

    // delete the new connector (two clicks)
    await js(`(() => {
      const del = document.querySelectorAll('.connector-row')[2].querySelectorAll('button')[2];
      del.click();
    })()`);
    await wait(100);
    await js(`document.querySelectorAll('.connector-row')[2].querySelectorAll('button')[2].click(); 'x'`);
    await wait(400);
    if (saved.length !== 2) return fail('delete ' + JSON.stringify(saved));
    const afterDel = await js(`document.querySelectorAll('.connector-row').length`);
    if (afterDel !== 2) return fail('rows after delete ' + afterDel);

    // remote Figma is paused behind a coming-soon state
    await js(`document.querySelector('#connector-figma-remote').click(); 'x'`);
    await wait(200);
    const soon = await js(`document.querySelector('#connector-auth').textContent`);
    if (!/coming soon/i.test(soon)) return fail('coming soon ' + soon);
    if (calls.includes('preset-figma')) return fail('remote preset should be disabled');

    // one-click local Figma preset connects without OAuth
    await js(`document.querySelector('#connector-figma-local').click(); 'x'`);
    await wait(400);
    if (!calls.includes('preset-figma-local')) return fail('local preset ' + JSON.stringify(calls));
    if (!calls.includes('connect:figma')) return fail('local preset connect ' + JSON.stringify(calls));

    // Esc closes
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); 'x'`);
    await wait(200);
    const closed = await js(`document.querySelector('#connectors').hidden`);
    if (!closed) return fail('did not close');

    clearTimeout(timer);
    console.log('CONNECTORS_PASS');
    app.exit(0);
  } catch (e) {
    clearTimeout(timer);
    fail(e.message);
  }
});
