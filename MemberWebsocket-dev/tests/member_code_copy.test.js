const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'member', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'member', 'app.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'member', 'styles.css'), 'utf8');

test('member code renders a copy action beside the identifier', () => {
  assert.match(html, /<span id="memberCode">—<\/span><button id="copyMemberCodeButton"/);
  assert.match(html, /copyMemberCodeButton[^>]+aria-live="polite"[^>]+disabled>複製<\/button>/);
});

test('member code copy uses Clipboard API with a legacy fallback and visible feedback', () => {
  assert.match(app, /copyMemberCodeButton\.addEventListener\('click', copyMemberCode\)/);
  assert.match(app, /navigator\.clipboard\.writeText\(value\)/);
  assert.match(app, /document\.execCommand\('copy'\)/);
  assert.match(app, /setMemberCodeCopyFeedback\('已複製'\)/);
  assert.match(app, /setMemberCodeCopyFeedback\('複製失敗'\)/);
  assert.match(styles, /\.clipboard-fallback-input/);
});
