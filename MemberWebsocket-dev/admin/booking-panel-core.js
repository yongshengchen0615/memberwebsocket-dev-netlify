(() => {
  'use strict';

  const STORE_SERVICE_ID = '00000000-0000-4000-8000-000000000010';
  const PRIMARY_TAB_IDS = ['membersTab', 'cardsTab', 'eventsTab', 'calendarTab', 'testModeTab'];
  const PRIMARY_PANEL_IDS = ['membersPanel', 'cardsPanel', 'eventsPanel', 'calendarPanel', 'testModePanel'];
  const NO_SHOW_EARLY_REASON = '服務結束後才能標記無故未到。';
  const STATUS_LABELS = { pending: '待確認', confirmed: '已確認', completed: '服務已完成', rejected: '未通過', cancelled: '已取消', no_show: '無故未到' };
  const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];
  const state = {
    config: null,
    booking: { settings: {}, bookings: [], groups: {}, technicians: [], primaryTechnicianId: '' },
    catalog: { serviceTypes: [], services: [], pointCards: [] },
    filter: new URLSearchParams(window.location.search).has('bookingId') ? 'all' : 'pending',
    subtab: new URLSearchParams(window.location.search).has('bookingId') ? 'queue' : 'technicians',
    queueMode: 'standard',
    selected: new Set(),
    loading: false,
    refreshQueued: false,
    refreshQueuedShowSuccess: false,
    busy: false,
    realtimeListening: false,
    realtimeTimer: null,
    badgeLoading: false,
    badgeQueued: false,
    badgeStartPromise: null,
    unreadCount: 0,
    pendingCount: 0,
    accessiblePendingCount: 0,
    latestNotificationId: 0,
    bookingRenderSignatures: new Map(),
    settingsBaseline: null,
    settingsDraftVersion: '',
    settingsDirty: false,
  };
  const SETTINGS_INPUT_IDS = ['bookingAdminStartTime','bookingAdminEndTime','bookingAdminSlotInterval','bookingAdminAdvanceDays','bookingAdminMaxAdvanceDays','bookingAdminStoreServiceMinutes','bookingAdminReminderEnabled','bookingAdminSnapshotLocationRequired','bookingAdminReminderTime','bookingAdminNotice'];
  const els = {};

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();

  function mount() {
    const nav = document.querySelector('#adminView .surface-nav');
    const adminView = document.getElementById('adminView');
    if (!nav || !adminView || document.getElementById('bookingTab')) return;

    const tab = document.createElement('button');
    tab.id = 'bookingTab';
    tab.className = 'surface-tab';
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', 'false');
    tab.setAttribute('aria-controls', 'bookingPanel');
    tab.textContent = '預約';
    const badge = document.createElement('span');
    badge.className = 'booking-nav-count';
    badge.setAttribute('aria-hidden', 'true');
    badge.hidden = true;
    tab.appendChild(badge);
    const testModeTab = document.getElementById('testModeTab');
    if (testModeTab && testModeTab.parentElement === nav) nav.insertBefore(tab, testModeTab);
    else nav.appendChild(tab);

    const panel = document.createElement('section');
    panel.id = 'bookingPanel';
    panel.className = 'panel hidden';
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', 'bookingTab');
    panel.innerHTML = `
      <div class="panel-heading booking-admin-heading">
        <div><p class="kicker">Booking operations</p><h2>預約管理</h2><p>技師、預約項目、共用設定與用戶預約分頁管理，降低單頁資訊密度。</p></div>
        <div class="heading-actions"><span id="bookingAdminSyncStatus" class="sync-status">尚未同步</span></div>
      </div>

      <section class="booking-admin-stats" aria-label="預約概況">
        <div><span>預約項目</span><strong id="bookingAdminServiceCount">0</strong><small>目前可管理項目</small></div>
        <div><span>一般待確認</span><strong id="bookingAdminPendingCount">0</strong><small>會員正常預約流程</small></div>
        <div><span>快照待審核</span><strong id="bookingAdminAccessiblePendingCount">0</strong><small>收據補登審核</small></div>
        <div><span>已確認</span><strong id="bookingAdminConfirmedCount">0</strong><small>已確認的一般預約</small></div>
      </section>

      <nav class="booking-admin-filter booking-admin-subtabs" role="tablist" aria-label="預約管理分類">
        <button id="bookingAdminTechniciansSubtab" class="booking-admin-filter-button active" type="button" role="tab" aria-selected="true" aria-controls="bookingAdminTechniciansPanel">技師設定</button>
        <button id="bookingAdminServicesSubtab" class="booking-admin-filter-button" type="button" role="tab" aria-selected="false" aria-controls="bookingAdminServicesPanel">預約項目</button>
        <button id="bookingAdminSettingsSubtab" class="booking-admin-filter-button" type="button" role="tab" aria-selected="false" aria-controls="bookingAdminSettingsPanel">預約共用設定</button>
        <button id="bookingAdminQueueSubtab" class="booking-admin-filter-button" type="button" role="tab" aria-selected="false" aria-controls="bookingAdminQueuePanel">用戶預約<span id="bookingAdminQueueSubtabCount"></span></button>
      </nav>

      <div class="booking-admin-subtab-panels">
        <section id="bookingAdminTechniciansPanel" class="booking-admin-card" role="tabpanel" aria-labelledby="bookingAdminTechniciansSubtab">
          <div id="bookingAdminTechnicianMount" class="booking-admin-technician-mount"></div>
        </section>

        <section id="bookingAdminServicesPanel" class="booking-admin-card hidden" role="tabpanel" aria-labelledby="bookingAdminServicesSubtab">
          <div class="booking-admin-section-heading"><div><p class="kicker">Booking catalog</p><h3>預約項目</h3><p>項目類型與實際預約項目集中在同一頁管理。</p></div></div>
          <div class="booking-admin-catalog-section">
            <div class="booking-admin-list-heading booking-admin-list-heading-first"><strong>項目類型</strong><button id="bookingAdminNewTypeButton" class="button button-outline" type="button">＋ 新增類型</button></div>
            <div id="bookingAdminTypeMessage" class="form-message hidden" role="status"></div>
            <div id="bookingAdminTypeList" class="booking-admin-service-list"></div>
            <div id="bookingAdminTypeEmpty" class="empty-state compact hidden"><span aria-hidden="true">○</span><p>尚未建立項目類型</p></div>
          </div>
          <div class="booking-admin-catalog-section booking-admin-catalog-services">
            <div class="booking-admin-list-heading"><strong>預約項目</strong></div>
            <div class="booking-admin-actions booking-admin-service-actions">
              <button id="bookingAdminNewServiceButton" class="button button-dark" type="button">＋ 新增項目</button>
              <button id="bookingAdminBatchAddButton" class="button button-outline" type="button">批次新增</button>
              <button id="bookingAdminBatchEditButton" class="button button-outline" type="button" disabled>批次修改</button>
              <button id="bookingAdminBatchDeleteButton" class="button button-danger" type="button" disabled>批次刪除</button>
            </div>
            <div id="bookingAdminServiceMessage" class="form-message hidden" role="status"></div>
            <div id="bookingAdminServiceList" class="booking-admin-service-list"></div>
            <div id="bookingAdminServiceEmpty" class="empty-state compact hidden"><span aria-hidden="true">○</span><p>尚未建立預約項目</p></div>
          </div>
        </section>

        <section id="bookingAdminSettingsPanel" class="booking-admin-card booking-admin-settings-panel hidden" role="tabpanel" aria-labelledby="bookingAdminSettingsSubtab">
          <div class="booking-admin-section-heading"><div><p class="kicker">Booking settings</p><h3 id="bookingAdminHoursTitle">預約共用設定</h3><p>集中管理所有預約共同使用的工作時間、可預約日期範圍與會員端說明。</p></div></div>
          <form id="bookingAdminSettingsForm" class="booking-admin-form booking-admin-settings-form" novalidate>
            <div class="booking-admin-settings-layout">
              <section class="booking-admin-settings-block booking-admin-settings-hours" aria-labelledby="bookingAdminWorkingHoursHeading">
                <div class="booking-admin-settings-block-heading">
                  <div><span class="booking-admin-settings-eyebrow">營業時段</span><h4 id="bookingAdminWorkingHoursHeading">工作時間</h4></div>
                  <span class="booking-admin-settings-badge">每日共用</span>
                </div>
                <div class="booking-admin-form-grid booking-admin-global-settings-grid booking-admin-time-grid">
                  <label class="booking-admin-settings-field"><span>開始工作時間</span><input id="bookingAdminStartTime" type="time" step="300" value="09:00" required><small>會員端可選擇的第一個開始時段。</small></label>
                  <label class="booking-admin-settings-field"><span>結束工作時間</span><input id="bookingAdminEndTime" type="time" step="300" value="17:00" required><small>早於開始時間代表隔日結束，例如 14:00–02:00。</small></label>
                  <label class="booking-admin-settings-field"><span>時段切分間隔</span><div class="booking-admin-number-field"><input id="bookingAdminSlotInterval" type="number" min="5" max="120" step="5" value="30" required><span aria-hidden="true">分鐘</span></div><small>可設 5–120 分鐘，服務長度仍依各項目計算。</small></label>
                </div>
                <p id="bookingAdminHoursPreview" class="booking-admin-hours-preview" role="status" aria-live="polite"></p>
              </section>

              <section class="booking-admin-settings-block booking-admin-settings-rule" aria-labelledby="bookingAdminAdvanceRuleHeading">
                <div class="booking-admin-settings-block-heading">
                  <div><span class="booking-admin-settings-eyebrow">預約限制</span><h4 id="bookingAdminAdvanceRuleHeading">提前預約</h4></div>
                </div>
                <label class="booking-admin-settings-field">
                  <span>需要提前幾天預約</span>
                  <div class="booking-admin-number-field"><input id="bookingAdminAdvanceDays" type="number" min="0" max="365" step="1" value="0" required><span aria-hidden="true">天</span></div>
                  <small>設定 0 天時，可預約今天尚未經過的開始時段。</small>
                </label>
                <label class="booking-admin-settings-field">
                  <span>最多可預約幾天內</span>
                  <div class="booking-admin-number-field"><input id="bookingAdminMaxAdvanceDays" type="number" min="0" max="365" step="1" value="0" required><span aria-hidden="true">天</span></div>
                  <small>例如 20 代表最遠可預約今天起 20 天內；設定 0 代表不限制最遠日期。</small>
                </label>
              </section>

              <section class="booking-admin-settings-block booking-admin-settings-rule" aria-labelledby="bookingAdminStoreServiceHeading">
                <div class="booking-admin-settings-block-heading">
                  <div><span class="booking-admin-settings-eyebrow">共同服務時間</span><h4 id="bookingAdminStoreServiceHeading">店內服務</h4></div>
                  <span class="booking-admin-settings-badge">每位預約套用</span>
                </div>
                <label class="booking-admin-settings-field">
                  <span>店內服務分鐘</span>
                  <div class="booking-admin-number-field"><input id="bookingAdminStoreServiceMinutes" type="number" min="1" max="720" step="1" value="10" required><span aria-hidden="true">分鐘</span></div>
                  <small>每位預約人的項目時間會再加上此分鐘數；只影響之後新增或修改的預約，既有預約保留原始快照。</small>
                </label>
              </section>

              <section class="booking-admin-settings-block booking-admin-settings-rule" aria-labelledby="bookingAdminSnapshotHeading">
                <div class="booking-admin-settings-block-heading"><h4 id="bookingAdminSnapshotHeading">快照模式</h4></div>
                <label class="booking-admin-toggle"><input id="bookingAdminSnapshotLocationRequired" type="checkbox"><span><strong>快照前必須取得定位</strong><small>啟用後，會員拍攝及送出快照前必須位於下方任一指定地點的範圍內；請先新增至少一個地點。一般預約與票券的獨立定位規則不受影響。</small></span></label><div id="bookingAdminSnapshotLocationControls" class="coupon-location-controls hidden"><div class="coupon-map-search"><label for="bookingAdminSnapshotAddressSearch">地址搜尋</label><div><input id="bookingAdminSnapshotAddressSearch" type="search" maxlength="240" autocomplete="street-address" placeholder="輸入地址或地標，例如：台南火車站"><button id="bookingAdminSnapshotAddressSearchButton" type="button" class="button button-outline">搜尋地址</button><button id="bookingAdminSnapshotUseCurrentLocationButton" type="button" class="button button-outline">使用目前 GPS 選點</button></div><div id="bookingAdminSnapshotAddressResults" class="coupon-map-results" aria-live="polite"></div></div><div id="bookingAdminSnapshotLocationMap" class="coupon-location-map" role="region" aria-label="使用地點地圖，點選可選擇候選位置"></div><p id="bookingAdminSnapshotMapStatus" class="field-help" aria-live="polite">先用地址搜尋、目前 GPS 或地圖點選位置；找不到精確地址時會自動顯示附近／近似候選，再確認地點與半徑範圍後新增。</p><section id="bookingAdminSnapshotLocationDraft" class="coupon-location-draft hidden" aria-label="待確認使用地點"><div class="coupon-location-draft-heading"><div><strong>待確認位置</strong><small>地圖圓圈即快照半徑範圍，可拖曳地圖標記微調位置。</small></div><span>尚未加入</span></div><div class="coupon-location-draft-fields"><label>地點名稱<input id="bookingAdminSnapshotLocationDraftName" type="text" maxlength="100" placeholder="例如：台南門市"></label><label>快照半徑（公尺）<input id="bookingAdminSnapshotLocationDraftRadius" type="number" min="50" max="2000" step="10" value="100"></label></div><div class="coupon-location-draft-actions"><button id="clearBookingAdminSnapshotLocationDraftButton" class="button button-outline" type="button">取消選點</button><button id="addBookingAdminSnapshotLocationButton" class="button button-dark" type="button">＋ 新增地點</button></div></section><div class="coupon-location-heading"><strong>允許快照地點</strong><span id="bookingAdminSnapshotLocationCount">0 / 20 個使用地點</span></div><div id="bookingAdminSnapshotLocationRows" class="coupon-location-rows"></div><p class="field-help">符合任一地點的快照半徑即可使用。座標只在背景保存供快照判斷，不在管理介面顯示。地圖與地址搜尋資料由 OpenStreetMap 提供。</p></div>
              </section>

              <section class="booking-admin-settings-block booking-admin-settings-rule" aria-labelledby="bookingAdminReminderHeading">
                <div class="booking-admin-settings-block-heading">
                  <div><span class="booking-admin-settings-eyebrow">營運通知</span><h4 id="bookingAdminReminderHeading">預約前一天提醒</h4></div>
                  <span class="booking-admin-settings-badge">台北時間</span>
                </div>
                <label class="booking-admin-toggle"><input id="bookingAdminReminderEnabled" type="checkbox"><span><strong>啟用前一天 LINE 提醒</strong><small>僅提醒已確認且仍有效的預約；測試會員不會收到 LINE 訊息。</small></span></label>
                <label class="booking-admin-settings-field"><span>前一天提醒時間</span><input id="bookingAdminReminderTime" type="time" step="60" value="18:00" required><small>依實際預約開始日期的前一天計算，包含跨夜營業時段。</small></label>
              </section>

              <section class="booking-admin-settings-block booking-admin-settings-notice" aria-labelledby="bookingAdminNoticeHeading">
                <div class="booking-admin-settings-block-heading">
                  <div><span class="booking-admin-settings-eyebrow">會員端內容</span><h4 id="bookingAdminNoticeHeading">預約說明</h4></div>
                  <span class="booking-admin-settings-badge">所有項目套用</span>
                </div>
                <label class="booking-admin-settings-field booking-admin-settings-notice-field">
                  <span>顯示給會員的預約說明（可換行）</span>
                  <textarea id="bookingAdminNotice" maxlength="2000" rows="5" placeholder="例如：\n請於預約時間前 10 分鐘抵達。\n如需取消或更改時間，請提前聯繫。"></textarea>
                  <small>最多 2,000 字；會員端會依原本換行顯示。</small>
                </label>
              </section>
            </div>
            <div id="bookingAdminSettingsMessage" class="form-message hidden" role="status" aria-live="polite"></div>
            <div class="booking-admin-settings-actions">
              <p><strong>儲存後立即套用</strong><span>這些設定會套用到所有預約項目，不需逐項調整。</span><span id="bookingAdminDraftStatus" class="booking-admin-settings-draft-status" role="status" aria-live="polite">設定載入中…</span></p>
              <div class="booking-admin-settings-action-buttons">
                <button id="bookingAdminDiscardSettingsButton" class="button button-outline" type="button" disabled>還原未儲存變更</button>
                <button id="bookingAdminSaveSettingsButton" class="button button-dark" type="submit">儲存預約與票券設定</button>
              </div>
            </div>
          </form>
        </section>

        <section id="bookingAdminQueuePanel" class="booking-admin-card booking-admin-operations-panel hidden" role="tabpanel" aria-labelledby="bookingAdminQueueSubtab">
          <div class="booking-admin-section-heading booking-admin-operations-heading">
            <div><p class="kicker">Booking operations</p><h3>預約處理</h3><p>一般預約與快照收據採不同審核流程，請先選擇要處理的工作類型。</p></div>
          </div>
          <nav class="booking-admin-queue-modes" role="tablist" aria-label="預約處理模式">
            <button id="bookingAdminStandardMode" class="booking-admin-queue-mode active" type="button" role="tab" aria-selected="true" aria-controls="bookingAdminStandardQueueView">
              <span><strong>一般預約</strong><small>確認、修改、完成服務</small></span><b id="bookingAdminStandardModeCount">0</b>
            </button>
            <button id="bookingAdminAccessibleMode" class="booking-admin-queue-mode" type="button" role="tab" aria-selected="false" aria-controls="accessibleAdminQueue">
              <span><strong>快照審核</strong><small>核對收據、服務、票券與點數</small></span><b id="bookingAdminAccessibleModeCount">0</b>
            </button>
          </nav>
          <section id="bookingAdminStandardQueueView" class="booking-admin-queue-view" role="tabpanel" aria-labelledby="bookingAdminStandardMode">
            <div class="booking-admin-queue-toolbar">
              <div><strong>一般預約</strong><small>依預約狀態篩選需要處理的會員預約。</small></div>
              <div class="booking-admin-filter" role="group" aria-label="一般預約狀態篩選">
                <button class="booking-admin-filter-button active" data-booking-filter="pending" type="button">待確認</button>
                <button class="booking-admin-filter-button" data-booking-filter="confirmed" type="button">已確認</button>
                <button class="booking-admin-filter-button" data-booking-filter="completed" type="button">已完成</button>
                <button class="booking-admin-filter-button" data-booking-filter="no_show" type="button">無故未到</button>
                <button class="booking-admin-filter-button" data-booking-filter="all" type="button">全部</button>
              </div>
            </div>
            <div id="bookingAdminQueue" class="booking-admin-queue"></div>
            <div id="bookingAdminQueueEmpty" class="empty-state compact hidden"><span aria-hidden="true">○</span><p>目前沒有符合條件的一般預約</p></div>
          </section>
        </section>
      </div>`;
    adminView.appendChild(panel);

    const modal = document.createElement('div');
    modal.id = 'bookingAdminCrudModal';
    modal.className = 'booking-admin-modal hidden';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = `<div class="booking-admin-modal-card"><div class="booking-admin-modal-heading"><div><p class="kicker">Booking editor</p><h2 id="bookingAdminCrudModalTitle">管理</h2></div><button id="bookingAdminCrudModalClose" class="booking-admin-modal-close" type="button" aria-label="關閉">×</button></div><div id="bookingAdminCrudModalBody"></div></div>`;
    document.body.appendChild(modal);

    cacheElements();
    bindEvents();
    setSubtab(state.subtab);
    window.addEventListener('focus', updateNoShowButtons);
    startBookingBadgeSync();
    openInitialBookingPanel();
  }

  function handleAdminSessionReady() {
    startBookingBadgeSync();
    openInitialBookingPanel();
  }

  function openInitialBookingPanel() {
    if (window.MemberAdminInitialPanel !== 'booking' || !window.MemberAdminSession?.isReady?.()) return false;
    window.MemberAdminInitialPanel = '';
    activateBookingPanel();
    return true;
  }

  function cacheElements() {
    [
      'bookingTab','bookingPanel','bookingAdminSyncStatus','bookingAdminSettingsForm','bookingAdminStartTime','bookingAdminEndTime','bookingAdminSlotInterval','bookingAdminHoursPreview','bookingAdminAdvanceDays','bookingAdminMaxAdvanceDays','bookingAdminStoreServiceMinutes','bookingAdminReminderEnabled','bookingAdminSnapshotLocationRequired','bookingAdminReminderTime','bookingAdminNotice','bookingAdminSettingsMessage','bookingAdminDraftStatus','bookingAdminDiscardSettingsButton','bookingAdminSaveSettingsButton',
      'bookingAdminNewTypeButton','bookingAdminTypeMessage','bookingAdminTypeList','bookingAdminTypeEmpty','bookingAdminServiceCount','bookingAdminPendingCount','bookingAdminAccessiblePendingCount','bookingAdminConfirmedCount',
      'bookingAdminTechniciansSubtab','bookingAdminServicesSubtab','bookingAdminSettingsSubtab','bookingAdminQueueSubtab','bookingAdminQueueSubtabCount','bookingAdminTechniciansPanel','bookingAdminServicesPanel','bookingAdminSettingsPanel','bookingAdminQueuePanel','bookingAdminStandardMode','bookingAdminAccessibleMode','bookingAdminStandardModeCount','bookingAdminAccessibleModeCount','bookingAdminStandardQueueView','bookingAdminNewServiceButton','bookingAdminBatchAddButton','bookingAdminBatchEditButton','bookingAdminBatchDeleteButton','bookingAdminServiceMessage','bookingAdminServiceList','bookingAdminServiceEmpty','bookingAdminQueue','bookingAdminQueueEmpty',
      'bookingAdminCrudModal','bookingAdminCrudModalTitle','bookingAdminCrudModalBody','bookingAdminCrudModalClose'
    ].forEach((id) => { els[id] = document.getElementById(id); });
  }

  function bindEvents() {
    els.bookingTab.addEventListener('click', activateBookingPanel);
    PRIMARY_TAB_IDS.forEach((id) => document.getElementById(id)?.addEventListener('click', deactivateBookingPanel));
    els.bookingAdminSettingsForm.addEventListener('submit', saveSettings);
    els.bookingAdminSettingsForm.addEventListener('input', (event) => { if (SETTINGS_INPUT_IDS.includes(event.target?.id)) updateSettingsDraft(); });
    els.bookingAdminSettingsForm.addEventListener('change', (event) => { if (SETTINGS_INPUT_IDS.includes(event.target?.id)) updateSettingsDraft(); });
    els.bookingAdminDiscardSettingsButton.addEventListener('click', () => {
      if (state.busy || !state.settingsDirty) return;
      renderSettings(true);
      showMessage(els.bookingAdminSettingsMessage, '已還原至目前伺服器設定；未儲存的更改已捨棄。', 'success');
    });
    const snapshotRows = document.getElementById('bookingAdminSnapshotLocationRows');
    if (snapshotRows) new MutationObserver(() => updateSettingsDraft()).observe(snapshotRows, { childList: true, subtree: true });
    window.TicketLocationEditors?.snapshot?.init();
    ['bookingAdminStartTime','bookingAdminEndTime','bookingAdminSlotInterval'].forEach((id) => els[id].addEventListener('input', renderHoursPreview));
    els.bookingAdminNewTypeButton.addEventListener('click', () => openTypeModal(null));
    els.bookingAdminTechniciansSubtab.addEventListener('click', () => setSubtab('technicians'));
    els.bookingAdminServicesSubtab.addEventListener('click', () => setSubtab('services'));
    els.bookingAdminSettingsSubtab.addEventListener('click', () => setSubtab('settings'));
    els.bookingAdminQueueSubtab.addEventListener('click', () => setSubtab('queue'));
    els.bookingAdminStandardMode.addEventListener('click', () => setQueueMode('standard'));
    els.bookingAdminAccessibleMode.addEventListener('click', () => setQueueMode('accessible'));
    els.bookingAdminNewServiceButton.addEventListener('click', () => openServiceModal(null));
    els.bookingAdminBatchAddButton.addEventListener('click', () => openBatchModal('create'));
    els.bookingAdminBatchEditButton.addEventListener('click', () => openBatchModal('update'));
    els.bookingAdminBatchDeleteButton.addEventListener('click', batchDelete);
    els.bookingAdminCrudModalClose.addEventListener('click', closeModal);
    els.bookingAdminCrudModal.addEventListener('click', (event) => { if (event.target === els.bookingAdminCrudModal && window.matchMedia('(max-width:768px)').matches) closeModal(); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeModal(); });
    document.querySelectorAll('[data-booking-filter]').forEach((button) => button.addEventListener('click', () => setFilter(button.dataset.bookingFilter || 'pending')));
    window.addEventListener('beforeunload', teardownRealtime);
    window.addEventListener('member-admin-session-ready', handleAdminSessionReady);
    window.addEventListener('member-admin:booking-snapshot-request', handleOperationalSnapshotRequest);
    window.addEventListener('member-admin:booking-focus', handleOperationalBookingFocus);
    window.addEventListener('admin:accessible-receipts-updated', handleAccessibleReceiptsUpdated);
  }

  function setQueueMode(mode) {
    state.queueMode = mode === 'accessible' ? 'accessible' : 'standard';
    const standard = state.queueMode === 'standard';
    els.bookingAdminStandardMode?.classList.toggle('active', standard);
    els.bookingAdminStandardMode?.setAttribute('aria-selected', String(standard));
    els.bookingAdminAccessibleMode?.classList.toggle('active', !standard);
    els.bookingAdminAccessibleMode?.setAttribute('aria-selected', String(!standard));
    els.bookingAdminStandardQueueView?.classList.toggle('hidden', !standard);
    const accessible = document.getElementById('accessibleAdminQueue');
    accessible?.classList.toggle('hidden', standard);
    els.bookingAdminQueuePanel?.setAttribute('data-queue-mode', state.queueMode);
    window.dispatchEvent(new CustomEvent('member-admin:booking-queue-mode-changed',{detail:{mode:state.queueMode}}));
  }

  function setSubtab(subtab) {
    const allowed = ['technicians', 'services', 'settings', 'queue'];
    state.subtab = allowed.includes(subtab) ? subtab : 'technicians';
    const tabs = {
      technicians: [els.bookingAdminTechniciansSubtab, els.bookingAdminTechniciansPanel],
      services: [els.bookingAdminServicesSubtab, els.bookingAdminServicesPanel],
      settings: [els.bookingAdminSettingsSubtab, els.bookingAdminSettingsPanel],
      queue: [els.bookingAdminQueueSubtab, els.bookingAdminQueuePanel],
    };
    Object.entries(tabs).forEach(([key, pair]) => {
      const [tab, panel] = pair;
      const active = key === state.subtab;
      tab?.classList.toggle('active', active);
      tab?.setAttribute('aria-selected', String(active));
      panel?.classList.toggle('hidden', !active);
    });
    if (state.subtab === 'queue') setQueueMode(state.queueMode);
  }

  function activateBookingPanel() {
    PRIMARY_TAB_IDS.forEach((id) => document.getElementById(id)?.setAttribute('aria-selected', 'false'));
    PRIMARY_PANEL_IDS.forEach((id) => document.getElementById(id)?.classList.add('hidden'));
    els.bookingTab.setAttribute('aria-selected', 'true');
    els.bookingPanel.classList.remove('hidden');
    setSubtab(state.subtab);
    if (!state.loading) refreshAll(false, true);
  }

  function deactivateBookingPanel() {
    els.bookingTab.setAttribute('aria-selected', 'false');
    els.bookingPanel.classList.add('hidden');
  }

  async function context() {
    if (!window.MemberAdminSession || typeof window.MemberAdminSession.wait !== 'function') {
      throw clientError('AUTH_REQUIRED', '管理端登入服務尚未準備完成。');
    }
    const session = await window.MemberAdminSession.wait();
    state.config = session.config;
    return { config: session.config, idToken: session.idToken };
  }

  function renderBookingPendingBadge(unreadCount, pendingCount, accessiblePendingCount = state.accessiblePendingCount) {
    const unread = Math.max(0, Number(unreadCount || 0));
    const pending = Math.max(0, Number(pendingCount || 0));
    const accessiblePending = Math.max(0, Number(accessiblePendingCount || 0));
    const totalActionable = pending + accessiblePending;
    state.unreadCount = unread;
    state.pendingCount = pending;
    state.accessiblePendingCount = accessiblePending;
    els.bookingAdminPendingCount.textContent = String(pending);
    if (els.bookingAdminAccessiblePendingCount) els.bookingAdminAccessiblePendingCount.textContent = String(accessiblePending);
    if (els.bookingAdminStandardModeCount) els.bookingAdminStandardModeCount.textContent = String(pending);
    if (els.bookingAdminAccessibleModeCount) els.bookingAdminAccessibleModeCount.textContent = String(accessiblePending);
    els.bookingAdminQueueSubtabCount.textContent = totalActionable ? `（${totalActionable}）` : '';
    els.bookingTab.dataset.unreadCount = String(unread);
    els.bookingTab.dataset.pendingCount = String(pending);
    els.bookingTab.dataset.accessiblePendingCount = String(accessiblePending);
    els.bookingTab.dataset.badgeCount = String(totalActionable);
    const badge = els.bookingTab.querySelector('.booking-nav-count');
    if (badge) {
      badge.textContent = String(totalActionable);
      badge.hidden = totalActionable === 0;
    }
    const labels = [];
    if (unread) labels.push(`${unread} 筆未讀更新`);
    if (pending) labels.push(`${pending} 筆一般預約待確認`);
    if (accessiblePending) labels.push(`${accessiblePending} 筆快照預約待審核`);
    els.bookingTab.setAttribute('aria-label', labels.length ? `預約，${labels.join('，')}` : '預約');
    els.bookingTab.title = labels.join('；');
  }

  function handleAccessibleReceiptsUpdated(event) {
    const submissions = Array.isArray(event?.detail?.submissions) ? event.detail.submissions : [];
    renderBookingPendingBadge(state.unreadCount, state.pendingCount, submissions.length);
  }

  async function refreshBookingBadge() {
    if (isBackgroundE2ERunner()) return false;
    if (state.badgeLoading) {
      state.badgeQueued = true;
      return false;
    }
    state.badgeLoading = true;
    try {
      const summary = await bookingRequest('admin.booking.summary');
      state.latestNotificationId = Math.max(0, Number(summary?.latestNotificationId || 0));
      renderBookingPendingBadge(
        Number(summary?.unreadCount || 0),
        Number(summary?.pendingCount || 0),
        Number(summary?.accessibleReceiptPendingCount || 0),
      );
      return true;
    } catch (error) {
      console.warn('booking nav badge refresh failed', error);
      return false;
    } finally {
      state.badgeLoading = false;
      if (state.badgeQueued) {
        state.badgeQueued = false;
        window.setTimeout(() => { refreshBookingBadge(); }, 0);
      }
    }
  }

  async function markBookingNotificationsRead() {
    if (isBackgroundE2ERunner()) return false;
    try {
      const result = await bookingRequest('admin.booking.notifications.read', {
        throughNotificationId: state.latestNotificationId || null,
      }, true);
      state.latestNotificationId = Math.max(
        state.latestNotificationId,
        Number(result?.latestNotificationId || 0),
      );
      const pending = Array.isArray(state.booking?.bookings)
        ? state.booking.bookings.filter((booking) => booking.status === 'pending').length
        : state.pendingCount;
      renderBookingPendingBadge(Number(result?.unreadCount || 0), pending, state.accessiblePendingCount);
      return true;
    } catch (error) {
      console.warn('booking notification cursor update failed', error);
      return false;
    }
  }

  function startBookingBadgeSync() {
    if (isBackgroundE2ERunner()) return Promise.resolve(false);
    if (state.badgeStartPromise) return state.badgeStartPromise;
    state.badgeStartPromise = (async () => {
      try {
        await context();
        setupRealtime();
        return await refreshBookingBadge();
      } catch (error) {
        console.warn('booking nav badge sync unavailable', error);
        return false;
      } finally {
        state.badgeStartPromise = null;
      }
    })();
    return state.badgeStartPromise;
  }

  async function requestFunction(name, action, payload = {}, write = false) {
    const { config, idToken } = await context();
    const endpoint = `${String(config.supabaseUrl || '').replace(/\/$/, '')}/functions/v1/${name}`;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), write ? 30000 : 15000);
    try {
      const response = await fetch(endpoint, {
        method: 'POST', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', apikey: String(config.supabasePublishableKey || '') },
        body: JSON.stringify({ ...payload, action, clientType: 'admin', idToken }),
      });
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch { throw clientError(write ? 'API_RESPONSE_UNCERTAIN' : 'API_RESPONSE_ERROR', '預約服務回傳格式不正確。'); }
      if (!response.ok || data?.ok !== true) throw clientError(String(data?.error?.code || 'API_ERROR'), String(data?.error?.message || '預約服務拒絕此操作。'));
      return data.data || {};
    } catch (error) {
      if (error?.code) throw error;
      throw clientError(write ? 'API_RESPONSE_UNCERTAIN' : 'NETWORK_ERROR', write ? '無法確認操作是否已送達；請先更新資料確認。' : '目前無法連線預約服務。');
    } finally { window.clearTimeout(timer); }
  }

  const bookingRequest = (action, payload = {}, write = false) => requestFunction('booking-api', action, payload, write);
  const manageRequest = (action, payload = {}, write = false) => requestFunction('booking-admin-api', action, payload, write);
  const operationsRequest = (action, payload = {}, write = false) => requestFunction('booking-admin-operations', action, payload, write);
  const contactRequest = (action, payload = {}) => requestFunction('booking-contact-api', action, payload, false);
  const groupDetailsRequest = (action, payload = {}) => requestFunction('booking-group-details-api', action, payload, false);
  const resourceRequest = (action, payload = {}) => requestFunction('booking-group-api', action, payload, false);
  function clientError(code, message) { const error = new Error(message); error.code = code; return error; }

  function isBackgroundE2ERunner() {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get('e2eBackgroundRunner') === '1' && Boolean(params.get('e2eRunId'));
    } catch {
      return false;
    }
  }

  async function refreshAll(showSuccess, markNotificationsRead = false) {
    if (state.loading) {
      state.refreshQueued = true;
      state.refreshQueuedShowSuccess = state.refreshQueuedShowSuccess || Boolean(showSuccess);
      return false;
    }
    state.loading = true;
    setSyncStatus('同步預約資料中…');
    try {
      const [booking, catalog, resources] = await Promise.all([
        bookingRequest('admin.booking.bootstrap',{bookingId:new URLSearchParams(window.location.search).get('bookingId') || ''}),
        manageRequest('admin.booking.manage.bootstrap'),
        resourceRequest('admin.booking.resources.bootstrap'),
      ]);
      const rawBookings = Array.isArray(booking.bookings) ? booking.bookings : [];
      const bookingIds = rawBookings.map((item) => String(item.bookingId || '')).filter(Boolean);
      const [contactData, groupData] = bookingIds.length
        ? await Promise.all([
            contactRequest('admin.booking.contacts', { bookingIds }),
            groupDetailsRequest('admin.booking.group.details', { bookingIds }),
          ])
        : [{ contacts: [] }, { bookingGroups: {} }];
      const contacts = Array.isArray(contactData.contacts) ? contactData.contacts : [];
      const contactsById = new Map(contacts.map((item) => [String(item.bookingId || ''), item]));
      const bookings = rawBookings.map((item) => ({
        ...item,
        ...(contactsById.get(String(item.bookingId || '')) || {}),
      }));
      const nextBooking = {
        noShowRisk: booking.noShowRisk,
        settings: { ...(booking.settings || {}), ...(catalog.settings || {}), ...(resources.settings || {}) },
        bookings,
        groups: groupData?.bookingGroups && typeof groupData.bookingGroups === 'object' ? groupData.bookingGroups : {},
        technicians: Array.isArray(resources.technicians) ? resources.technicians : [],
        primaryTechnicianId: String(resources.settings?.primaryTechnicianId || groupData?.primaryTechnicianId || ''),
      };
      const nextCatalog = {
        serviceTypes: Array.isArray(catalog.serviceTypes) ? catalog.serviceTypes : [],
        services: Array.isArray(catalog.services) ? catalog.services : [],
        pointCards: Array.isArray(catalog.pointCards) ? catalog.pointCards : [],
      };
      const nextSelected = new Set([...state.selected].filter((id) => nextCatalog.services.some((service) => service.serviceId === id)));
      const settingsChanged = JSON.stringify(state.booking.settings || {}) !== JSON.stringify(nextBooking.settings || {});
      const bookingDataChanged = JSON.stringify({
        bookings: state.booking.bookings || [],
        groups: state.booking.groups || {},
        technicians: state.booking.technicians || [],
        primaryTechnicianId: state.booking.primaryTechnicianId || '',
      }) !== JSON.stringify({
        bookings: nextBooking.bookings,
        groups: nextBooking.groups,
        technicians: nextBooking.technicians,
        primaryTechnicianId: nextBooking.primaryTechnicianId,
      });
      const catalogChanged = JSON.stringify(state.catalog || {}) !== JSON.stringify(nextCatalog);
      const selectionChanged = [...state.selected].sort().join('|') !== [...nextSelected].sort().join('|');

      state.booking = nextBooking;
      window.BookingRiskSettings?.mount(els.bookingAdminSettingsPanel,{data:state.booking.noShowRisk,request:(action,body)=>bookingRequest('admin.booking.risk.'+action,body,action!=='get')});
      state.catalog = nextCatalog;
      state.selected = nextSelected;
      if (catalogChanged) {
        window.dispatchEvent(new CustomEvent('member-admin:booking-services-updated', {
          detail: { services: nextCatalog.services },
        }));
      }

      // Keep stable DOM for sections whose server data did not change. Replacing
      // every list on each realtime event caused visible jumps and also reset
      // in-progress settings inputs while a booking update was syncing.
      if (settingsChanged) renderSettings();
      if (catalogChanged) renderTypes();
      if (catalogChanged || selectionChanged) renderServices();
      if (bookingDataChanged || catalogChanged) renderStats();
      if (bookingDataChanged) {
        renderBookings();
        publishOperationalBookingSnapshot();
      }
      updateNoShowButtons();
      setupRealtime();
      if (markNotificationsRead && !els.bookingPanel?.classList.contains('hidden')) {
        await markBookingNotificationsRead();
      }
      setSyncStatus(showSuccess ? '預約資料已更新' : `已同步 · ${new Date().toLocaleTimeString('zh-Hant-TW', { hour: '2-digit', minute: '2-digit' })}`);
    } catch (error) {
      setSyncStatus(error?.message || '預約資料同步失敗', true);
      showMessage(els.bookingAdminServiceMessage, error?.message || '預約資料同步失敗', 'error');
    } finally {
      state.loading = false;
      if (state.refreshQueued) {
        const queuedShowSuccess = state.refreshQueuedShowSuccess;
        state.refreshQueued = false;
        state.refreshQueuedShowSuccess = false;
        window.setTimeout(() => { refreshAll(queuedShowSuccess); }, 0);
      }
    }
    return true;
  }
  function publishOperationalBookingSnapshot() {
    const bookings = (state.booking.bookings || []).map((booking) => ({
      bookingId: String(booking.bookingId || ''),
      bookingDate: String(booking.bookingDate || ''),
      startTime: String(booking.startTime || '').slice(0, 5),
      endTime: String(booking.endTime || '').slice(0, 5),
      status: String(booking.status || ''),
      memberDisplayName: String(booking.memberDisplayName || ''),
      memberCode: String(booking.memberCode || ''),
      technicianName: String(booking.technicianName || ''),
      partySize: Math.max(1, Number(booking.partySize || 1)),
      cancellationRequestedAt: booking.cancellationRequestedAt || null,
    })).filter((booking) => booking.bookingId && booking.bookingDate);
    window.dispatchEvent(new CustomEvent('member-admin:booking-snapshot', { detail: { bookings } }));
  }

  function handleOperationalSnapshotRequest() {
    if (state.booking.bookings.length) publishOperationalBookingSnapshot();
    if (state.loading) {
      state.refreshQueued = true;
      return;
    }
    refreshAll(false);
  }

  function handleOperationalBookingFocus(event) {
    const bookingId = String(event?.detail?.bookingId || '');
    if (!bookingId) return;
    setSubtab('queue');
    setFilter('all');
    window.requestAnimationFrame(() => {
      const card = Array.from(els.bookingAdminQueue.querySelectorAll('[data-booking-id]'))
        .find((item) => String(item.dataset.bookingId || '') === bookingId);
      if (!card) return;
      els.bookingAdminQueue.querySelectorAll('.is-calendar-target').forEach((item) => item.classList.remove('is-calendar-target'));
      card.classList.add('is-calendar-target');
      card.tabIndex = -1;
      try { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {}
      try { card.focus({ preventScroll: true }); } catch (_) { card.focus(); }
      window.setTimeout(() => card.classList.remove('is-calendar-target'), 3600);
    });
  }

  function renderAll() { renderSettings(); renderTypes(); renderServices(); renderStats(); renderBookings(); }
  function currentSettingsSignature() {
    return JSON.stringify({
      fields: SETTINGS_INPUT_IDS.map((id) => {
        const input = els[id];
        return input?.type === 'checkbox' ? Boolean(input.checked) : String(input?.value || '');
      }),
      locations: window.TicketLocationEditors?.snapshot?.get?.() || [],
    });
  }
  function updateSettingsDraft() {
    if (state.settingsBaseline === null || !els.bookingAdminDraftStatus) return;
    state.settingsDirty = currentSettingsSignature() !== state.settingsBaseline;
    els.bookingAdminDiscardSettingsButton.disabled = state.busy || !state.settingsDirty;
    if (!state.busy) {
      const serverVersion = String(state.booking.settings?.updatedAt || '');
      els.bookingAdminDraftStatus.textContent = state.settingsDirty
        ? (serverVersion !== state.settingsDraftVersion
          ? '伺服器已有新版設定；本頁草稿已保留。請先記下變更並重新載入，避免覆寫他人修改。'
          : '有未儲存的變更，離開前請儲存或還原。')
        : '目前設定已載入，尚未修改。';
    }
  }
  function renderSettings(force = false) {
    const settings = state.booking.settings || {};
    window.BookingRiskSettings?.mount(els.bookingAdminSettingsPanel,{data:state.booking.noShowRisk,request:(action,body)=>bookingRequest('admin.booking.risk.'+action,body,action!=='get')});
    if (state.settingsDirty && !force) {
      updateSettingsDraft();
      return;
    }
    els.bookingAdminStartTime.value = String(settings.workStartTime || '09:00');
    els.bookingAdminEndTime.value = String(settings.workEndTime || '17:00');
    els.bookingAdminSlotInterval.value = String(Number(settings.slotIntervalMinutes || 30));
    els.bookingAdminAdvanceDays.value = String(Number(settings.minAdvanceDays || 0));
    els.bookingAdminMaxAdvanceDays.value = String(Number(settings.maxAdvanceDays || 0));
    els.bookingAdminStoreServiceMinutes.value = String(Number(settings.storeServiceMinutes || 10));
    els.bookingAdminNotice.value = String(settings.bookingNotice || '');
    els.bookingAdminReminderEnabled.checked = settings.reminderEnabled === true;
    els.bookingAdminSnapshotLocationRequired.checked = settings.snapshotLocationRequired === true;
    window.TicketLocationEditors?.snapshot?.set(Array.isArray(settings.snapshotLocations) ? settings.snapshotLocations : []);
    els.bookingAdminReminderTime.value = String(settings.reminderTime || '18:00');
    renderHoursPreview();
    state.settingsBaseline = currentSettingsSignature();
    state.settingsDraftVersion = String(settings.updatedAt || '');
    state.settingsDirty = false;
    updateSettingsDraft();
  }
  function renderHoursPreview() {
    const start = els.bookingAdminStartTime.value;
    const end = els.bookingAdminEndTime.value;
    const step = Number(els.bookingAdminSlotInterval.value);
    const valid = /^\d{2}:\d{2}$/.test(start) && /^\d{2}:\d{2}$/.test(end) && start !== end
      && [start, end].every((time) => Number(time.slice(0, 2)) < 24 && Number(time.slice(3)) < 60 && Number(time.slice(3)) % 5 === 0)
      && Number.isInteger(step) && step >= 5 && step <= 120 && step % 5 === 0;
    if (!valid) { els.bookingAdminHoursPreview.textContent = '請輸入不同的開始／結束時間，以及 5–120 分鐘的切分間隔。'; return; }
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const next = new Date(`${today}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const overnight = end < start;
    const opening = Number(start.slice(0, 2)) * 60 + Number(start.slice(3));
    const closing = Number(end.slice(0, 2)) * 60 + Number(end.slice(3)) + (overnight ? 1440 : 0);
    const first = Array.from({ length: Math.min(4, Math.ceil((closing - opening) / step)) }, (_, index) => {
      const minute = (opening + index * step) % 1440;
      return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
    });
    els.bookingAdminHoursPreview.textContent = `${today} 營業班次：${today} ${start} → ${overnight ? next.toISOString().slice(0, 10) : today} ${end}。切分起點：${first.join('、')}${closing - opening > step * 4 ? '…' : ''}`;
  }
  function renderStats() {
    const bookings = state.booking.bookings || [];
    const pending = bookings.filter((booking) => booking.status === 'pending').length;
    els.bookingAdminServiceCount.textContent = String(state.catalog.services.length);
    renderBookingPendingBadge(state.unreadCount, pending, state.accessiblePendingCount);
    els.bookingAdminConfirmedCount.textContent = String(bookings.filter((booking) => booking.status === 'confirmed').length);
  }

  function renderTypes() {
    const rows = state.catalog.serviceTypes || [];
    els.bookingAdminTypeList.replaceChildren();
    els.bookingAdminTypeEmpty.classList.toggle('hidden', rows.length > 0);
    rows.forEach((type) => {
      const row = document.createElement('div');
      row.className = 'booking-admin-service-row';
      row.style.cursor = 'default';
      const content = document.createElement('span');
      const title = document.createElement('strong'); title.textContent = type.name;
      const small = document.createElement('small'); small.textContent = type.rewardMinutesPerPoint && type.rewardPointCardId ? `完成服務每 ${type.rewardMinutesPerPoint} 分鐘 → ${type.rewardPointCardTitle || '指定集點卡'} +1 點` : '未設定完成服務自動集點';
      content.append(title, small);
      const actions = document.createElement('span'); actions.className = 'booking-admin-actions'; actions.style.margin = '0';
      actions.append(actionButton('修改', 'button button-outline', () => openTypeModal(type)), actionButton('刪除', 'button button-danger', () => deleteType(type)));
      row.append(content, actions); els.bookingAdminTypeList.appendChild(row);
    });
  }

  function renderServices() {
    const rows = state.catalog.services || [];
    els.bookingAdminServiceList.replaceChildren();
    els.bookingAdminServiceEmpty.classList.toggle('hidden', rows.length > 0);
    rows.forEach((service) => {
      const row = document.createElement('div');
      row.className = `booking-admin-service-row${service.isActive ? '' : ' inactive'}`;
      row.style.cursor = 'default';
      const left = document.createElement('span');
      left.style.gridTemplateColumns = 'auto 1fr'; left.style.alignItems = 'start'; left.style.columnGap = '10px';
      const check = document.createElement('input');
      check.type = 'checkbox'; check.checked = state.selected.has(service.serviceId); check.setAttribute('aria-label', `選取 ${service.title}`);
      check.style.width = '18px'; check.style.height = '18px'; check.style.marginTop = '2px';
      check.addEventListener('change', () => { check.checked ? state.selected.add(service.serviceId) : state.selected.delete(service.serviceId); updateBatchButtons(); });
      const text = document.createElement('span');
      const title = document.createElement('strong'); title.textContent = service.title;
      const meta = document.createElement('small'); meta.textContent = `類型 ${service.serviceType || '未設定'} · ${service.durationMinutes} 分鐘 · ${formatMoney(service.priceAmount)} · ${service.requiresCompanionService ? '加購／需搭配一般項目 · ' : ''}${service.isActive ? '開放' : '停用'}`;
      text.append(title, meta); left.append(check, text);
      const actions = document.createElement('span'); actions.className = 'booking-admin-actions'; actions.style.margin = '0';
      actions.append(actionButton('修改', 'button button-outline', () => openServiceModal(service)), actionButton('刪除', 'button button-danger', () => deleteService(service)));
      row.append(left, actions); els.bookingAdminServiceList.appendChild(row);
    });
    updateBatchButtons();
  }

  function updateBatchButtons() {
    const count = state.selected.size;
    els.bookingAdminBatchEditButton.disabled = count === 0;
    els.bookingAdminBatchDeleteButton.disabled = count === 0;
    els.bookingAdminBatchEditButton.textContent = count ? `批次修改（${count}）` : '批次修改';
    els.bookingAdminBatchDeleteButton.textContent = count ? `批次刪除（${count}）` : '批次刪除';
  }

  async function saveSettings(event) {
    event.preventDefault();
    if (state.busy) return;
    const minAdvanceDays = Number(els.bookingAdminAdvanceDays.value);
    const maxAdvanceDays = Number(els.bookingAdminMaxAdvanceDays.value);
    const storeServiceMinutes = Number(els.bookingAdminStoreServiceMinutes.value);
    const slotIntervalMinutes = Number(els.bookingAdminSlotInterval.value);
    const workStartTime = els.bookingAdminStartTime.value;
    const workEndTime = els.bookingAdminEndTime.value;
    const bookingNotice = String(els.bookingAdminNotice.value || '').replace(/\r\n?/g, '\n');
    if (!Number.isInteger(minAdvanceDays) || minAdvanceDays < 0 || minAdvanceDays > 365) return showMessage(els.bookingAdminSettingsMessage, '提前預約天數必須介於 0–365 天。', 'error');
    if (!Number.isInteger(maxAdvanceDays) || maxAdvanceDays < 0 || maxAdvanceDays > 365) return showMessage(els.bookingAdminSettingsMessage, '最遠可預約天數必須介於 0–365 天；0 代表不限制。', 'error');
    if (maxAdvanceDays > 0 && maxAdvanceDays < minAdvanceDays) return showMessage(els.bookingAdminSettingsMessage, '最遠可預約天數不可小於需要提前的天數。', 'error');
    if (!Number.isInteger(storeServiceMinutes) || storeServiceMinutes < 1 || storeServiceMinutes > 720) return showMessage(els.bookingAdminSettingsMessage, '店內服務分鐘必須介於 1–720 分鐘。', 'error');
    if (!/^\d{2}:\d{2}$/.test(workStartTime) || !/^\d{2}:\d{2}$/.test(workEndTime) || workStartTime === workEndTime || [workStartTime, workEndTime].some((time) => Number(time.slice(0, 2)) > 23 || Number(time.slice(3)) > 59 || Number(time.slice(3)) % 5 !== 0)) return showMessage(els.bookingAdminSettingsMessage, '工作時間格式錯誤或時段長度為零。', 'error');
    if (!Number.isInteger(slotIntervalMinutes) || slotIntervalMinutes < 5 || slotIntervalMinutes > 120 || slotIntervalMinutes % 5 !== 0) return showMessage(els.bookingAdminSettingsMessage, '切分間隔須為 5–120 分鐘的 5 分鐘倍數。', 'error');
    if (bookingNotice.length > 2000) return showMessage(els.bookingAdminSettingsMessage, '預約說明不可超過 2,000 字。', 'error');
    const reminderTime = els.bookingAdminReminderTime.value;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(reminderTime)) return showMessage(els.bookingAdminSettingsMessage, '請設定有效的前一天提醒時間。', 'error');
    const snapshotLocations = window.TicketLocationEditors?.snapshot?.get() || [];
    if (els.bookingAdminSnapshotLocationRequired.checked && !snapshotLocations.length) return showMessage(els.bookingAdminSettingsMessage, '請先新增至少一個快照允許地點，才能啟用定位限制。', 'error');
    state.busy = true; clearMessage(els.bookingAdminSettingsMessage);
    const previousDisabled = new Map([...els.bookingAdminSettingsForm.querySelectorAll('input,select,textarea,button')].map((control) => [control, control.disabled]));
    for (const control of previousDisabled.keys()) control.disabled = true;
    els.bookingAdminSettingsForm.setAttribute('aria-busy', 'true');
    els.bookingAdminSaveSettingsButton.disabled = true;
    els.bookingAdminSaveSettingsButton.textContent = '儲存中…';
    els.bookingAdminDiscardSettingsButton.disabled = true;
    els.bookingAdminDraftStatus.textContent = '正在儲存，請勿重複送出。';
    try {
      const result = await manageRequest('admin.booking.settings.save', {
        workStartTime: els.bookingAdminStartTime.value,
        workEndTime: els.bookingAdminEndTime.value,
        slotIntervalMinutes,
        minAdvanceDays,
        maxAdvanceDays,
        storeServiceMinutes,
        bookingNotice,
        reminderEnabled: els.bookingAdminReminderEnabled.checked,
        snapshotLocationRequired: els.bookingAdminSnapshotLocationRequired.checked,
        snapshotLocations,
        reminderTime,
        expectedUpdatedAt: state.settingsDraftVersion,
      }, true);
      if (!result.settings || !result.settings.updatedAt) throw clientError('API_RESPONSE_UNCERTAIN', '儲存回應缺少可確認的版本；請重新載入核對後再操作。');
      state.booking.settings = result.settings;
      renderSettings(true);
      showMessage(els.bookingAdminSettingsMessage, '預約與票券共用設定已儲存。', 'success');
    } catch (error) {
      const conflict = /CONFLICT|STALE_VERSION|VERSION_MISMATCH/i.test(String(error?.code || ''));
      const uncertain = error?.code === 'API_RESPONSE_UNCERTAIN';
      showMessage(els.bookingAdminSettingsMessage, conflict
        ? '設定版本已變更，未儲存草稿仍保留。請先記下變更，再重新載入比較，勿直接覆寫。'
        : uncertain ? '無法確認這次是否已儲存；目前輸入仍保留。請重新載入核對結果，避免重複送出。'
          : error?.message || '儲存失敗；目前輸入仍保留。', 'error');
    } finally {
      state.busy = false;
      for (const [control, disabled] of previousDisabled) control.disabled = disabled;
      els.bookingAdminSettingsForm.removeAttribute('aria-busy');
      els.bookingAdminSaveSettingsButton.disabled = false;
      els.bookingAdminSaveSettingsButton.textContent = '儲存預約與票券設定';
      updateSettingsDraft();
    }
  }

  function openTypeModal(type) {
    els.bookingAdminCrudModalTitle.textContent = type ? '修改項目類型' : '新增項目類型';
    const cards = state.catalog.pointCards || [];
    const cardOptions = ['<option value="">請選擇集點卡</option>', ...cards.map((card) => `<option value="${escapeAttr(card.id)}">${escapeHtml(card.title || card.cardId || '集點卡')}</option>`)].join('');
    els.bookingAdminCrudModalBody.innerHTML = `<form class="booking-admin-form">
      <label>項目類型名稱<input data-type-name maxlength="80" required></label>
      <label class="booking-admin-toggle"><input data-type-reward-enabled type="checkbox"><span><strong>完成服務自動集點</strong><small>管理員確認服務完成後，依此類型實際服務分鐘自動加點；店內服務時間不計入。</small></span></label>
      <div data-type-reward-fields style="display:grid;gap:12px">
        <label>每多少服務分鐘獲得 1 點<input data-type-reward-minutes type="number" min="1" max="10080" step="1" placeholder="例如：60"></label>
        <label>加到哪張集點卡<select data-type-reward-card>${cardOptions}</select></label>
        <small>同一筆完成服務會以此類型的服務分鐘計算：可獲得點數 = 服務分鐘 ÷ 設定分鐘數（無條件捨去）。</small>
      </div>
      <div data-modal-message class="form-message hidden"></div>
      <div class="booking-admin-modal-actions"><button data-cancel class="button button-outline" type="button">取消</button><button class="button button-dark" type="submit">${type ? '儲存修改' : '新增類型'}</button></div>
    </form>`;
    const form = els.bookingAdminCrudModalBody.querySelector('form');
    const input = form.querySelector('[data-type-name]');
    const enabled = form.querySelector('[data-type-reward-enabled]');
    const rewardFields = form.querySelector('[data-type-reward-fields]');
    const minutesInput = form.querySelector('[data-type-reward-minutes]');
    const cardSelect = form.querySelector('[data-type-reward-card]');
    input.value = type?.name || '';
    minutesInput.value = type?.rewardMinutesPerPoint ? String(type.rewardMinutesPerPoint) : '';
    cardSelect.value = type?.rewardPointCardId || '';
    enabled.checked = Boolean(type?.rewardMinutesPerPoint && type?.rewardPointCardId);

    const syncRewardFields = () => {
      rewardFields.classList.toggle('hidden', !enabled.checked);
      minutesInput.disabled = !enabled.checked;
      cardSelect.disabled = !enabled.checked;
    };
    enabled.addEventListener('change', () => {
      if (enabled.checked && !cards.length) {
        enabled.checked = false;
        syncRewardFields();
        return showMessage(form.querySelector('[data-modal-message]'), '目前沒有可使用的集點卡，請先建立並啟用集點卡。', 'error');
      }
      clearMessage(form.querySelector('[data-modal-message]'));
      syncRewardFields();
    });
    syncRewardFields();

    form.querySelector('[data-cancel]').addEventListener('click', closeModal);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = input.value.trim();
      if (!name) return;
      let rewardMinutesPerPoint = null;
      let rewardPointCardId = null;
      if (enabled.checked) {
        rewardMinutesPerPoint = Number(minutesInput.value);
        rewardPointCardId = cardSelect.value;
        if (!Number.isInteger(rewardMinutesPerPoint) || rewardMinutesPerPoint < 1 || rewardMinutesPerPoint > 10080) {
          return showMessage(form.querySelector('[data-modal-message]'), '自動集點分鐘必須介於 1–10,080 分鐘。', 'error');
        }
        if (!rewardPointCardId) {
          return showMessage(form.querySelector('[data-modal-message]'), '請選擇要自動加點的集點卡。', 'error');
        }
      }
      const payload = { name, rewardMinutesPerPoint, rewardPointCardId };
      if (type) payload.typeId = type.id;
      await runModalAction(async () => manageRequest(type ? 'admin.booking.type.update' : 'admin.booking.type.create', payload, true));
    });
    showModal(); input.focus();
  }

  async function deleteType(type) {
    if (!window.confirm(`確定刪除項目類型「${type.name}」？\n若仍有預約項目使用，系統會拒絕刪除。`)) return;
    await runPageAction(els.bookingAdminTypeMessage, async () => manageRequest('admin.booking.type.delete', { typeId: type.id }, true));
  }

  function serviceFormHtml(service = {}) {
    const options = ['<option value="">請選擇項目類型</option>', ...(state.catalog.serviceTypes || []).map((type) => `<option value="${escapeAttr(type.name)}">${escapeHtml(type.name)}</option>`)].join('');
    return `<label>預約項目名稱<input data-field="title" maxlength="100" required value="${escapeAttr(service.title || '')}"></label><label>項目類型<select data-field="serviceType" required>${options}</select></label><label>服務時間（分鐘）<input data-field="durationMinutes" type="number" min="1" max="720" step="1" required value="${Number(service.durationMinutes || 30)}"></label><label>價格（NT$）<input data-field="priceAmount" type="number" min="0" max="10000000" step="1" required value="${Number(service.priceAmount || 0)}"></label><label class="booking-admin-toggle"><input data-field="requiresCompanionService" type="checkbox" ${service.requiresCompanionService ? 'checked' : ''}><span><strong>加購項目，需搭配其他項目</strong><small>開啟後不能單獨預約；同一位預約人至少還要選擇一個一般項目。</small></span></label><label class="booking-admin-toggle"><input data-field="isActive" type="checkbox" ${service.isActive === false ? '' : 'checked'}><span><strong>開放會員預約</strong><small>關閉後會員端不再顯示，既有預約紀錄仍保留。</small></span></label>`;
  }

  function openServiceModal(service) {
    if (!state.catalog.serviceTypes.length) return window.alert('請先新增至少一個項目類型。');
    els.bookingAdminCrudModalTitle.textContent = service ? '修改預約項目' : '新增預約項目';
    els.bookingAdminCrudModalBody.innerHTML = `<form class="booking-admin-form">${serviceFormHtml(service || {})}<div data-modal-message class="form-message hidden"></div><div class="booking-admin-modal-actions"><button data-cancel class="button button-outline" type="button">取消</button><button class="button button-dark" type="submit">儲存預約項目</button></div></form>`;
    const form = els.bookingAdminCrudModalBody.querySelector('form');
    form.querySelector('[data-field="serviceType"]').value = service?.serviceType || '';
    form.querySelector('[data-cancel]').addEventListener('click', closeModal);
    form.addEventListener('submit', async (event) => {
      event.preventDefault(); const payload = readServiceForm(form);
      if (service) { payload.serviceId = service.serviceId; payload.expectedUpdatedAt = service.updatedAt || ''; }
      await runModalAction(async () => manageRequest('admin.booking.service.save', payload, true));
    });
    showModal();
  }

  function readServiceForm(form) {
    return {
      title: form.querySelector('[data-field="title"]').value.trim(),
      serviceType: form.querySelector('[data-field="serviceType"]').value,
      durationMinutes: Number(form.querySelector('[data-field="durationMinutes"]').value),
      priceAmount: Number(form.querySelector('[data-field="priceAmount"]').value),
      requiresCompanionService: form.querySelector('[data-field="requiresCompanionService"]').checked,
      isActive: form.querySelector('[data-field="isActive"]').checked,
    };
  }

  async function deleteService(service) {
    if (!window.confirm(`確定刪除預約項目「${service.title}」？\n既有預約紀錄會保留。`)) return;
    await runPageAction(els.bookingAdminServiceMessage, async () => manageRequest('admin.booking.service.delete', { serviceId: service.serviceId, expectedUpdatedAt: service.updatedAt || '' }, true));
  }

  function openBatchModal(mode) {
    if (!state.catalog.serviceTypes.length) return window.alert('請先新增至少一個項目類型。');
    const source = mode === 'update' ? state.catalog.services.filter((service) => state.selected.has(service.serviceId)) : [{}, {}];
    if (mode === 'update' && !source.length) return;
    els.bookingAdminCrudModalTitle.textContent = mode === 'create' ? '批次新增預約項目' : `批次修改預約項目（${source.length}）`;
    els.bookingAdminCrudModalBody.innerHTML = `<form class="booking-admin-form"><div data-batch-rows></div>${mode === 'create' ? '<button data-add-row class="button button-outline" type="button">＋ 新增一列</button>' : ''}<div data-modal-message class="form-message hidden"></div><div class="booking-admin-modal-actions"><button data-cancel class="button button-outline" type="button">取消</button><button class="button button-dark" type="submit">套用批次操作</button></div></form>`;
    const form = els.bookingAdminCrudModalBody.querySelector('form');
    const rows = form.querySelector('[data-batch-rows]');
    source.forEach((service) => appendBatchRow(rows, service, mode));
    form.querySelector('[data-add-row]')?.addEventListener('click', () => appendBatchRow(rows, {}, mode));
    form.querySelector('[data-cancel]').addEventListener('click', closeModal);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const operations = [...rows.querySelectorAll('[data-batch-row]')].map((row) => {
        const payload = readServiceForm(row);
        if (mode === 'update') { payload.serviceId = row.dataset.serviceId; payload.expectedUpdatedAt = row.dataset.updatedAt || ''; }
        return { op: mode, ...payload };
      });
      if (!operations.length) return;
      await runModalAction(async () => manageRequest('admin.booking.services.batch', { operations }, true));
    });
    showModal();
  }

  function appendBatchRow(container, service, mode) {
    const row = document.createElement('div');
    row.dataset.batchRow = '1'; row.dataset.serviceId = service.serviceId || ''; row.dataset.updatedAt = service.updatedAt || '';
    row.style.cssText = 'padding:12px 0;border-bottom:1px solid rgba(23,53,46,.1);display:grid;gap:10px';
    row.innerHTML = serviceFormHtml(service);
    row.querySelector('[data-field="serviceType"]').value = service.serviceType || '';
    if (mode === 'create') row.appendChild(actionButton('移除此列', 'button button-outline', () => row.remove()));
    container.appendChild(row);
  }

  async function batchDelete() {
    const selected = state.catalog.services.filter((service) => state.selected.has(service.serviceId));
    if (!selected.length || !window.confirm(`確定批次刪除 ${selected.length} 個預約項目？\n既有預約紀錄會保留。`)) return;
    const operations = selected.map((service) => ({ op: 'delete', serviceId: service.serviceId, expectedUpdatedAt: service.updatedAt || '' }));
    await runPageAction(els.bookingAdminServiceMessage, async () => manageRequest('admin.booking.services.batch', { operations }, true));
  }

  async function runModalAction(fn) {
    if (state.busy) return;
    state.busy = true;
    const message = els.bookingAdminCrudModalBody.querySelector('[data-modal-message]');
    try {
      await fn();
      state.selected.clear();
      // Keep the modal open until the authoritative catalog is refreshed.
      // Otherwise a user can immediately trigger another batch action while
      // state.busy is still true, causing the next action to be silently ignored.
      await refreshAll(true);
      els.bookingAdminCrudModal.classList.add('hidden');
    }
    catch (error) { if (['BOOKING_CONFLICT','BOOKING_NO_SHOW_NOT_ALLOWED'].includes(error?.code)) await refreshAll(false); showMessage(message, error?.message || '操作失敗。', 'error'); }
    finally { state.busy = false; }
  }

  async function runPageAction(messageElement, fn) {
    if (state.busy) return;
    state.busy = true; clearMessage(messageElement);
    try { await fn(); state.selected.clear(); await refreshAll(true); }
    catch (error) { showMessage(messageElement, error?.message || '操作失敗。', 'error'); }
    finally { state.busy = false; }
  }

  function bookingVisibleItems(booking) { return Array.isArray(booking?.items) ? booking.items.filter((item) => item.serviceId !== STORE_SERVICE_ID) : []; }
  function bookingStoreItem(booking) { return Array.isArray(booking?.items) ? booking.items.find((item) => item.serviceId === STORE_SERVICE_ID) : null; }
  function bookingDisplayTitle(booking) {
    const titles = bookingVisibleItems(booking).map((item) => item.serviceTitle).filter(Boolean);
    return titles.length ? titles.join(' + ') : booking.serviceTitle || '預約項目';
  }

  function bookingCreatedTimestamp(booking) {
    const createdAt = Date.parse(String(booking?.createdAt || ''));
    if (Number.isFinite(createdAt)) return createdAt;
    const updatedAt = Date.parse(String(booking?.updatedAt || ''));
    if (Number.isFinite(updatedAt)) return updatedAt;
    const fallback = Date.parse(booking?.startAt || `${String(booking?.bookingDate || '')}T${String(booking?.startTime || '00:00').slice(0, 5)}:00+08:00`);
    return Number.isFinite(fallback) ? fallback : 0;
  }

  function compareBookingsNewestFirst(a, b) {
    const timestampDiff = bookingCreatedTimestamp(b) - bookingCreatedTimestamp(a);
    if (timestampDiff) return timestampDiff;
    return String(b?.bookingId || '').localeCompare(String(a?.bookingId || ''));
  }

  function openBookingItemsModal(booking) {
    const services = (state.catalog.services || []).filter((service) => service.serviceId !== STORE_SERVICE_ID);
    if (!services.length) return window.alert('目前沒有可供管理員選擇的服務項目。');
    const current = new Map(bookingVisibleItems(booking).map((item) => [item.serviceId, Number(item.quantity || 1)]));
    els.bookingAdminCrudModalTitle.textContent = `現場改單｜${booking.memberDisplayName || '會員'}`;
    els.bookingAdminCrudModalBody.innerHTML = `<form class="booking-admin-form"><p class="booking-admin-time">只修改這筆預約的實際服務項目與數量；原預約日期與時段會保留，不會重新排程。</p><div data-booking-item-rows style="display:grid;gap:10px"></div><div data-modal-message class="form-message hidden"></div><div class="booking-admin-modal-actions"><button data-cancel class="button button-outline" type="button">取消</button><button class="button button-dark" type="submit">儲存現場改單</button></div></form>`;
    const form = els.bookingAdminCrudModalBody.querySelector('form');
    const rows = form.querySelector('[data-booking-item-rows]');
    services.forEach((service) => {
      const row = document.createElement('label');
      row.className = 'booking-admin-toggle';
      row.style.alignItems = 'center';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.bookingService = service.serviceId;
      checkbox.checked = current.has(service.serviceId);
      const text = document.createElement('span');
      const title = document.createElement('strong'); title.textContent = `${service.title}${service.isActive ? '' : '（目前停用）'}`;
      const meta = document.createElement('small'); meta.textContent = `${Number(service.durationMinutes || 0)} 分鐘／份 · ${formatMoney(service.priceAmount)}${service.requiresCompanionService ? ' · 加購／需搭配一般項目' : ''}`;
      text.append(title, meta);
      const quantity = document.createElement('select');
      quantity.dataset.bookingQuantity = service.serviceId;
      quantity.setAttribute('aria-label', `${service.title} 數量`);
      quantity.innerHTML = '<option value="1">1 份</option><option value="2">2 份</option>';
      quantity.value = String(current.get(service.serviceId) || 1);
      quantity.disabled = !checkbox.checked;
      checkbox.addEventListener('change', () => { quantity.disabled = !checkbox.checked; });
      row.append(checkbox, text, quantity);
      rows.appendChild(row);
    });
    form.querySelector('[data-cancel]').addEventListener('click', closeModal);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const items = [...form.querySelectorAll('[data-booking-service]:checked')].map((checkbox) => ({
        serviceId: checkbox.dataset.bookingService,
        quantity: Number(form.querySelector(`[data-booking-quantity="${checkbox.dataset.bookingService}"]`)?.value || 1),
      }));
      if (!items.length) return showMessage(form.querySelector('[data-modal-message]'), '請至少選擇一個實際服務項目。', 'error');
      const selectedServices = items.map((item) => services.find((service) => service.serviceId === item.serviceId)).filter(Boolean);
      if (selectedServices.some((service) => service.requiresCompanionService) && !selectedServices.some((service) => !service.requiresCompanionService)) {
        return showMessage(form.querySelector('[data-modal-message]'), '加購項目不能單獨使用，請至少再選擇一個一般項目。', 'error');
      }
      await runModalAction(async () => operationsRequest('admin.booking.items.update', {
        bookingId: booking.bookingId,
        expectedUpdatedAt: booking.updatedAt,
        items,
      }, true));
    });
    showModal();
  }

  async function openBookingBenefitsModal(booking) {
    if (!canEditBooking(booking)) return window.alert('這筆預約目前無法修改預約票券。');
    els.bookingAdminCrudModalTitle.textContent = `修改預約票券｜${booking.memberDisplayName || '會員'}`;
    els.bookingAdminCrudModalBody.innerHTML = '<div class="booking-admin-form"><p class="booking-admin-time">正在同步會員可用票券…</p></div>';
    showModal();

    let result;
    try {
      result = await operationsRequest('admin.booking.benefits.list', { bookingId: booking.bookingId });
    } catch (error) {
      els.bookingAdminCrudModalBody.innerHTML = '<div class="booking-admin-form"><div data-modal-message class="form-message"></div><div class="booking-admin-modal-actions"><button data-cancel class="button button-outline" type="button">關閉</button></div></div>';
      showMessage(els.bookingAdminCrudModalBody.querySelector('[data-modal-message]'), error?.message || '目前無法讀取會員可用票券。', 'error');
      els.bookingAdminCrudModalBody.querySelector('[data-cancel]')?.addEventListener('click', closeModal);
      return;
    }

    const freshBooking = result?.booking && typeof result.booking === 'object' ? result.booking : booking;
    const catalog = result?.catalog && typeof result.catalog === 'object' ? result.catalog : {};
    const available = (Array.isArray(catalog.items) ? catalog.items : [])
      .filter((item) => item?.kind === 'points' || item?.kind === 'event');
    const current = (Array.isArray(freshBooking.benefits) ? freshBooking.benefits : [])
      .filter((item) => item?.status === 'pending' && (item?.kind === 'points' || item?.kind === 'event'));
    const currentKeys = new Set(current.map((item) => `${item.kind}:${item.id}`));
    const rowsByKey = new Map();

    available.forEach((item) => {
      const selectionId = String(item?.selectionId || '');
      const key = selectionId ? `${item.kind}:${selectionId}` : `${item.kind}:offer:${String(item?.id || '')}`;
      rowsByKey.set(key, { ...item, selectionId });
    });
    current.forEach((item) => {
      const key = `${item.kind}:${item.id}`;
      if (!rowsByKey.has(key)) {
        rowsByKey.set(key, {
          kind: item.kind,
          selectionId: item.id,
          title: item.title || '預約票券',
          subtitle: '目前已選用，但已不在可用票券清單',
          conditionLabel: '此票券目前已失效或資格已變更；請取消選取後儲存。',
          selectable: false,
          disabledReason: '目前不可繼續綁定此票券',
          invalidCurrent: true,
        });
      }
    });

    const bookingServiceTypes = new Set(
      (Array.isArray(freshBooking.items) ? freshBooking.items : [])
        .map((item) => String(item?.serviceType || '').trim().toLocaleLowerCase('zh-Hant-TW'))
        .filter(Boolean)
    );
    const serviceRequirementMet = (item) => {
      const required = (Array.isArray(item?.requiredServiceTypes) ? item.requiredServiceTypes : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean);
      return !required.length || required.some((value) => bookingServiceTypes.has(value.toLocaleLowerCase('zh-Hant-TW')));
    };
    const hasLimit = (value) => Number.isInteger(Number(value)) && Number(value) > 0;
    const eventLimit = Number(catalog.eventTicketMaxPerDay || 0);
    const pointLimit = Number(catalog.pointTicketMaxPerRedemption || 0);

    els.bookingAdminCrudModalBody.innerHTML = '<form class="booking-admin-form"><p class="booking-admin-time">可新增、移除或更換這筆預約要使用的票券。管理端只能選擇會員已持有且目前可用的票券；尚未領取的活動票券不會由管理端代領。</p><div data-booking-benefit-summary class="booking-admin-time"></div><div data-booking-benefit-rows style="display:grid;gap:10px"></div><div data-modal-message class="form-message hidden"></div><div class="booking-admin-modal-actions"><button data-cancel class="button button-outline" type="button">取消</button><button class="button button-dark" type="submit">儲存預約票券</button></div></form>';
    const form = els.bookingAdminCrudModalBody.querySelector('form');
    const rows = form.querySelector('[data-booking-benefit-rows]');
    const summary = form.querySelector('[data-booking-benefit-summary]');
    const kindLabel = { points: '集點卡票券', event: '活動票券' };

    const ordered = [...rowsByKey.values()].sort((left, right) => {
      const kindDiff = String(left.kind).localeCompare(String(right.kind));
      return kindDiff || String(left.title || '').localeCompare(String(right.title || ''), 'zh-Hant-TW');
    });

    if (!ordered.length) {
      const empty = document.createElement('p');
      empty.className = 'integration-empty';
      empty.textContent = '會員目前沒有可調整的預約票券。';
      rows.appendChild(empty);
    }

    ordered.forEach((item) => {
      const selectionId = String(item?.selectionId || '');
      const key = selectionId ? `${item.kind}:${selectionId}` : '';
      const isCurrent = Boolean(key && currentKeys.has(key));
      const serviceBlocked = !serviceRequirementMet(item);
      const row = document.createElement('label');
      row.className = 'booking-admin-toggle';
      row.style.alignItems = 'flex-start';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = isCurrent;
      checkbox.disabled = !isCurrent && (!selectionId || item.selectable !== true || serviceBlocked);
      if (selectionId) {
        checkbox.dataset.bookingBenefitKind = String(item.kind || '');
        checkbox.dataset.bookingBenefitId = selectionId;
      }
      if (item.invalidCurrent) checkbox.dataset.bookingBenefitInvalidCurrent = 'true';
      if (serviceBlocked) checkbox.dataset.bookingBenefitServiceBlocked = 'true';
      if (item.kind === 'points') {
        checkbox.dataset.bookingBenefitPointCard = String(item.cardId || item.cardTitle || '');
        checkbox.dataset.bookingBenefitPointCost = String(Math.max(0, Number(item.pointCost || 0)));
        checkbox.dataset.bookingBenefitPointBalance = String(Math.max(0, Number(item.pointBalance || 0)));
      }

      const copy = document.createElement('span');
      const title = document.createElement('strong');
      title.textContent = `${kindLabel[item.kind] || '票券'}｜${item.title || '預約票券'}`;
      const subtitle = document.createElement('small');
      subtitle.textContent = String(item.subtitle || (isCurrent ? '目前已選用' : ''));
      const condition = document.createElement('small');
      condition.textContent = serviceBlocked
        ? `不符合目前預約項目。 ${String(item.conditionLabel || '')}`.trim()
        : String(item.conditionLabel || '');
      copy.append(title);
      if (subtitle.textContent) copy.appendChild(subtitle);
      if (condition.textContent) copy.appendChild(condition);
      const disabledReason = String(item.disabledReason || '');
      if ((!selectionId || item.selectable !== true || serviceBlocked) && disabledReason) {
        const reason = document.createElement('small');
        reason.textContent = disabledReason;
        copy.appendChild(reason);
      }
      row.append(checkbox, copy);
      rows.appendChild(row);
    });

    const updateSummary = () => {
      const checked = [...form.querySelectorAll('[data-booking-benefit-id]:checked')];
      const pointCount = checked.filter((input) => input.dataset.bookingBenefitKind === 'points').length;
      const eventCount = checked.filter((input) => input.dataset.bookingBenefitKind === 'event').length;
      summary.textContent = `目前選擇：集點卡票券 ${pointCount} 張${hasLimit(pointLimit) ? ` / 上限 ${pointLimit}` : ' / 不限張數'}；活動票券 ${eventCount} 張${hasLimit(eventLimit) ? ` / 上限 ${eventLimit}` : ' / 不限張數'}。`;
    };
    form.querySelectorAll('input[type="checkbox"]').forEach((input) => input.addEventListener('change', updateSummary));
    updateSummary();

    form.querySelector('[data-cancel]').addEventListener('click', closeModal);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const selectedInputs = [...form.querySelectorAll('[data-booking-benefit-id]:checked')];
      const invalidCurrent = selectedInputs.find((input) => input.dataset.bookingBenefitInvalidCurrent === 'true');
      if (invalidCurrent) {
        return showMessage(form.querySelector('[data-modal-message]'), '目前已選用的其中一張票券已失效，請取消該票券後再儲存。', 'error');
      }
      const serviceBlocked = selectedInputs.find((input) => input.dataset.bookingBenefitServiceBlocked === 'true');
      if (serviceBlocked) {
        return showMessage(form.querySelector('[data-modal-message]'), '其中一張票券不符合目前預約項目限制，請取消該票券或先修改服務項目。', 'error');
      }

      const pointInputs = selectedInputs.filter((input) => input.dataset.bookingBenefitKind === 'points');
      const eventInputs = selectedInputs.filter((input) => input.dataset.bookingBenefitKind === 'event');
      if (hasLimit(pointLimit) && pointInputs.length > pointLimit) {
        return showMessage(form.querySelector('[data-modal-message]'), `集點卡票券每筆預約最多可選 ${pointLimit} 張。`, 'error');
      }
      if (hasLimit(eventLimit) && eventInputs.length > eventLimit) {
        return showMessage(form.querySelector('[data-modal-message]'), `活動票券每筆預約最多可選 ${eventLimit} 張。`, 'error');
      }

      const pointBudget = new Map();
      pointInputs.forEach((input) => {
        const card = String(input.dataset.bookingBenefitPointCard || '');
        const cost = Math.max(0, Number(input.dataset.bookingBenefitPointCost || 0));
        const balance = Math.max(0, Number(input.dataset.bookingBenefitPointBalance || 0));
        const currentBudget = pointBudget.get(card) || { required: 0, available: balance };
        currentBudget.required += cost;
        currentBudget.available = Math.min(currentBudget.available, balance);
        pointBudget.set(card, currentBudget);
      });
      if ([...pointBudget.values()].some((budget) => budget.required > budget.available)) {
        return showMessage(form.querySelector('[data-modal-message]'), '會員目前可用點數不足，請取消部分集點卡票券後再儲存。', 'error');
      }

      const benefits = selectedInputs.map((input) => ({
        kind: input.dataset.bookingBenefitKind,
        id: input.dataset.bookingBenefitId,
      }));
      await runModalAction(async () => operationsRequest('admin.booking.benefits.update', {
        bookingId: freshBooking.bookingId,
        expectedUpdatedAt: freshBooking.updatedAt,
        benefits,
      }, true));
    });
  }

  function openCompletedBookingModal(booking, group) {
    els.bookingAdminCrudModalTitle.textContent = '更正已完成訂單';
    els.bookingAdminCrudModalBody.innerHTML = '<form class="booking-admin-form"><p>填寫每位客人的實際項目與分鐘。系統會預覽點數及會員服務時間的差額，確認後追加補正紀錄。</p><fieldset data-correction-fields><div data-correction-people></div><label>更正原因<input data-correction-reason required maxlength="500"></label></fieldset><div data-correction-preview role="status" aria-live="polite"></div><div data-modal-message class="form-message hidden"></div><div class="booking-admin-modal-actions"><button data-cancel class="button button-outline" type="button">取消</button><button class="button button-dark" type="submit">預覽並確認補正</button></div></form>';
    const form = els.bookingAdminCrudModalBody.querySelector('form');
    const people = group?.participants?.length ? group.participants : [{position:1,items:booking.items || []}];
    let requestId = '';
    people.forEach((person,index) => {
      const section = document.createElement('fieldset'); section.dataset.correctionPosition = person.position || index+1;
      const legend = document.createElement('legend'); legend.textContent = `第 ${index+1} 位 · ${person.technicianName || '現場安排'}`; section.append(legend);
      const existing = new Map((person.items || []).map(item => [item.serviceId,item]));
      const services = new Map((state.catalog.services || []).map(service => [service.serviceId,service]));
      for (const item of person.items || []) if (!services.has(item.serviceId)) services.set(item.serviceId,{serviceId:item.serviceId,title:item.serviceTitle,durationMinutes:item.unitDurationMinutes});
      services.forEach(service => {
        if (service.serviceId === STORE_SERVICE_ID) return;
        const old = existing.get(service.serviceId);
        const row = document.createElement('label'); row.className='booking-admin-toggle';
        const check = document.createElement('input'); check.type='checkbox'; check.dataset.correctionService=service.serviceId; check.checked=Boolean(old);
        const title = document.createElement('span'); title.textContent=service.title || old?.serviceTitle || '服務項目';
        const minutes = document.createElement('input'); minutes.type='number'; minutes.min='1'; minutes.max='720'; minutes.step='1'; minutes.dataset.correctionMinutes=''; minutes.value=String(old?.unitDurationMinutes || service.durationMinutes || 30); minutes.setAttribute('aria-label',`${title.textContent} 實際分鐘`);
        const quantity = document.createElement('select'); quantity.dataset.correctionQuantity=''; quantity.append(new Option('1 份','1'),new Option('2 份','2')); quantity.value=String(old?.quantity || 1); quantity.setAttribute('aria-label',`${title.textContent} 數量`);
        const sync=()=>{minutes.disabled=quantity.disabled=!check.checked;}; check.addEventListener('change',sync); sync();
        row.append(check,title,minutes,quantity); section.append(row);
      });
      form.querySelector('[data-correction-people]').append(section);
    });
    form.addEventListener('input',()=>{requestId='';form.querySelector('[data-correction-preview]').textContent='';});
    form.querySelector('[data-cancel]').addEventListener('click',closeModal);
    form.addEventListener('submit',async event=>{
      event.preventDefault(); if(state.busy) return;
      const participants=[...form.querySelectorAll('[data-correction-position]')].map(section=>({position:Number(section.dataset.correctionPosition),items:[...section.querySelectorAll('[data-correction-service]:checked')].map(check=>({serviceId:check.dataset.correctionService,minutes:Number(check.parentElement.querySelector('[data-correction-minutes]').value),quantity:Number(check.parentElement.querySelector('[data-correction-quantity]').value)}))}));
      const reason=form.querySelector('[data-correction-reason]').value.trim();
      const payload={bookingId:booking.bookingId,expectedUpdatedAt:booking.updatedAt,participants,reason,requestId:requestId||(requestId='correction_'+crypto.randomUUID().replaceAll('-',''))};
      const fields=form.querySelector('[data-correction-fields]'); fields.disabled=true; state.busy=true;
      try {
        const {adjustment}=await operationsRequest('admin.booking.completed.preview',payload);
        const preview=`服務對象的會員服務時間：${adjustment.before.serviceMinutes} → ${adjustment.after.serviceMinutes} 分鐘（差額 ${adjustment.serviceMinutesDelta>=0?'+':''}${adjustment.serviceMinutesDelta}）\n${Number(adjustment.before.friendRewardMinutes||0)!==Number(adjustment.after.friendRewardMinutes||0)?`代預約會員的獎勵時間：${adjustment.before.friendRewardMinutes} → ${adjustment.after.friendRewardMinutes} 分鐘\n`:''}`+(adjustment.pointDeltas||[]).map(item=>`${item.memberId===booking.memberId?'預約會員':'服務對象'} · ${item.cardTitle}：${item.delta>=0?'+':''}${item.delta} 點`).join('\n');
        form.querySelector('[data-correction-preview]').textContent=preview;
        if (!window.confirm(`${preview}\n\n原因：${reason}\n確認追加補正？`)) return;
        await operationsRequest('admin.booking.completed.correct',{...payload,expectedPreview:adjustment},true);
        els.bookingAdminCrudModal.classList.add('hidden'); await refreshAll(true);
      } catch(error) {showMessage(form.querySelector('[data-modal-message]'),error?.message||'無法補正，請重新整理後確認。','error');}
      finally {state.busy=false;fields.disabled=false;}
    });
    showModal();
  }

  function renderBookings() {
    const bookings = (state.booking.bookings || [])
      .filter((booking) => state.filter === 'all' || booking.status === state.filter)
      .slice()
      .sort(compareBookingsNewestFirst);
    els.bookingAdminQueueEmpty.classList.toggle('hidden', bookings.length > 0);
    const existingCards = new Map(
      Array.from(els.bookingAdminQueue.querySelectorAll('[data-booking-id]'))
        .map((card) => [String(card.dataset.bookingId || ''), card])
        .filter(([bookingId]) => Boolean(bookingId))
    );
    const nextSignatures = new Map();
    const retainedCards = new Set();

    bookings.forEach((booking) => {
      const bookingId = String(booking.bookingId || '');
      const storedGroup = state.booking.groups?.[bookingId];
      const hasStoredParticipants = Boolean(storedGroup && Array.isArray(storedGroup.participants) && storedGroup.participants.length);
      const group = groupForDisplay(storedGroup, booking);
      const renderSignature = JSON.stringify({ booking, group, hasStoredParticipants });
      nextSignatures.set(bookingId, renderSignature);
      const existingCard = existingCards.get(bookingId);
      if (existingCard && state.bookingRenderSignatures.get(bookingId) === renderSignature) {
        retainedCards.add(existingCard);
        els.bookingAdminQueue.appendChild(existingCard);
        return;
      }

      const card = document.createElement('article');
      card.className = 'booking-admin-booking booking-summary-normalized';
      card.dataset.bookingId = bookingId;
      if (new URLSearchParams(window.location.search).get('bookingId') === bookingId) {
        card.classList.add('booking-detail-target');
        const hint=document.createElement('p'); hint.textContent='已載入 LINE 通知對應預約，請核對最新狀態後操作。'; card.append(hint);
      }
      card.dataset.bookingMemberCode = String(booking.memberCode || '');
      card.dataset.bookingMemberName = String(booking.memberDisplayName || '');
      card.dataset.bookingDate = String(booking.bookingDate || '');
      card.dataset.bookingStartTime = String(booking.startTime || '').slice(0, 5);
      card.dataset.bookingEndTime = String(booking.endTime || '').slice(0, 5);
      card.dataset.bookingStartAt = String(booking.startAt || '');
      card.dataset.bookingEndAt = String(booking.endAt || '');
      card.dataset.bookingCopyItems = JSON.stringify(bookingVisibleItems(booking).map((item) => ({
        serviceTitle: String(item?.serviceTitle || '預約項目').trim(),
        quantity: Math.max(1, Number(item?.quantity || 1)),
      })));
      card.dataset.bookingCopyGroup = JSON.stringify({
        partySize: Math.max(1, Number(group?.partySize || group?.participants?.length || 1)),
        participants: (group?.participants || []).map((participant) => ({
          technicianName: String(participant?.technicianName || '現場安排'),
          items: Array.isArray(participant?.items) ? participant.items.map((item) => ({
            serviceTitle: String(item?.serviceTitle || '預約項目').trim(),
            quantity: Math.max(1, Number(item?.quantity || 1)),
          })) : [],
        })),
      });
      card.dataset.bookingCopyContactName = bookingContactName(booking);
      card.dataset.bookingCopyPhone = String(booking.contactPhone || '—');

      card.appendChild(renderBookingSummary(booking, group, hasStoredParticipants));

      const heading = document.createElement('div');
      heading.className = 'booking-admin-booking-heading';
      const status = document.createElement('span');
      status.className = `booking-admin-status status-${booking.status}`;
      status.textContent = STATUS_LABELS[booking.status] || booking.status;
      heading.appendChild(status);
      card.appendChild(heading);

      const benefitCards = renderBookingBenefitCards(booking.benefits);
      if (benefitCards) card.appendChild(benefitCards);
      if (booking.memberNote) appendNote(card, `會員備註：${booking.memberNote}`, false);
      if (booking.adminNote) appendNote(card, `管理端說明：${booking.adminNote}`, true);
      const cancellationPending = Boolean(booking.cancellationRequestedAt && !booking.cancellationReviewedAt);
      if (cancellationPending) appendNote(card, '會員已提出取消申請，請至「取消申請」分頁選擇保留預約或確認取消；審核完成前不可修改、確認或完成此預約。', true);

      if (booking.status === 'completed') {
        card.appendChild(actionButton('更正已完成訂單', 'button button-outline', () => openCompletedBookingModal(booking, group)));
      }
      if (canEditBooking(booking)) {
        const note = document.createElement('label');
        note.className = 'booking-admin-note-field';
        note.textContent = '管理端說明（選填）';
        const textarea = document.createElement('textarea');
        textarea.maxLength = 500;
        textarea.rows = 2;
        textarea.value = booking.adminNote || '';
        note.appendChild(textarea);
        card.appendChild(note);

        const actions = document.createElement('div');
        actions.className = 'booking-admin-actions';
        if (!hasStoredParticipants) {
          actions.append(actionButton('修改服務項目', 'button button-outline', () => openBookingItemsModal(booking)));
        }
        actions.append(actionButton('修改預約票券', 'button button-outline', () => openBookingBenefitsModal(booking)));
        if (booking.status === 'pending' || booking.status === 'confirmed') {
          const reason = noShowUnavailableReason(booking);
          const visibleReason = noShowDisplayReason(reason);
          const noShow = actionButton('無故未到', 'button button-danger', () => openNoShow(booking, textarea.value));
          noShow.dataset.noShowId=bookingId; noShow.disabled = Boolean(reason); noShow.title = visibleReason;
          noShow.setAttribute('aria-label', visibleReason ? `無故未到：${visibleReason}` : '無故未到');
          actions.append(noShow);
          if (visibleReason) { const hint = document.createElement('small'); hint.textContent = visibleReason; actions.append(hint); }
        }
        if (booking.status === 'pending') {
          actions.append(
            actionButton('不通過', 'button button-outline', () => updateBookingStatus(booking, 'rejected', textarea.value)),
            actionButton('確認預約', 'button button-dark', () => updateBookingStatus(booking, 'confirmed', textarea.value)),
          );
        } else {
          actions.append(
            actionButton('確認服務完成', 'button button-dark', () => updateBookingStatus(booking, 'completed', textarea.value)),
            actionButton('取消預約', 'button button-danger', () => updateBookingStatus(booking, 'cancelled', textarea.value)),
          );
        }
        card.appendChild(actions);
      }

      if (existingCard) existingCard.remove();
      retainedCards.add(card);
      els.bookingAdminQueue.appendChild(card);
    });

    Array.from(els.bookingAdminQueue.children).forEach((card) => {
      if (!retainedCards.has(card)) card.remove();
    });
    state.bookingRenderSignatures = nextSignatures;
  }

  function canEditBooking(booking) {
    return Boolean(
      (booking?.status === 'pending' || booking?.status === 'confirmed')
      && !(booking?.cancellationRequestedAt && !booking?.cancellationReviewedAt)
    );
  }

  function groupForDisplay(group, booking) {
    if (group && Array.isArray(group.participants) && group.participants.length) return group;
    const items = bookingVisibleItems(booking);
    if (!items.length) return { partySize: 1, participants: [] };
    return {
      partySize: 1,
      participants: [{
        position: 1,
        technicianId: '',
        technicianName: '現場安排',
        isPrimaryTechnician: false,
        items,
      }],
      totalDurationMinutes: Number(booking?.totalDurationMinutes || 0),
      totalAmount: Number(booking?.totalAmount || 0),
    };
  }

  function renderBookingSummary(booking, group, hasStoredParticipants) {
    const summary = document.createElement('div');
    summary.className = 'booking-received-summary';

    const memberMeta = document.createElement('div');
    memberMeta.className = 'booking-member-meta';
    memberMeta.append(
      summaryMetaItem('LINE 名稱', String(booking.memberDisplayName || '未取得')),
      summaryMetaItem('會員編號', String(booking.memberCode || '未取得')),
      summaryMetaItem('總服務時間', `${Math.max(0, Number(group?.totalDurationMinutes || booking.totalDurationMinutes || 0))} 分鐘`),
      summaryMetaItem('總金額', formatMoney(Number(group?.totalAmount ?? booking.totalAmount ?? 0))),
    );
    if(group?.serviceRecipientMemberCode)memberMeta.append(summaryMetaItem('實際受服務者',`${group.serviceRecipientName||'好友'} · ${group.serviceRecipientMemberCode}（好友代約）`));
    summary.appendChild(memberMeta);

    const dateTime = document.createElement('p');
    dateTime.className = 'booking-received-datetime';
    dateTime.textContent = `${formatBookingDateSummary(booking.bookingDate)} 營業班次 · ${String(booking.startTime || '—').slice(0, 5)}–${String(booking.endTime || '—').slice(0, 5)}${String(booking.endAt || '').slice(0, 10) > String(booking.startAt || '').slice(0, 10) ? '（隔日）' : ''}`;
    summary.appendChild(dateTime);

    const contactName = document.createElement('p');
    contactName.className = 'booking-received-name';
    contactName.textContent = bookingContactName(booking);
    summary.appendChild(contactName);

    const phone = document.createElement('p');
    phone.className = 'booking-received-phone';
    phone.textContent = `電話：${String(booking.contactPhone || '—')}`;
    summary.appendChild(phone);

    summary.appendChild(renderParticipantDetails(booking, group, hasStoredParticipants));

    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'booking-copy-button';
    copyButton.dataset.bookingAdminAction = 'copy-booking';
    copyButton.textContent = '複製預約內容';
    copyButton.setAttribute('aria-label', `複製 ${bookingContactName(booking)} 的預約內容`);
    summary.appendChild(copyButton);

    return summary;
  }

  function summaryMetaItem(label, value) {
    const item = document.createElement('div');
    item.className = 'booking-member-meta-item';
    const key = document.createElement('span');
    key.className = 'booking-member-meta-label';
    key.textContent = label;
    const content = document.createElement('strong');
    content.textContent = value;
    item.append(key, content);
    return item;
  }

  function renderParticipantDetails(booking, group, hasStoredParticipants) {
    const box = document.createElement('section');
    box.className = 'booking-group-admin-details';
    box.setAttribute('aria-label', '逐位預約明細');
    const participants = Array.isArray(group?.participants) ? group.participants : [];

    if (!participants.length) {
      const empty = document.createElement('p');
      empty.textContent = '逐位預約明細尚未建立。';
      box.appendChild(empty);
      return box;
    }

    participants.forEach((participant, index) => {
      const block = document.createElement('div');
      block.className = 'booking-group-admin-participant';

      const heading = document.createElement('strong');
      heading.textContent = participantLabel(index);
      const items = document.createElement('p');
      items.textContent = `預約項目：${participantItemsLabel(participant.items)}`;
      const tech = document.createElement('p');
      const techName = String(participant.technicianName || '現場安排').replace(/（主要技師）/g, '').trim() || '現場安排';
      tech.textContent = `預約技師：${techName}`;
      block.append(heading, items, tech);

      if (hasStoredParticipants && canEditBooking(booking)) {
        const actions = document.createElement('div');
        actions.className = 'booking-admin-actions';
        actions.style.margin = '4px 0 0';
        actions.append(
          actionButton('修改此位項目', 'button button-outline', () => openParticipantItemsEditor(booking, group, index)),
          actionButton('修改此位技師', 'button button-outline', () => openParticipantTechnicianEditor(booking, group, index)),
        );
        block.appendChild(actions);
      }

      box.appendChild(block);
    });

    return box;
  }

  function openParticipantItemsEditor(booking, group, participantIndex) {
    if (!canEditBooking(booking)) return window.alert('這筆預約目前無法修改服務項目。');
    const participant = group?.participants?.[participantIndex];
    const services = (state.catalog.services || []).filter((service) => service.serviceId !== STORE_SERVICE_ID);
    if (!participant || !services.length) return window.alert('目前沒有可供管理員選擇的服務項目。');

    const current = new Map((participant.items || []).map((item) => [String(item.serviceId || ''), Math.max(1, Number(item.quantity || 1))]));
    els.bookingAdminCrudModalTitle.textContent = `${participantLabel(participantIndex)}｜修改項目`;
    els.bookingAdminCrudModalBody.innerHTML = '<form class="booking-admin-form"><p class="booking-admin-time">只修改這一位的預約項目與數量；系統會重新計算整筆預約時間。</p><div data-participant-item-rows style="display:grid;gap:10px"></div><div data-modal-message class="form-message hidden"></div><div class="booking-admin-modal-actions"><button data-cancel class="button button-outline" type="button">取消</button><button class="button button-dark" type="submit">儲存修改</button></div></form>';
    const form = els.bookingAdminCrudModalBody.querySelector('form');
    const rows = form.querySelector('[data-participant-item-rows]');

    services.forEach((service) => {
      const row = document.createElement('label');
      row.className = 'booking-admin-toggle';
      row.style.alignItems = 'center';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = String(service.serviceId || '');
      checkbox.checked = current.has(checkbox.value);
      const text = document.createElement('span');
      const title = document.createElement('strong');
      title.textContent = `${service.title}${service.isActive ? '' : '（目前停用）'}`;
      const meta = document.createElement('small');
      meta.textContent = `${Number(service.durationMinutes || 0)} 分鐘／份 · ${formatMoney(service.priceAmount)}`;
      text.append(title, meta);
      const quantity = document.createElement('select');
      quantity.innerHTML = '<option value="1">1 份</option><option value="2">2 份</option>';
      quantity.value = String(current.get(checkbox.value) || 1);
      quantity.disabled = !checkbox.checked;
      checkbox.addEventListener('change', () => { quantity.disabled = !checkbox.checked; });
      row.append(checkbox, text, quantity);
      rows.appendChild(row);
    });

    form.querySelector('[data-cancel]').addEventListener('click', closeModal);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const selected = [...rows.querySelectorAll('input[type="checkbox"]:checked')].map((checkbox) => ({
        serviceId: checkbox.value,
        quantity: Number(checkbox.closest('label')?.querySelector('select')?.value || 1),
      }));
      if (!selected.length) return showMessage(form.querySelector('[data-modal-message]'), '請至少選擇一個預約項目。', 'error');

      const participants = (group.participants || []).map((person, index) => ({
        position: Number(person.position || index + 1),
        items: index === participantIndex
          ? selected
          : (person.items || []).map((item) => ({
              serviceId: String(item.serviceId || ''),
              quantity: Math.max(1, Number(item.quantity || 1)),
            })),
      }));

      await runModalAction(async () => operationsRequest('admin.booking.participants.items.update', {
        bookingId: booking.bookingId,
        expectedUpdatedAt: booking.updatedAt,
        participants,
      }, true));
    });
    showModal();
  }

  function openParticipantTechnicianEditor(booking, group, participantIndex) {
    if (!canEditBooking(booking)) return window.alert('這筆預約目前無法修改預約技師。');
    const participant = group?.participants?.[participantIndex];
    if (!participant) return;

    const technicians = (state.booking.technicians || [])
      .filter((item) => item.isActive || String(item.technicianId || '') === String(participant.technicianId || ''))
      .slice()
      .sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0) || String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hant'));
    if (!technicians.length && state.booking.settings?.requirePrimaryTechnician !== false) return window.alert('目前沒有可用技師，請先到預約人數與技師設定新增技師。');

    els.bookingAdminCrudModalTitle.textContent = `${participantLabel(participantIndex)}｜修改技師`;
    els.bookingAdminCrudModalBody.innerHTML = '<form class="booking-admin-form"><p class="booking-admin-time">同一筆多人預約不可重複指定同一位技師，且至少一位必須指定主要技師。儲存時會重新檢查技師時段衝突。</p><label>預約技師<select data-participant-technician></select></label><div data-modal-message class="form-message hidden"></div><div class="booking-admin-modal-actions"><button data-cancel class="button button-outline" type="button">取消</button><button class="button button-dark" type="submit">儲存修改</button></div></form>';
    const form = els.bookingAdminCrudModalBody.querySelector('form');
    form.querySelector('.booking-admin-time').textContent = state.booking.settings?.requirePrimaryTechnician === false
      ? '目前不必預約主要技師也能成立預約，可選其他技師或現場安排。同一筆多人預約不可重複指定同一位技師；儲存時重新檢查時段衝突。'
      : '每筆預約至少一位服務對象須預約主要技師，才能成立預約。同一筆多人預約不可重複指定同一位技師；儲存時重新檢查時段衝突。';
    const select = form.querySelector('[data-participant-technician]');
    const onsite = document.createElement('option');
    onsite.value = '';
    onsite.textContent = '現場安排';
    select.appendChild(onsite);

    technicians.forEach((technician) => {
      const option = document.createElement('option');
      option.value = String(technician.technicianId || '');
      const primary = option.value && option.value === String(state.booking.primaryTechnicianId || '');
      option.textContent = `${String(technician.name || '未命名技師')}${primary ? '（主要技師）' : ''}${technician.isActive ? '' : '（目前停用）'}`;
      option.disabled = technician.isActive === false && option.value !== String(participant.technicianId || '');
      select.appendChild(option);
    });
    select.value = String(participant.technicianId || '');

    form.querySelector('[data-cancel]').addEventListener('click', closeModal);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const participants = (group.participants || []).map((person, index) => ({
        position: Number(person.position || index + 1),
        technicianId: index === participantIndex ? String(select.value || '') : String(person.technicianId || ''),
      }));
      const selectedIds = participants.map((person) => person.technicianId).filter(Boolean);
      if (new Set(selectedIds).size !== selectedIds.length) {
        return showMessage(form.querySelector('[data-modal-message]'), '同一筆多人預約不可重複指定同一位技師。', 'error');
      }
      const primaryTechnicianId = String(state.booking.primaryTechnicianId || '');
      if (state.booking.settings?.requirePrimaryTechnician !== false && primaryTechnicianId && !selectedIds.includes(primaryTechnicianId)) {
        return showMessage(form.querySelector('[data-modal-message]'), '每筆預約至少一位服務對象須預約主要技師，才能成立預約。', 'error');
      }

      await runModalAction(async () => operationsRequest('admin.booking.participants.technicians.update', {
        bookingId: booking.bookingId,
        expectedUpdatedAt: booking.updatedAt,
        participants,
      }, true));
    });
    showModal();
  }

  function participantItemsLabel(items) {
    const rows = Array.isArray(items) ? items : [];
    if (!rows.length) return '—';
    return rows.map((item) => {
      const title = String(item?.serviceTitle || '預約項目');
      const quantity = Math.max(1, Number(item?.quantity || 1));
      return quantity > 1 ? `${title} × ${quantity}` : title;
    }).join('、');
  }

  function participantLabel(index) {
    const names = ['第一', '第二', '第三', '第四', '第五', '第六', '第七', '第八', '第九', '第十'];
    return `${names[index] || `第 ${index + 1} `}位預約`;
  }

  function bookingContactName(booking) {
    const surname = String(booking?.contactSurname || '').trim();
    const label = salutationLabel(booking?.contactSalutation);
    if (surname && label) return `${surname}${label}`;
    return '未取得預約人資料';
  }

  function salutationLabel(value) {
    if (value === 'mr') return '先生';
    if (value === 'ms') return '小姐';
    return '';
  }

  function formatBookingDateSummary(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!match) return String(value || '—');
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const weekday = WEEKDAY_LABELS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] || '';
    return `${month}/${day}（${weekday}）`;
  }

  function completionPreviewData(booking) {
    const typeByName = new Map((state.catalog.serviceTypes || []).map((type) => [String(type.name || ''), type]));
    const serviceById = new Map((state.catalog.services || []).map((service) => [String(service.serviceId || ''), service]));
    const typeMinutes = new Map();
    let serviceMinutes = 0;
    const items = bookingVisibleItems(booking).map((item) => {
      const fallback = serviceById.get(String(item.serviceId || ''));
      const countsTowardMembership = item.countsTowardMembership !== undefined
        ? Boolean(item.countsTowardMembership)
        : fallback?.countsTowardMembership !== false;
      const quantity = Math.max(1, Number(item.quantity || 1));
      const unitMinutes = Math.max(0, Number(item.unitDurationMinutes || fallback?.durationMinutes || 0));
      const subtotalMinutes = Math.max(0, Number(item.subtotalMinutes || unitMinutes * quantity));
      const serviceType = String(item.serviceType || fallback?.serviceType || '');
      if (countsTowardMembership) {
        serviceMinutes += subtotalMinutes;
        if (serviceType) typeMinutes.set(serviceType, (typeMinutes.get(serviceType) || 0) + subtotalMinutes);
      }
      return {
        title: String(item.serviceTitle || fallback?.title || '預約項目'),
        serviceType,
        quantity,
        subtotalMinutes,
        countsTowardMembership,
      };
    });
    const rewards = [];
    let totalRewardPoints = 0;
    typeMinutes.forEach((minutes, typeName) => {
      const type = typeByName.get(typeName);
      const perPoint = Number(type?.rewardMinutesPerPoint || 0);
      const cardId = String(type?.rewardPointCardId || '');
      if (!perPoint || !cardId) return;
      const points = Math.floor(Number(minutes || 0) / perPoint);
      if (points < 1) return;
      totalRewardPoints += points;
      rewards.push({
        typeName,
        minutes:Number(minutes || 0),
        perPoint,
        points,
        pointCardTitle:String(type?.rewardPointCardTitle || '指定集點卡'),
      });
    });
    return { items,serviceMinutes,rewards,totalRewardPoints };
  }

  function openCompletionPreview(booking, adminNote) {
    const preview = completionPreviewData(booking);
    const recipient=state.booking.groups?.[booking.bookingId];
    els.bookingAdminCrudModalTitle.textContent = `完成結算預覽｜${booking.memberDisplayName || '會員'}`;
    const itemRows = preview.items.map((item) => `
      <div class="booking-completion-preview-item">
        <div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.serviceType || '未分類')} · ${item.quantity} 份 · ${item.subtotalMinutes} 分鐘</p></div>
        <span class="integration-status ${item.countsTowardMembership ? 'is-active' : 'is-attention'}">${item.countsTowardMembership ? '計入' : '不計入'}</span>
      </div>`).join('');
    const rewardRows = preview.rewards.length
      ? preview.rewards.map((reward) => `<div class="booking-completion-preview-item"><div><strong>${escapeHtml(reward.pointCardTitle)}</strong><p>${escapeHtml(reward.typeName)}：${reward.minutes} 分鐘 ÷ ${reward.perPoint}</p></div><strong>+${reward.points} 點</strong></div>`).join('')
      : '<p class="integration-empty">依目前項目類型規則，本次沒有自動集點。</p>';
    const pendingBenefits = Array.isArray(booking.benefits) ? booking.benefits.filter((benefit) => benefit.status === 'pending') : [];
    const benefitRows = pendingBenefits.length
      ? pendingBenefits.map((benefit) => `<div class="booking-completion-preview-item"><div><strong>${escapeHtml(bookingBenefitDisplayTitle(benefit))}</strong><p>${escapeHtml(bookingBenefitKindLabel(benefit))} · 完成服務時重新驗證</p></div><span class="integration-status is-attention">待核銷</span></div>`).join('')
      : '<p class="integration-empty">會員本次沒有選用優惠。</p>';
    els.bookingAdminCrudModalBody.innerHTML = `
      <form class="booking-admin-form booking-completion-preview">
        <div class="booking-completion-preview-summary">
          <div><span>受服務會員</span><strong>${escapeHtml(recipient?.serviceRecipientName || booking.memberDisplayName || '會員')}</strong></div>
          <div><span>將計入服務時間</span><strong>${preview.serviceMinutes} 分鐘</strong></div>
          <div><span>預估自動集點</span><strong>${preview.totalRewardPoints} 點</strong></div>
          <div><span>待核銷優惠</span><strong>${pendingBenefits.length} 項</strong></div>
        </div>
        ${recipient?.serviceRecipientMemberCode ? `<p>好友代約：正常集點與服務時間歸受服務好友；建立者 ${escapeHtml(booking.memberDisplayName||'會員')} 另取得每種已配置服務類型 1 點及 ${Math.floor(preview.serviceMinutes/2)} 分鐘。票券使用建立者自己的資產。</p>` : ''}
        <section><p class="kicker">Service settlement</p><div class="booking-completion-preview-list">${itemRows || '<p class="integration-empty">沒有可結算的服務項目。</p>'}</div></section>
        <section><p class="kicker">Point rewards</p><div class="booking-completion-preview-list">${rewardRows}</div></section>
        <section><p class="kicker">Benefit redemption</p><div class="booking-completion-preview-list">${benefitRows}</div></section>
        <p class="booking-completion-preview-note">此畫面為送出前預覽。真正的服務時間、集點、LINE 通知與重複請求判斷仍由 Server-side 完成結算流程決定；同時會重新驗證票券擁有權、狀態、效期、點數與每日上限，並在同一交易內完成核銷與預約結算，任何一項失敗都不會產生半完成狀態。</p>
        <div data-modal-message class="form-message hidden"></div>
        <div class="booking-admin-modal-actions"><button data-cancel class="button button-outline" type="button">返回</button><button class="button button-dark" type="submit">確認完成並結算</button></div>
      </form>`;
    const form = els.bookingAdminCrudModalBody.querySelector('form');
    form.querySelector('[data-cancel]').addEventListener('click', closeModal);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      await runModalAction(async () => operationsRequest('admin.booking.status.complete', {
        bookingId: booking.bookingId,
        expectedUpdatedAt: booking.updatedAt,
        adminNote,
      }, true));
    });
    showModal();
  }

  function updateNoShowButtons() {
    for(const button of document.querySelectorAll('[data-no-show-id]')) {
      const booking=state.booking.bookings.find(b=>String(b.bookingId)===button.dataset.noShowId);
      if(!booking) continue;
      const reason=noShowUnavailableReason(booking);
      const visibleReason=noShowDisplayReason(reason);
      button.disabled=Boolean(reason)||state.busy;button.title=visibleReason;
      button.setAttribute('aria-label',visibleReason ? `無故未到：${visibleReason}` : '無故未到');
      const hint=button.nextElementSibling;
      if(hint?.tagName==='SMALL') { hint.textContent=visibleReason; hint.hidden=!visibleReason; }
    }
  }

  function noShowDisplayReason(reason) {
    return reason === NO_SHOW_EARLY_REASON ? '' : reason;
  }

  function noShowUnavailableReason(booking) {
    if (booking.receiptSubmissionId || String(booking.requestId || '').startsWith('receipt-register:')) return '快照請使用獨立審核流程。';
    if (!['pending', 'confirmed'].includes(booking.status)) return '只有待確認或已確認的一般預約可標記。';
    if (booking.cancellationRequestedAt && !booking.cancellationReviewedAt) return '請先處理取消申請。';
    const raw = String(booking.endAt || '');
    const end = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : `${raw}+08:00`);
    if (!raw || !Number.isFinite(end)) return '缺少有效服務結束時間，請先核對排程。';
    return end >= Date.now() ? NO_SHOW_EARLY_REASON : '';
  }

  function openNoShow(booking, adminNote) {
    const reason = noShowUnavailableReason(booking);
    if (reason) { showMessage(els.bookingAdminServiceMessage, reason, 'error'); return; }
    els.bookingAdminCrudModalTitle.textContent = '確認標記無故未到';
    els.bookingAdminCrudModalBody.innerHTML = `<form class="booking-admin-form"><p>${escapeHtml(booking.memberDisplayName || '會員')} · ${escapeHtml(booking.memberCode || '')}</p><p>${escapeHtml(booking.startAt || '')}–${escapeHtml(booking.endAt || '')}</p><p>確認此會員未到場？此操作不核銷票券、不扣點、不計入違規；僅解除本筆未使用票券的保留。</p><label><input type="checkbox" required> 我已人工核對，確認這筆預約無故未到。</label><div data-modal-message class="form-message hidden"></div><div class="booking-admin-modal-actions"><button data-cancel type="button" class="button button-outline">返回</button><button type="submit" class="button button-danger">確認標記無故未到</button></div></form>`;
    const form = els.bookingAdminCrudModalBody.querySelector('form');
    form.querySelector('[data-cancel]').addEventListener('click', closeModal);
    form.addEventListener('submit', async e => {
      e.preventDefault(); if (!form.reportValidity() || state.busy) return;
      const submit=form.querySelector('[type=submit]'); submit.disabled=true; submit.textContent='正在標記…';
      await runModalAction(() => bookingRequest('admin.booking.status.update', {
        bookingId:booking.bookingId,expectedUpdatedAt:booking.updatedAt,status:'no_show',adminNote,
      }, true));
      submit.disabled=false; submit.textContent='確認標記無故未到';
    });
    showModal();
  }

  async function updateBookingStatus(booking, status, adminNote) {
    if (status === 'completed') {
      openCompletionPreview(booking, adminNote);
      return;
    }
    await runPageAction(els.bookingAdminServiceMessage, async () => {
      return bookingRequest('admin.booking.status.update', { bookingId: booking.bookingId, expectedUpdatedAt: booking.updatedAt, status, adminNote }, true);
    });
  }
  function setFilter(filter) {
    state.filter = ['pending','confirmed','completed','no_show','all'].includes(filter) ? filter : 'pending';
    document.querySelectorAll('[data-booking-filter]').forEach((button) => button.classList.toggle('active', button.dataset.bookingFilter === state.filter));
    renderBookings();
  }

  function handleSharedRealtimeInvalidation(event) {
    const detail = event?.detail || {};
    if (String(detail.clientType || '') !== 'admin') return;
    const scope = String(detail.scope || '');
    const type = String(detail.eventType || '');
    if ((scope !== 'all' && scope !== 'admin') || !type.startsWith('booking.')) return;
    if (state.realtimeTimer !== null) return;
    state.realtimeTimer = window.setTimeout(() => {
      state.realtimeTimer = null;
      if (state.loading || state.busy) {
        state.refreshQueued = true;
        return;
      }
      const catalogInvalidation = type.startsWith('booking.db.booking_services.')
        || type.startsWith('booking.db.booking_service_types.');
      if (els.bookingPanel?.classList.contains('hidden')) {
        if (catalogInvalidation) refreshAll(false, false);
        else refreshBookingBadge();
      } else refreshAll(false, true);
    }, 500);
  }

  function setupRealtime() {
    if (isBackgroundE2ERunner() || state.realtimeListening) return;
    window.addEventListener('member-system:realtime-invalidation', handleSharedRealtimeInvalidation);
    state.realtimeListening = true;
  }

  function teardownRealtime() {
    if (state.realtimeTimer !== null) window.clearTimeout(state.realtimeTimer);
    state.realtimeTimer = null;
    if (state.realtimeListening) {
      window.removeEventListener('member-system:realtime-invalidation', handleSharedRealtimeInvalidation);
      state.realtimeListening = false;
    }
  }

  function actionButton(label, className, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    button.dataset.bookingAdminAction = String(label || 'action');
    button.addEventListener('click', handler);
    return button;
  }

  function bookingBenefitPresentation(benefit) {
    const kind = String(benefit?.kind || '');
    const kindLabel = ({ points: '集點卡票券', event: '活動票券', calendar: '會員活動' })[kind] || '預約票券';
    let sourceTitle = String(benefit?.cardTitle || '').trim();
    let ticketTitle = String(benefit?.title || '可用權益').trim() || '可用權益';

    if (kind === 'points') {
      const separator = ticketTitle.indexOf('｜');
      if (!sourceTitle && separator > 0) {
        sourceTitle = ticketTitle.slice(0, separator).trim();
        ticketTitle = ticketTitle.slice(separator + 1).trim() || '集點卡票券';
      } else if (sourceTitle && ticketTitle.startsWith(`${sourceTitle}｜`)) {
        ticketTitle = ticketTitle.slice(sourceTitle.length + 1).trim() || '集點卡票券';
      }
    }

    const status = String(benefit?.status || 'pending');
    let statusLabel = ({ pending: '待核銷', redeemed: '已核銷', applied: '已核銷', cancelled: '已取消' })[status] || status;
    if (status === 'cancelled' && benefit?.cancellationReason === 'booking_services_changed') statusLabel = '項目變更，已解除綁定';
    return { kind, kindLabel, sourceTitle, ticketTitle, status, statusLabel };
  }

  function bookingBenefitKindLabel(benefit) {
    return bookingBenefitPresentation(benefit).kindLabel;
  }

  function bookingBenefitDisplayTitle(benefit) {
    const view = bookingBenefitPresentation(benefit);
    return view.sourceTitle ? `${view.sourceTitle}｜${view.ticketTitle}` : view.ticketTitle;
  }

  function renderBookingBenefitCards(benefits) {
    const rows = (Array.isArray(benefits) ? benefits : [])
      .filter((benefit) => benefit?.kind === 'points' || benefit?.kind === 'event');
    if (!rows.length) return null;

    const section = document.createElement('section');
    section.className = 'booking-ticket-summary';
    section.setAttribute('aria-label', '使用票券');

    const heading = document.createElement('div');
    heading.className = 'booking-ticket-summary-heading';
    const headingTitle = document.createElement('strong');
    headingTitle.textContent = '使用票券';
    const count = document.createElement('span');
    count.className = 'booking-ticket-count';
    count.textContent = `${rows.length} 張`;
    heading.append(headingTitle, count);

    const grid = document.createElement('div');
    grid.className = 'booking-ticket-grid';

    rows.forEach((benefit) => {
      const view = bookingBenefitPresentation(benefit);
      const ticket = document.createElement('article');
      ticket.className = `booking-ticket-card kind-${view.kind || 'other'}`;

      const top = document.createElement('div');
      top.className = 'booking-ticket-card-top';
      const kind = document.createElement('span');
      kind.className = 'booking-ticket-kind';
      kind.textContent = view.kindLabel;
      const status = document.createElement('span');
      status.className = `booking-ticket-status status-${view.status || 'pending'}`;
      status.textContent = view.statusLabel;
      top.append(kind, status);

      const body = document.createElement('div');
      body.className = 'booking-ticket-body';

      if (view.kind === 'points' && view.sourceTitle) {
        const sourceField = document.createElement('div');
        sourceField.className = 'booking-ticket-field booking-ticket-source';
        const sourceLabel = document.createElement('small');
        sourceLabel.textContent = '來源集點卡';
        const sourceValue = document.createElement('strong');
        sourceValue.textContent = view.sourceTitle;
        sourceField.append(sourceLabel, sourceValue);
        body.appendChild(sourceField);
      }

      const titleField = document.createElement('div');
      titleField.className = 'booking-ticket-field';
      const titleLabel = document.createElement('small');
      titleLabel.textContent = '票券名稱';
      const titleValue = document.createElement('strong');
      titleValue.textContent = view.ticketTitle;
      titleField.append(titleLabel, titleValue);
      body.appendChild(titleField);

      ticket.append(top, body);
      grid.appendChild(ticket);
    });

    section.append(heading, grid);
    return section;
  }

  function appendNote(card, text, admin) {
    const note = document.createElement('p');
    note.className = `booking-admin-note${admin ? ' admin' : ''}`;
    note.textContent = text;
    card.appendChild(note);
  }

  function showModal() { els.bookingAdminCrudModal.classList.remove('hidden'); }
  function closeModal() { if (!state.busy) els.bookingAdminCrudModal.classList.add('hidden'); }
  function setSyncStatus(message, error) { els.bookingAdminSyncStatus.textContent = message; els.bookingAdminSyncStatus.classList.toggle('error', Boolean(error)); }
  function showMessage(element, message, type) { if (!element) return; element.textContent = message; element.className = `form-message ${type || ''}`; }
  function clearMessage(element) { if (!element) return; element.textContent = ''; element.className = 'form-message hidden'; }
  function formatDate(value) { const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '')); return match ? `${Number(match[1])}/${Number(match[2])}/${Number(match[3])}` : String(value || '—'); }
  function formatMoney(value) { const amount = Number(value || 0); return `NT$${Number.isFinite(amount) ? Math.max(0, Math.trunc(amount)).toLocaleString('zh-Hant-TW') : '0'}`; }
  function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char])); }
  function escapeAttr(value) { return escapeHtml(value); }
})();
