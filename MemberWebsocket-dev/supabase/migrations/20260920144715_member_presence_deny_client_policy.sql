create policy "member_presence_no_client_access"
on public.member_presence_sessions
for all
to anon, authenticated
using (false)
with check (false);
