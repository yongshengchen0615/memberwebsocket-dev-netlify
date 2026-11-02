(() => {
  'use strict';
  // The UI is convenience only: LINE verification, current qualification,
  // business ownership, suspension and versioning are enforced by platform-api/SQL.
  const validBusiness = value => /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value);
  const el = id => document.getElementById(id);
  const form = el('clientPageTitleForm');
  const input = el('clientPageTitleInput');
  const save = el('clientPageTitleSave');
  let generation = 0, config = null, token = '', tenant = null, pending = null, saving = false;
  let fallback = 'Lumen Club';

  function status(message) { if (el('clientPageTitleStatus')) el('clientPageTitleStatus').textContent = message; }
  function preview() {
    const title = input?.value.trim() || fallback;
    if (el('clientPageTitlePreview')) el('clientPageTitlePreview').textContent = title + '｜預約';
  }
  function clear() {
    generation += 1;
    config = null; token = ''; tenant = null; pending = null; saving = false;
    fallback = 'Lumen Club';
    if (form) form.reset();
    if (input) { input.disabled = true; input.placeholder = '請先選擇已授權的商家'; }
    if (save) { save.disabled = true; save.textContent = '儲存網頁抬頭'; }
    if (el('clientPageTitleShortcut')) el('clientPageTitleShortcut').hidden = true;
    status('');
    preview();
  }
  async function request(action, payload, scope) {
    const url = new URL(config.supabaseFunctionUrl);
    url.pathname = url.pathname.replace(/\/api\/?$/, '/platform-api');
    if (!url.pathname.endsWith('/platform-api') || url.protocol !== 'https:')
      throw new Error('管理端 API 設定不正確。');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url.href, {
        method: 'POST', cache: 'no-store',
        headers: {'Content-Type':'application/json', apikey:config.supabasePublishableKey},
        body: JSON.stringify({action, idToken:token, business:scope, ...payload}),
        signal: controller.signal,
      });
      let body;
      try { body = await response.json(); }
      catch { throw Object.assign(new Error('無法確認伺服器回應。'), {uncertain: true}); }
      if (!response.ok || body?.ok !== true) {
        throw Object.assign(new Error(body?.error?.message || '無法完成設定。'), {
          status: response.status, code: body?.error?.code,
        });
      }
      return body.data;
    } finally { clearTimeout(timer); }
  }
  async function load(scope, epoch) {
    try {
      const result = await request('platform.application.bootstrap', {}, scope);
      if (generation !== epoch) return;
      const found = result?.tenant;
      if (result?.application?.status !== 'approved' || found?.slug !== scope ||
          found?.status !== 'active' || found?.expired === true ||
          !Number.isSafeInteger(found.version) || found.version < 1)
        throw new Error('目前沒有此商家的網頁抬頭修改權限。');
      tenant = found;
      fallback = found.name || 'Lumen Club';
      input.value = found.siteTitle || '';
      input.placeholder = fallback;
      input.disabled = false;
      save.disabled = false;
      preview();
      status('已讀取商家目前設定。');
    } catch (error) {
      if (generation !== epoch) return;
      tenant = null;
      input.disabled = true;
      save.disabled = true;
      status(error.message || '無法讀取網頁抬頭設定。');
    }
  }
  function sync(nextConfig, idToken) {
    clear();
    const scope = typeof nextConfig?.business === 'string' ? nextConfig.business : '';
    if (nextConfig?.productizedAdmin !== true || !validBusiness(scope) ||
        typeof idToken !== 'string' || !idToken) return;
    config = nextConfig; token = idToken;
    const epoch = generation;
    el('clientPageTitleShortcut').hidden = false;
    status('正在讀取商家網頁抬頭…');
    void load(scope, epoch);
  }
  input?.addEventListener('input', () => {
    if (saving || pending || !tenant) return;
    preview();
    status('尚未儲存。');
  });
  form?.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving || !tenant || !config || !token) return;
    if (!pending) {
      if (!form.reportValidity()) return;
      const title = input.value.trim();
      if (Array.from(title).length > 60 || /[\u0000-\u001f\u007f]/.test(title)) {
        status('顯示名稱最多 60 字，且不能包含控制字元。'); return;
      }
      pending = { title, expectedVersion:tenant.version, requestId:crypto.randomUUID() };
    }
    const epoch = generation, scope = config.business;
    saving = true; input.disabled = true; save.disabled = true;
    status('正在儲存網頁抬頭…');
    try {
      const result = await request('platform.title.save', pending, scope);
      if (generation !== epoch) return;
      if (result?.tenant?.slug !== scope || !Number.isSafeInteger(result.tenant.version))
        throw Object.assign(new Error('無法確認儲存結果；請重新整理管理端。'), {uncertain:true});
      tenant = result.tenant; fallback = tenant.name || fallback;
      pending = null;
      input.value = tenant.siteTitle || '';
      input.placeholder = fallback;
      preview();
      status('已儲存。重新開啟用戶端即可看到新的分頁標題。');
    } catch (error) {
      if (generation !== epoch) return;
      if (error?.status === 401 || error?.status === 403) {
        clear(); return;
      }
      const uncertain = error?.uncertain || !Number.isInteger(error?.status) || error.status >= 500;
      if (!uncertain) pending = null;
      if (error?.status === 409) {
        // Never auto-retry a stale version. The manager must refresh first.
        tenant = null;
        status('商家設定已由其他管理員變更，請重新整理管理端後再修改。');
      } else {
        status(uncertain ? '儲存結果尚未確認，請按「重試相同操作」，避免重複提交。' :
          (error.message || '儲存失敗。請檢查輸入後重試。'));
        if (uncertain) save.textContent = '重試相同操作';
      }
    } finally {
      if (generation === epoch) {
        saving = false; input.disabled = !tenant;
        save.disabled = !tenant; if (!pending) save.textContent = '儲存網頁抬頭';
      }
    }
  });
  Object.defineProperty(window, 'ClientPageTitleShortcut', {
    value: Object.freeze({sync, clear}), writable: false, configurable: false,
  });
})();
