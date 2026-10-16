-- Seed the fixed membership tier model used by MemberWebsocket-dev.
-- These defaults match the existing admin UI and legacy MemberService definitions.
insert into public.membership_tier_settings
  (tier_key, tier_label, required_service_minutes, style_key, updated_by)
values
  ('general', '一般會員', 0, 'forest', 'system'),
  ('silver', '銀級會員', 600, 'ocean', 'system'),
  ('gold', '金級會員', 1800, 'gold', 'system'),
  ('platinum', '白金會員', 3600, 'platinum', 'system')
on conflict (tier_key) do nothing;
