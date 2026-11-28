-- Recurring ticket/calendar maintenance executes DML even with zero rows.
-- Statement triggers previously invalidated their views for these no-ops.
-- Transition tables retain one invalidation per statement/scope, while ignoring
-- zero-row operations and updates that only touch the bookkeeping timestamp.
create or replace function public.notify_effective_ticket_invalidation()
returns trigger language plpgsql security invoker set search_path='' as $$
declare changed boolean; prefix text; scopes text[];
begin
 if tg_op='INSERT' then
  select exists(select 1 from changed_new) into changed;
 elsif tg_op='DELETE' then
  select exists(select 1 from changed_old) into changed;
 else
  select exists(
   select 1 from changed_old o full join changed_new n using(id)
   where (to_jsonb(o)-'updated_at') is distinct from (to_jsonb(n)-'updated_at')
  ) into changed;
 end if;
 if not changed then return null;end if;
 prefix:=case when tg_table_name='event_ticket_claims' then 'member-record.db.' else 'admin.db.' end;
 scopes:=case when tg_table_name='calendar_items' then array['calendar','member','admin'] else array['event','admin'] end;
 perform public.emit_realtime_invalidation(scopes,prefix||tg_table_name||'.'||lower(tg_op));
 return null;
end $$;
revoke all on function public.notify_effective_ticket_invalidation() from public,anon,authenticated;
grant execute on function public.notify_effective_ticket_invalidation() to service_role;

do $install$
declare s text; definition text; item record; trigger_name text; operation text;
begin
 definition:=pg_get_functiondef('public.notify_effective_ticket_invalidation()'::regprocedure);
 for s in select 'public' union all select nspname from pg_namespace where nspname ~ '^business_[0-9a-f]{32}$'
 loop
  if s<>'public' then execute replace(definition,'public.',quote_ident(s)||'.');end if;
  execute format('revoke all on function %I.notify_effective_ticket_invalidation() from public,anon,authenticated',s);
  execute format('grant execute on function %I.notify_effective_ticket_invalidation() to service_role',s);
  for item in select * from (values
   ('event_tickets','realtime_event_tickets_change'),
   ('event_ticket_claims','realtime_event_ticket_claims_member_record_change'),
   ('calendar_items','realtime_calendar_items_change')
  ) names(table_name,base_name)
  loop
   if to_regclass(format('%I.%I',s,item.table_name)) is null then continue;end if;
   execute format('drop trigger if exists %I on %I.%I',item.base_name,s,item.table_name);
   foreach operation in array array['insert','update','delete'] loop
    trigger_name:=item.base_name||'_'||operation;
    execute format('drop trigger if exists %I on %I.%I',trigger_name,s,item.table_name);
    execute format('create trigger %I after %s on %I.%I referencing %s for each statement execute function %I.notify_effective_ticket_invalidation()',
     trigger_name,operation,s,item.table_name,
     case operation when 'insert' then 'new table as changed_new' when 'delete' then 'old table as changed_old' else 'old table as changed_old new table as changed_new' end,s);
   end loop;
  end loop;
 end loop;
end $install$;

-- Skip recurring UPSERT writes when the ticket fields already match, so a
-- maintenance pass also preserves the optimistic updated_at version used by
-- an editor. RETURNING is empty for a skipped conflict: read the existing row
-- for the unchanged grant/calendar logic instead of treating it as a new issue.
do $producer$
declare s text; definition text; rewritten text; anchor text; replacement text;
begin
 for s in select 'public' union all select nspname from pg_namespace where nspname ~ '^business_[0-9a-f]{32}$'
 loop
  if to_regprocedure(format('%I.issue_fixed_tickets(date,uuid,uuid)',s)) is null then continue;end if;
  definition:=pg_get_functiondef(to_regprocedure(format('%I.issue_fixed_tickets(date,uuid,uuid)',s)));
  if position('effective-ticket-upsert' in definition)>0 then continue;end if;
  rewritten:=replace(definition,format('insert into %I.event_tickets(',s),format('insert into %I.event_tickets as current_ticket(',s));
  anchor:=E'      deleted_at = null\n    returning * into v_event;';
  replacement:=E'      deleted_at = null\n    -- effective-ticket-upsert\n    where (current_ticket.title,current_ticket.description,current_ticket.usage_method,current_ticket.usage_instructions,current_ticket.status,current_ticket.starts_on,current_ticket.ends_on,current_ticket.quota,current_ticket.accent,current_ticket.allowed_tier_keys,current_ticket.deleted_at)\n      is distinct from\n      (excluded.title,excluded.description,excluded.usage_method,excluded.usage_instructions,excluded.status,excluded.starts_on,excluded.ends_on,excluded.quota,excluded.accent,excluded.allowed_tier_keys,excluded.deleted_at)\n    returning * into v_event;\n    if not found then\n      select * into v_event from '||quote_ident(s)||E'.event_tickets\n      where fixed_ticket_template_id=v_template.id and fixed_cycle_key=v_event_cycle_key;\n    end if;';
  if rewritten=definition or position(anchor in rewritten)=0 then raise exception 'FIXED_TICKET_UPSERT_CONTRACT_CHANGED: %',s;end if;
  execute replace(rewritten,anchor,replacement);
 end loop;
end $producer$;

-- Existing merchants and newly provisioned merchants must share the same rules.
do $template$
declare tpl jsonb; funcs jsonb; trgs jsonb; saved_path text:=current_setting('search_path');
begin
 if to_regclass('platform_private.business_templates') is null then return;end if;
 select snapshot into tpl from platform_private.business_templates where version='business-v1-20261019' for update;
 if tpl is null then raise exception 'BUSINESS_TEMPLATE_MISSING';end if;
 -- pg_get_triggerdef must qualify function names even when public is visible.
 -- Otherwise a future merchant's copied trigger could call the public emitter.
 perform set_config('search_path','',true);
 select coalesce(jsonb_agg(f.value order by f.ordinality),'[]'::jsonb) into funcs
 from jsonb_array_elements(tpl->'functions') with ordinality f(value,ordinality)
 where f.value->>'name'<>'notify_effective_ticket_invalidation';
 funcs:=funcs||jsonb_build_array(jsonb_build_object('name','notify_effective_ticket_invalidation',
  'definition',pg_get_functiondef('public.notify_effective_ticket_invalidation()'::regprocedure)));
 if to_regprocedure('public.issue_fixed_tickets(date,uuid,uuid)') is not null then
  select coalesce(jsonb_agg(case when f.value->>'name'='issue_fixed_tickets'
   then jsonb_set(f.value,'{definition}',to_jsonb(pg_get_functiondef('public.issue_fixed_tickets(date,uuid,uuid)'::regprocedure)))
   else f.value end order by f.ordinality),'[]'::jsonb) into funcs
  from jsonb_array_elements(funcs) with ordinality f(value,ordinality);
 end if;
 select coalesce(jsonb_agg(t.value order by t.ordinality),'[]'::jsonb) into trgs
 from jsonb_array_elements(tpl->'triggers') with ordinality t(value,ordinality)
 where t.value->>'name' not in ('realtime_event_tickets_change','realtime_event_ticket_claims_member_record_change','realtime_calendar_items_change')
  and t.value->>'name' not like 'realtime_event_tickets_change_%'
  and t.value->>'name' not like 'realtime_event_ticket_claims_member_record_change_%'
  and t.value->>'name' not like 'realtime_calendar_items_change_%';
 select trgs||coalesce(jsonb_agg(jsonb_build_object('name',t.tgname,'table',c.relname,
  'definition',pg_get_triggerdef(t.oid)) order by t.tgname),'[]'::jsonb) into trgs
 from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and not t.tgisinternal and t.tgfoid='public.notify_effective_ticket_invalidation()'::regprocedure;
 update platform_private.business_templates set snapshot=jsonb_set(jsonb_set(tpl,'{functions}',funcs),'{triggers}',trgs)
 where version='business-v1-20261019';
 perform set_config('search_path',saved_path,true);
end $template$;
notify pgrst,'reload schema';
