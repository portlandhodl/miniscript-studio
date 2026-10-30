// "Your key" dialog: create fresh BIP-39 seed words or restore existing ones,
// derive the BIP-48 account xpub in WASM, and attach it to a key block.
// Seed words and passphrases are never stored or sent anywhere; they live only in
// this dialog's DOM and are wiped when it closes.
import { newMnemonic, mnemonicKey } from './wasm.js';
import { lifehashImg } from './lifehash.js';
import { $, $$, esc, randomHex, copyText } from './util.js';

export class KeyCeremony {
  constructor(app) {
    this.app = app;
    this.dlg = $('#key-dialog');
    this.mode = 'create';
    this.len = 16;
    this.words = [];
    this.derived = null;

    $$('#kc-mode [data-mode]').forEach((b) => b.addEventListener('click', () => this.setMode(b.dataset.mode)));
    $$('#kc-length [data-len]').forEach((b) =>
      b.addEventListener('click', () => {
        this.len = Number(b.dataset.len);
        $$('#kc-length [data-len]').forEach((x) => x.classList.toggle('is-active', x === b));
        this.generate();
      }));
    $('#kc-regen').addEventListener('click', () => this.generate());
    $('#kc-reveal').addEventListener('click', () => {
      const masked = $('#kc-words').classList.toggle('is-masked');
      $('#kc-reveal').textContent = masked ? 'Reveal words' : 'Hide words';
    });
    for (const id of ['#kc-pass', '#kc-account', '#kc-input']) $(id).addEventListener('input', () => this.derive());
    $('#kc-ack').addEventListener('change', () => this.updateUse());
    $('#kc-use').addEventListener('click', () => this.use());
    this.dlg.addEventListener('close', () => this.wipe());
  }

  /** Opens the dialog for `nodeId` (an existing key block) or a block created on use. */
  open(nodeId = null, mode = 'create') {
    this.target = nodeId;
    this.setMode(mode);
    this.dlg.showModal();
  }

  setMode(mode) {
    this.mode = mode;
    $$('#kc-mode [data-mode]').forEach((b) => b.classList.toggle('is-active', b.dataset.mode === mode));
    $('#kc-create').hidden = mode !== 'create';
    $('#kc-restore').hidden = mode !== 'restore';
    $('#kc-ack-wrap').hidden = mode !== 'create';
    $('#kc-note').innerHTML = `<span>${mode === 'create'
      ? `Words are generated in this browser with <code>crypto.getRandomValues</code> and never leave it. Nothing is stored; they vanish when this dialog closes. That is fine for learning and testnets. For serious funds, create seeds on a hardware wallet and paste its xpub instead.`
      : `Restoring derives the same BIP-48 account (<code>m/48'/coin'/account'/2'</code>) that Sparrow, Liana and most multisig coordinators use. The words never leave this browser and aren’t saved.`}</span>`;
    if (mode === 'create') this.generate();
    else this.derive();
    if (mode === 'restore') setTimeout(() => $('#kc-input').focus(), 50);
  }

  generate() {
    const r = newMnemonic(randomHex(this.len));
    this.words = r.ok ? r.words : [];
    $('#kc-words').innerHTML = this.words.map((w) => `<li><span>${esc(w)}</span></li>`).join('');
    $('#kc-words').classList.add('is-masked');
    $('#kc-reveal').textContent = 'Reveal words';
    $('#kc-ack').checked = false;
    this.derive();
  }

  phrase() {
    return this.mode === 'create' ? this.words.join(' ') : $('#kc-input').value.trim();
  }

  derive() {
    const words = this.phrase();
    const preview = $('#kc-preview');
    this.derived = null;
    if (!words) {
      preview.innerHTML = `<div class="kc__empty">Enter your seed words to preview the key.</div>`;
      return this.updateUse();
    }
    const account = Math.max(0, Math.min(1000, Number($('#kc-account').value) || 0));
    const r = mnemonicKey(words, $('#kc-pass').value, this.app.model.state.network, account);
    if (!r.ok) {
      preview.innerHTML = `<div class="kc__empty kc__empty--bad">${esc(r.error)}</div>`;
      return this.updateUse();
    }
    this.derived = r;
    preview.innerHTML = `
      ${lifehashImg(r.key, 'lifehash--hero')}
      <div class="kv">
        <div><span>Fingerprint</span><b class="mono">${r.fingerprint}</b></div>
        <div><span>Path</span><b class="mono">${r.path}</b></div>
      </div>
      <button class="copy-block copy-block--compact kc__xpub" type="button" title="Copy xpub">
        <div class="copy-block__head"><span>Account xpub</span></div>
        <div class="copy-block__text mono">${esc(r.xpub)}</div>
      </button>
      <p class="caption">A passphrase changes everything: different fingerprint, different LifeHash. Check this image when you restore.</p>`;
    preview.querySelector('.kc__xpub').addEventListener('click', () => copyText(r.key));
    this.updateUse();
  }

  updateUse() {
    $('#kc-use').disabled = !this.derived || (this.mode === 'create' && !$('#kc-ack').checked);
  }

  use() {
    const { app } = this;
    const m = app.model;
    const d = this.derived;
    if (!d) return;
    let node = m.node(this.target);
    if (!node || node.type !== 'key') {
      const c = $('#canvas').getBoundingClientRect();
      const w = app.canvas.toWorld(c.left + c.width / 2 - 120, c.top + c.height / 2 - 60);
      node = m.addNode('key', w.x, w.y, { label: app.nextKeyLabel('My key'), role: 'hardware' });
    }
    m.update(node.id, { key: d.key, seed: null, origin: this.mode === 'create' ? 'created' : 'restored' });
    m.commit();
    this.dlg.close();
    app.canvas.select(node.id);
  }

  wipe() {
    this.words = [];
    this.derived = null;
    $('#kc-words').innerHTML = '';
    $('#kc-input').value = '';
    $('#kc-pass').value = '';
    $('#kc-ack').checked = false;
    $('#kc-preview').innerHTML = '';
  }
}
