'use strict';
/* MCP connector configs — normalization shared by settings, the modal, and tests */
const DEFAULT_FIGMA = {
  id: 'figma',
  name: 'Figma',
  transport: 'http',
  url: 'http://127.0.0.1:3845/mcp',
  command: '',
  args: [],
  enabled: false,
};

// Figma remote OAuth is paused: Figma only grants mcp:connect to MCP-catalog clients.
// Keep the shape so the flow can be re-enabled once a client is approved.
const FIGMA_REMOTE = {
  clientId: '',
  clientSecret: '',
  redirectUri: 'http://127.0.0.1:19876/mcp/oauth/callback',
};

function cleanServers(list) {
  const out = [];
  const ids = new Set();
  (Array.isArray(list) ? list : []).slice(0, 20).forEach((s, i) => {
    if (!s || typeof s !== 'object') return;
    let id = String(s.id || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || `server-${i + 1}`;
    const base = id;
    let n = 2;
    while (ids.has(id)) id = `${base}-${n++}`;
    ids.add(id);
    const url = String(s.url || '').trim();
    let hosted = false;
    try { hosted = /(^|\.)mcp\.figma\.com$/i.test(new URL(url).hostname); } catch {}
    out.push({
      id,
      name: String(s.name || '').trim() || `Connector ${i + 1}`,
      transport: s.transport === 'stdio' ? 'stdio' : 'http',
      url: String(s.url || '').trim(),
      command: String(s.command || '').trim(),
      args: Array.isArray(s.args) ? s.args.map(String) : String(s.args || '').split(/\s+/).filter(Boolean),
      enabled: !!s.enabled,
      oauth: !!s.oauth || hosted,
      pat: String(s.pat || '').trim(),
      clientId: String(s.clientId || (hosted ? FIGMA_REMOTE.clientId : '') || '').trim(),
      clientSecret: String(s.clientSecret || (hosted ? FIGMA_REMOTE.clientSecret : '') || '').trim(),
      redirectUri: String(s.redirectUri || (hosted ? FIGMA_REMOTE.redirectUri : '') || '').trim(),
      token: String(s.token || '').trim(),
    });
  });
  return out;
}

// migrate the old single-Figma shape (`mcp.figma`) to the server list
function normalizeMcp(raw) {
  const useTools = !(raw && raw.useTools === false);
  const oauthTokens = (raw && raw.oauthTokens && typeof raw.oauthTokens === 'object') ? raw.oauthTokens : {};
  if (raw && Array.isArray(raw.servers)) return { useTools, oauthTokens, servers: cleanServers(raw.servers) };
  const fig = (raw && raw.figma) || {};
  return { useTools, oauthTokens, servers: cleanServers([{ ...DEFAULT_FIGMA, ...fig }]) };
}

module.exports = { cleanServers, normalizeMcp, DEFAULT_FIGMA, FIGMA_REMOTE };
