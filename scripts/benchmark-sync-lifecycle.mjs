// Actual runtime, identical synthetic authority and virtual clock on both sides.
// Measures request counts, not provider/network/DB latency or production SLOs.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { businessSyncHarness } = require('../MemberWebsocket-dev/tests/helpers/business-sync-harness.cjs');
const [beforeDirectory, output] = process.argv.slice(2);
if (!beforeDirectory || !output) throw Error('Usage: node scripts/benchmark-sync-lifecycle.mjs BASELINE_DIRECTORY REPORT.json');
const report = {
  scope: 'Controlled actual-JS-runtime request-count benchmark; virtual clock, synthetic delayed API. Not production latency or load evidence.',
  baselineSha: process.env.BASELINE_SHA || 'unspecified', samplesPerRuntime: 120, scenarios: [],
};
for (const kind of ['member', 'booking']) {
  const row = { kind };
  for (const version of ['before', 'after']) {
    const source = version === 'before' ? fs.readFileSync(path.join(beforeDirectory, kind + '.js'), 'utf8') : undefined;
    const h = await businessSyncHarness(kind, source), stop = h.subscribe();
    try {
      await h.tick(); const startProbes = h.probes.length;
      for (let i = 0; i < 120; i++) {
        h.holdProbes(); h.emit('pageshow'); await h.tick();
        const pending = h.probes.at(-1);
        for (let j = 0; j < 20; j++) { h.emit('pageshow'); h.emit('online'); h.emit('visibilitychange', true); }
        h.holdProbes(false); pending.resolve(); await h.tick();
      }
      row[version] = { probes: h.probes.length - startProbes, fullRefreshes: h.updates.length };
    } finally { stop(); }
  }
  row.probeReductionPercent = (row.before.probes - row.after.probes) / row.before.probes * 100;
  report.scenarios.push(row);
}
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
