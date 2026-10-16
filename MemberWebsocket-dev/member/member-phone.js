(() => {
  'use strict';

  const COUNTRY_CODES = Object.freeze([
    ['+886', '台灣 +886'],
    ['+86', '中國 +86'],
    ['+852', '香港 +852'],
    ['+853', '澳門 +853'],
    ['+81', '日本 +81'],
    ['+82', '韓國 +82'],
    ['+65', '新加坡 +65'],
    ['+60', '馬來西亞 +60'],
    ['+66', '泰國 +66'],
    ['+84', '越南 +84'],
    ['+63', '菲律賓 +63'],
    ['+62', '印尼 +62'],
    ['+1', '美國／加拿大 +1'],
    ['+44', '英國 +44'],
    ['+61', '澳洲 +61'],
    ['+64', '紐西蘭 +64'],
    ['+91', '印度 +91'],
    ['+971', '阿聯酋 +971'],
    ['+33', '法國 +33'],
    ['+49', '德國 +49'],
  ]);

  const TRUNK_ZERO_CODES = new Set(['+886', '+81', '+82', '+60', '+66', '+84', '+63', '+62', '+44', '+61', '+64', '+33', '+49']);
  const SUPPORTED_CODES = COUNTRY_CODES.map(([code]) => code).sort((a, b) => b.length - a.length);

  function compact(value) {
    return String(value || '').trim().replace(/[()\s.\-]/g, '');
  }

  function isValidE164(value) {
    return /^\+[1-9]\d{7,14}$/.test(String(value || ''));
  }

  function hasSuspiciousRepetition(value) {
    const digits = String(value || '').replace(/\D/g, '');
    return /(\d)\1{6,}/.test(digits);
  }

  function isValidPhone(value) {
    const phone = String(value || '');
    if (!isValidE164(phone) || hasSuspiciousRepetition(phone)) return false;
    if (phone.startsWith('+886')) {
      return /^\+886(?:9\d{8}|[2-8]\d{7,8})$/.test(phone);
    }
    return true;
  }

  function normalizeStored(value) {
    const phone = compact(value);
    if (isValidPhone(phone)) return phone;
    if (/^0\d{8,9}$/.test(phone)) return `+886${phone.slice(1)}`;
    return '';
  }

  function compose(countryCode, localNumber) {
    const code = String(countryCode || '').trim();
    if (!/^\+[1-9]\d{0,2}$/.test(code)) return '';
    let local = compact(localNumber);
    if (local.startsWith('+')) return isValidPhone(local) ? local : '';
    if (!/^\d{5,14}$/.test(local)) return '';
    if (TRUNK_ZERO_CODES.has(code) && local.startsWith('0')) local = local.slice(1);
    const phone = `${code}${local}`;
    return isValidPhone(phone) ? phone : '';
  }

  function split(value, fallbackCountryCode = '+886') {
    const raw = compact(value);
    if (/^0\d{8,9}$/.test(raw)) return { countryCode: '+886', localNumber: raw };
    const normalized = normalizeStored(raw);
    if (!normalized) return { countryCode: fallbackCountryCode, localNumber: raw };
    const countryCode = SUPPORTED_CODES.find((code) => normalized.startsWith(code)) || fallbackCountryCode;
    let localNumber = normalized.slice(countryCode.length);
    if (TRUNK_ZERO_CODES.has(countryCode) && localNumber) localNumber = `0${localNumber}`;
    return { countryCode, localNumber };
  }

  window.MemberPhone = Object.freeze({ COUNTRY_CODES, compose, split, normalizeStored, isValidE164, isValidPhone });
})();
