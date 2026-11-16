import { escapeHtml as esc } from './text.js';

const symbols = {
  later: 'M15 18l-6-6 6-6', keep: 'm5 12 4 4L19 6',
  undo: 'M3 10h11a7 7 0 0 1 0 14 M3 10l5-5 M3 10l5 5',
  edit: 'm4 16-1 5 5-1L20 8l-4-4z M13 7l4 4',
  archive: 'M3 3h18v5H3z M5 8v13h14V8 M9 12h6',
  delete: 'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7',
  camera: 'M3 7h4l2-3h6l2 3h4v13H3z M16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${symbols[name]}"/></svg>`;
const purchaseList = item => item.purchases || [{ id: item.id, revision: item.revision, ...item.data }];

export class InboxReview {
  constructor({ root, read, send, money, date, place, open, remove, changed, active, samples }) {
    Object.assign(this, { root, read, send, money, date, place, open, remove, changed, active, samples });
    this.queue = [];
    this.history = [];
    this.later = new Set();
    this.busy = false;
    this.loading = false;
    this.error = '';
    this.generation = 0;
    root.addEventListener('click', event => {
      const button = event.target.closest('[data-review]');
      if (!button || this.busy || this.loading) return;
      this.handle(button.dataset.review);
    });
    document.addEventListener('keydown', event => {
      if (!this.active() || this.busy || this.loading || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
      if (document.querySelector('dialog[open]') || event.target.closest('input,textarea,select,a,[contenteditable=true]')) return;
      const action = { ArrowLeft: 'later', ArrowRight: 'keep', z: 'undo', Z: 'undo' }[event.key];
      if (action) { event.preventDefault(); this.handle(action); }
    });
    root.addEventListener('pointerdown', event => this.dragStart(event));
    root.addEventListener('pointermove', event => this.dragMove(event));
    root.addEventListener('pointerup', event => this.dragEnd(event));
    root.addEventListener('pointercancel', () => this.resetDrag());
    root.addEventListener('lostpointercapture', () => this.resetDrag());
  }

  async start() {
    if (this.busy) { this.render(); return; }
    const generation = ++this.generation;
    const sampleItems = this.samples();
    const sample = Boolean(sampleItems);
    if (this.sample !== sample) { this.history = []; this.later.clear(); }
    this.sample = sample;
    this.loading = true;
    this.error = '';
    this.render();
    try {
      const items = [];
      if (sampleItems) {
        const finished = new Set(this.history.filter(entry => entry.action !== 'later').map(entry => entry.item.id));
        items.push(...sampleItems.filter(item => !finished.has(item.id)));
      } else {
        let offset = 0, total;
        do {
          const page = await this.read(`/api/items?status=inbox&group=product&sort=purchaseDate&direction=desc&limit=200&offset=${offset}`);
          if (generation !== this.generation) return;
          items.push(...page.items);
          offset += page.items.length;
          total = page.total;
          if (!page.items.length) break;
        } while (offset < total);
      }
      const currentId = this.queue[0]?.id;
      this.queue = [...new Map(items.map(item => [item.id, item])).values()]
        .filter(item => !purchaseList(item).every(purchase => this.later.has(purchase.id)));
      const index = this.queue.findIndex(item => item.id === currentId);
      if (index > 0) this.queue.unshift(...this.queue.splice(index, 1));
      if (!sample) await this.changed();
    } catch (error) { this.error = error.message; }
    finally {
      if (generation === this.generation) { this.loading = false; this.render(); }
    }
  }

  async handle(action) {
    if (this.busy || this.loading) return;
    if (action === 'reload') return this.start();
    if (action === 'restart') { this.later.clear(); this.history = this.history.filter(entry => entry.action !== 'later'); return this.start(); }
    if (action === 'undo') return this.undo();
    const item = this.queue[0];
    if (!item) return;
    if (action === 'edit' || action === 'details' || action === 'delete') {
      this.busy = true;
      this.error = '';
      try {
        if (action === 'delete') {
          if (!this.sample) await this.remove(item.id);
        } else await this.open(item.id, action === 'edit');
      }
      catch (error) { this.error = error.message; }
      finally { this.busy = false; this.render(); }
      return;
    }
    if (!['keep', 'archive', 'later'].includes(action)) return;
    this.busy = true;
    this.error = '';
    this.render();
    let reload = false;
    try {
      const purchases = purchaseList(item);
      let saved = null;
      if (action !== 'later' && !this.sample) {
        saved = await this.send('/api/inbox/review', {
          action, items: purchases.slice(0, 200).map(({ id, revision }) => ({ id, revision })),
        });
      }
      await this.animate(action === 'keep' ? 'right' : 'left');
      if (action === 'later') purchases.forEach(purchase => this.later.add(purchase.id));
      this.history.push({ action, item, saved });
      this.queue.shift();
      reload = saved && purchases.length > saved.items.length;
      if (!this.sample && action !== 'later') {
        try { await this.changed(); } catch { this.error = 'Decision saved. Reload to update the totals.'; }
      }
    } catch (error) { this.error = error.message; }
    finally { this.busy = false; if (reload) await this.start(); else this.render(true); }
  }

  async undo() {
    const entry = this.history.at(-1);
    if (!entry || entry.undoUnavailable || this.busy) return;
    this.busy = true;
    this.error = '';
    this.render();
    try {
      let restored = entry.item;
      if (entry.saved) {
        const result = await this.send('/api/inbox/review', { action: 'undo', from: entry.saved.status, items: entry.saved.items });
        const revisions = new Map(result.items.map(item => [item.id, item.revision]));
        restored = {
          ...restored, revision: revisions.get(restored.id) ?? restored.revision,
          purchases: purchaseList(restored).map(purchase => ({ ...purchase, revision: revisions.get(purchase.id) ?? purchase.revision })),
        };
      }
      purchaseList(restored).forEach(purchase => this.later.delete(purchase.id));
      this.queue = [restored, ...this.queue.filter(item => item.id !== restored.id)];
      this.history.pop();
      if (entry.saved) {
        try { await this.changed(); } catch { this.error = 'Undo saved. Reload to update the totals.'; }
      }
    } catch (error) {
      if (error.status === 409) {
        entry.undoUnavailable = true;
        this.error = 'Newer changes prevent Undo. Use History to review these purchases.';
      } else this.error = error.message;
    }
    finally {
      this.busy = false;
      if (!this.error && entry.saved) await this.start();
      this.render(true);
    }
  }

  price(item) {
    const purchases = purchaseList(item);
    const priced = purchases.filter(purchase => purchase.priceMinor !== null);
    if (!priced.length) return 'Price not set';
    if (priced.length !== purchases.length || new Set(priced.map(purchase => purchase.currency)).size > 1) return 'Prices vary';
    const low = Math.min(...priced.map(purchase => purchase.priceMinor));
    const high = Math.max(...priced.map(purchase => purchase.priceMinor));
    return low === high ? this.money(low, priced[0].currency) : `${this.money(low, priced[0].currency)} – ${this.money(high, priced[0].currency)}`;
  }

  render(focus = false) {
    if (!this.active()) return;
    this.resetDrag();
    const disabled = this.busy || this.loading ? 'disabled' : '';
    const item = this.queue[0];
    const done = this.history.filter(entry => entry.action !== 'later').length;
    const total = done + this.queue.length;
    const progress = total ? Math.round(done / total * 100) : 100;
    const last = this.history.at(-1);
    const lastMessage = last ? ({ keep: 'Kept in your collection', archive: 'Moved to Archive', later: 'Saved for later' }[last.action]) : 'Your decisions appear here';
    const status = this.loading ? 'Loading your inbox…' : this.busy ? 'Saving…' : `${this.queue.length} product${this.queue.length === 1 ? '' : 's'} to review`;
    this.root.innerHTML = `<section class="inbox-review" aria-label="Review inbox">
      <div class="review-topline"><span role="status" aria-live="polite">${status}</span><span>${done} reviewed</span></div>
      <progress class="review-progress" max="100" value="${progress}" aria-label="Review progress">${progress}%</progress>
      ${this.error ? `<div class="review-error" role="alert"><span>${esc(this.error)}</span><button data-review="reload" ${disabled}>Reload inbox</button></div>` : ''}
      ${this.loading ? '<div class="review-loading"><span class="spinner"></span> Opening your inbox…</div>' : item ? this.card(item) : this.error ? '<div class="review-loading">Reload the inbox to continue.</div>' : `<div class="review-complete"><span class="review-complete-icon">${icon('keep')}</span><h2>${this.later.size ? 'That is everything for now.' : 'Your inbox is clear.'}</h2><p>${this.later.size ? `${this.later.size} purchase${this.later.size === 1 ? '' : 's'} saved for later. They remain in your inbox.` : 'New purchases will appear here for review.'}</p><button class="button secondary" data-review="${this.later.size ? 'restart' : 'reload'}" ${disabled}>${this.later.size ? 'Review saved items' : 'Check for new items'}</button></div>`}
      <div class="review-controls">${item && !this.loading ? `<div class="review-actions" role="group" aria-label="Review decision">
        <button class="review-action review-later" data-review="later" ${disabled}>${icon('later')}<span>Later</span></button>
        <button class="review-action review-edit" data-review="edit" ${disabled}>${icon('edit')}<span>Edit</span></button>
        <button class="review-action review-keep" data-review="keep" ${disabled}>${icon('keep')}<span>Keep${purchaseList(item).length > 1 ? ` ${Math.min(purchaseList(item).length, 200)}` : ''}</span></button>
      </div><p class="review-hint">Swipe left for Later · Swipe right to Keep</p>` : ''}
      <div class="review-secondary"><button data-review="undo" ${disabled || !last || last.undoUnavailable ? 'disabled' : ''}>${icon('undo')} Undo</button><span role="status" aria-live="polite">${esc(lastMessage)}</span>${item && !this.loading ? `<div class="review-secondary-actions"><button data-review="archive" ${disabled}>${icon('archive')} Archive${purchaseList(item).length > 1 ? ` ${Math.min(purchaseList(item).length, 200)}` : ''}</button>${this.sample ? '' : `<button data-review="delete" aria-label="Delete ${purchaseList(item).length > 1 ? 'purchase' : 'item'}" ${disabled}>${icon('delete')} Delete</button>`}</div>` : '<span></span>'}</div>
      ${item && !this.loading ? `<p class="review-scope">${purchaseList(item).length > 1 ? `Keep and Archive apply to ${Math.min(purchaseList(item).length, 200)} inbox purchases.` : 'Keep moves this purchase to your collection.'} Later leaves it in the inbox.</p>` : ''}
      </div>
    </section>`;
    if (focus && !document.querySelector('dialog[open]')) this.root.querySelector('[data-review=keep], [data-review=restart], [data-review=reload]')?.focus({ preventScroll: true });
  }

  card(item) {
    const d = item.data;
    const purchases = purchaseList(item);
    const recipient = purchase => purchase.purchaseFor?.kind === 'other' ? (purchase.purchaseFor.recipient || 'Someone else') : 'Me';
    const unique = (values, fallback) => new Set(values).size > 1 ? fallback : values[0];
    const seller = unique(purchases.map(purchase => purchase.seller || 'Not recorded'), 'Multiple stores');
    const place = unique(purchases.map(purchase => this.place(purchase.locationId)), 'Multiple places');
    const forWhom = unique(purchases.map(recipient), 'Recipients vary');
    const missing = [!item.photo_id && !item.art && 'photo', !d.locationId && 'place', !d.purchaseDate && 'date', d.priceMinor === null && 'price'].filter(Boolean);
    return `<div class="review-stack"><article class="review-card" tabindex="0" aria-labelledby="review-name">
      <div class="review-photo">${item.art ? `<img src="/art/${esc(item.art)}.svg" alt="${esc(d.name)}" draggable="false">` : item.photo_id ? `<img src="/api/files/${esc(item.photo_id)}" alt="${esc(d.name)}" draggable="false">` : `<div class="review-no-photo">${icon('camera')}<span>No photo yet</span><button data-review="edit" ${this.busy ? 'disabled' : ''}>Add a photo</button></div>`}
        <span class="review-count">${purchases.length > 1 ? `${purchases.length} purchases` : '1 purchase'}</span>
        <span class="review-stamp review-stamp-keep" aria-hidden="true">KEEP</span><span class="review-stamp review-stamp-later" aria-hidden="true">LATER</span>
      </div>
      <div class="review-info"><div class="review-product-line"><span>${esc([d.brand, d.model].filter(Boolean).join(' · ') || d.tags[0] || 'YOUR PURCHASE')}</span><span>${esc(this.price(item))}</span></div>
        <h2 id="review-name">${esc(d.name)}</h2>
        <dl class="review-facts"><div><dt>Bought from</dt><dd>${esc(seller)}</dd></div><div><dt>${purchases.length > 1 ? 'Latest purchase' : 'Purchased'}</dt><dd>${esc(this.date(d.purchaseDate))}</dd></div><div><dt>Place</dt><dd>${esc(place)}</dd></div><div><dt>Bought for</dt><dd>${esc(forWhom)}</dd></div></dl>
        <div class="review-card-footer"><span>${missing.length ? `Missing ${missing.join(', ')}` : 'Ready to review'}</span><button data-review="details" ${this.busy ? 'disabled' : ''}>View details <span aria-hidden="true">↗</span></button></div>
      </div>
    </article></div>`;
  }

  async animate(direction) {
    const card = this.root.querySelector('.review-card');
    if (!this.active() || !card || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const sign = direction === 'right' ? 1 : -1;
    const animation = card.animate([
      { transform: 'translateX(0) rotate(0)', opacity: 1 },
      { transform: `translateX(${sign * 100}px) rotate(${sign * 9}deg)`, opacity: 0 },
    ], { duration: 180, easing: 'ease-in', fill: 'forwards' });
    await animation.finished.catch(() => {});
  }

  dragStart(event) {
    if (this.busy || this.loading || !this.active() || !event.isPrimary || event.button !== 0) return;
    const card = event.target.closest('.review-card');
    if (!card || event.target.closest('button,a') || document.querySelector('dialog[open]')) return;
    this.drag = { card, id: event.pointerId, x: event.clientX, y: event.clientY, delta: 0, horizontal: false };
    card.setPointerCapture(event.pointerId);
  }

  dragMove(event) {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.id) return;
    const x = event.clientX - drag.x, y = event.clientY - drag.y;
    if (!drag.horizontal) {
      if (Math.abs(y) > 12 && Math.abs(y) > Math.abs(x)) { this.resetDrag(); return; }
      if (Math.abs(x) < 10 || Math.abs(x) < Math.abs(y) * 1.3) return;
      drag.horizontal = true;
      drag.card.classList.add('dragging');
    }
    drag.delta = x;
    drag.card.style.transform = `translateX(${x}px) rotate(${x / 24}deg)`;
    drag.card.querySelector('.review-stamp-keep').style.opacity = String(Math.max(0, Math.min(x / 90, 1)));
    drag.card.querySelector('.review-stamp-later').style.opacity = String(Math.max(0, Math.min(-x / 90, 1)));
  }

  dragEnd(event) {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.id) return;
    const threshold = Math.min(100, drag.card.clientWidth * .25);
    const action = drag.horizontal && Math.abs(drag.delta) >= threshold ? drag.delta > 0 ? 'keep' : 'later' : null;
    this.resetDrag();
    if (action) this.handle(action);
  }

  resetDrag() {
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;
    drag.card.classList.remove('dragging');
    drag.card.style.transform = '';
    drag.card.querySelectorAll('.review-stamp').forEach(stamp => stamp.style.opacity = '');
    if (drag.card.hasPointerCapture(drag.id)) drag.card.releasePointerCapture(drag.id);
  }
}
