const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { flush } = require('./realtime-lifecycle-harness.cjs');
function frontdeskSyncHarness(source) {
  const app = source || fs.readFileSync(path.join(__dirname, '../../frontdesk/app.js'), 'utf8');
  const start = app.indexOf(' const canSync='), end = app.indexOf(' // The rejection dialog', start);
  const eventsStart = app.lastIndexOf(" document.addEventListener('visibilitychange'");
  const eventsEnd = app.indexOf(" window.addEventListener('pageshow'", eventsStart);
  if (start < 0 || end < start || eventsStart < 0 || eventsEnd < eventsStart) throw Error('FRONTDESK_SYNC_BOUNDARY_MISSING');
  const timers = new Map(), listeners = new Map(), probes = [], loads = [], heldLoads = [], failures = [];
  let now = 0, timerId = 0, holdLoad = false;
  const events = prefix => ({
    addEventListener(type, fn) { listeners.set(prefix + type, fn); },
  });
  const document = { ...events('d:'), visibilityState: 'visible' }, navigator = { onLine: true };
  const context = {
    window: events('w:'), document, navigator, idToken: 'synthetic-staff', busy: false, pending: new Map(), status: {},
    setTimeout(fn, delay) { const key = ++timerId; timers.set(key, { fn, at: now + delay }); return key; },
    clearTimeout(key) { timers.delete(key); },
    request(action) { return new Promise((resolve, reject) => probes.push({ action, resolve, reject })); },
    load() { loads.push(now); return holdLoad ? new Promise(resolve => heldLoads.push(resolve)) : Promise.resolve(true); },
    failure(error) { failures.push(error); },
  };
  const declarations = / let syncTimer=[^;]+;/.exec(app)?.[0];
  vm.runInNewContext(declarations + app.slice(start, end) + app.slice(eventsStart, eventsEnd) +
    '\nthis.start=startSync;this.stop=stopSync;', context);
  return {
    document, navigator, probes, loads, failures, timers, context,
    start: context.start, stop: context.stop,
    emit(type, documentEvent = false) { listeners.get((documentEvent ? 'd:' : 'w:') + type)?.(); },
    holdLoad() { holdLoad = true; },
    async finishLoad() { holdLoad = false; for (const resolve of heldLoads.splice(0)) resolve(true); await flush(); },
    async tick(ms = 0) {
      await flush(); const endTime = now + ms;
      for (let i = 0; i < 100; i++) {
        const next = [...timers].filter(([, timer]) => timer.at <= endTime).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
      }
      now = endTime; await flush();
    },
  };
}
module.exports = { frontdeskSyncHarness };
