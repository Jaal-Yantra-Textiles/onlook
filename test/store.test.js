'use strict';
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
/* node test/store.test.js — exercises MemoryStore against the local docker Postgres */
const os = require('node:os');
const path = require('node:path');
const { MemoryStore } = require('../main/store');

(async () => {
  const store = new MemoryStore(path.join(os.tmpdir(), 'wl-store-test'));
  const init = await store.init('postgres://postgres@localhost:5432/postgres');
  const checks = [];
  const check = (name, cond) => checks.push([name, !!cond]);

  check('postgres mode', init.mode === 'postgres');

  const folder = '/tmp/fake-project-' + Date.now();
  await store.upsertProject({ folder, name: 'fake-project', pm: 'npm', port: 3000 });
  const projects = await store.listProjects();
  check('project remembered', projects.some((p) => p.folder === folder));

  const { id } = await store.createSession(folder); // untitled — first user message names it
  await store.appendMessage({ sessionId: id, role: 'user', content: 'hello world', title: 'hello world' });
  await store.appendMessage({ sessionId: id, role: 'assistant', content: 'hi back', title: 'hello world' });
  await store.appendMessage({ sessionId: id, role: 'selection', content: JSON.stringify({ selector: '#a', tag: 'h1' }) });

  const latest = await store.latestSession(folder);
  check('latest session found', latest && latest.session.id === id);
  check('messages persisted', latest.messages.length === 3 && latest.messages[1].content === 'hi back');
  check('session title', latest.session.title === 'hello world');

  const listed = await store.listSessions();
  check('sessions listed', listed.some((s) => s.id === id && Number(s.messages) === 3));

  // a second project's chats must not appear in the first project's history
  const folderB = '/tmp/fake-project-B-' + Date.now();
  await store.upsertProject({ folder: folderB, name: 'fake-project-B', pm: 'npm', port: 3001 });
  const sb = await store.createSession(folderB);
  await store.appendMessage({ sessionId: sb.id, role: 'user', content: 'b msg', title: 'b chat' });
  const onlyA = await store.listSessions(folder);
  check('sessions filtered by project', onlyA.length === 1 && onlyA[0].id === id);
  const all = await store.listSessions();
  check('all sessions without filter', all.length >= 2 && all.some((s) => s.id === sb.id));

  // clean up the rows this test created in the real database
  try {
    const { Client } = require('pg');
    const c = new Client({ connectionString: 'postgres://postgres@localhost:5432/postgres' });
    await c.connect();
    await c.query(`DELETE FROM withlook.messages WHERE session_id IN (SELECT id FROM withlook.sessions WHERE project_id IN (SELECT id FROM withlook.projects WHERE folder LIKE '/tmp/fake-project-%'))`);
    await c.query(`DELETE FROM withlook.sessions WHERE project_id IN (SELECT id FROM withlook.projects WHERE folder LIKE '/tmp/fake-project-%')`);
    await c.query(`DELETE FROM withlook.projects WHERE folder LIKE '/tmp/fake-project-%'`);
    await c.end();
  } catch {}

  // fallback file mode
  const fileStore = new MemoryStore(path.join(os.tmpdir(), 'wl-store-test2'));
  const finit = await fileStore.init('');
  check('file fallback', finit.mode === 'file');
  await fileStore.upsertProject({ folder: '/tmp/x', name: 'x', pm: 'npm', port: 3000 });
  const fp = await fileStore.listProjects();
  check('file projects', fp.length === 1);

  const failed = checks.filter(([, ok]) => !ok);
  console.log(failed.length ? 'STORE_FAIL ' + failed.map((f) => f[0]).join(', ') : 'STORE_PASS (' + checks.length + ' checks)');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.log('STORE_FAIL ' + e.message); process.exit(1); });
