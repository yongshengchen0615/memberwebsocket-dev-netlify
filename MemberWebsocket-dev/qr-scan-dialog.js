(() => {
  'use strict';
  // Presentation only. Scanner callers remain responsible for validating a QR value
  // and must never trigger a business transaction from the decoded payload.
  let active = null;
  function close(panel) {
    if (panel && active && active.panel !== panel) return;
    const current = active;
    if (!current) return;
    active = null;
    try { current.stop?.(); } finally {
    current.panel.hidden = true;
    if (current.next && current.next.parentNode === current.parent) {
      current.parent.insertBefore(current.panel, current.next);
    } else {
      current.parent.append(current.panel);
    }
    current.overlay.remove();
    document.body.style.overflow = current.originalOverflow;
    if (current.opener?.isConnected && current.opener.getClientRects().length) {
      current.opener.focus({ preventScroll: true });
    }
    }
  }
  function open(panel, { title = '掃描 QR Code', opener = document.activeElement, start, stop, closeLabel = '關閉 QR 掃描視窗' } = {}) {
    if (!panel || typeof start !== 'function' || typeof stop !== 'function') return false;
    close();
    window.dispatchEvent(new Event('qr-scan-dialog:opening'));
    const overlay = document.createElement('div');
    overlay.className = 'qr-scan-dialog-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', title);
    overlay.tabIndex = -1;
    const card = document.createElement('section');
    card.className = 'qr-scan-dialog-card';
    const heading = document.createElement('div');
    heading.className = 'qr-scan-dialog-heading';
    const label = document.createElement('h2');
    label.textContent = title;
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'qr-scan-dialog-close';
    closeButton.textContent = '關閉';
    closeButton.setAttribute('aria-label', closeLabel);
    heading.append(label, closeButton);
    const originalParent = panel.parentNode;
    const originalNext = panel.nextSibling;
    card.append(heading, panel);
    overlay.append(card);
    active = {
      overlay, panel, opener, stop,
      parent: originalParent, next: originalNext,
      originalOverflow: document.body.style.overflow
    };
    panel.hidden = false;
    document.body.append(overlay);
    document.body.style.overflow = 'hidden';
    closeButton.addEventListener('click', () => close());
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close();
    });
    closeButton.focus({ preventScroll: true });
    Promise.resolve().then(() => {
      if (active?.overlay === overlay && !document.hidden) start();
    });
    return true;
  }
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !active) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    close();
  }, true);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) close();
  });
  window.addEventListener('pagehide', () => close());
  window.addEventListener('member-system:session-revoked', () => close());
  window.addEventListener('member:access-ended', () => close());
  window.addEventListener('booking:receipt-dialog-opening', () => close());
  window.QRScanDialog = { open, close, isOpen: panel => Boolean(active && (!panel || panel === active.panel)) };
  window.MemberPanelDialog = {
    open: (panel, options = {}) => open(panel, {
      start: () => {}, stop: () => {}, closeLabel: '關閉視窗', ...options
    }), close, isOpen: panel => Boolean(active && (!panel || panel === active.panel))
  };
  let qrGeneration = 0;
  window.QRDisplayDialog = {
    show({ title = '會員 QR Code', memberCode, value = memberCode, opener = document.activeElement } = {}) {
      const code = String(memberCode || '').trim().toUpperCase();
      if (!/^[A-Z0-9_-]{4,40}$/.test(code)) return false;
      close();
      let panel = document.getElementById('qrDisplayPanel');
      if (!panel) {
        panel = document.createElement('section'); panel.id = 'qrDisplayPanel';
        panel.className = 'qr-display-panel'; panel.hidden = true;
        document.body.append(panel);
      }
      panel.replaceChildren();
      const canvas = document.createElement('canvas');
      canvas.setAttribute('aria-label', title); canvas.hidden = true;
      const text = document.createElement('strong'); text.textContent = code;
      const status = document.createElement('p'); status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite'); status.textContent = '正在產生 QR Code…';
      const copy = document.createElement('button'); copy.type = 'button';
      copy.className = 'qr-scan-dialog-close'; copy.textContent = '複製會員編號';
      const current = ++qrGeneration;
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(code); if (current === qrGeneration) status.textContent = '會員編號已複製。'; }
        catch { if (current === qrGeneration) status.textContent = '無法複製，請使用畫面上的會員編號。'; }
      });
      panel.append(canvas, text, copy, status);
      return open(panel, { title, opener, closeLabel: '關閉 QR Code 視窗',
        stop: () => { qrGeneration++; canvas.hidden = true; },
        start: async () => {
          try {
            if (!window.FriendQRCode?.toCanvas) throw new Error('QR 元件未載入');
            await window.FriendQRCode.toCanvas(canvas, String(value), { width: 256, margin: 4 });
            if (current !== qrGeneration) return;
            canvas.hidden = false; status.textContent = 'QR 只用於會員識別；操作仍需確認。';
          } catch {
            if (current === qrGeneration) status.textContent = 'QR Code 暫時無法顯示，請關閉重試或使用會員編號。';
          }
        }
      });
    }, close: () => close(document.getElementById('qrDisplayPanel'))
  };
})();
