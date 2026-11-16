import { escapeHtml as esc } from './text.js';

export class ItemSharing {
  constructor({ read, toast, resize }) {
    this.read = read; this.toast = toast; this.resize = resize;
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'share-dialog'; this.dialog.setAttribute('aria-labelledby', 'share-title');
    document.body.append(this.dialog);
    this.dialog.addEventListener('click', event => this.click(event));
    this.dialog.addEventListener('submit', event => { event.preventDefault(); this.publish().catch(error => this.error(error)); });
    this.dialog.addEventListener('input', () => this.schedulePreview());
    this.dialog.addEventListener('change', () => this.schedulePreview());
    this.dialog.addEventListener('cancel', event => { if (this.busy) event.preventDefault(); });
    this.dialog.addEventListener('close', () => { clearTimeout(this.timer); this.previewId++; });
    this.previewId = 0;
  }

  async open(item) {
    if (this.busy) { this.toast('Wait for the share request to finish.'); return; }
    this.item = item; this.share = null; this.busy = false;
    this.dialog.innerHTML = '<div class="dialog-heading"><h2 id="share-title">Share this item</h2><button class="icon-btn" data-share-action="close" aria-label="Close sharing">×</button></div><p class="share-loading">Loading sharing settings…</p>';
    this.dialog.showModal();
    try {
      const result = await this.read(`/api/items/${item.id}/share`);
      if (!this.dialog.open || this.item.id !== item.id) return;
      this.share = result.share; this.render();
      if (!this.share) await this.preview();
    } catch (error) { this.error(error); }
  }

  render() {
    const d = this.item.data;
    const error = '<div id="share-error" class="error-message" role="alert" tabindex="-1" hidden></div>';
    const photos = this.item.attachments.filter(file => file.kind === 'photo');
    const options = [['brand', 'Brand', d.brand], ['model', 'Model', d.model], ['price', 'Price paid', d.priceMinor === null ? '' : new Intl.NumberFormat('en-US', { style: 'currency', currency: d.currency }).format(d.priceMinor / 100)], ['seller', 'Store', d.seller], ['purchaseDate', 'Purchase date', d.purchaseDate], ['productUrl', 'Product link', d.productUrl], ['tags', 'Tags', d.tags.join(', ')]];
    this.dialog.innerHTML = `<div class="dialog-heading"><div><p class="share-eyebrow">A PAGE FOR ONE ITEM</p><h2 id="share-title">Share this item</h2></div><button class="icon-btn" data-share-action="close" aria-label="Close sharing">×</button></div>${this.share ? error : ''}${this.share ? this.activePage() : `<form id="share-form"><div class="share-workspace"><div class="share-settings"><p class="share-intro">Choose what visitors can see.</p><p class="share-access-note">Anyone with this link can view or save the page.</p><label class="form-field">Name<span class="share-item-name">${esc(d.name)}</span></label><fieldset class="share-fields"><legend>Include on the page</legend>${options.filter(([, , value]) => value).map(([key, label, value]) => `<label class="share-option"><input type="checkbox" name="fields" value="${key}" ${['brand', 'model'].includes(key) ? 'checked' : ''}><span><strong>${label}</strong><small>${esc(value)}</small></span></label>`).join('')}</fieldset><label class="form-field">Photo<select name="photoId"><option value="">No photo</option>${photos.map((photo, index) => `<option value="${esc(photo.id)}" ${index === 0 ? 'selected' : ''}>Photo ${index + 1}</option>`).join('')}</select></label><label class="form-field">Public description<textarea name="description" maxlength="2000" rows="4" placeholder="Write a note for this page…"></textarea></label><label class="form-field">Link expires<select name="expiry"><option value="7">In 7 days</option><option value="30" selected>In 30 days</option><option value="90">In 90 days</option><option value="">No expiry</option></select></label><p class="share-private-note">Private notes, receipts, serial numbers, people, and locations stay hidden.</p></div><div class="share-preview-panel"><div class="share-preview-heading"><span>PAGE PREVIEW</span><span id="share-preview-status" role="status">Loading…</span></div><iframe id="share-preview" title="Public item page preview" sandbox="allow-same-origin"></iframe></div></div><div class="share-form-footer">${error}<p id="share-submit-status" role="status">You can revoke the link at any time.</p><button class="button primary" type="submit">Create share link <span aria-hidden="true">↗</span></button></div></form>`}`;
  }

  activePage() {
    return `<div class="share-active"><div class="share-live-icon" aria-hidden="true">${this.share.expired ? '⌛' : '↗'}</div><h3>${this.share.expired ? 'This link has expired' : 'Your page is ready'}</h3><p>${esc(this.share.data.name)}</p><label class="form-field">Share link<input id="share-url" readonly value="${esc(this.share.url)}"></label><div class="share-link-actions"><button class="button primary" data-share-action="copy" ${this.share.expired ? 'disabled' : ''}>Copy link</button><a class="button secondary" href="${esc(this.share.url)}" target="_blank" rel="noopener noreferrer">Open page ↗</a></div><p class="share-expiry">${this.share.expiresAt ? `Expires ${new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(new Date(this.share.expiresAt))}` : 'No expiry'} · A saved copy of selected details</p><p class="share-access-note">Anyone with this link can view or save the page.</p><div class="share-revoke"><p>Revoke this link to stop access or create an updated page.</p><button class="button danger-outline" data-share-action="revoke">Revoke link</button></div></div>`;
  }

  input() {
    const form = new FormData(this.dialog.querySelector('#share-form'));
    return { revision: this.item.revision, fields: form.getAll('fields'), photoId: form.get('photoId') || null, description: form.get('description'), expiresAt: form.get('expiry') ? new Date(Date.now() + Number(form.get('expiry')) * 86400000).toISOString() : null };
  }

  schedulePreview() {
    if (this.share || this.busy) return;
    clearTimeout(this.timer); this.previewId++;
    const status = this.dialog.querySelector('#share-preview-status'); if (status) status.textContent = 'Updating…';
    this.timer = setTimeout(() => this.preview().catch(error => this.error(error)), 250);
  }

  async preview() {
    const id = ++this.previewId;
    const result = await this.read(`/api/items/${this.item.id}/share/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(this.input()) });
    if (id !== this.previewId || !this.dialog.open) return;
    this.dialog.querySelector('#share-preview').srcdoc = result.html;
    this.dialog.querySelector('#share-preview-status').textContent = 'Only these details will appear';
    this.dialog.querySelector('#share-error').hidden = true;
  }

  async publish() {
    if (this.busy) return;
    const form = this.dialog.querySelector('#share-form');
    const data = this.input();
    const item = this.item;
    this.busy = true; clearTimeout(this.timer); this.previewId++;
    this.dialog.querySelector('#share-error').hidden = true;
    const button = form.querySelector('[type=submit]'), label = button.innerHTML;
    const status = this.dialog.querySelector('#share-submit-status'), statusText = status.textContent;
    button.textContent = 'Creating link…';
    status.textContent = data.photoId ? 'Preparing photo…' : 'Creating your page…';
    for (const field of form.elements) field.disabled = true;
    try {
      let body, headers;
      if (data.photoId) {
        const response = await fetch(`/api/files/${encodeURIComponent(data.photoId)}`);
        if (!response.ok) throw new Error('Could not load the selected photo.');
        const source = await response.blob();
        const photo = await this.resize(new File([source], 'shared-photo', { type: source.type }));
        body = new FormData(); body.set('data', JSON.stringify(data)); body.set('photo', photo);
      } else { body = JSON.stringify(data); headers = { 'Content-Type': 'application/json' }; }
      status.textContent = 'Creating your page…';
      await this.read(`/api/items/${item.id}/share`, { method: 'POST', headers, body });
      this.share = (await this.read(`/api/items/${item.id}/share`)).share;
      this.previewId++; this.render(); this.toast('Share page created.');
    } finally {
      this.busy = false; button.innerHTML = label; status.textContent = statusText;
      for (const field of form.elements) field.disabled = false;
    }
  }

  async click(event) {
    const button = event.target.closest('[data-share-action]');
    if (!button) return;
    const action = button.dataset.shareAction;
    try {
      if (action === 'close') { if (!this.busy) this.dialog.close(); return; }
      if (action === 'copy') {
        try { await navigator.clipboard.writeText(this.share.url); this.toast('Share link copied.'); }
        catch { const input = this.dialog.querySelector('#share-url'); input.focus(); input.select(); this.toast('Copy the selected link.'); }
      }
      if (action === 'revoke') {
        if (this.busy) return;
        this.busy = true; button.disabled = true;
        try {
          await this.read(`/api/items/${this.item.id}/share`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: this.share.id }) });
          this.share = null; this.render(); await this.preview(); this.toast('Share link revoked.');
        } finally { this.busy = false; button.disabled = false; }
      }
    } catch (error) { this.error(error); }
  }

  error(error) {
    let element = this.dialog.querySelector('#share-error');
    if (!element) { element = document.createElement('p'); element.id = 'share-error'; element.className = 'error-message'; element.setAttribute('role', 'alert'); this.dialog.append(element); }
    element.textContent = error.message; element.hidden = false;
    (element.closest('.share-form-footer') || element).scrollIntoView({ block: 'end' }); element.focus({ preventScroll: true });
  }
}
