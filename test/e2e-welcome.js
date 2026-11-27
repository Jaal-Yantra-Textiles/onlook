'use strict';
/* E2E welcome + create-page test: electron test/e2e-welcome.js */
const { app, BrowserWindow, ipcMain } = require('electron');
// a closed stdout pipe (e.g. launched through `| head`) must never crash the test
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
const path = require('node:path');

app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, '..', 'main', 'preload-page.js'), contextIsolation: true, sandbox: true } });
  const got = [];
  let done = false;
  let timer = null;

  ipcMain.handle('create:pickLocation', async () => '/tmp/demo-parent');
  ipcMain.handle('create:templates', () => []);
  ipcMain.handle('create:submit', async () => ({ ok: false, error: 'dry-run' }));
  ipcMain.handle('welcome:data', async () => ({ projects: [], running: { state: 'idle', folder: null } }));

  const phase2 = () => {
    win.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'create-project.html')).then(async () => {
      const ok = await win.webContents.executeJavaScript(
        `!!(window.withlook && window.withlook.pickCreateLocation && window.withlook.submitCreate && window.withlook.onCreateStatus && window.withlook.onCreateLog) && !!document.getElementById('go') && !!document.getElementById('loc')`, true)
        .catch(() => false);
      console.log(ok ? 'CREATE_PAGE_PASS' : 'CREATE_PAGE_FAIL');
      app.exit(ok ? 0 : 1);
    }).catch((e) => { console.log('CREATE_PAGE_FAIL ' + e.message); app.exit(1); });
  };

  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    const ok = got.includes('open') && got.includes('create');
    console.log(ok ? 'WELCOME_PASS ' + got.join(',') : 'WELCOME_FAIL ' + got.join(','));
    if (!ok) app.exit(1);
    else phase2();
  };

  timer = setTimeout(() => { console.log('WELCOME_FAIL timeout ' + got.join(',')); app.exit(1); }, 8000);
  ipcMain.on('page:ui', (_e, a) => { got.push(a); if (got.length >= 2) finish(); });

  win.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'placeholder.html')).then(() => {
    win.webContents.executeJavaScript(`document.getElementById('btn-open').click(); document.getElementById('btn-new').click(); 'ok'`, true)
      .catch((e) => { console.log('WELCOME_FAIL ' + e.message); app.exit(1); });
  }).catch((e) => { console.log('WELCOME_FAIL ' + e.message); app.exit(1); });
});
