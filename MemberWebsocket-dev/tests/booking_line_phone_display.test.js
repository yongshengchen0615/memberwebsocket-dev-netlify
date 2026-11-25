const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const helperUrl = pathToFileURL(path.join(root, 'supabase/functions/booking-line-notifications/phone-display.mjs')).href;
async function realFormatters() {
  const helper = await import(helperUrl);
  const source = fs.readFileSync(path.join(root, 'supabase/functions/_shared/booking-contact-phone.ts'), 'utf8');
  const js = stripTypeScriptTypes(source, { mode: 'strip' });
  const { formatBookingPhone } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
  return { formatBookingPhone, formatBookingLinePhoneFields: helper.formatBookingLinePhoneFields };
}

test('AC-LPH-001: all booking LINE phone rows display local 09 format for Taiwan mobile', async () => {
  const { formatBookingPhone, formatBookingLinePhoneFields: display } = await realFormatters();
  const notice = [
    '【預約】', '電話：+886912345678',
    '【修改預約】', '電話：886912345678',
    '【櫃檯確認修改】', '電話：+886 (0)912-345-678',
    '【櫃檯拒絕預約】', '【原預約資料】', '電話：0912-345-678',
    '【櫃檯新增的預約資料】', '電話：+886-912-345-678',
    '【預約提醒】', '聯絡電話：+886912345678', '手機：+886912345678', '聯絡手機：+886912345678',
  ].join('\n');
  const output = display(notice, formatBookingPhone);
  assert.equal((output.match(/^電話：0912345678$/gm) || []).length, 5);
  assert.match(output, /^聯絡電話：0912345678$/m);
  assert.match(output, /^手機：0912345678$/m);
  assert.match(output, /^聯絡手機：0912345678$/m);
  assert.doesNotMatch(output, /電話：\+?886/);
  assert.match(output, /【櫃檯新增的預約資料】/);
});

test('AC-LPH-002: other countries, Taiwan landline and invalid mobiles never change', async () => {
  const { formatBookingPhone, formatBookingLinePhoneFields: display } = await realFormatters();
  const source = ['電話：+819012345678', '電話：+14155552671', '電話：+886212345678',
    '電話：02-12345678', '電話：+8869112345678', '電話：未提供', '電話：'].join('\n');
  assert.equal(display(source, formatBookingPhone), source);
});

test('AC-LPH-003: only structured phone fields are transformed, not notes, IDs or unrelated text', async () => {
  const { formatBookingPhone, formatBookingLinePhoneFields: display } = await realFormatters();
  const source = '【預約確認】\r\n電話：+886912345678\r\n會員備註：電話：+886912345678\r\n' +
    '說明：+886912345678\r\n預約編號：886912345678\r\n額外電話：+886912345678\r\n電話：+886912345678 分機 123';
  const output = display(source, formatBookingPhone);
  assert.match(output, /\r\n電話：0912345678\r\n/);
  assert.match(output, /會員備註：電話：\+886912345678/);
  assert.match(output, /額外電話：\+886912345678/);
  assert.match(output, /電話：\+886912345678 分機 123$/);
  assert.match(output, /預約編號：886912345678/);
});

test('AC-LPH-004: LINE Flex renderer applies shared booking phone formatter before parsing all channels', () => {
  const source = fs.readFileSync(path.join(root, 'supabase/functions/booking-line-notifications/delivery.ts'), 'utf8');
  assert.match(source, /import\s*\{\s*formatBookingPhone\s*\}\s*from\s*['"]\.\.\/_shared\/booking-contact-phone\.ts['"]/);
  assert.match(source, /import\s*\{\s*formatBookingLinePhoneFields\s*\}\s*from\s*['"]\.\/phone-display\.mjs['"]/);
  assert.match(source, /formatBookingLinePhoneFields\(job\.message_text,\s*formatBookingPhone\)/);
  assert.match(source, /const parsed = parseBookingMessage\(visibleText\)/);
  assert.match(source, /const message = buildBookingFlexMessage\(job\)/);
});
