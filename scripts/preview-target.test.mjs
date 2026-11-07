import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { validatePreviewTarget } = require('../MemberWebsocket-dev/tests/browser/preview-target.cjs');
const sha = 'a'.repeat(40);
const preview = 'https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app/';

test('QA-PREVIEW-003 accepts only the dedicated read-only preview', () => {
  assert.equal(validatePreviewTarget(preview, sha), preview.slice(0, -1));
  for (const target of [
    'http://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app/',
    'https://memberwebsocket-dev-netlify.netlify.app/',
    'https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app.evil.test/',
    'https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app/admin/',
    'https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app/?token=x',
    'https://user@integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app/',
    'http://localhost:8080/',
  ]) assert.throws(() => validatePreviewTarget(target, sha));
  for (const invalid of ['', '1234567', 'g'.repeat(40)]) {
    assert.throws(() => validatePreviewTarget(preview, invalid));
  }
  assert.throws(() => validatePreviewTarget(undefined, sha));
});
