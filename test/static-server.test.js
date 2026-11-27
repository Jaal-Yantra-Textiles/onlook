'use strict';
/* static server for plain-HTML projects: node test/static-server.test.js */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { start } = require('../main/static-server');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-static-'));
fs.writeFileSync(path.join(root, 'index.html'), '<h1>Home</h1>');
fs.writeFileSync(path.join(root, 'about.html'), '<h1>About</h1>');
fs.writeFileSync(path.join(root, 'styles.css'), 'body{color:red}');
fs.mkdirSync(path.join(root, 'docs'));
fs.writeFileSync(path.join(root, 'docs', 'index.html'), '<h1>Docs</h1>');
fs.writeFileSync(path.join(root, 'secret.txt'), 'inside');

(async () => {
  let server = null;
  try {
    const s = await start(root, [0]);
    assert.equal(s.ok, true);
    server = s.server;
    const base = `http://127.0.0.1:${s.port}`;

    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type'), /text\/html/);
    assert.match(await home.text(), /Home/);

    const extless = await fetch(`${base}/about`);
    assert.equal(extless.status, 200);
    assert.match(await extless.text(), /About/);

    const explicit = await fetch(`${base}/about.html`);
    assert.equal(explicit.status, 200);

    const css = await fetch(`${base}/styles.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);

    const dir = await fetch(`${base}/docs`);
    assert.equal(dir.status, 200);
    assert.match(await dir.text(), /Docs/);

    const missing = await fetch(`${base}/nope`);
    assert.equal(missing.status, 404);

    const head = await fetch(`${base}/`, { method: 'HEAD' });
    assert.equal(head.status, 200);

    const post = await fetch(`${base}/`, { method: 'POST' });
    assert.equal(post.status, 405);

    // traversal must never escape the project folder
    const traversal = await fetch(`${base}/%2e%2e/%2e%2e/etc/passwd`);
    assert.ok(traversal.status === 403 || traversal.status === 404);
    assert.doesNotMatch(await traversal.text(), /root:/);

    console.log('STATIC_SERVER_PASS');
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  } catch (e) {
    console.error('STATIC_SERVER_FAIL ' + (e && e.message));
    try { if (server) server.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
    process.exit(1);
  }
})();
