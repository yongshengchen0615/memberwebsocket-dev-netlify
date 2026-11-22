-- AC-ADM-FD-001..006: An admin walk-in rejection must not enqueue a
-- second "new booking" LINE notice to frontdesk. The rejection notice to the
-- member and frontdesk->admin review alerts are intentionally unchanged.
-- A frontdesk LINE deep link may inspect both sides of this *one* audited
-- admin replacement, without broadening the unscoped staff history.
--
-- All decisions use tenant-scoped audit records rather than editable notes.

create or replace function platform_private.admin_paired_walkin_source(
  p_schema text, p_booking jsonb
) returns uuid
language plpgsql security definer set search_path='' as $admin_pair$
declare v_original uuid;v_valid boolean;v_source text;
begin
 if p_schema !~ '^business_[0-9a-f]{32}$'
   or not exists(select 1 from platform_private.tenants where runtime_schema=p_schema)
 then return null;end if;
 if p_booking->>'status' not in ('pending','confirmed') then return null;end if;
 v_source:=substring(coalesce(p_booking->>'admin_note','') from
   '^原預約 ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) 拒絕後的現場／電話預約$');
 if v_source is null then return null;end if;
 v_original:=v_source::uuid;
 execute format($verify$
  select exists(
    select 1 from %1$I.bookings original
    join %1$I.booking_audit_events rejected
      on rejected.target_type='booking' and rejected.target_id=original.id::text
        and rejected.action='BOOKING_REJECTED'
        and rejected.actor_role='admin' and rejected.result='success'
        and rejected.actor_line_user_id=original.rejected_by
        and rejected.metadata->>'rejectionReason'='unrecorded_phone_booking'
    join %1$I.booking_audit_events replacement
      on replacement.target_type='booking' and replacement.target_id=$2::text
        and replacement.action='BOOKING_PHONE_CREATED'
        and replacement.actor_role='admin' and replacement.result='success'
        and replacement.actor_line_user_id=rejected.actor_line_user_id
        and replacement.created_at=rejected.created_at
    where original.id=$1 and original.id<>$2
      and original.status='rejected'
      and original.rejection_reason='unrecorded_phone_booking'
      and original.booking_date=$3
      and original.rejected_at=rejected.created_at
      and original.rejected_at<=$4
  )$verify$,p_schema)
 into v_valid using v_original,(p_booking->>'id')::uuid,
    (p_booking->>'booking_date')::date,
    (p_booking->>'created_at')::timestamptz;
 return case when v_valid then v_original else null end;
end $admin_pair$;
revoke all on function platform_private.admin_paired_walkin_source(text,jsonb)
  from public,anon,authenticated;

-- Keep the full existing trigger unchanged except for its paired-insert guard.
-- Fail closed on unexpected upstream changes instead of silently overriding
-- the multi-channel notification lifecycle.
do $patch_enqueue$
declare t record; d text;tpl jsonb;items jsonb:='[]'::jsonb;f jsonb;
 old_guard constant text:=$old$  if TG_OP = 'INSERT' and
     platform_private.frontdesk_paired_phone_source(TG_TABLE_SCHEMA,to_jsonb(NEW)) is not null
    then return null;end if;$old$;
 new_guard constant text:=$new$  if TG_OP = 'INSERT' and
     (platform_private.frontdesk_paired_phone_source(TG_TABLE_SCHEMA,to_jsonb(NEW)) is not null
       or platform_private.admin_paired_walkin_source(TG_TABLE_SCHEMA,to_jsonb(NEW)) is not null)
    then return null;end if;$new$;
 base_marker constant text:=$old$begin
  if TG_OP = 'INSERT' then$old$;
 base_guard constant text:=$new$begin
  if TG_OP = 'INSERT' and
     platform_private.admin_paired_walkin_source(TG_TABLE_SCHEMA,to_jsonb(NEW)) is not null
    then return null;end if;
  if TG_OP = 'INSERT' then$new$;
begin
 for t in select runtime_schema from platform_private.tenants where runtime_schema is not null loop
  select pg_get_functiondef(to_regprocedure(format('%I.notice_enqueue()',t.runtime_schema))) into strict d;
  if position(new_guard in d)=0 then
   if (length(d)-length(replace(d,old_guard,'')))<>length(old_guard)
    then raise exception 'ADMIN_FRONTDESK_NOTICE_TRIGGER_CONTRACT_CHANGED: %',t.runtime_schema;end if;
   execute replace(d,old_guard,new_guard);
  end if;
  -- Only unclaimed, unattempted legacy rows can be safely cancelled.
  -- Rows already attempted are not retroactively marked undelivered.
  execute format($cleanup$
   update %1$I.notice_outbox o
   set status='skipped',last_error='ADMIN_WALKIN_FRONTDESK_NOTICE_SUPPRESSED'
   from %1$I.bookings b
   where o.booking_id=b.id and o.channel='frontdesk'
     and o.event_key=b.id::text||':created'
     and o.status='pending' and o.attempt_count=0 and o.first_attempt_at is null
     and platform_private.admin_paired_walkin_source(%2$L,to_jsonb(b)) is not null
  $cleanup$,t.runtime_schema,t.runtime_schema);
 end loop;
 select snapshot into strict tpl from platform_private.business_templates
   where version='business-v1-20261019' for update;
 for f in select value from jsonb_array_elements(tpl->'functions') loop
  if f->>'name'='notice_enqueue' then
   d:=f->>'definition';
   if position('platform_private.admin_paired_walkin_source(TG_TABLE_SCHEMA' in d)=0 then
    if (length(d)-length(replace(d,base_marker,'')))<>length(base_marker)
     then raise exception 'ADMIN_FRONTDESK_NOTICE_TEMPLATE_CONTRACT_CHANGED';end if;
    d:=replace(d,base_marker,base_guard);
   end if;
   f:=jsonb_set(f,'{definition}',to_jsonb(d));
  end if;
  items:=items||jsonb_build_array(f);
 end loop;
 update platform_private.business_templates set snapshot=jsonb_set(tpl,'{functions}',items)
  where version='business-v1-20261019';
end $patch_enqueue$;

-- Preserve the LINE bookingId scoping at SQL, not only in the browser.
-- Unscoped history remains limited to the frontdesk staff member's own events.
-- Admin review can be viewed only when the authorized staff opens a specific
-- booking link. The paired replacement must have matching actor and audit time.
do $patch_history$
declare d text;old_history text;new_history text;history_start int;history_end int;
begin
 select pg_get_functiondef(
  'public.platform_frontdesk_request(uuid,text,text,timestamp with time zone,text,jsonb)'::regprocedure
 ) into strict d;
 history_start:=position('if p_action=''history'' then' in d);
 history_end:=position('if p_action=''bookings'' then' in d);
 if history_start=0 or history_end<=history_start
 then raise exception 'ADMIN_FRONTDESK_HISTORY_BRANCH_MISSING';end if;
 old_history:=substring(d from history_start for history_end-history_start);
 new_history:=old_history;
 if position('''actorRole'',e.actor_role' in old_history)>0 then return;end if;

 if position('''actionAt'',e.created_at,' in new_history)=0
 then raise exception 'ADMIN_FRONTDESK_HISTORY_FIELDS_CHANGED';end if;
 new_history:=replace(new_history,'''actionAt'',e.created_at,',
   '''actionAt'',e.created_at,''actorRole'',e.actor_role,');

 if position('select id,created_at,target_id,actor_line_user_id' in new_history)=0
 then raise exception 'ADMIN_FRONTDESK_HISTORY_PROJECTION_CHANGED';end if;
 new_history:=replace(new_history,'select id,created_at,target_id,actor_line_user_id',
  'select id,created_at,target_id,actor_line_user_id,actor_role');

 if position('where paired.actor_role=''frontdesk''' in new_history)=0
 then raise exception 'ADMIN_FRONTDESK_HISTORY_PAIR_CHANGED';end if;
 new_history:=replace(new_history,'where paired.actor_role=''frontdesk''',
  'where paired.actor_role=e.actor_role');

 if position('where actor_role=''frontdesk'' and action=''BOOKING_REJECTED''' in new_history)=0
 then raise exception 'ADMIN_FRONTDESK_HISTORY_ACTOR_CHANGED';end if;
 new_history:=replace(new_history,
  'where actor_role=''frontdesk'' and action=''BOOKING_REJECTED''',
  'where ((actor_role=''frontdesk'' and actor_line_user_id=$2) or (actor_role=''admin'' and $3::uuid is not null)) and action=''BOOKING_REJECTED''');

 if position(E'       and actor_line_user_id=$2\n       and ($3::uuid' in new_history)=0
 then raise exception 'ADMIN_FRONTDESK_HISTORY_SCOPE_CHANGED';end if;
 new_history:=replace(new_history,E'       and actor_line_user_id=$2\n       and ($3::uuid',
  E'       and ($3::uuid');

 if position('and b.id is not null' in new_history)=0
 then raise exception 'ADMIN_FRONTDESK_HISTORY_ORIGINAL_CHANGED';end if;
 new_history:=replace(new_history,'and b.id is not null',
   'and b.id is not null and b.rejected_by=e.actor_line_user_id'
   || E'\n         and b.rejection_reason=''unrecorded_phone_booking''');

 if new_history=old_history then raise exception 'ADMIN_FRONTDESK_HISTORY_NO_CHANGE';end if;
 execute replace(d,old_history,new_history);
end $patch_history$;

notify pgrst,'reload schema';
