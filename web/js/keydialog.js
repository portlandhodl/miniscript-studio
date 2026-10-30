// "Add your key" dialog: paste an xpub (public key only), optionally add its key
// origin, preview its LifeHash and attach it to a key block. Private key material
// is detected and refused: it is cleared immediately and never stored.
import { parseKey } from './wasm.js';
import { lifehashImg } from './lifehash.js';
import { icon } from './icons.js';
import { $, esc, privateMaterial } from './util.js';

const PATH_RE = /^m?\/?(\d+[hH']?)(\/\d+[hH']?)*$/;

export class KeyDialog {
  constructor(app) {
    this.app = app;
    this.dlg = $('#key-dialog');
    this.parsed = null;
    for (const id of ['#kc-input', '#kc-fp', '#kc-path']) $(id).addEventListener('input', () => this.update());
    $('#kc-use').addEventListener('click', () => this.use());
    this.dlg.addEventListener('close', () => {
      $('#kc-input').value = $('#kc-fp').value = $('#kc-path').value = '';
      this.update();
    });
  }

  /** Opens the dialog for `nodeId` (an existing key block) or a block created on use. */
  open(nodeId = null) {
    this.target = nodeId;
    this.update();
    this.dlg.showModal();
    setTimeout(() => $('#kc-input').focus(), 50);
  }

  /** The key string to parse: input as-is, or prefixed with the origin fields. */
  candidate() {
    const raw = $('#kc-input').value.trim();
    const bare = raw && !raw.startsWith('[') && /^[xtyzuvYZUV]pub/.test(raw);
    $('#kc-origin').hidden = !bare;
    if (!bare) return raw;
    const fp = $('#kc-fp').value.trim().toLowerCase();
    const path = $('#kc-path').value.trim().replace(/^m\/?/, '');
    if (/^[0-9a-f]{8}$/.test(fp) && PATH_RE.test(path)) return `[${fp}/${path}]${raw}`;
    return raw;
  }

  update() {
    const status = $('#kc-status');
    const preview = $('#kc-preview');
    this.parsed = null;
    $('#kc-use').disabled = true;

    const secret = privateMaterial($('#kc-input').value);
    if (secret) {
      $('#kc-input').value = '';
      $('#kc-origin').hidden = true;
      status.innerHTML = `<div class="callout callout--bad">${icon('alert')}<span>That looked like <b>${secret}</b>. It was cleared and not stored. Paste only an <b>xpub</b>. Never share private keys or seed words, and if this one was real, consider it exposed.</span></div>`;
      preview.innerHTML = '';
      return;
    }

    const key = this.candidate();
    if (!key) {
      status.innerHTML = '';
      preview.innerHTML = `<div class="kc__empty">Paste an xpub to preview its LifeHash.</div>`;
      return;
    }
    const r = parseKey(key);
    if (!r.ok) {
      status.innerHTML = `<div class="callout callout--warn">${icon('alert')}<span>${esc(r.error)}</span></div>`;
      preview.innerHTML = `<div class="kc__empty kc__empty--bad">Not a valid public key</div>`;
      return;
    }
    this.parsed = r;
    $('#kc-use').disabled = false;
    const mainnet = this.app.model.state.network === 'bitcoin';
    const notes = [];
    if (r.mainnet != null && r.mainnet !== mainnet) notes.push(`This key is for ${r.mainnet ? 'mainnet' : 'a test network'}; the wallet is set to ${this.app.model.state.network}.`);
    if (!key.startsWith('[')) notes.push('No key origin: hardware signers may not recognise this key when signing.');
    if (!r.multipath) notes.push('Not a <code>&lt;0;1&gt;/*</code> multipath key, so this block can only be used in one spending path.');
    status.innerHTML = notes.map((n) => `<div class="callout callout--warn">${icon('alert')}<span>${n}</span></div>`).join('');
    preview.innerHTML = `
      ${lifehashImg(r.key, 'lifehash--hero')}
      <div class="kv">
        <div><span>Fingerprint</span><b class="mono">${r.fingerprint}</b></div>
        <div><span>Type</span><b>${r.kind === 'xpub' ? 'xpub' : 'single key'}${r.multipath ? ' · multipath' : ''}</b></div>
      </div>
      <p class="caption">Compare this LifeHash with your coordinator or device before funding.</p>`;
  }

  use() {
    const { app } = this;
    const m = app.model;
    if (!this.parsed) return;
    let node = m.node(this.target);
    if (!node || node.type !== 'key') {
      const c = $('#canvas').getBoundingClientRect();
      const w = app.canvas.toWorld(c.left + c.width / 2 - 120, c.top + c.height / 2 - 60);
      node = m.addNode('key', w.x, w.y, { label: app.nextKeyLabel('My key'), role: 'hardware' });
    }
    m.update(node.id, { key: this.parsed.key, seed: null, origin: 'xpub' });
    m.commit();
    this.dlg.close();
    app.canvas.select(node.id);
  }
}
