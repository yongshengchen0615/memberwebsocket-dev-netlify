-- Allow an unstarted PENDING or CONFIRMED future general booking to keep its
-- own reserved point-ticket benefit while independently funded snapshot usage
-- redeems the original issued ticket. No other statuses are eligible.
-- Existing approval transaction must still rebind the future booking atomically.
begin;
do $migration$
declare
  v_definition text;
  v_old text;
  v_new text;
begin
  select pg_get_functiondef('public.validate_snapshot_ticket_selection(uuid,uuid,jsonb,text)'::regprocedure)
    into v_definition;
  v_old := 'future.status<>''confirmed''';
  v_new := 'future.status not in (''pending'',''confirmed'')';
  if v_definition is null or (length(v_definition)-length(replace(v_definition,v_old,''))) <> length(v_old) then
    raise exception 'SNAPSHOT_PENDING_VALIDATOR_SOURCE_CHANGED';
  end if;
  execute replace(v_definition,v_old,v_new);

  select pg_get_functiondef('public.register_snapshot_receipt_v2(text,timestamptz,text,uuid,date,time,jsonb,jsonb,text)'::regprocedure)
    into v_definition;
  v_old := 'b.status=''confirmed'' and b.completed_at is null';
  v_new := 'b.status in (''pending'',''confirmed'') and b.completed_at is null';
  if v_definition is null or (length(v_definition)-length(replace(v_definition,v_old,''))) <> length(v_old) then
    raise exception 'SNAPSHOT_PENDING_REBIND_SOURCE_CHANGED';
  end if;
  execute replace(v_definition,v_old,v_new);
end
$migration$;
commit;
