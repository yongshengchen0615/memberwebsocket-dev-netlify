const { PGlite } = require('@electric-sql/pglite');
const { btree_gist } = require('@electric-sql/pglite/contrib/btree_gist');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const fixture = require('./fixtures/schema-before-legacy-cleanup.json');
const contract = require('../../supabase/schema-contract.json');
const prepare = fs.readFileSync(path.join(root, 'supabase/migrations/20261005101816_prepare_current_schema_contract.sql'), 'utf8');
const retire = fs.readFileSync(path.join(root, 'supabase/migrations/20261005101853_retire_unused_legacy_schema.sql'), 'utf8');
const rateLimitRepair = fs.readFileSync(path.join(root, 'supabase/migrations/20261005121343_fix_rate_limit_after_test_mode_cleanup.sql'), 'utf8');

(async () => {
  const db = new PGlite({ extensions: { btree_gist } });
  try {
    await db.exec('create extension btree_gist;');
    await db.exec(fixture.ddl);
    // PGlite has no pgcrypto extension. Its native PostgreSQL SHA-256 primitive
    // implements the only digest algorithm used by these cleanup entrypoints.
    await db.exec("create function extensions.digest(text,text) returns bytea language sql immutable as $$ select case when lower($2)='sha256' then sha256(convert_to($1,'UTF8')) else null end $$;");
    let pending = fixture.functions;
    // SQL functions check referenced functions at CREATE time; install in
    // dependency order without replacing any application code with a mock.
    while (pending.length) {
      const retry = []; const errors = [];
      for (const definition of pending) {
        try { await db.exec(definition); } catch (error) { retry.push(definition); errors.push(definition.split('\n')[0]+' :: '+error.message); }
      }
      if (retry.length === pending.length) throw new Error(errors.join('\n'));
      pending = retry;
    }
    for (const c of fixture.constraints.filter(c => c.type !== 'f' && c.type !== 't')) {
      await db.exec(`alter table ${c.schema}.${c.table} add constraint ${c.name} ${c.def};`);
    }
    for (const c of fixture.constraints.filter(c => c.type === 'f')) {
      await db.exec(`alter table ${c.schema}.${c.table} add constraint ${c.name} ${c.def};`);
    }
    for (const t of fixture.triggers) await db.exec(t.def+';');

    // A disabled historical config can be retired; an enabled rule must abort.
    await db.exec("insert into public.birthday_benefit_settings(singleton,enabled) values(true,true);");
    await assert.rejects(db.exec('begin;'+prepare+'commit;'), /LEGACY_BIRTHDAY_DATA_REQUIRES_MIGRATION/);
    await db.exec('rollback; update public.birthday_benefit_settings set enabled=false;');
    await db.exec("insert into public.test_execution_leases(lease_type,actor_line_user_id,expires_at) values('full_e2e','qa:cleanup',now()+interval '1 hour');");
    await assert.rejects(db.exec('begin;'+prepare+'commit;'), /LEGACY_CLEANUP_ACTIVE_TEST_RUN/);
    await db.exec('rollback; delete from public.test_execution_leases;');
    await db.exec('begin;'+prepare+retire+rateLimitRepair+'commit;');
    for (const table of contract.retiredTables) {
      assert.equal((await db.query('select to_regclass($1) as value',['public.'+table])).rows[0].value,null);
    }
    for (const [table,columns] of Object.entries(contract.retiredColumns)) {
      const names = (await db.query('select column_name from information_schema.columns where table_schema=\'public\' and table_name=$1',[table])).rows.map(r => r.column_name);
      for (const column of columns) assert.ok(!names.includes(column),table+'.'+column);
    }
    for (const f of contract.retiredFunctions) {
      assert.equal((await db.query("select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=$1 and p.proname=$2 and pg_get_function_identity_arguments(p.oid)=$3",[f.schema,f.name,f.identity])).rows[0].n,0);
    }
    const rateAllowed=(await db.query("select public.consume_api_rate_limit('qa:legacy-cleanup-contract',false,1,90,30) allowed")).rows[0].allowed;
    assert.equal(rateAllowed,true);
    console.log('PASS enabled legacy rules and active E2E runs block cleanup; retired mode columns are removed and rate limiting still works');

    await db.exec('select maintenance.ensure_required_system_baseline(); select maintenance.ensure_event_ticket_settings_baseline();');
    await db.exec('update public.event_ticket_settings set max_tickets_per_day=0; select maintenance.ensure_event_ticket_settings_baseline();');
    assert.equal((await db.query('select max_tickets_per_day from public.event_ticket_settings')).rows[0].max_tickets_per_day,0);
    assert.equal((await db.query('select count(*)::int n from public.membership_tier_settings')).rows[0].n,4);
    console.log('PASS one-click-clear baselines use current schema and preserve zero as unlimited');

    const admin='qa:cleanup-admin';
    await db.query("insert into public.admins(line_user_id,role,status) values($1,'admin','active')",[admin]);
    const result=(await db.query('select * from public.admin_save_maintenance_test_access(false,false,false,\'\',$1,1)',[admin])).rows[0];
    assert.equal(result.created_account_count,1);
    assert.equal((await db.query('select count(*)::int n from public.members where is_test_account')).rows[0].n,1);
    console.log('PASS current maintenance test-account creation survives removal of legacy mode flags');

    // New concrete item restrictions must survive INSERT and retain any/all.
    const service=(await db.query("select id from public.booking_services where is_active limit 1")).rows[0].id;
    await db.query("insert into public.event_tickets(event_ticket_id,title,ticket_type,description,usage_method,usage_instructions,status,required_service_ids,required_service_match_mode,created_by,updated_by) values('QA-CURRENT','Current','coupon','Rule','Show','Show','active',$1,'all','qa:cleanup-admin','qa:cleanup-admin')",[[service]]);
    const event=(await db.query("select required_service_ids,required_service_match_mode from public.event_tickets where event_ticket_id='QA-CURRENT'")).rows[0];
    assert.deepEqual(event.required_service_ids,[service]);assert.equal(event.required_service_match_mode,'all');
    const locations=[{name:'QA site',latitude:25.03,longitude:121.56,radiusMeters:100}];
    await db.query("update public.event_tickets set requires_location=true,redemption_locations=$1 where event_ticket_id='QA-CURRENT'",[JSON.stringify(locations)]);
    await assert.rejects(db.query("update public.event_tickets set redemption_locations='[]' where event_ticket_id='QA-CURRENT'"),/event_tickets_redemption_locations_valid/);
    console.log('PASS concrete service IDs survive insert; multiple-location integrity remains enforced');

    // Both purge entrypoints must resolve against the contracted schema and
    // remove test users without touching the retained active admin/config.
    const id=(await db.query('select id from public.members where is_test_account')).rows[0].id;
    await db.query('select * from public.admin_delete_test_accounts($1)',[[id]]);
    await db.exec('select public.admin_purge_all_test_data();');
    assert.equal((await db.query('select count(*)::int n from public.admins')).rows[0].n,1);
    assert.equal((await db.query('select count(*)::int n from public.members where is_test_account')).rows[0].n,0);
    console.log('PASS account deletion and full test-data purge have no dangling birthday references');
    await db.exec('select * from maintenance.clear_public_data(true);');
    assert.equal((await db.query('select count(*)::int n from public.admins')).rows[0].n,1);
    assert.equal((await db.query('select count(*)::int n from public.membership_tier_settings')).rows[0].n,4);
    assert.equal((await db.query('select count(*)::int n from public.booking_settings s join public.booking_technicians t on t.id=s.primary_technician_id and t.is_active')).rows[0].n,1);
    console.log('PASS full reset rebuilds current settings, service catalog and active primary technician atomically');
    await db.exec(fs.readFileSync(path.join(root,'supabase/rollback/restore_legacy_schema_contract.sql'),'utf8'));
    assert.notEqual((await db.query("select to_regclass('public.birthday_benefit_settings') value")).rows[0].value,null);
    assert.equal((await db.query('select enabled from public.birthday_benefit_settings')).rows[0].enabled,false);
    console.log('PASS explicit emergency rollback restores old schema compatibility with birthday rules disabled');
  } finally { await db.close(); }
})().catch(error => { console.error(error.message); process.exitCode=1; });
