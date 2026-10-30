// Visual representation of each block type on the canvas.
import { TYPES, hasInputs } from './model.js';
import { icon, ROLES } from './icons.js';
import { lifehashImg } from './lifehash.js';
import {
  esc, fmtDuration, fmtInt, fmtDate, olderSeconds, olderIsTime, afterIsTime, afterSecondsFromNow,
  describeOlder,
} from './util.js';

export const PALETTE = [
  {
    group: 'Signers',
    items: [
      { type: 'key', title: 'Key', desc: 'A signing device: xpub, hardware wallet, co-signer', icon: 'key', data: { role: 'hardware' } },
      { type: 'key', title: 'Vendor key', desc: 'A collaborative custody co-signer', icon: 'vendor', data: { role: 'vendor', label: 'Vendor' } },
      { type: 'key', title: 'Heir key', desc: 'Someone who inherits after a delay', icon: 'heir', data: { role: 'heir', label: 'Heir' } },
    ],
  },
  {
    group: 'Time',
    items: [
      { type: 'older', title: 'Wait (relative)', desc: 'Unlocks after coins sit unmoved for a while (older)', icon: 'clock' },
      { type: 'after', title: 'Date (absolute)', desc: 'Unlocks at a block height or date (after)', icon: 'calendar' },
    ],
  },
  {
    group: 'Logic',
    items: [
      { type: 'and', title: 'All of', desc: 'Every input must be satisfied (and)', icon: 'and' },
      { type: 'or', title: 'Any of', desc: 'Any one input is enough (or)', icon: 'or' },
      { type: 'thresh', title: 'Threshold', desc: 'k of n inputs (thresh / multisig)', icon: 'thresh' },
    ],
  },
  {
    group: 'Secrets',
    items: [{ type: 'hash', title: 'Hashlock', desc: 'Requires revealing a SHA256 preimage', icon: 'hash' }],
  },
];

export function blockSummary(n, app) {
  switch (n.type) {
    case 'key': return n.label || 'Key';
    case 'older': return `Wait ${fmtDuration(olderSeconds(Number(n.value)), { short: true })}`;
    case 'after': return afterIsTime(n.value) ? `After ${fmtDate(n.value)}` : `After block ${fmtInt(n.value)}`;
    case 'hash': return 'Secret preimage';
    case 'and': return `All of ${n.inputs.length}`;
    case 'or': return `Any of ${n.inputs.length}`;
    case 'thresh': return `${n.k} of ${n.inputs.length}`;
    case 'wallet': return n.name;
  }
  return TYPES[n.type]?.title ?? n.type;
}

function keyBody(n, app) {
  const uses = app.model.parentsOf(n.id).length;
  const fp = /^\[([0-9a-f]{8})/.exec(n.key || '')?.[1];
  return `
    <div class="key-card">
      ${lifehashImg(n.key, 'lifehash--lg')}
      <div class="key-card__meta">
        <div class="mono key-card__fp">${fp ? `fp ${fp}` : n.key ? esc(n.key.slice(0, 12)) + '…' : 'no key yet'}</div>
        <div class="chips">
          ${n.seed ? '<span class="chip chip--muted">demo</span>' : n.key ? '<span class="chip chip--ok">custom</span>' : ''}
          ${uses > 1 ? `<span class="chip chip--key" title="Each extra use is derived on its own multipath branch">${uses} paths</span>` : ''}
        </div>
      </div>
    </div>`;
}

function timeBody(n) {
  const v = Number(n.value);
  if (n.type === 'older') {
    return `<div class="big-value">${fmtDuration(olderSeconds(v))}</div>
      <div class="mono muted">older(${fmtInt(v)}) · ${olderIsTime(v) ? 'time-based' : describeOlder(v)}</div>`;
  }
  if (!v) return `<div class="muted">Pick a date or block height</div>`;
  const left = afterSecondsFromNow(v);
  return `<div class="big-value">${afterIsTime(v) ? fmtDate(v) : `Block ${fmtInt(v)}`}</div>
    <div class="mono muted">after(${v}) · ${left > 0 ? `in ${fmtDuration(left)}` : 'already reached'}</div>`;
}

function logicBody(n) {
  if (n.type === 'thresh') {
    return `<div class="stepper no-drag">
      <button class="icon-btn" data-act="k-" title="Fewer required">${icon('minus')}</button>
      <div class="stepper__value"><b>${n.k}</b> of ${n.inputs.length}</div>
      <button class="icon-btn" data-act="k+" title="More required">${icon('plus')}</button>
    </div>`;
  }
  return `<div class="muted small">${n.type === 'and' ? 'Every input must be satisfied' : 'Any single input is enough'}</div>`;
}

function walletBody(n, app) {
  const r = app.result;
  const ctx = app.model.state.context;
  const okResult = r?.ok;
  return `
    <div class="wallet-card">
      ${okResult ? lifehashImg(r.descriptor, 'lifehash--xl') : `<span class="lifehash lifehash--xl lifehash--empty">${icon('wallet')}</span>`}
      <div class="wallet-card__meta">
        <div class="chips">
          <span class="chip chip--wallet">${ctx === 'tr' ? 'Taproot' : 'P2WSH'}</span>
          <span class="chip chip--muted">${app.model.state.network}</span>
        </div>
        ${okResult
          ? `<div class="status status--ok">${icon('check')} Compiled</div>
             <div class="mono muted small">${r.addresses?.[0]?.receive ? esc(r.addresses[0].receive.slice(0, 14)) + '…' : ''}</div>`
          : `<div class="status status--warn">${icon('alert')} ${r?.error ? 'Not compilable' : 'Incomplete'}</div>`}
      </div>
    </div>`;
}

export function nodeHTML(n, app) {
  const t = TYPES[n.type];
  const errorMsg = app.nodeErrors?.get(n.id);
  const roleIcon = n.type === 'key' ? ROLES[n.role]?.icon ?? 'key' : t.icon;
  let title = t.title;
  let sub = '';
  let body = '';
  switch (n.type) {
    case 'key':
      title = esc(n.label || 'Key');
      sub = ROLES[n.role]?.label ?? 'Signer';
      body = keyBody(n, app);
      break;
    case 'older':
    case 'after':
      sub = n.type === 'older' ? 'since funds were received' : 'absolute lock';
      body = timeBody(n);
      break;
    case 'hash':
      sub = 'SHA256 preimage';
      body = n.hash
        ? `<div class="mono hash-preview">${esc(n.hash.slice(0, 16))}…</div>${n.preimage ? '<span class="chip chip--hash">secret known</span>' : ''}`
        : '<div class="muted">Set or generate a secret</div>';
      break;
    case 'and':
    case 'or':
    case 'thresh':
      sub = n.type === 'and' ? 'and' : n.type === 'or' ? 'or' : 'thresh';
      body = logicBody(n);
      break;
    case 'wallet':
      title = esc(n.name || 'Wallet');
      sub = 'Output descriptor';
      body = walletBody(n, app);
      break;
  }

  let inputs = '';
  if (hasInputs(n)) {
    const total = n.weights ? n.weights.slice(0, n.inputs.length).reduce((a, b) => a + (b || 1), 0) : 0;
    const rows = n.inputs.map((cid, i) => {
      const c = app.model.node(cid);
      const meta = n.type === 'or' ? `<span class="slot__meta" title="Relative likelihood">${Math.round(((n.weights[i] || 1) / total) * 100)}%</span>` : '';
      return `<div class="slot is-filled" data-slot="${i}">
        <span class="port port--in port--${TYPES[c?.type]?.family}"></span>
        <span class="slot__label">${esc(c ? blockSummary(c, app) : '?')}</span>${meta}
      </div>`;
    });
    const max = t.maxInputs ?? Infinity;
    if (n.inputs.length < max || n.type === 'wallet') {
      if (!(n.type === 'wallet' && n.inputs.length)) {
        rows.push(`<div class="slot slot--add" data-slot="${n.inputs.length}">
          <span class="port port--in"></span><span class="slot__label">${n.type === 'wallet' ? 'Spending policy' : 'Drop input here'}</span></div>`);
      }
    }
    inputs = `<div class="node__inputs">${rows.join('')}</div>`;
  }

  const out = n.type === 'wallet' ? '' : `<span class="port port--out" title="Drag to connect"></span>`;
  return `
    <div class="node__head">
      <span class="node__icon">${icon(roleIcon)}</span>
      <div class="node__titles"><div class="node__title">${title}</div><div class="node__sub">${sub}</div></div>
    </div>
    <div class="node__body">${body}</div>
    ${inputs}
    ${out}
    ${errorMsg ? `<div class="node__error">${icon('alert')}<span>${esc(errorMsg)}</span></div>` : ''}`;
}
