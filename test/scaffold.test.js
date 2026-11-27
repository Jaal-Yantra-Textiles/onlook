'use strict';
/* project scaffolding: node test/scaffold.test.js */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { TEMPLATES, plan, commandFor, writePlainHtml } = require('../main/scaffold');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-scaffold-'));
const parent = path.join(root, 'projects');
fs.mkdirSync(parent, { recursive: true });

try {
  // catalog
  const ids = TEMPLATES.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ['next', 'vite-react', 'vite-vue', 'vite-svelte', 'astro', 'html', 'github', 'custom']) {
    assert.ok(ids.includes(id), `missing template ${id}`);
  }

  // commands
  const next = plan({ template: 'next', parent, name: 'my-app' });
  assert.equal(next.ok, true);
  assert.equal(next.cmd, 'npx');
  assert.ok(next.args.includes('create-next-app@latest'));
  assert.equal(next.folder, path.join(parent, 'my-app'));
  assert.ok(next.label.includes('create-next-app'));

  assert.deepEqual(commandFor('vite-react', 'x').args.slice(-2), ['--template', 'react-ts']);
  assert.deepEqual(commandFor('vite-vue', 'x').args.slice(-2), ['--template', 'vue-ts']);
  assert.deepEqual(commandFor('vite-svelte', 'x').args.slice(-2), ['--template', 'svelte-ts']);
  assert.ok(commandFor('astro', 'x').args.includes('--template'));

  // plain HTML
  const html = plan({ template: 'html', parent, name: 'site' });
  assert.equal(html.kind, 'html');

  // GitHub clone
  const noRepo = plan({ template: 'github', parent, name: 'clone' });
  assert.equal(noRepo.ok, false);
  assert.match(noRepo.error, /repository URL/);
  const clone = plan({ template: 'github', parent, name: 'clone', repo: 'https://github.com/owner/repo', branch: 'dev' });
  assert.equal(clone.cmd, 'git');
  assert.deepEqual(clone.args.slice(0, 5), ['clone', '--depth', '1', '--branch', 'dev']);
  assert.equal(clone.cwd, parent);

  // custom command
  assert.equal(plan({ template: 'custom', parent, name: 'custom' }).ok, false);
  const custom = plan({ template: 'custom', parent, name: 'custom', command: 'npm create vite@latest . -- --template react-ts' });
  assert.equal(custom.shell, true);
  assert.equal(custom.cwd, path.join(parent, 'custom'));
  assert.equal(custom.mkdir, true);

  // validation
  assert.equal(plan({ template: 'next', parent: '/does/not/exist', name: 'x' }).ok, false);
  assert.equal(plan({ template: 'next', parent, name: 'bad name!' }).ok, false);
  fs.mkdirSync(path.join(parent, 'taken'));
  assert.match(plan({ template: 'next', parent, name: 'taken' }).error, /already exists/);

  // plain HTML writer
  const site = path.join(parent, 'site');
  const w = writePlainHtml(site, 'site');
  assert.equal(w.ok, true);
  for (const f of ['index.html', 'about.html', 'styles.css', 'main.js', 'README.md']) {
    assert.ok(fs.existsSync(path.join(site, f)), `missing ${f}`);
  }
  assert.match(fs.readFileSync(path.join(site, 'index.html'), 'utf8'), /Your new site is live/);
  assert.match(fs.readFileSync(path.join(site, 'about.html'), 'utf8'), /About/);
  const git = spawnSync('git', ['-C', site, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
  assert.equal(git.status, 0, 'plain HTML project should be a git repo');
  assert.ok(git.stdout.trim().length > 0, 'a branch should exist');
  const status = spawnSync('git', ['-C', site, 'status', '--porcelain'], { encoding: 'utf8' });
  assert.equal(status.stdout.trim(), '', 'initial commit should leave a clean tree');

  console.log('SCAFFOLD_PASS');
  fs.rmSync(root, { recursive: true, force: true });
} catch (e) {
  console.error('SCAFFOLD_FAIL ' + (e && e.message));
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(1);
}
