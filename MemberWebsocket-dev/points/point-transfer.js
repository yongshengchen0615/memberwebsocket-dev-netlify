(() => {
  'use strict';

  const state = {
    requestId: '',
    pending: null,
    fingerprint: '',
    receiver: null,
    receiverGeneration: 0,
    friendGeneration: 0,
    busy: false,
    activeCardId: '',
    activeCardTitle: '',
    memberCode: '',
    options: new Map(),
    loaded: false,
    refreshPromise: null,
    refreshQueued: false,
    scanner: null
  };

  function newRequestId() {
    const value = window.crypto?.randomUUID?.() || String(Date.now()) + Math.random().toString(36).slice(2);
    return 'pt-' + value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 90);
  }

  function session() {
    return window.MemberSystem?.getSession?.('points') || null;
  }

  function setMessage(message, error = false) {
    const target = document.getElementById('pointTransferMessage');
    if (!target) return;
    target.textContent = String(message || '');
    target.classList.toggle('hidden', !message);
    target.classList.toggle('error', Boolean(error));
  }

  function pendingKey() { return 'point-transfer-pending:v1:' + state.memberCode; }
  function savePending(value) {
    state.pending = value;
    try {
      if (value) window.sessionStorage.setItem(pendingKey(), JSON.stringify(value));
      else window.sessionStorage.removeItem(pendingKey());
    } catch (_) { /* In-memory idempotency still covers this tab. */ }
  }
  function restorePending() {
    state.pending = null;
    if (!state.memberCode) return;
    try {
      const saved = JSON.parse(window.sessionStorage.getItem(pendingKey()) || 'null');
      if (saved && /^[A-Za-z0-9_-]{8,120}$/.test(saved.requestId) && typeof saved.cardId === 'string' && /^[A-Za-z0-9_-]{4,40}$/.test(saved.memberCode) && Number.isSafeInteger(saved.amount) && saved.amount > 0) state.pending = saved;
    } catch (_) { /* Never reuse malformed saved instructions. */ }
  }
  function lockFields() {
    const pending = Boolean(state.pending);
    for (const id of ['pointTransferMemberCode','pointTransferAmount','pointTransferLookup','pointTransferChooseFriend','pointTransferScanQr','pointTransferUseFriend','pointTransferFriendSelect']) {
      const element = document.getElementById(id);
      if (element) element.disabled = state.busy || pending;
    }
  }
  function clearReceiver() {
    if (state.pending) return;
    state.receiverGeneration += 1;
    state.receiver = null;
    state.requestId = '';
    state.fingerprint = '';
    renderReceiver();
  }

  function renderReceiver() {
    const target = document.getElementById('pointTransferReceiver');
    if (!target) return;
    if (!state.receiver) {
      target.textContent = '';
      target.classList.add('hidden');
      return;
    }
    target.textContent = `收件會員：${state.receiver.displayName}（${state.receiver.memberCode}）`;
    target.classList.remove('hidden');
  }

  function ensureModal() {
    let modal = document.getElementById('pointTransferModal');
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = 'pointTransferModal';
    modal.className = 'point-transfer-modal hidden';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'pointTransferTitle');
    modal.innerHTML = `
      <section class="point-transfer-card">
        <div class="point-transfer-heading">
          <div>
            <p class="point-transfer-kicker">Member transfer</p>
            <h2 id="pointTransferTitle">點數轉贈</h2>
            <p id="pointTransferCardSummary" class="point-transfer-card-summary">目前集點卡</p>
          </div>
          <button id="pointTransferClose" class="point-transfer-close" type="button" aria-label="關閉點數轉贈">×</button>
        </div>
        <section class="point-transfer-own-code" aria-label="我的會員編號">
          <div class="point-transfer-own-code-text">
            <span>我的會員編號</span>
            <strong id="pointTransferOwnMemberCode">讀取中…</strong>
          </div>
        </section>
        <form id="pointTransferForm" class="point-transfer-form">
          <input id="pointTransferCard" type="hidden">
          <label>
            <span>收件會員編號</span>
            <input id="pointTransferMemberCode" type="text" maxlength="40" autocomplete="off" placeholder="例如 MXXXXXXXXXX" required>
          </label>
          <div class="point-transfer-recipient-actions">
            <button id="pointTransferChooseFriend" class="point-transfer-secondary-button" type="button">選擇好友</button>
            <button id="pointTransferScanQr" class="point-transfer-secondary-button" type="button">掃描會員 QR Code</button>
          </div>
          <div id="pointTransferFriendPicker" class="point-transfer-friend-picker" hidden>
            <label for="pointTransferFriendSelect">已接受的好友</label>
            <select id="pointTransferFriendSelect"><option value="">請先載入好友</option></select>
            <button id="pointTransferUseFriend" class="point-transfer-secondary-button" type="button">使用選取的好友</button>
            <p id="pointTransferFriendStatus" role="status" aria-live="polite"></p>
            <button id="pointTransferFriendCancel" class="point-transfer-secondary-button" type="button">取消</button>
          </div>
          <section id="pointTransferQrPanel" hidden>
            <video id="pointTransferQrVideo" autoplay muted playsinline aria-label="收件者 QR 掃描畫面"></video>
            <p id="pointTransferQrStatus" role="status" aria-live="polite">掃描不會直接轉贈點數。</p>
            <button id="pointTransferQrImageButton" class="point-transfer-secondary-button" type="button">選擇 QR 圖片</button>
            <input id="pointTransferQrFile" type="file" accept="image/png,image/jpeg,image/webp" hidden>
            <button id="pointTransferQrClose" class="point-transfer-secondary-button" type="button">關閉相機</button>
          </section>
          <button id="pointTransferLookup" class="point-transfer-secondary-button" type="button">確認收件會員</button>
          <p id="pointTransferReceiver" class="point-transfer-receiver hidden"></p>
          <label>
            <span>轉贈點數</span>
            <input id="pointTransferAmount" type="number" min="1" step="1" inputmode="numeric" required>
          </label>
          <p id="pointTransferBalanceHint" class="point-transfer-balance-hint"></p>
          <button id="pointTransferSubmit" class="point-transfer-submit" type="submit">確認轉贈</button>
          <p id="pointTransferMessage" class="point-transfer-message hidden" role="status" aria-live="polite"></p>
        </form>
      </section>`;

    document.body.append(modal);
    modal.querySelector('#pointTransferClose').addEventListener('click', closeModal);
    modal.addEventListener('click', (event) => {
      if (event.target === modal && !state.busy) closeModal();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !modal.classList.contains('hidden') && !state.busy) closeModal();
    });

    const code = modal.querySelector('#pointTransferMemberCode');
    const amount = modal.querySelector('#pointTransferAmount');
    [code, amount].forEach((input) => input.addEventListener('input', clearReceiver));
    modal.querySelector('#pointTransferLookup').addEventListener('click', lookupReceiver);
    modal.querySelector('#pointTransferChooseFriend').addEventListener('click', () => {
      if (state.busy || state.pending) return;
      const picker = document.getElementById('pointTransferFriendPicker');
      if (window.MemberPanelDialog?.open(picker, {title: '選擇轉贈好友', opener: document.getElementById('pointTransferChooseFriend'), stop: () => { state.friendGeneration++; }})) void loadFriendChoices();
    });
    modal.querySelector('#pointTransferFriendCancel').addEventListener('click', () => window.MemberPanelDialog?.close(document.getElementById('pointTransferFriendPicker')));
    modal.querySelector('#pointTransferUseFriend').addEventListener('click', () => {
      if (state.busy || state.pending) return;
      const chosen = document.getElementById('pointTransferFriendSelect').value;
      if (!chosen) return setMessage('請先選擇好友。', true);
      const input = modal.querySelector('#pointTransferMemberCode');
      input.value = chosen;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      window.MemberPanelDialog?.close(document.getElementById('pointTransferFriendPicker'));
      void lookupReceiver();
    });
    modal.querySelector('#pointTransferScanQr').addEventListener('click', openTransferScanner);
    modal.querySelector('#pointTransferQrClose').addEventListener('click', stopTransferScanner);
    modal.querySelector('#pointTransferQrImageButton').addEventListener('click', () => document.getElementById('pointTransferQrFile').click());
    modal.querySelector('#pointTransferQrFile').addEventListener('change', event => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (file) void state.scanner?.readFile(file);
    });
    modal.querySelector('#pointTransferForm').addEventListener('submit', submitTransfer);
    return modal;
  }

  async function loadFriendChoices() {
    const picker = document.getElementById('pointTransferFriendPicker');
    const select = document.getElementById('pointTransferFriendSelect');
    const status = document.getElementById('pointTransferFriendStatus');
    const s = session();
    if (!s || !picker || !select || !status || state.pending) return;
    const currentMember = state.memberCode;
    const generation = ++state.friendGeneration;
    select.disabled = true;
    select.replaceChildren(new Option('請選擇好友', ''));
    status.textContent = '正在載入好友…';
    try {
      const response = await window.MemberSystem.request(s.config, 'points', s.idToken, 'member.friend.list');
      if (generation !== state.friendGeneration || picker.hidden || state.memberCode !== currentMember || !session()) return;
      const friends = (Array.isArray(response?.friends) ? response.friends : []).filter(friend =>
        friend.status === 'accepted' && /^[A-Za-z0-9_-]{4,40}$/.test(String(friend.memberCode || '')) &&
        String(friend.memberCode).toUpperCase() !== currentMember.toUpperCase());
      for (const friend of friends) select.add(new Option(
        String(friend.displayName || '好友') + ' · ' + friend.memberCode, friend.memberCode));
      status.textContent = friends.length ? '選擇好友後仍需確認收件會員及點數。' : '目前沒有已接受的好友，可改用會員編號。';
    } catch (error) {
      if (generation === state.friendGeneration) status.textContent = error?.message || '好友載入失敗，請取消後重試或輸入會員編號。';
    } finally { if (generation === state.friendGeneration) select.disabled = false; }
  }

  function parseTransferQR(raw) {
    const text = String(raw || '').trim();
    let code = text;
    if (text.startsWith('https://') || text.startsWith('http://')) {
      const url = new URL(text);
      const base = new URL('../member/', location.href);
      if (url.origin !== base.origin || url.username || url.password ||
          ![base.pathname, base.pathname + 'index.html'].includes(url.pathname)) {
        throw new Error('不是本站的會員 QR Code。');
      }
      const hash = new URLSearchParams(url.hash.slice(1));
      code = hash.get('friend') || hash.get('reward') || '';
    }
    if (!/^[A-Za-z0-9_-]{4,40}$/.test(code)) throw new Error('請掃描會員 QR Code 或輸入有效會員編號。');
    return code.toUpperCase();
  }

  function stopTransferScanner() {
    window.QRScanDialog?.close(document.getElementById('pointTransferQrPanel'));
    state.scanner?.stop();
  }

  function openTransferScanner() {
    if (state.busy || state.pending) return;
    const panel = document.getElementById('pointTransferQrPanel');
    if (!window.FriendQRScanner?.create || !window.QRScanDialog?.open || !panel) {
      setMessage('無法啟動掃描，請輸入會員編號。', true); return;
    }
    if (!state.scanner) {
      state.scanner = window.FriendQRScanner.create(panel.querySelector('video'), {
        label: '會員', parseValue: parseTransferQR,
        onStatus: message => {
          const status = document.getElementById('pointTransferQrStatus');
          if (status) status.textContent = message;
        },
        onResult: code => {
          stopTransferScanner();
          const input = document.getElementById('pointTransferMemberCode');
          input.value = code;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          setMessage('QR 已辨識，正在確認收件者…');
          void lookupReceiver();
        }
      });
    }
    window.QRScanDialog.open(panel, {
      title: '掃描轉贈收件者', opener: document.getElementById('pointTransferScanQr'),
      start: () => state.scanner.start(), stop: () => state.scanner.stop()
    });
  }

  function updateOwnMemberCode() {
    const output = document.getElementById('pointTransferOwnMemberCode');
    if (output) output.textContent = state.memberCode || '尚未取得會員編號';
    const qrButton = document.getElementById('pointTransferShowOwnQr');
    if (qrButton) qrButton.disabled = !state.memberCode || !session();
  }

  function currentCardId() {
    return String(
      state.activeCardId ||
      document.getElementById('activeCardView')?.dataset.cardId ||
      ''
    );
  }

  function updateOpenButton() {
    const button = document.getElementById('pointTransferButton');
    if (!button) return;
    const cardId = currentCardId();
    const option = state.options.get(cardId);
    const balance = Number(option?.balance || 0);
    button.disabled = !state.pending && (!state.loaded || !cardId || !option || balance <= 0);
    button.title = button.disabled && state.loaded ? '這張集點卡目前沒有可轉贈點數' : '';
  }

  function updateModalBalance() {
    const cardId = document.getElementById('pointTransferCard')?.value;
    const option = state.options.get(cardId);
    const balance = Math.max(0, Number(option?.balance || 0));
    const amount = document.getElementById('pointTransferAmount');
    if (amount) amount.max = state.pending ? '' : String(balance);
    const summary = document.getElementById('pointTransferCardSummary');
    if (summary) summary.textContent = `${option?.title || state.activeCardTitle || '集點卡'}・可轉贈 ${balance} 點${option?.expiresOn ? `・至 ${option.expiresOn}` : ''}`;
    const hint = document.getElementById('pointTransferBalanceHint');
    if (hint) hint.textContent = `本次轉贈會從這張集點卡扣除，最多可轉贈 ${balance} 點。`;
  }

  function openModal() {
    const modal = ensureModal();
    const cardId = state.pending?.cardId || currentCardId();
    const option = state.options.get(cardId);
    if ((!option || Number(option.balance || 0) <= 0) && !state.pending) {
      updateOpenButton();
      return;
    }

    clearReceiver();
    document.getElementById('pointTransferFriendPicker').hidden = true;
    document.getElementById('pointTransferCard').value = cardId;
    document.getElementById('pointTransferMemberCode').value = '';
    document.getElementById('pointTransferAmount').value = '';
    document.getElementById('pointTransferCardSummary').textContent =
      `${option?.title || state.activeCardTitle || '集點卡'}・可轉贈 ${Number(option?.balance || 0)} 點${option?.expiresOn ? `・至 ${option.expiresOn}` : ''}`;
    document.getElementById('pointTransferBalanceHint').textContent =
      state.pending ? '待確認原交易；不會重新扣點。' : `本次轉贈會從這張集點卡扣除，最多可轉贈 ${Number(option?.balance || 0)} 點。`;
    document.getElementById('pointTransferAmount').max = state.pending ? '' : String(Number(option?.balance || 0));
    setMessage('');
    if (state.pending) {
      const { memberCode, amount, requestId } = state.pending;
      document.getElementById('pointTransferMemberCode').value = memberCode;
      document.getElementById('pointTransferAmount').value = String(amount);
      state.receiver = { memberCode, displayName: '原收件會員' };
      state.requestId = requestId;
      state.fingerprint = JSON.stringify([cardId, memberCode, amount]);
      renderReceiver();
      setMessage('前次交易結果尚未確認。再次確認將沿用同一交易識別，不會另建立轉贈。', true);
    }
    lockFields();
    modal.classList.remove('hidden');
    document.body.classList.add('point-transfer-modal-open');
    window.setTimeout(() => document.getElementById('pointTransferMemberCode')?.focus(), 0);
  }

  function closeModal() {
    if (state.busy) return;
    stopTransferScanner();
    window.MemberPanelDialog?.close(document.getElementById('pointTransferFriendPicker'));
    window.QRDisplayDialog?.close();
    document.getElementById('pointTransferModal')?.classList.add('hidden');
    document.body.classList.remove('point-transfer-modal-open');
    clearReceiver();
    setMessage('');
    document.getElementById('pointTransferButton')?.focus();
  }

  async function loadOptions() {
    if (state.refreshPromise) {
      state.refreshQueued = true;
      return state.refreshPromise;
    }

    const s = session();
    if (!s) {
      updateOpenButton();
      return;
    }

    state.refreshPromise = (async () => {
      try {
        const data = await window.MemberSystem.request(s.config, 'points', s.idToken, 'points.transfer.options');
        const cards = Array.isArray(data.cards) ? data.cards : [];
        state.options = new Map(cards.map((card) => [String(card.cardId || ''), {
          cardId: String(card.cardId || ''),
          title: String(card.title || '集點卡'),
          balance: Number(card.balance || 0),
          expiresOn: String(card.expiresOn || '')
        }]));
        state.loaded = true;
        updateOpenButton();
        updateModalBalance();
      } catch (error) {
        state.options = new Map();
        state.loaded = true;
        updateOpenButton();
        updateModalBalance();
        if (!document.getElementById('pointTransferModal')?.classList.contains('hidden')) {
          setMessage(error?.message || '目前無法讀取可轉贈點數。', true);
        }
      } finally {
        state.refreshPromise = null;
        if (state.refreshQueued) {
          state.refreshQueued = false;
          void loadOptions();
        }
      }
    })();

    return state.refreshPromise;
  }

  function syncActiveCard(detail) {
    const cardId = String(detail?.cardId || '');
    const title = String(detail?.title || '');
    const stamps = Math.max(0, Number(detail?.stamps || 0));

    state.activeCardId = cardId;
    state.activeCardTitle = title;

    const current = state.options.get(cardId);
    const transferEligible = detail?.transferEligible !== false;
    if (current) {
      state.options.set(cardId, {
        ...current,
        title: title || current.title,
        balance: stamps,
        expiresOn: String(detail?.expiresOn || current.expiresOn || '')
      });
    } else if (cardId && transferEligible && stamps > 0) {
      state.options.set(cardId, {
        cardId,
        title: title || '集點卡',
        balance: stamps,
        expiresOn: String(detail?.expiresOn || '')
      });
    }
    updateOpenButton();

    // renderCards() is also the endpoint of the points realtime refresh path.
    // Re-fetch transfer eligibility/balance here so the transfer button never
    // requires a full-page reload after an admin grant, redemption, or transfer.
    void loadOptions();
  }

  async function lookupReceiver() {
    if (state.busy || state.pending) return;
    const s = session();
    if (!s) return;
    const memberCode = String(document.getElementById('pointTransferMemberCode').value || '').trim();
    if (!memberCode) return setMessage('請輸入收件會員編號。', true);
    clearReceiver();
    const generation = state.receiverGeneration;
    setMessage('正在確認收件會員…');
    try {
      const receiver = await window.MemberSystem.request(
        s.config,
        'points',
        s.idToken,
        'points.transfer.receiver',
        { memberCode }
      );
      if (generation !== state.receiverGeneration) return;
      state.receiver = receiver;
      renderReceiver();
      setMessage('已確認收件會員，請核對後再送出。');
    } catch (error) {
      if (generation !== state.receiverGeneration) return;
      state.receiver = null;
      renderReceiver();
      setMessage(error?.message || '目前無法確認收件會員。', true);
    }
  }

  async function submitTransfer(event) {
    event.preventDefault();
    if (state.busy) return;

    const s = session();
    if (!s) return;

    const cardId = String(document.getElementById('pointTransferCard').value || '');
    const option = state.options.get(cardId);
    const memberCode = String(document.getElementById('pointTransferMemberCode').value || '').trim();
    const amount = Number(document.getElementById('pointTransferAmount').value);

    if (!option && !state.pending) return setMessage('這張集點卡目前無法轉贈。', true);
    if (!state.receiver || state.receiver.memberCode !== memberCode) return setMessage('請先確認收件會員。', true);
    if (!Number.isSafeInteger(amount) || amount <= 0) return setMessage('請輸入大於 0 的整數點數。', true);
    if (!state.pending && amount > Number(option.balance || 0)) return setMessage('轉贈點數不可超過目前可用點數。', true);

    const fingerprint = JSON.stringify([cardId, memberCode, amount]);
    if (state.fingerprint !== fingerprint) {
      state.requestId = newRequestId();
      state.fingerprint = fingerprint;
    }

    if (!window.confirm(`確定從「${option?.title || '原集點卡'}」轉贈 ${amount} 點給 ${state.receiver.displayName}（${memberCode}）嗎？`)) return;
    savePending({ cardId, memberCode, amount, requestId: state.requestId });

    state.busy = true;
    const submit = document.getElementById('pointTransferSubmit');
    const close = document.getElementById('pointTransferClose');
    submit.disabled = true;
    close.disabled = true;
    const fields = ['pointTransferMemberCode', 'pointTransferAmount', 'pointTransferLookup', 'pointTransferChooseFriend', 'pointTransferScanQr', 'pointTransferUseFriend'].map((id) => document.getElementById(id));
    fields.forEach((field) => { if (field) field.disabled = true; });
    setMessage('正在安全轉贈點數…');

    try {
      const result = await window.MemberSystem.request(
        s.config,
        'points',
        s.idToken,
        'points.transfer.create',
        { cardId, memberCode, amount, requestId: state.requestId }
      );
      setMessage(`轉贈完成。交易編號 ${result.transferId}，目前剩餘 ${result.senderBalance} 點。`);
      savePending(null);
      state.requestId = '';
      state.fingerprint = '';
      state.receiver = null;
      renderReceiver();
      document.getElementById('pointTransferAmount').value = '';
      window.dispatchEvent(new CustomEvent('pointcard:transfer-completed', { detail: { cardId, senderBalance: Number(result.senderBalance || 0) } }));
      const refresh = window.PointCardClient && typeof window.PointCardClient.refresh === 'function'
        ? window.PointCardClient.refresh()
        : Promise.resolve();
      await Promise.allSettled([refresh, loadOptions()]);
    } catch (error) {
      const status = Number(error?.status || 0);
      if (status >= 400 && status < 500 && error?.code !== 'API_RESPONSE_UNCERTAIN') savePending(null);
      setMessage(
        (state.pending && (error?.code === 'API_RESPONSE_UNCERTAIN' || status >= 500 || status === 0))
          ? '結果尚未確認；請保持相同內容再次按「確認轉贈」，系統會沿用同一操作識別，不會重複扣點。'
          : (error?.message || '點數轉贈失敗。'),
        true
      );
    } finally {
      state.busy = false;
      submit.disabled = false;
      close.disabled = false;
      fields.forEach((field) => { if (field) field.disabled = false; });
      lockFields();
    }
  }

  function bind() {
    ensureModal();
    const openButton = document.getElementById('pointTransferButton');
    if (openButton && !openButton.dataset.bound) {
      openButton.dataset.bound = 'true';
      openButton.addEventListener('click', openModal);
    }
    const qrButton = document.getElementById('pointTransferShowOwnQr');
    if (qrButton && !qrButton.dataset.bound) {
      qrButton.dataset.bound = 'true';
      qrButton.addEventListener('click', event => {
        if (!state.memberCode || !session()) return;
        window.QRDisplayDialog?.show({ memberCode: state.memberCode, title: '我的會員 QR Code', opener: event.currentTarget });
      });
    }
    updateOpenButton();
    updateOwnMemberCode();
  }

  window.addEventListener('member-system:session-revoked', stopTransferScanner);
  window.addEventListener('member:access-ended', (event) => {
    stopTransferScanner();
    state.receiverGeneration += 1;
    state.receiver = null;
    if (event.detail?.code === 'MEMBER_REMOVED') savePending(null);
    state.memberCode = '';
    window.QRDisplayDialog?.close();
    updateOwnMemberCode();
    document.getElementById('pointTransferModal')?.classList.add('hidden');
    document.body.classList.remove('point-transfer-modal-open');
  });
  window.addEventListener('pagehide', stopTransferScanner);

  window.addEventListener('pointcard:active-changed', (event) => {
    syncActiveCard(event?.detail);
  });

  window.addEventListener('user-tour:ready', (event) => {
    if (event?.detail?.surface !== 'points') return;
    const nextCode = String(event?.detail?.profile?.memberCode || '').trim();
    if (nextCode !== state.memberCode) {
      stopTransferScanner();
      window.MemberPanelDialog?.close(document.getElementById('pointTransferFriendPicker'));
      window.QRDisplayDialog?.close();
      state.receiverGeneration++; state.receiver = null;
      state.memberCode = nextCode;
      restorePending();
    }
    bind();
    updateOwnMemberCode();
    void loadOptions();
  });

  window.addEventListener('pageshow', () => {
    bind();
    if (!document.getElementById('pointsView')?.classList.contains('hidden')) void loadOptions();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!document.getElementById('pointsView')?.classList.contains('hidden')) void loadOptions();
  });

  window.addEventListener('online', () => {
    if (!document.getElementById('pointsView')?.classList.contains('hidden')) void loadOptions();
  });
})();
