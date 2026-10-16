(() => {
  'use strict';

  const FIXED_STATUS_VALUES = new Set(['active', 'draft', 'archived']);
  const OLD_DELETE_CONFIRM = '已發出的票券與使用紀錄會保留。';
  const NEW_DELETE_CONFIRM = '尚未使用的會員票券會立即失效；已使用紀錄會保留。';
  const OLD_DELETE_SUCCESS = '固定票券已刪除；已發出的會員票券與歷史紀錄仍保留。';
  const NEW_DELETE_SUCCESS = '固定票券已刪除；未使用的會員票券已立即失效，會員端會自動同步。已使用紀錄仍保留。';

  function ready(callback) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', callback, { once: true });
    else callback();
  }

  function openEventTicketEditor() {
    const form = document.getElementById('eventTicketForm');
    const modal = form?.closest('.editor-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    const focusTarget = modal.querySelector('input:not([type="hidden"]), select, textarea, button:not(.editor-modal-close)');
    if (focusTarget instanceof HTMLElement) focusTarget.focus();
  }

  ready(() => {
    const type = document.getElementById('eventTicketType');
    const status = document.getElementById('eventTicketStatus');
    const list = document.getElementById('eventTicketListItems');
    const deleteButton = document.getElementById('deleteEventTicketButton');
    const message = document.getElementById('eventTicketFormMessage');
    if (!type || !status || !list || !deleteButton || !message) return;

    type.addEventListener('change', () => {
      if (type.value === 'fixed' && !FIXED_STATUS_VALUES.has(status.value)) status.value = 'active';
    });

    list.addEventListener('click', (event) => {
      const fixed = event.target instanceof Element ? event.target.closest('[data-fixed-ticket-id]') : null;
      if (!fixed) return;
      window.setTimeout(openEventTicketEditor, 0);
    }, true);

    deleteButton.addEventListener('click', () => {
      if (type.value !== 'fixed') return;
      const originalConfirm = window.confirm;
      const rewrittenConfirm = (text) => originalConfirm.call(window, String(text || '').replace(OLD_DELETE_CONFIRM, NEW_DELETE_CONFIRM));
      window.confirm = rewrittenConfirm;
      window.queueMicrotask(() => {
        if (window.confirm === rewrittenConfirm) window.confirm = originalConfirm;
      });
    }, true);

    const rewriteDeleteSuccess = () => {
      if (message.textContent?.trim() === OLD_DELETE_SUCCESS) message.textContent = NEW_DELETE_SUCCESS;
    };
    new MutationObserver(rewriteDeleteSuccess).observe(message, { childList: true, characterData: true, subtree: true });
    rewriteDeleteSuccess();
  });
})();
