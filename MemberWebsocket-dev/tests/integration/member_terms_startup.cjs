const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'member/index.html'), 'utf8');
const memberPhone = fs.readFileSync(path.join(root, 'member/member-phone.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'member/app.js'), 'utf8');
const profileExtension = fs.readFileSync(path.join(root, 'member/profile-extension.js'), 'utf8');
const terms = { id: 'terms-2', version: '2026-10-v2', title: '新版條款', summary: '請閱讀', body: '完整條款內容' };
const profile = { profileComplete: true, membershipRequired: false, joinedAt: '2026-01-01' };

// The 10/28 client OA/recommendation UI is intentionally rolled back to 10/27.
// Server-side friendship authorization remains covered by member_oa*.test.js.
test('RB-001: October 27 signup renders its original form without calling the newer OA endpoint',async()=>{
 const pending={lineUserId:'new-member',profileComplete:false,membershipRequired:true};
 const {dom,w,calls}=await start(false,{config:{memberFriendshipFlowEnabled:true},profile:pending,
  bootstrapResult:()=>({profile:pending,terms,memberOa:{required:true,configured:true,addFriendUrl:'https://line.me/R/ti/p/%40safe-oa'}}),
  oaCheck:()=>{throw new Error('The rolled-back client must not call the newer OA check');}
 });
 try {
  assert.equal(w.document.getElementById('profileForm').hidden,false);
  assert.equal(w.document.getElementById('memberOaJoin'),null);
  assert.equal(calls.filter(c=>c.action==='user.member.oa.check').length,0);
  assert.equal(calls.filter(c=>c.action==='user.member.profile.save').length,0);
  assert.match(w.document.getElementById('joinTermsBody').textContent,/完整條款/);
 }finally{dom.window.close();}
});

test('RB-002: rolled-back member page does not mount native OA or new invitation controls',async()=>{
 let requested=0;
 const pending={profileComplete:false,membershipRequired:true};
 const {dom,w}=await start(false,{config:{memberFriendshipFlowEnabled:true,memberInvitationsEnabled:true},profile:pending,
  liff:{isInClient:()=>true,getContext:()=>({viewType:'full'}),requestFriendship:async()=>requested++},
  bootstrapResult:()=>({profile:pending,terms,memberOa:{required:true,configured:false}})
 });
 try {
  assert.equal(w.document.getElementById('memberOaJoin'),null);
  assert.equal(requested,0);
  assert.equal(w.document.querySelector('script[src*="member-invitations.js"]'),null);
  assert.equal(w.document.getElementById('profileForm').hidden,false);
 }finally{dom.window.close();}
});

async function start(consentRequired, options = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.test/member/' });
  const currentProfile = options.profile || profile;
  const w = dom.window;
  await new Promise((resolve) => w.addEventListener('load', resolve, { once: true }));
  const calls = [];
  w.MemberSystem = {
    bindDialogKeyboard() {},
    loadConfig: async () => ({ brandName: 'Lumen Club', ...options.config }),
    signIn: options.signIn || (async () => 'fixture-token'),
    initials: () => '會',
    formatDate: (value) => value || '',
    subscribeRealtime: () => () => {},
    request: async (_config, _surface, _token, action, payload) => {
      calls.push({ action, payload });
      if (action === 'user.member.bootstrap') {
        const bootstrapCount = calls.filter((call) => call.action === 'user.member.bootstrap').length;
        if (typeof options.bootstrapResult === 'function') return options.bootstrapResult(bootstrapCount);
        return { profile: currentProfile, terms, consentRequired };
      }
      if (action === 'user.member.terms.accept') {
        if (typeof options.termsAcceptResult === 'function') return options.termsAcceptResult(payload);
        return { profile: currentProfile, terms };
      }
      if (action === 'user.member.profile.save') {
        if (typeof options.profileSaveResult === 'function') return options.profileSaveResult(payload);
        return { profile: { ...currentProfile, profileComplete: true, membershipRequired: false } };
      }
      if (action === 'user.member.oa.check' && options.oaCheck) return options.oaCheck();
      throw new Error(`Unexpected action: ${action}`);
    },
  };
  w.MembershipProgress = { render() {} };
  if (options.liff) w.liff = options.liff;
  w.eval(memberPhone);
  if (options.loadProfileExtension) w.eval(profileExtension);
  w.eval(app);
  w.dispatchEvent(new w.Event('DOMContentLoaded'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { dom, w, calls };
}

for (const first of ['LINE 簡介', '會員資料']) {
  test(`AC-001: member startup overlaps both reads and waits for both, with ${first} arriving first`, async () => {
    const lineProfile = Promise.withResolvers();
    const membership = Promise.withResolvers();
    const resolveLineProfile = () => lineProfile.resolve({ displayName: 'LINE 測試會員' });
    const resolveMembership = () => membership.resolve({ profile, terms });
    let lineRequests = 0;
    const { dom, w, calls } = await start(false, {
      liff: { getProfile: () => { lineRequests++; return lineProfile.promise; } },
      bootstrapResult: () => membership.promise,
    });
    const get = (id) => w.document.getElementById(id);
    try {
      assert.equal(lineRequests, 1);
      assert.equal(calls.filter((call) => call.action === 'user.member.bootstrap').length, 1);
      assert.equal(get('loadingView').classList.contains('hidden'), false);
      assert.equal(get('memberView').classList.contains('hidden'), true);

      if (first === 'LINE 簡介') resolveLineProfile();
      else resolveMembership();
      await new Promise(setImmediate);
      assert.equal(get('memberView').classList.contains('hidden'), true);

      resolveLineProfile();
      resolveMembership();
      await new Promise(setImmediate);
      assert.equal(get('memberView').classList.contains('hidden'), false);
      assert.equal(get('memberName').textContent, 'LINE 測試會員');
      assert.equal(calls.filter((call) => call.action === 'user.member.card.open').length, 1);
    } finally { dom.window.close(); }
  });
}

test('AC-002: failed LINE profile read uses the decoded token name and opens the member card', async () => {
  const { dom, w, calls } = await start(false, { liff: {
    getDecodedIDToken: () => ({ name: 'LINE 備援名稱' }),
    getProfile: async () => { throw new Error('LINE profile unavailable'); },
  } });
  try {
    assert.equal(w.document.getElementById('memberView').classList.contains('hidden'), false);
    assert.equal(w.document.getElementById('memberName').textContent, 'LINE 備援名稱');
    assert.equal(calls.filter((call) => call.action === 'user.member.bootstrap').length, 1);
  } finally { dom.window.close(); }
});

test('AC-003: failed sign-in cannot start either member startup read', async () => {
  let lineRequests = 0;
  const { dom, w, calls } = await start(false, {
    signIn: async () => { throw new Error('登入遭拒'); },
    liff: { getProfile: async () => { lineRequests++; } },
  });
  try {
    assert.equal(w.document.getElementById('errorMessage').textContent, '登入遭拒');
    assert.equal(w.document.getElementById('memberView').classList.contains('hidden'), true);
    assert.equal(lineRequests, 0);
    assert.deepEqual(calls, []);
  } finally { dom.window.close(); }
});

test('AC-003: member authorization denial remains hidden even if the LINE profile later succeeds', async () => {
  const lineProfile = Promise.withResolvers();
  const { dom, w, calls } = await start(false, {
    liff: { getProfile: () => lineProfile.promise },
    bootstrapResult: () => { throw new Error('會員資料存取遭拒'); },
  });
  const get = (id) => w.document.getElementById(id);
  try {
    assert.equal(get('errorMessage').textContent, '會員資料存取遭拒');
    assert.equal(get('memberView').classList.contains('hidden'), true);
    lineProfile.resolve({ displayName: '不得顯示的 LINE 名稱' });
    await new Promise(setImmediate);
    assert.equal(get('memberView').classList.contains('hidden'), true);
    assert.equal(get('errorView').classList.contains('hidden'), false);
    assert.deepEqual(calls.map((call) => call.action), ['user.member.bootstrap']);
  } finally { dom.window.close(); }
});

test('member page initializes and shows the latest terms to members who must reconsent', async () => {
  const { dom, w, calls } = await start(true);
  try {
    const get = (id) => w.document.getElementById(id);
    assert.equal(get('termsRenewView').classList.contains('hidden'), false);
    assert.equal(get('memberView').classList.contains('hidden'), true);
    assert.equal(calls.filter(call=>call.action==='user.member.card.open').length,0);
    assert.match(get('renewTermsSummary').textContent, /2026-10-v2/);
    assert.equal(get('renewTermsBody').textContent, '完整條款內容');

    get('renewTermsForm').dispatchEvent(new w.Event('submit', { cancelable: true }));
    assert.match(get('renewTermsMessage').textContent, /請閱讀並同意/);
    assert.equal(calls.filter((call) => call.action === 'user.member.terms.accept').length, 0);

    get('renewTermsAccepted').checked = true;
    get('renewTermsForm').dispatchEvent(new w.Event('submit', { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(JSON.parse(JSON.stringify(calls.find(call=>call.action==='user.member.terms.accept'))), {
      action: 'user.member.terms.accept',
      payload: { termsId: 'terms-2', termsVersion: '2026-10-v2', accepted: true },
    });
    assert.equal(get('memberView').classList.contains('hidden'), false);
    assert.equal(calls.filter(call=>call.action==='user.member.card.open').length,1);
  } finally { dom.window.close(); }
});

test('reconsent preflight refreshes changed terms without silently accepting them', async () => {
  const latestTerms = {
    id: 'terms-3',
    version: '2026-11-v3',
    title: '最新條款',
    summary: '條款再次更新',
    body: '最新完整條款內容',
  };
  const { dom, w, calls } = await start(true, {
    bootstrapResult: (count) => count === 1
      ? { profile, terms, consentRequired: true }
      : { profile, terms: latestTerms, consentRequired: true },
    termsAcceptResult: () => ({ profile, terms: latestTerms, consentRequired: false }),
  });
  try {
    const get = (id) => w.document.getElementById(id);
    get('renewTermsAccepted').checked = true;
    get('renewTermsForm').dispatchEvent(new w.Event('submit', { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(calls.filter((call) => call.action === 'user.member.terms.accept').length, 0);
    assert.match(get('renewTermsSummary').textContent, /2026-11-v3/);
    assert.equal(get('renewTermsAccepted').checked, false);
    assert.match(get('renewTermsMessage').textContent, /已載入最新版本/);

    get('renewTermsAccepted').checked = true;
    get('renewTermsForm').dispatchEvent(new w.Event('submit', { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const accepts = calls.filter((call) => call.action === 'user.member.terms.accept');
    assert.equal(accepts.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(accepts[0].payload)), {
      termsId: 'terms-3',
      termsVersion: '2026-11-v3',
      accepted: true,
    });
    assert.equal(get('memberView').classList.contains('hidden'), false);
  } finally { dom.window.close(); }
});

test('pending member verifies the latest terms when checking consent before registration', async () => {
  const pendingProfile = { profileComplete: false, membershipRequired: true, joinedAt: '' };
  const latestTerms = {
    id: 'terms-3',
    version: '2026-11-v3',
    title: '最新條款',
    summary: '最新摘要',
    body: '最新完整條款',
  };
  const { dom, w, calls } = await start(true, {
    profile: pendingProfile,
    bootstrapResult: (count) => count === 1
      ? { profile: pendingProfile, terms, consentRequired: true }
      : { profile: pendingProfile, terms: latestTerms, consentRequired: true },
  });
  try {
    const get = (id) => w.document.getElementById(id);
    get('joinTermsAccepted').checked = true;
    get('joinTermsAccepted').dispatchEvent(new w.Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.match(get('joinTermsSummary').textContent, /2026-11-v3/);
    assert.equal(get('joinTermsAccepted').checked, false);
    assert.match(get('profileFormMessage').textContent, /重新閱讀後再次勾選/);
    assert.equal(calls.filter((call) => call.action === 'user.member.profile.save').length, 0);
  } finally { dom.window.close(); }
});

test('pending member submits terms through canonical app flow even with profile extension loaded', async () => {
  const pendingProfile = { profileComplete: false, membershipRequired: true, joinedAt: '' };
  const joinedProfile = { profileComplete: true, membershipRequired: false, joinedAt: '2026-09-29' };
  const { dom, w, calls } = await start(true, {
    profile: pendingProfile,
    loadProfileExtension: true,
    bootstrapResult: () => ({ profile: pendingProfile, terms, consentRequired: true }),
    profileSaveResult: () => ({ profile: joinedProfile }),
  });
  try {
    const get = (id) => w.document.getElementById(id);
    get('profileSurname').value = '林';
    get('profileSalutation').value = 'mr';
    get('profileBirthday').value = '1990-01-01';
    get('profilePhone').value = '0912-345-678';

    get('joinTermsAccepted').checked = true;
    get('joinTermsAccepted').dispatchEvent(new w.Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(get('joinTermsAccepted').checked, true);

    get('profileForm').dispatchEvent(new w.Event('submit', { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));

    const saves = calls.filter((call) => call.action === 'user.member.profile.save');
    assert.equal(saves.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(saves[0].payload)), {
      birthday: '1990-01-01',
      phone: '+886912345678',
      surname: '林',
      salutation: 'mr',
      termsId: 'terms-2',
      termsVersion: '2026-10-v2',
      accepted: true,
    });
    assert.equal(get('memberView').classList.contains('hidden'), false);
    assert.equal(get('profileSetupView').classList.contains('hidden'), true);
  } finally { dom.window.close(); }
});

test('member page initializes without showing the reconsent view when consent is current', async () => {
  const { dom, w } = await start(false);
  try {
    assert.equal(w.document.getElementById('memberView').classList.contains('hidden'), false);
    assert.equal(w.document.getElementById('termsRenewView').classList.contains('hidden'), true);
  } finally { dom.window.close(); }
});
