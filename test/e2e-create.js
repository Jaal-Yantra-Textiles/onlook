'use strict';
/* e2e new-project picker: electron test/e2e-create.js */
const { app, BrowserWindow, ipcMain } = require('electron');
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
const path = require('node:path');
const { TEMPLATES } = require('../main/scaffold');

app.whenReady().then(() => {
  const captured = [];
  ipcMain.handle('create:templates', () => TEMPLATES);
  ipcMain.handle('create:pickLocation', () => '/tmp/demo-parent');
  ipcMain.handle('create:submit', (_e, opts) => { captured.push(opts); return { ok: true, folder: '/tmp/demo-parent/' + opts.name }; });

  const win = new BrowserWindow({
    show: false, width: 900, height: 800,
    webPreferences: { preload: path.join(__dirname, '..', 'main', 'preload-page.js'), contextIsolation: true, sandbox: true },
  });
  const fail = (why) => { console.log('CREATE_FLOW_FAIL ' + why); app.exit(1); };
  const timer = setTimeout(() => fail('timeout'), 10000);

  win.loadFile(path.join(__dirname, '..', 'renderer', 'create-project.html')).then(async () => {
    await new Promise((r) => setTimeout(r, 450));
    const state = () => win.webContents.executeJavaScript(`(() => {
      const q = (s) => document.querySelector(s);
      return {
        cards: document.querySelectorAll('#templates .tpl').length,
        selected: (q('#templates .tpl.on') || {}).dataset ? q('#templates .tpl.on').dataset.id : '',
        repoHidden: q('#repo-row').hidden,
        cmdHidden: q('#cmd-row').hidden,
        go: q('#go').textContent,
        ready: document.body.classList.contains('ready'),
        opacity: getComputedStyle(document.body).opacity,
        loc: q('#loc').textContent,
      };
    })()`, true);

    let s = await state();
    if (s.cards !== TEMPLATES.length) return fail('cards=' + s.cards);
    if (s.selected !== 'next') return fail('default=' + s.selected);
    if (!s.ready || Number(s.opacity) < 0.9) return fail('fade=' + s.opacity);

    // GitHub template reveals the repo fields
    await win.webContents.executeJavaScript(`document.querySelector('#templates [data-id="github"]').click(); 'x'`, true);
    s = await state();
    if (s.repoHidden || !s.cmdHidden) return fail('github fields');
    if (!/GitHub repo/.test(s.go)) return fail('go label ' + s.go);

    // custom reveals the command field
    await win.webContents.executeJavaScript(`document.querySelector('#templates [data-id="custom"]').click(); 'x'`, true);
    s = await state();
    if (s.cmdHidden || !s.repoHidden) return fail('custom fields');

    // plain HTML: location + name + create
    await win.webContents.executeJavaScript(`
      document.querySelector('#templates [data-id="html"]').click();
      document.querySelector('#loc').click();
      'x'
    `, true);
    await new Promise((r) => setTimeout(r, 250));
    await win.webContents.executeJavaScript(`
      const n = document.querySelector('#name');
      n.value = 'demo-site';
      n.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#go').click();
      'x'
    `, true);
    await new Promise((r) => setTimeout(r, 300));

    const c = captured[0] || {};
    const ok = captured.length === 1 && c.template === 'html' && c.name === 'demo-site' && c.parent === '/tmp/demo-parent';
    const status = await win.webContents.executeJavaScript(`document.querySelector('#status').textContent`, true);
    clearTimeout(timer);
    if (!ok) return fail('payload=' + JSON.stringify(c));
    if (!/Created/.test(status)) return fail('status=' + status);
    console.log('CREATE_FLOW_PASS');
    app.exit(0);
  }).catch((e) => { clearTimeout(timer); fail(e.message); });
});
