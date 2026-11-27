'use strict';
/* MCP OAuth: node test/mcp-oauth.test.js */
const http = require('node:http');
const assert = require('node:assert');
const { authorize, refresh, ensureToken, discover, registerClient } = require('../main/mcp-oauth');

function startStub() {
  const seen = { register: null, token: [], auth: null };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://127.0.0.1');
      const origin = 'http://127.0.0.1:' + server.address().port;
      const json = (v, code) => {
        res.writeHead(code || 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(v));
      };
      if (u.pathname === '/.well-known/oauth-protected-resource') {
        return json({ resource: origin + '/mcp', authorization_servers: [origin], scopes_supported: ['mcp:connect'] });
      }
      if (u.pathname === '/.well-known/oauth-authorization-server') {
        return json({
          issuer: origin,
          authorization_endpoint: origin + '/authorize',
          token_endpoint: origin + '/token',
          registration_endpoint: origin + '/register',
        });
      }
      if (u.pathname === '/register') {
        seen.register = { pat: req.headers['x-figma-token'], body: JSON.parse(body || '{}') };
        return json({ client_id: 'client-1', client_secret: 'secret-1' });
      }
      if (u.pathname === '/token') {
        const f = new URLSearchParams(body);
        seen.token.push(Object.fromEntries(f));
        if (f.get('grant_type') === 'refresh_token') {
          return json({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 });
        }
        if (f.get('code') === 'pre') {
          return json({ access_token: 'at-pre', refresh_token: 'rt-pre', expires_in: 3600 });
        }
        if (f.get('code') !== 'good' || !f.get('code_verifier')) return json({ error: 'invalid_grant' }, 400);
        return json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 });
      }
      res.writeHead(404); res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, origin: 'http://127.0.0.1:' + server.address().port })));
}

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

(async () => {
  const { server, seen, origin } = await startStub();
  try {
    const challenge = 'Bearer resource_metadata="' + origin + '/.well-known/oauth-protected-resource", scope="mcp:connect"';
    const meta = await discover(origin + '/mcp', challenge);
    assert.equal(meta.scope, 'mcp:connect');
    assert.equal(meta.tokenEndpoint, origin + '/token');
    assert.equal(meta.registrationEndpoint, origin + '/register');

    let opened = null;
    const openUrl = async (url) => {
      opened = new URL(url);
      const redirect = opened.searchParams.get('redirect_uri');
      const state = opened.searchParams.get('state');
      await fetch(redirect + '?code=good&state=' + state);
    };
    const tok = await authorize({
      serverUrl: origin + '/mcp',
      challenge,
      pat: 'figd_test',
      openUrl,
      clientName: 'withlook',
    });
    assert.equal(tok.accessToken, 'at-1');
    assert.equal(tok.refreshToken, 'rt-1');
    assert.equal(tok.clientId, 'client-1');
    assert.equal(tok.clientSecret, 'secret-1');
    assert.equal(seen.register.pat, 'figd_test');
    assert.deepEqual(seen.register.body.redirect_uris.length, 1);
    assert.equal(opened.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(opened.searchParams.get('code_challenge'));
    const first = seen.token[0];
    assert.equal(first.grant_type, 'authorization_code');
    assert.equal(first.code, 'good');
    assert.ok(first.code_verifier);
    assert.equal(first.client_secret, 'secret-1');

    const fresh = await refresh({ token: tok });
    assert.equal(fresh.accessToken, 'at-2');
    assert.equal(fresh.refreshToken, 'rt-2');

    const expired = { ...tok, expiresAt: Date.now() - 1000 };
    const ensured = await ensureToken({ token: expired, serverUrl: origin + '/mcp', challenge, pat: 'x', openUrl });
    assert.equal(ensured.accessToken, 'at-2');

    // ---- pre-registered client: no dynamic registration, custom redirect ----
    seen.register = null;
    const port = await freePort();
    const redirectUri = 'http://127.0.0.1:' + port + '/mcp/oauth/callback';
    let opened2 = null;
    const openUrl2 = async (url) => {
      opened2 = new URL(url);
      const redirect = opened2.searchParams.get('redirect_uri');
      const state = opened2.searchParams.get('state');
      await fetch(redirect + '?code=pre&state=' + state);
    };
    const pre = await authorize({
      serverUrl: origin + '/mcp',
      challenge,
      clientId: 'pre-1',
      clientSecret: 'pre-secret',
      redirectUri,
      openUrl: openUrl2,
      clientName: 'withlook',
    });
    assert.equal(pre.accessToken, 'at-pre');
    assert.equal(pre.clientId, 'pre-1');
    assert.equal(pre.clientSecret, 'pre-secret');
    assert.equal(seen.register, null);
    assert.equal(opened2.searchParams.get('client_id'), 'pre-1');
    assert.equal(opened2.searchParams.get('redirect_uri'), redirectUri);
    const preToken = seen.token[seen.token.length - 1];
    assert.equal(preToken.client_id, 'pre-1');
    assert.equal(preToken.client_secret, 'pre-secret');

    // ---- closed dynamic registration gets an actionable error ----
    const forb = http.createServer((req, res) => { res.writeHead(403, { 'content-type': 'text/plain' }); res.end('Forbidden'); });
    const forbPort = await new Promise((r) => forb.listen(0, '127.0.0.1', () => r(forb.address().port)));
    let regErr = null;
    try {
      await registerClient({ registrationEndpoint: 'http://127.0.0.1:' + forbPort + '/register', redirectUri: 'http://127.0.0.1:1/cb', pat: 'x' });
    } catch (e) { regErr = e; }
    forb.close();
    assert.match(regErr.message, /dynamic client registration/);

    console.log('MCP_OAUTH_PASS');
  } catch (e) {
    console.error('MCP_OAUTH_FAIL ' + (e && e.message));
    process.exit(1);
  } finally {
    server.close();
  }
})();
