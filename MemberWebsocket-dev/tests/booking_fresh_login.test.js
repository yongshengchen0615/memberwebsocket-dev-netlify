const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../booking/liff-fresh-login.js'), 'utf8');

for (const loggedIn of [false, true]) {
  test(`booking login return does not loop (logged in: ${loggedIn})`, async () => {
    let redirects = 0;
    let cleanedUrl = '';
    const window = {
      location: { href: 'https://example.test/booking/?booking_system_reauth=booking' },
      history: { replaceState: (_, __, url) => { cleanedUrl = url; } },
      BookingSystem: { signIn: async () => 'original', completeSignIn: async (_config, _clientType, idToken) => idToken },
      liff: { init: async () => {}, isInClient: () => false, isLoggedIn: () => loggedIn, getIDToken: () => 'fixture-token', login: () => { redirects++; } },
    };
    vm.runInNewContext(source, { window, document: { title: 'Booking' }, URL });
    const result = window.BookingSystem.signIn({ bookingLiffId: 'fixture-id' }, 'booking');
    if (loggedIn) assert.equal(await result, 'fixture-token');
    else await assert.rejects(result, { code: 'AUTH_REQUIRED' });
    assert.equal(redirects, 0);
    assert.equal(cleanedUrl, '/booking/');
    assert.equal(await window.BookingSystem.signIn({}, 'admin'), 'original');
  });
}
