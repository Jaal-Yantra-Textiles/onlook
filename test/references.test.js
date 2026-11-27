'use strict';
/* reference store: electron test/references.test.js */
const { app } = require('electron');
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { References, MAX_REFS, cardSize, nextSlot } = require('../main/references');

// 1×1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

app.whenReady().then(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-refs-'));
  try {
    const r = new References(root);
    assert.equal(r.setProject('/tmp/proj-a').length, 0);

    const a = r.addBuffer(PNG, 'one.png');
    assert.equal(a.ok, true);
    assert.equal(r.items.length, 1);
    const id = a.item.id;
    assert.match(a.item.thumb, /^data:image\/png;base64,/);
    assert.match(a.item.dataUrl, /^data:image\/jpeg;base64,/);
    assert.equal(a.item.width, 1);
    assert.equal(a.item.height, 1);

    // renderers never receive the full payload
    const listed = r.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].dataUrl, undefined);
    assert.ok(listed[0].thumb);
    assert.equal(r.byIds([id]).length, 1);
    assert.equal(r.byIds([]).length, 0);

    // include/exclude
    assert.equal(r.toggle(id), false);
    assert.equal(r.items[0].include, false);
    assert.equal(r.toggle(id), true);

    // persisted per project
    const r2 = new References(root);
    assert.equal(r2.setProject('/tmp/proj-a').length, 1);
    assert.equal(r2.items[0].name, 'one.png');
    assert.equal(r2.setProject('/tmp/proj-b').length, 0);
    assert.equal(r2.setProject('/tmp/proj-a').length, 1);

    // adding a file copies it into our assets dir
    const imgFile = path.join(root, 'two.png');
    fs.writeFileSync(imgFile, PNG);
    const b = r2.addPath(imgFile);
    assert.equal(b.ok, true);
    assert.ok(fs.existsSync(b.item.path));
    assert.ok(b.item.path.includes('reference-assets'));
    assert.equal(b.item.name, 'two.png');

    // removing deletes the copy, not the original
    const copy = b.item.path;
    assert.equal(r2.remove(b.item.id), true);
    assert.equal(fs.existsSync(copy), false);
    assert.ok(fs.existsSync(imgFile));

    // canvas box persists
    r2.setBox(r2.items[0].id, { x: 120, y: 90, w: 300, h: 200 });
    r2.save();
    const rBox = new References(root);
    rBox.setProject('/tmp/proj-a');
    assert.equal(rBox.items[0].x, 120);
    assert.equal(rBox.items[0].y, 90);
    assert.equal(rBox.items[0].w, 300);
    assert.equal(rBox.items[0].h, 200);
    // clamped
    rBox.setBox(rBox.items[0].id, { w: 10, h: 10 });
    assert.equal(rBox.items[0].w, 80);
    assert.equal(rBox.items[0].h, 60);

    // new cards keep the image ratio and never overlap
    assert.deepEqual(cardSize(1000, 500), { w: 240, h: 120 });
    assert.deepEqual(cardSize(500, 1000), { w: 120, h: 240 });
    assert.deepEqual(cardSize(1, 1), { w: 240, h: 240 });
    const s1 = nextSlot([], 200, 150);
    const s2 = nextSlot([{ x: s1.x, y: s1.y, w: 200, h: 150 }], 200, 150);
    assert.notDeepEqual(s1, s2);

    // cap
    for (let i = 0; i < MAX_REFS + 3; i++) r2.addBuffer(PNG, `x${i}.png`);
    assert.equal(r2.items.length, MAX_REFS);
    const full = r2.addBuffer(PNG, 'over.png');
    assert.equal(full.ok, false);

    // a missing file is dropped on reload
    const gone = r2.items[0].path;
    fs.rmSync(gone, { force: true });
    const r3 = new References(root);
    assert.equal(r3.setProject('/tmp/proj-a').length, MAX_REFS - 1);

    // no project = no items
    assert.equal(r3.setProject(null).length, 0);

    console.log('REFS_PASS');
    fs.rmSync(root, { recursive: true, force: true });
    app.exit(0);
  } catch (e) {
    console.error('REFS_FAIL ' + (e && e.message));
    fs.rmSync(root, { recursive: true, force: true });
    app.exit(1);
  }
});
