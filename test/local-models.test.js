'use strict';
/* local model discovery: node test/local-models.test.js */
const http = require('node:http');
const assert = require('node:assert');
const { listModels } = require('../main/local-models');

const server = http.createServer((req, res) => {
  if (req.url === '/v1/models') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'llama3.2:latest' }, { id: 'qwen2.5-coder:7b' }] }));
    return;
  }
  if (req.url === '/alt/models') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ models: [{ name: 'phi4' }, 'mistral-small'] }));
    return;
  }
  if (req.url === '/broken/models') {
    res.setHeader('content-type', 'application/json');
    res.end('{not json');
    return;
  }
  res.statusCode = 404;
  res.end('nope');
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const openai = await listModels(`${base}/v1`);
    assert.equal(openai.ok, true);
    assert.deepEqual(openai.models, ['llama3.2:latest', 'qwen2.5-coder:7b']);
    assert.equal(openai.base, `${base}/v1`); // trailing slash trimmed

    const alt = await listModels(`${base}/alt/`);
    assert.deepEqual(alt.models, ['phi4', 'mistral-small']);

    const broken = await listModels(`${base}/broken`);
    assert.equal(broken.ok, true);
    assert.deepEqual(broken.models, []); // unparseable body → connected, no models

    const missing = await listModels(`${base}/nope`);
    assert.equal(missing.ok, false);
    assert.match(missing.error, /HTTP 404/);

    const bad = await listModels('not a url');
    assert.equal(bad.ok, false);
    assert.match(bad.error, /http\(s\) base URL/);

    const refused = await listModels('http://127.0.0.1:1/v1', { timeout: 1500 });
    assert.equal(refused.ok, false);
    assert.ok(refused.error);

    console.log('LOCAL_MODELS_PASS');
    server.close();
  } catch (e) {
    console.error('LOCAL_MODELS_FAIL ' + (e && e.message));
    server.close();
    process.exit(1);
  }
})();
