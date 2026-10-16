(() => {
  'use strict';

  let session;
  let version = '';
  let savedPolicy = null;
  let busy = false;
  const labels = {
    eligible_only: '只顯示符合資格的內容',
    higher_preview: '符合資格＋較高階級鎖定預覽'
  };

  async function request(action, payload = {}) {
    return window.MemberSystem.request(session.config, 'admin', session.idToken, action, payload);
  }

  function describe(policy) {
    return policy === 'higher_preview'
      ? '符合階級的內容可正常操作；較高階級專屬內容會以鎖定狀態顯示，讓會員知道升級後的權益。'
      : '會員只看得到目前階級符合資格的內容；不符合資格的活動、票券與預約入口不顯示。';
  }

  function boot() {
    const panel = document.getElementById('eventsPanel');
    if (!panel) return;
    const section = document.createElement('section');
    section.className = 'tier-settings usage-policy-card visibility-policy-card';
    section.id = 'ticketVisibilitySettings';
    section.setAttribute('aria-labelledby', 'ticketVisibilitySettingsTitle');
    section.innerHTML = `
      <header class="usage-policy-heading">
        <div><p class="kicker">Member visibility</p><h3 id="ticketVisibilitySettingsTitle">會員階級顯示規則</h3><p>統一控制活動票券、活動日曆與預約入口的顯示方式；不改變會員資格或實際使用權限。</p></div>
        <div class="usage-policy-current"><span>目前生效</span><strong id="ticketVisibilityCurrent">載入中…</strong></div>
      </header>
      <div class="usage-policy-body">
        <div class="usage-policy-control">
          <label for="ticketVisibilityPolicy">會員端顯示方式</label>
          <select id="ticketVisibilityPolicy" aria-describedby="ticketVisibilityHelp" disabled>
            <option value="eligible_only">只顯示符合目前階級的內容</option>
            <option value="higher_preview">符合資格＋較高階級鎖定預覽</option>
          </select>
          <small id="ticketVisibilityHelp">可預覽不代表可以領取或使用；伺服器仍會驗證會員等級及票券規則。</small>
        </div>
        <div class="usage-policy-preview" aria-live="polite"><span>會員端效果預覽</span><strong id="ticketVisibilityPreviewTitle">正在讀取顯示規則…</strong><p id="ticketVisibilityPreview">設定載入後即可查看效果。</p></div>
      </div>
      <div class="visibility-policy-examples" aria-label="顯示規則比較">
        <div data-visibility-mode="eligible_only"><strong>只顯示符合資格</strong><span>適合不希望提前曝光高階內容的活動</span></div>
        <div data-visibility-mode="higher_preview"><strong>較高階級鎖定預覽</strong><span>適合展示升級權益；未符合資格仍不可領取或使用</span></div>
      </div>
      <p id="ticketVisibilityStatus" class="usage-policy-status" role="status" aria-live="polite">正在載入設定…</p>
      <footer class="usage-policy-footer"><span id="ticketVisibilityChangeStatus">設定載入中</span><div class="usage-policy-buttons"><button id="refreshTicketVisibility" type="button" class="button button-outline">重新載入</button><button id="saveTicketVisibility" type="button" class="button button-dark" disabled>儲存顯示規則</button></div></footer>
    `;
    panel.prepend(section);
    const select = section.querySelector('#ticketVisibilityPolicy');
    const status = section.querySelector('#ticketVisibilityStatus');
    const button = section.querySelector('#saveTicketVisibility');
    const refresh = section.querySelector('#refreshTicketVisibility');

    function render() {
      const policy = select.value;
      const loaded = savedPolicy !== null;
      const dirty = loaded && policy !== savedPolicy;
      select.disabled = !loaded || busy;
      button.disabled = !loaded || !dirty || busy;
      refresh.disabled = busy;
      section.dataset.dirty = String(dirty);
      section.querySelector('#ticketVisibilityCurrent').textContent = loaded ? labels[savedPolicy] : '載入中…';
      section.querySelector('#ticketVisibilityPreviewTitle').textContent = labels[policy] || '尚未設定';
      section.querySelector('#ticketVisibilityPreview').textContent = describe(policy);
      section.querySelector('#ticketVisibilityChangeStatus').textContent = !loaded ? '設定載入中' : dirty ? '有尚未儲存的變更' : '已與目前設定同步';
      section.querySelectorAll('[data-visibility-mode]').forEach((card) => {
        card.classList.toggle('is-selected', card.dataset.visibilityMode === policy);
      });
    }

    async function load() {
      if (busy) return;
      busy = true;
      render();
      status.textContent = '正在同步最新顯示規則…';
      try {
        session = await window.MemberAdminSession.wait();
        const result = await request('admin.ticket-visibility.get');
        if (!Object.hasOwn(labels, result.visibilityPolicy)) throw new Error('顯示規則資料不正確，請檢查設定。');
        version = String(result.updatedAt || '');
        savedPolicy = result.visibilityPolicy;
        select.value = savedPolicy;
        status.textContent = '';
      } catch (error) {
        status.textContent = error && error.message || '顯示設定載入失敗，請重新載入。';
      } finally {
        busy = false;
        render();
      }
    }

    select.addEventListener('change', () => { status.textContent = ''; render(); });
    button.addEventListener('click', async () => {
      if (busy || savedPolicy === null || select.value === savedPolicy) return;
      busy = true;
      button.textContent = '儲存中…';
      status.textContent = '';
      render();
      try {
        const result = await request('admin.ticket-visibility.save', {
          visibilityPolicy: select.value,
          expectedUpdatedAt: version
        });
        version = String(result.updatedAt || '');
        savedPolicy = Object.hasOwn(labels, result.visibilityPolicy) ? result.visibilityPolicy : select.value;
        select.value = savedPolicy;
        status.textContent = '已儲存顯示規則，會員端將同步更新。';
      } catch (error) {
        status.textContent = error && error.message || '儲存失敗，請重新載入最新設定。';
      } finally {
        busy = false;
        button.textContent = '儲存顯示規則';
        render();
      }
    });
    refresh.addEventListener('click', () => { void load(); });
    render();
    void load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
