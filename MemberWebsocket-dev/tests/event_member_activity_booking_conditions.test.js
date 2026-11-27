const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const migration=read('supabase/migrations/20261127180000_event_and_activity_booking_usage_rules.sql');
const direct={bookingId:'no-booking'},eligible={bookingId:'a-confirmed-booking'};

test('AC-001: restricted event ticket only shows eligible confirmed bookings, legacy unrestricted supports direct use',()=>{
  const window={};
  vm.runInNewContext(read('ticket-booking-choice.js'),{window});
  for(const row of [{minBookingPartySize:2},{maxBookingPartySize:3},{minBookingPartySize:2,maxBookingPartySize:3}]){
    const result=window.TicketBookingChoice.eventOptions(row,[direct,eligible]);
    assert.equal(result.requiresBooking,true);
    assert.deepEqual(Array.from(result.bookings,b=>b.bookingId),[eligible.bookingId]);
    assert.equal(window.TicketBookingChoice.eventOptions(row,[direct]).bookings.length,0);
  }
  assert.equal(window.TicketBookingChoice.eventOptions({minBookingPartySize:0,maxBookingPartySize:0},[direct,eligible]).requiresBooking,false);
});

test('AC-002: party-size labels are inclusive, bounded, and free of raw identifiers',()=>{
  const source=read('supabase/functions/api/index.ts');
  const a=source.indexOf('function bookingPartySizeLabel(');
  const b=source.indexOf('\n}\n',a);
  assert.ok(a>=0&&b>a);
  const fn=vm.runInNewContext(stripTypeScriptTypes(source.slice(a,b+2))+'\nbookingPartySizeLabel');
  assert.equal(fn({min_booking_party_size:2,max_booking_party_size:4}),'每筆預約需 2–4 位');
  assert.equal(fn({min_booking_party_size:3}),'每筆預約至少 3 位');
  assert.equal(fn({max_booking_party_size:5}),'每筆預約最多 5 位');
  assert.equal(fn({}),'');
  assert.match(fn({min_booking_party_size:6,max_booking_party_size:2}),/資料異常/);
});

test('AC-003: admin editor and API both validate min/max, preserve values and reject stale responses',()=>{
  const html=read('admin/index.html');
  const admin=read('admin/app.js');
  const api=read('supabase/functions/api/index.ts');
  for(const id of ['eventTicketMinBookingPartySize','eventTicketMaxBookingPartySize','calendarItemMinBookingPartySize','calendarItemMaxBookingPartySize','calendarItemRequiredServiceIds','calendarItemRequiredServiceGroups','calendarItemMinBookingAmountMode']){
    assert.match(html,new RegExp('id="'+id+'"'));
    assert.match(admin,new RegExp(id));
  }
  assert.match(admin,/function validateBookingPartyRule/);
  assert.match(admin,/Number\(result\.eventTicket\.minBookingPartySize/);
  assert.match(admin,/Number\(result\.calendarItem\.maxBookingPartySize/);
  assert.match(api,/INVALID_BOOKING_PARTY_SIZE_RULE/);
  assert.match(api,/min_booking_party_size: minBookingPartySize/);
  assert.match(api,/normalizeCalendarUsageRules/);
});

test('AC-004: database party gates use canonical, owned bookings and fail direct redemption closed',()=>{
  assert.match(migration,/min_booking_party_size smallint NOT NULL DEFAULT 0/i);
  assert.match(migration,/max_booking_party_size smallint NOT NULL DEFAULT 0/i);
  assert.match(migration,/b\.id=p_booking_id and b\.member_id=p_member_id/);
  assert.match(migration,/b\.party_size>=et\.min_booking_party_size/);
  assert.match(migration,/b\.party_size<=et\.max_booking_party_size/);
  assert.match(migration,/or e\.min_booking_party_size>0 or e\.max_booking_party_size>0/);
  assert.match(migration,/BOOKING_BENEFIT_PARTY_SIZE_REQUIRED/);
  assert.match(migration,/BEFORE UPDATE OF party_size ON public\.bookings/);
});

test('AC-005: calendar use combines service groups, selected subtotal, party size and ownership',()=>{
  assert.match(migration,/CREATE OR REPLACE FUNCTION public\.booking_meets_activity_usage/);
  assert.match(migration,/b\.member_id=p_member_id/);
  assert.match(migration,/booking_meets_required_services\(b\.id/);
  assert.match(migration,/bi\.unit_price_amount::bigint\*bi\.quantity::bigint/);
  assert.match(migration,/BOOKING_ACTIVITY_REQUIREMENT_NOT_MET/);
  assert.match(migration,/validate_booking_benefit_service_requirement_row/);
  assert.match(migration,/replace_booking_benefit_selections_request/);
});

test('AC-006: member surfaces describe condition and no artificial claim is issued',()=>{
  const member=read('supabase/functions/member-calendar-api/index.ts');
  const calendar=read('calendar/app.js');
  const benefits=read('supabase/functions/_shared/booking-benefits.ts');
  const ui=read('event-ticket-ui.js');
  assert.match(member,/activityUsageLabels/);
  assert.match(calendar,/item\.usageConditionLabels/);
  assert.match(benefits,/minBookingPartySizeLabel/);
  assert.match(ui,/預約人數條件/);
  assert.match(benefits,/selectable: false, selectionId: ''/);
  assert.doesNotMatch(migration,/\b(update|delete)\s+public\.event_ticket_claims/gi);
});
