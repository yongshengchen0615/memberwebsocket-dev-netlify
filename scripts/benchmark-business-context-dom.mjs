// Same JSDOM, data, mutation workload and HTTP stub on both source revisions.
// Work counts are deterministic. Timings describe this synthetic runtime only.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const { businessContextDom } = require('../MemberWebsocket-dev/tests/helpers/business-context-dom.cjs');
const base = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(base || '')) throw Error('Provide an exact baseline SHA');
const filename = 'MemberWebsocket-dev/business-context.js';
const sources = {
  baseline: execFileSync('git', ['show', `${base}:${filename}`], { encoding: 'utf8' }),
  candidate: fs.readFileSync(filename, 'utf8'),
};
const samples = { baseline: [], candidate: [] };
async function measure(source) {
  const h = await businessContextDom({ source, rows: 200 });
  try {
    h.reset();
    const startup = performance.now();
    await Promise.all(Array.from({ length: 20 }, () => h.context.configure(h.config()))); await h.flush();
    const startupMs = performance.now() - startup;
    const initialization = { documentQueries: h.metrics.documentQueries, hrefWrites: h.metrics.hrefWrites, requests: h.metrics.requests, ms: startupMs };
    h.reset();
    const changes = h.document.getElementById('changes'), started = performance.now();
    for (let i = 0; i < 20; i++) {
      changes.textContent = String(i); await h.flush();
    }
    return { initialization, localUpdates: { documentQueries: h.metrics.documentQueries, hrefWrites: h.metrics.hrefWrites, requests: h.metrics.requests, ms: performance.now() - started } };
  } finally { h.close(); }
}
// Alternate order so source order does not systematically favor one version.
for (let round = 0; round < 5; round++) {
  for (const kind of round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) samples[kind].push(await measure(sources[kind]));
}
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
const summary = Object.fromEntries(Object.entries(samples).map(([kind, values]) => [kind, Object.fromEntries(['initialization', 'localUpdates'].map(phase => [phase, {
  documentQueries: values[0][phase].documentQueries, hrefWrites: values[0][phase].hrefWrites, requests: values[0][phase].requests,
  p50Ms: percentile(values.map(v => v[phase].ms), .5), maxMs: percentile(values.map(v => v[phase].ms), 1),
}]))]));
console.log(JSON.stringify({ base, candidateSourceSha256: createHash('sha256').update(sources.candidate).digest('hex'), node: process.version, measuredAt: new Date().toISOString(), workload: { existingLinks: 200, startupConsumers: 20, separateMutationBatches: 20, rounds: 5 }, summary, samples,
  limits: 'Synthetic JSDOM work counts and timings; not browser input latency, LINE, API/SQL or external network p95.' }, null, 2));
