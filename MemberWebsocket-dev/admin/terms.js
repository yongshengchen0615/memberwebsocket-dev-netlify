(() => {
  'use strict';

  window.addEventListener('DOMContentLoaded', () => {
    const $ = (id) => document.getElementById(id);
    const ids = [
      'termsReload','termsAdminMessage','termsVersionList','termsNewDraft','termsDraftForm',
      'termsId','termsVersion','termsTitle','termsSummary','termsBody','termsEffectiveAt',
      'termsRequired','termsReconsent','termsSave','termsActivate','termsActiveVersion',
      'termsActiveTitle','termsDraftCount','termsVersionCount','termsEditorState',
      'termsEditorHint','termsReadonlyNote','termsSummaryCount','termsBodyCount',
      'termsReconsentNote'
    ];
    const el = Object.fromEntries(ids.map((id) => [id, $(id)]));
    let rows = [];
    let busy = false;
    let selectedRow = null;

    const statusMeta = (status, scope) => {
      if (scope === 'e2e') {
        if (status === 'active') return { label: 'E2E 測試中', className: 'is-e2e' };
        return { label: 'E2E 測試歷史', className: 'is-e2e' };
      }
      if (status === 'active') return { label: '啟用中', className: 'is-active' };
      if (status === 'draft') return { label: '草稿', className: 'is-draft' };
      return { label: '歷史版本', className: 'is-history' };
    };

    function formatDate(value) {
      if (!value) return '未設定生效時間';
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) return '未設定生效時間';
      try {
        return new Intl.DateTimeFormat('zh-TW', {
          year: 'numeric', month: 'short', day: 'numeric',
          hour: '2-digit', minute: '2-digit', hour12: false
        }).format(date);
      } catch (_) {
        return date.toLocaleString();
      }
    }

    function updateCounts() {
      el.termsSummaryCount.textContent = `${el.termsSummary.value.length} / 500`;
      el.termsBodyCount.textContent = `${el.termsBody.value.length.toLocaleString('zh-TW')} / 20,000`;
    }

    function updatePolicyNotice() {
      el.termsReconsentNote.classList.toggle('hidden', !el.termsReconsent.checked);
    }

    function updateOverview() {
      const productionRows = rows.filter((row) => (row.scope || 'production') === 'production');
      const active = productionRows.find((row) => row.status === 'active') || null;
      const draftCount = productionRows.filter((row) => row.status === 'draft').length;
      el.termsActiveVersion.textContent = active?.version || '尚未啟用';
      el.termsActiveTitle.textContent = active?.title || '建立第一版草稿後再啟用';
      el.termsDraftCount.textContent = String(draftCount);
      el.termsVersionCount.textContent = String(productionRows.length);
    }

    function updateEditorMeta() {
      if (!selectedRow) {
        el.termsEditorState.textContent = '新草稿';
        el.termsEditorState.className = 'terms-editor-status is-new';
        el.termsEditorHint.textContent = '建立新版本並儲存成草稿；確認內容後才能啟用。';
        el.termsReadonlyNote.classList.add('hidden');
        el.termsSave.textContent = '建立草稿';
        return;
      }

      const meta = statusMeta(selectedRow.status, selectedRow.scope);
      el.termsEditorState.textContent = meta.label;
      el.termsEditorState.className = `terms-editor-status ${meta.className}`;
      el.termsSave.textContent = '儲存草稿';

      if (selectedRow.scope === 'e2e') {
        el.termsEditorHint.textContent = '此版本由 E2E 測試自動建立，只提供測試帳號驗證會員申請條款。';
        el.termsReadonlyNote.textContent = 'E2E 條款與正式會員條款完全隔離；請使用「移除測試資料」清除，不可從一般條款管理流程修改或啟用。';
        el.termsReadonlyNote.classList.remove('hidden');
      } else if (selectedRow.status === 'draft') {
        el.termsEditorHint.textContent = '草稿可繼續修改；啟用後內容會鎖定。';
        el.termsReadonlyNote.classList.add('hidden');
      } else if (selectedRow.status === 'active') {
        el.termsEditorHint.textContent = '目前對會員生效的版本。';
        el.termsReadonlyNote.textContent = '此版本已啟用並鎖定內容。若要修改條款，請建立新版本，避免改寫既有會員已同意的內容。';
        el.termsReadonlyNote.classList.remove('hidden');
      } else {
        el.termsEditorHint.textContent = '歷史版本僅供查閱。';
        el.termsReadonlyNote.textContent = '此版本已成為歷史紀錄，內容保持唯讀。若要調整條款，請建立新版本。';
        el.termsReadonlyNote.classList.remove('hidden');
      }
    }

    function updateControls() {
      const editable = !selectedRow || (selectedRow.scope !== 'e2e' && selectedRow.status === 'draft');
      for (const control of el.termsDraftForm.querySelectorAll('input:not([type="hidden"]),textarea')) {
        control.disabled = busy || !editable;
      }
      el.termsSave.disabled = busy || !editable;
      el.termsActivate.disabled = busy || !selectedRow || selectedRow.scope === 'e2e' || selectedRow.status !== 'draft';
      el.termsReload.disabled = busy;
      el.termsNewDraft.disabled = busy;
      el.termsDraftForm.setAttribute('aria-busy', String(busy));
      for (const button of el.termsVersionList.querySelectorAll('button')) button.disabled = busy;
    }

    function message(value) {
      el.termsAdminMessage.textContent = value;
      el.termsAdminMessage.classList.toggle('hidden', !value);
    }

    function session() {
      const value = window.MemberSystem.getSession('admin');
      if (!value) throw new Error('請先登入管理端。');
      return value;
    }

    async function request(action, payload = {}) {
      const { config, idToken } = session();
      return window.MemberSystem.request(config, 'admin', idToken, action, payload);
    }

    function show(row) {
      selectedRow = row || null;
      el.termsId.value = row?.id || '';
      el.termsVersion.value = row?.version || '';
      el.termsTitle.value = row?.title || '';
      el.termsSummary.value = row?.summary || '';
      el.termsBody.value = row?.body || '';
      const date = row?.effective_at ? new Date(row.effective_at) : new Date();
      el.termsEffectiveAt.value = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      el.termsRequired.checked = row ? row.required === true : true;
      el.termsReconsent.checked = row?.reconsent_existing === true;

      updateEditorMeta();
      updateCounts();
      updatePolicyNotice();
      updateControls();

      for (const button of el.termsVersionList.querySelectorAll('button')) {
        button.setAttribute('aria-current', String(button.dataset.id === row?.id));
      }
    }

    function renderVersionList() {
      el.termsVersionList.replaceChildren();

      if (!rows.length) {
        const empty = document.createElement('div');
        empty.className = 'terms-version-empty';
        const strong = document.createElement('strong');
        strong.textContent = '尚無條款版本';
        const small = document.createElement('small');
        small.textContent = '建立第一版草稿並啟用後，會員申請才會套用條款。';
        empty.append(strong, small);
        el.termsVersionList.append(empty);
        return;
      }

      for (const row of rows) {
        const meta = statusMeta(row.status, row.scope);
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.id = row.id;
        button.setAttribute('aria-current', 'false');
        button.setAttribute('aria-label', `${row.version || '未命名版本'}，${meta.label}，${row.title || '未命名條款'}`);

        const top = document.createElement('span');
        top.className = 'terms-version-card-top';
        const version = document.createElement('strong');
        version.textContent = row.version || '未命名版本';
        const badge = document.createElement('span');
        badge.className = `terms-status-badge ${meta.className}`;
        badge.textContent = meta.label;
        top.append(version, badge);

        const title = document.createElement('span');
        title.className = 'terms-version-title';
        title.textContent = row.title || '未命名條款';

        const metaLine = document.createElement('span');
        metaLine.className = 'terms-version-meta';
        const consentText = row.reconsent_existing === true ? '既有會員需重新同意' : '既有會員不強制重新同意';
        const scopeText = row.scope === 'e2e' ? 'E2E 測試資料' : '正式會員條款';
        metaLine.textContent = `${scopeText} · ${formatDate(row.effective_at)} · ${consentText}`;

        button.append(top, title, metaLine);
        button.addEventListener('click', () => show(row));
        el.termsVersionList.append(button);
      }
    }

    async function reload(selectedId) {
      const result = await request('admin.terms.list');
      rows = result.terms || [];
      renderVersionList();
      updateOverview();
      show(
        rows.find((row) => row.id === selectedId)
        || rows.find((row) => row.scope !== 'e2e' && row.status === 'active')
        || rows.find((row) => row.scope !== 'e2e')
        || rows[0]
        || null
      );
    }

    async function run(task) {
      if (busy) return;
      busy = true;
      updateControls();
      message('');
      try {
        await task();
      } catch (error) {
        message(
          error?.code === 'API_RESPONSE_UNCERTAIN'
            ? '無法確認是否儲存成功，請先重新載入版本確認。'
            : error?.message || '操作失敗。'
        );
      } finally {
        busy = false;
        updateControls();
      }
    }

    el.termsSummary.addEventListener('input', updateCounts);
    el.termsBody.addEventListener('input', updateCounts);
    el.termsReconsent.addEventListener('change', updatePolicyNotice);

    el.termsReload.addEventListener('click', () => run(() => reload(el.termsId.value)));

    el.termsNewDraft.addEventListener('click', () => {
      if (!busy) {
        show(null);
        message('');
        el.termsVersion.focus();
      }
    });

    el.termsDraftForm.addEventListener('submit', (event) => {
      event.preventDefault();
      if (busy) return;

      const effectiveAt = new Date(el.termsEffectiveAt.value);
      if (!Number.isFinite(effectiveAt.getTime())) {
        message('請設定有效的條款生效時間。');
        el.termsEffectiveAt.focus();
        return;
      }

      run(async () => {
        const result = await request('admin.terms.draft.save', {
          id: el.termsId.value || null,
          version: el.termsVersion.value.trim(),
          title: el.termsTitle.value.trim(),
          summary: el.termsSummary.value.trim(),
          body: el.termsBody.value.trim(),
          effectiveAt: effectiveAt.toISOString(),
          required: el.termsRequired.checked,
          reconsentExisting: el.termsReconsent.checked
        });
        await reload(result.id);
        message('草稿已儲存。確認內容後再啟用。');
      });
    });

    el.termsActivate.addEventListener('click', () => run(async () => {
      const id = el.termsId.value;
      if (!id) return;
      await request('admin.terms.activate', { id });
      await reload(id);
      message(
        el.termsReconsent.checked
          ? '此版本已啟用；既有會員下次進入時會被要求重新同意新版條款。'
          : '此版本已啟用，新的會員申請立即適用。'
      );
    }));

    $('membersTab').addEventListener('click', () => {
      if (session()) run(() => reload(el.termsId.value));
    });

    // Admin session becomes available after the authenticated bootstrap.
    const observer = new MutationObserver(() => {
      if (window.MemberSystem.getSession('admin') && !$('adminView').classList.contains('hidden')) {
        observer.disconnect();
        run(() => reload());
      }
    });
    observer.observe($('adminView'), { attributes: true, attributeFilter: ['class'] });

    updateCounts();
    updatePolicyNotice();
    updateEditorMeta();
  });
})();
