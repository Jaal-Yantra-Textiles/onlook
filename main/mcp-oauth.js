'use strict';
/* MCP OAuth 2.1 (PKCE) for remote servers such as Figma's hosted MCP */
const crypto = require('node:crypto');
const http = require('node:http');

const CALLBACK_PATH = '/mcp/oauth/callback';
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const CALLBACK_PORT = 19876;

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pkce() {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function parseChallenge(header) {
  const out = {};
  const re = /([a-zA-Z_]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(String(header || '')))) out[m[1].toLowerCase()] = m[2];
  return out;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' from ' + url);
  return res.json();
}

async function postJson(url, body, headers) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...(headers || {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error('HTTP ' + res.status + ' from ' + url + ': ' + text.slice(0, 300));
  return json;
}

async function postForm(url, fields) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(fields).toString(),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error('HTTP ' + res.status + ' from ' + url + ': ' + text.slice(0, 300));
  return json;
}

async function postFormBasic(url, fields, clientId, clientSecret) {
  const basic = Buffer.from(clientId + ':' + clientSecret).toString('base64');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      authorization: 'Basic ' + basic,
    },
    body: new URLSearchParams(fields).toString(),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error('HTTP ' + res.status + ' from ' + url + ': ' + text.slice(0, 300));
  return json;
}

// client_secret_post first, then client_secret_basic (Figma accepts both)
async function exchange(url, fields, client) {
  const body = { ...fields };
  if (client && client.clientSecret) body.client_secret = client.clientSecret;
  try {
    return await postForm(url, body);
  } catch (e) {
    if (client && client.clientSecret && /HTTP 401/.test(e.message)) {
      return postFormBasic(url, { ...fields }, client.clientId, client.clientSecret);
    }
    throw e;
  }
}

// WWW-Authenticate challenge + RFC 9728 / RFC 8414 discovery
async function discover(serverUrl, challenge) {
  const c = parseChallenge(challenge);
  const origin = new URL(serverUrl).origin;
  const metaUrl = c.resource_metadata || (origin + '/.well-known/oauth-protected-resource');
  const resource = await getJson(metaUrl);
  const issuer = (resource.authorization_servers && resource.authorization_servers[0]) || origin;
  const auth = await getJson(issuer + '/.well-known/oauth-authorization-server');
  return {
    resource: resource.resource || serverUrl,
    issuer,
    scopes: resource.scopes_supported || [],
    scope: (c.scope || (resource.scopes_supported || [])[0] || '').trim(),
    authorizationEndpoint: auth.authorization_endpoint,
    tokenEndpoint: auth.token_endpoint,
    registrationEndpoint: auth.registration_endpoint,
  };
}

// RFC 7591 dynamic registration; Figma gates this behind a personal access token
async function registerClient({ registrationEndpoint, redirectUri, pat, clientName }) {
  if (!registrationEndpoint) throw new Error('This server does not support dynamic client registration.');
  if (!pat) throw new Error('A Figma personal access token is needed to register the OAuth client.');
  let reg;
  try {
    reg = await postJson(registrationEndpoint, {
      client_name: clientName || 'withlook',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }, { 'x-figma-token': pat });
  } catch (e) {
    if (/HTTP 403/.test(e.message)) {
      throw new Error('Figma closed dynamic client registration (403). Enter a pre-registered OAuth client ID and secret instead, or use the local Figma Dev Mode server.');
    }
    throw e;
  }
  if (!reg || !reg.client_id) throw new Error('Registration returned no client_id.');
  return { clientId: reg.client_id, clientSecret: reg.client_secret || '' };
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function pickPort(start) {
  const base = start || CALLBACK_PORT;
  for (let p = base; p < base + 20; p++) {
    try { const server = await listen(p); return { server, port: p }; } catch {}
  }
  const server = await listen(0);
  return { server, port: server.address().port };
}

function waitForCode(server, expectedState, cbPath) {
  const path = cbPath || CALLBACK_PATH;
  return new Promise((resolve, reject) => {
    const done = (fn, value) => {
      clearTimeout(timer);
      try { server.close(); } catch {}
      fn(value);
    };
    const timer = setTimeout(() => done(reject, new Error('Timed out waiting for the browser sign-in.')), AUTH_TIMEOUT_MS);
    server.on('request', (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== path) { res.writeHead(404); res.end(); return; }
      const code = u.searchParams.get('code') || '';
      const state = u.searchParams.get('state') || '';
      const error = u.searchParams.get('error') || '';
      const desc = u.searchParams.get('error_description') || '';
      const reason = error === 'access_denied' ? 'Access was denied in the browser.'
        : error === 'invalid_scope' ? 'The server rejected the requested scope. Figma only grants mcp:connect to MCP-approved OAuth clients.'
        : /not enabled/i.test(desc) ? 'Figma says the remote MCP server is not enabled for this OAuth client. Only MCP-catalog-approved clients can use it; try the local Figma Dev Mode server.'
        : (desc || error || 'The sign-in response did not match.');
      const ok = !error && code && state === expectedState;
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(ok
        ? '<h2>Signed in</h2><p>You can close this tab and return to withlook.</p>'
        : '<h2>Sign-in failed</h2><p>' + reason + '</p>');
      if (ok) done(resolve, code);
      else done(reject, new Error(reason));
    });
  });
}

async function authorize(opts) {
  const meta = await discover(opts.serverUrl, opts.challenge);
  let client;
  let redirectUri;
  let server;
  if (opts.clientId) {
    client = { clientId: String(opts.clientId).trim(), clientSecret: String(opts.clientSecret || '').trim() };
    redirectUri = opts.redirectUri || ('http://127.0.0.1:' + CALLBACK_PORT + CALLBACK_PATH);
    let u;
    try { u = new URL(redirectUri); } catch { throw new Error('The redirect URI is not a valid URL.'); }
    if (!/^(127\.0\.0\.1|localhost)$/i.test(u.hostname)) {
      throw new Error('The redirect URI must point to 127.0.0.1 (or localhost) so withlook can capture the code.');
    }
    const port = Number(u.port);
    if (!port) throw new Error('The redirect URI must include a local port, e.g. http://127.0.0.1:19876/mcp/oauth/callback.');
    try {
      server = await listen(port);
    } catch {
      throw new Error('Port ' + port + ' is busy. Free it or change the redirect URI.');
    }
  } else {
    const picked = await pickPort();
    server = picked.server;
    redirectUri = 'http://127.0.0.1:' + picked.port + CALLBACK_PATH;
    client = await registerClient({
      registrationEndpoint: meta.registrationEndpoint,
      redirectUri,
      pat: opts.pat,
      clientName: opts.clientName,
    });
  }
  const cbPath = new URL(redirectUri).pathname;
  const { verifier, challenge: codeChallenge } = pkce();
  const state = crypto.randomBytes(16).toString('hex');
  const waiting = waitForCode(server, state, cbPath);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: client.clientId,
    redirect_uri: redirectUri,
    scope: meta.scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  const authUrl = meta.authorizationEndpoint + '?' + params.toString();
  try {
    await opts.openUrl(authUrl);
  } catch (e) {
    try { server.close(); } catch {}
    waiting.catch(() => {});
    throw e;
  }
  const code = await waiting;
  const fields = {
    grant_type: 'authorization_code',
    client_id: client.clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  };
  const tok = await exchange(meta.tokenEndpoint, fields, client);
  if (!tok || !tok.access_token) throw new Error('The token exchange returned no access token.');
  return {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token || '',
    expiresAt: Date.now() + (Number(tok.expires_in) || 3600) * 1000,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    tokenEndpoint: meta.tokenEndpoint,
    redirectUri,
    scope: meta.scope,
  };
}

async function refresh({ token }) {
  if (!token || !token.refreshToken || !token.tokenEndpoint) return null;
  const fields = {
    grant_type: 'refresh_token',
    client_id: token.clientId,
    refresh_token: token.refreshToken,
  };
  const tok = await exchange(token.tokenEndpoint, fields, {
    clientId: token.clientId,
    clientSecret: token.clientSecret,
  });
  if (!tok || !tok.access_token) return null;
  return {
    ...token,
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token || token.refreshToken,
    expiresAt: Date.now() + (Number(tok.expires_in) || 3600) * 1000,
  };
}

async function ensureToken(opts) {
  const { token } = opts;
  if (token && token.accessToken && token.expiresAt && token.expiresAt - 60000 > Date.now()) return token;
  if (token && token.refreshToken && token.tokenEndpoint) {
    try { return await refresh({ token }); } catch {}
  }
  return authorize(opts);
}

module.exports = {
  discover, registerClient, authorize, refresh, ensureToken,
  pkce, parseChallenge, CALLBACK_PATH,
};
