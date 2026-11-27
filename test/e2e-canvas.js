'use strict';
/* canvas dock: electron test/e2e-canvas.js */
const { app, BrowserWindow, ipcMain } = require('electron');
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
const path = require('node:path');

const actions = [];

app.whenReady().then(async () => {
  ipcMain.on('canvas:action', (_e, d) => actions.push(d));

  const win = new BrowserWindow({
    show: false, width: 420, height: 42, backgroundColor: '#0b0d12',
    webPreferences: { preload: path.join(__dirname, '..', 'main', 'preload-overlay.js'), contextIsolation: true, sandbox: true },
  });
  const fail = (why) => { console.log('CANVAS_FAIL ' + why); app.exit(1); };
  const timer = setTimeout(() => fail('timeout'), 10000);
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    await win.loadFile(path.join(__dirname, '..', 'renderer', 'canvas-bar.html'));
    await wait(450);

    await js(`['in','out','zoom','hand','multi','center','float-btn','frames','stop','restart']
      .forEach((id) => document.getElementById(id).click()); 'x'`);
    await wait(200);

    const expected = ['in', 'out', 'fit', 'panMode', 'multiCanvas', 'center', 'toggleFloat', 'clearFrames', 'stopDev', 'restartDev'];
    const got = actions.map((a) => a && a.action);
    if (JSON.stringify(got) !== JSON.stringify(expected)) return fail('actions ' + JSON.stringify(got));

    // a running, multi-page canvas in pan mode
    win.webContents.send('canvas:state', { zoom: 0.8, panMode: true, frames: 3, dev: 'running', multi: true, dock: false });
    await wait(250);
    const live = await js(`(() => {
      const g = (id) => document.getElementById(id);
      return {
        zoom: g('zoom').textContent,
        frames: g('frames').textContent,
        framesHidden: g('frames').hidden,
        framesSep: g('frames-sep').hidden,
        panning: document.body.classList.contains('panning'),
        hint: getComputedStyle(g('pan-hint')).display,
        handOn: g('hand').classList.contains('on'),
        multiOn: g('multi').classList.contains('on'),
        stopHidden: g('stop').hidden,
        restartHidden: g('restart').hidden,
        serverSep: g('server-sep').hidden,
      };
    })()`);

    if (live.zoom !== '80%') return fail('zoom ' + live.zoom);
    if (live.frames !== '3 frames' || live.framesHidden || live.framesSep) return fail('frames ' + JSON.stringify(live));
    if (!live.panning || live.hint === 'none') return fail('pan ' + JSON.stringify(live));
    if (!live.handOn || !live.multiOn) return fail('toggles ' + JSON.stringify(live));
    if (live.stopHidden || live.restartHidden || live.serverSep) return fail('server ' + JSON.stringify(live));

    // idle, single frame: the dock goes back to its normal shape
    win.webContents.send('canvas:state', { zoom: 1, panMode: false, frames: 1, dev: 'idle', multi: false, dock: false });
    await wait(250);
    const idle = await js(`(() => {
      const g = (id) => document.getElementById(id);
      return {
        zoom: g('zoom').textContent,
        framesHidden: g('frames').hidden,
        panning: document.body.classList.contains('panning'),
        stopHidden: g('stop').hidden,
        restartHidden: g('restart').hidden,
        multiOn: g('multi').classList.contains('on'),
      };
    })()`);
    if (idle.zoom !== '100%' || !idle.framesHidden || idle.panning) return fail('idle ' + JSON.stringify(idle));
    if (!idle.stopHidden || !idle.restartHidden || idle.multiOn) return fail('idle controls ' + JSON.stringify(idle));

    clearTimeout(timer);
    console.log('CANVAS_PASS');
    app.exit(0);
  } catch (e) {
    clearTimeout(timer);
    fail(e.message);
  }
});
