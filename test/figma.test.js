'use strict';
/* Figma URL parsing + MCP tool mapping: node test/figma.test.js */
const assert = require('node:assert');
const { parseFigmaUrl, importFigma } = require('../main/figma');

function fakeClient(overrides = {}) {
  const calls = [];
  return {
    calls,
    tools: overrides.tools || [
      { name: 'get_code' }, { name: 'get_variable_defs' }, { name: 'get_screenshot' },
    ],
    async listTools() { return this.tools; },
    async callTool(name, args) {
      calls.push({ name, args });
      if (overrides[name]) return overrides[name](args);
      if (name === 'get_code' || name === 'get_design_context') return { content: [{ type: 'text', text: 'export function Hero() {}' }] };
      if (name === 'get_variable_defs') return { content: [{ type: 'text', text: '--brand: #6ea8ff' }] };
      if (name === 'get_screenshot') return { content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }] };
      return { content: [] };
    },
  };
}

(async () => {
  try {
    // ---- URL parsing ----
    const url = 'https://www.figma.com/design/abc123/My-File?node-id=12-345&t=x';
    assert.deepEqual(parseFigmaUrl(url), { ok: true, nodeId: '12:345', fileKey: 'abc123', url });
    assert.equal(parseFigmaUrl('12-345').nodeId, '12:345');
    assert.equal(parseFigmaUrl('12:345').nodeId, '12:345');
    assert.equal(parseFigmaUrl('https://www.figma.com/file/abc/Name?node-id=1-2').nodeId, '1:2');
    assert.equal(parseFigmaUrl('').ok, false);
    assert.match(parseFigmaUrl('https://example.com/x?node-id=1-2').error, /figma\.com/);
    assert.match(parseFigmaUrl('https://www.figma.com/design/abc/Name').error, /node-id/);
    assert.match(parseFigmaUrl('https://www.figma.com/design/abc/Name?node-id=x').error, /node-id/);

    // ---- import: all three tools ----
    const c = fakeClient();
    const r = await importFigma(c, url);
    assert.equal(r.ok, true);
    assert.equal(r.nodeId, '12:345');
    assert.match(r.code, /Hero/);
    assert.match(r.variables, /brand/);
    assert.equal(r.image.data, 'AAAA');
    assert.deepEqual(c.calls.map((x) => x.name), ['get_code', 'get_variable_defs', 'get_screenshot']);
    assert.equal(c.calls[0].args.nodeId, '12:345');
    assert.equal(c.calls[0].args.clientFrameworks, 'react');
    assert.equal(c.calls[2].args.enableBase64Response, true);

    // ---- remote server: get_design_context instead of get_code ----
    const remote = fakeClient({ tools: [{ name: 'get_design_context' }, { name: 'get_variable_defs' }, { name: 'get_screenshot' }] });
    const r5 = await importFigma(remote, url);
    assert.equal(r5.ok, true);
    assert.match(r5.code, /Hero/);
    assert.ok(r5.tools.includes('get_design_context'));
    assert.equal(remote.calls[0].name, 'get_design_context');
    assert.equal(remote.calls[0].args.fileKey, 'abc123');

    // ---- only code available ----
    const codeOnly = fakeClient({ tools: [{ name: 'get_code' }] });
    const r2 = await importFigma(codeOnly, '1-2');
    assert.equal(r2.ok, true);
    assert.ok(r2.code);
    assert.equal(r2.image, null);

    // ---- a failing screenshot must not lose the code ----
    const flaky = fakeClient({ get_screenshot: () => { throw new Error('not selected'); } });
    const r3 = await importFigma(flaky, url);
    assert.equal(r3.ok, true);
    assert.match(r3.code, /Hero/);
    assert.ok(r3.tools.some((t) => /get_screenshot \(failed/.test(t)));

    // ---- no useful tools ----
    const empty = fakeClient({ tools: [{ name: 'something_else' }] });
    const r4 = await importFigma(empty, url);
    assert.equal(r4.ok, false);

    console.log('FIGMA_PASS');
  } catch (e) {
    console.error('FIGMA_FAIL ' + (e && e.message));
    process.exit(1);
  }
})();
