(() => {
  'use strict';

  let opener = null;
  let saving = false;
  let currentProfile = null;

  window.addEventListener('DOMContentLoaded', () => {
    prepareBirthdayEditPicker();

    document.getElementById('editBirthdayButton')?.addEventListener('click', openBirthdayModal);
    document.getElementById('closeBirthdayEditButton')?.addEventListener('click', closeBirthdayModal);
    document.getElementById('cancelBirthdayEditButton')?.addEventListener('click', closeBirthdayModal);
    document.getElementById('saveBirthdayEditButton')?.addEventListener('click', saveBirthday);

    document.getElementById('birthdayEditYear')?.addEventListener('change', () => {
      syncBirthdayEditDayOptions();
      updateBirthdayEditState();
    });
    document.getElementById('birthdayEditMonth')?.addEventListener('change', () => {
      syncBirthdayEditDayOptions();
      updateBirthdayEditState();
    });
    document.getElementById('birthdayEditDay')?.addEventListener('change', updateBirthdayEditState);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeBirthdayModal();
    });
    window.addEventListener('member-profile-ready', (event) => {
      const profile = event?.detail?.profile;
      if (profile && typeof profile === 'object') currentProfile = profile;
    });
  });

  function prepareBirthdayEditPicker() {
    const input = document.getElementById('birthdayEditInput');
    const fields = input?.closest('.profile-edit-modal-fields');
    if (!fields) return;

    fields.classList.add('date-picker-fields');
    fields.replaceChildren(
      createDateSelectField('birthdayEditYear', '年份'),
      createDateSelectField('birthdayEditMonth', '月份'),
      createDateSelectField('birthdayEditDay', '日期'),
    );

    const currentYear = new Date().getFullYear();
    const year = document.getElementById('birthdayEditYear');
    const month = document.getElementById('birthdayEditMonth');
    if (!year || !month) return;

    year.replaceChildren(new Option('選擇年份', ''));
    for (let value = currentYear; value >= 1900; value -= 1) {
      year.appendChild(new Option(`${value} 年`, String(value)));
    }

    month.replaceChildren(new Option('選擇月份', ''));
    for (let value = 1; value <= 12; value += 1) {
      month.appendChild(new Option(`${value} 月`, padDatePart(value)));
    }

    syncBirthdayEditDayOptions();
    updateBirthdayEditState();
  }

  function createDateSelectField(id, labelText) {
    const label = document.createElement('label');
    label.setAttribute('for', id);
    label.append(document.createTextNode(labelText));
    const select = document.createElement('select');
    select.id = id;
    select.setAttribute('aria-label', labelText);
    label.appendChild(select);
    return label;
  }

  async function openBirthdayModal(event) {
    const modal = document.getElementById('birthdayEditModal');
    if (!modal) return;
    opener = event?.currentTarget || document.activeElement;
    modal.classList.remove('hidden');
    document.body.classList.add('profile-modal-open');
    setWriteUncertain(false);
    showMessage('正在準備會員資料…');

    try {
      const profile = await ensureCurrentProfile();
      applyBirthdayToPicker(String(profile.birthday || '').trim());
      hideMessage();
      if (!modal.classList.contains('hidden')) document.getElementById('birthdayEditYear')?.focus();
    } catch (error) {
      clearBirthdayEditPicker();
      showMessage(error?.message || '會員資料尚未準備完成，請重新整理後再試。');
    }
  }

  function closeBirthdayModal() {
    const modal = document.getElementById('birthdayEditModal');
    if (!modal || modal.classList.contains('hidden') || saving) return;
    modal.classList.add('hidden');
    hideMessage();
    if (document.getElementById('honorificEditModal')?.classList.contains('hidden') &&
        document.getElementById('phoneEditModal')?.classList.contains('hidden')) {
      document.body.classList.remove('profile-modal-open');
    }
    if (opener instanceof HTMLElement && document.contains(opener)) opener.focus();
    opener = null;
  }

  async function saveBirthday() {
    if (saving) return;
    const birthday = selectedBirthday();
    if (!isValidBirthday(birthday)) return showMessage('請選擇完整且正確的生日，日期不可晚於今天。');

    setSaving(true);
    hideMessage();
    try {
      const result = await requestProfile('user.member.profile.save', { birthday });
      const profile = result.profile || { ...(currentProfile || {}), birthday };
      publishProfile(profile);
      applyBirthdayToPicker(String(profile.birthday || birthday));
      setSaving(false);
      closeBirthdayModal();
    } catch (error) {
      const uncertain = error?.code === 'API_RESPONSE_UNCERTAIN';
      showMessage(uncertain
        ? '無法確認生日是否已儲存。請關閉視窗後重新整理確認；系統不會自動重送。'
        : error?.message || '生日暫時無法儲存，請稍後再試。');
      setSaving(false);
      if (uncertain) setWriteUncertain(true);
    }
  }

  function applyBirthdayToPicker(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    const year = document.getElementById('birthdayEditYear');
    const month = document.getElementById('birthdayEditMonth');
    const day = document.getElementById('birthdayEditDay');
    if (!year || !month || !day) return;

    year.value = match ? match[1] : '';
    month.value = match ? match[2] : '';
    syncBirthdayEditDayOptions();
    day.value = match ? match[3] : '';
    updateBirthdayEditState();
  }

  function clearBirthdayEditPicker() {
    const year = document.getElementById('birthdayEditYear');
    const month = document.getElementById('birthdayEditMonth');
    const day = document.getElementById('birthdayEditDay');
    if (year) year.value = '';
    if (month) month.value = '';
    syncBirthdayEditDayOptions();
    if (day) day.value = '';
    updateBirthdayEditState();
  }

  function syncBirthdayEditDayOptions() {
    const year = document.getElementById('birthdayEditYear');
    const month = document.getElementById('birthdayEditMonth');
    const day = document.getElementById('birthdayEditDay');
    if (!year || !month || !day) return;

    const selectedDay = String(day.value || '');
    const yearValue = Number(year.value);
    const monthValue = Number(month.value);
    const maxDay = Number.isInteger(yearValue) && yearValue >= 1900 && monthValue >= 1 && monthValue <= 12
      ? new Date(Date.UTC(yearValue, monthValue, 0)).getUTCDate()
      : 31;

    day.replaceChildren(new Option('選擇日期', ''));
    for (let value = 1; value <= maxDay; value += 1) {
      day.appendChild(new Option(`${value} 日`, padDatePart(value)));
    }
    if (selectedDay && Number(selectedDay) <= maxDay) day.value = selectedDay;
  }

  function updateBirthdayEditState() {
    const birthday = selectedBirthday();
    const valid = isValidBirthday(birthday);
    const message = document.getElementById('birthdayEditMessage');
    const saveButton = document.getElementById('saveBirthdayEditButton');

    if (saveButton && !saving) saveButton.disabled = !valid;
    if (!message || !message.classList.contains('hidden')) return;
    message.textContent = '';
  }

  function selectedBirthday() {
    const year = String(document.getElementById('birthdayEditYear')?.value || '');
    const month = String(document.getElementById('birthdayEditMonth')?.value || '');
    const day = String(document.getElementById('birthdayEditDay')?.value || '');
    return year && month && day ? `${year}-${month}-${day}` : '';
  }

  async function ensureCurrentProfile() {
    if (currentProfile && typeof currentProfile === 'object') return currentProfile;
    const result = await requestProfile('user.member.bootstrap');
    const profile = result?.profile && typeof result.profile === 'object' ? result.profile : null;
    if (!profile) throw new Error('會員資料尚未準備完成，請重新整理後再試。');
    currentProfile = profile;
    return profile;
  }

  function requestProfile(action, payload = {}) {
    const system = window.MemberSystem;
    if (!system || typeof system.getSession !== 'function' || typeof system.request !== 'function') {
      throw new Error('會員系統尚未準備完成。');
    }
    const session = system.getSession('member');
    if (!session) throw new Error('登入尚未完成，請重新整理後再試。');
    return system.request(session.config, 'member', session.idToken, action, payload);
  }

  function publishProfile(profile) {
    if (!profile || typeof profile !== 'object') return;
    currentProfile = profile;
    const updatedBirthday = String(profile.birthday || '');
    const display = document.getElementById('memberBirthday');
    if (display) display.textContent = updatedBirthday || '未填寫';
    const setupInput = document.getElementById('profileBirthday');
    if (setupInput && setupInput.value !== updatedBirthday) {
      setupInput.value = updatedBirthday;
      setupInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    window.dispatchEvent(new CustomEvent('member-profile-updated', { detail: { profile } }));
  }

  function isValidBirthday(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (year < 1900 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return false;
    return value <= todayIsoDate();
  }

  function todayIsoDate() {
    const now = new Date();
    return `${now.getFullYear()}-${padDatePart(now.getMonth() + 1)}-${padDatePart(now.getDate())}`;
  }

  function padDatePart(value) {
    return String(value).padStart(2, '0');
  }

  function normalizePhone(value) {
    return String(value || '').replace(/[()\s-]/g, '');
  }

  function setSaving(value) {
    saving = value;
    const saveButton = document.getElementById('saveBirthdayEditButton');
    const cancelButton = document.getElementById('cancelBirthdayEditButton');
    const closeButton = document.getElementById('closeBirthdayEditButton');
    const inputs = [
      document.getElementById('birthdayEditYear'),
      document.getElementById('birthdayEditMonth'),
      document.getElementById('birthdayEditDay'),
    ];

    if (saveButton) {
      saveButton.disabled = value || !isValidBirthday(selectedBirthday());
      saveButton.textContent = value ? '儲存中…' : '儲存';
    }
    if (cancelButton) cancelButton.disabled = value;
    if (closeButton) closeButton.disabled = value;
    inputs.forEach((input) => { if (input) input.disabled = value; });
  }

  function setWriteUncertain(value) {
    const saveButton = document.getElementById('saveBirthdayEditButton');
    if (!saveButton) return;
    if (value) {
      saveButton.disabled = true;
      saveButton.textContent = '請重新整理確認';
    } else {
      saveButton.textContent = '儲存';
      saveButton.disabled = !isValidBirthday(selectedBirthday());
    }
  }

  function showMessage(message) {
    const element = document.getElementById('birthdayEditMessage');
    if (!element) return;
    element.textContent = String(message || '');
    element.classList.remove('hidden');
  }

  function hideMessage() {
    const element = document.getElementById('birthdayEditMessage');
    if (!element) return;
    element.textContent = '';
    element.classList.add('hidden');
  }
})();