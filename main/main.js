'use strict';
const { app, BrowserWindow, WebContentsView, Menu, ipcMain, dialog, shell, screen, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const sandbox = require('./sandbox');
const frameworks = require('./frameworks');
const { listModels } = require('./local-models');
const scaffold = require('./scaffold');
const staticServer = require('./static-server');
const { References, MAX_REFS } = require('./references');
const { McpClient } = require('./mcp');
const { importFigma } = require('./figma');
const { cleanServers, normalizeMcp } = require('./mcp-servers');
const { exposeTools } = require('./agent-tools');
const mcpOauth = require('./mcp-oauth');

// a closed stdout pipe (e.g. launched through `| head`) must never crash the app
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

// ---------- constants ----------
const OVERLAY_W = 780;
const PILL_H = 52;
let pillH = PILL_H; // the floating pill grows with the composer
const TOP_GAP = 10;
const PANEL_VIEW_H = 660;
const SMOKE = process.argv.includes('--smoke');
const TEST_PROJ = (() => { const i = process.argv.indexOf('--test-project'); return i >= 0 ? process.argv[i + 1] : null; })();
const TEST_OPENCODE = (() => { const i = process.argv.indexOf('--test-opencode'); return i >= 0 ? process.argv[i + 1] : null; })();
const TEST_LOAD = (() => { const i = process.argv.indexOf('--test-load'); return i >= 0 ? process.argv[i + 1] : null; })();
const TEST_STATIC = process.argv.includes('--test-static');
// test runs must never touch the user's real memory.json / settings.json
if (SMOKE || TEST_PROJ || TEST_OPENCODE || TEST_LOAD || TEST_STATIC) {
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
let staticSrv = null; // in-process server for plain-HTML projects
let refsStore = null; // canvas reference images
let refsOpen = false;
const refCards = new Map(); // id → WebContentsView (draggable canvas cards)
const cardSig = new Map(); // id → last rendered signature
let refsSaveTimer = null;
const mcpClients = new Map(); // id → { client, status, tools, serverInfo, error }
let devWait = null; // port-poll timeout guard
let createProc = null; // active create-next-app scaffold
let createCancelled = false;
let devState = { state: 'idle', folder: null, projectFolder: null, sandbox: null, pm: null, framework: null, scaffold: false, port: null, url: null, error: null, external: false };
let devLogs = [];
const chatAborts = new Map();
let quitting = false; // true once the app is really quitting (not just closing the window)

// ---------- settings ----------
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const DEFAULT_SETTINGS = {
  provider: 'cloudflare',
  cloudflare: { accountId: '', token: '', model: '@cf/meta/llama-3.3-70b-instruct' },
  openai: { apiKey: '', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  local: { baseUrl: 'http://localhost:11434/v1', apiKey: '', model: '' },
  systemPrompt: '',
  editor: 'code',
  sandbox: true, // agent edits + dev server run in an isolated worktree; your folder is untouched
  agent: 'direct', // 'direct' = LLM API · 'opencode' = local opencode agent
  opencode: { model: '', agent: '' },
  // the app always opens on the dashboard; projects start only when the user clicks one
  window: null,
  memory: { url: 'postgres://postgres@localhost:5432/postgres' },
  mcp: normalizeMcp(null),
};
function loadSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return {
      ...DEFAULT_SETTINGS, ...s,
      cloudflare: { ...DEFAULT_SETTINGS.cloudflare, ...(s.cloudflare || {}) },
      openai: { ...DEFAULT_SETTINGS.openai, ...(s.openai || {}) },
      local: { ...DEFAULT_SETTINGS.local, ...(s.local || {}) },
      opencode: { ...DEFAULT_SETTINGS.opencode, ...(s.opencode || {}) },
      memory: { ...DEFAULT_SETTINGS.memory, ...(s.memory || {}) },
      mcp: normalizeMcp(s.mcp),
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
let refsShift = 0; // slides the page left to make room for the reference rail
let refsShiftTimer = null;
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
function refsVisible() {
  return !!(refsOpen && refsStore && refsStore.items.length && devState.state === 'running' && !homeMode && pageInMain);
}
function refsState() {
  return {
    items: refsStore ? refsStore.list() : [],
    open: refsVisible(),
    full: !!(refsStore && refsStore.items.length >= MAX_REFS),
    project: devState.projectFolder || null,
  };
}
function scheduleRefsSave() {
  if (refsSaveTimer) clearTimeout(refsSaveTimer);
  refsSaveTimer = setTimeout(() => {
    refsSaveTimer = null;
    if (refsStore) refsStore.save();
  }, 350);
}
async function pickReferences() {
  if (!refsStore) return refsState();
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
  });
  if (!r.canceled) {
    let added = 0;
    for (const f of r.filePaths) { const a = refsStore.addPath(f, newRefPlace()); if (a.ok) added++; }
    if (added) {
      refsOpen = true;
      pushDevLog(`withlook: added ${added} reference image${added === 1 ? '' : 's'}`);
      refsSend();
      updateRefsShift();
    }
  }
  return refsState();
}
function refsSend() {
  const s = refsState();
  try { if (overlayView && !overlayView.webContents.isDestroyed()) overlayView.webContents.send('refs:state', s); } catch {}
  syncRefCards();
  layout();
}
function sendCard(id) {
  const view = refCards.get(id);
  const item = refsStore && refsStore.items.find((i) => i.id === id);
  if (!view || !item) return;
  const sig = `${item.name}|${item.include}|${item.thumb.length}|${item.w}x${item.h}`;
  if (cardSig.get(id) === sig) return;
  cardSig.set(id, sig);
  try {
    view.webContents.send('ref:item', {
      id: item.id, name: item.name, thumb: item.thumb, include: item.include,
      width: item.width, height: item.height, w: item.w, h: item.h, zoom: canvas.zoom,
    });
  } catch {}
}
function syncRefCards() {
  if (!win) return;
  const visible = refsVisible();
  const items = (visible && refsStore) ? refsStore.items : [];
  const keep = new Set(items.map((i) => i.id));
  let changed = false;
  for (const [id, view] of [...refCards]) {
    if (!keep.has(id)) {
      try { win.contentView.removeChildView(view); } catch {}
      try { view.webContents.destroy(); } catch {}
      refCards.delete(id);
      cardSig.delete(id);
      changed = true;
    }
  }
  if (!visible) {
    for (const view of refCards.values()) { try { view.setVisible(false); } catch {} }
    return;
  }
  for (const item of items) {
    let view = refCards.get(item.id);
    if (!view) {
      view = new WebContentsView({
        webPreferences: { preload: path.join(__dirname, 'preload-overlay.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      try { view.setBackgroundColor('#00000000'); } catch {}
      view.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'ref-card.html')).catch(() => {});
      view.webContents.on('did-finish-load', () => { cardSig.delete(item.id); sendCard(item.id); });
      refCards.set(item.id, view);
      win.contentView.addChildView(view);
      changed = true;
    }
    try { view.setVisible(true); } catch {}
    sendCard(item.id);
  }
  if (changed) restackViews();
  layoutRefCards();
}
function layoutRefCards() {
  if (!win) return;
  const a = previewArea();
  const zoom = canvas.zoom || 1;
  for (const [id, view] of refCards) {
    const item = refsStore && refsStore.items.find((i) => i.id === id);
    if (!item) continue;
    const w = Math.max(80, Math.round(item.w * zoom));
    const h = Math.max(60, Math.round(item.h * zoom));
    let x = a.x + Math.round(item.x * zoom);
    let y = a.y + Math.round(item.y * zoom);
    // keep a corner reachable when the window or zoom changes
    x = Math.max(a.x - w + 48, Math.min(x, a.x + a.w - 48));
    y = Math.max(a.y - h + 48, Math.min(y, a.y + a.h - 48));
    try { view.setBounds({ x, y, width: w, height: h }); } catch {}
  }
}
function newRefPlace() {
  const a = previewArea();
  const z = canvas.zoom || 1;
  const n = refsStore ? refsStore.items.length : 0;
  const col = n % 2;
  const row = Math.floor(n / 2) % 4;
  return {
    x: Math.max(28, Math.round((a.w - 300 - col * 260) / z)),
    y: Math.round((24 + row * 260) / z),
  };
}
function animateRefsShift(target) {
  if (refsShiftTimer) { clearInterval(refsShiftTimer); refsShiftTimer = null; }
  const start = refsShift;
  if (Math.abs(start - target) < 1) { refsShift = target; applyCanvas(); return; }
  const t0 = Date.now();
  refsShiftTimer = setInterval(() => {
    const k = Math.min(1, (Date.now() - t0) / 220);
    const e = 1 - Math.pow(1 - k, 3);
    refsShift = start + (target - start) * e;
    applyCanvas();
    if (k >= 1) {
      clearInterval(refsShiftTimer);
      refsShiftTimer = null;
      refsShift = target;
      applyCanvas();
    }
  }, 16);
}
function updateRefsShift() {
  animateRefsShift(refsVisible() ? -220 : 0);
}
function mcpConfigs() {
  const m = loadSettings().mcp;
  return (m && Array.isArray(m.servers)) ? m.servers : [];
}
function mcpConfig(id) {
  return mcpConfigs().find((s) => s.id === id) || null;
}
function mcpTokens() {
  const m = loadSettings().mcp;
  return (m && m.oauthTokens && typeof m.oauthTokens === 'object') ? m.oauthTokens : {};
}
function saveMcpToken(id, tok) {
  const s = loadSettings();
  s.mcp = { ...(s.mcp || {}), oauthTokens: { ...((s.mcp && s.mcp.oauthTokens) || {}), [id]: tok } };
  saveSettings(s);
}
function clearMcpToken(id) {
  const s = loadSettings();
  const t = { ...((s.mcp && s.mcp.oauthTokens) || {}) };
  delete t[id];
  s.mcp = { ...(s.mcp || {}), oauthTokens: t };
  saveSettings(s);
}
function mcpState(id) {
  const cfg = mcpConfig(id) || { id, name: id, transport: 'http', url: '', command: '', args: [], enabled: false };
  const st = mcpClients.get(id);
  return {
    id,
    name: cfg.name,
    transport: cfg.transport,
    url: cfg.url,
    command: cfg.command,
    args: cfg.args,
    enabled: cfg.enabled,
    status: st ? st.status : 'disconnected',
    tools: st ? st.tools : [],
    server: (st && st.serverInfo) ? st.serverInfo.name : null,
    error: st ? st.error : null,
    signedIn: !!(cfg.token || mcpTokens()[id]),
    hasClient: !!cfg.clientId,
    clientId: cfg.clientId || '',
    redirectUri: cfg.redirectUri || '',
  };
}
function mcpStatus() {
  return {
    useTools: loadSettings().mcp.useTools !== false,
    servers: mcpConfigs().map((s) => mcpState(s.id)),
  };
}
async function mcpConnect(id, opts = {}) {
  const cfg = mcpConfig(id);
  if (!cfg) return { ok: false, error: 'Unknown connector.' };
  if (cfg.transport === 'http' && !/^https?:\/\//i.test(cfg.url || '')) {
    return { ok: false, error: 'Enter the connector URL.' };
  }
  if (cfg.transport === 'stdio' && !cfg.command) {
    return { ok: false, error: 'Enter the command to run.' };
  }
  let tok = cfg.token ? { accessToken: cfg.token } : (cfg.oauth ? (mcpTokens()[id] || null) : null);
  if (tok && tok.expiresAt && tok.expiresAt - 60000 <= Date.now() && tok.refreshToken) {
    try {
      const fresh = await mcpOauth.refresh({ token: tok });
      if (fresh) { tok = fresh; saveMcpToken(id, fresh); } else tok = null;
    } catch { tok = null; }
  }
  const prev = mcpClients.get(id);
  if (prev && prev.client) { try { prev.client.close(); } catch {} }
  mcpClients.set(id, { client: null, status: 'connecting', tools: [], toolsFull: null, serverInfo: null, error: null });
  const client = new McpClient({
    transport: cfg.transport,
    url: cfg.url,
    command: cfg.command,
    args: cfg.args,
    name: 'withlook',
    token: tok ? tok.accessToken : null,
  });
  try {
    await client.connect();
    return mcpConnected(id, cfg, client);
  } catch (e) {
    if (cfg.oauth && e.code === 401) return mcpOAuthRetry(id, cfg, client, e, opts);
    return mcpFailed(id, client, e);
  }
}
async function mcpConnected(id, cfg, client) {
  const tools = await client.listTools();
  mcpClients.set(id, { client, status: 'connected', tools: tools.map((t) => t.name), toolsFull: tools, serverInfo: client.serverInfo, error: null });
  pushDevLog(`withlook: connected ${cfg.name} (${tools.length} tool${tools.length === 1 ? '' : 's'})`);
  return { ok: true, server: mcpState(id) };
}
function mcpFailed(id, client, e) {
  try { client.close(); } catch {}
  mcpClients.set(id, { client: null, status: 'error', tools: [], toolsFull: null, serverInfo: null, error: e.message });
  return { ok: false, error: e.message, server: mcpState(id) };
}
function mcpDisconnect(id) {
  const st = mcpClients.get(id);
  if (st && st.client) { try { st.client.close(); } catch {} }
  mcpClients.delete(id);
  return mcpStatus();
}
async function mcpOAuthRetry(id, cfg, client, e, opts) {
  if (!opts.interactive) {
    try { client.close(); } catch {}
    const msg = 'Sign-in required — open Connectors and click connect.';
    mcpClients.set(id, { client: null, status: 'auth', tools: [], toolsFull: null, serverInfo: null, error: msg });
    return { ok: false, authRequired: true, error: msg, server: mcpState(id) };
  }
  if (!cfg.clientId && !cfg.pat) {
    try { client.close(); } catch {}
    const msg = 'Add an OAuth client ID and secret (or a Figma PAT) in this connector to sign in.';
    mcpClients.set(id, { client: null, status: 'auth', tools: [], toolsFull: null, serverInfo: null, error: msg });
    return { ok: false, needPat: true, needClient: true, error: msg, server: mcpState(id) };
  }
  try {
    pushDevLog(`withlook: opening the browser to sign in to ${cfg.name}`);
    const fresh = await mcpOauth.authorize({
      serverUrl: cfg.url,
      challenge: client.authChallenge || '',
      pat: cfg.pat,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      redirectUri: cfg.redirectUri,
      clientName: 'withlook',
      openUrl: (u) => {
        overlaySend('mcp:authUrl', { id, url: u });
        return shell.openExternal(u);
      },
    });
    saveMcpToken(id, fresh);
    client.token = fresh.accessToken;
    await client.connect();
    return mcpConnected(id, cfg, client);
  } catch (e2) {
    return mcpFailed(id, client, e2);
  }
}
function mcpSignOut(id) {
  const s = loadSettings();
  const servers = (s.mcp && Array.isArray(s.mcp.servers) ? s.mcp.servers : []).map((c) => (
    c.id === id ? { ...c, token: '' } : c
  ));
  s.mcp = { ...(s.mcp || {}), servers };
  saveSettings(s);
  clearMcpToken(id);
  return mcpDisconnect(id);
}
async function mcpSave(input) {
  const list = Array.isArray(input) ? input : (input && input.servers);
  const useTools = (!Array.isArray(input) && input && input.useTools !== undefined) ? !!input.useTools : undefined;
  const before = new Map(mcpConfigs().map((s) => [s.id, s]));
  const next = cleanServers(list).map((c) => {
    const prev = before.get(c.id);
    const keep = (k) => c[k] || (prev && prev[k]) || '';
    return { ...c, pat: keep('pat'), clientSecret: keep('clientSecret'), token: keep('token') };
  });
  const s = loadSettings();
  const keep = new Set(next.map((x) => x.id));
  const oauthTokens = { ...((s.mcp && s.mcp.oauthTokens) || {}) };
  for (const k of Object.keys(oauthTokens)) if (!keep.has(k)) delete oauthTokens[k];
  s.mcp = { ...(s.mcp || {}), servers: next, oauthTokens, ...(useTools === undefined ? {} : { useTools }) };
  saveSettings(s);
  for (const [id, st] of [...mcpClients]) {
    const cfg = next.find((x) => x.id === id);
    const prev = before.get(id);
    const changed = !cfg || !prev ||
      cfg.transport !== prev.transport || cfg.url !== prev.url ||
      cfg.command !== prev.command || JSON.stringify(cfg.args) !== JSON.stringify(prev.args) ||
      cfg.oauth !== prev.oauth;
    if (!cfg || !cfg.enabled || changed) {
      if (st.client) { try { st.client.close(); } catch {} }
      mcpClients.delete(id);
    }
  }
  const connects = next.filter((c) => c.enabled && !mcpClients.has(c.id)).map((c) => mcpConnect(c.id));
  if (connects.length) await Promise.allSettled(connects);
  return mcpStatus();
}
async function mcpAddFigmaRemote() {
  const id = 'figma-remote';
  const list = mcpConfigs().map((s) => ({ ...s }));
  const preset = {
    id,
    name: 'Figma (remote)',
    transport: 'http',
    url: 'https://mcp.figma.com/mcp',
    command: '',
    args: [],
    enabled: false,
    oauth: true,
  };
  const i = list.findIndex((s) => s.id === id);
  if (i >= 0) list[i] = { ...list[i], ...preset };
  else list.push(preset);
  await mcpSave(list);
  return { ok: true, id, server: mcpState(id) };
}
async function mcpAddFigmaLocal() {
  const id = 'figma';
  const list = mcpConfigs().map((s) => ({ ...s }));
  const preset = {
    id,
    name: 'Figma (local)',
    transport: 'http',
    url: 'http://127.0.0.1:3845/mcp',
    command: '',
    args: [],
    enabled: false,
    oauth: false,
  };
  const i = list.findIndex((s) => s.id === id);
  if (i >= 0) list[i] = { ...list[i], ...preset };
  else list.push(preset);
  await mcpSave(list);
  return { ok: true, id, server: mcpState(id) };
}
function figmaServerId() {
  const list = mcpConfigs();
  const fig = list.find((s) => s.id === 'figma') || list.find((s) => /figma/i.test(s.name));
  return fig ? fig.id : null;
}
async function ensureFigmaClient() {
  const id = figmaServerId();
  if (!id) return { ok: false, error: 'Add a Figma connector in Connectors first.' };
  const st = mcpClients.get(id);
  if (st && st.status === 'connected' && st.client) return { ok: true, id };
  const r = await mcpConnect(id);
  return r.ok ? { ok: true, id } : { ok: false, error: r.error };
}
// WIP: used by the tool-calling loop (not wired into handleChatSend yet)
async function mcpToolsForModel() {
  const servers = [];
  for (const cfg of mcpConfigs()) {
    const st = mcpClients.get(cfg.id);
    if (!st || st.status !== 'connected' || !st.client) continue;
    let full = st.toolsFull;
    if (!Array.isArray(full) || !full.length) {
      try { full = await st.client.listTools(); st.toolsFull = full; } catch { full = []; }
    }
    if (full.length) servers.push({ id: cfg.id, name: cfg.name, tools: full });
  }
  return exposeTools(servers);
}
function previewArea() {
  const [W, H] = win.getContentSize();
  if (dockMode) {
    const dockW = chatHidden ? 0 : Math.round(Math.max(330, Math.min(440, W * 0.34)));
    const showSidebar = !sidebarHidden && W >= 1000;
    try { if (sidebarView) sidebarView.setVisible(showSidebar); } catch {}
    const left = showSidebar ? SIDEBAR_W : 0;
    return { x: left, y: TAB_BAR_H, w: Math.max(200, W - left - dockW), h: Math.max(120, H - TAB_BAR_H) };
  }
  try { if (sidebarView) sidebarView.setVisible(false); } catch {}
  return { x: 0, y: TAB_BAR_H, w: W, h: Math.max(120, H - TAB_BAR_H) };
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
    const chrome = [overlayView, canvasBarView, panGlassView, tabbarView, sidebarView, loaderView, ...refCards.values()];
    for (const v of [...chrome, ...tabs.map((t) => t.view)]) win.contentView.removeChildView(v);
    win.contentView.addChildView(pageView);
    for (const t of tabs) if (t.view !== pageView) win.contentView.addChildView(t.view);
    for (const v of refCards.values()) win.contentView.addChildView(v);
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
    const scaffolding = devState.state === 'starting' && devState.scaffold;
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
  let x = fa.x + Math.round((fa.w - w) / 2) + canvas.x + refsShift;
  let y = fa.y + Math.round((fa.h - h) / 2) + canvas.y;
  x = Math.min(Math.max(x, fa.x - w + 120), fa.x + fa.w - 120);
  y = Math.min(Math.max(y, fa.y - h + 120), fa.y + fa.h - 120);
  if (multiCanvas && pageInMain) {
    // every tab side by side on the same canvas
    const GAP = 40;
    const baseX = fa.x + Math.round((fa.w - w) / 2) + canvas.x + refsShift;
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
    // frames read as cards on the stage whenever they don't fill it
    const radius = (multiCanvas || canvas.zoom !== 1) ? 10 : 0;
    for (const t of tabs) { try { t.view.setBorderRadius(radius); } catch {} }
  }
  try {
    if (tabbarView) {
      const barH = tabMenuOpen ? H : TAB_BAR_H; // full height when a dropdown is open, so its backdrop covers the whole window
      tabbarView.setBounds({ x: 0, y: 0, width: W, height: barH });
      tabbarView.setVisible(showTopBar);
    }
    applyLoader();
    const bw = 420; // wide enough for every dock control
    canvasBarView.setBounds({ x: a.x + Math.round((a.w - bw) / 2), y: a.y + a.h - 42 - 14, width: bw, height: 42 });
    canvasBarView.setVisible(showCanvasBar);
    panGlassView.setBounds({ x: fa.x, y: fa.y, width: fa.w, height: fa.h });
    panGlassView.setVisible(showCanvasBar && canvas.panMode);
    if (sidebarView) sidebarView.setBounds({ x: 0, y: TAB_BAR_H, width: SIDEBAR_W, height: H - TAB_BAR_H });
    if (!canvasBarView.webContents.isDestroyed()) {
      canvasBarView.webContents.send('canvas:state', { ...canvas, frames: tabs.length, dev: devState.state, dock: dockMode, multi: multiCanvas });
    }
  } catch {}
  layoutRefCards();
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
  const camera = action === 'in' || action === 'out' || action === 'fit' || action === 'panMode' || action === 'pan' || action === 'center';
  if (camera && (homeMode || devState.state !== 'running')) return;
  switch (action) {
    case 'in': canvas.zoom = Math.min(3, Math.round(canvas.zoom * 1.25 * 1000) / 1000); break;
    case 'out': canvas.zoom = Math.max(0.25, Math.round(canvas.zoom / 1.25 * 1000) / 1000); break;
    case 'fit': canvas.zoom = 1; canvas.x = 0; canvas.y = 0; break;
    case 'panMode': canvas.panMode = !!data; break;
    case 'pan': canvas.x += (data && data.dx) || 0; canvas.y += (data && data.dy) || 0; break;
    case 'center': canvas.x = 0; canvas.y = 0; break;
    case 'addRef': pickReferences(); break;
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
    case 'connectors': overlaySend('ui:openConnectors', {}); break;
  }
  applyCanvas();
}

function layout() {
  if (!win || !pageView || !overlayView) return;
  const [W, H] = win.getContentSize();
  syncRefCards();
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
  const h = panelOpen ? Math.min(PANEL_VIEW_H, H - yBase - 16) : pillH;
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
  overlaySend('ui:mode', { open: panelOpen, dock: dockMode, home: homeMode, preview: !!(previewWin && !previewWin.isDestroyed()) });
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
    overlaySend('ui:mode', { open: panelOpen, dock: dockMode, home: homeMode, preview: true });
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
      overlaySend('ui:mode', { open: panelOpen, dock: dockMode, home: homeMode, preview: false });
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
    swapPageFile(PLACEHOLDER_FILE);
  } catch {}
}
function openHome() {
  if (quitting) return;
  if (settingsModal) { settingsModal = false; overlaySend('ui:closeSettings', {}); }
  if (refsShiftTimer) { clearInterval(refsShiftTimer); refsShiftTimer = null; }
  refsShift = 0;
  homeMode = true;
  broadcastTabs();
  if (panelOpen) setPanelOpen(false); // the dashboard owns the window
  try { if (previewWin && !previewWin.isDestroyed()) previewWin.close(); } catch {}
  try {
    if (win && !win.isDestroyed() && !win.contentView.children.includes(pageView)) restackViews();
    pageInMain = true;
    canvas.zoom = 1; canvas.x = 0; canvas.y = 0; canvas.panMode = false;
    layout();
    swapPageFile(PLACEHOLDER_FILE);
    overlaySend('ui:mode', { open: panelOpen, dock: dockMode, home: homeMode, preview: false });
  } catch {}
}

// ---------- picker ----------
const pickerSource = fs.readFileSync(path.join(__dirname, 'picker-inject.js'), 'utf8');
function startPicker() {
  if (!pageView) return;
  if (homeMode || devState.state !== 'running') return; // no page to pick on the dashboard
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
async function findExistingDevServer(folder, ports) {
  const scanPorts = Array.isArray(ports) && ports.length ? ports : (() => {
    const a = [];
    for (let p = 3000; p <= 3012; p++) a.push(p);
    return a;
  })();
  for (const port of scanPorts) {
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
  devState.folder = folder;
  devState.projectFolder = folder;
  if (tabs[0]) tabs[0].route = '/';
  pushDevLog(`withlook: found a dev server already running for this project on :${port} — attaching`);
  markServerReady(port, { external: true });
}
async function attachDevServerUrl(input, folder) {
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, error: 'Enter a port or URL.' };
  const url = (/^https?:\/\//i.test(raw) ? raw : 'http://localhost:' + raw.replace(/^:/, '')).replace(/\/+$/, '');
  let port;
  try {
    const u = new URL(url);
    port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  } catch { return { ok: false, error: 'That is not a valid URL.' }; }
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (r.status >= 500) return { ok: false, error: `The server on ${url} responded with ${r.status}.` };
  } catch {
    return { ok: false, error: `Could not reach ${url}. Is the server running?` };
  }
  let project = folder || devState.projectFolder || devState.folder;
  try {
    const pids = await sh('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
    const pid = pids && pids.split('\n').filter(Boolean)[0];
    if (pid) {
      const cwdOut = await sh('lsof', ['-p', pid, '-a', '-d', 'cwd', '-Fn']);
      const m = cwdOut ? cwdOut.match(/\nn(.+)/) : null;
      const cwd = m ? m[1].trim() : '';
      if (cwd) {
        const resolved = resolveProjectFolder(cwd) || cwd;
        const same = project && (cwd === project || cwd.startsWith(project + path.sep) || project.startsWith(cwd + path.sep));
        if (!same) {
          if (project) pushDevLog(`withlook: :${port} is running from ${resolved} — switching the project to it`);
          project = resolved;
        }
      }
    }
  } catch {}
  homeMode = false;
  stopDev(true);
  if (devState.sandbox) {
    const q = sandbox.cleanupOnQuit(devState.sandbox);
    if (q.kept) pushDevLog(`withlook: kept the sandbox at ${q.path}`);
    devState.sandbox = null;
  }
  devState.folder = project;
  devState.projectFolder = project;
  devState.external = true;
  if (refsStore) {
    refsStore.setProject(project);
    refsOpen = refsStore.items.length > 0;
    refsSend();
  }
  pushDevLog(`withlook: attaching to ${url} — edits apply to the project folder`);
  markServerReady(port, { external: true, url });
  return { ok: true, port, url };
}
// one place that flips a project to "running": status, store, preview, every tab
function markServerReady(port, opts = {}) {
  const localUrl = opts.url || `http://localhost:${port}`;
  setDevStatus({ state: 'running', port, url: localUrl, external: !!opts.external });
  pushDevLog(`withlook: server is up → ${localUrl}`);
  refreshGitViews();
  if (store) {
    const projectFolder = devState.projectFolder || devState.folder;
    store.upsertProject({ folder: projectFolder, name: path.basename(projectFolder), pm: devState.pm, port })
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
  updateRefsShift();
}

// ---------- dev server ----------
function resolveProjectFolder(folder) {
  if (!folder) return null;
  if (fs.existsSync(path.join(folder, 'package.json'))) return folder;
  if (fs.existsSync(path.join(folder, 'index.html'))) return folder; // plain HTML site
  // users often pick the parent of the app (e.g. ~/Developer/jyt-web/jyt-web)
  try {
    const children = fs.readdirSync(folder, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && (
        fs.existsSync(path.join(folder, d.name, 'package.json')) ||
        fs.existsSync(path.join(folder, d.name, 'index.html'))
      ));
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
  if (refsShiftTimer) { clearInterval(refsShiftTimer); refsShiftTimer = null; }
  refsShift = 0;
  if (!keepView) closeExtraTabs(); // a restart (keepView) reloads its tabs when the server returns
  if (createProc) { createCancelled = true; killProc(createProc); createProc = null; }
  if (devProc) { killProc(devProc); devProc = null; }
  if (staticSrv) { try { staticSrv.close(); } catch {} staticSrv = null; }
  if (devWait) { clearTimeout(devWait); devWait = null; }
  if (devState.state !== 'idle') setDevStatus({ state: 'idle', url: null, port: null, framework: null, scaffold: false, error: null, external: false });
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
  devState.folder = folder;
  if (refsStore) {
    refsStore.setProject(folder);
    refsOpen = refsStore.items.length > 0;
    refsSend();
  }
  // reopening a project whose dev server is still running should attach, not start a second one
  const early = await findExistingDevServer(folder, frameworks.portsFor(folder));
  if (early) {
    devState.pm = detectPM(folder);
    const fw0 = frameworks.detectFramework(folder);
    devState.framework = { id: fw0.id, name: fw0.name };
    attachDevServer(early, folder);
    return;
  }
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
      setDevStatus({ state: 'starting', folder, projectFolder: folder, pm: null, framework: null, port: null, url: null, error: null, external: false });
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

  const fw = frameworks.detectFramework(runFolder);
  const framework = { id: fw.id, name: fw.name };
  const pm = fw.id === 'static' ? null : detectPM(runFolder);
  pushDevLog(`withlook: ${fw.name} project detected${pm ? ` (${pm})` : ''}${fw.routes ? '' : ' — routes are added as tabs'}`);
  setDevStatus({ state: 'starting', folder: runFolder, projectFolder: folder, sandbox: devState.sandbox, pm, framework, scaffold: false, port: null, url: null, error: null, external: false });
  broadcastTabs();
  // plain HTML has no dev command — withlook serves the folder itself
  if (fw.id === 'static') {
    pushDevLog('withlook: plain HTML — serving the folder locally');
    const srv = await staticServer.start(runFolder);
    if (!srv.ok) { setDevStatus({ state: 'error', error: `Could not start the static server: ${srv.error}` }); return; }
    staticSrv = srv.server;
    markServerReady(srv.port);
    return;
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
        let live = await findExistingDevServer(folder, frameworks.portsFor(folder));
        if (!live) {
          // a booting instance may not have opened its port yet — give it a few seconds
          for (let i = 0; i < 6 && !live; i++) { await sleep(800); live = await findExistingDevServer(folder, frameworks.portsFor(folder)); }
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
      const busy = devLogs.find((l) => /EADDRINUSE|address already in use/i.test(l));
      if (busy) {
        const m = busy.match(/:(\d{2,5})\b/);
        setDevStatus({ state: 'error', error: `Port ${m ? m[1] : '?'} is already in use. Stop the other server, attach to it, or change the dev port.` });
        return;
      }
      setDevStatus({ state: 'error', error: `Dev server exited (code ${code}). See logs.` });
    }
  });
  devWait = setTimeout(() => {
    devWait = null;
    if (devProc === proc && !portFound) { portFound = true; waitForPort(fw.ports[0] || 3000, proc); }
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
        markServerReady(port);
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
// swap the preview document without a white flash: hide → load → show
async function swapPageFile(file) {
  if (!pageView || pageView.webContents.isDestroyed()) return;
  try { pageView.setVisible(false); } catch {}
  try { await pageView.webContents.loadFile(file); } catch (e) {
    // aborted loads are normal when navigating away or quitting
    if (!quitting && !/ERR_ABORTED|ERR_FAILED/.test(e.message)) console.error('page load failed', e.message);
  }
  try { if (pageInMain) pageView.setVisible(activeTab === 0); } catch {}
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
        if (file.split('/').includes('withlook-references')) continue; // agent-only reference copies
        const st = stats[file] || {};
        files.push({ status, path: file, abs: path.join(folder, file), adds: st.adds, dels: st.dels });
      }
    }
    return { ok: true, branch: branch.trim(), repo, remote, files };
  })();
}
async function gitSharePatch(mode) {
  const folder = gitFolder('sandbox');
  if (!folder) return { ok: false, error: 'No project.' };
  const run = (args) => new Promise((resolve) => {
    execFile('git', args, { cwd: folder, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });
  const [patch, statusOut, branchOut] = await Promise.all([
    run(['diff', 'HEAD', '--binary']),
    run(['status', '--porcelain=v1', '-z']),
    run(['rev-parse', '--abbrev-ref', 'HEAD']),
  ]);
  if (patch === null) return { ok: false, error: 'git diff failed.' };
  const files = [];
  const untracked = [];
  if (statusOut) {
    const parts = statusOut.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p) continue;
      const status = p.slice(0, 2);
      const file = p.slice(3);
      if (status[0] === 'R' || status[0] === 'C') i++; // skip rename origin
      if (!file) continue;
      if (/^\.env(\..+)?$/.test(path.basename(file))) continue;
      if (file.split('/').includes('withlook-references')) continue;
      files.push({ status: status.trim() || '?', path: file });
      if (status === '??') untracked.push(file);
    }
  }
  if (mode === 'copy') {
    clipboard.writeText(patch);
    return { ok: true, bytes: patch.length, files: files.length };
  }
  const dir = path.join(app.getPath('userData'), 'patches');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.basename(folder) + '-' + stamp;
  const patchPath = path.join(dir, base + '.patch');
  const manifestPath = path.join(dir, base + '.json');
  const manifest = {
    project: folder,
    branch: branchOut ? branchOut.trim() : '',
    base: 'HEAD',
    createdAt: new Date().toISOString(),
    patch: patchPath,
    files,
    untracked,
  };
  fs.writeFileSync(patchPath, patch);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { ok: true, patchPath, manifestPath, bytes: patch.length, files: files.length };
}

// ---------- pages (route list from the detected framework) ----------
let lastRoutesLog = '';
async function listPages() {
  const candidates = [
    devState.folder,
    devState.projectFolder,
    devState.sandbox && devState.sandbox.projectPath,
    devState.sandbox && devState.sandbox.folder,
  ].filter(Boolean);
  for (const folder of [...new Set(candidates)]) {
    try {
      const routes = await frameworks.listRoutes(folder);
      if (routes.length) { lastRoutesLog = ''; return routes; }
    } catch {}
  }
  const folder = devState.folder;
  if (folder) {
    const hint = fs.existsSync(path.join(folder, 'apps')) ? ' — this looks like a monorepo root; open apps/<app> for route tabs' : '';
    const msg = `withlook: no routes found in ${folder}${hint}`;
    if (msg !== lastRoutesLog) { lastRoutesLog = msg; pushDevLog(msg); }
  }
  return [];
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

// opencode reads text prompts — hand it real files it can open
function copyRefsForAgent(refs) {
  const dir = path.join(app.getPath('userData'), 'agent-refs');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { return ''; }
  const names = [];
  for (const r of refs) {
    try {
      const dest = path.join(dir, `${r.id.slice(0, 8)}-${path.basename(r.path)}`);
      if (!fs.existsSync(dest)) fs.copyFileSync(r.path, dest);
      names.push(dest);
    } catch {}
  }
  return names.length
    ? `\n\nReference images for visual guidance (open them if your model supports images): ${names.join(', ')}`
    : '';
}

async function handleChatSend(_e, { id, messages, context }) {
  const settings = loadSettings();
  const refs = (context && Array.isArray(context.referenceIds) && refsStore)
    ? refsStore.byIds(context.referenceIds)
    : [];
  const sys = buildSystemPrompt(settings, { ...(context || {}), referenceCount: refs.length }, settings.agent);
  const msgs = [{ role: 'system', content: sys },
    ...(Array.isArray(messages) ? messages : []).map((m) => ({ role: m.role, content: String(m.content || '') }))];

  // ---- opencode agent: a local coding agent edits the repo directly ----
  if (settings.agent === 'opencode') {
    const folder = devState.folder || devState.projectFolder;
    if (!folder) { overlaySend('chat:error', { id, error: 'Open a project first — opencode runs inside it.' }); return; }
    const oc = settings.opencode || {};
    const args = ['run', '--auto', '--format', 'json'];
    if (oc.model) args.push('--model', oc.model);
    if (oc.agent) args.push('--agent', oc.agent);
    let prompt =
      `You are running inside the user's project at ${folder}. ` +
      'The chat context below may include selected page elements and their source code excerpts — use that context and make the requested change directly. ' +
      'Do not explore the whole codebase or read unrelated configuration/settings files unless strictly necessary. ' +
      'Do not narrate your investigation ("Let me look…", "Let me check…") — keep progress notes brief and put the result and the changes in your final answer. ' +
      'Do not modify config files (package.json, tsconfig, opencode config) unless explicitly asked.\n\n' +
      msgs.map((m) => (m.role === 'system' ? m.content : `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)).join('\n\n');
    if (refs.length) prompt += copyRefsForAgent(refs);
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
        if (!j) { overlaySend('chat:chunk', { id, delta: stripAnsi(line) + '\n', kind: 'text' }); continue; }
        if (j.type === 'background_wait') {
          const jobs = Array.isArray(j.jobs) ? j.jobs : [];
          const what = jobs.map((x) => x && (x.title || x.id)).filter(Boolean).join(' · ');
          overlaySend('chat:chunk', { id, kind: 'status', delta: 'background · ' + String(what || 'waiting').slice(0, 160) });
          continue;
        }
        if (!j.part) { pushDevLog('opencode: ' + stripAnsi(line).slice(0, 300)); continue; }
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

  // direct providers: attach the selected references to the latest user turn
  if (refs.length) {
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    if (lastUser) {
      lastUser.content = [
        { type: 'text', text: String(lastUser.content || '') },
        ...refs.map((r) => ({ type: 'image_url', image_url: { url: r.dataUrl } })),
      ];
    }
  }

  const provider = settings.provider === 'openai' ? 'openai' : settings.provider === 'local' ? 'local' : 'cloudflare';
  let url, headers = { 'Content-Type': 'application/json' }, body, model, localBase = '';
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
  } else if (provider === 'local') {
    // any OpenAI-compatible server on this machine: Ollama, LM Studio, llama.cpp, vLLM…
    const lo = settings.local || {};
    localBase = String(lo.baseUrl || 'http://localhost:11434/v1').replace(/\/+$/, '');
    if (!lo.model) {
      overlaySend('chat:error', { id, error: 'A local model is selected but no model name is set. Open Settings (⌘,) → Local → refresh models.' });
      return;
    }
    model = lo.model;
    url = `${localBase}/chat/completions`;
    if (lo.apiKey) headers.Authorization = `Bearer ${lo.apiKey}`; // most local servers ignore it
    body = { model, messages: msgs, stream: true };
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
    if (ctrl.signal.aborted) {
      overlaySend('chat:done', { id });
    } else {
      let msg = err?.message || String(err);
      if (provider === 'local') {
        const code = err?.cause?.code ? ` (${err.cause.code})` : '';
        msg = `Could not reach the local model server at ${localBase}${code}. Is it running? ${msg}`;
      }
      overlaySend('chat:error', { id, error: msg });
    }
  } finally {
    chatAborts.delete(id);
  }
}

// ---------- menu ----------
function buildMenu() {
  const isMac = process.platform === 'darwin';
  // project-only shortcuts are inert on the dashboard (recent projects)
  const live = () => !homeMode && devState.state === 'running';
  const menu = [
    ...(isMac ? [{
      label: app.name, submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Open Project', submenu: [
          { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: () => overlaySend('ui:openProject', {}) },
          { label: 'Attach Project…', accelerator: 'CmdOrCtrl+Shift+O', click: () => overlaySend('ui:openAttach', {}) },
        ] },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => overlaySend('ui:openSettings', {}) },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : [{
      label: 'File', submenu: [
        { label: 'Open Project', submenu: [
          { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: () => overlaySend('ui:openProject', {}) },
          { label: 'Attach Project…', accelerator: 'CmdOrCtrl+Shift+O', click: () => overlaySend('ui:openAttach', {}) },
        ] },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => overlaySend('ui:openSettings', {}) },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }]),
    { role: 'editMenu' },
    {
      label: 'Page', submenu: [
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => { if (live()) navGo(-1); } },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => { if (live()) navGo(1); } },
        { label: 'Reload Page', accelerator: 'CmdOrCtrl+R', click: () => { if (live() && pageView) pageView.webContents.reload(); } },
        { label: 'Page DevTools', accelerator: 'CmdOrCtrl+Alt+I', click: () => { if (live() && pageView) pageView.webContents.toggleDevTools(); } },
      ],
    },
    {
      label: 'Withlook', submenu: [
        { label: 'Home', accelerator: 'CmdOrCtrl+Shift+H', click: () => openHome() },
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: () => { if (!homeMode) toggleSidebar(); } },
        { label: 'Toggle Chat', accelerator: 'CmdOrCtrl+Shift+J', click: () => { if (live()) toggleChat(); } },
        { label: 'Select Element on Page', accelerator: 'CmdOrCtrl+E', click: () => { if (live()) startPicker(); } },
        { label: 'Focus Chat', accelerator: 'CmdOrCtrl+K', click: () => { if (live()) overlaySend('ui:focusChat', {}); } },
        { label: 'Toggle Float', accelerator: 'CmdOrCtrl+F', click: () => { if (live()) toggleFloat(); } },
        { label: 'Toggle Chat Panel', accelerator: 'CmdOrCtrl+J', click: () => { if (live()) overlaySend('ui:togglePanel', {}); } },
      ],
    },
    {
      label: 'Canvas', submenu: [
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => { if (live()) doCanvasAction('in'); } },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+Minus', click: () => { if (live()) doCanvasAction('out'); } },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => { if (live()) doCanvasAction('fit'); } },
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
  loaderView.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'loader.html')).catch(() => {});

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
    if (ch === 'ui:ready') {
      overlaySend('dev:status', devState);
      overlaySend('page:nav', navInfo());
      try { overlayView.webContents.send('refs:state', refsState()); } catch {}
    }
  });
  layout();
}

// ---------- IPC ----------
function wireIpc() {
  ipcMain.handle('settings:get', () => loadSettings());
  ipcMain.handle('settings:save', (_e, s) => {
    const cur = loadSettings();
    if (s && typeof s === 'object') s.mcp = cur.mcp; // connectors are managed by the connectors modal
    saveSettings(s);
    return true;
  });
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    releases: 'https://github.com/Jaal-Yantra-Textiles/onlook/releases',
  }));
  ipcMain.handle('app:releases', () => {
    shell.openExternal('https://github.com/Jaal-Yantra-Textiles/onlook/releases').catch(() => {});
    return true;
  });
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
  ipcMain.handle('create:openPage', async () => {
    stopDev(true); // stop any running server but keep the view we are about to replace
    cancelPicker();
    if (panelOpen) setPanelOpen(false); // the create page owns the window — no chat overlay
    homeMode = true;
    try { if (previewWin && !previewWin.isDestroyed()) previewWin.close(); } catch {}
    broadcastTabs();
    layout();
    await swapPageFile(CREATE_FILE); // hide → load → show, so there is no white flash
    return true;
  });
  ipcMain.handle('create:pickLocation', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });
  ipcMain.handle('create:templates', () => scaffold.TEMPLATES);
  ipcMain.handle('create:submit', async (_e, opts) => {
    const p = scaffold.plan(opts || {});
    if (!p.ok) return { ok: false, error: p.error };

    stopDev(true); // keep the create page on screen while scaffolding
    devLogs = [];
    setDevStatus({ state: 'starting', folder: p.folder, pm: 'scaffold', scaffold: true, framework: null, port: null, url: null, error: null, external: false });
    const sendPage = (ch, d) => { try { pageView.webContents.send(ch, d); } catch {} };
    pushDevLog(`$ ${p.label}   (in ${p.cwd || p.folder})`);

    // onboarding: add it to Recent projects and return to the dashboard — never auto-start it
    const created = (folder) => {
      const pm = detectPM(folder);
      if (store) store.upsertProject({ folder, name: path.basename(folder), pm, port: null }).catch((e) => console.error('store upsert failed', e.message));
      setDevStatus({ state: 'idle', url: null, port: null, framework: null, scaffold: false, error: null, external: false });
      sendPage('create:status', { phase: 'created', folder });
      setTimeout(() => { openHome(); }, 700);
      return { ok: true, folder };
    };
    const failed = (error) => {
      setDevStatus({ state: 'error', error, scaffold: false });
      sendPage('create:status', { phase: 'error', error });
      return { ok: false, error };
    };

    // plain HTML: written in-process, no network, no tooling
    if (p.kind === 'html') {
      const r = scaffold.writePlainHtml(p.folder, p.name);
      if (!r.ok) return failed(r.error || 'Could not write the starter files.');
      for (const f of r.files) pushDevLog(`withlook: wrote ${f}`);
      if (r.git) pushDevLog('withlook: initialized a git repository');
      return created(p.folder);
    }

    if (p.mkdir) { try { fs.mkdirSync(p.folder, { recursive: true }); } catch {} }

    return new Promise((resolve) => {
      let proc;
      try {
        proc = spawn(p.cmd, p.args || [], {
          cwd: p.cwd || p.parent,
          env: { ...process.env, CI: '1', BROWSER: 'none' },
          shell: !!p.shell,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) { return resolve(failed(e.message)); }
      createProc = proc;
      createCancelled = false;
      const onLine = (line) => { pushDevLog(line); sendPage('create:log', line); };
      readline.createInterface({ input: proc.stdout }).on('line', onLine);
      readline.createInterface({ input: proc.stderr }).on('line', onLine);
      proc.on('error', (e) => { createProc = null; resolve(failed(e.message)); });
      proc.on('exit', (code) => {
        const wasCancelled = createCancelled;
        createProc = null;
        if (wasCancelled) {
          setDevStatus({ state: 'idle', scaffold: false });
          sendPage('create:status', { phase: 'cancelled' });
          resolve({ ok: false, error: 'Cancelled — partial files may remain in the folder.' });
          return;
        }
        if (code !== 0) { resolve(failed(`${p.label} exited with code ${code}`)); return; }
        // a custom command can "succeed" without writing anything
        if (p.kind === 'custom') {
          let entries = [];
          try { entries = fs.readdirSync(p.folder); } catch {}
          if (!entries.length) { resolve(failed('The command finished, but the folder is still empty.')); return; }
        }
        resolve(created(p.folder));
      });
    });
  });
  ipcMain.handle('dev:start', async (_e, folder) => {
    const resolved = resolveProjectFolder(folder);
    if (!resolved) {
      return { ok: false, error: 'That folder has no package.json or index.html — is it a web project?' };
    }
    startDev(resolved);
    return { ok: true, folder: resolved };
  });
  ipcMain.handle('dev:stop', () => { stopDev(); return true; });
  ipcMain.handle('dev:restart', () => restartDev());
  ipcMain.handle('dev:attach', (_e, url) => attachDevServerUrl(url, devState.projectFolder || devState.folder));
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
  ipcMain.handle('git:share-patch', (_e, mode) => gitSharePatch(mode === 'save' ? 'save' : 'copy'));
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
  // local OpenAI-compatible servers: list installed models (Ollama, LM Studio, llama.cpp, vLLM…)
  ipcMain.handle('local:models', (_e, baseUrl) => listModels(baseUrl));
  // canvas reference images
  ipcMain.handle('refs:list', () => refsState());
  ipcMain.handle('refs:pick', () => pickReferences());
  ipcMain.handle('refs:add-data', (_e, d) => {
    if (!refsStore) return { ok: false, error: 'No project.', ...refsState() };
    const url = String((d && d.dataUrl) || '');
    const m = url.match(/^data:image\/[a-z0-9.+-]+;base64,(.+)$/i);
    if (!m) return { ok: false, error: 'Not an image.', ...refsState() };
    if (m[1].length > 24 * 1024 * 1024) return { ok: false, error: 'Image is too large.', ...refsState() };
    const r = refsStore.addBuffer(Buffer.from(m[1], 'base64'), String((d && d.name) || 'image.png'), newRefPlace());
    if (r.ok) { refsOpen = true; refsSend(); updateRefsShift(); }
    return { ok: r.ok, error: r.error, ...refsState() };
  });
  ipcMain.handle('refs:paste', () => {
    if (!refsStore) return { ok: false, error: 'No project.', ...refsState() };
    const img = clipboard.readImage();
    if (img.isEmpty()) return { ok: false, error: 'No image in the clipboard.', ...refsState() };
    const r = refsStore.addBuffer(img.toPNG(), 'pasted image.png', newRefPlace());
    if (r.ok) { refsOpen = true; refsSend(); updateRefsShift(); }
    return { ok: r.ok, error: r.error, ...refsState() };
  });
  ipcMain.handle('refs:remove', (_e, id) => {
    if (refsStore) refsStore.remove(String(id));
    refsSend();
    updateRefsShift();
    return refsState();
  });
  ipcMain.handle('refs:toggle', (_e, id) => {
    if (refsStore) refsStore.toggle(String(id));
    refsSend();
    return refsState();
  });
  ipcMain.handle('refs:tray', (_e, open) => {
    refsOpen = !!open;
    refsSend();
    updateRefsShift();
    return refsState();
  });
  // canvas card drag/resize (renderer → main, no reply)
  ipcMain.on('ref:move', (_e, d) => {
    if (!refsStore || !d || !d.id) return;
    const item = refsStore.items.find((i) => i.id === d.id);
    if (!item) return;
    const z = canvas.zoom || 1;
    refsStore.setBox(item.id, {
      x: item.x + (Number(d.dx) || 0) / z,
      y: item.y + (Number(d.dy) || 0) / z,
    });
    layoutRefCards();
    scheduleRefsSave();
  });
  ipcMain.on('ref:resize', (_e, d) => {
    if (!refsStore || !d || !d.id) return;
    const item = refsStore.items.find((i) => i.id === d.id);
    if (!item) return;
    const z = canvas.zoom || 1;
    refsStore.setBox(item.id, {
      w: item.w + (Number(d.dw) || 0) / z,
      h: item.h + (Number(d.dh) || 0) / z,
    });
    layoutRefCards();
    scheduleRefsSave();
  });
  ipcMain.on('ref:move-end', () => { if (refsStore) refsStore.save(); });
  // MCP / Figma
  ipcMain.handle('mcp:status', () => mcpStatus());
  ipcMain.handle('mcp:servers', () => mcpStatus());
  ipcMain.handle('mcp:save', (_e, servers) => mcpSave(servers));
  ipcMain.handle('mcp:connect', (_e, id) => mcpConnect(String(id), { interactive: true }));
  ipcMain.handle('mcp:disconnect', (_e, id) => mcpDisconnect(String(id)));
  ipcMain.handle('mcp:signout', (_e, id) => mcpSignOut(String(id)));
  ipcMain.handle('mcp:preset-figma', () => mcpAddFigmaRemote());
  ipcMain.handle('mcp:preset-figma-local', () => mcpAddFigmaLocal());
  ipcMain.handle('app:openExternal', (_e, url) => {
    const u = String(url || '');
    if (!/^https?:\/\//i.test(u)) return false;
    shell.openExternal(u).catch(() => {});
    return true;
  });
  ipcMain.handle('figma:import', async (_e, input) => {
    const f = await ensureFigmaClient();
    if (!f.ok) return f;
    const st = mcpClients.get(f.id);
    if (!st || !st.client) return { ok: false, error: 'The Figma connector is not available.' };
    try {
      const r = await importFigma(st.client, input);
      if (!r.ok) return r;
      let refId = null;
      if (r.image && r.image.data && refsStore) {
        const add = refsStore.addBuffer(Buffer.from(r.image.data, 'base64'), `figma-${r.nodeId.replace(':', '-')}.png`, newRefPlace());
        if (add.ok) {
          refId = add.item.id;
          refsOpen = true;
          refsSend();
          updateRefsShift();
        }
      }
      pushDevLog(`withlook: imported Figma frame ${r.nodeId} (${r.tools.join(', ')})`);
      return {
        ok: true,
        nodeId: r.nodeId,
        fileKey: r.fileKey,
        code: r.code,
        variables: r.variables,
        refId,
        hasImage: !!r.image,
        tools: r.tools,
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
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
  ipcMain.on('ui:pillHeight', (_e, h) => {
    const next = Math.max(PILL_H, Math.min(220, Math.round(Number(h) || PILL_H)));
    if (next === pillH) return;
    pillH = next;
    if (!panelOpen && !dockMode) layout();
  });
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
    else if (a && a.action === 'attach') overlaySend('ui:openAttach', {});
    else if (a === 'settings') overlaySend('ui:openSettings', {});
    else if (a === 'home') openHome();
    else if (a && a.action === 'openFolder' && a.folder) overlaySend('ui:openFolder', a.folder);
  });
  ipcMain.handle('welcome:data', async () => ({
    version: app.getVersion(),
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
  refsStore = new References(app.getPath('userData'));
  // test/smoke runs must never write into the user's real project memory
  const initRes = await store.init((SMOKE || TEST_PROJ || TEST_OPENCODE || TEST_LOAD || TEST_STATIC) ? '' : loadSettings().memory.url);
  if (initRes.error) console.error('memory store: postgres unavailable, using local file —', initRes.error);
  wireIpc();
  createWindow();
  for (const s of loadSettings().mcp.servers) {
    if (s.enabled) mcpConnect(s.id).catch(() => {});
  }
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
    // seed a reference image so the canvas tray is exercised end-to-end
    try {
      const ud = app.getPath('userData');
      const assets = path.join(ud, 'reference-assets');
      fs.mkdirSync(assets, { recursive: true });
      const seed = path.join(assets, 'seed.png');
      fs.writeFileSync(seed, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
      const projectKey = resolveProjectFolder(TEST_PROJ) || TEST_PROJ;
      fs.writeFileSync(path.join(ud, 'references.json'), JSON.stringify({ [projectKey]: [{ id: 'seed', path: seed, name: 'seed.png', include: true }] }));
      refsStore = new References(ud); // re-read the seeded store (the constructor ran before this)
    } catch (e) { console.log('REFS_SEED_FAIL ' + e.message); }
    startDev(TEST_PROJ);
    let sawLoader = false;
    let sawPanelFlash = false;
    let chatsOk = false;
    let refsCardOk = false;
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
      const cards = [...refCards.values()];
      const b = cards[0] ? cards[0].getBounds() : null;
      const pa = previewArea();
      refsCardOk = !!b && b.width > 0 && b.x >= pa.x - b.width && b.x < pa.x + pa.w && b.y < pa.y + pa.h;
      console.log(`REFS_CARD ${refsCardOk ? 'PASS' : 'FAIL'} n=${cards.length} bounds=${b ? b.x + ',' + b.y + ' ' + b.width + 'x' + b.height : 'none'}`);
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
                    app.exit(okBtn && tabsOk && commitOk && pushOk && okR && urlOk && okHome && chatsOk && refsCardOk ? 0 : 1);
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
  if (TEST_STATIC) {
    // create a plain-HTML project, serve it with the built-in static server, check routes
    const base = path.join(os.tmpdir(), 'withlook-static-test');
    const folder = path.join(base, 'demo-site');
    fs.rmSync(base, { recursive: true, force: true });
    const written = scaffold.writePlainHtml(folder, 'demo-site');
    if (!written.ok) { console.log('STATIC_FAIL ' + written.error); app.exit(1); }
    startDev(folder);
    const poll = setInterval(async () => {
      if (devState.state === 'running') {
        clearInterval(poll);
        const pages = await listPages();
        const routes = pages.map((p) => p.route);
        let body = '';
        try { body = await (await fetch(devState.url, { signal: AbortSignal.timeout(5000) })).text(); } catch {}
        const ok = !!devState.framework && devState.framework.id === 'static' &&
          routes.includes('/') && routes.includes('/about') && /Your new site is live/.test(body);
        console.log((ok ? 'STATIC_PASS' : 'STATIC_FAIL') +
          ` framework=${devState.framework && devState.framework.id} pages=${routes.join(',')} served=${/Your new site is live/.test(body)}`);
        stopDev(true); // close the static server, keep the view (no page swap while exiting)
        if (devState.sandbox) { sandbox.discardSandbox(devState.sandbox); devState.sandbox = null; }
        fs.rmSync(base, { recursive: true, force: true });
        app.exit(ok ? 0 : 1);
      } else if (devState.state === 'error') {
        clearInterval(poll);
        console.log('STATIC_FAIL ' + devState.error + '\n' + devLogs.slice(-10).join('\n'));
        app.exit(1);
      }
    }, 400);
    setTimeout(() => { clearInterval(poll); console.log('STATIC_FAIL timeout state=' + devState.state); app.exit(1); }, 60000);
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
