const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');

const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/member-profile-api/index.ts'), 'utf8')
  .replace(/^import .*\n/gm, '');

function harness() {
  const member = { id:'member-1', line_user_id:'line-1', display_name:'Member', member_code:'M0001', status:'active', membership_status:'pending', created_at:'2026-01-01T00:00:00Z', is_test_account:false };
  let terms = { id:'terms-1', version:'v1', title:'會員條款', summary:'摘要', body:'條款全文', status:'active', required:true, effective_at:'2020-01-01T00:00:00Z', activated_at:'2026-09-28T00:00:00Z', reconsent_existing:false };
  const consents = new Set();
  let forcedTermsRpcError = null;
  let handler;
  const db = {
    rpc(name, args) {
      if (name === 'consume_api_rate_limit') return Promise.resolve({ data:true, error:null });
      if (name === 'member_service_minute_totals') return Promise.resolve({ data:[{ member_id:member.id,total_minutes:0 }],error:null });
      assert.equal(name, 'accept_membership_terms_api');
      const payload=args.p_payload || {};
      if (forcedTermsRpcError) return Promise.resolve({ data:null, error:forcedTermsRpcError });
      if (payload.accepted !== true) return Promise.resolve({ data:null, error:{ message:'TERMS_CONSENT_REQUIRED' } });
      if (payload.termsId !== terms.id || payload.termsVersion !== terms.version) return Promise.resolve({ data:null, error:{ message:'TERMS_VERSION_STALE' } });
      consents.add(terms.id);
      if (member.membership_status === 'pending') Object.assign(member, { membership_status:'active', birthday:payload.birthday, phone:payload.phone, surname:payload.surname, salutation:payload.salutation, joined_at:'2026-09-27T00:00:00Z' });
      return Promise.resolve({ data:true, error:null });
    },
    from(table) {
      let row = table === 'members' ? member : table === 'membership_terms' ? terms : table === 'membership_consents' ? (consents.has(terms.id) ? { id:'consent' } : null) : null;
      const query = {
        select() { return query; }, eq() { return query; }, order() { return Promise.resolve({ data:[], error:null }); },
        maybeSingle() { return Promise.resolve({ data:row, error:null }); },
        single() { return Promise.resolve({ data:row, error:null }); },
        update(patch) { Object.assign(member,patch); row=member; return query; }
      };
      return query;
    }
  };
  const context = vm.createContext({
    Deno:{ serve(callback) { handler=callback; }, env:{ get(name) { if (name==='SUPABASE_URL') return 'https://example.supabase.co'; if (name==='SUPABASE_SERVICE_ROLE_KEY') return 'test-only'; return ''; } } },
    createClient:() => db, readJsonObject:(request) => request.json(),
    resolveUserTestIdentity:async () => ({ lineUserId:'line-1',displayName:'Member' }),
    TestModeAuthError:class extends Error {}, verifyLineIdTokenContract:async () => ({ lineUserId:'line-1',displayName:'Member' }),
    crypto:require('node:crypto').webcrypto, TextEncoder, Date, Response, console,
  });
  vm.runInContext(stripTypeScriptTypes(source),context);
  async function call(action, payload={}) {
    const response=await handler(new Request('https://example.invalid',{ method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,clientType:'member',testSessionToken:'fixture',...payload}) }));
    return { status:response.status,body:await response.json() };
  }
  return {
    call,
    member,
    consents,
    forceTermsRpcError(error) { forcedTermsRpcError=error; },
    setTestAccount() { member.is_test_account=true; },
    setJoinedAt(value) { member.joined_at=value; },
    switchTerms() { terms={...terms,id:'terms-2',version:'v2',activated_at:'2026-09-28T01:00:00Z',reconsent_existing:true}; },
  };
}

test('registration rejects missing and stale consent, then records consent with activation', async () => {
  const h=harness();
  const initial=await h.call('user.member.bootstrap');
  assert.equal(initial.body.data.consentRequired,true);
  const profile={ birthday:'1990-01-01',phone:'0912345678',surname:'林',salutation:'mr' };
  const missing=await h.call('user.member.profile.save',{...profile,termsId:'terms-1',termsVersion:'v1'});
  assert.equal(missing.status,400);
  assert.equal(missing.body.error.code,'TERMS_CONSENT_REQUIRED');
  assert.equal(h.member.membership_status,'pending');
  const stale=await h.call('user.member.profile.save',{...profile,termsId:'terms-1',termsVersion:'old',accepted:true});
  assert.equal(stale.status,409);
  assert.equal(stale.body.error.code,'TERMS_VERSION_STALE');
  assert.equal(stale.body.error.details.terms.id,'terms-1');
  assert.equal(stale.body.error.details.terms.version,'v1');
  assert.equal(stale.body.error.details.consentRequired,true);
  assert.equal(h.consents.size,0);
  const joined=await h.call('user.member.profile.save',{...profile,termsId:'terms-1',termsVersion:'v1',accepted:true});
  assert.equal(joined.status,200);
  assert.equal(joined.body.data.profile.membershipRequired,false);
  assert.deepEqual([...h.consents],['terms-1']);
});

test('active version replacement requires existing member to accept v2', async () => {
  const h=harness();
  const profile={ birthday:'1990-01-01',phone:'0912345678',surname:'林',salutation:'mr',termsId:'terms-1',termsVersion:'v1',accepted:true };
  await h.call('user.member.profile.save',profile);
  h.switchTerms();
  const boot=await h.call('user.member.bootstrap');
  assert.equal(boot.body.data.consentRequired,true);
  const stale=await h.call('user.member.terms.accept',{termsId:'terms-1',termsVersion:'v1',accepted:true});
  assert.equal(stale.status,409);
  assert.equal(stale.body.error.details.terms.id,'terms-2');
  assert.equal(stale.body.error.details.terms.version,'v2');
  const renewed=await h.call('user.member.terms.accept',{termsId:'terms-2',termsVersion:'v2',accepted:true});
  assert.equal(renewed.status,200);
  assert.equal(renewed.body.data.consentRequired,false);
  assert.deepEqual([...h.consents],['terms-1','terms-2']);
});


test('test accounts follow the same active terms consent gate', async () => {
  const h=harness();
  const profile={ birthday:'1990-01-01',phone:'0912345678',surname:'林',salutation:'mr',termsId:'terms-1',termsVersion:'v1',accepted:true };
  await h.call('user.member.profile.save',profile);
  h.setTestAccount();
  h.switchTerms();
  // Test accounts are provisioned directly as active records. Even if they were
  // created after the terms activation timestamp, they still need an explicit consent row.
  h.setJoinedAt('2026-09-29T00:00:00Z');

  const boot=await h.call('user.member.bootstrap');
  assert.equal(boot.status,200);
  assert.equal(boot.body.data.consentRequired,true);

  const renewed=await h.call('user.member.terms.accept',{termsId:'terms-2',termsVersion:'v2',accepted:true});
  assert.equal(renewed.status,200);
  assert.equal(renewed.body.data.consentRequired,false);
  assert.deepEqual([...h.consents],['terms-1','terms-2']);
});


test('PostgREST stale RPC schema is surfaced as a retryable membership service error', async () => {
  const h=harness();
  h.forceTermsRpcError({
    code:'PGRST202',
    message:'Could not find the function public.accept_membership_terms_api in the schema cache',
  });
  const result=await h.call('user.member.profile.save',{
    birthday:'1990-01-01',
    phone:'0912345678',
    surname:'林',
    salutation:'mr',
    termsId:'terms-1',
    termsVersion:'v1',
    accepted:true,
  });
  assert.equal(result.status,503);
  assert.equal(result.body.error.code,'MEMBERSHIP_RPC_UNAVAILABLE');
  assert.match(result.body.error.message,/重新送出/);
  assert.equal(h.member.membership_status,'pending');
  assert.equal(h.consents.size,0);
});
