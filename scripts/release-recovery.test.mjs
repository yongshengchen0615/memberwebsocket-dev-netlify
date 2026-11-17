import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { requireRecoveryBaselines } from './release-recovery.mjs';

const input = () => ({ event: 'workflow_dispatch', ref: 'refs/heads/Integrated-Marketing-Platform', sha: 'b'.repeat(40),
  needs: { recovery_member: { result: 'success' }, recovery_netlify: { result: 'success' }, recovery_ticket: { result: 'success' } } });

test('AC-010 all three complete baselines can release only an exact trusted source', () => {
  for (const ref of ['refs/heads/master', 'refs/heads/Integrated-Marketing-Platform', 'refs/heads/feature/productization-super-admin']) {
    assert.equal(requireRecoveryBaselines({ ...input(), ref }).status, 'verified');
  }
});

test('AC-011 failure, cancel, skipped, pending or missing results cannot unlock publication', () => {
  for (const key of ['recovery_member', 'recovery_netlify', 'recovery_ticket']) {
    for (const result of ['failure', 'cancelled', 'skipped', 'pending', undefined]) {
      const value = input(); value.needs[key].result = result;
      assert.throws(() => requireRecoveryBaselines(value), /RECOVERY_BASELINE/);
    }
    const missing = input(); delete missing.needs[key];
    assert.throws(() => requireRecoveryBaselines(missing), /RECOVERY_BASELINE/);
  }
  assert.throws(() => requireRecoveryBaselines({ ...input(), needs: {} }), /RECOVERY_BASELINE/);
});

test('AC-011 recovery never accepts a PR, ordinary feature branch, missing or synthetic source SHA', () => {
  for (const patch of [{ event: 'pull_request' }, { event: 'push' }, { ref: 'refs/heads/main' },
    { ref: 'refs/pull/333/merge' }, { ref: 'refs/heads/fix/untrusted' }, { sha: '' }, { sha: 'synthetic' }]) {
    assert.throws(() => requireRecoveryBaselines({ ...input(), ...patch }), /RECOVERY_SOURCE/);
  }
});

test('AC-012/014 both publishers use the full same-commit reusable baselines and retain normal push CI gates', () => {
  for (const file of ['publish-netlify.yml', 'publish-platform-preview.yml']) {
    const source = readFileSync(new URL('../.github/workflows/' + file, import.meta.url), 'utf8');
    for (const workflow of ['test-memberwebsocket-dev.yml', 'test-netlify-build.yml', 'test-memberwebsocket-ticket-policy.yml']) {
      assert.ok(source.includes('uses: ./.github/workflows/' + workflow));
      const reusable = readFileSync(new URL('../.github/workflows/' + workflow, import.meta.url), 'utf8');
      assert.match(reusable, /^  workflow_call:/m);
    }
    const jobs = source.slice(source.indexOf('jobs:'), source.indexOf('  publish:'));
    assert.doesNotMatch(jobs, /secrets:|inherit/);
    assert.match(source, /needs: \[recovery_member, recovery_netlify, recovery_ticket\]/);
    assert.match(source, /!cancelled\(\)/);
    assert.match(source, /run: node scripts\/release-recovery.mjs/);
    assert.match(source, /-f event=push/);
    const wait = source.slice(source.indexOf('- name: Wait for all established CI'), source.indexOf('- name: Deploy exact-SHA'));
    assert.match(wait, /if: github.event_name != 'workflow_dispatch'/);
    assert.match(wait, /node scripts\/check-preview-ci.mjs/);
    assert.match(source, /RECOVERY_NEEDS: \$\{\{ toJSON\(needs\) \}\}/);
  }
});
