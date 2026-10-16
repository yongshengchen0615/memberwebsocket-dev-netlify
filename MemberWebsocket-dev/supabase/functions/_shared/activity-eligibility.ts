const TIER_KEYS = ['general', 'silver', 'gold', 'platinum'];

// Shared by booking recommendations and confirmation notifications. Capacity
// applies to unclaimed offers; ownership/use checks remain in the ticket service.
export function isEligibleTierActivity(
  item: any, tier: string, today: string, birthday: unknown,
  sourceEvents: Map<string, any> = new Map(), counts: Map<string, number> = new Map(),
  requireStarted = false,
): boolean {
  if (!item || item.item_type !== 'event') return false;
  const audience = String(item.audience_type || 'all');
  if (audience === 'birthday_month') {
    const date = String(birthday || '');
    const month = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Number(date.slice(5, 7)) : 0;
    if (item.status !== 'targeted' || month < 1 || month > 12 || Number(item.audience_month) !== month) return false;
  } else if (item.status !== 'active') return false;
  const tiers = Array.isArray(item.allowed_tier_keys) ? item.allowed_tier_keys.filter((key: string) => TIER_KEYS.includes(key)) : [];
  if (tiers.length && !tiers.includes(tier)) return false;
  if (requireStarted && item.starts_on && String(item.starts_on) > today) return false;
  const end = String(item.ends_on || item.starts_on || '');
  if (end && end < today) return false;
  if (item.source_event_ticket_id) {
    const sourceId = String(item.source_event_ticket_id);
    const event = sourceEvents.get(sourceId);
    if (!event || event.status !== 'active' || event.deleted_at) return false;
    if (requireStarted && event.starts_on && String(event.starts_on) > today) return false;
    if (event.ends_on && String(event.ends_on) < today) return false;
    if (!Array.isArray(event.allowed_tier_keys) || !event.allowed_tier_keys.includes(tier)) return false;
    if (Number(event.quota || 0) > 0 && (counts.get(sourceId) || 0) >= Number(event.quota)) return false;
  }
  return true;
}
