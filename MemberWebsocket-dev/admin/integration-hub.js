(() => {
  'use strict';

  const state = {
    data: null,
    loading: false,
    activeView: 'overview',
    notificationFilter: 'all',
    auditFilter: 'all',
    auditQuery: '',
    lastLoadedAt: 0,
  };

  const STATUS_LABELS = {
    active: '啟用中',
    draft: '草稿',
    archived: '已封存',
    pending: '待處理',
    queued: '待處理',
    processing: '處理中',
    sent: '已傳送',
    success: '成功',
    failed: '失敗',
    skipped: '略過',
    attention: '需確認',
    completed: '已完成',
  };
  const TIER_LABELS = { general:'一般', silver:'銀級', gold:'金級', platinum:'白金' };

  function ready(callback) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', callback, { once:true });
    else callback();
  }

  ready(init);

  function init() {
    const nav = document.querySelector('.surface-nav');
    const adminView = document.getElementById('adminView');
    if (!nav || !adminView || document.getElementById('operationsHubTab')) return;

    const tab = document.createElement('button');
    tab.id = 'operationsHubTab';
    tab.className = 'surface-tab';
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', 'false');
    tab.setAttribute('aria-controls', 'operationsHubPanel');
    tab.textContent = '整合中心';

    const testTab = document.getElementById('testModeTab');
    if (testTab && testTab.parentElement === nav) nav.insertBefore(tab, testTab);
    else nav.append(tab);

    const panel = document.createElement('section');
    panel.id = 'operationsHubPanel';
    panel.className = 'panel hidden integration-hub-panel';
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', 'operationsHubTab');
    panel.innerHTML = panelHtml();

    const testPanel = document.getElementById('testModePanel');
    if (testPanel && testPanel.parentElement === adminView) adminView.insertBefore(panel, testPanel);
    else adminView.append(panel);

    tab.addEventListener('click', activate);
    nav.addEventListener('click', (event) => {
      const other = event.target instanceof Element ? event.target.closest('.surface-tab') : null;
      if (!other || other.id === 'operationsHubTab') return;
      deactivate();
    });

    panel.addEventListener('click', handleClick);
    panel.addEventListener('change', handleChange);
    panel.addEventListener('input', handleInput);
    window.addEventListener('member-admin-data-refreshed', () => {
      if (!panel.classList.contains('hidden') && Date.now() - state.lastLoadedAt > 1200) refresh();
    });
    window.addEventListener('member-admin-session-ready', () => {
      if (!panel.classList.contains('hidden')) refresh();
    });
  }

  function panelHtml() {
    return `
      <div class="panel-heading integration-hub-heading">
        <div>
          <p class="kicker">Operations center</p>
          <h2>整合營運中心</h2>
          <p>跨會員、權益、活動、通知、預約與稽核的管理讀模型；實際寫入仍由各 Domain 原有流程負責。</p>
        </div>
        <div class="heading-actions">
          <span id="integrationHubFreshness" class="integration-freshness">尚未同步</span>
          <button class="button button-outline" type="button" data-integration-action="refresh">重新整理</button>
        </div>
      </div>
      <div id="integrationHubMessage" class="form-message hidden" role="alert"></div>

      <section class="integration-command-bar" aria-label="整合操作列">
        <div>
          <p class="kicker">Quick operations</p>
          <h3>常用操作與批次入口</h3>
          <p>跨模組只提供導向；批次寫入仍留在各自模組，以維持驗證、授權與交易邊界。</p>
        </div>
        <div class="integration-command-actions">
          <button class="button button-dark" type="button" data-integration-target="member-grant">會員發放</button>
          <button class="button button-outline" type="button" data-integration-target="booking-services">點數來源設定</button>
          <button class="button button-outline" type="button" data-integration-target="events">自動權益</button>
          <button class="button button-outline" type="button" data-integration-target="booking-queue">預約結算</button>
          <button class="button button-outline" type="button" data-integration-target="calendar-batch">日曆批次</button>
        </div>
      </section>

      <div id="integrationMetricGrid" class="integration-metric-grid" aria-live="polite"></div>

      <nav class="integration-view-tabs" role="tablist" aria-label="整合中心分類">
        <button class="integration-view-tab active" role="tab" type="button" aria-selected="true" data-integration-view-tab="overview">總覽</button>
        <button class="integration-view-tab" role="tab" type="button" aria-selected="false" data-integration-view-tab="benefits">權益自動化</button>
        <button class="integration-view-tab" role="tab" type="button" aria-selected="false" data-integration-view-tab="notifications">通知中心</button>
        <button class="integration-view-tab" role="tab" type="button" aria-selected="false" data-integration-view-tab="audit">Audit Timeline</button>
      </nav>

      <section data-integration-view="overview" class="integration-view">
        <div class="integration-two-column">
          <section class="integration-card">
            <div class="integration-card-heading"><div><p class="kicker">Point sources</p><h3>點數自動來源</h3></div><button class="text-button" type="button" data-integration-target="booking-services">管理來源</button></div>
            <div id="integrationPointSources" class="integration-list"></div>
          </section>
          <section class="integration-card">
            <div class="integration-card-heading"><div><p class="kicker">Campaign ownership</p><h3>活動期間與日曆關聯</h3></div><button class="text-button" type="button" data-integration-target="events">管理活動票券</button></div>
            <div id="integrationCampaigns" class="integration-list"></div>
          </section>
        </div>
        <section class="integration-card">
          <div class="integration-card-heading"><div><p class="kicker">Completion settlements</p><h3>最近預約完成結算</h3></div><button class="text-button" type="button" data-integration-target="booking-queue">前往預約</button></div>
          <div id="integrationSettlements" class="integration-table-wrap"></div>
        </section>
      </section>

      <section data-integration-view="benefits" class="integration-view hidden">
        <div class="integration-benefit-summary" id="integrationBenefitSummary"></div>
        <section class="integration-card">
          <div class="integration-card-heading"><div><p class="kicker">Automatic benefits</p><h3>固定票券規則</h3></div><button class="button button-outline" type="button" data-integration-target="fixed-new">＋ 新增固定票券</button></div>
          <div id="integrationFixedTickets" class="integration-list"></div>
        </section>
        <section class="integration-card">
          <div class="integration-card-heading"><div><p class="kicker">Birthday benefits</p><h3>生日固定票券</h3></div><button class="text-button" type="button" data-integration-target="birthday-fixed-new">新增生日固定票券</button></div>
          <div id="integrationBirthday" class="integration-list"></div>
        </section>
      </section>

      <section data-integration-view="notifications" class="integration-view hidden">
        <section class="integration-card">
          <div class="integration-card-heading integration-filter-heading">
            <div><p class="kicker">Notification center</p><h3>LINE 預約傳送狀態</h3></div>
            <label>狀態
              <select id="integrationNotificationFilter">
                <option value="all">全部</option><option value="pending">待處理</option><option value="sent">已傳送</option><option value="failed">失敗</option>
              </select>
            </label>
          </div>
          <div id="integrationNotifications" class="integration-table-wrap"></div>
        </section>
      </section>

      <section data-integration-view="audit" class="integration-view hidden">
        <section class="integration-card">
          <div class="integration-card-heading integration-filter-heading">
            <div><p class="kicker">Unified audit</p><h3>跨模組 Audit Timeline</h3></div>
            <div class="integration-audit-filters">
              <label>Domain
                <select id="integrationAuditFilter">
                  <option value="all">全部</option>
                  <option value="member">會員</option>
                  <option value="booking">預約</option>
                  <option value="event_ticket">活動票券</option>
                  <option value="calendar">日曆</option>
                  <option value="system">系統／其他</option>
                </select>
              </label>
              <label>搜尋
                <input id="integrationAuditSearch" type="search" maxlength="100" placeholder="Action 或目標">
              </label>
            </div>
          </div>
          <div id="integrationAuditTimeline" class="integration-audit-timeline"></div>
        </section>
      </section>
    `;
  }

  function activate() {
    document.querySelectorAll('#adminView > .panel').forEach((panel) => panel.classList.add('hidden'));
    document.querySelectorAll('.surface-nav .surface-tab').forEach((button) => button.setAttribute('aria-selected', 'false'));
    document.getElementById('bookingPanel')?.classList.add('hidden');
    document.getElementById('bookingTab')?.setAttribute('aria-selected', 'false');
    document.getElementById('operationsHubPanel')?.classList.remove('hidden');
    document.getElementById('operationsHubTab')?.setAttribute('aria-selected', 'true');
    if (!state.data || Date.now() - state.lastLoadedAt > 15000) refresh();
  }

  function deactivate() {
    document.getElementById('operationsHubPanel')?.classList.add('hidden');
    document.getElementById('operationsHubTab')?.setAttribute('aria-selected', 'false');
  }

  async function refresh() {
    if (state.loading) return;
    state.loading = true;
    setMessage('');
    document.getElementById('operationsHubPanel')?.setAttribute('aria-busy', 'true');
    try {
      const session = await window.MemberAdminSession.wait();
      state.data = await window.MemberSystem.request(session.config, 'admin', session.idToken, 'admin.integration-overview', {});
      state.lastLoadedAt = Date.now();
      render();
    } catch (error) {
      setMessage(error?.message || '整合資料讀取失敗，請稍後再試。');
    } finally {
      state.loading = false;
      document.getElementById('operationsHubPanel')?.setAttribute('aria-busy', 'false');
    }
  }

  function render() {
    renderMetrics();
    renderPointSources();
    renderCampaigns();
    renderSettlements();
    renderBenefits();
    renderNotifications();
    renderAudit();
    const freshness = document.getElementById('integrationHubFreshness');
    if (freshness) freshness.textContent = `同步於 ${formatDateTime(state.data?.generatedAt)}`;
  }

  function renderMetrics() {
    const data = state.data || {};
    const stats = data.stats || {};
    const notifications = Array.isArray(data.notifications) ? data.notifications : [];
    const fixed = Array.isArray(data.automation?.fixedTickets) ? data.automation.fixedTickets : [];
    const metrics = [
      ['正式會員', Number(stats.memberCount || 0), `啟用 ${Number(stats.activeMemberCount || 0)}`],
      ['啟用集點卡', Number(stats.activeCardCount || 0), `今日加點 ${Number(stats.todayEntryCount || 0)}`],
      ['啟用活動票券', Number(stats.activeEventTicketCount || 0), 'Campaign'],
      ['自動權益規則', fixed.filter((item) => item.status === 'active').length, `全部 ${fixed.length}`],
      ['待傳送通知', notifications.filter((item) => ['pending','queued','processing'].includes(item.status)).length, 'LINE'],
      ['通知失敗', notifications.filter((item) => item.status === 'failed').length, '需檢查'],
    ];
    const grid = document.getElementById('integrationMetricGrid');
    if (!grid) return;
    grid.replaceChildren(...metrics.map(([label,value,hint]) => {
      const card = document.createElement('article');
      card.className = 'integration-metric';
      const l = document.createElement('span'); l.textContent = String(label);
      const v = document.createElement('strong'); v.textContent = String(value);
      const h = document.createElement('small'); h.textContent = String(hint);
      card.append(l,v,h); return card;
    }));
  }

  function renderPointSources() {
    const rows = Array.isArray(state.data?.pointSources) ? state.data.pointSources : [];
    const host = document.getElementById('integrationPointSources');
    if (!host) return;
    if (!rows.length) return renderEmpty(host, '目前沒有自動點數來源。');
    host.replaceChildren(...rows.map((row) => {
      const item = document.createElement('article');
      item.className = 'integration-list-item';
      const main = document.createElement('div');
      const title = document.createElement('strong'); title.textContent = String(row.title || '點數來源');
      const meta = document.createElement('p'); meta.textContent = `${row.detail || '—'} · ${row.pointCardTitle || '—'}`;
      main.append(title,meta);
      item.append(main,statusBadge(row.status));
      return item;
    }));
  }

  function renderCampaigns() {
    const rows = Array.isArray(state.data?.campaigns) ? state.data.campaigns : [];
    const host = document.getElementById('integrationCampaigns');
    if (!host) return;
    if (!rows.length) return renderEmpty(host, '目前沒有活動票券。');
    host.replaceChildren(...rows.slice(0,12).map((row) => {
      const item = document.createElement('article');
      item.className = 'integration-list-item';
      const main = document.createElement('div');
      const title = document.createElement('strong'); title.textContent = String(row.title || '活動票券');
      const meta = document.createElement('p');
      meta.textContent = `${formatDateRange(row.startsOn,row.endsOn)} · ${row.calendarLinked ? '日曆已連結' : '未加入日曆'}${row.fixedTicketManaged ? ' · 固定票券產生' : ''}`;
      main.append(title,meta);
      item.append(main,statusBadge(row.status));
      return item;
    }));
  }

  function renderSettlements() {
    const rows = Array.isArray(state.data?.settlements) ? state.data.settlements : [];
    const host = document.getElementById('integrationSettlements');
    if (!host) return;
    if (!rows.length) return renderEmpty(host, '尚無完成結算紀錄。');
    const table = document.createElement('table');
    table.className = 'integration-table';
    table.innerHTML = '<thead><tr><th>會員</th><th>服務時間</th><th>點數回饋</th><th>完成時間</th><th></th></tr></thead>';
    const body = document.createElement('tbody');
    rows.slice(0,20).forEach((row) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td><strong>${escapeHtml(row.memberDisplayName || '會員')}</strong><small>${escapeHtml(row.memberCode || '')}</small></td><td>${Number(row.serviceMinutes || 0)} 分鐘</td><td>${Number(row.rewardCount || 0)} 項</td><td>${escapeHtml(formatDateTime(row.createdAt))}</td>`;
      const action = document.createElement('td');
      const button = document.createElement('button'); button.type='button'; button.className='text-button'; button.textContent='查看預約'; button.dataset.integrationBookingId=String(row.bookingId||'');
      action.append(button); tr.append(action); body.append(tr);
    });
    table.append(body); host.replaceChildren(table);
  }

  function renderBenefits() {
    const fixed = Array.isArray(state.data?.automation?.fixedTickets) ? state.data.automation.fixedTickets : [];
    const birthday = fixed.filter((row) => row.scheduleType === 'birthday_month');
    const summary = document.getElementById('integrationBenefitSummary');
    if (summary) {
      const active = fixed.filter((row) => row.status === 'active').length;
      summary.innerHTML = `<article><span>固定票券</span><strong>${active} / ${fixed.length}</strong><small>啟用規則</small></article><article><span>生日固定票券</span><strong>${birthday.filter((row)=>row.status === 'active').length} / ${birthday.length}</strong><small>啟用規則</small></article><article><span>LINE 通知</span><strong>${fixed.filter((row)=>row.notifyLine).length}</strong><small>固定規則啟用通知</small></article>`;
    }
    const fixedHost = document.getElementById('integrationFixedTickets');
    if (fixedHost) {
      if (!fixed.length) renderEmpty(fixedHost,'尚未建立固定票券規則。');
      else fixedHost.replaceChildren(...fixed.map((row) => {
        const item=document.createElement('article'); item.className='integration-list-item integration-list-item-action';
        const main=document.createElement('div');
        const title=document.createElement('strong'); title.textContent=String(row.title||'固定票券');
        const meta=document.createElement('p'); meta.textContent=`${fixedScheduleLabel(row)} · ${tierSummary(row.allowedTierKeys)} · ${row.notifyLine?'LINE 通知':'不通知'}`;
        main.append(title,meta);
        const actions=document.createElement('div'); actions.className='integration-inline-actions';
        actions.append(statusBadge(row.status));
        const button=document.createElement('button'); button.type='button'; button.className='text-button'; button.textContent='管理'; button.dataset.integrationFixedId=String(row.fixedTicketId||''); actions.append(button);
        item.append(main,actions); return item;
      }));
    }
    const birthdayHost=document.getElementById('integrationBirthday');
    if (birthdayHost) {
      if (!birthday.length) renderEmpty(birthdayHost,'尚未建立生日固定票券規則。');
      else birthdayHost.replaceChildren(...birthday.map((row) => {
        const item=document.createElement('article'); item.className='integration-list-item';
        const main=document.createElement('div');
        const title=document.createElement('strong'); title.textContent=String(row.title||'生日固定票券');
        const meta=document.createElement('p'); meta.textContent=`${tierSummary(row.allowedTierKeys)} · ${row.notifyLine?'LINE 通知':'不通知'} · 最後更新 ${formatDateTime(row.updatedAt)}`;
        main.append(title,meta); item.append(main,statusBadge(row.status)); return item;
      }));
    }
  }

  function renderNotifications() {
    let rows = Array.isArray(state.data?.notifications) ? state.data.notifications : [];
    if (state.notificationFilter === 'pending') rows = rows.filter((row) => ['pending','queued','processing'].includes(row.status));
    else if (state.notificationFilter !== 'all') rows = rows.filter((row) => row.status === state.notificationFilter);
    const host=document.getElementById('integrationNotifications');
    if(!host) return;
    if(!rows.length) return renderEmpty(host,'沒有符合篩選條件的通知。');
    const table=document.createElement('table'); table.className='integration-table';
    table.innerHTML='<thead><tr><th>會員</th><th>排程</th><th>狀態</th><th>嘗試</th><th>錯誤</th></tr></thead>';
    const body=document.createElement('tbody');
    rows.forEach((row)=>{
      const tr=document.createElement('tr');
      const error=String(row.lastError||'');
      tr.innerHTML=`<td><strong>${escapeHtml(row.memberDisplayName||'會員')}</strong><small>${escapeHtml(row.memberCode||'')}</small></td><td>${escapeHtml(formatDateTime(row.scheduledFor))}</td><td></td><td>${Number(row.attemptCount||0)}</td><td class="integration-error-cell">${escapeHtml(error||'—')}</td>`;
      tr.children[2].append(statusBadge(row.status)); body.append(tr);
    });
    table.append(body); host.replaceChildren(table);
  }

  function renderAudit() {
    let rows=Array.isArray(state.data?.auditTimeline)?state.data.auditTimeline:[];
    if(state.auditFilter!=='all') {
      if(state.auditFilter==='system') rows=rows.filter((row)=>!['member','booking','event_ticket','calendar'].includes(String(row.domain||'')));
      else rows=rows.filter((row)=>String(row.domain||'')===state.auditFilter);
    }
    const q=state.auditQuery.trim().toLowerCase();
    if(q) rows=rows.filter((row)=>`${row.action||''} ${row.targetLabel||''} ${row.domain||''}`.toLowerCase().includes(q));
    const host=document.getElementById('integrationAuditTimeline');
    if(!host) return;
    if(!rows.length) return renderEmpty(host,'沒有符合條件的 Audit 紀錄。');
    host.replaceChildren(...rows.map((row)=>{
      const item=document.createElement('article'); item.className='integration-audit-item';
      const dot=document.createElement('span'); dot.className=`integration-audit-dot is-${row.result==='success'?'success':row.result==='failed'?'failed':'neutral'}`;
      const main=document.createElement('div');
      const heading=document.createElement('div'); heading.className='integration-audit-heading';
      const title=document.createElement('strong'); title.textContent=auditActionLabel(row.action);
      const time=document.createElement('time'); time.textContent=formatDateTime(row.createdAt);
      heading.append(title,time);
      const meta=document.createElement('p'); meta.textContent=`${domainLabel(row.domain)} · ${row.targetLabel||'—'} · ${row.actorRole||'system'}`;
      main.append(heading,meta); item.append(dot,main,statusBadge(row.result)); return item;
    }));
  }

  function handleClick(event) {
    const refreshButton=event.target instanceof Element?event.target.closest('[data-integration-action="refresh"]'):null;
    if(refreshButton) return refresh();

    const viewButton=event.target instanceof Element?event.target.closest('[data-integration-view-tab]'):null;
    if(viewButton) return switchView(String(viewButton.dataset.integrationViewTab||'overview'));

    const targetButton=event.target instanceof Element?event.target.closest('[data-integration-target]'):null;
    if(targetButton) return navigate(String(targetButton.dataset.integrationTarget||''));

    const bookingButton=event.target instanceof Element?event.target.closest('[data-integration-booking-id]'):null;
    if(bookingButton) return navigateBooking(String(bookingButton.dataset.integrationBookingId||''));

    const fixedButton=event.target instanceof Element?event.target.closest('[data-integration-fixed-id]'):null;
    if(fixedButton) return navigateFixedTicket(String(fixedButton.dataset.integrationFixedId||''));
  }

  function handleChange(event) {
    if(event.target?.id==='integrationNotificationFilter') { state.notificationFilter=String(event.target.value||'all'); renderNotifications(); }
    if(event.target?.id==='integrationAuditFilter') { state.auditFilter=String(event.target.value||'all'); renderAudit(); }
  }

  function handleInput(event) {
    if(event.target?.id==='integrationAuditSearch') { state.auditQuery=String(event.target.value||''); renderAudit(); }
  }

  function switchView(view) {
    state.activeView=view;
    document.querySelectorAll('[data-integration-view]').forEach((section)=>section.classList.toggle('hidden',section.dataset.integrationView!==view));
    document.querySelectorAll('[data-integration-view-tab]').forEach((button)=>{
      const active=button.dataset.integrationViewTab===view;
      button.classList.toggle('active',active); button.setAttribute('aria-selected',active?'true':'false');
    });
  }

  function navigate(target) {
    deactivate();
    if(target==='member-grant') {
      click('membersTab'); window.setTimeout(()=>document.getElementById('memberSearch')?.focus(),0); return;
    }
    if(target==='events' || target==='fixed-new' || target==='birthday-fixed-new') {
      click('eventsTab');
      if(target!=='events') window.setTimeout(()=>{
        click('newEventTicketButton');
        const type=document.getElementById('eventTicketType');
        if(type) { type.value='fixed'; type.dispatchEvent(new Event('change',{bubbles:true})); }
        if(target==='birthday-fixed-new') {
          const schedule=document.getElementById('fixedTicketScheduleType');
          if(schedule) { schedule.value='birthday_month'; schedule.dispatchEvent(new Event('change',{bubbles:true})); }
        }
      },120);
      return;
    }
    if(target==='calendar-batch') {
      click('calendarTab'); window.setTimeout(()=>document.querySelector('.calendar-batch-editor')?.scrollIntoView({behavior:'smooth',block:'start'}),80); return;
    }
    if(target==='booking-services' || target==='booking-queue') {
      click('bookingTab');
      window.setTimeout(()=>click(target==='booking-services'?'bookingAdminServicesSubtab':'bookingAdminQueueSubtab'),100);
    }
  }

  function navigateBooking(bookingId) {
    deactivate(); click('bookingTab');
    window.setTimeout(()=>{
      click('bookingAdminQueueSubtab');
      window.dispatchEvent(new CustomEvent('member-admin:booking-focus',{detail:{bookingId}}));
    },120);
  }

  function navigateFixedTicket(fixedTicketId) {
    deactivate(); click('eventsTab');
    window.setTimeout(()=>{
      const target=document.querySelector(`[data-fixed-ticket-id="${cssEscape(fixedTicketId)}"]`);
      if(target instanceof HTMLElement) target.click();
    },160);
  }

  function click(id) { const el=document.getElementById(id); if(el instanceof HTMLElement) el.click(); }

  function fixedScheduleLabel(row) {
    const type=String(row.scheduleType||'');
    if(type==='birthday_month') return '生日當月 1 號';
    if(type==='yearly') return `每年 ${Number(row.scheduleMonth||1)}/${Number(row.scheduleDay||1)}`;
    if(type==='monthly') return `每月 ${Number(row.scheduleDay||1)} 日`;
    if(type==='weekly') return `每週 ${['','一','二','三','四','五','六','日'][Number(row.scheduleWeekday||1)]}`;
    return '未設定週期';
  }

  function tierSummary(keys) {
    const rows=Array.isArray(keys)?keys:[];
    if(rows.length===4) return '全部會員';
    if(!rows.length) return '未設定會員範圍';
    return rows.map((key)=>TIER_LABELS[key]||key).join('、');
  }

  function statusBadge(status) {
    const value=String(status||'');
    const span=document.createElement('span');
    span.className=`integration-status is-${value.replace(/[^a-z0-9_-]/gi,'')||'neutral'}`;
    span.textContent=STATUS_LABELS[value]||value||'—';
    return span;
  }

  function auditActionLabel(action) {
    const map={
      ADMIN_MEMBER_UPDATE:'會員資料更新',
      GRANT_MESSAGE_PRESET_SAVE:'發放訊息設定',
      BOOKING_COMPLETED:'預約完成結算',
      BOOKING_SERVICE_TYPE_CREATED:'新增預約類型',
      BOOKING_SERVICE_TYPE_UPDATED:'修改預約類型',
      BOOKING_SERVICE_TYPE_DELETED:'刪除預約類型',
      'line.push.grant.scheduled':'排程 LINE 發送',
    };
    return map[action]||String(action||'系統操作').replaceAll('_',' ').replaceAll('.',' · ');
  }

  function domainLabel(domain) {
    const map={member:'會員',booking:'預約',event_ticket:'活動票券',calendar:'日曆',point_card:'集點卡',grant_message_preset:'發放訊息'};
    return map[domain]||String(domain||'系統');
  }

  function formatDateRange(start,end) {
    const s=String(start||''); const e=String(end||'');
    if(!s&&!e) return '不限日期';
    if(s&&e&&s!==e) return `${s} ～ ${e}`;
    return s||e;
  }

  function formatDateTime(value) {
    if(!value) return '—';
    const date=new Date(String(value));
    if(Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('zh-Hant-TW',{timeZone:'Asia/Taipei',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(date);
  }

  function renderEmpty(host,message) {
    const p=document.createElement('p'); p.className='integration-empty'; p.textContent=String(message||'目前沒有資料。'); host.replaceChildren(p);
  }

  function setMessage(message) {
    const el=document.getElementById('integrationHubMessage');
    if(!el) return;
    el.textContent=String(message||''); el.classList.toggle('hidden',!message);
  }

  function escapeHtml(value) {
    return String(value??'').replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  }

  function cssEscape(value) {
    if(window.CSS&&typeof window.CSS.escape==='function') return window.CSS.escape(String(value||''));
    return String(value||'').replace(/["\\]/g,'\\$&');
  }
})();
