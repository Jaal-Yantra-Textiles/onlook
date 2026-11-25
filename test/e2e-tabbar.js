'use strict';
/* e2e tab bar home state: electron test/e2e-tabbar.js */
const { app, BrowserWindow, ipcMain } = require('electron');
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
const path = require('node:path');

app.whenReady().then(() => {
  ipcMain.handle('git:status', () => ({ ok: false, error: 'test' }));
  const win = new BrowserWindow({
    show: false, width: 1200, height: 200,
    webPreferences: { preload: path.join(__dirname, '..', 'main', 'preload-overlay.js'), contextIsolation: true, sandbox: true },
  });
  const fail = (why) => { console.log('TABBAR_FAIL ' + why); app.exit(1); };
  const timer = setTimeout(() => fail('timeout'), 8000);

  win.loadFile(path.join(__dirname, '..', 'renderer', 'tabbar.html')).then(async () => {
    await new Promise((r) => setTimeout(r, 250));
    win.webContents.send('tabs:state', { tabs: ['/'], active: 0, home: true });
    await new Promise((r) => setTimeout(r, 150));
    const home = await win.webContents.executeJavaScript(`
      (() => {
        const bar = document.querySelector('.bar');
        const cs = getComputedStyle(bar);
        return {
          isHome: document.body.classList.contains('home'),
          label: (document.querySelector('.home-label') || {}).textContent || '',
          addHidden: getComputedStyle(document.querySelector('#add')).display === 'none',
          homeVisible: getComputedStyle(document.querySelector('#home')).display !== 'none',
          togglesHidden: getComputedStyle(document.querySelector('#sidebar')).display === 'none' &&
            getComputedStyle(document.querySelector('#chat')).display === 'none',
          macPad: navigator.userAgent.includes('Mac') ? cs.paddingLeft : 'n/a',
          barH: bar.getBoundingClientRect().height,
          barTop: bar.getBoundingClientRect().top,
        };
      })()
    `, true);

    win.webContents.send('tabs:state', { tabs: ['/'], active: 0, home: false, ready: false, phase: 'starting', sidebar: true, chat: true, sandbox: { mode: 'worktree' } });
    await new Promise((r) => setTimeout(r, 150));
    const loading = await win.webContents.executeJavaScript(`
      (() => ({
        isHome: document.body.classList.contains('home'),
        isLoading: document.body.classList.contains('loading'),
        label: (document.querySelector('.loading-label') || {}).textContent || '',
        addHidden: getComputedStyle(document.querySelector('#add')).display === 'none',
        sandboxHidden: getComputedStyle(document.querySelector('#sandbox')).display === 'none',
        changesHidden: getComputedStyle(document.querySelector('#changes')).display === 'none',
        newChatHidden: getComputedStyle(document.querySelector('#a-new')).display === 'none',
        sidebarHidden: getComputedStyle(document.querySelector('#sidebar')).display === 'none',
        chatHidden: getComputedStyle(document.querySelector('#chat')).display === 'none',
      }))()
    `, true);

    win.webContents.send('tabs:state', { tabs: ['/', '/about'], active: 1, home: false, ready: true, phase: 'running', sidebar: false, chat: false });
    await new Promise((r) => setTimeout(r, 150));
    const project = await win.webContents.executeJavaScript(`
      (() => ({
        isHome: document.body.classList.contains('home'),
        isLoading: document.body.classList.contains('loading'),
        tabs: [...document.querySelectorAll('.tab .route')].map((n) => n.textContent),
        active: [...document.querySelectorAll('.tab')].findIndex((n) => n.classList.contains('on')),
        addVisible: getComputedStyle(document.querySelector('#add')).display !== 'none',
        homeLabel: !!document.querySelector('.home-label'),
        loadingLabel: !!document.querySelector('.loading-label'),
        sidebarOn: document.querySelector('#sidebar').classList.contains('on'),
        chatOn: document.querySelector('#chat').classList.contains('on'),
        togglesVisible: getComputedStyle(document.querySelector('#sidebar')).display !== 'none' &&
          getComputedStyle(document.querySelector('#chat')).display !== 'none',
      }))()
    `, true);

    clearTimeout(timer);
    const ok = home.isHome && home.label === 'Recent projects' && home.addHidden && home.homeVisible && home.togglesHidden &&
      home.macPad === '86px' && home.barH === 38 && home.barTop === 0 &&
      !loading.isHome && loading.isLoading && /Starting dev server/.test(loading.label) &&
      loading.addHidden && loading.sandboxHidden && loading.changesHidden && loading.newChatHidden &&
      loading.sidebarHidden && loading.chatHidden &&
      !project.isHome && !project.isLoading && project.tabs.join(',') === '/,/about' && project.active === 1 &&
      project.addVisible && !project.homeLabel && !project.loadingLabel && project.togglesVisible &&
      !project.sidebarOn && !project.chatOn;
    console.log(ok ? 'TABBAR_PASS' : 'TABBAR_FAIL ' + JSON.stringify({ home, loading, project }));
    app.exit(ok ? 0 : 1);
  }).catch((e) => { clearTimeout(timer); fail(e.message); });
});
