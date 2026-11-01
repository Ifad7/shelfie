'use strict';

// ------------------------------------------------------------------ helpers
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const pct = (c) => (c == null ? '—' : `${Math.round(c * 100)}%`);
const authorsText = (a) => (a && a.length ? a.join(', ') : 'Unknown author');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const STATUS_LABEL = { pending: 'Pending', processing: 'Reading…', identified: 'Identified', uncertain: 'Uncertain',
  failed: 'Failed', not_book: 'Not a book', verified: 'Verified' };
const READING = { unread: 'Unread', reading: 'Reading', read: 'Read', abandoned: 'Abandoned', wishlist: 'Wishlist' };
const PALETTE = ['#7b2d26', '#2f4f6f', '#3e5f3a', '#8a6a2f', '#5b3a5e', '#2f6a6a', '#6b3f2a', '#4a4f5a',
  '#913f3f', '#35556b', '#6f5a22', '#3d3b6b', '#5a2e3f', '#2e5446'];

function hashStr(s) {
  let h = 2166136261;
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const bookColor = (b) => PALETTE[hashStr((b.title || '') + ((b.authors || [])[0] || '')) % PALETTE.length];

async function api(path, opts = {}) {
  const init = { method: opts.method || (opts.body ? 'POST' : 'GET'), headers: {} };
  if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); init.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(path, init);
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

function toast(msg, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, isError ? 7000 : 3200);
}

async function run(fn) {
  try { return await fn(); } catch (e) { toast(e.message, true); return undefined; }
}

function qs(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== '' && v != null && v !== false) p.set(k, v);
  return p.toString();
}

const thumb = (id, large) => `/api/images/${id}/thumb${large ? '?size=large' : ''}`;
const badge = (s) => `<span class="badge ${esc(s)}">${esc(STATUS_LABEL[s] || s)}</span>`;

/** A cover: the photo if we have one, otherwise a cloth-bound cover in the book's colour. */
function coverHtml(b, large = false) {
  if (b.cover_id) return `<img class="cover-img" loading="lazy" src="${thumb(b.cover_id, large)}" alt="">`;
  const a = (b.authors || [])[0] || '';
  return `<div class="cloth" style="--c:${bookColor(b)}"><div class="cloth-t">${esc(b.title)}</div><div class="cloth-a">${esc(a)}</div></div>`;
}

function confHtml(c) {
  if (c == null) return '';
  const cls = c >= 0.8 ? '' : c >= 0.6 ? 'mid' : 'low';
  return `<div class="conf ${cls}" title="How sure Gemini is about this identification"><span>Confidence</span>
    <div class="bar"><div style="width:${Math.round(c * 100)}%"></div></div><b>${pct(c)}</b></div>`;
}

function renderPager(el, total, page, per, onPage) {
  const pages = Math.max(1, Math.ceil(total / per));
  if (pages <= 1) { el.innerHTML = ''; return; }
  el.innerHTML = `<button data-p="${page - 1}" ${page <= 1 ? 'disabled' : ''}>‹ Prev</button>
    <span class="muted small">Page ${page} of ${pages} · ${total} items</span>
    <button data-p="${page + 1}" ${page >= pages ? 'disabled' : ''}>Next ›</button>`;
  $$('button', el).forEach((b) => b.onclick = () => onPage(Number(b.dataset.p)));
}

function emptyState(art, title, text, action = '') {
  return `<div class="empty"><div class="art">${art}</div><h3>${title}</h3><p>${text}</p>${action}</div>`;
}

// ------------------------------------------------------------------ theme
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  $('#theme-label').textContent = t === 'dark' ? 'Night' : 'Day';
  try { localStorage.setItem('theme', t); } catch { /* ignore */ }
}
setTheme(document.documentElement.dataset.theme || 'light');
$('#theme-toggle').onclick = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');

// ------------------------------------------------------------------ state & routing
const store = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
const state = {
  view: 'library',
  status: null,
  lib: { q: '', genre: '', author: '', language: '', reading_status: '', favorite: false, sort: 'title',
    page: 1, per_page: 60, layout: store('layout', 'grid') === 'list' ? 'list' : 'grid', selected: new Set() },
  img: { q: '', status: '', folder_id: '', page: 1, per_page: 60, selected: new Set(), items: [] },
  finds: { page: 1, per_page: 48, selected: new Set(), items: [] },
  review: { status: 'uncertain', page: 1, per_page: 20 },
  lastProcessed: -1, lastScanRunning: false, lastImgRefresh: 0, lastFinds: -1, lastShelfCount: -1,
};

const VIEWS = { library: renderLibrary, feed: renderFeed, import: renderImport, finds: renderFinds, review: renderReview, settings: renderSettings };

function showView() {
  const v = (location.hash || '#library').slice(1);
  state.view = VIEWS[v] ? v : 'library';
  $$('.view').forEach((el) => {
    const on = el.id === `view-${state.view}`;
    if (on && el.hidden) { el.style.animation = 'none'; void el.offsetWidth; el.style.animation = ''; }
    el.hidden = !on;
  });
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === state.view));
  window.scrollTo({ top: 0 });
  VIEWS[state.view]();
}
window.addEventListener('hashchange', showView);
const refreshView = () => VIEWS[state.view]();

// ------------------------------------------------------------------ status polling
const setPill = (sel, n) => { const el = $(sel); el.hidden = !n; el.textContent = n; };

async function poll() {
  let s;
  try { s = await api('/api/status'); } catch { return; }
  state.status = s;
  const u = s.usage;
  $('#quota-text').textContent = `${u.requests} / ${u.daily_limit}`;
  const ratio = Math.min(1, u.requests / Math.max(1, u.daily_limit));
  $('#quota-meter div').style.width = `${ratio * 100}%`;
  $('#quota-meter').classList.toggle('hot', ratio > 0.85);
  setPill('#nav-library', s.books.total);
  setPill('#nav-pending', s.counts.pending + s.counts.processing);
  setPill('#nav-finds', s.books.finds);
  setPill('#nav-review', s.counts.uncertain + s.counts.failed);
  renderAlert(s.processor);

  if (s.books.total !== state.lastShelfCount) { state.lastShelfCount = s.books.total; loadBookcase(); }
  if (state.view === 'import') {
    updateProcessPanel(s);
    const processed = s.processor.run.processed;
    const now = Date.now();
    if ((processed !== state.lastProcessed || s.processor.state !== 'idle') && now - state.lastImgRefresh > 4000) {
      state.lastProcessed = processed;
      loadImages(true);
    }
    if (state.lastScanRunning && !s.scanner.running) { loadFolders(); loadImages(true); }
    if (s.books.finds !== state.lastFinds) renderFindsCallout(s.books.finds);
  }
  if (state.view === 'finds' && s.books.finds !== state.lastFinds && state.lastFinds !== -1 && !state.finds.selected.size) loadFinds(true);
  state.lastFinds = s.books.finds;
  if (state.lastScanRunning && !s.scanner.running && s.scanner.message) toast(s.scanner.message);
  state.lastScanRunning = s.scanner.running;
}
setInterval(poll, 1500);

// ------------------------------------------------------------------ alert banner
const ALERT_ICONS = { gemini_limit: '⛔', app_limit: '⏸️', overloaded: '🌩️', config: '⚠️' };

function resetText(iso) {
  const at = new Date(iso);
  const mins = Math.max(0, Math.round((at - Date.now()) / 60000));
  const h = Math.floor(mins / 60), m = mins % 60;
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const day = at.toDateString() === new Date().toDateString() ? 'today' : 'tomorrow';
  return `Limits reset at ${time} ${day} your time (in ${h ? `${h} h ` : ''}${m} min).`;
}

let lastAlertKey = '';
function renderAlert(p) {
  const el = $('#alert-banner');
  const a = p.state === 'paused' ? p.alert : null;
  if (!a) { el.hidden = true; lastAlertKey = ''; return; }
  const key = a.kind + a.title + (a.reset_at || '') + Math.floor(Date.now() / 60000);
  if (key === lastAlertKey) return;
  lastAlertKey = key;
  el.className = 'alert-banner' + (a.kind === 'gemini_limit' || a.kind === 'config' ? ' bad' : '');
  el.innerHTML = `<div class="icon">${ALERT_ICONS[a.kind] || '⚠️'}</div>
    <div class="body"><b>${esc(a.title)}</b><div>${esc(a.detail)}</div>
      ${a.reset_at ? `<div class="reset">${esc(resetText(a.reset_at))}</div>` : ''}</div>
    <div class="acts"><button class="primary" id="alert-resume">Resume</button>
      ${a.kind !== 'overloaded' ? '<a class="button ghost" href="#settings">Settings</a>' : ''}
      <button class="ghost" id="alert-cancel">Stop</button></div>`;
  el.hidden = false;
  $('#alert-resume').onclick = () => run(async () => { await api('/api/process/resume', { body: {} }); poll(); });
  $('#alert-cancel').onclick = () => run(async () => { await api('/api/process/cancel', { body: {} }); poll(); });
}

// ------------------------------------------------------------------ bookcase (right sidebar)
const bookcase = $('#bookcase');
function setBookcase(collapsed) {
  bookcase.classList.toggle('collapsed', collapsed);
  $('#bookcase-toggle').style.transform = collapsed ? 'rotate(180deg)' : '';
  $('#bookcase-toggle').title = collapsed ? 'Show the bookshelf' : 'Collapse the bookshelf';
  try { localStorage.setItem('bookcase', collapsed ? 'collapsed' : 'open'); } catch { /* ignore */ }
}
setBookcase(store('bookcase', innerWidth < 1380 ? 'collapsed' : 'open') === 'collapsed');
$('#bookcase-toggle').onclick = () => setBookcase(!bookcase.classList.contains('collapsed'));
$('#bookcase-vert').onclick = () => setBookcase(false);

// ---- named shelves (shared by the bookcase sidebar and the Library's shelf view)
state.shelves = [];  // [{id, name, position, count}]
const shelfName = (id) => (state.shelves.find((s) => s.id === id) || {}).name || 'Unsorted';
const shelfOptions = (sel) => `<option value="" ${sel == null ? 'selected' : ''}>Unsorted</option>` +
  state.shelves.map((s) => `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${esc(s.name)}</option>`).join('');

/** Small text prompt in our own modal (keeps the look consistent). Resolves to the text or null. */
function askText(title, { value = '', placeholder = '', ok = 'Save', hint = '' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const body = openModal(`<h2>${esc(title)}</h2>${hint ? `<p class="muted">${esc(hint)}</p>` : ''}
      <input type="text" id="ask-input" value="${esc(value)}" placeholder="${esc(placeholder)}" style="width:100%;margin-top:10px" maxlength="80">
      <div class="modal-actions"><div></div><div><button data-close>Cancel</button><button class="primary" id="ask-ok">${esc(ok)}</button></div></div>`,
    { small: true, onClose: () => finish(null) });
    const input = $('#ask-input', body);
    const submit = () => { const v = input.value.trim(); if (!v) { input.focus(); return; } finish(v); closeModal(false); };
    $('[data-close]', body).onclick = () => closeModal(false);
    $('#ask-ok', body).onclick = submit;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    setTimeout(() => { input.focus(); input.select(); }, 50);
  });
}

async function newShelf() {
  const name = await askText('New shelf', { placeholder: 'e.g. Bangla classics, To read, Science…', ok: 'Create shelf',
    hint: 'Shelves let you organise your library however you like. Drag books onto them afterwards.' });
  if (!name) return;
  await run(async () => {
    await api('/api/shelves', { body: { name } });
    toast(`Shelf “${name}” added`);
    await refreshShelves();
  });
}

async function renameShelf(id) {
  const name = await askText('Rename shelf', { value: shelfName(id), ok: 'Rename' });
  if (!name) return;
  await run(async () => { await api(`/api/shelves/${id}`, { method: 'PUT', body: { name } }); await refreshShelves(); });
}

async function deleteShelf(id) {
  if (!confirm(`Remove the shelf “${shelfName(id)}”? Its books are kept and moved to Unsorted.`)) return;
  await run(async () => { await api(`/api/shelves/${id}`, { method: 'DELETE' }); toast('Shelf removed'); await refreshShelves(); });
}

async function moveShelf(id, dir) {
  const ids = state.shelves.map((s) => s.id);
  const i = ids.indexOf(id), j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  await run(async () => { await api('/api/shelves/order', { body: { ids } }); await refreshShelves(); });
}

/** Re-render everything that shows shelves. */
async function refreshShelves() {
  await loadBookcase();
  if (fullcase.open) renderFullcase(true);
  if (state.view === 'library') { fillShelfFilter(); loadBooks(true); }
  if (state.view === 'finds') fillFindsShelf();
}

/**
 * Drag and drop: items can be dragged within a zone (to reorder) or into another zone (to move shelf).
 * The dragged element itself moves live so you see where it will land; on drop the zone's order is saved.
 */
let dragEl = null;
function wireDnD(root, itemSel, zoneSel, onDropped) {
  $$(itemSel, root).forEach((el) => {
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      dragEl = el;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', el.dataset.id);
      requestAnimationFrame(() => el.classList.add('dragging'));
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      $$('.drop-on', root).forEach((z) => z.classList.remove('drop-on'));
      const zone = el.closest(zoneSel);
      dragEl = null;
      if (zone) onDropped(zone, el);
    });
  });
  $$(zoneSel, root).forEach((zone) => {
    zone.addEventListener('dragover', (e) => {
      if (!dragEl || !root.contains(dragEl)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      $$('.drop-on', root).forEach((z) => z !== zone && z.classList.remove('drop-on'));
      zone.classList.add('drop-on');
      const over = e.target.closest(itemSel);
      if (over && over !== dragEl && zone.contains(over)) {
        const r = over.getBoundingClientRect();
        const after = e.clientX > r.left + r.width / 2;
        const ref = after ? over.nextElementSibling : over;
        if (ref !== dragEl) over.parentNode.insertBefore(dragEl, ref);
      } else if (!over) {
        const items = $$(itemSel, zone).filter((x) => x !== dragEl);
        const last = items[items.length - 1];
        const lr = last && last.getBoundingClientRect();
        if (!last || e.clientY > lr.bottom || (e.clientY >= lr.top && e.clientX > lr.right)) {
          if (zone.lastElementChild !== dragEl || dragEl.parentNode !== zone) {
            const hint = $('.drop-hint', zone);
            zone.insertBefore(dragEl, hint && hint.parentNode === zone ? hint : null);
          }
        }
      }
    });
    zone.addEventListener('dragleave', (e) => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('drop-on'); });
    zone.addEventListener('drop', (e) => e.preventDefault());
  });
}

async function saveZoneOrder(zone, itemSel) {
  const shelfId = zone.dataset.shelf ? Number(zone.dataset.shelf) : null;
  const ids = $$(itemSel, zone).map((x) => Number(x.dataset.id));
  await run(() => api('/api/shelves/arrange', { body: { shelf_id: shelfId, book_ids: ids } }));
}

// ---- the bookcase sidebar
let shelfIds = new Set();
async function loadBookcase(freshIds = []) {
  const d = await api('/api/shelf').catch(() => null);
  if (!d) return;
  state.shelves = d.shelves;
  const books = d.books;
  $('#bookcase-count').textContent = plural(books.length, 'book');
  const body = $('#bookcase-shelves');
  const fresh = new Set(freshIds.length ? freshIds : books.filter((b) => shelfIds.size && !shelfIds.has(b.id)).map((b) => b.id));
  shelfIds = new Set(books.map((b) => b.id));
  const spine = (b) => {
    const h = hashStr(b.title);
    const w = b.page_count ? Math.max(16, Math.min(32, 12 + b.page_count / 30)) : 16 + (h % 13);
    return `<div class="slot" data-id="${b.id}"><div class="spine ${fresh.has(b.id) ? 'fresh' : ''}" title="${esc(b.title)} — ${esc(authorsText(b.authors))}${formatNote(b)}"
      style="--c:${bookColor(b)};width:${w}px;height:${84 + (h % 32)}px">${fileDot(b)}<span>${esc(b.title)}</span></div></div>`;
  };
  const group = (id, name, list) => `<div class="case-group">
      <div class="case-label"><span class="plate ${id ? '' : 'unsorted'}" ${id ? `data-rename="${id}" title="Double-click to rename"` : ''}>${esc(name)}</span>
        <span class="cnt">${list.length}</span>
        ${id ? `<span class="mini"><button data-ren="${id}" title="Rename">✎</button><button data-del="${id}" title="Remove shelf">✕</button></span>` : ''}</div>
      <div class="case-zone" data-shelf="${id || ''}">${list.map(spine).join('')}<div class="drop-hint">${id ? 'Drag books here' : (books.length ? 'Nothing unsorted' : 'Add books from New Finds')}</div></div>
    </div>`;
  const unsorted = books.filter((b) => b.shelf_id == null);
  body.innerHTML = d.shelves.map((s) => group(s.id, s.name, books.filter((b) => b.shelf_id === s.id))).join('')
    + group(null, 'Unsorted', unsorted)
    + '<button class="button add-shelf-btn" id="case-add-shelf">＋ Add a shelf</button>'
    + '<div class="case-zone filler" aria-hidden="true"></div>';
  $$('.slot', body).forEach((s) => s.onclick = () => openBook(Number(s.dataset.id)));
  $$('[data-rename]', body).forEach((p) => p.ondblclick = () => renameShelf(Number(p.dataset.rename)));
  $$('[data-ren]', body).forEach((b) => b.onclick = () => renameShelf(Number(b.dataset.ren)));
  $$('[data-del]', body).forEach((b) => b.onclick = () => deleteShelf(Number(b.dataset.del)));
  $('#case-add-shelf', body).onclick = newShelf;
  wireDnD(body, '.slot', '.case-zone:not(.filler)', async (zone) => {
    await saveZoneOrder(zone, '.slot');
    await loadBookcase();
    if (state.view === 'library') loadBooks(true);
  });
}
$('#bookcase-add').onclick = newShelf;

// ---- the full-screen bookcase ("reading room")
const fullcase = { open: false, mode: store('fcMode', 'spines'), q: '', data: null };

function openFullcase() {
  fullcase.open = true;
  $('#fullcase').hidden = false;
  $('#fullcase').classList.remove('closing');
  document.body.style.overflow = 'hidden';
  $$('#fc-mode button').forEach((b) => b.classList.toggle('active', b.dataset.m === fullcase.mode));
  renderFullcase();
  setTimeout(() => $('#fc-q').focus({ preventScroll: true }), 300);
}

function closeFullcase() {
  if (!fullcase.open) return;
  fullcase.open = false;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  const el = $('#fullcase');
  el.classList.add('closing');
  setTimeout(() => { el.hidden = true; el.classList.remove('closing'); }, reduceMotion ? 0 : 260);
  document.body.style.overflow = '';
  refreshView();
}

async function renderFullcase(quiet = false) {
  const d = await api('/api/shelf').catch(() => null);
  if (!d) return;
  fullcase.data = d;
  state.shelves = d.shelves;
  const books = d.books;
  const covers = fullcase.mode === 'covers';
  const nShelves = d.shelves.length + 1;
  $('#fc-sub').textContent = `${plural(books.length, 'book')} on ${nShelves} ${nShelves === 1 ? 'shelf' : 'shelves'} · drag books between shelves to organise · Esc to close`;
  const slot = (b) => {
    const h = hashStr(b.title);
    const peek = `<div class="peek"><div class="pc">${coverHtml(b)}</div><b>${esc(b.title)}</b>${esc(authorsText(b.authors))}${b.publication_year ? ` · ${esc(b.publication_year)}` : ''}
      ${b.ebook_ext ? `<div class="peek-pdf">${b.readable ? '📖' : '⬇'} ${esc(b.ebook_ext.toUpperCase())}${b.ebook_pct ? ` · ${Math.round(b.ebook_pct * 100)}% read` : ''}</div>` : ''}</div>`;
    if (covers) return `<div class="slot" data-id="${b.id}" data-title="${esc((b.title + ' ' + (b.authors || []).join(' ')).toLowerCase())}">
      <div class="mcover">${coverHtml(b)}${fmtChips(b)}</div></div>`;
    const w = b.page_count ? Math.max(24, Math.min(46, 16 + b.page_count / 18)) : 24 + (h % 18);
    const ht = 150 + (h % 42);
    return `<div class="slot" data-id="${b.id}" data-title="${esc((b.title + ' ' + (b.authors || []).join(' ')).toLowerCase())}">${peek}
      <div class="spine" style="--c:${bookColor(b)};width:${w}px;height:${ht}px">${fileDot(b)}<span>${esc(b.title)}</span>
        ${w >= 32 ? `<div class="au">${esc(((b.authors || [])[0] || '').split(' ').pop())}</div>` : ''}</div></div>`;
  };
  const bay = (id, name, list, i) => `<section class="fc-bay" style="--i:${i}">
      <div class="case-label"><span class="plate ${id ? '' : 'unsorted'}" ${id ? `data-rename="${id}" title="Double-click to rename"` : ''}>${esc(name)}</span>
        <span class="cnt">${plural(list.length, 'book')}</span>
        ${id ? `<span class="mini"><button data-up="${id}" title="Move this shelf earlier" ${i === 0 ? 'disabled' : ''}>↑</button><button data-down="${id}" title="Move this shelf later" ${i >= d.shelves.length - 1 ? 'disabled' : ''}>↓</button><button data-ren="${id}" title="Rename">✎</button><button data-del="${id}" title="Remove shelf">✕</button></span>` : ''}</div>
      <div class="case-zone ${covers ? 'covers' : ''}" data-shelf="${id || ''}">${list.map(slot).join('')}
        <div class="drop-hint">${id ? 'An empty shelf. Drag books here.' : 'Nothing unsorted.'}</div></div>
    </section>`;
  const room = $('#fc-room');
  room.innerHTML = !books.length && !d.shelves.length
    ? `<div class="fc-empty">Your bookcase is empty. Add books from New Finds and they'll appear here. 📚</div>`
    : d.shelves.map((s, i) => bay(s.id, s.name, books.filter((b) => b.shelf_id === s.id), i)).join('')
      + bay(null, 'Unsorted', books.filter((b) => b.shelf_id == null), d.shelves.length)
      + `<div class="fc-addbay" id="fc-addbay" style="--i:${d.shelves.length + 1}">＋ Add a shelf</div>`;
  room.classList.toggle('no-anim', quiet);
  $$('.slot', room).forEach((s) => {
    s.onclick = () => openBook(Number(s.dataset.id));
    // show the preview card on whichever side has room
    s.onmouseenter = () => s.classList.toggle('flip', s.getBoundingClientRect().right + 180 > innerWidth);
  });
  $$('[data-rename]', room).forEach((p) => p.ondblclick = () => renameShelf(Number(p.dataset.rename)));
  $$('[data-ren]', room).forEach((b) => b.onclick = () => renameShelf(Number(b.dataset.ren)));
  $$('[data-del]', room).forEach((b) => b.onclick = () => deleteShelf(Number(b.dataset.del)));
  $$('[data-up]', room).forEach((b) => b.onclick = () => moveShelf(Number(b.dataset.up), -1));
  $$('[data-down]', room).forEach((b) => b.onclick = () => moveShelf(Number(b.dataset.down), 1));
  if ($('#fc-addbay')) $('#fc-addbay').onclick = newShelf;
  wireDnD(room, '.slot', '.case-zone', async (zone) => {
    await saveZoneOrder(zone, '.slot');
    $$('.fc-bay', room).forEach((bayEl) => {  // refresh the counts without a full re-render
      $('.case-label .cnt', bayEl).textContent = plural($$('.slot', bayEl).length, 'book');
    });
    loadBookcase();
  });
  applyFullcaseSearch();
}

function applyFullcaseSearch() {
  const q = fullcase.q.toLowerCase();
  $$('#fc-room .slot').forEach((s) => {
    const hit = q && s.dataset.title.includes(q);
    s.classList.toggle('dim', !!q && !hit);
    s.classList.toggle('hit', !!hit);
  });
  $$('#fc-room .fc-bay').forEach((b) => b.classList.toggle('nomatch', !!q && !$('.slot.hit', b)));
  const first = q && $('#fc-room .slot.hit');
  if (first) first.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center', inline: 'nearest' });
}

$('#bookcase-max').onclick = openFullcase;
$('#lib-fullcase').onclick = openFullcase;
$('#fc-close').onclick = closeFullcase;
$('#fc-add').onclick = newShelf;
$('#fc-q').addEventListener('input', debounce((e) => { fullcase.q = e.target.value.trim(); applyFullcaseSearch(); }, 200));
$$('#fc-mode button').forEach((b) => b.onclick = () => {
  fullcase.mode = b.dataset.m;
  try { localStorage.setItem('fcMode', fullcase.mode); } catch { /* ignore */ }
  $$('#fc-mode button').forEach((x) => x.classList.toggle('active', x === b));
  renderFullcase();
});
$('#fc-screen').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else $('#fullcase').requestFullscreen?.().catch(() => toast('Your browser blocked full screen', true));
};

/** Animate a cover flying from a card into the bookcase (or the Library nav item when the bookcase is hidden). */
function flyToShelf(fromEl) {
  if (!fromEl || reduceMotion) return Promise.resolve();
  const r = fromEl.getBoundingClientRect();
  const visible = getComputedStyle(bookcase).display !== 'none';
  const target = (visible ? (bookcase.classList.contains('collapsed') ? bookcase : $('#bookcase-shelves')) : $('.nav a[data-view=library]')).getBoundingClientRect();
  const fly = fromEl.cloneNode(true);
  fly.className = 'flyer';
  Object.assign(fly.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  document.body.append(fly);
  const dx = target.left + target.width / 2 - (r.left + r.width / 2);
  const dy = target.top + Math.min(80, target.height / 2) - (r.top + r.height / 2);
  const anim = fly.animate([
    { transform: 'translate(0,0) rotate(0) scale(1)', opacity: 1 },
    { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 120}px) rotate(-12deg) scale(.7)`, opacity: 1, offset: 0.5 },
    { transform: `translate(${dx}px, ${dy}px) rotate(-90deg) scale(.18)`, opacity: 0.2 },
  ], { duration: 850, easing: 'cubic-bezier(.4,.1,.3,1)' });
  return anim.finished.then(() => fly.remove()).catch(() => fly.remove());
}

// ------------------------------------------------------------------ modal
let modalOnClose = null;
function openModal(html, { small = false, onClose = null } = {}) {
  $('#modal-body').innerHTML = html;
  const box = $('.modal-box');
  box.classList.toggle('small', small);
  box.style.animation = 'none'; void box.offsetWidth; box.style.animation = '';
  $('#modal').hidden = false;
  modalOnClose = onClose;
  return $('#modal-body');
}
function closeModal(refresh = true) {
  $('#modal').hidden = true;
  $('#modal-body').innerHTML = '';
  const cb = modalOnClose; modalOnClose = null;
  if (cb) cb(); else if (refresh) { refreshView(); poll(); loadBookcase(); if (fullcase.open) renderFullcase(true); }
}
$$('#modal [data-close]').forEach((el) => el.addEventListener('click', () => closeModal()));
document.addEventListener('keydown', (e) => {
  if (reader.open) { readerKey(e); return; }
  if (e.key !== 'Escape') return;
  if (!$('#modal').hidden) closeModal();
  else if (fullcase.open && !document.fullscreenElement) closeFullcase();
});
const lightbox = (imageId) => window.open(`/api/images/${imageId}/file`, '_blank');

// ------------------------------------------------------------------ book form
const FORM_FIELDS = [
  ['title', 'Title', 'c3'], ['subtitle', 'Subtitle', 'c3'],
  ['authors', 'Authors (separate with ;)', 'c3', 'list;'], ['series', 'Series', 'c2'], ['series_volume', 'Volume', ''],
  ['publisher', 'Publisher', 'c2'], ['publication_year', 'Year', ''], ['edition', 'Edition', ''], ['isbn', 'ISBN', 'c2'],
  ['language', 'Language', 'c2'], ['page_count', 'Pages', '', 'number'], ['genre', 'Genre', 'c3'],
  ['categories', 'Categories (comma separated)', 'c3', 'list'], ['target_audience', 'Target audience', 'c3'],
  ['topics', 'Topics & themes', 'c3', 'list'], ['keywords', 'Keywords', 'c3', 'list'],
  ['description', 'Description', 'c6', 'textarea'],
];

function bookFormHtml(b = {}) {
  const unsure = new Set(b.status === 'verified' ? [] : (b.uncertain_fields || []));
  const fields = FORM_FIELDS.map(([f, label, cls, kind]) => {
    let v = b[f];
    if (Array.isArray(v)) v = v.join(kind === 'list;' ? '; ' : ', ');
    const input = kind === 'textarea'
      ? `<textarea data-f="${f}" rows="3">${esc(v)}</textarea>`
      : `<input data-f="${f}" data-kind="${kind || ''}" ${kind === 'number' ? 'type="number" min="1"' : 'type="text"'} value="${esc(v)}">`;
    return `<label class="${cls} ${unsure.has(f) ? 'uncertain-field' : ''}">${label}${input}</label>`;
  }).join('');
  const rating = b.rating || 0;
  const personal = `
    <label class="c2">Reading status<select data-f="reading_status">${Object.entries(READING).map(([k, l]) =>
      `<option value="${k}" ${b.reading_status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label class="c2">Rating<span class="stars" data-rating="${rating}">${[1, 2, 3, 4, 5].map((n) =>
      `<button type="button" data-star="${n}" class="${n <= rating ? 'on' : ''}">★</button>`).join('')}</span></label>
    <label class="c2 check" style="margin-top:26px"><input type="checkbox" data-f="favorite" ${b.favorite ? 'checked' : ''}> ★ Favourite</label>
    ${b.in_library ? `<label class="c2">Shelf<select data-f="shelf_id">${shelfOptions(b.shelf_id ?? null)}</select></label>` : ''}
    <label class="${b.in_library ? 'c2' : 'c3'}">Room / location<input type="text" data-f="location" value="${esc(b.location)}" placeholder="e.g. Living room"></label>
    <label class="${b.in_library ? 'c2' : 'c3'}">Personal tags (comma separated)<input type="text" data-f="tags" data-kind="list" value="${esc((b.tags || []).join(', '))}"></label>
    <div class="c6" style="margin:6px 0 4px"><div style="font-weight:500;margin-bottom:6px">I own this book as</div><div class="own-toggles">
      <label class="own"><input type="checkbox" data-f="has_hardcopy" ${b.has_hardcopy ? 'checked' : ''}><span class="tick">✓</span>📕 Hardcopy</label>
      <label class="own"><input type="checkbox" data-f="has_pdf" ${b.has_pdf || b.ebook_available ? 'checked' : ''}><span class="tick">✓</span>📱 eBook (PDF, EPUB…)</label>
    </div></div>
    <label class="c6">Personal notes<textarea data-f="user_notes" rows="2">${esc(b.user_notes)}</textarea></label>`;
  return `<div class="form-grid book-form"><div class="form-section">About the book</div>${fields}<div class="form-section">My copy</div>${personal}</div>`;
}

function wireForm(root) {
  $$('.stars', root).forEach((stars) => {
    $$('button', stars).forEach((btn) => btn.onclick = () => {
      const n = Number(btn.dataset.star);
      const val = Number(stars.dataset.rating) === n ? 0 : n;
      stars.dataset.rating = val;
      $$('button', stars).forEach((b) => b.classList.toggle('on', Number(b.dataset.star) <= val));
    });
  });
}

function collectForm(root) {
  const out = {};
  $$('[data-f]', root).forEach((el) => {
    const f = el.dataset.f;
    if (el.type === 'checkbox') out[f] = el.checked;
    else if (el.dataset.kind === 'list') out[f] = el.value.split(',').map((s) => s.trim()).filter(Boolean);
    else if (el.dataset.kind === 'list;') out[f] = el.value.split(';').map((s) => s.trim()).filter(Boolean);
    else out[f] = el.value;
  });
  const stars = $('.stars', root);
  if (stars) out.rating = Number(stars.dataset.rating) || null;
  return out;
}

function fillEmpty(root, data) {
  let n = 0;
  for (const [f, v] of Object.entries(data)) {
    const el = $(`[data-f="${f}"]`, root);
    if (!el || v == null || (Array.isArray(v) && !v.length) || el.value.trim()) continue;
    el.value = Array.isArray(v) ? v.join(el.dataset.kind === 'list;' ? '; ' : ', ') : v;
    el.closest('label')?.classList.add('uncertain-field');
    n++;
  }
  return n;
}

// ------------------------------------------------------------------ LIBRARY
const libInputs = { q: '#lib-q', genre: '#lib-genre', author: '#lib-author', language: '#lib-language',
  reading_status: '#lib-reading', sort: '#lib-sort', in_shelf: '#lib-inshelf', format: '#lib-format' };
for (const [k, sel] of Object.entries(libInputs)) {
  const el = $(sel);
  const handler = () => { state.lib[k] = el.value; state.lib.page = 1; loadBooks(); };
  el.addEventListener(k === 'q' ? 'input' : 'change', k === 'q' ? debounce(handler) : handler);
}
$('#lib-fav').onchange = (e) => { state.lib.favorite = e.target.checked; state.lib.page = 1; loadBooks(); };
$$('#lib-layout button').forEach((b) => b.onclick = () => setLayout(b.dataset.l));
function setLayout(l) {
  state.lib.layout = l;
  try { localStorage.setItem('layout', l); } catch { /* ignore */ }
  $$('#lib-layout button').forEach((b) => b.classList.toggle('active', b.dataset.l === l));
  loadBooks();
}

function renderLibrary() {
  setLayout(state.lib.layout);
  loadFacets();
  loadStats();
  fillShelfFilter();
}

/** The "All shelves" filter in My Library. */
function fillShelfFilter() {
  const el = $('#lib-inshelf'), cur = state.lib.in_shelf || '';
  el.innerHTML = '<option value="">All shelves</option>' + state.shelves.map((s) =>
    `<option value="${s.id}">${esc(s.name)} (${s.count})</option>`).join('') + '<option value="unsorted">Unsorted</option>';
  el.value = [...el.options].some((o) => o.value === cur) ? cur : '';
}

/** The eBook file's format as a short label (EPUB, PDF, MOBI…), or "eBook" when you only own a digital copy. */
const ebookTag = (b) => (b.ebook_ext ? b.ebook_ext.toUpperCase() : 'eBook');

/** Small chips showing which formats you own. */
function fmtChips(b) {
  const digital = b.has_pdf || b.ebook_available || b.ebook_ext;
  if (!b.has_hardcopy && !digital) return '';
  const readable = b.ebook_readable || b.readable;
  const tip = b.ebook_ext ? (readable ? `${ebookTag(b)} file attached: you can read it here` : `${ebookTag(b)} file attached: download to read it`)
    : 'You own a digital copy';
  return `<div class="fmt-chips">${b.has_hardcopy ? '<span class="fmt" title="You own the hardcopy">Hardcopy</span>' : ''}${digital
    ? `<span class="fmt pdf" title="${tip}">${esc(ebookTag(b))}</span>` : ''}</div>`;
}
const formatNote = (b) => (b.ebook_ext ? ` · ${b.ebook_ext.toUpperCase()}` : '');
/** A little dot on a spine: green = readable here, amber = file attached (download to read). */
const fileDot = (b) => (b.ebook_ext ? `<em class="pdfdot ${b.readable ? '' : 'other'}"></em>` : '');

async function loadStats() {
  const s = await run(() => api('/api/stats'));
  if (!s) return;
  $('#lib-sub').textContent = s.books
    ? `${plural(s.books, 'book')} by ${plural(s.authors, 'author')}${s.pages ? `, ${s.pages.toLocaleString()} pages of reading` : ''}.`
    : "Every book you've shelved, in one place.";
  const items = [['Books', s.books], ['Read', s.read], ['Reading now', s.reading], ['Favourites', s.favorites],
    ['Hardcopies', s.hardcopies], ['eBooks', s.ebooks]];
  $('#lib-stats').innerHTML = s.books ? items.map(([l, v], i) => `<div class="stat" style="--i:${i}"><b>${esc(v)}</b><span>${l}</span></div>`).join('') : '';
}

async function loadFacets() {
  const f = await run(() => api('/api/books/facets'));
  if (!f) return;
  const fill = (sel, list, all) => {
    const el = $(sel), cur = el.value;
    el.innerHTML = `<option value="">${all}</option>` + list.map((o) =>
      `<option value="${esc(o.value)}">${esc(o.value)} (${o.n})</option>`).join('');
    el.value = cur;
  };
  fill('#lib-genre', f.genre, 'All genres');
  fill('#lib-author', f.author, 'All authors');
  fill('#lib-language', f.language, 'All languages');
}

function libQuery(extra = {}) {
  const l = state.lib;
  return qs({ q: l.q, genre: l.genre, author: l.author, language: l.language, reading_status: l.reading_status,
    favorite: l.favorite ? 1 : '', sort: l.sort, in_shelf: l.in_shelf, format: l.format, ...extra });
}

async function loadBooks(quiet = false) {
  const l = state.lib;
  const data = await run(() => api(`/api/books?${libQuery({ page: l.page, per_page: l.per_page })}`));
  if (!data) return;
  const filterQs = libQuery();
  $('#export-csv').href = `/api/export?format=csv&${filterQs}`;
  $('#export-json').href = `/api/export?format=json&${filterQs}`;
  const el = $('#lib-results');
  if (!data.items.length) {
    const filtered = l.q || l.genre || l.author || l.language || l.reading_status || l.favorite || l.in_shelf || l.format;
    const finds = state.status ? state.status.books.finds : 0;
    el.innerHTML = filtered
      ? emptyState('🔍', 'No books match', 'Try a different search or clear the filters.')
      : finds
        ? emptyState('✨', `${plural(finds, 'new book')} waiting`, 'Gemini has identified books from your photos. Add them to your shelves.',
          '<a class="button primary" href="#finds">Go to New Finds</a>')
        : emptyState('📚', 'Your shelves are empty', 'Scan a folder of book photos and Gemini will identify them for you, or add a book by hand.',
          '<a class="button primary" href="#import">Scan your first shelf</a>');
  } else if (l.layout === 'list') {
    el.innerHTML = `<table class="list"><thead><tr><th></th><th></th><th>Title</th><th>Author</th><th>Year</th>
      <th>Shelf</th><th>Format</th><th>Reading</th><th>Status</th></tr></thead><tbody>${data.items.map((b, i) => `
      <tr data-id="${b.id}" style="--i:${Math.min(i, 30)}"><td><input type="checkbox" class="sel" ${l.selected.has(b.id) ? 'checked' : ''}></td>
      <td><div class="mini">${coverHtml(b)}</div></td>
      <td><b>${esc(b.title)}</b>${b.series ? `<div class="muted small">${esc(b.series)} ${esc(b.series_volume || '')}</div>` : ''}</td>
      <td>${esc(authorsText(b.authors))}</td><td>${esc(b.publication_year || '')}</td>
      <td>${esc(shelfName(b.shelf_id ?? null))}</td>
      <td><span class="list-fmt">${b.has_hardcopy ? '<span class="fmt">Hardcopy</span>' : ''}${b.has_pdf || b.ebook_available ? `<span class="fmt pdf">${esc(ebookTag(b))}</span>` : ''}</span>
        ${b.ebook_readable ? '<button class="ghost small" data-read>📖 Read</button>' : ''}</td>
      <td>${esc(READING[b.reading_status] || '')}${b.favorite ? ' ★' : ''}</td>
      <td>${badge(b.status)}</td></tr>`).join('')}</tbody></table>`;
  } else {
    el.innerHTML = `<div class="book-grid">${data.items.map((b, i) => `
      <div class="book-card ${l.selected.has(b.id) ? 'selected' : ''}" data-id="${b.id}" style="--i:${Math.min(i, 30)}">
        <input type="checkbox" class="sel" ${l.selected.has(b.id) ? 'checked' : ''} title="Select">
        <div class="cover">${coverHtml(b)}${b.favorite ? '<div class="ribbon fav"></div>' : ''}
          ${b.status === 'uncertain' ? `<div class="flag">${badge('uncertain')}</div>` : ''}
          ${b.ebook_readable ? `<button class="read-chip" data-read title="Read the ${esc(ebookTag(b))}"><svg class="i"><use href="#i-book-open"/></svg>Read</button>` : ''}</div>
        <div class="t">${esc(b.title)}</div>
        <div class="a">${esc(authorsText(b.authors))}${b.publication_year ? ` · ${esc(b.publication_year)}` : ''}</div>
        ${fmtChips(b).replace('fmt-chips', 'fmt-row')}
        ${b.ebook_readable && b.ebook_pct ? `<div class="progress-mini" title="${Math.round(b.ebook_pct * 100)}% read"><div style="width:${Math.round(b.ebook_pct * 100)}%"></div></div>` : ''}
      </div>`).join('')}</div>`;
  }
  el.classList.toggle('no-anim', quiet);
  $$('[data-id]', el).forEach((card) => {
    const id = Number(card.dataset.id);
    const cb = $('.sel', card);
    cb.onclick = (e) => { e.stopPropagation(); toggleSel(l.selected, id, cb.checked); card.classList.toggle('selected', cb.checked); updateLibSelbar(); };
    card.onclick = () => openBook(id);
    const rd = $('[data-read]', card);
    if (rd) rd.onclick = (e) => { e.stopPropagation(); openReader(id); };
  });
  renderPager($('#lib-pager'), data.total, data.page, data.per_page, (p) => { l.page = p; loadBooks(); window.scrollTo(0, 0); });
  updateLibSelbar();
}

$('#lib-new-shelf').onclick = newShelf;
$('#lib-move').onclick = () => moveDialog([...state.lib.selected]);

function moveDialog(ids) {
  const body = openModal(`<h2>Move ${plural(ids.length, 'book')} to a shelf</h2>
    <div class="pick-list">${[{ id: null, name: 'Unsorted' }, ...state.shelves].map((s) => `
      <div class="opt" data-shelf="${s.id ?? ''}"><span class="plate ${s.id ? '' : 'unsorted'}">${esc(s.name)}</span>
      <span class="muted small">${s.id ? plural(s.count, 'book') : ''}</span></div>`).join('')}</div>
    <div class="modal-actions"><div><button id="mv-new" class="ghost">＋ New shelf</button></div><div><button data-close>Cancel</button></div></div>`, { small: true });
  $('[data-close]', body).onclick = () => closeModal(false);
  $$('.opt', body).forEach((o) => o.onclick = () => run(async () => {
    const shelfId = o.dataset.shelf ? Number(o.dataset.shelf) : null;
    await api('/api/books/move', { body: { ids, shelf_id: shelfId } });
    toast(`Moved ${plural(ids.length, 'book')} to ${shelfId ? `“${shelfName(shelfId)}”` : 'Unsorted'}`);
    state.lib.selected.clear();
    closeModal(false);
    await refreshShelves();
    if (state.lib.layout !== 'shelf') loadBooks();
  }));
  $('#mv-new', body).onclick = async () => {
    const name = await askText('New shelf', { placeholder: 'Shelf name', ok: 'Create & move' });
    if (!name) return;
    await run(async () => {
      const s = await api('/api/shelves', { body: { name } });
      await api('/api/books/move', { body: { ids, shelf_id: s.id } });
      toast(`Moved ${plural(ids.length, 'book')} to “${name}”`);
      state.lib.selected.clear();
      await refreshShelves();
      if (state.lib.layout !== 'shelf') loadBooks();
    });
  };
}

function toggleSel(set, id, on) { if (on) set.add(id); else set.delete(id); }

function updateLibSelbar() {
  const n = state.lib.selected.size;
  $('#lib-selbar').hidden = !n;
  $('#lib-selcount').textContent = `${n} selected`;
  $('#lib-merge').disabled = n < 2;
}
$('#lib-selclear').onclick = () => { state.lib.selected.clear(); loadBooks(); };
$('#lib-delete').onclick = () => run(async () => {
  const n = state.lib.selected.size;
  if (!confirm(`Delete ${plural(n, 'book')} from Shelfie? Their photos stay on disk.`)) return;
  await api('/api/books/bulk-delete', { body: { ids: [...state.lib.selected] } });
  state.lib.selected.clear();
  toast(`Deleted ${plural(n, 'book')}`);
  renderLibrary(); poll();
});
$('#lib-unshelve').onclick = () => run(async () => {
  const ids = [...state.lib.selected];
  await Promise.all(ids.map((id) => api(`/api/books/${id}/remove-from-library`, { body: {} })));
  state.lib.selected.clear();
  toast(`Moved ${plural(ids.length, 'book')} back to New Finds`);
  renderLibrary(); poll();
});
$('#lib-merge').onclick = () => run(async () => {
  const books = await Promise.all([...state.lib.selected].map((id) => api(`/api/books/${id}`)));
  mergeDialog(books);
});
$('#lib-add').onclick = () => newBook([]);

function mergeDialog(books) {
  const body = openModal(`<h2>Merge ${books.length} books into one</h2>
    <p class="muted">Choose the record to keep. Photos from all of them are attached to it, empty fields are filled in from the others, and the others are removed.</p>
    <div class="pick-list">${books.map((b, i) => `<label class="opt check"><input type="radio" name="keep" value="${b.id}" ${i === 0 ? 'checked' : ''}>
      <div class="mini">${coverHtml(b)}</div><div><b>${esc(b.title)}</b><div class="muted small">
      ${esc(authorsText(b.authors))} · ${plural(b.images.length, 'photo')} ${b.isbn ? '· ISBN ' + esc(b.isbn) : ''}</div></div></label>`).join('')}</div>
    <div class="modal-actions"><div></div><div><button data-close>Cancel</button><button class="primary" id="do-merge">Merge</button></div></div>`, { small: true });
  $('[data-close]', body).onclick = () => closeModal(false);
  $('#do-merge').onclick = () => run(async () => {
    const target = Number($('input[name=keep]:checked', body).value);
    await api('/api/books/merge', { body: { target_id: target, source_ids: books.map((b) => b.id) } });
    state.lib.selected.clear();
    toast('Books merged');
    closeModal();
  });
}

async function openBook(id) {
  const b = await run(() => api(`/api/books/${id}`));
  if (!b) return;
  const imgs = b.images || [];
  const cover = b.cover_id || (imgs[0] && imgs[0].id);
  const body = openModal(`
    <div class="row" style="margin-bottom:14px">${badge(b.status)}
      ${b.in_library ? '<span class="badge inlib">On your shelf</span>' : '<span class="badge find">New find</span>'}
      <span class="muted small">Confidence ${pct(b.confidence)} · ${b.source === 'manual' ? 'added by hand' : 'identified by Gemini'} · ${esc((b.created_at || '').slice(0, 10))}</span></div>
    <div class="detail">
      <div class="gallery">
        <div class="book-hero"><div class="b3" id="main-img" data-id="${cover || ''}">${coverHtml({ ...b, cover_id: cover }, true)}</div></div>
        ${imgs.length > 1 ? `<div class="thumbs">${imgs.map((i) => `<img src="${thumb(i.id)}" data-id="${i.id}" class="${i.id === cover ? 'active' : ''}" title="${esc(i.filename)}">`).join('')}</div>` : ''}
        ${imgs.length ? `<div class="row small" style="margin-top:10px">${imgs.length > 1 ? '<button id="set-cover" class="ghost">Use as cover</button>' : ''}
          <button id="open-image" class="ghost">Photo details</button></div>` : ''}
        <div id="ebook-slot">${ebookPanelHtml(b)}</div>
        ${b.ai_notes ? `<div class="notes">${esc(b.ai_notes)}</div>` : ''}
        <div id="ol-results"></div>
      </div>
      <div>
        <h2 style="font-size:26px;margin-bottom:2px">${esc(b.title)}</h2>
        <div class="muted" style="margin-bottom:8px;font-family:var(--serif);font-style:italic">${esc(authorsText(b.authors))}</div>
        ${bookFormHtml(b)}
      </div>
    </div>
    <div class="modal-actions">
      <div><button class="danger" id="b-delete">Delete</button><button class="ghost" id="b-lookup">Check Open Library</button></div>
      <div>${b.in_library ? '' : '<button class="gold" id="b-shelve">Add to library</button>'}
        <button id="b-save">Save</button><button class="primary" id="b-verify">Save &amp; mark verified</button></div>
    </div>`);
  wireForm(body);
  const main = $('#main-img', body);
  if (cover) main.onclick = () => lightbox(Number(main.dataset.id));
  $$('.thumbs img', body).forEach((t) => t.onclick = () => {
    $$('.thumbs img', body).forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    main.innerHTML = `<img class="cover-img" src="${thumb(t.dataset.id, true)}" alt="">`;
    main.dataset.id = t.dataset.id;
  });
  if ($('#set-cover', body)) $('#set-cover', body).onclick = () => run(async () => {
    await api(`/api/books/${id}`, { method: 'PUT', body: { cover_image_id: Number(main.dataset.id) } });
    toast('Cover updated');
  });
  if ($('#open-image', body)) $('#open-image', body).onclick = () => openImage(Number(main.dataset.id || cover));
  const save = (verify, shelve = false) => run(async () => {
    const res = await api(`/api/books/${id}`, { method: 'PUT', body: { ...collectForm(body), verify } });
    if (shelve) {
      await api('/api/books/add-to-library', { body: { ids: [id] } });
      await flyToShelf(main);
      loadBookcase([id]);
    }
    toast(shelve ? `“${res.title}” is on your shelf` : verify ? 'Saved and verified' : 'Saved');
    if (res.possible_duplicate) {
      const d = res.possible_duplicate;
      if (confirm(`This looks like a duplicate of "${d.title}" (${authorsText(d.authors)}). Merge them now?`)) {
        await api('/api/books/merge', { body: { target_id: id, source_ids: [d.id] } });
        toast('Merged duplicate');
      }
    }
    closeModal();
  });
  $('#b-save', body).onclick = () => save(false);
  $('#b-verify', body).onclick = () => save(true);
  if ($('#b-shelve', body)) $('#b-shelve', body).onclick = () => save(false, true);
  $('#b-delete', body).onclick = () => run(async () => {
    if (!confirm(`Delete "${b.title}" from Shelfie? Its photos stay on disk.`)) return;
    await api(`/api/books/${id}`, { method: 'DELETE' });
    toast('Book deleted');
    closeModal();
  });
  $('#b-lookup', body).onclick = () => openLibraryLookup(id, body);
  wireEbookPanel(body, b);
}

// ---- eBook panel (in a book's details)
const EBOOK_EXTS = ['pdf', 'epub', 'mobi', 'azw', 'azw3', 'fb2', 'djvu', 'cbz', 'cbr', 'txt', 'rtf', 'docx', 'odt'];
const EBOOK_ACCEPT = EBOOK_EXTS.map((e) => `.${e}`).join(',') + ',application/pdf,application/epub+zip';
const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function readingProgress(b) {
  if (b.ebook_ext === 'pdf' && b.ebook_page && b.ebook_pages) return { pct: b.ebook_page / b.ebook_pages, text: `You're on page ${b.ebook_page} of ${b.ebook_pages}` };
  if (b.ebook_pct) return { pct: b.ebook_pct, text: `You're ${Math.round(b.ebook_pct * 100)}% through` };
  return null;
}

function ebookPanelHtml(b) {
  if (b.ebook_available) {
    const prog = readingProgress(b);
    const pctRead = prog ? Math.round(prog.pct * 100) : 0;
    const dl = `/api/books/${b.id}/ebook?download=1`;
    return `<div class="pdf-panel">
      <h4>📚 eBook <span class="fmt pdf">${esc(ebookTag(b))}</span></h4>
      <div class="fname">${esc(b.ebook_name)}${b.ebook_size ? ` · ${fmtSize(b.ebook_size)}` : ''}${b.ebook_ext === 'pdf' && b.ebook_pages ? ` · ${b.ebook_pages} pages` : ''}</div>
      ${pctRead ? `<div class="progress-mini" title="${pctRead}% read"><div style="width:${pctRead}%"></div></div>
        <div class="fname" style="margin-top:4px">${prog.text}${b.ebook_ext === 'pdf' ? ` (${pctRead}%)` : ''}</div>` : ''}
      ${b.ebook_readable
        ? `<button class="gold read-big" data-eb="read"><svg class="i"><use href="#i-book-open"/></svg>${pctRead ? 'Continue reading' : 'Read now'}</button>`
        : `<div class="notes" style="margin:10px 0 0">Shelfie can't show <b>${esc(b.ebook_label || ebookTag(b))}</b> files in the browser.
             Download it to read in Kindle, Calibre, Apple Books or another e-reader app.</div>
           <a class="button gold read-big" href="${dl}"><svg class="i"><use href="#i-down"/></svg>Download to read</a>`}
      <div class="wrong-file">Wrong file attached?</div>
      <div class="pdf-actions">
        <label class="button ghost" title="Choose the right file. It replaces this one.">⇄ Upload a different file<input type="file" accept="${EBOOK_ACCEPT}" data-eb="file" hidden></label>
        <button class="ghost danger" data-eb="remove">Remove file</button>
      </div>
      ${b.ebook_readable ? `<a class="dl-link" href="${dl}">Download a copy</a>` : ''}
      <div class="upload-bar" hidden><div></div></div>
    </div>`;
  }
  return `<div class="pdf-panel">
    <label class="pdf-drop" data-eb="drop">
      <svg class="i"><use href="#i-upload"/></svg>
      <b>Upload this book's eBook</b>
      <span class="small">Drag a file here, or click to choose one.<br>PDF, EPUB, MOBI, AZW3, FB2, DJVU, CBZ, TXT and more.
        PDF, EPUB and TXT open right here in Shelfie.</span>
      <input type="file" accept="${EBOOK_ACCEPT}" data-eb="file">
    </label>
    <div class="upload-bar" hidden><div></div></div>
  </div>`;
}

/** Upload with a progress bar (fetch can't report upload progress, so this uses XMLHttpRequest). */
function uploadEbook(bookId, file, barEl) {
  return new Promise((resolve, reject) => {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!EBOOK_EXTS.includes(ext)) {
      reject(new Error(`“${file.name}” isn't an eBook file Shelfie knows. Use PDF, EPUB, MOBI, AZW3, FB2, DJVU, CBZ, CBR, TXT, RTF, DOCX or ODT.`));
      return;
    }
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append('file', file);
    xhr.open('POST', `/api/books/${bookId}/ebook`);
    if (barEl) { barEl.hidden = false; xhr.upload.onprogress = (e) => { if (e.lengthComputable) barEl.firstElementChild.style.width = `${e.loaded / e.total * 100}%`; }; }
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (barEl) barEl.hidden = true;
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error((data && data.error) || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => { if (barEl) barEl.hidden = true; reject(new Error('Upload failed. Is Shelfie still running?')); };
    xhr.send(form);
  });
}

function wireEbookPanel(body, b) {
  const slot = $('#ebook-slot', body);
  const rewire = (book) => { slot.innerHTML = ebookPanelHtml(book); wireEbookPanel(body, book); };
  const ownDigital = $('[data-f="has_pdf"]', body);
  const doUpload = (file) => run(async () => {
    const replacing = b.ebook_available;
    const nb = await uploadEbook(b.id, file, $('.upload-bar', slot));
    if (ownDigital) ownDigital.checked = true;  // keep the form in step, so Save doesn't undo it
    toast(replacing ? `Replaced: “${nb.title}” now has the ${ebookTag(nb)} file “${nb.ebook_name}”`
      : `${ebookTag(nb)} added to “${nb.title}”`);
    rewire(nb);
    loadBookcase();
  });
  const input = $('[data-eb="file"]', slot);
  if (input) input.onchange = () => { if (input.files[0]) doUpload(input.files[0]); input.value = ''; };
  const drop = $('[data-eb="drop"]', slot);
  if (drop) {
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) doUpload(f); };
  }
  const readBtn = $('[data-eb="read"]', slot);
  if (readBtn) readBtn.onclick = () => { closeModal(false); openReader(b.id); };
  const rm = $('[data-eb="remove"]', slot);
  if (rm) rm.onclick = () => run(async () => {
    if (!confirm(`Remove the file “${b.ebook_name}” from this book?\n\nThe book stays in your library. You can upload the right file afterwards.`)) return;
    const nb = await api(`/api/books/${b.id}/ebook`, { method: 'DELETE' });
    if (ownDigital) ownDigital.checked = false;
    toast('File removed. You can upload the right one now');
    rewire(nb);
    loadBookcase();
  });
}

async function openLibraryLookup(id, body) {
  const box = $('#ol-results', body);
  box.innerHTML = '<div class="notes">Searching Open Library…</div>';
  const res = await run(() => api(`/api/books/${id}/lookup`));
  if (!res) { box.innerHTML = ''; return; }
  if (!res.candidates.length) { box.innerHTML = '<div class="notes">No matches on Open Library.</div>'; return; }
  box.innerHTML = `<h3 style="margin-top:14px">Open Library matches</h3>` + res.candidates.map((c, i) => `
    <div class="notes"><b>${esc(c.title)}</b> — ${esc(authorsText(c.authors))}${c.publication_year ? ` (${esc(c.publication_year)})` : ''}
    <div>${c.publisher ? esc(c.publisher) + ' · ' : ''}${c.page_count ? c.page_count + ' pages · ' : ''}${c.isbn ? 'ISBN ' + esc(c.isbn) : ''}</div>
    <div class="row" style="margin-top:6px"><button class="ghost" data-fill="${i}">Fill empty fields</button>
    ${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">View</a>` : ''}</div></div>`).join('');
  $$('[data-fill]', box).forEach((btn) => btn.onclick = () => {
    const { url, ...fields } = res.candidates[Number(btn.dataset.fill)];
    const n = fillEmpty(body, fields);
    toast(n ? `Filled ${plural(n, 'empty field')}. Review, then save` : 'No empty fields to fill');
  });
}

function newBook(imageIds) {
  const body = openModal(`<h2>${imageIds.length ? `New book from ${plural(imageIds.length, 'photo')}` : 'Add a book by hand'}</h2>
    <p class="muted">It goes straight onto your shelf.</p>
    ${imageIds.length ? `<div class="row">${imageIds.slice(0, 12).map((i) => `<img src="${thumb(i)}" style="width:60px;height:60px;object-fit:cover;border-radius:8px">`).join('')}</div>` : ''}
    ${bookFormHtml({ reading_status: 'unread', in_library: 1, shelf_id: null, has_hardcopy: true })}
    <label style="margin-top:12px">📱 eBook file of this book (optional: PDF, EPUB, MOBI…)<input type="file" id="nb-pdf" accept="${EBOOK_ACCEPT}"></label>
    <div class="upload-bar" id="nb-bar" hidden><div></div></div>
    <div class="modal-actions"><div></div><div><button data-close>Cancel</button><button class="primary" id="nb-save">Add to library</button></div></div>`);
  wireForm(body);
  $('[data-close]', body).onclick = () => closeModal(false);
  $('#nb-save', body).onclick = () => run(async () => {
    const data = collectForm(body);
    if (!data.title.trim()) throw new Error('Title is required');
    const pdf = $('#nb-pdf', body).files[0];
    const b = await api('/api/books', { body: { ...data, has_pdf: data.has_pdf || !!pdf, image_ids: imageIds } });
    if (pdf) {
      try { await uploadEbook(b.id, pdf, $('#nb-bar', body)); } catch (e) { toast(`Book added, but the file upload failed: ${e.message}`, true); }
    }
    toast(`“${b.title}” is on your shelf`);
    state.img.selected.clear();
    loadBookcase([b.id]);
    closeModal();
  });
}

function pickBook(title, imageIds, onPick) {
  const body = openModal(`<h2>${esc(title)}</h2>
    <div class="search" style="margin-top:10px"><svg class="i"><use href="#i-search"/></svg><input type="search" id="pb-q" placeholder="Search all books…"></div>
    <div class="pick-list" id="pb-list"></div>
    <div class="modal-actions"><div><button id="pb-new" class="ghost">＋ Create a new book from ${plural(imageIds.length, 'photo')}</button></div>
    <div><button data-close>Cancel</button></div></div>`, { small: true });
  $('[data-close]', body).onclick = () => closeModal(false);
  $('#pb-new', body).onclick = () => newBook(imageIds);
  const load = async (q) => {
    const data = await run(() => api(`/api/books?${qs({ q, per_page: 40, sort: 'title', shelf: 'all' })}`));
    if (!data) return;
    $('#pb-list', body).innerHTML = data.items.length ? data.items.map((b) => `<div class="opt" data-id="${b.id}">
      <div class="mini">${coverHtml(b)}</div>
      <div><b>${esc(b.title)}</b><div class="muted small">${esc(authorsText(b.authors))}${b.publication_year ? ' · ' + esc(b.publication_year) : ''}
      ${b.in_library ? '' : ' · <span class="badge find">New find</span>'}</div></div></div>`).join('')
      : '<div class="empty" style="border:0">No books found</div>';
    $$('.opt', body).forEach((o) => o.onclick = () => onPick(Number(o.dataset.id)));
  };
  $('#pb-q', body).oninput = debounce((e) => load(e.target.value));
  $('#pb-q', body).focus();
  load('');
}

function linkImagesTo(imageIds) {
  pickBook(`Match ${plural(imageIds.length, 'photo')} to one book`, imageIds, (bookId) => run(async () => {
    await api('/api/images/link', { body: { ids: imageIds, book_id: bookId } });
    state.img.selected.clear();
    toast('Photos matched to book');
    closeModal();
  }));
}

// ------------------------------------------------------------------ IMAGE DETAIL
async function openImage(id) {
  const im = await run(() => api(`/api/images/${id}`));
  if (!im) return;
  const books = im.books || [];
  const body = openModal(`
    <div class="row" style="margin-bottom:14px">${badge(im.status)}
      <span class="muted small">${esc(im.filename)} · confidence ${pct(im.confidence)} · attempts ${im.attempts}${im.ai_model ? ' · ' + esc(im.ai_model) : ''}</span></div>
    <div class="detail">
      <div class="gallery">
        <img class="main" id="im-main" src="${thumb(id, true)}" alt="" title="Open the original">
        <div class="muted small" style="margin-top:6px;word-break:break-all">${esc(im.path)}</div>
        ${im.error ? `<div class="notes">${esc(im.error)}</div>` : ''}
        ${im.duplicates.length ? `<div class="notes">Identical file also at: ${im.duplicates.map((d) => esc(d.filename)).join(', ')} (analysed once, from cache)</div>` : ''}
        ${im.ai_result ? `<details><summary class="small">Raw Gemini result</summary><pre>${esc(JSON.stringify(im.ai_result, null, 2))}</pre></details>` : ''}
      </div>
      <div>
        ${books.length ? books.map((b) => `<div class="card" data-book="${b.id}" style="margin-bottom:14px">
            <div class="row space"><div class="row">${badge(b.status)}${b.in_library ? '<span class="badge inlib">On your shelf</span>' : '<span class="badge find">New find</span>'}
              <span class="muted small">confidence ${pct(b.confidence)}</span></div>
            <div class="row"><button class="ghost small" data-unlink="${b.id}">Unlink from this photo</button>
            <button class="ghost small" data-openbook="${b.id}">Open book</button></div></div>
            ${b.ai_notes ? `<div class="notes">${esc(b.ai_notes)}</div>` : ''}
            ${bookFormHtml(b)}
            <div class="row" style="justify-content:flex-end;margin-top:10px">
            ${b.in_library ? '' : `<button class="gold" data-shelve="${b.id}">Add to library</button>`}
            <button data-save="${b.id}">Save</button>
            <button class="primary" data-verify="${b.id}">Save &amp; mark verified</button></div></div>`).join('')
        : emptyState('🔎', 'No book linked to this photo', 'Enter the details yourself, or match it to a book you already have.',
          '<button class="primary" id="im-create">Enter book details</button>')}
      </div>
    </div>
    <div class="modal-actions">
      <div><button id="im-reanalyze">↻ Re-analyse with Gemini</button><button id="im-link">Match to existing book…</button>
        ${im.status !== 'not_book' ? '<button id="im-notbook" class="ghost">Not a book</button>' : ''}</div>
      <div><button data-close>Close</button></div>
    </div>`);
  wireForm(body);
  $('#im-main', body).onclick = () => lightbox(id);
  $('[data-close]', body).onclick = () => closeModal();
  $$('[data-book]', body).forEach((card) => {
    const bid = Number(card.dataset.book);
    const save = (verify, shelve = false) => run(async () => {
      await api(`/api/books/${bid}`, { method: 'PUT', body: { ...collectForm(card), verify } });
      if (shelve) { await api('/api/books/add-to-library', { body: { ids: [bid] } }); await flyToShelf($('#im-main', body)); loadBookcase([bid]); }
      toast(shelve ? 'Added to your library' : verify ? 'Saved and verified' : 'Saved');
      if (verify || shelve) openImage(id);
    });
    $(`[data-save="${bid}"]`, card).onclick = () => save(false);
    $(`[data-verify="${bid}"]`, card).onclick = () => save(true);
    if ($(`[data-shelve="${bid}"]`, card)) $(`[data-shelve="${bid}"]`, card).onclick = () => save(false, true);
    $(`[data-unlink="${bid}"]`, card).onclick = () => run(async () => {
      await api(`/api/images/${id}/unlink`, { body: { book_id: bid } });
      openImage(id);
    });
    $(`[data-openbook="${bid}"]`, card).onclick = () => openBook(bid);
  });
  if ($('#im-create', body)) $('#im-create', body).onclick = () => newBook([id]);
  $('#im-reanalyze', body).onclick = () => reanalyze([id]);
  $('#im-link', body).onclick = () => linkImagesTo([id]);
  if ($('#im-notbook', body)) $('#im-notbook', body).onclick = () => markNotBook([id]);
}

async function reanalyze(ids) {
  if (!confirm(`Send ${plural(ids.length, 'photo')} to Gemini again? This uses API quota and replaces the current AI result.`)) return;
  const res = await run(() => api('/api/images/reanalyze', { body: { ids } }));
  if (!res) return;
  toast(res.started ? 'Re-analysis started' : 'Queued. The running job will pick it up');
  state.img.selected.clear();
  closeModal();
}

async function markNotBook(ids) {
  await run(async () => {
    await api('/api/images/not-book', { body: { ids } });
    toast('Marked as not a book');
    state.img.selected.clear();
    closeModal();
  });
}

// ------------------------------------------------------------------ SCAN & IDENTIFY
$('#folder-browse').onclick = () => run(async () => {
  $('#folder-browse').disabled = true;
  try {
    const r = await api('/api/pick-folder', { body: {} });
    if (r.path) $('#folder-path').value = r.path;
  } finally { $('#folder-browse').disabled = false; }
});
$('#folder-add').onclick = () => run(async () => {
  const path = $('#folder-path').value.trim();
  if (!path) throw new Error('Choose or type a folder path first');
  await api('/api/folders', { body: { path, recursive: $('#folder-recursive').checked } });
  state.lastScanRunning = true;
  toast('Scanning folder…');
  loadFolders();
});
$('#folder-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#folder-add').click(); });

$('#proc-start').onclick = () => run(async () => {
  await api('/api/process/start', { body: { folder_id: state.img.folder_id ? Number(state.img.folder_id) : null } });
  poll();
});
['pause', 'resume', 'cancel'].forEach((a) => $(`#proc-${a}`).onclick = () => run(async () => { await api(`/api/process/${a}`, { body: {} }); poll(); }));
$('#proc-retry').onclick = () => run(async () => {
  const r = await api('/api/images/retry-failed', { body: {} });
  toast(`${plural(r.requeued, 'failed photo')} re-queued`);
  poll(); loadImages(true);
});

function renderImport() {
  loadFolders();
  loadImages();
  if (state.status) { updateProcessPanel(state.status); renderFindsCallout(state.status.books.finds); }
  poll();
}

function renderFindsCallout(n) {
  $('#finds-callout').innerHTML = n ? `<div class="callout"><div class="big">✨</div>
    <div class="txt"><b>${plural(n, 'new book')} found</b><span class="muted">Gemini has identified books from your photos. They're waiting in New Finds for you to add to your library.</span></div>
    <a class="button gold" href="#finds">Review &amp; add to library →</a></div>` : '';
}

async function loadFolders() {
  const folders = await run(() => api('/api/folders'));
  if (!folders) return;
  $('#folders').innerHTML = folders.map((f) => `<div class="folder-item" data-id="${f.id}">
    <div class="p">📁 ${esc(f.path)}<div class="muted small" style="font-weight:400">${plural(f.images, 'photo')} · ${f.identified || 0} identified · ${f.uncertain || 0} uncertain ·
      ${f.failed || 0} failed · ${f.pending || 0} pending${f.missing ? ` · ${f.missing} missing from disk` : ''} · last scan ${esc((f.last_scan || 'never').replace('T', ' '))}</div></div>
    <button class="ghost" data-rescan>Rescan</button><button class="ghost danger" data-remove>Remove</button></div>`).join('');
  $$('.folder-item').forEach((el) => {
    const id = Number(el.dataset.id);
    $('[data-rescan]', el).onclick = () => run(async () => { await api(`/api/folders/${id}/scan`, { body: {} }); state.lastScanRunning = true; toast('Rescanning…'); });
    $('[data-remove]', el).onclick = () => run(async () => {
      if (!confirm('Remove this folder from Shelfie? Photos on disk are not touched.')) return;
      const removeBooks = confirm('Also remove books that were identified only from this folder?\n\nOK = remove them, Cancel = keep them.');
      await api(`/api/folders/${id}`, { method: 'DELETE', body: { remove_books: removeBooks } });
      toast('Folder removed');
      renderImport();
    });
  });
  const sel = $('#img-folder'), cur = sel.value;
  sel.innerHTML = '<option value="">All folders</option>' + folders.map((f) => `<option value="${f.id}">${esc(f.path)}</option>`).join('');
  sel.value = cur;
}

function updateProcessPanel(s) {
  const c = s.counts, p = s.processor;
  const done = c.total - c.pending - c.processing;
  $('#progress-bar').style.width = c.total ? `${(done / c.total) * 100}%` : '0';
  $('#progress').classList.toggle('active', ['running', 'waiting'].includes(p.state));
  const eta = c.pending ? ` · about ${s.eta_minutes < 1 ? 'a minute' : `${Math.ceil(s.eta_minutes)} min`} left at ${s.usage.rpm} requests/min` : '';
  $('#progress-text').textContent = c.total ? `${done} of ${plural(c.total, 'photo')} processed${eta}` : 'No photos yet. Scan a folder above.';
  const counters = [['Photos', c.total, ''], ['Waiting', c.pending + c.processing, 'info'], ['Identified', c.identified, 'ok'],
    ['Uncertain', c.uncertain, 'warn'], ['Failed', c.failed, 'bad'], ['Not a book', c.not_book, ''], ['New finds', s.books.finds, 'gold']];
  $('#counters').innerHTML = counters.map(([l, v, cls]) => `<div class="counter ${cls}"><b>${v}</b><span>${l}</span></div>`).join('');
  const idle = p.state === 'idle';
  $('#proc-start').disabled = !idle || !c.pending || !s.has_key;
  $('#proc-start').textContent = state.img.folder_id ? 'Start identifying (this folder)' : 'Start identifying';
  $('#proc-pause').disabled = !['running', 'waiting'].includes(p.state);
  $('#proc-resume').disabled = p.state !== 'paused';
  $('#proc-cancel').disabled = idle || p.state === 'stopping';
  $('#proc-retry').disabled = !c.failed;
  let msg = p.message || '';
  if (!s.has_key) msg = 'Add your Gemini API key in Settings to start.';
  if (p.state === 'waiting' && p.wait_seconds) msg += ` (${p.wait_seconds}s)`;
  if (s.scanner.running) msg = `Scanning ${s.scanner.done}/${s.scanner.found}… ${msg}`;
  $('#proc-message').textContent = msg;
  $('#scan-status').textContent = s.scanner.running ? `Scanning: ${s.scanner.done} of ${s.scanner.found} files` : (s.scanner.message || '');
}

const imgInputs = { q: '#img-q', status: '#img-status', folder_id: '#img-folder' };
for (const [k, sel] of Object.entries(imgInputs)) {
  const el = $(sel);
  const h = () => { state.img[k] = el.value; state.img.page = 1; loadImages(); if (state.status) updateProcessPanel(state.status); };
  el.addEventListener(k === 'q' ? 'input' : 'change', k === 'q' ? debounce(h) : h);
}

let imgRenderedOnce = false;
async function loadImages(silent = false) {
  state.lastImgRefresh = Date.now();
  const i = state.img;
  const call = () => api(`/api/images?${qs({ q: i.q, status: i.status, folder_id: i.folder_id, page: i.page, per_page: i.per_page })}`);
  const data = silent ? await call().catch(() => null) : await run(call);
  if (!data) return;
  i.items = data.items;
  const grid = $('#img-grid');
  const animate = !silent || !imgRenderedOnce;
  imgRenderedOnce = true;
  grid.innerHTML = data.items.length ? data.items.map((im, n) => {
    const b = im.books[0];
    const title = b ? b.title + (im.books.length > 1 ? ` +${im.books.length - 1} more` : '') : (STATUS_LABEL[im.status] || '');
    return `<div class="img-card ${i.selected.has(im.id) ? 'selected' : ''} ${im.status}" data-id="${im.id}" title="${esc(im.error || '')}"
      style="${animate ? `--i:${Math.min(n, 30)}` : 'animation:none'}">
      <input type="checkbox" class="sel" ${i.selected.has(im.id) ? 'checked' : ''}>
      ${badge(im.status)}<img loading="lazy" src="${thumb(im.id)}" alt="">
      <div class="meta"><div class="t">${esc(title)}</div><div class="f">${esc(im.filename)}</div></div></div>`;
  }).join('') : `<div style="grid-column:1/-1">${emptyState('🖼️', 'No photos yet', 'Choose a folder above and click Scan folder.')}</div>`;
  $$('.img-card', grid).forEach((card) => {
    const id = Number(card.dataset.id);
    const cb = $('.sel', card);
    cb.onclick = (e) => { e.stopPropagation(); toggleSel(i.selected, id, cb.checked); card.classList.toggle('selected', cb.checked); updateImgSelbar(); };
    card.onclick = (e) => { if (e.shiftKey || e.ctrlKey || e.metaKey) { cb.click(); return; } openImage(id); };
  });
  renderPager($('#img-pager'), data.total, data.page, data.per_page, (p) => { i.page = p; loadImages(); });
  updateImgSelbar();
}

function updateImgSelbar() {
  const n = state.img.selected.size;
  $('#img-selbar').hidden = !n;
  $('#img-selcount').textContent = `${plural(n, 'photo')} selected`;
}
$('#img-selall').onclick = () => { state.img.items.forEach((im) => state.img.selected.add(im.id)); loadImages(); };
$('#img-selclear').onclick = () => { state.img.selected.clear(); loadImages(); };
$('#img-link').onclick = () => linkImagesTo([...state.img.selected]);
$('#img-reanalyze').onclick = () => reanalyze([...state.img.selected]);
$('#img-notbook').onclick = () => markNotBook([...state.img.selected]);

// ------------------------------------------------------------------ NEW FINDS
function renderFinds() { fillFindsShelf(); loadFinds(); }

state.finds.shelf = store('findsShelf', '');
function fillFindsShelf() {
  const sel = $('#finds-shelf');
  const cur = state.finds.shelf && state.shelves.some((s) => String(s.id) === state.finds.shelf) ? Number(state.finds.shelf) : null;
  sel.innerHTML = shelfOptions(cur);
}
$('#finds-shelf').onchange = (e) => {
  state.finds.shelf = e.target.value;
  try { localStorage.setItem('findsShelf', e.target.value); } catch { /* ignore */ }
};

async function loadFinds(silent = false) {
  const f = state.finds;
  const call = () => api(`/api/books?${qs({ shelf: 'finds', sort: 'added', page: f.page, per_page: f.per_page })}`);
  const data = silent ? await call().catch(() => null) : await run(call);
  if (!data) return;
  f.items = data.items;
  for (const id of [...f.selected]) if (!data.items.some((b) => b.id === id)) f.selected.delete(id);
  const el = $('#finds-list');
  $('#finds-actions').hidden = !data.total;
  if (!data.items.length) {
    el.innerHTML = emptyState('🌿', 'No new finds right now',
      state.status && state.status.books.total ? 'Everything Gemini found is already on your shelves.' : 'Scan a folder of book photos and the books Gemini identifies will show up here.',
      '<a class="button primary" href="#import">Scan &amp; identify</a>');
  } else {
    el.innerHTML = `<div class="finds-grid">${data.items.map((b, i) => `
      <div class="find-card ${f.selected.has(b.id) ? 'selected' : ''}" data-id="${b.id}" style="--i:${Math.min(i, 24)}">
        <input type="checkbox" class="sel" ${f.selected.has(b.id) ? 'checked' : ''} title="Select">
        <div class="fc-cover" data-open>${coverHtml(b)}</div>
        <div class="fc-body">
          <div class="fc-title" data-open>${esc(b.title)}</div>
          <div class="fc-author">${esc(authorsText(b.authors))}${b.publication_year ? ` · ${esc(b.publication_year)}` : ''}</div>
          <div class="fc-meta">${b.status === 'uncertain' ? badge('uncertain') : ''}${b.genre ? `<span class="badge">${esc(b.genre)}</span>` : ''}
            ${b.language ? `<span class="badge">${esc(b.language)}</span>` : ''}${b.image_count > 1 ? `<span class="badge">${b.image_count} photos</span>` : ''}</div>
          ${confHtml(b.confidence)}
          <div class="fc-actions">
            <button class="primary" data-add>＋ Add to library</button>
            <button class="ghost" data-open>Edit</button>
            <button class="ghost danger" data-dismiss title="Not mine / wrong book">Dismiss</button>
          </div>
        </div>
      </div>`).join('')}</div>`;
  }
  $$('.find-card', el).forEach((card) => {
    const id = Number(card.dataset.id);
    const cb = $('.sel', card);
    cb.onclick = (e) => { e.stopPropagation(); toggleSel(f.selected, id, cb.checked); card.classList.toggle('selected', cb.checked); updateFindsSelbar(); };
    $$('[data-open]', card).forEach((x) => x.onclick = () => openBook(id));
    $('[data-add]', card).onclick = () => addFinds([id]);
    $('[data-dismiss]', card).onclick = () => dismissFinds([id]);
  });
  renderPager($('#finds-pager'), data.total, data.page, data.per_page, (p) => { f.page = p; loadFinds(); window.scrollTo(0, 0); });
  updateFindsSelbar();
}

function updateFindsSelbar() {
  const n = state.finds.selected.size;
  $('#finds-selbar').hidden = !n;
  $('#finds-selcount').textContent = `${plural(n, 'book')} selected`;
}

async function addFinds(ids, opts = null) {
  const shelfId = $('#finds-shelf').value ? Number($('#finds-shelf').value) : null;
  const res = await run(() => api('/api/books/add-to-library', { body: { ...(opts || { ids }), shelf_id: shelfId } }));
  if (!res) return;
  const cards = opts ? $$('.find-card') : ids.map((id) => $(`.find-card[data-id="${id}"]`)).filter(Boolean);
  const flying = cards.slice(0, 6).map((c, i) => new Promise((r) => setTimeout(() => flyToShelf($('.fc-cover', c)).then(r), i * 120)));
  cards.forEach((c) => c.classList.add('leaving'));
  await Promise.all(flying);
  const where = shelfId ? ` on “${shelfName(shelfId)}”` : '';
  toast(res.added === 1 && cards[0] ? `“${$('.fc-title', cards[0]).textContent}” is on your shelf${where}` : `${plural(res.added, 'book')} added to your library${where}`);
  ids.forEach((id) => state.finds.selected.delete(id));
  if (opts) state.finds.selected.clear();
  await loadBookcase();
  loadFinds(true); poll();
}

async function dismissFinds(ids) {
  if (!confirm(`Dismiss ${plural(ids.length, 'book')}? ${ids.length === 1 ? 'It' : 'They'} won't be added to your library. You can re-analyse the photo later.`)) return;
  await run(async () => {
    ids.map((id) => $(`.find-card[data-id="${id}"]`)).filter(Boolean).forEach((c) => c.classList.add('leaving'));
    await api('/api/books/bulk-delete', { body: { ids } });
    ids.forEach((id) => state.finds.selected.delete(id));
    setTimeout(() => { loadFinds(true); poll(); }, 400);
  });
}

$('#finds-add-sel').onclick = () => addFinds([...state.finds.selected]);
$('#finds-dismiss-sel').onclick = () => dismissFinds([...state.finds.selected]);
$('#finds-selall').onclick = () => { state.finds.items.forEach((b) => state.finds.selected.add(b.id)); loadFinds(true); };
$('#finds-selclear').onclick = () => { state.finds.selected.clear(); loadFinds(true); };
$('#finds-add-all').onclick = () => addFinds([], { all: true });
$('#finds-add-confident').onclick = () => addFinds([], { all: true, confident_only: true });

// ------------------------------------------------------------------ BOOK FEED
const feed = { region: store('feedRegion', ''), q: '', page: 1, items: [], polling: null };

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function feedImg(src, cls) {
  return src ? `<div class="${cls}"><img loading="lazy" referrerpolicy="no-referrer" src="${esc(src)}" alt=""
    onerror="this.parentElement.remove(); this.closest('a')?.classList.add('textonly')"></div>` : '';
}

function feedCard(it, i) {
  const mention = it.mentions && it.mentions.length ? `<div class="mention">📚 On your shelf: ${esc(it.mentions.join(', '))}</div>` : '';
  return `<a class="feed-card ${esc(it.region)} ${it.image ? '' : 'textonly'}" href="${esc(it.link || '#')}" target="_blank" rel="noopener noreferrer" style="--i:${Math.min(i, 20)}">
    ${feedImg(it.image, 'fc-img')}
    <div class="fc-pad">
      <div class="fc-src"><span class="rdot ${esc(it.region)}"></span><span>${esc(it.source)}</span><span class="when">${esc(timeAgo(it.published))}</span></div>
      <h3>${esc(it.title)}</h3>
      ${it.summary ? `<p>${esc(it.summary)}</p>` : ''}
      ${mention}
      <div class="fc-foot"><span>${it.author ? 'by ' + esc(it.author) : ''}</span><span class="go">Read →</span></div>
    </div></a>`;
}

function feedHero(it) {
  return `<a class="feed-hero ${it.image ? '' : 'noimg'}" href="${esc(it.link || '#')}" target="_blank" rel="noopener noreferrer">
    ${it.image ? `<div class="fh-img"><img referrerpolicy="no-referrer" src="${esc(it.image)}" alt="" onerror="this.closest('a').classList.add('noimg'); this.parentElement.remove()"></div>` : ''}
    <div class="fh-body">
      <div class="fc-src"><span class="rdot ${esc(it.region)}"></span><span>${esc(it.source)}</span><span class="when">${esc(timeAgo(it.published))}</span></div>
      <h2>${esc(it.title)}</h2>
      ${it.summary ? `<p>${esc(it.summary)}</p>` : ''}
      ${it.mentions && it.mentions.length ? `<div><span class="mention">📚 On your shelf: ${esc(it.mentions.join(', '))}</span></div>` : ''}
      <div class="fc-foot" style="margin-top:auto"><span>${it.author ? 'by ' + esc(it.author) : ''}</span><span class="go">Read the story →</span></div>
    </div></a>`;
}

function renderFeedChips(regions, authors) {
  const chips = [['', 'All stories'], ...Object.entries(regions), ['mine', 'My authors']];
  $('#feed-regions').innerHTML = chips.map(([k, l]) => `<button class="chip ${feed.region === k ? 'active' : ''}" data-r="${k}">
    ${k && k !== 'mine' ? `<span class="rdot ${k}"></span>` : k === 'mine' ? '📚' : ''}${esc(l)}${k === 'mine' && !authors ? ' <span class="n">(none yet)</span>' : ''}</button>`).join('');
  $$('#feed-regions .chip').forEach((c) => c.onclick = () => {
    feed.region = c.dataset.r; feed.page = 1;
    try { localStorage.setItem('feedRegion', feed.region); } catch { /* ignore */ }
    loadFeed();
  });
}

function renderFeedMeta(d) {
  const when = d.last_refresh ? timeAgo(new Date(d.last_refresh).toISOString()) : 'never';
  $('#feed-meta').innerHTML = d.refreshing
    ? '<span class="live"></span> Fetching the latest stories…'
    : `<span class="live"></span> Updated ${esc(when)} · ${plural(d.sources_enabled, 'source')}${d.sources_failing ? ` · <span style="color:var(--warn)">${d.sources_failing} not responding</span>` : ''} · refreshes every 30 min`;
  $('#feed-refresh').classList.toggle('spinning', d.refreshing);
  $('#feed-refresh').disabled = d.refreshing;
}

function renderFeed() { loadFeed(false, true); }

async function loadFeed(append = false, auto = false) {
  const params = { page: feed.page, per_page: 30, q: feed.q, auto: auto ? 1 : '' };
  if (feed.region === 'mine') params.mine = 1; else params.region = feed.region;
  if (!append && !feed.items.length) $('#feed-list').innerHTML = `<div class="feed-grid">${'<div class="skeleton"></div>'.repeat(6)}</div>`;
  const d = await run(() => api(`/api/feed?${qs(params)}`));
  if (!d) return;
  renderFeedChips(d.regions, d.authors);
  renderFeedMeta(d);
  feed.items = append ? feed.items.concat(d.items) : d.items;
  const el = $('#feed-list');
  if (!feed.items.length) {
    el.innerHTML = d.refreshing ? `<div class="feed-grid">${'<div class="skeleton"></div>'.repeat(6)}</div>`
      : feed.region === 'mine'
        ? emptyState('📚', d.authors ? 'No news about your authors right now' : 'No authors on your shelf yet',
          d.authors ? `Watching for ${plural(d.authors, 'author')} from your library. Stories that mention them will appear here.` : 'Add books to your library and stories about their authors will show up here.')
        : emptyState('📰', 'No stories found', feed.q ? 'Try a different search.' : 'Click Refresh to fetch the latest stories.');
  } else if (append) {
    $('.feed-grid', el).insertAdjacentHTML('beforeend', d.items.map(feedCard).join(''));
  } else {
    // Lead with a story that has a picture, if one is near the top.
    const heroIdx = Math.max(0, feed.items.slice(0, 10).findIndex((x) => x.image));
    const first = feed.items[heroIdx];
    const rest = feed.items.filter((_, i) => i !== heroIdx);
    el.innerHTML = (feed.q ? '' : feedHero(first)) + `<div class="feed-grid">${(feed.q ? feed.items : rest).map(feedCard).join('')}</div>`;
  }
  $('#feed-more').hidden = feed.items.length >= d.total;
  if (d.refreshing && !feed.polling) {
    feed.polling = setInterval(async () => {
      const m = await api('/api/feed?per_page=1').catch(() => null);
      if (m && !m.refreshing) { clearInterval(feed.polling); feed.polling = null; if (state.view === 'feed') { feed.page = 1; loadFeed(); } }
    }, 2000);
  }
}

$('#feed-q').addEventListener('input', debounce((e) => { feed.q = e.target.value.trim(); feed.page = 1; loadFeed(); }));
$('#feed-more').onclick = () => { feed.page += 1; loadFeed(true); };
$('#feed-refresh').onclick = () => run(async () => {
  const d = await api('/api/feed/refresh', { body: {} });
  renderFeedMeta({ ...d, refreshing: true });
  loadFeed();
});
$('#feed-sources').onclick = () => openSources();

async function openSources() {
  const d = await run(() => api('/api/feed/sources'));
  if (!d) return;
  const groups = Object.entries(d.regions).map(([k, label]) => {
    const rows = d.sources.filter((s) => s.region === k);
    return `<div class="src-group"><h3><span class="rdot ${k}"></span>${esc(label)}</h3>${rows.map((s) => `
      <div class="src-row" data-id="${s.id}">
        <label class="switch" title="Show in feed"><input type="checkbox" ${s.enabled ? 'checked' : ''}><span></span></label>
        <div class="nm"><b>${esc(s.name)}</b><span class="${s.last_error ? 'err' : ''}">${s.last_error ? 'Not responding: ' + esc(s.last_error.slice(0, 80))
          : s.last_fetched ? `${s.item_count} stories · checked ${esc(timeAgo(new Date(s.last_fetched).toISOString()))}` : 'Not fetched yet'}</span></div>
        ${s.builtin ? '' : '<button class="ghost danger small" data-del>Remove</button>'}
      </div>`).join('') || '<div class="muted small">No sources.</div>'}</div>`;
  }).join('');
  const body = openModal(`<h2>Feed sources</h2>
    <p class="muted">Switch sources on or off, or add any RSS / Atom feed: a newspaper's books section, a blog, a publisher.
      Tip: Google News searches work too, e.g. <code>https://news.google.com/rss/search?q=Humayun+Ahmed</code>.</p>
    <div class="card" style="padding:14px 16px;box-shadow:none">
      <div class="row"><input type="text" id="src-url" placeholder="https://example.com/books/feed" style="flex:2;min-width:220px">
        <input type="text" id="src-name" placeholder="Name (optional)" style="flex:1;min-width:140px">
        <select id="src-region">${Object.entries(d.regions).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select>
        <button class="primary" id="src-add">Add feed</button></div>
    </div>
    ${groups}
    <div class="modal-actions"><div></div><div><button data-close>Done</button></div></div>`, { small: true, onClose: () => { feed.page = 1; if (state.view === 'feed') loadFeed(); } });
  $('[data-close]', body).onclick = () => closeModal();
  $$('.src-row', body).forEach((row) => {
    const id = Number(row.dataset.id);
    $('input', row).onchange = (e) => run(() => api(`/api/feed/sources/${id}`, { method: 'PUT', body: { enabled: e.target.checked } }));
    const del = $('[data-del]', row);
    if (del) del.onclick = () => run(async () => {
      if (!confirm('Remove this feed and its stories?')) return;
      await api(`/api/feed/sources/${id}`, { method: 'DELETE' });
      row.remove();
    });
  });
  $('#src-add', body).onclick = () => run(async () => {
    const btn = $('#src-add', body);
    btn.disabled = true; btn.textContent = 'Checking…';
    try {
      const r = await api('/api/feed/sources', { body: { url: $('#src-url', body).value, name: $('#src-name', body).value, region: $('#src-region', body).value } });
      toast(`Added “${r.name}” (${r.items} ${r.items === 1 ? 'story' : 'stories'})`);
      openSources();
    } finally { btn.disabled = false; btn.textContent = 'Add feed'; }
  });
}

// ------------------------------------------------------------------ REVIEW
$$('#review-filter button').forEach((b) => b.onclick = () => {
  $$('#review-filter button').forEach((x) => x.classList.toggle('active', x === b));
  state.review.status = b.dataset.s; state.review.page = 1; renderReview();
});

async function renderReview() {
  const r = state.review;
  const data = await run(() => api(`/api/images?${qs({ status: r.status, page: r.page, per_page: r.per_page })}`));
  if (!data) return;
  const el = $('#review-list');
  if (!data.items.length) {
    const msg = { uncertain: ['🎉', 'Nothing uncertain', 'Gemini was confident about every photo so far.'],
      failed: ['✅', 'No failures', 'Every photo was processed without errors.'],
      not_book: ['📷', 'Nothing here', 'No photos have been marked as “not a book”.'] }[r.status];
    el.innerHTML = emptyState(...msg);
  } else {
    el.innerHTML = data.items.map((im, i) => `<div class="review-item" data-id="${im.id}" style="--i:${Math.min(i, 20)}">
      <img src="${thumb(im.id, true)}" loading="lazy" alt="" data-zoom>
      <div>
        <div class="row">${badge(im.status)}<span class="muted small">${esc(im.filename)} · confidence ${pct(im.confidence)}</span></div>
        ${im.books.length ? im.books.map((b) => `<div style="margin-top:10px"><span class="bt">${esc(b.title)}</span> <span class="muted">— ${esc(authorsText(b.authors))}</span> ${badge(b.status)}</div>`).join('')
          : '<div class="muted" style="margin-top:10px">No book identified.</div>'}
        ${im.error ? `<div class="notes">${esc(im.error)}</div>` : ''}
      </div>
      <div class="actions">
        ${im.books.length ? '<button class="primary" data-a="accept">✓ Looks right</button>' : ''}
        <button data-a="edit">Review &amp; edit…</button>
        <button data-a="link">Match to book…</button>
        <button data-a="retry">↻ Retry analysis</button>
        ${im.status !== 'not_book' ? '<button class="ghost" data-a="notbook">Not a book</button>' : ''}
      </div></div>`).join('');
  }
  $$('.review-item', el).forEach((item) => {
    const id = Number(item.dataset.id);
    $('[data-zoom]', item).onclick = () => openImage(id);
    $$('[data-a]', item).forEach((btn) => btn.onclick = () => {
      const a = btn.dataset.a;
      if (a === 'accept') run(async () => { await api('/api/images/accept', { body: { ids: [id] } }); toast(im.books.some((b) => !b.in_library) ? 'Accepted. Add it to your library from New Finds' : 'Accepted'); renderReview(); poll(); });
      if (a === 'edit') openImage(id);
      if (a === 'link') linkImagesTo([id]);
      if (a === 'retry') reanalyze([id]);
      if (a === 'notbook') markNotBook([id]);
    });
  });
  renderPager($('#review-pager'), data.total, data.page, data.per_page, (p) => { r.page = p; renderReview(); window.scrollTo(0, 0); });
}

// ------------------------------------------------------------------ SETTINGS
const SETTING_INPUTS = { model: '#set-model', fallback_model: '#set-fallback', rpm: '#set-rpm', daily_limit: '#set-daily',
  batch_size: '#set-batch', confidence_threshold: '#set-threshold', max_image_px: '#set-px', jpeg_quality: '#set-quality' };

async function renderSettings() {
  const s = await run(() => api('/api/settings'));
  if (!s) return;
  for (const [k, sel] of Object.entries(SETTING_INPUTS)) $(sel).value = s[k] ?? '';
  $('#set-key').value = '';
  $('#key-hint').textContent = s.has_key ? `(saved key ${s.api_key_hint}${s.api_key_from_env ? ', from environment' : ''})` : '(no key saved)';
  $('#key-clear').hidden = !s.has_key || s.api_key_from_env;
  const sys = await api('/api/system').catch(() => null);
  $('#desktop-card').hidden = !(sys && sys.can_shortcut);
}

$('#make-shortcut').onclick = () => run(async () => {
  $('#shortcut-result').textContent = 'Adding…';
  try {
    await api('/api/system/shortcut', { body: {} });
    $('#shortcut-result').innerHTML = '<span style="color:var(--ok)">✓ Done! Look for the Shelfie button on your Desktop and in the Start menu.</span>';
  } catch (e) { $('#shortcut-result').innerHTML = `<span style="color:var(--bad)">${esc(e.message)}</span>`; }
});

$('#settings-save').onclick = () => run(async () => {
  const data = {};
  for (const [k, sel] of Object.entries(SETTING_INPUTS)) data[k] = k.endsWith('model') ? $(sel).value : Number($(sel).value);
  const key = $('#set-key').value.trim();
  if (key) data.api_key = key;
  await api('/api/settings', { method: 'PUT', body: data });
  toast('Settings saved');
  renderSettings(); poll();
});
$('#key-test').onclick = () => run(async () => {
  const out = $('#key-result');
  out.textContent = 'Testing…';
  try {
    const r = await api('/api/settings/test', { body: { api_key: $('#set-key').value.trim() || undefined } });
    $('#model-list').innerHTML = r.models.map((m) => `<option value="${esc(m.name)}">${esc(m.display_name)}</option>`).join('');
    out.innerHTML = `<span style="color:var(--ok)">✓ Key works. ${r.models.length} models available.</span>`;
  } catch (e) {
    out.innerHTML = `<span style="color:var(--bad)">${esc(e.message)}</span>`;
  }
});
$('#key-clear').onclick = () => run(async () => {
  if (!confirm('Remove the saved API key?')) return;
  await api('/api/settings', { method: 'PUT', body: { clear_api_key: true } });
  toast('Key removed');
  renderSettings(); poll();
});

// ------------------------------------------------------------------ READER (PDF, EPUB, TXT)
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174';
const EPUBJS = 'https://cdn.jsdelivr.net/npm/epubjs@0.3.93/dist/epub.min.js';
const JSZIP = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const FONTS = [80, 90, 100, 110, 120, 135, 150, 175, 200];
const PAPERS = { paper: '#1f1a15', sepia: '#3b2f22', night: '#d9d0c3' };  // text colour on each page colour
const reader = {
  open: false, kind: null, book: null, doc: null, page: 1, pages: 0, zoom: 1, fit: 'page', token: 0, tasks: [],
  layout: store('rdLayout', 'single'), paper: store('rdPaper', 'paper'), font: Number(store('rdFont', '100')) || 100,
  saveT: null, idleT: null, wheelT: 0, epub: null, rendition: null, locReady: false, pct: 0, pos: null, flow: null, toc: [],
};
const scriptCache = {};

function loadScript(src) {
  if (!scriptCache[src]) {
    scriptCache[src] = new Promise((resolve, reject) => {
      const tag = document.createElement('script');
      tag.src = src;
      tag.onload = resolve;
      tag.onerror = () => { delete scriptCache[src]; tag.remove(); reject(new Error('The reader needs the internet the first time')); };
      document.head.append(tag);
    });
  }
  return scriptCache[src];
}
async function loadPdfJs() {
  await loadScript(`${PDFJS}/pdf.min.js`);
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS}/pdf.worker.min.js`;
  return window.pdfjsLib;
}
async function loadEpubJs() { await loadScript(JSZIP); await loadScript(EPUBJS); return window.ePub; }
const ebookUrl = (b, download = false) => `/api/books/${b.id}/ebook${download ? '?download=1' : ''}`;

async function openReader(bookId) {
  const b = await run(() => api(`/api/books/${bookId}`));
  if (!b) return;
  if (!b.ebook_available) { toast('This book has no eBook file yet. Open the book to upload one.', true); return; }
  if (!b.ebook_readable) {
    toast(`Shelfie can't show ${b.ebook_label} files in the browser, so it's downloading for your e-reader app.`);
    location.href = ebookUrl(b, true);
    return;
  }
  const el = $('#reader');
  Object.assign(reader, { open: true, kind: b.ebook_ext, book: b, doc: null, page: 1, pages: 0, zoom: 1, fit: 'page',
    epub: null, rendition: null, locReady: false, pct: b.ebook_pct || 0, pos: b.ebook_pos, flow: null, toc: [] });
  el.hidden = false;
  el.classList.remove('closing', 'idle');
  el.dataset.paper = reader.paper;
  el.dataset.kind = reader.kind;
  el.style.setProperty('--rd-font', reader.font / 100);
  document.body.style.overflow = 'hidden';
  $('#rd-book-title').textContent = b.title;
  $('#rd-book-author').textContent = authorsText(b.authors);
  $('#rd-download').href = ebookUrl(b, true);
  $('#rd-pages').innerHTML = '';
  $('#rd-toc').hidden = true;
  $('#rd-toc-btn').classList.remove('active');
  $('#rd-loading').hidden = false;
  $$('.rd-fallback, .rd-flow').forEach((f) => f.remove());
  syncReaderTools();
  try {
    if (reader.kind === 'pdf') await openPdf(b);
    else if (reader.kind === 'epub') await openEpub(b);
    else await openText(b);
  } catch (err) {
    console.warn(err);
    if (!reader.open) return;
    $('#rd-loading').hidden = true;
    if (reader.kind === 'pdf') {
      // Offline or unusual PDF: fall back to the browser's own viewer so the book still opens.
      const frame = document.createElement('iframe');
      frame.className = 'rd-fallback';
      frame.src = ebookUrl(b);
      Object.assign(frame.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' });
      $('#rd-stage').append(frame);
      toast("Using your browser's built-in PDF viewer");
    } else {
      $('#rd-stage').insertAdjacentHTML('beforeend', `<div class="rd-flow rd-error">
        <h2>This ${esc(ebookTag(b))} couldn't be opened</h2><p>${esc(err.message || 'The file may be damaged, or the reader needs the internet the first time.')}</p>
        <p>If it's the wrong file, close the reader, open the book and choose <b>Upload a different file</b>.</p>
        <a class="button gold" href="${ebookUrl(b, true)}">Download it instead</a></div>`);
    }
    return;
  }
  if (!reader.open) return;
  $('#rd-loading').hidden = true;
  armIdle();
}

// ---- PDF
async function openPdf(b) {
  const lib = await loadPdfJs();
  reader.doc = await lib.getDocument({ url: ebookUrl(b), rangeChunkSize: 262144 }).promise;
  if (!reader.open) return;
  reader.pages = reader.doc.numPages;
  $('#rd-pages-total').textContent = reader.pages;
  $('#rd-slider').max = reader.pages;
  $('#rd-page').max = reader.pages;
  const start = b.ebook_page && b.ebook_page <= reader.pages ? b.ebook_page : 1;
  if (start > 1) toast(`Welcome back, carrying on from page ${start}`);
  await goToPage(start, 0);
  saveProgress(true);
  loadPdfToc();
}

// ---- EPUB (epub.js): real reflowing pages, chapters, font size and page colours
/** Create the EPUB page view with the current layout, page colour and font size. */
function setupRendition() {
  const inner = $('.rd-epub-inner', reader.flow);
  inner.innerHTML = '';
  const r = reader.rendition = reader.epub.renderTo(inner, {
    width: '100%', height: '100%', flow: 'paginated', spread: reader.layout === 'spread' ? 'always' : 'none', allowScriptedContent: false,
  });
  for (const [name, color] of Object.entries(PAPERS)) {
    r.themes.register(name, {
      body: { color: `${color} !important`, background: 'transparent !important', 'font-family': 'Georgia, "Iowan Old Style", "Palatino Linotype", serif', 'line-height': '1.65' },
      'p, li, span, div, h1, h2, h3, h4': { color: `${color} !important` },
      a: { color: name === 'night' ? '#e3b866 !important' : '#8e3424 !important' },
      img: { 'max-width': '100%' },
    });
  }
  r.themes.select(reader.paper);
  r.themes.fontSize(`${reader.font}%`);
  r.on('relocated', (loc) => {
    reader.pos = loc.start.cfi;
    reader.pct = reader.locReady ? reader.epub.locations.percentageFromCfi(loc.start.cfi) : (loc.start.percentage || reader.pct);
    syncReaderTools();
    saveProgress();
  });
  r.on('keydown', (e) => readerKey(e));
  r.on('mousemove', () => armIdle());
  r.on('touchstart', (e) => { touchX = e.changedTouches ? e.changedTouches[0].clientX : null; });
  r.on('touchend', (e) => endSwipe(e));
}

async function openEpub(b) {
  const ePub = await loadEpubJs();
  const res = await fetch(ebookUrl(b));
  if (!res.ok) throw new Error('The file could not be loaded');
  const data = await res.arrayBuffer();
  if (!reader.open) return;
  const box = document.createElement('div');
  box.className = `rd-flow rd-epub ${reader.layout === 'spread' ? 'spread' : ''}`;
  box.innerHTML = '<div class="rd-epub-inner"></div>';
  $('#rd-stage').append(box);
  reader.flow = box;
  reader.epub = ePub(data);
  setupRendition();
  const r = reader.rendition;
  try { await r.display(b.ebook_pos || undefined); } catch { await r.display(); }
  if (b.ebook_pct > 0.01) toast(`Welcome back, carrying on from ${Math.round(b.ebook_pct * 100)}%`);
  // Locations make the progress slider and percentages accurate; computing them takes a moment.
  reader.epub.ready.then(() => reader.epub.locations.generate(1200)).then(() => {
    if (!reader.open || reader.kind !== 'epub') return;
    reader.locReady = true;
    if (reader.pos) reader.pct = reader.epub.locations.percentageFromCfi(reader.pos);
    syncReaderTools();
  }).catch(() => {});
  reader.epub.loaded.navigation.then((nav) => {
    const items = [];
    const walk = (list, level) => list.forEach((n) => { items.push({ label: (n.label || '').trim(), href: n.href, level }); if (n.subitems && level < 2) walk(n.subitems, level + 1); });
    walk(nav.toc || [], 0);
    reader.toc = items;
    renderTocList(items.map((it, i) => ({ title: it.label || `Section ${i + 1}`, level: it.level })), (i) => reader.rendition.display(items[i].href));
  }).catch(() => renderTocList([], null));
}

// ---- TXT: a clean scrolling page
async function openText(b) {
  const res = await fetch(ebookUrl(b));
  if (!res.ok) throw new Error('The file could not be loaded');
  const buf = await res.arrayBuffer();
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch {
    try { text = new TextDecoder('utf-16', { fatal: true }).decode(buf); } catch { text = new TextDecoder('windows-1252').decode(buf); }
  }
  if (!reader.open) return;
  const box = document.createElement('div');
  box.className = 'rd-flow rd-text';
  const paras = text.replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  box.innerHTML = `<article>${paras.map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')}</article>`;
  $('#rd-stage').append(box);
  reader.flow = box;
  requestAnimationFrame(() => {
    box.scrollTop = (reader.pct || 0) * (box.scrollHeight - box.clientHeight);
    if (reader.pct > 0.01) toast(`Welcome back, carrying on from ${Math.round(reader.pct * 100)}%`);
    syncReaderTools();
  });
  box.addEventListener('scroll', debounce(() => {
    const max = box.scrollHeight - box.clientHeight;
    reader.pct = max > 0 ? box.scrollTop / max : 1;
    reader.pos = reader.pct.toFixed(4);
    syncReaderTools();
    saveProgress();
  }, 120));
  renderTocList([], null);
}

/** Re-create the EPUB view at the current position (after changing one/two pages or the font size). */
function rebuildEpub() {
  if (!reader.epub || !reader.flow) return;
  const at = reader.pos;
  try { reader.rendition.destroy(); } catch { /* gone */ }
  reader.flow.classList.toggle('spread', reader.layout === 'spread');
  setupRendition();
  reader.rendition.display(at || undefined).catch(() => reader.rendition.display());
  syncReaderTools();
}

function closeReader() {
  if (!reader.open) return;
  saveProgress(true);
  reader.open = false;
  reader.token++;
  reader.tasks.forEach((t) => { try { t.cancel(); } catch { /* already done */ } });
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  const el = $('#reader');
  el.classList.add('closing');
  const { doc, rendition, epub } = reader;
  setTimeout(() => {
    el.hidden = true; el.classList.remove('closing');
    $('#rd-pages').innerHTML = '';
    $$('.rd-fallback, .rd-flow').forEach((f) => f.remove());
    try { if (rendition) rendition.destroy(); if (epub) epub.destroy(); } catch { /* already gone */ }
    if (doc) doc.destroy();
  }, reduceMotion ? 0 : 230);
  Object.assign(reader, { doc: null, rendition: null, epub: null, flow: null });
  if (!fullcase.open) document.body.style.overflow = '';
  refreshView();
  loadBookcase();
}

/** Which PDF pages are on screen for a given page: in two-page mode the cover is alone, then 2-3, 4-5… */
function visiblePages(p) {
  if (reader.layout !== 'spread' || reader.pages < 2 || p === 1) return [p];
  const left = p % 2 === 0 ? p : p - 1;
  return left + 1 <= reader.pages ? [left, left + 1] : [left];
}

async function goToPage(p, dir = 0) {
  if (!reader.doc) return;
  p = Math.max(1, Math.min(reader.pages, Math.round(p) || 1));
  reader.page = visiblePages(p)[0];
  await renderPages(dir);
  saveProgress();
}

function flowTurn(dir) {
  const f = reader.flow;
  if (!f || reduceMotion) return;
  f.classList.remove('turn-next', 'turn-prev'); void f.offsetWidth; f.classList.add(dir > 0 ? 'turn-next' : 'turn-prev');
}
function nextPage() {
  if (reader.kind === 'epub') { if (reader.rendition) { reader.rendition.next(); flowTurn(1); } return; }
  if (reader.kind === 'txt') { if (reader.flow) reader.flow.scrollBy({ top: reader.flow.clientHeight * 0.9, behavior: reduceMotion ? 'auto' : 'smooth' }); return; }
  const v = visiblePages(reader.page); if (v[v.length - 1] < reader.pages) goToPage(v[v.length - 1] + 1, 1);
}
function prevPage() {
  if (reader.kind === 'epub') { if (reader.rendition) { reader.rendition.prev(); flowTurn(-1); } return; }
  if (reader.kind === 'txt') { if (reader.flow) reader.flow.scrollBy({ top: -reader.flow.clientHeight * 0.9, behavior: reduceMotion ? 'auto' : 'smooth' }); return; }
  if (reader.page > 1) goToPage(visiblePages(reader.page - 1)[0], -1);
}
function goToPct(p) {
  p = Math.max(0, Math.min(1, p));
  if (reader.kind === 'epub' && reader.locReady) reader.rendition.display(reader.epub.locations.cfiFromPercentage(p));
  else if (reader.kind === 'txt' && reader.flow) reader.flow.scrollTop = p * (reader.flow.scrollHeight - reader.flow.clientHeight);
}

async function renderPages(dir) {
  const doc = reader.doc;
  if (!doc) return;
  const token = ++reader.token;
  reader.tasks.forEach((t) => { try { t.cancel(); } catch { /* finished */ } });
  reader.tasks = [];
  const nums = visiblePages(reader.page);
  const stage = $('#rd-stage');
  const narrow = innerWidth < 860;
  const availW = stage.clientWidth - (narrow ? 16 : 140);
  const availH = stage.clientHeight - (narrow ? 32 : 66);
  const pages = await Promise.all(nums.map((n) => doc.getPage(n)));
  if (token !== reader.token) return;
  const base = pages.map((pg) => pg.getViewport({ scale: 1 }));
  const totalW = base.reduce((sum, v) => sum + v.width, 0);
  const maxH = Math.max(...base.map((v) => v.height));
  const fitScale = reader.fit === 'width' ? availW / totalW : Math.min(availW / totalW, availH / maxH);
  const scale = Math.max(0.1, fitScale * reader.zoom);
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const holder = document.createElement('div');
  const jobs = pages.map((pg) => {
    const vp = pg.getViewport({ scale });
    const wrap = document.createElement('div');
    wrap.className = 'rd-page';
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = `${Math.floor(vp.width)}px`;
    canvas.style.height = `${Math.floor(vp.height)}px`;
    wrap.append(canvas);
    holder.append(wrap);
    const task = pg.render({ canvasContext: canvas.getContext('2d'), viewport: pg.getViewport({ scale: scale * dpr }) });
    reader.tasks.push(task);
    return task.promise;
  });
  try { await Promise.all(jobs); } catch (err) { if (token === reader.token) console.warn(err); return; }
  if (token !== reader.token) return;
  const target = $('#rd-pages');
  target.className = 'rd-pages' + (nums.length > 1 ? ' spread' : '');
  target.replaceChildren(...holder.childNodes);
  if (dir && !reduceMotion) { void target.offsetWidth; target.classList.add(dir > 0 ? 'turn-next' : 'turn-prev'); }
  stage.classList.toggle('fitpage', reader.fit === 'page' && reader.zoom <= 1);
  if (dir) stage.scrollTop = 0;
  syncReaderTools();
}

function syncReaderTools() {
  const flow = reader.kind === 'epub' || reader.kind === 'txt';
  $$('#rd-layout button').forEach((b) => b.classList.toggle('active', b.dataset.l === reader.layout));
  $$('#rd-paper button').forEach((b) => b.classList.toggle('active', b.dataset.p === reader.paper));
  if (flow) {
    $('#rd-slider').max = 1000;
    $('#rd-slider').value = Math.round((reader.pct || 0) * 1000);
    $('#rd-slider').disabled = reader.kind === 'epub' && !reader.locReady;
    $('#rd-pct').textContent = `${Math.round((reader.pct || 0) * 100)}%`;
    $('#rd-zoom').textContent = `${reader.font}%`;
    $('#rd-where').textContent = reader.kind === 'epub' && !reader.locReady ? 'Preparing page numbers…' : 'Through the book';
    $('#rd-prev').style.visibility = '';
    $('#rd-next').style.visibility = '';
    return;
  }
  const last = visiblePages(reader.page).slice(-1)[0] || 1;
  $('#rd-slider').disabled = false;
  $('#rd-page').value = reader.page;
  $('#rd-slider').value = reader.page;
  $('#rd-pct').textContent = reader.pages ? `${Math.round(last / reader.pages * 100)}%` : '0%';
  $('#rd-zoom').textContent = `${Math.round(reader.zoom * 100)}%`;
  $('#rd-fit').classList.toggle('active', reader.fit === 'width');
  $('#rd-fit').title = reader.fit === 'width' ? 'Fit the whole page' : 'Fit the page width';
  $('#rd-prev').style.visibility = reader.page > 1 ? '' : 'hidden';
  $('#rd-next').style.visibility = last < reader.pages ? '' : 'hidden';
}

function saveProgress(now = false) {
  if (!reader.book) return;
  let payload;
  if (reader.kind === 'pdf') { if (!reader.pages) return; payload = { page: reader.page, pages: reader.pages }; }
  else payload = { pos: reader.pos, pct: reader.pct };
  clearTimeout(reader.saveT);
  const id = reader.book.id;
  const send = () => api(`/api/books/${id}/progress`, { method: 'PUT', body: payload }).catch(() => {});
  if (now) send(); else reader.saveT = setTimeout(send, 800);
}

function renderTocList(items, onPick) {
  const list = $('#rd-toc-list');
  if (!items.length) {
    list.innerHTML = `<div class="none">This ${reader.kind === 'txt' ? 'text file' : 'book'} has no table of contents.</div>`;
    return;
  }
  list.innerHTML = items.map((it, i) => `<a class="l${it.level}" data-i="${i}">${esc(it.title)}</a>`).join('');
  $$('a', list).forEach((a) => a.onclick = () => {
    try { onPick(Number(a.dataset.i)); } catch { toast('That chapter link could not be followed', true); }
    if (innerWidth < 860) $('#rd-toc').hidden = true;
  });
}

async function loadPdfToc() {
  $('#rd-toc-list').innerHTML = '<div class="none">Loading…</div>';
  let outline = null;
  try { outline = await reader.doc.getOutline(); } catch { /* none */ }
  const items = [];
  const walk = (nodes, level) => nodes.forEach((n) => { items.push({ n, level }); if (n.items && level < 2) walk(n.items, level + 1); });
  walk(outline || [], 0);
  renderTocList(items.map(({ n, level }) => ({ title: n.title, level })), async (i) => {
    let dest = items[i].n.dest;
    if (typeof dest === 'string') dest = await reader.doc.getDestination(dest);
    if (!dest) return;
    const idx = typeof dest[0] === 'object' ? await reader.doc.getPageIndex(dest[0]) : dest[0];
    goToPage(idx + 1, 1);
  });
}

function setZoom(z) { reader.zoom = z; renderPages(0); }
function zoomStep(d) {
  if (reader.kind !== 'pdf') {  // EPUB / text: change the font size
    const i = FONTS.findIndex((f) => f >= reader.font);
    reader.font = FONTS[Math.max(0, Math.min(FONTS.length - 1, (i < 0 ? FONTS.length - 1 : i) + d))];
    try { localStorage.setItem('rdFont', reader.font); } catch { /* ignore */ }
    $('#reader').style.setProperty('--rd-font', reader.font / 100);
    if (reader.rendition) rebuildEpub();
    syncReaderTools();
    return;
  }
  const i = ZOOMS.findIndex((z) => z >= reader.zoom - 0.001);
  setZoom(ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? ZOOMS.length - 1 : i) + d))]);
}

function readerKey(e) {
  if (e.target && e.target.matches && e.target.matches('input') && e.key !== 'Escape') return;
  const k = e.key;
  if (k === 'Escape') { if (!document.fullscreenElement) closeReader(); return; }
  if (reader.kind === 'txt' && ['ArrowUp', 'ArrowDown'].includes(k)) return;  // let text scroll normally
  if (['ArrowRight', 'PageDown', ' '].includes(k)) { e.preventDefault(); nextPage(); }
  else if (['ArrowLeft', 'PageUp'].includes(k)) { e.preventDefault(); prevPage(); }
  else if (k === 'Home') { if (reader.kind === 'pdf') goToPage(1, -1); else goToPct(0); }
  else if (k === 'End') { if (reader.kind === 'pdf') goToPage(reader.pages, 1); else goToPct(1); }
  else if (k === '+' || k === '=') zoomStep(1);
  else if (k === '-') zoomStep(-1);
  armIdle();
}

function armIdle() {
  const el = $('#reader');
  el.classList.remove('idle');
  clearTimeout(reader.idleT);
  reader.idleT = setTimeout(() => {
    if (reader.open && $('#rd-toc').hidden && !$('.rd-top:hover, .rd-bottom:hover')) el.classList.add('idle');
  }, 2800);
}

$('#reader').addEventListener('mousemove', debounce(armIdle, 60));
$('#rd-close').onclick = closeReader;
$('#rd-prev').onclick = prevPage;
$('#rd-next').onclick = nextPage;
$('#rd-zoom-in').onclick = () => zoomStep(1);
$('#rd-zoom-out').onclick = () => zoomStep(-1);
$('#rd-fit').onclick = () => { reader.fit = reader.fit === 'width' ? 'page' : 'width'; reader.zoom = 1; renderPages(0); };
$('#rd-toc-btn').onclick = () => {
  $('#rd-toc').hidden = !$('#rd-toc').hidden;
  $('#rd-toc-btn').classList.toggle('active', !$('#rd-toc').hidden);
  setTimeout(() => { if (reader.kind === 'pdf') renderPages(0); else if (reader.rendition) reader.rendition.resize(); }, 30);
};
$('#rd-full').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : $('#reader').requestFullscreen()).catch(() => {});
$('#rd-page').addEventListener('change', (e) => goToPage(Number(e.target.value), 0));
$('#rd-slider').addEventListener('input', (e) => {
  if (reader.kind === 'pdf') $('#rd-page').value = e.target.value;
  else $('#rd-pct').textContent = `${Math.round(e.target.value / 10)}%`;
});
$('#rd-slider').addEventListener('change', (e) => {
  if (reader.kind === 'pdf') goToPage(Number(e.target.value), 0); else goToPct(Number(e.target.value) / 1000);
});
$$('#rd-layout button').forEach((b) => b.onclick = () => {
  reader.layout = b.dataset.l;
  try { localStorage.setItem('rdLayout', reader.layout); } catch { /* ignore */ }
  if (reader.kind === 'epub' && reader.rendition) rebuildEpub();
  else goToPage(reader.page, 0);
});
$$('#rd-paper button').forEach((b) => b.onclick = () => {
  reader.paper = b.dataset.p;
  $('#reader').dataset.paper = reader.paper;
  if (reader.rendition) reader.rendition.themes.select(reader.paper);
  try { localStorage.setItem('rdPaper', reader.paper); } catch { /* ignore */ }
  syncReaderTools();
});
// Mouse wheel: turns PDF pages when the whole page fits, and EPUB pages always; text simply scrolls.
$('#rd-stage').addEventListener('wheel', (e) => {
  if (reader.kind === 'txt' || e.ctrlKey) return;
  const st = $('#rd-stage');
  if (reader.kind === 'pdf' && st.scrollHeight > st.clientHeight + 4) return;
  e.preventDefault();
  if (Date.now() - reader.wheelT < 350) return;
  reader.wheelT = Date.now();
  if (e.deltaY > 0) nextPage(); else if (e.deltaY < 0) prevPage();
}, { passive: false });
// Swipe left / right on touch screens.
let touchX = null;
function endSwipe(e) {
  if (touchX == null || reader.kind === 'txt') { touchX = null; return; }
  const dx = (e.changedTouches ? e.changedTouches[0].clientX : touchX) - touchX;
  touchX = null;
  if (Math.abs(dx) > 50) (dx < 0 ? nextPage : prevPage)();
}
$('#rd-stage').addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
$('#rd-stage').addEventListener('touchend', endSwipe);
addEventListener('resize', debounce(() => {
  if (!reader.open) return;
  if (reader.kind === 'pdf' && reader.doc) renderPages(0);
  if (reader.rendition) reader.rendition.resize();
}, 250));

// ------------------------------------------------------------------ CLOSE SHELFIE
$('#quit-app').onclick = async () => {
  const busy = state.status && state.status.processor.state !== 'idle';
  if (!confirm(busy ? 'Shelfie is still identifying photos. Close anyway? Unfinished photos will wait for next time.'
    : 'Close Shelfie? Your library is saved. Start it again any time with the Shelfie button or Shelfie-Windows.bat.')) return;
  await api('/api/system/quit', { body: {} }).catch(() => {});
  const logo = $('.brand-logo').outerHTML.replace('class="brand-logo"', 'width="96" height="96"');
  document.body.insertAdjacentHTML('beforeend', `<div class="goodbye">${logo}<h1>See you soon 📚</h1>
    <p>Shelfie is closed and your library is saved. You can close this tab.</p>
    <p>To open it again, click the <b>Shelfie</b> button on your Desktop, or double-click <b>Shelfie-Windows.bat</b>.</p></div>`);
};

// ------------------------------------------------------------------ boot
poll().then(() => {
  const s = state.status;
  if (!location.hash && s && !s.books.total && !s.counts.total) location.hash = '#import';
  else if (!location.hash && s && !s.books.total && s.books.finds) location.hash = '#finds';
  else showView();
});
