(() => {
  'use strict';

  // Compatibility asset only.
  // Current admin booking cards are rendered once by booking-panel-core.js from
  // the canonical booking/contact/group/resource data model. Keep this file so
  // older cached loaders can still request the historical URL without a 404,
  // but do not parse or decorate rendered booking DOM.
  window.bookingSummaryLegacyRemoved = true;
})();
