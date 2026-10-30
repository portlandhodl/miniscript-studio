// Key ownership: loads a Key Ownership Manifest (docs/key-ownership-spec.md) into WASM
// memory and classifies every key in the design. The manifest itself is never persisted or
// shared; only the user's "we control" selection is remembered, keyed by the file's hash.
import { komLoad } from './wasm.js';

const SELECTION_KEY = 'miniscript-studio:kom-selection';
export const SPEC_URL = 'https://github.com/portlandhodl/miniscript-studio/blob/main/docs/key-ownership-spec.md';

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export class Ownership {
  constructor() {
    this.manifest = null;
    this.summary = null;
    this.name = '';
    this.hash = '';
    this.controlled = new Set();
    this.cache = new Map();
  }

  get loaded() {
    return !!this.manifest;
  }

  /** Validates and loads a manifest file; throws with the validator's message on any problem. */
  async load(file) {
    const bytes = await file.arrayBuffer();
    const hash = hex(await crypto.subtle.digest('SHA-256', bytes));
    let manifest;
    try {
      manifest = komLoad(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch (e) {
      throw new Error(typeof e === 'string' ? e : e.message || 'Not a valid manifest');
    }
    this.clear();
    this.manifest = manifest;
    this.summary = JSON.parse(manifest.summary());
    this.name = file.name;
    this.hash = hash;
    this.controlled = new Set(this.savedSelection()[hash] ?? []);
  }

  clear() {
    this.manifest?.free();
    this.manifest = null;
    this.summary = null;
    this.controlled = new Set();
    this.cache.clear();
  }

  setControlled(id, on) {
    if (on) this.controlled.add(id);
    else this.controlled.delete(id);
    this.cache.clear();
    const all = this.savedSelection();
    delete all[this.hash];
    all[this.hash] = [...this.controlled];
    const keep = Object.fromEntries(Object.entries(all).slice(-5));
    try {
      localStorage.setItem(SELECTION_KEY, JSON.stringify(keep));
    } catch { /* quota or private mode */ }
  }

  savedSelection() {
    try {
      return JSON.parse(localStorage.getItem(SELECTION_KEY)) ?? {};
    } catch {
      return {};
    }
  }

  /**
   * Classifies a descriptor key: `owned`, `known`, `conflict`, `device` or `unknown`
   * (null when no manifest is loaded or the block has no key).
   */
  match(key) {
    if (!this.manifest || !key) return null;
    if (this.cache.has(key)) return this.cache.get(key);
    const m = JSON.parse(this.manifest.matchKey(key));
    let r;
    if (m.result === 'match') {
      r = { kind: this.controlled.has(m.signer.id) ? 'owned' : 'known', signer: m.signer, path: m.path, account: m.account, status: m.status, originMismatch: m.originMismatch };
    } else if (m.result === 'conflict') {
      r = { kind: 'conflict', signer: m.claimed.signer, path: m.claimed.path };
    } else if (m.result === 'known-device') {
      r = { kind: 'device', signer: m.signer };
    } else {
      r = { kind: 'unknown' };
    }
    this.cache.set(key, r);
    return r;
  }
}

export const OWNERSHIP_CHIPS = {
  owned: ['chip--ok', 'ours'],
  known: ['chip--key', 'known'],
  conflict: ['chip--bad', 'conflict'],
  device: ['chip--warn', 'known device'],
  unknown: ['chip--muted', 'unknown'],
};

/** One-line explanation of a match, for tooltips and the inspector. */
export function describeMatch(r) {
  const who = r.signer ? `${r.signer.label}${r.signer.group ? ` (${r.signer.group})` : ''}` : '';
  switch (r.kind) {
    case 'owned': return `Ours: ${who}`;
    case 'known': return `Known signer you don’t control: ${who}`;
    case 'conflict': return `Claims to be ${who} at ${r.path}, but the key material does not match. Possible key substitution.`;
    case 'device': return `Same device as ${who}, but this account is not in the manifest.`;
    default: return 'Not in the manifest.';
  }
}
