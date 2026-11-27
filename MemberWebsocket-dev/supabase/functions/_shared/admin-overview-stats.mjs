// A read-only summary scoped to the already authenticated business client.
// "In progress" means currently usable by date; "new points" means newly issued grants,
// not point transfer records (which do not increase the merchant's total points).
const PAGE_SIZE = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function checkedCount(result, name) {
  if (result.error) throw result.error;
  if (!Number.isSafeInteger(result.count) || result.count < 0) {
    throw new Error('ADMIN_OVERVIEW_COUNT_UNAVAILABLE: ' + name);
  }
  return result.count;
}

export async function loadAdminOverviewStats(supabase, today) {
  if (typeof today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    throw new Error('ADMIN_OVERVIEW_INVALID_DAY');
  }
  const midnight = new Date(today + 'T00:00:00+08:00');
  if (!Number.isFinite(midnight.getTime())) throw new Error('ADMIN_OVERVIEW_INVALID_DAY');
  const from = midnight.toISOString();
  const until = new Date(midnight.getTime() + DAY_MS).toISOString();

  const [members, activeMembers, cards, events] = await Promise.all([
    supabase.from('members').select('id', { count: 'exact', head: true }).eq('is_test_account', false),
    supabase.from('members').select('id', { count: 'exact', head: true }).eq('is_test_account', false).eq('status', 'active'),
    supabase.from('point_cards').select('id', { count: 'exact', head: true })
      .eq('status', 'active')
      .or('expiry_mode.is.null,expiry_mode.neq.date,expires_on.is.null,expires_on.gte.' + today),
    supabase.from('event_tickets').select('id', { count: 'exact', head: true })
      .eq('status', 'active')
      .is('deleted_at', null)
      .is('referral_source_event_ticket_id', null)
      .or('starts_on.is.null,starts_on.lte.' + today)
      .or('ends_on.is.null,ends_on.gte.' + today),
  ]);

  const memberCount = checkedCount(members, 'members');
  const activeMemberCount = checkedCount(activeMembers, 'active members');
  const activeCardCount = checkedCount(cards, 'point cards');
  const activeEventTicketCount = checkedCount(events, 'event tickets');

  // PostgREST does not guarantee SQL aggregates are enabled on the Data API.
  // Fetch the day's positive grant amounts in bounded pages, with stable ordering.
  // Never silently cap the number of grants at PostgREST's default row limit.
  let todayPoints = 0;
  let offset = 0;
  while (true) {
    const response = await supabase.from('point_entries')
      .select('amount')
      .eq('entry_type', 'grant')
      .gt('amount', 0)
      .gte('created_at', from)
      .lt('created_at', until)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (response.error) throw response.error;
    if (!Array.isArray(response.data)) throw new Error('ADMIN_OVERVIEW_POINTS_UNAVAILABLE');
    for (const item of response.data) {
      const amount = Number(item.amount);
      if (!Number.isSafeInteger(amount) || amount <= 0 || !Number.isSafeInteger(todayPoints + amount)) {
        throw new Error('ADMIN_OVERVIEW_POINTS_INVALID');
      }
      todayPoints += amount;
    }
    if (response.data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return { memberCount, activeMemberCount, activeCardCount, activeEventTicketCount, todayEntryCount: todayPoints };
}
