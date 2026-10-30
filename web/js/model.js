// Graph model: blocks (nodes), their ordered inputs, undo history and persistence.

export const TYPES = {
  wallet: { title: 'Wallet', family: 'wallet', icon: 'wallet', multi: false, maxInputs: 1 },
  key: { title: 'Key', family: 'key', icon: 'key' },
  older: { title: 'Relative timelock', family: 'time', icon: 'clock' },
  after: { title: 'Absolute timelock', family: 'time', icon: 'calendar' },
  hash: { title: 'Hashlock', family: 'hash', icon: 'hash' },
  and: { title: 'All of', family: 'logic', icon: 'and', maxInputs: Infinity },
  or: { title: 'Any of', family: 'logic', icon: 'or', maxInputs: Infinity },
  thresh: { title: 'Threshold', family: 'logic', icon: 'thresh', maxInputs: Infinity },
};

export const hasInputs = (n) => n && 'inputs' in n;

const DEFAULTS = {
  wallet: () => ({ name: 'My vault', inputs: [] }),
  key: () => ({ label: 'Key', role: 'hardware', key: '', seed: null }),
  older: () => ({ value: 4320 }), // ≈ 30 days
  after: () => ({ value: 0 }),
  hash: () => ({ hash: '', preimage: '' }),
  and: () => ({ inputs: [] }),
  or: () => ({ inputs: [], weights: [] }),
  thresh: () => ({ inputs: [], k: 2 }),
};

let idCounter = 1;
const newId = (type) => `${type}_${(idCounter++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export class Model extends EventTarget {
  constructor() {
    super();
    this.state = Model.empty();
    this.history = [];
    this.future = [];
    this.lastSnapshot = JSON.stringify(this.state);
  }

  static empty() {
    const wallet = { id: 'wallet', type: 'wallet', x: 640, y: 260, ...DEFAULTS.wallet() };
    return { version: 1, context: 'wsh', network: 'signet', nodes: { wallet }, rootId: 'wallet' };
  }

  get nodes() { return this.state.nodes; }
  get root() { return this.state.nodes[this.state.rootId]; }
  node(id) { return this.state.nodes[id]; }

  emit(kind = 'structure') { this.dispatchEvent(new CustomEvent('change', { detail: { kind } })); }

  // -- history -------------------------------------------------------------
  commit() {
    const snap = JSON.stringify(this.state);
    if (snap === this.lastSnapshot) return;
    this.history.push(this.lastSnapshot);
    if (this.history.length > 150) this.history.shift();
    this.future = [];
    this.lastSnapshot = snap;
    this.dispatchEvent(new CustomEvent('commit'));
  }
  undo() {
    if (!this.history.length) return;
    this.future.push(this.lastSnapshot);
    this.lastSnapshot = this.history.pop();
    this.state = JSON.parse(this.lastSnapshot);
    this.emit('history');
    this.dispatchEvent(new CustomEvent('commit'));
  }
  redo() {
    if (!this.future.length) return;
    this.history.push(this.lastSnapshot);
    this.lastSnapshot = this.future.pop();
    this.state = JSON.parse(this.lastSnapshot);
    this.emit('history');
    this.dispatchEvent(new CustomEvent('commit'));
  }
  load(state, { resetHistory = false } = {}) {
    for (const n of Object.values(state.nodes)) if (hasInputs(n)) n.inputs = n.inputs.filter((c) => state.nodes[c]);
    this.state = state;
    if (resetHistory) this.clearHistory();
    else this.commit();
    this.emit('load');
  }

  clearHistory() {
    this.history = [];
    this.future = [];
    this.lastSnapshot = JSON.stringify(this.state);
  }

  // -- mutation ------------------------------------------------------------
  addNode(type, x, y, data = {}) {
    const id = data.id || newId(type);
    const n = { id, type, x: Math.round(x), y: Math.round(y), ...DEFAULTS[type](), ...data };
    this.state.nodes[id] = n;
    this.emit();
    return n;
  }

  update(id, patch, kind = 'data') {
    Object.assign(this.state.nodes[id], patch);
    this.emit(kind);
  }

  setGlobal(patch) {
    Object.assign(this.state, patch);
    this.emit('global');
  }

  move(id, x, y) {
    const n = this.state.nodes[id];
    n.x = Math.round(x);
    n.y = Math.round(y);
  }

  removeNode(id) {
    if (id === this.state.rootId) return false;
    for (const p of this.parentsOf(id)) this.detach(p.id, p.inputs.indexOf(id), false);
    delete this.state.nodes[id];
    this.emit();
    return true;
  }

  parentsOf(id) {
    return Object.values(this.state.nodes).filter((n) => hasInputs(n) && n.inputs.includes(id));
  }

  isAncestor(maybeAncestor, id, seen = new Set()) {
    if (maybeAncestor === id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return this.parentsOf(id).some((p) => this.isAncestor(maybeAncestor, p.id, seen));
  }

  /** Can `childId` feed into `parentId`? Returns an error string or null. */
  canConnect(childId, parentId) {
    const c = this.node(childId);
    const p = this.node(parentId);
    if (!c || !p || !hasInputs(p)) return 'That block has no inputs';
    if (c.type === 'wallet') return 'The wallet is the final output';
    if (childId === parentId || this.isAncestor(childId, parentId)) return 'That would create a loop';
    if (c.type === 'key' && p.inputs.includes(childId)) return 'This key is already an input of that block';
    return null;
  }

  connect(childId, parentId, slot = Infinity) {
    const why = this.canConnect(childId, parentId);
    if (why) return why;
    const c = this.node(childId);
    const p = this.node(parentId);
    // Keys represent signing devices and may appear in several spending paths.
    // Every other block lives in exactly one place in the tree.
    if (c.type !== 'key') {
      for (const old of this.parentsOf(childId)) {
        const i = old.inputs.indexOf(childId);
        if (old.id === parentId && i < slot) slot--;
        this.detach(old.id, i, false);
      }
    }
    const max = TYPES[p.type].maxInputs ?? Infinity;
    if (p.inputs.length >= max) this.detach(parentId, p.inputs.length - 1, false);
    slot = Math.min(slot, p.inputs.length);
    p.inputs.splice(slot, 0, childId);
    if (p.type === 'or') p.weights.splice(slot, 0, 1);
    this.emit();
    return null;
  }

  detach(parentId, slot, emit = true) {
    const p = this.node(parentId);
    if (!p || slot < 0 || slot >= p.inputs.length) return;
    p.inputs.splice(slot, 1);
    if (p.type === 'or') p.weights.splice(slot, 1);
    if (p.type === 'thresh') p.k = Math.max(1, Math.min(p.k, p.inputs.length || 1));
    if (emit) this.emit();
  }

  /** Every node reachable from the wallet, depth first. */
  reachable() {
    const out = new Set();
    const walk = (id) => {
      if (out.has(id)) return;
      out.add(id);
      const n = this.node(id);
      if (hasInputs(n)) n.inputs.forEach(walk);
    };
    walk(this.state.rootId);
    return out;
  }

  keyNodes() {
    return Object.values(this.state.nodes).filter((n) => n.type === 'key');
  }
}
