'use strict';
/* withlook references — images on the canvas that can travel with a chat message */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { nativeImage } = require('electron');

const MAX_REFS = 12;
const MAX_EDGE = 1024;   // what the model sees
const THUMB_EDGE = 160;  // what the tray/chat render
const JPEG_QUALITY = 85;

function encode(img) {
  const { width, height } = img.getSize();
  if (!width || !height) return null;
  const fullScale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const thumbScale = Math.min(1, THUMB_EDGE / Math.max(width, height));
  const full = fullScale < 1
    ? img.resize({ width: Math.round(width * fullScale), height: Math.round(height * fullScale), quality: 'good' })
    : img;
  const thumb = thumbScale < 1
    ? img.resize({ width: Math.round(width * thumbScale), height: Math.round(height * thumbScale), quality: 'good' })
    : img;
  return {
    width,
    height,
    dataUrl: 'data:image/jpeg;base64,' + full.toJPEG(JPEG_QUALITY).toString('base64'),
    thumb: thumb.toDataURL(), // small PNG for the UI
  };
}

function cardSize(width, height) {
  const w0 = Number(width) || 0;
  const h0 = Number(height) || 0;
  if (!w0 || !h0) return { w: 200, h: 150 };
  const s = 240 / Math.max(w0, h0);
  return { w: Math.max(80, Math.round(w0 * s)), h: Math.max(60, Math.round(h0 * s)) };
}

// first free cell in a 4-column grid, so new references never land on top of each other
function nextSlot(items, w, h) {
  const gap = 14;
  const stepX = 260;
  const stepY = 260;
  const hits = (x, y) => items.some((it) => !(
    x + w + gap <= it.x || it.x + it.w + gap <= x ||
    y + h + gap <= it.y || it.y + it.h + gap <= y
  ));
  for (let row = 0; row < 20; row++) {
    for (let col = 0; col < 4; col++) {
      const x = 28 + col * stepX;
      const y = 28 + row * stepY;
      if (!hits(x, y)) return { x, y };
    }
  }
  return { x: 28, y: 28 + items.length * stepY };
}

class References {
  constructor(userDataPath) {
    this.file = path.join(userDataPath, 'references.json');
    this.assets = path.join(userDataPath, 'reference-assets');
    this.project = null;
    this.items = [];
    this.all = {};
    try { fs.mkdirSync(this.assets, { recursive: true }); } catch {}
    try { this.all = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {}; } catch { this.all = {}; }
  }

  setProject(folder) {
    const next = folder || null;
    if (this.project === next) return this.items;
    this.project = next;
    this.items = [];
    if (!next) return this.items;
    (this.all[next] || []).forEach((saved, i) => {
      const item = this.hydrate(saved, i);
      if (item) this.items.push(item);
    });
    return this.items;
  }

  hydrate(saved, index = 0) {
    try {
      if (!saved || !saved.path || !fs.existsSync(saved.path)) return null;
      const img = nativeImage.createFromPath(saved.path);
      if (img.isEmpty()) return null;
      const enc = encode(img);
      if (!enc) return null;
      const num = (v, d) => (Number.isFinite(v) ? v : d);
      const size = cardSize(enc.width, enc.height);
      const slot = nextSlot(this.items, size.w, size.h);
      return {
        id: saved.id || crypto.randomUUID(),
        path: saved.path,
        name: saved.name || path.basename(saved.path),
        include: saved.include !== false,
        x: num(saved.x, slot.x),
        y: num(saved.y, slot.y),
        w: num(saved.w, size.w),
        h: num(saved.h, size.h),
        ...enc,
      };
    } catch { return null; }
  }

  addPath(file, place) {
    if (this.items.length >= MAX_REFS) return { ok: false, error: `Up to ${MAX_REFS} references.` };
    try {
      const img = nativeImage.createFromPath(file);
      if (img.isEmpty()) return { ok: false, error: 'Not an image file.' };
      const enc = encode(img);
      if (!enc) return { ok: false, error: 'Could not read that image.' };
      const id = crypto.randomUUID();
      const ext = /^\.(png|jpe?g|webp|gif|bmp)$/i.test(path.extname(file)) ? path.extname(file).toLowerCase() : '.png';
      const dest = path.join(this.assets, id + ext);
      fs.copyFileSync(file, dest); // keep our own copy — the original can move
      const size = cardSize(enc.width, enc.height);
      const slot = (place && Number.isFinite(place.x) && Number.isFinite(place.y))
        ? { x: place.x, y: place.y }
        : nextSlot(this.items, size.w, size.h);
      const item = {
        id, path: dest, name: path.basename(file), include: true,
        x: slot.x, y: slot.y, w: size.w, h: size.h,
        ...enc,
      };
      this.items.push(item);
      this.save();
      return { ok: true, item };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  addBuffer(buffer, name, place) {
    if (this.items.length >= MAX_REFS) return { ok: false, error: `Up to ${MAX_REFS} references.` };
    try {
      const img = nativeImage.createFromBuffer(buffer);
      if (img.isEmpty()) return { ok: false, error: 'Not an image.' };
      const enc = encode(img);
      if (!enc) return { ok: false, error: 'Could not read that image.' };
      const id = crypto.randomUUID();
      const dest = path.join(this.assets, id + '.png');
      fs.writeFileSync(dest, buffer);
      const size = cardSize(enc.width, enc.height);
      const slot = (place && Number.isFinite(place.x) && Number.isFinite(place.y))
        ? { x: place.x, y: place.y }
        : nextSlot(this.items, size.w, size.h);
      const item = {
        id, path: dest, name: name || 'image.png', include: true,
        x: slot.x, y: slot.y, w: size.w, h: size.h,
        ...enc,
      };
      this.items.push(item);
      this.save();
      return { ok: true, item };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  remove(id) {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return false;
    const [item] = this.items.splice(i, 1);
    try {
      if (item.path && path.dirname(item.path) === this.assets) fs.rmSync(item.path, { force: true });
    } catch {}
    this.save();
    return true;
  }

  toggle(id) {
    const item = this.items.find((x) => x.id === id);
    if (!item) return null;
    item.include = !item.include;
    this.save();
    return item.include;
  }

  setBox(id, patch) {
    const item = this.items.find((x) => x.id === id);
    if (!item) return null;
    if (Number.isFinite(patch.x)) item.x = Math.max(-2000, Math.min(4000, patch.x));
    if (Number.isFinite(patch.y)) item.y = Math.max(-2000, Math.min(4000, patch.y));
    if (Number.isFinite(patch.w)) item.w = Math.max(80, Math.min(520, patch.w));
    if (Number.isFinite(patch.h)) item.h = Math.max(60, Math.min(420, patch.h));
    return item;
  }

  // what the renderers get: no full-size data URLs
  list() {
    return this.items.map(({ id, name, include, thumb, width, height, x, y, w, h }) => ({ id, name, include, thumb, width, height, x, y, w, h }));
  }

  byIds(ids) {
    if (!Array.isArray(ids) || !ids.length) return [];
    const want = new Set(ids);
    return this.items.filter((x) => want.has(x.id));
  }

  save() {
    if (!this.project) return;
    this.all[this.project] = this.items.map(({ id, path: p, name, include, x, y, w, h }) => ({ id, path: p, name, include, x, y, w, h }));
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.all, null, 2));
    } catch {}
  }
}

module.exports = { References, MAX_REFS, cardSize, nextSlot };
