'use strict';
/* withlook overlay controller */
const $ = (id) => document.getElementById(id);
const els = {
  pill: $('pill'), quick: $('quick'), logo: $('logo'), pick: $('pick'), send: $('send'), openproj: $('openproj'),
  panel: $('panel'), pageChip: $('page-chip'), chips: $('chips'), addPick: $('add-pick'),
  newChat: $('new-chat'), settingsBtn: $('settings-btn'), collapse: $('collapse'),
  messages: $('messages'), footer: $('footer'), modelBadge: $('model-badge'), devBadge: $('dev-badge'), writeBtn: $('write-btn'), writeState: $('write-state'),
  refsBtn: $('refs-btn'), refStrip: $('ref-strip'), figmaBtn: $('figma-btn'), figmaChip: $('figma-chip'),
  connectors: $('connectors'), connectorsBackdrop: $('connectors-backdrop'), connectorsClose: $('connectors-close'),
  connectorList: $('connector-list'), connectorEmpty: $('connector-empty'), connectorAdd: $('connector-add'),
  connectorFigmaRemote: $('connector-figma-remote'),
  connectorFigmaLocal: $('connector-figma-local'),
  connectorAuth: $('connector-auth'),
  connectorForm: $('connector-form'), cfName: $('cf-name'), cfTransport: $('cf-transport'), cfHttp: $('cf-http'),
  cfUrl: $('cf-url'), cfStdio: $('cf-stdio'), cfCommand: $('cf-command'), cfArgs: $('cf-args'),
  cfEnabled: $('cf-enabled'), cfOauth: $('cf-oauth'), cfOauthWrap: $('cf-oauth-wrap'),
  cfClientId: $('cf-client-id'), cfClientSecret: $('cf-client-secret'), cfRedirect: $('cf-redirect'),
  cfPat: $('cf-pat'), cfToken: $('cf-token'),
  cfSave: $('cf-save'), cfCancel: $('cf-cancel'), cfStatus: $('cf-status'),
  figmaModal: $('figma-modal'), fmBackdrop: $('fm-backdrop'), fmClose: $('fm-close'), fmUrl: $('fm-url'),
  fmImport: $('fm-import'), fmStatus: $('fm-status'), fmResult: $('fm-result'), fmMeta: $('fm-meta'), fmCode: $('fm-code'),
  attachModal: $('attach-modal'), attachBackdrop: $('attach-backdrop'), attachClose: $('attach-close'),
  attachInput: $('attach-input'), attachSubmit: $('attach-submit'), attachStatus: $('attach-status'),
  quickBtn: $('quick-btn'), quickMenu: $('quick-menu'), quickSettings: $('quick-settings'),
  showPreviewBtn: $('show-preview'), previewLabel: $('preview-label'), logsBtn: $('logs-btn'), devlogPane: $('devlog-pane'), panelLogs: $('panel-logs'),
  settings: $('settings'), settingsClose: $('settings-close'), settingsBackdrop: $('settings-backdrop'),
  agentSeg: $('agent-seg'),
  providerFields: $('provider-fields'), ocFields: $('opencode-fields'),
  localFields: $('local-fields'), localBase: $('local-base'), localKey: $('local-key'),
  localModel: $('local-model'), localRefresh: $('local-refresh'), localStatus: $('local-status'),
  localPresets: document.querySelectorAll('#local-presets .preset'),
  ocModel: $('oc-model'), ocAgent: $('oc-agent'), ocNote: $('oc-note'),
  provBtns: document.querySelectorAll('#prov-seg button'),
  cfFields: $('cf-fields'), oaFields: $('oa-fields'),
  cfAccount: $('cf-account'), cfToken: $('cf-token'), cfModel: $('cf-model'),
  oaKey: $('oa-key'), oaBase: $('oa-base'), oaModel: $('oa-model'), sysPrompt: $('sys-prompt'),
  openProject: $('open-project'), editProject: $('edit-project'), stopServer: $('stop-server'), folderPath: $('folder-path'),
  editorCmd: $('editor-cmd'), sandboxBtn: $('sandbox-btn'),
  sandboxRow: $('sandbox-row'), sandboxPath: $('sandbox-path'), sandboxApply: $('sandbox-apply'),
  sandboxDiscard: $('sandbox-discard'), sandboxStatus: $('sandbox-status'),
  devLogsBox: $('dev-logs-box'), devLogs: $('dev-logs'),
  urlInput: $('url-input'), urlGo: $('url-go'),
  memUrl: $('mem-url'), memTest: $('mem-test'), memStatus: $('mem-status'),
  recentProjects: $('recent-projects'), recentMenu: $('recent-menu'), historyMenu: $('history-menu'), historyBtn: $('history-btn'),
  historyModal: $('history-modal'), hmList: $('hm-list'), hmClose: $('hm-close'), hmBackdrop: $('hm-backdrop'),
  saveSettings: $('save-settings'), savedFlash: $('saved-flash'), appInfo: $('app-info'),
};

const state = {
  panelOpen: false,
  dock: false,
  home: false,
  attachOpen: false,
  previewOut: false,
  settingsOpen: false,
  picking: false,
  writeMode: false,
  sandbox: true,
  selections: [],
  history: [],       // {role, content} for the API
  sessionId: null,    // current memory-store session
  streaming: false,
  streamId: null,
  assistantBuf: '',
  activity: [],
  assistantEl: null,
  pageUrl: '',
  settings: null,
  dev: null,
  references: [],
  refsOpen: false,
  connectors: [],
  connectorEdit: null,
  connectorDraft: null,
  connectorsOpen: false,
  figma: null,
};

/* ---------- tiny markdown (with applyable file blocks) ---------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function proseHtml(s) {
  return escapeHtml(s)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/^### (.*)$/gm, '<strong>$1</strong>')
    .replace(/^[-*•] (.*)$/gm, '• $1')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br>');
}
function renderMd(text) {
  const seg = String(text).split('```');
  let out = '';
  for (let i = 0; i < seg.length; i++) {
    if (i % 2 === 0) { out += proseHtml(seg[i]); continue; }
    let info = '', code = seg[i];
    const nl = code.indexOf('\n');
    if (nl >= 0 && code.slice(0, nl).trim()) { info = code.slice(0, nl).trim(); code = code.slice(nl + 1); }
    code = code.replace(/\n$/, '');
    const m = info.match(/path=(\S+)/);
    out += m
      ? `<details class="fileblock"><summary class="fb-head"><code>${escapeHtml(m[1])}</code><button class="apply-file" data-file="${escapeHtml(m[1])}">apply</button></summary><pre><code>${escapeHtml(code)}</code></pre></details>`
      : `<pre><code>${escapeHtml(code)}</code></pre>`;
  }
  return `<p>${out}</p>`;
}

/* ---------- panel ---------- */
async function setPanel(open) {
  const r = await window.wl.setPanel(open);
  applyMode(r && (r.open || r.dock) ? r : { open, dock: r ? r.dock : false });
  if (r && (r.open || r.dock)) scrollBottom();
}
function uiToggleFloat() {
  setPanel(!(state.panelOpen && state.dock));
}
function applyMode(m) {
  state.panelOpen = !!(m && m.open);
  state.dock = !!(m && m.dock);
  state.home = !!(m && m.home);
  state.previewOut = !!(m && m.preview);
  document.body.classList.toggle('dock', state.dock);
  els.panel.hidden = !(state.panelOpen || state.dock);
  if (els.previewLabel) els.previewLabel.textContent = state.previewOut ? 'dock preview back' : 'pop out preview';
  els.collapse.textContent = state.dock ? 'float' : '–';
}
window.wl.onUiMode((m) => applyMode(m));
function scrollBottom() { els.messages.scrollTop = els.messages.scrollHeight; }

/* ---------- messages ---------- */
function clearChat() {
  state.history = [];
  state.selections = [];
  state.figma = null;
  renderFigmaChip();
  renderChips();
  els.messages.innerHTML = '<div class="empty">New conversation. Pick an element and ask away.</div>';
}
function addMsg(role, html) {
  const empty = els.messages.querySelector('.empty');
  if (empty) empty.remove();
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  if (role === 'user') div.textContent = html;
  else div.innerHTML = (role === 'assistant' ? '<div class="who">withlook</div>' : '') + html;
  els.messages.appendChild(div);
  scrollBottom();
  return div;
}

function diffHtml(patch, maxLines = 240) {
  return String(patch || '').split('\n').slice(0, maxLines).map((ln) => {
    const cls = (ln.startsWith('+') && !ln.startsWith('+++')) ? 'add'
      : (ln.startsWith('-') && !ln.startsWith('---')) ? 'del' : 'ctx';
    return `<span class="dl ${cls}">${escapeHtml(ln) || ' '}</span>`;
  }).join('');
}

function renderActivity(l) {
  if (l.kind === 'report') {
    const lines = String(l.text).split('\n');
    lines.shift(); // drop the "changed:" header
    let add = 0, del = 0;
    const rows = [];
    for (const line of lines) {
      const m = line.match(/^(\S+)\s+(.+?)(?:\s+\+(\d+)\s+−(\d+))?$/);
      if (!m) continue;
      const st = m[1] === '?' ? 'U' : (m[1][0] || 'M');
      const a = Number(m[3] || 0), d = Number(m[4] || 0);
      add += a; del += d;
      rows.push(
        `<button class="rp-row" data-file="${escapeHtml(m[2])}" title="Show the diff">` +
        `<span class="rp-st st-${escapeHtml(st)}">${escapeHtml(st)}</span>` +
        `<span class="rp-path">${escapeHtml(m[2])}</span>` +
        `<span class="rp-num"><span class="a">+${a}</span> <span class="d">−${d}</span></span></button>` +
        `<pre class="rp-diff" hidden></pre>`
      );
    }
    return `<details class="oc-report"><summary>` +
      `<span>${rows.length} file${rows.length === 1 ? '' : 's'} changed</span>` +
      `<span class="rp-tot"><span class="a">+${add}</span> <span class="d">−${del}</span></span>` +
      `<span class="rp-actions"><button class="rp-action" data-patch="copy" title="Copy the unified diff">copy</button>` +
      `<button class="rp-action" data-patch="save" title="Save a .patch + manifest">save</button></span>` +
      `</summary><div class="rp-rows">${rows.join('')}</div></details>`;
  }
  if (l.kind === 'edit') {
    const files = Array.isArray(l.edit) ? l.edit : [];
    if (!files.length) return `<div class="oc-tool">${escapeHtml(l.text)}</div>`;
    return files.map((f) => {
      const patch = String(f.patch || '');
      const adds = f.additions != null ? f.additions : patch.split('\n').filter((x) => x.startsWith('+') && !x.startsWith('+++')).length;
      const dels = f.deletions != null ? f.deletions : patch.split('\n').filter((x) => x.startsWith('-') && !x.startsWith('---')).length;
      const where = String(f.file || '') + (f.line ? ':' + f.line : '');
      const counts = (patch || f.additions != null || f.deletions != null)
        ? `<span class="ed-num"><span class="a">+${adds}</span> <span class="d">−${dels}</span></span>`
        : '<span class="ed-num">edited</span>';
      return `<details class="oc-edit">` +
        `<summary><span class="ed-ico">✎</span>` +
        `<span class="ed-path" title="${escapeHtml(where)}">${escapeHtml(where)}</span>` +
        counts + `</summary>` +
        `<pre class="rp-diff">${patch ? diffHtml(patch) : '<span class="dl ctx">(diff not streamed — see the change report below)</span>'}</pre>` +
        `</details>`;
    }).join('');
  }
  return `<div class="oc-${l.kind}">${escapeHtml(l.text)}</div>`;
}

function activityHtml(items) {
  let out = '';
  let tools = [];
  const flush = () => {
    if (!tools.length) return;
    const names = [...new Set(tools.map((t) => String(t.text).split(' ')[0]))].slice(0, 4).join(', ');
    out += `<details class="oc-tools"><summary>${tools.length} tool call${tools.length > 1 ? 's' : ''} · ${escapeHtml(names)}</summary>` +
      tools.map((t) => `<div class="oc-tool">${escapeHtml(t.text)}</div>`).join('') + '</details>';
    tools = [];
  };
  for (const l of items) {
    if (l.kind === 'tool') { tools.push(l); continue; }
    flush();
    out += renderActivity(l);
  }
  flush();
  return out;
}

function setStreamingUI(on) {
  els.send.classList.toggle('stopping', on);
  els.send.title = on ? 'Stop generating (Esc)' : 'Send (Enter)';
  els.send.innerHTML = on
    ? '<svg viewBox="0 0 24 24" width="14" height="14"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>'
    : '<svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M2.5 21l19-9L2.5 3v6.2l11.5 2.8L2.5 14.8z"/></svg>';
}
function genStatusHtml(label) {
  return `<div class="gen-status"><span class="spin-sm"></span><span>${label}</span><button class="stop-gen">stop</button></div>`;
}
function renderAssistant() {
  if (!state.assistantEl) return;
  const openGroups = new Set();
  const openEdits = new Set();
  const openFiles = new Set();
  state.assistantEl.querySelectorAll('.oc-tools').forEach((d, i) => { if (d.open) openGroups.add(i); });
  state.assistantEl.querySelectorAll('.oc-edit').forEach((d, i) => { if (d.open) openEdits.add(i); });
  state.assistantEl.querySelectorAll('.fileblock').forEach((d, i) => { if (d.open) openFiles.add(i); });
  state.assistantEl.innerHTML =
    '<div class="who">withlook</div>' +
    activityHtml(state.activity) +
    renderMd(state.assistantBuf) +
    (state.streaming ? genStatusHtml('working…') : '');
  state.assistantEl.querySelectorAll('.oc-tools').forEach((d, i) => { if (openGroups.has(i)) d.open = true; });
  state.assistantEl.querySelectorAll('.oc-edit').forEach((d, i) => { if (openEdits.has(i)) d.open = true; });
  state.assistantEl.querySelectorAll('.fileblock').forEach((d, i) => { if (openFiles.has(i)) d.open = true; });
}

/* ---------- chat ---------- */
function context() {
  return {
    url: state.pageUrl,
    writeMode: !!state.writeMode,
    referenceIds: state.references.filter((r) => r.include).map((r) => r.id),
    figma: state.figma ? { url: state.figma.url, nodeId: state.figma.nodeId, code: state.figma.code, variables: state.figma.variables } : null,
    selections: state.selections.map((s) => ({
      selector: s.selector, tag: s.tag, id: s.id, classes: String(s.classes).slice(0, 200),
      text: s.text, html: s.html, styles: s.styles,
      sources: (s.sources || []).map((x) => ({ file: x.file, line: x.line })),
    })),
  };
}
async function ensureSession() {
  if (state.sessionId) return state.sessionId;
  const s = await window.wl.sessionsNew(state.dev && state.dev.folder);
  state.sessionId = s.id;
  return s.id;
}
async function send(textArg) {
  const text = (textArg ?? els.quick.value).trim();
  if (!text || state.streaming) return;
  if (!state.panelOpen) await setPanel(true);
  els.quick.value = '';
  state.history.push({ role: 'user', content: text });
  addMsg('user', text);
  const sid = await ensureSession();
  window.wl.messagesAppend({ sessionId: sid, role: 'user', content: text, title: text.slice(0, 80) }).catch(() => {});
  state.assistantBuf = '';
  state.activity = [];
  state.assistantEl = addMsg('assistant', genStatusHtml('thinking…'));
  state.streaming = true;
  state.streamId = 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  setStreamingUI(true);
  await window.wl.sendChat({ id: state.streamId, messages: state.history, context: context() });
}
function finishStream(ok) {
  state.streaming = false;
  state.streamId = null;
  setStreamingUI(false);
  renderAssistant(); // drop the "working…" row
  state.assistantEl = null;
  if (ok && state.assistantBuf.trim()) {
    state.history.push({ role: 'assistant', content: state.assistantBuf });
    if (state.sessionId) {
      window.wl.messagesAppend({ sessionId: state.sessionId, role: 'assistant', content: state.assistantBuf }).catch(() => {});
    }
  }
}
window.wl.onChatChunk(({ id, delta, kind, edit }) => {
  if (id !== state.streamId) return;
  const text = String(delta).replace(/\n+$/, '');
  if (kind === 'turn' || kind === 'tool' || kind === 'edit' || kind === 'report' || kind === 'status') {
    const last = state.activity[state.activity.length - 1];
    if (!(kind === 'status' && last && last.kind === 'status' && last.text === text)) {
      state.activity.push({ kind, text, edit });
    }
  } else state.assistantBuf += delta;
  renderAssistant();
  scrollBottom();
});
window.wl.onChatDone(({ id }) => { if (id === state.streamId) finishStream(true); });
window.wl.onChatError(({ id, error }) => {
  if (id !== state.streamId) return;
  if (state.assistantEl) state.assistantEl.remove();
  if (state.assistantBuf.trim()) state.history.push({ role: 'assistant', content: state.assistantBuf }); // keep partial answer
  state.streaming = false; state.streamId = null; state.assistantEl = null; state.assistantBuf = '';
  setStreamingUI(false);
  addMsg('error', '⚠ ' + escapeHtml(error));
});

/* ---------- selections / picker ---------- */
function renderChips() {
  els.chips.innerHTML = '';
  state.selections.forEach((s, i) => {
    const c = document.createElement('span');
    c.className = 'chip';
    c.title = s.selector;
    c.textContent = (s.text ? s.text.slice(0, 26) : s.selector.slice(0, 30)) || `<${s.tag}>`;
    const x = document.createElement('button');
    x.textContent = '×';
    x.onclick = () => { state.selections.splice(i, 1); renderChips(); };
    c.appendChild(x);
    els.chips.appendChild(c);
  });
  els.addPick.style.display = state.selections.length ? '' : 'none';
}

/* ---------- reference images ---------- */
function applyRefs(s) {
  if (!s) return;
  state.references = Array.isArray(s.items) ? s.items : [];
  state.refsOpen = !!s.open;
  renderRefs();
}
function renderRefs() {
  const included = state.references.filter((r) => r.include);
  if (els.refStrip) {
    els.refStrip.hidden = included.length === 0;
    els.refStrip.innerHTML = '';
    for (const r of included) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'ref-chip';
      chip.title = r.name + ' — click to exclude from this message';
      const img = document.createElement('img');
      img.src = r.thumb;
      img.alt = '';
      const name = document.createElement('span');
      name.textContent = r.name;
      chip.append(img, name);
      chip.onclick = () => { if (window.wl.toggleRef) window.wl.toggleRef(r.id); };
      els.refStrip.appendChild(chip);
    }
  }
  if (els.refsBtn) {
    const total = state.references.length;
    els.refsBtn.textContent = total ? `refs · ${included.length}/${total}` : 'refs';
    els.refsBtn.classList.toggle('on', total > 0);
    els.refsBtn.title = total
      ? `${included.length} of ${total} references included — click to ${state.refsOpen ? 'hide' : 'show'} the cards`
      : 'Add reference images (⌘⇧V pastes from the clipboard)';
  }
}
els.refsBtn.onclick = async () => {
  if (!state.dev || !state.dev.projectFolder) { flashPageChip('open a project first'); return; }
  if (!state.references.length) { await window.wl.pickRefs().catch(() => {}); return; }
  await window.wl.toggleTray(!state.refsOpen).catch(() => {});
};
// drop an image anywhere on the chat panel to add it as a reference
async function addDroppedImages(files) {
  for (const file of files) {
    if (!file.type || !file.type.startsWith('image/')) continue;
    const dataUrl = await new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => res(null);
      fr.readAsDataURL(file);
    });
    if (dataUrl && window.wl.addRefData) await window.wl.addRefData({ name: file.name, dataUrl }).catch(() => {});
  }
}
for (const type of ['dragover', 'drop']) {
  els.panel.addEventListener(type, (e) => {
    e.preventDefault();
    if (type === 'drop') addDroppedImages([...((e.dataTransfer && e.dataTransfer.files) || [])]);
  });
}

/* ---------- figma (MCP) ---------- */
function renderFigmaChip() {
  if (!els.figmaChip) return;
  els.figmaChip.innerHTML = '';
  if (!state.figma) return;
  const chip = document.createElement('span');
  chip.className = 'chip figma';
  chip.title = state.figma.url || '';
  chip.textContent = 'figma · ' + state.figma.nodeId;
  const x = document.createElement('button');
  x.textContent = '×';
  x.title = 'Remove the Figma frame from context';
  x.onclick = () => { state.figma = null; renderFigmaChip(); };
  chip.appendChild(x);
  els.figmaChip.appendChild(chip);
}
function openFigma() {
  closeSettings();
  els.figmaModal.hidden = false;
  els.fmStatus.textContent = '';
  els.fmUrl.focus();
}
function closeFigma() { els.figmaModal.hidden = true; }
function openAttach() {
  closeSettings();
  closeFigma();
  closeConnectors();
  state.attachOpen = true;
  document.body.classList.add('settings-on');
  if (window.wl.settingsModal) window.wl.settingsModal(true).catch(() => {});
  els.attachModal.hidden = false;
  els.attachStatus.textContent = '';
  els.attachInput.focus();
}
function closeAttach() {
  state.attachOpen = false;
  els.attachModal.hidden = true;
  document.body.classList.remove('settings-on');
  if (window.wl.settingsModal) window.wl.settingsModal(false).catch(() => {});
}
els.attachClose.onclick = closeAttach;
els.attachBackdrop.onclick = closeAttach;
els.attachSubmit.onclick = async () => {
  const url = els.attachInput.value.trim();
  if (!url) { els.attachStatus.textContent = 'Enter a port or URL.'; return; }
  els.attachSubmit.disabled = true;
  els.attachStatus.innerHTML = '<span class="wl-spinner"></span> connecting…';
  const r = await window.wl.devAttach(url).catch((e) => ({ ok: false, error: e.message }));
  els.attachSubmit.disabled = false;
  if (!r || !r.ok) { els.attachStatus.textContent = '✗ ' + ((r && r.error) || 'attach failed'); return; }
  els.attachStatus.textContent = '✓ attached to ' + r.url;
  setTimeout(closeAttach, 350);
};
els.attachInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') els.attachSubmit.click(); });
if (window.wl.onUiOpenAttach) window.wl.onUiOpenAttach(() => openAttach());
els.figmaBtn.onclick = openFigma;
els.fmClose.onclick = closeFigma;
els.fmBackdrop.onclick = closeFigma;
els.fmImport.onclick = async () => {
  const url = els.fmUrl.value.trim();
  if (!url) { els.fmStatus.textContent = 'Paste a Figma frame URL.'; return; }
  els.fmImport.disabled = true;
  els.fmStatus.textContent = 'importing…';
  const r = await window.wl.figmaImport(url).catch((e) => ({ ok: false, error: e.message }));
  els.fmImport.disabled = false;
  if (!r || !r.ok) { els.fmStatus.textContent = '✗ ' + ((r && r.error) || 'import failed'); return; }
  state.figma = { url, nodeId: r.nodeId, code: r.code || '', variables: r.variables || '' };
  renderFigmaChip();
  els.fmStatus.textContent = '✓ node ' + r.nodeId + (r.hasImage ? ' · screenshot added to References' : '');
  els.fmResult.hidden = false;
  els.fmMeta.textContent = 'tools: ' + (r.tools || []).join(', ');
  els.fmCode.hidden = !(r.code || r.variables);
  els.fmCode.textContent = (r.code || r.variables || '').slice(0, 6000);
};

function addSelectionMessage(s, live = true) {
  const empty = els.messages.querySelector('.empty');
  if (empty) empty.remove();
  const div = document.createElement('div');
  div.className = 'msg selection';
  const label = (s.text || '').trim().slice(0, 90) || s.selector;
  div.innerHTML =
    '<div class="sel-head"><span class="sel-pick">Picked <code></code></span>' +
    (live ? '<button class="sel-remove" title="Remove this selection">✕</button>' : '') + '</div>' +
    '<div class="sel-meta"></div>' +
    '<div class="src-actions"><button class="mini find-src">find source file</button><span class="src-status"></span></div>' +
    '<div class="src-list"></div>';
  div.querySelector('code').textContent = s.selector;
  div.querySelector('.sel-meta').textContent = label + `  ·  ${s.rect ? s.rect.width + '×' + s.rect.height : ''}`;
  if (live) {
    div.querySelector('.sel-remove').onclick = () => {
      const i = state.selections.indexOf(s);
      if (i >= 0) state.selections.splice(i, 1); // live selection → drop it from the AI context
      renderChips();
      div.classList.add('removed');
      const btn = div.querySelector('.sel-remove');
      btn.disabled = true;
      btn.textContent = 'removed';
    };
  }
  const status = div.querySelector('.src-status');
  const list = div.querySelector('.src-list');
  const findBtn = div.querySelector('.find-src');
  findBtn.onclick = async () => {
    status.textContent = 'searching project…';
    const r = await window.wl.findSources({
      text: s.text, selector: s.selector, classes: s.classes, id: s.id,
    });
    if (!r.ok) { status.textContent = r.error || 'not found'; return; }
    s.sources = r.files;
    status.textContent = r.files.length + ' match' + (r.files.length > 1 ? 'es' : '') + ':';
    list.innerHTML = '';
    for (const f of r.files) {
      const b = document.createElement('button');
      b.className = 'src-file';
      const short = f.file.replace((state.dev && state.dev.folder ? state.dev.folder : ''), '') || f.file;
      b.innerHTML = '<span class="path"></span><span class="ln"></span><span class="open">open →</span>';
      b.querySelector('.path').textContent = short || f.file;
      b.querySelector('.path').title = f.file;
      b.querySelector('.ln').textContent = 'L' + f.line + ' · ' + f.why;
      b.onclick = () => window.wl.openSource({ file: f.file, line: f.line });
      list.appendChild(b);
    }
    scrollBottom();
  };
  els.messages.appendChild(div);
  scrollBottom();
}
function pickNow() {
  if (!/^https?:/i.test(state.pageUrl || '')) { flashPageChip('load a page first'); return; }
  window.wl.startPicker();
}
window.wl.onPickerResult(async (data) => {
  if (data && data.selector) {
    state.selections.push(data);
    renderChips();
    if (!state.panelOpen) await setPanel(true);
    addSelectionMessage(data);
    els.quick.focus();
    const sid = await ensureSession();
    window.wl.messagesAppend({
      sessionId: sid, role: 'selection',
      content: JSON.stringify({ selector: data.selector, tag: data.tag, text: data.text, classes: data.classes, id: data.id, sources: [] }),
    }).catch(() => {});
  }
});
window.wl.onPickerState(({ active }) => {
  state.picking = active;
  els.pick.classList.toggle('on', active);
  els.pill.classList.toggle('picking-on', active);
  els.quick.disabled = active; // keep the chat bar out of the way while picking
  els.quick.placeholder = active
    ? 'Click an element on the page… (Esc to cancel)'
    : 'Ask withlook about this page…';
  // in dock mode the panel sits beside the page, so it can stay open while picking
  if (active) { closeSettings(); if (!state.dock && state.panelOpen) setPanel(false); }
});

/* ---------- page / dev status ---------- */
function flashPageChip(msg) {
  const old = els.pageChip.textContent;
  els.pageChip.textContent = msg;
  setTimeout(() => (els.pageChip.textContent = old || 'no page'), 1600);
}
window.wl.onPageNav((info) => {
  state.pageUrl = info.url || '';
  const isFile = state.pageUrl.startsWith('file://');
  els.pageChip.textContent = isFile
    ? (state.pageUrl.includes('create-project') ? 'new project' : 'welcome')
    : (info.title || info.url || 'no page');
  els.pageChip.title = info.url || '';
  if (!state.settingsOpen && /^https?:/.test(state.pageUrl)) els.urlInput.value = state.pageUrl;
});
window.wl.onPageError(({ error }) => flashPageChip('load failed: ' + String(error).slice(0, 60)));
if (window.wl.onRefsState) window.wl.onRefsState(applyRefs);
window.wl.onDevStatus((dev) => {
  state.dev = dev;
  const project = dev.projectFolder || dev.folder;
  const projName = project ? String(project).split(/[\\/]/).filter(Boolean).pop() : '';
  els.devBadge.className = 'badge ' + (dev.state === 'running' ? 'ok' : dev.state === 'error' ? 'err' : '');
  const tooling = [dev.pm, dev.framework && dev.framework.name].filter(Boolean).join(' · ');
  els.devBadge.textContent = 'server: ' + dev.state + (tooling ? ` (${tooling})` : '') + (projName && dev.state !== 'idle' ? ' · ' + projName : '') + (dev.sandbox ? ' · sandbox' : '') + (dev.external ? ' · attached' : '');
  els.devBadge.title = project || dev.url || dev.error || '';
  els.openproj.hidden = dev.state !== 'idle'; // no "open project" affordance once you're inside one
  els.folderPath.textContent = project ? project + (dev.port ? `  ·  :${dev.port}` : '') : '—';
  const sb = dev.sandbox;
  els.sandboxRow.hidden = !sb;
  if (sb) {
    els.sandboxPath.textContent = sb.projectPath || sb.root || '';
    els.sandboxPath.title = [sb.mode, sb.branch].filter(Boolean).join(' · ');
    els.sandboxStatus.textContent = '';
  }
  if (dev.state === 'error' && dev.error) { els.devBadge.title = dev.error; }
});
window.wl.onDevLog((line) => {
  els.devLogs.textContent += line + '\n';
  els.devLogs.scrollTop = els.devLogs.scrollHeight;
  els.panelLogs.textContent += line + '\n';
  els.panelLogs.scrollTop = els.panelLogs.scrollHeight;
});

/* ---------- settings ---------- */
function bindProv(prov) {
  closeCombo();
  els.provBtns.forEach((b) => b.classList.toggle('on', b.dataset.prov === prov));
  els.cfFields.hidden = prov !== 'cloudflare';
  els.oaFields.hidden = prov !== 'openai';
  els.localFields.hidden = prov !== 'local';
}
async function openSettings() {
  if (state.connectorsOpen) { state.connectorsOpen = false; els.connectors.hidden = true; els.connectorForm.hidden = true; }
  state.settingsOpen = true;
  document.body.classList.add('settings-on');
  // expand the overlay to the whole window BEFORE showing the card — otherwise the
  // card is laid out inside the 52px pill view and visibly jumps when the view grows
  if (window.wl.settingsModal) await window.wl.settingsModal(true).catch(() => {});
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  els.settings.hidden = false;
  const body = els.settings.querySelector('.drawer-body');
  if (body) body.scrollTop = 0;
  // local servers are cheap to probe — fill the model list the first time the drawer opens
  if (state.settings && state.settings.provider === 'local') {
    const dl = document.getElementById('local-models');
    if (dl && !dl.querySelector('option')) refreshLocalModels(false);
  }
}
function closeSettings() {
  closeCombo();
  state.settingsOpen = false;
  els.settings.hidden = true;
  document.body.classList.remove('settings-on');
  if (window.wl.settingsModal) window.wl.settingsModal(false).catch(() => {});
}
async function loadSettingsInto() {
  const s = await window.wl.getSettings();
  state.settings = s;
  bindProv(s.provider);
  els.cfAccount.value = s.cloudflare.accountId || '';
  els.cfToken.value = s.cloudflare.token || '';
  els.cfModel.value = s.cloudflare.model || '';
  els.oaKey.value = s.openai.apiKey || '';
  els.oaBase.value = s.openai.baseUrl || '';
  els.oaModel.value = s.openai.model || '';
  els.localBase.value = (s.local && s.local.baseUrl) || 'http://localhost:11434/v1';
  els.localKey.value = (s.local && s.local.apiKey) || '';
  els.localModel.value = (s.local && s.local.model) || '';
  els.sysPrompt.value = s.systemPrompt || '';
  els.editorCmd.value = s.editor || 'code';
  state.sandbox = s.sandbox !== false;
  els.sandboxBtn.textContent = 'Edit in a sandbox: ' + (state.sandbox ? 'on' : 'off');
  els.sandboxBtn.classList.toggle('on', state.sandbox);
  els.memUrl.value = (s.memory && s.memory.url) || '';
  els.ocModel.value = (s.opencode && s.opencode.model) || '';
  els.ocAgent.value = (s.opencode && s.opencode.agent) || '';
  bindAgent(s.agent || 'direct');
  updateModelBadge();
}
function bindAgent(agent) {
  closeCombo();
  els.agentSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.agent === agent));
  const isOC = agent === 'opencode';
  els.providerFields.hidden = isOC;
  els.ocFields.hidden = !isOC;
  if (isOC) loadOpencodeLists();
}
let ocListsLoaded = false;
async function loadOpencodeLists() {
  if (ocListsLoaded) return;
  els.ocNote.textContent = 'Loading models and agents from opencode…';
  const r = await window.wl.opencodeList().catch(() => null);
  if (!r || !r.ok) {
    els.ocNote.textContent = '✗ ' + ((r && r.error) || 'opencode not found — install from opencode.ai');
    return;
  }
  const fill = (listId, items) => {
    const dl = document.getElementById(listId);
    dl.innerHTML = '';
    for (const m of items.slice(0, 300)) {
      const o = document.createElement('option');
      o.value = m;
      dl.appendChild(o);
    }
  };
  fill('oc-models', r.models || []);
  fill('oc-agents', r.agents || []);
  els.ocNote.textContent = `✓ ${r.models.length} models · ${r.agents.length} agents loaded from your opencode install`;
  ocListsLoaded = true;
}

/* ---------- local models (Ollama · LM Studio · llama.cpp · vLLM) ---------- */
async function refreshLocalModels(announce) {
  const base = els.localBase.value.trim() || 'http://localhost:11434/v1';
  if (announce) els.localStatus.textContent = 'looking for models…';
  const r = await window.wl.localModels(base).catch((e) => ({ ok: false, error: e.message }));
  if (!r || !r.ok) {
    els.localStatus.textContent = '✗ ' + ((r && r.error) || 'no response') + ' — is the server running?';
    return;
  }
  const dl = document.getElementById('local-models');
  dl.innerHTML = '';
  for (const m of (r.models || []).slice(0, 300)) {
    const o = document.createElement('option');
    o.value = m;
    dl.appendChild(o);
  }
  if (!els.localModel.value && r.models && r.models.length) els.localModel.value = r.models[0];
  els.localStatus.textContent = r.models && r.models.length
    ? `✓ ${r.models.length} model${r.models.length === 1 ? '' : 's'} at ${r.base || base}`
    : '✓ connected — no models installed yet';
}
els.localRefresh.onclick = () => refreshLocalModels(true);
els.localPresets.forEach((b) => {
  b.onclick = () => { els.localBase.value = b.dataset.url; refreshLocalModels(true); };
});
const stripServer = ({ status, tools, server, error, ...cfg }) => cfg;
function showAuthWaiting(name, url) {
  els.connectorAuth.hidden = false;
  els.connectorAuth.textContent = '';
  const label = document.createElement('span');
  label.textContent = 'Waiting for sign-in to ' + (name || 'the connector') + ' in your browser… ';
  els.connectorAuth.appendChild(label);
  if (url) {
    const open = document.createElement('button');
    open.className = 'mini';
    open.textContent = 'open link';
    open.onclick = () => window.wl.openExternal(url).catch(() => {});
    els.connectorAuth.appendChild(open);
  }
  if (/remote/i.test(name || '')) {
    const hint = document.createElement('div');
    hint.className = 'dim';
    hint.textContent = 'If Figma says the remote MCP server is not enabled, this OAuth app is not an approved MCP client — use + Figma (local) instead.';
    els.connectorAuth.appendChild(hint);
  }
}
function hideAuth() {
  els.connectorAuth.hidden = true;
  els.connectorAuth.textContent = '';
}
async function refreshConnectors() {
  hideAuth();
  const st = await window.wl.mcpServers().catch(() => null);
  state.connectors = (st && st.servers) || [];
  renderConnectors();
}
function renderConnectors() {
  els.connectorList.innerHTML = '';
  els.connectorEmpty.hidden = state.connectors.length > 0;
  for (const s of state.connectors) {
    const row = document.createElement('div');
    row.className = 'connector-row';
    const main = document.createElement('div');
    main.className = 'connector-main';
    const name = document.createElement('span');
    name.className = 'connector-name';
    name.textContent = s.name;
    const sub = document.createElement('span');
    sub.className = 'connector-sub';
    sub.textContent = s.transport === 'stdio'
      ? [s.command, ...(s.args || [])].filter(Boolean).join(' ')
      : (s.url || 'no url');
    sub.title = sub.textContent;
    main.append(name, sub);

    const status = document.createElement('span');
    status.className = 'connector-status' + (s.status === 'connected' ? ' ok' : s.status === 'error' ? ' err' : '');
    status.textContent = s.status === 'connected' ? `connected · ${s.tools.length} tools`
      : s.status === 'connecting' ? 'connecting…'
      : s.status === 'auth' ? 'sign-in required'
      : s.status === 'error' ? 'error'
      : 'off';
    status.title = s.error || '';

    const connect = document.createElement('button');
    connect.className = 'mini' + (s.status === 'connected' ? '' : ' strong');
    connect.textContent = s.status === 'connected' ? 'disconnect'
      : (s.oauth && !s.signedIn) ? 'sign in' : 'connect';
    connect.onclick = async () => {
      connect.disabled = true;
      if (s.status === 'connected') {
        await window.wl.mcpDisconnect(s.id).catch(() => {});
      } else {
        if (s.oauth) showAuthWaiting(s.name, '');
        const r = await window.wl.mcpConnect(s.id).catch(() => null);
        if (r && r.needPat) {
          hideAuth();
          await refreshConnectors();
          openConnectorForm(state.connectors.find((x) => x.id === s.id));
          els.cfStatus.textContent = r.error;
          return;
        }
      }
      await refreshConnectors();
    };

    const edit = document.createElement('button');
    edit.className = 'mini';
    edit.textContent = 'edit';
    edit.onclick = () => openConnectorForm(s);

    const del = document.createElement('button');
    del.className = 'mini';
    del.textContent = '×';
    del.title = 'Delete this connector';
    let armed = false;
    del.onclick = async () => {
      if (!armed) {
        armed = true;
        del.textContent = 'confirm';
        del.classList.add('strong');
        setTimeout(() => { armed = false; del.textContent = '×'; del.classList.remove('strong'); }, 2500);
        return;
      }
      const servers = state.connectors.map(stripServer).filter((c) => c.id !== s.id);
      const r = await window.wl.mcpSave(servers).catch(() => null);
      if (r) state.connectors = r.servers || [];
      renderConnectors();
    };

    row.append(main, status, connect, edit, del);
    if (s.signedIn) {
      const out = document.createElement('button');
      out.className = 'mini';
      out.textContent = 'sign out';
      out.onclick = async () => { await window.wl.mcpSignOut(s.id).catch(() => {}); await refreshConnectors(); };
      row.appendChild(out);
    }
    els.connectorList.appendChild(row);
    if (s.error && s.status !== 'connected') {
      const err = document.createElement('div');
      err.className = 'connector-error';
      err.textContent = s.error;
      els.connectorList.appendChild(err);
    }
  }
}
function bindTransport(t) {
  els.cfTransport.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
  els.cfHttp.hidden = t !== 'http';
  els.cfStdio.hidden = t !== 'stdio';
}
function setConnectorEnabled(on) {
  if (state.connectorDraft) state.connectorDraft.enabled = on;
  els.cfEnabled.textContent = 'connect on launch: ' + (on ? 'on' : 'off');
  els.cfEnabled.classList.toggle('on', on);
}
function setConnectorOAuth(on) {
  if (state.connectorDraft) state.connectorDraft.oauth = on;
  els.cfOauth.textContent = 'OAuth sign-in: ' + (on ? 'on' : 'off');
  els.cfOauth.classList.toggle('on', on);
  els.cfOauthWrap.hidden = !on;
}
function openConnectorForm(cfg) {
  state.connectorEdit = cfg ? cfg.id : null;
  state.connectorDraft = cfg ? { ...cfg } : { name: '', transport: 'http', url: '', command: '', args: [], enabled: false, oauth: false, pat: '', clientId: '', clientSecret: '', redirectUri: '', token: '' };
  els.cfName.value = state.connectorDraft.name || '';
  els.cfUrl.value = state.connectorDraft.url || '';
  els.cfCommand.value = state.connectorDraft.command || '';
  els.cfArgs.value = (state.connectorDraft.args || []).join(' ');
  els.cfClientId.value = state.connectorDraft.clientId || '';
  els.cfClientSecret.value = state.connectorDraft.clientSecret || '';
  els.cfRedirect.value = state.connectorDraft.redirectUri || '';
  els.cfPat.value = state.connectorDraft.pat || '';
  els.cfToken.value = state.connectorDraft.token || '';
  els.cfStatus.textContent = '';
  bindTransport(state.connectorDraft.transport || 'http');
  setConnectorEnabled(!!state.connectorDraft.enabled);
  setConnectorOAuth(!!state.connectorDraft.oauth);
  els.connectorForm.hidden = false;
  els.cfName.focus();
}
els.cfTransport.querySelectorAll('button').forEach((b) => { b.onclick = () => bindTransport(b.dataset.t); });
els.cfEnabled.onclick = () => setConnectorEnabled(!(state.connectorDraft && state.connectorDraft.enabled));
els.cfOauth.onclick = () => setConnectorOAuth(!(state.connectorDraft && state.connectorDraft.oauth));
els.connectorAdd.onclick = () => openConnectorForm(null);
els.connectorFigmaLocal.onclick = async () => {
  els.connectorFigmaLocal.disabled = true;
  const r = await window.wl.mcpPresetFigmaLocal().catch(() => null);
  els.connectorFigmaLocal.disabled = false;
  if (!r || !r.ok) return;
  await refreshConnectors();
  await window.wl.mcpConnect(r.id).catch(() => null);
  await refreshConnectors();
};
els.connectorFigmaRemote.onclick = () => {
  els.connectorAuth.hidden = false;
  els.connectorAuth.textContent = 'Remote Figma MCP is coming soon — Figma currently allows only approved MCP clients. Use + Figma (local) or the opencode agent for now.';
};
els.cfCancel.onclick = () => { els.connectorForm.hidden = true; state.connectorEdit = null; };
els.cfSave.onclick = async () => {
  const transport = (els.cfTransport.querySelector('button.on') || {}).dataset;
  const t = transport && transport.t === 'stdio' ? 'stdio' : 'http';
  const draft = {
    id: state.connectorEdit || undefined,
    name: els.cfName.value.trim(),
    transport: t,
    url: els.cfUrl.value.trim(),
    command: els.cfCommand.value.trim(),
    args: els.cfArgs.value.trim().split(/\s+/).filter(Boolean),
    enabled: !!(state.connectorDraft && state.connectorDraft.enabled),
    oauth: !!(state.connectorDraft && state.connectorDraft.oauth),
    clientId: els.cfClientId.value.trim(),
    clientSecret: els.cfClientSecret.value.trim(),
    redirectUri: els.cfRedirect.value.trim(),
    pat: els.cfPat.value.trim(),
    token: els.cfToken.value.trim(),
  };
  if (!draft.name) { els.cfStatus.textContent = 'Give the connector a name.'; return; }
  if (t === 'http' && !/^https?:\/\//i.test(draft.url)) { els.cfStatus.textContent = 'Enter an http(s) URL.'; return; }
  if (t === 'stdio' && !draft.command) { els.cfStatus.textContent = 'Enter the command to run.'; return; }
  const servers = state.connectors.map(stripServer);
  if (state.connectorEdit) {
    const i = servers.findIndex((s) => s.id === state.connectorEdit);
    if (i >= 0) servers[i] = draft; else servers.push(draft);
  } else {
    servers.push(draft);
  }
  els.cfSave.disabled = true;
  els.cfStatus.textContent = 'saving…';
  const r = await window.wl.mcpSave(servers).catch(() => null);
  els.cfSave.disabled = false;
  if (!r) { els.cfStatus.textContent = 'Could not save the connector.'; return; }
  els.cfStatus.textContent = '';
  state.connectors = r.servers || [];
  els.connectorForm.hidden = true;
  state.connectorEdit = null;
  renderConnectors();
  if (draft.token || draft.oauth) {
    const srv = state.connectors.find((x) => x.name === draft.name);
    if (srv) {
      await window.wl.mcpConnect(srv.id).catch(() => null);
      await refreshConnectors();
    }
  }
};
async function openConnectors() {
  if (state.settingsOpen) { state.settingsOpen = false; els.settings.hidden = true; }
  closeFigma();
  closeHistoryModal();
  state.connectorsOpen = true;
  document.body.classList.add('settings-on');
  if (window.wl.settingsModal) await window.wl.settingsModal(true).catch(() => {});
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  els.connectors.hidden = false;
  els.connectorForm.hidden = true;
  await refreshConnectors();
}
function closeConnectors() {
  state.connectorsOpen = false;
  els.connectors.hidden = true;
  els.connectorForm.hidden = true;
  document.body.classList.remove('settings-on');
  if (window.wl.settingsModal) window.wl.settingsModal(false).catch(() => {});
}
els.connectorsClose.onclick = closeConnectors;
els.connectorsBackdrop.onclick = closeConnectors;
if (window.wl.onUiOpenConnectors) window.wl.onUiOpenConnectors(() => openConnectors());
if (window.wl.onMcpAuthUrl) window.wl.onMcpAuthUrl(({ id, url }) => {
  const s = state.connectors.find((x) => x.id === id);
  showAuthWaiting(s ? s.name : id, url);
});
function collectSettings() {
  const s = state.settings || {};
  const agentBtn = document.querySelector('#agent-seg button.on');
  const provBtn = document.querySelector('#prov-seg button.on');
  return {
    ...s,
    agent: agentBtn ? agentBtn.dataset.agent : 'direct',
    opencode: { model: els.ocModel.value.trim(), agent: els.ocAgent.value.trim() },
    provider: provBtn ? provBtn.dataset.prov : 'cloudflare',
    cloudflare: { accountId: els.cfAccount.value.trim(), token: els.cfToken.value.trim(), model: els.cfModel.value.trim() },
    openai: { apiKey: els.oaKey.value.trim(), baseUrl: els.oaBase.value.trim(), model: els.oaModel.value.trim() },
    local: { baseUrl: els.localBase.value.trim(), apiKey: els.localKey.value.trim(), model: els.localModel.value.trim() },
    systemPrompt: els.sysPrompt.value,
    editor: els.editorCmd.value.trim(),
    sandbox: state.sandbox !== false,
    memory: { url: els.memUrl.value.trim() },
  };
}
function updateModelBadge() {
  const s = state.settings;
  if (!s) return;
  els.modelBadge.textContent = s.agent === 'opencode'
    ? 'opencode · ' + ((s.opencode && s.opencode.model) || 'default model') + ((s.opencode && s.opencode.agent) ? ' · ' + s.opencode.agent : '')
    : s.provider === 'local'
      ? 'local · ' + ((s.local && s.local.model) || 'no model')
      : (s.provider === 'openai' ? 'openai · ' + s.openai.model : 'cloudflare · ' + s.cloudflare.model);
  els.modelBadge.title = els.modelBadge.textContent;
}
async function renderAppInfo() {
  if (!els.appInfo || !window.wl.appInfo) return;
  const info = await window.wl.appInfo().catch(() => null);
  if (!info) return;
  els.appInfo.innerHTML = '';
  const left = document.createElement('span');
  left.textContent = 'withlook v' + info.version + ' · Beta';
  const right = document.createElement('button');
  right.type = 'button';
  right.textContent = 'releases ↗';
  right.title = info.releases || 'GitHub releases';
  right.onclick = () => { if (window.wl.openReleases) window.wl.openReleases(); };
  els.appInfo.append(left, right);
}

/* ---------- comboboxes (model / agent pickers) ---------- */
// Native <datalist> popups are drawn by the OS and ignore the dark theme, so the
// option lists live in a themed popover instead. The <datalist> elements stay as
// the source of truth (opencode fills them at runtime).
const comboPop = document.createElement('div');
comboPop.className = 'combo-pop';
comboPop.hidden = true;
document.body.appendChild(comboPop);
const combo = { input: null, items: [], active: -1, typed: false };

function comboSource(input) {
  const wrap = input.closest('.combo');
  const dl = wrap && document.getElementById(wrap.dataset.combo);
  return dl ? Array.from(dl.querySelectorAll('option')).map((o) => o.value).filter(Boolean) : [];
}
function comboItems() {
  if (!combo.typed) return combo.items;
  const q = combo.input.value.trim().toLowerCase();
  return q ? combo.items.filter((v) => v.toLowerCase().includes(q)) : combo.items;
}
function renderCombo() {
  const items = comboItems();
  comboPop.innerHTML = '';
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'combo-empty';
    empty.textContent = combo.items.length ? 'no match — Enter keeps what you typed' : 'no options yet';
    comboPop.appendChild(empty);
    combo.active = -1;
    return;
  }
  const current = combo.input.value.trim();
  items.forEach((value, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'combo-opt' + (i === combo.active ? ' active' : '') + (value === current ? ' sel' : '');
    b.textContent = value;
    b.title = value;
    b.onmousedown = (e) => { e.preventDefault(); pickCombo(value); };
    comboPop.appendChild(b);
  });
  const active = comboPop.querySelector('.combo-opt.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}
function positionCombo() {
  if (!combo.input) return;
  const r = combo.input.getBoundingClientRect();
  comboPop.hidden = false;
  comboPop.style.width = Math.max(180, Math.round(r.width)) + 'px';
  comboPop.style.left = Math.round(r.left) + 'px';
  const h = comboPop.offsetHeight;
  const roomBelow = window.innerHeight - r.bottom;
  const openUp = roomBelow < h + 8 && r.top > roomBelow;
  comboPop.style.top = Math.round(openUp ? r.top - h - 4 : r.bottom + 4) + 'px';
}
function openCombo(input, typed) {
  combo.input = input;
  combo.items = comboSource(input);
  combo.typed = !!typed;
  combo.active = combo.items.indexOf(input.value.trim());
  renderCombo();
  positionCombo();
}
function closeCombo() {
  if (comboPop.hidden) return;
  comboPop.hidden = true;
  combo.input = null;
  combo.items = [];
  combo.active = -1;
}
function pickCombo(value) {
  if (!combo.input) return;
  const input = combo.input;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  closeCombo();
  input.focus();
}
function moveCombo(delta) {
  const items = comboItems();
  if (!items.length) return;
  combo.active = (combo.active + delta + items.length) % items.length;
  renderCombo();
}
document.querySelectorAll('.combo input').forEach((input) => {
  input.addEventListener('keydown', (e) => {
    const open = !comboPop.hidden && combo.input === input;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (open) moveCombo(1); else openCombo(input, false);
    } else if (e.key === 'ArrowUp' && open) {
      e.preventDefault();
      moveCombo(-1);
    } else if (e.key === 'Enter' && open) {
      const items = comboItems();
      if (items.length && combo.active >= 0) { e.preventDefault(); pickCombo(items[combo.active]); }
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      closeCombo();
    } else if (e.key === 'Tab') {
      closeCombo();
    }
  });
  input.addEventListener('input', () => {
    if (comboPop.hidden || combo.input !== input) return;
    combo.typed = true;
    combo.active = 0;
    renderCombo();
    positionCombo();
  });
  const btn = input.parentElement.querySelector('.combo-btn');
  if (btn) btn.addEventListener('click', () => {
    if (!comboPop.hidden && combo.input === input) { closeCombo(); return; }
    openCombo(input, false);
    input.focus();
  });
});
document.addEventListener('mousedown', (e) => {
  if (comboPop.hidden) return;
  if (comboPop.contains(e.target) || (combo.input && combo.input.contains(e.target))) return;
  if (e.target.closest && e.target.closest('.combo-btn')) return;
  closeCombo();
});
window.addEventListener('resize', closeCombo);
// the drawer scrolls under the popover — dismiss instead of letting it drift
const drawerBody = els.settings && els.settings.querySelector('.drawer-body');
if (drawerBody) drawerBody.addEventListener('scroll', closeCombo, { passive: true });

/* ---------- wiring ---------- */
els.logo.onclick = () => setPanel(!state.panelOpen);
els.collapse.onclick = () => setPanel(false);
els.newChat.onclick = () => { clearChat(); state.sessionId = null; };
els.pick.onclick = pickNow;
els.addPick.onclick = pickNow;
els.send.onclick = () => (state.streaming ? window.wl.stopChat(state.streamId) : send());
els.quick.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); state.streaming ? window.wl.stopChat(state.streamId) : send(); }
  if (e.key === 'Escape') { if (state.picking) window.wl.cancelPicker(); else { els.quick.blur(); if (state.panelOpen) setPanel(false); } }
});
// typing stays in the floating pill — the panel opens on Enter (send), not on focus

els.settingsBtn.onclick = () => (state.settingsOpen ? closeSettings() : openSettings());
els.settingsClose.onclick = closeSettings;
els.settingsBackdrop.onclick = closeSettings;
els.sandboxBtn.onclick = () => {
  state.sandbox = !state.sandbox;
  els.sandboxBtn.textContent = 'Edit in a sandbox: ' + (state.sandbox ? 'on' : 'off');
  els.sandboxBtn.classList.toggle('on', state.sandbox);
};
els.sandboxApply.onclick = async () => {
  els.sandboxStatus.textContent = 'applying…';
  const r = await window.wl.sandboxApply().catch((e) => ({ ok: false, error: e.message }));
  els.sandboxStatus.textContent = r.ok
    ? `✓ applied ${r.files || 0} file${r.files === 1 ? '' : 's'}` + (r.conflicts && r.conflicts.length ? ` · ${r.conflicts.length} conflict(s)` : '')
    : '✗ ' + (r.error || 'apply failed');
};
let discardArmed = false;
els.sandboxDiscard.onclick = async () => {
  if (!discardArmed) {
    discardArmed = true;
    els.sandboxStatus.textContent = 'click discard again to confirm';
    setTimeout(() => { discardArmed = false; if (els.sandboxStatus.textContent === 'click discard again to confirm') els.sandboxStatus.textContent = ''; }, 2500);
    return;
  }
  discardArmed = false;
  els.sandboxStatus.textContent = 'discarding…';
  const r = await window.wl.sandboxDiscard().catch((e) => ({ ok: false, error: e.message }));
  els.sandboxStatus.textContent = r.ok ? 'sandbox discarded' : '✗ ' + (r.error || 'discard failed');
};
els.provBtns.forEach((b) => (b.onclick = () => bindProv(b.dataset.prov)));
els.agentSeg.querySelectorAll('button').forEach((b) => (b.onclick = () => bindAgent(b.dataset.agent)));
els.saveSettings.onclick = async () => {
  state.settings = collectSettings();
  await window.wl.saveSettings(state.settings);
  updateModelBadge();
  els.memTest.click(); // reconnect memory store if the URL changed
  els.savedFlash.hidden = false;
  setTimeout(() => (els.savedFlash.hidden = true), 1400);
};
els.memTest.onclick = async () => {
  els.memStatus.textContent = 'testing connection…';
  const r = await window.wl.storeTest(els.memUrl.value.trim());
  els.memStatus.textContent = r.mode === 'postgres'
    ? '✓ connected — projects & chats are stored in Postgres'
    : '✗ Postgres unreachable — ' + (r.error || 'using local file storage');
  renderRecentProjects();
};
async function startProject(folder) {
  closeSettings(); // never let the settings drawer block the project flow
  els.folderPath.textContent = folder + '  ·  starting…';
  // stay collapsed while the server starts — the loader covers the wait and the
  // panel docks on its own once the server is running (no floating-panel flash)
  const r = await window.wl.startDev(folder);
  if (!r.ok) { flashPageChip(r.error || 'cannot start'); return; }
  const data = await window.wl.sessionsLatest(r.folder || folder);
  if (data && data.session) restoreSession(data);
  else { clearChat(); state.sessionId = null; }
}
async function chooseAndStart() {
  closeSettings();
  const folder = await window.wl.chooseProject();
  if (!folder) return;
  startProject(folder);
}
function restoreSession(data) {
  clearChat();
  state.sessionId = data.session.id;
  const lastSels = [];
  for (const m of data.messages) {
    if (m.role === 'user') { state.history.push({ role: 'user', content: m.content }); addMsg('user', m.content); }
    else if (m.role === 'assistant') { state.history.push({ role: 'assistant', content: m.content }); addMsg('assistant', renderMd(m.content)); }
    else if (m.role === 'selection') {
      try {
        const s = JSON.parse(m.content);
        addSelectionMessage(s, false); // history: no remove control
        lastSels.push(s);
        if (lastSels.length > 3) lastSels.shift();
      } catch {}
    }
  }
  state.selections = lastSels; // keep the last few picks as live AI context
  renderChips();
  scrollBottom();
}
function rpButton(p, action, label) {
  const b = document.createElement('button');
  b.className = 'rp';
  b.innerHTML = '<span class="name"></span><span class="sub"></span><span class="go"></span>';
  b.querySelector('.name').textContent = p.name || p.folder;
  b.querySelector('.sub').textContent = (p.folder || '') + (p.last_port ? ' · :' + p.last_port : '');
  b.querySelector('.go').textContent = label || 'start';
  b.onclick = () => action(p);
  return b;
}
async function renderRecentProjects() {
  const list = await window.wl.projectsList().catch(() => []);
  els.recentProjects.innerHTML = '';
  if (!list.length) { els.recentProjects.innerHTML = '<div class="menu-empty">No projects opened yet.</div>'; return; }
  for (const p of list) els.recentProjects.appendChild(rpButton(p, (x) => startProject(x.folder)));
}
async function startCreateFlow() {
  closeSettings();
  els.recentMenu.hidden = true;
  els.historyMenu.hidden = true;
  if (state.panelOpen) await setPanel(false); // the chat bar comes down; the centered page takes over
  await window.wl.openCreatePage();
}
async function toggleRecentMenu() {
  const menu = els.recentMenu;
  if (!menu.hidden) { menu.hidden = true; return; }
  closeSettings(); // the menu replaces the settings drawer
  els.historyMenu.hidden = true;
  if (!state.panelOpen) await setPanel(true); // otherwise the menu clips behind the pill
  menu.innerHTML = '';
  // recent projects first…
  const list = await window.wl.projectsList().catch(() => []);
  const head = document.createElement('div');
  head.className = 'menu-label';
  head.textContent = list.length ? 'Recent projects' : 'No recent projects yet — open or create one below';
  menu.appendChild(head);
  for (const p of list) menu.appendChild(rpButton(p, (x) => { menu.hidden = true; startProject(x.folder); }));
  // …then the open/new actions, centred at the bottom
  const actions = document.createElement('div');
  actions.className = 'menu-actions';
  const openBtn = document.createElement('button');
  openBtn.className = 'mini strong';
  openBtn.textContent = 'Open project…';
  openBtn.onclick = () => { menu.hidden = true; chooseAndStart(); };
  const newBtn = document.createElement('button');
  newBtn.className = 'mini strong';
  newBtn.textContent = 'New project…';
  newBtn.onclick = () => startCreateFlow();
  actions.append(openBtn, newBtn);
  menu.appendChild(actions);
  menu.hidden = false;
}
async function openHistoryModal() {
  els.recentMenu.hidden = true;
  els.historyMenu.hidden = true;
  if (!state.panelOpen) await setPanel(true); // the modal needs the full panel area
  const items = await window.wl.sessionsList(state.dev && state.dev.folder).catch(() => []);
  els.hmList.innerHTML = '';
  if (!items.length) {
    els.hmList.innerHTML = '<div class="hm-empty">No past conversations yet.</div>';
  } else {
    for (const s of items) {
      const b = document.createElement('button');
      b.className = 'hm-item';
      b.innerHTML = '<span class="t"></span><span class="m"></span>';
      b.querySelector('.t').textContent = s.title || 'Untitled chat';
      b.querySelector('.m').textContent = (s.project || s.folder || '—') + ' · ' + new Date(s.updated_at).toLocaleString() + ' · ' + s.messages + ' msgs';
      b.onclick = async () => {
        closeHistoryModal();
        const data = await window.wl.sessionsLoad(s.id);
        if (data) { restoreSession(data); if (!state.panelOpen) setPanel(true); }
      };
      els.hmList.appendChild(b);
    }
  }
  els.historyModal.hidden = false;
}
function closeHistoryModal() { els.historyModal.hidden = true; }
async function toggleHistoryMenu() { openHistoryModal(); }
els.openproj.onclick = toggleRecentMenu;
els.historyBtn.onclick = toggleHistoryMenu;
els.hmClose.onclick = closeHistoryModal;
els.hmBackdrop.onclick = closeHistoryModal;
document.addEventListener('click', (e) => {
  if (!els.recentMenu.hidden && !els.recentMenu.contains(e.target) && e.target !== els.openproj) els.recentMenu.hidden = true;
  if (!els.historyMenu.hidden && !els.historyMenu.contains(e.target) && e.target !== els.historyBtn) els.historyMenu.hidden = true;
  if (!els.quickMenu.hidden && !els.quickMenu.contains(e.target) && e.target !== els.quickBtn) els.quickMenu.hidden = true;
});
els.openProject.onclick = chooseAndStart;
els.editProject.onclick = async () => {
  if (!state.dev || !state.dev.folder) { flashPageChip('open a project first'); return; }
  await window.wl.openSource({ file: state.dev.folder });
};
function toggleQuickMenu(force) {
  const show = force !== undefined ? force : els.quickMenu.hidden;
  els.quickMenu.hidden = !show;
}
els.quickBtn.onclick = (e) => { e.stopPropagation(); toggleQuickMenu(); };
els.quickSettings.onclick = () => { toggleQuickMenu(false); openSettings(); };
els.writeBtn.onclick = () => {
  state.writeMode = !state.writeMode;
  els.writeState.textContent = state.writeMode ? 'on' : 'off';
  els.writeState.classList.toggle('on', state.writeMode);
};
els.showPreviewBtn.onclick = () => { window.wl.showPreview(); toggleQuickMenu(false); };
els.logsBtn.onclick = async () => {
  const show = els.devlogPane.hidden;
  if (show) {
    const logs = await window.wl.devLogs();
    els.panelLogs.textContent = (logs || []).join('\n');
    els.panelLogs.scrollTop = els.panelLogs.scrollHeight;
  }
  els.devlogPane.hidden = !show;
  toggleQuickMenu(false);
};
els.stopServer.onclick = () => window.wl.stopDev();
els.messages.addEventListener('click', async (e) => {
  const stopGen = e.target.closest('.stop-gen');
  if (stopGen) { if (state.streamId) window.wl.stopChat(state.streamId); return; }
  const patchBtn = e.target.closest('.rp-action');
  if (patchBtn) {
    e.preventDefault();
    e.stopPropagation();
    const mode = patchBtn.dataset.patch;
    patchBtn.disabled = true;
    const r = await window.wl.gitSharePatch(mode).catch(() => null);
    patchBtn.disabled = false;
    patchBtn.textContent = r && r.ok ? (mode === 'copy' ? 'copied ✓' : 'saved ✓') : 'failed';
    if (r && r.ok && mode === 'save') flashPageChip('patch saved');
    return;
  }
  const rpRow = e.target.closest('.rp-row');
  if (rpRow) {
    const pre = rpRow.nextElementSibling;
    if (!pre || !pre.classList.contains('rp-diff')) return;
    if (!pre.hidden) { pre.hidden = true; return; }
    pre.hidden = false;
    if (pre.dataset.loaded) return;
    pre.dataset.loaded = '1';
    pre.textContent = 'loading diff…';
    const r = await window.wl.gitDiff(rpRow.dataset.file, 'sandbox').catch(() => null);
    if (!r || !r.ok) { pre.textContent = (r && r.error) || 'diff unavailable'; return; }
    if (!String(r.diff).trim()) { pre.textContent = '(new untracked file — no tracked diff)'; return; }
    pre.innerHTML = diffHtml(r.diff);
    return;
  }
  const btn = e.target.closest('.apply-file');
  if (!btn || btn.disabled) return;
  e.preventDefault();
  e.stopPropagation();
  const block = btn.closest('.fileblock');
  const code = block.querySelector('pre code').textContent;
  btn.textContent = 'saving…';
  const r = await window.wl.writeCode({ file: btn.dataset.file, content: code });
  if (r.ok) { btn.textContent = 'saved ✓'; btn.disabled = true; flashPageChip('wrote ' + String(r.file).split('/').pop()); }
  else btn.textContent = r.error || 'failed';
});
els.stopServer.onclick = () => window.wl.stopDev();
els.urlGo.onclick = async () => {
  const ok = await window.wl.loadUrl(els.urlInput.value);
  if (!ok) flashPageChip('invalid URL');
};
els.urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') els.urlGo.click(); });

window.wl.onUiOpenSettings(() => { openSettings(); });
window.wl.onUiCloseSettings(() => { if (state.settingsOpen) closeSettings(); });
window.wl.onUiOpenProject(() => chooseAndStart());
window.wl.onUiOpenFolder((folder) => startProject(folder));
window.wl.onUiNewProject(() => startCreateFlow());
window.wl.onUiNewChat(() => { clearChat(); state.sessionId = null; if (!state.panelOpen) setPanel(true); });
window.wl.onUiOpenHistory(() => { closeSettings(); toggleHistoryMenu(); });
window.wl.onUiToggleFloat(() => uiToggleFloat());
window.wl.onUiShowPanel(() => { if (state.dev && state.dev.state === 'running' && !state.panelOpen) setPanel(true); });
window.wl.onUiLoadSession(async (id) => {
  closeSettings();
  els.recentMenu.hidden = true;
  els.historyMenu.hidden = true;
  const data = await window.wl.sessionsLoad(id);
  if (data) { restoreSession(data); if (!state.panelOpen) setPanel(true); }
});
window.wl.onUiFocusChat(() => {
  if (state.home || !state.dev || state.dev.state !== 'running') return;
  els.quick.focus();
  if (!state.panelOpen) setPanel(true);
});
window.wl.onUiTogglePanel(() => {
  if (state.home || !state.dev || state.dev.state !== 'running') return;
  setPanel(!state.panelOpen);
});

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  const live = !state.home && !!state.dev && state.dev.state === 'running';
  if (live && mod && (e.key === 'e' || e.key === 'E')) { e.preventDefault(); els.pick.click(); }
  if (live && mod && e.shiftKey && (e.key === 'v' || e.key === 'V')) { e.preventDefault(); if (window.wl.pasteRef) window.wl.pasteRef(); }
  if (live && mod && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); els.quick.focus(); }
  if (live && mod && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); uiToggleFloat(); }
  if (live && mod && (e.key === 'j' || e.key === 'J')) { e.preventDefault(); setPanel(!state.panelOpen); }
  if (e.key === 'Escape') {
    if (state.streaming) window.wl.stopChat(state.streamId);
    else if (state.attachOpen) closeAttach();
    else if (!els.connectors.hidden) closeConnectors();
    else if (!els.figmaModal.hidden) closeFigma();
    else if (!els.historyModal.hidden) closeHistoryModal();
    else if (state.picking) window.wl.cancelPicker();
    else if (!els.quickMenu.hidden) toggleQuickMenu(false);
    else if (state.settingsOpen) closeSettings();
    else if (state.panelOpen) setPanel(false);
  }
});

/* ---------- boot ---------- */
(async () => {
  await loadSettingsInto();
  renderAppInfo();
  if (window.wl.refsState) window.wl.refsState().then(applyRefs).catch(() => {});
  const st = await window.wl.storeStatus();
  els.memStatus.textContent = st.mode === 'postgres'
    ? '✓ connected — projects & chats are stored in Postgres'
    : 'not connected — using local file storage';
  renderRecentProjects();
  const dev = await window.wl.devStatus();
  if (dev) window.wl.onDevStatus && (state.dev = dev);
  const logs = await window.wl.devLogs();
  els.devLogs.textContent = (logs || []).join('\n');
  const info = await window.wl.pageInfo();
  if (info) window.wl.onPageNav && (state.pageUrl = info.url);
})();
