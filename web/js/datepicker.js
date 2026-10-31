// Small calendar popover. Unlike the native date input's picker, it is positioned by us and
// always kept inside the viewport (flips above the field and shifts sideways when needed).
import { esc } from './util.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MARGIN = 8;
const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;

let open = null;

export function closeDatePicker() {
  open?.cleanup();
  open = null;
}

/**
 * Opens a calendar under `anchor`. `value` and the picked date are local `YYYY-MM-DD`.
 * `onPick(value)` is called with the chosen date; `extra` adds footer buttons `{ label, onClick }`.
 */
export function openDatePicker(anchor, value, onPick, { extra = [], min = 2009, max = 2100 } = {}) {
  closeDatePicker();
  const today = new Date();
  const todayIso = iso(today.getFullYear(), today.getMonth(), today.getDate());
  const sel = /^\d{4}-\d{2}-\d{2}$/.test(value ?? '') ? value : todayIso;
  let view = { y: Number(sel.slice(0, 4)), m: Number(sel.slice(5, 7)) - 1 };

  const el = document.createElement('div');
  el.className = 'datepicker';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Choose a date');
  document.body.append(el);

  const render = () => {
    const first = new Date(view.y, view.m, 1).getDay();
    const days = new Date(view.y, view.m + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < first; i++) cells.push('<span></span>');
    for (let d = 1; d <= days; d++) {
      const v = iso(view.y, view.m, d);
      cells.push(`<button type="button" data-day="${v}" class="${v === sel ? 'is-selected' : ''} ${v === todayIso ? 'is-today' : ''}">${d}</button>`);
    }
    const years = [];
    for (let y = max; y >= min; y--) years.push(`<option value="${y}" ${y === view.y ? 'selected' : ''}>${y}</option>`);
    el.innerHTML = `
      <div class="datepicker__head">
        <button type="button" class="icon-btn" data-nav="-1" aria-label="Previous month">‹</button>
        <div class="datepicker__title">
          <select data-month aria-label="Month">${MONTHS.map((n, i) => `<option value="${i}" ${i === view.m ? 'selected' : ''}>${n}</option>`).join('')}</select>
          <select data-year aria-label="Year">${years.join('')}</select>
        </div>
        <button type="button" class="icon-btn" data-nav="1" aria-label="Next month">›</button>
      </div>
      <div class="datepicker__grid">${DAYS.map((d) => `<span class="datepicker__dow">${d}</span>`).join('')}${cells.join('')}</div>
      <div class="datepicker__foot">
        <button type="button" class="btn btn--ghost btn--sm" data-today>Today</button>
        ${extra.map((x, i) => `<button type="button" class="btn btn--ghost btn--sm" data-extra="${i}">${esc(x.label)}</button>`).join('')}
      </div>`;
    place();
  };

  // Below the anchor, right-aligned to it; flipped above and clamped so it never leaves the screen.
  const place = () => {
    if (!anchor.isConnected) return closeDatePicker();
    const a = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    let left = Math.min(a.right - w, vw - w - MARGIN);
    left = Math.max(MARGIN, left);
    let top = a.bottom + 6;
    if (top + h > vh - MARGIN) top = a.top - h - 6;
    top = Math.max(MARGIN, Math.min(top, vh - h - MARGIN));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  };

  const pick = (v) => {
    closeDatePicker();
    onPick(v);
  };
  el.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.day) pick(t.dataset.day);
    else if (t.dataset.nav) {
      const d = new Date(view.y, view.m + Number(t.dataset.nav), 1);
      view = { y: d.getFullYear(), m: d.getMonth() };
      render();
    } else if (t.hasAttribute('data-today')) pick(todayIso);
    else if (t.dataset.extra) {
      closeDatePicker();
      extra[Number(t.dataset.extra)].onClick();
    }
  });
  el.addEventListener('change', (e) => {
    if (e.target.matches('[data-month]')) view.m = Number(e.target.value);
    if (e.target.matches('[data-year]')) view.y = Number(e.target.value);
    render();
  });

  const outside = (e) => !el.contains(e.target) && !anchor.contains(e.target) && closeDatePicker();
  const key = (e) => e.key === 'Escape' && (e.stopPropagation(), closeDatePicker(), anchor.focus());
  setTimeout(() => document.addEventListener('pointerdown', outside, true));
  document.addEventListener('keydown', key, true);
  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, true);
  open = {
    cleanup() {
      el.remove();
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    },
  };
  render();
  el.querySelector('.is-selected, .is-today, [data-day]')?.focus();
}
