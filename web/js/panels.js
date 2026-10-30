// Sidebar (inspector, paths, simulator, wallet) and the compiler output drawer.
import { TYPES, hasInputs } from './model.js';
import { icon, ROLES } from './icons.js';
import { lifehash, lifehashImg } from './lifehash.js';
import { blockSummary, decaySchedule, ladderHTML } from './blocks.js';
import { custodyPhases, evaluate } from './policy.js';
import { parseKey } from './wasm.js';
import { describeMatch } from './ownership.js';
import {
  $, $$, esc, fmtDuration, fmtInt, fmtDate, olderSeconds, olderIsTime, afterIsTime, afterSecondsFromNow,
  estimateTipHeight, nowSec, SEQUENCE_TYPE_FLAG, copyText, randomHex, hexToBytes, sha256Hex, download, toast, privateMaterial,
} from './util.js';

const DAY = 86400;
const OLDER_PRESETS = [
  ['1 day', 144], ['1 week', 1008], ['30 days', 4320], ['90 days', 12960], ['6 months', 26280], ['1 year', 52560], ['Max ≈ 15 mo', 65535],
];

export const HINTS = [
  [/not safe/i, 'Every spending path needs at least one signature. Otherwise anyone could spend once the timelock passes or the secret leaks. Add a Key to the path that only has time or hash conditions.'],
  [/non-malleable/i, 'No non-malleable script exists for this policy. A common cause is mixing height-based and time-based timelocks in the same path.'],
  [/heightlock and timelock|timelock combination/i, 'One path combines a block-height lock with a date lock. Bitcoin can’t enforce both kinds in the same spend.'],
  [/duplicate keys/i, 'The same key appears more than once. Reuse one Key block across paths; the playground derives each use separately.'],
  [/Tapleaves/i, 'Too many Taproot leaves. Simplify the policy or use P2WSH.'],
  [/limits|resource/i, 'The script exceeds Bitcoin’s consensus or standardness limits. Try fewer keys or Taproot (multi_a has no 20-key limit).'],
];
export const hintFor = (msg) => HINTS.find(([re]) => re.test(msg || ''))?.[1];

export class Panels {
  constructor(app) {
    this.app = app;
    this.tab = 'block';
    this.drawerTab = 'policy';
    this.sim = { available: null, known: new Set(), elapsed: 0 };
    this.side = $('#sidebar-body');
    this.drawer = $('#drawer-body');

    $$('#sidebar-tabs [data-tab]').forEach((b) => b.addEventListener('click', () => this.setTab(b.dataset.tab)));
    $$('#drawer-tabs [data-tab]').forEach((b) =>
      b.addEventListener('click', () => {
        this.drawerTab = b.dataset.tab;
        $('#drawer').classList.remove('is-collapsed');
        this.renderDrawer();
      }));
    $('#drawer-toggle').addEventListener('click', () => {
      $('#drawer').classList.toggle('is-collapsed');
      requestAnimationFrame(() => app.canvas.renderWires());
    });
    $('#drawer-copy').addEventListener('click', () => {
      const text = this.drawerText();
      if (text) copyText(text);
    });
  }

  setTab(tab) {
    this.tab = tab;
    $$('#sidebar-tabs [data-tab]').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === tab));
    this.renderSide();
  }

  render({ skipInspector = false } = {}) {
    if (!(skipInspector && this.tab === 'block')) this.renderSide();
    else this.updateInspectorStatus();
    this.renderDrawer();
  }

  renderSide() {
    const { app } = this;
    $$('#sidebar-tabs [data-tab]').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === this.tab));
    const count = app.built?.paths.length || 0;
    $('#tab-paths-count').textContent = count ? count : '';
    if (this.tab !== 'paths') app.canvas.setOverlay(null);
    if (this.tab === 'block') this.renderInspector();
    else if (this.tab === 'paths') this.renderPaths();
    else if (this.tab === 'simulate') this.renderSimulator();
    else if (this.tab === 'wallet') this.renderWallet();
  }

  // ======================================================================
  // Inspector
  // ======================================================================
  renderInspector() {
    const { app } = this;
    const n = app.model.node(app.canvas.selected);
    if (!n) return this.renderWelcome();
    const t = TYPES[n.type];
    const err = app.nodeErrors.get(n.id);
    const head = `
      <div class="insp-head insp-head--${t.family}">
        <span class="insp-head__icon">${icon(n.type === 'key' ? ROLES[n.role]?.icon ?? 'key' : t.icon)}</span>
        <div><div class="insp-head__title">${esc(n.type === 'key' ? n.label : n.type === 'wallet' ? n.name : t.title)}</div>
        <div class="insp-head__sub">${t.title}${n.type !== 'wallet' && n.type !== 'key' ? ` · <code>${n.type}</code>` : ''}</div></div>
      </div>
      <div id="insp-status">${err ? `<div class="callout callout--warn">${icon('alert')}<span>${esc(err)}</span></div>` : ''}</div>`;
    const body = {
      key: () => this.keyInspector(n),
      older: () => this.olderInspector(n),
      after: () => this.afterInspector(n),
      hash: () => this.hashInspector(n),
      and: () => this.logicInspector(n),
      or: () => this.logicInspector(n),
      thresh: () => this.logicInspector(n),
      wallet: () => this.walletInspector(n),
    }[n.type]();
    const foot = n.type === 'wallet' ? '' : `
      <div class="insp-actions">
        <button class="btn btn--ghost" data-do="duplicate">${icon('copy')} Duplicate</button>
        <button class="btn btn--danger" data-do="delete">${icon('trash')} Delete</button>
      </div>`;
    this.side.innerHTML = head + body + foot;
    this.side.querySelector('[data-do="delete"]')?.addEventListener('click', () => app.deleteSelected());
    this.side.querySelector('[data-do="duplicate"]')?.addEventListener('click', () => app.duplicateSelected());
    this.bindInspector(n);
  }

  updateInspectorStatus() {
    const n = this.app.model.node(this.app.canvas.selected);
    const el = $('#insp-status');
    if (!n || !el) return;
    const err = this.app.nodeErrors.get(n.id);
    el.innerHTML = err ? `<div class="callout callout--warn">${icon('alert')}<span>${esc(err)}</span></div>` : '';
    const lh = $('#insp-lifehash');
    if (lh && n.type === 'key') lh.innerHTML = lifehashImg(n.key, 'lifehash--hero');
  }

  renderWelcome() {
    this.side.innerHTML = `
      <div class="welcome">
        <div class="welcome__badge">${icon('sparkle')} Visual Miniscript</div>
        <h2>Design self-custody you can survive.</h2>
        <p>Multisig alone isn’t a silver bullet. Real resilience comes from <b>fallback paths</b>: ways out under the worst circumstances, traded against how many people must cooperate.</p>
        <ol class="steps">
          <li><b>Drag blocks</b> from the left: keys, timelocks, logic.</li>
          <li><b>Wire outputs → inputs.</b> Drag from a block’s right handle into a slot.</li>
          <li><b>Watch it compile</b> live with rust-miniscript in WASM, below.</li>
          <li><b>Check the trade-offs</b> in <a href="#" data-goto="paths">Paths</a>, then rehearse disasters in <a href="#" data-goto="simulate">Simulate</a>.</li>
        </ol>
        <div class="kbd-list">
          <div><kbd>Del</kbd> remove block / wire</div>
          <div><kbd>⌘/Ctrl Z</kbd> undo · <kbd>⇧⌘Z</kbd> redo</div>
          <div><kbd>L</kbd> tidy layout · <kbd>F</kbd> fit view</div>
          <div><kbd>⌘/Ctrl D</kbd> duplicate</div>
          <div>Double-click a wire to cut it</div>
        </div>
      </div>`;
    $$('[data-goto]', this.side).forEach((a) => a.addEventListener('click', (e) => (e.preventDefault(), this.setTab(a.dataset.goto))));
  }

  keyInspector(n) {
    const uses = this.app.model.parentsOf(n.id).length;
    const info = n.key ? parseKey(n.key) : null;
    const mainnet = this.app.model.state.network === 'bitcoin';
    const mismatch = info?.ok && info.mainnet != null && info.mainnet !== mainnet;
    return `
      <div class="lifehash-hero" id="insp-lifehash">${lifehashImg(n.key, 'lifehash--hero')}</div>
      <p class="caption">LifeHash of this key: a visual fingerprint. Compare it on every device before you trust an xpub.</p>
      <label class="field"><span>Name</span><input data-f="label" value="${esc(n.label)}" maxlength="24" spellcheck="false"></label>
      <label class="field"><span>Role</span><select data-f="role">
        ${Object.entries(ROLES).map(([k, r]) => `<option value="${k}" ${k === n.role ? 'selected' : ''}>${r.label}</option>`).join('')}
      </select></label>
      <label class="field"><span>Public key <em>xpub with origin, e.g. [fp/48h/0h/0h/2h]xpub…</em></span>
        <textarea data-f="key" rows="4" class="mono" spellcheck="false" placeholder="[d34db33f/48h/0h/0h/2h]xpub…/&lt;0;1&gt;/*">${esc(n.key)}</textarea></label>
      <div id="key-feedback">${this.keyFeedback(info, mismatch)}</div>
      ${this.ownershipCallout(n.key)}
      <div class="btn-row">
        <button class="btn btn--primary" data-do="xpub">${icon('hardware')} Add your xpub</button>
      </div>
      <div class="btn-row">
        ${this.app.demo ? `<button class="btn btn--ghost" data-do="gen">${icon('dice')} New demo key</button>` : ''}
        <button class="btn btn--ghost" data-do="copykey" ${n.key ? '' : 'disabled'}>${icon('copy')} Copy</button>
      </div>
      <p class="caption">Public keys only. Export the xpub from your hardware wallet or coordinator; seed words and private keys are refused.</p>
      ${n.seed ? `<div class="callout callout--info">${icon('alert')}<span>Demo key from a public seed. <b>Never send real funds to it.</b> Paste your own xpub to design a real wallet.</span></div>` : ''}
      <div class="section-title">Used in ${uses} place${uses === 1 ? '' : 's'}</div>
      <p class="caption">A key block is one signing device. Wire it into several paths and each use gets its own derivation branch (<code>&lt;0;1&gt;</code>, <code>&lt;2;3&gt;</code>, …), the same approach Liana uses, so miniscript never sees a duplicate key.</p>`;
  }

  ownershipCallout(key) {
    const r = this.app.ownership.match(key);
    if (!r) return '';
    const cls = { owned: 'callout--ok', known: 'callout--info', conflict: 'callout--bad', device: 'callout--warn', unknown: 'callout--info' }[r.kind];
    const extra = [
      r.path && r.kind !== 'conflict' ? `Path <code>${esc(r.path)}</code>` : '',
      r.account != null ? `account ${r.account}` : '',
      r.status ? esc(r.status) : '',
    ].filter(Boolean).join(' · ');
    const mismatch = {
      'no-origin': 'This key has no origin: hardware signers may not recognise it.',
      fingerprint: 'The origin fingerprint differs from the manifest: hardware signers may not recognise it.',
      path: 'The origin path differs from the manifest: hardware signers may not recognise it.',
    }[r.originMismatch];
    return `<div class="callout ${cls}">${icon(r.kind === 'owned' ? 'shield' : 'alert')}<span><b>Ownership:</b> ${esc(describeMatch(r))}${extra ? `<br><small>${extra}</small>` : ''}${mismatch ? `<br>${mismatch}` : ''}
      <br><button class="btn btn--ghost btn--sm" data-do="own-details">Show manifest entry</button></span></div>`;
  }

  keyFeedback(info, mismatch) {
    if (!info) return '';
    if (!info.ok) return `<div class="callout callout--warn">${icon('alert')}<span>${esc(info.error)}</span></div>`;
    return `<div class="kv">
        <div><span>Fingerprint</span><b class="mono">${info.fingerprint}</b></div>
        <div><span>Type</span><b>${info.kind === 'xpub' ? 'Extended key' : 'Single key'}${info.multipath ? ' · multipath' : ''}${info.wildcard ? ' · ranged' : ''}</b></div>
      </div>
      ${mismatch ? `<div class="callout callout--warn">${icon('alert')}<span>This key is for ${info.mainnet ? 'mainnet' : 'a test network'}, but the wallet is set to ${this.app.model.state.network}.</span></div>` : ''}`;
  }

  olderInspector(n) {
    const v = Number(n.value);
    const time = olderIsTime(v);
    const units = v & 0xffff;
    return `
      <div class="segmented" data-seg="older-mode">
        <button class="${!time ? 'is-active' : ''}" data-mode="blocks">Blocks</button>
        <button class="${time ? 'is-active' : ''}" data-mode="time">Time (512s units)</button>
      </div>
      <div class="readout"><div class="readout__big">${fmtDuration(olderSeconds(v))}</div><div class="readout__sub mono">older(${v})</div></div>
      ${!time ? `<div class="chips chips--wrap">${OLDER_PRESETS.map(([l, b]) => `<button class="chip chip--btn ${b === v ? 'is-active' : ''}" data-preset="${b}">${l}</button>`).join('')}</div>
        <label class="field"><span>Blocks (1 – 65,535) · ~10 minutes each</span><input type="number" min="1" max="65535" data-f="blocks" value="${units}"></label>`
      : `<label class="field"><span>Days (max ≈ 388)</span><input type="number" min="1" max="388" step="0.5" data-f="days" value="${+((units * 512) / DAY).toFixed(2)}"></label>
        <p class="caption">Stored as ${fmtInt(units)} × 512-second units with the BIP-68 type flag.</p>`}
      <div class="callout callout--info">${icon('clock')}<span>A <b>relative</b> timelock counts from when the coins were received. Spending to yourself resets the clock. That is how a dead-man switch works: refresh it to prove you’re alive.</span></div>`;
  }

  afterInspector(n) {
    const v = Number(n.value) || 0;
    const time = v ? afterIsTime(v) : n.mode === 'date';
    const tip = estimateTipHeight();
    const left = v ? afterSecondsFromNow(v) : 0;
    const dateVal = time && v ? new Date(v * 1000).toISOString().slice(0, 10) : '';
    return `
      <div class="segmented" data-seg="after-mode">
        <button class="${!time ? 'is-active' : ''}" data-mode="height">Block height</button>
        <button class="${time ? 'is-active' : ''}" data-mode="date">Calendar date</button>
      </div>
      ${v ? `<div class="readout"><div class="readout__big">${time ? fmtDate(v) : `Block ${fmtInt(v)}`}</div>
        <div class="readout__sub">${left > 0 ? `in ${fmtDuration(left)}` : 'already in the past'} · <span class="mono">after(${v})</span></div></div>` : ''}
      ${!time ? `<div class="chips chips--wrap">${[['+6 months', 26280], ['+1 year', 52560], ['+2 years', 105120], ['+5 years', 262800]]
          .map(([l, b]) => `<button class="chip chip--btn" data-preset-h="${Math.ceil((tip + b) / 1000) * 1000}">${l}</button>`).join('')}</div>
        <label class="field"><span>Block height · current tip ≈ ${fmtInt(tip)} (estimated)</span><input type="number" min="1" max="499999999" data-f="height" value="${v || ''}"></label>`
      : `<label class="field"><span>Unlock date (UTC, median-time-past)</span><input type="date" data-f="date" value="${dateVal}"></label>`}
      <div class="callout callout--info">${icon('calendar')}<span>An <b>absolute</b> timelock unlocks at a fixed moment, no matter when the coins arrived. Plan to roll coins to a new wallet before it expires.</span></div>`;
  }

  hashInspector(n) {
    return `
      <label class="field"><span>SHA256 hash (32 bytes hex)</span><input class="mono" data-f="hash" value="${esc(n.hash)}" spellcheck="false" placeholder="64 hex characters"></label>
      <div class="btn-row"><button class="btn" data-do="secret">${icon('dice')} Generate secret</button></div>
      ${n.preimage ? `<label class="field"><span>Preimage (kept in this browser; included in share links)</span><input class="mono" readonly value="${esc(n.preimage)}"></label>` : ''}
      <div class="callout callout--info">${icon('hash')}<span>Spending reveals a 32-byte secret whose SHA256 matches. Hashlocks power HTLCs, atomic swaps and Lightning.</span></div>`;
  }

  logicInspector(n) {
    const m = this.app.model;
    const total = n.type === 'or' ? n.inputs.reduce((a, _, i) => a + (n.weights[i] || 1), 0) : 0;
    const rows = n.inputs.map((cid, i) => {
      const c = m.node(cid);
      const w = n.weights?.[i] || 1;
      return `<div class="input-row">
        <span class="dot dot--${TYPES[c.type].family}"></span>
        <span class="input-row__label">${esc(blockSummary(c, this.app))}</span>
        ${n.type === 'or' ? `<input type="range" min="1" max="99" value="${w}" data-weight="${i}" title="Likelihood"><span class="input-row__pct">${Math.round((w / total) * 100)}%</span>` : ''}
        <button class="icon-btn" data-detach="${i}" title="Disconnect">${icon('x')}</button>
      </div>`;
    }).join('');
    return `
      <div class="segmented" data-seg="convert">
        ${['and', 'or', 'thresh'].map((t) => `<button class="${n.type === t ? 'is-active' : ''}" data-type="${t}">${TYPES[t].title}</button>`).join('')}
      </div>
      ${n.type === 'thresh' ? `
        <div class="readout"><div class="readout__big">${n.k} of ${n.inputs.length}</div><div class="readout__sub">inputs must be satisfied</div></div>
        <input type="range" class="wide" min="1" max="${Math.max(1, n.inputs.length)}" value="${n.k}" data-f="k">` : ''}
      <div class="section-title">Inputs</div>
      ${rows || '<p class="caption">Nothing connected yet. Drag a block’s right handle onto this block.</p>'}
      ${n.type === 'or' ? `<div class="callout callout--info">${icon('sparkle')}<span>Likelihood tells the compiler which branch you expect to use. It makes that branch cheaper; with Taproot, the most likely single key becomes the private key-path spend.</span></div>` : ''}
      ${n.type === 'thresh' && decaySchedule(n, m) ? `
        <div class="section-title">Decay schedule</div>
        ${ladderHTML(decaySchedule(n, m))}
        <div class="callout callout--info">${icon('clock')}<span>Each timelock input counts as <b>one signature that signs itself</b> once its time has passed. With ${n.k} of ${n.inputs.length} required, every expired timelock means one fewer real signer is needed.</span></div>`
      : n.type === 'thresh' ? `<div class="callout callout--info">${icon('thresh')}<span>When every input is a key, this compiles to <code>multi</code> (P2WSH) or <code>multi_a</code> (Taproot). Add timelock inputs for a <b>decaying multisig</b>: each one that expires replaces one signature.</span></div>` : ''}`;
  }

  walletInspector(n) {
    const s = this.app.model.state;
    return `
      <label class="field"><span>Wallet name</span><input data-f="name" value="${esc(n.name)}" maxlength="40"></label>
      <div class="section-title">Script type</div>
      <div class="segmented" data-seg="context">
        <button class="${s.context === 'wsh' ? 'is-active' : ''}" data-ctx="wsh">P2WSH · SegWit v0</button>
        <button class="${s.context === 'tr' ? 'is-active' : ''}" data-ctx="tr">P2TR · Taproot</button>
      </div>
      <p class="caption">${s.context === 'tr'
        ? 'Taproot hides unused branches: each spend reveals only its own leaf. A likely single key becomes the key path, which looks like ordinary single-sig on chain.'
        : 'P2WSH puts the whole script on chain at spend time. It is the most widely supported option for miniscript wallets today.'}</p>
      <label class="field"><span>Network</span><select data-f="network">
        ${['bitcoin', 'testnet', 'signet', 'regtest'].map((x) => `<option value="${x}" ${x === s.network ? 'selected' : ''}>${x === 'bitcoin' ? 'Mainnet' : x[0].toUpperCase() + x.slice(1)}</option>`).join('')}
      </select></label>
      ${this.app.demo ? '<p class="caption">Demo keys are re-derived for the selected network.</p>' : ''}`;
  }

  bindInspector(n) {
    const { app } = this;
    const m = app.model;
    const side = this.side;
    const on = (sel, ev, fn) => side.querySelectorAll(sel).forEach((el) => el.addEventListener(ev, fn));
    const commitOnChange = (el) => el.addEventListener('change', () => m.commit());

    on('[data-f="label"]', 'input', (e) => {
      m.update(n.id, { label: e.target.value }, 'inspector');
      side.querySelector('.insp-head__title').textContent = e.target.value;
    });
    on('[data-f="name"]', 'input', (e) => m.update(n.id, { name: e.target.value }, 'inspector'));
    on('[data-f="role"]', 'change', (e) => (m.update(n.id, { role: e.target.value }), m.commit()));
    on('[data-f="key"]', 'input', (e) => {
      const secret = privateMaterial(e.target.value);
      if (secret) {
        // Never keep private material: not in the block, history, storage or share links.
        e.target.value = n.key || '';
        $('#key-feedback').innerHTML = `<div class="callout callout--bad">${icon('alert')}<span>That looked like <b>${secret}</b>. It was discarded. Paste only an xpub / public key.</span></div>`;
        return;
      }
      const raw = e.target.value.trim();
      const info = raw ? parseKey(raw) : null;
      const mismatch = info?.ok && info.mainnet != null && info.mainnet !== (m.state.network === 'bitcoin');
      $('#key-feedback').innerHTML = this.keyFeedback(info, mismatch);
      m.update(n.id, { key: info?.ok ? info.key : raw, seed: null, origin: info?.ok ? 'xpub' : null }, 'inspector');
    });
    on('[data-f="key"]', 'change', () => (m.commit(), this.renderInspector()));
    on('[data-do="gen"]', 'click', () => {
      m.update(n.id, { origin: null });
      app.assignDemoKey(n, randomHex(32));
      m.commit();
      this.renderInspector();
    });
    on('[data-do="copykey"]', 'click', () => copyText(n.key));
    on('[data-do="xpub"]', 'click', () => app.keys.open(n.id));
    on('[data-do="own-details"]', 'click', () => app.showOwnership(n.id));

    // Timelocks
    on('[data-seg="older-mode"] button', 'click', (e) => {
      const toTime = e.currentTarget.dataset.mode === 'time';
      const secs = olderSeconds(Number(n.value));
      const value = toTime
        ? SEQUENCE_TYPE_FLAG | Math.min(65535, Math.max(1, Math.round(secs / 512)))
        : Math.min(65535, Math.max(1, Math.round(secs / 600)));
      m.update(n.id, { value });
      m.commit();
      this.renderInspector();
    });
    on('[data-preset]', 'click', (e) => (m.update(n.id, { value: Number(e.currentTarget.dataset.preset) }), m.commit(), this.renderInspector()));
    on('[data-f="blocks"]', 'input', (e) => m.update(n.id, { value: Math.round(Number(e.target.value)) }, 'inspector'));
    on('[data-f="days"]', 'input', (e) => {
      const units = Math.min(65535, Math.max(1, Math.round((Number(e.target.value) * DAY) / 512)));
      m.update(n.id, { value: SEQUENCE_TYPE_FLAG | units }, 'inspector');
    });
    on('[data-seg="after-mode"] button', 'click', (e) => {
      const toDate = e.currentTarget.dataset.mode === 'date';
      const v = Number(n.value) || 0;
      const secsLeft = v ? afterSecondsFromNow(v) : 365 * DAY;
      const value = toDate
        ? Math.floor((nowSec() + secsLeft) / DAY) * DAY
        : Math.ceil((estimateTipHeight() + secsLeft / 600) / 1000) * 1000;
      m.update(n.id, { value, mode: toDate ? 'date' : 'height' });
      m.commit();
      this.renderInspector();
    });
    on('[data-preset-h]', 'click', (e) => (m.update(n.id, { value: Number(e.currentTarget.dataset.presetH) }), m.commit(), this.renderInspector()));
    on('[data-f="height"]', 'input', (e) => m.update(n.id, { value: Math.round(Number(e.target.value)) }, 'inspector'));
    on('[data-f="date"]', 'change', (e) => {
      const ts = Math.floor(Date.parse(`${e.target.value}T00:00:00Z`) / 1000);
      if (ts > 500_000_000) (m.update(n.id, { value: ts }), m.commit(), this.renderInspector());
    });

    // Hash
    on('[data-f="hash"]', 'input', (e) => m.update(n.id, { hash: e.target.value.trim().toLowerCase(), preimage: '' }, 'inspector'));
    on('[data-do="secret"]', 'click', async () => {
      const preimage = randomHex(32);
      const hash = await sha256Hex(hexToBytes(preimage));
      m.update(n.id, { hash, preimage });
      m.commit();
      this.renderInspector();
    });

    // Logic
    on('[data-seg="convert"] button', 'click', (e) => {
      const type = e.currentTarget.dataset.type;
      if (type === n.type) return;
      const patch = { type };
      if (type === 'or') patch.weights = n.inputs.map(() => 1);
      if (type === 'thresh') patch.k = Math.max(1, Math.min(n.k ?? 2, n.inputs.length || 2));
      m.update(n.id, patch);
      m.commit();
      this.renderInspector();
    });
    on('[data-f="k"]', 'input', (e) => {
      m.update(n.id, { k: Number(e.target.value) }, 'inspector');
      side.querySelector('.readout__big').textContent = `${n.k} of ${n.inputs.length}`;
    });
    on('[data-weight]', 'input', (e) => {
      const i = Number(e.target.dataset.weight);
      const weights = n.weights.slice();
      weights[i] = Number(e.target.value);
      m.update(n.id, { weights }, 'inspector');
      const total = n.inputs.reduce((a, _, j) => a + (weights[j] || 1), 0);
      side.querySelectorAll('.input-row__pct').forEach((el, j) => (el.textContent = `${Math.round(((weights[j] || 1) / total) * 100)}%`));
    });
    on('[data-detach]', 'click', (e) => (m.detach(n.id, Number(e.currentTarget.dataset.detach)), m.commit(), this.renderInspector()));

    // Wallet
    on('[data-seg="context"] button', 'click', (e) => (m.setGlobal({ context: e.currentTarget.dataset.ctx }), m.commit(), this.renderInspector()));
    on('[data-f="network"]', 'change', (e) => (app.setNetwork(e.target.value), this.renderInspector()));

    side.querySelectorAll('input, textarea').forEach((el) => {
      if (!el.dataset.weight && el.dataset.f !== 'key') commitOnChange(el);
    });
    side.querySelectorAll('[data-weight]').forEach(commitOnChange);
  }

  // ======================================================================
  // Paths
  // ======================================================================
  renderPaths() {
    const { app } = this;
    const built = app.built;
    const r = app.result;
    if (!built?.paths.length) {
      this.side.innerHTML = `<div class="empty">${icon('shield')}<p>Complete the policy to see its spending paths.</p></div>`;
      return;
    }
    const devices = built.devices;
    const phases = custodyPhases(built.paths, devices);
    const n = devices.length;
    // Which timelock blocks expire at each moment: the cause of each new phase.
    const reach = app.model.reachable();
    const timelocks = Object.values(app.model.nodes).filter((x) => reach.has(x.id) && (x.type === 'older' || (x.type === 'after' && x.value)));
    const waitOf = (x) => (x.type === 'older' ? olderSeconds(Number(x.value)) : Math.max(0, afterSecondsFromNow(Number(x.value))));
    const phaseHTML = phases.map((ph, pi) => {
      const when = ph.t === 0 ? 'From day one' : `After ${fmtDuration(ph.t)}`;
      const causes = ph.t > 0 ? timelocks.filter((x) => Math.abs(waitOf(x) - ph.t) < 1) : [];
      const prev = phases[pi - 1];
      const delta = prev?.minSigners != null && ph.minSigners != null ? prev.minSigners - ph.minSigners : 0;
      const cause = causes.length
        ? `<div class="phase__cause">${causes.map((x) => `<span class="chip chip--time">${icon(x.type === 'older' ? 'clock' : 'calendar')} ${esc(blockSummary(x, app))} passes</span>`).join('')}
            <span class="phase__delta">${delta > 0 ? `${delta === 1 ? 'one' : delta} fewer signer${delta === 1 ? '' : 's'} needed` : prev && !prev.active.length ? 'first path opens' : 'a new fallback path opens'}</span></div>`
        : '';
      if (!ph.active.length) {
        return `<div class="phase"><div class="phase__when">${when}</div><div class="phase__locked">${icon('lock')} No path is open yet</div></div>`;
      }
      return `<div class="phase">
        <div class="phase__when">${when}</div>
        ${cause}
        <div class="phase__stats">
          <div class="stat"><div class="stat__v">${ph.minSigners}<small> of ${n}</small></div><div class="stat__l">signers needed</div></div>
          <div class="stat"><div class="stat__v ${ph.tolerance > 0 ? 'good' : 'bad'}">${ph.tolerance ?? '–'}</div><div class="stat__l">keys you can lose</div></div>
          <div class="stat"><div class="stat__v">${ph.attacker}</div><div class="stat__l">keys a thief needs</div></div>
        </div>
      </div>`;
    }).join('');

    const cards = built.paths.map((p, i) => {
      const plan = r?.paths?.[i];
      const isKeyPath = r?.context === 'tr' && r.key_path_spendable && p.uses.length === 1 && p.uses[0] === r.internal_key && !p.wait && !p.hashes.size;
      const own = this.pathOwnership(p);
      const conds = [];
      if (p.olderBlocks) conds.push(`${icon('clock')} wait ${fmtDuration(olderSeconds(p.olderBlocks))}`);
      if (p.olderTime) conds.push(`${icon('clock')} wait ${fmtDuration(olderSeconds(p.olderTime))}`);
      if (p.afterHeight) conds.push(`${icon('calendar')} after block ${fmtInt(p.afterHeight)}`);
      if (p.afterTime) conds.push(`${icon('calendar')} after ${fmtDate(p.afterTime)}`);
      if (p.hashes.size) conds.push(`${icon('hash')} reveal secret`);
      return `<div class="path-card" data-path="${i}">
        <div class="path-card__top">
          <span class="path-card__idx">${i + 1}</span>
          <div class="avatars">${[...p.devices].map((d) => this.avatar(d)).join('')}</div>
          <div class="path-card__cost">${plan?.spendable ? `<b>${plan.input_vbytes}</b> vB` : p.conflict ? '<span class="bad">conflict</span>' : '–'}</div>
        </div>
        <div class="path-card__who">${[...p.devices].map((d) => esc(app.model.node(d).label)).join(' + ') || 'No signature'}</div>
        <div class="chips chips--wrap">${conds.map((c) => `<span class="chip chip--cond">${c}</span>`).join('')}
          ${!conds.length ? '<span class="chip chip--ok">available now</span>' : ''}
          ${isKeyPath ? '<span class="chip chip--wallet" title="Looks like single-sig on chain">key path · private</span>' : ''}
          ${own}</div>
      </div>`;
    }).join('');

    this.side.innerHTML = `
      <div class="section-title">Custody over time</div>
      <p class="caption">Fault tolerance against interactivity. As time passes, fallback paths open: fewer signers are needed and lost keys become survivable.</p>
      <div class="phases">${phaseHTML}</div>
      <div class="section-title">Unlock timeline</div>
      ${this.timelineSVG(built.paths)}
      <div class="section-title">${built.paths.length} spending path${built.paths.length > 1 ? 's' : ''}${built.truncated ? ' (truncated)' : ''}</div>
      <p class="caption">Hover a path to highlight it on the canvas. Costs are full input sizes from rust-miniscript’s spend planner.</p>
      <div class="path-list">${cards}</div>`;

    $$('.path-card, .tl-row', this.side).forEach((el) => {
      const i = Number(el.dataset.path);
      el.addEventListener('mouseenter', () => {
        app.canvas.setOverlay({ mode: 'path', nodes: built.paths[i].nodes });
        $$(`[data-path="${i}"]`, this.side).forEach((x) => x.classList.add('is-hover'));
      });
      el.addEventListener('mouseleave', () => {
        app.canvas.setOverlay(null);
        $$('.is-hover', this.side).forEach((x) => x.classList.remove('is-hover'));
      });
    });
  }

  avatar(deviceId, size = '') {
    const k = this.app.model.node(deviceId);
    return `<span class="avatar ${size}" title="${esc(k?.label)}">${lifehashImg(k?.key)}</span>`;
  }

  timelineSVG(paths) {
    const W = 340, rowH = 30, left = 104, right = 12, top = 8, axisH = 22;
    const maxWait = Math.max(...paths.map((p) => p.wait));
    const T = Math.max(maxWait * 1.25, 30 * DAY);
    const x = (t) => left + (Math.min(t, T) / T) * (W - left - right);
    const steps = [DAY, 7 * DAY, 30 * DAY, 90 * DAY, 182 * DAY, 365 * DAY, 730 * DAY, 1826 * DAY, 3652 * DAY];
    const step = steps.find((s) => T / s <= 5) ?? steps[steps.length - 1];
    const ticks = [];
    for (let t = 0; t <= T; t += step) ticks.push(t);
    const H = top + paths.length * rowH + axisH;
    const rows = paths.map((p, i) => {
      const y = top + i * rowH + rowH / 2;
      const x0 = x(p.wait);
      const who = [...p.devices].slice(0, 3).map((d, j) => {
        const k = this.app.model.node(d);
        return `<image href="${lifehash(k?.key)}" x="${26 + j * 18}" y="${y - 8}" width="16" height="16" class="tl-avatar" preserveAspectRatio="none"/>`;
      }).join('');
      const more = p.devices.size > 3 ? `<text x="${26 + 3 * 18}" y="${y + 4}" class="tl-label">+${p.devices.size - 3}</text>` : '';
      return `<g class="tl-row" data-path="${i}">
        <rect x="0" y="${y - rowH / 2}" width="${W}" height="${rowH}" class="tl-hit"/>
        <text x="12" y="${y + 4}" class="tl-idx" text-anchor="middle">${i + 1}</text>
        ${who}${more}
        <path d="M${x0 + 4},${y - 4} H${W - right} V${y + 4} H${x0 + 4} a4,4 0 0 1 -4,-4 a4,4 0 0 1 4,-4z" class="tl-bar ${p.conflict ? 'is-conflict' : ''}"/>
        <circle cx="${x0}" cy="${y}" r="4" class="tl-dot"/>
        <title>Path ${i + 1}: ${p.wait ? `opens after ${fmtDuration(p.wait)}` : 'open from day one'}. Needs ${p.devices.size} signer${p.devices.size === 1 ? '' : 's'}.</title>
      </g>`;
    }).join('');
    const axisY = top + paths.length * rowH + 4;
    const tickHTML = ticks.map((t) => `<g><line x1="${x(t)}" x2="${x(t)}" y1="${top}" y2="${axisY}" class="tl-grid"/>
      <text x="${x(t)}" y="${axisY + 13}" class="tl-tick" text-anchor="middle">${t === 0 ? 'now' : fmtDuration(t, { short: true })}</text></g>`).join('');
    return `<svg class="timeline" viewBox="0 0 ${W} ${H}" role="img" aria-label="When each spending path unlocks">${tickHTML}${rows}</svg>`;
  }

  // ======================================================================
  // Simulator
  // ======================================================================
  renderSimulator() {
    const { app } = this;
    const built = app.built;
    if (!built?.paths.length) {
      app.canvas.setOverlay(null);
      this.side.innerHTML = `<div class="empty">${icon('play')}<p>Complete the policy to rehearse recovery scenarios.</p></div>`;
      return;
    }
    const devices = built.devices;
    if (!this.sim.available) this.sim.available = new Set(devices);
    for (const d of devices) if (!this.sim.seen?.has(d)) this.sim.available.add(d);
    this.sim.seen = new Set(devices);
    const hashes = Object.values(app.model.nodes).filter((n) => n.type === 'hash' && app.model.reachable().has(n.id));
    const maxWait = Math.max(...built.paths.map((p) => p.wait));
    const T = Math.max(maxWait * 1.25, 30 * DAY);
    this.sim.elapsed = Math.min(this.sim.elapsed, T);

    this.side.innerHTML = `
      <div class="section-title">What do you still have?</div>
      <div class="sim-devices">
        ${devices.map((d) => {
          const k = app.model.node(d);
          const on = this.sim.available.has(d);
          return `<button class="sim-device ${on ? 'is-on' : 'is-off'}" data-dev="${d}">
            ${lifehashImg(k.key)}<span class="sim-device__name">${esc(k.label)}</span>
            <span class="sim-device__state">${on ? 'available' : 'lost'}</span></button>`;
        }).join('')}
        ${hashes.map((hn) => `<button class="sim-device ${this.sim.known.has(hn.id) ? 'is-on' : 'is-off'}" data-hash="${hn.id}">
            <span class="lifehash sim-hash">${icon('hash')}</span><span class="sim-device__name">Secret</span>
            <span class="sim-device__state">${this.sim.known.has(hn.id) ? 'known' : 'unknown'}</span></button>`).join('')}
      </div>
      <div class="section-title">How much time has passed?</div>
      <input type="range" class="wide" id="sim-time" min="0" max="${T}" step="${Math.max(600, Math.round(T / 500))}" value="${this.sim.elapsed}" list="sim-marks">
      <datalist id="sim-marks">${[...new Set(built.paths.map((p) => p.wait))].map((w) => `<option value="${w}"></option>`).join('')}</datalist>
      <div class="sim-marks">${[...new Set(built.paths.map((p) => p.wait))].filter((w) => w > 0).map((w) =>
        `<button class="chip chip--btn" data-jump="${w}">${fmtDuration(w, { short: true })}</button>`).join('')}</div>
      <div class="sim-time" id="sim-time-label"></div>
      <div id="sim-result"></div>`;

    $$('[data-dev]', this.side).forEach((b) => b.addEventListener('click', () => {
      const d = b.dataset.dev;
      this.sim.available.has(d) ? this.sim.available.delete(d) : this.sim.available.add(d);
      this.renderSimulator();
    }));
    $$('[data-hash]', this.side).forEach((b) => b.addEventListener('click', () => {
      const d = b.dataset.hash;
      this.sim.known.has(d) ? this.sim.known.delete(d) : this.sim.known.add(d);
      this.renderSimulator();
    }));
    $('#sim-time').addEventListener('input', (e) => {
      this.sim.elapsed = Number(e.target.value);
      this.updateSimulation();
    });
    $$('[data-jump]', this.side).forEach((b) => b.addEventListener('click', () => {
      this.sim.elapsed = Number(b.dataset.jump);
      $('#sim-time').value = this.sim.elapsed;
      this.updateSimulation();
    }));
    this.updateSimulation();
  }

  updateSimulation() {
    const { app } = this;
    const built = app.built;
    const r = app.result;
    const { available, known, elapsed } = this.sim;
    const now = nowSec();
    $('#sim-time-label').innerHTML = elapsed
      ? `<b>+ ${fmtDuration(elapsed, { approx: false })}</b> <span class="muted">· ${fmtDate(now + elapsed)} · ≈ block ${fmtInt(estimateTipHeight(now + elapsed))}</span>`
      : `<b>Right after funding</b> <span class="muted">· ${fmtDate(now)}</span>`;

    const sat = evaluate(app.model, { available, known, elapsed, now });
    app.canvas.setOverlay({ mode: 'sim', sat, elapsed });

    const haveAll = (p) => [...p.devices].every((d) => available.has(d)) && [...p.hashes].every((h) => known.has(h));
    const open = built.paths.map((p, i) => ({ p, i })).filter(({ p }) => !p.conflict && haveAll(p) && p.wait <= elapsed);
    let html;
    if (open.length) {
      const best = open
        .map(({ p, i }) => ({ p, i, vb: r?.paths?.[i]?.spendable ? r.paths[i].input_vbytes : Infinity }))
        .sort((a, b) => a.vb - b.vb)[0];
      html = `<div class="sim-banner sim-banner--ok">${icon('unlock')}<div><b>Spendable</b>
        <div>via path ${best.i + 1}: ${[...best.p.devices].map((d) => esc(app.model.node(d).label)).join(' + ')}${best.vb < Infinity ? ` · ${best.vb} vB input` : ''}</div></div></div>`;
    } else {
      const future = built.paths.filter((p) => !p.conflict && haveAll(p)).sort((a, b) => a.wait - b.wait)[0];
      html = future
        ? `<div class="sim-banner sim-banner--wait">${icon('clock')}<div><b>Locked, but recoverable</b>
            <div>Opens in ${fmtDuration(future.wait - elapsed)} with ${[...future.devices].map((d) => esc(app.model.node(d).label)).join(' + ')}. Keep these keys safe.</div></div></div>`
        : `<div class="sim-banner sim-banner--bad">${icon('alert')}<div><b>Funds are unrecoverable</b>
            <div>No spending path can ever be satisfied with what’s left. Add a fallback path to survive this scenario.</div></div></div>`;
    }
    $('#sim-result').innerHTML = html;
  }

  // ======================================================================
  // Wallet export
  // ======================================================================
  renderWallet() {
    const { app } = this;
    const r = app.result;
    if (!r?.ok) {
      this.side.innerHTML = `<div class="empty">${icon('wallet')}<p>${r?.error ? esc(r.error) : 'Complete the policy to get a descriptor.'}</p></div>`;
      return;
    }
    const demo = app.model.keyNodes().some((k) => k.seed && app.model.reachable().has(k.id));
    const policy388 = this.walletPolicy();
    this.side.innerHTML = `
      <div class="wallet-hero">
        ${lifehashImg(r.descriptor, 'lifehash--hero')}
        <div><div class="wallet-hero__name">${esc(app.model.root.name)}</div>
        <div class="muted">${r.context === 'tr' ? 'Taproot' : 'P2WSH'} · ${app.model.state.network}</div>
        <div class="caption">This LifeHash is the visual identity of the descriptor. Every cosigner should see the same image.</div></div>
      </div>
      ${this.ownershipSummary()}
      ${demo ? `<div class="callout callout--warn">${icon('alert')}<span>Uses <b>demo keys</b> derived from public seeds. Don’t send funds. Replace them with your own xpubs.</span></div>` : ''}
      ${this.copyBlock('Descriptor (receive + change)', r.descriptor)}
      ${r.single_descriptors?.map((d, i) => this.copyBlock(i === 0 ? 'Receive descriptor' : 'Change descriptor', d, true)).join('') ?? ''}
      ${policy388 ? this.copyBlock('Wallet policy (BIP-388, for hardware signers)', policy388, true) : ''}
      <div class="section-title">Addresses</div>
      <table class="addr-table"><thead><tr><th>#</th><th>Receive</th></tr></thead><tbody>
        ${r.addresses.map((a) => `<tr><td>${a.index}</td><td class="mono"><button class="addr" data-copy="${esc(a.receive)}">${esc(a.receive)}</button></td></tr>`).join('')}
      </tbody></table>
      <div class="btn-row">
        <button class="btn" data-do="backup">${icon('download')} Backup file</button>
        <button class="btn btn--ghost" data-do="json">${icon('code')} Core import JSON</button>
      </div>`;
    $$('[data-copy]', this.side).forEach((b) => b.addEventListener('click', () => copyText(b.dataset.copy)));
    $('[data-do="backup"]', this.side).addEventListener('click', () => download(`${(app.model.root.name || 'wallet').replace(/\W+/g, '_')}-descriptor.txt`, this.backupText()));
    $('[data-do="json"]', this.side).addEventListener('click', () => {
      const req = r.single_descriptors.map((desc, i) => ({ desc, active: true, internal: i === 1, timestamp: 'now', range: [0, 999] }));
      copyText(`importdescriptors '${JSON.stringify(req)}'`);
    });
  }

  /** "We can sign alone" when every signer on the path is ours, per the loaded manifest. */
  pathOwnership(p) {
    const own = this.app.ownership;
    if (!own.loaded || !p.devices.size) return '';
    const kinds = [...p.devices].map((d) => own.match(this.app.model.node(d).key)?.kind ?? 'unknown');
    if (kinds.includes('conflict')) return '<span class="chip chip--bad">key conflict</span>';
    const theirs = kinds.filter((k) => k !== 'owned').length;
    return theirs
      ? `<span class="chip chip--muted" title="Signers on this path that you don’t control">needs ${theirs} other signer${theirs === 1 ? '' : 's'}</span>`
      : '<span class="chip chip--ok">we can sign alone</span>';
  }

  /** Ownership summary for the Wallet tab. */
  ownershipSummary() {
    const { app } = this;
    if (!app.ownership.loaded) return '';
    const reach = app.model.reachable();
    const counts = { owned: 0, known: 0, device: 0, unknown: 0, conflict: 0 };
    const keys = app.model.keyNodes().filter((k) => reach.has(k.id));
    for (const k of keys) counts[app.ownership.match(k.key)?.kind ?? 'unknown']++;
    return `<div class="callout ${counts.conflict ? 'callout--bad' : 'callout--info'}">${icon('shield')}<span>
      <b>${counts.owned} of ${keys.length}</b> key${keys.length === 1 ? '' : 's'} ours · ${counts.known} known · ${counts.device + counts.unknown} unknown
      ${counts.conflict ? `· <b>${counts.conflict} conflict${counts.conflict === 1 ? '' : 's'}</b>: a key claims a known signer but does not match` : ''}
      <br><small>From ${esc(app.ownership.name)}</small></span></div>`;
  }

  copyBlock(label, text, compact = false) {
    return `<div class="copy-block ${compact ? 'copy-block--compact' : ''}">
      <div class="copy-block__head"><span>${label}</span><button class="icon-btn" data-copy="${esc(text)}" title="Copy">${icon('copy')}</button></div>
      <div class="copy-block__text mono">${esc(text)}</div></div>`;
  }

  /** BIP-388 wallet policy: `@i/**` placeholders plus the key vector. */
  walletPolicy() {
    const { app } = this;
    const r = app.result;
    const built = app.built;
    if (!r?.ok) return null;
    const tmpl = r.descriptor_alias;
    const keyIdx = new Map();
    const vec = [];
    let ok = true;
    const out = tmpl.replace(/([(,{])([A-Za-z_][A-Za-z0-9_]*)(?=[),}])/g, (m0, pre, alias) => {
      if (alias === 'UNSPENDABLE') return m0;
      const nodeId = built.aliasToNode[alias];
      const key = built.keys[alias];
      if (!nodeId || !key) return m0;
      const mm = /^(.*)\/<(\d+);(\d+)>\/\*$/.exec(key);
      if (!mm) return (ok = false), m0;
      if (!keyIdx.has(nodeId)) {
        keyIdx.set(nodeId, vec.length);
        vec.push(mm[1]);
      }
      const i = keyIdx.get(nodeId);
      return `${pre}@${i}/${mm[2] === '0' ? '**' : `<${mm[2]};${mm[3]}>/*`}`;
    });
    if (!ok || out.includes('UNSPENDABLE')) return null;
    return `${out}\n\n${vec.map((k, i) => `@${i}: ${k}`).join('\n')}`;
  }

  backupText() {
    const { app } = this;
    const r = app.result;
    const lines = [
      `# ${app.model.root.name}`,
      `# Created with Miniscript Studio · ${new Date().toISOString()}`,
      `# Network: ${app.model.state.network} · Script: ${r.context}`,
      '',
      '## Descriptor',
      r.descriptor,
      '',
      '## Policy (aliases)',
      app.built.policy,
      '',
      '## Miniscript (aliases)',
      r.miniscript,
      '',
      '## Keys',
      ...Object.entries(app.built.keys).map(([a, k]) => `${a}: ${k}`),
      '',
      '## First addresses',
      ...r.addresses.map((a) => `${a.index}: ${a.receive}`),
    ];
    return lines.join('\n');
  }

  // ======================================================================
  // Compiler drawer
  // ======================================================================
  drawerText() {
    const { app } = this;
    const r = app.result;
    switch (this.drawerTab) {
      case 'policy': return app.built?.policy ?? '';
      case 'miniscript': return r?.ok ? r.miniscript : '';
      case 'descriptor': return r?.ok ? r.descriptor : '';
      case 'script': return r?.ok ? (r.script_asm ?? r.leaves?.map((l) => l.asm).join('\n\n')) : '';
      default: return '';
    }
  }

  renderDrawer() {
    const { app } = this;
    const r = app.result;
    const built = app.built;
    $$('#drawer-tabs [data-tab]').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === this.drawerTab));
    const status = $('#drawer-status');
    const firstErr = built?.errors.find((e) => app.model.reachable().has(e.id));
    if (r?.ok) status.innerHTML = `<span class="status status--ok">${icon('check')} compiled · ${r.script_size} B script</span>`;
    else if (r?.error) status.innerHTML = `<span class="status status--bad">${icon('alert')} compile error</span>`;
    else status.innerHTML = `<span class="status status--warn">${icon('alert')} ${esc(firstErr?.msg ?? 'incomplete')}</span>`;

    let html = '';
    const err = r && !r.ok ? `<div class="callout callout--bad">${icon('alert')}<div><b>${esc(r.error)}</b>${hintFor(r.error) ? `<div>${esc(hintFor(r.error))}</div>` : ''}</div></div>` : '';
    switch (this.drawerTab) {
      case 'policy':
        html = built?.policy
          ? `<pre class="code">${highlight(built.policy)}</pre><p class="caption">Concrete policy with signer aliases and <code>weight@</code> likelihoods. This is what the compiler optimises.</p>`
          : `<p class="muted">${esc(firstErr?.msg ?? 'Connect blocks to the wallet to build a policy.')}</p>`;
        break;
      case 'miniscript':
        html = err || (r?.ok ? `<pre class="code">${highlight(r.miniscript)}</pre><p class="caption">Compiled by rust-miniscript ${r.context === 'tr' ? '(Taproot: internal key + script tree)' : '(SegWit v0)'}.</p>` : '<p class="muted">Nothing compiled yet.</p>');
        break;
      case 'descriptor':
        html = err || (r?.ok ? `<pre class="code code--wrap">${highlight(r.descriptor)}</pre>` : '<p class="muted">Nothing compiled yet.</p>');
        break;
      case 'script':
        if (err || !r?.ok) html = err || '<p class="muted">Nothing compiled yet.</p>';
        else if (r.script_asm) html = `<pre class="code code--asm">${asmHighlight(r.script_asm)}</pre>`;
        else {
          html = `<div class="leaves">
            <div class="leaf leaf--internal"><div class="leaf__head">Internal key <span class="mono">${esc(r.internal_key)}</span></div>
            <div class="caption">${r.key_path_spendable ? 'Key-path spend: a single Schnorr signature, indistinguishable from single-sig.' : 'Provably unspendable (BIP-341 NUMS point). Script paths only.'}</div></div>
            ${r.leaves.map((l) => `<div class="leaf"><div class="leaf__head">Leaf · depth ${l.depth} · ${l.script_size} B</div>
              <pre class="code">${highlight(l.miniscript)}</pre><pre class="code code--asm">${asmHighlight(l.asm)}</pre></div>`).join('')}
          </div>`;
        }
        break;
      case 'analysis':
        html = err || (r?.ok ? this.analysisHTML(r) : '<p class="muted">Nothing compiled yet.</p>');
        break;
    }
    this.drawer.innerHTML = html;
  }

  analysisHTML(r) {
    const a = r.analysis ?? r.leaf_analysis?.[0] ?? {};
    const all = r.leaf_analysis ?? [a];
    const every = (k) => all.every((x) => x[k]);
    const any = (k) => all.some((x) => x[k]);
    const item = (label, value, good) => `<div class="metric"><div class="metric__l">${label}</div><div class="metric__v ${good === true ? 'good' : good === false ? 'bad' : ''}">${value}</div></div>`;
    return `<div class="metrics">
      ${item('Script size', `${r.script_size} B`)}
      ${item('Max witness', r.max_weight_to_satisfy ? `${fmtInt(r.max_weight_to_satisfy)} WU` : '–')}
      ${item('Spending paths', this.app.built.paths.length)}
      ${r.leaves ? item('Tap leaves', r.leaves.length) : item('Tree height', a.tree_height ?? '–')}
      ${item('Safe', every('safe') ? 'yes' : 'no', every('safe'))}
      ${item('Non-malleable', every('non_malleable') ? 'yes' : 'no', every('non_malleable'))}
      ${item('Sane', every('sane') ? 'yes' : 'no', every('sane'))}
      ${item('Timelock mixing', any('timelock_mixing') ? 'yes' : 'none', !any('timelock_mixing'))}
    </div>
    <div class="mono muted small">scriptPubKey ${esc(r.script_pubkey)}</div>`;
  }
}

const FRAGMENTS = /\b(and_v|and_b|and_n|andor|or_b|or_c|or_d|or_i|thresh|multi_a|multi|pk_k|pk_h|pkh|pk|older|after|sha256|hash256|ripemd160|hash160|and|or|wsh|tr|sh|wpkh)(?=\()/g;

function highlight(src) {
  return esc(src)
    .replace(/(\[[0-9a-f]{8}[^\]]*\])/g, '<span class="tk-origin">$1</span>')
    .replace(/\b([xt]pub[1-9A-HJ-NP-Za-km-z]{100,})/g, (m) => `<span class="tk-key" title="${m}">${m.slice(0, 8)}…${m.slice(-6)}</span>`)
    .replace(FRAGMENTS, '<span class="tk-frag">$1</span>')
    .replace(/\b([a-z]{1,4}):(?=<span class="tk-frag">)/g, '<span class="tk-wrap">$1:</span>')
    .replace(/(\d+)@/g, '<span class="tk-weight">$1@</span>')
    .replace(/#([a-z0-9]{8})$/, '<span class="tk-check">#$1</span>');
}

function asmHighlight(asm) {
  return esc(asm)
    .replace(/(OP_[A-Z0-9_]+)/g, '<span class="tk-op">$1</span>')
    .replace(/&lt;([^&]+)&gt;/g, '<span class="tk-alias">&lt;$1&gt;</span>');
}
