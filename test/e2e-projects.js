'use strict';
/* e2e dashboard remove-project: electron test/e2e-projects.js */
const { app, BrowserWindow, ipcMain } = require('electron');
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
const path = require('node:path');

app.whenReady().then(() => {
  let welcomeCalls = 0;
  let removedFolder = null;
  ipcMain.handle('welcome:data', () => {
    welcomeCalls++;
    return welcomeCalls === 1
      ? { projects: [{ name: 'demo-project', folder: '/tmp/wl-demo-project', repo: 'acme/demo-project', last_opened_at: Date.now() }], running: { state: 'idle', folder: null } }
      : { projects: [], running: { state: 'idle', folder: null } };
  });
  ipcMain.handle('projects:remove', (_e, folder) => { removedFolder = folder; return { ok: true }; });

  const win = new BrowserWindow({
    show: false, width: 1100, height: 760,
    webPreferences: { preload: path.join(__dirname, '..', 'main', 'preload-page.js'), contextIsolation: true, sandbox: true },
  });
  const fail = (why) => { console.log('PROJECTS_FAIL ' + why); app.exit(1); };
  const timer = setTimeout(() => fail('timeout'), 8000);

  win.loadFile(path.join(__dirname, '..', 'renderer', 'placeholder.html')).then(async () => {
    await new Promise((r) => setTimeout(r, 350));
    const before = await win.webContents.executeJavaScript(`
      (() => ({
        card: !!document.querySelector('.card'),
        remove: !!document.querySelector('.card-remove'),
        workspace: !!document.querySelector('.ws'),
        wsRemove: !!document.querySelector('.ws-x'),
      }))()
    `, true);
    await win.webContents.executeJavaScript(`
      (() => {
        const x = document.querySelector('.card-remove');
        x.click();
        const armed = x.classList.contains('armed');
        x.click();
        return armed;
      })()
    `, true).catch(() => false);
    await new Promise((r) => setTimeout(r, 500));
    const after = await win.webContents.executeJavaScript(`
      (() => ({
        onboard: !!document.querySelector('.onboard'),
        cards: document.querySelectorAll('.card').length,
        emptyWs: !!document.querySelector('.ws-empty'),
      }))()
    `, true);

    clearTimeout(timer);
    const ok = before.card && before.remove && before.workspace && before.wsRemove &&
      removedFolder === '/tmp/wl-demo-project' && welcomeCalls >= 2 &&
      after.onboard && after.cards === 0 && after.emptyWs;
    console.log(ok ? 'PROJECTS_PASS' : 'PROJECTS_FAIL ' + JSON.stringify({ before, after, removedFolder, welcomeCalls }));
    app.exit(ok ? 0 : 1);
  }).catch((e) => { clearTimeout(timer); fail(e.message); });
});
