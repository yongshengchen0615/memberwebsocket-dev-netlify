// Same runtime and virtual clock on both sides; measures resource/request counts,
// not hosted WebSocket latency, provider availability or mobile LINE performance.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { realtimeLifecycleHarness } = require('../MemberWebsocket-dev/tests/helpers/realtime-lifecycle-harness.cjs');
const { frontdeskSyncHarness } = require('../MemberWebsocket-dev/tests/helpers/frontdesk-sync-harness.cjs');
const [baseSha, output] = process.argv.slice(2);
if (!/^[a-f0-9]{40}$/.test(baseSha || '') || !output) throw Error('Usage: node scripts/benchmark-realtime-lifecycle.mjs BASE_SHA OUTPUT.json');
const files = { member: 'MemberWebsocket-dev/member-system.js', booking: 'MemberWebsocket-dev/booking/common.js', frontdesk: 'MemberWebsocket-dev/frontdesk/app.js' };
const report = { baselineSha: baseSha, measuredAt: new Date().toISOString(), node: process.version,
  scope: 'Actual application JavaScript, synthetic SDK/API, virtual clock, identical scenarios; counts only, not hosted latency.',
  sourceSha256: {}, websocket: [], frontdesk: [] };
for (const version of ['before', 'after']) {
  const sources = Object.fromEntries(Object.entries(files).map(([kind, file]) => [kind,
    version === 'before' ? execFileSync('git', ['show', baseSha + ':' + file], { encoding: 'utf8' }) : fs.readFileSync(file, 'utf8')]));
  report.sourceSha256[version] = Object.fromEntries(Object.entries(sources).map(([kind, source]) => [kind, createHash('sha256').update(source).digest('hex')]));
  for (const kind of ['member', 'booking']) {
    const h = realtimeLifecycleHarness(kind, sources[kind]); let refreshes = 0;
    const stop = h.subscribe(() => refreshes++), channel = h.channels[0]; channel.status('SUBSCRIBED');
    h.emit('pagehide'); const channelsAfterPagehide = h.activeChannels;
    for (const fn of h.intervals.values()) fn(); await h.tick(60000);
    const refreshesAfterPagehide = refreshes;
    stop(); h.notifications.length = 0;
    for (let i = 0; i < 100; i++) { channel.change({ new: { scope: 'all', event_type: 'booking.changed' } }); channel.status('SUBSCRIBED'); }
    await h.tick(60000);
    report.websocket.push({ version, kind, eventPairs: 100, channelsAfterPagehide, refreshesAfterPagehide, lateNotificationsAfterUnsubscribe: h.notifications.length,
      channelsAfterUnsubscribe: h.activeChannels, listenersAfterUnsubscribe: h.listenerCount });
  }
  const stale = frontdeskSyncHarness(sources.frontdesk); stale.start(); await stale.tick();
  stale.document.visibilityState = 'hidden'; stale.emit('visibilitychange', true);
  stale.document.visibilityState = 'visible'; stale.emit('visibilitychange', true);
  await stale.tick(); stale.probes[0].resolve({ revision: '1' }); await stale.tick();
  const staleFullReads = stale.loads.length; stale.stop();
  const slow = frontdeskSyncHarness(sources.frontdesk); slow.holdLoad(); slow.start(); await slow.tick();
  slow.probes[0].resolve({ revision: '1' }); await slow.tick();
  for (let i = 0; i < 100; i++) slow.emit('focus');
  await slow.tick(); await slow.finishLoad(); await slow.tick();
  report.frontdesk.push({ version, recoveryEventCount: 100, fullReadsFromStaleProbe: staleFullReads,
    immediateTrailingChecksAfterSlowRefresh: slow.probes.length - 1 }); slow.stop();
}
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
