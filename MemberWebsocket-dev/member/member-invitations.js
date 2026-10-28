(() => {
  'use strict';
  let contextKey = '', generation = 0, current = null, issued = null, busy = false;
  let incoming = null, claimPromise = null;
  const el = id => document.getElementById(id);
  const session = () => window.MemberSystem?.getSession?.('member');
  const shop = config => String(config?.business || window.BusinessContext?.slug || new URL(location.href).searchParams.get('business') || '');
  const key = (config, profile) => [shop(config), profile?.lineUserId || '', profile?.memberCode || ''].join(':');
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  function status(text, error = false) {
    const node = el('memberInvitationStatus');
    if (node) { node.textContent = text; node.dataset.state = error ? 'error' : 'info'; }
  }
  function captureIncoming() {
    const url = new URL(location.href);
    let token = url.searchParams.get('invitation'), business = url.searchParams.get('business') || '';
    if (!token && url.searchParams.get('liff.state')) {
      try {
        const nested = new URL(url.searchParams.get('liff.state'), location.origin);
        token = nested.searchParams.get('invitation');
        business = nested.searchParams.get('business') || business;
      } catch { /* Invalid state cannot claim an invitation. */ }
    }
    if (token) incoming = /^[a-f0-9]{64}$/.test(token) ? { token, business } : { token: '', business, invalid: true };
  }
  captureIncoming();
  function removeIncomingUrl() {
    const url = new URL(location.href);
    url.searchParams.delete('invitation');
    const state = url.searchParams.get('liff.state');
    if (state) {
      try {
        const nested = new URL(state, location.origin);
        nested.searchParams.delete('invitation');
        url.searchParams.set('liff.state', nested.pathname + nested.search + nested.hash);
      } catch { url.searchParams.delete('liff.state'); }
    }
    history.replaceState(history.state, '', url.href);
  }
  async function claimPending({ config, idToken, profile }) {
    if (!config?.memberInvitationsEnabled || !incoming) return;
    if (incoming.business !== shop(config)) { incoming = null; removeIncomingUrl(); return; }
    if (profile?.profileComplete && !profile.membershipRequired) { incoming = null; removeIncomingUrl(); return; }
    if (!idToken || !profile?.lineUserId) return;
    if (incoming.invalid) { incoming = null; removeIncomingUrl(); return { claimed: false, reason: 'INVITATION_TOKEN_INVALID' }; }
    if (claimPromise) return claimPromise;
    const candidate = incoming;
    removeIncomingUrl();
    claimPromise = window.MemberSystem.request(config, 'member', idToken, 'user.member.invitation.claim', { invitationToken: candidate.token })
      .then(result => { if (incoming === candidate) incoming = null; return result; })
      .catch(error => {
        const terminal = ['INVITATION_TOKEN_INVALID','INVITATION_TOKEN_EXPIRED','INVITATION_SELF_NOT_ALLOWED','INVITATION_ACTIVE_MEMBER','INVITATION_ALREADY_CLAIMED','INVITATION_SOURCE_UNAVAILABLE','INVITATION_TENANT_UNAVAILABLE'];
        if (!terminal.includes(error?.code)) throw error;
        if (incoming === candidate) incoming = null;
        return { claimed: false, reason: error.code };
      })
      .finally(() => { claimPromise = null; });
    return claimPromise;
  }
  function summary(data) {
    const node = el('memberInvitationSummary');
    if (node) node.textContent = `成功加入 ${count(data?.joinedCount)} 人 · 已獲獎勵 ${count(data?.rewardedCount)} 份 · 待處理 ${count(data?.pendingCount)} 份`;
    const list = el('memberInvitationRewards');
    if (!list) return;
    list.replaceChildren();
    for (const reward of Array.isArray(data?.rewards) ? data.rewards : []) {
      const line = document.createElement('p');
      line.textContent = String(reward.title || '邀請獎勵') + (reward.expiresOn ? ` · 有效至 ${reward.expiresOn}` : '');
      list.append(line);
    }
  }
  async function loadSummary(retry = false) {
    const active = session(), epoch = generation;
    if (!active || !current || key(active.config, current) !== contextKey) return;
    try {
      const result = await window.MemberSystem.request(active.config, 'member', active.idToken, retry ? 'member.invitation.retry' : 'member.invitation.summary', {});
      if (epoch !== generation) return;
      summary(result);
      if (retry) status('已重新確認獎勵狀態，請查看成果。');
    } catch (error) { if (epoch === generation) status(error?.message || '成果暫時無法讀取，請稍後重試。', true); }
  }
  async function ensureIssued(active, epoch) {
    if (issued && Date.parse(issued.expiresAt) > Date.now()) return issued;
    const result = await window.MemberSystem.request(active.config, 'member', active.idToken, 'member.invitation.create', {});
    if (epoch !== generation || key(active.config, current) !== contextKey) return null;
    const url = new URL(result?.invitationUrl || '');
    if (url.protocol !== 'https:' || (url.hostname !== 'liff.line.me' && url.origin !== location.origin)
      || url.username || url.password || url.searchParams.get('business') !== shop(active.config)
      || !/^[a-f0-9]{64}$/.test(url.searchParams.get('invitation') || '') || !(Date.parse(result.expiresAt) > Date.now())) {
      throw new Error('邀請連結暫時無法使用，請重新整理後重試。');
    }
    issued = result;
    el('memberInvitationManualLink').value = url.href;
    el('memberInvitationCampaign').textContent = result.campaign?.title
      ? `${result.campaign.title}；優惠依新會員完成加入時的有效活動與額度為準。`
      : '分享邀請新會員；獎勵依完成加入時的有效活動與額度為準。';
    return issued;
  }
  async function copyUrl(url, epoch) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('unavailable');
      await navigator.clipboard.writeText(url);
      if (epoch === generation) status('新會員邀請連結已複製。');
    } catch {
      if (epoch !== generation) return;
      const field = el('memberInvitationManualLink');
      field.focus(); field.select();
      let copied = false;
      try { copied = document.execCommand?.('copy') === true; } catch { /* Keep the selectable link available. */ }
      status(copied ? '新會員邀請連結已複製。' : '請長按下方邀請連結複製，或改用系統分享。', !copied);
    }
  }
  async function invite(share) {
    const active = session(), epoch = generation;
    if (busy || !current || !active || key(active.config, current) !== contextKey) return;
    busy = true;
    for (const id of ['shareMemberInvitation', 'copyMemberInvitation']) el(id).disabled = true;
    status('正在準備專屬邀請連結…');
    try {
      const data = await ensureIssued(active, epoch);
      if (!data || epoch !== generation) return;
      const url = data.invitationUrl;
      if (!share) return await copyUrl(url, epoch);
      const liff = window.liff;
      if (typeof liff?.shareTargetPicker === 'function' && liff.isApiAvailable?.('shareTargetPicker')) {
        const title = String(active.config.brandName || '會員邀請');
        const result = await liff.shareTargetPicker([{ type: 'flex', altText: `${title}：邀請你加入會員`, contents: {
          type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [
            { type: 'text', text: title, weight: 'bold', wrap: true },
            { type: 'text', text: '邀請你加入會員，查看商家服務與優惠。', wrap: true },
            { type: 'button', action: { type: 'uri', label: '加入會員', uri: url } },
          ] },
        } }], { isMultiple: true });
        if (epoch === generation) status(result?.status === 'success' ? '分享操作已完成，加入與獎勵請查看成果。' : '已取消分享，可改用複製連結。');
      } else if (typeof navigator.share === 'function') {
        await navigator.share({ title: String(active.config.brandName || '會員邀請'), text: '邀請你加入會員', url });
        if (epoch === generation) status('系統分享操作已完成，加入與獎勵請查看成果。');
      } else await copyUrl(url, epoch);
    } catch (error) {
      if (epoch === generation) status(error?.name === 'AbortError' ? '已取消分享，可改用複製連結。' : (error?.message || '分享暫時無法使用，請改用複製連結。'), error?.name !== 'AbortError');
    } finally {
      if (epoch === generation) {
        busy = false;
        for (const id of ['shareMemberInvitation', 'copyMemberInvitation']) if (el(id)) el(id).disabled = false;
      }
    }
  }
  function install() {
    const modal = window.MemberReferral?.ensureUi();
    if (!modal || el('memberInvitationPanel')) return;
    const panel = document.createElement('section'); panel.id = 'memberInvitationPanel'; panel.className = 'member-referral-section';
    const heading = document.createElement('h3'); heading.textContent = '邀請 LINE 好友加入會員';
    const campaign = document.createElement('p'); campaign.id = 'memberInvitationCampaign'; campaign.textContent = '邀請新會員加入本商家，優惠依完成加入時的有效活動與額度為準。';
    const actions = document.createElement('div'); actions.className = 'friend-actions';
    for (const [id, label, handler] of [
      ['shareMemberInvitation', '選擇 LINE 好友', () => void invite(true)],
      ['copyMemberInvitation', '複製邀請連結', () => void invite(false)],
      ['refreshMemberInvitations', '更新成果', () => void loadSummary()],
      ['retryMemberInvitationRewards', '重查待處理獎勵', () => void loadSummary(true)],
    ]) { const button = document.createElement('button'); button.id = id; button.type = 'button'; button.className = 'button button-refresh'; button.textContent = label; button.addEventListener('click', handler); actions.append(button); }
    const feedback = document.createElement('p'); feedback.id = 'memberInvitationStatus'; feedback.className = 'friend-feedback'; feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
    const label = document.createElement('label'); label.htmlFor = 'memberInvitationManualLink'; label.textContent = '新會員邀請連結';
    const link = document.createElement('input'); link.id = 'memberInvitationManualLink'; link.type = 'text'; link.readOnly = true; link.autocomplete = 'off';
    const results = document.createElement('p'); results.id = 'memberInvitationSummary'; results.setAttribute('aria-live', 'polite'); results.textContent = '開啟後讀取實際加入與獎勵成果。';
    const rewards = document.createElement('div'); rewards.id = 'memberInvitationRewards';
    panel.append(heading, campaign, actions, feedback, label, link, results, rewards);
    const description = el('memberReferralDescription'); description?.after(panel);
    if (description) description.textContent = '分享專屬邀請連結；新會員完成加入後，才依商家活動計算邀請獎勵。';
    const oldForm = el('memberReferralRewardTabPanel') || el('memberReferralForm');
    if (oldForm && !el('legacyMemberReferral')) {
      const details = document.createElement('details'); details.id = 'legacyMemberReferral';
      const title = document.createElement('summary'); title.textContent = '會員編號邀請優惠（既有方式）';
      oldForm.before(details); details.append(title, oldForm);
    }
    el('openMemberReferral')?.addEventListener('click', () => void loadSummary());
  }
  window.addEventListener('member-profile-ready', event => {
    const active = session(), profile = event.detail?.profile;
    const nextKey = key(active?.config, profile);
    if (nextKey !== contextKey || !profile || profile.membershipRequired || profile.profileComplete === false || (profile.status && profile.status !== 'active')) {
      generation++; issued = null; busy = false; contextKey = nextKey; current = null;
      if (el('memberInvitationManualLink')) el('memberInvitationManualLink').value = '';
      status(''); summary({});
      for (const id of ['shareMemberInvitation', 'copyMemberInvitation']) if (el(id)) el(id).disabled = true;
    }
    if (!active?.config?.memberInvitationsEnabled || !profile?.lineUserId || profile.membershipRequired || profile.profileComplete === false || (profile.status && profile.status !== 'active')) return;
    if (incoming) { incoming = null; removeIncomingUrl(); }
    current = profile; install();
    for (const id of ['shareMemberInvitation', 'copyMemberInvitation']) el(id).disabled = false;
  });
  window.addEventListener('pagehide', () => { generation++; issued = null; current = null; incoming = null; });
  window.MemberInvitations = { claimPending };
})();
