(() => {
  'use strict';

  const EVENT_TICKET_TIER_KEYS = Object.freeze(['general', 'silver', 'gold', 'platinum']);
  const CALENDAR_ITEM_TIER_KEYS = Object.freeze(['general', 'silver', 'gold', 'platinum']);
  const CALENDAR_ITEM_TIER_LABELS = Object.freeze({ general: '一般會員', silver: '銀級會員', gold: '金級會員', platinum: '白金會員' });
  const MEMBERSHIP_TIER_STYLE_KEYS = Object.freeze(['forest', 'midnight', 'ocean', 'sunset', 'lavender', 'rose', 'gold', 'platinum', 'mint', 'cherry']);
  const MEMBERSHIP_TIER_STYLE_LABELS = Object.freeze({ forest: '森林綠', midnight: '午夜藍', ocean: '海灣青', sunset: '夕陽橘', lavender: '薰衣草紫', rose: '玫瑰粉', gold: '金曜棕', platinum: '鉑金灰', mint: '薄荷綠', cherry: '櫻桃紅' });
  const POINT_CARD_STYLE_KEYS = Object.freeze(['citrus', 'coral', 'lagoon', 'skyline', 'violet', 'berry', 'cocoa', 'lime', 'denim', 'peach']);
  const POINT_CARD_STYLE_LABELS = Object.freeze({ citrus: '柑橘氣泡', coral: '珊瑚蘇打', lagoon: '潟湖水光', skyline: '晴空城市', violet: '電光紫', berry: '莓果霓虹', cocoa: '可可拿鐵', lime: '萊姆汽水', denim: '丹寧晴藍', peach: '蜜桃冰沙' });
  const LEGACY_POINT_CARD_STYLE_MAP = Object.freeze({ forest: 'lagoon', midnight: 'skyline', ocean: 'denim', sunset: 'coral', lavender: 'violet', rose: 'berry', gold: 'citrus', platinum: 'cocoa', mint: 'lime', cherry: 'peach' });
  const state = { config: null, idToken: '', members: [], memberPage: { page: 1, pageSize: 100, total: 0, totalPages: 1, query: '' }, memberKind: 'real', memberSearchTimer: null, memberRequestVersion: 0, tierSettings: [], cards: [], cardSortOriginalOrder: [], tickets: [], bookingServices: [], eventTickets: [], calendarItems: [], messagePresets: [], adminCalendarMonth: '', ticketCalendarMonth: '', bookingCalendarMonth: '', stats: {}, activePanel: 'members', activeCardWorkspace: 'cards', loadedPanels: { members: true, cards: false, events: false, calendar: false }, panelLoads: Object.create(null), summaryLoaded: false, selectedCardId: '', selectedTicketId: '', selectedEventTicketId: '', selectedCalendarItemId: '', grantRequestId: '', grantSuccessTimer: null, editorModals: Object.create(null), cardSortBusy: false, cardSortDirty: false, cardSortDrag: null, suppressCardClick: false, writeConfirmationRequired: false, memberRecords: { lineUserId: '', filter: 'all', subfilter: 'all', data: null, member: null, requestVersion: 0 }, memberUsage: { kind: 'real', page: 1, query: '', members: [], totalPages: 1, total: 0, requestVersion: 0, searchTimer: null, loaded: false }, operationalBookings: [] };
  const els = {};
  const LOGIN_PROGRESS_TICK_MS = 650;
  const MEMBER_PRESENCE_POLL_MS = 15_000;
  const STORE_SERVICE_ID = '00000000-0000-4000-8000-000000000010';
  let loginProgressTimer = null;
  let loginProgressValue = 8;
  let stopAdminRealtime = null;
  let memberPresencePollTimer = null;
  let memberPresencePollPending = false;
  let memberPresencePollQueued = false;
  let memberPresencePageVersion = 0;
  const memberPresenceObservations = new Map();
  let adminRefreshPromise = null;
  let adminRefreshQueued = false;
  let adminRefreshBusy = false;

  window.addEventListener('DOMContentLoaded', () => {
    window.MemberSystem.bindDialogKeyboard();
    [
      'app', 'loadingView', 'loadingProgress', 'loadingProgressBar', 'loadingProgressText', 'loadingStatus', 'errorView', 'errorTitle', 'errorMessage', 'pendingBox', 'pendingUserId', 'retryButton', 'adminView', 'displayName', 'roleLabel', 'logoutButton',
      'membersTab', 'cardsTab', 'eventsTab', 'calendarTab', 'clientPageTitleTab', 'clientPageTitleShortcut', 'cardSettingsTab', 'ticketSettingsTab', 'memberCount', 'activeMemberCount', 'activeCardCount', 'activeEventTicketCount', 'todayEntryCount', 'membersPanel', 'cardsPanel', 'eventsPanel', 'calendarPanel', 'cardSettingsPanel', 'ticketSettingsPanel', 'syncStatus', 'refreshButton',
      'tierSettingsForm', 'tierGeneralMinutes', 'tierSilverMinutes', 'tierGoldMinutes', 'tierPlatinumMinutes', 'tierGeneralStyle', 'tierSilverStyle', 'tierGoldStyle', 'tierPlatinumStyle', 'tierSettingsFormMessage', 'saveTierSettingsButton',
      'memberSearch', 'memberResultCount', 'memberTableBody', 'memberEmptyState', 'memberPagination', 'memberPrevPageButton', 'memberPageStatus', 'memberNextPageButton',
      'newCardButton', 'cardResultCount', 'cardListItems', 'cardEmptyState', 'editorKicker', 'editorTitle', 'editorStatus', 'cardForm', 'cardId', 'cardExpectedUpdatedAt', 'cardTitle', 'cardUsageMethod', 'cardUsageInstructions', 'cardBenefitDescription', 'cardStatus', 'cardExpiryMode', 'cardExpiresOnField', 'cardExpiresOn', 'cardExpiresOnSummary', 'cardAccent', 'accentValue', 'rewardRows', 'addRewardButton', 'rewardEditorHint', 'cardFormMessage', 'resetCardButton', 'archiveCardButton', 'deleteCardButton', 'saveCardButton',
      'newTicketButton', 'ticketResultCount', 'ticketListItems', 'ticketEmptyState', 'ticketEditorKicker', 'ticketEditorTitle', 'ticketEditorStatus', 'ticketForm', 'ticketTemplateId', 'ticketExpectedUpdatedAt', 'ticketTitle', 'ticketType', 'ticketDescription', 'ticketUsageMethod', 'ticketUsageInstructions', 'ticketStatus', 'ticketPrizeEditor', 'ticketPrizeRows', 'addTicketPrizeButton', 'balanceTicketPrizesButton', 'ticketPrizeTotal', 'ticketFormMessage', 'resetTicketButton', 'deleteTicketButton', 'saveTicketButton',
      'newEventTicketButton', 'eventTicketResultCount', 'eventTicketListItems', 'eventTicketEmptyState', 'eventTicketEditorKicker', 'eventTicketEditorTitle', 'eventTicketEditorStatus', 'eventTicketForm', 'eventTicketId', 'eventTicketExpectedUpdatedAt', 'eventTicketTitle', 'eventTicketType', 'eventTicketDescription', 'eventTicketUsageMethod', 'eventTicketUsageInstructions', 'eventTicketStatus', 'eventTicketRequiredServiceMatchMode', 'eventTicketRequiredServiceIds', 'eventTicketMinBookingAmountMode', 'eventTicketMinBookingAmount', 'eventTicketMinBookingServiceIds', 'eventTicketValidityMode', 'eventTicketValidityDays', 'eventTicketStartsOn', 'eventTicketEndsOn', 'eventTicketDateRangeSummary', 'eventTicketDateRangeMessage', 'eventTicketQuota', 'eventTicketAccent', 'eventTicketAccentValue', 'eventTicketPrizeEditor', 'eventTicketPrizeRows', 'addEventTicketPrizeButton', 'balanceEventTicketPrizesButton', 'eventTicketPrizeTotal', 'eventTicketFormMessage', 'resetEventTicketButton', 'deleteEventTicketButton', 'saveEventTicketButton', 'eventTicketLocationRule', 'eventTicketRequiresLocation', 'eventTicketLatitude', 'eventTicketLongitude', 'eventTicketRadius',
      'newCalendarItemButton', 'adminCalendarPreviousMonthButton', 'adminCalendarNextMonthButton', 'adminCalendarTodayButton', 'adminCalendarMonthTitle', 'adminCalendarGrid', 'calendarItemEditorKicker', 'calendarItemEditorTitle', 'calendarItemEditorStatus', 'calendarItemForm', 'calendarItemId', 'calendarItemExpectedUpdatedAt', 'calendarItemTitle', 'calendarItemType', 'calendarItemDescription', 'calendarItemLinkLabel', 'calendarItemLinkUrl', 'calendarItemEventLinkFields', 'calendarItemStatus', 'calendarItemStartsOn', 'calendarItemEndsOn', 'calendarItemAccent', 'calendarItemAccentValue', 'calendarItemFormMessage', 'resetCalendarItemButton', 'deleteCalendarItemButton', 'saveCalendarItemButton',
      'memberModal', 'closeMemberModal', 'memberForm', 'memberLineUserId', 'memberExpectedUpdatedAt', 'memberIdentity', 'memberTier', 'memberStatus', 'memberFormMessage', 'cancelMemberButton', 'saveMemberButton',
      'memberRecordsModal', 'closeMemberRecordsModal', 'memberRecordsIdentity', 'memberRecordsOverview', 'memberRecordsModalMessage', 'memberRecordsOpenUsage', 'memberUsagePanel', 'memberUsageSearch', 'memberUsageSelect', 'memberUsagePrev', 'memberUsageNext', 'memberUsagePageStatus', 'memberUsageRosterMessage', 'memberUsageIntro', 'memberUsageSelectedLabel', 'memberRecordsSummary', 'memberRecordsTabs', 'memberRecordsSubfilter', 'memberRecordsFilterStatus', 'memberRecordsList', 'memberRecordsEmpty', 'memberRecordsMessage',
      'grantMode', 'grantServiceFields', 'grantServiceStatus', 'grantServiceList', 'previewServiceGrantButton', 'grantServicePreview', 'grantModal', 'closeGrantModal', 'grantForm', 'grantMemberId', 'grantMemberName', 'grantStampsEnabled', 'grantStampsFields', 'grantCardId', 'grantStampAmount', 'grantPointRows', 'addGrantPointButton', 'grantPointHint', 'grantServiceTimeEnabled', 'grantServiceTimeFields', 'grantServiceTimeMinutes', 'grantMessageSection', 'grantMessagePreset', 'grantMessagePreview', 'manageGrantMessagesButton', 'grantFormMessage', 'cancelGrantButton', 'saveGrantButton', 'grantSuccessNotice',
      'messagePresetModal', 'closeMessagePresetModal', 'messagePresetForm', 'messagePresetList', 'messagePresetId', 'messagePresetExpectedUpdatedAt', 'messagePresetTitle', 'messagePresetBody', 'messagePresetStatus', 'messagePresetFormMessage', 'newMessagePresetButton', 'saveMessagePresetButton'
    ].forEach((id) => { els[id] = document.getElementById(id); });
    window.TicketLocationEditors.init();
    bindEvents();
    // Browser timers can be throttled while the admin tab is hidden.
    // Reconcile immediately when the dashboard is visible again.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.idToken) {
        void refreshMemberPresence().catch(() => {});
      }
    });
    installSettingsCopy();
    window.addEventListener('pagehide', (event) => {
      // Hide private views before Back/Forward Cache snapshots them. A persisted
      // page keeps its in-memory credential only until pageshow, where the server
      // revalidates authorization before the admin UI is shown again.
      delete document.documentElement.dataset.memberAdminReady;
      stopLoginProgress();
      if (typeof stopAdminRealtime === 'function') stopAdminRealtime();
      stopAdminRealtime = null;
      stopMemberPresencePolling();
      document.querySelectorAll('.modal').forEach((modal) => modal.classList.add('hidden'));
      setView('loading');
      if (!event.persisted) {
        state.idToken = '';
        window.MemberAdminSession?.clear();
      }
    });
    window.addEventListener('pageshow', (event) => {
      if (event.persisted) void resumeAdminFromBfcache();
    });
    boot();
  });

  function bindEvents() {
    prepareGrantPointEditor();
    prepareExplicitStatusOptions();
    prepareTierStylePreviews();
    preparePointCardStyleEditor();
    prepareCardSortControls();
    prepareEditorModals();
    els.cardSortSaveButton.addEventListener('click', saveCardSort);
    const eventTicketTierAccess = document.getElementById('eventTicketAllowedTiers');
    const eventTicketTitleField = els.eventTicketTitle.closest('label');
    if (eventTicketTierAccess && eventTicketTitleField) {
      els.eventTicketForm.insertBefore(eventTicketTierAccess, eventTicketTitleField);
      eventTicketTierAccess.addEventListener('change', updateEventTicketTierSummary);
      eventTicketTierAccess.addEventListener('click', handleAudiencePresetClick);
      updateEventTicketTierSummary();
    }
    ensureCalendarItemTierAccess();
    prepareCalendarWorkspace();
    els.retryButton.addEventListener('click', () => window.location.reload());
    els.logoutButton.addEventListener('click', () => window.MemberSystem.logout());
    els.membersTab.addEventListener('click', () => switchPanel('members'));
    els.cardsTab.addEventListener('click', () => switchPanel('cards'));
    els.eventsTab.addEventListener('click', () => switchPanel('events'));
    els.calendarTab.addEventListener('click', () => { switchPanel('calendar'); requestOperationalBookingSnapshot(); });
    els.clientPageTitleTab.addEventListener('click', () => switchPanel('clientPageTitle'));
    els.cardSettingsTab.addEventListener('click', () => switchCardWorkspace('cards'));
    els.ticketSettingsTab.addEventListener('click', () => switchCardWorkspace('tickets'));
    els.refreshButton.addEventListener('click', () => { if (state.writeConfirmationRequired) return window.location.reload(); return refreshData(true).catch((error) => { els.syncStatus.textContent = error && error.message || '同步失敗，請稍後再試。'; els.syncStatus.classList.add('error'); }); });
    els.memberSearch.addEventListener('input', scheduleMemberSearch);
    els.memberPrevPageButton.addEventListener('click', () => loadMembersPage(state.memberPage.page - 1, state.memberPage.query));
    els.memberNextPageButton.addEventListener('click', () => loadMembersPage(state.memberPage.page + 1, state.memberPage.query));
    els.memberTableBody.addEventListener('click', handleMemberTableClick);
    els.tierSettingsForm.addEventListener('submit', saveTierSettings);
    els.newCardButton.addEventListener('click', () => { resetCardForm(); openEditorModal('card'); });
    els.cardListItems.addEventListener('click', handleCardListClick);
    els.addRewardButton.addEventListener('click', addRewardRow);
    els.rewardRows.addEventListener('input', updateRewardEditorHint);
    els.rewardRows.addEventListener('change', updateRewardEditorHint);
    els.rewardRows.addEventListener('click', (event) => { const button = event.target instanceof Element ? event.target.closest('[data-remove-reward]') : null; if (button) { button.closest('[data-reward-row]')?.remove(); updateRewardEditorHint(); } });
    els.cardExpiryMode.addEventListener('change', updateCardExpiryUI);
    els.cardExpiresOn.addEventListener('change', updateCardExpiryDateUI);
    els.cardAccent.addEventListener('input', updateAccentValue);
    els.cardForm.addEventListener('submit', saveCard);
    els.resetCardButton.addEventListener('click', resetCardForm);
    els.archiveCardButton.addEventListener('click', archiveCard);
    els.deleteCardButton.addEventListener('click', deleteCard);
    els.newTicketButton.addEventListener('click', () => { resetTicketForm(); openEditorModal('ticket'); });
    els.ticketListItems.addEventListener('click', (event) => { const button = event.target instanceof Element ? event.target.closest('[data-ticket-template-id]') : null; if (button) { loadTicketForm(button.dataset.ticketTemplateId); openEditorModal('ticket'); } });
    els.ticketType.addEventListener('change', updateTicketTypeUI);
    els.ticketPrizeRows.addEventListener('input', updateTicketPrizeTotal);
    els.ticketPrizeRows.addEventListener('click', (event) => { const button = event.target instanceof Element ? event.target.closest('[data-remove-ticket-prize]') : null; if (button) { button.closest('[data-ticket-prize-row]')?.remove(); updateTicketPrizeTotal(); } });
    els.addTicketPrizeButton.addEventListener('click', () => { renderTicketPrizeRows([...collectTicketPrizes(), defaultPrize(0)]); });
    els.balanceTicketPrizesButton.addEventListener('click', balanceTicketPrizes);
    els.ticketForm.addEventListener('submit', saveTicket);
    els.resetTicketButton.addEventListener('click', resetTicketForm);
    els.deleteTicketButton.addEventListener('click', deleteTicket);
    els.newEventTicketButton.addEventListener('click', () => { resetEventTicketForm(); openEditorModal('eventTicket'); });
    els.eventTicketListItems.addEventListener('click', (event) => { const button = event.target instanceof Element ? event.target.closest('[data-event-ticket-id]') : null; if (button) { loadEventTicketForm(button.dataset.eventTicketId); openEditorModal('eventTicket'); } });
    els.eventTicketType.addEventListener('change', updateEventTicketTypeUI);
    els.eventTicketMinBookingAmountMode.addEventListener('change', updateEventTicketAmountModeUI);
    els.eventTicketPrizeRows.addEventListener('input', updateEventTicketPrizeTotal);
    els.eventTicketPrizeRows.addEventListener('click', (event) => { const button = event.target instanceof Element ? event.target.closest('[data-remove-event-ticket-prize]') : null; if (button) { button.closest('[data-event-ticket-prize-row]')?.remove(); updateEventTicketPrizeTotal(); } });
    els.addEventTicketPrizeButton.addEventListener('click', () => { renderEventTicketPrizeRows([...collectEventTicketPrizes(), defaultPrize(0)]); });
    els.balanceEventTicketPrizesButton.addEventListener('click', balanceEventTicketPrizes);
    els.eventTicketValidityMode.addEventListener('change', updateEventTicketValidityUI);
    els.eventTicketValidityDays.addEventListener('input', updateEventTicketDateRangeUI);
    els.eventTicketStartsOn.addEventListener('change', updateEventTicketDateRangeUI);
    els.eventTicketEndsOn.addEventListener('change', updateEventTicketDateRangeUI);
    els.eventTicketAccent.addEventListener('input', updateEventTicketAccentValue);
    els.eventTicketForm.addEventListener('submit', saveEventTicket);
    els.resetEventTicketButton.addEventListener('click', resetEventTicketForm);
    els.deleteEventTicketButton.addEventListener('click', deleteEventTicket);
    els.newCalendarItemButton.addEventListener('click', () => { resetCalendarItemForm(); openEditorModal('calendar'); });
    els.adminCalendarPreviousMonthButton.addEventListener('click', () => changeAdminCalendarMonth(-1));
    els.adminCalendarNextMonthButton.addEventListener('click', () => changeAdminCalendarMonth(1));
    els.adminCalendarTodayButton.addEventListener('click', () => { state.adminCalendarMonth = ''; renderAdminCalendar(); });
    els.adminCalendarGrid.addEventListener('click', handleAdminCalendarGridClick);
    document.addEventListener('click', handleScopedCalendarClick);
    window.addEventListener('member-admin:booking-snapshot', handleOperationalBookingSnapshot);
    window.addEventListener('member-admin:features-updated', () => {
      if (window.BusinessWorkspace?.allows('booking') === false) state.operationalBookings = [];
      renderBookingOverviewCalendar();
    });
    window.addEventListener('member-admin:booking-services-updated', handleBookingServicesUpdated);
    els.calendarItemAccent.addEventListener('input', updateCalendarItemAccentValue);
    els.calendarItemForm.addEventListener('change', handleCalendarItemFormChange);
    els.calendarItemForm.addEventListener('submit', saveCalendarItem);
    els.resetCalendarItemButton.addEventListener('click', resetCalendarItemForm);
    els.deleteCalendarItemButton.addEventListener('click', deleteCalendarItem);
    els.memberForm.addEventListener('submit', saveMember);
    els.cancelMemberButton.addEventListener('click', closeMemberModal);
    els.closeMemberModal.addEventListener('click', closeMemberModal);
    els.memberModal.addEventListener('click', (event) => { if (shouldDismissModalFromBackdrop(event, els.memberModal)) closeMemberModal(); });
    els.closeMemberRecordsModal.addEventListener('click', closeMemberRecordsModal);
    els.memberRecordsModal.addEventListener('click', (event) => { if (shouldDismissModalFromBackdrop(event, els.memberRecordsModal)) closeMemberRecordsModal(); });
    els.memberRecordsTabs.addEventListener('click', handleMemberRecordsTabClick);
    els.memberRecordsSubfilter.addEventListener('change', () => {
      if (!state.memberRecords.data || els.memberRecordsSubfilter.disabled) return;
      state.memberRecords.subfilter = els.memberRecordsSubfilter.value;
      renderMemberRecordList();
    });
    els.memberRecordsSummary.addEventListener('click', handleMemberRecordsSummaryClick);
    els.memberRecordsOpenUsage.addEventListener('click', () => {
      const member = state.memberRecords.member;
      if (!member) return;
      closeMemberRecordsModal();
      state.memberUsage.kind = 'real';
      state.memberUsage.page = 1;
      state.memberUsage.query = '';
      state.memberUsage.loaded = false;
            els.memberUsageSearch.value = '';
      window.MemberWorkspaceTabs?.select('usage');
    });
    window.addEventListener('member-workspace-selected', (event) => {
      if (event.detail?.workspace === 'usage' && state.idToken && !state.memberUsage.loaded) {
        void loadMemberUsageRoster().catch(() => {});
      }
    });
    els.memberUsageSearch.addEventListener('input', () => {
      state.memberUsage.requestVersion++;
      if (state.memberUsage.searchTimer) window.clearTimeout(state.memberUsage.searchTimer);
      state.memberUsage.query = els.memberUsageSearch.value.trim().slice(0, 100);
      state.memberUsage.page = 1;
      clearMemberUsageHistory();
      state.memberUsage.searchTimer = window.setTimeout(() => { void loadMemberUsageRoster().catch(() => {}); }, 300);
    });
    els.memberUsageSelect.addEventListener('change', () => {
      const member = state.memberUsage.members.find((item) => item.lineUserId === els.memberUsageSelect.value)
        || (state.memberRecords.member?.lineUserId === els.memberUsageSelect.value ? state.memberRecords.member : null);
      if (member) void openMemberRecordsModal(member, false);
      else clearMemberUsageHistory();
    });
    els.memberUsagePrev.addEventListener('click', () => { clearMemberUsageHistory(); state.memberUsage.page = Math.max(1, state.memberUsage.page - 1); void loadMemberUsageRoster().catch(() => {}); });
    els.memberUsageNext.addEventListener('click', () => { clearMemberUsageHistory(); state.memberUsage.page = Math.min(state.memberUsage.totalPages, state.memberUsage.page + 1); void loadMemberUsageRoster().catch(() => {}); });
    els.grantForm.addEventListener('submit', saveGrant);
    els.grantMode.addEventListener('change', changeGrantMode);
    els.grantServiceList.addEventListener('change', invalidateServicePreview);
    els.previewServiceGrantButton.addEventListener('click', previewServiceGrant);
    els.cancelGrantButton.addEventListener('click', closeGrantModal);
    els.closeGrantModal.addEventListener('click', closeGrantModal);
    els.grantModal.addEventListener('click', (event) => { if (shouldDismissModalFromBackdrop(event, els.grantModal)) closeGrantModal(); });
    els.grantStampsEnabled.addEventListener('change', updateGrantOptions);
    els.grantPointRows.addEventListener('input', updateGrantPointHint);
    els.grantPointRows.addEventListener('change', updateGrantPointHint);
    els.grantPointRows.addEventListener('click', (event) => { const button = event.target instanceof Element ? event.target.closest('[data-remove-grant-point]') : null; if (button) { button.closest('[data-grant-point-row]')?.remove(); updateGrantPointHint(); } });
    els.addGrantPointButton.addEventListener('click', addGrantPointRow);
    els.grantServiceTimeEnabled.addEventListener('change', updateGrantOptions);
    els.grantMessagePreset.addEventListener('change', updateGrantMessagePreview);
    els.manageGrantMessagesButton.addEventListener('click', openMessagePresetModal);
    els.closeMessagePresetModal.addEventListener('click', closeMessagePresetModal);
    els.messagePresetModal.addEventListener('click', (event) => { if (shouldDismissModalFromBackdrop(event, els.messagePresetModal)) closeMessagePresetModal(); });
    els.messagePresetList.addEventListener('change', () => { if (els.messagePresetList.value) loadMessagePresetForm(els.messagePresetList.value); });
    els.newMessagePresetButton.addEventListener('click', resetMessagePresetForm);
    els.messagePresetForm.addEventListener('submit', saveMessagePreset);
    document.addEventListener('click', handleAdminDateControlClick);
    els.cardListItems.addEventListener('pointerdown', handleCardSortPointerDown);
    document.addEventListener('pointermove', handleCardSortPointerMove);
    document.addEventListener('pointerup', handleCardSortPointerUp);
    document.addEventListener('pointercancel', handleCardSortPointerUp);
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const dialogs = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
        .filter(node => !node.classList.contains('hidden') && node.getClientRects().length)
        .sort((a,b) => (parseInt(getComputedStyle(a).zIndex) || 0) - (parseInt(getComputedStyle(b).zIndex) || 0));
      const top = dialogs.at(-1);
      if (!top) return;
      const close = { memberModal: closeMemberModal, grantModal: closeGrantModal, messagePresetModal: closeMessagePresetModal, memberRecordsModal: closeMemberRecordsModal }[top.id];
      const editor = Object.entries(state.editorModals).find(([,entry]) => entry.modal === top);
      if (!close && !editor) return;
      event.preventDefault();
      if (close) close(); else closeEditorModal(editor[0]);
    });
  }

  function shouldDismissModalFromBackdrop(event, modal) {
    if (!event || event.target !== modal) return false;
    return typeof window.matchMedia === 'function' && window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  }

  function prepareGrantPointEditor() {
    if (els.grantPointRows || !els.grantStampsFields) return;
    const legacyCardLabel = els.grantCardId.closest('label'); const legacyAmountLabel = els.grantStampAmount.closest('label');
    if (legacyCardLabel) legacyCardLabel.classList.add('hidden');
    if (legacyAmountLabel) legacyAmountLabel.classList.add('hidden');
    const rows = document.createElement('div'); rows.id = 'grantPointRows'; rows.className = 'grant-point-rows';
    const addButton = document.createElement('button'); addButton.id = 'addGrantPointButton'; addButton.type = 'button'; addButton.className = 'text-button grant-add-point'; addButton.textContent = '＋ 再加入一張集點卡';
    const hint = document.createElement('p'); hint.id = 'grantPointHint'; hint.className = 'field-help'; hint.textContent = '可在同一次操作中為不同集點卡發放不同點數。';
    els.grantStampsFields.replaceChildren(rows, addButton, hint); els.grantPointRows = rows; els.addGrantPointButton = addButton; els.grantPointHint = hint;
  }

  function prepareExplicitStatusOptions() {
    [els.cardStatus, els.ticketStatus, els.eventTicketStatus, els.calendarItemStatus].forEach((select) => {
      if (!select || select.querySelector('option[value=""]')) return;
      const option = document.createElement('option'); option.value = ''; option.disabled = true; option.textContent = '請選擇公開狀態'; select.insertBefore(option, select.firstChild); select.value = '';
    });
  }

  function prepareTierStylePreviews() {
    [['general', els.tierGeneralStyle], ['silver', els.tierSilverStyle], ['gold', els.tierGoldStyle], ['platinum', els.tierPlatinumStyle]].forEach(([tierKey, select]) => {
      const label = select && select.closest('label');
      if (!label || label.querySelector('[data-tier-style-preview]')) return;
      select.dataset.tierStyleSelect = tierKey;
      const preview = createStylePreview(`目前${CALENDAR_ITEM_TIER_LABELS[tierKey] || ''}卡面`);
      preview.dataset.tierStylePreview = tierKey;
      label.insertBefore(preview, select);
      select.addEventListener('change', syncTierStylePreviews);
    });
    syncTierStylePreviews();
  }

  function preparePointCardStyleEditor() {
    const accentGrid = els.cardAccent && els.cardAccent.closest('.form-grid');
    if (!accentGrid || els.cardStyle) return;
    const label = document.createElement('label'); label.className = 'card-style-field'; label.append(document.createTextNode('集點卡樣式'));
    const select = document.createElement('select'); select.id = 'cardStyle'; select.name = 'styleKey'; select.setAttribute('aria-label', '集點卡樣式');
    POINT_CARD_STYLE_KEYS.forEach((styleKey) => { const option = document.createElement('option'); option.value = styleKey; option.textContent = POINT_CARD_STYLE_LABELS[styleKey]; select.append(option); });
    const preview = createStylePreview('目前集點卡面'); preview.dataset.pointCardStylePreview = 'true'; label.append(select, preview); accentGrid.insertBefore(label, accentGrid.firstChild); els.cardStyle = select; els.cardStylePreview = preview; select.addEventListener('change', updatePointCardStylePreview); updatePointCardStylePreview();
  }

  function createStylePreview(prefix) {
    const preview = document.createElement('div'); preview.className = 'style-preview'; preview.setAttribute('role', 'img');
    const thumbnail = document.createElement('span'); thumbnail.className = 'style-thumbnail'; thumbnail.setAttribute('aria-hidden', 'true');
    const copy = document.createElement('span'); copy.className = 'style-preview-copy'; const eyebrow = document.createElement('small'); eyebrow.textContent = prefix; const name = document.createElement('strong'); name.dataset.stylePreviewName = 'true'; copy.append(eyebrow, name); preview.append(thumbnail, copy); return preview;
  }

  function syncTierStylePreviews() {
    document.querySelectorAll('[data-tier-style-select]').forEach((select) => { const preview = select.closest('label')?.querySelector('[data-tier-style-preview]'); if (preview) updateStylePreview(select, preview, `目前${CALENDAR_ITEM_TIER_LABELS[select.dataset.tierStyleSelect] || ''}卡面`); });
  }

  function updatePointCardStylePreview() { if (!els.cardStyle || !els.cardStylePreview) return; const styleKey = safePointCardStyle(els.cardStyle.value); els.cardStylePreview.dataset.style = styleKey; els.cardStylePreview.setAttribute('aria-label', `目前集點卡面：${POINT_CARD_STYLE_LABELS[styleKey]}`); const name = els.cardStylePreview.querySelector('[data-style-preview-name]'); if (name) name.textContent = POINT_CARD_STYLE_LABELS[styleKey]; }
  function updateStylePreview(select, preview, prefix) { const styleKey = safeTierStyle(select.value); preview.dataset.style = styleKey; preview.setAttribute('aria-label', `${prefix}：${MEMBERSHIP_TIER_STYLE_LABELS[styleKey]}`); const name = preview.querySelector('[data-style-preview-name]'); if (name) name.textContent = MEMBERSHIP_TIER_STYLE_LABELS[styleKey]; }

  function prepareCardSortControls() {
    const cardList = els.cardListItems && els.cardListItems.closest('.card-list');
    if (!cardList || cardList.querySelector('.card-sort-hint')) return;
    const hint = document.createElement('p'); hint.className = 'card-sort-hint'; hint.textContent = '電腦可拖曳排序；手機請使用每張卡右側的上下按鈕，完成後按「儲存排序」。';
    const message = document.createElement('p'); message.id = 'cardSortMessage'; message.className = 'form-message hidden'; message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
    const saveButton = document.createElement('button'); saveButton.id = 'saveCardSortButton'; saveButton.type = 'button'; saveButton.className = 'button button-dark card-sort-save'; saveButton.textContent = '儲存排序';
    cardList.insertBefore(hint, els.cardListItems); cardList.insertBefore(message, els.cardListItems); cardList.insertBefore(saveButton, els.cardListItems); els.cardSortMessage = message; els.cardSortSaveButton = saveButton;
  }

  function prepareEditorModals() {
    [
      { key: 'card', form: els.cardForm, titleId: 'editorTitle', label: '集點卡' },
      { key: 'ticket', form: els.ticketForm, titleId: 'ticketEditorTitle', label: '票券' },
      { key: 'eventTicket', form: els.eventTicketForm, titleId: 'eventTicketEditorTitle', label: '活動票券' },
      { key: 'calendar', form: els.calendarItemForm, titleId: 'calendarItemEditorTitle', label: '日曆項目' }
    ].forEach((config) => {
      const editor = config.form && config.form.closest('.editor');
      const workspace = editor && editor.closest('.card-workspace');
      if (!editor || !workspace || !editor.parentNode) return;
      workspace.classList.add('editor-modal-host');
      const modal = document.createElement('div'); modal.id = `${config.key}EditorModal`; modal.className = 'modal editor-modal hidden'; modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-labelledby', config.titleId);
      const card = document.createElement('div'); card.className = 'modal-card editor-modal-card';
      const heading = editor.querySelector('.editor-heading');
      const status = editor.querySelector('.editor-status');
      const actions = document.createElement('div'); actions.className = 'editor-heading-actions';
      const close = document.createElement('button'); close.type = 'button'; close.className = 'close-button editor-modal-close'; close.setAttribute('aria-label', `關閉${config.label}視窗`); close.textContent = '×';
      if (heading) { if (status) actions.append(status); actions.append(close); heading.append(actions); }
      card.append(editor); modal.append(card); document.body.append(modal);
      modal.addEventListener('click', (event) => { if (shouldDismissModalFromBackdrop(event, modal)) closeEditorModal(config.key); });
      close.addEventListener('click', () => closeEditorModal(config.key));
      state.editorModals[config.key] = { modal, close, opener: null };
    });
  }

  function openEditorModal(key, opener) {
    const entry = state.editorModals[key]; if (!entry) return;
    entry.opener = opener instanceof HTMLElement ? opener : document.activeElement;
    entry.modal.classList.remove('hidden');
    const refreshTicketMap = () => {
      if (key === 'ticket') window.TicketLocationEditors?.template?.refresh();
      if (key === 'eventTicket') window.TicketLocationEditors?.event?.refresh();
    };
    const scheduleFrame = typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame.bind(window)
      : (callback) => window.setTimeout(callback, 0);
    scheduleFrame(() => {
      refreshTicketMap();
      window.setTimeout(refreshTicketMap, 80);
    });
    const focusTarget = entry.modal.querySelector('input:not([type="hidden"]), select, textarea, button:not(.editor-modal-close)');
    (focusTarget || entry.close).focus();
  }

  function closeEditorModal(key) {
    const entry = state.editorModals[key]; if (!entry) return;
    entry.modal.classList.add('hidden');
    if (key === 'ticket') window.TicketLocationEditors?.template?.stopGPS?.();
    if (key === 'eventTicket') window.TicketLocationEditors?.event?.stopGPS?.();
    if (entry.opener instanceof HTMLElement && document.contains(entry.opener)) entry.opener.focus();
    entry.opener = null;
  }

  function closeEditorModals() { Object.keys(state.editorModals).forEach(closeEditorModal); }

  function isBackgroundE2ERunner() {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get('e2eBackgroundRunner') === '1' && Boolean(params.get('e2eRunId'));
    } catch {
      return false;
    }
  }

  function backgroundE2ERunId() {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get('e2eBackgroundRunner') === '1'
        ? String(params.get('e2eRunId') || '')
        : '';
    } catch {
      return '';
    }
  }

  async function waitForBackgroundAdminSession(timeoutMs = 8000) {
    const runId = backgroundE2ERunId();
    if (!runId) return null;
    const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 8000);
    while (Date.now() < deadline) {
      try {
        if (!window.opener || window.opener.closed) break;
        const session = window.opener.MemberAdminE2EControl?.provideBackgroundSession?.(runId);
        if (session?.idToken && session?.config && String(session.runId || '') === runId) {
          return {
            idToken: String(session.idToken),
            config: { ...session.config }
          };
        }
      } catch {}
      await new Promise((resolve) => window.setTimeout(resolve, 80));
    }
    const error = new Error('背景管理端 Runner 無法取得原管理端的已驗證 Session。');
    error.code = 'E2E_BACKGROUND_SESSION_HANDOFF_FAILED';
    throw error;
  }

  function recoverMissingBusinessEntry(error) {
    // A runner inherits its parent session; dropping its URL scope would reuse
    // that session for an unscoped bootstrap instead of the application entry.
    if (isBackgroundE2ERunner()) return false;
    // A removed/nonexistent merchant must never bootstrap through the shared
    // legacy business data plane. Redirect only to the unscoped, still-authenticated
    // application entry; never recover from permission or network failures.
    if (error?.code !== 'BUSINESS_NOT_FOUND' || !window.BusinessContext?.slug) return false;
    if (!['/admin/', '/admin'].includes(window.location.pathname)) return false;
    const clean = new URL(window.location.href);
    clean.searchParams.delete('business');
    clean.searchParams.delete('liff.state');
    if (clean.href === window.location.href) return false;
    window.location.replace(clean.href);
    return true;
  }

  async function boot() {
    setView('loading');
    try {
      startLoginProgress('正在取得開啟設定…', 18);
      const backgroundSession = await waitForBackgroundAdminSession();
      if (backgroundSession) {
        state.config = backgroundSession.config;
        state.idToken = backgroundSession.idToken;
        startLoginProgress('已安全沿用原管理端 Session…', 64);
      } else {
        state.config = await window.MemberSystem.loadConfig();
        if (state.config.productizedAdmin === true && !state.config.business) {
          // Productized tenants never use the legacy shared business data plane.
          // Keep the /admin/ route and mount only the grant-scoped control plane.
          startLoginProgress('正在載入已授權的管理功能…', 70);
          await window.ProductizedAdminShell.mount();
          return;
        }
        startLoginProgress('正在驗證 LINE 身分…', 48);
        state.idToken = await window.MemberSystem.signIn(state.config, 'admin');
      }
      startLoginProgress('正在完整同步管理資料…', 96);
      await refreshData(false);
      await completeLoginProgress('完整管理資料已準備完成');
      setView('admin');
      document.documentElement.dataset.memberAdminReady = 'true';
      window.dispatchEvent(new Event('member-admin-ready'));
      if (!isBackgroundE2ERunner()) {
        stopAdminRealtime = window.MemberSystem.subscribeRealtime(state.config, 'admin', handleAdminRealtimeUpdate);
        startMemberPresencePolling();
      } else {
        stopAdminRealtime = null;
        stopMemberPresencePolling();
      }
    } catch (error) {
      stopLoginProgress();
      if (!recoverMissingBusinessEntry(error)) handleBootError(error);
    } finally { stopLoginProgress(); els.app.setAttribute('aria-busy', 'false'); }
  }

  async function resumeAdminFromBfcache() {
    if (!state.config || !state.idToken) {
      await boot();
      return;
    }
    delete document.documentElement.dataset.memberAdminReady;
    els.app.setAttribute('aria-busy', 'true');
    setView('loading');
    try {
      startLoginProgress('正在重新驗證管理權限…', 92);
      await refreshData(false);
      await completeLoginProgress('管理權限與資料已重新驗證');
      setView('admin');
      document.documentElement.dataset.memberAdminReady = 'true';
      window.dispatchEvent(new Event('member-admin-ready'));
      if (!isBackgroundE2ERunner()) {
        stopAdminRealtime = window.MemberSystem.subscribeRealtime(state.config, 'admin', handleAdminRealtimeUpdate);
        startMemberPresencePolling();
      }
    } catch (error) {
      state.idToken = '';
      window.MemberAdminSession?.clear();
      stopLoginProgress();
      handleBootError(error);
    } finally {
      stopLoginProgress();
      els.app.setAttribute('aria-busy', 'false');
    }
  }

  async function handleAdminRealtimeUpdate(context = {}) {
    if (isBackgroundE2ERunner()) return;
    const eventTypes = Array.isArray(context.eventTypes) ? context.eventTypes.map(String) : [];
    const reasons = Array.isArray(context.reasons) ? context.reasons.map(String) : [];
    const realtimeOnly = reasons.length > 0 && reasons.every((reason) => reason === 'realtime');
    const bookingRealtimeOnly = eventTypes.length > 0
      && eventTypes.every((type) => type.startsWith('booking.'))
      && realtimeOnly;
    const presenceRealtimeOnly = eventTypes.length > 0
      && eventTypes.every((type) => type.includes('.presence.') || type === 'test_mode.presence.changed')
      && realtimeOnly;
    if (bookingRealtimeOnly || presenceRealtimeOnly) {
      await Promise.allSettled([refreshOpenMemberRecords(), refreshMemberPresence()]);
      return;
    }
    const tasks = [refreshData(false), refreshOpenMemberRecords()];
    await Promise.allSettled(tasks);
    await refreshMemberPresence().catch(() => {});
  }

  function startMemberPresencePolling() {
    stopMemberPresencePolling();
    if (isBackgroundE2ERunner()) return;
    const tick = async () => {
      if (!state.idToken) return;
      if (document.visibilityState === 'visible') await refreshMemberPresence().catch(() => {});
      if (state.idToken) memberPresencePollTimer = window.setTimeout(tick, MEMBER_PRESENCE_POLL_MS);
    };
    memberPresencePollTimer = window.setTimeout(tick, MEMBER_PRESENCE_POLL_MS);
  }

  function stopMemberPresencePolling() {
    if (memberPresencePollTimer !== null) {
      window.clearTimeout(memberPresencePollTimer);
      memberPresencePollTimer = null;
    }
  }

  function mergeNewerPresenceObservations(members, requestStartedAt) {
    return members.map((member) => {
      const observation = memberPresenceObservations.get(String(member.lineUserId || ''));
      // A completed presence request is authoritative only if it started
      // AFTER the member-list/bootstrap request whose result is being applied.
      if (!observation || observation.requestStartedAt <= requestStartedAt) return member;
      return {
        ...member,
        isOnline: observation.isOnline,
        lastSeenAt: observation.lastSeenAt,
        onlineSurfaces: [...observation.onlineSurfaces],
      };
    });
  }

  async function refreshMemberPresence() {
    if (!state.config || !state.idToken || !state.members.length) return;
    if (memberPresencePollPending) {
      memberPresencePollQueued = true;
      return;
    }
    memberPresencePollPending = true;
    const requestStartedAt = Date.now();
    const requestedKind = state.memberKind;
    const requestedPageVersion = memberPresencePageVersion;
    const lineUserIds = state.members.map((member) => String(member.lineUserId || '')).filter(Boolean);
    try {
      const result = await window.MemberSystem.request(state.config, 'admin', state.idToken, 'admin.members.presence.list', {
        lineUserIds,
      });
      // A malformed response is not evidence that every member went offline.
      if (!result || !Array.isArray(result.members)) throw new Error('會員上線狀態回應不完整。');
      // A member list loaded after this request is more authoritative.
      // Never overwrite it with an older in-flight response.
      if (requestedKind !== state.memberKind || requestedPageVersion !== memberPresencePageVersion) return;
      const byId = new Map(result.members.map((row) => [String(row.lineUserId || ''), row]));
      for (const id of lineUserIds) {
        const presence = byId.get(id);
        if (!presence) continue; // Do not treat missing rows as offline.
        memberPresenceObservations.set(id, {
          requestStartedAt,
          isOnline: Boolean(presence.isOnline),
          lastSeenAt: String(presence.lastSeenAt || ''),
          onlineSurfaces: Array.isArray(presence.onlineSurfaces) ? presence.onlineSurfaces.map(String) : [],
        });
      }
      let changed = false;
      state.members = state.members.map((member) => {
        const observation = memberPresenceObservations.get(String(member.lineUserId || ''));
        if (!observation || observation.requestStartedAt < requestStartedAt) return member;
        const previousSurfaces = Array.isArray(member.onlineSurfaces) ? member.onlineSurfaces : [];
        if (Boolean(member.isOnline) !== observation.isOnline
          || String(member.lastSeenAt || '') !== observation.lastSeenAt
          || previousSurfaces.join('|') !== observation.onlineSurfaces.join('|')) changed = true;
        return { ...member, isOnline: observation.isOnline, lastSeenAt: observation.lastSeenAt,
          onlineSurfaces: [...observation.onlineSurfaces] };
      });
      if (changed) renderMembers();
    } finally {
      memberPresencePollPending = false;
      if (memberPresencePollQueued) {
        memberPresencePollQueued = false;
        void refreshMemberPresence().catch(() => {});
      }
    }
  }

  function refreshData(showBusy) {
    adminRefreshQueued = true;
    if (showBusy) {
      adminRefreshBusy = true;
      els.refreshButton.disabled = true;
      els.syncStatus.textContent = '完整同步中…';
    }
    if (adminRefreshPromise) return adminRefreshPromise;

    adminRefreshPromise = (async () => {
      try {
        do {
          adminRefreshQueued = false;
          const requestStartedAt = Date.now();
          const result = await window.MemberSystem.request(state.config, 'admin', state.idToken, 'admin.bootstrap', {});
          assertCompleteAdminBootstrap(result);
          applyAdminBootstrap(result, requestStartedAt);
          if (!window.MemberAdminSession.isReady()) window.MemberAdminSession.establish(state.config, state.idToken);
          els.syncStatus.textContent = `已完整同步 · ${new Date().toLocaleTimeString('zh-Hant-TW', { hour: '2-digit', minute: '2-digit' })}`;
          els.syncStatus.classList.remove('error');
          window.dispatchEvent(new Event('member-admin-data-refreshed'));
        } while (adminRefreshQueued && state.idToken);
      } finally {
        adminRefreshPromise = null;
        if (adminRefreshBusy) {
          adminRefreshBusy = false;
          els.refreshButton.disabled = false;
        }
      }
    })();

    return adminRefreshPromise;
  }

  function assertCompleteAdminBootstrap(result) {
    const requiredArrays = ['members', 'tierSettings', 'cards', 'tickets', 'eventTickets', 'calendarItems', 'messagePresets'];
    const missing = requiredArrays.filter((key) => !Array.isArray(result && result[key]));
    const hasStats = Boolean(result && result.stats && typeof result.stats === 'object' && !Array.isArray(result.stats));
    const hasMemberPage = Boolean(result && result.memberPage && typeof result.memberPage === 'object' && !Array.isArray(result.memberPage));
    if (!result || typeof result !== 'object' || Array.isArray(result) || missing.length || !hasStats || !hasMemberPage) {
      const suffix = missing.length ? `（缺少：${missing.join('、')}）` : '';
      const error = new Error(`GAS 管理資料回應不完整${suffix}，已停止顯示管理頁面，請重新整理後再試。`);
      error.code = 'ADMIN_BOOTSTRAP_INCOMPLETE';
      throw error;
    }
  }

  function applyAdminBootstrap(result, requestStartedAt) {
    // Reconciliation updates lists and grants, not an editor's unsaved draft.
    // Keep its original optimistic version so a conflicting save still fails.
    const openEditors = new Set(Object.entries(state.editorModals)
      .filter(([, entry]) => !entry.modal.classList.contains('hidden')).map(([key]) => key));
    if(result.features){state.config.grantedFeatures=result.features;window.BusinessWorkspace?.apply(result);}
    if (state.memberKind === 'real') {
      state.members = mergeNewerPresenceObservations(result.members, requestStartedAt);
      memberPresencePageVersion++;
      if (memberPresencePollPending) memberPresencePollQueued = true;
      applyMemberPage(result.memberPage, state.memberPage);
    }
    state.tierSettings = result.tierSettings;
    state.stats = result.stats;
    state.messagePresets = Array.isArray(result.messagePresets) ? result.messagePresets : [];
    renderGrantMessagePresetOptions();
    renderMessagePresetList();
    state.loadedPanels = { members: true, cards: true, events: true, calendar: true };
    state.summaryLoaded = Object.prototype.hasOwnProperty.call(state.stats, 'todayEntryCount');
    els.displayName.textContent = String(result.profile && result.profile.displayName || '管理員');
    els.roleLabel.textContent = String(result.role || 'Admin');
    renderAdminOverview();
    applyAdminCards(result, false, openEditors);
    applyAdminEventTickets(result, false, openEditors);
    applyAdminCalendarItems(result, openEditors.has('calendar'));
  }

  function renderAdminOverview() {
    els.memberCount.textContent = String(state.stats.memberCount ?? state.members.length);
    els.activeMemberCount.textContent = String(state.stats.activeMemberCount ?? state.members.filter((member) => member.status === 'active').length);
    els.activeCardCount.textContent = state.stats.activeCardCount === undefined ? '—' : String(state.stats.activeCardCount);
    els.todayEntryCount.textContent = state.stats.todayEntryCount === undefined ? '—' : String(state.stats.todayEntryCount);
    els.activeEventTicketCount.textContent = state.stats.activeEventTicketCount === undefined ? '—' : String(state.stats.activeEventTicketCount);
    renderMembers(); renderTierSettings();
  }

  async function loadAdminSummary() {
    const result = await window.MemberSystem.request(state.config, 'admin', state.idToken, 'admin.summary', {});
    state.stats = { ...state.stats, ...(result.stats && typeof result.stats === 'object' ? result.stats : {}) };
    state.summaryLoaded = true;
    renderAdminOverview();
  }

  async function ensureAdminPanelData(panel) {
    if (panel === 'members' || state.loadedPanels[panel]) return;
    if (state.panelLoads[panel]) return state.panelLoads[panel];
    const actionByPanel = { cards: 'admin.pointcards.list', events: 'admin.event-tickets.list', calendar: 'admin.calendar-items.list' };
    const action = actionByPanel[panel];
    if (!action) return;
    const payload = panel === 'cards' ? { includeTickets: true } : {};
    const load = window.MemberSystem.request(state.config, 'admin', state.idToken, action, payload).then((result) => {
      if (panel === 'cards') applyAdminCards(result);
      if (panel === 'events') applyAdminEventTickets(result);
      if (panel === 'calendar') applyAdminCalendarItems(result);
      state.loadedPanels[panel] = true;
    }).finally(() => { if (state.panelLoads[panel] === load) delete state.panelLoads[panel]; });
    state.panelLoads[panel] = load;
    return load;
  }

  function normalizeBookingServices(services) {
    return (Array.isArray(services) ? services : [])
      .map((service) => ({
        serviceId: String(service?.serviceId || '').trim(),
        title: String(service?.title || '').trim(),
        serviceType: String(service?.serviceType || '').trim(),
        isActive: service?.isActive !== false,
      }))
      .filter((service) => service.serviceId && service.title && service.serviceId !== STORE_SERVICE_ID);
  }

  function handleBookingServicesUpdated(event) {
    if (!Array.isArray(event?.detail?.services)) return;
    state.bookingServices = normalizeBookingServices(event.detail.services);
    document.querySelectorAll('[data-reward-required-service-ids]').forEach((root) => {
      renderRequiredServiceOptions(root, collectRequiredServiceIds(root));
    });
    if (els.eventTicketRequiredServiceIds) {
      renderRequiredServiceOptions(els.eventTicketRequiredServiceIds, collectRequiredServiceIds(els.eventTicketRequiredServiceIds));
      renderRequiredServiceOptions(els.eventTicketMinBookingServiceIds, collectRequiredServiceIds(els.eventTicketMinBookingServiceIds));
    }
    document.querySelectorAll('[data-reward-required-service-groups], #eventTicketRequiredServiceGroups').forEach(root => {
      renderRequiredServiceGroups(root, collectRequiredServiceGroups(root));
    });
  }

  function applyAdminCards(result, renderOverview = true, openEditors = new Set()) {
    if (Array.isArray(result.bookingServices)) state.bookingServices = normalizeBookingServices(result.bookingServices);
    state.cards = Array.isArray(result.cards) ? result.cards : [];
    state.cardSortOriginalOrder = state.cards.map((card) => String(card.cardId || ''));
    state.cardSortDirty = false;
    state.tickets = Array.isArray(result.tickets) ? result.tickets : [];
    state.stats = { ...state.stats, ...(result.stats && typeof result.stats === 'object' ? result.stats : {}) };
    if (renderOverview) renderAdminOverview();
    renderCardList(); renderTicketList();
    if (!openEditors.has('card')) {
      if (state.selectedCardId && state.cards.some((card) => card.cardId === state.selectedCardId)) loadCardForm(state.selectedCardId); else resetCardForm();
    }
    if (!openEditors.has('ticket')) {
      if (state.selectedTicketId && state.tickets.some((ticket) => ticket.ticketTemplateId === state.selectedTicketId)) loadTicketForm(state.selectedTicketId); else resetTicketForm();
    }
  }

  function applyAdminEventTickets(result, renderOverview = true, openEditors = new Set()) {
    if (Array.isArray(result.bookingServices)) state.bookingServices = normalizeBookingServices(result.bookingServices);
    const previousTickets = state.eventTickets;
    const nextTickets = Array.isArray(result.eventTickets) ? result.eventTickets : [];
    const listChanged = JSON.stringify(previousTickets) !== JSON.stringify(nextTickets);
    state.eventTickets = nextTickets;
    state.stats = { ...state.stats, ...(result.stats && typeof result.stats === 'object' ? result.stats : {}) };
    if (renderOverview) renderAdminOverview();
    if (listChanged || els.eventTicketListItems.children.length !== nextTickets.length) renderEventTicketList();
    renderEventTicketCalendar();

    if (state.selectedEventTicketId && !openEditors.has('eventTicket')) {
      const selected = nextTickets.find((ticket) => ticket.eventTicketId === state.selectedEventTicketId);
      if (!selected) {
        resetEventTicketForm(false);
        return;
      }
      const formVersion = String(els.eventTicketExpectedUpdatedAt.value || '');
      const serverVersion = String(selected.updatedAt || '');
      if (!formVersion || formVersion !== serverVersion) loadEventTicketForm(state.selectedEventTicketId, false);
    }
  }

  function applyAdminCalendarItems(result, preserveEditor = false) {
    state.calendarItems = Array.isArray(result.calendarItems) ? result.calendarItems : [];
    renderAdminCalendar();
    renderBookingOverviewCalendar();
    if (!preserveEditor) {
      if (state.selectedCalendarItemId && state.calendarItems.some((item) => item.calendarItemId === state.selectedCalendarItemId)) loadCalendarItemForm(state.selectedCalendarItemId); else resetCalendarItemForm();
    }
  }

  function renderMembers() {
    const members = state.members;
    const page = state.memberPage;
    els.memberResultCount.textContent = `共 ${page.total} 位會員`;
    els.memberTableBody.replaceChildren(...members.map((member) => {
      const row = document.createElement('tr');
      const memberCell = document.createElement('td'); memberCell.append(createMemberIdentity(member));
      const tierCell = document.createElement('td'); const tier = document.createElement('span'); tier.className = 'tier-text'; tier.textContent = String(member.tier || '一般會員'); tierCell.append(tier);
      const statusCell = document.createElement('td'); const status = document.createElement('span'); status.className = `status-pill${member.status === 'active' ? '' : ' disabled'}`; status.textContent = member.status === 'active' ? '啟用中' : '已停用'; statusCell.append(status);
      const presenceCell = document.createElement('td'); presenceCell.className = 'member-presence-cell';
      const presence = document.createElement('span'); presence.className = `member-presence-pill ${member.isOnline ? 'online' : 'offline'}`; presence.textContent = member.isOnline ? '上線' : '下線'; presenceCell.append(presence);
      if (member.isOnline && Array.isArray(member.onlineSurfaces) && member.onlineSurfaces.length) {
        const surfaces = document.createElement('small'); surfaces.textContent = member.onlineSurfaces.map(memberPresenceSurfaceLabel).join('、'); presenceCell.append(surfaces);
      }
      const serviceTimeCell = document.createElement('td'); serviceTimeCell.textContent = formatServiceMinutes(member.serviceMinutesTotal);
      const dateCell = document.createElement('td'); dateCell.textContent = window.MemberSystem.formatDate(member.joinedAt);
      const actionsCell = document.createElement('td'); actionsCell.className = 'align-right'; const actions = document.createElement('div'); actions.className = 'row-actions'; actions.append(actionButton('強制下線', 'force-logout', member.lineUserId), actionButton('會員 360', 'view-records', member.lineUserId)); actionsCell.append(actions);
      row.append(memberCell, tierCell, statusCell, presenceCell, serviceTimeCell, dateCell, actionsCell); return row;
    }));
    els.memberEmptyState.classList.toggle('hidden', members.length !== 0);
    renderMemberPagination();
  }

  function memberPagePayload(page, query) { return { memberPage: Math.max(1, Number(page) || 1), memberPageSize: state.memberPage.pageSize || 100, memberQuery: String(query || '').trim(), memberKind: 'real' }; }
  function applyMemberPage(value, fallback) {
    const source = value && typeof value === 'object' ? value : fallback || {};
    const pageSize = Math.max(1, Number(source.pageSize) || 100);
    const total = Math.max(0, Number(source.total) || 0);
    const totalPages = Math.max(1, Number(source.totalPages) || Math.ceil(total / pageSize) || 1);
    state.memberPage = { page: Math.min(Math.max(1, Number(source.page) || 1), totalPages), pageSize, total, totalPages, query: String(source.query || '').trim() };
  }
  function renderMemberPagination() {
    const page = state.memberPage;
    els.memberPagination.classList.toggle('hidden', page.totalPages <= 1);
    els.memberPrevPageButton.disabled = page.page <= 1;
    els.memberNextPageButton.disabled = page.page >= page.totalPages;
    els.memberPageStatus.textContent = `第 ${page.page} / ${page.totalPages} 頁`;
  }
  function renderTierSettings() {
    const inputsByKey = { general: els.tierGeneralMinutes, silver: els.tierSilverMinutes, gold: els.tierGoldMinutes, platinum: els.tierPlatinumMinutes };
    const stylesByKey = { general: els.tierGeneralStyle, silver: els.tierSilverStyle, gold: els.tierGoldStyle, platinum: els.tierPlatinumStyle };
    state.tierSettings.forEach((setting) => {
      const input = inputsByKey[setting && setting.tierKey];
      const style = stylesByKey[setting && setting.tierKey];
      if (!input || !style) return;
      input.value = String(Math.max(0, Math.floor(Number(setting.requiredServiceMinutes) || 0)));
      style.value = safeTierStyle(setting.styleKey);
      input.dataset.updatedAt = String(setting.updatedAt || '');
      style.dataset.updatedAt = String(setting.updatedAt || '');
    });
    syncTierStylePreviews();
  }
  function collectTierSettings() {
    return [
      ['general', els.tierGeneralMinutes, els.tierGeneralStyle], ['silver', els.tierSilverMinutes, els.tierSilverStyle], ['gold', els.tierGoldMinutes, els.tierGoldStyle], ['platinum', els.tierPlatinumMinutes, els.tierPlatinumStyle]
    ].map(([tierKey, input, style]) => ({ tierKey, requiredServiceMinutes: Number(input.value), styleKey: safeTierStyle(style.value), expectedUpdatedAt: String(input.dataset.updatedAt || '') }));
  }
  async function saveTierSettings(event) {
    event.preventDefault(); if (requireRefreshBeforeWrite(els.tierSettingsFormMessage)) return; hideMessage(els.tierSettingsFormMessage);
    const tierSettings = collectTierSettings();
    const invalid = tierSettings.some((setting, index) => !Number.isInteger(setting.requiredServiceMinutes) || setting.requiredServiceMinutes < 0 || setting.requiredServiceMinutes > 10000000 || !MEMBERSHIP_TIER_STYLE_KEYS.includes(setting.styleKey) || (index === 0 ? setting.requiredServiceMinutes !== 0 : setting.requiredServiceMinutes <= tierSettings[index - 1].requiredServiceMinutes));
    if (invalid) return showMessage(els.tierSettingsFormMessage, '門檻必須由一般會員 0 分鐘開始，銀級、金級與白金會員需依序遞增。');
    setSaving(els.saveTierSettingsButton, true, '正在儲存會員等級門檻…');
    try {
      const result = await window.MemberSystem.request(state.config, 'admin', state.idToken, 'admin.member-tiers.save', { tierSettings });
      state.tierSettings = Array.isArray(result.tierSettings) ? result.tierSettings : state.tierSettings;
      renderTierSettings();
      if (await refreshAfterSuccessfulWrite('會員等級與卡面樣式已儲存', els.tierSettingsFormMessage)) showMessage(els.tierSettingsFormMessage, '會員等級與卡面樣式已儲存，會員卡會依目前等級顯示對應外觀。', true);
    } catch (error) { handleActionError(error, els.tierSettingsFormMessage); } finally { setSaving(els.saveTierSettingsButton, false); }
  }
  function scheduleMemberSearch() {
    if (state.memberSearchTimer) window.clearTimeout(state.memberSearchTimer);
    const query = String(els.memberSearch.value || '').trim().toLowerCase();
    if (query === state.memberPage.query) return;
    state.memberSearchTimer = window.setTimeout(() => {
      state.memberSearchTimer = null;
      loadMembersPage(1, query).catch((error) => { setSyncStatus(error && error.message || '搜尋會員失敗，請稍後再試。', true); });
    }, 250);
  }
  async function loadMembersPage(page, query) {
    const requestVersion = ++state.memberRequestVersion;
    const requestStartedAt = Date.now();
    els.memberPrevPageButton.disabled = true;
    els.memberNextPageButton.disabled = true;
    try {
      const result = await window.MemberSystem.request(state.config, 'admin', state.idToken, 'admin.members.list', memberPagePayload(page, query));
      if (requestVersion !== state.memberRequestVersion) return;
      state.members = mergeNewerPresenceObservations(Array.isArray(result.members) ? result.members : [], requestStartedAt);
      memberPresencePageVersion++;
      applyMemberPage(result.memberPage, state.memberPage);
      renderMembers();
      void refreshMemberPresence().catch(() => {});
    } catch (error) {
      if (requestVersion === state.memberRequestVersion) renderMemberPagination();
      throw error;
    }
  }

  function memberPresenceSurfaceLabel(surface) {
    const labels = { member:'會員卡',points:'集點卡',event:'活動票券',calendar:'日曆',booking:'預約' };
    return labels[String(surface || '')] || '用戶端';
  }

  function createMemberIdentity(member) {
    const wrapper = document.createElement('div'); wrapper.className = 'member-cell'; const avatar = document.createElement('span'); avatar.className = 'member-avatar'; avatar.textContent = window.MemberSystem.initials(member.displayName); const copy = document.createElement('div'); const name = document.createElement('strong'); name.textContent = String(member.displayName || 'LINE 使用者'); const code = document.createElement('small'); code.textContent = String(member.memberCode || '尚未建立'); copy.append(name, code); wrapper.append(avatar, copy); return wrapper;
  }

  function actionButton(label, action, value, accent) { const button = document.createElement('button'); button.type = 'button'; button.className = `small-button${accent ? ' accent' : ''}`; button.dataset.action = action; button.dataset.value = String(value || ''); button.textContent = label; return button; }
  async function handleMemberTableClick(event) {
    const button = event.target instanceof Element ? event.target.closest('[data-action]') : null;
    if (!button) return;
    const member = state.members.find((item) => item.lineUserId === button.dataset.value);
    if (!member) return;
    if (button.dataset.action === 'force-logout') {
      const confirmed = window.confirm(`確定要強制結束「${member.displayName || member.memberCode || '此會員'}」目前所有登入工作階段嗎？\n\n此操作不會停用或刪除會員，會員之後可重新登入。`);
      if (!confirmed) return;
      button.disabled = true;
      try {
        await window.MemberSystem.request(state.config, 'admin', state.idToken, 'admin.member.force-logout', { lineUserId: member.lineUserId });
        setSyncStatus('已強制結束該會員的所有登入工作階段。');
        await loadMembersPage(state.memberPage.page, state.memberPage.query);
      } catch (error) {
        setSyncStatus(error && error.message || '強制下線失敗，請稍後再試。', true);
      } finally {
        button.disabled = false;
      }
      return;
    }
    if (button.dataset.action === 'view-records') {
      button.disabled = true;
      try { await openMemberRecordsModal(member); } finally { button.disabled = false; }
      return;
    }
  }



  const MEMBER_RECORD_FILTERS = Object.freeze([
    ['all', '全部'],
    ['presence', '上／下線'],
    ['pointCards', '集點卡'],
    ['eventTickets', '活動票券'],
    ['calendar', '日曆'],
    ['bookings', '預約'],
  ]);

  const MEMBER_RECORD_SUBFILTERS = Object.freeze({
    presence: [['online', '上線'], ['offline', '下線']],
    pointCards: [
      ['grant', '管理員發放'], ['earn', '獲得點數'], ['redeem', '兌換扣點'],
      ['booking_reward', '預約回饋'], ['calendar_bonus', '日曆回饋'], ['adjustment', '點數調整'],
      ['transfer_in', '轉入點數'], ['transfer_out', '轉出點數'], ['point_ticket', '集點票券'],
    ],
    eventTickets: [['coupon', '優惠券'], ['lottery', '抽獎券'], ['referral', '好友邀請券'], ['membership_join', '加入會員券']],
    calendar: [['event', '活動'], ['holiday', '休假日']],
    bookings: [
      ['pending', '待確認'], ['confirmed', '已確認'], ['cancellation_requested', '取消申請'],
      ['cancelled', '已取消'], ['completed', '已完成'], ['rejected', '已拒絕'], ['no_show', '無故未到'],
    ],
  });

  function memberRecordSubcategory(record, category) {
    const row = record && typeof record === 'object' ? record : {};
    const normalize = (value) => String(value || '').trim().toLowerCase();
    let value = '';
    if (category === 'presence') value = normalize(row.event);
    if (category === 'pointCards') {
      if (row.recordType === 'point_ticket') value = 'point_ticket';
      if (row.recordType === 'point_entry') {
        value = normalize(row.entryType);
        if (value === 'redemption') value = 'redeem';
        if (value === 'grant' && normalize(row.referenceType) === 'booking') value = 'booking_reward';
        if (value === 'grant' && normalize(row.referenceType) === 'calendar_bonus') value = 'calendar_bonus';
      }
    }
    if (category === 'eventTickets') value = normalize(row.ticketType);
    if (category === 'calendar') value = normalize(row.itemType);
    if (category === 'bookings') {
      value = normalize(row.status);
      if (value === 'cancel_requested'
        || (['pending', 'confirmed'].includes(value) && row.cancellationRequestedAt && !row.cancellationReviewedAt)) {
        value = 'cancellation_requested';
      }
    }
    return (MEMBER_RECORD_SUBFILTERS[category] || []).some(([key]) => key === value) ? value : 'other';
  }

  function memberRecordSubfilterOptions(category, records) {
    const rows = Array.isArray(records) ? records : [];
    const counts = Object.create(null);
    for (const record of rows) {
      const key = memberRecordSubcategory(record, category);
      counts[key] = (counts[key] || 0) + 1;
    }
    return [['all', '全部細項', rows.length], ...(MEMBER_RECORD_SUBFILTERS[category] || [])
      .concat([['other', '其他']]).map(([key, label]) => [key, label, counts[key] || 0])];
  }

  function memberRecordSubcategoryLabel(record, category) {
    const key = memberRecordSubcategory(record, category);
    return (MEMBER_RECORD_SUBFILTERS[category] || []).find(([value]) => value === key)?.[1] || '其他';
  }

  async function openMemberRecordsModal(member, showModal = true) {
    const requestVersion = ++state.memberRecords.requestVersion;
    state.memberRecords.lineUserId = String(member.lineUserId || '');
    state.memberRecords.filter = 'all';
    state.memberRecords.subfilter = 'all';
    state.memberRecords.data = null;
    state.memberRecords.member = member;
    els.memberRecordsIdentity.textContent = `${member.displayName || 'LINE 使用者'} · ${member.memberCode || '尚未建立'}`;
    els.memberRecordsSummary.replaceChildren();
    els.memberRecordsList.replaceChildren();
    els.memberRecordsEmpty.classList.add('hidden');
    hideMessage(els.memberRecordsMessage);
    hideMessage(els.memberRecordsModalMessage);
    els.memberUsageIntro.classList.add('hidden');
    els.memberUsageSelectedLabel.textContent = `${member.displayName || 'LINE 使用者'} · ${member.memberCode || '尚未建立'}`;
    const loading = document.createElement('div');
    loading.className = 'member-records-loading';
    loading.textContent = '正在讀取會員紀錄…';
    els.memberRecordsList.append(loading);
    renderMemberRecordTabs();
    els.memberRecordsFilterStatus.textContent = '正在讀取會員紀錄…';
    if (showModal) {
      els.memberRecordsModal.classList.remove('hidden');
      window.requestAnimationFrame(() => {
        if (!els.memberRecordsModal.classList.contains('hidden')) {
          try { els.closeMemberRecordsModal.focus({ preventScroll: true }); } catch (_) { els.closeMemberRecordsModal.focus(); }
        }
      });
    }

    try {
      const result = await window.MemberSystem.request(state.config, 'admin', state.idToken, 'admin.member-records.list', {
        lineUserId: state.memberRecords.lineUserId,
      });
      if (requestVersion !== state.memberRecords.requestVersion || state.memberRecords.lineUserId !== String(member.lineUserId || '')) return;
      state.memberRecords.data = result && typeof result === 'object' ? result : { records: {}, counts: {} };
      renderMemberRecords();
    } catch (error) {
      if (requestVersion !== state.memberRecords.requestVersion) return;
      els.memberRecordsList.replaceChildren();
      els.memberRecordsEmpty.classList.add('hidden');
      els.memberRecordsFilterStatus.textContent = '紀錄載入失敗';
      showMessage(els.memberRecordsMessage, error && error.message || '無法讀取會員紀錄，請稍後再試。');
      if (showModal) showMessage(els.memberRecordsModalMessage, error && error.message || '無法讀取會員紀錄，請稍後再試。');
    }
  }

  async function refreshOpenMemberRecords() {
    const lineUserId = String(state.memberRecords.lineUserId || '');
    if (!lineUserId || (els.memberRecordsModal.classList.contains('hidden') && els.memberUsagePanel.classList.contains('hidden'))) return;
    const requestVersion = ++state.memberRecords.requestVersion;
    try {
      const result = await window.MemberSystem.request(state.config, 'admin', state.idToken, 'admin.member-records.list', { lineUserId });
      if (requestVersion !== state.memberRecords.requestVersion || state.memberRecords.lineUserId !== lineUserId) return;
      state.memberRecords.data = result && typeof result === 'object' ? result : { records:{},counts:{} };
      renderMemberRecords();
    } catch (error) {
      if (requestVersion !== state.memberRecords.requestVersion || state.memberRecords.lineUserId !== lineUserId) return;
      showMessage(els.memberRecordsMessage, error && error.message || '會員紀錄即時同步失敗，將於下一次資料更新時重試。');
      if (!els.memberRecordsModal.classList.contains('hidden')) showMessage(els.memberRecordsModalMessage, error && error.message || '會員紀錄即時同步失敗，將於下一次資料更新時重試。');
    }
  }

  function clearMemberUsageHistory() {
    state.memberRecords.requestVersion++;
    state.memberRecords.lineUserId = '';
    state.memberRecords.member = null;
    state.memberRecords.data = null;
    state.memberRecords.filter = 'all';
    state.memberRecords.subfilter = 'all';
    els.memberUsageSelect.value = '';
    els.memberUsageSelectedLabel.textContent = '';
    els.memberRecordsSummary.replaceChildren();
    els.memberRecordsList.replaceChildren();
    els.memberRecordsEmpty.classList.add('hidden');
    els.memberUsageIntro.classList.remove('hidden');
    hideMessage(els.memberRecordsMessage);
    renderMemberRecordTabs();
    els.memberRecordsFilterStatus.textContent = '請先選擇會員';
  }

  async function loadMemberUsageRoster() {
    if (!state.idToken) return;
    const usage = state.memberUsage;
    const requestVersion = ++usage.requestVersion;
    usage.loaded = false;
    hideMessage(els.memberUsageRosterMessage);
    els.memberUsageSelect.disabled = true;
    els.memberUsagePrev.disabled = true;
    els.memberUsageNext.disabled = true;
    els.memberUsagePageStatus.textContent = '載入會員清單中…';
    const preferred = state.memberRecords.member;
    try {
      const result = await window.MemberSystem.request(state.config, 'admin', state.idToken, 'admin.members.list', {
        memberPage: usage.page, memberPageSize: 100, memberQuery: usage.query, memberKind: 'real',
      });
      if (requestVersion !== usage.requestVersion) return;
      const page = result.memberPage || {};
      usage.members = Array.isArray(result.members) ? result.members : [];
      usage.page = Number(page.page) || 1;
      usage.totalPages = Math.max(1, Number(page.totalPages) || 1);
      usage.total = Math.max(0, Number(page.total) || 0);
      usage.loaded = true;
      const options = [new Option('請選擇會員', '')];
      usage.members.forEach((member) => {
        options.push(new Option(`${member.displayName || 'LINE 使用者'} · ${member.memberCode || '尚未建立'}`, String(member.lineUserId || '')));
      });
      if (preferred && usage.kind === 'real'
          && !options.some((option) => option.value === preferred.lineUserId)) {
        options.push(new Option(`${preferred.displayName || 'LINE 使用者'} · ${preferred.memberCode || '尚未建立'}（目前選取）`, preferred.lineUserId));
      }
      els.memberUsageSelect.replaceChildren(...options);
      els.memberUsageSelect.value = preferred && options.some((option) => option.value === preferred.lineUserId) ? preferred.lineUserId : '';
      els.memberUsageSelect.disabled = false;
      els.memberUsagePrev.disabled = usage.page <= 1;
      els.memberUsageNext.disabled = usage.page >= usage.totalPages;
      els.memberUsagePageStatus.textContent = `共 ${usage.total} 位會員 · 第 ${usage.page} / ${usage.totalPages} 頁`;
      if (!usage.total && !preferred) els.memberUsagePageStatus.textContent = '沒有符合條件的會員';
    } catch (error) {
      if (requestVersion !== usage.requestVersion) return;
      els.memberUsagePageStatus.textContent = '會員清單載入失敗';
      showMessage(els.memberUsageRosterMessage, error?.message || '無法讀取會員清單，請重新切換分頁再試。');
    }
  }

  function closeMemberRecordsModal() {
    els.memberRecordsModal.classList.add('hidden');
  }

  function handleMemberRecordsTabClick(event) {
    const button = event.target instanceof Element ? event.target.closest('[data-record-filter]') : null;
    if (!button || !state.memberRecords.data) return;
    const filter = String(button.dataset.recordFilter || 'all');
    if (!MEMBER_RECORD_FILTERS.some(([value]) => value === filter)) return;
    state.memberRecords.filter = filter;
    state.memberRecords.subfilter = 'all';
    renderMemberRecords();
  }

  function handleMemberRecordsSummaryClick(event) {
    const button = event.target instanceof Element ? event.target.closest('[data-record-summary-filter]') : null;
    if (!button || !state.memberRecords.data) return;
    const filter = String(button.dataset.recordSummaryFilter || '');
    if (!MEMBER_RECORD_FILTERS.some(([value]) => value === filter)) return;
    state.memberRecords.filter = filter;
    state.memberRecords.subfilter = 'all';
    renderMemberRecords();
    const activeTab = els.memberRecordsTabs.querySelector('[data-record-filter="' + filter + '"]');
    try { activeTab?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' }); } catch (_) {}
  }

  function memberRecordCounts() {
    const data = state.memberRecords.data || {};
    const records = data.records && typeof data.records === 'object' ? data.records : {};
    const counts = data.counts && typeof data.counts === 'object' ? data.counts : {};
    const result = {};
    for (const [key] of MEMBER_RECORD_FILTERS) {
      if (key === 'all') continue;
      result[key] = Math.max(0, Number(counts[key] ?? (Array.isArray(records[key]) ? records[key].length : 0)) || 0);
    }
    result.all = Object.values(result).reduce((sum, value) => sum + Number(value || 0), 0);
    return result;
  }

  function renderMemberRecordTabs() {
    if (!els.memberRecordsTabs) return;
    const counts = memberRecordCounts();
    els.memberRecordsTabs.querySelectorAll('[data-record-filter]').forEach((button) => {
      const filter = String(button.dataset.recordFilter || 'all');
      const item = MEMBER_RECORD_FILTERS.find(([key]) => key === filter);
      button.textContent = `${item ? item[1] : '全部'} ${counts[filter] || 0}`;
      const selected = state.memberRecords.filter === filter;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
    renderMemberRecordSubfilters();
  }

  function renderMemberRecordSubfilters() {
    const category = state.memberRecords.filter;
    const records = state.memberRecords.data?.records?.[category];
    const options = memberRecordSubfilterOptions(category, records);
    const disabled = category === 'all' || !state.memberRecords.data;
    if (disabled || !options.some(([key]) => key === state.memberRecords.subfilter)) state.memberRecords.subfilter = 'all';
    els.memberRecordsSubfilter.disabled = disabled;
    els.memberRecordsSubfilter.replaceChildren(...(disabled ? [['all', '先選擇上方分類']] : options).map(([key, label, count]) => {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = count === undefined ? label : `${label} ${count}`;
      return option;
    }));
    els.memberRecordsSubfilter.value = state.memberRecords.subfilter;
  }

  function renderMemberRecords() {
    hideMessage(els.memberRecordsMessage);
    renderMemberRecordsOverview();
    const counts = memberRecordCounts();
    const summary = [
      ['上／下線', counts.presence],
      ['集點卡', counts.pointCards],
      ['活動票券', counts.eventTickets],
      ['日曆', counts.calendar],
      ['預約', counts.bookings],
    ];
    const summaryFilters = ['presence', 'pointCards', 'eventTickets', 'calendar', 'bookings'];
    els.memberRecordsSummary.replaceChildren(...summary.map(([label, count], index) => {
      const filter = summaryFilters[index] || 'all';
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'member-record-summary-pill';
      pill.dataset.recordSummaryFilter = filter;
      const selected = state.memberRecords.filter === filter;
      pill.classList.toggle('active', selected);
      pill.setAttribute('aria-pressed', selected ? 'true' : 'false');
      const name = document.createElement('span');
      name.textContent = String(label);
      const value = document.createElement('strong');
      value.textContent = String(count || 0);
      const hint = document.createElement('small');
      hint.textContent = '查看';
      pill.append(name, value, hint);
      return pill;
    }));
    renderMemberRecordTabs();
    renderMemberRecordList();
  }



  function memberProfileContactFields(member) {
    const source = member && typeof member === 'object' ? member : {};
    const phone = String(source.phone || '').trim();
    const birthday = String(source.birthday || '').trim();
    return [
      ['聯絡電話', phone || '未填寫'],
      ['生日', birthday ? birthday.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$1/$2/$3') : '未填寫'],
    ];
  }

  function renderMemberRecordsOverview() {
    if (!els.memberRecordsOverview) return;
    const member = state.memberRecords.member;
    if (!member) { els.memberRecordsOverview.replaceChildren(); return; }
    const counts = memberRecordCounts();
    const metrics = [
      ['會員等級', String(member.tier || '一般會員')],
      ['累積服務時間', formatServiceMinutes(Number(member.serviceMinutesTotal || 0))],
      ['全部紀錄', String(counts.all || 0) + ' 筆'],
      ['預約紀錄', String(counts.bookings || 0) + ' 筆'],
    ];

    const hero = document.createElement('div');
    hero.className = 'member-records-overview-hero';
    const avatar = document.createElement('span');
    avatar.className = 'member-records-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = window.MemberSystem.initials(member.displayName || 'LINE 使用者');

    const copy = document.createElement('div');
    copy.className = 'member-records-overview-copy';
    const eyebrow = document.createElement('span');
    eyebrow.className = 'member-records-overview-eyebrow';
    eyebrow.textContent = '會員';
    const title = document.createElement('strong');
    title.textContent = String(member.displayName || 'LINE 使用者');
    const meta = document.createElement('div');
    meta.className = 'member-records-overview-meta';
    const code = document.createElement('span');
    code.textContent = String(member.memberCode || '尚未建立會員編號');
    const status = document.createElement('span');
    status.className = `member-records-status ${member.status === 'disabled' ? 'is-disabled' : 'is-active'}`;
    status.textContent = member.status === 'disabled' ? '已停用' : '啟用中';
    meta.append(code, status);
    const contact = document.createElement('div');
    contact.className = 'member-records-overview-contact';
    memberProfileContactFields(member).forEach(([label, value]) => {
      const item = document.createElement('span');
      const contactLabel = document.createElement('small');
      contactLabel.textContent = label;
      const contactValue = document.createElement('strong');
      contactValue.textContent = value;
      item.append(contactLabel, contactValue);
      contact.append(item);
    });
    copy.append(eyebrow, title, meta, contact);
    hero.append(avatar, copy);

    const metricGrid = document.createElement('div');
    metricGrid.className = 'member-records-overview-metrics';
    metrics.forEach(([label, value], index) => {
      const item = document.createElement('span');
      item.className = index < 2 ? 'is-primary' : '';
      if (index === 3) item.dataset.businessRequires = 'membership booking';
      const small = document.createElement('small'); small.textContent = label;
      const strong = document.createElement('strong'); strong.textContent = value;
      item.append(small, strong); metricGrid.append(item);
    });

    const actions = document.createElement('div');
    actions.className = 'member-records-overview-actions';

    const statusAction = document.createElement('button');
    statusAction.type = 'button';
    statusAction.className = 'button button-outline member-records-action-secondary';
    statusAction.textContent = '狀態';
    statusAction.addEventListener('click', () => {
      state.memberRecords.childOpener = statusAction;
      openMemberModal(member);
    });

    const grantAction = document.createElement('button');
    grantAction.type = 'button';
    grantAction.className = 'button button-dark';
    grantAction.textContent = '＋ 發放';
    grantAction.addEventListener('click', async () => {
      state.memberRecords.childOpener = grantAction;
      grantAction.disabled = true;
      hideMessage(els.memberRecordsModalMessage);
      try {
        if (!state.loadedPanels.cards) await ensureAdminPanelData('cards');
        openGrantModal(member);
      } catch (error) {
        state.memberRecords.childOpener = null;
        showMessage(els.memberRecordsModalMessage, error && error.message || '無法載入發放資料，請稍後再試。');
      } finally {
        grantAction.disabled = false;
      }
    });

    const removeAction = document.createElement('button');
    removeAction.type = 'button'; removeAction.className = 'button button-outline'; removeAction.textContent = '移除會員全部資料';
    removeAction.addEventListener('click', async () => {
      const confirmed = window.prompt(`此操作不可復原。將移除 ${member.displayName || '會員'} 的個人資料、連線、收據、點數、票券及好友關聯；其他會員已取得的權益會保留。重新註冊不會復原舊資料。請輸入完整會員編號 ${member.memberCode} 確認：`);
      if (confirmed !== member.memberCode) { if (confirmed !== null) showMessage(els.memberRecordsModalMessage, '會員編號不符，未開始移除。'); return; }
      if (!window.confirm('確定永久移除此會員？已移除的資料無法復原。')) return;
      removeAction.disabled = true; statusAction.disabled = true; grantAction.disabled = true;
      showMessage(els.memberRecordsModalMessage, '正在撤銷連線並清除會員資料…');
      try {
        const result = await window.MemberSystem.request(state.config, 'admin', state.idToken, 'admin.member.remove', { lineUserId: member.lineUserId, confirmMemberCode: confirmed });
        if (result.state !== 'complete') throw new Error('清理尚未完成，請重試移除。');
        closeMemberRecordsModal(); await loadMembersPage(state.memberPage.page, state.memberPage.query);
      } catch (error) { showMessage(els.memberRecordsModalMessage, error.message || '移除尚未完成，請重試。'); }
      finally { removeAction.disabled = false; statusAction.disabled = false; grantAction.disabled = false; }
    });
    actions.append(statusAction, grantAction, removeAction);

    els.memberRecordsOverview.replaceChildren(hero, metricGrid, actions);
  }

  function memberRecordsForFilter() {
    const data = state.memberRecords.data || {};
    const records = data.records && typeof data.records === 'object' ? data.records : {};
    const combined = [];
    for (const [category] of MEMBER_RECORD_FILTERS) {
      if (category === 'all') continue;
      if (state.memberRecords.filter !== 'all' && category !== state.memberRecords.filter) continue;
      for (const record of Array.isArray(records[category]) ? records[category] : []) {
        if (state.memberRecords.filter !== 'all' && state.memberRecords.subfilter && state.memberRecords.subfilter !== 'all'
          && memberRecordSubcategory(record, category) !== state.memberRecords.subfilter) continue;
        combined.push({ ...record, recordCategory: category });
      }
    }
    return combined.sort((a, b) => memberRecordSortValue(b) - memberRecordSortValue(a));
  }

  function memberRecordSortValue(record) {
    const raw = String(record && record.occurredAt || '');
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
  }

  function renderMemberRecordList() {
    const records = memberRecordsForFilter();
    els.memberRecordsList.replaceChildren(...records.map(createMemberRecordItem));
    els.memberRecordsEmpty.classList.toggle('hidden', records.length !== 0);
    const total = memberRecordCounts()[state.memberRecords.filter] || 0;
    els.memberRecordsFilterStatus.textContent = `顯示 ${records.length} / ${total} 筆 · 最新紀錄優先`;
  }

  function createMemberRecordItem(record) {
    const category = String(record.recordCategory || '');
    const article = document.createElement('article');
    article.className = `member-record-item category-${category}`;
    const feature = {pointCards:'points',eventTickets:'events',calendar:'calendar',bookings:'booking',testAutomation:'testing'}[category];
    article.dataset.businessRequires = feature ? 'membership ' + feature : 'membership';

    const heading = document.createElement('div');
    heading.className = 'member-record-item-heading';
    const categoryPill = document.createElement('span');
    categoryPill.className = 'member-record-category';
    categoryPill.textContent = memberRecordCategoryLabel(category);
    const time = document.createElement('time');
    time.textContent = formatMemberRecordDateTime(record.occurredAt);
    const subtype = document.createElement('span');
    subtype.className = 'member-record-subcategory';
    subtype.textContent = memberRecordSubcategoryLabel(record, category);
    heading.append(categoryPill, subtype, time);

    const title = document.createElement('strong');
    title.className = 'member-record-title';
    title.textContent = memberRecordTitle(record, category);

    const summary = document.createElement('p');
    summary.className = 'member-record-summary';
    summary.textContent = memberRecordSummary(record, category);

    const details = memberRecordDetails(record, category);
    const detailWrap = document.createElement('div');
    detailWrap.className = 'member-record-details';
    details.filter(Boolean).forEach((detail) => {
      const line = document.createElement('small');
      line.textContent = String(detail);
      detailWrap.append(line);
    });

    article.append(heading, title, summary);
    if (detailWrap.childElementCount) article.append(detailWrap);
    return article;
  }

  function memberRecordCategoryLabel(category) {
    const item = MEMBER_RECORD_FILTERS.find(([key]) => key === category);
    return item ? item[1] : '紀錄';
  }

  function memberRecordTitle(record, category) {
    if (category === 'presence') return { online: '會員上線', offline: '會員下線' }[memberRecordSubcategory(record, category)] || '會員連線紀錄';
    if (category === 'pointCards' && record.recordType === 'point_entry') return String(record.title || '集點卡點數');
    if (category === 'pointCards' && record.recordType === 'point_ticket') return String(record.title || '集點卡票券');
    if (category === 'eventTickets') return String(record.title || '活動票券');
    if (category === 'calendar') return String(record.title || '日曆項目');
    if (category === 'bookings') return String(record.title || '預約');
    return String(record.title || '會員紀錄');
  }

  function memberRecordSummary(record, category) {
    if (category === 'presence') {
      const event = { online: '上線', offline: '下線' }[memberRecordSubcategory(record, category)] || '未識別的連線事件';
      return `${event} · ${memberRecordPresenceSurfaceLabel(record.surface)}`;
    }
    if (category === 'pointCards' && record.recordType === 'point_entry') {
      const amount = Number(record.amount || 0);
      return `點數異動 ${amount > 0 ? '+' : ''}${amount} 點`;
    }
    if (category === 'pointCards' && record.recordType === 'point_ticket') {
      return `集點票券 · ${memberRecordStatusLabel(record.status, 'ticket')}`;
    }
    if (category === 'eventTickets') return `${memberRecordTicketTypeLabel(record.ticketType)} · ${memberRecordStatusLabel(record.status, 'ticket')}`;
    if (category === 'calendar') {
      const start = record.startsOn ? window.MemberSystem.formatDate(record.startsOn) : '日期未設定';
      const end = record.endsOn && record.endsOn !== record.startsOn ? ` ～ ${window.MemberSystem.formatDate(record.endsOn)}` : '';
      return `${start}${end} · ${memberRecordStatusLabel(record.status, 'calendar')}`;
    }
    if (category === 'bookings') {
      const date = record.bookingDate ? window.MemberSystem.formatDate(record.bookingDate) : '日期未設定';
      const startDate = String(record.startAt || '').slice(0, 10) || record.bookingDate;
      const endDate = String(record.endAt || '').slice(0, 10) || record.bookingDate;
      const time = `${startDate} ${String(record.startTime || '').slice(0, 5)}–${endDate} ${String(record.endTime || '').slice(0, 5)}`;
      return `營業日 ${date} · ${time} · ${memberRecordStatusLabel(record.status, 'booking')}`;
    }
    return '會員使用紀錄';
  }

  function memberRecordDetails(record, category) {
    const details = [];
    if (category === 'presence') {
      details.push(`來源：${memberRecordPresenceSurfaceLabel(record.surface)}`);
      if (record.reason) details.push(`原因：${memberRecordPresenceReasonLabel(record.reason, record.event)}`);
      return details;
    }
    if (category === 'pointCards' && record.recordType === 'point_entry') {
      if (record.entryType) details.push(`類型：${memberRecordSubcategoryLabel(record, category)}`);
      if (record.note) details.push(`備註：${record.note}`);
      if (record.referenceType) details.push(`來源：${memberRecordReferenceLabel(record.referenceType)}`);
      return details;
    }
    if (category === 'pointCards' && record.recordType === 'point_ticket') {
      if (record.cardTitle) details.push(`來源集點卡：${record.cardTitle}`);
      if (Number(record.pointsSpent || 0) > 0) details.push(`兌換扣除：${Number(record.pointsSpent)} 點`);
      if (record.earnedAt) details.push(`取得：${formatMemberRecordDateTime(record.earnedAt)}`);
      if (record.usedAt) details.push(`使用：${formatMemberRecordDateTime(record.usedAt)}`);
      const result = memberRecordResultText(record.result);
      if (result) details.push(`結果：${result}`);
      return details;
    }
    if (category === 'eventTickets') {
      if (record.claimedAt) details.push(`領取：${formatMemberRecordDateTime(record.claimedAt)}`);
      if (record.usedAt) details.push(`使用：${formatMemberRecordDateTime(record.usedAt)}`);
      const result = memberRecordResultText(record.result);
      if (result) details.push(`結果：${result}`);
      return details;
    }
    if (category === 'calendar') {
      if (record.relatedTicketTitle) details.push(`關聯票券：${record.relatedTicketTitle}`);
      if (record.relatedTicketStatus) details.push(`票券狀態：${memberRecordStatusLabel(record.relatedTicketStatus, 'ticket')}`);
      return details;
    }
    if (category === 'bookings') {
      const participants = Array.isArray(record.participants) ? record.participants : [];
      if (participants.length) {
        participants.forEach((participant) => {
          const items = (Array.isArray(participant.items) ? participant.items : []).map((item) => {
            const qty = Number(item.quantity || 1);
            const duration = Number(item.durationMinutes || 0);
            const price = Number(item.priceAmount || 0);
            const suffix = [duration > 0 ? `${duration} 分鐘` : '', price > 0 ? formatMemberRecordMoney(price * qty) : ''].filter(Boolean).join(' / ');
            return `${item.title || '預約項目'}${qty > 1 ? ' × ' + qty : ''}${suffix ? '（' + suffix + '）' : ''}`;
          });
          const tech = participant.technicianName ? ` · 技師：${participant.technicianName}` : '';
          details.push(`第 ${Math.max(1, Number(participant.position || 1))} 位：${items.join('、') || '未取得項目'}${tech}`);
        });
      } else {
        if (record.technicianName) details.push(`技師：${record.technicianName}`);
        if (Number(record.partySize || 1) > 1) details.push(`預約人數：${Number(record.partySize)} 位`);
      }
      if (Number(record.totalDurationMinutes || 0) > 0) details.push(`總服務時間：${Number(record.totalDurationMinutes)} 分鐘`);
      if (record.memberNote) details.push(`會員備註：${record.memberNote}`);
      if (record.cancellationRequestedAt && !record.cancelledAt) details.push(`取消申請：${formatMemberRecordDateTime(record.cancellationRequestedAt)}`);
      if (record.settlement && Number(record.settlement.serviceMinutes || 0) > 0) details.push(`完成後計入服務時間：${Number(record.settlement.serviceMinutes)} 分鐘`);
      if (record.settlement && record.settlement.rewardDetails) details.push('完成後集點回饋已結算');
      return details;
    }
    return details;
  }

  function memberRecordPresenceSurfaceLabel(surface) {
    const labels = {
      member:'會員卡',
      points:'集點卡',
      event:'活動票券',
      calendar:'日曆',
      booking:'預約',
    };
    return labels[String(surface || '').toLowerCase()] || '會員系統';
  }

  function memberRecordPresenceReasonLabel(reason, event) {
    const labels = {
      signin:'登入完成',
      resume:'返回頁面',
      relogin:'重新登入',
      logout:'主動登出',
      pagehide:'離開頁面',
      hidden:'LINE 頁面轉入背景或關閉',
      bfcache:'頁面暫存離開',
    };
    return labels[String(reason || '').toLowerCase()]
      || { online: '上線', offline: '離線' }[String(event || '').trim().toLowerCase()] || '未識別的連線事件';
  }

  function memberRecordStatusLabel(status, kind) {
    const value = String(status || '').toLowerCase();
    const common = {
      available:'可使用', claimed:'已領取', used:'已使用', expired:'已過期', cancelled:'已取消',
      active:'啟用中', targeted:'指定會員', draft:'草稿', archived:'已封存',
      pending:'待確認', confirmed:'已確認', completed:'已完成', rejected:'已拒絕',
    };
    if (value === 'cancellation_requested') return '取消申請';
    if (kind === 'booking' && value === 'cancel_requested') return '取消申請';
    return common[value] || String(status || '—');
  }

  function memberRecordTicketTypeLabel(type) {
    const value = String(type || '').toLowerCase();
    if (value === 'lottery') return '抽獎券';
    if (value === 'coupon') return '優惠券';
    if (value === 'referral') return '好友邀請券';
    if (value === 'membership_join') return '加入會員券';
    return '活動票券';
  }

  function memberRecordPointEntryLabel(type) {
    const value = String(type || '').toLowerCase();
    const labels = {
      grant:'管理員發放', earn:'獲得點數', redeem:'兌換扣點', redemption:'兌換扣點',
      booking_reward:'預約完成回饋', calendar_bonus:'日曆活動回饋', adjustment:'點數調整',
    };
    return labels[value] || String(type || '點數異動');
  }

  function memberRecordReferenceLabel(type) {
    const value = String(type || '').toLowerCase();
    const labels = { booking:'預約', calendar:'日曆', calendar_bonus:'日曆活動回饋', point_transfer:'會員點數轉贈', event_ticket:'活動票券', admin:'管理員操作', point_ticket:'集點票券' };
    return labels[value] || String(type || '');
  }

  function memberRecordResultText(result) {
    if (!result) return '';
    if (typeof result === 'string' || typeof result === 'number') return String(result);
    if (typeof result !== 'object') return '';
    return String(result.prizeTitle || result.title || result.name || result.message || '');
  }

  function formatMemberRecordDateTime(value) {
    const text = String(value || '');
    if (!text) return '—';
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return window.MemberSystem.formatDate(text);
    return window.MemberSystem.formatDateTime(text);
  }

  function formatMemberRecordTimeRange(start, end) {
    const normalize = (value) => String(value || '').slice(0,5);
    const startText = normalize(start);
    const endText = normalize(end);
    if (!startText) return '';
    return endText ? `${startText}–${endText}` : startText;
  }

  function formatMemberRecordMoney(value) {
    return `NT ${Math.max(0, Number(value || 0)).toLocaleString('zh-TW')}`;
  }

  function parseAdminIsoDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
    if (!match) return null;
    const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
  }
  function toAdminIsoDate(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
    const year = date.getUTCFullYear(); const month = String(date.getUTCMonth() + 1).padStart(2, '0'); const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  function todayAdminIsoDate() {
    const values = {};
    new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).forEach((part) => { if (part.type !== 'literal') values[part.type] = part.value; });
    return `${values.year}-${values.month}-${values.day}`;
  }
  function addAdminDays(value, amount) {
    const date = parseAdminIsoDate(value); const days = Number(amount);
    if (!date || !Number.isFinite(days)) return '';
    date.setUTCDate(date.getUTCDate() + Math.trunc(days));
    return toAdminIsoDate(date);
  }
  function formatAdminDateValue(value, includeWeekday) {
    const date = parseAdminIsoDate(value); if (!date) return '';
    const options = { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' };
    if (includeWeekday) options.weekday = 'short';
    return new Intl.DateTimeFormat('zh-Hant-TW', options).format(date);
  }
  function formatAdminDateCompact(value) {
    const date = parseAdminIsoDate(value); if (!date) return String(value || '');
    return new Intl.DateTimeFormat('zh-Hant-TW', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  }
  function setAdminDateInput(input, value) {
    if (!(input instanceof HTMLInputElement)) return;
    input.value = String(value || '');
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function updateCardExpiryDateUI() {
    if (!els.cardExpiresOnSummary) return;
    const limited = els.cardExpiryMode.value === 'date'; const value = String(els.cardExpiresOn.value || '').trim(); const parsed = value ? parseAdminIsoDate(value) : null;
    els.cardExpiresOnSummary.textContent = limited ? (parsed ? formatAdminDateValue(value, true) : '請選擇到期日') : '無期限';
    els.cardExpiresOnField.classList.toggle('invalid', limited && Boolean(value) && !parsed);
  }
  function updateEventTicketValidityUI() {
    const mode = els.eventTicketValidityMode.value;
    document.getElementById('eventTicketValidityDaysField').classList.toggle('hidden', mode === 'fixed');
    els.eventTicketEndsOn.closest('.date-control')?.classList.toggle('hidden', mode === 'relative');
    els.eventTicketForm.querySelector('.date-range-presets')?.classList.toggle('hidden', mode === 'relative');
    updateEventTicketDateRangeUI();
  }
  function updateEventTicketDateRangeUI() {
    if (!els.eventTicketDateRangeSummary || !els.eventTicketDateRangeMessage) return;
    if (els.eventTicketValidityMode.value === 'relative') {
      const days = Number(els.eventTicketValidityDays.value);
      els.eventTicketDateRangeSummary.textContent = Number.isSafeInteger(days) && days > 0 ? `獲得後 ${days} 天` : '請填寫有效天數';
      els.eventTicketDateRangeMessage.textContent = '不受固定結束日期限制，每張票券以會員獲得時間獨立計算。';
      els.eventTicketDateRangeMessage.classList.remove('warning');
      return;
    }
    const startsOn = String(els.eventTicketStartsOn.value || '').trim(); const endsOn = String(els.eventTicketEndsOn.value || '').trim();
    const startDate = startsOn ? parseAdminIsoDate(startsOn) : null; const endDate = endsOn ? parseAdminIsoDate(endsOn) : null; const validationMessage = validateEventTicketDates(startsOn, endsOn);
    const startControl = els.eventTicketStartsOn.closest('.date-control'); const endControl = els.eventTicketEndsOn.closest('.date-control');
    if (startControl) startControl.classList.toggle('invalid', Boolean(startsOn) && !startDate || Boolean(startDate && endDate && startDate > endDate));
    if (endControl) endControl.classList.toggle('invalid', Boolean(endsOn) && !endDate || Boolean(startDate && endDate && startDate > endDate));
    els.eventTicketDateRangeMessage.classList.toggle('warning', Boolean(validationMessage));
    if (validationMessage) { els.eventTicketDateRangeSummary.textContent = '日期需要調整'; els.eventTicketDateRangeMessage.textContent = validationMessage; return; }
    if (!startsOn && !endsOn) { els.eventTicketDateRangeSummary.textContent = '不限制日期'; els.eventTicketDateRangeMessage.textContent = '未設定期間限制，票券會依公開狀態與其他條件判定是否可用。'; return; }
    if (startDate && endDate) {
      const days = Math.round((endDate.getTime() - startDate.getTime()) / 86400000) + 1;
      els.eventTicketDateRangeSummary.textContent = `${formatAdminDateCompact(startsOn)} → ${formatAdminDateCompact(endsOn)}`;
      els.eventTicketDateRangeMessage.textContent = `${formatAdminDateValue(startsOn, true)} 至 ${formatAdminDateValue(endsOn, true)}，共 ${days} 天。`;
      return;
    }
    if (startDate) { els.eventTicketDateRangeSummary.textContent = `自 ${formatAdminDateCompact(startsOn)} 起`; els.eventTicketDateRangeMessage.textContent = `從 ${formatAdminDateValue(startsOn, true)} 起生效，未設定結束日。`; return; }
    els.eventTicketDateRangeSummary.textContent = `至 ${formatAdminDateCompact(endsOn)}`;
    els.eventTicketDateRangeMessage.textContent = `截至 ${formatAdminDateValue(endsOn, true)}，未設定開始日。`;
  }
  function handleAdminDateControlClick(event) {
    const button = event.target instanceof Element ? event.target.closest('[data-open-date-picker], [data-date-target], [data-event-range-days], [data-event-range-action]') : null;
    if (!button) return;
    const pickerTargetId = String(button.dataset.openDatePicker || '');
    if (pickerTargetId) {
      const input = document.getElementById(pickerTargetId); if (!(input instanceof HTMLInputElement)) return;
      event.preventDefault();
      try { if (typeof input.showPicker === 'function') { input.showPicker(); return; } } catch (_) {}
      input.focus({ preventScroll: true });
      input.click();
      return;
    }
    const targetId = String(button.dataset.dateTarget || '');
    if (targetId) {
      const input = document.getElementById(targetId); if (!(input instanceof HTMLInputElement)) return;
      const action = String(button.dataset.dateAction || ''); const today = todayAdminIsoDate(); let nextValue = '';
      if (action === 'clear') nextValue = '';
      else if (action === 'end-of-year') nextValue = `${today.slice(0, 4)}-12-31`;
      else if (button.dataset.dateOffset !== undefined) nextValue = addAdminDays(today, Number(button.dataset.dateOffset));
      else return;
      event.preventDefault(); setAdminDateInput(input, nextValue); return;
    }
    if (button.dataset.eventRangeAction === 'clear') {
      event.preventDefault(); els.eventTicketStartsOn.value = ''; els.eventTicketEndsOn.value = ''; updateEventTicketDateRangeUI(); return;
    }
    if (button.dataset.eventRangeDays !== undefined) {
      const days = Number(button.dataset.eventRangeDays); if (!Number.isInteger(days) || days < 1) return;
      event.preventDefault(); const startsOn = todayAdminIsoDate(); els.eventTicketStartsOn.value = startsOn; els.eventTicketEndsOn.value = addAdminDays(startsOn, days - 1); updateEventTicketDateRangeUI();
    }
  }

  function renderCardList() {
    els.cardResultCount.textContent = String(state.cards.length); els.cardEmptyState.classList.toggle('hidden', state.cards.length !== 0);
    els.cardListItems.replaceChildren(...state.cards.map((card, index) => {
      const cardId = String(card.cardId); const titleText = String(card.title || '未命名集點卡');
      const item = document.createElement('article'); item.className = 'card-sort-item'; item.dataset.cardSortItem = 'true'; item.dataset.cardId = cardId; item.setAttribute('aria-roledescription', '可拖曳集點卡');
      const button = document.createElement('button'); button.type = 'button'; button.className = 'card-list-item card-list-item-main'; button.dataset.cardId = cardId; button.setAttribute('aria-selected', cardId === state.selectedCardId ? 'true' : 'false'); button.style.setProperty('--card-accent', safeAccent(card.accent));
      const title = document.createElement('strong'); const dot = document.createElement('i'); title.append(dot, document.createTextNode(titleText));
      const meta = document.createElement('small'); meta.textContent = cardSortMeta(card, index);
      button.append(title, meta);
      const controls = document.createElement('div'); controls.className = 'card-sort-controls'; controls.setAttribute('aria-label', `調整${titleText}顯示順序`);
      controls.append(createCardSortMoveButton(cardId, titleText, 'up', index === 0), createCardSortMoveButton(cardId, titleText, 'down', index === state.cards.length - 1));
      item.append(button, controls); return item;
    }));
    updateCardSortSaveState();
  }

  function createCardSortMoveButton(cardId, title, direction, disabled) { const button = document.createElement('button'); button.type = 'button'; button.className = 'card-sort-move'; button.dataset.cardSortMove = direction; button.dataset.cardId = cardId; button.disabled = disabled; button.setAttribute('aria-label', direction === 'up' ? `將${title}上移一位` : `將${title}下移一位`); button.textContent = direction === 'up' ? '↑' : '↓'; return button; }

  function cardSortMeta(card, index) {
    const expiry = card.expiryMode === 'date' && card.expiresOn ? `到期 ${formatAdminDateCompact(card.expiresOn)}` : '無期限';
    return `第 ${index + 1} 張 · ${Array.isArray(card.rewards) ? card.rewards.length : 0} 個兌換節點 · ${expiry} · ${statusLabel(card.status)}`;
  }

  function handleCardListClick(event) {
    const move = event.target instanceof Element ? event.target.closest('[data-card-sort-move]') : null;
    if (move) { adjustCardSortPosition(move.dataset.cardId, move.dataset.cardSortMove === 'up' ? -1 : 1); return; }
    if (state.suppressCardClick) return;
    const button = event.target instanceof Element ? event.target.closest('[data-card-id]') : null;
    if (button) { loadCardForm(button.dataset.cardId); openEditorModal('card'); }
  }

  function handleCardSortPointerDown(event) {
    if (state.cardSortBusy || state.writeConfirmationRequired || (event.pointerType && event.pointerType !== 'mouse') || (event.button !== undefined && event.button !== 0)) return;
    // Keep the move buttons' click target; pointer capture would retarget their
    // native mouse click to the card and open its editor instead of sorting.
    if (event.target instanceof Element && event.target.closest('[data-card-sort-move]')) return;
    const item = event.target instanceof Element ? event.target.closest('[data-card-sort-item]') : null;
    if (!item || item.parentElement !== els.cardListItems) return;
    state.cardSortDrag = { item, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, active: false };
    if (typeof item.setPointerCapture === 'function') {
      try { item.setPointerCapture(event.pointerId); } catch (_) {}
    }
  }

  function handleCardSortPointerMove(event) {
    const drag = state.cardSortDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    if (!drag.active && distance < 6) return;
    if (!drag.active) {
      drag.active = true;
      drag.item.classList.add('is-dragging');
      drag.item.setAttribute('aria-grabbed', 'true');
    }
    event.preventDefault();
    const targetElement = document.elementFromPoint(event.clientX, event.clientY);
    const target = targetElement instanceof Element ? targetElement.closest('[data-card-sort-item]') : null;
    if (!target || target === drag.item || target.parentElement !== els.cardListItems) return;
    const items = Array.from(els.cardListItems.querySelectorAll('[data-card-sort-item]'));
    const fromIndex = items.indexOf(drag.item); const targetIndex = items.indexOf(target);
    if (fromIndex < 0 || targetIndex < 0) return;
    if (fromIndex < targetIndex) els.cardListItems.insertBefore(drag.item, target.nextSibling);
    else els.cardListItems.insertBefore(drag.item, target);
    els.cardListItems.querySelectorAll('[data-card-sort-item]').forEach((item) => item.classList.toggle('is-drag-over', item === target));
    updateCardSortDraftFromDom();
  }

  function handleCardSortPointerUp(event) {
    const drag = state.cardSortDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.item.classList.remove('is-dragging');
    drag.item.removeAttribute('aria-grabbed');
    els.cardListItems.querySelectorAll('[data-card-sort-item]').forEach((item) => item.classList.remove('is-drag-over'));
    state.cardSortDrag = null;
    if (!drag.active) return;
    state.suppressCardClick = true;
    window.setTimeout(() => { state.suppressCardClick = false; }, 0);
    updateCardSortDraftFromDom();
    showMessage(els.cardSortMessage, state.cardSortDirty ? '排序草稿已變更，請按「儲存排序」套用。' : '排序未變更。');
  }

  function updateCardSortDraftFromDom() {
    const cardIds = Array.from(els.cardListItems.querySelectorAll('[data-card-sort-item]')).map((item) => String(item.dataset.cardId || ''));
    const cardsById = new Map(state.cards.map((card) => [String(card.cardId), card]));
    if (cardIds.length !== state.cards.length || cardIds.some((cardId) => !cardsById.has(cardId))) return;
    state.cards = cardIds.map((cardId) => cardsById.get(cardId));
    state.cardSortDirty = cardIds.some((cardId, index) => cardId !== state.cardSortOriginalOrder[index]);
    updateCardSortPositions();
    updateCardSortSaveState();
  }

  function updateCardSortPositions() {
    Array.from(els.cardListItems.querySelectorAll('[data-card-sort-item]')).forEach((item, index) => {
      const card = state.cards[index]; const meta = item.querySelector('.card-list-item small');
      if (card && meta) meta.textContent = cardSortMeta(card, index);
    });
  }

  function adjustCardSortPosition(cardId, offset) {
    if (state.cardSortBusy || state.writeConfirmationRequired) return;
    const fromIndex = state.cards.findIndex((card) => String(card.cardId || '') === String(cardId || '')); const toIndex = fromIndex + offset;
    if (fromIndex < 0 || toIndex < 0 || toIndex >= state.cards.length) return;
    const card = state.cards[fromIndex]; state.cards.splice(fromIndex, 1); state.cards.splice(toIndex, 0, card);
    state.cardSortDirty = state.cards.some((item, index) => String(item.cardId || '') !== state.cardSortOriginalOrder[index]); renderCardList();
    const focusDirection = toIndex === 0 ? 'down' : 'up'; const focusTarget = Array.from(els.cardListItems.querySelectorAll('[data-card-sort-move]')).find((button) => button.dataset.cardId === String(card.cardId || '') && button.dataset.cardSortMove === focusDirection && !button.disabled);
    if (focusTarget) focusTarget.focus();
    showMessage(els.cardSortMessage, `已將「${String(card.title || '集點卡')}」調整為第 ${toIndex + 1} 張；請按「儲存排序」套用。`);
  }

  function updateCardSortSaveState() {
    if (!els.cardSortSaveButton) return;
    els.cardSortSaveButton.disabled = state.cardSortBusy || state.writeConfirmationRequired || !state.cardSortDirty;
    els.cardSortSaveButton.textContent = state.cardSortBusy ? '儲存中…' : '儲存排序';
  }

  async function saveCardSort() {
    if (state.cardSortBusy || !state.cardSortDirty || requireRefreshBeforeWrite(els.cardSortMessage)) return;
    const cardOrders = state.cards.map((card, index) => ({ cardId: String(card.cardId), sortOrder: index, expectedUpdatedAt: String(card.updatedAt || '') }));
    state.cardSortBusy = true; updateCardSortSaveState(); showOperationProgress('正在儲存集點卡排序…');
    try {
      const result = await window.MemberSystem.request(state.config, 'admin', state.idToken, 'admin.pointcards.reorder', { cardOrders });
      if (!Array.isArray(result.cards) || result.cards.length !== cardOrders.length || result.cards.some((card) => !card || !card.cardId)) { const error = new Error('無法確認集點卡排序結果。'); error.code = 'API_RESPONSE_UNCERTAIN'; throw error; }
      state.cards = result.cards; state.cardSortOriginalOrder = state.cards.map((card) => String(card.cardId || '')); state.cardSortDirty = false; renderCardList(); showOperationSuccess('集點卡排序已儲存'); showMessage(els.cardSortMessage, '已更新會員端顯示順序。', true);
    } catch (error) {
      if (error && error.code === 'API_RESPONSE_UNCERTAIN') { state.writeConfirmationRequired = true; lockAdminWrites(); showOperationNotice('無法確認排序是否完成，請重新整理確認。', 'warning', 0); showUncertainWriteMessage(els.cardSortMessage); setSyncStatus('排序結果尚未確認；請重新整理確認後再操作。', true); }
      else { showOperationNotice(error && error.code === 'CONFLICT' ? '集點卡資料已變更，請重新整理後再試。' : '排序未完成，請稍後再試。', 'error', 4600); showMessage(els.cardSortMessage, error && error.code === 'CONFLICT' ? '集點卡已被其他管理者更新，請重新整理後再排序。' : error && error.message || '排序未完成，請稍後再試。'); }
    } finally { state.cardSortBusy = false; updateCardSortSaveState(); }
  }

  function loadCardForm(cardId) {
    const card = state.cards.find((item) => item.cardId === cardId); if (!card) return;
    state.selectedCardId = cardId; els.cardId.value = String(card.cardId); els.cardExpectedUpdatedAt.value = String(card.updatedAt || ''); els.cardTitle.value = String(card.title || ''); els.cardUsageMethod.value = String(card.usageMethod || ''); els.cardUsageInstructions.value = String(card.usageInstructions || ''); els.cardBenefitDescription.value = String(card.benefitDescription || ''); els.cardStatus.value = String(card.status || 'draft'); els.cardStyle.value = safePointCardStyle(card.styleKey); updatePointCardStylePreview(); els.cardExpiryMode.value = String(card.expiryMode || 'unlimited'); els.cardExpiresOn.value = String(card.expiresOn || ''); updateCardExpiryUI(); els.cardAccent.value = safeAccent(card.accent); updateAccentValue(); renderRewardRows(card.rewards && card.rewards.length ? card.rewards : [defaultReward(5)]); els.editorKicker.textContent = 'Edit points card'; els.editorTitle.textContent = String(card.title || '編輯集點卡'); updateEditorStatus(els.editorStatus, card.status); els.archiveCardButton.disabled = card.status === 'archived'; els.archiveCardButton.textContent = card.status === 'archived' ? '已封存集點卡' : '封存集點卡'; els.deleteCardButton.disabled = false; hideMessage(els.cardFormMessage); renderCardList();
  }

  function resetCardForm() {
    state.selectedCardId = ''; els.cardForm.reset(); els.cardId.value = ''; els.cardExpectedUpdatedAt.value = ''; els.cardStatus.value = ''; els.cardStyle.value = POINT_CARD_STYLE_KEYS[0]; updatePointCardStylePreview(); els.cardExpiryMode.value = 'unlimited'; els.cardExpiresOn.value = ''; els.cardAccent.value = '#e47845'; updateCardExpiryUI(); updateAccentValue(); renderRewardRows([defaultReward(5)]); els.editorKicker.textContent = 'Create points card'; els.editorTitle.textContent = '新增集點卡'; updateEditorStatus(els.editorStatus, ''); els.archiveCardButton.disabled = true; els.archiveCardButton.textContent = '先儲存後才能封存'; els.deleteCardButton.disabled = true; hideMessage(els.cardFormMessage); renderCardList();
  }

  function defaultReward(thresholdStamps) { return { thresholdStamps, ticketTemplateId: '', requiredServiceIds: [], requiredServiceMatchMode: 'any', requiredServiceGroups: [] }; }
  function updateCardExpiryUI() { const limited = els.cardExpiryMode.value === 'date'; els.cardExpiresOnField.classList.toggle('hidden', !limited); els.cardExpiresOn.required = limited; updateCardExpiryDateUI(); }
  function validatePublicStatus(value, label) { return ['active', 'draft', 'archived'].includes(String(value || '')) ? '' : `請選擇${label}公開狀態。`; }
  function validateCardExpiry(mode, expiresOn) { if (mode === 'unlimited') return ''; if (mode !== 'date' || !/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) return '請選擇有效的集點卡到期日。'; const parts = expiresOn.split('-').map(Number); const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])); return date.getUTCFullYear() === parts[0] && date.getUTCMonth() === parts[1] - 1 && date.getUTCDate() === parts[2] ? '' : '請選擇有效的集點卡到期日。'; }
  function validateCardGuidance(usageMethod, usageInstructions, benefitDescription) { if (usageMethod.length > 120) return '使用方式最多 120 字。'; if (usageInstructions.length > 500) return '使用說明最多 500 字。'; if (benefitDescription.length > 500) return '優惠說明最多 500 字。'; return ''; }

  function activeTicketOptions(currentTicketTemplateId) {
    const tickets = state.tickets.filter((ticket) => ticket.status === 'active' || ticket.ticketTemplateId === currentTicketTemplateId);
    return [['', state.tickets.some((ticket) => ticket.status === 'active') ? '請選擇票券' : '請先到「票券」頁新增並啟用票券']].concat(tickets.map((ticket) => [ticket.ticketTemplateId, `${ticket.title || '未命名票券'} · ${ticket.ticketType === 'lottery' ? '抽獎券' : '優惠券'}${ticket.status === 'active' ? '' : '（未啟用）'}`]));
  }

  function renderRewardRows(rewards) { els.rewardRows.replaceChildren(...rewards.map((reward, index) => createRewardRow(reward, index))); updateRewardEditorHint(); }
  function createRewardRow(reward, index) {
    const row = document.createElement('article'); row.className = 'reward-row-editor'; row.dataset.rewardRow = 'true';
    const heading = document.createElement('div'); heading.className = 'reward-row-heading'; const label = document.createElement('strong'); label.textContent = `節點 ${index + 1}`; const summary = document.createElement('span'); summary.className = 'reward-row-summary'; summary.dataset.rewardSummary = 'true'; const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'text-button remove-reward'; remove.dataset.removeReward = 'true'; remove.textContent = '刪除'; heading.append(label, summary, remove);
    const grid = document.createElement('div'); grid.className = 'reward-row-grid'; grid.append(fieldLabel('需要集到', 'number', reward.thresholdStamps, { field: 'thresholdStamps', min: '1', max: '100', step: '1', suffix: '點' }), fieldLabel('選擇票券', 'select', reward.ticketTemplateId, { field: 'ticketTemplateId', options: activeTicketOptions(String(reward.ticketTemplateId || '')) }));
    const serviceRule = document.createElement('fieldset'); serviceRule.className = 'event-ticket-tier-access audience-selector ticket-booking-service-rule reward-booking-service-rule'; serviceRule.dataset.rewardServiceRule = 'true';
    const legend = document.createElement('legend'); legend.textContent = '此節點的預約項目限制';
    const serviceHeading = document.createElement('div'); serviceHeading.className = 'audience-selector-heading';
    const serviceCopy = document.createElement('div'); const kicker = document.createElement('p'); kicker.className = 'kicker'; kicker.textContent = 'Booking rule';
    const serviceTitle = document.createElement('h4'); serviceTitle.textContent = '集到這個節點後，需預約哪些項目才能使用票券？';
    const serviceHelp = document.createElement('p'); serviceHelp.textContent = '未勾選代表不限預約項目；可設定「任一即可」或「全部都要預約」。';
    serviceCopy.append(kicker, serviceTitle, serviceHelp); serviceHeading.append(serviceCopy);
    const matchModeField = fieldLabel('符合方式', 'select', (reward.requiredServiceGroups?.length ? 'groups' : reward.requiredServiceMatchMode === 'all' ? 'all' : 'any'), { field: 'requiredServiceMatchMode', options: [['any', '任一勾選項目有預約即可'], ['all', '勾選的所有項目都需預約'], ['groups', '符合任一組合（例如 A＋B 或 A＋C）']] });
    matchModeField.classList.add('booking-service-match-mode');
    const serviceOptions = document.createElement('div'); serviceOptions.className = 'event-ticket-tier-options audience-tier-grid'; serviceOptions.dataset.rewardRequiredServiceIds = 'true'; serviceOptions.setAttribute('aria-label', `節點 ${index + 1} 可使用票券的預約項目`);
    renderRequiredServiceOptions(serviceOptions, reward.requiredServiceIds);
    const groupsEditor = document.createElement('div'); groupsEditor.dataset.rewardRequiredServiceGroups = 'true';
    renderRequiredServiceGroups(groupsEditor, reward.requiredServiceGroups);
    const matchSelect = matchModeField.querySelector('select');
    matchSelect.addEventListener('change', () => { updateServiceGroupMode(matchSelect, serviceOptions, groupsEditor); updateRewardEditorHint(); });
    updateServiceGroupMode(matchSelect, serviceOptions, groupsEditor);
    serviceRule.append(legend, serviceHeading, matchModeField, serviceOptions, groupsEditor);
    row.append(heading, grid, serviceRule); return row;
  }
  function fieldLabel(labelText, type, value, options) {
    const label = document.createElement('label'); label.dataset.fieldLabel = options.field; const caption = document.createElement('span'); caption.textContent = labelText; label.append(caption); let input;
    if (type === 'select') { input = document.createElement('select'); (options.options || []).forEach(([optionValue, optionLabel]) => { const option = document.createElement('option'); option.value = optionValue; option.textContent = optionLabel; input.append(option); }); input.value = String(value || ''); input.title = String(input.selectedOptions[0] && input.selectedOptions[0].textContent || ''); input.addEventListener('change', () => { input.title = String(input.selectedOptions[0] && input.selectedOptions[0].textContent || ''); }); } else if (type === 'textarea') { input = document.createElement('textarea'); input.value = value === undefined || value === null ? '' : String(value); input.rows = Number(options.rows) || 3; if (options.maxlength) input.maxLength = Number(options.maxlength); if (options.placeholder) input.placeholder = options.placeholder; } else { input = document.createElement('input'); input.type = type; input.value = value === undefined || value === null ? '' : String(value); if (options.min) input.min = options.min; if (options.max) input.max = options.max; if (options.step) input.step = options.step; if (options.maxlength) input.maxLength = Number(options.maxlength); if (options.placeholder) input.placeholder = options.placeholder; }
    input.dataset.field = options.field; if (options.suffix) { const suffix = document.createElement('span'); suffix.className = 'field-suffix'; suffix.textContent = options.suffix; label.append(input, suffix); } else label.append(input); return label;
  }
  function addRewardRow() { const rewards = collectRewards(); const highest = rewards.reduce((max, reward) => Math.max(max, Number(reward.thresholdStamps) || 0), 0); rewards.push(defaultReward(Math.min(100, highest + 5 || 5))); renderRewardRows(rewards); els.rewardRows.querySelector('[data-reward-row]:last-child [data-field="ticketTemplateId"]')?.focus(); }
  function collectRewards() { return Array.from(els.rewardRows.querySelectorAll('[data-reward-row]')).map((row) => ({ thresholdStamps: Number(row.querySelector('[data-field="thresholdStamps"]')?.value), ticketTemplateId: String(row.querySelector('[data-field="ticketTemplateId"]')?.value || '').trim(), requiredServiceIds: collectRequiredServiceIds(row.querySelector('[data-reward-required-service-ids]')), requiredServiceMatchMode: row.querySelector('[data-field="requiredServiceMatchMode"]')?.value || 'any', requiredServiceGroups: collectRequiredServiceGroups(row.querySelector('[data-reward-required-service-groups]')) })); }
  function updateRewardEditorHint() {
    const rewards = collectRewards(); const duplicate = rewards.some((reward, index) => rewards.findIndex((item) => item.thresholdStamps === reward.thresholdStamps) !== index); const missingTicket = rewards.some((reward) => !reward.ticketTemplateId);
    els.rewardRows.querySelectorAll('[data-reward-row]').forEach((row) => { const threshold = Number(row.querySelector('[data-field="thresholdStamps"]')?.value); const ticket = state.tickets.find((item) => item.ticketTemplateId === row.querySelector('[data-field="ticketTemplateId"]')?.value); const requiredServiceIds = collectRequiredServiceIds(row.querySelector('[data-reward-required-service-ids]')); const requiredServiceMatchMode = row.querySelector('[data-field="requiredServiceMatchMode"]')?.value || 'any'; const serviceGroups = collectRequiredServiceGroups(row.querySelector('[data-reward-required-service-groups]')); const serviceSummary = ` · ${requiredServiceMatchMode === 'groups' ? groupRequirementLabel(serviceGroups) : bookingServiceRequirementLabel(requiredServiceIds, requiredServiceMatchMode)}`; const summary = row.querySelector('[data-reward-summary]'); if (summary) summary.textContent = Number.isInteger(threshold) && threshold > 0 ? `集到 ${threshold} 點即可兌換 · ${ticket ? ticket.title : '尚未選擇票券'}${serviceSummary}` : '請先設定點數節點'; });
    els.rewardEditorHint.textContent = duplicate ? '有節點使用相同點數，請調整後再儲存。' : missingTicket ? '每個節點都要選擇一張已啟用票券。' : `${rewards.length} 個兌換節點 · 兌換時會自動扣除該節點需要集到的點數。`; els.rewardEditorHint.classList.toggle('warning', duplicate || missingTicket);
  }
  function validateRewardEditor(title, rewards) { if (!title || title.length > 80) return '請填寫卡片名稱（最多 80 字）。'; if (!rewards.length || rewards.length > 30) return '請至少設定 1 個兌換節點，最多 30 個節點。'; const thresholds = new Set(); for (const reward of rewards) { if (!Number.isInteger(reward.thresholdStamps) || reward.thresholdStamps < 1 || reward.thresholdStamps > 100) return '需要集到的點數必須是 1–100 的整數。'; if (thresholds.has(reward.thresholdStamps)) return '每個點數只能設定一個節點。'; thresholds.add(reward.thresholdStamps); if (!reward.ticketTemplateId) return '請為每個節點選擇一張票券。'; if (reward.requiredServiceMatchMode === 'groups' && (!reward.requiredServiceGroups?.length || reward.requiredServiceGroups.some(group => !group.length))) return '請為每個預約組合至少勾選一個項目。'; } return ''; }

  function installSettingsCopy() {
    for(const [kind,idField,titleField,saveId,messageId] of [
      ['card','cardId','cardTitle','saveCardButton','cardFormMessage'],
      ['ticket','ticketTemplateId','ticketTitle','saveTicketButton','ticketFormMessage'],
      ['event','eventTicketId','eventTicketTitle','saveEventTicketButton','eventTicketFormMessage'],
    ]) {
      const save=document.getElementById(saveId);if(!save)continue;
      const button=document.createElement('button');button.type='button';button.className='button button-refresh';button.id='copySettings-'+kind;button.textContent='複製已儲存設定';save.before(button);
      button.addEventListener('click',()=>{
        const fixed=kind==='event'&&document.getElementById('eventTicketType').value==='fixed'?window.FixedTicketAdmin?.selected():null;
        const sourceId=fixed?.fixedTicketId||document.getElementById(idField).value;
        const copyKind=fixed?'fixed':kind;
        const source=fixed||(kind==='card'?state.cards:kind==='ticket'?state.tickets:state.eventTickets).find(x=>(x.cardId||x.ticketTemplateId||x.eventTicketId)===sourceId);
        if(!source || requireRefreshBeforeWrite(els[messageId])) {showMessage(els[messageId],'請先選擇已儲存的設定。');return;}
        let modal=document.getElementById('settingsCopyModal');
        if(!modal){modal=document.createElement('div');modal.id='settingsCopyModal';modal.className='modal';modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');modal.setAttribute('aria-labelledby','settingsCopyTitle');modal.innerHTML='<section class="modal-card"><h2 id="settingsCopyTitle">複製設定為草稿</h2><p>複製已儲存的設定。請在複本確認規則與效期後再啟用。</p><label>複本名稱<input id="settingsCopyName" maxlength="100" required></label><p id="settingsCopyPreview"></p><p>會員點數、持有票券、使用紀錄及預約綁定不會複製。此操作不發券、不發 LINE 通知。</p><p id="settingsCopyStatus" role="status" aria-live="polite"></p><div class="form-actions"><button id="settingsCopyCancel" type="button" class="button button-refresh">取消</button><button id="settingsCopyConfirm" type="button" class="button button-dark">建立草稿複本</button></div></section>';document.body.append(modal);}
        modal.dataset.businessRequires=kind==='event'?'events':'points';
        modal.classList.remove('hidden');const input=modal.querySelector('#settingsCopyName');input.disabled=false;input.value=(source.title+'（複本）').slice(0,100);
        modal.querySelector('#settingsCopyPreview').textContent=`來源：${source.title} · 效期：${source.expiresOn||[source.startsOn,source.endsOn].filter(Boolean).join('～')||'不限'}${source.quota!==undefined?' · 限量：'+(source.quota||'不限'):''}${source.rewards?' · '+source.rewards.length+' 個集點節點':''}${source.allowedTierKeys?' · 階級：'+source.allowedTierKeys.map(key=>({general:'一般',silver:'銀級',gold:'金級',platinum:'白金'})[key]||key).join('、'):''}。名稱可在此修改，其餘設定建立後在原編輯器調整。`;
        const status=modal.querySelector('#settingsCopyStatus');status.textContent='';const confirm=modal.querySelector('#settingsCopyConfirm');const cancel=modal.querySelector('#settingsCopyCancel');confirm.disabled=false;cancel.disabled=false;
        let operation=null;let busy=false;
        const close=()=>{if(busy)return;modal.classList.add('hidden');button.focus();};cancel.onclick=close;
        modal.onkeydown=event=>{if(event.key==='Escape'){event.preventDefault();close();}if(event.key==='Tab'){const nodes=[input,cancel,confirm].filter(x=>!x.disabled);const i=nodes.indexOf(document.activeElement);event.preventDefault();nodes[(i+(event.shiftKey?-1:1)+nodes.length)%nodes.length]?.focus();}};
        confirm.onclick=async()=>{
          if(busy||!input.reportValidity())return;
          const title=input.value.trim();if(!title)return;
          if(!operation || operation.title!==title)operation={title,requestId:'COPY-'+crypto.randomUUID()};
          busy=true;confirm.disabled=true;cancel.disabled=true;input.disabled=true;status.textContent='正在建立草稿…';
          try {
            const result=await window.MemberSystem.request(state.config,'admin',state.idToken,'admin.settings.copy',{kind:copyKind,sourceId,...operation});
            const panel=kind==='event'?'events':'cards';state.loadedPanels[panel]=false;await ensureAdminPanelData(panel);
            if(kind==='card')loadCardForm(result.publicId);else if(kind==='ticket')loadTicketForm(result.publicId);else if(fixed)await window.FixedTicketAdmin.loadCopy(result.publicId);else loadEventTicketForm(result.publicId);
            busy=false;close();showMessage(els[messageId],'草稿複本已建立。請確認名稱、效期、數量、會員階級與規則後再啟用。',true);
          } catch(error){status.textContent=error.message||'無法確認結果，請重試同一操作。';}
          finally{busy=false;confirm.disabled=false;cancel.disabled=false;input.disabled=false;}
        };
        input.focus();
      });
    }
  }

  async function saveCard(event) {
    event.preventDefault(); if (requireRefreshBeforeWrite(els.cardFormMessage)) return; hideMessage(els.cardFormMessage);
    const rewards = collectRewards(); const expiryMode = String(els.cardExpiryMode.value || 'unlimited'); const expiresOn = String(els.cardExpiresOn.value || '').trim(); const usageMethod = String(els.cardUsageMethod.value || '').trim(); const usageInstructions = String(els.cardUsageInstructions.value || '').trim(); const benefitDescription = String(els.cardBenefitDescription.value || '').trim();
    const validationMessage = validatePublicStatus(els.cardStatus.value, '集點卡') || validateRewardEditor(String(els.cardTitle.value || '').trim(), rewards) || validateCardGuidance(usageMethod, usageInstructions, benefitDescription) || validateCardExpiry(expiryMode, expiresOn);
    if (validationMessage) return showMessage(els.cardFormMessage, validationMessage);
    setSaving(els.saveCardButton, true, '正在儲存集點卡…');
    try {
      const result = await window.MemberSystem.request(state.config, 'admin', state.idToken, 'admin.pointcards.save', { card: { cardId: els.cardId.value, title: String(els.cardTitle.value || '').trim(), usageMethod, usageInstructions, benefitDescription, rewardTitle: '', rewards, status: els.cardStatus.value, styleKey: safePointCardStyle(els.cardStyle.value), pointCardStyleKey: safePointCardStyle(els.cardStyle.value), expiryMode, expiresOn, accent: safeAccent(els.cardAccent.value) }, expectedUpdatedAt: els.cardExpectedUpdatedAt.value });
      if (result.card) { state.cards = replaceById(state.cards, result.card, 'cardId'); loadCardForm(result.card.cardId); }
      if (await refreshAfterSuccessfulWrite('集點卡已儲存', els.cardFormMessage)) showMessage(els.cardFormMessage, '已儲存，會員端下次更新時會看到最新設定。', true);
    } catch (error) { handleActionError(error, els.cardFormMessage); } finally { setSaving(els.saveCardButton, false); }
  }

  async function archiveCard() {
    if (requireRefreshBeforeWrite(els.cardFormMessage)) return;
    const cardId = String(els.cardId.value || '').trim();
    if (!cardId || els.archiveCardButton.disabled) return;
    if (!window.confirm('封存後不再接受新的集點；會員端會同步隱藏這張卡與相關票券，但所有資料與歷史紀錄都會保留。確定要封存嗎？')) return;
    const originalText = els.archiveCardButton.textContent;
    els.archiveCardButton.disabled = true; els.archiveCardButton.textContent = '封存中…'; showOperationProgress('正在封存集點卡…');
    try {
      const result = await window.MemberSystem.request(state.config, 'admin', state.idToken, 'admin.pointcards.archive', { cardId, expectedUpdatedAt: els.cardExpectedUpdatedAt.value });
      if (result.card) state.cards = replaceById(state.cards, result.card, 'cardId');
      if (result.card) loadCardForm(result.card.cardId);
      if (await refreshAfterSuccessfulWrite('集點卡已封存，所有資料仍保留', els.cardFormMessage)) showMessage(els.cardFormMessage, '集點卡已封存；會員端不再顯示，資料與歷史紀錄仍保留。', true);
    } catch (error) { handleActionError(error, els.cardFormMessage); } finally { if (!state.writeConfirmationRequired && els.cardId.value === cardId && els.cardStatus.value !== 'archived') { els.archiveCardButton.disabled = false; els.archiveCardButton.textContent = originalText; } }
  }

  async function deleteCard() {
    if (requireRefreshBeforeWrite(els.cardFormMessage)) return;
    const cardId = String(els.cardId.value || '').trim();
    const cardTitle = String(els.cardTitle.value || '這張集點卡').trim();
    if (!cardId || els.deleteCardButton.disabled) return;
    if (!window.confirm(`永久刪除「${cardTitle}」後，集點卡、節點、票券、餘額、點數流水與相關歷史都會移除，無法復原。要繼續嗎？`)) return;
    if (!window.confirm('最後確認：這是永久刪除，不是封存。確定要刪除嗎？')) return;
    const originalText = els.deleteCardButton.textContent;
    els.deleteCardButton.disabled = true; els.deleteCardButton.textContent = '刪除中…'; showOperationProgress('正在永久刪除集點卡…');
    try {
      await window.MemberSystem.request(state.config, 'admin', state.idToken, 'admin.pointcards.delete', { cardId, expectedUpdatedAt: els.cardExpectedUpdatedAt.value });
      state.cards = state.cards.filter((card) => card.cardId !== cardId); state.selectedCardId = ''; resetCardForm();
      if (await refreshAfterSuccessfulWrite('集點卡已永久刪除', els.cardFormMessage)) showMessage(els.cardFormMessage, '集點卡與所有相關資料已永久刪除。', true);
    } catch (error) { handleActionError(error, els.cardFormMessage); } finally { if (!state.writeConfirmationRequired && els.cardId.value === cardId) { els.deleteCardButton.disabled = false; els.deleteCardButton.textContent = originalText; } }
  }

  function renderTicketList() {
    els.ticketResultCount.textContent = String(state.tickets.length); els.ticketEmptyState.classList.toggle('hidden', state.tickets.length !== 0);
    els.ticketListItems.replaceChildren(...state.tickets.map((ticket) => { const button = document.createElement('button'); button.type = 'button'; button.className = 'card-list-item'; button.dataset.ticketTemplateId = String(ticket.ticketTemplateId); button.setAttribute('aria-selected', String(ticket.ticketTemplateId) === state.selectedTicketId ? 'true' : 'false'); const title = document.createElement('strong'); title.textContent = String(ticket.title || '未命名票券'); const meta = document.createElement('small'); meta.textContent = `${ticket.ticketType === 'lottery' ? '抽獎券' : '優惠券'} · ${statusLabel(ticket.status)}`; button.append(title, meta); return button; }));
  }
  function bookingServiceTitle(serviceId) {
    const service = state.bookingServices.find((item) => String(item?.serviceId || '') === String(serviceId || ''));
    return String(service?.title || serviceId || '').trim();
  }

  function bookingServiceRequirementLabel(serviceIds, matchMode = 'any') {
    const selected = new Set((Array.isArray(serviceIds) ? serviceIds : []).map((value) => String(value || '').trim()).filter(Boolean));
    if (!selected.size) return '預約不限項目';

    const services = state.bookingServices.filter((service) => service && service.serviceId && service.title && service.serviceId !== STORE_SERVICE_ID);
    const servicesByType = new Map();
    for (const service of services) {
      const type = String(service.serviceType || '').trim();
      if (!type) continue;
      const group = servicesByType.get(type) || [];
      group.push(service);
      servicesByType.set(type, group);
    }

    const coveredIds = new Set();
    const fullTypes = [];
    for (const [type, group] of servicesByType) {
      if (group.length && group.every((service) => selected.has(String(service.serviceId)))) {
        fullTypes.push(type);
        group.forEach((service) => coveredIds.add(String(service.serviceId)));
      }
    }

    const individualTitles = services
      .filter((service) => selected.has(String(service.serviceId)) && !coveredIds.has(String(service.serviceId)))
      .map((service) => String(service.title || '').trim())
      .filter(Boolean);
    const unknownIds = [...selected].filter((serviceId) =>
      !services.some((service) => String(service.serviceId) === serviceId)
    );
    individualTitles.push(...unknownIds);

    const allRequired = matchMode === 'all';
    if (fullTypes.length && !individualTitles.length) {
      if (allRequired) return fullTypes.length === 1
        ? `需預約「${fullTypes[0]}」項目類型的所有項目`
        : `需預約「${fullTypes.join('、')}」項目類型的所有項目`;
      return fullTypes.length === 1
        ? `需預約「${fullTypes[0]}」項目類型`
        : `需預約「${fullTypes.join('、')}」其中一種項目類型`;
    }
    if (!fullTypes.length) {
      if (allRequired) return `需預約所有指定項目：「${individualTitles.join('、')}」`;
      return individualTitles.length === 1
        ? `需預約「${individualTitles[0]}」項目`
        : `需預約「${individualTitles.join('、')}」其中一個項目`;
    }
    const typePart = fullTypes.length === 1 ? `「${fullTypes[0]}」項目類型` : `「${fullTypes.join('、')}」項目類型`;
    const itemPart = individualTitles.length === 1 ? `「${individualTitles[0]}」項目` : `「${individualTitles.join('、')}」項目`;
    return allRequired
      ? `需預約 ${typePart}的所有項目，且需包含 ${itemPart}`
      : `需預約 ${typePart} 或 ${itemPart}`;
  }

  function renderRequiredServiceOptions(root, selectedIds = []) {
    if (!root) return;
    const selected = new Set((Array.isArray(selectedIds) ? selectedIds : []).map((value) => String(value || '').trim()).filter(Boolean));
    // A service catalogue may briefly be empty during merchant real-time refresh.
    // Preserve the last saved selection until checkboxes are available again.
    root.dataset.requiredServiceSelectedIds = JSON.stringify([...selected]);
    const services = state.bookingServices.filter((service) => service && service.serviceId && service.title);
    if (!services.length) {
      const empty = document.createElement('p');
      empty.className = 'field-help';
      empty.textContent = '尚未建立預約項目；請先至預約管理新增可預約項目。';
      root.replaceChildren(empty);
      return;
    }
    root.replaceChildren(...services.map((service) => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = service.serviceId;
      input.checked = selected.has(service.serviceId);
      const copy = document.createElement('span');
      const strong = document.createElement('strong');
      strong.textContent = service.title;
      const small = document.createElement('small');
      small.textContent = `${service.serviceType || '未分類'} · 預約項目${service.isActive === false ? ' · 已停用' : ''}`;
      copy.append(strong, small);
      label.append(input, copy);
      return label;
    }));
  }

  function collectRequiredServiceIds(root) {
    if (!root) return [];
    const choices = Array.from(root.querySelectorAll('input[type="checkbox"]'));
    if (!choices.length) {
      // Do not erase configured groups while an async service refresh renders
      // the "no services" placeholder instead of real checkbox controls.
      try {
        const saved = JSON.parse(root.dataset.requiredServiceSelectedIds || '[]');
        return Array.isArray(saved) ? saved.map(value => String(value || '').trim()).filter(Boolean) : [];
      } catch (_) {
        return [];
      }
    }
    const selected = choices.filter(input => input.checked)
      .map(input => String(input.value || '').trim()).filter(Boolean);
    root.dataset.requiredServiceSelectedIds = JSON.stringify(selected);
    return selected;
  }


  function groupRequirementLabel(groups) {
    const valid = (Array.isArray(groups) ? groups : []).filter(group => Array.isArray(group) && group.length);
    return valid.length ? `符合任一組合：${valid.map(group => group.map(bookingServiceTitle).join('＋')).join(' 或 ')}` : '請新增預約組合';
  }

  function collectRequiredServiceGroups(root) {
    return Array.from(root?.querySelectorAll('[data-service-combination]') || []).map(row =>
      collectRequiredServiceIds(row.querySelector('[data-group-service-items]')));
  }

  function renderRequiredServiceGroups(root, groups = []) {
    if (!root) return;
    const list = document.createElement('div'); list.className = 'ticket-service-groups';
    const add = document.createElement('button'); add.type = 'button'; add.className = 'button button-outline ticket-service-group-add';
    add.textContent = '＋ 新增一組替代組合';
    const addRow = (selected = []) => {
      if (list.children.length >= 10) return;
      const row = document.createElement('section'); row.className = 'ticket-service-group'; row.dataset.serviceCombination = 'true';
      const heading = document.createElement('div'); heading.className = 'ticket-service-group-heading';
      const name = document.createElement('strong'); name.textContent = `組合 ${list.children.length + 1}（組內全部要預約）`;
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'text-button'; remove.textContent = '移除組合';
      remove.addEventListener('click', () => {
        row.remove();
        Array.from(list.children).forEach((entry, index) => { entry.querySelector('strong').textContent = `組合 ${index + 1}（組內全部要預約）`; });
        add.disabled = list.children.length >= 10;
        updateRewardEditorHint();
      });
      heading.append(name, remove);
      const items = document.createElement('div'); items.dataset.groupServiceItems = 'true';
      items.className = 'event-ticket-tier-options audience-tier-grid';
      renderRequiredServiceOptions(items, selected);
      row.append(heading, items); list.append(row);
      add.disabled = list.children.length >= 10;
    };
    for (const group of (Array.isArray(groups) ? groups : []).slice(0, 10)) addRow(group);
    add.addEventListener('click', () => { addRow(); updateRewardEditorHint(); });
    root.replaceChildren(list, add);
  }

  function updateServiceGroupMode(select, singleRoot, groupRoot) {
    const grouped = select?.value === 'groups';
    singleRoot?.classList.toggle('hidden', grouped);
    groupRoot?.classList.toggle('hidden', !grouped);
    if (grouped && groupRoot && !groupRoot.querySelector('[data-service-combination]')) {
      renderRequiredServiceGroups(groupRoot, [[]]);
    }
  }

  function setEventTicketServiceGroups(groups = []) {
    const editor = document.getElementById('eventTicketRequiredServiceGroups');
    const select = els.eventTicketRequiredServiceMatchMode;
    renderRequiredServiceGroups(editor, groups);
    if (!select.dataset.groupListener) {
      select.dataset.groupListener = 'true';
      select.addEventListener('change', () => updateServiceGroupMode(select, els.eventTicketRequiredServiceIds, editor));
    }
    updateServiceGroupMode(select, els.eventTicketRequiredServiceIds, editor);
  }

  function loadTicketForm(ticketTemplateId) { const ticket = state.tickets.find((item) => item.ticketTemplateId === ticketTemplateId); if (!ticket) return; state.selectedTicketId = ticketTemplateId; els.ticketTemplateId.value = String(ticket.ticketTemplateId); els.ticketExpectedUpdatedAt.value = String(ticket.updatedAt || ''); els.ticketTitle.value = String(ticket.title || ''); els.ticketType.value = ticket.ticketType === 'lottery' ? 'lottery' : 'coupon'; els.ticketDescription.value = String(ticket.description || ''); els.ticketUsageMethod.value = String(ticket.usageMethod || ''); els.ticketUsageInstructions.value = String(ticket.usageInstructions || ''); els.ticketStatus.value = String(ticket.status || 'draft'); document.getElementById('ticketRequiresLocation').checked = Boolean(ticket.requiresLocation); window.TicketLocationEditors.template.set(Array.isArray(ticket.redemptionLocations) ? ticket.redemptionLocations : []); renderTicketPrizeRows(ticket.prizes && ticket.prizes.length ? ticket.prizes : [defaultPrize()]); updateTicketTypeUI(); els.ticketEditorKicker.textContent = 'Edit ticket'; els.ticketEditorTitle.textContent = String(ticket.title || '編輯票券'); updateEditorStatus(els.ticketEditorStatus, ticket.status); els.deleteTicketButton.disabled = state.writeConfirmationRequired; els.deleteTicketButton.classList.remove('hidden'); hideMessage(els.ticketFormMessage); renderTicketList(); }
  function resetTicketForm() { state.selectedTicketId = ''; els.ticketForm.reset(); els.ticketTemplateId.value = ''; els.ticketExpectedUpdatedAt.value = ''; els.ticketType.value = 'coupon'; els.ticketStatus.value = ''; document.getElementById('ticketRequiresLocation').checked = false; window.TicketLocationEditors.template.set([]); renderTicketPrizeRows([defaultPrize()]); updateTicketTypeUI(); els.ticketEditorKicker.textContent = 'Create ticket'; els.ticketEditorTitle.textContent = '新增票券'; updateEditorStatus(els.ticketEditorStatus, ''); els.deleteTicketButton.disabled = true; els.deleteTicketButton.classList.add('hidden'); hideMessage(els.ticketFormMessage); renderTicketList(); }
  function defaultPrize(rate) { return { prizeTitle: '', prizeDescription: '', winRate: rate === undefined ? 100 : rate }; }
  function updateTicketTypeUI() { const lottery = els.ticketType.value === 'lottery'; els.ticketPrizeEditor.classList.toggle('hidden', !lottery); if (lottery && !els.ticketPrizeRows.children.length) renderTicketPrizeRows([defaultPrize()]); }
  function setTicketSaving(value) {
    state.ticketSaving = value;
    els.ticketForm.toggleAttribute('inert', value);
    for (const control of els.ticketPrizeEditor.querySelectorAll('input, textarea, button')) control.disabled = value;
  }
  function renderTicketPrizeRows(prizes) { els.ticketPrizeRows.replaceChildren(...prizes.map((prize, index) => { const row = document.createElement('div'); row.className = 'prize-row'; row.dataset.ticketPrizeRow = 'true'; row.append(fieldLabel(`獎項 ${index + 1} 名稱`, 'text', prize.prizeTitle, { field: 'ticketPrizeTitle', maxlength: '100', placeholder: '例如：免費蛋糕' }), fieldLabel('中獎機率', 'number', prize.winRate, { field: 'ticketPrizeRate', min: '0', max: '100', step: '0.01', suffix: '%' })); const description = fieldLabel('獎項說明（可換行，選填）', 'textarea', prize.prizeDescription, { field: 'ticketPrizeDescription', maxlength: '240', rows: 2, placeholder: '例如：可兌換任一蛋糕' }); description.classList.add('prize-description-field'); const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'text-button remove-prize'; remove.dataset.removeTicketPrize = 'true'; remove.textContent = '刪除'; row.append(description, remove); return row; })); setTicketSaving(Boolean(state.ticketSaving)); updateTicketPrizeTotal(); }
  function collectTicketPrizes() { return Array.from(els.ticketPrizeRows.querySelectorAll('[data-ticket-prize-row]')).map((row) => ({ prizeTitle: String(row.querySelector('[data-field="ticketPrizeTitle"]')?.value || '').trim(), prizeDescription: String(row.querySelector('[data-field="ticketPrizeDescription"]')?.value || '').trim(), winRate: Number(row.querySelector('[data-field="ticketPrizeRate"]')?.value) })); }
  function updateTicketPrizeTotal() { const total = Math.round(collectTicketPrizes().reduce((sum, prize) => sum + (Number.isFinite(prize.winRate) ? prize.winRate : 0), 0) * 100); els.ticketPrizeTotal.textContent = `機率合計 ${formatRate(total / 100)}%${total === 10000 ? ' ✓' : '／還差 ' + formatRate((10000 - total) / 100) + '%'}`; els.ticketPrizeTotal.classList.toggle('warning', total !== 10000); }
  function balanceTicketPrizes() { const rows = Array.from(els.ticketPrizeRows.querySelectorAll('[data-ticket-prize-row]')); if (!rows.length) return; const base = Math.floor(10000 / rows.length); const remainder = 10000 - base * rows.length; rows.forEach((row, index) => { row.querySelector('[data-field="ticketPrizeRate"]').value = String((base + (index < remainder ? 1 : 0)) / 100); }); updateTicketPrizeTotal(); }
  function validateTicket(ticket) {
    if (!['active', 'draft', 'archived'].includes(ticket.status)) return '請選擇票券公開狀態。';
    if (!ticket.title || ticket.title.length > 100) return '請填寫票券名稱（最多 100 字）。';
    if (!ticket.description || ticket.description.length > 240) return '請填寫票券說明（最多 240 字）。';
    if (!ticket.usageMethod || ticket.usageMethod.length > 120) return '請填寫使用方式（最多 120 字）。';
    if (!ticket.usageInstructions || ticket.usageInstructions.length > 500) return '請填寫使用說明（最多 500 字）。';
    if (ticket.requiresLocation && (!ticket.redemptionLocations.length || ticket.redemptionLocations.length > 20 || ticket.redemptionLocations.some((location) => !location.name?.trim() || location.name.length > 100 || !Number.isFinite(Number(location.latitude)) || Math.abs(Number(location.latitude)) > 90 || !Number.isFinite(Number(location.longitude)) || Math.abs(Number(location.longitude)) > 180 || !Number.isInteger(Number(location.radiusMeters)) || Number(location.radiusMeters) < 50 || Number(location.radiusMeters) > 2000))) return '請設定 1–20 個有效地點（名稱、座標、50–2000 公尺半徑）。';
    if (ticket.ticketType !== 'lottery') return '';
    if (!ticket.prizes.length || ticket.prizes.length > 30) return '抽獎券至少要設定 1 個獎項，最多 30 個獎項。';
    let total = 0;
    for (const prize of ticket.prizes) {
      if (!prize.prizeTitle || prize.prizeTitle.length > 100) return '每個抽獎獎項都需要填寫名稱。';
      if (prize.prizeDescription.length > 240) return '獎項說明最多 240 字。';
      if (!Number.isFinite(prize.winRate) || prize.winRate < 0 || prize.winRate > 100) return '每個獎項機率必須介於 0–100%。';
      total += Math.round(prize.winRate * 100);
    }
    return total === 10000 ? '' : '同一張抽獎券的獎項機率合計必須正好是 100%。';
  }
  async function saveTicket(event) {
    event.preventDefault(); if (state.ticketSaving || requireRefreshBeforeWrite(els.ticketFormMessage)) return; hideMessage(els.ticketFormMessage);
    const ticket = { ticketTemplateId: els.ticketTemplateId.value, title: String(els.ticketTitle.value || '').trim(), ticketType: els.ticketType.value, description: String(els.ticketDescription.value || '').trim(), usageMethod: String(els.ticketUsageMethod.value || '').trim(), usageInstructions: String(els.ticketUsageInstructions.value || '').trim(), status: els.ticketStatus.value, requiresLocation: document.getElementById('ticketRequiresLocation').checked, redemptionLocations: window.TicketLocationEditors.template.get(), prizes: els.ticketType.value === 'lottery' ? collectTicketPrizes() : [] };
    const validationMessage = validateTicket(ticket);
    if (validationMessage) return showMessage(els.ticketFormMessage, validationMessage);
    setTicketSaving(true);
    setSaving(els.saveTicketButton, true, '正在儲存票券…');
    try {
      const result = await window.MemberSystem.request(state.config, 'admin', state.idToken, 'admin.tickets.save', { ticket, expectedUpdatedAt: els.ticketExpectedUpdatedAt.value });
      if (result.ticket) { state.tickets = replaceById(state.tickets, result.ticket, 'ticketTemplateId'); loadTicketForm(result.ticket.ticketTemplateId); }
      if (await refreshAfterSuccessfulWrite('票券已儲存', els.ticketFormMessage)) showMessage(els.ticketFormMessage, '票券已儲存；集點卡節點現在可以選擇它。', true);
    } catch (error) { handleActionError(error, els.ticketFormMessage); } finally { setTicketSaving(false); setSaving(els.saveTicketButton, false); }
  }
  async function deleteTicket() {
    if (requireRefreshBeforeWrite(els.ticketFormMessage)) return;
    const ticketTemplateId = String(els.ticketTemplateId.value || '').trim();
    const title = String(els.ticketTitle.value || '這張票券').trim();
    if (!ticketTemplateId || els.deleteTicketButton.disabled) return;
    if (!window.confirm(`確定刪除「${title}」？仍被集點卡兌換節點使用的票券必須先解除引用才能刪除；已發放的會員票券與核銷歷史會保留。`)) return;
    const originalText = els.deleteTicketButton.textContent;
    els.deleteTicketButton.disabled = true;
    els.deleteTicketButton.textContent = '刪除中…';
    showOperationProgress('正在刪除集點卡票券…');
    try {
      const result = await window.MemberSystem.request(state.config, 'admin', state.idToken, 'admin.tickets.delete', {
        ticketTemplateId, expectedUpdatedAt: els.ticketExpectedUpdatedAt.value
      });
      state.tickets = state.tickets.filter((ticket) => ticket.ticketTemplateId !== ticketTemplateId);
      resetTicketForm();
      const preserved = Number(result.preservedTicketCount || 0);
      if (await refreshAfterSuccessfulWrite('集點卡票券已刪除', els.ticketFormMessage)) {
        showMessage(els.ticketFormMessage,
          preserved ? `票券已刪除，並保留 ${preserved} 筆已發放的會員票券歷史。` : '票券已刪除。', true);
      }
    } catch (error) {
      handleActionError(error, els.ticketFormMessage);
    } finally {
      if (!state.writeConfirmationRequired) {
        els.deleteTicketButton.textContent = originalText;
        els.deleteTicketButton.disabled = !els.ticketTemplateId.value;
      }
    }
  }
  function formatRate(value) { const rate = Number(value); return Number.isFinite(rate) ? String(Number(rate.toFixed(2))) : '0'; }

  function renderEventTicketList() {
    els.eventTicketResultCount.textContent = String(state.eventTickets.length);
    els.eventTicketEmptyState.classList.toggle('hidden', state.eventTickets.length !== 0);
    const existing = new Map(
      Array.from(els.eventTicketListItems.querySelectorAll('[data-event-ticket-id]'))
        .map((button) => [String(button.dataset.eventTicketId || ''), button])
        .filter(([eventTicketId]) => Boolean(eventTicketId))
    );
    const retained = new Set();

    state.eventTickets.forEach((ticket) => {
      const eventTicketId = String(ticket.eventTicketId || '');
      const selected = eventTicketId === state.selectedEventTicketId;
      const signature = JSON.stringify([
        eventTicketId,
        ticket.title || '',
        Number(ticket.claimedCount || 0),
        Number(ticket.quota || 0),
        ticket.startsOn || '',
        ticket.endsOn || '',
        ticket.validityMode || 'fixed',
        ticket.validityDays ?? null,
        Array.isArray(ticket.allowedTierLabels) ? ticket.allowedTierLabels : [],
        ticket.ticketType || '',
        ticket.status || '',
        safeAccent(ticket.accent),
        selected,
      ]);
      let button = existing.get(eventTicketId);
      if (!button || button.dataset.eventTicketRenderSignature !== signature) {
        const next = document.createElement('button');
        next.type = 'button';
        next.className = 'card-list-item';
        next.dataset.eventTicketId = eventTicketId;
        next.dataset.eventTicketRenderSignature = signature;
        next.setAttribute('aria-selected', selected ? 'true' : 'false');
        next.style.setProperty('--card-accent', safeAccent(ticket.accent));
        const title = document.createElement('strong');
        const dot = document.createElement('i');
        title.append(dot, document.createTextNode(String(ticket.title || '未命名活動票券')));
        const limit = Number(ticket.quota || 0) > 0
          ? `已發放 ${Number(ticket.claimedCount || 0)} 張 · 已使用 ${Number(ticket.usedCount || 0)} / 上限 ${Number(ticket.quota)} 次`
          : `已發放 ${Number(ticket.claimedCount || 0)} 張 · 使用不限量（已使用 ${Number(ticket.usedCount || 0)} 次）`;
        const dates = ticket.validityMode && ticket.validityMode !== 'fixed'
          ? `獲得後 ${ticket.validityDays} 天${ticket.validityMode === 'both' ? ' · 最晚 ' + formatAdminDateCompact(ticket.endsOn) : ''}`
          : ticket.startsOn || ticket.endsOn
            ? `${ticket.startsOn ? formatAdminDateCompact(ticket.startsOn) : '即日起'}–${ticket.endsOn ? formatAdminDateCompact(ticket.endsOn) : '不限期'}`
            : '不限期';
        const allowedTiers = Array.isArray(ticket.allowedTierLabels) && ticket.allowedTierLabels.length ? ticket.allowedTierLabels.join('、') : '全部等級';
        const meta = document.createElement('small');
        meta.textContent = `${ticket.ticketType === 'lottery' ? '抽獎券' : ticket.ticketType === 'referral' ? '好友邀請' : ticket.ticketType === 'membership_join' ? '加入會員' : '優惠券'} · ${allowedTiers} · ${dates} · ${limit} · ${statusLabel(ticket.status)}`;
        next.append(title, meta);
        if (button) button.remove();
        button = next;
      }
      retained.add(button);
      els.eventTicketListItems.appendChild(button);
    });

    Array.from(els.eventTicketListItems.children).forEach((button) => {
      if (!retained.has(button)) button.remove();
    });
    window.dispatchEvent(new Event('member-admin-event-ticket-list-rendered'));
  }

  function updateEventTicketAmountModeUI() {
    const mode = els.eventTicketMinBookingAmountMode.value;
    document.getElementById('eventTicketMinBookingAmountField').classList.toggle('hidden', mode === 'none');
    document.getElementById('eventTicketMinBookingServicesField').classList.toggle('hidden', mode !== 'selected_services');
  }
  function validateEventTicketAmountRule(ticket) {
    if (!['none', 'total', 'selected_services'].includes(ticket.minBookingAmountMode)) return '請選擇有效的金額門檻模式。';
    if (ticket.minBookingAmountMode === 'none') return '';
    if (!Number.isSafeInteger(ticket.minBookingAmount) || ticket.minBookingAmount < 1 || ticket.minBookingAmount > 10000000) return '最低預約金額必須是 1–10,000,000 元的整數。';
    if (ticket.minBookingAmountMode === 'selected_services' && (!ticket.minBookingServiceIds.length || ticket.minBookingServiceIds.length > 20)) return '指定預約項目金額門檻需選擇 1–20 個項目。';
    return '';
  }
  function loadEventTicketForm(eventTicketId, renderList = true) {
    const ticket = state.eventTickets.find((item) => item.eventTicketId === eventTicketId); if (!ticket) return;
    state.selectedEventTicketId = eventTicketId;
    els.eventTicketId.value = String(ticket.eventTicketId);
    els.eventTicketExpectedUpdatedAt.value = String(ticket.updatedAt || '');
    els.eventTicketTitle.value = String(ticket.title || '');
    els.eventTicketType.value = ['coupon', 'lottery', 'referral', 'membership_join'].includes(ticket.ticketType) ? ticket.ticketType : 'coupon';
    els.eventTicketDescription.value = String(ticket.description || '');
    els.eventTicketUsageMethod.value = String(ticket.usageMethod || '');
    els.eventTicketUsageInstructions.value = String(ticket.usageInstructions || '');
    els.eventTicketStatus.value = String(ticket.status || 'draft');
    document.getElementById('eventTicketVisibilityPolicy').value = ticket.visibilityPolicy || 'eligible_only';
    els.eventTicketRequiredServiceMatchMode.value = ticket.requiredServiceGroups?.length ? 'groups' : ticket.requiredServiceMatchMode === 'all' ? 'all' : 'any';
    renderRequiredServiceOptions(els.eventTicketRequiredServiceIds, ticket.requiredServiceIds); setEventTicketServiceGroups(ticket.requiredServiceGroups);
    els.eventTicketMinBookingAmountMode.value = ticket.minBookingAmountMode || 'none';
    els.eventTicketMinBookingAmount.value = String(Number(ticket.minBookingAmount || 0));
    renderRequiredServiceOptions(els.eventTicketMinBookingServiceIds, ticket.minBookingServiceIds || []);
    updateEventTicketAmountModeUI();
    els.eventTicketStartsOn.value = String(ticket.startsOn || '');
    els.eventTicketEndsOn.value = String(ticket.endsOn || '');
    els.eventTicketValidityMode.value = ticket.validityMode || 'fixed';
    els.eventTicketValidityDays.value = String(ticket.validityDays || 30);
    els.eventTicketQuota.value = String(Number(ticket.quota || 0));
    els.eventTicketRequiresLocation.checked = Boolean(ticket.requiresLocation);
    window.CouponLocationEditor.set(ticket.redemptionLocations?.length ? ticket.redemptionLocations : ticket.requiresLocation ? [{ name: '原核銷地點', latitude: ticket.redemptionLatitude, longitude: ticket.redemptionLongitude, radiusMeters: ticket.redemptionRadiusMeters || 100 }] : []);
    els.eventTicketAccent.value = safeAccent(ticket.accent || '#df6b4d');
    setEventTicketAllowedTiers(ticket.allowedTierKeys);
    els.deleteEventTicketButton.disabled = false; els.deleteEventTicketButton.classList.remove('hidden'); els.deleteEventTicketButton.textContent = '刪除目前票券';
    renderEventTicketPrizeRows(ticket.prizes && ticket.prizes.length ? ticket.prizes : [defaultPrize()]);
    updateEventTicketTypeUI(); updateEventTicketAccentValue(); updateEventTicketValidityUI();
    els.eventTicketEditorKicker.textContent = 'Edit event ticket'; els.eventTicketEditorTitle.textContent = String(ticket.title || '編輯活動票券'); updateEditorStatus(els.eventTicketEditorStatus, ticket.status); hideMessage(els.eventTicketFormMessage); if (renderList) renderEventTicketList();
  }

  function resetEventTicketForm(renderList = true) {
    state.selectedEventTicketId = ''; els.eventTicketForm.reset(); els.eventTicketId.value = ''; els.eventTicketExpectedUpdatedAt.value = ''; els.eventTicketType.value = 'coupon'; els.eventTicketStatus.value = ''; document.getElementById('eventTicketVisibilityPolicy').value = 'eligible_only'; els.eventTicketRequiredServiceMatchMode.value = 'any'; els.eventTicketMinBookingAmountMode.value = 'none'; els.eventTicketMinBookingAmount.value = '0'; renderRequiredServiceOptions(els.eventTicketMinBookingServiceIds, []); updateEventTicketAmountModeUI(); renderRequiredServiceOptions(els.eventTicketRequiredServiceIds, []); setEventTicketServiceGroups([]); els.eventTicketStartsOn.value = ''; els.eventTicketEndsOn.value = ''; els.eventTicketValidityMode.value = 'fixed'; els.eventTicketValidityDays.value = '30'; els.eventTicketQuota.value = '0'; els.eventTicketRequiresLocation.checked = false; window.CouponLocationEditor.set([]); els.eventTicketAccent.value = '#df6b4d'; setEventTicketAllowedTiers(EVENT_TICKET_TIER_KEYS); els.deleteEventTicketButton.disabled = true; els.deleteEventTicketButton.classList.add('hidden'); els.deleteEventTicketButton.textContent = '刪除目前票券'; renderEventTicketPrizeRows([defaultPrize()]); updateEventTicketTypeUI(); updateEventTicketAccentValue(); updateEventTicketValidityUI(); els.eventTicketEditorKicker.textContent = 'Create event ticket'; els.eventTicketEditorTitle.textContent = '新增活動票券'; updateEditorStatus(els.eventTicketEditorStatus, ''); hideMessage(els.eventTicketFormMessage); if (renderList) renderEventTicketList();
  }

  function collectEventTicketAllowedTiers() { return Array.from(document.querySelectorAll('#eventTicketAllowedTiers input[name="eventTicketAllowedTierKey"]:checked')).map((input) => String(input.value || '').trim()).filter((tierKey) => EVENT_TICKET_TIER_KEYS.includes(tierKey)); }
  function setEventTicketAllowedTiers(tierKeys) {
    const allowed = Array.isArray(tierKeys) ? tierKeys.filter((tierKey) => EVENT_TICKET_TIER_KEYS.includes(tierKey)) : tierKeys === undefined || tierKeys === null ? EVENT_TICKET_TIER_KEYS : [];
    document.querySelectorAll('#eventTicketAllowedTiers input[name="eventTicketAllowedTierKey"]').forEach((input) => { input.checked = allowed.includes(input.value); });
    updateEventTicketTierSummary();
  }
  function audiencePresetTierKeys(preset) {
    const presets = {
      all: EVENT_TICKET_TIER_KEYS,
      general: ['general'],
      'silver-plus': ['silver', 'gold', 'platinum'],
      'gold-plus': ['gold', 'platinum'],
      platinum: ['platinum'],
    };
    return presets[String(preset || '')] || null;
  }
  function handleAudiencePresetClick(event) {
    const button = event.target instanceof Element ? event.target.closest('[data-audience-preset]') : null;
    if (!button) return;
    const tiers = audiencePresetTierKeys(button.dataset.audiencePreset);
    if (!tiers) return;
    setEventTicketAllowedTiers(tiers);
    button.focus({ preventScroll: true });
  }
  function audiencePresetForTierKeys(tierKeys) {
    const selected = EVENT_TICKET_TIER_KEYS.filter((tierKey) => tierKeys.includes(tierKey));
    for (const preset of ['all', 'general', 'silver-plus', 'gold-plus', 'platinum']) {
      const values = audiencePresetTierKeys(preset) || [];
      if (values.length === selected.length && values.every((value) => selected.includes(value))) return preset;
    }
    return '';
  }
  function updateEventTicketTierSummary() {
    const root = document.getElementById('eventTicketAllowedTiers');
    const summary = document.getElementById('eventTicketTierSummary');
    if (!root || !summary) return;
    const selectedKeys = collectEventTicketAllowedTiers();
    const labels = selectedKeys.map((tierKey) => CALENDAR_ITEM_TIER_LABELS[tierKey] || tierKey);
    summary.textContent = selectedKeys.length === EVENT_TICKET_TIER_KEYS.length
      ? `所有會員等級 · ${selectedKeys.length} / ${EVENT_TICKET_TIER_KEYS.length}`
      : selectedKeys.length
        ? `${labels.join('、')} · ${selectedKeys.length} / ${EVENT_TICKET_TIER_KEYS.length}`
        : '尚未選擇適用會員 · 0 / 4';
    const activePreset = audiencePresetForTierKeys(selectedKeys);
    root.querySelectorAll('[data-audience-preset]').forEach((button) => {
      const active = String(button.dataset.audiencePreset || '') === activePreset;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    root.classList.toggle('has-no-audience', selectedKeys.length === 0);
  }
  function updateEventTicketTypeUI() { const lottery = els.eventTicketType.value === 'lottery'; const referral = els.eventTicketType.value === 'referral'; els.eventTicketPrizeEditor.classList.toggle('hidden', !lottery); if (referral) { els.eventTicketRequiresLocation.checked = false; window.CouponLocationEditor.set([]); } els.eventTicketLocationRule.classList.toggle('hidden', referral); if (!referral) window.CouponLocationEditor.refresh(); if (lottery && !els.eventTicketPrizeRows.children.length) renderEventTicketPrizeRows([defaultPrize()]); }
  function renderEventTicketPrizeRows(prizes) { els.eventTicketPrizeRows.replaceChildren(...prizes.map((prize, index) => { const row = document.createElement('div'); row.className = 'prize-row'; row.dataset.eventTicketPrizeRow = 'true'; row.append(fieldLabel(`獎項 ${index + 1} 名稱`, 'text', prize.prizeTitle, { field: 'eventTicketPrizeTitle', maxlength: '100', placeholder: '例如：免費蛋糕' }), fieldLabel('中獎機率', 'number', prize.winRate, { field: 'eventTicketPrizeRate', min: '0', max: '100', step: '0.01', suffix: '%' })); const description = fieldLabel('獎項說明（選填）', 'text', prize.prizeDescription, { field: 'eventTicketPrizeDescription', maxlength: '240', placeholder: '例如：可兌換任一蛋糕' }); description.classList.add('prize-description-field'); const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'text-button remove-prize'; remove.dataset.removeEventTicketPrize = 'true'; remove.textContent = '刪除'; row.append(description, remove); return row; })); updateEventTicketPrizeTotal(); }
  function collectEventTicketPrizes() { return Array.from(els.eventTicketPrizeRows.querySelectorAll('[data-event-ticket-prize-row]')).map((row) => ({ prizeTitle: String(row.querySelector('[data-field="eventTicketPrizeTitle"]')?.value || '').trim(), prizeDescription: String(row.querySelector('[data-field="eventTicketPrizeDescription"]')?.value || '').trim(), winRate: Number(row.querySelector('[data-field="eventTicketPrizeRate"]')?.value) })); }
  function updateEventTicketPrizeTotal() { const total = Math.round(collectEventTicketPrizes().reduce((sum, prize) => sum + (Number.isFinite(prize.winRate) ? prize.winRate : 0), 0) * 100); els.eventTicketPrizeTotal.textContent = `機率合計 ${formatRate(total / 100)}%${total === 10000 ? ' ✓' : '／還差 ' + formatRate((10000 - total) / 100) + '%'}`; els.eventTicketPrizeTotal.classList.toggle('warning', total !== 10000); }
  function balanceEventTicketPrizes() { const rows = Array.from(els.eventTicketPrizeRows.querySelectorAll('[data-event-ticket-prize-row]')); if (!rows.length) return; const base = Math.floor(10000 / rows.length); const remainder = 10000 - base * rows.length; rows.forEach((row, index) => { row.querySelector('[data-field="eventTicketPrizeRate"]').value = String((base + (index < remainder ? 1 : 0)) / 100); }); updateEventTicketPrizeTotal(); }
  function validateEventTicketDates(startsOn, endsOn) { const dateMessage = (value, label) => !value || /^\d{4}-\d{2}-\d{2}$/.test(value) && (() => { const parts = value.split('-').map(Number); const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])); return date.getUTCFullYear() === parts[0] && date.getUTCMonth() === parts[1] - 1 && date.getUTCDate() === parts[2]; })() ? '' : `請選擇有效的${label}。`; return dateMessage(startsOn, '活動開始日') || dateMessage(endsOn, '活動結束日') || (startsOn && endsOn && startsOn > endsOn ? '活動結束日不可早於開始日。' : ''); }
  function validateEventTicket(ticket) { if (!['coupon', 'lottery', 'referral', 'membership_join'].includes(ticket.ticketType)) return '請選擇有效的票券類型。'; if (ticket.ticketType === 'referral' && ticket.requiresLocation) return '好友邀請票券目前不支援定位核銷。'; if (!['active', 'draft', 'archived'].includes(ticket.status)) return '請選擇活動票券公開狀態。'; if (!ticket.title || ticket.title.length > 100) return '請填寫活動票券名稱（最多 100 字）。'; if (!ticket.description || ticket.description.length > 240) return '請填寫票券說明（最多 240 字）。'; if (!ticket.usageMethod || ticket.usageMethod.length > 120) return '請填寫使用方式（最多 120 字）。'; if (!ticket.usageInstructions || ticket.usageInstructions.length > 500) return '請填寫使用說明（最多 500 字）。'; if (!ticket.allowedTierKeys.length) return '請至少選擇一個可使用的會員等級。'; if (!Number.isInteger(ticket.quota) || ticket.quota < 0 || ticket.quota > 1000000) return '使用數量上限必須是 0–1,000,000 的整數。'; if (ticket.requiresLocation && (!ticket.redemptionLocations.length || ticket.redemptionLocations.length > 20 || ticket.redemptionLocations.some((location) => !location.name?.trim() || location.name.length > 100 || !Number.isFinite(Number(location.latitude)) || Math.abs(Number(location.latitude)) > 90 || !Number.isFinite(Number(location.longitude)) || Math.abs(Number(location.longitude)) > 180 || !Number.isInteger(Number(location.radiusMeters)) || Number(location.radiusMeters) < 50 || Number(location.radiusMeters) > 2000))) return '請設定 1–20 個有效地點（名稱、座標、50–2000 公尺半徑）。'; if (!['fixed', 'relative', 'both'].includes(ticket.validityMode)) return '請選擇有效的票券使用期限模式。'; if (ticket.validityMode !== 'fixed' && (!Number.isSafeInteger(ticket.validityDays) || ticket.validityDays < 1 || ticket.validityDays > 3650)) return '獲得後有效天數必須是 1–3650。'; if (ticket.validityMode === 'both' && !ticket.endsOn) return '雙重期限必須設定活動結束日。'; const dateMessage = validateEventTicketDates(ticket.startsOn, ticket.endsOn); if (dateMessage) return dateMessage; if (ticket.ticketType !== 'lottery') return ''; if (!ticket.prizes.length || ticket.prizes.length > 30) return '抽獎券至少要設定 1 個獎項，最多 30 個獎項。'; let total = 0; for (const prize of ticket.prizes) { if (!prize.prizeTitle || prize.prizeTitle.length > 100) return '每個抽獎獎項都需要填寫名稱。'; if (prize.prizeDescription.length > 240) return '獎項說明最多 240 字。'; if (!Number.isFinite(prize.winRate) || prize.winRate < 0 || prize.winRate > 100) return '每個獎項機率必須介於 0–100%。'; total += Math.round(prize.winRate * 100); } return total === 10000 ? '' : '同一張抽獎券的獎項機率合計必須正好是 100%。'; }
  async function saveEventTicket(event) {
    event.preventDefault(); if (requireRefreshBeforeWrite(els.eventTicketFormMessage)) return; hideMessage(els.eventTicketFormMessage);
    const ticket = { eventTicketId: els.eventTicketId.value, title: String(els.eventTicketTitle.value || '').trim(), ticketType: els.eventTicketType.value, description: String(els.eventTicketDescription.value || '').trim(), usageMethod: String(els.eventTicketUsageMethod.value || '').trim(), usageInstructions: String(els.eventTicketUsageInstructions.value || '').trim(), status: els.eventTicketStatus.value, startsOn: String(els.eventTicketStartsOn.value || '').trim(), endsOn: els.eventTicketValidityMode.value === 'relative' ? '' : String(els.eventTicketEndsOn.value || '').trim(), validityMode: els.eventTicketValidityMode.value, validityDays: els.eventTicketValidityMode.value === 'fixed' ? null : Number(els.eventTicketValidityDays.value), quota: Number(els.eventTicketQuota.value), requiresLocation: els.eventTicketRequiresLocation.checked, redemptionLocations: window.CouponLocationEditor.get(), allowedTierKeys: collectEventTicketAllowedTiers(), visibilityPolicy: document.getElementById('eventTicketVisibilityPolicy').value, requiredServiceIds: collectRequiredServiceIds(els.eventTicketRequiredServiceIds), requiredServiceMatchMode: els.eventTicketRequiredServiceMatchMode.value, requiredServiceGroups: collectRequiredServiceGroups(document.getElementById('eventTicketRequiredServiceGroups')), minBookingAmountMode: els.eventTicketMinBookingAmountMode.value, minBookingAmount: els.eventTicketMinBookingAmountMode.value === 'none' ? 0 : Number(els.eventTicketMinBookingAmount.value), minBookingServiceIds: els.eventTicketMinBookingAmountMode.value === 'selected_services' ? collectRequiredServiceIds(els.eventTicketMinBookingServiceIds) : [], accent: safeAccent(els.eventTicketAccent.value), prizes: els.eventTicketType.value === 'lottery' ? collectEventTicketPrizes() : [] };
    const validationMessage = ticket.requiredServiceMatchMode === 'groups' && (!ticket.requiredServiceGroups.length || ticket.requiredServiceGroups.some(group => !group.length)) ? '請為每個預約組合至少勾選一個項目。' : (validateEventTicketAmountRule(ticket) || validateEventTicket(ticket)); if (validationMessage) return showMessage(els.eventTicketFormMessage, validationMessage);
    // Publishing general offers is an irreversible bulk grant, not merely a visibility toggle.
    const prior = state.eventTickets.find((row) => row.eventTicketId === ticket.eventTicketId);
    const issuingNow = ticket.status === 'active' && ['coupon', 'lottery'].includes(ticket.ticketType)
      && (!prior || prior.status !== 'active');
    if (issuingNow) {
      const limitLabel = ticket.quota > 0 ? `最多使用 ${ticket.quota} 次` : '使用不限量';
      if (!window.confirm(`啟用「${ticket.title}」將立即發放給所有符合資格的會員，發放張數不設上限；${limitLabel}，只有成功使用／核銷才計入上限。發放後不會因封存自動收回，確定啟用並發放嗎？`)) return;
    }
    setSaving(els.saveEventTicketButton, true, '正在儲存活動票券…');
    try {
      const result = await window.MemberSystem.request(state.config, 'admin', state.idToken, 'admin.event-tickets.save', { eventTicket: ticket, expectedUpdatedAt: els.eventTicketExpectedUpdatedAt.value });
      // Older deployed APIs silently normalize "groups" to "any". Reject that
      // response before loading it into the editor and erasing the user's draft.
      if (ticket.requiredServiceMatchMode === 'groups' && (!result.eventTicket ||
          result.eventTicket.requiredServiceMatchMode !== 'groups' ||
          JSON.stringify(result.eventTicket.requiredServiceGroups) !== JSON.stringify(ticket.requiredServiceGroups))) {
        throw new Error('後端未保留預約組合設定，請勿使用此票券；請聯絡系統管理員確認 API 版本後重新儲存。');
      }
      if (!result.eventTicket || result.eventTicket.minBookingAmountMode !== ticket.minBookingAmountMode
          || Number(result.eventTicket.minBookingAmount || 0) !== ticket.minBookingAmount
          || JSON.stringify(result.eventTicket.minBookingServiceIds || []) !== JSON.stringify(ticket.minBookingServiceIds)) {
        throw new Error('後端未保留最低預約金額設定，請確認 API 與資料庫已升級。');
      }
      if (!result.eventTicket || result.eventTicket.validityMode !== ticket.validityMode || (ticket.validityMode !== 'fixed' && Number(result.eventTicket.validityDays) !== ticket.validityDays)) {
        throw new Error('後端未保留活動票券使用期限設定，請確認 API 與資料庫已升級。');
      }
      if (result.eventTicket) { state.eventTickets = replaceById(state.eventTickets, result.eventTicket, 'eventTicketId'); loadEventTicketForm(result.eventTicket.eventTicketId); }
      if (await refreshAfterSuccessfulWrite('活動票券已儲存', els.eventTicketFormMessage)) showMessage(els.eventTicketFormMessage, ticket.ticketType === 'referral' ? '好友邀請票券已儲存；每成功邀請一位尚未綁定邀請關係的會員，系統會自動發 1 張給邀請者。' : ticket.ticketType === 'membership_join' ? '加入會員票券已儲存；新會員完成加入後由系統自動發放。' : ticket.status === 'active' ? '活動票券已啟用；符合資格的會員已直接取得發放名額，不需要另行領取。' : '活動票券已儲存；草稿或封存狀態不會新增發放。', true);
    } catch (error) { handleActionError(error, els.eventTicketFormMessage); } finally { setSaving(els.saveEventTicketButton, false); }
  }
  async function deleteEventTicket() {
    if (requireRefreshBeforeWrite(els.eventTicketFormMessage)) return;
    const eventTicketId = String(els.eventTicketId.value || '').trim(); const title = String(els.eventTicketTitle.value || '這張活動票券').trim();
    if (!eventTicketId || els.deleteEventTicketButton.disabled) return;
    if (!window.confirm(`刪除「${title}」後，會員端將無法再使用；已發放的票券快照與稽核紀錄會保留。確定要刪除嗎？`)) return;
    const originalText = els.deleteEventTicketButton.textContent;
    els.deleteEventTicketButton.disabled = true; els.deleteEventTicketButton.textContent = '刪除中…'; showOperationProgress('正在刪除活動票券…');
    try {
      const result = await window.MemberSystem.request(state.config, 'admin', state.idToken, 'admin.event-tickets.delete', { eventTicketId, expectedUpdatedAt: els.eventTicketExpectedUpdatedAt.value });
      state.eventTickets = state.eventTickets.filter((ticket) => ticket.eventTicketId !== eventTicketId); state.selectedEventTicketId = ''; resetEventTicketForm();
      const preserved = Number(result.preservedClaimCount || 0);
      if (await refreshAfterSuccessfulWrite('活動票券已刪除', els.eventTicketFormMessage)) showMessage(els.eventTicketFormMessage, preserved ? `活動票券已刪除；已保留 ${preserved} 筆會員票券歷史。` : '活動票券已刪除。', true);
    } catch (error) { handleActionError(error, els.eventTicketFormMessage); } finally { if (!state.writeConfirmationRequired && els.eventTicketId.value === eventTicketId) { els.deleteEventTicketButton.disabled = false; els.deleteEventTicketButton.textContent = originalText; } }
  }
  function updateEventTicketAccentValue() { els.eventTicketAccentValue.textContent = safeAccent(els.eventTicketAccent.value).toUpperCase(); }

  function calendarMonthDates(month) {
    const sharedModel = window.MemberAdminCalendarNavigation?.monthDates;
    if (typeof sharedModel === 'function') return sharedModel(toAdminIsoDate(month));
    // Calendar enhancement is optional: a missing asset must not block admin
    // startup or the original date-cell CRUD handlers.
    const offset = month.getUTCDay();
    return Array.from({length:42}, (_, index) => {
      const date = new Date(month);
      date.setUTCDate(1 + index - offset);
      return date.getUTCFullYear() >= 1000 && date.getUTCFullYear() <= 9999 ? toAdminIsoDate(date) : '';
    });
  }

  function connectCalendarNavigation(grid, scope, month, rows) {
    const settings = {
      activity: { key:'adminCalendarMonth', render:renderAdminCalendar },
      ticket: { key:'ticketCalendarMonth', render:renderEventTicketCalendar },
      booking: { key:'bookingCalendarMonth', render:renderBookingOverviewCalendar }
    }[scope];
    window.MemberAdminCalendarNavigation?.connect({
      grid, scope, month:toAdminIsoDate(month), today:todayAdminIsoDate(), rows,
      onMonthChange(value) { state[settings.key] = value; settings.render(); },
      onCreate(date, opener) {
        if (scope === 'ticket') {
          resetEventTicketForm(false);
          els.eventTicketStartsOn.value = date;
          updateEventTicketDateRangeUI();
          openEditorModal('eventTicket', opener);
        } else openCalendarDateEditor(date, opener, scope === 'booking' ? 'holiday' : 'event');
      },
      onOpen(item, opener) {
        if (item.bookingId) {
          if (window.BusinessWorkspace?.allows('booking') === false) return;
          opener.dataset.adminBookingId = String(item.bookingId);
          handleAdminCalendarGridClick({ target:opener });
        } else if (scope === 'ticket') {
          loadEventTicketForm(String(item.eventTicketId || ''), false);
          openEditorModal('eventTicket', opener);
        } else {
          loadCalendarItemForm(String(item.calendarItemId || ''), false);
          openEditorModal('calendar', opener);
        }
      }
    });
  }

  function prepareCalendarWorkspace() {
    document.getElementById('calendarItemResultCount')?.closest('.list-heading')?.remove();
    document.getElementById('calendarItemListItems')?.remove();
    document.getElementById('calendarItemEmptyState')?.remove();
    els.adminCalendarGrid.closest('.admin-calendar')?.closest('.card-list')?.setAttribute('aria-label', '會員活動月曆，不含活動票券或預約');
    const hint = els.adminCalendarGrid.closest('.admin-calendar')?.querySelector('.admin-calendar-toolbar p');
    if (hint) hint.textContent = '點日期查看當日活動，再按「＋」新增；點既有活動可編輯。休假日請到「預約」設定。';
  }

  function requestOperationalBookingSnapshot() {
    window.dispatchEvent(new CustomEvent('member-admin:booking-snapshot-request'));
  }

  function handleOperationalBookingSnapshot(event) {
    const raw = Array.isArray(event?.detail?.bookings) ? event.detail.bookings : [];
    state.operationalBookings = (window.BusinessWorkspace?.allows('booking') === false ? [] : raw).map((booking) => ({
      bookingId: String(booking.bookingId || ''),
      bookingDate: String(booking.bookingDate || ''),
      startTime: String(booking.startTime || '').slice(0, 5),
      endTime: String(booking.endTime || '').slice(0, 5),
      status: String(booking.status || ''),
      memberDisplayName: String(booking.memberDisplayName || '會員'),
      memberCode: String(booking.memberCode || ''),
      technicianName: String(booking.technicianName || ''),
      partySize: Math.max(1, Number(booking.partySize || 1)),
      cancellationRequestedAt: booking.cancellationRequestedAt || null,
    })).filter((booking) => booking.bookingId && /^\d{4}-\d{2}-\d{2}$/.test(booking.bookingDate));
    renderBookingOverviewCalendar();
  }

  function adminOperationalBookingsForDate(dateValue) {
    return state.operationalBookings
      .filter((booking) => booking.bookingDate === dateValue && ['pending', 'confirmed', 'completed'].includes(booking.status))
      .slice()
      .sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
  }

  function operationalBookingStatusLabel(booking) {
    if (booking.cancellationRequestedAt && booking.status !== 'completed') return '取消申請';
    return ({ pending:'待確認', confirmed:'已確認', completed:'已完成' })[booking.status] || booking.status;
  }

  function createOperationalBookingCalendarButton(booking) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `admin-calendar-booking status-${booking.status}`;
    if (booking.cancellationRequestedAt && booking.status !== 'completed') button.classList.add('has-cancellation-request');
    button.dataset.adminBookingId = booking.bookingId;
    const time = booking.startTime || '—';
    button.textContent = `${time} ${booking.memberDisplayName || booking.memberCode || '會員'}`;
    const details = [operationalBookingStatusLabel(booking), booking.technicianName, booking.partySize > 1 ? booking.partySize + ' 人' : ''].filter(Boolean);
    button.title = details.join(' · ');
    button.setAttribute('aria-label', `${time} ${booking.memberDisplayName || '會員'}，${details.join('，')}；前往預約管理`);
    return button;
  }

  function renderAdminCalendar() {
    const month = currentAdminCalendarMonth();
    state.adminCalendarMonth = toAdminIsoDate(month);
    const title = new Intl.DateTimeFormat('zh-Hant-TW', { timeZone: 'UTC', year: 'numeric', month: 'long' }).format(month);
    const dates = calendarMonthDates(month);
    const previewLimit = typeof window.MemberAdminCalendarNavigation?.connect === 'function' ? 3 : Infinity;
    const today = todayAdminIsoDate();
    const cells = [];
    els.adminCalendarMonthTitle.textContent = title;
    els.adminCalendarGrid.setAttribute('aria-label', title + '會員活動日曆，點選日期查看當日，點選項目編輯');
    for (let index = 0; index < 42; index += 1) {
      const date = dates[index];
      if (!date) {
        const empty = document.createElement('div');
        empty.className = 'admin-calendar-day admin-calendar-day-empty';
        empty.setAttribute('aria-hidden', 'true');
        cells.push(empty);
        continue;
      }
      const day = Number(date.slice(8));
      const entries = adminCalendarItemsForDate(date);
      const cell = document.createElement('article');
      cell.className = 'admin-calendar-day';
      if (date.slice(0, 7) !== toAdminIsoDate(month).slice(0, 7)) cell.classList.add('is-outside-month');
      cell.dataset.adminCalendarDate = date;
      if (date === today) cell.classList.add('is-today');
      if (entries.length) cell.classList.add('has-items');
      const header = document.createElement('div');
      header.className = 'admin-calendar-day-header';
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'admin-calendar-day-button';
      add.dataset.adminCalendarDate = date;
      add.setAttribute('aria-label', formatAdminDateValue(date, true) + '，新增會員活動');
      const number = document.createElement('span');
      number.className = 'admin-calendar-day-number';
      number.textContent = String(day);
      add.append(number);
      header.append(add);
      const items = document.createElement('div');
      items.className = 'admin-calendar-items';
      entries.slice(0, previewLimit).forEach((item) => {
        const row = document.createElement('div');
        row.className = 'admin-calendar-item-row';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'admin-calendar-item ' + (item.itemType === 'holiday' ? 'holiday' : 'event');
        button.dataset.adminCalendarItemId = String(item.calendarItemId || '');
        button.style.setProperty('--calendar-item-accent', safeAccent(item.accent));
        button.setAttribute('aria-label', '編輯會員活動：' + String(item.title || '未命名活動'));
        button.textContent = String(item.title || '未命名活動');
        row.append(button);
        items.append(row);
      });
      if (entries.length > previewLimit) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'calendar-scope-more';
        more.textContent = '另有 ' + (entries.length - previewLimit) + ' 筆';
        more.setAttribute('aria-label', more.textContent + '，查看當日會員活動');
        items.append(more);
      }
      cell.append(header, items);
      cells.push(cell);
    }
    els.adminCalendarGrid.replaceChildren(...cells);
    connectCalendarNavigation(els.adminCalendarGrid, 'activity', month,
      state.calendarItems.filter(item => window.MemberAdminCalendarScopes.belongsToScope('activity', item)));
  }

  function scopedCalendarMonth(key) {
    const month = parseAdminIsoDate(state[key]) || parseAdminIsoDate(todayAdminIsoDate());
    if (!month) return new Date();
    month.setUTCDate(1);
    return month;
  }

  function renderScopedCalendar({ rows, key, gridId, titleId, summaryId, kind }) {
    const grid = document.getElementById(gridId);
    const title = document.getElementById(titleId);
    const summary = document.getElementById(summaryId);
    if (!grid || !title || !summary) return;
    const rules = window.MemberAdminCalendarScopes;
    const month = scopedCalendarMonth(key);
    state[key] = toAdminIsoDate(month);
    const monthLabel = new Intl.DateTimeFormat('zh-Hant-TW', { timeZone: 'UTC', year: 'numeric', month: 'long' }).format(month);
    const dates = calendarMonthDates(month);
    const previewLimit = typeof window.MemberAdminCalendarNavigation?.connect === 'function' ? 3 : Infinity;
    const today = todayAdminIsoDate();
    const cells = [];
    title.textContent = monthLabel;
    grid.setAttribute('aria-label', monthLabel + (kind === 'ticket' ? '活動票券' : '預約') + '專屬日曆');
    let visibleCount = 0;
    for (let index = 0; index < 42; index += 1) {
      const date = dates[index];
      if (!date) {
        const blank = document.createElement('div');
        blank.className = 'admin-calendar-day admin-calendar-day-empty';
        blank.setAttribute('aria-hidden', 'true');
        cells.push(blank);
        continue;
      }
      const day = Number(date.slice(8));
      const entries = rows.filter((item) => (rules.belongsToScope(kind, item) || (kind === 'booking' && rules.belongsToScope('holiday', item))) && rules.occursOn(item, date));
      if (date.slice(0, 7) === state[key].slice(0, 7)) visibleCount += entries.length;
      const cell = document.createElement('article');
      cell.className = 'admin-calendar-day';
      if (date.slice(0, 7) !== toAdminIsoDate(month).slice(0, 7)) cell.classList.add('is-outside-month');
      cell.dataset[kind === 'ticket' ? 'ticketCalendarDate' : 'bookingCalendarDate'] = date;
      if (date === today) cell.classList.add('is-today');
      if (entries.length) cell.classList.add('has-items');
      const header = document.createElement('div');
      header.className = 'admin-calendar-day-header';
      const dayButton = document.createElement('button');
      dayButton.type = 'button';
      dayButton.className = 'admin-calendar-day-button';
      dayButton.dataset[kind === 'ticket' ? 'ticketCalendarDate' : 'bookingCalendarDate'] = date;
      dayButton.setAttribute('aria-label', formatAdminDateValue(date, true) + (kind === 'ticket' ? '，新增活動票券' : '，設定休假日'));
      const number = document.createElement('span');
      number.className = 'admin-calendar-day-number';
      number.textContent = String(day);
      dayButton.append(number);
      header.append(dayButton);
      const items = document.createElement('div');
      items.className = kind === 'ticket' ? 'admin-calendar-items' : 'admin-calendar-bookings';
      entries.slice(0, previewLimit).forEach((item) => {
        const row = document.createElement('div');
        row.className = 'admin-calendar-item-row';
        const button = document.createElement('button');
        button.type = 'button';
        if (kind === 'ticket') {
          button.className = 'admin-calendar-item event';
          button.dataset.ticketCalendarItemId = String(item.eventTicketId);
          button.style.setProperty('--calendar-item-accent', safeAccent(item.accent));
          button.textContent = String(item.title || '未命名活動票券');
          button.setAttribute('aria-label', '編輯活動票券：' + String(item.title || '未命名活動票券'));
        } else if (item.itemType === 'holiday') {
          button.className = 'admin-calendar-item holiday';
          button.dataset.bookingCalendarHolidayId = String(item.calendarItemId);
          button.textContent = '休假 · ' + String(item.title || '休假日');
          button.setAttribute('aria-label', '編輯休假日：' + String(item.title || '休假日'));
        } else {
          button.className = 'admin-calendar-booking status-' + String(item.status || '');
          button.dataset.bookingCalendarId = String(item.bookingId);
          button.textContent = (item.startTime || '—') + ' ' + String(item.memberDisplayName || item.memberCode || '會員');
          button.setAttribute('aria-label', '查看預約：' + String(item.memberDisplayName || '會員') + ' ' + (item.startTime || ''));
        }
        row.append(button);
        items.append(row);
      });
      if (entries.length > previewLimit) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'calendar-scope-more';
        more.textContent = '另有 ' + (entries.length - previewLimit) + ' 筆';
        more.setAttribute('aria-label', more.textContent + '，查看當日' + (kind === 'ticket' ? '活動票券' : '預約與休假'));
        items.append(more);
      }
      cell.append(header, items);
      cells.push(cell);
    }
    grid.replaceChildren(...cells);
    const undated = kind === 'ticket' ? rows.filter((row) => !rules.validIsoDate(row.startsOn)).length : 0;
    summary.textContent = kind === 'ticket'
      ? visibleCount + ' 個日期顯示項目' + (undated ? ' · ' + undated + ' 張未設定開始日的票券在下方清單' : '') + ' · 點日期查看當日，再按「＋」新增'
      : visibleCount + ' 個預約與休假日項目 · 點日期查看時間軸，再按「＋」設定休假日';
    connectCalendarNavigation(grid, kind, month, rows);
  }

  function renderEventTicketCalendar() {
    renderScopedCalendar({
      rows: state.eventTickets, key: 'ticketCalendarMonth',
      gridId: 'eventTicketCalendarGrid', titleId: 'eventTicketCalendarMonthTitle',
      summaryId: 'eventTicketCalendarSummary', kind: 'ticket'
    });
  }

  function renderBookingOverviewCalendar() {
    renderScopedCalendar({
      rows: [...state.operationalBookings.filter((booking) => window.BusinessWorkspace?.allows('booking') !== false && ['pending', 'confirmed', 'completed'].includes(booking.status)),
        ...state.calendarItems.filter((item) => window.MemberAdminCalendarScopes.belongsToScope('holiday', item))],
      key: 'bookingCalendarMonth', gridId: 'bookingOverviewCalendarGrid',
      titleId: 'bookingOverviewCalendarMonthTitle',
      summaryId: 'bookingOverviewCalendarSummary', kind: 'booking'
    });
  }

  function handleScopedCalendarClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const button = target.closest('[data-ticket-calendar-item-id]');
    if (button) {
      const ticketId = String(button.dataset.ticketCalendarItemId || '');
      loadEventTicketForm(ticketId, false);
      openEditorModal('eventTicket', button);
      return;
    }
    const ticketDate = target.closest('[data-ticket-calendar-date]');
    if (ticketDate) {
      const date = String(ticketDate.dataset.ticketCalendarDate || '');
      if (!window.MemberAdminCalendarScopes.validIsoDate(date)) return;
      resetEventTicketForm(false);
      els.eventTicketStartsOn.value = date;
      updateEventTicketDateRangeUI();
      openEditorModal('eventTicket', ticketDate);
      return;
    }
    const holiday = target.closest('[data-booking-calendar-holiday-id]');
    if (holiday) {
      loadCalendarItemForm(String(holiday.dataset.bookingCalendarHolidayId || ''), false);
      openEditorModal('calendar', holiday);
      return;
    }
    const booking = target.closest('[data-booking-calendar-id]');
    if (booking) {
      // Reuse the existing booking-focus handoff (and its single scheduled task).
      // The calendar button is synthesized, so it can carry the same safe ID.
      booking.dataset.adminBookingId = String(booking.dataset.bookingCalendarId || '');
      handleAdminCalendarGridClick(event);
      return;
    }
    const bookingDate = target.closest('[data-booking-calendar-date]');
    if (bookingDate) {
      const date = String(bookingDate.dataset.bookingCalendarDate || '');
      openCalendarDateEditor(date, bookingDate, 'holiday');
      return;
    }
    const monthMove = {
      eventTicketCalendarPreviousMonthButton: ['ticketCalendarMonth', -1, renderEventTicketCalendar],
      eventTicketCalendarNextMonthButton: ['ticketCalendarMonth', 1, renderEventTicketCalendar],
      eventTicketCalendarTodayButton: ['ticketCalendarMonth', 0, renderEventTicketCalendar],
      bookingOverviewCalendarPreviousMonthButton: ['bookingCalendarMonth', -1, renderBookingOverviewCalendar],
      bookingOverviewCalendarNextMonthButton: ['bookingCalendarMonth', 1, renderBookingOverviewCalendar],
      bookingOverviewCalendarTodayButton: ['bookingCalendarMonth', 0, renderBookingOverviewCalendar]
    }[target.closest('button')?.id || ''];
    if (!monthMove) return;
    const [key, offset, render] = monthMove;
    if (offset === 0) state[key] = '';
    else {
      const month = scopedCalendarMonth(key);
      month.setUTCMonth(month.getUTCMonth() + offset);
      state[key] = toAdminIsoDate(month);
    }
    render();
  }

  function currentAdminCalendarMonth() {
    const current = parseAdminIsoDate(state.adminCalendarMonth) || parseAdminIsoDate(todayAdminIsoDate());
    if (!current) return new Date();
    current.setUTCDate(1);
    return current;
  }

  function changeAdminCalendarMonth(offset) {
    const month = currentAdminCalendarMonth();
    month.setUTCMonth(month.getUTCMonth() + Number(offset || 0));
    state.adminCalendarMonth = toAdminIsoDate(month);
    renderAdminCalendar();
  }

  function adminCalendarItemsForDate(dateValue) {
    const rules = window.MemberAdminCalendarScopes;
    return state.calendarItems.filter((item) =>
      rules.belongsToScope('activity', item) && rules.occursOn(item, dateValue));
  }

  function handleAdminCalendarGridClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const bookingButton = target.closest('[data-admin-booking-id]');
    if (bookingButton) {
      document.getElementById('bookingTab')?.click();
      window.setTimeout(() => window.dispatchEvent(new CustomEvent('member-admin:booking-focus', { detail: { bookingId: String(bookingButton.dataset.adminBookingId || '') } })), 0);
      return;
    }
    const itemButton = target.closest('[data-admin-calendar-item-id]');
    if (itemButton) { loadCalendarItemForm(itemButton.dataset.adminCalendarItemId, false); openEditorModal('calendar', itemButton); return; }
    const dateButton = target.closest('[data-admin-calendar-date]');
    if (dateButton) openCalendarDateEditor(dateButton.dataset.adminCalendarDate, dateButton);
  }

  function openCalendarDateEditor(dateValue, opener, itemType = 'event') {
    if (!parseAdminIsoDate(dateValue)) return;
    resetCalendarItemForm(false);
    els.calendarItemType.value = itemType === 'holiday' ? 'holiday' : 'event';
    els.calendarItemStartsOn.value = dateValue;
    els.calendarItemEndsOn.value = '';
    updateCalendarItemTypeUI();
    els.calendarItemEditorTitle.textContent = `新增${formatAdminDateValue(dateValue, true)}${itemType === 'holiday' ? '休假日' : '會員活動'}`;
    openEditorModal('calendar', opener);
  }

  function createCalendarTierAccess() {
    const access = document.createElement('fieldset'); access.className = 'event-ticket-tier-access'; access.dataset.calendarTierAccess = 'true';
    const legend = document.createElement('legend'); legend.textContent = '會員階級顯示規則';
    const description = document.createElement('p'); description.textContent = '每個會員活動各自設定適用階級與顯示方式；可隱藏不符合階級的活動，或顯示較高階級活動的鎖定預覽。';
    const policyLabel = document.createElement('label'); policyLabel.textContent = '會員端顯示方式';
    const policySelect = document.createElement('select'); policySelect.id = 'calendarItemVisibilityPolicy';
    [['eligible_only', '只顯示符合階級的會員活動'], ['higher_preview', '符合階級＋較高階級鎖定預覽']].forEach(([value, label]) => {
      const option = document.createElement('option'); option.value = value; option.textContent = label; policySelect.append(option);
    });
    policyLabel.append(policySelect);
    const options = document.createElement('div'); options.className = 'event-ticket-tier-options';
    CALENDAR_ITEM_TIER_KEYS.forEach((tierKey) => {
      const label = document.createElement('label'); const input = document.createElement('input'); input.type = 'checkbox'; input.value = tierKey; input.checked = true; input.dataset.calendarAllowedTierKey = 'true';
      label.append(input, document.createTextNode(CALENDAR_ITEM_TIER_LABELS[tierKey])); options.append(label);
    });
    const summary = document.createElement('output'); summary.className = 'event-ticket-tier-summary'; summary.dataset.calendarTierSummary = 'true'; summary.setAttribute('aria-live', 'polite');
    access.append(legend, description, policyLabel, options, summary);
    return access;
  }

  function ensureCalendarItemTierAccess() {
    let access = document.getElementById('calendarItemAllowedTiers');
    if (!access) {
      access = createCalendarTierAccess(); access.id = 'calendarItemAllowedTiers';
      const titleField = els.calendarItemTitle.closest('label');
      if (titleField) els.calendarItemForm.insertBefore(access, titleField);
    }
    updateCalendarItemTierSummary();
    updateCalendarItemTypeUI();
    return access;
  }

  function normalizeCalendarItemTierKeys(tierKeys, fallback) {
    if (!Array.isArray(tierKeys)) return Array.isArray(fallback) ? fallback.slice() : [];
    return CALENDAR_ITEM_TIER_KEYS.filter((tierKey) => tierKeys.includes(tierKey));
  }

  function calendarTierKeysFromAccess(access) {
    if (!access) return [];
    return Array.from(access.querySelectorAll('input[data-calendar-allowed-tier-key]:checked')).map((input) => String(input.value || '')).filter((tierKey) => CALENDAR_ITEM_TIER_KEYS.includes(tierKey));
  }

  function setCalendarTierAccess(access, tierKeys) {
    if (!access) return;
    const allowed = normalizeCalendarItemTierKeys(tierKeys, CALENDAR_ITEM_TIER_KEYS);
    access.querySelectorAll('input[data-calendar-allowed-tier-key]').forEach((input) => { input.checked = allowed.includes(input.value); });
    updateCalendarTierAccessSummary(access);
  }

  function calendarItemTierSummaryText(tierKeys) {
    const labels = normalizeCalendarItemTierKeys(tierKeys, CALENDAR_ITEM_TIER_KEYS).map((tierKey) => CALENDAR_ITEM_TIER_LABELS[tierKey]);
    return labels.length === CALENDAR_ITEM_TIER_KEYS.length ? '所有會員等級' : labels.length ? labels.join('、') : '尚未設定參加階級';
  }

  function updateCalendarTierAccessSummary(access) {
    const summary = access && access.querySelector('[data-calendar-tier-summary]');
    if (summary) summary.textContent = '已選擇：' + calendarItemTierSummaryText(calendarTierKeysFromAccess(access));
  }

  function collectCalendarItemAllowedTiers() { return calendarTierKeysFromAccess(document.getElementById('calendarItemAllowedTiers')); }

  function setCalendarItemAllowedTiers(tierKeys) { setCalendarTierAccess(document.getElementById('calendarItemAllowedTiers'), tierKeys); }

  function updateCalendarItemTierSummary() { updateCalendarTierAccessSummary(document.getElementById('calendarItemAllowedTiers')); }

  function updateCalendarItemTypeUI() {
    const access = document.getElementById('calendarItemAllowedTiers');
    if (!access) return;
    const isEvent = els.calendarItemType.value === 'event';
    access.classList.toggle('hidden', !isEvent);
    document.getElementById('calendarItemVisibilityPolicy').disabled = !isEvent;
    access.querySelectorAll('input[data-calendar-allowed-tier-key]').forEach((input) => { input.disabled = !isEvent; });
    els.calendarItemEventLinkFields.classList.toggle('hidden', !isEvent);
    [els.calendarItemLinkLabel, els.calendarItemLinkUrl].forEach((input) => { input.disabled = !isEvent; });
  }

  function handleCalendarItemFormChange(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target === els.calendarItemType) updateCalendarItemTypeUI();
    if (target.matches('input[data-calendar-allowed-tier-key]')) updateCalendarItemTierSummary();
  }

  function loadCalendarItemForm(calendarItemId, shouldRender) {
    const item = state.calendarItems.find((value) => value.calendarItemId === calendarItemId); if (!item) return;
    state.selectedCalendarItemId = calendarItemId;
    els.calendarItemId.value = String(item.calendarItemId || '');
    els.calendarItemExpectedUpdatedAt.value = String(item.updatedAt || '');
    els.calendarItemTitle.value = String(item.title || '');
    els.calendarItemType.value = item.itemType === 'holiday' ? 'holiday' : 'event';
    document.getElementById('calendarItemVisibilityPolicy').value = item.visibilityPolicy || 'eligible_only';
    els.calendarItemDescription.value = String(item.description || '');
    els.calendarItemLinkLabel.value = String(item.linkLabel || '');
    els.calendarItemLinkUrl.value = String(item.linkUrl || '');
    els.calendarItemStatus.value = String(item.status || 'draft');
    els.calendarItemStartsOn.value = String(item.startsOn || '');
    els.calendarItemEndsOn.value = String(item.endsOn || '') === String(item.startsOn || '') ? '' : String(item.endsOn || '');
    els.calendarItemAccent.value = safeAccent(item.accent || '#df6b4d');
    setCalendarItemAllowedTiers(item.allowedTierKeys);
    els.deleteCalendarItemButton.disabled = false; els.deleteCalendarItemButton.textContent = '刪除目前項目';
    updateCalendarItemAccentValue(); updateCalendarItemTypeUI(); hideMessage(els.calendarItemFormMessage);
    els.calendarItemEditorKicker.textContent = 'Edit calendar item'; els.calendarItemEditorTitle.textContent = String(item.title || '編輯日曆項目'); updateEditorStatus(els.calendarItemEditorStatus, item.status); if (shouldRender !== false) renderAdminCalendar();
  }

  function resetCalendarItemForm(shouldRender) {
    state.selectedCalendarItemId = ''; els.calendarItemForm.reset();
    els.calendarItemId.value = ''; els.calendarItemExpectedUpdatedAt.value = ''; els.calendarItemType.value = 'event'; document.getElementById('calendarItemVisibilityPolicy').value = 'eligible_only'; els.calendarItemStatus.value = ''; els.calendarItemStartsOn.value = todayAdminIsoDate(); els.calendarItemEndsOn.value = ''; els.calendarItemAccent.value = '#df6b4d'; els.calendarItemLinkLabel.value = ''; els.calendarItemLinkUrl.value = ''; setCalendarItemAllowedTiers(CALENDAR_ITEM_TIER_KEYS);
    els.deleteCalendarItemButton.disabled = true; els.deleteCalendarItemButton.textContent = '先儲存後才能刪除';
    els.calendarItemEditorKicker.textContent = 'Create calendar item'; els.calendarItemEditorTitle.textContent = '新增日曆項目'; updateEditorStatus(els.calendarItemEditorStatus, ''); updateCalendarItemAccentValue(); updateCalendarItemTypeUI(); hideMessage(els.calendarItemFormMessage); if (shouldRender !== false) renderAdminCalendar();
  }

  function validateCalendarItem(item) {
    if (!item.title || item.title.length > 100) return '請填寫日曆項目名稱（最多 100 字）。';
    if (!['holiday', 'event'].includes(item.itemType)) return '日曆項目類型不合法。';
    if (item.itemType === 'event' && !normalizeCalendarItemTierKeys(item.allowedTierKeys).length) return '請至少選擇一個可參加活動的會員階級。';
    if (item.itemType === 'event' && !['eligible_only', 'higher_preview'].includes(item.visibilityPolicy)) return '請選擇有效的會員階級顯示方式。';
    const linkLabel = String(item.linkLabel || '').trim(); const linkUrl = String(item.linkUrl || '').trim();
    if (item.itemType === 'event' && ((linkLabel || linkUrl) && (!linkLabel || !linkUrl || linkLabel.length > 80 || linkUrl.length > 2048 || !isSafeCalendarLinkUrl(linkUrl)))) return '活動連結需要同時填寫名稱與有效的 HTTPS 網址。';
    if (item.description.length > 500) return '日曆項目說明最多 500 字。';
    if (!parseAdminIsoDate(item.startsOn)) return '請選擇有效的開始日。';
    if (item.endsOn && !parseAdminIsoDate(item.endsOn)) return '請選擇有效的結束日。';
    if (item.endsOn && item.endsOn < item.startsOn) return '結束日不可早於開始日。';
    if (item.endsOn && (parseAdminIsoDate(item.endsOn).getTime() - parseAdminIsoDate(item.startsOn).getTime()) / 86400000 + 1 > 366) return '單一日曆項目最長可設定 366 天。';
    if (!['active', 'draft', 'archived'].includes(item.status)) return '公開狀態不合法。';
    if (!/^#[0-9a-f]{6}$/i.test(item.accent)) return '識別色不合法。';
    return '';
  }

  function isSafeCalendarLinkUrl(value) {
    const url = String(value || '').trim();
    return /^https:\/\/[^\s<>"']+$/i.test(url) && /^https:\/\/[^\/?#@]+(?:[\/?#]|$)/i.test(url);
  }

  async function saveCalendarItem(event) {
    event.preventDefault(); if (requireRefreshBeforeWrite(els.calendarItemFormMessage)) return; hideMessage(els.calendarItemFormMessage);
    const item = { calendarItemId: String(els.calendarItemId.value || '').trim(), title: String(els.calendarItemTitle.value || '').trim(), itemType: els.calendarItemType.value, description: String(els.calendarItemDescription.value || '').trim(), linkLabel: els.calendarItemType.value === 'event' ? String(els.calendarItemLinkLabel.value || '').trim() : '', linkUrl: els.calendarItemType.value === 'event' ? String(els.calendarItemLinkUrl.value || '').trim() : '', status: els.calendarItemStatus.value, startsOn: String(els.calendarItemStartsOn.value || '').trim(), endsOn: String(els.calendarItemEndsOn.value || '').trim(), allowedTierKeys: els.calendarItemType.value === 'event' ? collectCalendarItemAllowedTiers() : [], visibilityPolicy: els.calendarItemType.value === 'event' ? document.getElementById('calendarItemVisibilityPolicy').value : 'eligible_only', accent: safeAccent(els.calendarItemAccent.value) };
    const validationMessage = validateCalendarItem(item); if (validationMessage) return showMessage(els.calendarItemFormMessage, validationMessage);
    setSaving(els.saveCalendarItemButton, true, '正在儲存日曆項目…');
    try {
      const result = await window.MemberSystem.request(state.config, 'admin', state.idToken, 'admin.calendar-items.save', { calendarItem: item, expectedUpdatedAt: els.calendarItemExpectedUpdatedAt.value });
      if (result.calendarItem) { state.calendarItems = replaceById(state.calendarItems, result.calendarItem, 'calendarItemId'); loadCalendarItemForm(result.calendarItem.calendarItemId); }
      if (await refreshAfterSuccessfulWrite('日曆項目已儲存', els.calendarItemFormMessage)) showMessage(els.calendarItemFormMessage, '日曆項目已儲存；啟用後會顯示在會員日曆。', true);
    } catch (error) { handleActionError(error, els.calendarItemFormMessage); } finally { setSaving(els.saveCalendarItemButton, false); }
  }

  async function deleteCalendarItem() {
    if (requireRefreshBeforeWrite(els.calendarItemFormMessage)) return;
    const calendarItemId = String(els.calendarItemId.value || '').trim(); const title = String(els.calendarItemTitle.value || '這個日曆項目').trim();
    if (!calendarItemId || els.deleteCalendarItemButton.disabled) return;
    if (!window.confirm('確定要刪除「' + title + '」嗎？這項日期將立即不再顯示於會員日曆。')) return;
    const originalText = els.deleteCalendarItemButton.textContent;
    els.deleteCalendarItemButton.disabled = true; els.deleteCalendarItemButton.textContent = '刪除中…'; showOperationProgress('正在刪除日曆項目…');
    try {
      await window.MemberSystem.request(state.config, 'admin', state.idToken, 'admin.calendar-items.delete', { calendarItemId: calendarItemId, expectedUpdatedAt: els.calendarItemExpectedUpdatedAt.value });
      state.calendarItems = state.calendarItems.filter((item) => item.calendarItemId !== calendarItemId); state.selectedCalendarItemId = ''; resetCalendarItemForm();
      if (await refreshAfterSuccessfulWrite('日曆項目已刪除', els.calendarItemFormMessage)) showMessage(els.calendarItemFormMessage, '日曆項目已刪除。', true);
    } catch (error) { handleActionError(error, els.calendarItemFormMessage); } finally { if (!state.writeConfirmationRequired && els.calendarItemId.value === calendarItemId) { els.deleteCalendarItemButton.disabled = false; els.deleteCalendarItemButton.textContent = originalText; } }
  }

  function updateCalendarItemAccentValue() { els.calendarItemAccentValue.textContent = safeAccent(els.calendarItemAccent.value).toUpperCase(); }

  function openMemberModal(member) {
    els.memberLineUserId.value = String(member.lineUserId);
    els.memberExpectedUpdatedAt.value = String(member.updatedAt || '');
    els.memberIdentity.textContent = `${member.displayName || 'LINE 使用者'} · ${member.memberCode || '尚未建立'}`;
    els.memberTier.textContent = String(member.tier || '一般會員');
    els.memberStatus.value = member.status === 'active' ? 'active' : 'disabled';
    hideMessage(els.memberFormMessage);
    els.memberModal.classList.remove('hidden');
    els.memberStatus.focus();
  }
  function closeMemberModal() {
    if (state.memberSaving) return;
    els.memberModal.classList.add('hidden');
    if (!els.memberRecordsModal.classList.contains('hidden')) {
      state.memberRecords.childOpener?.focus({ preventScroll: true });
      state.memberRecords.childOpener = null;
    }
  }
  async function saveMember(event) {
    event.preventDefault();
    if (requireRefreshBeforeWrite(els.memberFormMessage)) return;
    if (state.memberSaving) return;
    state.memberSaving = true;
    hideMessage(els.memberFormMessage);
    setSaving(els.saveMemberButton, true, '正在儲存會員狀態…');
    try {
      const payload = { lineUserId: els.memberLineUserId.value, status: els.memberStatus.value, expectedUpdatedAt: els.memberExpectedUpdatedAt.value };
      const result = await window.MemberSystem.request(state.config, 'admin', state.idToken, 'admin.member.update', payload);
      if (result.member) state.members = replaceById(state.members, result.member, 'lineUserId');
      state.memberSaving = false;
      closeMemberModal();
      if (state.memberRecords.lineUserId === payload.lineUserId && result.member) {
        state.memberRecords.member = result.member;
        const scroller = els.memberRecordsModal.querySelector('.modal-card');
        const scrollTop = scroller.scrollTop;
        renderMemberRecordsOverview();
        scroller.scrollTop = scrollTop;
        els.memberRecordsOverview.querySelector('button')?.focus({ preventScroll: true });
      }
      renderAdminOverview();
      if (await refreshAfterSuccessfulWrite('會員狀態已儲存', els.memberFormMessage)) setSyncStatus('會員狀態已儲存 · 已同步', false);
    } catch (error) { handleActionError(error, els.memberFormMessage); } finally { state.memberSaving = false; setSaving(els.saveMemberButton, false); }
  }

  function activeGrantMessagePresets() {
    return state.messagePresets.filter((preset) => preset.status === 'active');
  }
  function renderGrantMessagePresetOptions(selectedId) {
    if (!els.grantMessagePreset) return;
    const preferred = selectedId === undefined ? String(els.grantMessagePreset.value || '') : String(selectedId || '');
    const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = '不附加預設訊息';
    const options = activeGrantMessagePresets().map((preset) => {
      const option = document.createElement('option');
      option.value = String(preset.presetId || '');
      option.textContent = String(preset.title || '未命名預設訊息');
      return option;
    });
    els.grantMessagePreset.replaceChildren(placeholder, ...options);
    const fallback = activeGrantMessagePresets()[0];
    const nextValue = preferred && activeGrantMessagePresets().some((preset) => String(preset.presetId) === preferred)
      ? preferred
      : fallback ? String(fallback.presetId || '') : '';
    els.grantMessagePreset.value = nextValue;
    updateGrantMessagePreview();
  }
  function updateGrantMessagePreview() {
    if (!els.grantMessagePreview) return;
    const preset = state.messagePresets.find((item) => String(item.presetId || '') === String(els.grantMessagePreset.value || ''));
    els.grantMessagePreview.textContent = preset ? String(preset.message || '') : '未選擇預設訊息，LINE 通知只會顯示會員名稱與本次發放明細。';
    els.grantMessagePreview.classList.toggle('is-empty', !preset);
  }
  function renderMessagePresetList(selectedId) {
    if (!els.messagePresetList) return;
    const preferred = selectedId === undefined ? String(els.messagePresetList.value || '') : String(selectedId || '');
    const options = state.messagePresets.map((preset) => {
      const option = document.createElement('option');
      option.value = String(preset.presetId || '');
      option.textContent = String(preset.title || '未命名預設訊息') + (preset.status === 'archived' ? '（停用）' : '');
      return option;
    });
    els.messagePresetList.replaceChildren(...options);
    if (preferred && state.messagePresets.some((preset) => String(preset.presetId || '') === preferred)) els.messagePresetList.value = preferred;
  }
  function openMessagePresetModal() {
    renderMessagePresetList();
    const selectedId = String(els.messagePresetList.value || state.messagePresets[0]?.presetId || '');
    if (selectedId) loadMessagePresetForm(selectedId); else resetMessagePresetForm();
    hideMessage(els.messagePresetFormMessage);
    els.messagePresetModal.classList.remove('hidden');
    window.requestAnimationFrame(() => { if (!els.messagePresetModal.classList.contains('hidden')) els.messagePresetTitle.focus(); });
  }
  function closeMessagePresetModal() { els.messagePresetModal.classList.add('hidden'); }
  function resetMessagePresetForm() {
    els.messagePresetId.value = '';
    els.messagePresetExpectedUpdatedAt.value = '';
    els.messagePresetTitle.value = '';
    els.messagePresetBody.value = '';
    els.messagePresetStatus.value = 'active';
    els.messagePresetList.selectedIndex = -1;
    hideMessage(els.messagePresetFormMessage);
    els.messagePresetTitle.focus();
  }
  function loadMessagePresetForm(presetId) {
    const preset = state.messagePresets.find((item) => String(item.presetId || '') === String(presetId || ''));
    if (!preset) return resetMessagePresetForm();
    els.messagePresetId.value = String(preset.presetId || '');
    els.messagePresetExpectedUpdatedAt.value = String(preset.updatedAt || '');
    els.messagePresetTitle.value = String(preset.title || '');
    els.messagePresetBody.value = String(preset.message || '');
    els.messagePresetStatus.value = preset.status === 'archived' ? 'archived' : 'active';
    els.messagePresetList.value = String(preset.presetId || '');
    hideMessage(els.messagePresetFormMessage);
  }
  async function saveMessagePreset(event) {
    event.preventDefault();
    if (requireRefreshBeforeWrite(els.messagePresetFormMessage)) return;
    hideMessage(els.messagePresetFormMessage);
    const title = String(els.messagePresetTitle.value || '').trim();
    const message = String(els.messagePresetBody.value || '').trim();
    const status = els.messagePresetStatus.value === 'archived' ? 'archived' : 'active';
    if (!title || title.length > 80) return showMessage(els.messagePresetFormMessage, '請輸入預設訊息名稱（最多 80 字）。');
    if (!message || message.length > 1000) return showMessage(els.messagePresetFormMessage, '請輸入預設訊息內容（最多 1000 字）。');
    setSaving(els.saveMessagePresetButton, true, '正在儲存預設訊息…', '儲存中…');
    try {
      const result = await window.MemberSystem.request(state.config, 'admin', state.idToken, 'admin.grant-message-presets.save', {
        messagePreset: {
          presetId: els.messagePresetId.value,
          title,
          message,
          status,
          sortOrder: 0
        },
        expectedUpdatedAt: els.messagePresetExpectedUpdatedAt.value
      });
      state.messagePresets = Array.isArray(result.messagePresets) ? result.messagePresets : state.messagePresets;
      const savedId = String(result.messagePreset && result.messagePreset.presetId || '');
      renderMessagePresetList(savedId);
      renderGrantMessagePresetOptions(status === 'active' ? savedId : '');
      if (savedId) loadMessagePresetForm(savedId);
      showOperationSuccess('預設訊息已儲存');
      showMessage(els.messagePresetFormMessage, '預設訊息已儲存，可直接在發放視窗中選擇。', true);
    } catch (error) { handleActionError(error, els.messagePresetFormMessage); }
    finally { setSaving(els.saveMessagePresetButton, false); }
  }

  function openGrantModal(member) {
    const activeCards = activeGrantCards();
    state.grantRequestId = createRequestId();
    resetServiceGrant();
    els.grantMemberId.value = String(member.lineUserId);
    els.grantMemberName.textContent = `${member.displayName || 'LINE 使用者'} · ${member.memberCode || '尚未建立'} · 服務時間 ${formatServiceMinutes(member.serviceMinutesTotal)}`;
    // 先清掉前一次內容，再立即顯示；不要讓 focus/layout 阻塞 Modal 第一幀。
    els.grantStampsEnabled.checked = false;
    els.grantStampsEnabled.disabled = activeCards.length === 0;
    els.grantServiceTimeEnabled.checked = false;
    els.grantStampAmount.value = '';
    els.grantServiceTimeMinutes.value = '';
    renderGrantMessagePresetOptions();
    els.grantMessageSection.classList.remove('hidden');
    els.grantPointRows.replaceChildren();
    els.grantPointHint.textContent = '勾選「發放集點」後選擇集點卡與點數。';
    els.grantPointHint.classList.remove('warning');
    els.addGrantPointButton.disabled = true;
    els.grantStampsFields.classList.add('hidden');
    els.grantServiceTimeFields.classList.add('hidden');
    els.grantServiceTimeMinutes.disabled = true;
    hideMessage(els.grantFormMessage);
    els.grantModal.classList.remove('hidden');

    const focusTarget = activeCards.length ? els.grantStampsEnabled : els.grantServiceTimeEnabled;
    window.requestAnimationFrame(() => {
      if (els.grantModal.classList.contains('hidden')) return;
      try { focusTarget.focus({ preventScroll: true }); } catch (_) { focusTarget.focus(); }
    });
  }
  function closeGrantModal() {
    if (state.grantSaving) return;
    state.grantRequestId = '';
    serviceGrant.version++;
    els.grantModal.classList.add('hidden');
    if (!els.memberRecordsModal.classList.contains('hidden')) {
      state.memberRecords.childOpener?.focus({ preventScroll: true });
      state.memberRecords.childOpener = null;
    }
  }
  function activeGrantCards() { return window.BusinessWorkspace?.allows('points')===false?[]:state.cards.filter((card) => card.status === 'active' && !card.expired); }
  function renderGrantPointRows(points) { const grants = Array.isArray(points) ? points : []; els.grantPointRows.replaceChildren(...grants.map((grant, index) => createGrantPointRow(grant, index, grants))); updateGrantPointHint(); }
  function createGrantPointRow(grant, index, grants) {
    const row = document.createElement('article'); row.className = 'grant-point-row'; row.dataset.grantPointRow = 'true';
    const heading = document.createElement('div'); heading.className = 'grant-point-row-heading'; const title = document.createElement('strong'); title.textContent = `集點卡 ${index + 1}`; heading.append(title);
    if (grants.length > 1) { const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'text-button'; remove.dataset.removeGrantPoint = 'true'; remove.textContent = '刪除'; heading.append(remove); }
    const grid = document.createElement('div'); grid.className = 'grant-point-row-fields';
    const cardLabel = document.createElement('label'); cardLabel.textContent = '集點卡'; const select = document.createElement('select'); select.dataset.grantPointField = 'cardId'; const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.disabled = true; placeholder.textContent = '請選擇集點卡'; select.append(placeholder); activeGrantCards().forEach((card) => { const option = document.createElement('option'); option.value = String(card.cardId); option.dataset.cardTitle = String(card.title || '未命名集點卡'); option.textContent = option.dataset.cardTitle; select.append(option); }); select.value = String(grant.cardId || ''); cardLabel.append(select);
    const amountLabel = document.createElement('label'); amountLabel.textContent = '增加點數'; const amount = document.createElement('input'); amount.type = 'number'; amount.min = '1'; amount.max = '100'; amount.step = '1'; amount.value = grant.amount === undefined || grant.amount === null ? '' : String(grant.amount); amount.dataset.grantPointField = 'amount'; amountLabel.append(amount); grid.append(cardLabel, amountLabel); row.append(heading, grid); return row;
  }
  function collectGrantPoints() { return Array.from(els.grantPointRows.querySelectorAll('[data-grant-point-row]')).map((row) => ({ cardId: String(row.querySelector('[data-grant-point-field="cardId"]')?.value || '').trim(), amount: Number(row.querySelector('[data-grant-point-field="amount"]')?.value) })); }
  function syncGrantPointCardOptions() {
    const selects = Array.from(els.grantPointRows.querySelectorAll('[data-grant-point-field="cardId"]'));
    const selectedIds = selects.map((select) => String(select.value || '')).filter(Boolean);
    selects.forEach((select) => {
      const currentId = String(select.value || '');
      select.querySelectorAll('option[value]:not([value=""])').forEach((option) => {
        const cardId = String(option.value || '');
        const selectedElsewhere = selectedIds.includes(cardId) && cardId !== currentId;
        option.disabled = selectedElsewhere;
        option.textContent = `${option.dataset.cardTitle || option.textContent.replace(/\s*（已選擇）$/, '')}${selectedElsewhere ? '（已選擇）' : ''}`;
      });
    });
  }
  function addGrantPointRow() { const grants = collectGrantPoints(); if (!activeGrantCards().length || grants.length >= 20) return; grants.push({ cardId: '', amount: '' }); renderGrantPointRows(grants); els.grantPointRows.querySelector('[data-grant-point-row]:last-child select')?.focus(); }
  function updateGrantPointHint() { syncGrantPointCardOptions(); const grants = collectGrantPoints(); const duplicate = grants.some((grant, index) => grants.findIndex((item) => item.cardId === grant.cardId) !== index); const invalid = grants.some((grant) => !grant.cardId || !Number.isInteger(grant.amount) || grant.amount < 1 || grant.amount > 100); const message = !grants.length ? '勾選「發放集點」後選擇集點卡與點數。' : duplicate ? '同一次發放不可重複選擇同一張集點卡。' : invalid ? '每張集點卡請輸入 1–100 的整數點數。' : `${grants.length} 張集點卡 · 每張可設定不同點數。`; els.grantPointHint.textContent = message; els.grantPointHint.classList.toggle('warning', duplicate || invalid); els.addGrantPointButton.disabled = activeGrantCards().length <= grants.length || grants.length >= 20 || !els.grantStampsEnabled.checked; }
  function updateGrantOptions() {
    const addStamps = els.grantStampsEnabled.checked;
    const addServiceTime = els.grantServiceTimeEnabled.checked;
    if (addStamps && !els.grantPointRows.children.length) renderGrantPointRows([{ cardId: '', amount: '' }]);
    els.grantStampsFields.classList.toggle('hidden', !addStamps);
    els.grantPointRows.querySelectorAll('select, input, button').forEach((element) => { element.disabled = !addStamps; });
    if (addStamps) syncGrantPointCardOptions();
    els.addGrantPointButton.disabled = !addStamps || activeGrantCards().length <= collectGrantPoints().length;
    els.grantServiceTimeFields.classList.toggle('hidden', !addServiceTime);
    els.grantServiceTimeMinutes.disabled = !addServiceTime;
  }
  const serviceGrant = { version: 0, preview: null };
  function resetServiceGrant() {
    serviceGrant.version++;
    serviceGrant.preview = null;
    els.grantMode.value = 'manual';
    els.grantMode.disabled = false;
    els.grantServiceFields.hidden = true;
    els.grantServiceList.replaceChildren();
    els.grantForm.querySelectorAll(':scope > fieldset').forEach(node => node.hidden = false);
    els.saveGrantButton.disabled = state.writeConfirmationRequired;
  }
  function invalidateServicePreview() {
    serviceGrant.version++;
    serviceGrant.preview = null;
    state.grantRequestId = createRequestId();
    els.grantServicePreview.textContent = '項目已變更，請重新預覽並確認。';
    els.saveGrantButton.disabled = true;
    els.previewServiceGrantButton.disabled = false;
    els.grantServiceList.querySelectorAll('[data-service-grant-id]').forEach(input => {
      input.closest('.grant-service-row').querySelector('input[type="number"]').disabled = !input.checked;
    });
  }
  async function changeGrantMode() {
    if(els.grantMode.value==='services'&&window.BusinessWorkspace?.allows('membership','points','booking')===false)els.grantMode.value='manual';
    const services = els.grantMode.value === 'services';
    const version = ++serviceGrant.version;
    serviceGrant.preview = null;
    state.grantRequestId = createRequestId();
    els.grantStampsEnabled.checked = false;
    els.grantServiceTimeEnabled.checked = false;
    els.grantPointRows.replaceChildren();
    els.grantServiceTimeMinutes.value = '';
    updateGrantOptions();
    els.grantServiceFields.hidden = !services;
    els.grantForm.querySelectorAll(':scope > fieldset').forEach(node => node.hidden = services);
    els.saveGrantButton.disabled = services || state.writeConfirmationRequired;
    if (!services) return;
    els.grantServiceList.replaceChildren();
    els.grantServiceStatus.textContent = '正在載入有效服務項目…';
    els.grantServicePreview.textContent = '請選擇服務項目並預覽。';
    els.previewServiceGrantButton.disabled = true;
    try {
      const result = await window.MemberSystem.request(state.config, 'admin', state.idToken, 'admin.service-grants.catalog', {});
      if (version !== serviceGrant.version) return;
      for (const item of result.services || []) {
        const row = document.createElement('div'); row.className = 'grant-service-row';
        const input = document.createElement('input'); input.type = 'checkbox'; input.dataset.serviceGrantId = item.serviceId;
        input.id = 'grant-service-' + item.serviceId;
        const label = document.createElement('label'); label.htmlFor = input.id;
        const title = document.createElement('strong'); title.textContent = item.title;
        const hint = document.createElement('small'); hint.textContent = `${item.serviceType || '服務'} · ${item.durationMinutes} 分鐘${item.countsTowardMembership ? '' : ' · 不計會員時間'}${item.requiresCompanionService ? ' · 需搭配主服務' : ''}`;
        label.append(title, hint);
        const quantity = document.createElement('input'); quantity.type = 'number'; quantity.min = '1'; quantity.max = '2'; quantity.step = '1'; quantity.value = '1'; quantity.disabled = true; quantity.setAttribute('aria-label', item.title + '數量');
        row.append(input, label, quantity); els.grantServiceList.append(row);
      }
      els.grantServiceStatus.textContent = els.grantServiceList.children.length ? '選擇實際服務項目與數量；點數按現有服務類型規則計算。' : '目前沒有有效服務項目，可改用手動發放。';
      els.previewServiceGrantButton.disabled = !els.grantServiceList.children.length;
    } catch (error) {
      if (version !== serviceGrant.version) return;
      els.grantServiceStatus.textContent = error.message || '服務項目載入失敗，請切換登記方式後重試。';
    }
  }
  function collectServiceGrantItems() {
    return [...els.grantServiceList.querySelectorAll('[data-service-grant-id]:checked')].map(input => ({
      serviceId: input.dataset.serviceGrantId,
      quantity: Number(input.closest('.grant-service-row').querySelector('input[type="number"]').value)
    }));
  }
  function serviceGrantSummary(preview) {
    return [(preview.points || []).map(point => `${point.cardTitle} +${point.amount} 點`).join('、'), `會員服務時間 +${preview.serviceMinutes} 分鐘`].filter(Boolean).join('；');
  }
  async function previewServiceGrant() {
    if (state.grantSaving) return;
    const items = collectServiceGrantItems();
    if (!items.length || items.some(item => !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 2)) return showMessage(els.grantFormMessage, '請選擇服務項目，數量須為 1–2 的整數。');
    const version = ++serviceGrant.version;
    serviceGrant.preview = null;
    els.previewServiceGrantButton.disabled = true;
    els.saveGrantButton.disabled = true;
    els.grantServicePreview.textContent = '正在計算發放明細…';
    hideMessage(els.grantFormMessage);
    try {
      const result = await window.MemberSystem.request(state.config, 'admin', state.idToken, 'admin.service-grants.preview', { lineUserId: els.grantMemberId.value, items });
      if (version !== serviceGrant.version) return;
      serviceGrant.preview = result.preview;
      const lines = result.preview.items.map(item => { const line = document.createElement('p'); line.textContent = `${item.title} ×${item.quantity} · ${item.durationMinutes * item.quantity} 分鐘`; return line; });
      const total = document.createElement('strong'); total.textContent = serviceGrantSummary(result.preview);
      els.grantServicePreview.replaceChildren(...lines,total);
      els.saveGrantButton.disabled = state.writeConfirmationRequired;
    } catch (error) {
      if (version === serviceGrant.version) { els.grantServicePreview.textContent = '尚未取得有效預覽。'; handleActionError(error, els.grantFormMessage); }
    } finally { if (version === serviceGrant.version) els.previewServiceGrantButton.disabled = false; }
  }
  async function saveServiceItemGrant() {
    if (!serviceGrant.preview) return showMessage(els.grantFormMessage, '請先預覽並確認發放明細。');
    const targetMember = state.members.find(member => member.lineUserId === els.grantMemberId.value);
    const payload = { lineUserId: els.grantMemberId.value, requestId: state.grantRequestId, items: collectServiceGrantItems(), expectedPreview: serviceGrant.preview, messagePresetId: els.grantMessagePreset.value };
    state.grantSaving = true;
    els.grantMode.disabled = true;
    els.grantServiceFields.querySelectorAll('input,button').forEach(node => node.disabled = true);
    setSaving(els.saveGrantButton, true, '正在依服務項目登記發放…', '發放中…');
    try {
      const result = await window.MemberSystem.request(state.config, 'admin', state.idToken, 'admin.service-grants.add', payload);
      if (result.member) state.members = replaceById(state.members,result.member,'lineUserId');
      const details = serviceGrantSummary(result.grant?.preview || payload.expectedPreview);
      state.grantSaving = false;
      closeGrantModal(); showGrantSuccess(details);
      const notice = result.notification?.status === 'failed' ? '；' + result.notification.message : '';
      await refreshAfterSuccessfulWrite('發放完成：' + details + notice, null, false);
    } catch (error) {
      if (error.code === 'SERVICE_GRANT_PREVIEW_STALE') serviceGrant.preview = null;
      handleActionError(error, els.grantFormMessage);
    } finally {
      state.grantSaving = false; els.grantMode.disabled = false;
      els.grantServiceFields.querySelectorAll('input,button').forEach(node => node.disabled = false);
      setSaving(els.saveGrantButton, false);
      if (!serviceGrant.preview) els.saveGrantButton.disabled = true;
    }
  }
  async function saveGrant(event) {
    event.preventDefault(); if (state.grantSaving || requireRefreshBeforeWrite(els.grantFormMessage)) return; hideMessage(els.grantFormMessage);
    if (els.grantMode.value === 'services') return saveServiceItemGrant();
    const addStamps = els.grantStampsEnabled.checked; const addServiceTime = els.grantServiceTimeEnabled.checked;
    const points = collectGrantPoints(); const serviceTimeMinutes = Number(els.grantServiceTimeMinutes.value);
    if (!addStamps && !addServiceTime) return showMessage(els.grantFormMessage, '請至少勾選「發放集點」或「發放消費服務時間」。');
    if (addStamps && (!points.length || points.some((point) => !point.cardId || !Number.isInteger(point.amount) || point.amount < 1 || point.amount > 100) || new Set(points.map((point) => point.cardId)).size !== points.length)) return showMessage(els.grantFormMessage, '請為每張集點卡選擇不同卡片，並輸入 1–100 的整數點數。');
    if (addServiceTime && (!Number.isInteger(serviceTimeMinutes) || serviceTimeMinutes < 1 || serviceTimeMinutes > 1440)) return showMessage(els.grantFormMessage, '請輸入 1–1440 的整數分鐘數。');
    const targetMember = state.members.find((member) => String(member.lineUserId || '') === String(els.grantMemberId.value || '')); const payload = { lineUserId: els.grantMemberId.value, requestId: state.grantRequestId || (state.grantRequestId = createRequestId()), messagePresetId: String(els.grantMessagePreset.value || '') };
    if (addStamps) payload.points = points;
    if (addServiceTime) payload.serviceTime = { minutes: serviceTimeMinutes };
    state.grantSaving = true;
    setSaving(els.saveGrantButton, true, '正在發放集點與服務時間…', '發放中…');
    try {
      const result = await window.MemberSystem.request(state.config, 'admin', state.idToken, 'admin.member-grants.add', payload);
      if (result.member) state.members = replaceById(state.members, result.member, 'lineUserId');
      const titlesById = Object.fromEntries(activeGrantCards().map((card) => [String(card.cardId), String(card.title || '集點卡')]));
      const details = [addStamps ? points.map((point) => `${titlesById[point.cardId] || '集點卡'} +${point.amount} 點`).join('、') : '', addServiceTime ? formatServiceMinutes(serviceTimeMinutes) : ''].filter(Boolean).join('、');
      const notificationMessage = result.notification && result.notification.status !== 'sent' ? `；${result.notification.message}` : '';
      state.grantSaving = false;
      closeGrantModal(); showGrantSuccess(details);
      if (await refreshAfterSuccessfulWrite('發放完成' + notificationMessage, null, false)) setSyncStatus(`發放完成：${details}${notificationMessage} · 已同步`, false);
    } catch (error) { handleActionError(error, els.grantFormMessage); } finally { state.grantSaving = false; setSaving(els.saveGrantButton, false); }
  }

  function switchPanel(panel) {
    if (panel === 'clientPageTitle' && (els.clientPageTitleTab.hidden || els.clientPageTitleTab.disabled)) return;
    state.activePanel = panel;
    ['members', 'cards', 'events', 'calendar'].forEach((name) => { const selected = name === panel; els[name + 'Tab'].setAttribute('aria-selected', String(selected)); els[name + 'Panel'].classList.toggle('hidden', !selected); });
    const titleSelected = panel === 'clientPageTitle';
    els.clientPageTitleTab.setAttribute('aria-selected', String(titleSelected));
    els.clientPageTitleShortcut.hidden = !titleSelected;
    els.clientPageTitleShortcut.classList.toggle('hidden', !titleSelected);
    if (panel !== 'clientPageTitle' && !state.loadedPanels[panel]) ensureAdminPanelData(panel).catch((error) => { setSyncStatus(error && error.message || '資料載入失敗，請稍後再試。', true); });
  }
  function switchCardWorkspace(workspace) { state.activeCardWorkspace = workspace; const workspaces = [['cards', 'cardSettingsTab', 'cardSettingsPanel'], ['tickets', 'ticketSettingsTab', 'ticketSettingsPanel']]; workspaces.forEach(([name, tabId, panelId]) => { const selected = name === workspace; els[tabId].setAttribute('aria-selected', String(selected)); els[panelId].classList.toggle('hidden', !selected); }); }
  function updateAccentValue() { els.accentValue.textContent = safeAccent(els.cardAccent.value).toUpperCase(); }
  function updateEditorStatus(element, status) { element.textContent = statusLabel(status); element.className = `editor-status ${status}`; }
  function statusLabel(status) { return ({ active: '啟用中', draft: '草稿', archived: '已封存', disabled: '已停用' })[status] || '未設定'; }
  function safeAccent(value) { return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value) : '#e47845'; }
  function safeTierStyle(value) { const styleKey = String(value || '').trim(); return MEMBERSHIP_TIER_STYLE_KEYS.includes(styleKey) ? styleKey : 'forest'; }
  function safePointCardStyle(value) { const styleKey = String(value || '').trim().toLowerCase(); return POINT_CARD_STYLE_KEYS.includes(styleKey) ? styleKey : (LEGACY_POINT_CARD_STYLE_MAP[styleKey] || POINT_CARD_STYLE_KEYS[0]); }
  function replaceById(items, next, key) { return items.some((item) => item[key] === next[key]) ? items.map((item) => item[key] === next[key] ? next : item) : [next, ...items]; }
  function createRequestId() { if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID(); return `request-${Date.now()}-${Math.random().toString(36).slice(2, 14)}`; }
  function formatServiceMinutes(value) { return `${Math.max(0, Math.floor(Number(value) || 0))} 分鐘`; }
  function showOperationNotice(message, tone, duration) {
    const notice = els.grantSuccessNotice;
    if (!notice) return;
    if (state.grantSuccessTimer) window.clearTimeout(state.grantSuccessTimer);
    notice.textContent = message;
    notice.classList.remove('hidden', 'is-processing', 'is-success', 'is-warning', 'is-error');
    notice.classList.add(`is-${tone}`);
    const hideAfter = duration === undefined ? (tone === 'processing' ? 0 : 3600) : duration;
    if (hideAfter > 0) state.grantSuccessTimer = window.setTimeout(() => { notice.classList.add('hidden'); state.grantSuccessTimer = null; }, hideAfter);
    else state.grantSuccessTimer = null;
  }
  function showOperationProgress(message) { showOperationNotice(message, 'processing', 0); }
  function showOperationSuccess(message) { showOperationNotice(message, 'success'); }
  function showGrantSuccess(details) { showOperationSuccess(details ? `發放完成：${details}` : '發放完成'); }
  function setSaving(button, saving, progressMessage, busyLabel) { button.disabled = saving || state.writeConfirmationRequired; if (saving) { button.dataset.originalText = button.textContent; button.textContent = busyLabel || '儲存中…'; showOperationProgress(progressMessage || '正在儲存…'); } else button.textContent = state.writeConfirmationRequired ? '請重新整理確認' : button.dataset.originalText || button.textContent; }
  function showMessage(element, message, success) { element.textContent = message; element.classList.toggle('success', Boolean(success)); element.classList.remove('hidden'); }
  function hideMessage(element) { element.textContent = ''; element.classList.add('hidden'); element.classList.remove('success'); const action = element.nextElementSibling; if (action && action.matches('[data-uncertain-write-refresh]')) action.remove(); }
  function showUncertainWriteMessage(element) {
    hideMessage(element);
    showMessage(element, '無法確認這次操作是否完成。資料可能已更新；請先重新整理確認，請勿重複送出。');
    const refreshButton = document.createElement('button'); refreshButton.type = 'button'; refreshButton.className = 'button button-outline uncertain-write-refresh'; refreshButton.dataset.uncertainWriteRefresh = 'true'; refreshButton.textContent = '重新整理確認'; refreshButton.addEventListener('click', () => window.location.reload());
    element.insertAdjacentElement('afterend', refreshButton);
  }
  function lockAdminWrites() { [els.saveTierSettingsButton, els.saveCardButton, els.archiveCardButton, els.deleteCardButton, els.saveTicketButton, els.deleteTicketButton, els.saveEventTicketButton, els.deleteEventTicketButton, els.saveCalendarItemButton, els.deleteCalendarItemButton, els.saveMemberButton, els.saveGrantButton, els.saveMessagePresetButton].forEach((button) => { if (button) button.disabled = true; }); els.refreshButton.classList.remove('hidden'); els.refreshButton.textContent = '重新整理確認'; renderCardList(); }
  function requireRefreshBeforeWrite(element) { if (!state.writeConfirmationRequired) return false; showUncertainWriteMessage(element); return true; }
  function setSyncStatus(message, error) { els.syncStatus.textContent = message; els.syncStatus.classList.toggle('error', Boolean(error)); }
  async function refreshAfterSuccessfulWrite(successMessage, messageElement, showSuccessNotice = true) {
    if (showSuccessNotice) showOperationSuccess(successMessage);
    try { await refreshData(false); return true; } catch (_) {
      const message = `${successMessage}；資料已完成更新，但畫面同步失敗，請重新整理確認。`;
      showOperationNotice(message, 'warning', 5200);
      if (messageElement) showMessage(messageElement, message, true);
      setSyncStatus('資料已更新，但畫面同步失敗，請重新整理確認。', true);
      return false;
    }
  }
  function handleActionError(error, element) { if (error && error.code === 'API_RESPONSE_UNCERTAIN') { state.writeConfirmationRequired = true; lockAdminWrites(); showOperationNotice('無法確認這次操作是否完成，請重新整理確認。', 'warning', 0); showUncertainWriteMessage(element); setSyncStatus('寫入結果尚未確認；請重新整理確認後再操作。', true); return; } showOperationNotice(error && error.code === 'CONFLICT' ? '資料已被其他管理者更新，請重新整理後再試。' : '操作未完成，請查看表單提示。', 'error', 4600); showMessage(element, error && error.code === 'CONFLICT' ? '資料已被另一位管理者更新，請重新整理後再儲存。' : error && error.message || '操作失敗，請稍後再試。'); }
  function handleBootError(error) { if (error && error.code === 'ADMIN_PENDING') { els.pendingUserId.textContent = String(error.details && error.details.lineUserId || '請查看 Admins 資料表'); els.pendingBox.classList.remove('hidden'); showError('此 LINE 帳號尚未授權', 'GAS 已記錄這次管理端登入，但目前不允許進入管理功能。'); return; } if (error && error.code === 'ADMIN_FORBIDDEN') { showError('沒有管理端權限', '此 LINE 帳號未啟用管理權限，請檢查 Admins 的 role 與 status。'); return; } showError(error && error.code === 'CONFIG_ERROR' ? '系統尚未完成設定' : '暫時無法進入管理端', error && error.message || '請稍後重新整理。'); }
  function setView(view) {
    els.loadingView.classList.toggle('hidden', view !== 'loading');
    els.errorView.classList.toggle('hidden', view !== 'error');
    els.adminView.classList.toggle('hidden', view !== 'admin');
    // Route-only shortcut: never show a business setting for unscoped, expired,
    // unauthenticated or failed admin sessions. Server permission checks remain authoritative.
    if (view === 'admin') window.ClientPageTitleShortcut?.sync(state.config, state.idToken);
    else window.ClientPageTitleShortcut?.clear();
  }
  function startLoginProgress(status, ceiling) { stopLoginProgress(); const maximum = Math.max(loginProgressValue, Math.min(98, Number(ceiling) || loginProgressValue)); setLoginProgress(loginProgressValue, status); loginProgressTimer = window.setInterval(() => { const remaining = maximum - loginProgressValue; if (remaining <= 0) return stopLoginProgress(); setLoginProgress(Math.min(maximum, loginProgressValue + Math.max(1, Math.ceil(remaining * .12))), status); }, LOGIN_PROGRESS_TICK_MS); }
  function stopLoginProgress() { if (loginProgressTimer !== null) window.clearInterval(loginProgressTimer); loginProgressTimer = null; }
  function completeLoginProgress(status) {
    stopLoginProgress();
    // 資料就緒便交還操作，不讓裝飾性動畫阻塞主要畫面。
    setLoginProgress(100, status);
    return Promise.resolve();
  }

  function setLoginProgress(value, status) { const progress = Math.max(loginProgressValue, Math.max(0, Math.min(100, Math.round(Number(value) || 0)))); loginProgressValue = progress; els.loadingProgress.setAttribute('aria-valuenow', String(progress)); els.loadingProgress.setAttribute('aria-valuetext', `${progress}%`); els.loadingProgressBar.style.width = `${progress}%`; els.loadingProgressText.textContent = `${progress}%`; if (status) els.loadingStatus.textContent = status; }
  function showError(title, message) { els.errorTitle.textContent = title; els.errorMessage.textContent = message; setView('error'); }

  window.MemberAdminDataSync = Object.freeze({
    refresh: () => refreshData(false)
  });
})();

