(() => {
  'use strict';

  // Presentation state only. Authentication and permissions stay on the server.
  const TAIPEI_DATE = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' });
  const SURFACES = {
    memberSetup: [
      { selector: '#profileForm', title: '先完成會員資料', description: '首次加入會員需要填寫基本資料並同意目前版本的會員條款。這些資料會用於會員識別、聯絡與預約。' },
      { selector: '#profileSurname', title: '填寫姓氏', description: '姓氏會和稱謂組合成預約稱呼，例如「王先生」。' },
      { selector: '#profileSalutation', title: '選擇稱謂', description: '請選擇先生或小姐；之後仍可在會員卡的個人資料中修改。' },
      { selector: '#profileBirthdayPickerButton', title: '設定生日', description: '點擊生日欄位後，在同一個視窗選擇完整的年月日。' },
      { selector: '#profilePhone', title: '填寫聯絡電話', description: '電話會作為會員聯絡與預約資料，送出前請再次確認。' },
      { selector: '#profileSetupView .terms-box', title: '閱讀並同意會員條款', description: '請先閱讀管理員目前發佈的使用同意與免責聲明，再勾選同意。' },
      { selector: '#saveProfileButton', title: '完成加入會員', description: '資料確認無誤後送出。加入成功後會開啟會員卡，並接續會員卡功能教學。' },
    ],
    member: [
      { selector: '#memberPass', title: '這是你的會員卡', description: '在這裡確認會員狀態、姓名與目前階級。' },
      { selector: '#membershipProgress', title: '查看升等進度', description: '服務時間會累積在這裡，下一個會員階級也會顯示在此。' },
      { selector: '.profile-details', title: '確認個人資料', description: '可以查看會員編號、聯絡資料，也能修改稱呼、生日和電話。' },
      { selector: '#memberFeatureLinks', title: '探索其他功能', description: '從這裡前往集點卡、活動票券、活動日曆與預約服務。' },
    ],
    points: [
      { selector: '#membershipProgress', title: '查看會員階級', description: '先確認目前階級與下一階段所需的服務時間。' },
      { selector: '#cardTabs button', title: '切換集點卡', description: '有多張卡片時，從這裡選擇要查看的集點卡。' },
      { selector: '#activeCardView:not(.hidden)', title: '查看集點進度', description: '這裡顯示目前點數、使用期限與優惠說明。' },
      { selector: '.tickets-panel', title: '查看可用票券', description: '集點卡票券在這裡查看；使用前請確認票券詳情。' },
      { selector: '#ticketHistoryDisclosure', title: '查看使用紀錄', description: '需要查詢已使用的票券時，可以展開紀錄。' },
    ],
    event: [
      { selector: '#membershipProgress', title: '確認會員資格', description: '部分活動依會員階級開放，先在這裡確認目前階級。' },
      { selector: '.event-toolbar', title: '查看活動狀態', description: '這裡會顯示目前開放的票券及已使用紀錄數量。' },
      { selector: '#eventList .event-ticket button', title: '查看並使用活動票券', description: '「查看並使用」先開啟詳情，不會自動領取或核銷。請確認期間、會員階級與預約項目；領取後選擇已確認且符合條件的預約，最後按確認使用才會核銷。預約頁勾選未領取票券時，會先提醒勾選等於領取。' },
      { selector: '#usedTicketHistory:not(.hidden)', title: '查詢核銷紀錄', description: '已使用的票券與結果保留在這裡。' },
      { selector: '#emptyView:not(.hidden)', title: '尚無開放活動', description: '有新的活動票券時，會顯示在這個區域。' },
    ],
    calendar: [
      { selector: '#membershipProgress', title: '確認會員階級', description: '會員階級與累積服務時間會顯示在這裡。' },
      { selector: '.calendar-toolbar', title: '切換月份', description: '使用左右按鈕切換月份，也可以回到本月。' },
      { selector: '#calendarGrid', title: '查看休假日與活動', description: '有活動或休假的日期可點開查看詳細內容。' },
    ],
    booking: [
      { selector: '#membershipProgress', title: '確認會員階級', description: '預約前可先查看會員階級與服務時間進度。' },
      { selector: '.booking-accessible-switch', title: '選擇操作模式', description: '一般模式可選日期、項目、技師與票券；大字拍收據模式可上傳收據，由管理員登記服務。切換會保留未送出的草稿。' },
      { selector: '#bookingNotice', title: '閱讀預約說明', description: '請先確認店家公告與可預約時段規則。' },
      { selector: '#calendarGrid button', title: '選擇預約日期', description: '點選可預約日期後，再選服務與時間；送出前會再次確認。' },
      { selector: '#bookingView .booking-card[aria-labelledby="myBookingsTitle"]', title: '查看我的預約', description: '已預約、已完成與已取消的紀錄都會顯示在這裡。' },
    ],
  };
  let surface = '';
  let activeSurface = '';
  let STEPS = [];
  let setupView = null;
  const ui = {};
  let active = false;
  let stepIndex = 0;
  let storageKey = '';
  let checkedKey = '';
  let opener = null;
  let identityGeneration = 0;
  let autoOpenObserver = null;
  let activeObserver = null;
  let positionFrame = null;

  document.addEventListener('DOMContentLoaded', () => {
    ui.view = document.querySelector('main[data-user-tour]');
    surface = ui.view?.dataset.userTour || '';
    activeSurface = surface;
    STEPS = SURFACES[surface] || [];
    if (!STEPS.length) return;
    installControls();
    ui.surfaceView = ui.view;
    ui.app = document.getElementById('app') || document.querySelector('.app-shell');
    setupView = surface === 'member' ? document.getElementById('profileSetupView') : null;
    ui.memberTourMasks = Array.from(document.querySelectorAll('[data-member-tour-mask]'));
    for (const id of ['openMemberTour', 'memberTourOverlay', 'memberTourFocus', 'memberTourDialog', 'memberTourTitle', 'memberTourDescription', 'memberTourProgress', 'memberTourSkip', 'memberTourBack', 'memberTourNext']) {
      ui[id] = document.getElementById(id);
    }
    if (Object.values(ui).some((element) => !element)) return;
    ui.openMemberTour.addEventListener('click', () => open(ui.openMemberTour));
    ui.memberTourOverlay.addEventListener('click', (event) => {
      event.preventDefault();
      // A background tap is not consent to skip the tour for the day.
      ui.memberTourTitle.focus();
    });
    ui.memberTourSkip.addEventListener('click', () => close('skip'));
    ui.memberTourBack.addEventListener('click', () => move(-1));
    ui.memberTourNext.addEventListener('click', () => {
      if (stepIndex === STEPS.length - 1) close('complete');
      else move(1);
    });
    ui.memberTourDialog.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close('dismiss'); }
      if (event.key !== 'Tab') return;
      const focusable = [document.getElementById('memberTourDismiss'), ui.memberTourSkip, ui.memberTourBack, ui.memberTourNext].filter((button) => !button.disabled);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === ui.memberTourTitle)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    });
    window.addEventListener('resize', queuePositionFocus);
    window.addEventListener('scroll', queuePositionFocus, true);
    window.addEventListener('pagehide', () => { identityGeneration += 1; close('dismiss'); });
    window.addEventListener('pagehide', stopAutoOpenObserver, { once: true });
    window.addEventListener('beforeunload', stopAutoOpenObserver, { once: true });
    window.addEventListener('member-profile-ready', (event) => { void considerProfile(event.detail?.profile); });
    window.addEventListener('user-tour:ready', (event) => { if (event.detail?.surface === surface) void considerProfile(event.detail.profile); });
  });

  function installControls() {
    if (!document.getElementById('openMemberTour')) {
      const button = document.createElement('button');
      button.id = 'openMemberTour';
      button.type = 'button';
      button.className = 'text-button';
      button.textContent = '使用教學';
      button.setAttribute('aria-haspopup', 'dialog');
      button.setAttribute('aria-controls', 'memberTourDialog');
      const menu = ui.view.querySelector('.account-menu');
      menu?.insertBefore(button, menu.querySelector('#logoutButton'));
    }
    const existingOverlay = document.getElementById('memberTourOverlay');
    if (existingOverlay) ensureTourMasks(existingOverlay);
    if (document.getElementById('memberTourDialog')) { installDismiss(); return; }
    const overlay = document.createElement('div');
    overlay.id = 'memberTourOverlay';
    overlay.className = 'member-tour-overlay hidden';
    overlay.setAttribute('aria-hidden', 'true');
    ensureTourMasks(overlay);
    const focus = document.createElement('div');
    focus.id = 'memberTourFocus';
    focus.className = 'member-tour-focus hidden';
    focus.setAttribute('aria-hidden', 'true');
    const dialog = document.createElement('section');
    dialog.id = 'memberTourDialog';
    dialog.className = 'member-tour-dialog hidden';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'memberTourTitle');
    dialog.setAttribute('aria-describedby', 'memberTourDescription');
    dialog.tabIndex = -1;
    dialog.innerHTML = '<p id="memberTourProgress" class="member-tour-progress" aria-live="polite"></p><h2 id="memberTourTitle" tabindex="-1"></h2><p id="memberTourDescription"></p><div class="member-tour-actions"><button id="memberTourSkip" type="button">不再顯示</button><button id="memberTourBack" type="button">上一步</button><button id="memberTourNext" type="button">下一步</button></div>';
    document.body.append(overlay, focus, dialog);
    installDismiss();
  }

  function installDismiss() {
    const dialog=document.getElementById('memberTourDialog');
    const skip=document.getElementById('memberTourSkip');
    if(skip) skip.textContent='不再顯示';
    if(!dialog || document.getElementById('memberTourDismiss')) return;
    const button=document.createElement('button');button.id='memberTourDismiss';button.type='button';button.className='member-tour-dismiss';button.textContent='關閉';button.setAttribute('aria-label','關閉使用教學');
    button.addEventListener('click',()=>close('dismiss'));dialog.prepend(button);
  }

  function ensureTourMasks(overlay) {
    if (!overlay) return;
    const existing = new Set(Array.from(overlay.querySelectorAll('[data-member-tour-mask]')).map((mask) => mask.dataset.memberTourMask));
    for (const region of ['top', 'right', 'bottom', 'left']) {
      if (existing.has(region)) continue;
      const mask = document.createElement('span');
      mask.className = 'member-tour-mask';
      mask.dataset.memberTourMask = region;
      overlay.append(mask);
    }
  }

  function resolveTourSurface(profile) {
    if (surface === 'member' && setupView && (!profile?.profileComplete || profile?.membershipRequired)) {
      return 'memberSetup';
    }
    return surface;
  }

  function resolveIdentitySeed(profile) {
    // Identity comes from the server-resolved profile. Do not derive tutorial persistence from client credentials or session tokens.
    return String(profile?.lineUserId || '').trim();
  }

  function activateTourSurface(nextSurface) {
    const nextSteps = SURFACES[nextSurface] || [];
    const nextView = nextSurface === 'memberSetup' ? setupView : ui.surfaceView;
    if (!nextSteps.length || !nextView) return false;
    if (active && activeSurface !== nextSurface) close('switch');
    activeSurface = nextSurface;
    STEPS = nextSteps;
    ui.view = nextView;
    return true;
  }

  async function considerProfile(profile) {
    const nextSurface = resolveTourSurface(profile);
    if (!activateTourSurface(nextSurface)) return;

    const identitySeed = resolveIdentitySeed(profile);
    if (!identitySeed) return;
    const generation = ++identityGeneration;
    let key = '';
    try {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identitySeed));
      const identityHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
      // Keep the published member key so today's earlier skip still applies; onboarding uses an independent key.
      key = nextSurface === 'memberSetup'
        ? `member-setup-tour:${identityHash}`
        : nextSurface === 'member'
          ? `member-tour:${identityHash}`
          : `user-tour:${nextSurface}:${identityHash}`;
    } catch (_) {
      // Web Crypto can be unavailable in some embedded browsers. Manual replay remains available after setup.
      return;
    }
    if (generation !== identityGeneration || !window.document?.body) return;
    if (storageKey && storageKey !== key && active) close('switch');
    storageKey = key;
    ui.memberTourDialog.dataset.storageKey = key;
    if (checkedKey === key) return;
    checkedKey = key;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { /* storage blocked */ }
    const skippedAt = saved?.skippedAt || (saved?.outcome === 'skip' ? saved.completedAt : null);
    const explicitSkip = saved?.outcome === 'skip' && saved?.source === 'explicit';
    if(saved?.version===2 && saved?.disabled===true && saved?.source==='explicit') return;
    const isPairedE2ERunner = new URLSearchParams(window.location?.search || '').has('qaPair');
    if (!isPairedE2ERunner && explicitSkip && skippedAt && taipeiDay(new Date(skippedAt)) === taipeiDay(new Date())) return;
    // Test accounts follow the same tutorial rules as real members. Paired E2E explicitly validates and dismisses the tour.
    queueAutoOpen(generation, key);
  }

  function stopAutoOpenObserver() {
    if (autoOpenObserver) autoOpenObserver.disconnect();
    autoOpenObserver = null;
  }

  function queueAutoOpen(generation, key) {
    stopAutoOpenObserver();
    const doc = window.document;
    if (!doc?.body || generation !== identityGeneration) return;
    const attempt = () => {
      if (generation !== identityGeneration || storageKey !== key) {
        stopAutoOpenObserver();
        return;
      }
      if (ui.view.classList.contains('hidden') || otherDialogOpen()) return;
      if (open(null)) {
        stopAutoOpenObserver();
      }
    };
    autoOpenObserver = new MutationObserver(attempt);
    autoOpenObserver.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'hidden', 'aria-hidden'] });
    // Hidden/background tabs may pause requestAnimationFrame. Auto-start is functional state,
    // so attempt synchronously and keep rAF only as a visual/lifecycle refinement.
    attempt();
    if (autoOpenObserver) requestAnimationFrame(attempt);
  }

  function available(index) {
    const doc = window.document;
    if (!doc || typeof doc.querySelector !== 'function') return null;
    const element = doc.querySelector(STEPS[index].selector);
    return element && element.isConnected && !element.closest('.hidden,[hidden]') ? element : null;
  }

  function taipeiDay(date) {
    return Number.isNaN(date.getTime()) ? '' : TAIPEI_DATE.format(date);
  }

  function otherDialogOpen() {
    const doc = window.document;
    if (!doc || typeof doc.querySelectorAll !== 'function') return false;
    return Array.from(doc.querySelectorAll('[aria-modal="true"]')).some((dialog) =>
      dialog !== ui.memberTourDialog && !dialog.closest('.hidden,[hidden]')
    );
  }

  function findStep(from, direction) {
    for (let index = from; index >= 0 && index < STEPS.length; index += direction) {
      if (available(index)) return index;
    }
    return -1;
  }

  function open(trigger) {
    if (active) return true;
    if (ui.view.classList.contains('hidden') || otherDialogOpen()) return false;
    const first = findStep(0, 1);
    if (first < 0) return false; // DOM may still be loading: wait for the next mutation.
    opener = trigger;
    stepIndex = first;
    active = true;
    ui.memberTourOverlay.classList.remove('hidden');
    ui.memberTourDialog.classList.remove('hidden');
    ui.app.inert = true;
    activeObserver = new MutationObserver(() => {
      if (!active) return;
      if (ui.view.classList.contains('hidden')) close('missing');
      else if (!available(stepIndex)) renderStep({ scroll: false });
    });
    activeObserver.observe(ui.view, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'hidden'] });
    renderStep({ scroll: true });
    return true;
  }

  function move(direction) {
    const next = findStep(stepIndex + direction, direction);
    if (next < 0) {
      if (direction > 0) close('complete');
      return;
    }
    stepIndex = next;
    renderStep({ scroll: true });
  }

  function renderStep(options = {}) {
    if (!active) return;
    const target = available(stepIndex);
    if (!target) {
      const next = findStep(stepIndex + 1, 1);
      if (next < 0) { close('missing'); return; }
      stepIndex = next;
      renderStep(options);
      return;
    }
    const step = STEPS[stepIndex];
    const visibleSteps = STEPS.map((_, index) => index).filter((index) => available(index));
    const visiblePosition = visibleSteps.indexOf(stepIndex) + 1;
    ui.memberTourProgress.textContent = `使用教學 ${visiblePosition} / ${visibleSteps.length}`;
    ui.memberTourDialog.style.setProperty('--member-tour-progress', `${Math.round((visiblePosition / visibleSteps.length) * 100)}%`);
    ui.memberTourTitle.textContent = step.title;
    ui.memberTourDescription.textContent = step.description;
    ui.memberTourBack.disabled = findStep(stepIndex - 1, -1) < 0;
    ui.memberTourNext.textContent = findStep(stepIndex + 1, 1) < 0 ? '完成' : '下一步';
    if (options.scroll !== false) target.scrollIntoView?.({ block: 'center', behavior: 'instant' });
    // Geometry must exist even when the page is backgrounded and rAF is throttled.
    positionFocus();
    queuePositionFocus();
    ui.memberTourTitle.focus();
  }

  function queuePositionFocus() {
    if (!active) return;
    // Keep only the newest geometry request. Cancelling a stale frame also makes
    // resize/scroll recovery deterministic when the browser throttles rAF.
    if (positionFrame !== null) cancelAnimationFrame(positionFrame);
    positionFrame = requestAnimationFrame(() => {
      positionFrame = null;
      positionFocus();
    });
  }

  function positionFocus() {
    if (!active) return;
    if (ui.view.classList.contains('hidden')) { close('missing'); return; }
    const target = available(stepIndex);
    if (!target) {
      renderStep({ scroll: false });
      return;
    }
    const box = target.getBoundingClientRect();
    const dialog = ui.memberTourDialog.getBoundingClientRect();
    const edge = innerWidth <= 620 ? 10 : 20;
    const width=dialog.width || Math.max(0,dialog.right-dialog.left);
    const height=dialog.height;
    const candidates=[
      {left:Math.max(edge,innerWidth-edge-width),top:Math.max(edge,innerHeight-edge-height)},
      {left:Math.max(edge,innerWidth-edge-width),top:edge},
      {left:edge,top:Math.max(edge,innerHeight-edge-height)},
      {left:edge,top:edge},
    ];
    const overlap=p=>Math.max(0,Math.min(box.right,p.left+width)-Math.max(box.left,p.left))*Math.max(0,Math.min(box.bottom,p.top+height)-Math.max(box.top,p.top));
    candidates.sort((a,b)=>overlap(a)-overlap(b));const position=candidates[0];
    ui.memberTourDialog.classList.toggle('member-tour-dialog-top',position.top===edge);
    Object.assign(ui.memberTourDialog.style,{left:position.left+'px',top:position.top+'px',right:'auto',bottom:'auto'});
    if (box.bottom <= 0 || box.top >= innerHeight || box.right <= 0 || box.left >= innerWidth) {
      ui.memberTourFocus.classList.add('hidden');
      positionMasks(null);
      return;
    }
    const focusBox = {
      left: Math.max(4, box.left - 5),
      top: Math.max(4, box.top - 5),
      right: Math.min(innerWidth - 4, box.right + 5),
      bottom: Math.min(innerHeight - 4, box.bottom + 5),
    };
    const frame = ui.memberTourFocus.style;
    frame.left = `${focusBox.left}px`;
    frame.top = `${focusBox.top}px`;
    frame.width = `${Math.max(0, focusBox.right - focusBox.left)}px`;
    frame.height = `${Math.max(0, focusBox.bottom - focusBox.top)}px`;
    positionMasks(focusBox);
    ui.memberTourFocus.classList.remove('hidden');
  }

  function positionMasks(focusBox) {
    const masks = Array.isArray(ui.memberTourMasks) ? ui.memberTourMasks : [];
    if (masks.length !== 4) return;
    const byRegion = Object.fromEntries(masks.map((mask) => [mask.dataset.memberTourMask, mask]));
    if (!focusBox) {
      byRegion.top.style.cssText = 'left:0;top:0;right:0;bottom:0';
      for (const region of ['right', 'bottom', 'left']) byRegion[region].style.cssText = 'display:none';
      return;
    }
    const gap = innerWidth <= 620 ? 7 : 10;
    const left = Math.max(0, focusBox.left - gap);
    const top = Math.max(0, focusBox.top - gap);
    const right = Math.min(innerWidth, focusBox.right + gap);
    const bottom = Math.min(innerHeight, focusBox.bottom + gap);
    const height = Math.max(0, bottom - top);
    byRegion.top.style.cssText = `display:block;left:0;top:0;right:0;height:${top}px`;
    byRegion.bottom.style.cssText = `display:block;left:0;top:${bottom}px;right:0;bottom:0`;
    byRegion.left.style.cssText = `display:block;left:0;top:${top}px;width:${left}px;height:${height}px`;
    byRegion.right.style.cssText = `display:block;left:${right}px;top:${top}px;right:0;height:${height}px`;
  }

  function close(outcome) {
    if (!active) return;
    active = false;
    activeObserver?.disconnect();
    activeObserver = null;
    if (positionFrame !== null) cancelAnimationFrame(positionFrame);
    positionFrame = null;
    ui.memberTourOverlay.classList.add('hidden');
    ui.memberTourFocus.classList.add('hidden');
    positionMasks(null);
    ui.memberTourDialog.classList.add('hidden');
    ui.memberTourDialog.classList.remove('member-tour-dialog-top');
    ui.memberTourDialog.style.removeProperty('--member-tour-progress');
    for(const property of ['left','top','right','bottom']) ui.memberTourDialog.style.removeProperty(property);
    ui.app.inert = false;
    if (storageKey) {
      try {
        if (outcome === 'skip') localStorage.setItem(storageKey, JSON.stringify({ version:2,disabled:true,skippedAt: new Date().toISOString(), outcome, source: 'explicit' }));
        // Completing a manual replay preserves permanent opt-out. Legacy daily skips may expire.
        if (outcome === 'complete') { const saved=JSON.parse(localStorage.getItem(storageKey)||'null');if(saved?.disabled!==true) localStorage.removeItem(storageKey); }
      } catch (_) { /* optional UX state */ }
    }
    const focusTarget = opener?.isConnected
      ? opener
      : activeSurface === 'memberSetup'
        ? ui.view.querySelector('input:not([type="hidden"]), select, button:not([disabled])')
        : ui.openMemberTour;
    opener = null;
    focusTarget?.focus();
  }
})();
