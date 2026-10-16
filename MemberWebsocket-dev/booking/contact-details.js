(() => {
  'use strict';

  const system = window.BookingSystem;
  if (!system || typeof system.request !== 'function' || typeof system.memberProfile !== 'function') return;

  const originalRequest = system.request.bind(system);
  const originalMemberProfile = system.memberProfile.bind(system);
  const REQUEST_TIMEOUT_MS = 15000;
  let cachedProfile = {};
  let latestBookings = [];
  let editingBookingId = '';

  system.memberProfile = async function memberProfileWithBookingFields(config, idToken) {
    const endpoint = `${String(config.supabaseUrl || '').replace(/\/$/, '')}/functions/v1/member-profile-api`;
    const data = await postJson(endpoint, config, {
      action: 'user.member.bootstrap',
      clientType: 'member',
      idToken,
    }, '會員資料服務');
    cachedProfile = data?.profile && typeof data.profile === 'object' ? data.profile : {};
    syncMemberContactSummary();
    return cachedProfile;
  };

  system.request = async function requestWithBookingContact(config, clientType, idToken, action, payload = {}) {
    if (clientType !== 'member') return originalRequest(config, clientType, idToken, action, payload);

    if (action === 'user.booking.bootstrap') {
      const result = await originalRequest(config, clientType, idToken, action, payload);
      const bookings = Array.isArray(result?.bookings) ? result.bookings : [];
      const contacts = bookings.length
        ? await contactRequest(config, idToken, 'user.booking.contacts', { bookingIds: bookings.map((item) => item.bookingId) })
        : { contacts: [] };
      const byId = new Map((contacts.contacts || []).map((item) => [item.bookingId, item]));
      result.bookings = bookings.map((item) => ({ ...item, ...(byId.get(item.bookingId) || {}) }));
      latestBookings = result.bookings;
      return result;
    }

    if (action === 'user.booking.create' || action === 'user.booking.update') {
      const contact = getContactPayload(true);
      const result = await contactRequest(config, idToken, action, { ...payload, ...contact });
      if (result?.booking) {
        latestBookings = [result.booking, ...latestBookings.filter((item) => item.bookingId !== result.booking.bookingId)];
      }
      return result;
    }

    if (action === 'user.booking.cancel') {
      const existing = latestBookings.find((item) => item.bookingId === payload.bookingId) || null;
      const result = await originalRequest(config, clientType, idToken, action, payload);
      if (result?.booking && existing) result.booking = { ...result.booking, ...contactFields(existing) };
      if (result?.booking) latestBookings = latestBookings.map((item) => item.bookingId === result.booking.bookingId ? result.booking : item);
      return result;
    }

    return originalRequest(config, clientType, idToken, action, payload);
  };

  window.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('bookingForm');
    const sourceInputs = [...document.querySelectorAll('input[name="bookingContactSource"]')];
    sourceInputs.forEach((input) => input.addEventListener('change', updateContactMode));

    if (form) {
      form.addEventListener('submit', (event) => {
        const error = validateContact();
        if (!error) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        showFormError(error);
      }, true);
    }

    document.addEventListener('click', (event) => {
      const button = event.target instanceof Element ? event.target.closest('button') : null;
      if (!button) return;
      if (button.id === 'cancelEditBookingButton') {
        editingBookingId = '';
        setMemberContactMode();
        return;
      }
      if (button.textContent?.trim() !== '修改預約') return;
      const item = button.closest('.booking-item');
      const bookingId = String(item?.dataset.bookingId || '');
      const booking = latestBookings.find((entry) => entry.bookingId === bookingId);
      if (!booking) return;
      editingBookingId = bookingId;
      applyBookingContact(booking);
    }, true);

    window.addEventListener('booking:created', () => {
      editingBookingId = '';
      setMemberContactMode();
    });
    updateContactMode();
    syncMemberContactSummary();
  });

  async function contactRequest(config, idToken, action, payload) {
    const endpoint = `${String(config.supabaseUrl || '').replace(/\/$/, '')}/functions/v1/booking-contact-api`;
    return postJson(endpoint, config, { ...payload, action, clientType: 'member', idToken }, '預約聯絡資料服務');
  }

  async function postJson(endpoint, config, body, label) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: String(config.supabasePublishableKey || '') },
        cache: 'no-store',
        signal: controller.signal,
        body: JSON.stringify(window.TestModeClient && typeof window.TestModeClient.payload === 'function'
          ? window.TestModeClient.payload(body)
          : body),
      });
      let data;
      try { data = await response.json(); }
      catch { throw clientError('API_INVALID_RESPONSE', `${label}回傳格式不正確。`); }
      if (!response.ok || data?.ok !== true) {
        const apiError = data?.error || {};
        throw clientError(String(apiError.code || 'API_ERROR'), String(apiError.message || `${label}暫時無法完成操作。`), apiError.details || null);
      }
      return data.data || {};
    } catch (error) {
      if (error?.name === 'AbortError') throw clientError('API_TIMEOUT', `${label}回應逾時，請稍後再試。`);
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function getContactPayload(strict = false) {
    const source = selectedSource();
    if (source === 'member') {
      if (strict && validateMemberContact()) throw clientError('BOOKING_CONTACT_INCOMPLETE', validateMemberContact());
      return { contactSource: 'member' };
    }
    const surname = String(document.getElementById('bookingContactSurname')?.value || '').trim();
    const salutation = String(document.getElementById('bookingContactSalutation')?.value || '').trim();
    const phone = String(document.getElementById('bookingContactPhone')?.value || '').trim();
    if (strict) {
      const error = validateCustomContact(surname, salutation, phone);
      if (error) throw clientError('INVALID_BOOKING_CONTACT', error);
    }
    return { contactSource: 'custom', contactSurname: surname, contactSalutation: salutation, contactPhone: phone };
  }

  function selectedSource() {
    return String(document.querySelector('input[name="bookingContactSource"]:checked')?.value || 'member');
  }

  function validateContact() {
    if (selectedSource() === 'member') return validateMemberContact();
    return validateCustomContact(
      String(document.getElementById('bookingContactSurname')?.value || '').trim(),
      String(document.getElementById('bookingContactSalutation')?.value || '').trim(),
      String(document.getElementById('bookingContactPhone')?.value || '').trim(),
    );
  }

  function validateMemberContact() {
    const surname = String(cachedProfile.surname || '').trim();
    const salutation = String(cachedProfile.salutation || '').trim();
    const phone = normalizePhone(cachedProfile.phone);
    if (!surname || !['mr', 'ms'].includes(salutation) || !/^\+?\d{8,15}$/.test(phone)) {
      return '會員資料中的姓氏、稱謂或電話尚未完整，請先回會員卡補齊，或改選「本次重新填寫」。';
    }
    return '';
  }

  function validateCustomContact(surname, salutation, phone) {
    if (!surname) return '請填寫本次預約姓氏。';
    if (!['mr', 'ms'].includes(salutation)) return '請選擇本次預約稱謂。';
    if (!/^\+?\d{8,15}$/.test(normalizePhone(phone))) return '請填寫正確的本次預約電話。';
    return '';
  }

  function updateContactMode() {
    const custom = selectedSource() === 'custom';
    const panel = document.getElementById('bookingCustomContactFields');
    if (panel) panel.classList.toggle('hidden', !custom);
    ['bookingContactSurname', 'bookingContactSalutation', 'bookingContactPhone'].forEach((id) => {
      const input = document.getElementById(id);
      if (input) input.required = custom;
    });
    syncMemberContactSummary();
  }

  function syncMemberContactSummary() {
    const summary = document.getElementById('bookingMemberContactSummary');
    if (!summary) return;
    const surname = String(cachedProfile.surname || '').trim();
    const label = salutationLabel(cachedProfile.salutation);
    const phone = String(cachedProfile.phone || '').trim();
    summary.textContent = surname && label && phone ? `${surname}${label}｜${phone}` : '會員預約資料尚未完整，可選擇本次重新填寫。';
  }

  function setMemberContactMode() {
    const radio = document.querySelector('input[name="bookingContactSource"][value="member"]');
    if (radio) radio.checked = true;
    updateContactMode();
  }

  function applyBookingContact(booking) {
    const source = String(booking.contactSource || 'member');
    const radio = document.querySelector(`input[name="bookingContactSource"][value="${source === 'custom' ? 'custom' : 'member'}"]`);
    if (radio) radio.checked = true;
    if (source === 'custom') {
      setInputValue('bookingContactSurname', booking.contactSurname || '');
      setInputValue('bookingContactSalutation', booking.contactSalutation || '');
      setInputValue('bookingContactPhone', booking.contactPhone || '');
    }
    updateContactMode();
  }

  function contactFields(booking) {
    return {
      contactSource: booking.contactSource || 'member',
      contactSurname: booking.contactSurname || '',
      contactSalutation: booking.contactSalutation || '',
      contactSalutationLabel: booking.contactSalutationLabel || salutationLabel(booking.contactSalutation),
      contactPhone: booking.contactPhone || '',
    };
  }

  function showFormError(message) {
    const element = document.getElementById('formMessage');
    if (!element) return;
    element.textContent = message;
    element.className = 'form-message error';
  }

  function normalizePhone(value) { return String(value || '').replace(/[()\s-]/g, ''); }
  function salutationLabel(value) { return value === 'mr' ? '先生' : value === 'ms' ? '小姐' : ''; }
  function setInputValue(id, value) { const element = document.getElementById(id); if (element) element.value = String(value || ''); }
  function clientError(code, message, details = null) { const error = new Error(message); error.code = code; error.details = details; return error; }

  void originalMemberProfile;
})();
