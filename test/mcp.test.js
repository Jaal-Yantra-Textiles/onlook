'use strict';
/* MCP client: node test/mcp.test.js */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert');
const { McpClient, resultText, resultImage } = require('../main/mcp');

const TOOLS = [
  { name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'shot', description: 'Return an image', inputSchema: { type: 'object', properties: {} } },
];

const stdioServer = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const tools = ${JSON.stringify(TOOLS)};
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id == null) return;
  let result;
  if (m.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'stub-stdio', version: '1' } };
  else if (m.method === 'tools/list') result = { tools };
  else if (m.method === 'tools/call') {
    if (m.params.name === 'shot') result = { content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }] };
    else result = { content: [{ type: 'text', text: 'echo:' + ((m.params.arguments || {}).text || '') }] };
  } else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no method' } }) + '\\n'); return; }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
});
`;

function httpServer(mode) {
  const seen = { session: [], methods: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let m = {};
      try { m = JSON.parse(body); } catch {}
      seen.session.push(req.headers['mcp-session-id'] || '');
      seen.methods.push(m.method || '');
      if (m.method === 'initialize') res.setHeader('mcp-session-id', 'sess-1');
      const reply = (result) => {
        const payload = JSON.stringify({ jsonrpc: '2.0', id: m.id, result });
        if (mode === 'sse') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end('event: message\ndata: ' + payload + '\n\n');
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(payload);
        }
      };
      if (m.id == null) { res.writeHead(202); res.end(); return; }
      if (m.method === 'initialize') reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'stub-http', version: '1' } });
      else if (m.method === 'tools/list') reply({ tools: TOOLS });
      else if (m.method === 'tools/call') {
        if (m.params.name === 'shot') reply({ content: [{ type: 'image', mimeType: 'image/png', data: 'BBBB' }] });
        else reply({ content: [{ type: 'text', text: 'echo:' + ((m.params.arguments || {}).text || '') }] });
      } else reply({});
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}

function authServer() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.headers.authorization !== 'Bearer good') {
        res.writeHead(401, { 'www-authenticate': 'Bearer resource_metadata="http://x/.well-known/oauth-protected-resource"', 'content-type': 'text/plain' });
        res.end('Unauthorized');
        return;
      }
      let m = {};
      try { m = JSON.parse(body); } catch {}
      const result = m.method === 'initialize'
        ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'stub-auth', version: '1' } }
        : m.method === 'tools/list' ? { tools: TOOLS } : {};
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-mcp-'));
  const script = path.join(root, 'server.js');
  fs.writeFileSync(script, stdioServer);
  try {
    // ---- stdio ----
    const stdio = new McpClient({ transport: 'stdio', command: process.execPath, args: [script] });
    await stdio.connect();
    assert.equal(stdio.serverInfo.name, 'stub-stdio');
    const tools = await stdio.listTools();
    assert.equal(tools.length, 2);
    assert.equal(resultText(await stdio.callTool('echo', { text: 'hi' })), 'echo:hi');
    assert.equal(resultImage(await stdio.callTool('shot', {}))?.data, 'AAAA');
    stdio.close();

    // ---- Streamable HTTP (JSON) ----
    const a = await httpServer('json');
    const httpClient = new McpClient({ url: `http://127.0.0.1:${a.port}/mcp` });
    await httpClient.connect();
    assert.equal(httpClient.serverInfo.name, 'stub-http');
    assert.equal((await httpClient.listTools()).length, 2);
    assert.equal(resultText(await httpClient.callTool('echo', { text: 'yo' })), 'echo:yo');
    assert.equal(httpClient.sessionId, 'sess-1');
    // the session id must travel on the follow-up requests
    assert.ok(a.seen.session.slice(1).every((s) => s === 'sess-1'));
    httpClient.close();
    a.server.close();

    // ---- Streamable HTTP (SSE responses) ----
    const b = await httpServer('sse');
    const sseClient = new McpClient({ url: `http://127.0.0.1:${b.port}/mcp` });
    await sseClient.connect();
    assert.equal((await sseClient.listTools()).length, 2);
    assert.equal(resultImage(await sseClient.callTool('shot', {}))?.data, 'BBBB');
    sseClient.close();
    b.server.close();

    // ---- bearer auth: token sent, 401 challenge surfaced ----
    const c = await authServer();
    const okClient = new McpClient({ url: `http://127.0.0.1:${c.port}/mcp`, token: 'good' });
    await okClient.connect();
    assert.equal(okClient.serverInfo.name, 'stub-auth');
    assert.equal((await okClient.listTools()).length, 2);
    okClient.close();
    const noClient = new McpClient({ url: `http://127.0.0.1:${c.port}/mcp` });
    let authErr = null;
    try { await noClient.connect(); } catch (e) { authErr = e; }
    assert.ok(authErr && authErr.code === 401);
    assert.match(noClient.authChallenge, /resource_metadata/);
    c.server.close();

    console.log('MCP_PASS');
    fs.rmSync(root, { recursive: true, force: true });
  } catch (e) {
    console.error('MCP_FAIL ' + (e && e.message));
    fs.rmSync(root, { recursive: true, force: true });
    process.exit(1);
  }
})();
