const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const professional = require('../e2e-professional-tester.js');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('professional tester plans are deterministic and risk-aware', () => {
  const base = {
    caseKey: 'BOOKING_HUMAN_LIFECYCLE',
    domain: 'Human E2E',
    module: 'booking',
    side: 'user',
    surface: 'booking',
    risk: 'mutation',
    complexityLevel: 7,
    seed: 'QA-PROFESSIONAL-SEED'
  };
  const first = professional.planTesterBehavior(base);
  const second = professional.planTesterBehavior(base);
  assert.deepEqual(first, second);
  assert.equal(first.risk, 'mutation');
  assert.ok(first.strategies.includes('repeat-action-guard'));
  assert.ok(first.strategies.includes('post-mutation-consistency'));
  assert.ok(first.strategies.includes('keyboard-evidence'));
  assert.ok(first.strategies.includes('refresh-persistence-evidence'));
  assert.equal(first.evidenceTarget, 'deep');

  const security = professional.planTesterBehavior({
    caseKey: 'SECURITY_TAMPERED_SESSION',
    domain: 'Authorization Boundary',
    side: 'admin',
    surface: 'admin',
    complexityLevel: 4,
    seed: 'QA-SECURITY-SEED'
  });
  assert.equal(security.risk, 'security');
  assert.ok(security.strategies.includes('negative-boundary-observation'));
});

test('professional tester evidence recognizes correction, keyboard and multi-step behavior', () => {
  const plan = professional.planTesterBehavior({
    caseKey: 'MEMBER_HUMAN_PROFILE_EDIT',
    risk: 'mutation',
    side: 'user',
    surface: 'member',
    complexityLevel: 6,
    seed: 'QA-EVIDENCE-SEED'
  });
  const before = {
    available: true,
    fingerprint: 'PT1-before',
    duplicateIdCount: 0,
    horizontalOverflow: false,
    busyCount: 0,
    invalidCount: 0
  };
  const after = {
    available: true,
    fingerprint: 'PT1-after',
    duplicateIdCount: 0,
    horizontalOverflow: false,
    busyCount: 0,
    invalidCount: 0
  };
  const evidence = professional.summarizeProfessionalEvidence([
    { type: 'click', target: '#editProfileButton', trusted: false },
    { type: 'input', target: '#displayNameInput', trusted: false },
    { type: 'input', target: '#displayNameInput', trusted: false },
    { type: 'change', target: '#displayNameInput', trusted: false },
    { type: 'keydown', target: '#displayNameInput', trusted: false },
    { type: 'focusin', target: '#displayNameInput', trusted: false }
  ], before, after, plan);

  assert.equal(evidence.eventCount, 4);
  assert.equal(evidence.professionalTester.signals.primaryInteraction, true);
  assert.equal(evidence.professionalTester.signals.multiStep, true);
  assert.equal(evidence.professionalTester.signals.dataEntry, true);
  assert.equal(evidence.professionalTester.signals.correctedInput, true);
  assert.equal(evidence.professionalTester.signals.keyboard, true);
  assert.equal(evidence.professionalTester.signals.focusTraversal, true);
  assert.equal(evidence.professionalTester.signals.stateTransition, true);
  assert.equal(evidence.professionalTester.ok, true);
});

test('focus-only activity cannot satisfy the real UI interaction gate', () => {
  const plan = professional.planTesterBehavior({
    caseKey: 'COMMON_SURFACE_READY',
    side: 'user',
    surface: 'member',
    complexityLevel: 4,
    seed: 'QA-FOCUS-SEED'
  });
  const snapshot = {
    available: true,
    fingerprint: 'PT1-stable',
    duplicateIdCount: 0,
    horizontalOverflow: false,
    busyCount: 0,
    invalidCount: 0
  };
  const evidence = professional.summarizeProfessionalEvidence([
    { type: 'focusin', target: '#memberView', trusted: false },
    { type: 'focusout', target: '#memberView', trusted: false }
  ], snapshot, snapshot, plan);

  assert.equal(evidence.eventCount, 0);
  assert.equal(evidence.professionalTester.signals.primaryInteraction, false);
  assert.equal(evidence.professionalTester.ok, false);
});

test('structural regressions invalidate professional tester evidence', () => {
  const plan = professional.planTesterBehavior({
    caseKey: 'ADMIN_POINT_CARD_CRUD',
    risk: 'mutation',
    side: 'admin',
    surface: 'admin',
    complexityLevel: 5,
    seed: 'QA-STRUCTURE-SEED'
  });
  const before = {
    available: true,
    fingerprint: 'PT1-before',
    duplicateIdCount: 0,
    horizontalOverflow: false,
    busyCount: 0,
    invalidCount: 0
  };
  const duplicateAfter = {
    ...before,
    fingerprint: 'PT1-duplicate',
    duplicateIdCount: 1
  };
  const duplicateEvidence = professional.summarizeProfessionalEvidence([
    { type: 'click', target: '#saveButton', trusted: false }
  ], before, duplicateAfter, plan);
  assert.equal(duplicateEvidence.professionalTester.anomalies.duplicateIdIncrease, 1);
  assert.equal(duplicateEvidence.professionalTester.ok, false);

  const overflowAfter = {
    ...before,
    fingerprint: 'PT1-overflow',
    horizontalOverflow: true
  };
  const overflowEvidence = professional.summarizeProfessionalEvidence([
    { type: 'click', target: '#saveButton', trusted: false }
  ], before, overflowAfter, plan);
  assert.equal(overflowEvidence.professionalTester.anomalies.horizontalOverflowIntroduced, true);
  assert.equal(overflowEvidence.professionalTester.ok, false);
});

test('both admin and user E2E entry points load and enforce the professional tester layer', () => {
  const adminHtml = read('admin/index.html');
  const adminRunner = read('admin/e2e-control.js');
  const userRunner = read('user-test-control.js');
  const workflow = read('../.github/workflows/test-memberwebsocket-dev.yml');

  assert.match(adminHtml, /e2e-professional-tester\.js\?v=professional-qa-20261005-2/);
  assert.match(adminHtml, /e2e-control\.js\?v=qa-e2e-20261010-2/);
  assert.match(adminRunner, /MemberE2EProfessionalTester/);
  assert.match(adminRunner, /professionalTesterStructuralRegressionFree/);
  assert.match(adminRunner, /registerCleanup/);
  assert.match(userRunner, /MemberE2EProfessionalTester/);
  assert.match(userRunner, /professionalTesterStructuralRegressionFree/);
  assert.match(userRunner, /registerCleanup/);

  for (const surface of ['member', 'points', 'event', 'calendar', 'booking']) {
    const html = read(surface + '/index.html');
    assert.match(html, /e2e-professional-tester\.js\?v=professional-qa-20261005-2/, surface);
    assert.match(html, /user-test-control\.js\?v=qa-e2e-20261010-2/, surface);
  }
  assert.match(workflow, /MemberWebsocket-dev\/e2e-professional-tester\.js/);
});
