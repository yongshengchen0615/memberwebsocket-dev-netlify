const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {stripTypeScriptTypes} = require('node:module');
const {JSDOM} = require('jsdom');
const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 20));

function user(w) {
  w.eval(read('user-test-control.js').replace('  window.MemberUserTestControl =',
    '  window.optimizationProbe = {state,waitFor,compactFailureTrace,pointsHumanRedeemCase};\n  window.MemberUserTestControl ='));
  w.optimizationProbe.state.config = {supabaseUrl:'https://fixture.supabase.co'};
  return w.optimizationProbe;
}

test('DOM waits complete while every background timer is suspended and disconnect observers', async () => {
  const d = new JSDOM('<div id="bookingView"></div>', {url:'https://example.test/MemberWebsocket-dev/booking/',runScripts:'outside-only'});
  const w = d.window;
  try {
    const probe = user(w);
    let active = 0;
    const Observer = w.MutationObserver;
    w.MutationObserver = class extends Observer {
      observe(...args) { active++; return super.observe(...args); }
      disconnect() { active--; return super.disconnect(); }
    };
    const held = new Map(); let timer = 0;
    w.setTimeout = callback => { held.set(++timer, callback); return timer; };
    w.clearTimeout = id => held.delete(id);
    let completed = false;
    const pending = probe.waitFor(() => w.document.getElementById('slot'), 5000).then(value => { completed=true; return value; });
    w.document.getElementById('bookingView').innerHTML = '<button id="slot">Ready</button>';
    await tick();
    assert.equal(completed, true, 'A mutation must resolve without running even one timer');
    assert.equal((await pending).id, 'slot');
    assert.equal(active, 0); assert.equal(held.size, 0);
    probe.state.pendingTimedOutNode = {};
    await assert.rejects(probe.waitFor(() => true), error => error.code === 'E2E_NODE_CANCELLED');
    assert.equal(active, 0);
  } finally { w.close(); }
});

test('trace compaction preserves the final error, last UI action and API timing instead of a settings prefix', () => {
  const d = new JSDOM('<div/>', {url:'https://example.test/MemberWebsocket-dev/booking/',runScripts:'outside-only'});
  try {
    const probe = user(d.window);
    const trace = probe.compactFailureTrace({seed:'QA',surface:'booking',caseKey:'BOOKING_HUMAN_LIFECYCLE',
      page:{path:'/booking/',visibilityState:'hidden'},error:{code:'E2E_NODE_TIMEOUT',message:'Deadline'},
      events:[...Array.from({length:20}, () => ({type:'settings',detail:{settings:'x'.repeat(1800)}})),
        {type:'ui.click',atMs:1,detail:{target:'#confirmBookingButton'}}],
      apiTimings:[{path:'/functions/v1/booking-group-api',durationMs:1200,responseStatus:200}]}, 2000);
    assert.equal(trace.truncated,true);assert.equal(trace.error.code,'E2E_NODE_TIMEOUT');
    assert.equal(trace.events.at(-1).detail.target,'#confirmBookingButton');
    assert.equal(trace.apiTimings.at(-1).durationMs,1200);assert.ok(JSON.stringify(trace).length<=2000);
    assert.equal(trace.preview,undefined);
  } finally { d.window.close(); }
});

async function pointsHarness(eligible = true) {
  const d = new JSDOM(read('points/index.html'), {url:'https://example.test/MemberWebsocket-dev/points/',runScripts:'outside-only'});
  const w = d.window; await new Promise(resolve => w.addEventListener('load',resolve,{once:true}));
  const bookingId='00000000-0000-4000-8000-000000000001',writes=[];
  const ticket={ticketId:'QA-TICKET',ticketTitle:'QA 真人操作票券',thresholdStamps:1,ticketTemplateId:'TPL',status:'available',
    eligibleBookings:eligible?[{bookingId,title:'QA booking'}]:[]};
  const snapshot={cards:[{cardId:'QA-CARD',title:'QA',status:'active',stamps:2,rewards:[{thresholdStamps:1,ticketTemplateId:'TPL'}]}],
    cardDetails:{'QA-CARD':{tickets:[ticket]}}};
  w.TestModeClient={getSessionToken:()=> 'isolated',payload:body=>body};
  w.MemberSystem={request:async()=>snapshot};
  w.fetch=async(_url,init)=>{
    const body=JSON.parse(init.body);
    if(body.action==='user.qa.fixture.prepare')return {ok:true,json:async()=>({ok:true,data:{ticketId:ticket.ticketId,bookingId}})};
    if(body.operation==='member.settings.get')return {ok:true,json:async()=>({ok:true,data:{maxTicketsPerRedemption:1}})};
    if(body.operation==='member.redeem'){
      writes.push(body);ticket.status='used';
      w.document.getElementById('ticketHistoryList').textContent='QA 真人操作票券';
      return {ok:true,json:async()=>({ok:true,data:{tickets:[{...ticket,pointsSpent:1}],balance:{stamps:1}}})};
    }
    throw new Error('Unexpected operation '+JSON.stringify(body));
  };
  w.eval(read('ticket-booking-choice.js'));w.eval(read('ui-components.js'));w.eval(read('points/pointcard-ticket-overview.js'));
  await w.PointCardTicketOverview.initialize({config:{supabaseUrl:'https://fixture.supabase.co'},refreshData:async()=>w.PointCardTicketOverview.renderSnapshot(snapshot)});
  w.MemberClientQaHooks={surface:'points',refresh:async()=>w.PointCardTicketOverview.renderSnapshot(snapshot)};
  return {w,probe:user(w),writes,bookingId};
}

test('point E2E selects the eligible fixture booking through the production confirmation UI', async () => {
  const h=await pointsHarness();
  try {
    const result=await h.probe.pointsHumanRedeemCase();
    assert.equal(result.status,'passed',JSON.stringify(result));
    assert.equal(result.actual.bookingSelected,true);assert.equal(result.actual.cancelClosed,true);
    assert.equal(h.writes.length,1);assert.equal(h.writes[0].bookingId,h.bookingId);
    assert.deepEqual(h.writes[0].ticketIds,['QA-TICKET']);
  } finally { h.w.close(); }
});

test('point E2E rejects an ineligible ticket with a useful precondition error and no debit', async () => {
  const h=await pointsHarness(false);
  try {
    await assert.rejects(h.probe.pointsHumanRedeemCase(), error => error.code==='E2E_TICKET_PRECONDITION');
    assert.equal(h.writes.length,0);
  } finally { h.w.close(); }
});

function apiProbe() {
  const source=read('supabase/functions/user-test-api/index.ts').replace(/^import .*\n/gm,'');
  const context=vm.createContext({Deno:{serve(){},env:{get(){return '';}}},Date,Intl,console,setTimeout,crypto:require('node:crypto').webcrypto,TextEncoder});
  vm.runInContext(stripTypeScriptTypes(source),context);
  return context;
}

test('server trace compaction retains diagnosis inputs and redacts secrets before shrinking', () => {
  const api=apiProbe();
  const trace=api.safeDiagnosticSnapshot({caseKey:'BOOKING',error:{code:'E2E_TIMEOUT',token:'private'},page:{visibilityState:'hidden'},
    events:Array.from({length:25},()=>({type:'ui.click',detail:{target:'#submit',settings:'x'.repeat(1000),phone:'private'}})),
    apiTimings:[{path:'/api',responseStatus:503,durationMs:2000}]},2000);
  assert.equal(trace.error.code,'E2E_TIMEOUT');assert.equal(trace.error.token,'[redacted]');
  assert.equal(trace.apiTimings[0].responseStatus,503);assert.equal(trace.events.at(-1).detail.target,'#submit');
  assert.equal(JSON.stringify(trace).includes('private'),false);assert.ok(JSON.stringify(trace).length<=2000);
});

test('point fixture setup rejects formal identities and other surfaces before any privileged operation', async () => {
  const api=apiProbe();let reads=0;const db={from(){reads++;throw new Error('must not query');}};
  for(const identity of [{memberId:'formal',isTestAccount:false,surface:'points'}, {memberId:'qa',isTestAccount:true,surface:'event'}]) {
    await assert.rejects(api.preparePointRedemptionBooking(db,identity,'ABCDEF1234567890','QA'),error=>error.code==='TEST_ACCOUNT_REQUIRED');
  }
  assert.equal(reads,0);
});

// Only the transport is adapted. RPCs, triggers, ownership and integrity checks
// run against the empty PostgreSQL production-schema snapshot.
function postgresTransport(db) {
  const errors=[];
  return {
    errors,
    from(table) {
      let operation='select',columns='*',values,one=false,optional=false,sort='',limit='',filters=[],args=[];
      const identifier=value=>{assert.match(value,/^[a-z_]+$/);return '"'+value+'"';};
      const bind=value=>{args.push(value);return '$'+args.length;};
      const q={
        select(value='*'){columns=value;return q;},
        eq(key,value){filters.push(identifier(key)+'='+bind(value));return q;},
        like(key,value){filters.push(identifier(key)+' like '+bind(value));return q;},
        order(key,{ascending}){sort=' order by '+identifier(key)+(ascending?' asc':' desc');return q;},
        limit(value){limit=' limit '+Number(value);return q;},
        single(){one=true;return q;},maybeSingle(){one=true;optional=true;return q;},
        update(value){operation='update';values=value;return q;},
        insert(value){operation='insert';values=value;return q;},
        delete(){operation='delete';return q;},
        async then(resolve,reject) {
          try {
            const selected=columns==='*'?'*':columns.split(',').map(identifier).join(',');
            const where=filters.length?' where '+filters.join(' and '):'';
            let sql;
            if(operation==='select')sql='select '+selected+' from '+identifier(table)+where+sort+limit;
            if(operation==='update')sql='update '+identifier(table)+' set '+Object.entries(values).map(([key,value])=>identifier(key)+'='+bind(value)).join(',')+where+' returning '+selected;
            if(operation==='insert')sql='insert into '+identifier(table)+' ('+Object.keys(values).map(identifier).join(',')+') values ('+Object.values(values).map(bind).join(',')+') returning '+selected;
            if(operation==='delete')sql='delete from '+identifier(table)+where+' returning '+selected;
            const rows=(await db.query(sql,args)).rows;
            resolve(one&&rows.length!==1&&!(optional&&rows.length===0)?{data:null,error:{message:'single-row mismatch'}}:{data:one?(rows[0]||null):rows,error:null});
          } catch(error) { resolve({data:null,error}); }
        },
      };
      return q;
    },
    async rpc(name,values) {
      assert.ok(['create_booking_bundle_request','member_ticket_booking_options'].includes(name));
      try {
        const keys=Object.keys(values),args=Object.values(values).map(value=>Array.isArray(value)?JSON.stringify(value):value);
        const sql='select to_jsonb('+name+'('+keys.map((key,i)=>key+' => $'+(i+1)).join(',')+')) data';
        return {data:(await db.query(sql,args)).rows[0].data,error:null};
      } catch(error) { errors.push(error.message+' '+error.where+' '+JSON.stringify(values));return {data:null,error}; }
    },
  };
}

test('QA point booking uses real eligibility and constraints, preserves balance and cleans failed setup only', async () => {
  const db=await require('./fixtures/load-postgres-snapshot.cjs')();
  try {
    await db.exec(read('supabase/migrations/20261006023020_booking_ticket_usage_consistency.sql'));
    await db.exec('select maintenance.ensure_required_system_baseline();select maintenance.ensure_event_ticket_settings_baseline();');
    const query=async(sql,args=[]) => (await db.query(sql,args)).rows;
    const member=(await query("insert into members(line_user_id,member_code,status,membership_status,is_test_account) values('test:optimization','QA-OPT','active','active',true) returning id"))[0].id;
    const other=(await query("insert into members(line_user_id,member_code,status,membership_status) values('formal:untouched','FORMAL','active','pending') returning id"))[0].id;
    await query("insert into booking_service_types(name) values('QA')");
    await query("insert into booking_services(title,duration_minutes,price_amount,service_type,created_by) values('QA optimization service',30,100,'QA','qa:e2e:fixture')");
    const card=(await query("insert into point_cards(card_id,title,status,created_by,updated_by) values('QA-OPT-CARD','QA','active','qa:e2e:fixture','qa:e2e:fixture') returning id"))[0].id;
    const template=(await query("insert into ticket_templates(ticket_template_id,title,ticket_type,status,created_by,updated_by) values('QA-OPT-TPL','QA','coupon','active','qa:e2e:fixture','qa:e2e:fixture') returning id"))[0].id;
    await query('insert into point_balances(member_id,point_card_id,stamps) values($1,$2,2)',[member,card]);
    await query("insert into point_tickets(ticket_id,member_id,point_card_id,ticket_template_id,threshold_stamps,ticket_type,ticket_title) values('QA-OPT-TICKET',$1,$2,$3,1,'coupon','QA')",[member,card,template]);
    const api=apiProbe(),s=postgresTransport(db),identity={memberId:member,isTestAccount:true,surface:'points'};
    const booking=await api.preparePointRedemptionBooking(s,identity,'ABCDEF1234567890','QA-OPT-TICKET')
      .catch(error=>assert.fail(error.message+': '+s.errors.join('; ')));
    const row=(await query('select member_id,status,confirmed_by from bookings where id=$1',[booking]))[0];
    assert.equal(row.member_id,member);assert.equal(row.status,'confirmed');assert.match(row.confirmed_by,/^qa-ui:/);
    assert.equal((await s.rpc('member_ticket_booking_options',{p_member_id:member})).data.points['QA-OPT-TICKET'][0].bookingId,booking);
    assert.equal((await query('select stamps from point_balances where member_id=$1',[member]))[0].stamps,2);
    assert.equal((await query("select count(*)::int n from booking_audit_events where action='QA_POINT_REDEMPTION_FIXTURE' and target_id=$1",[booking]))[0].n,1);
    await assert.rejects(api.preparePointRedemptionBooking(s,identity,'ABCDEF1234567890','QA-OPT-TICKET'),error=>error.code==='QA_FIXTURE_BOOKING_NOT_READY');
    assert.equal((await query('select status from bookings where id=$1',[booking]))[0].status,'confirmed');
    await assert.rejects(api.preparePointRedemptionBooking(s,identity,'ABCDEF1234567891','FOREIGN-TICKET'),error=>error.code==='QA_FIXTURE_BOOKING_NOT_READY');
    assert.equal((await query('select count(*)::int n from bookings'))[0].n,1);
    assert.equal((await query('select status from members where id=$1',[other]))[0].status,'active');
  } finally { await db.close(); }
});


test('point redemption fixture probes more than five distinct candidate slots', async () => {
  const api = apiProbe();
  const observed = [], bookingId = '00000000-0000-4000-8000-000000000099';
  const records = {
    booking_settings: { work_start_time:'10:00', work_end_time:'18:00',slot_interval_minutes:15,min_advance_days:1,max_advance_days:10 },
    booking_services: null,
    calendar_items: [],
  };
  const service = { id:'qa-service',duration_minutes:30 };
  const store = { id:'store-service',duration_minutes:15 };
  const client = {
    from(table) {
      const criteria = {};
      const q = {
        select(){return q}, eq(k,v){criteria[k]=v;return q}, like(){return q},
        order(){return q},limit(){return q},update(){return q},
        insert(){return Promise.resolve({data:[{}],error:null})},
        single(){
          const data = table==='booking_settings'?records.booking_settings
            :table==='booking_services'?(criteria.id?store:service)
            :table==='bookings'?{id:bookingId,status:'confirmed'}:null;
          return Promise.resolve({data,error:data?null:{message:'not found'}});
        },
        then(resolve,reject) {
          return Promise.resolve({data:table==='booking_services'?[service]:records[table]||[],error:null}).then(resolve,reject);
        },
      };
      return q;
    },
    async rpc(name,args) {
      if(name==='create_booking_bundle_request') {
        observed.push(args.p_booking_date+' '+args.p_start_time);
        return observed.length<=5?{data:null,error:{message:'BOOKING_SLOT_TAKEN'}}
          :{data:{id:bookingId,status:'pending'},error:null};
      }
      if(name==='member_ticket_booking_options')return {data:{points:{T:[{bookingId}]}},error:null};
      throw Error('unexpected rpc '+name);
    },
  };
  const selected = await api.preparePointRedemptionBooking(client,{memberId:'qa',isTestAccount:true,surface:'points'},'ABCDEF1234567890','T');
  assert.equal(selected,bookingId);
  assert.equal(observed.length,6);
  assert.equal(new Set(observed).size,6,'each retry should be a new date and time candidate');
});

test('point fixture failure before response removes all QA rows including issued tickets and ledger', async () => {
  const api = apiProbe(), names = ['ticket_templates','point_cards','point_card_rewards','point_balances','point_entries','point_tickets'];
  const rows = Object.fromEntries(names.map(name=>[name,[]]));
  let counter=0;
  const client={
    from(table) {
      let action='select',value,filters=[],limit=Infinity,single=false;
      const q={
        select(){return q},eq(key,v){filters.push(row=>row[key]===v);return q},
        like(){return q},order(){return q},
        limit(n){limit=n;return q},insert(data){action='insert';value=data;return q},
        delete(){action='delete';return q},single(){single=true;return execute()},
        maybeSingle(){single=true;return execute()},then(ok,bad){return execute().then(ok,bad)},
      };
      async function execute() {
        if(table==='booking_settings')return {data:null,error:{message:'QA booking setup unavailable'}};
        const target=rows[table]||[];
        if(action==='insert') {
          const newRow={...value,id:'row-'+(++counter)};
          target.push(newRow);
          return {data:single?newRow:[newRow],error:null};
        }
        const matching=target.filter(row=>filters.every(f=>f(row))).slice(0,limit);
        if(action==='delete')for(const row of matching)target.splice(target.indexOf(row),1);
        return {data:single?(matching[0]||null):matching,error:null};
      }
      return q;
    },
    async rpc(name, args) {
      if(name!=='issue_eligible_point_tickets')throw Error('unexpected RPC '+name);
      const reward=rows.point_card_rewards.find(row=>row.point_card_id===args.p_point_card_id);
      rows.point_tickets.push({id:'issued',ticket_id:'ISSUED',member_id:'qa',point_card_id:args.p_point_card_id,
        reward_id:reward.id,status:'available'});
      return {data:{},error:null};
    },
  };
  await assert.rejects(api.prepareHumanFixture(client,{memberId:'qa',surface:'points',isTestAccount:true},'points'),
    error=>error.code==='QA_FIXTURE_BOOKING_NOT_READY');
  for(const name of names)assert.equal(rows[name].length,0, name+' leaked an orphan');

  // Failed ticket issuance must not leave the point ledger that blocks card deletion.
  client.rpc = async name => {
    assert.equal(name,'issue_eligible_point_tickets');
    return {data:{},error:{code:'ISSUANCE_FAILED'}};
  };
  await assert.rejects(api.prepareHumanFixture(client,{memberId:'qa',surface:'points',isTestAccount:true},'points'),
    error=>error.code==='QA_FIXTURE_POINT_TICKET_FAILED');
  for(const name of names)assert.equal(rows[name].length,0, name+' leaked after failed issuance');
});
