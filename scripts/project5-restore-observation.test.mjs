import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/project5-restore-observation.yml', import.meta.url), 'utf8');

test('Project #5 observing correction triggers only on integrated branch and the one workflow file', () => {
  assert.match(workflow, /^on:\n  push:\n    branches: \[Integrated-Marketing-Platform\]\n    paths:\n      - '\.github\/workflows\/project5-restore-observation\.yml'/m);
  assert.doesNotMatch(workflow, /^  pull_request:/m);
  assert.doesNotMatch(workflow, /^  issue_comment:/m);
});

test('Project status correction refuses untrusted actor, branch and concurrent overwrites', () => {
  assert.match(workflow, /github\.actor == 'yongshengchen0615'/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/Integrated-Marketing-Platform'/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /Unexpected Issue #40 prior Status; no update performed/);
});

test('Project status correction uses pinned, reviewed existing GraphQL updater, not a second implementation', () => {
  assert.match(workflow, /ref: 8d1b624876947e178f8fa078ddf02b4258dbb7ad/);
  assert.match(workflow, /import \{ createGraphqlClient, getProjectIssue, changeProjectStatus \} from/);
  assert.match(workflow, /persist-credentials: false/g);
});

test('Project status correction is fixed to Issue 40 QA to Observation, with post-write readback', () => {
  assert.match(workflow, /const issue = 40;/);
  assert.match(workflow, /const target = '觀察中';/);
  assert.match(workflow, /before !== 'QA \/ E2E' && before !== target/);
  assert.match(workflow, /getProjectIssue\(graphql, issue, target\)/);
  assert.match(workflow, /changeProjectStatus\(graphql, \{/);
  assert.match(workflow, /result\.to !== target/);
  assert.match(workflow, /\['updated', 'unchanged'\]/);
  assert.doesNotMatch(workflow, /issue\s*=\s*Number\(process\.env/);
});

test('Project mutation requires dedicated token and read-only default GitHub token', () => {
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, /PROJECTS_V2_TOKEN: \$\{\{ secrets\.PROJECTS_V2_TOKEN \}\}/);
  assert.match(workflow, /if \(!token\) throw new Error\('Missing PROJECTS_V2_TOKEN'\)/);
  assert.doesNotMatch(workflow, /permissions:\s*write-all/);
});
