'use strict';
/* withlook static server — plain-HTML projects are served straight from the folder */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const NOT_FOUND = `<!doctype html><meta charset="utf-8"><title>404</title>
<style>body{background:#0b0d12;color:#e7ecf5;font:14px/1.6 ui-sans-serif,system-ui;display:grid;place-items:center;height:100vh;margin:0}
code{color:#6ea8ff}</style>
<div><h1>404</h1><p>No file matches this path.</p><p><code>withlook</code> serves plain HTML from the project folder.</p></div>`;

// resolve a URL path inside root, refusing traversal and absolute escapes
function resolveInRoot(root, url) {
  let decoded;
  try { decoded = decodeURIComponent(String(url || '/').split('?')[0].split('#')[0]); } catch { return null; }
  if (decoded.includes('\0')) return null;
  const abs = path.resolve(root, '.' + path.posix.normalize('/' + decoded));
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

function fileFor(abs) {
  try {
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      const index = path.join(abs, 'index.html');
      return fs.existsSync(index) ? index : null;
    }
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
    if (!path.extname(abs)) {
      // /about → about.html, then about/index.html
      if (fs.existsSync(abs + '.html')) return abs + '.html';
      const index = path.join(abs, 'index.html');
      if (fs.existsSync(index)) return index;
    }
  } catch {}
  return null;
}

function handler(root) {
  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('method not allowed');
      return;
    }
    const abs = resolveInRoot(root, req.url);
    if (!abs) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('forbidden');
      return;
    }
    const file = fileFor(abs);
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : NOT_FOUND);
      return;
    }
    try {
      const body = fs.readFileSync(file);
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'content-length': body.length,
        'cache-control': 'no-store',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('could not read the file');
    }
  };
}

function start(root, ports = [8080, 8081, 8082, 8083, 8084, 8085, 8086, 8087, 8088, 8089, 8090]) {
  return new Promise((resolve) => {
    const server = http.createServer(handler(root));
    let i = 0;
    const attempt = () => {
      if (i >= ports.length) { resolve({ ok: false, error: 'no free port' }); return; }
      const port = ports[i++];
      const onError = (e) => {
        server.removeListener('listening', onListen);
        if (e.code === 'EADDRINUSE' || e.code === 'EACCES') attempt();
        else resolve({ ok: false, error: e.message });
      };
      const onListen = () => {
        server.removeListener('error', onError);
        resolve({ ok: true, server, port: server.address().port });
      };
      server.once('error', onError);
      server.once('listening', onListen);
      try { server.listen(port, '127.0.0.1'); } catch (e) { resolve({ ok: false, error: e.message }); }
    };
    attempt();
  });
}

module.exports = { start, handler, resolveInRoot, MIME };
