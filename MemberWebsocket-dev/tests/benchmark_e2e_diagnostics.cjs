// Reproducible microbenchmark; not a whole-run browser E2E performance claim.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const relative = 'MemberWebsocket-dev/supabase/functions/_shared/e2e-diagnostics.js';
const root = path.resolve(__dirname, '../..');
const load = source => import('data:text/javascript;base64,' +
  Buffer.from(source + '\nexport { findField };').toString('base64'));
function medianMs(fn, count) {
  for (let i = 0; i < 20; i++) fn();
  const samples = [];
  for (let round = 0; round < 5; round++) {
    const start = performance.now();
    for (let i = 0; i < count; i++) fn();
    samples.push((performance.now() - start) / count);
  }
  return samples.sort((a, b) => a - b)[2];
}
(async () => {
  const ref = process.argv[2] || 'b056efd7554bb6fb072c7d2e6f532c3db5481c2c';
  const before = await load(execFileSync('git', ['show', ref + ':' + relative], { cwd: root, encoding: 'utf8' }));
  const after = await load(fs.readFileSync(path.join(root, relative), 'utf8'));
  const actual = {};
  for (let i = 0; i < 80; i++) {
    actual['branch' + i] = {};
    for (let j = 0; j < 80; j++) actual['branch' + i]['leaf' + j] = { value: 'safe' };
  }
  const input = { caseKey: 'BENCH', domain: 'Diagnostic', message: 'assertion failed', actual };
  const fieldBefore = medianMs(() => before.findField(actual, new Set(['absent'])), 200);
  const fieldAfter = medianMs(() => after.findField(actual, new Set(['absent'])), 200);
  const diagnosisBefore = medianMs(() => before.diagnoseE2EFailure(input), 100);
  const diagnosisAfter = medianMs(() => after.diagnoseE2EFailure(input), 100);
  process.stdout.write(JSON.stringify({ baselineRef: ref, inputBytes: Buffer.byteLength(JSON.stringify(input)),
    rounds: 5, field: { beforeMs: fieldBefore, afterMs: fieldAfter, speedup: fieldBefore / fieldAfter },
    diagnosis: { beforeMs: diagnosisBefore, afterMs: diagnosisAfter, speedup: diagnosisBefore / diagnosisAfter }
  }, null, 2) + '\n');
})().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
