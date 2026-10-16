const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '../..');
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

async function page() {
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'admin/index.html'), 'utf8'), {
    runScripts: 'outside-only', url: 'https://example.test/admin/',
  });
  const w = dom.window;
  await new Promise((resolve) => w.addEventListener('load', resolve, { once: true }));
  const calls = [];
  const draft = { id: 'draft-1', version: 'v2', title: '條款', body: '全文', status: 'draft', required: true, effective_at: '2026-10-01T00:00:00+08:00' };
  let finishSave;
  w.MemberSystem = {
    getSession: () => ({ config: {}, idToken: 'fixture' }),
    request: async (_config, _surface, _token, action, payload) => {
      calls.push({ action, payload });
      if (action === 'admin.terms.list') return { terms: [draft] };
      if (action === 'admin.terms.draft.save') return new Promise((resolve) => { finishSave = () => resolve({ id: draft.id }); });
      if (action === 'admin.terms.activate') { draft.status = 'active'; return {}; }
      throw new Error(action);
    },
  };
  w.eval(fs.readFileSync(path.join(root, 'admin/terms.js'), 'utf8'));
  w.dispatchEvent(new w.Event('DOMContentLoaded'));
  const get = (id) => w.document.getElementById(id);
  get('termsReload').click();
  await tick();
  return { dom, w, get, calls, finishSave: () => finishSave() };
}

test('terms save prevents draft/version switching and duplicate requests until reload completes', async () => {
  const { dom, w, get, calls, finishSave } = await page();
  try {
    get('termsDraftForm').dispatchEvent(new w.Event('submit', { cancelable: true }));
    assert.equal(get('termsNewDraft').disabled, true);
    assert.equal(get('termsReload').disabled, true);
    assert.equal(get('termsActivate').disabled, true);
    assert.equal(get('termsVersion').disabled, true);
    assert.equal(get('termsDraftForm').getAttribute('aria-busy'), 'true');
    get('termsNewDraft').click();
    get('termsDraftForm').dispatchEvent(new w.Event('submit', { cancelable: true }));
    assert.equal(calls.filter((row) => row.action === 'admin.terms.draft.save').length, 1);
    assert.equal(get('termsId').value, 'draft-1');
    finishSave();
    await tick();
    assert.equal(get('termsNewDraft').disabled, false);
    assert.equal(get('termsVersion').disabled, false);
    assert.equal(get('termsActivate').disabled, false);
    assert.equal(get('termsDraftForm').getAttribute('aria-busy'), 'false');
    assert.match(get('termsAdminMessage').textContent, /草稿已儲存/);
    get('termsActivate').click();
    await tick();
    assert.equal(get('termsVersion').disabled, true);
    assert.equal(get('termsSave').disabled, true);
    assert.equal(get('termsActivate').disabled, true);
    assert.equal(get('termsNewDraft').disabled, false);
  } finally { dom.window.close(); }
});

test('invalid terms effective time is explained before any request and focuses the field', async () => {
  const { dom, w, get, calls } = await page();
  try {
    get('termsEffectiveAt').value = '';
    get('termsDraftForm').dispatchEvent(new w.Event('submit', { cancelable: true }));
    assert.equal(calls.some((row) => row.action === 'admin.terms.draft.save'), false);
    assert.match(get('termsAdminMessage').textContent, /有效的條款生效時間/);
    assert.equal(w.document.activeElement.id, 'termsEffectiveAt');
  } finally { dom.window.close(); }
});
