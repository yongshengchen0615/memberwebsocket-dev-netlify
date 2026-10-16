(() => {
  'use strict';
  let pending = false, cursor = null, filters = null, generation = 0;
  const $ = id => document.getElementById(id);
  const node = (tag, text, cls = '') => { const n = document.createElement(tag); n.textContent = text; n.className = cls; return n; };
  const ACTIONS = {
    ADMIN_MEMBER_UPDATE:'管理員修改會員資料',MEMBER_CARD_OPEN:'開啟會員卡',MEMBER_PROFILE_UPDATED:'修改會員資料','user.member.profile.save':'修改會員資料',
    'admin.member.update':'管理員修改會員資料','user.pointcard.transfer':'點數轉贈',
    BOOKING_CREATED:'送出預約',BOOKING_UPDATED:'修改預約',BOOKING_CONFIRMED:'確認預約',BOOKING_COMPLETED:'完成服務',
    BOOKING_CANCELLED:'取消預約',BOOKING_REJECTED:'預約未通過',BOOKING_NO_SHOW:'標記無故未到',
    BOOKING_BENEFITS_UPDATED:'修改預約選用票券',BOOKING_BENEFITS_UPDATE_FAILED:'預約選票失敗',
    SNAPSHOT_POINT_TICKET_CANCELLED:'取消快照集點卡預選票券',SNAPSHOT_EVENT_TICKET_CANCELLED:'取消快照活動預選票券',
    SNAPSHOT_REVIEWED:'快照審核',SNAPSHOT_REGISTERED:'快照登記',
    'user.pointcard.ticket.redeem':'核銷集點卡票券','user.pointcard.tickets.redeem':'核銷集點卡票券',
    'user.event.ticket.redeem':'核銷活動票券','user.event.tickets.redeem':'核銷活動票券','user.event.ticket.claim':'領取活動票券',
    LOGIN_SESSION_CREATED:'建立登入連線',LOGIN_SESSION_TAKEOVER:'登入裝置接管',AUDIT_QUERY_VIEWED:'查詢使用紀錄',
  };
  const ROLES={member:'會員',admin:'管理員',system:'系統'};
  const TYPES={member:'會員',admin:'管理員',booking:'預約',point_transfer:'轉點交易',point_ticket:'集點卡票券',ticket:'票券',event_ticket:'活動票券',event_claim:'活動票券',event_ticket_claim:'活動票券',audit_query:'稽核查詢',booking_receipt:'快照收據'};
  const FIELDS={birthday:'生日',phone:'電話',surname:'姓氏',salutation:'稱謂',display_name:'顯示名稱',status:'帳號狀態',membership_status:'會員資格'};
  const STATES={pending:'待確認',confirmed:'已確認',completed:'服務已完成',rejected:'未通過',cancelled:'已取消',no_show:'無故未到'};
  function safe(value) { return ['string','number','boolean'].includes(typeof value) ? String(value).slice(0,300) : '—'; }
  function time(value) {
    const date=new Date(value); return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',dateStyle:'short',timeStyle:'medium'}).format(date) : '—';
  }
  function renderItem(item) {
    const row=node('article','','operation-audit-row');
    const action=ACTIONS[item.action] || (/^LOGIN_/.test(item.action || '') ? '登入連線異動' : /^MEMBERSHIP_/.test(item.action || '') ? '會員資格異動' : /^admin\./.test(item.action || '') ? '管理設定異動' : '其他操作');
    const result={success:'成功',failed:'失敗'}[item.result] || '結果未提供';
    row.append(node('strong',`${action} · ${result}`),node('p',`${time(item.createdAt)} · ${ROLES[item.actorRole] || '其他操作人'} ${safe(item.actorLabel || item.actor)}`),node('small',`${TYPES[item.targetType] || '關聯資源'} · ${safe(item.target)}`));
    const detail=node('details',''), summary=node('summary','查看詳情'), list=node('dl','','operation-audit-detail');
    const d=item.detail && typeof item.detail==='object' && !Array.isArray(item.detail) ? item.detail : {};
    const add=(label,value)=>{if(value===null || value===undefined || value==='') return; const pair=node('div','');pair.append(node('dt',label),node('dd',safe(value)));list.append(pair);};
    if(Array.isArray(d.profileFields)) {const fields=d.profileFields.map(k=>FIELDS[k]).filter(Boolean);if(fields.length)add('修改欄位',fields.join('、'));}
    add('票券名稱',d.ticketTitle);add('集點卡',d.cardTitle);add('轉出會員',d.sender);add('轉入會員',d.receiver);
    if(typeof d.amount==='number')add('轉贈點數',`${d.amount} 點`);
    if(d.previousStatus)add('原狀態',STATES[d.previousStatus] || '其他狀態');if(d.nextStatus)add('新狀態',STATES[d.nextStatus] || '其他狀態');
    if(typeof d.selectedCount==='number')add(item.action==='AUDIT_QUERY_VIEWED' ? '查詢筆數' : '預選數量',`${d.selectedCount} ${item.action==='AUDIT_QUERY_VIEWED' ? '筆' : '張'}`);
    if(typeof d.ticketCount==='number')add('票券數量',`${d.ticketCount} 張`);
    if(typeof d.serviceMinutes==='number')add('服務時間',`${d.serviceMinutes} 分鐘`);
    add('操作識別',d.requestId);add('錯誤代碼',d.errorCode);add('來源',ROLES[d.clientType] || (d.clientType ? '會員端' : ''));
    if(!list.children.length)add('補充資料','未提供可顯示的明細');
    detail.append(summary,list);row.append(detail);return row;
  }
  function date(offset) { return new Date(Date.now() + (8 * 60 * 60 * 1000) + offset * 86400000).toISOString().slice(0, 10); }
  function init() {
    const nav = document.querySelector('.surface-nav'), view = $('adminView'); if (!nav || !view) return;
    const tab = node('button', '使用紀錄', 'surface-tab'); tab.id = 'operationAuditTab'; tab.type = 'button';
    tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', 'operationAuditPanel'); tab.setAttribute('aria-selected', 'false');
    nav.append(tab);
    const panel = node('section', '', 'panel hidden operation-audit-panel'); panel.id = 'operationAuditPanel';
    panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id);
    panel.innerHTML = '<h2>使用紀錄／操作稽核</h2><p>查詢重要會員及系統操作。識別資訊已遮罩，詳情只提供必要欄位；每次查詢也會留下稽核紀錄。</p><form id="operationAuditForm" class="operation-audit-filters"><label>開始日期<input id="auditFrom" type="date" required></label><label>結束日期<input id="auditTo" type="date" required></label><label>會員編號<input id="auditMemberCode" type="text" maxlength="40" placeholder="全部會員" autocomplete="off"></label><label>事件<input id="auditAction" type="text" maxlength="80" placeholder="全部事件／完整事件名稱" list="auditActionOptions" autocomplete="off"></label><label>結果<select id="auditResult"><option value="">全部</option><option value="success">成功</option><option value="failed">失敗</option></select></label><button id="auditSearch" class="button button-dark" type="submit">查詢</button></form><p id="operationAuditStatus" role="status" aria-live="polite"></p><div id="operationAuditList"></div><button id="auditNext" class="button button-outline" type="button" hidden>下一頁</button>';
    const options=node('datalist',''); options.id='auditActionOptions'; Object.entries(ACTIONS).forEach(([value,label])=>{const o=node('option',label);o.value=value;options.append(o);});panel.append(options);
    view.append(panel); $('auditFrom').value = date(-6); $('auditTo').value = date(0);
    tab.addEventListener('click', () => {
      nav.querySelectorAll('[role=tab]').forEach(n => n.setAttribute('aria-selected', String(n===tab)));
      [...view.children].filter(n => n.classList.contains('panel')).forEach(n => n.classList.toggle('hidden', n!==panel));
      if (!filters) void query(false);
    });
    nav.addEventListener('click', e => {
      const other = e.target.closest('.surface-tab');
      if (other && other.id !== tab.id) { panel.classList.add('hidden'); tab.setAttribute('aria-selected','false'); }
    });
    $('operationAuditForm').addEventListener('submit', e => { e.preventDefault(); void query(false); });
    $('auditNext').addEventListener('click', () => void query(true));
  }
  async function query(next) {
    if (pending) return;
    const session = window.MemberSystem.getSession('admin');
    if (!session) { $('operationAuditStatus').textContent = '登入狀態已失效，請重新登入。'; return; }
    const from = $('auditFrom').value, to = $('auditTo').value;
    if (!from || !to || from>to) { $('operationAuditStatus').textContent = '請選擇有效的日期範圍。'; return; }
    const upper = new Date(`${to}T00:00:00+08:00`); upper.setUTCDate(upper.getUTCDate()+1);
    if (!next) { cursor = null; filters = {from:`${from}T00:00:00+08:00`,to:upper.toISOString(),memberCode:$('auditMemberCode').value.trim().toUpperCase(),eventAction:$('auditAction').value.trim(),result:$('auditResult').value}; }
    const current = ++generation; pending = true;
    $('operationAuditPanel').setAttribute('aria-busy', 'true'); $('auditSearch').disabled = true; $('auditNext').disabled = true;
    $('operationAuditStatus').textContent = '正在查詢紀錄…';
    try {
      const result = await window.MemberSystem.request(session.config, 'admin', session.idToken, 'admin.audit.query', {
        ...filters,cursor,requestId:'AUDQ-'+crypto.randomUUID(),
      });
      if (current!==generation) return;
      const list = $('operationAuditList'); list.replaceChildren();
      const items = Array.isArray(result.items) ? result.items : [];
      for (const item of items) {
        list.append(renderItem(item));
      }
      cursor = items.length ? {createdAt:items.at(-1).createdAt,id:items.at(-1).id} : null;
      $('auditNext').hidden = !result.hasMore;
      $('operationAuditStatus').textContent = items.length ? `本頁 ${items.length} 筆；依台北時間由新到舊排列。` : '此條件下沒有紀錄。';
    } catch (e) {
      $('operationAuditList').replaceChildren(); $('auditNext').hidden = true;
      $('operationAuditStatus').textContent = e.message || '查詢失敗，請重試。';
    } finally { pending = false; $('operationAuditPanel').setAttribute('aria-busy','false'); $('auditSearch').disabled=false; $('auditNext').disabled=false; }
  }
  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded',init,{once:true}); else init();
})();
