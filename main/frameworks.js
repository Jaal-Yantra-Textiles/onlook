'use strict';
/* withlook framework adapters — which frontend is this, how to run it, and what routes does it have */
const fs = require('node:fs');
const path = require('node:path');

const PAGE_EXT = /\.(tsx|ts|jsx|js|mdx)$/;
const NEXT_PAGE = /^page\.(tsx|ts|jsx|js|mdx)$/;
const ASTRO_PAGE = /\.(astro|md|mdx)$/;

function readPkg(folder) {
  try { return JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8')); } catch { return null; }
}
function depsOf(pkg) {
  if (!pkg) return {};
  return { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
}
const has = (d, name) => Object.prototype.hasOwnProperty.call(d, name);
const hasConfig = (folder, names) => names.some((n) => fs.existsSync(path.join(folder, n)));

// turn a file path into a route: strip the extension, then turn [slug] / [...rest] into :slug / *
function toRoute(rel) {
  const r = String(rel || '')
    .replace(PAGE_EXT, '')
    .replace(ASTRO_PAGE, '')
    .replace(/\/index$/, '')
    .replace(/^index$/, '')
    .replace(/\[+\.\.\.([^\]]+)\]+/g, '*')
    .replace(/\[([^\]]+)\]/g, ':$1');
  return '/' + r.replace(/^\/+|\/+$/g, '');
}

async function scan(dir, opts = {}) {
  const out = [];
  const limit = opts.limit || 200;
  const walk = async (d, rel, depth) => {
    if (depth > 7 || out.length > limit) return;
    let entries;
    try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.name.startsWith('_') || ent.name.startsWith('.') || ent.name === 'node_modules') continue;
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) { await walk(path.join(d, ent.name), relPath, depth + 1); continue; }
      if (ent.isFile() && (!opts.match || opts.match.test(ent.name))) {
        out.push({ relPath, file: path.join(d, ent.name) });
      }
    }
  };
  await walk(dir, '', 0);
  return out;
}

function dedupe(list) {
  const seen = new Set();
  return list
    .filter((p) => (seen.has(p.route) ? false : (seen.add(p.route), true)))
    .sort((a, b) => a.route.localeCompare(b.route));
}

// Next.js: app router (page.*) first, then the pages router
async function nextRoutes(folder) {
  for (const [root, isApp] of [['src/app', true], ['app', true], ['src/pages', false], ['pages', false]]) {
    const dir = path.join(folder, root);
    if (!fs.existsSync(dir)) continue;
    const entries = (await scan(dir, { match: isApp ? NEXT_PAGE : PAGE_EXT }))
      .filter((e) => isApp || !/(^|\/)(404|500)\.[^/]+$/.test(e.relPath)); // error pages aren't routes
    if (!entries.length) continue;
    return dedupe(entries.map((e) => ({
      route: isApp ? toRoute(e.relPath.replace(/\/?page\.[^/]+$/, '').replace(/\(([^)]+)\)\/?/g, '')) : toRoute(e.relPath),
      file: e.file,
    })));
  }
  return [];
}

// Astro: src/pages is the route tree
async function astroRoutes(folder) {
  const dir = path.join(folder, 'src/pages');
  if (!fs.existsSync(dir)) return [];
  const entries = (await scan(dir, { match: ASTRO_PAGE }))
    .filter((e) => !/(^|\/)(404|500)\.[^/]+$/.test(e.relPath)); // error pages aren't routes
  return dedupe(entries.map((e) => ({ route: toRoute(e.relPath), file: e.file })));
}

// Plain HTML: every .html file is a page, served by withlook's static server
async function staticRoutes(folder) {
  const entries = await scan(folder, { match: /\.html?$/i });
  return dedupe(entries.map((e) => {
    let rel = e.relPath.replace(/\\/g, '/').replace(/\.html?$/i, '');
    if (rel === 'index') rel = '';
    else if (rel.endsWith('/index')) rel = rel.slice(0, -'/index'.length) + '/';
    return { route: '/' + rel, file: e.file };
  }));
}

// order matters: Nuxt/SvelteKit/Remix also depend on Vite
const ADAPTERS = [
  {
    id: 'next', name: 'Next.js', ports: [3000],
    detect: (d, f) => has(d, 'next') || hasConfig(f, ['next.config.js', 'next.config.mjs', 'next.config.ts']),
    routes: nextRoutes,
  },
  {
    id: 'astro', name: 'Astro', ports: [4321],
    detect: (d, f) => has(d, 'astro') || hasConfig(f, ['astro.config.mjs', 'astro.config.ts', 'astro.config.js']),
    routes: astroRoutes,
  },
  {
    id: 'nuxt', name: 'Nuxt', ports: [3000],
    detect: (d, f) => has(d, 'nuxt') || hasConfig(f, ['nuxt.config.ts', 'nuxt.config.js']),
  },
  {
    id: 'sveltekit', name: 'SvelteKit', ports: [5173],
    detect: (d, f) => has(d, '@sveltejs/kit') || hasConfig(f, ['svelte.config.js', 'svelte.config.ts']),
  },
  {
    id: 'remix', name: 'Remix', ports: [3000],
    detect: (d) => has(d, '@remix-run/dev'),
  },
  {
    id: 'angular', name: 'Angular', ports: [4200],
    detect: (d) => has(d, '@angular/core'),
  },
  {
    id: 'vite', name: 'Vite', ports: [5173],
    detect: (d, f) => has(d, 'vite') || hasConfig(f, ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']),
  },
];
const STATIC = { id: 'static', name: 'Plain HTML', ports: [8080], routes: staticRoutes };
const GENERIC = { id: 'web', name: 'Web app', ports: [3000, 5173, 4321, 8080, 4200] };

function detectFramework(folder) {
  const pkg = readPkg(folder);
  const d = depsOf(pkg);
  for (const a of ADAPTERS) {
    try { if (a.detect(d, folder)) return { ...a, pkg }; } catch {}
  }
  // no framework: an index.html with no dev script is a plain static site;
  // a package.json with its own dev script keeps the generic `pm run dev` path
  const hasDevScript = !!(pkg && pkg.scripts && pkg.scripts.dev);
  if (!hasDevScript && fs.existsSync(path.join(folder, 'index.html'))) return { ...STATIC, pkg };
  return { ...GENERIC, pkg };
}

// only the JSON-safe bits go into devState / the renderer
function describe(folder) {
  const fw = detectFramework(folder);
  return { id: fw.id, name: fw.name, ports: fw.ports, routes: !!fw.routes };
}

function scriptPorts(folder) {
  const pkg = readPkg(folder);
  if (!pkg || !pkg.scripts) return [];
  const out = [];
  for (const key of ['dev', 'start', 'preview']) {
    const script = String(pkg.scripts[key] || '');
    const re = /(?:-p|--port)[\s=]+(\d{2,5})/g;
    let m;
    while ((m = re.exec(script))) out.push(Number(m[1]));
    const env = script.match(/\bPORT=(\d{2,5})\b/);
    if (env) out.push(Number(env[1]));
  }
  return [...new Set(out)];
}

function portsFor(folder) {
  const fw = detectFramework(folder);
  const fallback = [];
  for (let p = 3000; p <= 3012; p++) fallback.push(p); // Next's usual range, plus common overrides
  return [...new Set([...scriptPorts(folder), ...fw.ports, ...fallback])];
}

async function listRoutes(folder) {
  const fw = detectFramework(folder);
  if (!fw.routes) return [];
  try { return await fw.routes(folder); } catch { return []; }
}

module.exports = { detectFramework, describe, portsFor, scriptPorts, listRoutes, toRoute };
