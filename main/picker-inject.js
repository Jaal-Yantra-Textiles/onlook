/* withlook element picker — injected into the preview page */
(() => {
  if (window.__wlPicker) { try { window.__wlPicker.stop(); } catch (_) {} }
  const doc = document;
  const style = doc.createElement('style');
  style.textContent = [
    'html.__wl-picking, html.__wl-picking * { cursor: crosshair !important; }',
    '#__wl-box { position: fixed; z-index: 2147483646; pointer-events: none; border: 1.5px solid #6ea8ff; background: rgba(110,168,255,0.14); border-radius: 3px; box-shadow: 0 0 0 1px rgba(0,0,0,0.45), 0 0 18px rgba(110,168,255,0.35); transition: all 50ms linear; display: none; }',
    '#__wl-tip { position: fixed; z-index: 2147483647; pointer-events: none; background: #10131a; color: #e7ecf5; font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; padding: 3px 7px; border-radius: 5px; border: 1px solid rgba(255,255,255,0.14); max-width: 420px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: none; }',
  ].join('\n');
  doc.documentElement.appendChild(style);
  doc.documentElement.classList.add('__wl-picking');
  const box = doc.createElement('div'); box.id = '__wl-box';
  const tip = doc.createElement('div'); tip.id = '__wl-tip';
  doc.documentElement.append(box, tip);
  let current = null;

  const cssEscape = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/([^a-zA-Z0-9_\u00A0-\uFFFF-])/g, '\\$1');

  const uniqueMatch = (sel, el) => {
    try { return document.querySelector(sel) === el; } catch (_) { return false; }
  };

  function selectorFor(el) {
    // 1. id
    if (el.id) {
      const s = '#' + cssEscape(el.id);
      if (uniqueMatch(s, el)) return s;
    }
    // 2. data-testid
    const tid = el.getAttribute ? el.getAttribute('data-testid') : null;
    if (tid) {
      const s = `${el.tagName.toLowerCase()}[data-testid="${tid}"]`;
      if (uniqueMatch(s, el)) return s;
    }
    // 3. tag + classes
    if (typeof el.className === 'string' && el.className.trim()) {
      const classes = el.className.trim().split(/\s+/).slice(0, 3).map(cssEscape);
      const s = el.tagName.toLowerCase() + classes.map((c) => '.' + c).join('');
      if (uniqueMatch(s, el)) return s;
    }
    // 4. structural path, extended upward until unique
    const path = [];
    let n = el;
    while (n && n.nodeType === 1) {
      if (n.id) { path.unshift('#' + cssEscape(n.id)); break; }
      let part = n.tagName.toLowerCase();
      const parent = n.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === n.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(n) + 1})`;
      }
      path.unshift(part);
      const s = path.join(' > ');
      if (path.length >= 2 && uniqueMatch(s, el)) return s;
      if (!parent) break;
      n = parent;
    }
    return path.join(' > ');
  }

  function describe(el) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const keys = ['display', 'position', 'width', 'height', 'padding', 'margin', 'font-size', 'font-weight', 'line-height', 'color', 'background-color', 'border', 'border-radius', 'flex-direction', 'gap', 'grid-template-columns', 'text-align', 'z-index'];
    const styles = keys.map((k) => `${k}: ${cs.getPropertyValue(k)}`).join('; ');
    let classes = '';
    try { if (typeof el.className === 'string') classes = el.className; } catch (_) {}
    return {
      selector: selectorFor(el),
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      classes,
      text: (el.innerText || el.textContent || '').trim().slice(0, 600),
      html: el.outerHTML.slice(0, 6000),
      rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
      styles,
    };
  }

  function onMove(e) {
    const el = e.target;
    if (!el || el === box || el === tip || !(el instanceof Element)) return;
    current = el;
    const r = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
    box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
    const d = describe(el);
    tip.style.display = 'block';
    tip.textContent = `<${d.tag}> ${Math.round(r.width)}×${Math.round(r.height)}  ${d.classes ? '.' + d.classes.trim().split(/\s+/).slice(0, 3).join('.') : d.selector.slice(0, 40)}`;
    const vw = window.innerWidth, vh = window.innerHeight;
    let tx = Math.max(6, Math.min(r.left, vw - 340));
    let ty = r.top > 30 ? r.top - 26 : r.bottom + 6;
    // the floating chat pill covers the top-centre strip of the page — flip below instead
    const pillX1 = (vw - 780) / 2, pillX2 = pillX1 + 780;
    if (tx > pillX1 && tx < pillX2 && ty < 76) ty = Math.min(r.bottom + 6, vh - 26);
    tip.style.left = tx + 'px';
    tip.style.top = ty + 'px';
  }
  function onClick(e) {
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    const data = current ? describe(current) : null;
    stop();
    if (data && window.withlook) window.withlook.submitSelection(data);
  }
  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      stop();
      if (window.withlook) window.withlook.cancelSelection();
    }
  }
  function stop() {
    doc.removeEventListener('mousemove', onMove, true);
    doc.removeEventListener('click', onClick, true);
    doc.removeEventListener('keydown', onKey, true);
    doc.documentElement.classList.remove('__wl-picking');
    try { style.remove(); box.remove(); tip.remove(); } catch (_) {}
    current = null;
    window.__wlPicker = null;
  }
  window.__wlPicker = { stop };
  doc.addEventListener('mousemove', onMove, true);
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('keydown', onKey, true);
  return true;
})();
