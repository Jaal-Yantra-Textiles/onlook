'use strict';
/* withlook sandbox — agent edits run in an isolated git worktree (or a copy), never in the user's folder */
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const SKIP = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'out', '.turbo', '.vercel', '.cache', 'withlook-references']);
const ENV_RE = /^\.env(\..+)?$/;
const MAX_UNTRACKED = 500;

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', error: err });
    });
  });
}
function runSync(cmd, args, opts = {}) {
  const r = require('node:child_process').spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  return { ok: !r.error && r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
}
const slug = (s) => String(s || 'project').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'project';

function copyEnv(srcDir, destDir) {
  try {
    for (const name of fs.readdirSync(srcDir)) {
      if (!ENV_RE.test(name)) continue;
      const src = path.join(srcDir, name);
      const dest = path.join(destDir, name);
      try { if (fs.statSync(src).isFile()) fs.copyFileSync(src, dest); } catch {}
    }
  } catch {}
}
function linkNodeModules(srcDir, destDir) {
  const src = path.join(srcDir, 'node_modules');
  const dest = path.join(destDir, 'node_modules');
  try {
    if (!fs.existsSync(src) || fs.existsSync(dest)) return;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // junctions work on Windows without Developer Mode; dir symlinks elsewhere
    fs.symlinkSync(src, dest, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {}
}
function statusEntries(gitDir) {
  const st = runSync('git', ['-C', gitDir, 'status', '--porcelain=v1', '-z']);
  if (!st.ok) return [];
  const out = [];
  const parts = st.stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    const status = part.slice(0, 2);
    const file = part.slice(3);
    if (status[0] === 'R' || status[0] === 'C') i++; // skip rename origin
    if (!file) continue;
    if (status === '??' && ENV_RE.test(path.basename(file))) continue; // secrets stay out of reports/cleanup
    if (file.split('/').includes('withlook-references')) continue; // agent-only reference copies
    out.push({ status, file });
  }
  return out;
}
function untrackedFiles(gitDir) {
  return statusEntries(gitDir).filter((e) => e.status === '??').map((e) => e.file).slice(0, MAX_UNTRACKED);
}
function copyUntracked(fromRoot, toRoot, files) {
  let copied = 0;
  for (const rel of files) {
    if (rel.split('/').some((seg) => SKIP.has(seg))) continue;
    const src = path.join(fromRoot, rel);
    const dest = path.join(toRoot, rel);
    try {
      if (!fs.statSync(src).isFile()) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      copied++;
    } catch {}
  }
  return copied;
}

async function createSandbox({ folder, baseDir }) {
  const id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  fs.mkdirSync(baseDir, { recursive: true });

  const top = await run('git', ['-C', folder, 'rev-parse', '--show-toplevel']);
  const head = top.ok ? await run('git', ['-C', folder, 'rev-parse', '--verify', 'HEAD']) : { ok: false };
  if (top.ok && head.ok) {
    const repoRoot = top.stdout.trim();
    const prefixOut = await run('git', ['-C', folder, 'rev-parse', '--show-prefix']);
    const prefix = prefixOut.ok ? prefixOut.stdout.trim() : '';
    const root = path.join(baseDir, `${slug(path.basename(folder))}-${id}`);
    const branch = `withlook/sandbox-${id}`;
    const add = await run('git', ['-C', repoRoot, 'worktree', 'add', '-b', branch, root, 'HEAD']);
    if (add.ok) {
      // mirror the user's uncommitted tracked changes into the worktree
      const diff = await run('git', ['-C', repoRoot, 'diff', 'HEAD', '--binary']);
      let appliedPatch = false;
      if (diff.ok && diff.stdout.trim()) {
        const patchFile = path.join(baseDir, `.patch-${id}`);
        try {
          fs.writeFileSync(patchFile, diff.stdout);
          const ap = await run('git', ['-C', root, 'apply', '--binary', '--whitespace=nowarn', patchFile]);
          appliedPatch = ap.ok;
        } finally { try { fs.rmSync(patchFile, { force: true }); } catch {} }
      }
      // untracked files (env files, new components) are not in HEAD — env files are copied after the base commit
      copyUntracked(repoRoot, root, untrackedFiles(repoRoot).filter((f) => !ENV_RE.test(path.basename(f))));
      linkNodeModules(repoRoot, root);
      const projectPath = prefix ? path.join(root, prefix) : root;
      if (prefix) linkNodeModules(folder, projectPath);
      // snapshot the user's current working tree as the sandbox base, so later
      // `git diff HEAD` contains ONLY the agent's edits (not the user's dirty files)
      const addAll = await run('git', ['-C', root, 'add', '-A']);
      const base = addAll.ok
        ? await run('git', ['-C', root, '-c', 'user.email=withlook@local', '-c', 'user.name=withlook',
          'commit', '--no-verify', '--allow-empty', '-m', 'withlook sandbox base'])
        : { ok: false };
      if (!base.ok) {
        // without a base commit we can't compute a clean agent-only diff — use a copy instead
        try { runSync('git', ['-C', repoRoot, 'worktree', 'remove', '--force', root]); } catch {}
        runSync('git', ['-C', repoRoot, 'branch', '-D', branch]);
      } else {
        copyEnv(repoRoot, root);
        if (prefix) copyEnv(folder, projectPath);
        return {
          ok: true, mode: 'worktree', root, repoRoot, projectPath, folder, branch, id,
          appliedPatch, prefix, base: 'HEAD',
        };
      }
    }
    // fall through to a copy if the worktree can't be created
  }

  const dest = path.join(baseDir, `${slug(path.basename(folder))}-${id}`);
  fs.mkdirSync(dest, { recursive: true });
  try {
    fs.cpSync(folder, dest, {
      recursive: true,
      filter: (src) => !SKIP.has(path.basename(src)),
    });
  } catch (e) {
    return { ok: false, error: 'Could not copy the project: ' + e.message };
  }
  linkNodeModules(folder, dest);
  copyEnv(folder, dest);
  return { ok: true, mode: 'copy', root: dest, projectPath: dest, folder, id };
}

async function applySandbox(sb) {
  if (!sb) return { ok: false, error: 'No sandbox.' };
  if (sb.mode === 'worktree') {
    const diff = await run('git', ['-C', sb.root, 'diff', 'HEAD', '--binary']);
    if (!diff.ok) return { ok: false, error: diff.stderr || 'git diff failed' };
    const patch = diff.stdout;
    let applied = 0;
    if (patch.trim()) {
      const patchFile = path.join(path.dirname(sb.root), `.apply-${sb.id}`);
      try {
        fs.writeFileSync(patchFile, patch);
        const check = await run('git', ['-C', sb.repoRoot, 'apply', '--check', patchFile]);
        if (!check.ok) {
          return { ok: false, error: 'The project changed since the sandbox was created — apply conflicts.\n' + (check.stderr || '').slice(0, 500) };
        }
        const ap = await run('git', ['-C', sb.repoRoot, 'apply', patchFile]);
        if (!ap.ok) return { ok: false, error: (ap.stderr || 'git apply failed').slice(0, 500) };
        applied = patch.split('\n').filter((l) => l.startsWith('diff --git')).length;
      } finally { try { fs.rmSync(patchFile, { force: true }); } catch {} }
    }
    // untracked files created in the sandbox
    let copied = 0;
    const conflicts = [];
    for (const rel of untrackedFiles(sb.root)) {
      if (rel.split('/').some((seg) => SKIP.has(seg))) continue;
      if (ENV_RE.test(path.basename(rel))) continue; // never overwrite env files on apply
      const src = path.join(sb.root, rel);
      const dest = path.join(sb.repoRoot, rel);
      try {
        if (!fs.statSync(src).isFile()) continue;
        if (fs.existsSync(dest)) {
          const a = fs.readFileSync(src);
          const b = fs.readFileSync(dest);
          if (!a.equals(b)) { conflicts.push(rel); continue; }
          continue;
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
        copied++;
      } catch {}
    }
    return { ok: true, applied, copied, conflicts, files: applied + copied };
  }

  // copy mode: copy files that differ (additions + modifications); never delete
  let copied = 0;
  const walk = (dir, rel = '') => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (SKIP.has(ent.name)) continue;
      if (ENV_RE.test(ent.name)) continue;
      const r = rel ? path.join(rel, ent.name) : ent.name;
      if (ent.isDirectory()) { walk(path.join(dir, ent.name), r); continue; }
      if (!ent.isFile()) continue;
      const src = path.join(dir, ent.name);
      const dest = path.join(sb.folder, r);
      try {
        const a = fs.readFileSync(src);
        const b = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
        if (b && a.equals(b)) continue;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
        copied++;
      } catch {}
    }
  };
  walk(sb.root);
  return { ok: true, applied: 0, copied, conflicts: [], files: copied };
}

function isDirtySync(sb) {
  if (!sb) return false;
  if (sb.mode !== 'worktree') return true; // copies are kept unless discarded explicitly
  return statusEntries(sb.root).length > 0;
}
async function isDirty(sb) {
  return isDirtySync(sb);
}

function discardSandbox(sb) {
  if (!sb) return { ok: true };
  try {
    if (sb.mode === 'worktree') {
      const rm = runSync('git', ['-C', sb.repoRoot, 'worktree', 'remove', '--force', sb.root]);
      if (!rm.ok) { try { fs.rmSync(sb.root, { recursive: true, force: true }); } catch {} }
      runSync('git', ['-C', sb.repoRoot, 'worktree', 'prune']);
      if (sb.branch) runSync('git', ['-C', sb.repoRoot, 'branch', '-D', sb.branch]);
    } else {
      fs.rmSync(sb.root, { recursive: true, force: true });
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

function cleanupOnQuit(sb) {
  if (!sb) return { removed: false };
  if (isDirtySync(sb)) return { removed: false, kept: true, path: sb.root };
  discardSandbox(sb);
  return { removed: true };
}

module.exports = {
  createSandbox, applySandbox, discardSandbox, cleanupOnQuit, isDirty, isDirtySync,
  untrackedFiles, SKIP,
};
