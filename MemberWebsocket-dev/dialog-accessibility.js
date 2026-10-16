(() => {
  'use strict';
  const selector = '[role="dialog"][aria-modal="true"]';
  const controls = 'button, a[href], input, select, textarea, [tabindex]';
  const openers = new Map();
  let previous = [];

  function visible(element) {
    return element.getClientRects().length > 0 &&
      !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
      window.getComputedStyle(element).visibility !== 'hidden';
  }

  function dialogs() {
    return Array.from(document.querySelectorAll(selector)).filter(visible)
      .sort((a, b) => (Number.parseInt(window.getComputedStyle(a).zIndex, 10) || 0) -
        (Number.parseInt(window.getComputedStyle(b).zIndex, 10) || 0));
  }

  function focusDialog(dialog) {
    // 聚焦容器而非輸入框，避免手機一開彈窗就彈出鍵盤。
    if (!dialog.hasAttribute('tabindex')) dialog.tabIndex = -1;
    dialog.focus({ preventScroll: true });
  }

  function syncDialogs() {
    const current = dialogs();
    const top = current[current.length - 1];
    for (const dialog of current) {
      if (!previous.includes(dialog) && !dialog.contains(document.activeElement)) {
        openers.set(dialog, document.activeElement);
      }
    }
    for (const dialog of previous.slice().reverse()) {
      if (current.includes(dialog)) continue;
      const opener = openers.get(dialog);
      openers.delete(dialog);
      if (opener && opener.isConnected && visible(opener) &&
          (!top || top.contains(opener)) &&
          (document.activeElement === document.body || dialog.contains(document.activeElement))) {
        opener.focus({ preventScroll: true });
      }
    }
    if (top && !previous.includes(top) && !top.contains(document.activeElement)) focusDialog(top);
    previous = current;
  }

  // 使用捕獲階段，讓預約頁與其他頁共用同一個最上層彈窗焦點規則。
  // Escape 關閉及送出中的鎖定仍由原功能處理，避免中斷交易。
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab' || event.defaultPrevented) return;
    const list = dialogs();
    const dialog = list[list.length - 1];
    if (!dialog) return;
    const items = Array.from(dialog.querySelectorAll(controls))
      .filter((element) => !element.matches(':disabled') && element.tabIndex >= 0 && visible(element))
      .sort((a, b) => (a.tabIndex || Infinity) - (b.tabIndex || Infinity));
    const first = items[0], last = items[items.length - 1];
    if (!first) { event.preventDefault(); focusDialog(dialog); return; }
    const active = document.activeElement;
    if (!items.includes(active) || (event.shiftKey ? active === first : active === last)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  }, true);

  const observer = new MutationObserver(syncDialogs);
  const observe = () => observer.observe(document.body, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ['class', 'hidden', 'aria-hidden'],
  });
  window.addEventListener('pagehide', () => observer.disconnect());
  window.addEventListener('pageshow', () => { observe(); syncDialogs(); });
  observe();
  syncDialogs();
})();
