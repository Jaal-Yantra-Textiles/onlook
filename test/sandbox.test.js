'use strict';
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
/* node test/sandbox.test.js */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sb = require('../main/sandbox');

const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-sb-'));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'app.txt'), 'v1\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n.env*\n');
  git(repo, 'init', '-q');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  // user's uncommitted work + an untracked file + a secret env file
  fs.writeFileSync(path.join(repo, 'app.txt'), 'v2 (user dirty)\n');
  fs.writeFileSync(path.join(repo, 'new-user.txt'), 'user file\n');
  fs.writeFileSync(path.join(repo, '.env.local'), 'SECRET=1\n');

  const s = await sb.createSandbox({ folder: repo, baseDir: path.join(base, 'sandboxes') });
  const checks = {};
  checks.worktree = s.ok && s.mode === 'worktree' && fs.existsSync(s.root);
  checks.mirrorsDirty = fs.readFileSync(path.join(s.projectPath, 'app.txt'), 'utf8').includes('v2 (user dirty)');
  checks.mirrorsUntracked = fs.existsSync(path.join(s.projectPath, 'new-user.txt'));
  checks.envCopied = fs.existsSync(path.join(s.projectPath, '.env.local'));
  checks.envNotCommitted = !git(s.root, 'ls-files', '.env.local').stdout.trim();
  checks.baseClean = !sb.isDirtySync(s); // env files are ignored, so the base is clean

  // agent edits in the sandbox
  fs.writeFileSync(path.join(s.projectPath, 'app.txt'), 'v3 (agent)\n');
  fs.writeFileSync(path.join(s.projectPath, 'agent-new.txt'), 'agent file\n');
  checks.dirty = sb.isDirtySync(s);
  checks.isolated = fs.readFileSync(path.join(repo, 'app.txt'), 'utf8').includes('v2 (user dirty)') &&
    !fs.existsSync(path.join(repo, 'agent-new.txt'));

  const ap = await sb.applySandbox(s);
  if (!ap.ok) console.log('APPLY_DEBUG ' + JSON.stringify(ap));
  checks.apply = ap.ok && ap.files >= 1;
  checks.appliedTracked = fs.readFileSync(path.join(repo, 'app.txt'), 'utf8').includes('v3 (agent)');
  checks.appliedNew = fs.existsSync(path.join(repo, 'agent-new.txt'));
  checks.userUntrackedKept = fs.existsSync(path.join(repo, 'new-user.txt'));

  const d = sb.discardSandbox(s);
  checks.discard = d.ok && !fs.existsSync(s.root);
  checks.branchGone = !git(repo, 'branch', '--list', s.branch).stdout.trim();

  // non-git copy fallback
  const plain = path.join(base, 'plain');
  fs.mkdirSync(plain);
  fs.writeFileSync(path.join(plain, 'index.txt'), 'plain v1\n');
  const c = await sb.createSandbox({ folder: plain, baseDir: path.join(base, 'sandboxes') });
  checks.copyMode = c.ok && c.mode === 'copy';
  fs.writeFileSync(path.join(c.projectPath, 'index.txt'), 'plain v2\n');
  checks.copyIsolated = fs.readFileSync(path.join(plain, 'index.txt'), 'utf8').includes('v1');
  const cap = await sb.applySandbox(c);
  checks.copyApply = cap.ok && fs.readFileSync(path.join(plain, 'index.txt'), 'utf8').includes('v2');
  sb.discardSandbox(c);

  // cleanup: clean sandbox removed, dirty sandbox kept
  const cleanRepo = path.join(base, 'clean');
  fs.mkdirSync(cleanRepo);
  fs.writeFileSync(path.join(cleanRepo, 'x.txt'), 'x\n');
  git(cleanRepo, 'init', '-q');
  git(cleanRepo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
  git(cleanRepo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  const cs = await sb.createSandbox({ folder: cleanRepo, baseDir: path.join(base, 'sandboxes') });
  const q1 = sb.cleanupOnQuit(cs);
  checks.cleanRemoved = q1.removed === true && !fs.existsSync(cs.root);
  const ds = await sb.createSandbox({ folder: cleanRepo, baseDir: path.join(base, 'sandboxes') });
  fs.writeFileSync(path.join(ds.projectPath, 'x.txt'), 'dirty\n');
  const q2 = sb.cleanupOnQuit(ds);
  checks.dirtyKept = q2.removed === false && fs.existsSync(ds.root);
  sb.discardSandbox(ds);

  fs.rmSync(base, { recursive: true, force: true });
  const bad = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  console.log(bad.length ? 'SANDBOX_FAIL ' + bad.join(',') + ' ' + JSON.stringify(checks) : 'SANDBOX_PASS');
  process.exit(bad.length ? 1 : 0);
})();
