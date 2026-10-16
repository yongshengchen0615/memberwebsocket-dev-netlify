(() => {
  'use strict';

  const MEMBER_TIER_STYLE_KEYS = Object.freeze(['forest', 'midnight', 'ocean', 'sunset', 'lavender', 'rose', 'gold', 'platinum', 'mint', 'cherry']);
  const state = { config: null, idToken: '', profile: null, lineProfile: null, profileSaveLocked: false, terms: null, termsCheckPromise: null, birthdayPicker: { opener: null } };
  const els = {};
  let cardOpenRecorded = false;
  const LOGIN_PROGRESS_TICK_MS = 650;
  let loginProgressTimer = null;
  let loginProgressValue = 8;
  let memberCodeCopyResetTimer = null;

  window.addEventListener('DOMContentLoaded', () => {
    window.MemberSystem.bindDialogKeyboard();
    ['app', 'loadingView', 'loadingProgress', 'loadingProgressBar', 'loadingProgressText', 'loadingStatus', 'errorView', 'errorTitle', 'errorMessage', 'retryButton', 'profileSetupView', 'profileForm', 'profileBirthday', 'profileBirthdayDisplay', 'profileBirthdayPickerButton', 'profileBirthdayPickerModal', 'profileBirthdayPickerTitle', 'closeProfileBirthdayPicker', 'cancelProfileBirthdayPicker', 'confirmProfileBirthdayPicker', 'profileBirthdayPickerMessage', 'profileBirthdayYear', 'profileBirthdayMonth', 'profileBirthdayDay', 'profileCountryCode', 'profilePhone', 'profileFormMessage', 'joinTermsSummary', 'joinTermsTitle', 'joinTermsBody', 'joinTermsAccepted', 'termsRenewView', 'renewTermsForm', 'renewTermsSummary', 'renewTermsTitle', 'renewTermsBody', 'renewTermsAccepted', 'renewTermsMessage', 'renewTermsButton', 'saveProfileButton', 'refreshProfileButton', 'memberView', 'memberPass', 'brandName', 'displayName', 'memberStatus', 'memberInitial', 'memberName', 'memberTier', 'memberCode', 'copyMemberCodeButton', 'joinedAt', 'memberBirthday', 'memberPhone', 'membershipProgress'].forEach((id) => { els[id] = document.getElementById(id); });
    els.retryButton.addEventListener('click', () => window.location.reload());
    els.refreshProfileButton.addEventListener('click', () => window.location.reload());
    els.copyMemberCodeButton.addEventListener('click', copyMemberCode);
    els.profileForm.addEventListener('submit', saveProfile);
    els.renewTermsForm.addEventListener('submit', acceptRenewedTerms);
    els.joinTermsAccepted.addEventListener('change', () => {
      if (els.joinTermsAccepted.checked) void verifyTermsSelection('join');
    });
    els.renewTermsAccepted.addEventListener('change', () => {
      if (els.renewTermsAccepted.checked) void verifyTermsSelection('renew');
    });
    prepareBirthdayPicker();
    els.profileBirthdayPickerButton.addEventListener('click', openBirthdayPicker);
    els.closeProfileBirthdayPicker.addEventListener('click', closeBirthdayPicker);
    els.cancelProfileBirthdayPicker.addEventListener('click', closeBirthdayPicker);
    els.confirmProfileBirthdayPicker.addEventListener('click', confirmBirthdayPicker);
    els.profileBirthdayPickerModal.addEventListener('click', (event) => { if (event.target === els.profileBirthdayPickerModal) closeBirthdayPicker(); });
    els.profileBirthdayYear.addEventListener('change', () => { syncBirthdayDayOptions(); updateBirthdayPickerState(); });
    els.profileBirthdayMonth.addEventListener('change', () => { syncBirthdayDayOptions(); updateBirthdayPickerState(); });
    els.profileBirthdayDay.addEventListener('change', updateBirthdayPickerState);
    els.profileBirthday.addEventListener('input', updateBirthdayInputDisplay);
    els.profileBirthday.addEventListener('change', updateBirthdayInputDisplay);
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeBirthdayPicker(); });
    window.addEventListener('member-profile-updated', handleExternalProfileUpdate);
    updateBirthdayInputDisplay();
    boot();
  });

  async function boot() {
    setView('loading');
    try {
      startLoginProgress('正在取得開啟設定…', 18);
      state.config = await window.MemberSystem.loadConfig();
      startLoginProgress('正在驗證 LINE 身分…', 48);
      state.idToken = await window.MemberSystem.signIn(state.config, 'member');
      state.lineProfile = await loadLineProfile();
      startLoginProgress('正在同步會員資料…', 92);
      const result = await window.MemberSystem.request(state.config, 'member', state.idToken, 'user.member.bootstrap');
      state.profile = result.profile || {};
      updateTerms(result.terms);
      // Subscribe regardless of the initial view so verification/activation and
      // profile changes appear without reopening the member LIFF page.
      window.MemberSystem.subscribeRealtime(state.config, 'member', async () => {
        const latest = await window.MemberSystem.request(state.config, 'member', state.idToken, 'user.member.bootstrap');
        const profile = latest && latest.profile && typeof latest.profile === 'object' ? latest.profile : null;
        if (!profile) return;
        state.profile = profile;
        updateTerms(latest.terms);
        if (latest.consentRequired && profile.profileComplete) {
          setView('termsRenew');
          return;
        }
        if (!profile.profileComplete || profile.membershipRequired) {
          if (!els.memberView.classList.contains('hidden')) setView('profileSetup');
          return;
        }
        renderProfile(profile);
        setView('member');
      });
      if (result.consentRequired && state.profile.profileComplete) {
        await completeLoginProgress('請確認更新後的條款');
        return setView('termsRenew');
      }
      if (!state.profile.profileComplete || state.profile.membershipRequired) {
        await completeLoginProgress('會員資料已準備完成');
        setView('profileSetup');
        announceTourReady(state.profile);
        return;
      }
      renderProfile(state.profile);
      await completeLoginProgress('會員資料已準備完成');
      setView('member');
      announceTourReady(state.profile);

    } catch (error) {
      stopLoginProgress();
      showError(error);
    } finally {
      stopLoginProgress();
      els.app.setAttribute('aria-busy', 'false');
    }
  }

  function handleExternalProfileUpdate(event) {
    const profile = event?.detail?.profile;
    if (!profile || typeof profile !== 'object') return;
    state.profile = profile;
    if (profile.profileComplete && !profile.membershipRequired) {
      renderProfile(profile);
      setView('member');
      announceTourReady(profile);
    }
  }

  async function loadLineProfile() {
    if (window.TestModeClient && typeof window.TestModeClient.getSessionToken === 'function' && window.TestModeClient.getSessionToken()) {
      return { displayName: '', pictureUrl: '' };
    }
    const decoded = typeof window.liff?.getDecodedIDToken === 'function' ? window.liff.getDecodedIDToken() : null;
    const fallback = {
      displayName: String(decoded && decoded.name || ''),
      pictureUrl: normalizeLinePictureUrl(decoded && decoded.picture),
    };
    if (typeof window.liff?.getProfile !== 'function') return fallback;
    try {
      const profile = await window.liff.getProfile();
      return {
        displayName: String(profile && profile.displayName || fallback.displayName || ''),
        pictureUrl: normalizeLinePictureUrl(profile && profile.pictureUrl) || fallback.pictureUrl,
      };
    } catch (_) {
      return fallback;
    }
  }

  function normalizeLinePictureUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:') return '';
      return url.href;
    } catch (_) {
      return '';
    }
  }

  function renderProfile(profile) {
    const brandName = String(state.config.brandName || 'Lumen Club');
    const displayName = String(profile.displayName || state.lineProfile?.displayName || 'LINE 使用者');
    const status = String(profile.status || 'active').toLowerCase();
    const isActive = status === 'active';
    els.brandName.textContent = brandName;
    els.displayName.textContent = displayName;
    renderMemberAvatar(state.lineProfile?.pictureUrl, displayName);
    els.memberName.textContent = displayName;
    els.memberTier.textContent = String(profile.tier || '一般會員');
    const tierStyleKey = safeTierStyle(profile.tierStyleKey);
    MEMBER_TIER_STYLE_KEYS.forEach((styleKey) => els.memberPass.classList.remove(`tier-style-${styleKey}`));
    els.memberPass.classList.add(`tier-style-${tierStyleKey}`);
    els.memberPass.dataset.tierStyle = tierStyleKey;
    const memberCode = String(profile.memberCode || '').trim();
    els.memberCode.textContent = memberCode || '尚未建立';
    if (els.copyMemberCodeButton.textContent === '複製') els.copyMemberCodeButton.disabled = !memberCode;
    els.joinedAt.textContent = window.MemberSystem.formatDate(profile.joinedAt);
    const surname = String(profile.surname || '').trim();
    const salutation = String(profile.salutation || '').trim().toLowerCase();
    const salutationLabel = salutation === 'mr' ? '先生' : salutation === 'ms' ? '小姐' : '';
    const honorificName = surname && salutationLabel ? `${surname}${salutationLabel}` : surname || salutationLabel;
    const honorificDisplay = document.getElementById('memberHonorificName');
    if (honorificDisplay) honorificDisplay.textContent = honorificName || '未填寫';
    els.memberBirthday.textContent = String(profile.birthday || '未填寫');
    els.memberPhone.textContent = String(profile.phone || '未填寫');
    window.MembershipProgress.render(els.membershipProgress, profile);
    els.memberStatus.textContent = isActive ? '使用中' : '暫停';
    els.memberStatus.parentElement.classList.toggle('inactive', !isActive);
  }

  function currentMemberCode() {
    return String(state.profile && state.profile.memberCode || '').trim();
  }

  async function copyMemberCode() {
    const memberCode = currentMemberCode();
    if (!memberCode) {
      setMemberCodeCopyFeedback('無可複製編號');
      scheduleMemberCodeCopyReset();
      return;
    }

    if (memberCodeCopyResetTimer !== null) {
      window.clearTimeout(memberCodeCopyResetTimer);
      memberCodeCopyResetTimer = null;
    }
    els.copyMemberCodeButton.disabled = true;

    try {
      await writeClipboardText(memberCode);
      setMemberCodeCopyFeedback('已複製');
    } catch (_) {
      setMemberCodeCopyFeedback('複製失敗');
    } finally {
      scheduleMemberCodeCopyReset();
    }
  }

  async function writeClipboardText(value) {
    if (window.isSecureContext && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(value);
      return;
    }

    const textarea = document.createElement('textarea');
    textarea.className = 'clipboard-fallback-input';
    textarea.value = value;
    textarea.readOnly = true;
    textarea.setAttribute('aria-hidden', 'true');
    document.body.appendChild(textarea);

    try {
      textarea.focus({ preventScroll: true });
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
      const copied = typeof document.execCommand === 'function' && document.execCommand('copy');
      if (!copied) throw new Error('Clipboard copy is unavailable.');
    } finally {
      textarea.remove();
    }
  }

  function setMemberCodeCopyFeedback(label) {
    els.copyMemberCodeButton.textContent = label;
  }

  function scheduleMemberCodeCopyReset() {
    if (memberCodeCopyResetTimer !== null) window.clearTimeout(memberCodeCopyResetTimer);
    memberCodeCopyResetTimer = window.setTimeout(() => {
      memberCodeCopyResetTimer = null;
      els.copyMemberCodeButton.textContent = '複製';
      els.copyMemberCodeButton.disabled = !currentMemberCode();
    }, 1800);
  }

  function announceTourReady(profile) {
    try { window.dispatchEvent(new CustomEvent('member-profile-ready', { detail: { profile } })); } catch (_) {}
  }

  function renderMemberAvatar(pictureUrl, displayName) {
    const initials = window.MemberSystem.initials(displayName);
    els.memberInitial.textContent = initials;
    els.memberInitial.style.backgroundImage = '';
    els.memberInitial.style.backgroundSize = '';
    els.memberInitial.style.backgroundPosition = '';
    els.memberInitial.style.backgroundRepeat = '';
    els.memberInitial.style.color = '';

    const url = normalizeLinePictureUrl(pictureUrl);
    if (!url) return;

    const image = new Image();
    image.referrerPolicy = 'no-referrer';
    image.onload = () => {
      els.memberInitial.style.backgroundImage = `url("${url.replaceAll('"', '%22')}")`;
      els.memberInitial.style.backgroundSize = 'cover';
      els.memberInitial.style.backgroundPosition = 'center';
      els.memberInitial.style.backgroundRepeat = 'no-repeat';
      els.memberInitial.style.color = 'transparent';
    };
    image.onerror = () => {
      els.memberInitial.textContent = initials;
      els.memberInitial.style.backgroundImage = '';
      els.memberInitial.style.color = '';
    };
    image.src = url;
  }

  async function saveProfile(event) {
    event.preventDefault();
    if (state.profileSaveLocked) return showUncertainSaveMessage();
    hideMessage();
    const birthday = String(els.profileBirthday.value || '').trim();
    const phone = window.MemberPhone?.compose(els.profileCountryCode.value, els.profilePhone.value) || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthday)) return showMessage('請填寫正確的生日。');
    if (!phone) return showMessage('請選擇國碼並填寫正確的電話號碼。');
    if (!state.terms) return showMessage('目前尚無有效會員條款，請稍後再試或聯繫管理員。');
    if (!els.joinTermsAccepted.checked) return showMessage('請閱讀並勾選同意會員條款。');
    if (state.termsCheckPromise) {
      const stillCurrent = await state.termsCheckPromise;
      if (!stillCurrent || !els.joinTermsAccepted.checked) return;
    }
    setSaving(true);
    try {
      const preflight = await preflightTermsForWrite();
      if (preflight.changed) {
        showMessage(preflight.terms
          ? '會員條款已更新，已載入最新版本。請重新閱讀並勾選同意後再送出。'
          : '目前尚無有效會員條款，請稍後再試或聯繫管理員。');
        return;
      }
      const result = await window.MemberSystem.request(state.config, 'member', state.idToken, 'user.member.profile.save', { birthday, phone, surname: String(document.getElementById('profileSurname').value || '').trim(), salutation: document.getElementById('profileSalutation').value, termsId: state.terms.id, termsVersion: state.terms.version, accepted: true });
      state.profile = result.profile || {};
      renderProfile(state.profile);
      setView('member');
      announceTourReady(state.profile);
      window.MemberSystem.subscribeRealtime(state.config, 'member', async () => {
        const fresh = await window.MemberSystem.request(state.config, 'member', state.idToken, 'user.member.bootstrap');
        if (fresh && fresh.profile && fresh.profile.profileComplete) { state.profile = fresh.profile; renderProfile(state.profile); }
      });
    } catch (error) {
      if (error && error.code === 'API_RESPONSE_UNCERTAIN') {
        state.profileSaveLocked = true;
        showUncertainSaveMessage();
      } else if (error?.code === 'TERMS_VERSION_STALE') {
        try {
          const fresh = await recoverLatestTerms(error);
          showMessage(fresh?.terms
            ? '會員條款已更新，已載入最新版本。請重新閱讀並勾選同意後再送出。'
            : '目前尚無有效會員條款，請稍後再試或聯繫管理員。');
        } catch (_) {
          showMessage('會員條款已更新，但最新內容載入失敗，請重新整理後再試。');
        }
      } else {
        showMessage(error && error.message || '資料暫時無法儲存，請稍後再試。');
      }
    } finally {
      setSaving(false);
    }
  }

  function updateTerms(terms) {
    state.terms = terms || null;
    for (const prefix of ['join', 'renew']) {
      els[prefix + 'TermsSummary'].textContent = terms ? `${terms.summary || terms.title}（版本 ${terms.version}）` : '目前尚無有效會員條款，請聯繫管理員。';
      els[prefix + 'TermsTitle'].textContent = terms ? `${terms.title} · v${terms.version}（完整內容）` : '條款尚未發佈';
      els[prefix + 'TermsBody'].textContent = terms?.body || '';
      els[prefix + 'TermsAccepted'].checked = false;
    }
    els.saveProfileButton.disabled = !terms;
    els.renewTermsButton.disabled = !terms;
  }

  function sameTermsVersion(left, right) {
    return Boolean(
      left
      && right
      && String(left.id || '') === String(right.id || '')
      && String(left.version || '') === String(right.version || '')
    );
  }

  async function fetchLatestTermsSnapshot() {
    const fresh = await window.MemberSystem.request(state.config, 'member', state.idToken, 'user.member.bootstrap');
    if (fresh?.profile && typeof fresh.profile === 'object') state.profile = fresh.profile;
    return fresh || {};
  }

  async function preflightTermsForWrite() {
    const previous = state.terms;
    const fresh = await fetchLatestTermsSnapshot();
    const latest = fresh.terms || null;
    const changed = !sameTermsVersion(previous, latest);
    if (changed) updateTerms(latest);
    return { changed, terms: latest, consentRequired: Boolean(fresh.consentRequired) };
  }

  function termsMessageElement(kind) {
    return kind === 'renew' ? els.renewTermsMessage : els.profileFormMessage;
  }

  function showTermsSyncMessage(kind, message) {
    const target = termsMessageElement(kind);
    target.textContent = message;
    target.classList.remove('hidden');
  }

  async function verifyTermsSelection(kind) {
    const checkbox = kind === 'renew' ? els.renewTermsAccepted : els.joinTermsAccepted;
    if (!checkbox.checked || !state.terms) return false;
    const selectedTerms = state.terms;
    const pending = (async () => {
      try {
        const fresh = await fetchLatestTermsSnapshot();
        const latest = fresh.terms || null;
        if (!sameTermsVersion(selectedTerms, latest)) {
          updateTerms(latest);
          showTermsSyncMessage(kind, latest
            ? '會員條款剛剛更新，已切換到最新版本。請重新閱讀後再次勾選同意。'
            : '目前尚無有效會員條款，請稍後再試或聯繫管理員。');
          return false;
        }
        return true;
      } catch (_) {
        checkbox.checked = false;
        showTermsSyncMessage(kind, '目前無法確認最新會員條款，請檢查網路後再試。');
        return false;
      }
    })();
    state.termsCheckPromise = pending;
    try {
      return await pending;
    } finally {
      if (state.termsCheckPromise === pending) state.termsCheckPromise = null;
    }
  }

  async function refreshTerms() {
    const fresh = await fetchLatestTermsSnapshot();
    updateTerms(fresh.terms);
    return fresh;
  }

  async function recoverLatestTerms(error) {
    const latest = error?.details?.terms;
    if (latest && typeof latest === 'object') {
      updateTerms(latest);
      return { terms: latest, consentRequired: Boolean(error?.details?.consentRequired) };
    }
    return await refreshTerms();
  }

  async function acceptRenewedTerms(event) {
    event.preventDefault();
    els.renewTermsMessage.classList.add('hidden');
    if (!state.terms || !els.renewTermsAccepted.checked) {
      els.renewTermsMessage.textContent = '請閱讀並同意目前有效條款。';
      els.renewTermsMessage.classList.remove('hidden');
      return;
    }
    if (state.termsCheckPromise) {
      const stillCurrent = await state.termsCheckPromise;
      if (!stillCurrent || !els.renewTermsAccepted.checked) return;
    }
    els.renewTermsButton.disabled = true;
    try {
      const preflight = await preflightTermsForWrite();
      if (preflight.changed) {
        els.renewTermsMessage.textContent = preflight.terms
          ? '會員條款已更新，已載入最新版本。請重新閱讀並勾選同意後再送出。'
          : '目前尚無有效會員條款，請聯繫管理員。';
        els.renewTermsMessage.classList.remove('hidden');
        return;
      }
      const result = await window.MemberSystem.request(state.config, 'member', state.idToken, 'user.member.terms.accept', {
        termsId:state.terms.id, termsVersion:state.terms.version, accepted:true
      });
      updateTerms(result.terms);
      state.profile = result.profile || state.profile;
      renderProfile(state.profile);
      setView('member');
      announceTourReady(state.profile);
    } catch (error) {
      if (error?.code === 'TERMS_VERSION_STALE') {
        try {
          const fresh = await recoverLatestTerms(error);
          els.renewTermsMessage.textContent = fresh?.terms
            ? '會員條款已更新，已載入最新版本。請重新閱讀並勾選同意後再送出。'
            : '目前尚無有效會員條款，請聯繫管理員。';
        } catch (_) {
          els.renewTermsMessage.textContent = '會員條款已更新，但最新內容載入失敗，請重新整理後再試。';
        }
      } else {
        els.renewTermsMessage.textContent = error?.message || '同意紀錄暫時無法儲存。';
      }
      els.renewTermsMessage.classList.remove('hidden');
    } finally { els.renewTermsButton.disabled = !state.terms; }
  }

  function setSaving(saving) { els.saveProfileButton.disabled = saving || state.profileSaveLocked || !state.terms; els.saveProfileButton.textContent = saving ? '加入中…' : state.profileSaveLocked ? '請重新整理確認' : '加入會員並開啟會員卡'; }
  function showUncertainSaveMessage() { showMessage('無法確認資料是否已儲存。請先重新整理確認；在確認前請勿再次送出。'); els.refreshProfileButton.classList.remove('hidden'); els.saveProfileButton.disabled = true; els.saveProfileButton.textContent = '請重新整理確認'; }
  function showMessage(message) { els.profileFormMessage.textContent = message; els.profileFormMessage.classList.remove('hidden'); }
  function hideMessage() { els.profileFormMessage.textContent = ''; els.profileFormMessage.classList.add('hidden'); if (!state.profileSaveLocked) els.refreshProfileButton.classList.add('hidden'); }

  function prepareBirthdayPicker() {
    const currentYear = new Date().getFullYear();
    const yearOptions = [new Option('選擇年份', '')];
    for (let year = currentYear; year >= 1900; year -= 1) yearOptions.push(new Option(`${year} 年`, String(year)));
    const monthOptions = [new Option('選擇月份', '')];
    for (let month = 1; month <= 12; month += 1) monthOptions.push(new Option(`${month} 月`, padDatePart(month)));
    els.profileBirthdayYear.replaceChildren(...yearOptions);
    els.profileBirthdayMonth.replaceChildren(...monthOptions);
    syncBirthdayDayOptions();
  }

  function openBirthdayPicker() {
    state.birthdayPicker.opener = document.activeElement;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(els.profileBirthday.value || '').trim());
    els.profileBirthdayYear.value = match ? match[1] : '';
    els.profileBirthdayMonth.value = match ? match[2] : '';
    syncBirthdayDayOptions();
    els.profileBirthdayDay.value = match ? match[3] : '';
    updateBirthdayPickerState();
    els.profileBirthdayPickerModal.classList.remove('hidden');
    els.profileBirthdayYear.focus();
  }

  function closeBirthdayPicker() {
    if (els.profileBirthdayPickerModal.classList.contains('hidden')) return;
    els.profileBirthdayPickerModal.classList.add('hidden');
    if (state.birthdayPicker.opener instanceof HTMLElement && document.contains(state.birthdayPicker.opener)) state.birthdayPicker.opener.focus();
    state.birthdayPicker.opener = null;
  }

  function syncBirthdayDayOptions() {
    const selectedDay = String(els.profileBirthdayDay.value || '');
    const year = Number(els.profileBirthdayYear.value);
    const month = Number(els.profileBirthdayMonth.value);
    const maxDay = Number.isInteger(year) && year >= 1900 && month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 31;
    const dayOptions = [new Option('選擇日期', '')];
    for (let day = 1; day <= maxDay; day += 1) dayOptions.push(new Option(`${day} 日`, padDatePart(day)));
    els.profileBirthdayDay.replaceChildren(...dayOptions);
    if (selectedDay && Number(selectedDay) <= maxDay) els.profileBirthdayDay.value = selectedDay;
  }

  function updateBirthdayPickerState() {
    const year = Number(els.profileBirthdayYear.value);
    const month = Number(els.profileBirthdayMonth.value);
    const day = Number(els.profileBirthdayDay.value);
    const date = new Date(Date.UTC(year, month - 1, day));
    const today = new Date();
    const valid = Number.isInteger(year) && year >= 1900 && month >= 1 && month <= 12 && day >= 1 && day <= 31 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day && date.getTime() <= Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
    els.confirmProfileBirthdayPicker.disabled = !valid;
    els.profileBirthdayPickerMessage.textContent = valid ? '日期已完整選擇，按「完成」套用。' : '請選擇完整的年月日。';
  }

  function confirmBirthdayPicker() {
    if (els.confirmProfileBirthdayPicker.disabled) return;
    const value = `${els.profileBirthdayYear.value}-${els.profileBirthdayMonth.value}-${els.profileBirthdayDay.value}`;
    els.profileBirthday.value = value;
    els.profileBirthday.dispatchEvent(new Event('input', { bubbles: true }));
    closeBirthdayPicker();
  }

  function updateBirthdayInputDisplay() {
    const value = String(els.profileBirthday.value || '').trim();
    els.profileBirthdayDisplay.textContent = value ? formatBirthday(value) : '請選擇生日';
    els.profileBirthdayDisplay.classList.toggle('has-value', Boolean(value));
  }

  function formatBirthday(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    return match ? `${Number(match[1])}年${Number(match[2])}月${Number(match[3])}日` : value;
  }

  function padDatePart(value) { return String(value).padStart(2, '0'); }

  function safeTierStyle(value) { const styleKey = String(value || '').trim(); return MEMBER_TIER_STYLE_KEYS.includes(styleKey) ? styleKey : 'forest'; }

  function setView(view) {
    if (view === 'member' && !cardOpenRecorded && document.visibilityState !== 'hidden') {
      cardOpenRecorded = true;
      void window.MemberSystem.request(state.config,'member',state.idToken,'user.member.card.open').catch(() => { cardOpenRecorded = false; });
    }
    els.loadingView.classList.toggle('hidden', view !== 'loading');
    els.errorView.classList.toggle('hidden', view !== 'error');
    els.profileSetupView.classList.toggle('hidden', view !== 'profileSetup');
    els.termsRenewView.classList.toggle('hidden', view !== 'termsRenew');
    els.memberView.classList.toggle('hidden', view !== 'member');
  }

  function startLoginProgress(status, ceiling) {
    stopLoginProgress();
    const maximum = Math.max(loginProgressValue, Math.min(98, Number(ceiling) || loginProgressValue));
    setLoginProgress(loginProgressValue, status);
    loginProgressTimer = window.setInterval(() => {
      const remaining = maximum - loginProgressValue;
      if (remaining <= 0) return stopLoginProgress();
      setLoginProgress(Math.min(maximum, loginProgressValue + Math.max(1, Math.ceil(remaining * .12))), status);
    }, LOGIN_PROGRESS_TICK_MS);
  }

  function stopLoginProgress() {
    if (loginProgressTimer !== null) window.clearInterval(loginProgressTimer);
    loginProgressTimer = null;
  }

  function completeLoginProgress(status) {
    stopLoginProgress();
    // 資料就緒便交還操作，不讓裝飾性動畫阻塞主要畫面。
    setLoginProgress(100, status);
    return Promise.resolve();
  }

  function setLoginProgress(value, status) {
    const progress = Math.max(loginProgressValue, Math.max(0, Math.min(100, Math.round(Number(value) || 0))));
    loginProgressValue = progress;
    els.loadingProgress.setAttribute('aria-valuenow', String(progress));
    els.loadingProgress.setAttribute('aria-valuetext', `${progress}%`);
    els.loadingProgressBar.style.width = `${progress}%`;
    els.loadingProgressText.textContent = `${progress}%`;
    if (status) els.loadingStatus.textContent = status;
  }

  function showError(error) {
    const code = error && error.code;
    els.errorTitle.textContent = code === 'SYSTEM_MAINTENANCE' ? '系統維護中' : code === 'CONFIG_ERROR' ? '系統尚未完成設定' : '會員卡暫時無法載入';
    els.errorMessage.textContent = error && error.message ? error.message : '請稍後重新整理再試。';
    setView('error');
  }
})();
