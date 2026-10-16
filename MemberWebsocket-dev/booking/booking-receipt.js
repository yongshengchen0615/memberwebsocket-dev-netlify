(() => {
  'use strict';

  const state = {
    receiptsByBooking: new Map(),
    metadataByBooking: new Map(),
    accessible: false,
    snapshotReady: false,
    snapshotAuthorizing: false,
    location: null,
    requestId: '',
    prepared: null,
    uploaded: false,
    selectedBookingId: '',
    selectedExpectedUpdatedAt: '',
    selectedFile: null,
    previewUrl: '',
    cameraStream: null,
    cameraReady: false,
    cameraGeneration: 0,
    opener: null,
    previousShellInert: null,
    photoGeneration: 0,
    ticketGeneration: 0,
    ticketsLoading: false,
    busy: false,
    listLoading: false,
    listGeneration: 0,
    listMemberId: '',
  };

  // Snapshot-mode GPS stays in memory only; it is never stored in localStorage.
  // Starting it from the mode toggle keeps the permission request tied to a user action.
  let modeLocation = null;
  let modeLocationRequired = null;
  let modeLocationGeneration = 0;
  let modeLocationPending = null;

  function freshModeLocation() {
    const fix = modeLocation;
    if (!fix || !Number.isFinite(fix.timestamp) || fix.timestamp < Date.now() - 120000
      || !Number.isFinite(fix.accuracy) || fix.accuracy <= 0 || fix.accuracy > 100) return null;
    return fix;
  }

  function reportModeLocation(status, message = '') {
    window.dispatchEvent(new CustomEvent('booking:snapshot-location-state', {
      detail: { status, message }
    }));
  }

  async function loadSnapshotPolicy() {
    const current = session();
    if (!current) throw new Error('登入狀態已失效，請重新整理。');
    const policy = await window.BookingSystem.request(current.config, 'booking', current.idToken, 'user.booking.receipt.list');
    if (typeof policy?.snapshotLocationRequired !== 'boolean') {
      throw new Error('目前無法確認管理端的快照定位設定，請稍後重試。');
    }
    return policy;
  }

  function beginSnapshotMode() {
    const generation = ++modeLocationGeneration;
    modeLocation = null;
    modeLocationRequired = null;
    reportModeLocation('checking');
    // The administrative setting is authoritative. Never request GPS while OFF.
    const pending = (async () => {
      const policy = await loadSnapshotPolicy();
      if (generation !== modeLocationGeneration) return null;
      modeLocationRequired = policy.snapshotLocationRequired === true;
      if (!modeLocationRequired) {
        reportModeLocation('optional');
        return null;
      }
      reportModeLocation('requesting');
      const point = await requestSnapshotGps(policy);
      if (generation === modeLocationGeneration) {
        modeLocation = point;
        reportModeLocation('ready');
      }
      return generation === modeLocationGeneration ? point : null;
    })().catch(error => {
      if (generation === modeLocationGeneration) {
        reportModeLocation('error', error?.message || '目前無法確認快照定位設定，請重新嘗試。');
      }
      throw error;
    }).finally(() => {
      if (modeLocationPending === pending) modeLocationPending = null;
    });
    modeLocationPending = pending;
    return pending;
  }

  function endSnapshotMode() {
    ++modeLocationGeneration;
    modeLocation = null;
    modeLocationRequired = null;
    modeLocationPending = null;
    reportModeLocation('idle');
  }

  function session() {
    return window.BookingSystem?.getSession?.() || null;
  }

  function newRequestId() {
    const raw = window.crypto?.randomUUID?.() || String(Date.now()) + Math.random().toString(36).slice(2);
    return 'br-' + raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 90);
  }

  function humanSize(bytes) {
    const value = Math.max(0, Number(bytes || 0));
    if (value < 1024) return value + ' B';
    if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
    return (value / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function ensureModal() {
    let modal = document.getElementById('bookingReceiptModal');
    if (modal) return modal;

    modal = document.createElement('section');
    modal.id = 'bookingReceiptModal';
    modal.className = 'booking-receipt-modal hidden';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'bookingReceiptTitle');
    modal.innerHTML = `
      <div class="booking-receipt-modal-card">
        <div class="booking-receipt-heading">
          <div><p class="kicker">Receipt verification</p><h2 id="bookingReceiptTitle">拍攝收據並送出審核</h2></div>
          <button id="bookingReceiptClose" class="booking-modal-close" type="button" aria-label="關閉">×</button>
        </div>
        <p class="booking-receipt-help">請直接使用相機拍攝本次消費收據。預約確認後即可上傳，不需等待服務時間結束；若重新上傳，會覆蓋這筆預約目前的收據快照。管理端確認前，預約仍維持已確認狀態。</p>
        <div class="booking-receipt-camera">
          <video id="bookingReceiptCamera" class="booking-receipt-camera-video" autoplay playsinline muted></video>
          <canvas id="bookingReceiptCanvas" class="hidden"></canvas>
          <div class="booking-receipt-camera-actions">
            <button id="bookingReceiptCapture" class="button button-dark" type="button" disabled>啟動相機中…</button>
            <button id="bookingReceiptRetake" class="button button-outline hidden" type="button">重新拍攝</button>
            <button id="bookingReceiptDiscard" class="button button-outline hidden" type="button">移除照片</button>
          </div>
          <label class="booking-receipt-file-label" for="bookingReceiptFile">或選擇現有收據圖片（JPG／PNG／WebP／HEIC／HEIF，最多 5 MB）
            <input id="bookingReceiptFile" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" aria-label="選擇收據圖片">
          </label>
        </div>
        <div id="bookingReceiptPreviewWrap" class="booking-receipt-preview hidden">
          <img id="bookingReceiptPreview" alt="本次收據預覽">
          <p id="bookingReceiptFileMeta"></p>
        </div>
        <p id="bookingReceiptMessage" class="booking-receipt-message hidden" role="status" aria-live="polite"></p>
        <fieldset id="snapshotTicketFields" class="hidden"><legend>登記本次要使用的票券</legend><p class="snapshot-ticket-intro">選擇本次希望使用的票券；快照模式不需要事先有有效預約，送出只登記使用意願，管理員審核實際服務後才核銷。</p><p id="snapshotTicketSelectionSummary" class="snapshot-ticket-selection-summary" role="status" aria-live="polite">尚未選擇票券；可只送出收據。</p><div id="snapshotTicketChoices" role="group" aria-label="選擇本次要登記使用的票券"></div></fieldset>
        <div class="booking-receipt-actions">
          <button id="bookingReceiptCancel" class="button button-light" type="button">取消</button>
          <button id="bookingReceiptSubmit" class="button button-dark" type="button" disabled>上傳收據並送出審核</button>
        </div>
      </div>`;
    document.body.append(modal);

    modal.querySelector('#bookingReceiptClose').addEventListener('click', closeModal);
    modal.querySelector('#bookingReceiptCancel').addEventListener('click', closeModal);
    modal.querySelector('#bookingReceiptCapture').addEventListener('click', captureFrame);
    modal.querySelector('#bookingReceiptRetake').addEventListener('click', retakePhoto);
    modal.querySelector('#bookingReceiptDiscard').addEventListener('click', discardPhoto);
    modal.querySelector('#bookingReceiptFile').addEventListener('change', event => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (state.busy || !file) return;
      stopCamera();
      acceptFile(file);
    });
    modal.querySelector('#bookingReceiptSubmit').addEventListener('click', submitReceipt);
    modal.addEventListener('click', (event) => {
      if (event.target === modal && !state.busy) closeModal();
    });

    return modal;
  }

  function setMessage(message, error = false) {
    const target = document.getElementById('bookingReceiptMessage');
    if (!target) return;
    target.textContent = String(message || '');
    target.classList.toggle('hidden', !message);
    target.classList.toggle('error', Boolean(error));
  }

  function cleanupPreview() {
    state.previewUrl = '';
  }

  function resetModalState({ preserveSnapshotAuthorization = false } = {}) {
    state.photoGeneration += 1;
    cleanupPreview();
    state.selectedFile = null;
    state.requestId = '';
    state.prepared = null;
    state.uploaded = false;
    state.cameraReady = false;
    state.snapshotAuthorizing = false;
    if (!preserveSnapshotAuthorization) {
      state.snapshotReady = false;
      state.location = null;
    }
    const fileInput = document.getElementById('bookingReceiptFile');
    if (fileInput) fileInput.disabled = false;
    const wrap = document.getElementById('bookingReceiptPreviewWrap');
    const preview = document.getElementById('bookingReceiptPreview');
    const meta = document.getElementById('bookingReceiptFileMeta');
    const submit = document.getElementById('bookingReceiptSubmit');
    const capture = document.getElementById('bookingReceiptCapture');
    const retake = document.getElementById('bookingReceiptRetake');
    const discard = document.getElementById('bookingReceiptDiscard');
    discard?.classList.add('hidden');
    if (preview) preview.removeAttribute('src');
    if (meta) meta.textContent = '';
    if (wrap) wrap.classList.add('hidden');
    if (submit) submit.disabled = true;
    if (capture) { capture.disabled = true; capture.textContent = '啟動相機中…'; capture.classList.remove('hidden'); }
    retake?.classList.add('hidden');
    setMessage('');
  }

  function stopCamera() {
    state.cameraGeneration += 1;
    if (state.cameraStream) {
      state.cameraStream.getTracks().forEach((track) => track.stop());
      state.cameraStream = null;
    }
    state.cameraReady = false;
    const video = document.getElementById('bookingReceiptCamera');
    if (video) video.srcObject = null;
  }

  function closeModal() {
    if (state.busy) return;
    stopCamera();
    resetModalState();
    state.ticketGeneration += 1;
    state.ticketsLoading = false;
    document.getElementById('bookingReceiptModal')?.classList.add('hidden');
    document.body.classList.remove('booking-receipt-modal-open');
    const shell = document.querySelector('.app-shell');
    if (shell && state.previousShellInert !== null) {
      shell.inert = state.previousShellInert;
      state.previousShellInert = null;
    }
    const opener = state.opener;
    state.opener = null;
    if (opener?.isConnected && opener.getClientRects().length) opener.focus({ preventScroll: true });
    state.selectedBookingId = '';
    state.selectedExpectedUpdatedAt = '';
  }

  function openModal(bookingId, expectedUpdatedAt, accessible = false, options = {}) {
    const modal = ensureModal();
    window.dispatchEvent(new Event('booking:receipt-dialog-opening'));
    state.opener = document.activeElement;
    resetModalState();
    state.accessible = accessible;
    state.ticketGeneration += 1;
    state.ticketsLoading = false;
    document.getElementById('snapshotTicketChoices').replaceChildren();
    document.getElementById('snapshotTicketSelectionSummary').textContent = '正在確認可登記的票券…';
    document.getElementById('snapshotTicketFields').classList.toggle('hidden', !accessible);
    document.getElementById('bookingReceiptTitle').textContent = accessible ? '拍收據，請管理員登記' : '拍攝收據並送出審核';
    modal.querySelector('.booking-receipt-help').textContent = accessible
      ? '拍下本次收據並送出即可，不必填寫預約。管理員核對服務項目後，才會登記服務時間與點數。等待登記時重新拍攝，會取代目前收據。'
      : '預約確認後即可拍攝收據。重新上傳會覆蓋目前快照；管理員核對前不會完成預約。';
    state.selectedBookingId = String(bookingId || '');
    state.selectedExpectedUpdatedAt = String(expectedUpdatedAt || '');
    modal.classList.remove('hidden');
    document.body.classList.add('booking-receipt-modal-open');
    const shell = document.querySelector('.app-shell');
    if (shell && state.previousShellInert === null) {
      state.previousShellInert = Boolean(shell.inert);
      shell.inert = true;
    }
    if (options?.skipCamera !== true) void startCamera();
  }

  async function requestSnapshotGps(policy) {
    if (window.isSecureContext === false || !navigator.geolocation?.getCurrentPosition) {
      throw new Error('此裝置不支援定位，請使用 HTTPS 及支援 GPS 定位的瀏覽器。');
    }
    const point = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(position => {
      const fix = { latitude: position.coords.latitude, longitude: position.coords.longitude,
        accuracy: position.coords.accuracy, timestamp: position.timestamp };
      if (!Object.values(fix).every(Number.isFinite) || Math.abs(fix.latitude) > 90 || Math.abs(fix.longitude) > 180 || fix.accuracy <= 0 || fix.accuracy > 100
        || fix.timestamp < Date.now() - 120000 || fix.timestamp > Date.now() + 30000) {
        reject(new Error('GPS 定位不夠精準或已失效（需在 100 公尺內），請重新定位。')); return;
      }
      resolve(fix);
    }, error => reject(new Error(error?.code === 1 ? '定位權限未開啟，請允許 GPS 後按「重新定位」。'
      : error?.code === 3 ? 'GPS 定位逾時，請按「重新定位」重試。' : '暫時無法取得 GPS 定位，請按「重新定位」重試。')),
    { maximumAge: 0, timeout: 12000, enableHighAccuracy: true }));
    const locations = Array.isArray(policy.snapshotLocations) ? policy.snapshotLocations : [];
    if (!locations.length) throw new Error('管理端尚未設定快照可使用地點，請聯絡管理員。');
    const allowed = locations.map(item => String(item.name || '').trim()).filter(Boolean).join('、');
    const toRadians = degrees => degrees * Math.PI / 180;
    const near = locations.some(location => {
      const lat = Number(location.latitude), lon = Number(location.longitude), meters = Number(location.radiusMeters);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(meters)) return false;
      const dLat = toRadians(point.latitude - lat), dLon = toRadians(point.longitude - lon);
      const arc = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(lat)) * Math.cos(toRadians(point.latitude)) * Math.sin(dLon / 2) ** 2;
      const distance = 2 * 6371000 * Math.asin(Math.sqrt(Math.min(1, arc)));
      return distance <= meters && point.accuracy <= meters;
    });
    if (!near) throw new Error(`目前不在快照指定地點「${allowed || '管理端設定的地點'}」範圍內，請抵達後重新定位。`);
    return point;
  }

  async function snapshotLocation() {
    const policy = await loadSnapshotPolicy();
    // The backend revalidates the latest policy at prepare/finalize. A location
    // may still be supplied for ticket-specific requirements when already held.
    if (policy.snapshotLocationRequired !== true) return freshModeLocation();
    return requestSnapshotGps(policy);
  }

  async function authorizeSnapshot(start = true) {
    if (state.snapshotAuthorizing) return false;
    state.snapshotAuthorizing = true;
    const generation = state.photoGeneration;
    const capture = document.getElementById('bookingReceiptCapture');
    const input = document.getElementById('bookingReceiptFile');
    if (capture) capture.disabled = true;
    if (input) input.disabled = true;
    setMessage('正在確認快照定位設定…');
    try {
      // Reuse the mode-entry fix if fresh; otherwise retry in this dialog.
      const point = modeLocationRequired === false ? null
        : freshModeLocation() || await (modeLocationPending || beginSnapshotMode());
      if (modeLocationRequired === null || (modeLocationRequired === true && !point)) return false;
      if (generation !== state.photoGeneration || document.getElementById('bookingReceiptModal')?.classList.contains('hidden')) return false;
      state.location = point; state.snapshotReady = true;
      if (input) input.disabled = false;
      if (start) void startCamera();
      return true;
    } catch (error) {
      if (generation === state.photoGeneration) {
        state.snapshotReady = false;
        if (capture) { capture.disabled = false; capture.textContent = '重新定位／確認設定'; }
        setMessage(error?.message || '目前無法確認定位，請重試。', true);
      }
      return false;
    } finally { if (generation === state.photoGeneration) state.snapshotAuthorizing = false; }
  }

  function openAccessible() {
    openModal('', '', true, { skipCamera: true });
    return authorizeSnapshot().then(ready => {
      if (ready) void loadSnapshotTickets();
      return ready;
    });
  }

  async function loadSnapshotTickets() {
    const generation = state.ticketGeneration;
    state.ticketsLoading = true;
    const fields = document.getElementById('snapshotTicketFields');
    fields.classList.remove('hidden'); fields.disabled = true;
    const choices = document.getElementById('snapshotTicketChoices');
      const previouslyChecked = new Set(
        [...choices.querySelectorAll('[data-snapshot-id]:checked')]
          .map(check => String(check.dataset.snapshotKind) + ':' + String(check.dataset.snapshotId))
      );
    choices.textContent = '正在讀取票券與使用條件…';
    try {
      const current = session();
      const catalog = await window.BookingSystem.request(current.config, 'booking', current.idToken, 'user.booking.receipt.options', { location: state.location });
      if (generation !== state.ticketGeneration || !state.accessible) return;
      choices.replaceChildren();
      window.dispatchEvent(new CustomEvent('booking:snapshot-benefit-options', { detail: { items: catalog.items || [] } }));
      // Show eligible unclaimed event tickets so the member can claim them first.
      // Only an issued claim ID is permitted in a snapshot redemption request.
      const items = (catalog.items || []).filter(item =>
        (item.kind === 'points' || item.kind === 'event')
        && (item.selectionId || (item.kind === 'event' && item.claimRequired === true)));
      const selectionSummary = document.getElementById('snapshotTicketSelectionSummary');
      // Match the member point-card redemption screen: total quantity and per-card
      // available points are shared across all selected tickets, not per checkbox.
      const normalizeLimit = value => {
        const parsed = Number(value);
        return Number.isInteger(parsed) && parsed >= 0 && parsed <= 50 ? parsed : 1;
      };
      const pointLimit = normalizeLimit(catalog.pointTicketMaxPerRedemption);
      const eventLimit = normalizeLimit(catalog.eventTicketMaxPerDay);
      const usedEventsToday = Math.max(0, Number(catalog.usedTodayCount) || 0);
      const itemByKey = new Map(items.filter(item => item.selectionId)
        .map(item => [String(item.kind) + ':' + String(item.selectionId), item]));
      items.forEach(item => {
        const blocked = item.selectable !== true || item.claimRequired === true;
        const option = document.createElement('div');
        option.className = 'snapshot-ticket-option';
        const label = document.createElement('label');
        label.className = 'snapshot-ticket-choice';
        option.classList.toggle('is-unavailable', blocked);
        label.classList.toggle('is-unavailable', blocked);
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.className = 'snapshot-ticket-checkbox';
        check.dataset.snapshotKind = item.kind;
        check.dataset.snapshotId = item.selectionId;
        check.disabled = blocked;
        check.checked = !blocked && previouslyChecked.has(String(item.kind) + ':' + String(item.selectionId));
        check.setAttribute('aria-label', '登記使用' + String(item.title || '此票券'));
        label.classList.toggle('is-selected', check.checked);
        option.classList.toggle('is-selected', check.checked);
        const copy = document.createElement('span');
        copy.className = 'snapshot-ticket-copy';
        const heading = document.createElement('span');
        heading.className = 'snapshot-ticket-title-row';
        const title = document.createElement('strong');
        title.className = 'snapshot-ticket-title';
        title.textContent = String(item.title || '可用票券');
        const kind = document.createElement('span');
        kind.className = 'snapshot-ticket-kind';
        kind.dataset.kind = item.kind;
        kind.textContent = item.kind === 'points' ? '集點卡票券' : '活動票券';
        heading.append(kind, title);
        copy.append(heading);
        if (item.cardTitle && item.kind === 'points') {
          const sourceName = document.createElement('span');
          sourceName.className = 'snapshot-ticket-source';
          sourceName.textContent = '來源集點卡：' + String(item.cardTitle);
          copy.append(sourceName);
        }
        const condition = document.createElement('span');
        condition.className = 'snapshot-ticket-condition';
        condition.textContent = String(item.conditionLabel || item.subtitle || '依票券使用條件核對');
        copy.append(condition);
        const facts = [];
        if (item.endsOn) facts.push('有效至 ' + String(item.endsOn).replaceAll('-', '/'));
        if (item.kind === 'points' && Number(item.pointCost) > 0) facts.push('使用需 ' + Number(item.pointCost) + ' 點');
        if (facts.length) {
          const detail = document.createElement('span');
          detail.className = 'snapshot-ticket-facts';
          detail.textContent = facts.join(' · ');
          copy.append(detail);
        }
        if (blocked) {
          const reason = document.createElement('span');
          reason.className = 'snapshot-ticket-disabled-reason';
          reason.textContent = item.kind === 'event' && item.claimRequired === true
            ? '尚未領取；請先領取，確認可用後才能勾選。'
            : String(item.disabledReason || '目前不可登記使用');
          copy.append(reason);
        }
        const dynamicReason = document.createElement('span');
        dynamicReason.className = 'snapshot-ticket-disabled-reason hidden';
        copy.append(dynamicReason);
        const indicator = document.createElement('span');
        indicator.className = 'snapshot-ticket-choice-status';
        indicator.textContent = blocked
          ? (item.kind === 'event' && item.claimRequired === true ? '需先領取' : item.kind === 'event' && (item.reservedInSnapshot || item.reservedForBooking) ? '不可重複登記' : '不可使用')
          : check.checked ? '已選擇' : '點選使用';
        label.append(copy, check, indicator);
        option.append(label);
        if (item.kind === 'event' && item.claimRequired === true) {
          const claimButton = document.createElement('button');
          claimButton.type = 'button';
          claimButton.className = 'button button-outline snapshot-ticket-claim-button';
          claimButton.textContent = '領取活動票券';
          claimButton.addEventListener('click', async () => {
            if (state.busy || state.ticketsLoading || generation !== state.ticketGeneration || !state.accessible) return;
            const title = String(item.title || '活動票券');
            if (!window.confirm('要先領取「' + title + '」嗎？領取後仍須符合定位及使用條件，才能登記快照。')) return;
            const currentSession = session();
            if (!currentSession) return setMessage('登入狀態已失效，請重新整理。', true);
            state.ticketsLoading = true;
            fields.disabled = true;
            claimButton.textContent = '領取中…';
            try {
              await window.BookingSystem.claimEventTicket(currentSession.config, currentSession.idToken, String(item.id || ''));
              if (generation !== state.ticketGeneration || !state.accessible) return;
              setMessage('已領取活動票券，正在重新確認可使用條件…');
              await loadSnapshotTickets();
              if (generation === state.ticketGeneration && state.accessible) {
                setMessage('活動票券已領取，請確認票券條件後勾選使用。');
              }
            } catch (error) {
              if (generation === state.ticketGeneration && state.accessible) {
                setMessage(String(error?.message || '活動票券領取失敗，請重新嘗試。'), true);
              }
            } finally {
              if (generation === state.ticketGeneration && state.accessible) {
                state.ticketsLoading = false;
                fields.disabled = false;
                claimButton.textContent = '領取活動票券';
              }
            }
          });
          const claimAction = document.createElement('div');
          claimAction.className = 'snapshot-ticket-claim-action';
          claimAction.append(claimButton);
          option.append(claimAction);
        }
        choices.append(option);
        check.addEventListener('change', () => {
          resetTicketRequest();
          renderBookings();
        });
      });
      if (!items.length) choices.textContent = '目前沒有可登記或可領取的票券，可以只送出收據。';
      function renderBookings() {
        const checked = [...choices.querySelectorAll('[data-snapshot-id]:checked')];
        const selectedPoints = checked.filter(input => input.dataset.snapshotKind === 'points').length;
        const selectedEvents = checked.filter(input => input.dataset.snapshotKind === 'event').length;
        const spendByCard = new Map();
        const balanceByCard = new Map();
        for (const input of checked) {
          if (input.dataset.snapshotKind !== 'points') continue;
          const ticket = itemByKey.get('points:' + input.dataset.snapshotId);
          if (!ticket) continue;
          const cardKey = String(ticket.cardId || ticket.cardTitle || ticket.selectionId);
          spendByCard.set(cardKey, (spendByCard.get(cardKey) || 0) + Math.max(0, Number(ticket.pointCost) || 0));
          balanceByCard.set(cardKey, { title: String(ticket.cardTitle || '集點卡'), balance: Math.max(0, Number(ticket.pointBalance) || 0) });
        }
        for (const input of choices.querySelectorAll('[data-snapshot-id]')) {
          const ticket = itemByKey.get(String(input.dataset.snapshotKind) + ':' + String(input.dataset.snapshotId));
          if (!ticket) continue;
          const selected = input.checked;
          const fixedBlocked = ticket.selectable !== true || ticket.claimRequired === true;
          let reason = '';
          if (!selected && !fixedBlocked) {
            if (ticket.kind === 'points') {
              const cardKey = String(ticket.cardId || ticket.cardTitle || ticket.selectionId);
              const available = Math.max(0, Number(ticket.pointBalance) || 0);
              const spent = spendByCard.get(cardKey) || 0;
              const needed = Math.max(0, Number(ticket.pointCost) || 0);
              if (pointLimit > 0 && selectedPoints >= pointLimit) {
                reason = '已達管理端設定的單次上限 ' + pointLimit + ' 張，請先取消其他票券。';
              } else if (spent + needed > available) {
                reason = '點數不足：剩餘可用 ' + Math.max(0, available - spent) + ' 點，此票券需要 ' + needed + ' 點。';
              }
            } else if (ticket.kind === 'event' && eventLimit > 0 &&
                       usedEventsToday + selectedEvents >= eventLimit) {
              reason = '已達管理端設定的每日上限 ' + eventLimit + ' 張（今日已用 ' + usedEventsToday + ' 張）。';
            }
          }
          input.disabled = fixedBlocked || Boolean(reason);
          const label = input.closest('.snapshot-ticket-choice');
          const option = input.closest('.snapshot-ticket-option');
          label?.classList.toggle('is-selected', selected);
          option?.classList.toggle('is-selected', selected);
          option?.classList.toggle('is-unavailable', input.disabled);
          label?.classList.toggle('is-unavailable', input.disabled);
          const status = label?.querySelector('.snapshot-ticket-choice-status');
          if (status) status.textContent = selected ? '已選擇' : fixedBlocked ? (ticket.kind === 'event' && (ticket.reservedInSnapshot || ticket.reservedForBooking) ? '不可重複登記' : '不可使用') : reason ? '不可再選' : '點選使用';
          // The last reason belongs to the dynamic quantity/budget guard.
          const messages = label?.querySelectorAll('.snapshot-ticket-disabled-reason') || [];
          const dynamic = messages[messages.length - 1];
          if (dynamic) { dynamic.textContent = reason; dynamic.classList.toggle('hidden', !reason); }
        }
        if (selectionSummary) {
          selectionSummary.classList.toggle('has-selection', checked.length > 0);
          const budgets = [...spendByCard.entries()].map(([id, amount]) => {
            const card = balanceByCard.get(id);
            return card.title + '預計扣 ' + amount + ' 點（可用 ' + card.balance + ' 點）';
          });
          const limits = '集點卡單次 ' + (pointLimit === 0 ? '不限張數' : '最多 ' + pointLimit + ' 張') +
            '；活動票券今日' + (eventLimit === 0 ? '不限張數' : '剩餘 ' + Math.max(0, eventLimit - usedEventsToday) + ' 張');
          selectionSummary.textContent = checked.length
            ? '本次已選擇 ' + checked.length + ' 張票券；' + (budgets.length ? '預計扣點：' + budgets.join('、') + '。' : '') +
              limits + '。送出後由管理員審核，不會立即核銷，也不需要事先預約。'
            : '尚未選擇票券；可只送出收據，無需事先預約。' + limits + '。';
        }
      }
      // A reloaded catalog may lower the limit while prior choices remain checked.
      // Do not silently keep an over-budget, over-limit selection.
      for (const checkbox of [...choices.querySelectorAll('[data-snapshot-id]:checked')]) {
        const picked = [...choices.querySelectorAll('[data-snapshot-id]:checked')];
        const pointPicks = picked.filter(input => input.dataset.snapshotKind === 'points');
        const eventPicks = picked.filter(input => input.dataset.snapshotKind === 'event');
        const pointSum = new Map();
        for (const input of pointPicks) {
          const ticket = itemByKey.get('points:' + input.dataset.snapshotId);
          const key = String(ticket?.cardId || ticket?.cardTitle || ticket?.selectionId);
          pointSum.set(key, (pointSum.get(key) || 0) + Math.max(0, Number(ticket?.pointCost) || 0));
        }
        const item = itemByKey.get(String(checkbox.dataset.snapshotKind) + ':' + checkbox.dataset.snapshotId);
        const cardKey = String(item?.cardId || item?.cardTitle || item?.selectionId);
        const overBudget = checkbox.dataset.snapshotKind === 'points' &&
          (pointSum.get(cardKey) || 0) > Math.max(0, Number(item?.pointBalance) || 0);
        if (overBudget || (pointLimit > 0 && pointPicks.length > pointLimit) ||
            (eventLimit > 0 && usedEventsToday + eventPicks.length > eventLimit)) {
          checkbox.checked = false;
          resetTicketRequest();
        }
      }
      renderBookings();
    } catch (error) {
      if (generation === state.ticketGeneration) {
        choices.textContent = error?.message || '無法讀取票券，可只送收據或關閉後重試。';
        const summary = document.getElementById('snapshotTicketSelectionSummary');
        if (summary) summary.textContent = '票券暫時無法載入；可以只送出收據。';
      }
    } finally {
      if (generation === state.ticketGeneration) {
        state.ticketsLoading = false;
        fields.disabled = false;
      }
    }
  }

  function resetTicketRequest() {
    state.requestId = ''; state.prepared = null; state.uploaded = false;
  }

  async function openAccessibleE2ESnapshot(blob) {
    const testSessionToken = window.TestModeClient?.getSessionToken?.();
    if (!testSessionToken) throw Object.assign(new Error('只有有效測試 Session 可以使用 E2E 收據快照。'), { code: 'TEST_SESSION_REQUIRED' });
    if (!(blob instanceof Blob)) throw Object.assign(new Error('E2E 收據快照格式不正確。'), { code: 'E2E_RECEIPT_SNAPSHOT_REQUIRED' });
    const mimeType = String(blob.type || '').toLowerCase();
    const extension = mimeType === 'image/webp' ? 'webp' : mimeType === 'image/png' ? 'png' : mimeType === 'image/jpeg' ? 'jpg' : '';
    if (!extension) throw Object.assign(new Error('E2E 收據快照必須是 JPG、PNG 或 WebP。'), { code: 'E2E_RECEIPT_SNAPSHOT_MIME' });
    openModal('', '', true, { skipCamera: true });
    if (!await authorizeSnapshot(false)) throw new Error('E2E 快照未取得目前政策要求的定位。');
    const file = new File([blob], `e2e-accessible-receipt-${Date.now()}.${extension}`, {
      type: mimeType,
      lastModified: Date.now(),
    });
    acceptFile(file);
    return { mimeType, sizeBytes: file.size };
  }

  async function startCamera() {
    stopCamera();
    const generation = state.cameraGeneration;
    const video = document.getElementById('bookingReceiptCamera');
    const capture = document.getElementById('bookingReceiptCapture');
    if (!video || !capture) return;

    capture.disabled = true;
    capture.textContent = '啟動相機中…';
    setMessage('正在開啟後鏡頭…');

    if (!navigator.mediaDevices?.getUserMedia) {
      capture.disabled = false;
      capture.textContent = '重新嘗試開啟相機';
      setMessage('此瀏覽器無法使用相機，請改用選擇收據圖片功能。', true);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      if (generation !== state.cameraGeneration) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      state.cameraStream = stream;
      video.srcObject = stream;
      await video.play();
      if (generation !== state.cameraGeneration) return;
      state.cameraReady = true;
      capture.disabled = false;
      capture.textContent = '拍攝收據';
      setMessage('請將收據完整放入畫面後拍攝。');
    } catch (error) {
      if (generation !== state.cameraGeneration) return;
      stopCamera();
      console.warn('booking receipt camera unavailable', error);
      capture.disabled = false;
      capture.textContent = '重新嘗試開啟相機';
      setMessage('無法開啟相機。請允許相機權限後再試，或選擇收據圖片。', true);
    }
  }

  function acceptFile(file) {
    if (state.accessible && !state.snapshotReady) return;
    const generation = ++state.photoGeneration;
    state.requestId = ''; state.prepared = null; state.uploaded = false;
    cleanupPreview();
    state.selectedFile = file || null;
    const wrap = document.getElementById('bookingReceiptPreviewWrap');
    const preview = document.getElementById('bookingReceiptPreview');
    const meta = document.getElementById('bookingReceiptFileMeta');
    const submit = document.getElementById('bookingReceiptSubmit');
    const capture = document.getElementById('bookingReceiptCapture');
    const retake = document.getElementById('bookingReceiptRetake');
    const discard = document.getElementById('bookingReceiptDiscard');
    wrap?.classList.add('hidden');
    discard?.classList.add('hidden');

    if (!file) {
      wrap?.classList.add('hidden');
      if (submit) submit.disabled = true;
      return;
    }

    const allowed = new Set(['image/jpeg','image/png','image/webp','image/heic','image/heif']);
    if (!allowed.has(String(file.type || '').toLowerCase())) {
      state.selectedFile = null;
      if (capture) { capture.disabled = false; capture.textContent = '重新開啟相機'; }
      setMessage('請使用 JPG、PNG、WebP、HEIC 或 HEIF 圖片。', true);
      if (submit) submit.disabled = true;
      return;
    }
    if (file.size < 1 || file.size > 5 * 1024 * 1024) {
      state.selectedFile = null;
      if (capture) { capture.disabled = false; capture.textContent = '重新開啟相機'; }
      setMessage('收據圖片不可超過 5 MB。', true);
      if (submit) submit.disabled = true;
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (generation !== state.photoGeneration) return;
      state.previewUrl = typeof reader.result === 'string' ? reader.result : '';
      if (preview && state.previewUrl) preview.src = state.previewUrl;
      if (meta) meta.textContent = `${file.name || '收據照片'} · ${humanSize(file.size)}`;
      wrap?.classList.remove('hidden');
      if (submit) submit.disabled = false;
      capture?.classList.add('hidden');
      retake?.classList.remove('hidden');
      discard?.classList.remove('hidden');
      stopCamera();
      setMessage('收據圖片已準備好。確認清楚可辨識後送出；管理端核對前不會完成預約。');
    };
    reader.onerror = () => {
      if (generation !== state.photoGeneration) return;
      state.selectedFile = null;
      if (capture) { capture.disabled = false; capture.textContent = '重新開啟相機'; }
      setMessage('無法讀取這張圖片，請重新選擇或拍攝。', true);
      if (submit) submit.disabled = true;
    };
    reader.readAsDataURL(file);
  }

  function captureFrame() {
    if (state.busy) return;
    if (state.accessible && !state.snapshotReady) { void authorizeSnapshot(); return; }
    if (!state.cameraReady) {
      void startCamera();
      return;
    }

    const video = document.getElementById('bookingReceiptCamera');
    const canvas = document.getElementById('bookingReceiptCanvas');
    if (!video || !canvas || !video.videoWidth || !video.videoHeight) {
      setMessage('相機畫面尚未準備完成，請再試一次。', true);
      return;
    }

    const maxWidth = 1920;
    const scale = Math.min(1, maxWidth / video.videoWidth);
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) {
      setMessage('目前無法擷取相機畫面。', true);
      return;
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const generation = ++state.photoGeneration;
    const capture = document.getElementById('bookingReceiptCapture');
    if (capture) capture.disabled = true;
    canvas.toBlob((blob) => {
      if (generation !== state.photoGeneration) return;
      if (capture) capture.disabled = false;
      if (!blob) {
        setMessage('拍攝失敗，請重新拍攝。', true);
        return;
      }
      const file = new File([blob], `receipt-${Date.now()}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
      acceptFile(file);
    }, 'image/jpeg', 0.88);
  }

  function discardPhoto() {
    if (state.busy) return;
    stopCamera();
    resetModalState({ preserveSnapshotAuthorization: true });
    const capture = document.getElementById('bookingReceiptCapture');
    if (capture) { capture.disabled = false; capture.textContent = '重新開啟相機'; }
    setMessage('已移除尚未送出的收據圖片；預約與已選票券不受影響。');
  }

  function retakePhoto() {
    if (state.busy) return;
    if (state.accessible && !state.snapshotReady) { void authorizeSnapshot(); return; }
    state.photoGeneration += 1;
    state.requestId = ''; state.prepared = null; state.uploaded = false;
    cleanupPreview();
    state.selectedFile = null;
    const wrap = document.getElementById('bookingReceiptPreviewWrap');
    const preview = document.getElementById('bookingReceiptPreview');
    const meta = document.getElementById('bookingReceiptFileMeta');
    const submit = document.getElementById('bookingReceiptSubmit');
    const capture = document.getElementById('bookingReceiptCapture');
    const retake = document.getElementById('bookingReceiptRetake');
    const discard = document.getElementById('bookingReceiptDiscard');
    discard?.classList.add('hidden');
    wrap?.classList.add('hidden');
    preview?.removeAttribute('src');
    if (meta) meta.textContent = '';
    if (submit) submit.disabled = true;
    capture?.classList.remove('hidden');
    retake?.classList.add('hidden');
    void startCamera();
  }

  async function uploadSigned(config, prepared, file) {
    if (!window.supabase?.createClient) throw new Error('Supabase Storage SDK 尚未載入。');
    const client = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const result = await client.storage
      .from('booking-receipts')
      .uploadToSignedUrl(String(prepared.objectPath || ''), String(prepared.uploadToken || ''), file, {
        contentType: String(file.type || '').toLowerCase(),
      });
    if (result.error) throw result.error;
  }

  function snapshotConfirmationChatText(receiptId, ticketCount) {
    return [
      '【快照確認】',
      '狀態：收據已送出，等待管理員審核',
      receiptId ? `快照編號：${receiptId}` : '',
      `登記票券：${ticketCount} 張（待審核，尚未核銷）`,
      '管理員核對服務後才會登記服務時間、點數及票券核銷。',
      receiptId ? `查看預約明細：https://liff.line.me/2010787602-sgiB0ETj?receiptId=${encodeURIComponent(receiptId)}` : '',
    ].filter(Boolean).join('\n');
  }

  async function sendSnapshotConfirmationChatMessage(receiptId, ticketCount) {
    try {
      const sender = window.BookingSystem?.sendMemberChatMessage;
      if (typeof sender !== 'function') return { sent: false, reason: 'send_messages_unavailable' };
      return await sender(snapshotConfirmationChatText(receiptId, ticketCount));
    } catch (_) {
      // A LINE chat failure must never turn a committed receipt into an upload error.
      return { sent: false, reason: 'send_failed' };
    }
  }

  async function submitReceipt() {
    if (state.busy || !state.selectedFile || (!state.selectedBookingId && !state.accessible)) return;
    if (state.accessible && state.ticketsLoading) { setMessage('票券仍在讀取中，請稍候。', true); return; }
    const selectedBenefits = state.accessible ? [...document.querySelectorAll('[data-snapshot-id]:checked')].map(check => ({ kind: check.dataset.snapshotKind, id: check.dataset.snapshotId })) : [];
    const currentSession = session();
    if (!currentSession) return setMessage('登入狀態已失效，請重新整理後再試。', true);

    state.busy = true;
    const ticketFields = document.getElementById('snapshotTicketFields');
    if (ticketFields) ticketFields.disabled = true;
    const submit = document.getElementById('bookingReceiptSubmit');
    const cancel = document.getElementById('bookingReceiptCancel');
    const close = document.getElementById('bookingReceiptClose');
    const imageInput = document.getElementById('bookingReceiptFile');
    [submit, cancel, close, imageInput].forEach((button) => { if (button) button.disabled = true; });

    const file = state.selectedFile;
    const requestId = state.requestId || (state.requestId = newRequestId());
    let submitted = false;
    const retake = document.getElementById('bookingReceiptRetake');
    if (retake) retake.disabled = true;
    try {
      if (state.accessible) {
        setMessage('正在重新確認定位政策…');
        state.location = await snapshotLocation();
      }
      setMessage('正在建立安全上傳連結…');
      const prepared = state.prepared || await window.BookingSystem.request(
        currentSession.config,
        'booking',
        currentSession.idToken,
        'user.booking.receipt.prepare',
        {
          ...(state.accessible ? { accessible: true, location: state.location, benefits: selectedBenefits } : { bookingId: state.selectedBookingId }),
          requestId,
          mimeType: String(file.type || '').toLowerCase(),
          sizeBytes: file.size,
        }
      );

      state.prepared = prepared;
      if (!state.uploaded && prepared.uploadToken) {
        setMessage('正在上傳收據圖片…');
        await uploadSigned(currentSession.config, prepared, file);
        state.uploaded = true;
      }

      setMessage('正在驗證圖片並送交管理端確認…');
      const finalized = await window.BookingSystem.request(
        currentSession.config,
        'booking',
        currentSession.idToken,
        'user.booking.receipt.finalize',
        {
          receiptId: prepared.receiptId,
          ...(state.accessible ? { location: state.location } : {}),
          expectedUpdatedAt: state.selectedExpectedUpdatedAt,
        }
      );

      // Database finalization is the commit point. Replays must not send the
      // same chat confirmation again, and LINE errors never undo a snapshot.
      submitted = true;
      let chatResult = null;
      if (state.accessible && finalized.alreadyApplied !== true) {
        setMessage('快照已送出，正在同步 LINE 官方帳號聊天…');
        chatResult = await sendSnapshotConfirmationChatMessage(
          String(finalized.receiptId || prepared.receiptId || ''), selectedBenefits.length
        );
      }
      setMessage(finalized.alreadyApplied ? '此收據已送出，正在等待管理端確認。' : '收據已安全送出，請等待管理端核對後完成預約。');
      if (state.accessible) window.dispatchEvent(new CustomEvent('booking:accessible-receipt-submitted', {
        detail: { ...finalized, receiptId: String(finalized.receiptId || prepared.receiptId || ''), chatResult },
      }));
      state.receiptsByBooking.set(state.selectedBookingId, {
        receiptId: String(finalized.receiptId || prepared.receiptId || ''),
        status: String(finalized.status || 'awaiting_review'),
      });
      // Background tabs throttle timers. Finalization is the commit point, so
      // release the dialog immediately and refresh the persisted receipt list.
      state.busy = false;
      [submit, cancel, close, imageInput].forEach((button) => { if (button) button.disabled = false; });
      if (retake) retake.disabled = false;
      closeModal();
      void refreshListAndDecorate();
      return;
    } catch (error) {
      if (error?.code !== 'API_RESPONSE_UNCERTAIN' && error?.code !== 'RECEIPT_UPLOAD_UNAVAILABLE') {
        state.requestId = ''; state.prepared = null; state.uploaded = false;
      }
      setMessage(
        error?.code === 'API_RESPONSE_UNCERTAIN'
          ? '無法確認最後結果。請先重新整理頁面；若已完成，系統不會再次結算。'
          : (error?.message || '收據上傳或送審失敗，請重新拍攝後再試。'),
        true
      );
    } finally {
      if (!submitted) {
        state.busy = false;
        if (ticketFields) ticketFields.disabled = false;
        [submit, cancel, close, imageInput].forEach((button) => { if (button) button.disabled = false; });
        if (retake) retake.disabled = false;
      }
    }
  }

  function decorateCards() {
    document.querySelectorAll('#bookingList [data-booking-id]').forEach((card) => {
      const bookingId = String(card.dataset.bookingId || '');
      const meta = state.metadataByBooking.get(bookingId);
      if (!bookingId || !meta) return;

      card.querySelectorAll('[data-booking-receipt-control]').forEach((node) => node.remove());

      const bound = meta.receipt?.status === 'bound';
      const awaitingReview = meta.receipt?.status === 'awaiting_review';
      const pending = meta.receipt?.status === 'pending_upload';

      if (bound) {
        const note = document.createElement('p');
        note.dataset.bookingReceiptControl = '1';
        note.className = 'booking-receipt-status is-bound';
        note.textContent = '收據已確認 · 服務完成';
        card.append(note);
        return;
      }

      const canSubmitReceipt = Boolean(meta.canSubmitReceipt ?? meta.canComplete);

      if (awaitingReview) {
        const note = document.createElement('p');
        note.dataset.bookingReceiptControl = '1';
        note.className = 'booking-receipt-status';
        note.textContent = '收據已送出 · 等待管理端確認；重新拍攝會覆蓋目前快照';
        card.append(note);
      }

      if (canSubmitReceipt) {
        const actions = document.createElement('div');
        actions.dataset.bookingReceiptControl = '1';
        actions.className = 'booking-actions booking-receipt-card-actions';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'button button-dark';
        button.textContent = awaitingReview
          ? '重新拍攝並覆蓋收據'
          : pending
            ? '收據上傳未完成，重新拍攝'
            : '拍攝收據送出審核';
        button.addEventListener('click', () => openModal(bookingId, meta.updatedAt));
        actions.append(button);
        card.append(actions);
      }
    });
  }

  function invalidateReceiptList() {
    state.listGeneration += 1;
    state.listLoading = false;
    state.metadataByBooking.clear();
    document.querySelectorAll('[data-booking-receipt-control]').forEach(node => node.remove());
    window.dispatchEvent(new CustomEvent('booking:receipts-updated', { detail: { submissions: [] } }));
  }

  async function refreshListAndDecorate() {
    if (state.listLoading) return;
    const currentSession = session();
    if (!currentSession) return;
    const generation = state.listGeneration;
    const isCurrent = () => generation === state.listGeneration
      && session()?.idToken === currentSession.idToken;
    state.listLoading = true;
    try {
      const data = await window.BookingSystem.request(
        currentSession.config,
        'booking',
        currentSession.idToken,
        'user.booking.receipt.list',
        {receiptId:new URLSearchParams(window.location.search).get('receiptId') || ''}
      );
      // A response from an ended or replaced session cannot update another member's UI.
      if (!isCurrent()) return;
      state.metadataByBooking.clear();
      (Array.isArray(data.bookings) ? data.bookings : []).forEach((item) => {
        state.metadataByBooking.set(String(item.bookingId || ''), item);
      });
      decorateCards();
      window.dispatchEvent(new CustomEvent('booking:receipts-updated', { detail: { submissions: Array.isArray(data.submissions) ? data.submissions : [] } }));
    } catch (error) {
      if (!isCurrent()) return;
      console.warn('booking receipt list failed', error);
      window.dispatchEvent(new CustomEvent('booking:receipt-load-error'));

    } finally {
      if (generation === state.listGeneration) state.listLoading = false;
    }
  }

  window.BookingReceipts = Object.freeze({
    openAccessible,
    beginSnapshotMode,
    endSnapshotMode,
    openAccessibleE2ESnapshot,
    openBooking: openModal,
    refresh: refreshListAndDecorate,
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !document.getElementById('bookingReceiptModal')?.classList.contains('hidden')) closeModal();
  });
  window.addEventListener('DOMContentLoaded', ensureModal);
  window.addEventListener('pagehide', () => {
    state.photoGeneration += 1;
    endSnapshotMode();
    stopCamera();
  });
  window.addEventListener('qr-scan-dialog:opening', () => {
    if (!document.getElementById('bookingReceiptModal')?.classList.contains('hidden') && !state.busy) closeModal();
  });
  window.addEventListener('member:access-ended', () => {
    state.listMemberId = '';
    invalidateReceiptList();
    state.busy = false;
    closeModal();
  });
  window.addEventListener('booking:member-loaded', event => {
    const memberId = String(event.detail?.profile?.lineUserId || '');
    if (memberId === state.listMemberId) return;
    state.listMemberId = memberId;
    invalidateReceiptList();
  });
  window.addEventListener('booking:bookings-rendered', () => { void refreshListAndDecorate(); });
  window.addEventListener('pageshow', () => {
    if (!document.getElementById('bookingView')?.classList.contains('hidden')) void refreshListAndDecorate();
  });
})();
