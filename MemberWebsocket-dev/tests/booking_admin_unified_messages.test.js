const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const ui = read('admin/booking-panel-core.js');
const api = read('supabase/functions/booking-admin-api/index.ts');
const css = read('admin/booking-panel.css');

const messagePanelStart = ui.indexOf('<section id="bookingAdminMessagesPanel"');
const riskPanelStart = ui.indexOf('<section id="bookingAdminRiskPanel"', messagePanelStart);
const messagePanel = ui.slice(messagePanelStart, riskPanelStart);
const settingsPanel = ui.slice(ui.indexOf('<section id="bookingAdminSettingsPanel"'), messagePanelStart);
const messagesHandler = api.slice(api.indexOf('async function messagesSave('), api.indexOf('async function settingsSave('));
const sharedHandler = api.slice(api.indexOf('async function settingsSave('), api.indexOf('function normalizeRewardRule('));

test('AC-BMSG-001: message settings is a separate accessible booking subtab', () => {
  assert.ok(messagePanelStart > 0 && riskPanelStart > messagePanelStart);
  assert.match(ui, /id="bookingAdminMessagesSubtab"[^>]+role="tab"[^>]+aria-controls="bookingAdminMessagesPanel"/);
  assert.match(messagePanel, /id="bookingAdminMessagesPanel"[^>]+role="tabpanel"[^>]+aria-labelledby="bookingAdminMessagesSubtab"/);
  assert.match(ui, /const allowed = \['technicians', 'services', 'settings', 'messages', 'risk', 'queue'\]/);
  assert.match(ui, /messages: \[els\.bookingAdminMessagesSubtab, els\.bookingAdminMessagesPanel\]/);
  assert.match(css, /booking-admin-messages-layout/);
});

test('AC-BMSG-002: the four texts share one form and submit button', () => {
  assert.equal((messagePanel.match(/<form id="bookingAdminMessagesForm"/g) || []).length, 1);
  assert.equal((messagePanel.match(/type="submit"/g) || []).length, 1);
  assert.equal((messagePanel.match(/id="bookingAdminMessagesSave"/g) || []).length, 1);
  for (const id of ['bookingAdminNotice', 'bookingAdminOnsiteEditMessage', 'bookingAdminPendingMessage', 'bookingAdminReminderMessage']) {
    assert.match(messagePanel, new RegExp('id="' + id + '"'));
    assert.doesNotMatch(settingsPanel, new RegExp('id="' + id + '"'));
  }
  assert.doesNotMatch(messagePanel,/bookingAdminRejectionMessage|預約未通過訊息/);
  assert.doesNotMatch(messagePanel, /id="bookingAdminPendingMessageSave"|id="bookingAdminRejectionMessageSave"|id="bookingAdminReminderMessageSave"/);
  assert.match(ui, /els\.bookingAdminMessagesForm\.addEventListener\('submit', saveMessages\)/);
  assert.match(ui, /manageRequest\('admin\.booking\.messages\.save'/);
  assert.match(ui, /\.\.\.fields,\s*expectedUpdatedAt: state\.messagesDraftVersion/);
});

test('AC-BMSG-003: one API operation validates message texts before a single CAS database update', () => {
  assert.match(api, /action === "admin\.booking\.messages\.save"\) return await messagesSave\(supabase, identity, body\)/);
  assert.match(api, /await authorizeAdmin\(supabase, identity\)/);
  assert.match(api, /await consumeRateLimit\(supabase, identity/);
  for (const [key, column] of [
    ['bookingNotice', 'booking_notice'],
    ['pendingMessage', 'pending_message'],
    ['reminderMessage', 'reminder_message'],
  ]) {
    assert.match(messagesHandler, /typeof body\[key\] !== "string"/);
    assert.match(messagesHandler, new RegExp(column + ': ' + key));
  }
  assert.equal((messagesHandler.match(/\.update\(/g) || []).length, 1);
  assert.match(messagesHandler, /\.eq\("id", 1\)\.eq\("updated_at", expectedUpdatedAt\)/);
  assert.match(messagesHandler, /if \(!result\.data\) throw new ApiError\(409, "BOOKING_SETTINGS_CONFLICT"/);
  assert.match(messagesHandler, /if \(!pendingMessage\.trim\(\) \|\| pendingMessage\.length > 400\)/);
  assert.match(messagesHandler,/REJECTION_SETTINGS_MOVED/);
  assert.doesNotMatch(messagesHandler,/rejection_message:\s*rejectionMessage/);
  assert.doesNotMatch(ui,/bookingAdminRejectionMessage/);
  assert.match(messagesHandler, /if \(!reminderMessage\.trim\(\) \|\| reminderMessage\.length > 400\)/);
  assert.match(messagesHandler, /BOOKING_MESSAGES_UPDATED/);
  assert.match(messagesHandler, /onsite_edit_message: onsiteEditMessage/);
  assert.match(messagesHandler, /INVALID_ONSITE_EDIT_MESSAGE/);
  assert.match(messagesHandler, /hasOnsiteEditMessage \? \{ onsite_edit_message/);
  assert.match(ui, /const MESSAGE_INPUT_IDS = \['bookingAdminNotice','bookingAdminOnsiteEditMessage'/);
});

test('AC-BMSG-004: unsaved drafts and concurrent updates cannot silently overwrite message text', () => {
  assert.match(ui, /if \(state\.messagesDirty && !force\)/);
  assert.match(ui, /state\.messagesDraftVersion = String\(settings\.updatedAt \|\| ''\)/);
  assert.match(ui, /state\.messagesDirty = currentMessagesSignature\(\) !== state\.messagesBaseline/);
  assert.match(ui, /els\.bookingAdminMessagesDiscard\.addEventListener\('click'/);
  assert.match(ui, /state\.messagesSaving = true/);
  assert.match(ui, /state\.messagesSaving = false/);
  assert.match(ui, /本頁草稿已保留/);
  assert.match(sharedHandler, /body\.bookingNotice === undefined/);
  assert.match(sharedHandler, /String\(legacyReminder\.data\.booking_notice \|\| ""\)/);
  assert.match(sharedHandler, /p_booking_notice: bookingNotice/);
  assert.doesNotMatch(ui.slice(ui.indexOf('async function saveSettings('), ui.indexOf('window.addEventListener(\'member-admin:features-updated\'')), /bookingNotice,/);
});

test('AC-BMSG-005: messages are grouped by destination with actionable explanations and accurate notification boundaries', () => {
  assert.equal((messagePanel.match(/class="booking-admin-messages-group"/g) || []).length, 2);
  assert.match(messagePanel, /id="bookingAdminMessagesAudienceHeading">會員端顯示訊息/);
  assert.match(messagePanel, /id="bookingAdminMessagesLineHeading">LINE 預約通知/);
  assert.match(messagePanel, /role="note" aria-label="設定前須知"/);
  assert.match(messagePanel, /儲存設定立即群發/);
  assert.match(messagePanel, /拒絕預約設定/);
  assert.match(messagePanel, /此訊息表示「收到申請」，不代表已完成預約確認/);
  assert.match(messagePanel, /提醒時間仍依會員預約時的選擇/);
  assert.match(messagePanel, /示意資料，不會發送測試訊息/);
  assert.equal((messagePanel.match(/class="booking-admin-messages-card-grid"/g) || []).length, 2);
  assert.match(css, /booking-admin-messages-help/);
  assert.match(css, /booking-admin-messages-card-grid\{grid-template-columns:minmax\(0,1fr\)\}/);
});

test('AC-BMSG-006: character counts follow the same persisted text fields and limits', () => {
  for (const [id, max] of [
    ['bookingAdminNotice', 2000],
    ['bookingAdminOnsiteEditMessage', 400],
    ['bookingAdminPendingMessage', 400],
    ['bookingAdminReminderMessage', 400],
  ]) {
    assert.match(messagePanel, new RegExp('id="' + id + '" maxlength="' + max + '"'));
    assert.match(messagePanel, new RegExp('id="' + id + 'Count" for="' + id + '"'));
  }
  assert.match(ui, /function renderMessageLengths\(\)/);
  assert.match(ui, /function updateMessagesDraft\(\) \{\s*renderMessageLengths\(\);/);
  assert.match(ui, /renderMessages\(true\);/);
  assert.match(ui, /if \(event\.target === els\.bookingAdminPendingMessage\) renderPendingMessagePreview\(\);/);
  assert.match(ui, /if \(event\.target === els\.bookingAdminReminderMessage\) renderReminderMessagePreview\(\);/);
});

test('AC-BMSG-007: rendered character counts reflect current values and do not change submitted fields', () => {
  const vm = require('node:vm');
  const start = ui.indexOf('  function renderMessageLengths() {');
  const end = ui.indexOf('\n  function updateMessagesDraft()', start);
  assert.ok(start > 0 && end > start, 'expected the actual production counter renderer');
  const values = {
    bookingAdminNotice: '請提早抵達',
    bookingAdminOnsiteEditMessage: '現場修改',
    bookingAdminPendingMessage: '申請已收到',
    bookingAdminReminderMessage: '預約提醒\n請準時抵達',
  };
  const els = Object.fromEntries(Object.entries(values).map(([id, value]) => [id, { value }]));
  const counters = Object.fromEntries(Object.keys(values).map((id) => [id + 'Count', { textContent: '' }]));
  vm.runInNewContext(ui.slice(start, end) + '\nrenderMessageLengths();', {
    els,
    document: { getElementById: (id) => counters[id] || null },
  });
  for (const [id, value] of Object.entries(values)) {
    const limit = id === 'bookingAdminNotice' ? 2000 : 400;
    assert.equal(counters[id + 'Count'].textContent, value.length.toLocaleString('zh-TW') + ' / ' + limit.toLocaleString('zh-TW') + ' 字');
    assert.equal(els[id].value, value, 'counter should never modify the draft text');
  }
});

test('AC-BMSG-008: LINE previews render real separate rows with no extra backslash on line breaks', () => {
  const vm = require('node:vm');
  const start = ui.indexOf('  function renderLineNotificationPreview(');
  const end = ui.indexOf('\n  function renderSettings(', start);
  assert.ok(start > 0 && end > start, 'must execute production preview renderers');
  assert.match(css, /booking-admin-message-preview-line\{display:block/);
  const output = () => {
    let rows = [];
    return {
      get rows() { return rows; },
      set textContent(value) {
        assert.equal(value, '', 'preview must clear prior rows');
        rows = [];
      },
      appendChild(row) { rows.push(row); },
    };
  };
  const pending = '我們已收到您的預約申請\r\n請等待工作人員確認\n確認後會再透過 LINE 通知您';
  const reminder = '請準時抵達\r\n<請注意> & 無法即時補位';
  const els = {
    bookingAdminPendingMessage: { value: pending },
    bookingAdminReminderMessage: { value: reminder },
    bookingAdminPendingMessagePreview: output(),
    bookingAdminReminderMessagePreview: output(),
  };
  vm.runInNewContext(ui.slice(start, end) + '\nrenderPendingMessagePreview(); renderReminderMessagePreview();', {
    els,
    document: {
      createElement(tag) {
        assert.equal(tag, 'span');
        return { className: '', textContent: '' };
      },
    },
  });
  const actualPending = els.bookingAdminPendingMessagePreview.rows.map((row) => row.textContent);
  const actualReminder = els.bookingAdminReminderMessagePreview.rows.map((row) => row.textContent);
  assert.deepEqual(actualPending, [
    '【預約申請】',
    '狀態：等待管理員確認預約',
    '日期：2026/12/12',
    '時段：2026/12/12 11:30–2026/12/12 12:40（台北時間）',
    '預約人：示意會員',
    '預約人數：1 位',
    '預約編號：示意編號',
    '提醒事項：我們已收到您的預約申請',
    '請等待工作人員確認',
    '確認後會再透過 LINE 通知您',
  ]);
  assert.equal(actualPending.filter((line) => line.startsWith('提醒事項：')).length, 1);
  assert.equal(actualReminder[0], '【預約提醒】');
  assert.equal(actualReminder[1], '提醒事項：請準時抵達');
  assert.equal(actualReminder[2], '<請注意> & 無法即時補位');
  assert.equal(actualReminder.filter((line) => line.startsWith('提醒事項：')).length, 1);
  for (const row of [...els.bookingAdminPendingMessagePreview.rows, ...els.bookingAdminReminderMessagePreview.rows]) {
    assert.equal(row.className, 'booking-admin-message-preview-line');
    assert.doesNotMatch(row.textContent, /\\$/, 'a line must not acquire a visible trailing backslash');
  }
  assert.equal(els.bookingAdminPendingMessage.value, pending, 'preview cannot mutate saved text');
  assert.equal(els.bookingAdminReminderMessage.value, reminder, 'preview cannot mutate saved text');
  // HTML-looking administrator input must stay inert text; no HTML interpolation.
  assert.equal(actualReminder[2], '<請注意> & 無法即時補位');
});
