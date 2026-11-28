-- Presentation-only rename. Preserve general tier key, thresholds, and custom titles.
UPDATE public.membership_tier_settings
SET tier_label = '銅級會員'
WHERE tier_key = 'general'
  AND tier_label = '一般會員';
