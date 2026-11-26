(() => {
  'use strict';

  const booking = Boolean(window.BookingSystem);
  let profile = null, profileContext = '', generation = 0, loading = false, busy = false;
  let selectedCode = '', lockedRecipient = null, pendingCode = '', invitationUrl = '';

  const el = id => document.getElementById(id);
  const input = () => el('friendLookupCode');

  function session() {
    return booking ? window.BookingSystem.getSession() : window.MemberSystem.getSession('member');
  }

  async function request(operation, code = '') {
    const current = session();
    if (!current) throw new Error('登入狀態已失效，請重新整理。');
    if (!booking) {
      return window.MemberSystem.request(
        current.config,
        'member',
        current.idToken,
        'member.friend.' + operation,
        { memberCode: code }
      );
    }
    const body = {
      clientType: 'booking',
      idToken: current.idToken,
      action: 'member.friend.' + operation,
      memberCode: code,
    };
    const response = await fetch(
      current.config.supabaseUrl.replace(/\/$/, '') + '/functions/v1/member-growth-api',
      {
        method: 'POST',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          apikey: current.config.supabasePublishableKey,
        },
        body: JSON.stringify(window.TestModeClient?.payload ? window.TestModeClient.payload(body) : body),
      }
    );
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error?.message || '好友資料載入失敗。');
    return result.data;
  }

  function status(message, state = 'info', target = 'action') {
    const ids = target === 'friends' ? ['friendListStatus'] : ['friendStatus'];
    for (const id of ids) {
      const node = el(id);
      if (!node) continue;
      node.textContent = message;
      node.dataset.state = message ? state : '';
    }
  }

  function stopScan() { /* Legacy callers may request cleanup; manual input has no camera. */ }
  function parseMemberCode(value) {
    const code = String(value || '').trim().toUpperCase();
    if (!/^[A-Z0-9_-]{4,40}$/.test(code)) throw new Error('請輸入有效的會員編號。');
    return code;
  }

  function selectMemberTab(name) {
    if (booking) return;
    el(name === 'reward' ? 'openMemberReferral' : 'openMemberFriends')?.click();
  }

  function installMemberTabs(modal, rewardForm) {
    if (el('memberFriendsModal')) return { friendsPanel: el('memberReferralFriendsTabPanel') };
    const pass = el('memberPass');
    if (!pass || !modal || !rewardForm) return null;
    const friendsModal = document.createElement('div');
    friendsModal.id = 'memberFriendsModal';
    friendsModal.className = 'member-referral-modal hidden';
    friendsModal.setAttribute('role', 'dialog');
    friendsModal.setAttribute('aria-modal', 'true');
    friendsModal.setAttribute('aria-labelledby', 'memberFriendsTitle');
    friendsModal.innerHTML = '<section class="member-referral-dialog"><div class="member-referral-heading"><h2 id="memberFriendsTitle">好友中心</h2><button id="closeMemberFriends" type="button" class="member-referral-close" aria-label="關閉好友中心">×</button></div><section id="memberReferralFriendsTabPanel"></section></section>';
    document.body.append(friendsModal);
    const trigger = document.createElement('button');
    trigger.id = 'openMemberFriends'; trigger.type = 'button';
    trigger.className = 'member-referral-trigger'; trigger.textContent = '好友';
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-controls', friendsModal.id);
    const actions = el('memberPassActions') || pass;
    actions.insertBefore(trigger, el('openMemberReferral') || null);
    const shell = document.querySelector('.app-shell');
    let previousInert = null;
    const closeFriends = () => {
      stopScan();
      friendsModal.classList.add('hidden');
      if (shell && previousInert !== null) { shell.inert = previousInert; previousInert = null; }
      trigger.setAttribute('aria-expanded', 'false'); trigger.focus();
    };
    trigger.addEventListener('click', () => {
      window.MemberReferral?.close();
      if (shell && previousInert === null) { previousInert = shell.inert; shell.inert = true; }
      friendsModal.classList.remove('hidden'); trigger.setAttribute('aria-expanded', 'true');
      friendsModal.tabIndex = -1; friendsModal.focus({preventScroll:true});
    });
    el('closeMemberFriends').addEventListener('click', closeFriends);
    friendsModal.addEventListener('click', event => { if (event.target === friendsModal) closeFriends(); });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !friendsModal.classList.contains('hidden')) { event.preventDefault(); closeFriends(); }
    });
    const rewardPanel = document.createElement('section');
    rewardPanel.id = 'memberReferralRewardTabPanel';
    rewardForm.before(rewardPanel); rewardPanel.append(rewardForm);
    return { friendsPanel: el('memberReferralFriendsTabPanel') };
  }


  function installBookingFriendsModal(main) {
    const bookingFriendsModal = document.createElement('section');
    bookingFriendsModal.id = 'bookingFriendsModal';
    bookingFriendsModal.className = 'booking-modal booking-friends-modal hidden';
    bookingFriendsModal.setAttribute('role', 'dialog');
    bookingFriendsModal.setAttribute('aria-modal', 'true');
    bookingFriendsModal.setAttribute('aria-labelledby', 'bookingFriendsTitle');
    bookingFriendsModal.innerHTML = '<div class="booking-modal-card booking-friends-card"><div class="booking-modal-heading"><div><p class="kicker">My friends</p><h2 id="bookingFriendsTitle">我的好友名單</h2></div><button id="closeBookingFriends" type="button" class="booking-modal-close" aria-label="關閉好友名單">×</button></div><p id="friendListStatus" class="friend-feedback" role="status" aria-live="polite"></p><div id="friendList" class="booking-friends-list"></div><div id="friendReceivedBookings" class="booking-friends-bookings"></div></div>';
    main.append(bookingFriendsModal);
    const trigger = el('openBookingFriends');
    const close = () => {
      bookingFriendsModal.classList.add('hidden');
      trigger.setAttribute('aria-expanded', 'false');
      trigger.focus();
    };
    trigger.addEventListener('click', () => {
      if (!profile) return;
      bookingFriendsModal.classList.remove('hidden');
      trigger.setAttribute('aria-expanded', 'true');
      el('closeBookingFriends').focus();
      status('正在更新好友名單…', 'loading', 'friends');
      void refresh(false);
    });
    el('closeBookingFriends').addEventListener('click', close);
    bookingFriendsModal.addEventListener('click', event => {
      if (event.target === bookingFriendsModal) close();
    });
    bookingFriendsModal.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
    });
  }

  function invalidate() {
    pendingCode = '';
    stopScan();
    if (el('confirmFriendRequest')) el('confirmFriendRequest').hidden = true;
  }

  async function lookup() {
    if (!profile || busy) return;
    const field = input();
    if (!field) return;

    const current = generation;
    const entered = field.value;
    invalidate();
    busy = true;
    status('正在查找好友…', 'loading');
    const finishFeedback=window.AsyncActionFeedback?.begin('正在查找好友資料…');
    const button = el('lookupFriend');
    if (button) button.disabled = true;

    try {
      const code = parseMemberCode(entered);
      if ([profile.inviteCode, profile.memberCode]
        .map(value => String(value || '').toUpperCase())
        .includes(code)) {
        throw new Error('不可使用自己的邀請碼或會員編號。');
      }
      const found = await request('lookup', code);
      if (current !== generation || entered !== field.value) return;
      pendingCode = found.memberCode;
      status(
        `查找好友成功：${found.displayName} · ${found.memberCode}。確認後會送出好友邀請，需等待對方接受。`,
        'success'
      );
      el('confirmFriendRequest').hidden = false;
    } catch (error) {
      if (current === generation && entered === field.value) {
        status(
          `查找好友失敗：${error?.message || '請確認會員編號後重試。'}`,
          'error'
        );
      }
    } finally {
      finishFeedback?.();
      if (current === generation) busy = false;
      if (button) button.disabled = false;
    }
  }

  function install() {
    if (el('friendsPanel')) return;

    if (booking) {
      const main = el('bookingView');
      if (!main) return;
      const panel = document.createElement('section');
      panel.id = 'friendsPanel';
      panel.className = 'friends-panel booking-recipient';
      panel.innerHTML = '<div class="booking-recipient-heading"><label for="friendBookingRecipient">服務對象</label><div class="booking-recipient-actions"><button id="openBookingFriends" type="button" class="button booking-manage-friends" aria-haspopup="dialog" aria-controls="bookingFriendsModal" aria-expanded="false"><span class="booking-friends-icon" aria-hidden="true">👥</span>管理好友</button><button id="refreshFriends" type="button" class="button button-refresh">更新好友</button></div></div><select id="friendBookingRecipient" aria-describedby="friendStatus"><option value="">本人</option></select><details class="booking-recipient-help"><summary>代好友預約說明</summary><p>好友接受邀請後可代約單人服務。<span data-member-any="points events">票券由建立者選用自己的票券；</span>完成服務後，好友取得正常<span data-member-requires="points">點數與</span>服務分鐘，代約者取得<span data-member-requires="points">每種已設定集點規則的服務類型 1 點及</span>一半服務分鐘（不足 1 分鐘向下取整）。</p></details><p id="friendStatus" class="friend-feedback" role="status" aria-live="polite"></p>';
      (el('bookingRecipientHost') || el('bookingNotice')?.parentElement)?.append(panel);
      installBookingFriendsModal(main);
      el('friendBookingRecipient').addEventListener('change', event => {
        selectedCode = event.target.value;
        status(selectedCode ? '將替所選好友預約；送出前請再次確認受服務者。' : '本次為本人預約。');
      });
    } else {
      const modal = window.MemberReferral?.ensureUi();
      if (!modal) return;
      const rewardForm = el('memberReferralForm');
      const tabs = installMemberTabs(modal, rewardForm);
      if (!tabs) return;

      const addForm = document.createElement('form');
      addForm.id = 'friendAddForm';
      addForm.className = 'member-referral-section friend-add-section';
      addForm.noValidate = true;
      addForm.innerHTML = '<strong>加好友</strong><label for="friendLookupCode">好友會員編號</label><input id="friendLookupCode" type="text" maxlength="40" autocomplete="off" inputmode="text" placeholder="輸入好友的會員編號" aria-describedby="friendLookupHelp"><small id="friendLookupHelp">輸入會員編號查找並邀請好友；此操作不會觸發邀請優惠。</small><div class="friend-actions"><button id="lookupFriend" type="submit" class="button button-dark">查找好友</button><button id="confirmFriendRequest" type="button" class="button button-dark" hidden>確認送出好友邀請</button></div>';

      const message = document.createElement('p');
      message.id = 'friendStatus';
      message.className = 'friend-feedback';
      message.setAttribute('role', 'status');
      message.setAttribute('aria-live', 'polite');

      const panel = document.createElement('section');
      panel.id = 'friendsPanel';
      panel.className = 'friends-panel';
      panel.innerHTML = '<div class="friends-panel-heading"><h3>我的好友</h3><button id="refreshFriends" type="button" class="button button-refresh">更新好友</button></div><p id="friendListStatus" class="friend-feedback" role="status" aria-live="polite"></p><div id="friendList"></div><div id="friendReceivedBookings"></div>';

      tabs.friendsPanel.append(addForm, message, panel);

      addForm.addEventListener('submit', event => {
        event.preventDefault();
        void lookup();
      });
      input().addEventListener('input', invalidate);
      el('confirmFriendRequest').addEventListener('click', async event => {
        if (busy || !pendingCode) return;
        const current = generation;
        const button = event.currentTarget;
        busy = true;
        button.disabled = true;
        const finishFeedback=window.AsyncActionFeedback?.begin('正在送出好友邀請…');
        stopScan();
        try {
          const result = await request('request', pendingCode);
          if (current !== generation) return;
          status(result.status === 'accepted' ? '已是好友。' : '好友邀請已送出，等待對方接受。', 'success');
          button.hidden = true;
          await refresh(false);
        } catch (error) {
          if (current === generation) status(error?.message || '好友邀請暫時無法送出。', 'error');
        } finally {
          finishFeedback?.();
          if (current === generation) busy = false;
          button.disabled = false;
        }
      });

    }

    el('refreshFriends').addEventListener('click', () => void refresh());
  }

  async function copyInvitationLink() {
    const url = invitationUrl;
    const current = generation;
    if (!url) {
      status('會員編號仍在同步，請稍後再試。', 'error');
      return;
    }
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(url);
      if (current === generation) status('好友邀請連結已複製。', 'success');
    } catch (_) {
      if (current !== generation) return;
      const field = document.createElement('textarea');
      field.value = url;
      field.className = 'friend-copy-buffer';
      el('memberFriendsModal')?.append(field);
      field.select();
      let copied = false;
      try { copied = document.execCommand?.('copy') === true; } catch (_) { /* report below */ }
      field.remove();
      el('copyFriendInviteLink')?.focus();
      status(
        copied ? '好友邀請連結已複製。' : '無法複製好友邀請連結，請手動輸入對方的會員編號。',
        copied ? 'success' : 'error'
      );
    }
  }

  function renderFriendList(result) {
    const list = el('friendList');
    if (!list) return;
    list.replaceChildren();

    for (const friend of result.friends || []) {
      const row = document.createElement('article');
      row.className = 'friend-row';
      const copy = document.createElement('div');
      const name = document.createElement('strong');
      const hint = document.createElement('small');
      name.textContent = `${friend.displayName} · ${friend.memberCode}`;
      hint.textContent = friend.status === 'accepted'
        ? '已成為好友，可代約'
        : friend.status === 'blocked'
          ? '已封鎖'
          : friend.incoming
            ? '收到好友邀請'
            : '已送出邀請，等待接受';
      copy.append(name, hint);
      row.append(copy);

      const actions = document.createElement('div');
      actions.className = 'friend-actions';
      const choices = friend.status === 'pending' && friend.incoming
        ? [['accept', '接受'], ['remove', '婉拒'], ['block', '封鎖']]
        : friend.status === 'blocked'
          ? [['remove', '解除封鎖']]
          : [['remove', friend.status === 'pending' ? '撤回邀請' : '解除好友'], ['block', '封鎖']];

      for (const [operation, label] of choices) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'button button-refresh';
        button.textContent = label;
        button.addEventListener('click', async () => {
          const account = generation;
          button.disabled = true;
          const finishFeedback=window.AsyncActionFeedback?.begin('正在更新好友關係…');
          try {
            await request(operation, friend.memberCode);
            if (account !== generation) return;
            status('好友關係已更新。', 'success', 'friends');
            await refresh(false);
          } catch (error) {
            if (account === generation) status(error?.message || '好友關係更新失敗。', 'error', 'friends');
          } finally {
            finishFeedback?.();
            button.disabled = false;
          }
        });
        actions.append(button);
      }

      row.append(actions);
      list.append(row);
    }

    if (!list.children.length) {
      list.textContent = booking ? '目前沒有好友；可至會員卡的好友中心新增好友。' : '目前沒有好友，可用上方「加好友」輸入會員編號。';
    }

    const received = el('friendReceivedBookings');
    received.replaceChildren();
    for (const item of result.receivedBookings || []) {
      const line = document.createElement('p');
      line.textContent = `好友代約服務：${item.bookingDate} ${item.startTime} · ${item.statusLabel} · ${item.serviceTitle}`;
      received.append(line);
    }

  }

  async function refresh(showLoading = true) {
    if (!profile || loading) return;
    loading = true;
    const finishFeedback=showLoading?window.AsyncActionFeedback?.begin('正在更新好友名單…'):null;
    const current = generation;
    const panel = el('friendsPanel');
    panel.dataset.state = 'loading';
    panel.setAttribute('aria-busy', 'true');
    el('refreshFriends').disabled = true;
    if (showLoading) status('正在載入好友…', 'loading', booking ? 'action' : 'friends');

    try {
      const result = await request('list');
      if (current !== generation) return;

      renderFriendList(result);
      let recipientRemoved = false;
      if (booking) {
        const select = el('friendBookingRecipient');
        if (lockedRecipient) {
          select.replaceChildren(new Option(lockedRecipient.name || '本人', lockedRecipient.code));
          select.value = lockedRecipient.code;
          select.disabled = true;
          panel.dataset.state = 'ready';
          if (showLoading) status('編輯既有預約，服務對象維持原會員。');
          if (!el('bookingFriendsModal')?.classList.contains('hidden')) {
            status('好友名單已更新；既有預約的服務對象不可更換。', 'success', 'friends');
          }
          return;
        }
        select.disabled = false;
        const previous = selectedCode;
        select.replaceChildren(new Option('本人', ''));
        for (const friend of result.friends || []) {
          if (friend.status === 'accepted') {
            select.add(new Option(`${friend.displayName} · ${friend.memberCode}`, friend.memberCode));
          }
        }
        selectedCode = Array.from(select.options).some(option => option.value === previous) ? previous : '';
        select.value = selectedCode;
        recipientRemoved = Boolean(previous && previous !== selectedCode);
        if (recipientRemoved) status('原服務對象已不在有效好友名單中，已改為本人；請重新確認服務對象。', 'error');
      }

      panel.dataset.state = (result.friends || []).length ? 'ready' : 'empty';
      if (showLoading && !recipientRemoved) {
        status(booking && el('friendBookingRecipient').options.length === 1 ? '目前沒有可代約好友，本次為本人預約。' : '好友資料已更新。', 'success', booking ? 'action' : 'friends');
      }
      if (booking && !el('bookingFriendsModal')?.classList.contains('hidden')) {
        status('好友名單已更新。', 'success', 'friends');
      }
    } catch (error) {
      if (current === generation) {
        panel.dataset.state = 'error';
        status(
          error?.message || '好友資料載入失敗，請更新好友重試。',
          'error',
          booking && !el('bookingFriendsModal')?.classList.contains('hidden') ? 'friends' : booking ? 'action' : 'friends'
        );
      }
    } finally {
      finishFeedback?.();
      loading = false;
      panel.setAttribute('aria-busy', 'false');
      if (el('refreshFriends')) el('refreshFriends').disabled = false;
      if (current !== generation && profile) void refresh(false);
    }
  }

  window.addEventListener('focus', () => { if (booking && profile && !document.hidden) void refresh(false); });

  function ready(event) {
    const next = event.detail?.profile;
    if (!next?.lineUserId || next.membershipRequired || next.profileComplete === false || (next.status && next.status !== 'active')) {
      generation++;
      stopScan();
      profile = null;
      profileContext = '';
      busy = false;
      pendingCode = '';
      if (input()) input().value = '';
      invalidate();
      el('friendList')?.replaceChildren();
      el('friendReceivedBookings')?.replaceChildren();
      if (el('friendBookingRecipient')) {
        el('friendBookingRecipient').replaceChildren(new Option('本人', ''));
        el('friendBookingRecipient').disabled = true;
      }
      invitationUrl = '';
      selectedCode = '';
      lockedRecipient = null;
      window.MemberReferral?.close();
      el('closeMemberFriends')?.click();
      el('closeBookingFriends')?.click();
      return;
    }

    const account = session();
    const business = account?.config?.business || window.BusinessContext?.slug || new URL(location.href).searchParams.get('business') || '';
    const nextContext = business + ':' + next.lineUserId;
    const changed = profileContext !== nextContext;
    profileContext = nextContext;
    if (changed) {
      generation++;
      stopScan();
      busy = false;
      selectedCode = '';
      lockedRecipient = null;
      invalidate();
      if (!booking && input()) {
        input().value = '';
        status('');
      }
      el('friendList')?.replaceChildren();
      el('friendReceivedBookings')?.replaceChildren();
      for (const id of ['lookupFriend', 'confirmFriendRequest']) {
        if (el(id)) el(id).disabled = false;
      }
      if (booking) {
        el('bookingFriendsModal')?.remove();
        el('friendsPanel')?.remove();
      }
    }

    profile = next;
    const friendUrl = new URL('../member/', location.href);
    friendUrl.hash = 'friend=' + encodeURIComponent(profile.memberCode || '');
    invitationUrl = profile.memberCode ? friendUrl.href : '';
    install();
    if (!el('friendsPanel')) return;

    if (!booking) {
      const hash = new URLSearchParams(location.hash.slice(1));
      const search = new URLSearchParams(location.search);
      const friendIncoming = hash.get('friend');
      const rewardIncoming = hash.get('reward');
      const legacyInvite = hash.get('invite') || search.get('invite');
      const referralIncoming = rewardIncoming || legacyInvite;

      if (changed) {
        if (friendIncoming && input()) {
          input().value = friendIncoming.slice(0, 2048);
          input().dispatchEvent(new Event('input', { bubbles: true }));
        }
        if (referralIncoming) {
          window.MemberReferral?.prefill?.(
            legacyInvite && !rewardIncoming
              ? '#invite=' + encodeURIComponent(legacyInvite)
              : rewardIncoming
          );
        }
      }

      if (changed && (location.hash === '#friends' || friendIncoming || referralIncoming)) {
        selectMemberTab(referralIncoming && !friendIncoming ? 'reward' : 'friends');
      }
    }

    void refresh(false);
  }

  window.addEventListener(booking ? 'booking:member-loaded' : 'member-profile-ready', ready);
  window.addEventListener('member-referral:closed', stopScan);
  window.addEventListener(
    booking ? 'booking:refresh' : 'member-system:realtime-invalidation',
    () => { if (profile) void refresh(false); }
  );
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopScan();
  });
  window.addEventListener('pagehide', () => {
    generation++;
    stopScan();
    profile = null;
    invitationUrl = '';
    selectedCode = '';
  });

  window.MemberFriends = {
    lookup,
    invalidate,
    stopScan,
    openTab: selectMemberTab,
    copyInvitationLink,
    invitationUrl: () => invitationUrl,
    isBusy: () => busy,
    selected: () => selectedCode,
    lock: (code, name) => {
      lockedRecipient = {
        code: code || '',
        name: code ? `${name || '好友'} · ${code}（編輯時不可更換）` : '本人（編輯時不可更換）',
      };
      selectedCode = code || '';
      void refresh(false);
    },
    clear: () => {
      selectedCode = '';
      lockedRecipient = null;
      const select = el('friendBookingRecipient');
      if (select) {
        select.disabled = false;
        select.value = '';
      }
      void refresh(false);
    },
  };
})();
