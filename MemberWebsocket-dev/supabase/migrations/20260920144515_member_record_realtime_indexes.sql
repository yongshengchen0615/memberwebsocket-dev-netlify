create index if not exists audit_logs_target_created_idx
  on public.audit_logs (target_type, target_id, created_at desc);
