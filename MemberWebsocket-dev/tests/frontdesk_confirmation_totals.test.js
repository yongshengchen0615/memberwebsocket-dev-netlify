const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const migration=fs.readFileSync(path.resolve(__dirname,'../supabase/migrations/20261120170000_frontdesk_confirm_line_individual_totals.sql'),'utf8');

test('AC-FD-NOTIFY-002: desk confirmation aggregates duration and money from immutable participant snapshots',()=>{
 assert.match(migration,/booking_participant_items bpi/);
 assert.match(migration,/bpi\.unit_duration_minutes\s*\*\s*greatest\(coalesce\(bpi\.quantity,1\),1\)/);
 assert.match(migration,/bpi\.unit_price_amount\s*\*\s*greatest\(coalesce\(bpi\.quantity,1\),1\)/);
 assert.match(migration,/E'\\n個別時間：'/);
 assert.match(migration,/E'\\n個別金額：NT\$'/);
 assert.match(migration,/to_char\(coalesce\(pi\.amount,0\),'FM999,999,999,990'\)/);
 assert.match(migration,/case when coalesce\(pi\.has_store_service,false\) then 0 else \$2 end/);
 assert.doesNotMatch(migration,/booking_services\s+(?:as\s+)?(?:bs|s)\b/i,'do not recompute from mutable service pricing');
});

test('AC-FD-NOTIFY-003: historical one-person bookings fall back to original booking item snapshots',()=>{
 assert.match(migration,/if notice_details is null then/);
 assert.match(migration,/from %1\$I\.booking_items bi/);
 assert.match(migration,/bi\.unit_duration_minutes\s*\*\s*greatest\(coalesce\(bi\.quantity,1\),1\)/);
 assert.match(migration,/bi\.unit_price_amount\s*\*\s*greatest\(coalesce\(bi\.quantity,1\),1\)/);
 assert.match(migration,/E'\\n個別時間：'/);
 assert.match(migration,/E'\\n個別金額：NT\$'/);
});

test('AC-FD-NOTIFY-004: retain LINE recipient authorization and transactional replay contract',()=>{
 assert.match(migration,/if p_body->>'status'='confirmed' then/);
 assert.match(migration,/notice_message:='【櫃檯確認預約】'/);
 assert.match(migration,/a\.status=''active'' and a\.role=''admin''/);
 assert.match(migration,/on conflict \(event_key,channel,recipient\) do nothing/);
 assert.match(migration,/'frontdesk\.confirmed:'\|\|rid::text/);
 assert.match(migration,/insert into platform_private\.requests\(request_id,actor,operation,payload_hash,result\)/);
 assert.doesNotMatch(migration,/grant\s+execute\s+on\s+function/i);
 assert.doesNotMatch(migration,/revoke\s+all\s+on/i);
});
