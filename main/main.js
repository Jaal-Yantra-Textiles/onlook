'use strict';
const { app, BrowserWindow, WebContentsView, Menu, ipcMain, dialog, shell, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const sandbox = require('./sandbox');

// a closed stdout pipe (e.g. launched through `| head`) must never crash the app
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

// ---------- constants ----------
const OVERLAY_W = 780;
const PILL_H = 52;
const TOP_GAP = 10;
const PANEL_VIEW_H = 660;
const SMOKE = process.argv.includes('--smoke');
const TEST_PROJ = (() => { const i = process.argv.indexOf('--test-project'); return i >= 0 ? process.argv[i + 1] : null; })();
const TEST_OPENCODE = (() => { const i = process.argv.indexOf('--test-opencode'); return i >= 0 ? process.argv[i + 1] : null; })();
const TEST_LOAD = (() => { const i = process.argv.indexOf('--test-load'); return i >= 0 ? process.argv[i + 1] : null; })();
// test runs must never touch the user's real memory.json / settings.json
if (SMOKE || TEST_PROJ || TEST_OPENCODE || TEST_LOAD) {
  try { app.setPath('userData', path.join(os.tmpdir(), 'withlook-test')); } catch {}
}

// ---------- state ----------
let win = null;
let pageView = null;
let overlayView = null;
let previewWin = null; // small movable window hosting the loaded project
let pageInMain = true;  // false while pageView lives in the preview window
let homeMode = true;    // dashboard (recent projects) is showing instead of the live preview
let settingsModal = false; // global settings modal owns the whole window (dimmed background)
let sidebarHidden = false; // docked layout: hide the project rail
let chatHidden = false;    // hide the chat overlay entirely (preview gets the space)
let panelOpen = false;  // overlay expanded (floating pill → panel)
let dockMode = false;   // Onlook-style: chat docked right, preview beside it
let pickerActive = false;
let devProc = null;
let devWait = null; // port-poll timeout guard
let createProc = null; // active create-next-app scaffold
let createCancelled = false;
let devState = { state: 'idle', folder: null, projectFolder: null, sandbox: null, pm: null, port: null, url: null, error: null, external: false };
let devLogs = [];
const chatAborts = new Map();
let quitting = false; // true once the app is really quitting (not just closing the window)

// ---------- settings ----------
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const DEFAULT_SETTINGS = {
  provider: 'cloudflare',
  cloudflare: { accountId: '', token: '', model: '@cf/meta/llama-3.3-70b-instruct' },
  openai: { apiKey: '', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  systemPrompt: '',
  editor: 'code',
  sandbox: true, // agent edits + dev server run in an isolated worktree; your folder is untouched
  agent: 'direct', // 'direct' = LLM API · 'opencode' = local opencode agent
  opencode: { model: '', agent: '' },
  // the app always opens on the dashboard; projects start only when the user clicks one
  window: null,
  memory: { url: 'postgres://postgres@localhost:5432/postgres' },
};
function loadSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return {
      ...DEFAULT_SETTINGS, ...s,
      cloudflare: { ...DEFAULT_SETTINGS.cloudflare, ...(s.cloudflare || {}) },
      openai: { ...DEFAULT_SETTINGS.openai, ...(s.openai || {}) },
      opencode: { ...DEFAULT_SETTINGS.opencode, ...(s.opencode || {}) },
      memory: { ...DEFAULT_SETTINGS.memory, ...(s.memory || {}) },
    };
  } catch { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings(s) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2));
}

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function overlaySend(channel, payload) {
  if (overlayView && !overlayView.webContents.isDestroyed()) overlayView.webContents.send(channel, payload);
  if (sidebarView && !sidebarView.webContents.isDestroyed()) sidebarView.webContents.send(channel, payload);
}
function refreshGitViews() {
  for (const v of [overlayView, sidebarView, tabbarView]) {
    try { if (v && !v.webContents.isDestroyed()) v.webContents.send('git:refresh', {}); } catch {}
  }
}

// ---------- layout ----------
// ---------- canvas camera (Onlook-style: {x, y, zoom}) ----------
const canvas = { zoom: 1, x: 0, y: 0, panMode: false };
let canvasBarView = null;
let panGlassView = null;
let sidebarView = null;
let tabbarView = null;
let loaderView = null;
let activeLoading = false;
let projectLoaded = false; // the first page finished loading after the server came up
let loaderVisible = false; // mirrors loaderView visibility for tests/telemetry
let overlayVisible = false; // mirrors overlayView visibility for tests/telemetry
const SIDEBAR_W = 232;
const CANVAS_FIT_MARGIN = 48; // Onlook's FIT_MARGIN
function previewArea() {
  const [W, H] = win.getContentSize();
  if (dockMode) {
    const dockW = chatHidden ? 0 : Math.round(Math.max(330, Math.min(440, W * 0.34)));
    const showSidebar = !sidebarHidden && W >= 1000;
    try { if (sidebarView) sidebarView.setVisible(showSidebar); } catch {}
    const left = showSidebar ? SIDEBAR_W : 0;
    return { x: left, y: TAB_BAR_H, w: Math.max(200, W - left - dockW), h: H - TAB_BAR_H };
  }
  try { if (sidebarView) sidebarView.setVisible(false); } catch {}
  return { x: 0, y: TAB_BAR_H, w: W, h: H - TAB_BAR_H };
}
// ---------- route tabs (Onlook-style tab strip) ----------
let tabs = [];        // {view, route} — tab 0 is always pageView
let activeTab = 0;
let tabMenuOpen = false; // the top bar grows while its dropdowns are open
let multiCanvas = false; // show every open tab side by side on the canvas
const TAB_BAR_H = 38;
function activeView() { return (tabs[activeTab] && tabs[activeTab].view) || pageView; }
function broadcastTabs() {
  const state = {
    tabs: tabs.map((t) => t.route), active: activeTab, home: homeMode, sidebar: !sidebarHidden, chat: !chatHidden,
    ready: devState.state === 'running' && projectLoaded,
    phase: devState.state,
    sandbox: devState.sandbox ? { mode: devState.sandbox.mode, project: path.basename(devState.sandbox.folder) } : null,
  };
  if (tabbarView && !tabbarView.webContents.isDestroyed()) tabbarView.webContents.send('tabs:state', state);
}
function selectTab(i) {
  activeTab = Math.max(0, Math.min(i, tabs.length - 1));
  for (let k = 0; k < tabs.length; k++) {
    const isOn = multiCanvas ? true : k === activeTab;
    try { if (tabs[k].view !== pageView) tabs[k].view.setVisible(isOn); } catch {}
  }
  if (pageInMain) { try { pageView.setVisible(multiCanvas ? true : activeTab === 0); } catch {} }
  try { activeLoading = activeView().webContents.isLoading(); } catch { activeLoading = false; }
  broadcastTabs();
  overlaySend('page:nav', navInfo()); // the chip follows the active tab
  applyCanvas();
  applyLoader();
}
function trackTabRoute(wc, idx) {
  wc.on('did-navigate', (_e, url) => {
    if (pickerActive) cancelPicker();
    if (tabs[idx]) {
      try {
        const p = new URL(url).pathname || '/';
        if (!url.startsWith('file:')) tabs[idx].route = p;
      } catch {}
      broadcastTabs();
    }
    if (idx === activeTab) overlaySend('page:nav', navInfo());
  });
}
function openTab(route, force) {
  if (!devState.url) return { ok: false, error: 'No dev server running.' };
  const norm = String(route || '/').startsWith('/') ? String(route || '/') : '/' + route;
  const existing = tabs.findIndex((t) => t.route === norm);
  if (!force && existing >= 0) { selectTab(existing); return { ok: true, focused: true }; }
  if (tabs.length >= 6) return { ok: false, error: 'Too many tabs open.' };
  const v = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload-page.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  v.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  tabs.push({ view: v, route: norm });
  const idx = tabs.length - 1;
  trackTabRoute(v.webContents, idx);
  attachLoading(v.webContents, () => tabs[activeTab] && tabs[activeTab].view === v);
  restackViews();
  v.webContents.loadURL(devState.url.replace(/\/+$/, '') + norm).catch((e) => console.error('tab load failed', e.message));
  pushDevLog(`withlook: opened tab ${norm}`);
  selectTab(idx);
  return { ok: true };
}
function closeTab(i) {
  if (i <= 0 || i >= tabs.length) { selectTab(activeTab); return; } // tab 0 (the primary view) always stays
  const t = tabs[i];
  try { win.contentView.removeChildView(t.view); } catch {}
  try { t.view.webContents.destroy(); } catch {}
  tabs.splice(i, 1);
  if (activeTab >= i) activeTab = Math.max(0, activeTab - 1);
  selectTab(activeTab);
}
function closeExtraTabs() {
  for (let i = tabs.length - 1; i > 0; i--) closeTab(i);
  selectTab(0);
}
function restackViews() {
  try {
    const chrome = [overlayView, canvasBarView, panGlassView, tabbarView, sidebarView, loaderView];
    for (const v of [...chrome, ...tabs.map((t) => t.view)]) win.contentView.removeChildView(v);
    win.contentView.addChildView(pageView);
    for (const t of tabs) if (t.view !== pageView) win.contentView.addChildView(t.view);
    win.contentView.addChildView(loaderView);
    win.contentView.addChildView(panGlassView);
    win.contentView.addChildView(canvasBarView);
    win.contentView.addChildView(tabbarView);
    win.contentView.addChildView(sidebarView);
    win.contentView.addChildView(overlayView);
    if (tabMenuOpen) win.contentView.addChildView(tabbarView); // an open dropdown stays above the chat/sidebar
    // keep the visibility flags true after re-stacking
    for (let k = 0; k < tabs.length; k++) {
      const isOn = k === activeTab;
      if (tabs[k].view !== pageView) { try { tabs[k].view.setVisible(isOn); } catch {} }
    }
    if (pageInMain) { try { pageView.setVisible(activeTab === 0); } catch {} }
  } catch {}
}
function attachLoading(wc, isActive) {
  wc.on('did-start-loading', () => { if (isActive()) { activeLoading = true; applyLoader(); if (devState.state === 'running' && !projectLoaded) broadcastTabs(); } });
  wc.on('did-stop-loading', () => { if (isActive()) { activeLoading = false; applyLoader(); } });
  wc.on('did-finish-load', () => { if (isActive() && devState.state === 'running') { projectLoaded = true; broadcastTabs(); } });
  wc.on('did-fail-load', () => { if (isActive()) { projectLoaded = false; broadcastTabs(); } });
}
function applyLoader() {
  if (!loaderView || !win) return;
  const a = previewArea();
  try {
    loaderView.setBounds({ x: a.x, y: a.y, width: a.w, height: a.h });
    // show during startup and any in-flight page load — but not over the scaffold form
    const scaffolding = devState.state === 'starting' && devState.pm === 'create-next-app';
    loaderVisible = pageInMain && !homeMode && ((devState.state === 'starting' && !scaffolding) || (devState.state === 'running' && activeLoading));
    loaderView.setVisible(loaderVisible);
  } catch {}
}
function applyCanvas() {
  if (!win || !pageView || !canvasBarView || !panGlassView) return;
  const [W, H] = win.getContentSize();
  const a = previewArea();
  const showTopBar = pageInMain;
  const showCanvasBar = pageInMain && devState.state === 'running' && !homeMode;
  const fa = { x: a.x, y: a.y, w: a.w, h: a.h };
  const w = Math.round(fa.w * canvas.zoom);
  const h = Math.round(fa.h * canvas.zoom);
  let x = fa.x + Math.round((fa.w - w) / 2) + canvas.x;
  let y = fa.y + Math.round((fa.h - h) / 2) + canvas.y;
  x = Math.min(Math.max(x, fa.x - w + 120), fa.x + fa.w - 120);
  y = Math.min(Math.max(y, fa.y - h + 120), fa.y + fa.h - 120);
  if (multiCanvas && pageInMain) {
    // every tab side by side on the same canvas
    const GAP = 40;
    const baseX = fa.x + Math.round((fa.w - w) / 2) + canvas.x;
    const baseY = fa.y + Math.round((fa.h - h) / 2) + canvas.y;
    tabs.forEach((t, i) => {
      try { t.view.setBounds({ x: baseX + i * (w + GAP), y: baseY, width: w, height: h }); } catch {}
    });
  } else {
    for (const t of tabs) {
      try { t.view.setBounds({ x, y, width: w, height: h }); } catch {}
    }
  }
  if (pageInMain) {
    try { pageView.setBorderRadius(canvas.zoom !== 1 ? 10 : 0); } catch {}
  }
  try {
    if (tabbarView) {
      const barH = tabMenuOpen ? H : TAB_BAR_H; // full height when a dropdown is open, so its backdrop covers the whole window
      tabbarView.setBounds({ x: 0, y: 0, width: W, height: barH });
      tabbarView.setVisible(showTopBar);
    }
    applyLoader();
    const bw = 344; // wide enough for every dock control
    canvasBarView.setBounds({ x: a.x + Math.round((a.w - bw) / 2), y: a.y + a.h - 42 - 14, width: bw, height: 42 });
    canvasBarView.setVisible(showCanvasBar);
    panGlassView.setBounds({ x: fa.x, y: fa.y, width: fa.w, height: fa.h });
    panGlassView.setVisible(showCanvasBar && canvas.panMode);
    if (sidebarView) sidebarView.setBounds({ x: 0, y: TAB_BAR_H, width: SIDEBAR_W, height: H - TAB_BAR_H });
    if (!canvasBarView.webContents.isDestroyed()) {
      canvasBarView.webContents.send('canvas:state', { ...canvas, frames: tabs.length, dev: devState.state, dock: dockMode, multi: multiCanvas });
    }
  } catch {}
}
function toggleFloat() {
  setPanelOpen(!(panelOpen && dockMode)); // docked → float · otherwise dock/open
}
function toggleSidebar() {
  sidebarHidden = !sidebarHidden;
  layout();
  broadcastTabs();
  return { hidden: sidebarHidden };
}
function toggleChat() {
  if (chatHidden) setPanelOpen(true);
  else { chatHidden = true; layout(); broadcastTabs(); }
  return { hidden: chatHidden };
}
function doCanvasAction(action, data) {
  switch (action) {
    case 'in': canvas.zoom = Math.min(3, Math.round(canvas.zoom * 1.25 * 1000) / 1000); break;
    case 'out': canvas.zoom = Math.max(0.25, Math.round(canvas.zoom / 1.25 * 1000) / 1000); break;
    case 'fit': canvas.zoom = 1; canvas.x = 0; canvas.y = 0; break;
    case 'panMode': canvas.panMode = !!data; break;
    case 'pan': canvas.x += (data && data.dx) || 0; canvas.y += (data && data.dy) || 0; break;
    case 'clearFrames': closeExtraTabs(); break;
    case 'openTab': if (data) openTab(String(data)); break;
    case 'openTabForce': if (data) openTab(String(data), true); break;
    case 'selectTab': selectTab(Number(data) || 0); break;
    case 'closeTab': closeTab(Number(data) || 0); break;
    case 'stopDev': stopDev(); break;
    case 'restartDev': restartDev(); break;
    case 'toggleFloat': toggleFloat(); break;
    case 'toggleSidebar': toggleSidebar(); break;
    case 'toggleChat': toggleChat(); break;
    case 'home': openHome(); break;
    case 'multiCanvas': multiCanvas = !multiCanvas; if (!multiCanvas) selectTab(activeTab); applyCanvas(); break;
    case 'menu': {
      const open = !!data;
      tabMenuOpen = open;
      // the dropdown is a modal: raise the bar above the docked sidebar/chat so it can't be covered
      try {
        if (open) win.contentView.addChildView(tabbarView);
        else { win.contentView.addChildView(sidebarView); win.contentView.addChildView(overlayView); }
      } catch {}
      applyCanvas();
      break;
    }
    case 'newChat': overlaySend('ui:newChat', {}); break;
    case 'history': overlaySend('ui:openHistory', {}); break;
    case 'settings': overlaySend('ui:openSettings', {}); break;
  }
  applyCanvas();
}

function layout() {
  if (!win || !pageView || !overlayView) return;
  const [W, H] = win.getContentSize();
  applyCanvas();
  if (settingsModal) {
    // settings is a global modal: the overlay covers the window and dims the page/dashboard
    overlayView.setBounds({ x: 0, y: 0, width: W, height: H });
    overlayVisible = true;
    try { overlayView.setVisible(true); } catch {}
    return;
  }
  if (dockMode && chatHidden) {
    // chat hidden: the preview owns the space; the docked panel is gone
    overlayVisible = false;
    try { overlayView.setVisible(false); } catch {}
    return;
  }
  if (dockMode) {
    // Onlook-style editor layout: preview left, chat docked right (both below the top bar)
    const dockW = Math.round(Math.max(330, Math.min(440, W * 0.34)));
    overlayView.setBounds({ x: W - dockW, y: TAB_BAR_H, width: dockW, height: H - TAB_BAR_H });
    overlayVisible = true;
    try { overlayView.setVisible(true); } catch {}
    return;
  }
  const w = Math.min(OVERLAY_W, W - 24);
  const yBase = TAB_BAR_H + TOP_GAP; // everything sits below the app top bar
  const h = panelOpen ? Math.min(PANEL_VIEW_H, H - yBase - 16) : PILL_H;
  overlayView.setBounds({
    x: Math.round((W - w) / 2),
    y: yBase,
    width: w,
    height: h,
  });
  // the chat pill only exists while there is work to talk about
  overlayVisible = !chatHidden && (panelOpen || dockMode || (devState.state === 'running' && !homeMode));
  try { overlayView.setVisible(overlayVisible); } catch {}
}
function setPanelOpen(open) {
  panelOpen = !!open;
  if (panelOpen) chatHidden = false;
  dockMode = panelOpen && devState.state === 'running' && !homeMode;
  // full-screen (float) mode frames the page at 80% by default; docked is 100%
  if (devState.state === 'running' && pageInMain) canvas.zoom = dockMode ? 1 : 0.8;
  layout();
  overlaySend('ui:mode', { open: panelOpen, dock: dockMode, preview: !!(previewWin && !previewWin.isDestroyed()) });
  return { open: panelOpen, dock: dockMode };
}

// ---------- preview window (small, movable) ----------
function showPreviewWindow() {
  try {
    if (previewWin && !previewWin.isDestroyed()) { previewWin.show(); previewWin.focus(); return; }
    multiCanvas = false; // pop-out shows a single tab
    selectTab(0); // the pop-out always shows the primary tab
    const [mx, my] = win.getPosition();
    const [mw, mh] = win.getSize();
    previewWin = new BrowserWindow({
      width: 480, height: Math.min(760, mh - 80), minWidth: 320, minHeight: 380,
      x: Math.max(0, mx + mw - 520), y: my + 60,
      backgroundColor: '#0b0d12',
      title: 'withlook — preview',
      parent: win,
      webPreferences: {},
    });
    try { win.contentView.removeChildView(pageView); } catch {}
    previewWin.contentView.addChildView(pageView);
    pageInMain = false;
    layout(); // hides the canvas chrome while the preview is popped out
    layout();
    overlaySend('ui:mode', { open: panelOpen, dock: dockMode, preview: true });
    const fit = () => {
      if (!previewWin || previewWin.isDestroyed()) return;
      const [w, h] = previewWin.getContentSize();
      pageView.setBounds({ x: 0, y: 0, width: w, height: h });
    };
    fit();
    previewWin.on('resize', fit);
    previewWin.on('close', () => {
      try { previewWin.contentView.removeChildView(pageView); } catch {}
      restackViews();
      pageInMain = true;
      layout();
    });
    previewWin.on('closed', () => {
      previewWin = null;
      layout();
      overlaySend('ui:mode', { open: panelOpen, dock: dockMode, preview: false });
      if (win && !win.isDestroyed() && devState.state !== 'running') {
        pageView.webContents.loadFile(PLACEHOLDER_FILE).catch(() => {});
      } // while running, the page simply returns to the docked editor layout
    });
  } catch (e) { console.error('preview window failed', e.message); }
}
function resetToWelcome() {
  if (quitting) return; // no page loads during shutdown
  homeMode = true;
  broadcastTabs();
  try {
    if (previewWin && !previewWin.isDestroyed()) previewWin.close();
  } catch {}
  try {
    if (win && !win.isDestroyed() && !win.contentView.children.includes(pageView)) restackViews();
    pageInMain = true;
    canvas.zoom = 1; canvas.x = 0; canvas.y = 0; canvas.panMode = false; // camera home
    layout();
    pageView.webContents.loadFile(PLACEHOLDER_FILE).catch(() => {});
  } catch {}
}
function openHome() {
  if (quitting) return;
  if (settingsModal) { settingsModal = false; overlaySend('ui:closeSettings', {}); }
  homeMode = true;
  broadcastTabs();
  if (panelOpen) setPanelOpen(false); // the dashboard owns the window
  try { if (previewWin && !previewWin.isDestroyed()) previewWin.close(); } catch {}
  try {
    if (win && !win.isDestroyed() && !win.contentView.children.includes(pageView)) restackViews();
    pageInMain = true;
    canvas.zoom = 1; canvas.x = 0; canvas.y = 0; canvas.panMode = false;
    pageView.webContents.loadFile(PLACEHOLDER_FILE).catch(() => {});
    layout();
    overlaySend('ui:mode', { open: panelOpen, dock: dockMode, preview: false });
  } catch {}
}

// ---------- picker ----------
const pickerSource = fs.readFileSync(path.join(__dirname, 'picker-inject.js'), 'utf8');
function startPicker() {
  if (!pageView) return;
  if (pickerActive) { cancelPicker(); return; } // toggle off
  pickerActive = true;
  overlaySend('picker:state', { active: true });
  activeView().webContents
    .executeJavaScript(pickerSource, true)
    .catch((e) => console.error('picker inject failed', e));
}
function cancelPicker(notify = true) {
  if (!pageView) return;
  try {
    activeView().webContents
      .executeJavaScript('window.__wlPicker ? window.__wlPicker.stop() : undefined', true)
      .catch(() => {});
  } catch {}
  pickerActive = false;
  if (notify) overlaySend('picker:state', { active: false });
}
function handlePickerResult(_e, data) {
  pickerActive = false;
  overlaySend('picker:result', data);
  overlaySend('picker:state', { active: false });
}

// ---------- source search ----------
const { findSourcesInFolder } = require('./source-search');
const { MemoryStore } = require('./store');
let store = null;

async function findSources(_e, sel) {
  try {
    const folder = devState.folder;
    if (!folder) return { ok: false, error: 'Open a project first.' };
    return await findSourcesInFolder(folder, sel);
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
function openInEditor(_e, { file, line }) {
  const settings = loadSettings();
  const cmd = (settings.editor || 'code').trim() || 'code';
  const args = line ? ['-g', `${file}:${line}`] : [file];
  return new Promise((resolve) => {
    try {
      const p = spawn(cmd, args, { detached: process.platform !== 'win32', stdio: 'ignore', shell: true });
      p.on('error', () => { shell.openPath(file); resolve(true); });
      p.unref();
      resolve(true);
    } catch { shell.openPath(file); resolve(true); }
  });
}

// ---------- existing dev servers ----------
const sh = (cmd, args) => new Promise((res) => {
  execFile(cmd, args, { maxBuffer: 1024 * 1024, timeout: 5000 }, (e, o) => res(e ? null : o));
});
async function findExistingDevServer(folder) {
  for (let port = 3000; port <= 3012; port++) {
    const pids = await sh('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
    if (!pids) continue;
    for (const pid of pids.split('\n').filter(Boolean)) {
      const cwdOut = await sh('lsof', ['-p', pid, '-a', '-d', 'cwd', '-Fn']);
      const m = cwdOut ? cwdOut.match(/\nn(.+)/) : null;
      const cwd = m ? m[1].trim() : '';
      const cmd = await sh('ps', ['-o', 'command=', '-p', pid]);
      const cmdMatch = !!cmd && cmd.includes(folder);
      const cwdMatch = !!cwd && (cwd === folder || cwd.startsWith(folder + path.sep) || folder.startsWith(cwd + path.sep));
      if (cwdMatch || cmdMatch) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(2500) });
          if (r.status < 500) return port;
        } catch {}
      }
    }
  }
  return null;
}
function attachDevServer(port, folder) {
  projectLoaded = false;
  const localUrl = `http://localhost:${port}`;
  if (tabs[0]) tabs[0].route = '/';
  pushDevLog(`withlook: found a dev server already running for this project on :${port} — attaching`);
  pushDevLog(`withlook: server is up → ${localUrl}`);
  setDevStatus({ state: 'running', port, url: localUrl, external: true });
  overlaySend('git:refresh', {});
  if (store) {
    store.upsertProject({ folder, name: path.basename(folder), pm: devState.pm, port })
      .catch((e) => console.error('store upsert failed', e.message));
  }
  loadPageUrl(localUrl);
  setPanelOpen(true);
  for (const t of tabs) {
    try { t.view.webContents.loadURL(localUrl.replace(/\/+$/, '') + t.route).catch(() => {}); } catch {}
  }
}

// ---------- dev server ----------
function resolveProjectFolder(folder) {
  if (!folder) return null;
  if (fs.existsSync(path.join(folder, 'package.json'))) return folder;
  // users often pick the parent of the app (e.g. ~/Developer/jyt-web/jyt-web)
  try {
    const children = fs.readdirSync(folder, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && fs.existsSync(path.join(folder, d.name, 'package.json')));
    if (children.length === 1) return path.join(folder, children[0].name);
  } catch {}
  return null;
}
function detectPM(folder) {
  const exists = (f) => fs.existsSync(path.join(folder, f));
  if (exists('bun.lockb') || exists('bun.lock')) return 'bun';
  if (exists('pnpm-lock.yaml')) return 'pnpm';
  if (exists('yarn.lock')) return 'yarn';
  return 'npm';
}
// Next 16 defaults to Turbopack, which rejects a node_modules symlink pointing
// outside the sandbox. In a sandbox, run the same `next dev` on webpack instead.
function nextDevPlan(folder) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'));
    const script = String((pkg.scripts && pkg.scripts.dev) || '');
    if (!/\bnext\s+dev\b/.test(script)) return null;
    if (/\s--webpack\b/.test(script)) return null;
    let ver = (pkg.dependencies && pkg.dependencies.next) || (pkg.devDependencies && pkg.devDependencies.next) || '';
    if (!/\d/.test(ver)) {
      try { ver = JSON.parse(fs.readFileSync(path.join(folder, 'node_modules', 'next', 'package.json'), 'utf8')).version; } catch {}
    }
    const major = Number(String(ver).replace(/^[^\d]*/, '').split('.')[0]) || 0;
    const turbopack = major >= 16 || /--turbopack|--turbo\b/.test(script);
    if (!turbopack) return null;
    const m = script.match(/next\s+dev([^&|;]*)/);
    const extra = m ? m[1].trim().split(/\s+/).filter((x) => x && !/^--turbopack$|^--turbo$/.test(x)) : [];
    return { major, extra };
  } catch { return null; }
}
function pushDevLog(line) {
  const l = line.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
  if (!l.trim()) return;
  devLogs.push(l);
  if (devLogs.length > 400) devLogs.shift();
  overlaySend('dev:log', l);
}
function setDevStatus(patch) {
  devState = { ...devState, ...patch };
  overlaySend('dev:status', devState);
  layout(); // refresh canvas chrome visibility
  broadcastTabs();
}
function killProc(proc) {
  if (!proc) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F']);
    else process.kill(-proc.pid, 'SIGTERM');
  } catch { try { proc.kill(); } catch {} }
}
function stopDev(keepView) {
  projectLoaded = false;
  tabMenuOpen = false; // the top-bar dropdowns close with the project
  if (!keepView) closeExtraTabs(); // a restart (keepView) reloads its tabs when the server returns
  if (createProc) { createCancelled = true; killProc(createProc); createProc = null; }
  if (devProc) { killProc(devProc); devProc = null; }
  if (devWait) { clearTimeout(devWait); devWait = null; }
  if (devState.state !== 'idle') setDevStatus({ state: 'idle', url: null, port: null, error: null, external: false });
  if (!keepView) {
    setPanelOpen(false); // undock → back to the floating pill
    resetToWelcome();
  }
}
let restartTimer = null;
function restartDev() {
  const folder = devState.projectFolder || devState.folder;
  if (!folder) return { ok: false, error: 'No project is loaded.' };
  if (restartTimer) clearTimeout(restartTimer); // debounce repeated restart presses
  pushDevLog('withlook: restarting the dev server…');
  stopDev(true); // keep the project view; the server comes straight back up
  restartTimer = setTimeout(() => { restartTimer = null; startDev(folder); }, 700);
  return { ok: true };
}
async function startDev(folder) {
  homeMode = false; // leaving the dashboard for a live preview
  projectLoaded = false;
  broadcastTabs();
  stopDev(true); // keep the current view — the new page loads when the server is up
  devLogs = [];
  if (tabs[0]) tabs[0].route = '/'; // a new project always starts at its root, never the previous route
  const settings = loadSettings();
  devState.projectFolder = folder;
  let runFolder = folder;
  const sandboxBase = () => path.join(app.getPath('userData'), 'worktrees');

  if (settings.sandbox !== false) {
    const reusable = devState.sandbox && devState.sandbox.folder === folder && fs.existsSync(devState.sandbox.projectPath);
    if (reusable) {
      runFolder = devState.sandbox.projectPath;
      pushDevLog(`withlook: reusing sandbox at ${runFolder}`);
    } else {
      if (devState.sandbox) {
        const q = sandbox.cleanupOnQuit(devState.sandbox);
        if (q.kept) pushDevLog(`withlook: kept the previous sandbox at ${q.path}`);
        devState.sandbox = null;
      }
      setDevStatus({ state: 'starting', folder, projectFolder: folder, pm: null, port: null, url: null, error: null, external: false });
      pushDevLog('withlook: creating an isolated sandbox (your folder is not touched)…');
      const sb = await sandbox.createSandbox({ folder, baseDir: sandboxBase() });
      if (sb.ok) {
        devState.sandbox = sb;
        runFolder = sb.projectPath;
        pushDevLog(`withlook: sandbox (${sb.mode}) ready at ${runFolder}`);
      } else {
        pushDevLog('withlook: sandbox failed — running in the project folder: ' + sb.error);
      }
    }
  } else if (devState.sandbox) {
    const q = sandbox.cleanupOnQuit(devState.sandbox);
    if (q.kept) pushDevLog(`withlook: kept the sandbox at ${q.path}`);
    devState.sandbox = null;
  }

  const pm = detectPM(runFolder);
  setDevStatus({ state: 'starting', folder: runFolder, projectFolder: folder, sandbox: devState.sandbox, pm, port: null, url: null, error: null, external: false });
  broadcastTabs();
  // only attach to an already-running server when we're editing in place
  if (!devState.sandbox) {
    const existing = await findExistingDevServer(folder);
    if (existing) { attachDevServer(existing, folder); return; }
  }
  let cmd = pm, cmdArgs = ['run', 'dev'];
  const plan = devState.sandbox ? nextDevPlan(runFolder) : null;
  if (plan) {
    if (pm === 'pnpm') { cmd = 'pnpm'; cmdArgs = ['exec', 'next', 'dev', ...plan.extra, '--webpack']; }
    else if (pm === 'yarn') { cmd = 'yarn'; cmdArgs = ['next', 'dev', ...plan.extra, '--webpack']; }
    else if (pm === 'bun') { cmd = 'bunx'; cmdArgs = ['next', 'dev', ...plan.extra, '--webpack']; }
    else { cmd = 'npx'; cmdArgs = ['next', 'dev', ...plan.extra, '--webpack']; }
    pushDevLog(`withlook: Next ${plan.major} + sandbox — using webpack (Turbopack rejects the linked node_modules)`);
  }
  pushDevLog(`$ ${cmd} ${cmdArgs.join(' ')}  (in ${runFolder})`);
  let proc;
  try {
    proc = spawn(cmd, cmdArgs, {
      cwd: runFolder,
      env: { ...process.env, BROWSER: 'none', FORCE_COLOR: '0' },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    setDevStatus({ state: 'error', error: `Failed to spawn ${pm}: ${e.message}` });
    return;
  }
  devProc = proc;
  let portFound = false;
  let lockRetryDone = false;
  const onLine = (line) => {
    pushDevLog(line);
    if (!portFound) {
      const m = line.match(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\])[:\s](\d{2,5})/i);
      if (m) { portFound = true; waitForPort(Number(m[1]), proc); }
    }
  };
  readline.createInterface({ input: proc.stdout }).on('line', onLine);
  readline.createInterface({ input: proc.stderr }).on('line', onLine);
  proc.on('error', (e) => {
    pushDevLog(`[error] ${e.message}`);
    if (devProc === proc) setDevStatus({ state: 'error', error: e.message });
  });
  proc.on('exit', async (code) => {
    if (devProc === proc) {
      devProc = null;
      // the page is already being served (another instance owned the port) — keep it
      if (devState.state === 'running' && devState.folder === folder) {
        pushDevLog('withlook: dev process exited, but a server is still responding — keeping the session');
        return;
      }
      // next dev refuses to run twice for one project (lock held) — attach or clear a stale lock
      if (devLogs.some((l) => /Unable to acquire lock/i.test(l))) {
        let live = await findExistingDevServer(folder);
        if (!live) {
          // a booting instance may not have opened its port yet — give it a few seconds
          for (let i = 0; i < 6 && !live; i++) { await sleep(800); live = await findExistingDevServer(folder); }
        }
        if (live) { attachDevServer(live, folder); return; }
        if (!lockRetryDone) {
          lockRetryDone = true;
          try {
            fs.rmSync(path.join(folder, '.next', 'dev', 'lock'), { force: true });
            pushDevLog('withlook: no live server found — removed the stale next dev lock, retrying…');
            startDev(folder);
            return;
          } catch (e) {
            pushDevLog('withlook: could not remove the stale lock: ' + e.message);
          }
        }
        setDevStatus({ state: 'error', error: 'Another next dev instance is running for this project. Close it, then try again.' });
        return;
      }
      setDevStatus({ state: 'error', error: `Dev server exited (code ${code}). See logs.` });
    }
  });
  devWait = setTimeout(() => {
    devWait = null;
    if (devProc === proc && !portFound) { portFound = true; waitForPort(3000, proc); }
  }, 25000);
}
async function waitForPort(port, proc) {
  const healthUrls = [`http://127.0.0.1:${port}`, `http://localhost:${port}`]; // covers IPv4-only and IPv6/localhost binds
  const localUrl = `http://localhost:${port}`;
  const deadline = Date.now() + 90000;
  let lastNote = 0;
  pushDevLog(`withlook: waiting for ${localUrl} …`);
  while (Date.now() < deadline) {
    if (devProc !== proc) return; // stopped/restarted
    let res = null;
    for (const hu of healthUrls) {
      try { res = await fetch(hu, { signal: AbortSignal.timeout(8000) }); break; } catch {}
      if (devProc !== proc) return;
    }
    try {
      if (res && res.status < 500) {
        if (devProc !== proc) return;
        setDevStatus({ state: 'running', port, url: localUrl });
        pushDevLog(`withlook: server is up → ${localUrl}`);
        refreshGitViews();
        if (store) {
          store.upsertProject({ folder: devState.projectFolder || devState.folder, name: path.basename(devState.projectFolder || devState.folder), pm: devState.pm, port })
            .catch((e) => console.error('store upsert failed', e.message));
        }
        try {
          loadPageUrl(localUrl);
          setPanelOpen(true); // dock the chat panel next to the preview, Onlook-style
        } catch (e) {
          pushDevLog(`withlook: failed to open the page: ${e.message}`);
        }
        for (const t of tabs) {
          try { t.view.webContents.loadURL(localUrl.replace(/\/+$/, '') + t.route).catch(() => {}); } catch {}
        }
        return;
      }
    } catch (e) {
      if (Date.now() - lastNote > 15000) {
        lastNote = Date.now();
        pushDevLog(`withlook: still waiting for ${localUrl} … (${Math.round((deadline - Date.now()) / 1000)}s left)`);
      }
    }
    await sleep(1200);
  }
  if (devProc === proc) {
    setDevStatus({ state: 'error', error: 'Timed out waiting for the dev server — check the logs.' });
    pushDevLog('withlook: timed out. Last output:\n' + devLogs.slice(-8).join('\n'));
  }
}

// ---------- page ----------
function loadPageUrl(url) {
  if (!pageView) return;
  activeView().webContents.loadURL(url).catch((e) => overlaySend('page:error', { error: e.message }));
}
function navInfo() {
  const wc = pageView ? activeView().webContents : null;
  if (!wc) return { url: '', title: '', canBack: false, canFwd: false };
  let canBack = false, canFwd = false;
  try { canBack = wc.navigationHistory.canGoBack(); canFwd = wc.navigationHistory.canGoForward(); }
  catch { try { canBack = wc.canGoBack(); canFwd = wc.canGoForward(); } catch {} }
  return { url: wc.getURL(), title: wc.getTitle(), canBack, canFwd };
}
function navGo(dir) {
  const wc = pageView && pageView.webContents;
  if (!wc) return;
  try { dir === -1 ? wc.navigationHistory.goBack() : wc.navigationHistory.goForward(); }
  catch { dir === -1 ? wc.goBack() : wc.goForward(); }
}
const PLACEHOLDER_FILE = path.join(__dirname, '..', 'renderer', 'placeholder.html');
const CREATE_FILE = path.join(__dirname, '..', 'renderer', 'create-project.html');
const STATUS_FILE = path.join(__dirname, '..', 'renderer', 'status.html');

// ---------- git (project code changes) ----------
const { execFile } = require('node:child_process');
function repoFromRemote(url) {
  if (!url) return '';
  const s = String(url).trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const m = s.match(/[:/]([^/:]+\/[^/:]+)$/);
  return m ? m[1] : s;
}
function repoFromFolder(folder) {
  try {
    const cfg = fs.readFileSync(path.join(folder, '.git', 'config'), 'utf8');
    const m = cfg.match(/\[remote "origin"\][\s\S]*?\n\s*url\s*=\s*(.+)/);
    return m ? repoFromRemote(m[1].trim()) : '';
  } catch { return ''; }
}
function gitFolder(scope) {
  return scope === 'sandbox' && devState.sandbox ? devState.folder : (devState.projectFolder || devState.folder);
}
function gitStatus(scope) {
  const folder = gitFolder(scope);
  if (!folder) return Promise.resolve({ ok: false, error: 'no project' });
  const run = (args) => new Promise((resolve) => {
    execFile('git', args, { cwd: folder, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });
  return (async () => {
    const branch = await run(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branch === null) return { ok: false, error: 'not a git repository' };
    const [statusOut, numstatOut, remoteOut] = await Promise.all([
      run(['status', '--porcelain=v1', '-z']),
      run(['diff', 'HEAD', '--numstat', '-z']),
      run(['remote', 'get-url', 'origin']),
    ]);
    const remote = remoteOut ? remoteOut.trim() : '';
    const repo = repoFromRemote(remote);
    const stats = {};
    if (numstatOut) {
      for (const chunk of numstatOut.split('\0')) {
        if (!chunk) continue;
        const m = chunk.match(/^(-|\d+)\t(-|\d+)\t(.+)$/);
        if (m) stats[m[3]] = { adds: m[1] === '-' ? null : Number(m[1]), dels: m[2] === '-' ? null : Number(m[2]) };
      }
    }
    const files = [];
    if (statusOut) {
      const parts = statusOut.split('\0');
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (!p) continue;
        const status = p.slice(0, 2);
        let file = p.slice(3);
        if (status[0] === 'R' || status[0] === 'C') i++; // skip the rename origin chunk
        if (!file) continue;
        if (status === '??' && /^\.env(\..+)?$/.test(path.basename(file))) continue; // keep secrets out of the change report
        const st = stats[file] || {};
        files.push({ status, path: file, abs: path.join(folder, file), adds: st.adds, dels: st.dels });
      }
    }
    return { ok: true, branch: branch.trim(), repo, remote, files };
  })();
}

// ---------- pages (Onlook-style route list) ----------
const PAGE_FILE = /^page\.(tsx|ts|jsx|js|mdx)$/;
async function listPages() {
  const folder = devState.folder;
  if (!folder) return [];
  const found = [];
  const scan = async (root, isAppRouter) => {
    const fullRoot = path.join(folder, root);
    if (!fs.existsSync(fullRoot)) return;
    const walk = async (dir, rel, depth) => {
      if (depth > 7 || found.length > 200) return;
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        if (ent.name.startsWith('_') || ent.name.startsWith('.') || ent.name === 'node_modules') continue;
        const relPath = rel ? `${rel}/${ent.name}` : ent.name;
        if (ent.isDirectory()) await walk(path.join(dir, ent.name), relPath, depth + 1);
        else if (ent.isFile()) {
          if (isAppRouter) {
            if (PAGE_FILE.test(ent.name)) {
              let route = rel.replace(/\(([^)]+)\)\//g, '').replace(/\(([^)]+)\)/g, '');
              route = route.replace(/\[+\.\.\.([^\]]+)\]+/g, '*').replace(/\[([^\]]+)\]/g, ':$1');
              found.push({ route: '/' + (route || ''), file: path.join(dir, ent.name) });
            }
          } else if (/\.(tsx|ts|jsx|js|mdx)$/.test(ent.name)) {
            const route = relPath.replace(/\.(tsx|ts|jsx|js|mdx)$/, '').replace(/\/index$/, '').replace(/\[+\.\.\.([^\]]+)\]+/g, '*').replace(/\[([^\]]+)\]/g, ':$1');
            found.push({ route: '/' + route, file: path.join(dir, ent.name) });
          }
        }
      }
    };
    await walk(fullRoot, '', 0);
  };
  await scan('src/app', true);
  if (!found.length) await scan('app', true);
  if (!found.length) await scan('src/pages', false);
  if (!found.length) await scan('pages', false);
  const seen = new Set();
  return found.filter((p) => (seen.has(p.route) ? false : (seen.add(p.route), true))).sort((a, b) => a.route.localeCompare(b.route));
}

// ---------- opencode discovery ----------
let opencodePath = null;
function findOpencode() {
  if (opencodePath) return opencodePath;
  const candidates = [
    path.join(os.homedir(), '.opencode', 'bin', 'opencode'),
    '/opt/homebrew/bin/opencode',
    '/usr/local/bin/opencode',
  ];
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); opencodePath = c; return c; } catch {}
  }
  opencodePath = 'opencode'; // fall back to PATH
  return opencodePath;
}
function opencodeList() {
  const bin = findOpencode();
  const run = (args) => new Promise((resolve) => {
    execFile(bin, args, { maxBuffer: 8 * 1024 * 1024, timeout: 30000 }, (err, stdout) => resolve(err ? null : stdout));
  });
  return (async () => {
    const modelsOut = await run(['models']);
    if (modelsOut === null) return { ok: false, error: 'opencode CLI not found on PATH' };
    const models = modelsOut.split('\n').map((l) => l.trim()).filter(Boolean);
    const agents = new Set(['build', 'plan']);
    const jsoncFiles = [
      path.join(require('node:os').homedir(), '.config', 'opencode', 'opencode.jsonc'),
      path.join(require('node:os').homedir(), '.config', 'opencode', 'opencode.json'),
      devState.folder ? path.join(devState.folder, 'opencode.jsonc') : null,
      devState.folder ? path.join(devState.folder, 'opencode.json') : null,
    ].filter(Boolean);
    for (const f of jsoncFiles) {
      try {
        const raw = fs.readFileSync(f, 'utf8').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
        const cfg = JSON.parse(raw);
        if (cfg.agent && typeof cfg.agent === 'object') Object.keys(cfg.agent).forEach((k) => agents.add(k));
        if (cfg.$schema || cfg.mcp) { /* fine */ }
      } catch {}
    }
    for (const dir of [path.join(require('node:os').homedir(), '.config', 'opencode', 'agent'),
      devState.folder ? path.join(devState.folder, '.opencode', 'agent') : null].filter(Boolean)) {
      try { for (const f of fs.readdirSync(dir)) if (/\.md$/i.test(f)) agents.add(f.replace(/\.md$/i, '')); } catch {}
    }
    return { ok: true, models, agents: [...agents] };
  })();
}

// ---------- write mode ----------
function writeCodeFile(_e, { file, content }) {
  const folder = devState.folder;
  if (!folder) return { ok: false, error: 'No project is running.' };
  const abs = path.isAbsolute(file) ? file : path.resolve(folder, file);
  if (abs !== folder && !abs.startsWith(folder + path.sep)) return { ok: false, error: 'Refusing to write outside the project folder.' };
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, String(content));
    overlaySend('git:refresh', {}); // sidebar shows the change immediately
    return { ok: true, file: abs };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function gitDiff(_e, { file, scope }) {
  const folder = gitFolder(scope);
  if (!folder || !file) return Promise.resolve({ ok: false, error: 'No project/file.' });
  return new Promise((resolve) => {
    execFile('git', ['diff', 'HEAD', '--', file], { cwd: folder, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: err.message.slice(0, 300) });
      resolve({ ok: true, diff: String(stdout || '').slice(0, 60000) });
    });
  });
}

function gitCommit(_e, { message }) {
  const folder = gitFolder('project');
  if (!folder) return Promise.resolve({ ok: false, error: 'No project loaded.' });
  const msg = String(message || '').trim();
  if (!msg) return Promise.resolve({ ok: false, error: 'Commit message required.' });
  return new Promise((resolve) => {
    execFile('git', ['add', '-A'], { cwd: folder, maxBuffer: 4 * 1024 * 1024 }, (e1) => {
      if (e1) return resolve({ ok: false, error: e1.message.slice(0, 400) });
      execFile('git', ['commit', '-m', msg], { cwd: folder, maxBuffer: 4 * 1024 * 1024 }, (e2, stdout, stderr) => {
        if (e2) return resolve({ ok: false, error: String(stderr || e2.message).trim().slice(0, 500) });
        pushDevLog('withlook: committed — ' + msg);
        refreshGitViews();
        const first = String(stdout || '').split('\n')[0] || 'committed';
        resolve({ ok: true, output: first.slice(0, 200) });
      });
    });
  });
}

function gitPush() {
  const folder = gitFolder('project');
  if (!folder) return Promise.resolve({ ok: false, error: 'No project loaded.' });
  const run = (args) => new Promise((resolve) => {
    execFile('git', args, { cwd: folder, maxBuffer: 4 * 1024 * 1024, timeout: 60000 }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
  return (async () => {
    let r = await run(['push']);
    if (r.err) r = await run(['push', '-u', 'origin', 'HEAD']);
    if (r.err) return { ok: false, error: String(r.stderr || r.err.message).trim().slice(0, 800) };
    pushDevLog('withlook: pushed to origin');
    refreshGitViews();
    return { ok: true, output: String(r.stdout || r.stderr).trim().slice(-300) || 'pushed' };
  })();
}

function isRealProject(p) {
  if (!p || !p.folder) return false;
  const f = p.folder;
  if (f.startsWith('/tmp/') || f.startsWith(os.tmpdir())) return false; // test fixtures
  return !!resolveProjectFolder(f);
}

// ---------- AI ----------
const { buildSystemPrompt } = require('./prompt');
// first line (in the new file) touched by a unified diff — used for the live edit card
function firstChangedLine(patch) {
  const lines = String(patch || '').split('\n');
  let newLine = 0;
  for (const ln of lines) {
    const h = ln.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (h) { newLine = Number(h[1]); continue; }
    if (!newLine) continue;
    if (ln.startsWith('+') && !ln.startsWith('+++')) return newLine;
    if (ln.startsWith('-') && !ln.startsWith('---')) continue; // deletions don't advance the new file
    if (ln.startsWith(' ')) newLine++;
  }
  return null;
}

async function handleChatSend(_e, { id, messages, context }) {
  const settings = loadSettings();
  const sys = buildSystemPrompt(settings, context, settings.agent);
  const msgs = [{ role: 'system', content: sys },
    ...(Array.isArray(messages) ? messages : []).map((m) => ({ role: m.role, content: String(m.content || '') }))];

  // ---- opencode agent: a local coding agent edits the repo directly ----
  if (settings.agent === 'opencode') {
    const folder = devState.folder;
    if (!folder) { overlaySend('chat:error', { id, error: 'Open a project first — opencode runs inside it.' }); return; }
    const oc = settings.opencode || {};
    const args = ['run', '--auto', '--format', 'json'];
    if (oc.model) args.push('--model', oc.model);
    if (oc.agent) args.push('--agent', oc.agent);
    const prompt =
      `You are running inside the user's project at ${folder}. ` +
      'The chat context below may include selected page elements and their source code excerpts — use that context and make the requested change directly. ' +
      'Do not explore the whole codebase or read unrelated configuration/settings files unless strictly necessary. ' +
      'Do not narrate your investigation ("Let me look…", "Let me check…") — keep progress notes brief and put the result and the changes in your final answer. ' +
      'Do not modify config files (package.json, tsconfig, opencode config) unless explicitly asked.\n\n' +
      msgs.map((m) => (m.role === 'system' ? m.content : `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)).join('\n\n');
    args.push(prompt);
    let proc;
    try {
      // no shell: the args array (with its multiline prompt) passes verbatim via execve
      proc = spawn(findOpencode(), args, { cwd: folder, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } });
    } catch (e) { overlaySend('chat:error', { id, error: e.message }); return; }
    const stopper = { abort: () => killProc(proc) };
    chatAborts.set(id, stopper);
    pushDevLog(`withlook: opencode agent started in ${folder}`);
    const dec = new TextDecoder();
    const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '');
    let outBuf = '';
    let errTail = '';
    let wroteFiles = false;
    const textParts = new Map(); // part id → last full text (the stream repeats cumulative snapshots)
    const sentTools = new Set(); // tool part ids already reported
    proc.stdout.on('data', (b) => {
      outBuf += dec.decode(b, { stream: true });
      let nl;
      while ((nl = outBuf.indexOf('\n')) >= 0) {
        const line = outBuf.slice(0, nl).trim();
        outBuf = outBuf.slice(nl + 1);
        if (!line) continue;
        let j = null;
        try { j = JSON.parse(line); } catch {}
        if (!j || !j.part) { overlaySend('chat:chunk', { id, delta: stripAnsi(line) + '\n', kind: 'text' }); continue; }
        if (j.type === 'text' && j.part.text) {
          const pid = j.part.id || 'text';
          const prev = textParts.get(pid) || '';
          const full = j.part.text;
          let delta = full;
          if (full.startsWith(prev)) delta = full.slice(prev.length); // cumulative snapshot → only the new tail
          else if (prev.startsWith(full)) delta = '';                 // repeated snapshot → nothing new
          textParts.set(pid, full);
          if (delta) overlaySend('chat:chunk', { id, delta, kind: 'text' });
        } else if (j.type === 'tool_use' && j.part.state && j.part.state.status === 'completed') {
          const tpid = j.part.id || (j.part.tool + ':' + JSON.stringify(j.part.state.input || {}));
          if (sentTools.has(tpid)) continue; // never report the same tool call twice
          sentTools.add(tpid);
          const inp = j.part.state.input || {};
          const toolName = j.part.tool || 'tool';
          const what = inp.path || inp.command || inp.pattern || inp.url || Object.values(inp)[0] || '';
          const isEdit = /write|edit|remove|create|patch/i.test(toolName);
          if (isEdit) {
            const rel = (p) => {
              if (!p) return '';
              const abs = path.resolve(String(p));
              const folder = devState.folder;
              if (folder && abs.startsWith(folder + path.sep)) return path.relative(folder, abs);
              return String(p);
            };
            const meta = j.part.state.metadata || {};
            const metaFiles = Array.isArray(meta.files) ? meta.files
              : (meta.metadata && Array.isArray(meta.metadata.files)) ? meta.metadata.files : [];
            const edits = metaFiles.map((f) => {
              const patch = String(f.patch || '');
              return {
                file: rel(f.file || ''),
                patch,
                additions: f.additions,
                deletions: f.deletions,
                line: firstChangedLine(patch),
              };
            });
            if (!edits.length && inp.path) edits.push({ file: rel(inp.path), patch: '', additions: null, deletions: null, line: null });
            if (edits.length) overlaySend('chat:chunk', { id, kind: 'edit', edit: edits, delta: `${toolName} ${String(what).slice(0, 120)}` });
            else overlaySend('chat:chunk', { id, delta: `${toolName} ${String(what).slice(0, 120)}`, kind: 'tool' });
            wroteFiles = true;
          } else {
            overlaySend('chat:chunk', { id, delta: `${toolName} ${String(what).slice(0, 120)}`, kind: 'tool' });
          }
        }
        // step_start turn markers stay in the logs — not shown in the chat
      }
    });
    proc.stderr.on('data', (b) => {
      errTail = (errTail + stripAnsi(b.toString())).slice(-600);
    });
    const finish = async (code) => {
      chatAborts.delete(id);
      if (wroteFiles) pushDevLog('withlook: opencode modified files — refreshing git view');
      refreshGitViews();
      if (code === 0 || stopper.aborted) {
        // report exactly what changed, so edits can never land invisibly
        try {
          const git = await gitStatus('sandbox');
          if (git.ok && git.files && git.files.length) {
            const lines = git.files.slice(0, 10)
              .map((f) => `${(f.status || '').trim()} ${f.path}` + (f.adds != null ? `  +${f.adds} −${f.dels}` : ''));
            overlaySend('chat:chunk', { id, delta: 'changed:\n' + lines.join('\n'), kind: 'report' });
          } else if (!stopper.aborted) {
            overlaySend('chat:chunk', { id, delta: 'no working-tree changes detected', kind: 'report' });
          }
        } catch {}
        // make the change visible on the canvas too (second pass covers recompile time)
        if (wroteFiles) {
          setTimeout(() => { try { activeView().webContents.reload(); } catch {} }, 1200);
          setTimeout(() => { try { activeView().webContents.reload(); } catch {} }, 4500);
        }
        overlaySend('chat:done', { id });
      } else {
        overlaySend('chat:error', { id, error: `opencode exited with code ${code}` + (errTail ? ` — ${errTail}` : '') });
      }
    };
    stopper.abort = () => { stopper.aborted = true; killProc(proc); };
    proc.on('error', (e) => { overlaySend('chat:error', { id, error: `opencode not available: ${e.message}` }); chatAborts.delete(id); });
    proc.on('exit', finish);
    return;
  }

  const provider = settings.provider === 'openai' ? 'openai' : 'cloudflare';
  let url, headers = { 'Content-Type': 'application/json' }, body, model;
  if (provider === 'cloudflare') {
    const cf = settings.cloudflare;
    model = cf.model;
    if (!cf.accountId || !cf.token) {
      overlaySend('chat:error', { id, error: 'Cloudflare is selected but your Account ID or API token is missing. Open Settings (gear icon) to add it.' });
      return;
    }
    url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cf.accountId)}/ai/run/${model}`;
    headers.Authorization = `Bearer ${cf.token}`;
    body = { messages: msgs, stream: true };
  } else {
    const oa = settings.openai;
    model = oa.model;
    if (!oa.apiKey) {
      overlaySend('chat:error', { id, error: 'OpenAI is selected but no API key is set. Open Settings (gear icon) to paste one.' });
      return;
    }
    const base = (oa.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    url = `${base}/chat/completions`;
    headers.Authorization = `Bearer ${oa.apiKey}`;
    body = { model, messages: msgs, stream: true };
  }
  const ctrl = new AbortController();
  chatAborts.set(id, ctrl);
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    if (!res.ok) {
      let detail = '';
      try { const j = await res.json(); detail = JSON.stringify(j.errors || j.error || j).slice(0, 800); }
      catch { try { detail = (await res.text()).slice(0, 800); } catch {} }
      throw new Error(`HTTP ${res.status} — ${detail}`);
    }
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('text/event-stream')) {
      const j = await res.json();
      const text = j?.choices?.[0]?.message?.content ?? j?.result?.response ?? j?.response ?? '';
      if (text) overlaySend('chat:chunk', { id, delta: String(text) });
      overlaySend('chat:done', { id });
      return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '').trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        try {
          const j = JSON.parse(raw);
          const delta = j?.choices?.[0]?.delta?.content ?? j?.response ?? '';
          if (delta) overlaySend('chat:chunk', { id, delta: String(delta) });
        } catch {}
      }
    }
    overlaySend('chat:done', { id });
  } catch (err) {
    if (ctrl.signal.aborted) overlaySend('chat:done', { id });
    else overlaySend('chat:error', { id, error: err?.message || String(err) });
  } finally {
    chatAborts.delete(id);
  }
}

// ---------- menu ----------
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const menu = [
    ...(isMac ? [{
      label: app.name, submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: () => overlaySend('ui:openProject', {}) },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => overlaySend('ui:openSettings', {}) },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : [{
      label: 'File', submenu: [
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: () => overlaySend('ui:openProject', {}) },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => overlaySend('ui:openSettings', {}) },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }]),
    { role: 'editMenu' },
    {
      label: 'Page', submenu: [
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => navGo(-1) },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => navGo(1) },
        { label: 'Reload Page', accelerator: 'CmdOrCtrl+R', click: () => pageView && pageView.webContents.reload() },
        { label: 'Page DevTools', accelerator: 'CmdOrCtrl+Alt+I', click: () => pageView && pageView.webContents.toggleDevTools() },
      ],
    },
    {
      label: 'Withlook', submenu: [
        { label: 'Home', accelerator: 'CmdOrCtrl+Shift+H', click: () => openHome() },
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: () => toggleSidebar() },
        { label: 'Toggle Chat', accelerator: 'CmdOrCtrl+Shift+J', click: () => toggleChat() },
        { label: 'Select Element on Page', accelerator: 'CmdOrCtrl+E', click: () => startPicker() },
        { label: 'Focus Chat', accelerator: 'CmdOrCtrl+K', click: () => overlaySend('ui:focusChat', {}) },
        { label: 'Toggle Float', accelerator: 'CmdOrCtrl+F', click: () => toggleFloat() },
        { label: 'Toggle Chat Panel', accelerator: 'CmdOrCtrl+J', click: () => overlaySend('ui:togglePanel', {}) },
      ],
    },
    {
      label: 'Canvas', submenu: [
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => doCanvasAction('in') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+Minus', click: () => doCanvasAction('out') },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => doCanvasAction('fit') },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menu));
}

function saveWindowBounds() {
  if (!win || win.isDestroyed()) return;
  try {
    const s = loadSettings();
    s.window = win.getBounds();
    saveSettings(s);
  } catch {}
}
let boundsTimer = null;
function scheduleBoundsSave() {
  if (boundsTimer) clearTimeout(boundsTimer);
  boundsTimer = setTimeout(saveWindowBounds, 500);
}

// ---------- window ----------
function createWindow() {
  settingsModal = false;
  const saved = loadSettings().window;
  const usable = (() => {
    if (!saved || !Number.isInteger(saved.width) || saved.width < 700 || saved.height < 500) return null;
    try {
      const ok = screen.getAllDisplays().some((d) => {
        const a = d.workArea;
        return saved.x < a.x + a.width - 80 && saved.x + saved.width > a.x + 80 &&
               saved.y < a.y + a.height - 80 && saved.y + saved.height > a.y + 80;
      });
      return ok ? saved : null;
    } catch { return null; }
  })();
  win = new BrowserWindow({
    width: usable ? usable.width : 1440,
    height: usable ? usable.height : 900,
    ...(usable ? { x: usable.x, y: usable.y } : {}),
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0b0d12',
    title: 'withlook',
    show: true,
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 16 } }
      : { autoHideMenuBar: true }),
    webPreferences: {},
  });
  win.on('resize', () => { layout(); scheduleBoundsSave(); });
  win.on('move', scheduleBoundsSave);
  win.on('closed', () => { win = null; });
  win.webContents.loadFile(STATUS_FILE).catch(() => {});

  pageView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-page.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  overlayView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  try { overlayView.setBackgroundColor('#00000000'); } catch {}
  try { overlayView.webContents.setBackgroundColor('#00000000'); } catch {}

  canvasBarView = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload-overlay.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  panGlassView = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload-overlay.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  try { canvasBarView.setBackgroundColor('#00000000'); } catch {}
  try { panGlassView.setBackgroundColor('#00000000'); } catch {}
  try { canvasBarView.setVisible(false); panGlassView.setVisible(false); } catch {}

  sidebarView = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload-overlay.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  try { sidebarView.setVisible(false); } catch {}

  tabbarView = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload-overlay.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  try { tabbarView.setBackgroundColor('#00000000'); } catch {}
  try { tabbarView.setVisible(false); } catch {}
  loaderView = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload-overlay.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  try { loaderView.setBackgroundColor('#00000000'); } catch {}
  try { loaderView.setVisible(false); } catch {}
  tabs = [{ view: pageView, route: '/' }];
  activeTab = 0;
  attachLoading(pageView.webContents, () => activeTab === 0);

  win.contentView.addChildView(pageView);
  win.contentView.addChildView(loaderView);
  win.contentView.addChildView(panGlassView);
  win.contentView.addChildView(canvasBarView);
  win.contentView.addChildView(tabbarView);
  win.contentView.addChildView(sidebarView);
  win.contentView.addChildView(overlayView); // added last => on top

  canvasBarView.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'canvas-bar.html')).catch(() => {});
  panGlassView.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'pan-glass.html')).catch(() => {});
  sidebarView.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'sidebar.html')).catch(() => {});
  tabbarView.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'tabbar.html')).catch(() => {});
  tabbarView.webContents.on('did-finish-load', () => broadcastTabs());
  loaderView.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'loader.html')).catch(() => {});;

  const wc = pageView.webContents;
  wc.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  trackTabRoute(wc, 0);
  wc.on('did-navigate-in-page', () => overlaySend('page:nav', navInfo()));
  wc.on('page-title-updated', () => overlaySend('page:nav', navInfo()));
  wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (isMain && code !== -3) overlaySend('page:error', { error: `${code} ${desc} (${url})` });
  });
  wc.loadFile(PLACEHOLDER_FILE).catch(() => {});

  overlayView.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));
  overlayView.webContents.on('ipc-message', (_e, ch) => {
    if (ch === 'ui:ready') { overlaySend('dev:status', devState); overlaySend('page:nav', navInfo()); }
  });
  layout();
}

// ---------- IPC ----------
function wireIpc() {
  ipcMain.handle('settings:get', () => loadSettings());
  ipcMain.handle('settings:save', (_e, s) => { saveSettings(s); return true; });
  ipcMain.handle('project:choose', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });
  ipcMain.handle('create:cancel', () => {
    stopDev(true); // stay on the create page so the user can retry
    try { pageView.webContents.send('create:status', { phase: 'cancelled' }); } catch {}
    return true;
  });
  ipcMain.handle('preview:show', () => {
    if (previewWin && !previewWin.isDestroyed()) { previewWin.close(); return false; } // toggle back into the dock
    showPreviewWindow();
    return true;
  });
  ipcMain.handle('create:openPage', () => {
    stopDev(true); // stop any running server but keep the view we are about to replace
    cancelPicker();
    pageView.webContents.loadFile(CREATE_FILE).catch((e) => console.error(e.message));
    return true;
  });
  ipcMain.handle('create:pickLocation', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });
  ipcMain.handle('create:submit', async (_e, { parent, name }) => {
    if (!parent || !name || !/^[a-zA-Z0-9][a-zA-Z0-9-_]*$/.test(name)) {
      return { ok: false, error: 'Invalid project name — use letters, numbers, dashes.' };
    }
    const folder = path.join(parent, name);
    if (fs.existsSync(folder)) return { ok: false, error: 'A folder with that name already exists there.' };
    stopDev(true); // keep the create page on screen while scaffolding
    devLogs = [];
    setDevStatus({ state: 'starting', folder, pm: 'create-next-app', port: null, url: null, error: null });
    const sendPage = (ch, d) => { try { pageView.webContents.send(ch, d); } catch {} };
    pushDevLog(`$ npx create-next-app@latest ${name}   (in ${parent})`);
    return new Promise((resolve) => {
      const cmd = `npx --yes create-next-app@latest ${JSON.stringify(name)} --ts --eslint --tailwind --app --src-dir --import-alias "@/*" --use-npm --yes`;
      let proc;
      try {
        proc = spawn(cmd, { cwd: parent, env: { ...process.env, CI: 'true' }, shell: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) { return resolve({ ok: false, error: e.message }); }
      createProc = proc;
      createCancelled = false;
      const onLine = (line) => { pushDevLog(line); sendPage('create:log', line); };
      readline.createInterface({ input: proc.stdout }).on('line', onLine);
      readline.createInterface({ input: proc.stderr }).on('line', onLine);
      proc.on('error', (e) => {
        createProc = null;
        sendPage('create:status', { phase: 'error', error: e.message });
        resolve({ ok: false, error: e.message });
      });
      proc.on('exit', (code) => {
        const wasCancelled = createCancelled;
        createProc = null;
        if (code === 0) {
          const pm = detectPM(folder);
          // onboarding: add it to Recent projects and return to the dashboard — never auto-start it
          if (store) store.upsertProject({ folder, name, pm, port: null }).catch((e) => console.error('store upsert failed', e.message));
          setDevStatus({ state: 'idle', url: null, port: null, error: null, external: false });
          sendPage('create:status', { phase: 'created', folder });
          setTimeout(() => { openHome(); }, 700);
          resolve({ ok: true, folder });
        } else if (wasCancelled) {
          setDevStatus({ state: 'idle' });
          sendPage('create:status', { phase: 'cancelled' });
          resolve({ ok: false, error: 'Cancelled — partial files may remain in the folder.' });
        } else {
          const error = `create-next-app exited with code ${code}`;
          setDevStatus({ state: 'error', error });
          sendPage('create:status', { phase: 'error', error });
          resolve({ ok: false, error });
        }
      });
    });
  });
  ipcMain.handle('dev:start', async (_e, folder) => {
    const resolved = resolveProjectFolder(folder);
    if (!resolved) {
      return { ok: false, error: 'That folder has no package.json — is it a Next.js project?' };
    }
    startDev(resolved);
    return { ok: true, folder: resolved };
  });
  ipcMain.handle('dev:stop', () => { stopDev(); return true; });
  ipcMain.handle('dev:restart', () => restartDev());
  ipcMain.handle('dev:status', () => devState);
  ipcMain.handle('dev:logs', () => devLogs);
  ipcMain.handle('page:load', (_e, url) => {
    let u = String(url || '').trim();
    if (!u) return false;
    if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
    loadPageUrl(u);
    return true;
  });
  ipcMain.handle('page:info', () => navInfo());
  ipcMain.handle('page:back', () => navGo(-1));
  ipcMain.handle('page:forward', () => navGo(1));
  ipcMain.handle('page:reload', () => pageView && pageView.webContents.reload());
  ipcMain.handle('picker:start', () => { startPicker(); return true; });
  ipcMain.handle('picker:cancel', () => { cancelPicker(); return true; });
  ipcMain.handle('source:find', findSources);
  ipcMain.handle('source:open', openInEditor);
  // canvas camera
  ipcMain.on('canvas:action', (_e, d) => doCanvasAction(d && d.action, d && d.data));
  ipcMain.handle('git:status', gitStatus);
  ipcMain.handle('git:diff', gitDiff);
  ipcMain.handle('git:commit', gitCommit);
  ipcMain.handle('git:push', gitPush);
  ipcMain.handle('sandbox:status', async () => {
    const sb = devState.sandbox;
    if (!sb) return { active: false };
    return {
      active: true, mode: sb.mode, root: sb.root, path: sb.projectPath,
      projectFolder: sb.folder, branch: sb.branch || '', dirty: await sandbox.isDirty(sb),
    };
  });
  ipcMain.handle('sandbox:apply', async () => {
    const sb = devState.sandbox;
    if (!sb) return { ok: false, error: 'No sandbox is active.' };
    const r = await sandbox.applySandbox(sb);
    if (r.ok) {
      pushDevLog(`withlook: applied sandbox changes to ${sb.folder}`);
      refreshGitViews();
    }
    return r;
  });
  ipcMain.handle('sandbox:discard', async () => {
    const sb = devState.sandbox;
    if (!sb) return { ok: false, error: 'No sandbox is active.' };
    stopDev(false); // back to the dashboard; the server is gone
    const r = sandbox.discardSandbox(sb);
    devState.sandbox = null;
    setDevStatus({ sandbox: null });
    return r;
  });
  ipcMain.handle('pages:list', () => listPages());
  ipcMain.handle('code:write', writeCodeFile);
  ipcMain.handle('opencode:list', () => opencodeList());
  ipcMain.on('sidebar:ui', (_e, d) => {
    if (!d) return;
    if (d.a === 'loadSession' && d.d) overlaySend('ui:loadSession', d.d);
    else if (d.a === 'navigate' && d.d) openTab(d.d);
    else if (d.a === 'addFrame' && d.d) openTab(d.d);
    else if (d.a === 'openSettings') overlaySend('ui:openSettings', {});
    else if (d.a === 'newChat') overlaySend('ui:newChat', {});
    else if (d.a === 'history') overlaySend('ui:openHistory', {});
    else if (d.a === 'float') setPanelOpen(false);
  });
  // memory store
  ipcMain.handle('store:status', () => (store ? store.status() : { mode: 'file' }));
  ipcMain.handle('store:test', async (_e, url) => {
    const r = await store.init(url);
    return { ...r, ...(store.status()) };
  });
  ipcMain.handle('projects:list', () => store.listProjects());
  ipcMain.handle('projects:remove', async (_e, folder) => {
    if (!store || !folder) return { ok: false };
    const wasRunning = devState.projectFolder === folder;
    if (wasRunning) stopDev(false);
    const removed = await store.removeProject(folder);
    return { ok: removed, stopped: wasRunning };
  });
  // sessions belong to the real project, never the sandbox path
  const projectKey = (folder) => (devState.sandbox && folder && folder === devState.folder) ? devState.projectFolder : folder;
  ipcMain.handle('sessions:new', async (_e, folder) => {
    const s = await store.createSession(projectKey(folder));
    overlaySend('sessions:changed', {});
    return s;
  });
  ipcMain.handle('sessions:latest', (_e, folder) => store.latestSession(projectKey(folder)));
  ipcMain.handle('sessions:list', (_e, folder) => store.listSessions(projectKey(folder)));
  ipcMain.handle('sessions:load', (_e, id) => store.loadSession(id));
  ipcMain.handle('messages:append', async (_e, m) => {
    const r = await store.appendMessage(m);
    overlaySend('sessions:changed', {});
    return r;
  });
  ipcMain.handle('ui:panel', (_e, open) => setPanelOpen(open));
  ipcMain.handle('ui:settingsModal', (_e, open) => { settingsModal = !!open; layout(); return true; });
  ipcMain.handle('chat:send', handleChatSend);
  ipcMain.handle('chat:stop', (_e, id) => {
    const c = chatAborts.get(id);
    if (c) c.abort();
    return true;
  });
  // from the page preload (picker)
  ipcMain.on('picker:result', handlePickerResult);
  ipcMain.on('picker:cancel', () => { pickerActive = false; overlaySend('picker:state', { active: false }); });
  // from the page preload (welcome screen buttons)
  ipcMain.on('page:ui', (_e, a) => {
    if (a === 'open') overlaySend('ui:openProject', {});
    else if (a === 'create') overlaySend('ui:newProject', {});
    else if (a === 'settings') overlaySend('ui:openSettings', {});
    else if (a && a.action === 'openFolder' && a.folder) overlaySend('ui:openFolder', a.folder);
  });
  ipcMain.handle('welcome:data', async () => ({
    projects: store
      ? (await store.listProjects().catch(() => [])).filter(isRealProject).map((p) => ({
          ...p, repo: repoFromFolder(resolveProjectFolder(p.folder) || p.folder),
        }))
      : [],
    running: { state: devState.state, folder: devState.folder, url: devState.url },
  }));
}

// ---------- lifecycle ----------
app.whenReady().then(async () => {
  if (process.platform === 'darwin' && !app.isPackaged) {
    try { app.dock.setIcon(path.join(__dirname, '..', 'build', 'icon.png')); } catch {}
  }
  buildMenu();
  store = new MemoryStore(app.getPath('userData'));
  // test/smoke runs must never write into the user's real project memory
  const initRes = await store.init((SMOKE || TEST_PROJ || TEST_OPENCODE || TEST_LOAD) ? '' : loadSettings().memory.url);
  if (initRes.error) console.error('memory store: postgres unavailable, using local file —', initRes.error);
  wireIpc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  // launch always lands on the dashboard — projects never start automatically
  if (SMOKE) {
    setTimeout(() => {
      console.log('SMOKE visible=' + (win ? win.isVisible() : 'n/a'));
      const noAuto = devState.state === 'idle' && /placeholder\.html/.test(pageView ? pageView.webContents.getURL() : '');
      console.log('NO_AUTOSTART ' + (noAuto ? 'PASS' : 'FAIL') + ' state=' + devState.state + ' url=' + (pageView ? pageView.webContents.getURL() : 'n/a'));
      overlayView.webContents.executeJavaScript('document.querySelectorAll("#pill,#messages,#settings,#openproj").length', true)
        .then(() => overlayView.webContents.executeJavaScript(`
          (async function () {
            const q = () => { const b = document.querySelector('#agent-seg button.on'); return b ? b.dataset.agent : 'none'; };
            document.querySelector('#agent-seg [data-agent="opencode"]').click();
            const s1 = q();
            await new Promise((r) => setTimeout(r, 300));
            const s2 = q();
            const pv = document.querySelector('#prov-seg button');
            if (pv) pv.click();
            const s3 = q();
            return [s1, s2, s3].join('>');
          })()`, true))
        .then((states) => {
          console.log('AGENT_TOGGLER ' + (states === 'opencode>opencode>opencode' ? 'PASS' : 'FAIL ' + states));
          // close the window and reopen from the dock — must land on the main (welcome) view
          try { win.close(); } catch {}
          setTimeout(() => {
            app.emit('activate');
            setTimeout(() => {
              const w = BrowserWindow.getAllWindows()[0];
              const url = pageView && !pageView.webContents.isDestroyed() ? pageView.webContents.getURL() : 'n/a';
              const okReopen = !!w && /placeholder\.html/.test(url);
              console.log(`REOPEN ${okReopen ? 'PASS' : 'FAIL'} url=${url}`);
              console.log('SMOKE_OK');
              app.quit();
            }, 1600);
          }, 800);
        })
        .catch((e) => { console.log('SMOKE_OK agent_test_error=' + e.message); })
        .finally(() => { if (!win) app.quit(); });
    }, 2600);
  }
  if (TEST_PROJ) {
    startDev(TEST_PROJ);
    let sawLoader = false;
    let sawPanelFlash = false;
    let chatsOk = false;
    const loaderPoll = setInterval(() => {
      if (devState.state === 'starting') {
        if (loaderVisible) sawLoader = true;
        if (overlayVisible) sawPanelFlash = true; // the old floating panel must never appear while starting
      }
      if (devState.state === 'running' || devState.state === 'error') {
        clearInterval(loaderPoll);
        console.log('LOADER_START ' + (sawLoader ? 'PASS' : 'FAIL'));
        console.log('PANEL_FLASH ' + (sawPanelFlash ? 'FAIL' : 'PASS'));
      }
    }, 30);
    setTimeout(() => clearInterval(loaderPoll), 6000);
    setTimeout(() => {
      const ups = devLogs.filter((l) => l.includes('server is up')).length;
      const view = pageView ? pageView.webContents.getURL() : 'n/a';
      const ok = devState.state === 'running' && ups === 1 && /:3999/.test(view);
      console.log(`ITEST ${ok ? 'PASS' : 'FAIL'} state=${devState.state} ups=${ups} view=${view} dock=${dockMode}`);
      if (!ok) { console.log('ITEST_LOGS\n' + devLogs.join('\n')); app.exit(1); return; }
      const sandboxOk = !!devState.sandbox && devState.folder !== TEST_PROJ && fs.existsSync(devState.folder);
      console.log(`SANDBOX ${sandboxOk ? 'PASS' : 'FAIL'} mode=${devState.sandbox && devState.sandbox.mode} folder=${devState.folder}`);
      // the sidebar header must show the GitHub repo (owner/name) and branch
      (async () => {
        let repoText = '';
        for (let i = 0; i < 20 && !repoText; i++) {
          repoText = await sidebarView.webContents.executeJavaScript("document.getElementById('repo').textContent", true).catch(() => '');
          if (!repoText) await sleep(150);
        }
        const branchText = await sidebarView.webContents.executeJavaScript("document.getElementById('branch').textContent", true).catch(() => '');
        console.log(`REPO ${/saransh\/wl-fake-proj/.test(repoText) ? 'PASS' : 'FAIL'} repo=${repoText} branch=${branchText}`);
      })();
      // recent chats must be keyed to the real project, not the sandbox path
      (async () => {
        try {
          const sess = await store.createSession(devState.projectFolder);
          await store.appendMessage({ sessionId: sess.id, role: 'user', content: 'recent chat check', title: 'recent chat check' });
          overlaySend('sessions:changed', {});
          await sleep(600);
          const txt = await sidebarView.webContents.executeJavaScript(
            "document.querySelector('#chats .chat') ? document.querySelector('#chats .chat').textContent : ''", true).catch(() => '');
          chatsOk = /recent chat check/.test(txt);
          console.log(`CHATS ${chatsOk ? 'PASS' : 'FAIL'} ${txt}`);
        } catch (e) { console.log('CHATS FAIL ' + e.message); }
      })();
      // sidebar/chat toggles must give the preview the space and restore cleanly
      toggleSidebar();
      const sideOk = sidebarHidden && previewArea().x === 0;
      toggleSidebar();
      toggleChat();
      const chatOk = chatHidden && overlayVisible === false;
      toggleChat();
      const chromeOk = sideOk && chatOk && !sidebarHidden && !chatHidden && overlayVisible === true;
      console.log(`CHROME ${chromeOk ? 'PASS' : 'FAIL'} side=${sideOk} chat=${chatOk}`);
      // the top bar must grow for its dropdowns and sit above the docked chat/sidebar
      doCanvasAction('menu', true);
      const menuH = tabbarView.getBounds().height;
      const topOpen = win.contentView.children[win.contentView.children.length - 1] === tabbarView;
      doCanvasAction('menu', false);
      const topClosed = win.contentView.children[win.contentView.children.length - 1] === overlayView;
      console.log(`TAB_MENU ${menuH > 100 ? 'PASS' : 'FAIL'} h=${menuH} top=${topOpen && topClosed ? 'PASS' : 'FAIL'}`);
      // and it must shrink again after choosing a route from the + menu
      tabbarView.webContents.executeJavaScript("document.getElementById('add').click(); 'x'", true)
        .then(() => setTimeout(() => {
          const openedH = tabbarView.getBounds().height;
          tabbarView.webContents.executeJavaScript("document.querySelector('#menu button').click(); 'y'", true)
            .then(() => setTimeout(() => {
              const closedH = tabbarView.getBounds().height;
              const menuOk = openedH > 100 && closedH <= 60;
              console.log(`TAB_MENU_SHRINK ${menuOk ? 'PASS' : 'FAIL'} open=${openedH} closed=${closedH}`);
            }, 350))
            .catch(() => console.log('TAB_MENU_SHRINK FAIL click'));
        }, 350))
        .catch(() => console.log('TAB_MENU_SHRINK FAIL open'));
      // exercise the floating canvas toolbar buttons like a user would
      const before = canvas.zoom;
      canvasBarView.webContents.executeJavaScript("document.getElementById('in').click(); 'clicked'", true)
        .then(() => setTimeout(() => {
          const z = canvas.zoom;
          const okBtn = z !== before;
          console.log(`ZOOM_BAR ${okBtn ? 'PASS' : 'FAIL'} ${before}→${z}`);
          // route tabs: open a second page as a tab, Onlook-style
          let r = null;
          try { r = openTab('/about'); } catch (e) { console.log('TAB_OPEN_ERR ' + (e && e.stack || e)); }
          if (r && !r.ok) console.log('TAB_OPEN_FAIL ' + (r.error || ''));
          setTimeout(async () => {
            const t1 = tabs[1];
            const tabsOk = r.ok && tabs.length === 2 && activeTab === 1 && t1 && /:3999\/about/.test(t1.view.webContents.getURL());
            console.log(`TABS ${tabsOk ? 'PASS' : 'FAIL'} n=${tabs.length} active=${activeTab} url=${t1 ? t1.view.webContents.getURL() : 'n/a'}`);
            // local git commit flow
            let commitOk = false;
            let commitErr = '';
            try {
              fs.writeFileSync(path.join(devState.projectFolder || devState.folder, 'commit-test.txt'), 'x' + Date.now());
              const cr = await gitCommit(null, { message: 'withlook test commit' });
              const gs = await gitStatus();
              commitOk = cr.ok && gs.ok && gs.files.length === 0;
              commitErr = cr.ok ? '' : (cr.error || '');
            } catch (e) { commitErr = e.message; }
            console.log(`GIT_COMMIT ${commitOk ? 'PASS' : 'FAIL'}${commitErr ? ' ' + commitErr : ''}`);
            let pushOk = false;
            try {
              const pr = await gitPush();
              pushOk = pr.ok;
              console.log(`PUSH ${pushOk ? 'PASS' : 'FAIL'} ${pushOk ? String(pr.output || '').split('\n')[0] : (pr.error || '')}`);
            } catch (e) { console.log('PUSH FAIL ' + e.message); }
            // a new project must start at its root, never a stale route from before
            tabs[0].route = '/stale-route';
            restartDev();
            const rp = setInterval(() => {
              if (devState.state === 'running') {
                clearInterval(rp);
                const okR = tabs.length === 2;
                const url = pageView.webContents.getURL();
                const urlOk = /:3999\/$/.test(url);
                console.log(`RESTART_TABS ${okR ? 'PASS' : 'FAIL'} n=${tabs.length} root=${urlOk ? 'PASS' : 'FAIL'} url=${url}`);
                // the top-bar home icon must return to the dashboard
                tabbarView.webContents.executeJavaScript("document.getElementById('home').click(); 'x'", true)
                  .then(() => setTimeout(() => {
                    const homeUrl = pageView.webContents.getURL();
                    const okHome = /placeholder\.html/.test(homeUrl) && homeMode === true;
                    console.log(`HOME ${okHome ? 'PASS' : 'FAIL'} url=${homeUrl}`);
                    try { stopDev(false); } catch {}
                    if (devState.sandbox) { sandbox.discardSandbox(devState.sandbox); devState.sandbox = null; }
                    app.exit(okBtn && tabsOk && commitOk && pushOk && okR && urlOk && okHome && chatsOk ? 0 : 1);
                  }, 1500))
                  .catch((e) => { console.log('HOME FAIL ' + e.message); app.exit(1); });
              }
            }, 300);
            setTimeout(() => { clearInterval(rp); console.log('RESTART_TABS FAIL timeout'); app.exit(1); }, 15000);
          }, 1800);
        }, 400))
        .catch((e) => { console.log('ZOOM_BAR_FAIL ' + e.message); app.exit(1); });
    }, 15000);
  }
  if (TEST_OPENCODE) {
    // End-to-end opencode run driven through the real chat UI. Uses a throwaway
    // settings override (agent=opencode) and restores the user's settings after.
    const folder = TEST_OPENCODE;
    const settingsFile = settingsPath();
    let backup = null;
    try { backup = fs.readFileSync(settingsFile, 'utf8'); } catch {}
    const restore = () => {
      try {
        if (backup == null) { if (fs.existsSync(settingsFile)) fs.unlinkSync(settingsFile); }
        else fs.writeFileSync(settingsFile, backup);
      } catch {}
    };
    const task = 'Fix the bug in lib.js: add(a, b) currently returns a - b but it should return a + b. Run npm test to confirm. Change only lib.js.';
    const deadline = Date.now() + 180000;
    let sent = false;
    startDev(folder);
    const sendWhenReady = setInterval(async () => {
      if (sent || devState.state !== 'running') return;
      sent = true;
      clearInterval(sendWhenReady);
      const s = loadSettings();
      saveSettings({ ...s, agent: 'opencode', opencode: { ...s.opencode, model: 'opencode/big-pickle', agent: 'build' } });
      await sleep(300);
      try {
        await overlayView.webContents.executeJavaScript(`
          (async () => {
            window.__wlTest = { done: false, error: null, edits: [] };
            window.wl.onChatDone(() => { window.__wlTest.done = true; });
            window.wl.onChatError((d) => { window.__wlTest.error = d.error; });
            window.wl.onChatChunk((d) => { if (d.kind === 'edit') window.__wlTest.edits.push(d.edit); });
            const q = document.querySelector('#quick');
            q.value = ${JSON.stringify(task)};
            document.querySelector('#send').click();
            return 'sent';
          })()
        `, true);
      } catch (e) {
        console.log('OPENCODE_FAIL send ' + e.message);
        if (devState.sandbox) { sandbox.discardSandbox(devState.sandbox); devState.sandbox = null; }
        restore();
        app.exit(1);
      }
    }, 250);
    const check = setInterval(async () => {
      if (!sent) return;
      let st = null;
      try { st = await overlayView.webContents.executeJavaScript('window.__wlTest || null', true); } catch {}
      const sandboxFolder = devState.folder;
      const lib = (() => { try { return fs.readFileSync(path.join(sandboxFolder, 'lib.js'), 'utf8'); } catch { return ''; } })();
      const fixed = /return\s+a\s*\+\s*b/.test(lib);
      const originalLib = (() => { try { return fs.readFileSync(path.join(folder, 'lib.js'), 'utf8'); } catch { return ''; } })();
      const isolated = /return\s+a\s*-\s*b/.test(originalLib);
      if (fixed && isolated && st && st.done) {
        clearInterval(check);
        // the edit must also be visible in the chat, with its path and diff
        const ui = await overlayView.webContents.executeJavaScript(`
          (() => {
            const cards = [...document.querySelectorAll('.oc-edit')];
            const card = cards[0];
            const pre = card && card.querySelector('.rp-diff');
            return card ? {
              path: (card.querySelector('.ed-path') || {}).textContent || '',
              diff: !!pre && pre.querySelectorAll('.dl.add, .dl.del').length > 0 && !/not streamed/.test(pre.textContent),
              counts: (card.querySelector('.ed-num') || {}).textContent || '',
              cards: cards.length,
            } : null;
          })()
        `, true).catch(() => null);
        const uiOk = !!ui && /lib\.js/.test(ui.path) && ui.diff;
        console.log('OPENCODE_EDIT_UI ' + (uiOk ? 'PASS' : 'FAIL') + (ui ? ' ' + ui.path : ''));
        if (!uiOk) console.log('OPENCODE_EDIT_DEBUG ' + JSON.stringify({ ui, edits: st && st.edits }).slice(0, 1200));
        // the edit landed in the sandbox; apply it and confirm the user's folder changes only now
        const ap = devState.sandbox ? await sandbox.applySandbox(devState.sandbox) : { ok: false, error: 'no sandbox' };
        const appliedLib = (() => { try { return fs.readFileSync(path.join(folder, 'lib.js'), 'utf8'); } catch { return ''; } })();
        const applied = ap.ok && /return\s+a\s*\+\s*b/.test(appliedLib);
        console.log(`OPENCODE_SANDBOX ${isolated && applied ? 'PASS' : 'FAIL'} isolated=${isolated} applied=${applied} mode=${devState.sandbox && devState.sandbox.mode}`);
        console.log('OPENCODE ' + (uiOk && applied ? 'PASS' : 'FAIL') + ' fixed=' + fixed);
        if (devState.sandbox) { sandbox.discardSandbox(devState.sandbox); devState.sandbox = null; }
        restore();
        app.exit(uiOk && applied ? 0 : 1);
      } else if (st && st.error) {
        clearInterval(check);
        console.log('OPENCODE_FAIL ' + st.error);
        if (devState.sandbox) { sandbox.discardSandbox(devState.sandbox); devState.sandbox = null; }
        restore();
        app.exit(1);
      } else if (Date.now() > deadline) {
        clearInterval(check);
        console.log('OPENCODE_FAIL timeout fixed=' + fixed + ' state=' + JSON.stringify(st));
        if (devState.sandbox) { sandbox.discardSandbox(devState.sandbox); devState.sandbox = null; }
        restore();
        app.exit(1);
      }
    }, 1000);
  }
  if (TEST_LOAD) {
    // load a real project through the same path the app uses (sandbox + dev server)
    const cleanup = () => { try { stopDev(false); } catch {} if (devState.sandbox) { sandbox.discardSandbox(devState.sandbox); devState.sandbox = null; } };
    startDev(resolveProjectFolder(TEST_LOAD) || TEST_LOAD);
    const poll = setInterval(() => {
      if (devState.state === 'running') {
        clearInterval(poll);
        console.log(`LOAD_PASS url=${devState.url} folder=${devState.folder} sandbox=${devState.sandbox ? devState.sandbox.mode : 'off'}`);
        setTimeout(() => { cleanup(); app.exit(0); }, 1500);
      } else if (devState.state === 'error') {
        clearInterval(poll);
        console.log('LOAD_FAIL ' + devState.error + '\n' + devLogs.slice(-15).join('\n'));
        cleanup();
        app.exit(1);
      }
    }, 500);
    setTimeout(() => {
      clearInterval(poll);
      console.log('LOAD_FAIL timeout state=' + devState.state + '\n' + devLogs.slice(-15).join('\n'));
      cleanup();
      app.exit(1);
    }, 120000);
  }
});
function cleanupAll(final) {
  for (const c of chatAborts.values()) {
    try { c.abort(); } catch {}
  }
  chatAborts.clear();
  try { stopDev(); } catch {}
  if (final && devState.sandbox) {
    const q = sandbox.cleanupOnQuit(devState.sandbox);
    if (q.kept) console.log('withlook: kept dirty sandbox at ' + q.path);
    devState.sandbox = null;
  }
}
// closing the window only tears down the session; the app stays alive on macOS and
// reopening from the dock lands on the main (welcome) view
app.on('window-all-closed', () => { cleanupAll(false); if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { quitting = true; cleanupAll(true); });
app.on('will-quit', () => { quitting = true; cleanupAll(true); });
process.on('exit', () => { try { cleanupAll(true); } catch {} });
