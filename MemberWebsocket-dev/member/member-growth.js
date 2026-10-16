(() => {
  'use strict';

  const state = {
    profile: null,
    referralRequestId: '',
    binding: false,
    bound: false,
    joinSubmitted: false,
    generation: 0,
    previewCode: '',
    previewMemberCode: '',
  };
  let referralScanner = null;

  function stopReferralScan() {
    window.QRScanDialog?.close(document.getElementById('memberReferralQrScanner'));
    referralScanner?.stop();
    const scanner = document.getElementById('memberReferralQrScanner');
    if (scanner) scanner.hidden = true;
  }

  function referralScanStatus(message) {
    const text = String(message || '');
    const isError = /無法|未開啟|不是本站|格式不正確|未找到|過大|請選擇/.test(text);
    const inScanner = document.getElementById('memberReferralQrScanStatus');
    if (inScanner) inScanner.textContent = text;
    showReferralStatus(text, isError, isError ? 'error' : 'info');
  }

  function requestId(prefix) {
    const value = window.crypto?.randomUUID?.() || String(Date.now()) + Math.random().toString(36).slice(2);
    return prefix + '-' + value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
  }

  function watchJoinSubmit() {
    const form = document.getElementById('profileForm');
    if (!form || form.dataset.memberGrowthBound === 'true') return;
    form.dataset.memberGrowthBound = 'true';
    form.addEventListener('submit', () => {
      state.joinSubmitted = true;
    }, true);
  }

  function showReferralStatus(message, error = false, kind = 'info') {
    const status = document.getElementById('memberReferralStatus');
    if (!status) return;
    status.textContent = String(message || '');
    status.classList.toggle('hidden', !message);
    status.classList.toggle('error', Boolean(error));
    status.classList.toggle('success', Boolean(message) && !error && kind === 'success');
    status.dataset.state = error ? 'error' : kind;
  }


  function parseReferralValue(raw) {
    const text = String(raw || '').trim();
    if (!text) throw new Error('請輸入被邀請者的會員編號或掃描會員 QR Code。');
    let candidate = text;
    let legacyInviteCode = false;

    const pickFromUrl = (url) => {
      if (url.origin !== location.origin) throw new Error('邀請優惠連結不是本站連結。');
      const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
      if (hash.get('reward')) return { value: hash.get('reward'), legacy: false };
      if (hash.get('invite')) return { value: hash.get('invite'), legacy: true };
      if (url.searchParams.get('invite')) return { value: url.searchParams.get('invite'), legacy: true };
      return { value: '', legacy: false };
    };

    if (/^https?:\/\//i.test(text)) {
      try {
        const parsed = pickFromUrl(new URL(text));
        candidate = parsed.value;
        legacyInviteCode = parsed.legacy;
      } catch (error) {
        if (error?.message === '邀請優惠連結不是本站連結。') throw error;
        throw new Error('邀請優惠連結格式不正確。');
      }
    } else if (text.startsWith('#')) {
      const hash = new URLSearchParams(text.slice(1));
      if (hash.get('reward')) candidate = hash.get('reward');
      else if (hash.get('invite')) { candidate = hash.get('invite'); legacyInviteCode = true; }
      else candidate = '';
    }

    try { candidate = decodeURIComponent(candidate); } catch (_) { /* keep raw candidate */ }
    candidate = String(candidate || '').trim().toUpperCase();
    if (legacyInviteCode && /^[A-F0-9]{10}$/.test(candidate)) return { inviteCode: candidate };
    if (/^[A-Z0-9_-]{4,40}$/.test(candidate)) return { memberCode: candidate };
    throw new Error('請輸入有效的被邀請者會員編號或 QR Code。');
  }

  function referralShareUrl() {
    const code = String(state.profile?.memberCode || '').trim().toUpperCase();
    if (!code) return '';
    const url = new URL('../member/', location.href);
    url.hash = 'reward=' + encodeURIComponent(code);
    return url.href;
  }

  async function copyReferralLink() {
    const url = referralShareUrl();
    if (!url) { showReferralStatus('會員編號仍在同步，請稍後再試。', true); return; }
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(url);
      showReferralStatus('邀請優惠連結已複製。', false, 'success');
    } catch (_) {
      const field = document.createElement('textarea');
      field.value = url;
      field.className = 'friend-copy-buffer';
      document.getElementById('memberReferralModal')?.append(field);
      field.select();
      let copied = false;
      try { copied = document.execCommand?.('copy') === true; } catch (_) { /* report below */ }
      field.remove();
      showReferralStatus(copied ? '邀請優惠連結已複製。' : '無法複製邀請優惠連結，請稍後再試。', !copied, copied ? 'success' : 'error');
    }
  }

  async function shareReferralLink() {
    const url = referralShareUrl();
    if (!url) return;
    if (!navigator.share) { await copyReferralLink(); return; }
    try {
      await navigator.share({ title: '邀請優惠', url });
      showReferralStatus('邀請優惠連結已分享。', false, 'success');
    } catch (error) {
      if (error?.name !== 'AbortError') showReferralStatus('分享暫時無法使用，請改用複製邀請優惠連結。', true);
    }
  }
  function ensureReferralUi() {
    const pass = document.getElementById('memberPass');
    if (!pass) return null;
    const actions = document.getElementById('memberPassActions') || pass;

    let trigger = document.getElementById('openMemberReferral');
    if (!trigger) {
      trigger = document.createElement('button');
      trigger.id = 'openMemberReferral';
      trigger.type = 'button';
      trigger.className = 'member-referral-trigger';
      trigger.setAttribute('aria-haspopup', 'dialog');
      trigger.setAttribute('aria-controls', 'memberReferralModal');
      trigger.textContent = '邀請優惠';
      actions.append(trigger);
    }

    if (!document.getElementById('showMemberIdentityQr')) {
      const identityQr = document.createElement('button');
      identityQr.id = 'showMemberIdentityQr'; identityQr.type = 'button';
      identityQr.className = 'member-referral-trigger'; identityQr.textContent = '顯示會員 QR Code';
      identityQr.setAttribute('aria-haspopup', 'dialog');
      identityQr.addEventListener('click', () => window.QRDisplayDialog?.show({memberCode: state.profile?.memberCode, opener: identityQr}));
      actions.prepend(identityQr);
    }

    let modal = document.getElementById('memberReferralModal');
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = 'memberReferralModal';
    modal.className = 'member-referral-modal hidden';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'memberReferralTitle');
    modal.setAttribute('aria-describedby', 'memberReferralDescription');

    const dialog = document.createElement('section');
    dialog.className = 'member-referral-dialog';

    const heading = document.createElement('div');
    heading.className = 'member-referral-heading';
    const headingCopy = document.createElement('div');
    const kicker = document.createElement('p');
    kicker.className = 'kicker';
    kicker.textContent = 'Referral rewards';
    const title = document.createElement('h2');
    title.id = 'memberReferralTitle';
    title.textContent = '邀請優惠';
    headingCopy.append(kicker, title);
    const close = document.createElement('button');
    close.id = 'closeMemberReferral';
    close.type = 'button';
    close.className = 'member-referral-close';
    close.setAttribute('aria-label', '關閉邀請優惠');
    close.textContent = '×';
    heading.append(headingCopy, close);

    const description = document.createElement('p');
    description.id = 'memberReferralDescription';
    description.className = 'member-referral-description';
    description.textContent = '輸入或掃描被邀請者的會員編號，確認後領取優惠票券。';

    const bind = document.createElement('form');
    bind.id = 'memberReferralForm';
    bind.className = 'member-referral-section member-referral-bind';
    bind.noValidate = true;
    const bindTitle = document.createElement('strong');
    bindTitle.textContent = '領取好友邀請優惠';
    const bindLabel = document.createElement('label');
    bindLabel.setAttribute('for', 'memberReferralInviteCode');
    bindLabel.textContent = '被邀請者的會員編號';
    const input = document.createElement('input');
    input.id = 'memberReferralInviteCode';
    input.type = 'text';
    input.maxLength = 2048;
    input.autocomplete = 'off';
    input.inputMode = 'text';
    input.placeholder = '輸入對方會員編號或掃描對方 QR Code';
    input.setAttribute('aria-describedby', 'memberReferralBindHelp');
    const help = document.createElement('small');
    help.id = 'memberReferralBindHelp';
    help.textContent = '由邀請者本人操作：輸入或掃描被邀請者的會員編號。每成功邀請一位不同會員可獲得 1 張優惠票券；同一位被邀請者僅能登記一次。';
    const scanActions = document.createElement('div');
    scanActions.className = 'friend-actions';
    const scan = document.createElement('button');
    scan.id = 'scanMemberReferralQr';
    scan.type = 'button';
    scan.className = 'button button-refresh';
    scan.textContent = '掃描 QR Code';
    const upload = document.createElement('button');
    upload.id = 'uploadMemberReferralQr';
    upload.type = 'button';
    upload.className = 'button button-refresh';
    upload.textContent = '選擇 QR 圖片';
    const file = document.createElement('input');
    file.id = 'memberReferralQrFile';
    file.type = 'file';
    file.accept = 'image/png,image/jpeg,image/webp';
    file.hidden = true;
    scanActions.append(scan, upload, file);
    const camera = document.createElement('section');
    camera.id = 'memberReferralQrScanner';
    camera.hidden = true;
    const video = document.createElement('video');
    video.id = 'memberReferralQrVideo';
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('aria-label', '邀請優惠 QR Code 相機預覽');
    const cameraHelp = document.createElement('p');
    cameraHelp.id = 'memberReferralQrScanStatus';
    cameraHelp.setAttribute('role', 'status');
    cameraHelp.setAttribute('aria-live', 'polite');
    cameraHelp.textContent = '將完整的邀請優惠 QR Code 放在畫面中央。影像只在目前裝置辨識。';
    const stopScan = document.createElement('button');
    stopScan.id = 'stopMemberReferralQr';
    stopScan.type = 'button';
    stopScan.className = 'button button-refresh';
    stopScan.textContent = '關閉相機';
    const cameraImage = document.createElement('button');
    cameraImage.type = 'button';
    cameraImage.className = 'button button-refresh';
    cameraImage.textContent = '選擇 QR 圖片';
    camera.append(video, cameraHelp, cameraImage, stopScan);
    const submit = document.createElement('button');
    submit.id = 'bindMemberReferral';
    submit.type = 'submit';
    submit.className = 'button button-dark';
    submit.textContent = '確認邀請並領取票券';
    submit.disabled = true;
    const status = document.createElement('p');
    status.id = 'memberReferralStatus';
    status.className = 'member-growth-status hidden';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    bind.append(bindTitle, bindLabel, input, help, scanActions, camera, submit, status);

    dialog.append(heading, description, bind);
    modal.append(dialog);
    document.body.append(modal);

    const shell = document.querySelector('.app-shell');
    let previousInert = null;
    const closeModal = () => {
      stopReferralScan();
      window.QRDisplayDialog?.close();
      if (shell && previousInert !== null) { shell.inert = previousInert; previousInert = null; }
      modal.classList.add('hidden');
      window.dispatchEvent(new Event('member-referral:closed'));
      trigger.setAttribute('aria-expanded', 'false');
      trigger.focus();
    };
    const openModal = () => {
      document.getElementById('closeMemberFriends')?.click();
      if (shell && previousInert === null) { previousInert = shell.inert; shell.inert = true; }
      renderInviteCode(state.profile);
      showReferralStatus('');
      modal.classList.remove('hidden');
      trigger.setAttribute('aria-expanded', 'true');
      window.requestAnimationFrame(() => {
        modal.tabIndex = -1;
        modal.focus({ preventScroll: true });
      });
    };

    trigger.setAttribute('aria-expanded', 'false');
    trigger.addEventListener('click', openModal);
    close.addEventListener('click', closeModal);
    modal.addEventListener('click', (event) => {
      if (event.target === modal) closeModal();
    });
    document.addEventListener('keydown', (event) => {
      if (modal.classList.contains('hidden') || window.MemberPanelDialog?.isOpen()) return;
      if (event.key === 'Escape') { event.preventDefault(); closeModal(); }
      if (event.key === 'Tab') {
        const items = Array.from(modal.querySelectorAll('button:not(:disabled),input:not(:disabled),a[href],[tabindex="0"]')).filter(item => item.getClientRects().length && !item.closest('[hidden]'));
        const first = items[0], last = items.at(-1);
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === modal)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === modal || document.activeElement === last || !modal.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
      }
    });

    input.addEventListener('input', () => {
      stopReferralScan();
      if (!state.binding) state.referralRequestId = '';
      submit.disabled = state.binding || !input.value.trim();
      showReferralStatus('');
    });

    if (window.FriendQRScanner?.create) {
      referralScanner = window.FriendQRScanner.create(video, {
        label: '邀請優惠',
        parseValue: parseReferralValue,
        onStatus: referralScanStatus,
        onResult: referral => {
          stopReferralScan();
          input.value = referral.memberCode
            ? referral.memberCode
            : '#invite=' + encodeURIComponent(referral.inviteCode || '');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          showReferralStatus('已辨識邀請優惠 QR Code，請確認資料後再綁定。', false, 'success');
          input.focus();
        },
      });
      scan.addEventListener('click', () => {
        if (state.binding) return;
        if (!window.QRScanDialog?.open(camera, {
          title: '掃描邀請優惠 QR Code', opener: scan,
          start: () => referralScanner.start(), stop: () => referralScanner.stop()
        })) {
          camera.hidden = false;
          void referralScanner.start();
        }
      });
      stopScan.addEventListener('click', () => {
        stopReferralScan();
        scan.focus();
      });
      cameraImage.addEventListener('click', () => upload.click());
      upload.addEventListener('click', () => {
        if (!state.binding) file.click();
      });
      file.addEventListener('change', event => {
        const selected = event.target.files?.[0];
        event.target.value = '';
        stopReferralScan();
        void referralScanner.readFile(selected);
      });
    } else {
      scan.disabled = true;
      upload.disabled = true;
    }

    bind.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (state.binding) return;

      let referral;
      try { referral = parseReferralValue(input.value); }
      catch (error) { showReferralStatus(error?.message || '邀請優惠資料格式不正確。', true); return; }

      const ownInvite = String(state.profile?.inviteCode || '').trim().toUpperCase();
      const ownMember = String(state.profile?.memberCode || '').trim().toUpperCase();
      if ((referral.inviteCode && referral.inviteCode === ownInvite) || (referral.memberCode && referral.memberCode === ownMember)) {
        showReferralStatus('不可使用自己的邀請優惠碼或會員編號。', true);
        return;
      }

      const session = window.MemberSystem?.getSession?.('member');
      if (!session) {
        showReferralStatus('登入狀態已失效，請重新整理後再試。', true);
        return;
      }

      state.binding = true;
      const current = state.generation;
      state.referralRequestId = state.referralRequestId || requestId('ref');
      input.disabled = true;
      submit.disabled = true;
      submit.textContent = '綁定中…';
      showReferralStatus('正在確認邀請優惠與獎勵票券…');

      try {
        const result = await window.MemberSystem.request(
          session.config,
          'member',
          session.idToken,
          'member.referral.bind',
          { ...referral, requestId: state.referralRequestId }
        );
        if (current !== state.generation) return;
        state.referralRequestId = '';
        const expires = result?.rewardExpiresOn
          ? '，票券效期至 ' + window.MemberSystem.formatDate(result.rewardExpiresOn)
          : '';
        showReferralStatus(
          result?.alreadyApplied
            ? '這位會員已由你成功邀請，你的好友優惠票券已發放' + expires + '。'
            : '邀請成功！你已獲得 1 張好友優惠票券，可再邀請其他會員累積更多票券' + expires + '。',
          false,
          'success'
        );
        submit.textContent = '確認邀請並領取票券';
        input.value = '';
        submit.disabled = true;
      } catch (error) {
        if (current !== state.generation) return;
        submit.disabled = false;
        submit.textContent = '確認邀請並領取票券';
        showReferralStatus(error?.code === 'REFERRAL_REWARD_UNAVAILABLE' ? '管理員尚未設定好友邀請票券。' : (error?.message || '邀請優惠暫時無法完成，請稍後再試。'), true);
      } finally {
        if (current === state.generation) {
          state.binding = false;
          input.disabled = false;
          submit.disabled = !input.value.trim();
        }
      }
    });

    window.dispatchEvent(new Event('member-referral:ui-ready'));
    return modal;
  }

  function renderInviteCode(profile) {
    ensureReferralUi();
    const code = String(profile?.memberCode || '').trim().toUpperCase();
    const identityButton = document.getElementById('showMemberIdentityQr');
    if (identityButton) identityButton.disabled = !code;

  }

  async function sendJoinCompletionMessage() {
    if (!state.joinSubmitted) return;
    state.joinSubmitted = false;

    const message = '我已完成 Lumen Club 會員註冊，想開始使用會員服務。';
    try {
      if (!window.liff || typeof window.liff.sendMessages !== 'function' || !window.liff.isInClient?.()) return;
      const context = typeof window.liff.getContext === 'function' ? window.liff.getContext() : null;
      if (!context || context.type !== 'utou') return;
      await window.liff.sendMessages([{ type: 'text', text: message }]);
    } catch (error) {
      console.warn('automatic membership completion LINE message failed', error);
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    watchJoinSubmit();
    ensureReferralUi();
  });

  window.addEventListener('member-profile-ready', (event) => {
    const next = event?.detail?.profile || {};
    if (state.profile?.lineUserId !== next.lineUserId) {
      stopReferralScan();
      state.generation++;
      state.binding = false;
      state.bound = false;
      state.referralRequestId = '';
      document.getElementById('closeMemberReferral')?.click();
      const input = document.getElementById('memberReferralInviteCode');
      if (input) { input.value = ''; input.disabled = false; }
      const submit = document.getElementById('bindMemberReferral');
      if (submit) { submit.disabled = true; submit.textContent = '確認邀請並領取票券'; }
    }
    state.profile = next;
    renderInviteCode(state.profile);
    void sendJoinCompletionMessage();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopReferralScan();
  });
  window.addEventListener('pagehide', stopReferralScan);

  window.MemberReferral = {
    ensureUi: ensureReferralUi,
    close: () => document.getElementById('closeMemberReferral')?.click(),
    stopScan: stopReferralScan,
    isBusy: () => state.binding,
    prefill: (value) => {
      const input = document.getElementById('memberReferralInviteCode');
      if (!input) return;
      input.value = String(value || '').slice(0, 2048);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    shareUrl: referralShareUrl,
    copyLink: copyReferralLink,
  };})();
