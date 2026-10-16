const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const source = fs.readFileSync(path.join(__dirname,'../supabase/functions/booking-receipt-api/index.ts'),'utf8');
const code = source.slice(source.indexOf('async function prepare('),source.indexOf('async function finalize('));
const member = { id:'10000000-0000-4000-8000-000000000001' };
const body = { bookingId:'30000000-0000-4000-8000-000000000001',requestId:'receipt-request',mimeType:'image/jpeg',sizeBytes:100 };

for (const status of ['pending_upload','awaiting_review','bound']) {
  test(`receipt prepare: ${status} cannot grant overwrite access to a submitted snapshot`, async () => {
    const signed = [];
    const context = vm.createContext({
      asText:(value) => String(value || ''),
      ALLOWED_MIME:new Set(['image/jpeg']),MAX_FILE_BYTES:5242880,
      BUCKET:'booking-receipts',
      crypto:require('node:crypto').webcrypto,extensionFor:() => 'jpg',
      ApiError:class extends Error {},dbError:(error) => error,
    });
    vm.runInContext(stripTypeScriptTypes(source.slice(source.indexOf('function effectiveSettlement('),source.indexOf('async function adminList('))+code),context);
    const db = {
      rpc:async () => ({ data:{ status,receiptId:'receipt',objectPath:'object',alreadyPrepared:true },error:null }),
      storage:{ from:() => ({ createSignedUploadUrl:async (path,options) => { signed.push({ path,upsert:options.upsert }); return { data:{ token:'fixture' } }; } }) },
    };
    const result = await context.prepare(db,{},member,body);
    if (status === 'pending_upload') {
      assert.deepEqual(signed,[{ path:'object',upsert:false }]);
      assert.equal(result.uploadToken,'fixture');
    } else {
      assert.equal(signed.length,0);
      assert.equal(result.uploadToken,undefined);
      assert.equal(result.status,status);
    }
  });
}

test('the member receipt list prefers the submitted snapshot over failed or pending replacements', async () => {
  const code = source.slice(source.indexOf('async function memberList('),source.indexOf('async function prepare('));
  const context = vm.createContext({localTaipeiNowMs:() => Date.now(),Date,ApiError:class extends Error {}});
  vm.runInContext(stripTypeScriptTypes(source.slice(source.indexOf('function effectiveSettlement('),source.indexOf('async function adminList('))+code),context);
  const rows = [{id:body.bookingId,status:'confirmed',booking_receipts:[
    { receipt_id:'old',status:'awaiting_review',created_at:'2026-10-01T00:00:00Z' },
    { receipt_id:'pending',status:'pending_upload',created_at:'2026-10-02T00:00:00Z' },
    { receipt_id:'failed',status:'failed',created_at:'2026-10-03T00:00:00Z' },
  ]}];
  const q = { select(){return q;},eq(){return q;},in(){return q;},order(){return q;},single:async () => ({data:{snapshot_location_required:false}}),limit:async () => ({ data:rows }) };
  const result = await context.memberList({ from:() => q },member);
  assert.equal(result.bookings[0].receipt.receiptId,'old');
  assert.equal(result.bookings[0].canSubmitReceipt,true);
});


test('bound accessible receipt replay skips consumed benefit validation and reaches idempotent register RPC', async () => {
  const validateCode = source.slice(
    source.indexOf('async function validateAccessibleBenefits('),
    source.indexOf('async function registrationOptions(')
  );
  const context = vm.createContext({
    normalizeAccessibleBenefits:(value) => Array.isArray(value) ? value : [],
    dbError:(error) => error,
    ApiError:class extends Error {},
    String,
  });
  vm.runInContext(stripTypeScriptTypes(validateCode),context);
  let selected = '';
  const query = {
    select(value){ selected = String(value || ''); return query; },
    eq(){ return query; },
    maybeSingle:async () => ({ data:{ member_id:member.id,status:'bound' },error:null }),
  };
  const result = await context.validateAccessibleBenefits(
    { from:(table) => { assert.equal(table,'booking_receipts'); return query; } },
    'receipt-bound',
    '',
    [],
    [{kind:'points',id:'already-redeemed-ticket'}]
  );
  assert.deepEqual(Array.from(result),[]);
  assert.match(selected,/status/);
});


test('accessible history preserves released ticket reason without exposing raw redemption metadata',async()=>{
  const code=source.slice(source.indexOf('async function adminList('),source.indexOf('async function adminUrl('));
  const context=vm.createContext({ApiError:class extends Error {}});vm.runInContext(stripTypeScriptTypes(source.slice(source.indexOf('function effectiveSettlement('),source.indexOf('async function adminList('))+code),context);
  const row={receipt_id:'QA-RECEIPT',booking_id:body.bookingId,status:'bound',bookings:{id:body.bookingId,status:'completed',booking_benefit_selections:[
    {benefit_kind:'points',title_snapshot:'QA coupon',status:'cancelled',result:{cancellationReason:'booking_services_changed',privateMetadata:'not-public'}},
    {benefit_kind:'event',title_snapshot:'QA used',status:'redeemed',result:null},
  ]}};
  let call=0;const q={select(){return q;},eq(){return q;},in(){return q;},order(){return q;},limit:async()=>({data:call++?[row]:[],error:null})};
  const result=await context.adminList({from:()=>q});const benefits=result.accessibleRecords[0].benefits;
  assert.equal(benefits[0].cancellationReason,'booking_services_changed');assert.equal(benefits[1].cancellationReason,'');
  assert.equal(benefits[0].title,'QA coupon');assert.equal(Object.hasOwn(benefits[0],'result'),false);assert.equal(JSON.stringify(result).includes('privateMetadata'),false);
});
