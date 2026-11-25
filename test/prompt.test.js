'use strict';
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
/* node test/prompt.test.js */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { buildSystemPrompt, BASE_SYSTEM_PROMPT, NO_TOOLS_NOTE, HAS_TOOLS_NOTE } = require('../main/prompt');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-prompt-'));
const file = path.join(root, 'footer.tsx');
fs.writeFileSync(file, 'line1\nline2\nexport default function Footer() {\n  return <footer className="kt-foot-about">hi</footer>\n}\n');

const direct = buildSystemPrompt({ systemPrompt: '' }, { url: 'http://localhost:3000/about' }, 'direct');
const opencode = buildSystemPrompt({ systemPrompt: '' }, {}, 'opencode');
const extra = buildSystemPrompt({ systemPrompt: 'Always answer in French.' }, {}, 'direct');
const withSel = buildSystemPrompt({ systemPrompt: '' }, {
  writeMode: true,
  selections: [{ selector: '.kt-foot-about', tag: 'footer', classes: 'kt-foot-about', text: 'hi', html: '<footer></footer>', styles: 'color: red', sources: [{ file, line: 4 }] }],
}, 'direct');

const checks = {
  base: direct.includes(BASE_SYSTEM_PROMPT),
  noTools: direct.includes(NO_TOOLS_NOTE) && !direct.includes(HAS_TOOLS_NOTE),
  hasTools: opencode.includes(HAS_TOOLS_NOTE) && !opencode.includes(NO_TOOLS_NOTE),
  customAppended: extra.includes(BASE_SYSTEM_PROMPT) && extra.includes('Additional instructions from the user:\nAlways answer in French.'),
  url: direct.includes('Current page URL: http://localhost:3000/about'),
  excerpt: withSel.includes('Excerpt of ' + file) && withSel.includes('kt-foot-about'),
  writeMode: withSel.includes('WRITE MODE IS ON'),
  noNarrationRule: /Never narrate a process/.test(direct),
};
const bad = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
console.log(bad.length ? 'PROMPT_FAIL ' + bad.join(',') : 'PROMPT_PASS');
process.exit(bad.length ? 1 : 0);
