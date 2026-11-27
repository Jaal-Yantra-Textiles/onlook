'use strict';
/* withlook MCP client — JSON-RPC over Streamable HTTP or stdio */
const { spawn } = require('node:child_process');
const readline = require('node:readline');

const PROTOCOL_VERSION = '2024-11-05';

class McpError extends Error {
  constructor(message, code) { super(message); this.name = 'McpError'; this.code = code; }
}

// read a Streamable-HTTP response that may be JSON or an SSE stream
async function readSse(res, id) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (!raw) continue;
      let msg;
      try { msg = JSON.parse(raw); } catch { continue; }
      if (msg && msg.id === id) {
        try { await reader.cancel(); } catch {}
        return msg;
      }
    }
  }
  return null;
}

class McpClient {
  constructor(opts = {}) {
    this.transport = opts.transport === 'stdio' ? 'stdio' : 'http';
    this.url = String(opts.url || '');
    this.command = String(opts.command || '');
    this.args = Array.isArray(opts.args) ? opts.args : [];
    this.env = opts.env || null;
    this.timeout = opts.timeout || 30000;
    this.name = opts.name || 'withlook';
    this.token = opts.token || null;
    this.authChallenge = '';
    this.nextId = 0;
    this.pending = new Map();
    this.sessionId = null;
    this.proc = null;
    this.rl = null;
    this.serverInfo = null;
    this.capabilities = null;
    this.tools = [];
    this.connected = false;
  }

  async connect() {
    if (this.connected) return this;
    if (this.transport === 'stdio') this._startStdio();
    const init = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: this.name, version: '0.1.0' },
    });
    this.serverInfo = (init && init.serverInfo) || null;
    this.capabilities = (init && init.capabilities) || null;
    await this.notify('notifications/initialized', {});
    this.connected = true;
    return this;
  }

  async request(method, params) {
    const id = ++this.nextId;
    const msg = { jsonrpc: '2.0', id, method, params: params || {} };
    const res = this.transport === 'stdio' ? await this._stdio(msg) : await this._http(msg);
    if (!res) throw new McpError(`No response for ${method}`);
    if (res.error) throw new McpError(res.error.message || 'MCP error', res.error.code);
    return res.result;
  }

  async notify(method, params) {
    const msg = { jsonrpc: '2.0', method, params: params || {} };
    if (this.transport === 'stdio') { this._write(msg); return; }
    await this._http(msg);
  }

  async listTools() {
    const r = await this.request('tools/list', {});
    this.tools = (r && Array.isArray(r.tools)) ? r.tools : [];
    return this.tools;
  }

  async callTool(name, args) {
    return this.request('tools/call', { name, arguments: args || {} });
  }

  // ---- HTTP (Streamable HTTP; JSON or SSE responses) ----
  async _http(msg) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL_VERSION,
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    if (this.token) headers.authorization = 'Bearer ' + this.token;
    const res = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(this.timeout),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (res.status === 202 || res.status === 204) return null;
    if (!res.ok) {
      this.authChallenge = res.headers.get('www-authenticate') || '';
      const text = await res.text().catch(() => '');
      throw new McpError(`HTTP ${res.status}${text ? ' — ' + text.slice(0, 300) : ''}`, res.status);
    }
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('text/event-stream')) {
      if (msg.id == null) { try { await res.body.cancel(); } catch {} return null; }
      return readSse(res, msg.id);
    }
    return res.json().catch(() => null);
  }

  // ---- stdio ----
  _startStdio() {
    if (!this.command) throw new McpError('No command configured for this MCP server.');
    this.proc = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(this.env || {}) },
    });
    this.proc.on('error', (e) => this._failAll(e));
    this.proc.on('exit', () => this._failAll(new McpError('MCP server exited.')));
    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg && msg.id != null && this.pending.has(msg.id)) {
        const { resolve } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        resolve(msg);
      }
    });
  }

  _write(msg) {
    try { this.proc.stdin.write(JSON.stringify(msg) + '\n'); } catch {}
  }

  _stdio(msg) {
    return new Promise((resolve, reject) => {
      if (!this.proc) return reject(new McpError('MCP server is not running.'));
      if (msg.id == null) { this._write(msg); resolve(null); return; }
      const timer = setTimeout(() => {
        this.pending.delete(msg.id);
        reject(new McpError(`MCP request timed out (${msg.method}).`));
      }, this.timeout);
      this.pending.set(msg.id, {
        resolve: (m) => { clearTimeout(timer); resolve(m); },
      });
      this._write(msg);
    });
  }

  _failAll(err) {
    for (const { resolve } of this.pending.values()) resolve({ error: { message: err.message } });
    this.pending.clear();
    this.connected = false;
  }

  close() {
    this.connected = false;
    try { if (this.rl) this.rl.close(); } catch {}
    this.rl = null;
    try { if (this.proc) this.proc.kill(); } catch {}
    this.proc = null;
    this.pending.clear();
    this.sessionId = null;
  }
}

function resultText(result) {
  const content = (result && Array.isArray(result.content)) ? result.content : [];
  return content.filter((c) => c && c.type === 'text').map((c) => String(c.text || '')).join('\n').trim();
}

function resultImage(result) {
  const content = (result && Array.isArray(result.content)) ? result.content : [];
  const img = content.find((c) => c && c.type === 'image' && c.data);
  if (!img) return null;
  return { mimeType: img.mimeType || 'image/png', data: String(img.data) };
}

module.exports = { McpClient, McpError, resultText, resultImage, PROTOCOL_VERSION };
