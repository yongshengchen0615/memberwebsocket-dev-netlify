-- Guard stored calendar integrations before scheduled fixed-ticket issuance.
-- Patch only the known issuance branch; preserve all other scheduler behavior.
do $migration$
declare definition text; previous text; replacement text;
begin
 select pg_get_functiondef('public.platform_tick_businesses()'::regprocedure) into definition;
 if position('fixed-ticket-calendar-dependency' in definition)>0 then return; end if;
 previous := 'if (t.features->>''events'')::boolean then execute format(''select %I.issue_fixed_tickets()'',t.runtime_schema); end if;';
 replacement := $patch$-- fixed-ticket-calendar-dependency
   if (t.features->>'events')::boolean then
    due:=false;
    if coalesce((t.features->>'calendar')::boolean,false)=false then
     execute format('select exists(select 1 from %I.fixed_ticket_templates where status=''active'' and calendar_enabled=true)',t.runtime_schema) into due;
    end if;
    if not due then execute format('select %I.issue_fixed_tickets()',t.runtime_schema); end if;
   end if;$patch$;
 if position(previous in definition)=0 then raise exception 'FIXED_TICKET_SCHEDULER_CONTRACT_CHANGED'; end if;
 execute replace(definition,previous,replacement);
end $migration$;
notify pgrst, 'reload schema';
