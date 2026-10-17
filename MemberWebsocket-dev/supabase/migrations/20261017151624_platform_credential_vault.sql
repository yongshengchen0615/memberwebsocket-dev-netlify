-- Provision a stable encrypted key without writing plaintext to migration files.
-- An explicit Edge environment key continues to take precedence.
begin;
do $$ begin
  if not exists (select 1 from vault.secrets where name='platform_credential_encryption_v1') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32),'base64'),
      'platform_credential_encryption_v1','Platform merchant credential encryption key v1');
  end if;
end $$;
create function public.platform_credential_key() returns text
language sql stable security invoker set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name='platform_credential_encryption_v1'
$$;
revoke all on function public.platform_credential_key() from public,anon,authenticated;
grant execute on function public.platform_credential_key() to service_role;
commit;
