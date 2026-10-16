(() => {
  'use strict';

  const COLOR_COUNT = 12;

  function normalize(value) {
    return String(value || '其他').trim().toLocaleLowerCase('zh-Hant-TW') || '其他';
  }

  function slot(value) {
    const key = normalize(value);
    let hash = 0;
    for (let index = 0; index < key.length; index += 1) {
      hash = ((hash * 31) + key.charCodeAt(index)) >>> 0;
    }
    return hash % COLOR_COUNT;
  }

  window.BookingServiceTypeColor = Object.freeze({
    count: COLOR_COUNT,
    normalize,
    slot,
  });
})();
