(() => {
  'use strict';

  // Booking contacts use local mobile digits; member profile identity remains E.164.
  function format(value) {
    const phone = String(value ?? '').trim();
    const compact = phone.replace(/[()\s.\-]/g, '');
    const match = /^(?:\+?8860?9|09)(\d{8})$/.exec(compact);
    return match ? `09${match[1]}` : phone;
  }

  window.BookingContactPhone = Object.freeze({ format });
})();
