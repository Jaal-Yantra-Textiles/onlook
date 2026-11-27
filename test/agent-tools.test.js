'use strict';
/* tool exposure + streaming accumulation: node test/agent-tools.test.js */
const assert = require('node:assert');
const { exposeTools, accumulateToolCalls, finalizeToolCalls, MAX_TOOLS } = require('../main/agent-tools');

// ---- exposure ----
const { tools, map } = exposeTools([
  { id: 'figma', name: 'Figma', tools: [
    { name: 'get_code', description: 'Get code', inputSchema: { type: 'object', properties: { nodeId: { type: 'string' } } } },
    { name: 'get_screenshot', description: 'Shot' },
  ] },
  { id: 'files', name: 'Files', tools: [
    { name: 'read_file', description: 'Read' },
    { name: 'get_code', description: 'duplicate name, different server' },
  ] },
]);
assert.equal(tools.length, 4);
assert.equal(tools[0].function.name, 'figma__get_code');
assert.equal(tools[0].function.description, '[Figma] Get code');
assert.deepEqual(tools[0].function.parameters, { type: 'object', properties: { nodeId: { type: 'string' } } });
assert.deepEqual(tools[1].function.parameters, { type: 'object', properties: {} });
assert.equal(tools[3].function.name, 'files__get_code');
assert.deepEqual(map.get('figma__get_code'), { serverId: 'figma', tool: 'get_code' });
assert.deepEqual(map.get('files__get_code'), { serverId: 'files', tool: 'get_code' });

// weird names are sanitized and capped
const odd = exposeTools([{ id: 'my server!', name: 'S', tools: [{ name: 'do.thing/now' }] }]);
assert.match(odd.tools[0].function.name, /^my_server___do_thing_now$/);
assert.ok(odd.tools[0].function.name.length <= 64);

// cap
const many = exposeTools([{ id: 's', name: 'S', tools: Array.from({ length: 60 }, (_, i) => ({ name: 't' + i })) }]);
assert.equal(many.tools.length, MAX_TOOLS);

// ---- accumulation ----
const calls = new Map();
accumulateToolCalls(calls, [{ index: 0, id: 'c1', function: { name: 'figma__get_code', arguments: '{"nodeId":' } }]);
accumulateToolCalls(calls, [{ index: 0, function: { arguments: '"1:2"}' } }]);
assert.equal(calls.get(0).args, '{"nodeId":"1:2"}');
assert.equal(calls.get(0).name, 'figma__get_code');

// Cloudflare flat shape + object arguments
const flat = new Map();
accumulateToolCalls(flat, [{ name: 'echo', arguments: { text: 'hi' } }]);
assert.equal(flat.get(0).args, '{"text":"hi"}');

// finalize
const fin = finalizeToolCalls(calls);
assert.equal(fin.length, 1);
assert.equal(fin[0].id, 'c1');
assert.equal(fin[0].args, '{"nodeId":"1:2"}');
assert.equal(finalizeToolCalls(new Map([[0, { name: '' }]])).length, 0);
assert.ok(/^call_/.test(finalizeToolCalls(new Map([[0, { name: 'x' }]]))[0].id));

console.log('AGENT_TOOLS_PASS');
