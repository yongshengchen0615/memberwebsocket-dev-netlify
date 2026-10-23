const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const core = fs.readFileSync(path.join(root, 'admin/booking-panel-core.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'admin/booking-panel.css'), 'utf8');

test('AC-BUX-001: booking shared settings include an accessible draft state and explicit discard action', () => {
  assert.match(core, /id="bookingAdminDraftStatus"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(core, /id="bookingAdminDiscardSettingsButton"[^>]*type="button"[^>]*disabled/);
  assert.match(core, /bookingAdminSettingsForm\.addEventListener\('input'/);
  assert.match(core, /bookingAdminDiscardSettingsButton\.addEventListener\('click'/);
});

test('AC-BUX-003: background refresh preserves unsaved form values and server revision for conflict checks', () => {
  assert.match(core, /if \(state\.settingsDirty && !force\)/);
  assert.match(core, /state\.settingsDraftVersion = String\(settings\.updatedAt \|\| ''\)/);
  assert.match(core, /expectedUpdatedAt: state\.settingsDraftVersion/);
  assert.match(core, /bookingAdminSaveSettingsButton\.disabled = true/);
  assert.match(core, /bookingAdminSaveSettingsButton\.disabled = false/);
  assert.match(core, /renderSettings\(true\)/);
  assert.match(css, /booking-admin-settings-draft-status/);
});
