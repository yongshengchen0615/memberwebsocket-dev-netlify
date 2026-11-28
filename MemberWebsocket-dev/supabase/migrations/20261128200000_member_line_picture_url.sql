-- LINE photos are populated from verified ID token claims on authenticated member login.
-- Existing members retain NULL until their next verified member request.
alter table public.members add column if not exists line_picture_url text;
