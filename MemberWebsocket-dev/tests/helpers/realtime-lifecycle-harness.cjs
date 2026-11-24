const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

function realtimeLifecycleHarness(kind, source) {
  const listeners = new Map(), timers = new Map(), intervals = new Map();
  const channels = [], notifications = [], removals = [];
  let now = 10000, id = 0, holdRemoval = false, channelFailure = false;
  const events = prefix => ({
    addEventListener(type, fn) {
      const key = prefix + type;
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key).add(fn);
    },
    removeEventListener(type, fn) { listeners.get(prefix + type)?.delete(fn); },
  });
  const window = {
    ...events('w:'), location: { pathname: '/booking/', href: 'https://fixture.test/booking/' },
    CustomEvent: class { constructor(type, { detail }) { this.type = type; this.detail = detail; } },
    dispatchEvent(event) { notifications.push(event); },
    setTimeout(fn, delay = 0) { const key = ++id; timers.set(key, { fn, at: now + delay }); return key; },
    clearTimeout(key) { timers.delete(key); },
    setInterval(fn) { const key = ++id; intervals.set(key, fn); return key; },
    clearInterval(key) { intervals.delete(key); },
    supabase: { createClient() { return {
      channel(name) {
        if (channelFailure) throw Error('SDK_CHANNEL_UNAVAILABLE');
        const channel = {
          name, removed: false,
          on(_event, _filter, fn) { this.change = fn; return this; },
          subscribe(fn) { this.status = fn; return this; },
        };
        channels.push(channel); return channel;
      },
      removeChannel(channel) {
        channel.removed = true;
        if (!holdRemoval) return Promise.resolve('ok');
        return new Promise(resolve => removals.push(resolve));
      },
    }; } },
  };
  const document = { ...events('d:'), visibilityState: 'visible', querySelector: () => null };
  const navigator = { onLine: true };
  vm.runInNewContext(source || fs.readFileSync(path.join(__dirname, '../..', kind === 'booking' ? 'booking/common.js' : 'member-system.js'), 'utf8'), {
    window, document, navigator, URL, console,
    Date: class extends Date { static now() { return now; } },
  });
  const config = { realtimeEnabled: true, supabaseUrl: 'https://fixture.supabase.co',
    supabaseFunctionUrl: 'https://fixture.supabase.co/functions/v1/api', supabasePublishableKey: 'fixture-public',
    memberLiffId: 'member', pointsLiffId: 'points', eventLiffId: 'event', calendarLiffId: 'calendar', bookingLiffId: 'booking', adminLiffId: 'admin' };
  const system = kind === 'booking' ? window.BookingSystem : window.MemberSystem;
  return {
    window, document, navigator, channels, notifications, timers, intervals, config, system,
    subscribe(update = () => {}, cfg = config, benefits = null) {
      return kind === 'booking' ? system.subscribeRealtime(cfg, update, 'member', benefits) : system.subscribeRealtime(cfg, 'member', update);
    },
    emit(type, documentEvent = false) {
      for (const fn of listeners.get((documentEvent ? 'd:' : 'w:') + type) || []) fn({ type });
    },
    holdRemoval() { holdRemoval = true; },
    failChannels(value) { channelFailure = value; },
    async finishRemoval() { holdRemoval = false; for (const resolve of removals.splice(0)) resolve('ok'); await flush(); },
    get listenerCount() { return [...listeners.values()].reduce((n, set) => n + set.size, 0); },
    get activeChannels() { return channels.filter(channel => !channel.removed).length; },
    async tick(ms = 0) {
      await flush(); const end = now + ms;
      for (let i = 0; i < 100; i++) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
      }
      now = end; await flush();
    },
  };
}
module.exports = { realtimeLifecycleHarness, flush };
