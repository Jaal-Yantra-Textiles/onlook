'use strict';
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
/* node test/source.test.js */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { findSourcesInFolder } = require('../main/source-search');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-'));
  fs.mkdirSync(path.join(root, 'node_modules', 'junk'), { recursive: true });
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'junk', 'a.js'), 'Hello withlook');
  fs.writeFileSync(path.join(root, 'app', 'page.tsx'),
    `import Nav from "./nav"
export default function Page() {
  return (<div className="hero-section"><Nav /><h1 className="hero-title">Hello withlook</h1></div>)
}`);
  fs.writeFileSync(path.join(root, 'app', 'nav.tsx'), 'export default () => <nav className="topbar">menu</nav>');

  // text match (ignores node_modules, prefers best score)
  const r1 = await findSourcesInFolder(root, { text: 'Hello withlook', selector: '', classes: '', id: '' });
  const ok1 = r1.ok && r1.files[0].file.endsWith('page.tsx') && r1.files[0].line >= 3;

  // class token match
  const r2 = await findSourcesInFolder(root, { text: '', selector: '', classes: 'topbar', id: '' });
  const ok2 = r2.ok && r2.files[0].file.endsWith('nav.tsx');

  // id match
  const r3 = await findSourcesInFolder(root, { text: '', selector: '', classes: '', id: 'cta-button' });
  const ok3 = !r3.ok; // nothing contains it

  console.log(ok1 && ok2 && ok3 ? 'SRC_PASS' : 'SRC_FAIL ' + JSON.stringify({ r1, r2, r3 }).slice(0, 400));
  process.exit(ok1 && ok2 && ok3 ? 0 : 1);
})();
