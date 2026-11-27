'use strict';
/* reference card on the canvas: electron test/e2e-refs.js */
const { app, BrowserWindow, ipcMain } = require('electron');
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
const path = require('node:path');

const THUMB = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const calls = [];

app.whenReady().then(async () => {
  ipcMain.handle('refs:toggle', (_e, id) => { calls.push('toggle:' + id); return true; });
  ipcMain.handle('refs:remove', (_e, id) => { calls.push('remove:' + id); return true; });
  ipcMain.on('ref:move', (_e, d) => calls.push('move:' + d.id + ':' + d.dx + ',' + d.dy));
  ipcMain.on('ref:resize', (_e, d) => calls.push('resize:' + d.id + ':' + d.dw + ',' + d.dh));
  ipcMain.on('ref:move-end', () => calls.push('end'));

  const win = new BrowserWindow({
    show: false, width: 240, height: 190, backgroundColor: '#0b0b0e',
    webPreferences: { preload: path.join(__dirname, '..', 'main', 'preload-overlay.js'), contextIsolation: true, sandbox: true },
  });
  const fail = (why) => { console.log('REFS_CARD_UI_FAIL ' + why); app.exit(1); };
  const timer = setTimeout(() => fail('timeout'), 10000);
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    await win.loadFile(path.join(__dirname, '..', 'renderer', 'ref-card.html'));
    await wait(450);

    win.webContents.send('ref:item', {
      id: 'a', name: 'hero.png', thumb: THUMB, include: true, width: 100, height: 80, w: 200, h: 150, zoom: 1,
    });
    await wait(250);

    const first = await js(`(() => ({
      name: document.querySelector('#name').textContent,
      src: !!document.querySelector('#img').getAttribute('src'),
      on: document.querySelector('#card').classList.contains('on'),
      dot: document.querySelector('#dot').classList.contains('on'),
    }))()`);
    if (first.name !== 'hero.png' || !first.src || !first.on || !first.dot) return fail('render ' + JSON.stringify(first));

    // exclude state
    win.webContents.send('ref:item', { id: 'a', name: 'hero.png', thumb: THUMB, include: false, width: 100, height: 80, w: 200, h: 150 });
    await wait(200);
    const off = await js(`({ off: document.querySelector('#card').classList.contains('off'), dot: document.querySelector('#dot').classList.contains('on') })`);
    if (!off.off || off.dot) return fail('excluded ' + JSON.stringify(off));

    // include / remove buttons
    await js(`document.querySelector('#dot').click(); document.querySelector('#remove').click(); 'x'`);
    await wait(150);
    if (!calls.includes('toggle:a') || !calls.includes('remove:a')) return fail('buttons ' + JSON.stringify(calls));

    // drag the header
    await js(`(() => {
      const head = document.querySelector('#head');
      head.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, screenX: 100, screenY: 100 }));
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, screenX: 112, screenY: 106 }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    })()`);
    await wait(150);
    if (!calls.some((c) => c === 'move:a:12,6')) return fail('drag ' + JSON.stringify(calls));
    if (!calls.includes('end')) return fail('drag end ' + JSON.stringify(calls));

    // resize the corner
    await js(`(() => {
      const r = document.querySelector('#resize');
      r.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, screenX: 200, screenY: 200 }));
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, screenX: 220, screenY: 212 }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    })()`);
    await wait(150);
    if (!calls.some((c) => c === 'resize:a:20,12')) return fail('resize ' + JSON.stringify(calls));

    clearTimeout(timer);
    console.log('REFS_CARD_UI_PASS');
    app.exit(0);
  } catch (e) {
    clearTimeout(timer);
    fail(e.message);
  }
});
