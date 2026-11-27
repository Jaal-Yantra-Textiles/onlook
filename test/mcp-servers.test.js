'use strict';
/* connector configs: node test/mcp-servers.test.js */
const assert = require('node:assert');
const { cleanServers, normalizeMcp, DEFAULT_FIGMA, FIGMA_REMOTE } = require('../main/mcp-servers');

// legacy single-Figma shape migrates
const old = normalizeMcp({ figma: { url: 'http://localhost:9999/mcp', enabled: true } });
assert.equal(old.servers.length, 1);
assert.equal(old.servers[0].id, 'figma');
assert.equal(old.servers[0].url, 'http://localhost:9999/mcp');
assert.equal(old.servers[0].enabled, true);
assert.equal(old.servers[0].transport, 'http');

// defaults
assert.equal(normalizeMcp(null).servers[0].url, DEFAULT_FIGMA.url);
assert.equal(normalizeMcp({}).servers[0].enabled, false);
assert.equal(normalizeMcp(null).useTools, true);
assert.equal(normalizeMcp({ useTools: false }).useTools, false);
assert.equal(normalizeMcp({ useTools: false, servers: [] }).useTools, false);

// cleaning
const list = cleanServers([
  { id: 'My Server!!', name: '  ', transport: 'weird', args: 'a b  c', enabled: 1 },
  { id: 'my-server-', name: 'Second', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'] },
  { id: 'my-server-', name: 'Dup' },
  null,
  'nope',
]);
assert.equal(list.length, 3);
assert.equal(list[0].id, 'my-server');
assert.equal(list[0].name, 'Connector 1');
assert.equal(list[0].transport, 'http');
assert.deepEqual(list[0].args, ['a', 'b', 'c']);
assert.equal(list[0].enabled, true);
assert.equal(list[1].transport, 'stdio');
assert.equal(list[1].command, 'npx');
assert.deepEqual(list[1].args, ['-y', 'pkg']);
assert.equal(list[2].id, 'my-server-3');

// cap
const many = cleanServers(Array.from({ length: 30 }, (_, i) => ({ id: 's' + i, name: 'S' + i })));
assert.equal(many.length, 20);

// existing array is preserved
const arr = normalizeMcp({ servers: [{ id: 'x', name: 'X', url: 'http://x', enabled: true }] });
assert.equal(arr.servers.length, 1);
assert.equal(arr.servers[0].id, 'x');

// oauth: hosted Figma auto-enables, PAT persists, tokens survive normalization
const fig = cleanServers([{ id: 'figma-remote', name: 'Figma', url: 'https://mcp.figma.com/mcp', pat: 'figd_x' }]);
assert.equal(fig[0].oauth, true);
assert.equal(fig[0].pat, 'figd_x');
assert.equal(cleanServers([{ url: 'http://127.0.0.1:3845/mcp' }])[0].oauth, false);
const norm = normalizeMcp({ oauthTokens: { figma: { accessToken: 'at' } }, servers: [] });
assert.equal(norm.oauthTokens.figma.accessToken, 'at');
assert.deepEqual(normalizeMcp(null).oauthTokens, {});
const pre = cleanServers([{ id: 'figma', name: 'Figma', url: 'https://mcp.figma.com/mcp', clientId: 'cid', clientSecret: 'cs', redirectUri: 'http://127.0.0.1:19876/mcp/oauth/callback', token: 'tok' }])[0];
assert.equal(pre.clientId, 'cid');
assert.equal(pre.clientSecret, 'cs');
assert.equal(pre.redirectUri, 'http://127.0.0.1:19876/mcp/oauth/callback');
assert.equal(pre.token, 'tok');
const hosted = cleanServers([{ url: 'https://mcp.figma.com/mcp' }])[0];
assert.equal(hosted.oauth, true);
assert.equal(hosted.clientId, FIGMA_REMOTE.clientId);
assert.equal(hosted.clientSecret, FIGMA_REMOTE.clientSecret);
assert.equal(hosted.redirectUri, FIGMA_REMOTE.redirectUri);

console.log('MCP_SERVERS_PASS');
