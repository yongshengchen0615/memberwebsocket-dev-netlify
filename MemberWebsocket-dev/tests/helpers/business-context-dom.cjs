const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('../integration/node_modules/jsdom');

const flushDom = () => new Promise(resolve => setImmediate(resolve));

async function businessContextDom({ source, rows = 0, surface = 'booking' } = {}) {
  const links = Array.from({ length: rows }, (_, i) => `<a href="/points/?row=${i}">點數</a>`).join('');
  const dom = new JSDOM(`<!doctype html><title>原標題</title><main id="bookingView"><span data-tenant-brand="預約">原品牌</span><nav>${links}</nav><section id="changes"></section></main>`, {
    url: `https://fixture.test/${surface}/?business=shop-a`, runScripts: 'outside-only',
  });
  const { window } = dom, { document } = window;
  const metrics = { documentQueries: 0, elementQueries: 0, hrefWrites: 0, requests: 0, observerBatches: 0, roots: new Set() };
  const queryDocument = document.querySelectorAll.bind(document);
  document.querySelectorAll = selector => { metrics.documentQueries++; return queryDocument(selector); };
  const queryElement = window.Element.prototype.querySelectorAll;
  window.Element.prototype.querySelectorAll = function (selector) {
    metrics.elementQueries++; metrics.roots.add(this); return queryElement.call(this, selector);
  };
  const href = Object.getOwnPropertyDescriptor(window.HTMLAnchorElement.prototype, 'href');
  Object.defineProperty(window.HTMLAnchorElement.prototype, 'href', {
    ...href, set(value) { metrics.hrefWrites++; return href.set.call(this, value); },
  });
  const Observer = window.MutationObserver, observers = [];
  window.MutationObserver = class extends Observer {
    constructor(callback) { super((records, observer) => { metrics.observerBatches++; callback(records, observer); }); observers.push(this); }
  };
  let features = { membership: true, points: false, events: true, calendar: true, booking: true };
  let brand = '測試商家';
  window.fetch = async (_url, init) => {
    metrics.requests++;
    const body = JSON.parse(init.body);
    return { ok: true, json: async () => ({ ok: true, data: { business: body.business, name: brand, features: { ...features }, line: { bookingLiffId: 'synthetic-booking' } } }) };
  };
  window.AbortController = AbortController;
  window.eval(source || fs.readFileSync(path.resolve(__dirname, '../../business-context.js'), 'utf8'));
  await flushDom();
  const config = () => ({ supabaseFunctionUrl: 'https://fixture.supabase.co/functions/v1/api', supabasePublishableKey: 'synthetic-public' });
  const reset = () => {
    for (const key of Object.keys(metrics)) if (key !== 'roots') metrics[key] = 0;
    metrics.roots.clear();
  };
  return { dom, window, document, context: window.BusinessContext, metrics, config, reset, flush: flushDom,
    setFeatures(value) { features = { ...features, ...value }; },
    setBrand(value) { brand = value; }, close() { for (const observer of observers) observer.disconnect(); window.close(); },
  };
}
module.exports = { businessContextDom, flushDom };
