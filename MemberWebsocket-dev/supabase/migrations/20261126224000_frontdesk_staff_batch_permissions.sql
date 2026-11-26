-- AC-FD-BATCH-001..006: one merchant-authorized transaction for all edited staff.
-- Existing staff.save and staff.delete remain compatible; no production data reset.
do $patch_staff_batch$
declare d text; anchor text; code text;
begin
 select pg_get_functiondef('public.platform_frontdesk_admin(text,uuid,timestamptz,text,jsonb)'::regprocedure) into strict d;
 if position('''staff.batch''' in d)=0 then
  anchor:='''staff.save'',''staff.delete'')';
  if position(anchor in d)=0 then raise exception 'FRONTDESK_BATCH_ACTION_DRIFT';end if;
  d:=replace(d,anchor,'''staff.save'',''staff.delete'',''staff.batch'')');
 end if;
 if position('item jsonb;' in d)=0 then
  anchor:='high_duration integer;';
  if position(anchor in d)=0 then raise exception 'FRONTDESK_BATCH_DECLARE_DRIFT';end if;
  d:=replace(d,anchor,anchor||' item jsonb;');
 end if;
 anchor:='elsif p_action=''staff.save'' then';
 if position('elsif p_action=''staff.batch'' then' in d)=0 then
  if position(anchor in d)=0 then raise exception 'FRONTDESK_BATCH_BRANCH_DRIFT';end if;
  code:=$branch$
 elsif p_action='staff.batch' then
  if (p_body->>'expectedVersion')::integer is distinct from t.version then raise exception 'PLATFORM_CONFLICT';end if;
  if jsonb_typeof(p_body->'updates') is distinct from 'array'
   or jsonb_array_length(p_body->'updates') not between 1 and 100
  then raise exception 'PLATFORM_INVALID_INPUT';end if;
  if exists(select 1 from jsonb_array_elements(p_body->'updates') entry
   group by entry->>'staffId' having count(*)>1)
  then raise exception 'PLATFORM_INVALID_INPUT';end if;
  -- Lock rows in stable UUID order. A failure rolls back all prior updates,
  -- recipient synchronization, outbox skips and the audit event together.
  for item in select value from jsonb_array_elements(p_body->'updates') order by value->>'staffId' loop
   if jsonb_typeof(item) is distinct from 'object'
    or jsonb_typeof(item->'staffId') is distinct from 'string'
    or (item->>'staffId')!~'^[0-9a-fA-F-]{36}$'
    or jsonb_typeof(item->'expectedVersion') is distinct from 'number'
    or (item->>'expectedVersion')!~'^[0-9]{1,10}$'
    or coalesce(item->>'status','') not in ('approved','rejected','suspended')
    or coalesce(item->>'permissionMode','') not in ('notify_only','review')
    or jsonb_typeof(item->'allowNotificationToggle') is distinct from 'boolean'
   then raise exception 'PLATFORM_INVALID_INPUT';end if;
   select * into s from platform_private.frontdesk_staff
    where id=(item->>'staffId')::uuid and tenant_id=t.id for update;
   if not found then raise exception 'FRONTDESK_NOT_FOUND';end if;
   if s.version is distinct from (item->>'expectedVersion')::integer then raise exception 'PLATFORM_CONFLICT';end if;
   if item->>'status'='approved' and s.oa_verified_at is null then raise exception 'FRONTDESK_OA_REQUIRED';end if;
   update platform_private.frontdesk_staff set
    status=item->>'status',
    permission_mode=item->>'permissionMode',
    allow_notification_toggle=(item->>'allowNotificationToggle')::boolean,
    version=version+1,
    access_revoked_before=case when item->>'status'<>'approved' then clock_timestamp() else access_revoked_before end,
    reviewed_by=p_actor,reviewed_at=clock_timestamp(),updated_at=clock_timestamp()
    where id=s.id;
   if item->>'status'<>'approved' then
    execute format('update %I.notice_outbox set status=''skipped'',last_error=''FRONTDESK_ACCESS_REVOKED'' where channel=''frontdesk'' and recipient=$1 and status in (''pending'',''sending'')',t.runtime_schema)
     using s.line_user_id;
   end if;
  end loop;
$branch$;
  d:=replace(d,anchor,code||' '||anchor);
 end if;
 anchor:='jsonb_build_object(''staffId'',s.id,''status'',p_body->>''status'',''permissionMode'',p_body->>''permissionMode'',''result'',''success'')';
 if position('when p_action=''staff.batch'' then' in d)=0 then
  if position(anchor in d)=0 then raise exception 'FRONTDESK_BATCH_AUDIT_DRIFT';end if;
  d:=replace(d,anchor,'case when p_action=''staff.batch'' then jsonb_build_object(''updates'',p_body->''updates'',''result'',''success'') else '||anchor||' end');
 end if;
 execute d;
end $patch_staff_batch$;
