const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const load = require('./fixtures/load-postgres-snapshot.cjs');

const migrations = path.resolve(__dirname, '../../supabase/migrations');
const guardFix = fs.readFileSync(path.join(migrations, '20261125153000_fix_point_card_shared_ticket_service_guard.sql'), 'utf8');
const blueprintFix = fs.readFileSync(path.join(migrations, '20261125153100_fix_point_card_new_business_template.sql'), 'utf8');
const invalidService = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const tenant = 'business_00000000000000000000000000000000';

function originalGuard(schema) {
  return [
    'CREATE OR REPLACE FUNCTION @@SCHEMA@@.validate_ticket_required_service_ids()',
    'RETURNS trigger LANGUAGE plpgsql',
    "SET search_path TO '@@SCHEMA@@', 'pg_temp'",
    'AS $function$',
    'BEGIN',
    "  IF EXISTS (SELECT 1 FROM unnest(coalesce(new.required_service_ids, '{}'::uuid[])) r(service_id)",
    '    LEFT JOIN @@SCHEMA@@.booking_services bs ON bs.id = r.service_id WHERE bs.id IS NULL)',
    "    THEN RAISE EXCEPTION 'INVALID_REQUIRED_SERVICE_IDS'; END IF;",
    "  IF EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(new.required_service_groups, '[]'::jsonb)) g",
    '    CROSS JOIN LATERAL jsonb_array_elements_text(g.value) v',
    '    LEFT JOIN @@SCHEMA@@.booking_services bs ON bs.id::text = v.value WHERE bs.id IS NULL)',
    "    THEN RAISE EXCEPTION 'INVALID_REQUIRED_SERVICE_GROUPS'; END IF;",
    "  if TG_TABLE_NAME='event_tickets' and exists(select 1 from unnest(coalesce(new.min_booking_service_ids,'{}'::uuid[])) chosen(service_id) left join @@SCHEMA@@.booking_services bs on bs.id=chosen.service_id where bs.id is null) then raise exception 'INVALID_BOOKING_AMOUNT_RULE'; end if;",
    '  RETURN NEW;',
    'END;',
    '$function$;'
  ].join('\n').replaceAll('@@SCHEMA@@', schema);
}

test('AC-001–005: the shared point reward trigger separates event fields and preserves guards', async () => {
  const db = await load();
  try {
    await db.exec('CREATE SCHEMA ' + tenant + '; CREATE TABLE ' + tenant + '.booking_services(id uuid PRIMARY KEY);');
    await db.exec(originalGuard('public'));
    await db.exec(originalGuard(tenant));
    await db.exec([
      'CREATE TEMP TABLE qa_point_reward(',
      "  required_service_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],",
      "  required_service_groups jsonb NOT NULL DEFAULT '[]'::jsonb",
      ');',
      'CREATE TRIGGER qa_point_reward_guard BEFORE INSERT OR UPDATE ON qa_point_reward',
      'FOR EACH ROW EXECUTE FUNCTION public.validate_ticket_required_service_ids();'
    ].join('\n'));

    await assert.rejects(db.exec('INSERT INTO qa_point_reward DEFAULT VALUES'), /min_booking_service_ids/,
      'before the patch point-card rewards incorrectly access an event-ticket-only field');

    await db.exec(guardFix);
    await db.exec('INSERT INTO qa_point_reward DEFAULT VALUES');
    await assert.rejects(db.exec(
      "INSERT INTO qa_point_reward(required_service_ids) VALUES(ARRAY['@@BAD@@'::uuid])"
        .replace('@@BAD@@', invalidService)), /INVALID_REQUIRED_SERVICE_IDS/);
    await assert.rejects(db.exec(
      'INSERT INTO qa_point_reward(required_service_groups) VALUES(\'[["@@BAD@@"]]\'::jsonb)'
        .replace('@@BAD@@', invalidService)), /INVALID_REQUIRED_SERVICE_GROUPS/);

    await db.exec([
      'CREATE TEMP TABLE event_tickets(',
      "  required_service_ids uuid[] DEFAULT '{}'::uuid[],",
      "  required_service_groups jsonb DEFAULT '[]'::jsonb,",
      "  min_booking_service_ids uuid[] DEFAULT '{}'::uuid[]",
      ');',
      'CREATE TRIGGER qa_event_guard BEFORE INSERT OR UPDATE ON event_tickets',
      'FOR EACH ROW EXECUTE FUNCTION public.validate_ticket_required_service_ids();',
      'INSERT INTO event_tickets DEFAULT VALUES;'
    ].join('\n'));
    await assert.rejects(db.exec(
      "INSERT INTO event_tickets(min_booking_service_ids) VALUES(ARRAY['@@BAD@@'::uuid])"
        .replace('@@BAD@@', invalidService)), /INVALID_BOOKING_AMOUNT_RULE/);

    await db.exec([
      'CREATE TEMP TABLE qa_tenant_reward(',
      "  required_service_ids uuid[] DEFAULT '{}'::uuid[],",
      "  required_service_groups jsonb DEFAULT '[]'::jsonb",
      ');',
      'CREATE TRIGGER qa_tenant_reward_guard BEFORE INSERT OR UPDATE ON qa_tenant_reward',
      'FOR EACH ROW EXECUTE FUNCTION ' + tenant + '.validate_ticket_required_service_ids();',
      'INSERT INTO qa_tenant_reward DEFAULT VALUES;'
    ].join('\n'));
    await assert.rejects(db.exec(
      "INSERT INTO qa_tenant_reward(required_service_ids) VALUES(ARRAY['@@BAD@@'::uuid])"
        .replace('@@BAD@@', invalidService)), /INVALID_REQUIRED_SERVICE_IDS/);

    await db.exec(guardFix); // should be safe for environments already patched
    const checks = await db.query(
      "SELECT n.nspname, position('if TG_TABLE_NAME = ''event_tickets'' then' in pg_get_functiondef(p.oid)) > 0 AS fixed " +
      "FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace " +
      "WHERE p.proname = 'validate_ticket_required_service_ids' AND n.nspname IN ('public', $1)", [tenant]);
    assert.equal(checks.rows.length, 2);
    assert.ok(checks.rows.every(row => row.fixed));
  } finally {
    await db.close();
  }
});

test('AC-006: new-business blueprint migration patches only the shared trigger and is idempotent', async () => {
  const db = new PGlite();
  try {
    await db.exec('CREATE SCHEMA platform_private; CREATE TABLE platform_private.business_templates(version text PRIMARY KEY, snapshot jsonb NOT NULL);');
    const snapshot = { functions: [
      { name: 'validate_ticket_required_service_ids', definition: originalGuard('public') },
      { name: 'unrelated_function', definition: 'SELECT 1' }
    ], tables: [{ name: 'point_cards', marker: 'preserve-me' }] };
    await db.query('INSERT INTO platform_private.business_templates(version,snapshot) VALUES($1,$2::jsonb)',
      ['business-v1-20261019', JSON.stringify(snapshot)]);
    await db.exec(blueprintFix);
    await db.exec(blueprintFix);
    const r = await db.query("SELECT snapshot FROM platform_private.business_templates WHERE version='business-v1-20261019'");
    const saved = r.rows[0].snapshot;
    assert.equal(saved.functions.length, 2);
    assert.equal(saved.functions[1].definition, 'SELECT 1');
    assert.deepEqual(saved.tables, snapshot.tables);
    assert.ok(saved.functions[0].definition.includes("if TG_TABLE_NAME = 'event_tickets' then"));
    assert.ok(!saved.functions[0].definition.includes("if TG_TABLE_NAME='event_tickets' and exists"));
  } finally {
    await db.close();
  }
});

