'use strict';
/* withlook source search — maps a picked element to likely source files */
const path = require('node:path');
const fs = require('node:fs');

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'out', 'coverage', '.turbo', '.vercel', '.cache', 'vendor']);
const SRC_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.svelte', '.vue', '.astro', '.html', '.css', '.scss', '.mdx', '.md']);
const GENERIC_CLASS = new Set(['flex', 'grid', 'block', 'inline', 'hidden', 'container', 'wrapper', 'active', 'card', 'button', 'input', 'text', 'font', 'border', 'absolute', 'relative', 'fixed', 'select', 'label', 'item', 'items', 'justify', 'center', 'left', 'right', 'top', 'bottom', 'header', 'footer', 'main', 'root', 'app', 'page', 'content', 'box', 'row', 'col', 'w-full', 'h-full']);

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function collectFiles(dir, out = [], depth = 0) {
  if (depth > 8 || out.length > 3000) return out;
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const ent of entries) {
    if (ent.name.startsWith('.') || SKIP_DIRS.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) await collectFiles(full, out, depth + 1);
    else if (ent.isFile() && SRC_EXT.has(path.extname(ent.name).toLowerCase())) out.push(full);
  }
  return out;
}

async function findSourcesInFolder(folder, sel) {
  const files = await collectFiles(folder);
  const tokens = [];
  const text = String((sel && sel.text) || '').replace(/\s+/g, ' ').trim();
  const snippet = text.slice(0, 40);
  if (snippet.length >= 4) tokens.push({ re: new RegExp(escapeRe(snippet)), score: 10, why: 'text' });
  const tidM = String((sel && sel.selector) || '').match(/data-testid="([^"]+)"/);
  const idv = (sel && sel.id) || (tidM && tidM[1]) || '';
  if (idv.length >= 2) tokens.push({ re: new RegExp(escapeRe(idv)), score: 8, why: 'id' });
  for (const c of String((sel && sel.classes) || '').split(/\s+/)) {
    if (c.length >= 3 && !GENERIC_CLASS.has(c)) tokens.push({ re: new RegExp(escapeRe(c)), score: 2, why: 'class' });
  }
  if (!tokens.length) return { ok: false, error: 'Not enough clues to search for.' };
  const results = [];
  for (const f of files) {
    let content;
    try { content = await fs.promises.readFile(f, 'utf8'); } catch { continue; }
    if (content.length > 600000) continue;
    let score = 0; const whys = []; let line = 0;
    for (const t of tokens) {
      const m = t.re.exec(content);
      if (m) {
        score += t.score; whys.push(t.why);
        if (!line) line = content.slice(0, m.index).split('\n').length;
      }
    }
    if (score > 0) results.push({ file: f, line, score, why: whys.join('+') });
  }
  results.sort((a, b) => b.score - a.score);
  if (!results.length) return { ok: false, error: 'No source files matched.' };
  return { ok: true, files: results.slice(0, 5) };
}

module.exports = { collectFiles, findSourcesInFolder, escapeRe };
