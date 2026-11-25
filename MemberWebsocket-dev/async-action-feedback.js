/* Explicit user actions only; background sync must not open blocking Loading. */
(() => {
  'use strict';
  const active = new Map();
  // Track only the inert flags this overlay sets. Existing modal ownership is untouched.
  const ownedInert = new Set();
  const banner = document.createElement('div');
  banner.className = 'async-action-feedback';
  banner.setAttribute('role','status');
  banner.setAttribute('aria-live','polite');
  banner.setAttribute('aria-atomic','true');
  banner.hidden = true;
  const spinner = document.createElement('span');
  spinner.className = 'async-action-feedback-spinner';
  spinner.setAttribute('aria-hidden','true');
  const label = document.createElement('span');
  label.className = 'async-action-feedback-label';
  const hint = document.createElement('span');
  hint.className = 'async-action-feedback-hint';
  hint.textContent = '請勿重複點擊，系統正在等待後端回覆。';
  banner.append(spinner,label,hint);
  document.body.append(banner);

  // Native showModal() dialogs occupy the browser top layer, above all body
  // z-index values. Put the status inside that active accessibility subtree.
  function placeBanner() {
    let modal = null;
    try { modal = document.querySelector?.('dialog:modal') || null; }
    catch { /* Graceful fallback for browsers without :modal support. */ }
    if (modal) {
      if (banner.parentNode !== modal) modal.append(banner);
    } else if (banner.parentNode && banner.parentNode !== document.body) {
      document.body.append(banner);
    }
  }
  function lockBackground() {
    for (const node of document.body.children || []) {
      // A modal can make its app shell inert before the upload starts and
      // restore it before the pending request's finally. Never take ownership
      // of such an existing inert flag, nor inert an ancestor of our banner.
      if (node === banner || node.contains?.(banner) || ownedInert.has(node) || node.inert) continue;
      ownedInert.add(node);
      node.inert = true;
    }
  }
  function unlockBackground() {
    for (const node of ownedInert) node.inert = false;
    ownedInert.clear();
  }
  // Capture guards also protect controls inserted after the operation started.
  function guard(event) {
    if (!active.size || event.target === banner || banner.contains?.(event.target)) return;
    if (event.cancelable !== false) event.preventDefault();
    event.stopImmediatePropagation?.();
  }
  for (const type of ['click','submit','keydown']) document.addEventListener?.(type,guard,true);

  function render() {
    const busy = active.size > 0;
    if (busy) {
      placeBanner();
      lockBackground();
    } else {
      unlockBackground();
      // Return the hidden shared status to body; the next action may not
      // originate from the same modal and must not inherit its top-layer host.
      if (banner.parentNode && banner.parentNode !== document.body) document.body.append(banner);
    }
    banner.hidden = !busy;
    label.textContent = busy ? Array.from(active.values()).at(-1) : '';
  }
  // A native dialog may close programmatically while another write is pending.
  // Reposition the visible overlay before the next interaction.
  document.addEventListener?.('close', () => { if (active.size) render(); }, true);
  function begin(message = '正在更新資料…') {
    const key = Symbol('async-action');
    active.set(key,String(message));
    render();
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      active.delete(key);
      render();
    };
  }
  async function track(message,operation) {
    const finish = begin(message);
    try { return await operation(); }
    finally { finish(); }
  }
  window.AsyncActionFeedback = Object.freeze({begin,track});
})();
