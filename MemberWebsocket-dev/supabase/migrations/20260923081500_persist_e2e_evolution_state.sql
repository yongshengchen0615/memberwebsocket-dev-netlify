create table if not exists public.e2e_evolution_state (
  id boolean primary key default true check (id = true),
  run_count bigint not null default 0 check (run_count >= 0),
  last_complexity_level integer not null default 0 check (last_complexity_level between 0 and 8),
  last_seed text not null default '',
  last_root_run_id text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.e2e_evolution_state enable row level security;
revoke all on table public.e2e_evolution_state from anon, authenticated;
grant select, insert, update on table public.e2e_evolution_state to service_role;

insert into public.e2e_evolution_state (id)
values (true)
on conflict (id) do nothing;

create or replace function public.admin_advance_e2e_evolution(
  p_seed text,
  p_complexity_level integer,
  p_root_run_id text
)
returns public.e2e_evolution_state
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.e2e_evolution_state;
  v_level integer := greatest(1, least(8, coalesce(p_complexity_level, 1)));
  v_seed text := left(coalesce(p_seed, ''), 160);
  v_root_run_id text := left(coalesce(p_root_run_id, ''), 80);
begin
  if v_root_run_id = '' then
    raise exception 'root run id is required';
  end if;

  insert into public.e2e_evolution_state (
    id, run_count, last_complexity_level, last_seed, last_root_run_id, updated_at
  )
  values (true, 1, v_level, v_seed, v_root_run_id, now())
  on conflict (id) do update
  set
    run_count = case
      when public.e2e_evolution_state.last_root_run_id = excluded.last_root_run_id
        then public.e2e_evolution_state.run_count
      else public.e2e_evolution_state.run_count + 1
    end,
    last_complexity_level = case
      when public.e2e_evolution_state.last_root_run_id = excluded.last_root_run_id
        then public.e2e_evolution_state.last_complexity_level
      else excluded.last_complexity_level
    end,
    last_seed = case
      when public.e2e_evolution_state.last_root_run_id = excluded.last_root_run_id
        then public.e2e_evolution_state.last_seed
      else excluded.last_seed
    end,
    last_root_run_id = excluded.last_root_run_id,
    updated_at = case
      when public.e2e_evolution_state.last_root_run_id = excluded.last_root_run_id
        then public.e2e_evolution_state.updated_at
      else now()
    end
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.admin_advance_e2e_evolution(text, integer, text) from public, anon, authenticated;
grant execute on function public.admin_advance_e2e_evolution(text, integer, text) to service_role;
