import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const workflows = readdirSync(new URL('.github/workflows/', root))
  .filter(name => /^test-.*\.yml$/.test(name))
  .map(name => readFileSync(new URL('.github/workflows/' + name, root), 'utf8'));

// Inspect literal Node commands in run steps, not comments, step names or echo.
// This is a wiring check for these workflow conventions, not proof of execution.
function nodeInputs(source) {
  const lines = source.split(/\r?\n/), inputs = new Set();
  for (let i = 0; i < lines.length; i++) {
    const run = /^(\s+)(?:- )?run:\s*(.*)$/.exec(lines[i]);
    if (!run) continue;
    let command = run[2];
    if (/^[|>][-+]?\s*$/.test(command)) {
      const folded = command.startsWith('>'), block = [];
      while (i + 1 < lines.length && (!lines[i + 1].trim() || /^\s*/.exec(lines[i + 1])[0].length > run[1].length)) {
        block.push(lines[++i].trim());
      }
      command = block.filter(line => !line.startsWith('#')).join(folded ? ' ' : '\n');
    }
    command = command.replace(/\\\n/g, ' ');
    for (const match of command.matchAll(/(?:^|\n)\s*node\s+([^\n#]+)/g)) {
      for (const input of match[1].matchAll(/(?:^|\s)((?:scripts|MemberWebsocket-dev)\/[^\s'"\\]+\.(?:mjs|cjs))(?=\s|$)/g)) inputs.add(input[1]);
    }
  }
  return inputs;
}

const helpers = new Map([
  ['MemberWebsocket-dev/tests/integration/business-platform-fixture.cjs', 'Shared PGlite platform fixture'],
  ['MemberWebsocket-dev/tests/integration/business-runtime-fixture.cjs', 'Shared tenant runtime fixture'],
  ['MemberWebsocket-dev/tests/integration/platform-fixture.cjs', 'Shared platform API fixture'],
  ['MemberWebsocket-dev/tests/integration/postgres/database.cjs', 'Physical PostgreSQL connection helper'],
]);

test('AC-001: every script and SQL/DOM test is connected to a test workflow', () => {
  const inventory = [
    ...readdirSync(new URL('scripts/', root)).filter(name => name.endsWith('.test.mjs')).map(name => 'scripts/' + name),
    ...['MemberWebsocket-dev/tests/integration/', 'MemberWebsocket-dev/tests/integration/postgres/']
      .flatMap(dir => readdirSync(new URL(dir, root)).filter(name => name.endsWith('.cjs')).map(name => dir + name)),
  ];
  const wired = new Set(workflows.flatMap(source => [...nodeInputs(source)]));
  assert.deepEqual(inventory.filter(file => !helpers.has(file) && !wired.has(file)), [], 'Tests missing from executable CI run steps');
  for (const [file, reason] of helpers) {
    assert.ok(inventory.includes(file), 'Remove stale helper exclusion: ' + file);
    assert.ok(reason.length > 10);
    assert.doesNotMatch(readFileSync(new URL(file, root), 'utf8'), /(?:^|[^\w$.])(?:test|it|describe)\s*\(/, 'Do not hide tests in helper exclusions: ' + file);
  }
});

test('AC-002: wiring recognizes inline, literal, folded and continued Node commands', () => {
  const source = `      - run: node --test scripts/inline.test.mjs
      - name: integration
        run: |
          node --test \\
            MemberWebsocket-dev/tests/integration/first.cjs
          node MemberWebsocket-dev/tests/integration/second.cjs
      - run: >-
          node --test
          scripts/folded.test.mjs
      - name: next step
        run: echo scripts/ignored.test.mjs`;
  assert.deepEqual([...nodeInputs(source)], ['scripts/inline.test.mjs', 'MemberWebsocket-dev/tests/integration/first.cjs', 'MemberWebsocket-dev/tests/integration/second.cjs', 'scripts/folded.test.mjs']);
});

test('AC-002: comments, echo and step names cannot conceal missing test wiring', () => {
  assert.deepEqual([...nodeInputs(`      - name: node --test scripts/name.test.mjs
        run: |
          # node --test scripts/comment.test.mjs
          echo node --test scripts/echo.test.mjs
          node --test scripts/real.test.mjs # scripts/trailing.test.mjs
      # run: node --test scripts/yaml-comment.test.mjs`)], ['scripts/real.test.mjs']);
});
