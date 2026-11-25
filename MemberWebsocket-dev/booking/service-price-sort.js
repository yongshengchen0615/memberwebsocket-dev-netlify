(() => {
  'use strict';

  // Display sorting only: keep the API catalog and the member's selection order intact.
  function priceOf(service) {
    const value = service?.priceAmount;
    if (value === null || value === undefined || value === '') return Number.POSITIVE_INFINITY;
    const amount = Number(value);
    return Number.isFinite(amount) ? amount : Number.POSITIVE_INFINITY;
  }

  function compareServicesByPrice(left, right) {
    const aPrice = priceOf(left);
    const bPrice = priceOf(right);
    if (aPrice !== bPrice) return aPrice < bPrice ? -1 : 1;
    return String(left?.title || '').localeCompare(String(right?.title || ''), 'zh-Hant') ||
      String(left?.serviceId || '').localeCompare(String(right?.serviceId || ''));
  }

  function sortEntriesByPrice(entries, getService) {
    const readService = typeof getService === 'function' ? getService : (entry) => entry;
    return (Array.isArray(entries) ? entries : []).slice()
      .sort((left, right) => compareServicesByPrice(readService(left), readService(right)));
  }

  window.BookingServicePriceSort = Object.freeze({ sortEntriesByPrice });
})();
