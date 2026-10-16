(() => {
  'use strict';

  const POINT_CARD_STYLE_KEYS = Object.freeze(['citrus', 'coral', 'lagoon', 'skyline', 'violet', 'berry', 'cocoa', 'lime', 'denim', 'peach']);
  const LEGACY_POINT_CARD_STYLE_MAP = Object.freeze({ forest: 'lagoon', midnight: 'skyline', ocean: 'denim', sunset: 'coral', lavender: 'violet', rose: 'berry', gold: 'citrus', platinum: 'cocoa', mint: 'lime', cherry: 'peach' });

  const state = {
    config: null,
    idToken: '',
    profile: null,
    cards: [],
    cardDetails: Object.create(null),
    history: [],
    historyTotal: 0,
    activeCardId: '',
    loadVersion: 0
  };

  const els = {};
  const LOGIN_PROGRESS_TICK_MS = 650;
  let loginProgressTimer = null;
  let loginProgressValue = 8;

  window.addEventListener('DOMContentLoaded', () => {
    window.MemberSystem.bindDialogKeyboard();
    [
      'app', 'loadingView', 'loadingProgress', 'loadingProgressBar', 'loadingProgressText', 'loadingStatus',
      'errorView', 'errorTitle', 'errorMessage', 'joinMemberButton', 'retryButton', 'pointsView',
      'displayName', 'membershipProgress', 'cardTabs', 'emptyView',
      'activeCardView', 'activeCardTitle', 'activeCardStatus', 'cardGuidancePanel', 'cardUsageMethod',
      'cardUsageInstructions', 'cardBenefitDescription', 'progressCount', 'progressMessage',
      'remainingMessage', 'cardExpiry', 'ticketHistorySummary', 'ticketHistoryList', 'ticketHistoryEmpty'
    ].forEach((id) => {
      els[id] = document.getElementById(id);
    });

    els.retryButton.addEventListener('click', () => window.location.reload());
    els.joinMemberButton.addEventListener('click', () => window.MemberSystem.openMemberJoin(state.config));

    els.cardTabs.addEventListener('click', (event) => {
      const tab = event.target instanceof Element ? event.target.closest('[data-card-id]') : null;
      if (tab) selectCard(tab.dataset.cardId);
    });

    els.cardTabs.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !state.cards.length) return;
      event.preventDefault();

      const current = state.cards.findIndex((card) => card.cardId === state.activeCardId);
      const next = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? state.cards.length - 1
          : (current + (event.key === 'ArrowRight' ? 1 : -1) + state.cards.length) % state.cards.length;
      const cardId = state.cards[next].cardId;

      selectCard(cardId).then(() => {
        if (state.activeCardId !== cardId) return;
        const tab = Array.from(els.cardTabs.children).find((button) => button.dataset.cardId === cardId);
        if (tab) tab.focus();
      });
    });

    boot();
  });

  async function boot() {
    setView('loading');
    try {
      startLoginProgress('正在取得開啟設定…', 18);
      state.config = await window.MemberSystem.loadConfig();

      startLoginProgress('正在驗證 LINE 身分…', 48);
      state.idToken = await window.MemberSystem.signIn(state.config, 'points');

      if (!window.PointCardTicketOverview || typeof window.PointCardTicketOverview.initialize !== 'function') {
        const error = new Error('票券總覽模組載入失敗，請重新整理後再試。');
        error.code = 'TICKET_OVERVIEW_LOAD_ERROR';
        throw error;
      }

      startLoginProgress('正在準備票券設定…', 72);
      await window.PointCardTicketOverview.initialize({
        config: state.config,
        idToken: state.idToken,
        refreshData: () => loadCards(false)
      });

      startLoginProgress('正在同步集點卡與票券…', 92);
      await loadCards(false);
      await completeLoginProgress('集點卡資料已準備完成');
      setView('points');
      window.dispatchEvent(new CustomEvent('user-tour:ready', { detail: { surface: 'points', profile: state.profile } }));

      window.MemberSystem.subscribeRealtime(state.config, 'points', async () => {
        const results = await Promise.allSettled([
          window.PointCardTicketOverview.refreshSettings(),
          loadCards(false),
        ]);
        const failed = results.find((result) => result.status === 'rejected');
        if (failed) throw failed.reason;
      });
    } catch (error) {
      stopLoginProgress();
      showError(error);
    } finally {
      stopLoginProgress();
      els.app.setAttribute('aria-busy', 'false');
    }
  }

  async function loadCards(showBusy) {
    if (showBusy) setInlineStatus('正在更新集點卡…');

    const requestVersion = state.loadVersion + 1;
    state.loadVersion = requestVersion;

    try {
      const result = await window.MemberSystem.request(
        state.config,
        'points',
        state.idToken,
        'user.pointcard.bootstrap',
        { compact: false }
      );
      if (requestVersion !== state.loadVersion) return;

      applyCardsSnapshot(result);
      assertCompleteCardsBootstrap();
      if (requestVersion !== state.loadVersion) return;

      window.PointCardTicketOverview.renderSnapshot(result);
      window.TicketBookingSelections?.render(result.bookingSelections, {
        surface:'points',config:state.config,idToken:state.idToken,
        refresh:()=>loadCards(false),showStandaloneEditor:false
      });
      renderCards();

      if (showBusy) setInlineStatus('集點卡已更新。');
    } catch (error) {
      if (!showBusy) throw error;
      handleReadError(error);
    }
  }

  function applyCardsSnapshot(payload) {
    state.profile = payload && payload.profile && typeof payload.profile === 'object'
      ? payload.profile
      : {};
    state.cards = Array.isArray(payload && payload.cards) ? payload.cards : [];
    state.cardDetails = payload && payload.cardDetails && typeof payload.cardDetails === 'object'
      ? payload.cardDetails
      : Object.create(null);
    state.history = Array.isArray(payload && payload.history) ? payload.history : [];

    const historyTotal = Number(payload && payload.historyTotal);
    state.historyTotal = Number.isInteger(historyTotal) && historyTotal >= state.history.length
      ? historyTotal
      : state.history.length;

    if (!state.cards.some((card) => card.cardId === state.activeCardId)) {
      state.activeCardId = state.cards[0] ? state.cards[0].cardId : '';
    }

    els.displayName.textContent = String(state.profile.displayName || 'LINE 使用者');
    window.MembershipProgress.render(els.membershipProgress, state.profile);
  }

  function activeCard() {
    const summary = state.cards.find((card) => card.cardId === state.activeCardId) || state.cards[0] || null;
    if (!summary) return null;
    const detail = state.cardDetails[summary.cardId];
    return detail && detail.card ? { ...summary, ...detail.card } : summary;
  }

  function isCardUnavailable(card) {
    const status = String(card && card.status || 'active').trim().toLowerCase();
    return Boolean(card && card.expired) || status !== 'active';
  }

  function assertCompleteCardsBootstrap() {
    const incomplete = state.cards.some((card) => {
      const cardId = String(card && card.cardId || '');
      const detail = state.cardDetails[cardId];
      return !cardId
        || !detail
        || !detail.card
        || String(detail.card.cardId || '') !== cardId
        || !Array.isArray(detail.tickets);
    });

    if (!incomplete) return;
    const error = new Error('集點卡資料回應不完整，已停止顯示集點卡頁面。請重新整理後再試。');
    error.code = 'POINTCARD_BOOTSTRAP_INCOMPLETE';
    throw error;
  }

  async function selectCard(cardId) {
    const nextCardId = String(cardId || '');
    if (!state.cards.some((card) => card.cardId === nextCardId)) return;
    if (nextCardId === state.activeCardId) return;

    state.activeCardId = nextCardId;
    setInlineStatus('');
    renderCards();
  }

  function setInlineStatus(message, error = false) {
    const status = document.getElementById('syncNotice');
    status.textContent = message;
    status.classList.toggle('hidden', !message);
    status.classList.toggle('is-error', error);
  }

  function handleReadError(error) {
    if (/^(AUTH_|MEMBERSHIP_REQUIRED|MEMBER_)/.test(String(error && error.code || ''))) {
      showError(error);
      return;
    }
    setInlineStatus('更新失敗，畫面保留上次資料。請按「更新」重試；票券狀態以使用時驗證為準。', true);
  }

  function renderCards() {
    const hasCards = state.cards.length > 0;
    els.emptyView.classList.toggle('hidden', hasCards);
    els.activeCardView.classList.toggle('hidden', !hasCards);

    els.cardTabs.replaceChildren(...state.cards.map((summary) => {
      const detail = state.cardDetails[String(summary.cardId || '')];
      const card = detail && detail.card ? { ...summary, ...detail.card } : summary;
      const unavailable = isCardUnavailable(card);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `card-tab${unavailable ? ' is-unavailable' : ''}`;
      button.dataset.cardId = card.cardId;
      button.dataset.cardStyle = safeCardStyle(card.styleKey);
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(card.cardId === state.activeCardId));
      button.tabIndex = card.cardId === state.activeCardId ? 0 : -1;
      button.setAttribute('aria-controls', 'activeCardView');
      button.style.setProperty('--card-accent', safeAccent(card.accent));

      const title = document.createElement('strong');
      title.textContent = String(card.title || '未命名集點卡');
      const meta = document.createElement('span');
      const availableStamps = Math.max(0, Number(card.availableStamps ?? card.stamps ?? 0));
      const reservedStamps = Math.max(0, Number(card.reservedStamps || 0));
      const generalReservedStamps = Math.max(0, Number(card.generalReservedStamps ?? reservedStamps));
      const snapshotReservedStamps = Math.max(0, Number(card.snapshotReservedStamps || 0));
      meta.textContent = reservedStamps > 0
        ? `${availableStamps} 點可用 · ${reservedStamps} 點已預約${snapshotReservedStamps > 0 ? `（一般 ${generalReservedStamps} · 快照待審核 ${snapshotReservedStamps}）` : ''}`
        : `${availableStamps} 點`;
      button.append(title, meta);
      return button;
    }));

    renderHistory();

    if (!hasCards) {
      els.cardGuidancePanel.classList.add('hidden');
      return;
    }

    const card = activeCard();
    if (!card) return;
    renderActiveCard(card);
  }

  function renderActiveCard(card) {
    const totalStamps = Math.max(0, Number(card.totalStamps ?? card.stamps ?? 0));
    const reservedStamps = Math.max(0, Number(card.reservedStamps || 0));
    const generalReservedStamps = Math.max(0, Number(card.generalReservedStamps ?? reservedStamps));
    const snapshotReservedStamps = Math.max(0, Number(card.snapshotReservedStamps || 0));
    const stamps = Math.max(0, Number(card.availableStamps ?? (totalStamps - reservedStamps)));
    const ticketOfferCount = Array.isArray(card.rewards)
      ? card.rewards.length
      : Math.max(0, Number(card.rewardCount || 0));

    const unavailable = isCardUnavailable(card);
    const cardStatus = String(card.status || 'active').trim().toLowerCase();

    els.activeCardView.dataset.cardStyle = safeCardStyle(card.styleKey);
    els.activeCardView.dataset.cardId = String(card.cardId || '');
    els.activeCardView.classList.toggle('is-unavailable', unavailable);
    els.activeCardView.style.setProperty('--card-accent', safeAccent(card.accent));
    setConfiguredText(els.activeCardTitle, card.title || '集點卡');
    els.activeCardStatus.textContent = card.expired
      ? '已超過期限'
      : cardStatus === 'archived'
        ? '已停止集點'
        : unavailable
          ? '目前不可使用'
          : '進行中';
    els.progressCount.textContent = String(stamps);
    els.progressMessage.textContent = card.expired
      ? '這張集點卡已超過使用期限'
      : cardStatus === 'archived'
        ? '這張卡已停止集點'
        : unavailable
          ? '這張集點卡目前不可使用'
          : reservedStamps > 0
          ? snapshotReservedStamps > 0
             ? `目前可用 ${stamps} 點；合計 ${reservedStamps} 點已預約（一般預約 ${generalReservedStamps} 點＋快照待審核 ${snapshotReservedStamps} 點）。一般預約在結算時扣點，快照須經審核後才扣點。`
             : `目前可用 ${stamps} 點；另有 ${reservedStamps} 點已預約使用，將於服務完成時自動核銷。`
          : '點數會持續累積，達標後可於下方票券總覽選擇使用。';
    els.remainingMessage.textContent = ticketOfferCount
      ? `已設定 ${ticketOfferCount} 種兌換票券`
      : '尚未設定兌換票券';
    els.cardExpiry.textContent = card.expiryMode === 'date' && card.expiresOn
      ? `${card.expired ? '已於' : '使用期限至'} ${card.expiresOn}`
      : '使用期限：無期限';

    renderCardGuidance(card);
    window.dispatchEvent(new CustomEvent('pointcard:active-changed', { detail: {
      cardId: String(card.cardId || ''),
      title: String(card.title || '集點卡'),
      stamps,
      totalStamps,
      reservedStamps,
      generalReservedStamps,
      snapshotReservedStamps,
      expiresOn: card.expiryMode === 'date' ? String(card.expiresOn || '') : '',
      transferEligible: !unavailable
    } }));
  }

  function renderCardGuidance(card) {
    const fields = [
      [els.cardUsageMethod, card.usageMethod],
      [els.cardUsageInstructions, card.usageInstructions],
      [els.cardBenefitDescription, card.benefitDescription]
    ];

    let visibleCount = 0;
    fields.forEach(([output, value]) => {
      const configured = String(value || '').trim();
      setConfiguredText(output, configured);
      const item = output.closest('[data-card-guidance-item]');
      if (item) item.classList.toggle('hidden', !configured);
      if (configured) visibleCount += 1;
    });

    els.cardGuidancePanel.classList.toggle('hidden', visibleCount === 0);
  }

  function renderHistory() {
    const history = Array.isArray(state.history)
      ? state.history.slice().sort((a, b) => String(b.occurredAt || '').localeCompare(String(a.occurredAt || '')))
      : [];

    els.ticketHistorySummary.textContent = state.historyTotal
      ? `共 ${state.historyTotal} 筆使用紀錄`
      : '尚無使用紀錄';
    els.ticketHistoryEmpty.classList.toggle('hidden', state.historyTotal !== 0);
    els.ticketHistoryList.replaceChildren(...history.map((activity) => createHistoryCard(activity)));
  }

  function createHistoryCard(activity) {
    const item = document.createElement('li');
    item.className = 'ticket-history-item';

    const heading = document.createElement('div');
    heading.className = 'ticket-history-heading';
    const titleWrap = document.createElement('div');
    const type = document.createElement('span');
    type.className = 'member-ticket-type';
    type.textContent = activity.ticketType === 'lottery' ? '抽獎券已使用' : '優惠券已使用';
    const title = document.createElement('h3');
    setConfiguredText(title, activity.ticketTitle || '票券');
    titleWrap.append(type, title);

    const time = document.createElement('time');
    time.dateTime = String(activity.occurredAt || '');
    time.textContent = activity.occurredAt
      ? window.MemberSystem.formatDateTime(activity.occurredAt)
      : '時間未記錄';
    heading.append(titleWrap, time);

    const details = document.createElement('div');
    details.className = 'ticket-history-details';
    if (activity.cardTitle) {
      const card = document.createElement('p');
      setConfiguredText(card, `集點卡：${activity.cardTitle}`);
      details.append(card);
    }

    const pointLine = document.createElement('p');
    pointLine.className = 'ticket-history-points';
    pointLine.textContent = `本次實際扣除 ${Math.max(0, Number(activity.pointsSpent || 0))} 點`;
    details.append(pointLine);

    if (activity.ticketType === 'lottery') {
      const result = document.createElement('p');
      result.className = 'ticket-history-result';
      setConfiguredText(
        result,
        `本次抽獎結果：${activity.result && activity.result.prizeTitle ? activity.result.prizeTitle : '結果已記錄'}`
      );
      details.append(result);
      if (activity.result && activity.result.prizeDescription) {
        const description = document.createElement('p');
        setConfiguredText(description, activity.result.prizeDescription);
        details.append(description);
      }
    } else {
      const result = document.createElement('p');
      result.className = 'ticket-history-result';
      result.textContent = '票券核銷完成';
      details.append(result);
    }

    const reference = document.createElement('small');
    reference.className = 'ticket-history-reference';
    reference.textContent = `紀錄編號：${String(activity.referenceId || activity.ticketId || '—')}`;

    item.append(heading, details, reference);
    return item;
  }

  function setConfiguredText(element, value) {
    element.textContent = String(value === null || value === undefined ? '' : value);
    element.classList.add('configured-text');
    return element;
  }

  function safeAccent(value) {
    return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value) : '#e47845';
  }

  function safeCardStyle(value) {
    const styleKey = String(value || '').trim().toLowerCase();
    return POINT_CARD_STYLE_KEYS.includes(styleKey) ? styleKey : (LEGACY_POINT_CARD_STYLE_MAP[styleKey] || POINT_CARD_STYLE_KEYS[0]);
  }

  function setView(view) {
    els.loadingView.classList.toggle('hidden', view !== 'loading');
    els.errorView.classList.toggle('hidden', view !== 'error');
    els.pointsView.classList.toggle('hidden', view !== 'points');
  }

  function startLoginProgress(status, ceiling) {
    stopLoginProgress();
    const maximum = Math.max(loginProgressValue, Math.min(98, Number(ceiling) || loginProgressValue));
    setLoginProgress(loginProgressValue, status);
    loginProgressTimer = window.setInterval(() => {
      const remaining = maximum - loginProgressValue;
      if (remaining <= 0) {
        stopLoginProgress();
        return;
      }
      setLoginProgress(
        Math.min(maximum, loginProgressValue + Math.max(1, Math.ceil(remaining * 0.12))),
        status
      );
    }, LOGIN_PROGRESS_TICK_MS);
  }

  function stopLoginProgress() {
    if (loginProgressTimer !== null) window.clearInterval(loginProgressTimer);
    loginProgressTimer = null;
  }

  function completeLoginProgress(status) {
    stopLoginProgress();
    setLoginProgress(100, status);
    return Promise.resolve();
  }

  function setLoginProgress(value, status) {
    const progress = Math.max(
      loginProgressValue,
      Math.max(0, Math.min(100, Math.round(Number(value) || 0)))
    );
    loginProgressValue = progress;
    els.loadingProgress.setAttribute('aria-valuenow', String(progress));
    els.loadingProgress.setAttribute('aria-valuetext', `${progress}%`);
    els.loadingProgressBar.style.width = `${progress}%`;
    els.loadingProgressText.textContent = `${progress}%`;
    if (status) els.loadingStatus.textContent = status;
  }

  function showError(error) {
    const membershipRequired = error && error.code === 'MEMBERSHIP_REQUIRED';
    const maintenance = error && error.code === 'SYSTEM_MAINTENANCE';
    els.errorTitle.textContent = maintenance
      ? '系統維護中'
      : error && error.code === 'CONFIG_ERROR'
      ? '系統尚未完成設定'
      : membershipRequired
        ? '請先加入會員'
        : '集點卡暫時無法載入';
    els.errorMessage.textContent = membershipRequired
      ? '加入會員並完成會員資料後，才能使用集點卡與票券功能。'
      : error && error.message
        ? error.message
        : '請稍後重新整理再試。';
    els.joinMemberButton.classList.toggle('hidden', !membershipRequired);
    els.retryButton.classList.toggle('hidden', membershipRequired);
    setView('error');
  }
  window.PointCardClient = Object.freeze({ refresh: () => loadCards(false) });
  window.MemberClientQaHooks = Object.freeze({ surface: 'points', refresh: () => loadCards(false) });
})();
