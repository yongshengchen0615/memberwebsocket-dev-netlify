-- Extend gift ownership to isolated merchant schemas and the provisioner blueprint.
-- The public migration must precede this file. No membership or entitlement data is changed.
begin;
do $migration$
declare
  s text;
  ddl text;
  fn record;
  tpl jsonb;
  table_columns jsonb;
  tpl_tables jsonb;
  tpl_functions jsonb;
  tpl_indexes jsonb;
  tpl_constraints jsonb;
  tpl_triggers jsonb;
begin
  if to_regclass('public.event_ticket_transfers') is null
    or to_regprocedure('public.transfer_event_ticket_to_friend(text,text,text,text)') is null
    or to_regprocedure('public.prevent_event_ticket_reclaim_after_transfer()') is null
  then raise exception 'EVENT_TICKET_TRANSFER_BASE_MIGRATION_REQUIRED'; end if;

  for s in
    select nspname from pg_namespace
    where nspname ~ '^business_[0-9a-f]{32}$'
    order by nspname
  loop
    if to_regclass(format('%I.event_ticket_claims',s)) is null
      or to_regclass(format('%I.event_tickets',s)) is null
      or to_regclass(format('%I.members',s)) is null
      or to_regclass(format('%I.member_friendships',s)) is null
    then raise exception 'EVENT_TICKET_TRANSFER_TENANT_SCHEMA_INCOMPLETE: %',s; end if;

    execute format($table$
      create table if not exists %1$I.event_ticket_transfers (
        id uuid primary key default gen_random_uuid(),
        event_ticket_id uuid not null references %1$I.event_tickets(id) on delete cascade,
        claim_id text not null,
        sender_member_id uuid references %1$I.members(id) on delete set null,
        receiver_member_id uuid references %1$I.members(id) on delete set null,
        request_id text not null check (length(btrim(request_id)) between 8 and 120),
        created_at timestamptz not null default now(),
        unique(sender_member_id,request_id)
      )
    $table$,s);
    execute format('create index if not exists event_ticket_transfers_sender_history_idx on %I.event_ticket_transfers(event_ticket_id,sender_member_id)',s);
    execute format('create index if not exists event_ticket_transfers_receiver_history_idx on %I.event_ticket_transfers(event_ticket_id,receiver_member_id)',s);
    execute format('alter table %I.event_ticket_transfers enable row level security',s);
    execute format('revoke all on %I.event_ticket_transfers from public,anon,authenticated',s);
    execute format('grant select on %I.event_ticket_transfers to service_role',s);

    -- pg_get_functiondef returns the canonical body, including all rowtypes,
    -- security attributes and dependencies. Retarget only the trusted schema.
    for fn in
      select p.proname, pg_get_functiondef(p.oid) as definition
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public'
        and p.proname in (
          'transfer_event_ticket_to_friend',
          'prevent_event_ticket_reclaim_after_transfer'
        )
      order by p.proname
    loop
      ddl:=replace(fn.definition,'public.',format('%I.',s));
      execute ddl;
    end loop;
    if to_regprocedure(format('%I.transfer_event_ticket_to_friend(text,text,text,text)',s)) is null
      or to_regprocedure(format('%I.prevent_event_ticket_reclaim_after_transfer()',s)) is null
    then raise exception 'EVENT_TICKET_TRANSFER_TENANT_FUNCTION_MISSING: %',s; end if;

    execute format('drop trigger if exists prevent_event_ticket_reclaim_after_transfer on %I.event_ticket_claims',s);
    execute format('create trigger prevent_event_ticket_reclaim_after_transfer before insert on %1$I.event_ticket_claims for each row execute function %1$I.prevent_event_ticket_reclaim_after_transfer()',s);
    execute format('revoke all on function %I.prevent_event_ticket_reclaim_after_transfer() from public,anon,authenticated',s);
    execute format('revoke all on function %I.transfer_event_ticket_to_friend(text,text,text,text) from public,anon,authenticated',s);
    execute format('grant execute on function %I.transfer_event_ticket_to_friend(text,text,text,text) to service_role',s);
  end loop;

  -- The provisioner clones a versioned JSON catalog, not current public DDL.
  -- Add all five dependent object types for merchants created after this release.
  if to_regclass('platform_private.business_templates') is not null then
    select snapshot into tpl
    from platform_private.business_templates
    where version='business-v1-20261019'
    for update;
    if tpl is null then raise exception 'BUSINESS_TEMPLATE_MISSING'; end if;

    select jsonb_agg(jsonb_build_object(
      'name',a.attname,
      'type',format_type(a.atttypid,a.atttypmod),
      'default',pg_get_expr(d.adbin,d.adrelid),
      'notNull',a.attnotnull,
      'identity',a.attidentity::text,
      'generated',a.attgenerated::text
    ) order by a.attnum) into table_columns
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
    left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
    where n.nspname='public' and c.relname='event_ticket_transfers';
    if table_columns is null then raise exception 'EVENT_TICKET_TRANSFER_TEMPLATE_COLUMNS_MISSING'; end if;

    select coalesce(jsonb_agg(t order by ordinal),'[]'::jsonb) into tpl_tables
    from jsonb_array_elements(tpl->'tables') with ordinality x(t,ordinal)
    where t->>'name'<>'event_ticket_transfers';
    tpl:=jsonb_set(tpl,'{tables}',
      tpl_tables||jsonb_build_array(jsonb_build_object('name','event_ticket_transfers','columns',table_columns)));

    select coalesce(jsonb_agg(f order by ordinal),'[]'::jsonb) into tpl_functions
    from jsonb_array_elements(tpl->'functions') with ordinality x(f,ordinal)
    where f->>'name' not in ('transfer_event_ticket_to_friend','prevent_event_ticket_reclaim_after_transfer');
    select tpl_functions || coalesce(jsonb_agg(
      jsonb_build_object('name',p.proname,'definition',pg_get_functiondef(p.oid))
      order by p.proname
    ),'[]'::jsonb) into tpl_functions
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in (
      'transfer_event_ticket_to_friend','prevent_event_ticket_reclaim_after_transfer'
    );
    tpl:=jsonb_set(tpl,'{functions}',tpl_functions);

    select coalesce(jsonb_agg(i order by ordinal),'[]'::jsonb) into tpl_indexes
    from jsonb_array_elements(tpl->'indexes') with ordinality x(i,ordinal)
    where i->>'table'<>'event_ticket_transfers';
    select tpl_indexes || coalesce(jsonb_agg(
      jsonb_build_object('table','event_ticket_transfers','definition',pg_get_indexdef(i.indexrelid))
      order by ic.relname
    ),'[]'::jsonb) into tpl_indexes
    from pg_index i join pg_class t on t.oid=i.indrelid
    join pg_namespace n on n.oid=t.relnamespace
    join pg_class ic on ic.oid=i.indexrelid
    where n.nspname='public' and t.relname='event_ticket_transfers'
      and not exists (select 1 from pg_constraint c where c.conindid=i.indexrelid);
    tpl:=jsonb_set(tpl,'{indexes}',tpl_indexes);

    select coalesce(jsonb_agg(c order by ordinal),'[]'::jsonb) into tpl_constraints
    from jsonb_array_elements(tpl->'constraints') with ordinality x(c,ordinal)
    where c->>'table'<>'event_ticket_transfers';
    select tpl_constraints || coalesce(jsonb_agg(jsonb_build_object(
      'table','event_ticket_transfers','name',c.conname,
      'type',c.contype,'definition',pg_get_constraintdef(c.oid)
    ) order by c.conname),'[]'::jsonb) into tpl_constraints
    from pg_constraint c join pg_class t on t.oid=c.conrelid
    join pg_namespace n on n.oid=t.relnamespace
    where n.nspname='public' and t.relname='event_ticket_transfers';
    tpl:=jsonb_set(tpl,'{constraints}',tpl_constraints);

    select coalesce(jsonb_agg(t order by ordinal),'[]'::jsonb) into tpl_triggers
    from jsonb_array_elements(tpl->'triggers') with ordinality x(t,ordinal)
    where t->>'name'<>'prevent_event_ticket_reclaim_after_transfer';
    select tpl_triggers || coalesce(jsonb_agg(jsonb_build_object(
      'name',t.tgname,'table','event_ticket_claims','definition',pg_get_triggerdef(t.oid)
    )),'[]'::jsonb) into tpl_triggers
    from pg_trigger t join pg_class c on c.oid=t.tgrelid
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname='event_ticket_claims'
      and t.tgname='prevent_event_ticket_reclaim_after_transfer' and not t.tgisinternal;
    tpl:=jsonb_set(tpl,'{triggers}',tpl_triggers);

    update platform_private.business_templates
      set snapshot=tpl where version='business-v1-20261019';
  end if;
end;
$migration$;
notify pgrst,'reload schema';
commit;
