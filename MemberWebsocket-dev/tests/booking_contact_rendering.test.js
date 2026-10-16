const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bookingDir = path.join(__dirname, '../booking');
const html = fs.readFileSync(path.join(bookingDir, 'index.html'), 'utf8');
const typography = fs.readFileSync(path.join(bookingDir, 'booking-typography.css'), 'utf8');

test('booking contact block renders before service selection content', () => {
  const contact = html.indexOf('class="booking-contact-fieldset"');
  const servicePicker = html.indexOf('class="service-picker-fieldset"');
  const slot = html.indexOf('class="slot-fieldset"');

  assert.notEqual(contact, -1);
  assert.notEqual(servicePicker, -1);
  assert.notEqual(slot, -1);
  assert.ok(contact < servicePicker, 'contact block must appear before service picker');
  assert.ok(contact < slot, 'contact block must appear before slot selection');
});

test('contact component stylesheet loads after booking typography', () => {
  const typographyLink = html.indexOf('./booking-typography.css');
  const contactLink = html.indexOf('./contact-details.css');

  assert.notEqual(typographyLink, -1);
  assert.notEqual(contactLink, -1);
  assert.ok(typographyLink < contactLink, 'contact component styles must load after typography');
});

test('booking typography does not override contact component-specific rules', () => {
  assert.doesNotMatch(typography, /\.booking-contact-option\s+strong\s*\{/);
  assert.doesNotMatch(typography, /\.booking-contact-option\s+small\s*\{/);
  assert.doesNotMatch(typography, /\.booking-contact-fieldset\s+legend\s*\{/);
});
