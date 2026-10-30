// Visual representation of each block type on the canvas.
import { TYPES, hasInputs } from './model.js';
import { icon, ROLES } from './icons.js';
import { lifehashImg } from './lifehash.js';
import { ownershipBadge, describeMatch, isBlinded } from './ownership.js';
import {
  esc, fmtDuration, fmtInt, fmtDate, olderSeconds, olderIsTime, afterIsTime, afterSecondsFromNow,
  describeOlder,
} from './util.js';

export const PALETTE = [
  {
    group: 'Signers',
    items: [
      { type: 'key', title: 'Your own key', desc: 'Paste the xpub from your hardware wallet', icon: 'hardware', data: { role: 'hardware', label: 'My key' }, askXpub: true },
      { type: 'key', title: 'Key', desc: 'A signing device: add its xpub', demoDesc: 'A signing device: paste an xpub, or use a demo key', icon: 'key', data: { role: 'hardware' } },
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
  const own = app.ownership.match(n.key);
  // Two rows: status chips (incl. "blinded"), then the signer's name, which may truncate.
  const { cls: ownCls, text: ownText } = own ? ownershipBadge(own, { blinded: false }) : {};
  return `
    <div class="key-card">
      ${lifehashImg(n.key, 'lifehash--lg')}
      <div class="key-card__meta">
        <div class="mono key-card__fp">${fp ? `fp ${fp}` : n.key ? esc(n.key.slice(0, 12)) + '…' : 'no key yet'}</div>
        <div class="chips">
          ${n.seed ? '<span class="chip chip--muted">demo</span>'
            : n.origin === 'xpub' ? '<span class="chip chip--wallet">your xpub</span>'
            : n.key ? '<span class="chip chip--ok">custom</span>' : ''}
          ${uses > 1 ? `<span class="chip chip--key" title="Each extra use is derived on its own multipath branch">${uses} paths</span>` : ''}
          ${isBlinded(own) ? '<span class="chip chip--warn" title="The descriptor hides or misstates this key’s origin">blinded</span>' : ''}
        </div>
        ${own ? `<div class="chips"><button class="chip chip--own ${ownCls}" data-act="own" title="${esc(describeMatch(own))}. Click for details">${esc(ownText)}</button></div>` : ''}
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

const timelockWait = (c) =>
  c.type === 'older' ? olderSeconds(Number(c.value)) : Math.max(0, afterSecondsFromNow(Number(c.value)));

/**
 * For a threshold that mixes timelocks with other inputs: how many of the other
 * inputs (usually signers) are required at each moment. Every timelock that has
 * passed counts as one satisfied input, a signature that signs itself.
 */
export function decaySchedule(n, model) {
  if (n.type !== 'thresh') return null;
  const kids = n.inputs.map((id) => model.node(id)).filter(Boolean);
  const timed = kids.filter((c) => c.type === 'older' || (c.type === 'after' && Number(c.value) > 0));
  if (!timed.length) return null;
  const others = kids.length - timed.length;
  const unit = kids.filter((c) => !timed.includes(c)).every((c) => c.type === 'key') ? 'signer' : 'condition';
  const times = [...new Set([0, ...timed.map(timelockWait)])].sort((a, b) => a - b);
  return {
    unit,
    others,
    rows: times.map((t) => {
      const passed = timed.filter((c) => timelockWait(c) <= t).length;
      const need = Math.max(0, n.k - passed);
      return { t, need, of: others, by: timed.filter((c) => timelockWait(c) === t && t > 0) };
    }),
  };
}

export function ladderHTML(sched, { compact = false } = {}) {
  const rows = sched.rows.map((r) => {
    const dots = Array.from({ length: sched.others }, (_, i) => `<i class="${i < r.need ? 'on' : ''}"></i>`).join('');
    const val = r.need > sched.others ? 'locked' : r.need === 0 ? 'no signature!' : `${r.need} of ${sched.others}`;
    const cls = r.need === 0 ? 'is-bad' : r.need > sched.others ? 'is-locked' : '';
    return `<div class="ladder__row ${cls}" data-t="${r.t}">
      <span class="ladder__when">${r.t === 0 ? 'Now' : `After ${fmtDuration(r.t, { short: true })}`}</span>
      <span class="ladder__dots">${dots}</span>
      <span class="ladder__val">${val}</span>
    </div>`;
  }).join('');
  return `<div class="ladder ${compact ? 'ladder--compact' : ''}">
    <div class="ladder__title">${sched.unit === 'signer' ? 'Signers' : 'Conditions'} needed over time</div>${rows}</div>`;
}

function logicBody(n, app) {
  if (n.type === 'thresh') {
    const sched = decaySchedule(n, app.model);
    return `<div class="stepper no-drag">
      <button class="icon-btn" data-act="k-" title="Fewer required">${icon('minus')}</button>
      <div class="stepper__value"><b>${n.k}</b> of ${n.inputs.length}</div>
      <button class="icon-btn" data-act="k+" title="More required">${icon('plus')}</button>
    </div>${sched ? ladderHTML(sched, { compact: true }) : ''}`;
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
      body = logicBody(n, app);
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
      const decays = n.type === 'thresh' && (c?.type === 'older' || c?.type === 'after');
      const meta = n.type === 'or'
        ? `<span class="slot__meta" title="Relative likelihood">${Math.round(((n.weights[i] || 1) / total) * 100)}%</span>`
        : decays ? `<span class="slot__meta slot__meta--decay" title="Once this time passes it counts as one satisfied input">−1 signer</span>` : '';
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
