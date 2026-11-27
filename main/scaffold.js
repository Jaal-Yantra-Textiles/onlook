'use strict';
/* withlook project scaffolding — templates, GitHub boilerplates, plain HTML, custom commands */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TEMPLATES = [
  { id: 'next', label: 'Next.js', hint: 'App Router · TypeScript · Tailwind', kind: 'command' },
  { id: 'vite-react', label: 'Vite + React', hint: 'React 19 · TypeScript', kind: 'command' },
  { id: 'vite-vue', label: 'Vite + Vue', hint: 'Vue 3 · TypeScript', kind: 'command' },
  { id: 'vite-svelte', label: 'Vite + Svelte', hint: 'Svelte 5 · TypeScript', kind: 'command' },
  { id: 'astro', label: 'Astro', hint: 'Minimal · content-first', kind: 'command' },
  { id: 'html', label: 'Plain HTML', hint: 'No tooling · served locally', kind: 'html' },
  { id: 'github', label: 'GitHub repo', hint: 'Clone a boilerplate or starter', kind: 'clone' },
  { id: 'custom', label: 'Custom', hint: 'Run your own scaffold command', kind: 'custom' },
];

const byId = (id) => TEMPLATES.find((t) => t.id === id) || null;
const VALID_NAME = /^[a-zA-Z0-9][a-zA-Z0-9-_]*$/;
const VALID_BRANCH = /^[A-Za-z0-9._/-]+$/;

// the exact command each template runs; kept separate so it can be tested
function commandFor(id, name) {
  switch (id) {
    case 'next':
      return {
        cmd: 'npx',
        args: ['--yes', 'create-next-app@latest', name, '--ts', '--eslint', '--tailwind', '--app', '--src-dir',
          '--import-alias', '@/*', '--use-npm', '--yes'],
      };
    case 'vite-react':
      return { cmd: 'npm', args: ['create', 'vite@latest', name, '--', '--template', 'react-ts'] };
    case 'vite-vue':
      return { cmd: 'npm', args: ['create', 'vite@latest', name, '--', '--template', 'vue-ts'] };
    case 'vite-svelte':
      return { cmd: 'npm', args: ['create', 'vite@latest', name, '--', '--template', 'svelte-ts'] };
    case 'astro':
      return { cmd: 'npm', args: ['create', 'astro@latest', name, '--', '--template', 'minimal', '--install', '--no-git', '--yes'] };
    default:
      return null;
  }
}

function plan({ template = 'next', parent, name, repo, branch, command } = {}) {
  const t = byId(template);
  if (!t) return { ok: false, error: 'Pick a starting point.' };
  if (!parent) return { ok: false, error: 'Choose where to create the project.' };
  try {
    if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) return { ok: false, error: 'That location does not exist.' };
  } catch { return { ok: false, error: 'That location does not exist.' }; }
  if (!name || !VALID_NAME.test(name)) return { ok: false, error: 'Invalid project name — use letters, numbers, dashes.' };

  const folder = path.join(parent, name);
  if (fs.existsSync(folder)) return { ok: false, error: 'A folder with that name already exists there.' };

  if (t.kind === 'html') {
    return { ok: true, template: t, kind: 'html', folder, parent, name, label: 'plain HTML starter' };
  }

  if (t.kind === 'clone') {
    const url = String(repo || '').trim();
    if (!/^(https?:\/\/|git@|ssh:\/\/)\S+$/i.test(url)) {
      return { ok: false, error: 'Paste a repository URL (https://… or git@…).' };
    }
    const b = String(branch || '').trim();
    if (b && !VALID_BRANCH.test(b)) return { ok: false, error: 'That branch name is not valid.' };
    const args = ['clone', '--depth', '1'];
    if (b) args.push('--branch', b);
    args.push(url, folder);
    return { ok: true, template: t, kind: 'clone', folder, parent, name, cmd: 'git', args, cwd: parent, label: `git clone ${url}` };
  }

  if (t.kind === 'custom') {
    const c = String(command || '').trim();
    if (!c) return { ok: false, error: 'Enter the command that scaffolds the project.' };
    return { ok: true, template: t, kind: 'custom', folder, parent, name, cmd: c, shell: true, cwd: folder, mkdir: true, label: c };
  }

  const built = commandFor(t.id, name);
  if (!built) return { ok: false, error: 'That template has no command.' };
  return {
    ok: true, template: t, kind: 'command', folder, parent, name,
    cmd: built.cmd, args: built.args, cwd: parent,
    shell: process.platform === 'win32',
    label: `${built.cmd} ${built.args.join(' ')}`,
  };
}

// ---------- plain HTML starter (no network, no tooling) ----------
function htmlFiles(name) {
  const title = name.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return {
    'index.html': `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <header class="nav">
    <a class="brand" href="/">${title}</a>
    <nav><a href="/">Home</a><a href="/about">About</a></nav>
  </header>
  <main class="page">
    <p class="eyebrow">Plain HTML · no tooling</p>
    <h1>Your new site is live.</h1>
    <p>Edit <code>index.html</code>, <code>styles.css</code>, or <code>main.js</code> — withlook reloads the preview when you save.</p>
    <button id="hello">Click me</button>
    <p id="out" class="muted"></p>
  </main>
  <script src="main.js"></script>
</body>
</html>
`,
    'about.html': `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>About · ${title}</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <header class="nav">
    <a class="brand" href="/">${title}</a>
    <nav><a href="/">Home</a><a href="/about">About</a></nav>
  </header>
  <main class="page">
    <p class="eyebrow">Second page</p>
    <h1>About</h1>
    <p>This page exists so the Pages panel has something to show. Add another <code>.html</code> file and it appears there too.</p>
    <p><a href="/">← Back home</a></p>
  </main>
</body>
</html>
`,
    'styles.css': `:root {
  --bg: #0b0d12;
  --surface: #12151d;
  --line: #232838;
  --fg: #e7ecf5;
  --muted: #8b96ad;
  --accent: #6ea8ff;
  color-scheme: dark;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 15px/1.65 ui-sans-serif, -apple-system, 'Inter', system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.nav {
  display: flex; align-items: center; justify-content: space-between;
  max-width: 880px; margin: 0 auto; padding: 20px 24px;
  border-bottom: 1px solid var(--line);
}
.brand { color: var(--fg); font-weight: 650; text-decoration: none; letter-spacing: -0.01em; }
.nav nav { display: flex; gap: 18px; }
.nav a { color: var(--muted); text-decoration: none; font-size: 13px; }
.nav a:hover { color: var(--fg); }
.page { max-width: 880px; margin: 0 auto; padding: 72px 24px; }
.eyebrow { color: var(--accent); font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; margin: 0 0 12px; }
h1 { font-size: clamp(30px, 5vw, 46px); line-height: 1.1; letter-spacing: -0.03em; margin: 0 0 16px; }
p { color: var(--muted); max-width: 56ch; }
code { background: var(--surface); border: 1px solid var(--line); border-radius: 5px; padding: 1px 5px; font-size: 0.9em; color: var(--fg); }
button {
  margin-top: 20px; padding: 10px 18px; cursor: pointer;
  background: var(--accent); color: #08111f; border: 0; border-radius: 9px;
  font: inherit; font-weight: 600;
}
button:hover { filter: brightness(1.08); }
.muted { margin-top: 14px; font-size: 13px; }
a { color: var(--accent); }
`,
    'main.js': `const out = document.getElementById('out');
let clicks = 0;
document.getElementById('hello').addEventListener('click', () => {
  clicks += 1;
  out.textContent = \`Clicked \${clicks} time\${clicks === 1 ? '' : 's'} — edit main.js to change this.\`;
});
`,
    'README.md': `# ${title}

A plain HTML site — no build step, no dependencies.

\`\`\`bash
open index.html   # or just open it in withlook
\`\`\`

- \`index.html\` — home
- \`about.html\` — second page (appears in withlook's Pages panel)
- \`styles.css\` — shared styles
- \`main.js\` — page script

Add another \`.html\` file and withlook lists it as a route automatically.
`,
  };
}

function writePlainHtml(folder, name) {
  try {
    fs.mkdirSync(folder, { recursive: true });
    const files = htmlFiles(name || path.basename(folder));
    for (const [rel, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(folder, rel), content);
    }
    // a repo makes the sandbox use a worktree and lets commit/push work out of the box
    const git = spawnSync('git', ['-C', folder, 'init', '-q'], { encoding: 'utf8' });
    let committed = false;
    if (git.status === 0) {
      spawnSync('git', ['-C', folder, 'add', '-A'], { encoding: 'utf8' });
      const commit = spawnSync('git', ['-C', folder, '-c', 'user.email=withlook@local', '-c', 'user.name=withlook',
        'commit', '-qm', 'Initial commit', '--no-verify'], { encoding: 'utf8' });
      committed = commit.status === 0;
    }
    return { ok: true, files: Object.keys(files), git: committed };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { TEMPLATES, plan, commandFor, writePlainHtml, htmlFiles };
