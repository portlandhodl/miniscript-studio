// Node canvas: rendering, pan/zoom, dragging, wiring and tidy-tree layout.
import { TYPES, hasInputs } from './model.js';
import { nodeHTML } from './blocks.js';
import { toast } from './util.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const COL = 330;
const GAP = 28;

export class Canvas {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.model = app.model;
    this.view = { x: 0, y: 0, scale: 1 };
    this.selected = null;
    this.selectedWire = null;
    this.overlay = null;
    this.els = new Map();

    el.innerHTML = `<div class="world"><svg class="wires" width="1" height="1"><g class="wires__g"></g><path class="wire wire--temp" d="" /></svg><div class="nodes"></div></div>`;
    this.world = el.querySelector('.world');
    this.svg = el.querySelector('.wires');
    this.wireG = el.querySelector('.wires__g');
    this.temp = el.querySelector('.wire--temp');
    this.nodesEl = el.querySelector('.nodes');
    this.bind();
  }

  // -- coordinates ---------------------------------------------------------
  applyView() {
    const { x, y, scale } = this.view;
    this.world.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    this.el.style.setProperty('--grid-size', `${24 * scale}px`);
    this.el.style.backgroundPosition = `${x}px ${y}px`;
    this.app.onZoom?.(scale);
  }
  toWorld(cx, cy) {
    const r = this.el.getBoundingClientRect();
    return { x: (cx - r.left - this.view.x) / this.view.scale, y: (cy - r.top - this.view.y) / this.view.scale };
  }
  portPos(portEl) {
    const w = this.world.getBoundingClientRect();
    const p = portEl.getBoundingClientRect();
    return { x: (p.left + p.width / 2 - w.left) / this.view.scale, y: (p.top + p.height / 2 - w.top) / this.view.scale };
  }
  zoomAt(cx, cy, factor) {
    const r = this.el.getBoundingClientRect();
    const s = Math.min(2, Math.max(0.25, this.view.scale * factor));
    const k = s / this.view.scale;
    const px = cx - r.left;
    const py = cy - r.top;
    this.view.x = px - (px - this.view.x) * k;
    this.view.y = py - (py - this.view.y) * k;
    this.view.scale = s;
    this.applyView();
  }
  zoomBy(factor) {
    const r = this.el.getBoundingClientRect();
    this.zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
  }

  // -- rendering -----------------------------------------------------------
  render() {
    const nodes = this.model.nodes;
    for (const [id, el] of this.els) if (!nodes[id]) (el.remove(), this.els.delete(id));
    for (const n of Object.values(nodes)) {
      let el = this.els.get(n.id);
      if (!el) {
        el = document.createElement('div');
        el.dataset.id = n.id;
        this.nodesEl.append(el);
        this.els.set(n.id, el);
      }
      el.className = `node node--${TYPES[n.type].family} node--${n.type}`;
      el.classList.toggle('is-selected', this.selected === n.id);
      el.classList.toggle('has-error', this.app.nodeErrors?.has(n.id));
      el.innerHTML = nodeHTML(n, this.app);
      el.style.transform = `translate(${n.x}px, ${n.y}px)`;
    }
    this.applyOverlay();
    this.renderWires();
  }

  renderWires() {
    const frag = document.createDocumentFragment();
    for (const n of Object.values(this.model.nodes)) {
      if (!hasInputs(n)) continue;
      const pel = this.els.get(n.id);
      n.inputs.forEach((cid, i) => {
        const cel = this.els.get(cid);
        const slot = pel?.querySelector(`.slot[data-slot="${i}"] .port`);
        const out = cel?.querySelector('.port--out');
        if (!slot || !out) return;
        const a = this.portPos(out);
        const b = this.portPos(slot);
        const d = curve(a, b);
        const fam = TYPES[this.model.node(cid).type].family;
        const key = `${n.id}:${i}`;
        const g = document.createElementNS(SVGNS, 'g');
        g.dataset.wire = key;
        g.innerHTML = `<path class="wire__hit" d="${d}"/><path class="wire wire--${fam}" d="${d}"/>`;
        g.classList.toggle('is-selected', this.selectedWire === key);
        const ov = this.overlay;
        if (ov) {
          const on = ov.mode === 'path' ? ov.nodes.has(cid) && ov.nodes.has(n.id) : ov.sat.get(cid);
          g.classList.add(on ? 'is-lit' : 'is-dim');
        }
        frag.append(g);
      });
    }
    this.wireG.replaceChildren(frag);
  }

  /** Overlay modes: `{mode:'path', nodes:Set}` or `{mode:'sim', sat:Map}` or null. */
  setOverlay(ov) {
    this.overlay = ov;
    this.applyOverlay();
    this.renderWires();
  }
  applyOverlay() {
    const ov = this.overlay;
    this.el.classList.toggle('has-overlay', !!ov);
    for (const [id, el] of this.els) {
      el.classList.remove('is-lit', 'is-dim', 'is-sat', 'is-unsat');
      if (!ov) continue;
      if (ov.mode === 'path') el.classList.add(ov.nodes.has(id) ? 'is-lit' : 'is-dim');
      else el.classList.add(ov.sat.get(id) ? 'is-sat' : 'is-unsat');
    }
    // Decay ladders: mark the rung that applies now (or at the simulated time).
    const elapsed = ov?.mode === 'sim' ? ov.elapsed : 0;
    for (const ladder of this.nodesEl.querySelectorAll('.ladder')) {
      const rows = [...ladder.querySelectorAll('.ladder__row')];
      const cur = rows.filter((r) => Number(r.dataset.t) <= elapsed).pop();
      rows.forEach((r) => r.classList.toggle('is-current', r === cur));
    }
  }

  select(id) {
    this.selected = id;
    this.selectedWire = null;
    for (const [nid, el] of this.els) el.classList.toggle('is-selected', nid === id);
    this.renderWires();
    this.app.onSelect?.(id);
  }

  // -- interaction ---------------------------------------------------------
  bind() {
    const el = this.el;
    let drag = null;

    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      this.zoomAt(e.clientX, e.clientY, factor);
    }, { passive: false });

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.button !== 1) return;
      const t = e.target;
      const nodeEl = t.closest('.node');
      const id = nodeEl?.dataset.id;

      if (t.closest('.port--out') && id) {
        drag = { mode: 'wire', child: id, start: this.portPos(t.closest('.port--out')) };
        this.beginWiring(id);
      } else if (t.closest('.slot.is-filled .port') && id) {
        // Pick a wire up by its input end and re-route it.
        const slot = Number(t.closest('.slot').dataset.slot);
        const child = this.model.node(id).inputs[slot];
        const outEl = this.els.get(child)?.querySelector('.port--out');
        this.model.detach(id, slot);
        drag = { mode: 'wire', child, start: outEl ? this.portPos(outEl) : this.toWorld(e.clientX, e.clientY), detached: true };
        this.beginWiring(child);
      } else if (t.closest('.no-drag, button, input, select, textarea')) {
        return;
      } else if (nodeEl) {
        const n = this.model.node(id);
        const p = this.toWorld(e.clientX, e.clientY);
        drag = { mode: 'move', id, dx: p.x - n.x, dy: p.y - n.y, moved: false };
        if (this.selected !== id) this.select(id);
      } else if (t.closest('[data-wire]')) {
        this.selectedWire = t.closest('[data-wire]').dataset.wire;
        this.selected = null;
        this.app.onSelect?.(null);
        this.render();
        return;
      } else {
        drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, vx: this.view.x, vy: this.view.y, moved: false };
        el.classList.add('is-panning');
      }
      el.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (drag.mode === 'pan') {
        drag.moved ||= Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 3;
        this.view.x = drag.vx + e.clientX - drag.sx;
        this.view.y = drag.vy + e.clientY - drag.sy;
        this.applyView();
      } else if (drag.mode === 'move') {
        const p = this.toWorld(e.clientX, e.clientY);
        drag.moved = true;
        this.model.move(drag.id, p.x - drag.dx, p.y - drag.dy);
        const n = this.model.node(drag.id);
        this.els.get(drag.id).style.transform = `translate(${n.x}px, ${n.y}px)`;
        this.renderWires();
      } else if (drag.mode === 'wire') {
        const p = this.toWorld(e.clientX, e.clientY);
        this.temp.setAttribute('d', curve(drag.start, p));
        this.markDropTarget(e.clientX, e.clientY);
      }
    });

    const end = (e) => {
      if (!drag) return;
      el.classList.remove('is-panning');
      if (drag.mode === 'pan' && !drag.moved) {
        this.selectedWire = null;
        this.select(null);
      } else if (drag.mode === 'move' && drag.moved) {
        this.model.commit();
      } else if (drag.mode === 'wire') {
        const target = this.dropTarget(e.clientX, e.clientY);
        this.endWiring();
        if (target) {
          const why = this.model.connect(drag.child, target.parent, target.slot);
          if (why) toast(why, 'warn');
        }
        this.model.commit();
      }
      drag = null;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);

    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      const id = e.target.closest('.node')?.dataset.id;
      if (!btn || !id) return;
      if (btn.dataset.act === 'own') return this.app.showOwnership(id);
      const n = this.model.node(id);
      if (btn.dataset.act === 'k-' && n.k > 1) this.model.update(id, { k: n.k - 1 });
      if (btn.dataset.act === 'k+' && n.k < n.inputs.length) this.model.update(id, { k: n.k + 1 });
      this.model.commit();
    });

    el.addEventListener('dblclick', (e) => {
      const g = e.target.closest('[data-wire]');
      if (!g) return;
      const [pid, slot] = g.dataset.wire.split(':');
      this.model.detach(pid, Number(slot));
      this.model.commit();
    });
  }

  beginWiring(childId) {
    this.el.classList.add('is-wiring');
    for (const [id, el] of this.els) {
      el.classList.toggle('can-drop', hasInputs(this.model.node(id)) && !this.model.canConnect(childId, id));
    }
    this.wiringChild = childId;
  }
  endWiring() {
    this.el.classList.remove('is-wiring');
    this.temp.setAttribute('d', '');
    for (const el of this.els.values()) el.classList.remove('can-drop', 'is-target');
    this.nodesEl.querySelectorAll('.slot.is-target').forEach((s) => s.classList.remove('is-target'));
  }

  /** Finds the operator (and slot) under a screen point. */
  dropTarget(cx, cy) {
    const hit = document.elementFromPoint(cx, cy);
    const nodeEl = hit?.closest('.node');
    if (!nodeEl) return null;
    const n = this.model.node(nodeEl.dataset.id);
    if (!hasInputs(n)) return null;
    const slotEl = hit.closest('.slot');
    return { parent: n.id, slot: slotEl ? Number(slotEl.dataset.slot) : n.inputs.length, slotEl, nodeEl };
  }
  markDropTarget(cx, cy) {
    this.nodesEl.querySelectorAll('.is-target').forEach((s) => s.classList.remove('is-target'));
    const t = this.dropTarget(cx, cy);
    if (t && t.nodeEl.classList.contains('can-drop')) {
      t.nodeEl.classList.add('is-target');
      t.slotEl?.classList.add('is-target');
    }
  }

  // -- layout --------------------------------------------------------------
  autoLayout({ animate = true } = {}) {
    const m = this.model;
    const size = (id) => {
      const el = this.els.get(id);
      return { w: el?.offsetWidth || 240, h: el?.offsetHeight || 120 };
    };
    const placed = new Set();
    const pos = {};
    const colBottom = [];
    let cursor = 0;
    // Tidy tree, right to left: leaves stack downwards, parents centre on their children.
    // Shared keys are laid out next to the first block that uses them.
    const place = (id, depth) => {
      placed.add(id);
      const n = m.node(id);
      const centers = [];
      if (hasInputs(n)) for (const c of n.inputs) if (!placed.has(c) && m.node(c)) centers.push(place(c, depth + 1));
      const { h } = size(id);
      let top = centers.length ? (centers[0] + centers[centers.length - 1]) / 2 - h / 2 : cursor;
      top = Math.max(top, colBottom[depth] ?? -Infinity);
      colBottom[depth] = top + h + GAP;
      if (!centers.length) cursor = top + h + GAP;
      pos[id] = { x: -depth * COL, y: top };
      return top + h / 2;
    };
    place(m.state.rootId, 0);
    let ox = 0;
    for (const n of Object.values(m.nodes)) {
      if (placed.has(n.id)) continue;
      pos[n.id] = { x: -COL * 3 + ox, y: cursor + 40 };
      ox += size(n.id).w + GAP;
    }
    if (animate) {
      this.nodesEl.classList.add('is-animating');
      const t0 = performance.now();
      const tick = (t) => {
        this.renderWires();
        if (t - t0 < 450) requestAnimationFrame(tick);
        else this.nodesEl.classList.remove('is-animating');
      };
      requestAnimationFrame(tick);
    }
    for (const [id, p] of Object.entries(pos)) {
      m.move(id, p.x, p.y);
      const el = this.els.get(id);
      if (el) el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
    }
    this.renderWires();
    m.commit();
  }

  fit({ animate = true } = {}) {
    const nodes = Object.values(this.model.nodes);
    if (!nodes.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) {
      const el = this.els.get(n.id);
      x0 = Math.min(x0, n.x);
      y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x + (el?.offsetWidth || 240));
      y1 = Math.max(y1, n.y + (el?.offsetHeight || 120));
    }
    const r = this.el.getBoundingClientRect();
    const pad = 60;
    const s = Math.min(1.1, Math.max(0.3, Math.min((r.width - pad * 2) / (x1 - x0), (r.height - pad * 2) / (y1 - y0))));
    this.view.scale = s;
    this.view.x = (r.width - (x1 - x0) * s) / 2 - x0 * s;
    this.view.y = (r.height - (y1 - y0) * s) / 2 - y0 * s;
    if (animate) {
      this.world.classList.add('is-animating');
      setTimeout(() => this.world.classList.remove('is-animating'), 400);
    }
    this.applyView();
  }
}

function curve(a, b) {
  const dx = Math.max(60, Math.abs(b.x - a.x) * 0.5);
  return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
}
