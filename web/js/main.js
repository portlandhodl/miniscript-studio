// Miniscript Studio: application bootstrap and orchestration.
import { loadWasm, compile, generateKey, importDescriptor, liftMiniscript, parseKey, version } from './wasm.js';
import { Model, TYPES, hasInputs } from './model.js';
import { Canvas } from './canvas.js';
import { Panels } from './panels.js';
import { PALETTE } from './blocks.js';
import { buildPolicy } from './policy.js';
import { parsePolicy, buildBlocks } from './parse.js';
import { TEMPLATES } from './templates.js';
import { KeyDialog } from './keydialog.js';
import { lifehashImg } from './lifehash.js';
import { icon, ROLES } from './icons.js';
import { $, $$, h, esc, toast, copyText, seedHex, randomHex, hexToBytes, sha256Hex, compress, decompress, privateMaterial } from './util.js';

const STORAGE_KEY = 'miniscript-studio:v1';
const DEMO_STORAGE_KEY = 'miniscript-studio:demo:v1';
const DEMO_PARAM = 'demo';
const truthy = (v) => /^(1|true|yes|on)$/i.test(v ?? '');
const hasDemoKeys = (state) => Object.values(state.nodes).some((n) => n.type === 'key' && n.seed);

function readState(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? null;
  } catch {
    return null;
  }
}

class App {
  constructor() {
    this.model = new Model();
    this.nodeErrors = new Map();
    this.built = null;
    this.result = null;
    this.canvas = new Canvas($('#canvas'), this);
    this.panels = new Panels(this);
    this.keys = new KeyDialog(this);
    // Demo mode: public-seed demo keys and related shortcuts. Off by default.
    this.demo = false;
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
      localStorage.setItem(this.storageKey(), JSON.stringify(this.model.state));
    } catch { /* quota or private mode */ }
    this.updateChrome();
  }

  // -- demo mode -----------------------------------------------------------
  // Demo mode is a separate workspace with its own saved design, so demo keys never
  // mix with the user's own: leaving it brings back their previous design (or a blank one).
  storageKey() {
    return this.demo ? DEMO_STORAGE_KEY : STORAGE_KEY;
  }

  async setDemo(on, { open = true } = {}) {
    on = !!on;
    const changed = on !== this.demo;
    if (open && changed) this.persist();
    this.demo = on;
    document.body.classList.toggle('is-demo', on);
    $('#demo-banner').hidden = !on;
    const btn = $('#btn-demo');
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-pressed', String(on));
    const url = new URL(location.href);
    if (on) url.searchParams.set(DEMO_PARAM, 'true');
    else url.searchParams.delete(DEMO_PARAM);
    if (open && changed) url.hash = '';
    history.replaceState(null, '', url);
    buildPalette(this);
    // Templates are worked examples built on demo keys, so they live in demo mode only.
    $('#template-wrap').hidden = !on;
    $('#template-menu').classList.remove('is-open');
    if (open && changed) {
      await this.openWorkspace();
      toast(on ? 'Demo workspace: demo keys are public, never fund them' : 'Back to your workspace');
    }
  }

  /** Shows the saved design for the current mode, or its starting point. */
  async openWorkspace() {
    const saved = readState(this.storageKey());
    if (saved) {
      this.model.load(saved, { resetHistory: true });
      this.showWorkspace();
      return;
    }
    // Professional default: an empty wallet. Demo mode opens on a worked example.
    await this.loadTemplate(this.demo ? TEMPLATES[0] : TEMPLATES.find((t) => t.id === 'blank'));
    this.model.clearHistory();
    this.updateChrome();
  }

  showWorkspace() {
    this.canvas.selected = null;
    this.panels.sim = { available: null, known: new Set(), elapsed: 0 };
    $('#template-name').textContent = this.model.root.name;
    this.refresh();
    requestAnimationFrame(() => this.canvas.fit({ animate: false }));
    this.panels.setTab('paths');
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
    if (item.type === 'key' && !item.askXpub && this.demo) this.assignDemoKey(n, randomHex(32));
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
    if (item.askXpub) this.keys.open(n.id);
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
    if (copy.type === 'key') {
      // A duplicate is a different device: it never inherits the original's key.
      copy.label = this.nextKeyLabel(copy.label.replace(/\s+[A-Z]$/, ''));
      Object.assign(copy, { key: '', seed: null, origin: null });
    }
    const d = this.model.addNode(n.type, n.x + 30, n.y + 30, copy);
    if (d.type === 'key' && this.demo) this.assignDemoKey(d, randomHex(32));
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
        if (!this.demo) return { label, role, seed: null, key: '' };
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
    if (!this.demo && m.keyNodes().length) toast('Template loaded: add an xpub to each key block');
  }

  /** Resets the current workspace to exactly what a first visit shows. Undoable. */
  clearWorkspace() {
    const m = this.model;
    const blank = TEMPLATES.find((t) => t.id === 'blank');
    const fresh = Model.empty();
    fresh.context = blank.context;
    fresh.nodes[fresh.rootId].name = blank.name;
    const same = (a, b) => JSON.stringify({ ...a, nodes: null }) === JSON.stringify({ ...b, nodes: null })
      && Object.keys(a.nodes).length === 1 && a.nodes[a.rootId].name === b.nodes[b.rootId].name;
    if (same(m.state, fresh)) return toast('The workspace is already empty');
    m.state = fresh;
    this.panels.sim = { available: null, known: new Set(), elapsed: 0 };
    this.afterRebuild();
    $('#template-name').textContent = blank.name;
    toast('Workspace cleared. Undo (⌘Z) restores it');
  }

  afterRebuild() {
    this.canvas.selected = null;
    this.refresh();
    this.canvas.autoLayout({ animate: false });
    this.canvas.fit({ animate: false });
    this.model.commit();
    this.panels.setTab('paths');
  }

  /**
   * Parses import text without touching the model. Returns everything needed to build
   * the blocks, plus the distinct signers so the user can name them first.
   */
  prepareImport(text) {
    const m = this.model;
    const s = text.trim();
    const network = m.state.network;
    let ast;
    let resolve;
    let uses = {};
    let context = m.state.context;
    const existing = new Map(m.keyNodes().map((k) => [k.label, k]));
    const unnamed = (ref) => {
      const label = ref.replace(/_/g, ' ');
      if (!this.demo) return { label, role: 'hardware', seed: null, key: '' };
      const seed = seedHex(`miniscript-studio/import/${ref}`);
      return { label, role: 'hardware', seed, key: generateKey(seed, network).key };
    };
    if (/^(wsh|tr|sh|wpkh|pkh)\(/.test(s)) {
      const r = importDescriptor(s);
      if (!r.ok) throw new Error(r.error);
      context = r.context;
      ast = parsePolicy(r.policy);
      uses = r.uses;
      resolve = (ref) => {
        const block = uses[ref.ref] ?? ref.ref;
        return { label: block.replace(/^Key(\d+)$/, 'Key $1'), role: 'hardware', key: r.keys[block], seed: null };
      };
    } else {
      try {
        ast = parsePolicy(s);
      } catch (policyErr) {
        const lifted = liftMiniscript(s, context);
        if (!lifted.ok) throw new Error(`Not a policy (${policyErr.message}) or miniscript (${lifted.error})`);
        ast = parsePolicy(lifted.policy);
      }
      let literals = 0;
      resolve = (ref) => {
        if (ref.literal) return { label: `Key ${++literals}`, role: 'hardware', key: ref.literal, seed: null };
        const e = existing.get(ref.ref) ?? existing.get(ref.ref.replace(/_/g, ' '));
        return e ? { label: e.label, role: e.role, key: e.key, seed: e.seed } : unnamed(ref.ref);
      };
    }
    // Distinct signers in first-use order, keyed the same way buildBlocks dedupes them.
    const signers = new Map();
    const walk = (n) => {
      if (n.type === 'key') {
        const id = n.literal ?? uses[n.ref] ?? n.ref;
        if (!signers.has(id)) signers.set(id, resolve(n));
      }
      n.children?.forEach(walk);
    };
    walk(ast);
    return { ast, uses, context, network, signers };
  }

  /** Rebuilds the canvas from a prepared import; `names` maps signer id to `{ label, role }`. */
  applyImport(prep, names = {}) {
    const m = this.model;
    const keep = { network: prep.network, context: prep.context, name: m.root.name };
    m.state = Model.empty();
    Object.assign(m.state, { network: keep.network, context: keep.context });
    m.root.name = keep.name;
    buildBlocks(m, prep.ast, (n) => {
      const id = n.literal ?? prep.uses[n.ref] ?? n.ref;
      return { ...prep.signers.get(id), ...names[id] };
    }, prep.uses);
    this.afterRebuild();
    $('#template-name').textContent = 'Imported';
  }

  async share() {
    const data = await compress(JSON.stringify(this.model.state));
    // Only the copied link carries the design; this tab keeps saving to local storage.
    const url = new URL(location.href);
    url.hash = `s=${data}`;
    copyText(url.href);
    toast(`Share link copied: the whole design lives in the URL${this.demo ? ' (opens in demo mode)' : ''}`);
  }
}

// ---------------------------------------------------------------------------
// Chrome: palette, menus, dialogs, keyboard
// ---------------------------------------------------------------------------

function bindDemo(app) {
  $('#btn-demo').addEventListener('click', () => app.setDemo(!app.demo));
  $('#demo-exit').addEventListener('click', () => app.setDemo(false));
}

function buildPalette(app) {
  const root = $('#palette-body');
  root.replaceChildren();
  for (const group of PALETTE) {
    root.append(h('div', { class: 'palette__group' }, group.group));
    for (const item of group.items) {
      const fam = TYPES[item.type].family;
      const desc = (app.demo && item.demoDesc) || item.desc;
      const el = h('div', { class: `palette-item palette-item--${fam}`, tabindex: 0, role: 'button', title: desc });
      el.innerHTML = `<span class="palette-item__icon">${icon(item.icon)}</span>
        <span class="palette-item__text"><span class="palette-item__title">${item.title}</span><span class="palette-item__desc">${desc}</span></span>`;
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
  let prep = null;
  const step = (keys) => {
    $('#import-step-text').hidden = keys;
    $('#import-step-keys').hidden = !keys;
    $('#import-back').hidden = !keys;
    $('#import-go').textContent = keys ? 'Import as blocks' : 'Continue';
  };
  $('#btn-import').addEventListener('click', () => {
    $('#import-error').textContent = '';
    prep = null;
    step(false);
    imp.showModal();
    $('#import-text').focus();
  });
  $('#import-back').addEventListener('click', () => {
    $('#import-error').textContent = '';
    prep = null;
    step(false);
  });
  const finish = (names) => {
    app.applyImport(prep, names);
    imp.close();
    toast('Imported as blocks');
  };
  $('#import-go').addEventListener('click', (e) => {
    e.preventDefault();
    $('#import-error').textContent = '';
    if (prep) {
      const names = {};
      $$('#import-keys [data-signer]').forEach((row) => {
        const label = row.querySelector('[data-f="label"]').value.trim();
        names[row.dataset.signer] = { role: row.querySelector('[data-f="role"]').value, ...(label && { label }) };
      });
      return finish(names);
    }
    const secret = privateMaterial($('#import-text').value);
    if (secret) {
      $('#import-text').value = '';
      $('#import-error').textContent = `That contained ${secret}. It was cleared. Import public descriptors only (xpubs, never xprvs or seed words).`;
      return;
    }
    try {
      prep = app.prepareImport($('#import-text').value);
    } catch (err) {
      $('#import-error').textContent = err.message;
      return;
    }
    if (!prep.signers.size) return finish();
    const roles = (sel) => Object.entries(ROLES).map(([k, r]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${r.label}</option>`).join('');
    $('#import-keys').innerHTML = [...prep.signers].map(([id, k]) => {
      const info = k.key ? parseKey(k.key) : null;
      const meta = info?.ok ? `fp ${info.fingerprint}` : k.key ? 'unrecognised key' : 'no key yet';
      return `<div class="import-key" data-signer="${esc(id)}">
        ${lifehashImg(k.key, 'lifehash--lg')}
        <div class="import-key__body">
          <div class="import-key__meta mono">${esc(meta)}${k.seed ? ' · <span class="chip chip--muted">demo</span>' : ''}</div>
          <div class="import-key__fields">
            <input data-f="label" value="${esc(k.label)}" maxlength="24" spellcheck="false" aria-label="Key name">
            <select data-f="role" aria-label="Role">${roles(k.role)}</select>
          </div>
        </div>
      </div>`;
    }).join('');
    step(true);
    $('#import-keys [data-f="label"]')?.select();
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
  $('#btn-clear').addEventListener('click', () => app.clearWorkspace());
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

/** Loads a share link if present, otherwise the saved workspace for the current mode. */
async function restore(app) {
  // Designs saved before demo mode existed may hold demo keys: move them to the demo workspace.
  const legacy = readState(STORAGE_KEY);
  if (legacy && hasDemoKeys(legacy)) {
    if (!localStorage.getItem(DEMO_STORAGE_KEY)) localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(legacy));
    localStorage.removeItem(STORAGE_KEY);
  }
  const m = /#s=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (m) {
    try {
      const state = JSON.parse(await decompress(m[1]));
      // A shared design built on demo keys always opens in demo mode, behind the warning.
      if (hasDemoKeys(state)) await app.setDemo(true, { open: false });
      app.model.load(state, { resetHistory: true });
      app.persist();
      // The link has been copied into the workspace; drop it so reloads keep later edits.
      history.replaceState(null, '', location.pathname + location.search);
      return true;
    } catch (e) {
      toast('That share link could not be read', 'warn');
    }
  }
  const saved = readState(app.storageKey());
  if (!saved) return false;
  app.model.load(saved, { resetHistory: true });
  return true;
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
  bindDemo(app);
  buildTemplateMenu(app);
  bindDialogs(app);
  bindToolbar(app);
  await app.setDemo(truthy(new URLSearchParams(location.search).get(DEMO_PARAM)), { open: false });
  $('#version').textContent = version();

  if (await restore(app)) app.showWorkspace();
  else await app.openWorkspace();
  $('#boot').classList.add('is-done');
  setTimeout(() => $('#boot').remove(), 600);
}

main();
