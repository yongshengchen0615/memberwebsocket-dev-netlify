create or replace function public.prevent_published_terms_edit()
returns trigger language plpgsql set search_path = '' as $$
begin
 if tg_op='DELETE' then raise exception 'TERMS_IMMUTABLE'; end if;
 if old.status <> 'draft' and (
    (old.status='active' and new.status not in ('active','archived'))
    or (old.status='archived' and new.status <> 'archived')
    or (new.version,new.title,new.summary,new.body,new.required,new.effective_at,
        new.reconsent_existing,new.activated_at,new.created_by,new.created_at)
       is distinct from
       (old.version,old.title,old.summary,old.body,old.required,old.effective_at,
        old.reconsent_existing,old.activated_at,old.created_by,old.created_at)
 ) then raise exception 'TERMS_IMMUTABLE'; end if;
 return new;
end $$;
