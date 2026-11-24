const { test } = require('node:test');
const assert = require('node:assert/strict');

test('AC-001: direct cancellation requires booking grant, frontdesk grant and configured frontdesk', async () => {
  const { directFrontdeskCancellationEnabled: enabled } = await import('../supabase/functions/_shared/frontdesk-cancellation-mode.mjs');
  const grant = { features: { booking: true, frontdesk: true }, module_line: { booking: { frontdesk: { enabled: true } } } };
  assert.equal(enabled(grant), true);
  assert.equal(enabled({ ...grant, features: { booking: true, frontdesk: false } }), false);
  assert.equal(enabled({ ...grant, features: { booking: false, frontdesk: true } }), false);
  assert.equal(enabled({ ...grant, module_line: { booking: { frontdesk: { enabled: false } } } }), false);
  assert.equal(enabled({ ...grant, module_line: {} }), false);
  assert.equal(enabled({}), false);
  assert.equal(enabled(null), false);
});
