const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const read=relative=>fs.readFileSync(path.join(root,relative),'utf8');

test('member join terms and accessible screen receipt stay in full user E2E coverage',()=>{
  const runner=read('user-test-control.js');
  const coverage=read('e2e-feature-coverage.js');
  assert.match(runner,/MEMBER_JOIN_TERMS_FLOW/);
  assert.match(runner,/memberJoinTermsFlowCase/);
  assert.match(runner,/BOOKING_ACCESSIBLE_SCREENSHOT_RECEIPT/);
  assert.match(runner,/bookingAccessibleScreenshotReceiptCase/);
  assert.match(runner,/captureFailureScreenshotBlob/);
  assert.match(runner,/openAccessibleE2ESnapshot/);
  assert.match(coverage,/MEMBER_TERMS_CONSENT','MEMBER_JOIN_TERMS_FLOW/);
  assert.match(coverage,/BOOKING_ACCESSIBLE_MODE','BOOKING_ACCESSIBLE_RECEIPT_BOUNDARY','BOOKING_ACCESSIBLE_SCREENSHOT_RECEIPT/);
});

test('accessible receipt screenshot injection is test-only and reuses normal receipt submission',()=>{
  const receipt=read('booking/booking-receipt.js');
  const browser=read('tests/browser/receipt-location.spec.cjs');
  assert.match(receipt,/function openAccessibleE2ESnapshot/);
  assert.match(receipt,/TestModeClient\?\.getSessionToken/);
  assert.match(receipt,/TEST_SESSION_REQUIRED/);
  assert.match(receipt,/skipCamera: true/);
  assert.match(receipt,/acceptFile\(file\)/);
  assert.doesNotMatch(read('booking/index.html'),/input[^>]+type=["']file["']/i);
  assert.match(browser,/e2eReceiptSnapshotSource/);
  assert.match(browser,/\.screenshot\(\{type:'jpeg',quality:84\}\)/);
  assert.match(browser,/state\.uploads\[0\]\.size\)\.toBe\(screenshotSize\)/);
});

test('membership application terms have an isolated Chromium success path',()=>{
  const spec=read('tests/browser/member-join-terms.spec.cjs');
  assert.match(spec,/請閱讀並勾選同意會員條款/);
  assert.match(spec,/user\.member\.profile\.save/);
  assert.match(spec,/termsId:'terms-join-1'/);
  assert.match(spec,/termsVersion:'7'/);
  assert.match(spec,/accepted:true/);
  assert.match(spec,/#memberView/);
});

test('all clients load the expanded user E2E controller and booking loads the receipt snapshot build',()=>{
  for(const entry of ['member','points','event','calendar','booking']){
    assert.match(read(entry+'/index.html'),/\.\.\/user-test-control\.js\?v=qa-e2e-20261010-2/);
  }
  assert.match(read('booking/index.html'),/\.\/booking-receipt\.js\?v=accessible-e2e-snapshot-20261005-1/);
});
