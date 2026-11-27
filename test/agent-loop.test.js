'use strict';
/* tool-calling loop: node test/agent-loop.test.js */
const assert = require('node:assert');
const { runToolLoop } = require('../main/agent-loop');

const TOOLS = [{ type: 'function', function: { name: 'fake__echo', parameters: { type: 'object' } } }];

(async () => {
  try {
    // one tool round, then a final answer
    const messages = [{ role: 'user', content: 'use the tool' }];
    const seen = [];
    const sent = [];
    let calls = 0;
    const request = async (conv, tools) => {
      seen.push({ length: conv.length, tools: tools.length });
      calls++;
      if (calls === 1) return { text: 'checking', calls: [{ id: 'c1', name: 'fake__echo', args: '{"text":"hi"}' }] };
      return { text: 'done', calls: [] };
    };
    const callTool = async (name, args) => ({ text: 'echo:' + JSON.parse(args).text });
    await runToolLoop({ messages, tools: TOOLS, request, callTool, send: (k, d) => sent.push(k + ':' + d) });

    assert.equal(calls, 2);
    assert.equal(seen[0].tools, 1);
    assert.equal(seen[1].tools, 1);
    assert.equal(seen[1].length, 3); // user + assistant + tool
    assert.equal(messages.length, 3);
    assert.equal(messages[1].role, 'assistant');
    assert.equal(messages[1].content, 'checking');
    assert.equal(messages[1].tool_calls[0].id, 'c1');
    assert.equal(messages[2].role, 'tool');
    assert.equal(messages[2].tool_call_id, 'c1');
    assert.equal(messages[2].content, 'echo:hi');
    assert.ok(sent.some((s) => s.startsWith('tool:fake__echo')));

    // no tools → single request, no tool messages
    const plain = [{ role: 'user', content: 'hi' }];
    let plainCalls = 0;
    await runToolLoop({ messages: plain, tools: [], request: async () => { plainCalls++; return { text: 'ok', calls: [] }; }, callTool: async () => ({ text: '' }) });
    assert.equal(plainCalls, 1);
    assert.equal(plain.length, 1);

    // tool failure becomes a tool message, not a crash
    const fail = [{ role: 'user', content: 'x' }];
    let n = 0;
    await runToolLoop({
      messages: fail,
      tools: TOOLS,
      request: async () => { n++; return n === 1 ? { text: '', calls: [{ id: 'c2', name: 'fake__echo', args: '{}' }] } : { text: '', calls: [] }; },
      callTool: async () => { throw new Error('boom'); },
    });
    assert.match(fail[2].content, /Tool error: boom/);

    // image results call onImage
    const img = [];
    const imgs = [{ role: 'user', content: 'x' }];
    let m = 0;
    await runToolLoop({
      messages: imgs,
      tools: TOOLS,
      request: async () => { m++; return m === 1 ? { text: '', calls: [{ id: 'c3', name: 'fake__echo', args: '{}' }] } : { text: '', calls: [] }; },
      callTool: async () => ({ text: 'shot', image: { mimeType: 'image/png', data: 'AAAA' } }),
      onImage: (i) => img.push(i),
    });
    assert.equal(img.length, 1);
    assert.equal(img[0].data, 'AAAA');

    // max steps
    const cap = [{ role: 'user', content: 'x' }];
    const notes = [];
    await runToolLoop({
      messages: cap,
      tools: TOOLS,
      maxSteps: 3,
      request: async () => ({ text: '', calls: [{ id: 'c4', name: 'fake__echo', args: '{}' }] }),
      callTool: async () => ({ text: 'again' }),
      send: (k, d) => notes.push(d),
    });
    assert.ok(notes.some((n) => /stopped after 3 tool rounds/.test(n)));
    assert.equal(cap.filter((x) => x.role === 'tool').length, 3);

    console.log('AGENT_LOOP_PASS');
  } catch (e) {
    console.error('AGENT_LOOP_FAIL ' + (e && e.message));
    process.exit(1);
  }
})();
