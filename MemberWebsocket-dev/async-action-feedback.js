/* Explicit user actions only; background sync must not open blocking Loading. */
(() => {
  'use strict';
  const active = new Map();
  const originalInert = new Map();
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

  // Inert preserves the previous state of every sibling, including modal UI.
  function lockBackground() {
    for (const node of document.body.children || []) {
      if (node === banner || originalInert.has(node)) continue;
      originalInert.set(node,Boolean(node.inert));
      node.inert = true;
    }
  }
  function unlockBackground() {
    for (const [node,wasInert] of originalInert) node.inert = wasInert;
    originalInert.clear();
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
    if (busy) lockBackground();
    else unlockBackground();
    banner.hidden = !busy;
    label.textContent = busy ? Array.from(active.values()).at(-1) : '';
  }
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
