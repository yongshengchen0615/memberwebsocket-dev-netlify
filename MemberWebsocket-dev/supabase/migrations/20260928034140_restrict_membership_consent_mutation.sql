-- Default Data API grants may include DELETE for service_role; consent history is append-only.
revoke update, delete on public.membership_consents from service_role;
