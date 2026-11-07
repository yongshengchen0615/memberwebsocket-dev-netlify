const { test } = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./helpers/receipt-upload-fixture.cjs');
const a = '10000000-0000-4000-8000-000000000001';
const b = '20000000-0000-4000-8000-000000000002';
for (const tenant of ['', a, b]) for (const accessible of [true, false]) {
  test(`AC-187-001/002: ${tenant || 'legacy'} ${accessible ? 'snapshot' : 'booking'} upload uses the exact signed path`, async () => {
    const f = fixture(tenant);
    const result = await f.prepare({ accessible, bookingId: '40000000-0000-4000-8000-000000000004' });
    assert.equal(result.objectPath, f.signed.get(result.uploadToken));
    assert.equal(f.calls[0].options.upsert, false);
    assert.equal(result.objectPath, (tenant ? tenant + '/' : '') + f.storedPath());
    assert.ok(!f.storedPath().startsWith(a + '/') && !f.storedPath().startsWith(b + '/'), 'DB keeps tenant-relative paths for finalize and cleanup');
    const bytes = Buffer.from('synthetic-image');
    f.upload(result.objectPath, result.uploadToken, bytes);
    assert.equal(f.uploaded.get(result.objectPath), bytes);
    assert.throws(() => f.upload(result.objectPath, result.uploadToken, bytes), /Already Exists/);
    assert.throws(() => f.upload(b + '/' + f.storedPath(), result.uploadToken, bytes), tenant === b ? /Already Exists/ : /Invalid upload signature/);
  });
}
test('AC-187-004: signing failure fails closed without granting an upload', async () => {
  const f = fixture(a, { signingError: true });
  await assert.rejects(f.prepare({ accessible: true }), { code: 'RECEIPT_UPLOAD_UNAVAILABLE' });
  assert.equal(f.signed.size, 0);
});
for (const status of ['awaiting_review', 'bound']) test(`AC-187-004: replay of ${status} cannot overwrite a submitted receipt`, async () => {
  const f = fixture(a, { status });
  const result = await f.prepare({ accessible: true });
  assert.equal(result.status, status);
  assert.equal(result.uploadToken, undefined);
  assert.equal(f.calls.length, 0);
});
