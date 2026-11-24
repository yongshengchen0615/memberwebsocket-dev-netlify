(() => {
  'use strict';

  const state = { config: null, idToken: '', profile: null, offers: [], usedTickets: [], usedTicketCount: 0, pendingEventTicketId: '', processing: false, actionLocked: false, uncertainEventTicketId: '', ticketModalOpener: null, ticketModalMode: 'use' };
  const els = {};
  const LOGIN_PROGRESS_TICK_MS = 650;
  let loginProgressTimer = null;
  let loginProgressValue = 8;
  let autoOpenHandled = false;
  let locationTracker = null;
  let ticketReservationBusy = false;
  const expandedReservationTickets = new Set();
  let transferFriendLoadVersion = 0;

  window.addEventListener('DOMContentLoaded', () => {
    window.MemberSystem.bindDialogKeyboard();
    [
      'app', 'loadingView', 'loadingProgress', 'loadingProgressBar', 'loadingProgressText', 'loadingStatus', 'errorView', 'errorTitle', 'errorMessage', 'joinMemberButton', 'retryButton', 'eventView', 'displayName', 'membershipProgress', 'eventSummary', 'eventList', 'emptyView', 'usedTicketHistory', 'usedTicketHistorySummary', 'usedTicketList',
      'ticketModal', 'closeTicketModal', 'ticketModalType', 'ticketModalTitle', 'ticketModalDate', 'ticketModalDescription', 'ticketModalUsageMethod', 'ticketModalUsageInstructions', 'ticketModalServiceRequirement', 'ticketModalAmountRequirement', 'ticketModalPrizes', 'ticketModalStatus', 'ticketModalProcessing', 'ticketModalProcessingText', 'ticketModalResult', 'ticketModalAction', 'refreshTicketButton', 'ticketModalMessage', 'ticketModalLocationStatus', 'ticketModalLocationButton',
      'ticketTransferPanel', 'ticketTransferFriendSelect', 'ticketTransferStatus', 'ticketTransferButton'
    ].forEach((id) => { els[id] = document.getElementById(id); });
    els.retryButton.addEventListener('click', () => window.location.reload());
    els.joinMemberButton.addEventListener('click', () => window.MemberSystem.openMemberJoin(state.config));
    els.closeTicketModal.addEventListener('click', closeTicketModal);
    els.ticketModal.addEventListener('click', (event) => { if (event.target === els.ticketModal && !state.processing) closeTicketModal(); });
    els.ticketModalAction.addEventListener('click', handleTicketAction);
    els.ticketTransferButton.addEventListener('click', () => { void transferTicketToFriend(); });
    els.ticketTransferFriendSelect.addEventListener('change', () => { els.ticketTransferButton.disabled = state.processing || state.actionLocked || !els.ticketTransferFriendSelect.value; });
    els.ticketModalLocationButton.addEventListener('click', () => { void refreshLiveLocation(); });
    window.addEventListener('pagehide', stopLiveLocation);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') stopLiveLocation();
    });
    els.refreshTicketButton.addEventListener('click', () => window.location.reload());
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !state.processing) closeTicketModal(); });
    window.addEventListener('event-ticket:selection-claimed', () => {
      void loadOffers(false).catch(() => {});
    });
    boot();
  });

  async function boot() {
    setView('loading');
    try {
      startLoginProgress('正在取得開啟設定…', 18);
      state.config = await window.MemberSystem.loadConfig();
      startLoginProgress('正在驗證 LINE 身分…', 48);
      state.idToken = await window.MemberSystem.signIn(state.config, 'event');
      startLoginProgress('正在同步活動票券…', 92);
      await loadOffers(false);
      await completeLoginProgress('活動票券已準備完成');
      setView('event');
      window.dispatchEvent(new CustomEvent('user-tour:ready', { detail: { surface: 'event', profile: state.profile } }));
      window.MemberSystem.subscribeRealtime(state.config, 'event', () => {
        window.dispatchEvent(new CustomEvent('event:realtime-refresh'));
        return loadOffers(false);
      });
    } catch (error) { stopLoginProgress(); showError(error); } finally { stopLoginProgress(); els.app.setAttribute('aria-busy', 'false'); }
  }

  async function loadOffers(showBusy) {
    if (showBusy) setInlineStatus('正在更新活動票券…');
    const finishFeedback=showBusy?window.AsyncActionFeedback?.begin('正在載入活動票券…'):null;
    try {
      const result = await window.MemberSystem.request(state.config, 'event', state.idToken, 'user.event.bootstrap', { compact: false });
      applyOfferSnapshot(result);
      assertCompleteEventBootstrap();
      renderOffers();
      window.TicketBookingSelections?.render(result.bookingSelections, {surface:'event',config:state.config,idToken:state.idToken,refresh:()=>loadOffers(false)});
      // A management-side change must also refresh an already-open redemption dialog.
      if (!state.processing && !els.ticketModal.classList.contains('hidden') && state.pendingEventTicketId) {
        const active = findOffer(state.pendingEventTicketId);
        if (active) {
          renderTicketModal(active);
          if (active.ticket.requiresLocation) void refreshLiveLocation();
          else stopLiveLocation();
        } else closeTicketModal();
      }
      if (showBusy) setInlineStatus('活動票券已更新。');
    } catch (error) { if (!showBusy) throw error; if (/^(AUTH_|MEMBERSHIP_REQUIRED|MEMBER_)/.test(String(error && error.code || ''))) showError(error); else setInlineStatus('更新失敗，畫面保留上次資料。請重新整理頁面後重試；使用時會重新驗證資格。', true); } finally { finishFeedback?.(); }
  }

  function setInlineStatus(message, error = false) {
    const status = document.getElementById('syncNotice');
    status.textContent = message;
    status.classList.toggle('hidden', !message);
    status.classList.toggle('is-error', error);
  }

  function applyOfferSnapshot(payload) {
    state.profile = payload && payload.profile && typeof payload.profile === 'object' ? payload.profile : {};
    state.offers = normalizeFixedOffers(Array.isArray(payload && payload.offers) ? payload.offers : [], state.profile);
    state.usedTickets = Array.isArray(payload && payload.usedTickets) ? payload.usedTickets : [];
    const usedTicketCount = Number(payload && payload.usedTicketCount);
    state.usedTicketCount = Number.isInteger(usedTicketCount) && usedTicketCount >= state.usedTickets.length ? usedTicketCount : state.usedTickets.length;
    els.displayName.textContent = String(state.profile.displayName || 'LINE 使用者');
    window.MembershipProgress.render(els.membershipProgress, state.profile);
  }

  function assertCompleteEventBootstrap() {
    const incomplete = state.offers.concat(state.usedTickets).some((offer) => !offerHasDetails(offer));
    if (!incomplete) return;
    const error = new Error('活動票券資料回應不完整，已停止顯示活動票券頁面。請重新整理後再試。');
    error.code = 'EVENT_TICKET_BOOTSTRAP_INCOMPLETE';
    throw error;
  }

  function renderOffers() {
    const hasOffers = state.offers.length > 0;
    const hasUsedTickets = state.usedTicketCount > 0;
    const ineligibleOfferCount = state.offers.filter((offer) => !eventTicketTierEligible(offer)).length;
    els.eventList.replaceChildren(...state.offers.map(createOfferCard));
    els.usedTicketList.replaceChildren(...state.usedTickets.map(createHistoryItem));
    els.emptyView.classList.toggle('hidden', hasOffers);
    els.usedTicketHistory.classList.toggle('hidden', !hasUsedTickets);
    els.usedTicketHistorySummary.textContent = hasUsedTickets ? `共 ${state.usedTicketCount} 筆使用紀錄` : '尚無使用紀錄';
    els.eventSummary.textContent = hasOffers ? `${state.offers.length} 個活動票券 · 一般票券發放後可轉贈已加入的好友${ineligibleOfferCount ? ` · ${ineligibleOfferCount} 張尚未達適用等級` : ''}${hasUsedTickets ? ` · ${state.usedTicketCount} 筆已使用紀錄` : ''}` : hasUsedTickets ? `目前沒有開放中的活動 · ${state.usedTicketCount} 筆已使用紀錄` : '目前沒有開放中的活動';
    autoOpenFromCalendar();
  }


  function bookingRequiredForOffer(offer) {
    return window.TicketBookingChoice?.eventOptions?.(ticketForOffer(offer), offer.eligibleBookings)?.requiresBooking === true;
  }
  // Only owned, currently available, booking-restricted tickets should guide
  // members to a new booking. This is navigation, not redemption or issuance.
  function canGuideToBooking(offer) {
    return Boolean(offer && offer.claim && ['claimed', 'available'].includes(String(offer.claim.status || ''))
      && !offer.history && !offer.transferredOut && !offer.reservedForBooking
      && !offer.pendingSnapshot && !offer.soldOut && !offer.canUse
       && !canBindExistingBooking(offer)
      && offer.availability === 'active' && eventTicketTierEligible(offer)
      && bookingRequiredForOffer(offer) && window.BusinessContext?.allows?.('booking') !== false);
  }
  function canBindExistingBooking(offer) {
    return Boolean(offer && offer.claim && offer.claim.claimId
      && ['claimed', 'available'].includes(String(offer.claim.status || ''))
      && !offer.history && !offer.transferredOut && !offer.reservedForBooking
      && !offer.pendingSnapshot && !offer.soldOut && !state.actionLocked
      && offer.availability === 'active' && eventTicketTierEligible(offer)
      && bookingRequiredForOffer(offer)
      && Array.isArray(offer.eligibleBookings)
      && offer.eligibleBookings.some(booking => booking?.bookingId && booking.bookingId !== 'no-booking'));
  }
  function bookingGuideUrl(offer) {
    const url = new URL('../booking/', window.location.href);
    const business = String(window.BusinessContext?.slug || new URLSearchParams(window.location.search).get('business') || '');
    if (/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(business)) url.searchParams.set('business', business);
    const id = eventTicketIdForOffer(offer);
    if (/^[A-Za-z0-9_-]{1,128}$/.test(id)) url.searchParams.set('eventTicketId', id);
    return url.href;
  }
  function createBookingGuideLink(offer) {
    const link = document.createElement('a');
    link.href = bookingGuideUrl(offer);
    link.className = 'ticket-button ticket-booking-guide';
    link.dataset.ticketAction = 'booking-guide';
    link.dataset.eventTicketId = eventTicketIdForOffer(offer);
    link.textContent = '前往預約使用';
    link.setAttribute('aria-label', '前往預約並勾選「' + String(ticketForOffer(offer).title || '活動票券') + '」');
    return link;
  }

  function createOfferCard(offer) {
    const ticket = ticketForOffer(offer); const history = Boolean(offer.history); const fixed = isFixedOffer(offer); const used = history || String(offer?.claim?.status || '') === 'used'; const reserved = !used && Boolean(offer.reservedForBooking); const snapshotPending = !used && Boolean(offer.pendingSnapshot);
    const eligible = !history && eventTicketTierEligible(offer);
    const stateLabel = used ? '已使用' : offer.availability === 'expired' ? '已到期' : reserved ? '已預約使用' : snapshotPending ? '快照待審核' : !eligible ? '需升級' : offer.claim ? '已發放' : '尚未發放';
    const item = window.EventTicketUI.create(ticket, { history, fixed, stateLabel: offer.transferredOut ? '已轉贈' : stateLabel, stateClass: used ? 'used' : reserved ? 'reserved' : eligible ? offer.availability : 'tier-locked', usedAt: eventTicketTimestamp(offer.claim && offer.claim.usedAt), expiresAt: offer.claim?.expiresAt || null, showServiceRequirement: true, showAmountRequirement: true });
    const eventTicketId = eventTicketIdForOffer(offer);
    const action = document.createElement('div'); action.className = 'event-ticket-action';
    const hint = document.createElement('small');
    hint.textContent = used ? '票券已使用，使用紀錄已保留' : reserved ? '已選入一般預約，將於服務完成時自動核銷' : snapshotPending ? '已選入快照，待管理員審核' : !eligible ? '目前會員等級無法使用' : fixed && !offer.claim ? '符合固定發放條件時會由系統自動發放' : offer.claim ? claimLabel(offer.claim.status) : offer.soldOut ? '活動使用名額已額滿' : offer.availability === 'scheduled' ? '活動開始後即可使用已發放票券' : offer.availability === 'ended' ? '活動已結束' : '點開查看完整說明';
    const buttons = document.createElement('div'); buttons.className = 'event-ticket-action-buttons';
    const button = document.createElement('button'); button.type = 'button';
    button.className = `ticket-button${!history && offer.canUse ? ' accent' : ''}`;
    button.dataset.eventTicketId = eventTicketId;
    const bindable = canBindExistingBooking(offer);
    button.dataset.ticketAction = bindable ? 'bind-booking' : offer.claim && offer.canUse ? 'use' : 'details';
    button.textContent = history ? '查看紀錄' : reserved ? '已預約使用' : snapshotPending ? '快照待審核' : !eligible ? '查看詳情' : offer.claim ? bindable ? '綁定已有預約使用' : offer.canUse ? '使用票券' : '查看詳情' : '查看詳情';
    button.disabled = !eventTicketId;
    if (offer.transferredOut) { button.textContent = '已轉贈好友'; }
    button.addEventListener('click', () => openTicketModal(eventTicketId));
    if (offer.transferredOut) hint.textContent = '這張票券已轉贈好友，無法再次取得';
    if (!used || history) buttons.append(button);
    if (canGuideToBooking(offer)) {
      buttons.append(createBookingGuideLink(offer));
      hint.textContent = '這張票券已發放。請先到預約頁選擇日期、服務與時段，再於送出前勾選這張活動票券。';
    }
    if (canTransferTicket(offer)) {
      const transferButton = document.createElement('button');
      transferButton.type = 'button';
      transferButton.className = 'ticket-button ticket-button-secondary';
      transferButton.dataset.ticketAction = 'transfer';
      transferButton.textContent = '轉贈好友';
      transferButton.addEventListener('click', () => openTicketModal(eventTicketId, { focusTransfer: true }));
      buttons.append(transferButton);
    }
    if (!used && offer.claim?.expiresAt) {
      hint.textContent = `${hint.textContent ? hint.textContent + ' · ' : ''}獲得後 ${ticket.validityDays} 天有效 · 到期 ${eventTicketTimestamp(offer.claim.expiresAt)}${offer.availability === 'expired' ? ' · 已到期' : ''}`;
    }
    action.append(hint);
    if (buttons.childElementCount) action.append(buttons);
    item.append(action);
    const ref = String(offer?.claim?.claimId || '');
    const reservationDetails = window.TicketBookingSelections?.createTicketReservationDisclosure({
      title: String(ticket.title || '活動票券'),
      bookingSelections: offer.bookingSelections,
      pendingSnapshots: offer.pendingSnapshots,
      expanded: expandedReservationTickets.has(ref),
      onToggle: (open) => {
        if (open) expandedReservationTickets.add(ref);
        else expandedReservationTickets.delete(ref);
      },
      onCancelBooking: async (context) => {
        if (ticketReservationBusy || !ref) return;
        ticketReservationBusy = true;
        const finishFeedback=window.AsyncActionFeedback?.begin('正在取消活動票券預約使用…');
        try {
          await window.TicketBookingSelections.cancelTicket(context.bookingId, 'event', ref);
        } catch (error) {
          window.alert(error?.message || '取消活動票券一般預約失敗，請更新後重試。');
        } finally {
          finishFeedback?.();
          ticketReservationBusy = false;
          renderOffers();
        }
      },
      onCancelSnapshot: async (snapshot) => {
        if (ticketReservationBusy || !ref) return;
        if (!window.confirm(`確定取消「${ticket.title || '活動票券'}」在這筆快照中的使用意願？其他預約與票券將保留。`)) return;
        ticketReservationBusy = true;
        const finishFeedback=window.AsyncActionFeedback?.begin('正在取消活動快照票券…');
        try {
          await window.MemberSystem.request(state.config, 'event', state.idToken,
            'user.event.snapshot-ticket.cancel', {
              receiptId: snapshot.receiptId, ticketId: ref, expectedUpdatedAt: snapshot.updatedAt
            });
          await loadOffers(false);
        } catch (error) {
          window.alert(error?.message || '取消活動票券快照失敗，請更新後重試。');
        } finally {
          finishFeedback?.();
          ticketReservationBusy = false;
          renderOffers();
        }
      }
    });
    if (reservationDetails) item.append(reservationDetails);
    return item;
  }

  function createHistoryItem(offer) {
    const ticket = ticketForOffer(offer);
    const item = document.createElement('li'); item.className = 'event-history-item';
    const button = document.createElement('button'); button.type = 'button'; button.className = 'event-history-button'; button.dataset.eventTicketId = eventTicketIdForOffer(offer); button.addEventListener('click', () => openTicketModal(eventTicketIdForOffer(offer), { preferHistory: true }));
    const title = document.createElement('strong'); title.textContent = String(ticket.title || '活動票券');
    const meta = document.createElement('span'); meta.textContent = `使用於 ${eventTicketTimestamp(offer.claim && offer.claim.usedAt)}`;
    const result = document.createElement('small'); result.textContent = ticket.ticketType === 'lottery' && offer.claim && offer.claim.result ? `抽獎結果：${offer.claim.result.prizeTitle || '結果已記錄'}` : '核銷完成 · 點擊查看紀錄';
    button.append(title, meta, result); item.append(button); return item;
  }

  async function openTicketModal(eventTicketId, options = {}) {
    const targetId = String(eventTicketId || '').trim();
    const offer = findOffer(targetId, options);
    if (!offer) return;
    stopLiveLocation();
    state.pendingEventTicketId = targetId;
    state.ticketModalMode = options.focusTransfer && canTransferTicket(offer) ? 'transfer' : 'use';
    state.processing = false;
    state.actionLocked = targetId === String(state.uncertainEventTicketId || '').trim();
    state.ticketModalOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    els.ticketModalResult.classList.add('hidden');
    els.ticketModalResult.replaceChildren();
    renderTicketModal(offer);
    if (state.actionLocked) showMessage('無法確認這次操作是否完成。請先重新整理確認；在確認前請勿再次送出。');
    else hideMessage();
    setProcessing(false);
    els.ticketModal.classList.remove('hidden');
    if (state.ticketModalMode === 'transfer') void loadTransferFriends(offer, true);
    else if (offer.claim && offer.ticket.requiresLocation && !offer.history && !offer.reservedForBooking) void refreshLiveLocation();
    const focusTarget = offer.history || state.ticketModalMode === 'transfer'
      ? els.closeTicketModal
      : state.actionLocked ? els.refreshTicketButton
      : els.ticketModalAction.classList.contains('hidden') ? els.closeTicketModal : els.ticketModalAction;
    focusTarget.focus();
  }

  function offerHasDetails(offer) {
    const claim = offer && offer.claim;
    const ticket = offer && offer.ticket;
    return Boolean((claim && Object.prototype.hasOwnProperty.call(claim, 'ticketDescription')) || (ticket && Object.prototype.hasOwnProperty.call(ticket, 'description')));
  }

  function replaceOffer(nextOffer) {
    const eventTicketId = eventTicketIdForOffer(nextOffer);
    const replace = (offer) => eventTicketIdForOffer(offer) === eventTicketId ? nextOffer : offer;
    if (nextOffer.history) state.usedTickets = state.usedTickets.map(replace); else state.offers = state.offers.map(replace);
  }

  function renderTicketModal(offer) {
    const ticket = ticketForOffer(offer); const claim = offer.claim; const history = Boolean(offer.history); const reserved = !history && Boolean(offer.reservedForBooking);
    const transferMode = state.ticketModalMode === 'transfer' && canTransferTicket(offer);
    els.ticketModal.dataset.ticketMode = transferMode ? 'transfer' : 'use';
    els.ticketModalType.textContent = isFixedOffer(offer) ? '固定票券' : ticket.ticketType === 'lottery' ? '活動抽獎券' : ticket.ticketType === 'referral' ? '好友邀請券' : ticket.ticketType === 'membership_join' ? '加入會員券' : '活動優惠券'; els.ticketModalTitle.textContent = String(ticket.title || '活動票券'); els.ticketModalDate.textContent = history ? `已使用：${eventTicketTimestamp(claim && claim.usedAt)}` : `${eventDates(ticket, claim)}${isFixedOffer(offer) ? '' : ` · 使用數量上限：${eventTicketQuotaText(ticket)}`}`; els.ticketModalDescription.textContent = String(ticket.description || '查看活動內容與使用說明。'); els.ticketModalUsageMethod.textContent = `使用方式：${String(ticket.usageMethod || '請依活動現場指示使用')}`; els.ticketModalUsageInstructions.textContent = String(ticket.usageInstructions || '票券發放後請在活動期間出示本券。');
    if (transferMode) els.ticketModalType.textContent = `轉贈好友 · ${els.ticketModalType.textContent}`;
    els.ticketModal.querySelector('.instructions')?.classList.toggle('hidden', transferMode);
    const serviceRequirement = String(ticket.requiredServiceRequirementLabel || '').trim();
    els.ticketModalServiceRequirement.textContent = serviceRequirement ? `預約項目條件：${serviceRequirement}` : '';
    els.ticketModalServiceRequirement.classList.toggle('hidden', !serviceRequirement);
    const amountRequirement = String(ticket.minBookingAmountLabel || '').trim();
    els.ticketModalAmountRequirement.textContent = amountRequirement ? `金額使用條件：${amountRequirement}` : '';
    els.ticketModalAmountRequirement.classList.toggle('hidden', !amountRequirement);
    renderPrizes(ticket.ticketType, ticket.prizes);
    const needsGps = Boolean(!transferMode && claim && ticket.requiresLocation && !history && !reserved && !offer.pendingSnapshot);
    els.ticketModalLocationStatus.classList.toggle('hidden', !needsGps);
    els.ticketModalLocationButton.classList.toggle('hidden', !needsGps);
    els.ticketModalLocationButton.disabled = state.processing;
    if (claim && ticket.requiresLocation && !history) els.ticketModalLocationStatus.textContent = `可使用地點：${window.TicketLiveLocation.allowedLocationLabel(ticket.redemptionLocations)}。正在檢查 GPS；核銷前需確認定位。`;
    let bookingChoice = els.ticketModal.querySelector('[data-ticket-booking-choice]');
    if (!bookingChoice) { bookingChoice = document.createElement('div'); bookingChoice.dataset.ticketBookingChoice = ''; els.ticketModalStatus.before(bookingChoice); }
    const choiceMode = window.TicketBookingChoice?.eventOptions?.(ticket, offer.eligibleBookings)
      || { requiresBooking: true, bookings: [] };
    bookingChoice.hidden = transferMode || history || !claim || reserved || !choiceMode.requiresBooking;
    if (transferMode) bookingChoice.replaceChildren();
    else window.TicketBookingChoice?.mount(bookingChoice, choiceMode.bookings, () => { els.ticketModalAction.disabled = !(canBindExistingBooking(offer) || offer.canUse) || !window.TicketBookingChoice.selected(bookingChoice); if (needsGps) syncLiveLocationState(offer); });
    let modalGuide = els.ticketModal.querySelector('[data-ticket-booking-guide]');
    if (!modalGuide) {
      modalGuide = document.createElement('a');
      modalGuide.dataset.ticketBookingGuide = '';
      modalGuide.className = 'modal-action ticket-booking-guide';
      els.ticketModalAction.before(modalGuide);
    }
    modalGuide.hidden = transferMode || !canGuideToBooking(offer);
    if (!modalGuide.hidden) {
      modalGuide.href = bookingGuideUrl(offer);
      modalGuide.textContent = '前往預約使用（預約時勾選這張票券）';
    } else {
      modalGuide.removeAttribute('href');
    }
    const bindable = canBindExistingBooking(offer);
    const canTransfer = canTransferTicket(offer);
    els.ticketTransferPanel.hidden = !canTransfer || !transferMode;
    els.ticketTransferFriendSelect.disabled = state.processing || state.actionLocked || !transferMode || !canTransfer || els.ticketTransferFriendSelect.options.length <= 1;
    els.ticketTransferButton.disabled = state.processing || state.actionLocked || !transferMode || !canTransfer || !els.ticketTransferFriendSelect.value;
    const eligible = !history && eventTicketTierEligible(offer); const fixedPending = isFixedOffer(offer) && !claim; const canAct = !transferMode && !state.actionLocked && !history && !reserved && eligible && !fixedPending && Boolean(claim && (bindable || offer.canUse));
    els.ticketModalStatus.textContent = transferMode ? '目前為轉贈好友流程，請選擇好友並確認；轉贈後不可撤銷，也無法再自行使用。' : offer.locked ? String(offer.lockReason || '需符合指定會員階級。') : modalStatusText(offer); els.ticketModalAction.textContent = state.actionLocked ? '請重新整理確認' : history ? '這張票券已使用' : reserved ? '已預約使用' : !eligible ? '目前等級無法使用' : fixedPending ? '由系統自動發放' : claim ? bindable ? '綁定已有預約使用' : offer.canUse ? '確認使用這張票券' : '尚無符合條件的預約' : '票券尚未發放'; els.ticketModalAction.disabled = !canAct || Boolean(claim && !window.TicketBookingChoice?.selected(bookingChoice)); els.ticketModalAction.classList.toggle('hidden', transferMode || history || Boolean(offer.transferredOut) || Boolean(claim && !offer.canUse && !bindable && eligible) && !state.actionLocked); els.refreshTicketButton.classList.toggle('hidden', !state.actionLocked); if (needsGps) syncLiveLocationState(offer);
    if (history && claim && ticket.ticketType === 'lottery' && claim.result) {
      renderRedeemedResult({ ...claim, ticketType: 'lottery' });
    }
  }

  function renderPrizes(ticketType, prizes) {
    if (ticketType !== 'lottery' || !Array.isArray(prizes) || !prizes.length) { els.ticketModalPrizes.classList.add('hidden'); els.ticketModalPrizes.replaceChildren(); return; }
    const heading = document.createElement('strong'); heading.textContent = '有機會獲得'; const list = document.createElement('ul'); prizes.filter((prize) => String(prize && prize.prizeTitle || '').trim()).forEach((prize) => { const item = document.createElement('li'); item.textContent = String(prize.prizeTitle || '').trim(); list.append(item); }); els.ticketModalPrizes.replaceChildren(heading, list); els.ticketModalPrizes.classList.toggle('hidden', !list.children.length);
  }

  function closeTicketModal() { if (state.processing) return; ++transferFriendLoadVersion; stopLiveLocation(); state.pendingEventTicketId = ''; state.ticketModalMode = 'use'; els.ticketModal.classList.add('hidden'); setProcessing(false); hideMessage(); els.ticketModalResult.classList.add('hidden'); els.ticketModalResult.replaceChildren(); const opener = state.ticketModalOpener; state.ticketModalOpener = null; if (opener instanceof HTMLElement && document.contains(opener)) opener.focus(); }

  function canTransferTicket(offer) {
    const ticket = ticketForOffer(offer || {});
    return Boolean(
      offer && offer.claim && offer.claim.claimId && offer.claim.status === 'available'
      && !offer.history && !offer.reservedForBooking && !offer.pendingSnapshot
      && !offer.transferredOut && !offer.receivedAsGift && offer.availability === 'active'
      && !isFixedOffer(offer)
      && ['coupon', 'lottery'].includes(String(ticket.ticketType || ''))
    );
  }

  async function loadTransferFriends(offer, focusTransfer = false) {
    const generation = ++transferFriendLoadVersion;
    const select = els.ticketTransferFriendSelect;
    select.replaceChildren(new Option('正在載入好友…', ''));
    select.disabled = true;
    els.ticketTransferButton.disabled = true;
    els.ticketTransferStatus.textContent = '正在確認已加入的好友…';
    const finishFeedback=window.AsyncActionFeedback?.begin('正在取得可轉贈的好友名單…');
    try {
      const result = await window.MemberSystem.request(state.config, 'event', state.idToken, 'member.friend.list');
      if (generation !== transferFriendLoadVersion || state.ticketModalMode !== 'transfer' || state.pendingEventTicketId !== eventTicketIdForOffer(offer) || !canTransferTicket(offer)) return;
      const ownCode = String(state.profile?.memberCode || '').toUpperCase();
      const friends = (Array.isArray(result?.friends) ? result.friends : []).filter(friend => (
        friend.status === 'accepted' && /^[A-Za-z0-9_-]{4,40}$/.test(String(friend.memberCode || ''))
        && String(friend.memberCode).toUpperCase() !== ownCode
      ));
      select.replaceChildren(new Option('請選擇要轉贈的好友', ''));
      for (const friend of friends) {
        select.add(new Option(String(friend.displayName || '好友') + ' · ' + friend.memberCode, friend.memberCode));
      }
      select.disabled = !friends.length || state.processing || state.actionLocked;
      els.ticketTransferStatus.textContent = friends.length
        ? '每張票券限轉贈一次，受贈好友不受原票券會員階級限制；轉贈後無法撤銷，自己也無法使用。'
        : '目前沒有已接受的好友，請先到會員中心加入好友，等對方接受後再轉贈。';
      if (focusTransfer && friends.length) select.focus();
    } catch (error) {
      if (generation === transferFriendLoadVersion) {
        select.replaceChildren(new Option('無法載入好友', ''));
        select.disabled = true;
        els.ticketTransferStatus.textContent = error?.message || '好友資料暫時無法載入，請稍後再試。';
      }
    } finally { finishFeedback?.(); }
  }

  async function transferTicketToFriend() {
    const offer = findOffer(state.pendingEventTicketId);
    const receiverMemberCode = String(els.ticketTransferFriendSelect.value || '');
    if (state.ticketModalMode !== 'transfer' || !canTransferTicket(offer) || state.processing || state.actionLocked
      || !/^[A-Za-z0-9_-]{4,40}$/.test(receiverMemberCode)) return;
    const recipient = els.ticketTransferFriendSelect.selectedOptions[0]?.textContent || '此好友';
    if (!window.confirm(`確定將「${ticketForOffer(offer).title || '活動票券'}」轉贈給 ${recipient}？\n每張票券限轉贈一次，好友收到後無會員階級使用限制，但仍須符合有效期與其他使用條件。\n確認後不可撤銷、不可再次轉贈，你也無法再使用。`)) return;
    state.processing = true;
    const finishFeedback=window.AsyncActionFeedback?.begin('正在轉贈活動票券並同步資料…');
    try {
    setProcessing(true);
    els.ticketModalProcessingText.textContent = '正在確認好友關係及票券所有權…';
    els.ticketTransferButton.disabled = true;
    els.ticketModalAction.disabled = true;
    hideMessage();
    let transferred = false;
    try {
      const result = await window.MemberSystem.request(state.config, 'event', state.idToken,
        'user.event.ticket.transfer', {
          claimId: offer.claim.claimId,
          receiverMemberCode,
          requestId: crypto.randomUUID().replaceAll('-', ''),
        });
      transferred = Boolean(result && result.claimId === offer.claim.claimId);
      if (!transferred) throw new Error('轉贈回應不完整，請重新整理確認票券狀態。');
    } catch (error) {
      if (error?.code === 'API_RESPONSE_UNCERTAIN') {
        handleTicketError(error, '無法確認轉贈結果，請重新整理確認。');
      } else {
        showMessage(error?.message || '轉贈失敗，請確認好友關係與票券狀態。');
      }
    } finally {
      state.processing = false;
      setProcessing(false);
      const current = findOffer(state.pendingEventTicketId);
      if (current) renderTicketModal(current);
    }
    if (transferred) {
      closeTicketModal();
      try {
        await loadOffers(false);
        setInlineStatus('活動票券已成功轉贈給好友。');
      } catch (_) {
        setInlineStatus('轉贈已完成，但資料更新失敗，請重新整理確認。');
      }
    }
    } finally { finishFeedback?.(); }
  }

  async function handleTicketAction() {
    const offer = findOffer(state.pendingEventTicketId); if (!offer || state.ticketModalMode === 'transfer' || state.processing || state.actionLocked) return;
    if (offer.history || offer.reservedForBooking) return;
    if (!eventTicketTierEligible(offer)) return;
    if (canBindExistingBooking(offer)) return bindTicketToExistingBooking(offer);
    if (offer.claim && offer.canUse) return redeemTicket(offer);
  }

  async function bindTicketToExistingBooking(offer) {
    const container = els.ticketModal.querySelector('[data-ticket-booking-choice]');
    const bookingId = window.TicketBookingChoice?.selected(container);
    const allowed = offer.eligibleBookings?.some(item => item.bookingId === bookingId);
    if (!allowed || !canBindExistingBooking(offer)) {
      showMessage('請選擇符合條件的本人已確認預約。');
      return;
    }
    if (!window.confirm('確定將「' + String(ticketForOffer(offer).title || '活動票券') + '」綁定至選取的預約？票券將於該次服務完成時依規則核銷。')) return;
    state.processing = true;
    setProcessing(true);
    els.ticketModalAction.disabled = true;
    const finishFeedback = window.AsyncActionFeedback?.begin('正在綁定票券至已有預約…');
    try {
      await window.TicketBookingSelections.bindEventTicket(bookingId, offer.claim.claimId);
      state.processing = false;
      closeTicketModal();
      setInlineStatus('已綁定至已有預約；服務完成時依規則核銷。');
    } catch (error) {
      showMessage(error?.message || '綁定預約失敗，請重新載入後重試。');
    } finally {
      finishFeedback?.();
      state.processing = false;
      setProcessing(false);
      const latest = findOffer(state.pendingEventTicketId);
      if (latest && !els.ticketModal.classList.contains('hidden')) renderTicketModal(latest);
    }
  }

  async function redeemTicket(offer) {
    const bookingChoice = els.ticketModal.querySelector('[data-ticket-booking-choice]');
    const bookingId = window.TicketBookingChoice?.selected(bookingChoice);
    if (!offer.canUse || !bookingId) { showMessage('請選擇符合條件的已確認預約。', true); return; }
    window.TicketBookingChoice.lock(bookingChoice, true);
    state.processing = true; els.ticketModalAction.disabled = true; els.ticketModalAction.textContent = '確認中…'; els.ticketModalProcessingText.textContent = '正在確認核銷條件…'; setProcessing(true); hideMessage();
    let redeemed = false;
    let finishFeedback=null;
    try {
      let location = offer.ticket.requiresLocation ? await currentRedemptionLocation() : null;
      const check = offer.ticket.requiresLocation ? checkLocation(offer, location) : null;
      if (check && !check.allowed) throw new Error(locationFailureMessage(offer, check));
      const locationMessage = check
        ? `\n可使用地點：${window.TicketLiveLocation.allowedLocationLabel(offer.ticket.redemptionLocations)}\n目前 GPS 位於「${check.matched.name}」可使用範圍內（精度 ±${Math.round(location.accuracy)} 公尺）。\n`
        : '';
      if (!window.confirm(`確定現在使用「${String(offer.ticket.title || '活動票券')}」？${locationMessage}確認後將立即核銷且無法復原。`)) return;
      els.ticketModalProcessingText.textContent = '正在核銷票券，請稍候…';
      finishFeedback=window.AsyncActionFeedback?.begin('正在核銷活動票券並更新資料…');
      // Recheck after confirmation; server rechecks the authoritative current rule.
      if (offer.ticket.requiresLocation) {
        location = await currentRedemptionLocation();
        const latestOffer = findOffer(state.pendingEventTicketId) || offer;
        const latestCheck = checkLocation(latestOffer, location);
        if (!latestCheck.allowed) throw new Error(locationFailureMessage(latestOffer, latestCheck));
      }
      const usageKey = bookingId + ':' + offer.claim.claimId;
      if (state.usageAttempt?.key !== usageKey) state.usageAttempt = { key: usageKey, requestId: 'EVENT_' + crypto.randomUUID().replaceAll('-', '') };
      const result = await window.MemberSystem.request(state.config, 'event', state.idToken, 'user.event.ticket.redeem', { claimId: offer.claim.claimId, bookingId, requestId: state.usageAttempt.requestId, location });
      if (result.ticket) {
        redeemed = true;
        state.usageAttempt = null;
        bookingChoice.hidden = true;
        updateOfferClaim(offer.ticket.eventTicketId, result.ticket);
        setProcessing(false);
        // The redeem mutation is already durable at this point. Show that result before
        // non-critical list rendering so a render race cannot hide a successful mutation.
        await showRedeemedResult(result.ticket);
        renderOffers();
        window.dispatchEvent(new CustomEvent('event-ticket:redeemed', { detail: { ticket: result.ticket } }));
      }
    } catch (error) { handleTicketError(error, '使用票券失敗，請稍後再試。'); } finally { finishFeedback?.(); window.TicketBookingChoice?.lock(bookingChoice, false); setProcessing(false); state.processing = false; if (!redeemed && !state.actionLocked) renderTicketModal(offer); }
  }

  function currentRedemptionLocation() {
    els.ticketModalLocationStatus.classList.remove('hidden');
    els.ticketModalLocationStatus.textContent = '正在持續取得 GPS，需精度 100 公尺內的最新位置…';
    return liveLocation().read();
  }

  function stopLiveLocation() {
    locationTracker?.stop();
    locationTracker = null;
  }

  function checkLocation(offer, fix) {
    return window.TicketLiveLocation.evaluate(fix, offer?.ticket?.redemptionLocations);
  }

  function locationFailureMessage(offer, result) {
    const allowed = window.TicketLiveLocation.allowedLocationLabel(offer?.ticket?.redemptionLocations);
    if (result.reason === 'missing') return '尚未取得管理端設定的可使用地點，請稍後再試。';
    if (result.reason === 'waiting') return `請允許 GPS 並取得精度 100 公尺內的即時位置；可使用地點：${allowed}。`;
    return `目前不在可使用範圍，請至 ${allowed} 後再使用。`;
  }

  function syncLiveLocationState(offer = findOffer(state.pendingEventTicketId)) {
    if (!offer || !offer.ticket.requiresLocation || !offer.claim || offer.history || offer.reservedForBooking) return;
    if (!window.TicketLiveLocation) return;
    const fix = locationTracker?.latest();
    const check = checkLocation(offer, fix);
    const allowed = window.TicketLiveLocation.allowedLocationLabel(offer.ticket.redemptionLocations);
    const status = check.allowed
      ? `目前 GPS 符合「${check.matched.name}」的可使用範圍（精度 ±${Math.round(fix.accuracy)} 公尺）。`
      : locationFailureMessage(offer, check);
    els.ticketModalLocationStatus.textContent = `可使用地點：${allowed}。 ${status}`;
    const bookingChoice = els.ticketModal.querySelector('[data-ticket-booking-choice]');
    els.ticketModalAction.disabled = state.processing || state.actionLocked || !offer.canUse ||
      !window.TicketBookingChoice?.selected(bookingChoice) || !check.allowed;
  }

  function updateLiveLocation() {
    if (els.ticketModal.classList.contains('hidden')) return;
    syncLiveLocationState();
  }

  function liveLocation() {
    if (!window.TicketLiveLocation) throw new Error('GPS 模組尚未載入，請重新開啟活動票券。');
    if (!locationTracker) locationTracker = window.TicketLiveLocation.create({
      onUpdate: updateLiveLocation,
      onError: (message) => {
        const offer = findOffer(state.pendingEventTicketId);
        els.ticketModalLocationStatus.textContent = `${message}。可使用地點：${window.TicketLiveLocation.allowedLocationLabel(offer?.ticket?.redemptionLocations)}。`;
        els.ticketModalAction.disabled = true;
      }
    });
    return locationTracker;
  }

  async function refreshLiveLocation() {
    if (els.ticketModal.classList.contains('hidden')) return;
    const offer = findOffer(state.pendingEventTicketId);
    if (!offer?.ticket?.requiresLocation || !offer.claim || offer.history || offer.reservedForBooking) return;
    syncLiveLocationState(offer);
    try {
      await liveLocation().read();
      syncLiveLocationState(findOffer(state.pendingEventTicketId));
    } catch (error) {
      if (!els.ticketModal.classList.contains('hidden')) {
        els.ticketModalLocationStatus.textContent = `${error?.message || '無法取得 GPS'}。可使用地點：${window.TicketLiveLocation.allowedLocationLabel(offer.ticket.redemptionLocations)}。`;
        els.ticketModalAction.disabled = true;
      }
    }
  }

  async function showRedeemedResult(claim) {
    els.ticketModalAction.classList.add('hidden');
    els.ticketModalResult.classList.remove('hidden');
    if (claim.ticketType === 'lottery' && claim.result && document.visibilityState === 'visible') {
      els.ticketModalStatus.textContent = '開獎中，請稍候…';
      const reveal = document.createElement('div'); reveal.className = 'lottery-reveal'; reveal.textContent = '✦ 抽獎中 ✦';
      els.ticketModalResult.replaceChildren(reveal);
      await new Promise((resolve) => window.setTimeout(resolve, 1350));
    }
    // Background tabs heavily throttle timers; the animation is decorative, while the
    // persisted prize result is functional state and must be rendered immediately.
    renderRedeemedResult(claim);
    showMessage(claim.ticketType === 'lottery' ? '票券已完成核銷；抽獎結果已保存到使用紀錄。' : '活動票券已完成核銷，使用紀錄已保存。', true);
  }

  function renderRedeemedResult(claim) {
    els.ticketModalResult.classList.remove('hidden');
    if (claim.ticketType === 'lottery' && claim.result) {
      els.ticketModalStatus.textContent = '開獎完成，結果已保存。';
      const resultBox = document.createElement('div'); resultBox.className = 'lottery-result';
      const label = document.createElement('span'); label.textContent = '本次抽獎結果';
      const title = document.createElement('strong'); title.textContent = claim.result.prizeTitle || '本次抽獎結果已記錄';
      resultBox.append(label, title);
      if (claim.result.prizeDescription) { const description = document.createElement('p'); description.textContent = claim.result.prizeDescription; resultBox.append(description); }
      els.ticketModalResult.replaceChildren(resultBox);
    } else {
      els.ticketModalStatus.textContent = '票券已成功使用。';
      const resultBox = document.createElement('div'); resultBox.className = 'ticket-success'; resultBox.textContent = '這張活動票券已成功使用，請向現場工作人員兌換。';
      els.ticketModalResult.replaceChildren(resultBox);
    }
  }
  function updateOfferClaim(eventTicketId, claim) { const current = findOffer(eventTicketId); if (String(claim.status || '') === 'used') { const isNewHistory = !state.usedTickets.some((offer) => eventTicketIdForOffer(offer) === eventTicketId); state.offers = state.offers.filter((offer) => offer.ticket && offer.ticket.eventTicketId !== eventTicketId); const historyTicket = { ...(current || {}), ticket: ticketForOffer({ ...(current || {}), claim }), claim, availability: 'used', tierEligible: true, canClaim: false, canUse: false, soldOut: false, history: true }; state.usedTickets = [historyTicket, ...state.usedTickets.filter((offer) => !offer.ticket || offer.ticket.eventTicketId !== eventTicketId)]; if (isNewHistory) state.usedTicketCount += 1; return; } state.offers = state.offers.map((offer) => offer.ticket && offer.ticket.eventTicketId === eventTicketId ? { ...offer, claim, canClaim: false, canUse: eventTicketTierEligible(offer) && claim.status === 'available' && Boolean(offer.eligibleBookings?.length), soldOut: false } : offer); }
  function fixedEventTicketId(offer) {
    return String(offer?.ticket?.eventTicketId || offer?.claim?.eventTicketId || offer?.eventTicketId || '').trim();
  }
  function isFixedOffer(offer) { return fixedEventTicketId(offer).startsWith('FIXED-'); }
  function normalizeFixedOffers(offers) {
    // Fixed tickets are server-issued benefits. A fixed ticket without a member claim
    // must never be rendered as a pending/public offer, even if a stale API response contains it.
    return offers.filter((offer) => !isFixedOffer(offer) || Boolean(offer?.claim));
  }
  function autoOpenFromCalendar() {
    if (autoOpenHandled) return;
    let params;
    try { params = new URLSearchParams(window.location.search); } catch (_) { return; }
    if (params.get('source') !== 'event-ticket-calendar') return;
    const eventTicketId = String(params.get('eventTicketId') || '').trim();
    if (!eventTicketId || !findOffer(eventTicketId)) return;
    autoOpenHandled = true;
    openTicketModal(eventTicketId);
  }
  function eventTicketIdForOffer(offer) { const ticket = offer && offer.ticket || {}; const claim = offer && offer.claim || {}; return String(ticket.eventTicketId || claim.eventTicketId || '').trim(); }
  function findOffer(eventTicketId, options = {}) {
    const targetId = String(eventTicketId || '').trim();
    if (!targetId) return null;
    const activeOffer = state.offers.find((offer) => eventTicketIdForOffer(offer) === targetId) || null;
    const historyOffer = state.usedTickets.find((offer) => eventTicketIdForOffer(offer) === targetId) || null;
    if (options.preferHistory === true) return historyOffer || activeOffer || null;
    if (activeOffer && String(activeOffer?.claim?.status || '') === 'used' && historyOffer) return historyOffer;
    return activeOffer || historyOffer || null;
  }
  function ticketForOffer(offer) {
    const ticket = offer && offer.ticket || {};
    const claim = offer && offer.claim;
    if (!claim) return ticket;
    // An unredeemed claim belongs to the latest server-authorized ticket. Its
    // issuance snapshot is not the current offer after an admin edits the template.
    // Used tickets, however, must retain the details/prize odds at redemption.
    if (!offer.history && String(claim.status || '') !== 'used' && ticket.eventTicketId) return ticket;
    return {
      ...ticket, title: String(claim.ticketTitle || ticket.title || ''),
      ticketType: claim.ticketType || ticket.ticketType,
      description: String(claim.ticketDescription || ticket.description || ''),
      usageMethod: String(claim.usageMethod || ticket.usageMethod || ''),
      usageInstructions: String(claim.usageInstructions || ticket.usageInstructions || ''),
      prizes: Array.isArray(claim.prizes) ? claim.prizes : ticket.prizes
    };
  }
  function modalStatusText(offer) { if (offer.receivedAsGift) return offer.canUse ? '好友贈送票券：使用時不受會員階級限制，仍須符合預約與活動規則；每張票券只能轉贈一次。' : '好友贈送票券：不受會員階級限制，仍須符合原活動期限、預約及其他使用條件；不可再次轉贈。'; if (offer.transferredOut) return '這張票券已轉贈給好友，無法再次取得或使用。'; if (offer.history) return `這張票券已於 ${eventTicketTimestamp(offer.claim && offer.claim.usedAt)} 使用；內容與結果會保留在此紀錄。`; if (offer.availability === 'expired') return '這張票券已超過獲得後使用期限，無法核銷、轉贈或新增預約綁定。'; if (offer.reservedForBooking) return '這張票券已預約使用，將於該次預約服務完成時自動核銷。'; if (offer.pendingSnapshot) return '這張票券已選入快照預約，正等待管理員審核。'; if (!eventTicketTierEligible(offer)) return `這張票券只適用於${eventTicketAllowedTiers(ticketForOffer(offer))}；目前會員等級無法領取或使用。`; if (isFixedOffer(offer) && !offer.claim) return '符合固定票券的發放條件後，系統會自動發到你的會員帳戶，不需要手動領取。'; if (offer.claim) return canGuideToBooking(offer) ? '這張票券已發放。請至預約頁選擇日期、服務項目與時段，在送出預約前勾選此券；服務完成時依規則核銷。' : offer.canUse ? (window.TicketBookingChoice?.eventOptions?.(ticketForOffer(offer), offer.eligibleBookings)?.requiresBooking ? '這張票券已發放；選擇對應預約並確認後，票券會完成核銷。' : '這張票券已發放；確認後可直接使用並核銷。') : String(offer.usageDisabledReason || '需先有管理員已確認、尚未完成且符合項目條件的預約。'); if (offer.soldOut) return '這張活動票券的使用名額已額滿；已發放的票券仍會保留。'; if (offer.availability === 'scheduled') return '活動尚未開始，開始後即可使用已發放的票券。'; if (offer.availability === 'ended') return '活動已結束，這張票券目前無法使用。'; return '活動票券由系統發放至符合條件的 LINE 會員帳戶，不需要另外領取。'; }
  function claimLabel(status) { return status === 'used' ? '已使用' : '已發放，可使用'; }
  function eventTicketTierEligible(offer) { return offer && offer.tierEligible !== false; }
  function eventTicketAllowedTiers(ticket) { const labels = ticket && ticket.allowedTierLabels; return Array.isArray(labels) && labels.length ? labels.join('、') : '全部會員等級'; }
  function eventTicketQuotaText(ticket) { const quota = Number(ticket && ticket.quota || 0); const usedCount = Math.max(0, Number(ticket && ticket.usedCount || 0)); if (!Number.isFinite(quota) || quota <= 0) return `不限量（已使用 ${usedCount} 次）`; return `${quota} 次（已使用 ${usedCount} 次，剩餘 ${Math.max(0, quota - usedCount)} 次）`; }
  function availabilityLabel(value) { return ({ open: '進行中', scheduled: '即將開始', ended: '已結束', expired: '已到期' })[value] || '活動票券'; }
  function eventDates(ticket, claim) { if (ticket.validityMode && ticket.validityMode !== 'fixed') { const deadline = claim?.expiresAt ? ` · 使用至 ${eventTicketTimestamp(claim.expiresAt)}` : ''; return `獲得後 ${ticket.validityDays} 天有效${deadline}`; } const starts = ticket.startsOn || '即日起'; const ends = ticket.endsOn || '不限期'; return `${starts} — ${ends}`; }
  function eventTicketTimestamp(value) { const timestamp = String(value || '').trim(); if (!timestamp) return '時間已記錄'; const date = new Date(timestamp); if (Number.isNaN(date.getTime())) return timestamp; return new Intl.DateTimeFormat('zh-Hant-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date); }
  function setProcessing(processing) { els.ticketModalProcessing.classList.toggle('hidden', !processing); els.ticketModal.setAttribute('aria-busy', String(Boolean(processing))); }
  function showMessage(message, success) { els.ticketModalMessage.textContent = message; els.ticketModalMessage.classList.toggle('success', Boolean(success)); els.ticketModalMessage.classList.remove('hidden'); }
  function hideMessage() { els.ticketModalMessage.textContent = ''; els.ticketModalMessage.classList.add('hidden'); els.ticketModalMessage.classList.remove('success'); }
  function handleTicketError(error, fallback) { const uncertain = error && error.code === 'API_RESPONSE_UNCERTAIN'; if (uncertain) state.uncertainEventTicketId = state.pendingEventTicketId; showMessage(uncertain ? '無法確認這次操作是否完成。請先重新整理確認；在確認前請勿再次送出。' : error && error.message || fallback, false); state.actionLocked = uncertain; els.ticketModalAction.disabled = true; els.refreshTicketButton.classList.toggle('hidden', !uncertain); }
  function safeAccent(value) { return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value) : '#d86e50'; }
  function setView(view) { els.loadingView.classList.toggle('hidden', view !== 'loading'); els.errorView.classList.toggle('hidden', view !== 'error'); els.eventView.classList.toggle('hidden', view !== 'event'); }
  function startLoginProgress(status, ceiling) { stopLoginProgress(); const maximum = Math.max(loginProgressValue, Math.min(98, Number(ceiling) || loginProgressValue)); setLoginProgress(loginProgressValue, status); loginProgressTimer = window.setInterval(() => { const remaining = maximum - loginProgressValue; if (remaining <= 0) return stopLoginProgress(); setLoginProgress(Math.min(maximum, loginProgressValue + Math.max(1, Math.ceil(remaining * .12))), status); }, LOGIN_PROGRESS_TICK_MS); }
  function stopLoginProgress() { if (loginProgressTimer !== null) window.clearInterval(loginProgressTimer); loginProgressTimer = null; }
  function completeLoginProgress(status) {
    stopLoginProgress();
    // 資料就緒便交還操作，不讓裝飾性動畫阻塞主要畫面。
    setLoginProgress(100, status);
    return Promise.resolve();
  }

  function setLoginProgress(value, status) { const progress = Math.max(loginProgressValue, Math.max(0, Math.min(100, Math.round(Number(value) || 0)))); loginProgressValue = progress; els.loadingProgress.setAttribute('aria-valuenow', String(progress)); els.loadingProgress.setAttribute('aria-valuetext', `${progress}%`); els.loadingProgressBar.style.width = `${progress}%`; els.loadingProgressText.textContent = `${progress}%`; if (status) els.loadingStatus.textContent = status; }
  function showError(error) { const membershipRequired = error && error.code === 'MEMBERSHIP_REQUIRED'; const maintenance = error && error.code === 'SYSTEM_MAINTENANCE'; els.errorTitle.textContent = maintenance ? '系統維護中' : error && error.code === 'CONFIG_ERROR' ? '系統尚未完成設定' : membershipRequired ? '請先加入會員' : '活動票券暫時無法載入'; els.errorMessage.textContent = membershipRequired ? '加入會員並完成會員資料後，才能使用活動票券功能。' : error && error.message ? error.message : '請稍後重新整理再試。'; els.joinMemberButton.classList.toggle('hidden', !membershipRequired); els.retryButton.classList.toggle('hidden', membershipRequired); setView('error'); }
  window.MemberClientQaHooks = Object.freeze({ surface: 'event', refresh: () => loadOffers(false) });
})();
