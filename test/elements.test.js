'use strict';
/* shared element layer: node test/elements.test.js */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const R = path.join(__dirname, '..', 'renderer');
const css = fs.readFileSync(path.join(R, 'elements.css'), 'utf8');

// the tokens every view can rely on
for (const token of [
  '--wl-bg', '--wl-bg-bar', '--wl-surface', '--wl-input',
  '--wl-line', '--wl-line-soft', '--wl-line-strong',
  '--wl-text', '--wl-text-2', '--wl-text-dim', '--wl-text-muted', '--wl-text-faint',
  '--wl-accent', '--wl-blue', '--wl-mint', '--wl-red',
  '--wl-r-sm', '--wl-r-md', '--wl-r-lg', '--wl-mono', '--wl-ring',
]) {
  assert.ok(css.includes(token), `elements.css is missing ${token}`);
}

// the canonical controls
for (const cls of [
  '.wl-btn', '.wl-btn.primary', '.wl-btn.danger', '.wl-btn.sm', '.wl-btn.icon',
  '.wl-input', '.wl-chip', '.wl-badge', '.wl-label', '.wl-note',
  '.wl-seg', '.wl-menu', '.wl-menu-item', '.wl-card', '.wl-spinner', '.wl-kbd',
]) {
  assert.ok(css.includes(cls), `elements.css is missing ${cls}`);
}

// every visible view must load the shared layer before its own styles
const views = ['overlay.html', 'sidebar.html', 'tabbar.html', 'canvas-bar.html', 'loader.html',
  'placeholder.html', 'create-project.html', 'status.html', 'elements.html'];
for (const f of views) {
  const html = fs.readFileSync(path.join(R, f), 'utf8');
  const link = html.indexOf('elements.css');
  const own = Math.min(
    ...['<style', 'overlay.css'].map((s) => { const i = html.indexOf(s); return i < 0 ? Infinity : i; }),
  );
  assert.ok(link >= 0, `${f} does not link elements.css`);
  assert.ok(link < own, `${f} links elements.css after its own styles`);
}

// the catalog exists and shows the controls
const catalog = fs.readFileSync(path.join(R, 'elements.html'), 'utf8');
assert.match(catalog, /wl-btn/);
assert.match(catalog, /wl-input/);
assert.match(catalog, /wl-menu/);

console.log('ELEMENTS_PASS');
