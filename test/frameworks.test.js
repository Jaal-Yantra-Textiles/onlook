'use strict';
/* framework adapters: node test/frameworks.test.js */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { detectFramework, portsFor, listRoutes, toRoute } = require('../main/frameworks');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-fw-'));
function mk(name, pkg, files) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  for (const [rel, content] of Object.entries(files || {})) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}
const routes = async (dir) => (await listRoutes(dir)).map((r) => r.route);

(async () => {
  try {
    // Next app router: route groups stripped, dynamic segments colonised
    const nextApp = mk('next-app', { dependencies: { next: '16.0.0' } }, {
      'src/app/page.tsx': 'export default 1',
      'src/app/about/page.tsx': 'export default 1',
      'src/app/(marketing)/pricing/page.tsx': 'export default 1',
      'src/app/blog/[slug]/page.tsx': 'export default 1',
    });
    assert.equal(detectFramework(nextApp).id, 'next');
    assert.ok(portsFor(nextApp).includes(3000));
    assert.deepEqual(await routes(nextApp), ['/', '/about', '/blog/:slug', '/pricing']);

    // Next pages router fallback
    const nextPages = mk('next-pages', { dependencies: { next: '13.0.0' } }, {
      'pages/index.tsx': '', 'pages/docs/index.tsx': '', 'pages/api/hello.ts': '',
    });
    assert.deepEqual(await routes(nextPages), ['/', '/api/hello', '/docs']);

    // Astro: src/pages is the route tree
    const astro = mk('astro', { dependencies: { astro: '5.0.0' } }, {
      'src/pages/index.astro': '', 'src/pages/about.md': '', 'src/pages/blog/[slug].astro': '',
    });
    assert.equal(detectFramework(astro).id, 'astro');
    assert.ok(portsFor(astro).includes(4321));
    assert.deepEqual(await routes(astro), ['/', '/about', '/blog/:slug']);

    // Vite: detected, runs on 5173, no route discovery (tabs are added by hand)
    const vite = mk('vite', { devDependencies: { vite: '7.0.0', react: '19.0.0' } }, { 'src/main.tsx': '' });
    assert.equal(detectFramework(vite).id, 'vite');
    assert.ok(portsFor(vite).includes(5173));
    assert.deepEqual(await routes(vite), []);

    // SvelteKit and Nuxt also depend on Vite — they must not be mislabelled
    assert.equal(detectFramework(mk('sveltekit', { devDependencies: { vite: '7.0.0', '@sveltejs/kit': '2.0.0' } })).id, 'sveltekit');
    assert.equal(detectFramework(mk('nuxt', { dependencies: { nuxt: '3.0.0', vite: '7.0.0' } })).id, 'nuxt');

    // anything else still runs, on the generic port list
    const web = mk('web', { dependencies: {} }, {});
    assert.equal(detectFramework(web).id, 'web');
    assert.ok(portsFor(web).includes(5173));

    // plain HTML: no framework, no dev script — every page is a route
    const staticSite = mk('static', {}, { 'index.html': '', 'about.html': '', 'docs/index.html': '' });
    assert.equal(detectFramework(staticSite).id, 'static');
    assert.ok(portsFor(staticSite).includes(8080));
    assert.deepEqual(await routes(staticSite), ['/', '/about', '/docs/']);

    // a package.json with its own dev script keeps the generic runner
    const ownServer = mk('own-server', { scripts: { dev: 'node server.js' } }, { 'index.html': '' });
    assert.equal(detectFramework(ownServer).id, 'web');

    // custom dev ports are included so attach can find them
    const customPort = mk('custom-port', { scripts: { dev: 'next dev --turbopack -p 8000' } }, {});
    assert.ok(portsFor(customPort).includes(8000));
    const envPort = mk('env-port', { scripts: { dev: 'PORT=7000 node server.js' } }, {});
    assert.ok(portsFor(envPort).includes(7000));

    // route helper
    assert.equal(toRoute('blog/[...slug].astro'), '/blog/*');
    assert.equal(toRoute('index.astro'), '/');

    console.log('FRAMEWORK_PASS');
    fs.rmSync(root, { recursive: true, force: true });
  } catch (e) {
    console.error('FRAMEWORK_FAIL ' + (e && e.message));
    fs.rmSync(root, { recursive: true, force: true });
    process.exit(1);
  }
})();
