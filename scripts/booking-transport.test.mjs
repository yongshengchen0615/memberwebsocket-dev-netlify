import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingTransportSQL } from './booking-transport.mjs';

test('AC-BN-001: only the development release can restore its own tenant dispatcher',()=>{
 const sql=bookingTransportSQL('Integrated-Marketing-Platform','bmwhojszsnxliekkhrka');
 assert.match(sql,/https:\/\/bmwhojszsnxliekkhrka\.supabase\.co/);
 for(const [branch,ref] of [
  ['master','dbuquirnaskrwcamdxki'],
  ['Integrated-Marketing-Platform','dbuquirnaskrwcamdxki'],
  ['main','bmwhojszsnxliekkhrka'],
  ['Integrated-Marketing-Platform','unknown']
 ])assert.throws(()=>bookingTransportSQL(branch,ref),/BOOKING_TRANSPORT_BRANCH_NOT_ALLOWED/);
});
test('AC-BN-002: restore preserves existing credentials and cannot overwrite a mismatched project',()=>{
 const sql=bookingTransportSQL('Integrated-Marketing-Platform','bmwhojszsnxliekkhrka');
 assert.match(sql,/BOOKING_DISPATCH_PROJECT_URL_MISMATCH/);
 assert.match(sql,/BOOKING_DISPATCH_PROJECT_URL_DUPLICATE/);
 assert.match(sql,/BOOKING_DISPATCH_SECRET_DUPLICATE/);
 assert.match(sql,/BOOKING_DISPATCH_SECRET_INVALID/);
 assert.match(sql,/gen_random_bytes\(32\)/);
 assert.match(sql,/v_secret_count=0 THEN/);
 assert.doesNotMatch(sql,/vault\.update_secret|vault\.delete_secret|vault\.delete_secrets|vault\.update_secrets/);
 assert.doesNotMatch(sql,/decrypted_secret\s+AS\s+ready|SELECT\s+decrypted_secret\s*;/i);
});
test('AC-BN-003: only tenant-aware runtime is restored; legacy/public schedules remain untouched',()=>{
 const sql=bookingTransportSQL('Integrated-Marketing-Platform','bmwhojszsnxliekkhrka');
 assert.match(sql,/platform-business-runtime/g);
 assert.match(sql,/platform_tick_businesses\(\)/g);
 assert.match(sql,/cron\.alter_job\(job_id := v_job\.jobid, active := true\)/);
 assert.match(sql,/BOOKING_DISPATCH_JOB_CHANGED/);
 assert.doesNotMatch(sql,/cron\.unschedule|cron\.schedule\('dispatch-booking-line-notifications'/);
 assert.match(sql,/SELECT\s*\([\s\S]*\)\s+AS ready;/);
});
