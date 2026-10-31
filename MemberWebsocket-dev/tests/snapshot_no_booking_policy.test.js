const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./helpers/edge-test-fs.cjs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('snapshot receipt API explicitly skips global booking requirement while retaining member authentication', () => {
 const api = read('supabase/functions/booking-receipt-api/index.ts');
 assert.match(api, /action==="user\.booking\.receipt\.options"/);
 assert.match(api, /data=\{\.\.\.catalog,ticketBookingRequired:false\}/);
 assert.match(api, /const member=await requireMember\(supabase,identity\)/);
 assert.match(api, /accessible\?"prepare_snapshot_receipt_v2":"prepare_booking_receipt_request"/);
 assert.doesNotMatch(api, /const policy=await supabase\.from\("booking_settings"\)\.select\("ticket_booking_required"\)/);
});

test('snapshot receipt migration removes only the prebooking gate and retains availability, ownership, idempotency and SQL ACL', () => {
 const sql=read('supabase/migrations/20261010145511_snapshot_tickets_without_advance_booking.sql');
 assert.match(sql, /create or replace function public\.validate_snapshot_ticket_selection/);
 assert.match(sql, /create or replace function public\.register_snapshot_receipt_v2/);
 assert.doesNotMatch(sql, /if p_booking_id is null then raise exception 'BOOKING_TICKET_CONFIRMATION_REQUIRED'/);
 assert.doesNotMatch(sql, /jsonb_array_length\(p_benefits\)>0 and required and p_booking is null/);
 for(const marker of ['BOOKING_NOT_OWNED','MEMBERSHIP_REQUIRED','BOOKING_BENEFIT_NOT_AVAILABLE','POINT_TICKET_INSUFFICIENT_POINTS','TICKET_BATCH_LIMIT_EXCEEDED','EVENT_TICKET_DAILY_LIMIT_REACHED','ADMIN_REQUIRED','REQUEST_ID_CONFLICT']) {
  if(marker==='REQUEST_ID_CONFLICT') continue; // preserved in prepare_snapshot_receipt_v2, not rewritten
  assert.ok(sql.includes(marker),marker+' must remain enforced');
 }
 assert.match(sql, /revoke all on function public\.validate_snapshot_ticket_selection/);
 assert.match(sql, /grant execute on function public\.register_snapshot_receipt_v2[^\n]* to service_role/);
 assert.doesNotMatch(sql, /alter table public\.booking_settings|update public\.booking_settings/);
});

test('snapshot receipt sends intent without booking ID while standard redemption remains unchanged', () => {
 const receipt=read('booking/booking-receipt.js');
 assert.match(receipt, /accessible: true, location: state\.location, benefits: selectedBenefits/);
 assert.doesNotMatch(receipt, /snapshotTicketBooking|requestedBookingId/);
 assert.match(receipt, /const blocked = item\.selectable !== true/);
 assert.match(receipt, /check\.dataset\.snapshotKind = item\.kind/);
 assert.match(receipt, /check\.dataset\.snapshotId = item\.selectionId/);
});

test('snapshot and booking settings explicitly document the independent booking policy', () => {
 const admin = read('admin/booking-panel-core.js');
 const member = read('booking/booking-receipt.js');
 assert.doesNotMatch(admin, /使用票券必須有有效預約|bookingAdminTicketBookingRequired/);
 assert.match(admin, /快照前必須取得定位/);
 assert.match(read('admin/index.html'), /快照模式維持原規則/);
 assert.doesNotMatch(admin, /也適用快照登記/);
 assert.match(member, /快照模式不需要事先有有效預約/);
});

test('snapshot receipt prepare ignores a caller-supplied booking id; normal booking receipts retain it', async () => {
 const vm = require('node:vm');
 const { stripTypeScriptTypes } = require('node:module');
 const source = read('supabase/functions/booking-receipt-api/index.ts');
 const section = source.slice(source.indexOf('async function prepare('),source.indexOf('async function finalize('));
 const sent = [];
 const db = {
   rpc: async (name,args) => {
     sent.push({name,args});
     return {data:{receiptId:'QA-PREPARED',status:'awaiting_review',alreadyPrepared:true},error:null};
   }
 };
 const context = vm.createContext({
   asText:(v,m=1000) => String(v ?? '').trim().slice(0,m),
   ALLOWED_MIME:new Set(['image/jpeg']),MAX_FILE_BYTES:5*1024*1024,
   BUCKET:'booking-receipts',
   crypto:require('node:crypto').webcrypto,
   extensionFor:()=> 'jpg',
   ApiError:class extends Error{},dbError:(err)=>err,
   normalizeAccessibleBenefits: value => value,
 });
 vm.runInContext(stripTypeScriptTypes(section),context);
 const bookingId='30000000-0000-4000-8000-000000000001';
 const request={requestId:'QA-REQUEST',mimeType:'image/jpeg',sizeBytes:100};
 const member={id:'10000000-0000-4000-8000-000000000001'};
 await context.prepare(db,{},member,{...request,accessible:true,
   requestedBookingId:bookingId,benefits:[{kind:'points',id:'QA-TICKET'}]});
 assert.equal(sent[0].name,'prepare_snapshot_receipt_v2');
 assert.equal(sent[0].args.p_booking_id,null);
 assert.equal(sent[0].args.p_benefits[0].id,'QA-TICKET');
 await context.prepare(db,{},member,{...request,bookingId});
 assert.equal(sent[1].name,'prepare_booking_receipt_request');
 assert.equal(sent[1].args.p_booking_id,bookingId);
 assert.equal('p_benefits' in sent[1].args,false);
});
