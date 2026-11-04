(() => {
  'use strict';

  let currentProfile = null;
  let modalOpener = null;
  let phoneOtpSentTo = '';
  let phoneOtpSending = false;

  window.addEventListener('DOMContentLoaded', () => {
    // Initial membership registration is owned by member/app.js because it
    // must submit profile fields and the exact membership terms consent in one
    // canonical write. Do not intercept #profileForm here.
    document.getElementById('editHonorificButton')?.addEventListener('click', openHonorificModal);
    document.getElementById('closeHonorificEditButton')?.addEventListener('click', () => closeProfileModal('honorific'));
    document.getElementById('cancelHonorificEditButton')?.addEventListener('click', () => closeProfileModal('honorific'));
    document.getElementById('saveHonorificEditButton')?.addEventListener('click', saveHonorificProfile);

    document.getElementById('editPhoneButton')?.addEventListener('click', openPhoneModal);
    document.getElementById('closePhoneEditButton')?.addEventListener('click', () => closeProfileModal('phone'));
    document.getElementById('cancelPhoneEditButton')?.addEventListener('click', () => closeProfileModal('phone'));
    document.getElementById('savePhoneEditButton')?.addEventListener('click', savePhoneProfile);
    document.getElementById('phoneEditSendCodeButton')?.addEventListener('click', sendPhoneEditCode);
    document.getElementById('phoneEditInput')?.addEventListener('input', resetPhoneEditCode);
    document.getElementById('phoneEditCountryCode')?.addEventListener('change', resetPhoneEditCode);

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (!document.getElementById('honorificEditModal')?.classList.contains('hidden')) closeProfileModal('honorific');
      else if (!document.getElementById('phoneEditModal')?.classList.contains('hidden')) closeProfileModal('phone');
    });

    window.addEventListener('member-profile-ready', (event) => {
      const profile = event?.detail?.profile;
      if (!profile || typeof profile !== 'object') return;
      currentProfile = profile;
      applyProfileDisplay(profile);
    });
  });

  async function saveExtendedProfile(event) {
    event.preventDefault();
    event.stopImmediatePropagation();

    const surname = valueOf('profileSurname');
    const salutation = valueOf('profileSalutation');
    const birthday = valueOf('profileBirthday');
    const phone = window.MemberPhone?.compose(valueOf('profileCountryCode'), valueOf('profilePhone')) || '';

    if (!surname) return showMessage('請填寫姓氏。');
    if (!['mr', 'ms'].includes(salutation)) return showMessage('請選擇先生或小姐。');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthday)) return showMessage('請填寫正確的生日。');
    if (!phone) return showMessage('請選擇國碼並填寫正確的電話號碼。');

    const button = document.getElementById('saveProfileButton');
    if (button?.disabled) return;
    setSaving(true);
    hideMessage();

    try {
      const result = await requestProfile('user.member.profile.save', {
        surname,
        salutation,
        birthday,
        phone,
      });
      publishProfile(result.profile || { ...(currentProfile || {}), surname, salutation, birthday, phone });
      window.location.reload();
    } catch (error) {
      if (error?.code === 'API_RESPONSE_UNCERTAIN') {
        showMessage('無法確認會員資料是否已儲存。請重新整理確認；系統不會自動重送這次寫入。');
        setProfileWriteUncertain();
      } else {
        showMessage(error?.message || '會員資料暫時無法儲存，請稍後再試。');
        setSaving(false);
      }
    }
  }

  async function openHonorificModal(event) {
    modalOpener = event?.currentTarget || document.activeElement;
    closeProfileModal('phone', false);
    openProfileModal('honorific');
    setModalSaving('honorific', false);
    showModalMessage('honorific', '正在準備會員資料…');
    try {
      const profile = await ensureCurrentProfile();
      hideModalMessage('honorific');
      setValue('honorificSurnameInput', String(profile.surname || ''));
      setValue('honorificSalutationSelect', String(profile.salutation || '').toLowerCase());
      document.getElementById('honorificSurnameInput')?.focus();
    } catch (error) {
      showModalMessage('honorific', error?.message || '會員資料尚在同步，請稍後再試。');
    }
  }

  async function openPhoneModal(event) {
    modalOpener = event?.currentTarget || document.activeElement;
    closeProfileModal('honorific', false);
    openProfileModal('phone');
    setModalSaving('phone', false);
    showModalMessage('phone', '正在準備會員資料…');
    try {
      const profile = await ensureCurrentProfile();
      hideModalMessage('phone');
      applyPhoneInputs('phoneEditCountryCode', 'phoneEditInput', profile.phone);
      phoneOtpSentTo = '';
      setValue('phoneEditCode', '');
      renderPhoneEditVerification();
      document.getElementById('phoneEditInput')?.focus();
    } catch (error) {
      showModalMessage('phone', error?.message || '會員資料尚在同步，請稍後再試。');
    }
  }

  function openProfileModal(type) {
    const modal = document.getElementById(type === 'honorific' ? 'honorificEditModal' : 'phoneEditModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    document.body.classList.add('profile-modal-open');
  }

  function closeProfileModal(type, restoreFocus = true) {
    const modal = document.getElementById(type === 'honorific' ? 'honorificEditModal' : 'phoneEditModal');
    if (!modal || modal.classList.contains('hidden')) return;
    modal.classList.add('hidden');
    hideModalMessage(type);
    if (type === 'phone') {
      phoneOtpSentTo = '';
      setValue('phoneEditCode', '');
    }
    if (document.getElementById('honorificEditModal')?.classList.contains('hidden') && document.getElementById('phoneEditModal')?.classList.contains('hidden')) {
      document.body.classList.remove('profile-modal-open');
    }
    if (restoreFocus && modalOpener instanceof HTMLElement && document.contains(modalOpener)) modalOpener.focus();
    if (restoreFocus) modalOpener = null;
  }

  async function saveHonorificProfile() {
    const surname = valueOf('honorificSurnameInput');
    const salutation = valueOf('honorificSalutationSelect').toLowerCase();

    if (!surname) return showModalMessage('honorific', '請填寫姓氏。');
    if (!['mr', 'ms'].includes(salutation)) return showModalMessage('honorific', '請選擇先生或小姐。');

    let uncertain = false;
    setModalSaving('honorific', true);
    hideModalMessage('honorific');
    try {
      const result = await saveProfilePayload({ surname, salutation });
      publishProfile(result.profile || { ...(currentProfile || {}), surname, salutation });
      closeProfileModal('honorific');
    } catch (error) {
      uncertain = error?.code === 'API_RESPONSE_UNCERTAIN';
      showModalMessage('honorific', uncertain
        ? '無法確認這次修改是否完成。請關閉視窗後重新整理確認；系統不會自動重送。'
        : error?.message || '稱呼暫時無法儲存，請稍後再試。');
    } finally {
      if (uncertain) setModalWriteUncertain('honorific');
      else setModalSaving('honorific', false);
    }
  }

  function phoneEditCandidate() {
    return window.MemberPhone?.compose(valueOf('phoneEditCountryCode'), valueOf('phoneEditInput')) || '';
  }

  function phoneEditHasChanged(phone) {
    const previous = window.MemberPhone?.normalizeStored(currentProfile?.phone) || String(currentProfile?.phone || '').trim();
    return Boolean(phone && phone !== previous);
  }

  function renderPhoneEditVerification() {
    const phone = phoneEditCandidate();
    const changed = phoneEditHasChanged(phone);
    const required = currentProfile?.phoneVerificationRequired === true;
    document.getElementById('phoneEditVerification')?.classList.toggle('hidden', !required || !changed);
    const status = document.getElementById('phoneEditStatusMessage');
    if (status) status.textContent = !required ? '' : changed
      ? '新電話必須重新完成簡訊認證，原電話不會提前變更。'
      : currentProfile?.phoneVerified === true
        ? '目前電話已驗證，不必重複驗證。'
        : '電話沒有變更，不需要重新發送簡訊。';
  }

  function resetPhoneEditCode() {
    const phone = phoneEditCandidate();
    if (phone !== phoneOtpSentTo) {
      phoneOtpSentTo = '';
      setValue('phoneEditCode', '');
      const hint = document.getElementById('phoneEditVerificationMessage');
      if (hint) hint.textContent = '請先發送新號碼的簡訊驗證碼，再輸入 6 位數驗證碼。';
    }
    renderPhoneEditVerification();
  }

  async function sendPhoneEditCode() {
    if (phoneOtpSending) return;
    const phone = phoneEditCandidate();
    if (!phone) return showModalMessage('phone', '請先填寫正確的手機號碼。');
    if (!phoneEditHasChanged(phone)) return showModalMessage('phone', '目前號碼未變更，不需要重複驗證。');
    const button = document.getElementById('phoneEditSendCodeButton');
    const hint = document.getElementById('phoneEditVerificationMessage');
    phoneOtpSending = true;
    if (button) { button.disabled = true; button.textContent = '正在發送…'; }
    hideModalMessage('phone');
    try {
      const result = await requestProfile('user.member.phone.send', { phone });
      if (phoneEditCandidate() !== phone) {
        phoneOtpSentTo = '';
        if (hint) hint.textContent = '電話號碼已變更，請重新發送驗證碼。';
      } else if (result.alreadyVerified === true) {
        phoneOtpSentTo = '';
        if (hint) hint.textContent = '這支電話已完成驗證，不需要再次發送簡訊。';
      } else {
        phoneOtpSentTo = phone;
        setValue('phoneEditCode', '');
        if (hint) hint.textContent = '驗證碼已發送，輸入後點選「儲存」完成新電話綁定。';
        document.getElementById('phoneEditCode')?.focus();
      }
    } catch (error) {
      showModalMessage('phone', error?.message || '簡訊暫時無法發送，請稍後再試。');
    } finally {
      phoneOtpSending = false;
      if (button) { button.disabled = false; button.textContent = '重新發送驗證碼'; }
    }
  }

  async function savePhoneProfile() {
    const phone = phoneEditCandidate();
    if (!phone) return showModalMessage('phone', '請選擇國碼並填寫正確的電話號碼。');
    if (!phoneEditHasChanged(phone)) { closeProfileModal('phone'); return; }

    const required = currentProfile?.phoneVerificationRequired === true;
    const otpCode = valueOf('phoneEditCode');
    if (required && (phoneOtpSentTo !== phone || !/^[0-9]{6}$/.test(otpCode))) {
      return showModalMessage('phone', '請先發送新電話的簡訊驗證碼，並輸入收到的 6 位數驗證碼。');
    }

    let uncertain = false;
    setModalSaving('phone', true);
    hideModalMessage('phone');
    try {
      const result = await saveProfilePayload({ phone, ...(required ? { otpCode } : {}) });
      publishProfile(result.profile || { ...(currentProfile || {}), phone, phoneVerified: required });
      closeProfileModal('phone');
    } catch (error) {
      uncertain = error?.code === 'API_RESPONSE_UNCERTAIN';
      showModalMessage('phone', uncertain
        ? '無法確認新電話是否已儲存，請重新整理會員資料確認；系統不會自動重送。'
        : error?.message || '電話暫時無法儲存，請稍後再試。');
    } finally {
      if (uncertain) setModalWriteUncertain('phone');
      else setModalSaving('phone', false);
    }
  }

  async function saveProfilePayload(payload) {
    return requestProfile('user.member.profile.save', payload);
  }

  async function ensureCurrentProfile() {
    if (currentProfile && typeof currentProfile === 'object') return currentProfile;
    const result = await requestProfile('user.member.bootstrap');
    const profile = result?.profile && typeof result.profile === 'object' ? result.profile : null;
    if (!profile) throw new Error('會員資料尚未準備完成，請重新整理後再試。');
    currentProfile = profile;
    applyProfileDisplay(profile);
    return profile;
  }

  function resolveSession() {
    const system = window.MemberSystem;
    if (!system || typeof system.getSession !== 'function' || typeof system.request !== 'function') {
      throw new Error('會員系統尚未準備完成。');
    }
    const session = system.getSession('member');
    if (!session) throw new Error('登入尚未完成，請重新整理後再試。');
    return session;
  }

  function requestProfile(action, payload = {}) {
    const system = window.MemberSystem;
    const { config, idToken } = resolveSession();
    return system.request(config, 'member', idToken, action, payload);
  }

  function publishProfile(profile) {
    if (!profile || typeof profile !== 'object') return;
    currentProfile = profile;
    applyProfileDisplay(profile);
    window.dispatchEvent(new CustomEvent('member-profile-updated', { detail: { profile } }));
  }

  function setModalWriteUncertain(type) {
    setModalSaving(type, false);
    const saveButton = document.getElementById(type === 'honorific' ? 'saveHonorificEditButton' : 'savePhoneEditButton');
    if (!saveButton) return;
    saveButton.disabled = true;
    saveButton.textContent = '請重新整理確認';
  }

  function applyProfileDisplay(profile) {
    if (!profile || typeof profile !== 'object') return;
    const surname = String(profile.surname || '').trim();
    const salutation = String(profile.salutation || '').trim().toLowerCase();
    const salutationLabel = salutation === 'mr' ? '先生' : salutation === 'ms' ? '小姐' : '';
    const honorificName = surname && salutationLabel ? `${surname}${salutationLabel}` : surname || salutationLabel;
    const phone = String(profile.phone || '').trim();

    setValue('profileSurname', surname);
    setValue('profileSalutation', salutation);
    applyPhoneInputs('profileCountryCode', 'profilePhone', phone);
    setValue('profileBirthday', String(profile.birthday || ''));
    setValue('honorificSurnameInput', surname);
    setValue('honorificSalutationSelect', salutation);
    applyPhoneInputs('phoneEditCountryCode', 'phoneEditInput', phone);

    const honorificDisplay = document.getElementById('memberHonorificName');
    const phoneDisplay = document.getElementById('memberPhone');
    if (honorificDisplay) honorificDisplay.textContent = honorificName || '未填寫';
    if (phoneDisplay) phoneDisplay.textContent = phone || '未填寫';
  }

  function setModalSaving(type, saving) {
    const saveButton = document.getElementById(type === 'honorific' ? 'saveHonorificEditButton' : 'savePhoneEditButton');
    const cancelButton = document.getElementById(type === 'honorific' ? 'cancelHonorificEditButton' : 'cancelPhoneEditButton');
    const closeButton = document.getElementById(type === 'honorific' ? 'closeHonorificEditButton' : 'closePhoneEditButton');
    const inputs = type === 'honorific'
      ? [document.getElementById('honorificSurnameInput'), document.getElementById('honorificSalutationSelect')]
      : [document.getElementById('phoneEditCountryCode'), document.getElementById('phoneEditInput'), document.getElementById('phoneEditCode'), document.getElementById('phoneEditSendCodeButton')];

    if (saveButton) {
      saveButton.disabled = saving;
      saveButton.textContent = saving ? '儲存中…' : '儲存';
    }
    if (cancelButton) cancelButton.disabled = saving;
    if (closeButton) closeButton.disabled = saving;
    inputs.forEach((input) => { if (input) input.disabled = saving; });
  }

  function showModalMessage(type, message) {
    const element = document.getElementById(type === 'honorific' ? 'honorificEditMessage' : 'phoneEditMessage');
    if (!element) return;
    element.textContent = String(message || '');
    element.classList.remove('hidden');
  }

  function hideModalMessage(type) {
    const element = document.getElementById(type === 'honorific' ? 'honorificEditMessage' : 'phoneEditMessage');
    if (!element) return;
    element.textContent = '';
    element.classList.add('hidden');
  }

  function valueOf(id) {
    return String(document.getElementById(id)?.value || '').trim();
  }

  function setValue(id, value) {
    const element = document.getElementById(id);
    if (!element) return;
    if (element.value !== value) {
      element.value = value;
      if (id === 'profileBirthday') element.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function applyPhoneInputs(countryId, numberId, phone) {
    const parts = window.MemberPhone?.split(phone) || { countryCode: '+886', localNumber: String(phone || '') };
    setValue(countryId, parts.countryCode);
    setValue(numberId, parts.localNumber);
  }

  function setSaving(saving) {
    const button = document.getElementById('saveProfileButton');
    if (!button) return;
    button.disabled = saving;
    button.textContent = saving ? '加入中…' : '加入會員並開啟會員卡';
  }

  function setProfileWriteUncertain() {
    const button = document.getElementById('saveProfileButton');
    if (!button) return;
    button.disabled = true;
    button.textContent = '請重新整理確認';
  }

  function showMessage(message) {
    const element = document.getElementById('profileFormMessage');
    if (!element) return;
    element.textContent = String(message || '');
    element.classList.remove('hidden');
  }

  function hideMessage() {
    const element = document.getElementById('profileFormMessage');
    if (!element) return;
    element.textContent = '';
    element.classList.add('hidden');
  }

})();
