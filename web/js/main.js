// Miniscript Studio: application bootstrap and orchestration.
import { loadWasm, compile, generateKey, importDescriptor, liftMiniscript, version } from './wasm.js';
import { Model, TYPES, hasInputs } from './model.js';
import { Canvas } from './canvas.js';
import { Panels } from './panels.js';
import { PALETTE } from './blocks.js';
import { buildPolicy } from './policy.js';
import { parsePolicy, buildBlocks } from './parse.js';
import { TEMPLATES } from './templates.js';
import { icon } from './icons.js';
import { $, $$, h, esc, toast, copyText, seedHex, randomHex, hexToBytes, sha256Hex, compress, decompress } from './util.js';

const STORAGE_KEY = 'miniscript-studio:v1';

class App {
  constructor() {
    this.model = new Model();
    this.nodeErrors = new Map();
    this.built = null;
    this.result = null;
    this.canvas = new Canvas($('#canvas'), this);
    this.panels = new Panels(this);
    this.canvas.app.onSelect = (id) => {
      if (id) this.panels.setTab('block');
      else if (this.panels.tab === 'block') this.panels.renderSide();
    };
    this.onZoom = (s) => ($('#zoom-label').textContent = `${Math.round(s * 100)}%`);

    let pending = null;
    this.model.addEventListener('change', (e) => {
      pending = pending === 'full' || e.detail.kind !== 'inspector' ? 'full' : 'inspector';
      queueMicrotask(() => {
        if (!pending) return;
        const kind = pending;
        pending = null;
        this.refresh(kind);
      });
    });
    this.model.addEventListener('commit', () => this.persist());
  }

  // -- core loop -----------------------------------------------------------
  refresh(kind = 'full') {
    const m = this.model;
    this.built = buildPolicy(m);
    this.nodeErrors = new Map();
    for (const e of this.built.errors) if (!this.nodeErrors.has(e.id)) this.nodeErrors.set(e.id, e.msg);
    this.result = null;
    if (this.built.policy) {
      const t0 = performance.now();
      this.result = compile({
        policy: this.built.policy,
        keys: this.built.keys,
        context: m.state.context,
        network: m.state.network,
        paths: this.built.paths.map((p) => p.assets),
        address_count: 5,
      });
      this.compileMs = performance.now() - t0;
      if (!this.result.ok) this.nodeErrors.set(m.state.rootId, this.result.error);
    }
    this.canvas.render();
    this.panels.render({ skipInspector: kind === 'inspector' });
    this.updateChrome();
  }

  updateChrome() {
    const s = this.model.state;
    $$('#ctx-toggle [data-ctx]').forEach((b) => b.classList.toggle('is-active', b.dataset.ctx === s.context));
    $('#network-select').value = s.network;
    $('#btn-undo').disabled = !this.model.history.length;
    $('#btn-redo').disabled = !this.model.future.length;
    $('#compile-time').textContent = this.result?.ok ? `${this.compileMs.toFixed(1)} ms` : '';
  }

  persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.model.state));
    } catch { /* quota or private mode */ }
    this.updateChrome();
  }

  // -- keys ----------------------------------------------------------------
  assignDemoKey(node, seed) {
    const r = generateKey(seed, this.model.state.network);
    if (!r.ok) return toast(r.error, 'warn');
    this.model.update(node.id, { key: r.key, seed });
  }

  setNetwork(network) {
    const m = this.model;
    m.state.network = network;
    for (const k of m.keyNodes()) {
      if (!k.seed) continue;
      const r = generateKey(k.seed, network);
      if (r.ok) k.key = r.key;
    }
    m.emit('global');
    m.commit();
  }

  nextKeyLabel(base = 'Key') {
    const labels = new Set(this.model.keyNodes().map((k) => k.label));
    if (base !== 'Key' && !labels.has(base)) return base;
    for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') if (!labels.has(`${base} ${c}`)) return `${base} ${c}`;
    return `${base} ${labels.size + 1}`;
  }

  // -- block creation ------------------------------------------------------
  createBlock(item, world, target) {
    const m = this.model;
    const data = { ...(item.data || {}) };
    if (item.type === 'key') data.label = this.nextKeyLabel(data.label || 'Key');
    if (item.type === 'after') data.value = 0;
    const n = m.addNode(item.type, world.x, world.y, data);
    if (item.type === 'key') this.assignDemoKey(n, randomHex(32));
    if (target) {
      const why = m.connect(n.id, target.parent, target.slot);
      if (why) toast(why, 'warn');
      else {
        // Park the new block to the left of the block it feeds, next to its slot.
        const p = m.node(target.parent);
        const slot = Math.min(target.slot, p.inputs.length - 1);
        m.move(n.id, p.x - 320, p.y + 60 + slot * 36);
      }
    }
    if (item.type === 'hash') {
      const preimage = randomHex(32);
      sha256Hex(hexToBytes(preimage)).then((hash) => (m.update(n.id, { hash, preimage }), m.commit()));
    }
    m.commit();
    this.canvas.select(n.id);
    return n;
  }

  deleteSelected() {
    const c = this.canvas;
    if (c.selectedWire) {
      const [pid, slot] = c.selectedWire.split(':');
      this.model.detach(pid, Number(slot));
      c.selectedWire = null;
      this.model.commit();
      return;
    }
    if (!c.selected) return;
    if (!this.model.removeNode(c.selected)) return toast('The wallet block can’t be removed', 'warn');
    c.select(null);
    this.model.commit();
  }

  duplicateSelected() {
    const n = this.model.node(this.canvas.selected);
    if (!n || n.type === 'wallet') return;
    const copy = JSON.parse(JSON.stringify(n));
    delete copy.id;
    if (hasInputs(copy)) {
      copy.inputs = [];
      if (copy.weights) copy.weights = [];
    }
    if (copy.type === 'key') copy.label = this.nextKeyLabel(copy.label.replace(/\s+[A-Z]$/, ''));
    const d = this.model.addNode(n.type, n.x + 30, n.y + 30, copy);
    if (d.type === 'key') this.assignDemoKey(d, randomHex(32));
    this.model.commit();
    this.canvas.select(d.id);
  }

  // -- templates & import --------------------------------------------------
  async loadTemplate(t) {
    const m = this.model;
    const network = m.state.network;
    m.state = Model.empty();
    m.state.network = network;
    m.state.context = t.context;
    const src = t.policy();
    let pendingSecrets = [];
    if (src) {
      const ast = parsePolicy(src);
      ({ pendingSecrets } = buildBlocks(m, ast, (ref) => {
        const [label, role] = t.keys[ref.ref] ?? [ref.ref, 'hardware'];
        const seed = seedHex(`miniscript-studio/${t.id}/${ref.ref}`);
        return { label, role, seed, key: generateKey(seed, network).key };
      }));
    }
    for (const hn of pendingSecrets) {
      hn.preimage = seedHex(`miniscript-studio/${t.id}/secret`);
      hn.hash = await sha256Hex(hexToBytes(hn.preimage));
    }
    m.root.name = t.name;
    this.panels.sim = { available: null, known: new Set(), elapsed: 0 };
    this.afterRebuild();
    $('#template-name').textContent = t.name;
  }

  afterRebuild() {
    this.canvas.selected = null;
    this.refresh();
    this.canvas.autoLayout({ animate: false });
    this.canvas.fit({ animate: false });
    this.model.commit();
    this.panels.setTab('paths');
  }

  importText(text) {
    const m = this.model;
    const s = text.trim();
    const network = m.state.network;
    let ast;
    let resolve;
    let uses = {};
    let context = m.state.context;
    const existing = new Map(m.keyNodes().map((k) => [k.label, k]));
    const demo = (ref) => {
      const seed = seedHex(`miniscript-studio/import/${ref}`);
      return { label: ref.replace(/_/g, ' '), role: 'hardware', seed, key: generateKey(seed, network).key };
    };
    if (/^(wsh|tr|sh|wpkh|pkh)\(/.test(s)) {
      const r = importDescriptor(s);
      if (!r.ok) throw new Error(r.error);
      context = r.context;
      ast = parsePolicy(r.policy);
      uses = r.uses;
      resolve = (ref) => ({ label: ref.ref, role: 'hardware', key: r.keys[uses[ref.ref] ?? ref.ref], seed: null });
    } else {
      try {
        ast = parsePolicy(s);
      } catch (policyErr) {
        const lifted = liftMiniscript(s, context);
        if (!lifted.ok) throw new Error(`Not a policy (${policyErr.message}) or miniscript (${lifted.error})`);
        ast = parsePolicy(lifted.policy);
      }
      resolve = (ref) => {
        if (ref.literal) return { label: this.nextKeyLabel(), role: 'hardware', key: ref.literal, seed: null };
        const e = existing.get(ref.ref) ?? existing.get(ref.ref.replace(/_/g, ' '));
        return e ? { label: e.label, role: e.role, key: e.key, seed: e.seed } : demo(ref.ref);
      };
    }
    const keep = { network, context, name: m.root.name };
    m.state = Model.empty();
    Object.assign(m.state, { network: keep.network, context: keep.context });
    m.root.name = keep.name;
    buildBlocks(m, ast, resolve, uses);
    this.afterRebuild();
    $('#template-name').textContent = 'Imported';
  }

  async share() {
    const data = await compress(JSON.stringify(this.model.state));
    const url = `${location.origin}${location.pathname}#s=${data}`;
    history.replaceState(null, '', url);
    copyText(url);
    toast('Share link copied: the whole design lives in the URL');
  }
}

// ---------------------------------------------------------------------------
// Chrome: palette, menus, dialogs, keyboard
// ---------------------------------------------------------------------------

function buildPalette(app) {
  const root = $('#palette-body');
  for (const group of PALETTE) {
    root.append(h('div', { class: 'palette__group' }, group.group));
    for (const item of group.items) {
      const fam = TYPES[item.type].family;
      const el = h('div', { class: `palette-item palette-item--${fam}`, tabindex: 0, role: 'button', title: item.desc });
      el.innerHTML = `<span class="palette-item__icon">${icon(item.icon)}</span>
        <span class="palette-item__text"><span class="palette-item__title">${item.title}</span><span class="palette-item__desc">${item.desc}</span></span>`;
      bindPaletteDrag(app, el, item);
      root.append(el);
    }
  }
}

function bindPaletteDrag(app, el, item) {
  let drag = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { sx: e.clientX, sy: e.clientY, ghost: null };
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.ghost && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 5) {
      drag.ghost = el.cloneNode(true);
      drag.ghost.classList.add('palette-ghost');
      document.body.append(drag.ghost);
      $('#canvas').classList.add('is-dropping');
    }
    if (drag.ghost) {
      drag.ghost.style.transform = `translate(${e.clientX - 20}px, ${e.clientY - 20}px)`;
      drag.ghost.style.display = 'none';
      const t = app.canvas.dropTarget(e.clientX, e.clientY);
      drag.ghost.style.display = '';
      $$('.node.is-target').forEach((n) => n.classList.remove('is-target'));
      t?.nodeEl.classList.add('is-target');
    }
  });
  const end = (e) => {
    if (!drag) return;
    const wasDrag = !!drag.ghost;
    drag.ghost?.remove();
    $('#canvas').classList.remove('is-dropping');
    $$('.node.is-target').forEach((n) => n.classList.remove('is-target'));
    drag = null;
    const canvasRect = $('#canvas').getBoundingClientRect();
    if (wasDrag) {
      const inside = e.clientX > canvasRect.left && e.clientX < canvasRect.right && e.clientY > canvasRect.top && e.clientY < canvasRect.bottom;
      if (!inside) return;
      const t = app.canvas.dropTarget(e.clientX, e.clientY);
      const w = app.canvas.toWorld(e.clientX, e.clientY);
      app.createBlock(item, { x: w.x - 120, y: w.y - 30 }, t ? { parent: t.parent, slot: t.slot } : null);
    } else {
      // Click: add near the view centre, wired into the selected logic block if any.
      const sel = app.model.node(app.canvas.selected);
      const into = sel && hasInputs(sel) && sel.type !== 'wallet' ? { parent: sel.id, slot: Infinity } : null;
      const c = app.canvas.toWorld(canvasRect.left + canvasRect.width / 2, canvasRect.top + canvasRect.height / 2);
      const base = into ? { x: sel.x - 330, y: sel.y + sel.inputs.length * 40 } : { x: c.x - 120 + Math.random() * 40, y: c.y - 60 + Math.random() * 40 };
      app.createBlock(item, base, into);
    }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const c = $('#canvas').getBoundingClientRect();
      app.createBlock(item, app.canvas.toWorld(c.left + c.width / 2 - 120, c.top + c.height / 2 - 60), null);
    }
  });
}

function buildTemplateMenu(app) {
  const menu = $('#template-menu');
  menu.innerHTML = TEMPLATES.map((t) => `
    <button class="menu-item" data-tpl="${t.id}">
      <span class="menu-item__title">${esc(t.name)} <span class="chip chip--muted">${t.context === 'tr' ? 'Taproot' : 'P2WSH'}</span></span>
      <span class="menu-item__desc">${esc(t.blurb)}</span>
    </button>`).join('');
  const btn = $('#btn-templates');
  const close = () => menu.classList.remove('is-open');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('is-open');
  });
  document.addEventListener('click', (e) => !menu.contains(e.target) && close());
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tpl]');
    if (!b) return;
    close();
    app.loadTemplate(TEMPLATES.find((t) => t.id === b.dataset.tpl));
  });
}

function bindDialogs(app) {
  const imp = $('#import-dialog');
  $('#btn-import').addEventListener('click', () => {
    $('#import-error').textContent = '';
    imp.showModal();
    $('#import-text').focus();
  });
  $('#import-go').addEventListener('click', (e) => {
    e.preventDefault();
    try {
      app.importText($('#import-text').value);
      imp.close();
      toast('Imported as blocks');
    } catch (err) {
      $('#import-error').textContent = err.message;
    }
  });
  $$('[data-example]').forEach((b) => b.addEventListener('click', () => ($('#import-text').value = b.dataset.example)));
  $('#btn-help').addEventListener('click', () => $('#help-dialog').showModal());
  $$('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  $$('dialog').forEach((d) => d.addEventListener('click', (e) => e.target === d && d.close()));
}

function bindToolbar(app) {
  $('#btn-undo').addEventListener('click', () => app.model.undo());
  $('#btn-redo').addEventListener('click', () => app.model.redo());
  $('#btn-share').addEventListener('click', () => app.share());
  $('#btn-layout').addEventListener('click', () => (app.canvas.autoLayout(), setTimeout(() => app.canvas.fit(), 460)));
  $('#btn-fit').addEventListener('click', () => app.canvas.fit());
  $('#btn-zoom-in').addEventListener('click', () => app.canvas.zoomBy(1.2));
  $('#btn-zoom-out').addEventListener('click', () => app.canvas.zoomBy(1 / 1.2));
  $$('#ctx-toggle [data-ctx]').forEach((b) =>
    b.addEventListener('click', () => {
      app.model.setGlobal({ context: b.dataset.ctx });
      app.model.commit();
    }));
  $('#network-select').addEventListener('change', (e) => app.setNetwork(e.target.value));

  window.addEventListener('keydown', (e) => {
    const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z' && !typing) {
      e.preventDefault();
      e.shiftKey ? app.model.redo() : app.model.undo();
    } else if (mod && e.key.toLowerCase() === 'y' && !typing) {
      e.preventDefault();
      app.model.redo();
    } else if (mod && e.key.toLowerCase() === 'd' && !typing) {
      e.preventDefault();
      app.duplicateSelected();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && !typing) {
      e.preventDefault();
      app.deleteSelected();
    } else if (e.key === 'Escape' && !typing) {
      app.canvas.select(null);
    } else if (!typing && !mod && e.key.toLowerCase() === 'l') {
      app.canvas.autoLayout();
      setTimeout(() => app.canvas.fit(), 460);
    } else if (!typing && !mod && e.key.toLowerCase() === 'f') {
      app.canvas.fit();
    }
  });
  window.addEventListener('resize', () => app.canvas.renderWires());
}

async function restore(app) {
  const m = /#s=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (m) {
    try {
      app.model.load(JSON.parse(await decompress(m[1])), { resetHistory: true });
      $('#template-name').textContent = app.model.root.name;
      return true;
    } catch (e) {
      toast('That share link could not be read', 'warn');
    }
  }
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      app.model.load(JSON.parse(saved), { resetHistory: true });
      $('#template-name').textContent = app.model.root.name;
      return true;
    } catch { /* fall through to default */ }
  }
  return false;
}

async function main() {
  try {
    await loadWasm();
  } catch (e) {
    $('#boot').innerHTML = `<div class="boot__err">Failed to load the WebAssembly module.<br><small>${esc(e.message)}</small></div>`;
    return;
  }
  const app = new App();
  window.studio = app;
  buildPalette(app);
  buildTemplateMenu(app);
  bindDialogs(app);
  bindToolbar(app);
  $('#version').textContent = version();

  if (await restore(app)) {
    app.refresh();
    requestAnimationFrame(() => app.canvas.fit({ animate: false }));
    app.panels.setTab('paths');
  } else {
    await app.loadTemplate(TEMPLATES[0]);
  }
  $('#boot').classList.add('is-done');
  setTimeout(() => $('#boot').remove(), 600);
}

main();
