import { tierVisibility, loadVisibilityPolicy } from "./tier-visibility.ts";
import type { SupabaseClient } from './business-runtime.ts';
import { loadLatestPointOffers, loadLatestEventOffers } from './latest-available-offers.ts';
import { isEligibleTierActivity } from './activity-eligibility.ts';
import { chooseBookingPointOffers } from './booking-point-offer-choice.ts';

export async function loadBookingBenefits(db: SupabaseClient, member: any, tier: string, today: string, currentBookingId = '') {
  // Member and tier are resolved by the authenticated handler, never the body.
  // Fixed-size batched reads; no ticket issuance, claim or redemption occurs here.
  const [allPointOffers, events, calendar, eventSettings, pointSettings, pendingPointSelections, pendingSnapshotReceipts] = await Promise.all([
    loadLatestPointOffers(db, String(member.id), true, true),
    loadLatestEventOffers(db, String(member.id), tier, true, true),
    db.from('calendar_items')
      .select('calendar_item_id,title,item_type,starts_on,ends_on,status,allowed_tier_keys,source_event_ticket_id,audience_type,audience_month')
      .eq('item_type', 'event').in('status', ['active', 'targeted'])
      .is('source_event_ticket_id', null).lte('starts_on', today)
      .order('starts_on', { ascending: true }),
    db.from('event_ticket_settings')
      .select('max_tickets_per_day')
      .eq('id', 1)
      .maybeSingle(),
    db.from('point_card_settings')
      .select('max_tickets_per_redemption')
      .eq('id', 1)
      .maybeSingle(),
    db.from('booking_benefit_selections')
      .select('booking_id,benefit_kind,benefit_ref')
      .eq('member_id', String(member.id))
      .eq('status', 'pending'),
    db.from('booking_receipts')
      .select('requested_benefits')
      .eq('member_id', String(member.id))
      .eq('submission_mode', 'accessible')
      .in('status', ['pending_upload', 'awaiting_review']),
  ]);
  if (calendar.error) throw calendar.error;
  if (eventSettings.error) throw eventSettings.error;
  if (pointSettings.error) throw pointSettings.error;
  if (pendingPointSelections.error) throw pendingPointSelections.error;
  if (pendingSnapshotReceipts.error) throw pendingSnapshotReceipts.error;
  // One visible reward per booking; reserve distinct physical IDs internally.
  const points = chooseBookingPointOffers(allPointOffers, pendingPointSelections.data || [], currentBookingId);
  const eventClaimsInSnapshots = new Set<string>(
    (pendingSnapshotReceipts.data || []).flatMap((receipt: any) =>
      Array.isArray(receipt.requested_benefits) ? receipt.requested_benefits : []
    ).filter((selection: any) => selection?.kind === 'event')
      .map((selection: any) => String(selection.id || '')).filter(Boolean)
  );
  const rawEventLimit = Number(eventSettings.data?.max_tickets_per_day ?? 1);
  const eventTicketMaxPerDay = Number.isInteger(rawEventLimit) && rawEventLimit >= 0 && rawEventLimit <= 50 ? rawEventLimit : 1;
  const rawPointLimit = Number(pointSettings.data?.max_tickets_per_redemption ?? 1);
  const pointTicketMaxPerRedemption = Number.isInteger(rawPointLimit) && rawPointLimit >= 0 && rawPointLimit <= 50 ? rawPointLimit : 1;
  // Ticket-backed calendar activities are represented by the canonical event
  // offer above, so expired/full/used tickets cannot reappear as activities.
  const pointCardIds = [...new Set(points.map((offer) => String(offer.pointCardId || '')).filter(Boolean))];
  const pendingPointTicketIds = [...new Set(
    (pendingPointSelections.data || []).filter((row: any) => row.benefit_kind === 'points').map((row: any) => String(row.benefit_ref || '')).filter(Boolean)
  )];
  const [pointBalancesResult, reservationTicketsResult] = await Promise.all([
    pointCardIds.length
      ? db.from('point_balances')
          .select('point_card_id,stamps')
          .eq('member_id', String(member.id))
          .in('point_card_id', pointCardIds)
      : Promise.resolve({ data: [], error: null }),
    pendingPointTicketIds.length
      ? db.from('point_tickets')
          .select('ticket_id,point_card_id,threshold_stamps')
          .eq('member_id', String(member.id))
          .in('ticket_id', pendingPointTicketIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (pointBalancesResult.error) throw pointBalancesResult.error;
  if (reservationTicketsResult.error) throw reservationTicketsResult.error;
  const pointBalanceByCard = new Map(
    (pointBalancesResult.data || []).map((row: any) => [String(row.point_card_id || ''), Math.max(0, Number(row.stamps || 0))])
  );
  const reservationBookingByTicket = new Map(
    (pendingPointSelections.data || []).filter((row: any) => row.benefit_kind === 'points').map((row: any) => [String(row.benefit_ref || ''), String(row.booking_id || '')])
  );
  const reservedPointsByCard = new Map<string, number>();
  const currentBookingReservedPointsByCard = new Map<string, number>();
  for (const ticket of reservationTicketsResult.data || []) {
    const cardId = String(ticket.point_card_id || '');
    const ticketId = String(ticket.ticket_id || '');
    const points = Math.max(0, Number(ticket.threshold_stamps || 0));
    if (!cardId || !ticketId || points <= 0) continue;
    reservedPointsByCard.set(cardId, Number(reservedPointsByCard.get(cardId) || 0) + points);
    if (currentBookingId && reservationBookingByTicket.get(ticketId) === currentBookingId) {
      currentBookingReservedPointsByCard.set(
        cardId,
        Number(currentBookingReservedPointsByCard.get(cardId) || 0) + points,
      );
    }
  }

  const requiredServiceIds = [...new Set([
    ...points.flatMap((offer) => Array.isArray(offer.requiredServiceIds) ? offer.requiredServiceIds : []),
    ...events.flatMap((offer) => Array.isArray(offer.requiredServiceIds) ? offer.requiredServiceIds : []),
  ].map((serviceId) => String(serviceId || '')).filter(Boolean))];
  const bookingServiceRows = requiredServiceIds.length
    ? await db.from('booking_services').select('id,title,service_type').is('deleted_at', null)
    : { data: [], error: null };
  if (bookingServiceRows.error) throw bookingServiceRows.error;
  const bookingServices = (bookingServiceRows.data || []).map((row: any) => ({
    serviceId: String(row.id || ''),
    title: String(row.title || '').trim(),
    serviceType: String(row.service_type || '').trim(),
  })).filter((service: any) => service.serviceId && service.title);
  const requiredServiceTitleById = new Map(
    bookingServices.map((service: any) => [service.serviceId, service.title])
  );
  const requiredServiceTitlesFor = (serviceIds: string[]) =>
    serviceIds.map((serviceId) => requiredServiceTitleById.get(String(serviceId || '')) || '').filter(Boolean);
  const requiredServiceRequirementLabelFor = (serviceIds: string[], matchMode: string) => {
    const selected = new Set(serviceIds.map((serviceId) => String(serviceId || '')).filter(Boolean));
    if (!selected.size) return '';

    const servicesByType = new Map<string, any[]>();
    for (const service of bookingServices) {
      if (!service.serviceType) continue;
      const group = servicesByType.get(service.serviceType) || [];
      group.push(service);
      servicesByType.set(service.serviceType, group);
    }

    const coveredIds = new Set<string>();
    const fullTypes: string[] = [];
    for (const [serviceType, group] of servicesByType) {
      if (group.length && group.every((service) => selected.has(service.serviceId))) {
        fullTypes.push(serviceType);
        group.forEach((service) => coveredIds.add(service.serviceId));
      }
    }

    const individualTitles = bookingServices
      .filter((service) => selected.has(service.serviceId) && !coveredIds.has(service.serviceId))
      .map((service) => service.title);
    individualTitles.push(...[...selected].filter((serviceId) =>
      !bookingServices.some((service) => service.serviceId === serviceId)
    ));

    const allRequired = matchMode === 'all';
    if (fullTypes.length && !individualTitles.length) {
      if (allRequired) {
        return fullTypes.length === 1
          ? `需預約「${fullTypes[0]}」項目類型的所有項目`
          : `需預約「${fullTypes.join('、')}」項目類型的所有項目`;
      }
      return fullTypes.length === 1
        ? `需預約「${fullTypes[0]}」項目類型`
        : `需預約「${fullTypes.join('、')}」其中一種項目類型`;
    }
    if (!fullTypes.length) {
      if (allRequired) return `需預約所有指定項目：「${individualTitles.join('、')}」`;
      return individualTitles.length === 1
        ? `需預約「${individualTitles[0]}」項目`
        : `需預約「${individualTitles.join('、')}」其中一個項目`;
    }
    const typePart = fullTypes.length === 1
      ? `「${fullTypes[0]}」項目類型`
      : `「${fullTypes.join('、')}」項目類型`;
    const itemPart = individualTitles.length === 1
      ? `「${individualTitles[0]}」項目`
      : `「${individualTitles.join('、')}」項目`;
    return allRequired
      ? `需預約 ${typePart}的所有項目，且需包含 ${itemPart}`
      : `需預約 ${typePart} 或 ${itemPart}`;
  };

  const visibilityPolicy=await loadVisibilityPolicy(db);
  const visibleEvents=events.filter(offer=>tierVisibility(offer.allowedTierKeys,tier,visibilityPolicy).visible);
  const activities = (calendar.data || []).filter((item: any) =>
    isEligibleTierActivity(item, tier, today, member.birthday, undefined, undefined, true) || (tierVisibility(item.allowed_tier_keys,tier,visibilityPolicy).visible && isEligibleTierActivity(item,(item.allowed_tier_keys||[])[0],today,member.birthday,undefined,undefined,true))
  ).slice(0, 8);
  return {
    asOf: new Date().toISOString(),
    eventTicketMaxPerDay,
    pointTicketMaxPerRedemption,
    items: [
      ...points.map((offer) => {
        const pointCardId = String(offer.pointCardId || '');
        const totalPointBalance = pointBalanceByCard.get(pointCardId) || 0;
        const reservedPointBalance = Math.max(0, Number(reservedPointsByCard.get(pointCardId) || 0));
        const currentBookingReserved = Math.max(0, Number(currentBookingReservedPointsByCard.get(pointCardId) || 0));
        const otherBookingReserved = Math.max(0, reservedPointBalance - currentBookingReserved);
        const pointBalance = Math.max(0, totalPointBalance - otherBookingReserved);
        const pointCost = Math.max(0, Number(offer.thresholdStamps || 0));
        const requiredServiceIds = Array.isArray(offer.requiredServiceIds) ? offer.requiredServiceIds : [];
        const requiredServiceMatchMode = offer.requiredServiceMatchMode === 'all' ? 'all' : 'any';
        const requiredServiceTitles = requiredServiceTitlesFor(requiredServiceIds);
        const requiredServiceRequirementLabel = requiredServiceRequirementLabelFor(requiredServiceIds, requiredServiceMatchMode);
        const ticketId = String(offer.ticketId || '');
        const reservationBookingId = ticketId ? String(reservationBookingByTicket.get(ticketId) || '') : '';
        const reservedForOtherBooking = Boolean(reservationBookingId && reservationBookingId !== currentBookingId);
        const reservedForCurrentBooking = Boolean(reservationBookingId && reservationBookingId === currentBookingId);
        const hasTicket = Boolean(ticketId);
        const locationRestricted = offer.requiresLocation === true;
        const hasEnoughPoints = pointCost > 0 && pointBalance >= pointCost;
        return {
          kind: 'points', id: offer.rewardId, title: offer.ticketTitle,
          subtitle: `${offer.cardTitle} · 消耗 ${pointCost} 點`,
          statusLabel: !hasEnoughPoints ? '點數不足' : reservedForOtherBooking ? '已預約使用' : locationRestricted ? '可預約選用' : '可使用',
          startsOn: '', endsOn: offer.expiresOn, cardId: offer.cardId, cardTitle: offer.cardTitle, cardStyleKey: offer.styleKey,
          pointCost, pointBalance, totalPointBalance, reservedPointBalance, otherBookingReserved,
          requiredServiceIds, requiredServiceMatchMode, requiredServiceTitles, requiredServiceRequirementLabel,
          reservedForBooking: Boolean(reservationBookingId),
          reservedForCurrentBooking,
          requiresLocation: locationRestricted,
          // Booking selection records intent; only direct ticket redemption requires GPS.
          selectable: hasTicket && hasEnoughPoints && !reservedForOtherBooking, selectionId: offer.ticketId,
          conditionLabel: `${requiredServiceRequirementLabel ? `預約項目限制：${requiredServiceRequirementLabel} · ` : '預約項目限制：不限 · '}本卡可用 ${pointBalance} 點${otherBookingReserved > 0 ? ` · 其他預約已保留 ${otherBookingReserved} 點` : ''} · 此票券需 ${pointCost} 點 · ${pointTicketMaxPerRedemption === 0 ? '單次預約使用張數不限' : `單次預約最多使用 ${pointTicketMaxPerRedemption} 張`}${locationRestricted ? ' · 現場單獨使用需 GPS 定位' : ''}`,
          disabledReason: !hasTicket
            ? '目前沒有可核銷的票券'
            : !hasEnoughPoints
              ? `可用點數不足：目前可用 ${pointBalance} 點，此票券需要 ${pointCost} 點`
              : reservedForOtherBooking
                ? '此優惠目前已由其他預約保留，請稍後重新整理'
                : '',
        };
      }),
      ...visibleEvents.map((offer) => {
        const reserved = (pendingPointSelections.data || []).find((row: any) => row.benefit_kind === 'event' && row.benefit_ref === offer.claimId);
        const reservedForOtherBooking = Boolean(reserved && reserved.booking_id !== currentBookingId);
        const reservedInSnapshot = Boolean(offer.claimId && eventClaimsInSnapshots.has(String(offer.claimId)));
        const visibility=tierVisibility(offer.allowedTierKeys,tier,visibilityPolicy);
        const requiredServiceIds = Array.isArray(offer.requiredServiceIds) ? offer.requiredServiceIds : [];
        const requiredServiceMatchMode = offer.requiredServiceMatchMode === 'all' ? 'all' : 'any';
        const requiredServiceTitles = requiredServiceTitlesFor(requiredServiceIds);
        const requiredServiceRequirementLabel = requiredServiceRequirementLabelFor(requiredServiceIds, requiredServiceMatchMode);
        return {
          kind: 'event', id: offer.eventTicketId, title: offer.title,
          description: offer.description, accent: offer.accent, ticketType: offer.ticketType, quota: offer.quota, claimedCount: offer.claimedCount,
          allowedTierKeys: offer.allowedTierKeys, fixedTicketTemplateId: offer.fixedTicketTemplateId,
          subtitle: visibility.locked ? visibility.lockReason : offer.claimed ? '已領取，尚未使用' : '尚未領取；勾選即代表領取',
          statusLabel: visibility.locked ? '需升級' : reservedForOtherBooking ? '已預約使用，不能重複登記' : reservedInSnapshot ? '快照待審核，不能重複登記' : offer.claimed ? '可使用' : '可勾選並領取', startsOn: offer.startsOn, endsOn: offer.endsOn,
          requiresLocation: offer.requiresLocation === true,
          selectable: visibility.tierEligible && !reservedForOtherBooking && !reservedInSnapshot,
          reservedForBooking: Boolean(reserved), reservedForCurrentBooking: Boolean(reserved && !reservedForOtherBooking), reservedInSnapshot,
          locked:visibility.locked,
          selectionId: offer.claimId || '',
          claimRequired: visibility.tierEligible && !offer.claimed,
          requiredServiceIds, requiredServiceMatchMode, requiredServiceTitles, requiredServiceRequirementLabel,
          conditionLabel: `${eventTicketMaxPerDay === 0 ? '每日使用張數不限' : `每日最多使用 ${eventTicketMaxPerDay} 張`} · ${requiredServiceRequirementLabel ? `預約項目限制：${requiredServiceRequirementLabel}` : '預約項目限制：不限'}${offer.requiresLocation === true ? ' · 現場單獨使用需 GPS 定位' : ''}`,
          disabledReason: visibility.locked ? visibility.lockReason : reservedForOtherBooking ? '此票券已在一般預約登記，不能重複登記。' : reservedInSnapshot ? '此票券已在快照模式登記，待審核期間不能重複登記。' : '',
        };
      }),
      ...activities.map((item: any) => ({
        kind: 'calendar', id: item.calendar_item_id, title: item.title,
        subtitle: tierVisibility(item.allowed_tier_keys,tier,visibilityPolicy).lockReason || '適用於目前會員階級', statusLabel: tierVisibility(item.allowed_tier_keys,tier,visibilityPolicy).locked ? '需升級' : '活動進行中',
        startsOn: item.starts_on || '', endsOn: item.ends_on || item.starts_on || '',
        selectable: false, selectionId: '',
        conditionLabel: '會員條件：目前會員階級適用 · 活動資訊僅供預約參考',
        disabledReason: '',
      })),
    ],
  };
}
