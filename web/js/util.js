// Small shared helpers: time math, formatting, encoding.

export const BLOCK_SECONDS = 600;
export const SEQUENCE_TYPE_FLAG = 1 << 22; // BIP-68: relative lock measured in 512s units
export const LOCKTIME_THRESHOLD = 500_000_000; // below: block height, above: unix time

// Anchor for estimating the current tip height without a server.
const ANCHOR_HEIGHT = 840_000;
const ANCHOR_TIME = 1713571200; // 2024-04-20, the 4th halving

export const nowSec = () => Math.floor(Date.now() / 1000);
export const estimateTipHeight = (t = nowSec()) =>
  ANCHOR_HEIGHT + Math.floor((t - ANCHOR_TIME) / BLOCK_SECONDS);

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const fmtInt = (n) => Number(n).toLocaleString('en-US');

/** Human duration, e.g. "≈ 1 year 2 months". */
export function fmtDuration(sec, { approx = true, short = false } = {}) {
  sec = Math.max(0, Math.round(sec));
  if (sec === 0) return short ? 'now' : 'immediately';
  const units = [
    ['year', 365.25 * 86400],
    ['month', 30.44 * 86400],
    ['week', 7 * 86400],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  const parts = [];
  const label = (n, name) => {
    const abbr = { year: 'y', month: 'mo', week: 'w', day: 'd', hour: 'h', minute: 'min' }[name];
    return short ? `${n}${abbr}` : `${n} ${name}${n > 1 ? 's' : ''}`;
  };
  // Leading unit tolerates ~3% shortfall (52,560 blocks reads as "1 year", not
  // "11 months 4 weeks"); the second unit is rounded to the nearest whole.
  const i = units.findIndex(([, size]) => sec / size >= 0.95);
  if (i >= 0) {
    const [name, size] = units[i];
    let n = Math.max(1, Math.floor(sec / size + 0.05));
    const next = units[i + 1];
    let m = next ? Math.round((sec - n * size) / next[1]) : 0;
    if (next && m * next[1] >= size * 0.9) (n += 1), (m = 0);
    parts.push(label(n, name));
    if (m > 0) parts.push(label(m, next[0]));
  }
  if (!parts.length) parts.push(short ? `${sec}s` : `${sec} seconds`);
  return (approx && !short ? '≈ ' : '') + parts.join(short ? ' ' : ' ');
}

export function fmtDate(ts) {
  return new Date(ts * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Relative timelock (`older`) consensus value -> seconds. */
export function olderSeconds(v) {
  return v & SEQUENCE_TYPE_FLAG ? (v & 0xffff) * 512 : (v & 0xffff) * BLOCK_SECONDS;
}
export const olderIsTime = (v) => !!(v & SEQUENCE_TYPE_FLAG);

/** Absolute timelock (`after`) consensus value -> seconds from now (may be negative). */
export function afterSecondsFromNow(v, t = nowSec()) {
  return v >= LOCKTIME_THRESHOLD ? v - t : (v - estimateTipHeight(t)) * BLOCK_SECONDS;
}
export const afterIsTime = (v) => v >= LOCKTIME_THRESHOLD;

export function describeOlder(v) {
  if (olderIsTime(v)) return `${fmtInt(v & 0xffff)} × 512s`;
  return `${fmtInt(v)} block${v === 1 ? '' : 's'}`;
}
export function describeAfter(v) {
  return afterIsTime(v) ? fmtDate(v) : `block ${fmtInt(v)}`;
}

export const randomHex = (bytes = 32) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

export const hexToBytes = (hex) => new Uint8Array(hex.match(/../g).map((b) => parseInt(b, 16)));
export const bytesToHex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(bytes) {
  return bytesToHex(await crypto.subtle.digest('SHA-256', bytes));
}

/** Tiny synchronous string hash for deterministic demo seeds (not security relevant). */
export function seedHex(label) {
  // FNV-1a expanded into 32 bytes; demo keys are public by construction anyway.
  let out = '';
  for (let round = 0; round < 8; round++) {
    let h = 0x811c9dc5 ^ round;
    for (const c of `${round}:${label}`) {
      h ^= c.charCodeAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}

export async function compress(str) {
  const stream = new Blob([str]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = '';
  buf.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function decompress(b64) {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: 0 } }, text);
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Copied to clipboard');
}

let toastTimer;
export function toast(msg, kind = 'info') {
  let el = $('#toast');
  if (!el) {
    el = h('div', { id: 'toast', role: 'status' });
    document.body.append(el);
  }
  el.textContent = msg;
  el.className = `toast toast--${kind} is-visible`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), 2200);
}

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export function combinations(arr, k) {
  const out = [];
  const rec = (start, combo) => {
    if (combo.length === k) return out.push(combo.slice());
    for (let i = start; i < arr.length; i++) {
      combo.push(arr[i]);
      rec(i + 1, combo);
      combo.pop();
    }
  };
  rec(0, []);
  return out;
}

export function download(filename, text) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
