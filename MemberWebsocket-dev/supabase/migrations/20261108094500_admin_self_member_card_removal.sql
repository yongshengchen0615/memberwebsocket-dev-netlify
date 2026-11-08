-- AC-001/002: an active administrator may remove only their own member-card data.
-- Their administrator role, activity audit, and privileged actor references must survive.
-- Other administrators remain protected; ordinary member removal is unchanged.
-- Update both the public template and existing business_<id> schemas in place.
-- Replacement is atomic and fails closed if an expected function contract has drifted.
do $member_removal_patch$
declare
  tenant record;
  fn_name text;
  fn_signature text;
  fn_oid oid;
  ddl text;
  item jsonb;
  patches jsonb;
  old_fragment text;
  new_fragment text;
  template_idx integer;
begin
  for tenant in
    select nspname from pg_namespace
    where nspname='public' or nspname ~ '^business_[a-f0-9]+
    foreach fn_name in array array['begin_member_removal','finish_member_removal'] loop
      fn_signature := case when fn_name='begin_member_removal' then '(text,text,text)' else '(text,uuid)' end;
      if tenant.nspname='__provisioning_snapshot__' then
        select (f.ordinality-1)::integer, f.value->>'definition'
          into template_idx, ddl
        from platform_private.business_templates t
        cross join lateral jsonb_array_elements(t.snapshot->'functions') with ordinality as f(value,ordinality)
        where t.version='business-v1-20261019' and f.value->>'name'=fn_name;
        if ddl is null then raise exception 'MISSING_MEMBER_REMOVAL_TEMPLATE: %',fn_name; end if;
      else
        fn_oid := to_regprocedure(format('%I.%I%s',tenant.nspname,fn_name,fn_signature));
        if fn_oid is null then
          if tenant.nspname='public' then raise exception 'MISSING_MEMBER_REMOVAL_FUNCTION: %.%',tenant.nspname,fn_name; end if;
          continue;
        end if;
        ddl := pg_get_functiondef(fn_oid);
      end if;
      patches := case when fn_name='begin_member_removal' then
        jsonb_build_array(
          jsonb_build_array('if p_actor=p_target or exists(select 1 from admins where line_user_id=p_target) then raise exception ''ADMIN_PROTECTED''; end if;', 'if p_actor<>p_target and exists(select 1 from admins where line_user_id=p_target) then raise exception ''ADMIN_PROTECTED''; end if;')
        ) else
        jsonb_build_array(
          jsonb_build_array('update point_entries set created_by=''removed-member'',note=''會員關聯已移除'',request_id=null where member_id<>m.id and (created_by=m.line_user_id or reference_id in (select transfer_id from point_transfers where sender_member_id is null or receiver_member_id is null));', 'update point_entries set created_by=''removed-member'',note=''會員關聯已移除'',request_id=null where member_id<>m.id and ((created_by=m.line_user_id and not exists(select 1 from admins where line_user_id=m.line_user_id)) or reference_id in (select transfer_id from point_transfers where sender_member_id is null or receiver_member_id is null));'),
          jsonb_build_array('update service_time_entries set created_by=''removed-member'',note=''會員關聯已移除'',request_id=null where member_id<>m.id and created_by=m.line_user_id;', 'update service_time_entries set created_by=''removed-member'',note=''會員關聯已移除'',request_id=null where member_id<>m.id and created_by=m.line_user_id and not exists(select 1 from admins where line_user_id=m.line_user_id);'),
          jsonb_build_array('delete from idempotency_results where actor_line_user_id=m.line_user_id or result::text like ''%''||m.line_user_id||''%'' or result::text like ''%''||m.id::text||''%'';', 'delete from idempotency_results where (not exists(select 1 from admins where line_user_id=m.line_user_id) and (actor_line_user_id=m.line_user_id or result::text like ''%''||m.line_user_id||''%'')) or result::text like ''%''||m.id::text||''%'';'),
          jsonb_build_array('delete from audit_logs where actor_line_user_id=m.line_user_id or target_id in (m.line_user_id,m.id::text,m.member_code) or detail::text like ''%''||m.line_user_id||''%'' or detail::text like ''%''||m.id::text||''%'' or detail::text like ''%''||m.member_code||''%'';', 'delete from audit_logs where ((not exists(select 1 from admins where line_user_id=m.line_user_id)) and (actor_line_user_id=m.line_user_id or target_id=m.line_user_id or detail::text like ''%''||m.line_user_id||''%'')) or target_id in (m.id::text,m.member_code) or detail::text like ''%''||m.id::text||''%'' or detail::text like ''%''||m.member_code||''%'';'),
          jsonb_build_array('delete from booking_audit_events where actor_line_user_id=m.line_user_id or target_id=m.id::text or target_id=any(bids::text[]) or metadata::text like ''%''||m.line_user_id||''%'' or metadata::text like ''%''||m.id::text||''%'';', 'delete from booking_audit_events where (not exists(select 1 from admins where line_user_id=m.line_user_id) and (actor_line_user_id=m.line_user_id or metadata::text like ''%''||m.line_user_id||''%'')) or target_id=m.id::text or target_id=any(bids::text[]) or metadata::text like ''%''||m.id::text||''%'';'),
          jsonb_build_array('delete from api_rate_limits where principal_hash=encode(extensions.digest(m.line_user_id,''sha256''),''hex'');', 'delete from api_rate_limits where principal_hash=encode(extensions.digest(m.line_user_id,''sha256''),''hex'') and not exists(select 1 from admins where line_user_id=m.line_user_id);'),
          jsonb_build_array('for r in select table_name,column_name from information_schema.columns where table_schema=''public'' and data_type=''text'' and column_name in (''created_by'',''updated_by'',''completed_by'',''confirmed_by'',''rejected_by'',''cancelled_by'',''redeemed_by'',''cancellation_requested_by'',''cancellation_reviewed_by'') loop', 'if not exists(select 1 from admins where line_user_id=m.line_user_id) then
 for r in select table_name,column_name from information_schema.columns where table_schema=current_schema() and data_type=''text'' and column_name in (''created_by'',''updated_by'',''completed_by'',''confirmed_by'',''rejected_by'',''cancelled_by'',''redeemed_by'',''cancellation_requested_by'',''cancellation_reviewed_by'') loop'),
          jsonb_build_array('execute format(''update public.%I set %I=$1 where %I=$2'',r.table_name,r.column_name,r.column_name) using ''removed-member'',m.line_user_id;
 end loop;', 'execute format(''update %I.%I set %I=$1 where %I=$2'',current_schema(),r.table_name,r.column_name,r.column_name) using ''removed-member'',m.line_user_id;
 end loop;
 end if;')
        ) end;
      for item in select value from jsonb_array_elements(patches) loop
        old_fragment := item->>0;
        new_fragment := item->>1;
        -- Existing tenants store a concrete schema in the historical dynamic actor scrub.
        -- Match that original shape, while the replacement uses the function search_path.
        if tenant.nspname<>'public' and tenant.nspname<>'__provisioning_snapshot__' then
          old_fragment := replace(old_fragment, 'table_schema=''public''', 'table_schema='''||tenant.nspname||'''');
          old_fragment := replace(old_fragment, 'update public.%I', 'update '||tenant.nspname||'.%I');
        end if;
        if strpos(ddl,old_fragment)=0 then
          raise exception 'MEMBER_REMOVAL_CONTRACT_DRIFT: %.% missing expected section',tenant.nspname,fn_name;
        end if;
        ddl := replace(ddl,old_fragment,new_fragment);
      end loop;
      if tenant.nspname='__provisioning_snapshot__' then
        update platform_private.business_templates
           set snapshot=jsonb_set(snapshot,array['functions',template_idx::text,'definition'],to_jsonb(ddl),false)
         where version='business-v1-20261019';
        if not found then raise exception 'MISSING_MEMBER_REMOVAL_TEMPLATE_VERSION'; end if;
      else
        execute ddl;
      end if;
    end loop;
  end loop;
end;
$member_removal_patch$;

    union all select '__provisioning_snapshot__' where to_regclass('platform_private.business_templates') is not null
  loop
    foreach fn_name in array array['begin_member_removal','finish_member_removal'] loop
      fn_signature := case when fn_name='begin_member_removal' then '(text,text,text)' else '(text,uuid)' end;
      fn_oid := to_regprocedure(format('%I.%I%s',tenant.nspname,fn_name,fn_signature));
      if fn_oid is null then
        if tenant.nspname='public' then raise exception 'MISSING_MEMBER_REMOVAL_FUNCTION: %.%',tenant.nspname,fn_name; end if;
        continue;
      end if;
      ddl := pg_get_functiondef(fn_oid);
      patches := case when fn_name='begin_member_removal' then
        jsonb_build_array(
          jsonb_build_array('if p_actor=p_target or exists(select 1 from admins where line_user_id=p_target) then raise exception ''ADMIN_PROTECTED''; end if;', 'if p_actor<>p_target and exists(select 1 from admins where line_user_id=p_target) then raise exception ''ADMIN_PROTECTED''; end if;')
        ) else
        jsonb_build_array(
          jsonb_build_array('update point_entries set created_by=''removed-member'',note=''會員關聯已移除'',request_id=null where member_id<>m.id and (created_by=m.line_user_id or reference_id in (select transfer_id from point_transfers where sender_member_id is null or receiver_member_id is null));', 'update point_entries set created_by=''removed-member'',note=''會員關聯已移除'',request_id=null where member_id<>m.id and ((created_by=m.line_user_id and not exists(select 1 from admins where line_user_id=m.line_user_id)) or reference_id in (select transfer_id from point_transfers where sender_member_id is null or receiver_member_id is null));'),
          jsonb_build_array('update service_time_entries set created_by=''removed-member'',note=''會員關聯已移除'',request_id=null where member_id<>m.id and created_by=m.line_user_id;', 'update service_time_entries set created_by=''removed-member'',note=''會員關聯已移除'',request_id=null where member_id<>m.id and created_by=m.line_user_id and not exists(select 1 from admins where line_user_id=m.line_user_id);'),
          jsonb_build_array('delete from idempotency_results where actor_line_user_id=m.line_user_id or result::text like ''%''||m.line_user_id||''%'' or result::text like ''%''||m.id::text||''%'';', 'delete from idempotency_results where (not exists(select 1 from admins where line_user_id=m.line_user_id) and (actor_line_user_id=m.line_user_id or result::text like ''%''||m.line_user_id||''%'')) or result::text like ''%''||m.id::text||''%'';'),
          jsonb_build_array('delete from audit_logs where actor_line_user_id=m.line_user_id or target_id in (m.line_user_id,m.id::text,m.member_code) or detail::text like ''%''||m.line_user_id||''%'' or detail::text like ''%''||m.id::text||''%'' or detail::text like ''%''||m.member_code||''%'';', 'delete from audit_logs where ((not exists(select 1 from admins where line_user_id=m.line_user_id)) and (actor_line_user_id=m.line_user_id or target_id=m.line_user_id or detail::text like ''%''||m.line_user_id||''%'')) or target_id in (m.id::text,m.member_code) or detail::text like ''%''||m.id::text||''%'' or detail::text like ''%''||m.member_code||''%'';'),
          jsonb_build_array('delete from booking_audit_events where actor_line_user_id=m.line_user_id or target_id=m.id::text or target_id=any(bids::text[]) or metadata::text like ''%''||m.line_user_id||''%'' or metadata::text like ''%''||m.id::text||''%'';', 'delete from booking_audit_events where (not exists(select 1 from admins where line_user_id=m.line_user_id) and (actor_line_user_id=m.line_user_id or metadata::text like ''%''||m.line_user_id||''%'')) or target_id=m.id::text or target_id=any(bids::text[]) or metadata::text like ''%''||m.id::text||''%'';'),
          jsonb_build_array('delete from api_rate_limits where principal_hash=encode(extensions.digest(m.line_user_id,''sha256''),''hex'');', 'delete from api_rate_limits where principal_hash=encode(extensions.digest(m.line_user_id,''sha256''),''hex'') and not exists(select 1 from admins where line_user_id=m.line_user_id);'),
          jsonb_build_array('for r in select table_name,column_name from information_schema.columns where table_schema=''public'' and data_type=''text'' and column_name in (''created_by'',''updated_by'',''completed_by'',''confirmed_by'',''rejected_by'',''cancelled_by'',''redeemed_by'',''cancellation_requested_by'',''cancellation_reviewed_by'') loop', 'if not exists(select 1 from admins where line_user_id=m.line_user_id) then
 for r in select table_name,column_name from information_schema.columns where table_schema=current_schema() and data_type=''text'' and column_name in (''created_by'',''updated_by'',''completed_by'',''confirmed_by'',''rejected_by'',''cancelled_by'',''redeemed_by'',''cancellation_requested_by'',''cancellation_reviewed_by'') loop'),
          jsonb_build_array('execute format(''update public.%I set %I=$1 where %I=$2'',r.table_name,r.column_name,r.column_name) using ''removed-member'',m.line_user_id;
 end loop;', 'execute format(''update %I.%I set %I=$1 where %I=$2'',current_schema(),r.table_name,r.column_name,r.column_name) using ''removed-member'',m.line_user_id;
 end loop;
 end if;')
        ) end;
      for item in select value from jsonb_array_elements(patches) loop
        old_fragment := item->>0;
        new_fragment := item->>1;
        -- Existing tenants store a concrete schema in the historical dynamic actor scrub.
        -- Match that original shape, while the replacement uses the function search_path.
        if tenant.nspname<>'public' then
          old_fragment := replace(old_fragment, 'table_schema=''public''', 'table_schema='''||tenant.nspname||'''');
          old_fragment := replace(old_fragment, 'update public.%I', 'update '||tenant.nspname||'.%I');
        end if;
        if strpos(ddl,old_fragment)=0 then
          raise exception 'MEMBER_REMOVAL_CONTRACT_DRIFT: %.% missing expected section',tenant.nspname,fn_name;
        end if;
        ddl := replace(ddl,old_fragment,new_fragment);
      end loop;
      execute ddl;
    end loop;
  end loop;
end;
$member_removal_patch$;
