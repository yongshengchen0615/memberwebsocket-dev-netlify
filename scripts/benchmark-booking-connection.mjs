import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { JSDOM } = require('../MemberWebsocket-dev/tests/integration/node_modules/jsdom');
const base = process.argv[2];
if (!/^[a-f0-9]{7,40}$/.test(base || '')) throw Error('An immutable baseline commit is required');
const files = ['booking/common.js', 'booking/group-booking.js'];
const root = 'MemberWebsocket-dev/';
const config = { supabaseUrl: 'https://fixture.supabase.co', supabasePublishableKey: 'public-fixture' };
const report = {
  baselineSha: execFileSync('git', ['rev-parse', base], { encoding: 'utf8' }).trim(),
  candidateHeadSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  candidateRuntimeSha256: {}, node: process.version, generatedAt: new Date().toISOString(),
  workload: { bursts: 30, concurrentIdenticalReads: 100, nextFreshReadPerBurst: 1, syntheticIdentity: true },
  limits: 'Actual common + group browser JavaScript in the same JSDOM; synthetic HTTP. Counts demonstrate duplicate suppression, not production latency or capacity.',
  results: {},
};
const { createHash } = await import('node:crypto');
for (const file of files) report.candidateRuntimeSha256[file] = createHash('sha256').update(fs.readFileSync(root + file)).digest('hex');
for (const version of ['baseline', 'candidate']) {
  const dom = new JSDOM('<!doctype html><main></main>', { url: 'https://fixture.test/booking/', runScripts: 'outside-only' });
  const w = dom.window, calls = [], waiting = [];
  w.AbortController = AbortController;
  w.fetch = async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, body });
    let data = {};
    if (body.action === 'user.booking.bootstrap') data = { settings: {}, services: [{ serviceId: 'S', title: 'Fixture', priceAmount: 100, durationMinutes: 30 }], bookings: [] };
    if (body.action === 'user.booking.group.bootstrap') data = { settings: { requirePrimaryTechnician: false }, technicians: [], bookingGroups: {} };
    if (body.action === 'user.booking.group.slots') { await new Promise(resolve => waiting.push(resolve)); data = { slots: ['10:00'] }; }
    return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
  };
  let sourceBytes = 0;
  try {
    for (const file of files) {
      const source = version === 'baseline' ? execFileSync('git', ['show', `${base}:${root}${file}`], { encoding: 'utf8' }) : fs.readFileSync(root + file, 'utf8');
      sourceBytes += Buffer.byteLength(source); w.eval(source);
    }
    await w.BookingSystem.request(config, 'member', 'synthetic-identity', 'user.booking.bootstrap');
    const request = () => w.BookingSystem.request(config, 'member', 'synthetic-identity', 'user.booking.slots', { bookingDate: '2026-11-11', items: [{ serviceId: 'S', quantity: 1 }] });
    const counts = [];
    for (let burst = 0; burst < 30; burst++) {
      const before = calls.length, reads = Array.from({ length: 100 }, request);
      counts.push(calls.length - before); waiting.splice(0).forEach(resolve => resolve());
      const values = await Promise.all(reads); if (values.some(value => value.slots[0] !== '10:00')) throw Error('Incorrect shared result');
      const nextBefore = calls.length, fresh = request();
      if (calls.length - nextBefore !== 1) throw Error('Read response was cached after settlement');
      waiting.splice(0).forEach(resolve => resolve()); await fresh;
    }
    report.results[version] = { duplicateBurstRequestCounts: counts, duplicateBurstTotal: counts.reduce((a, b) => a + b, 0), freshRequests: 30, runtimeSourceBytes: sourceBytes };
  } finally { w.close(); }
}
const output = process.argv[3] || 'evidence/booking-connection-benchmark.json';
fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report.results));
