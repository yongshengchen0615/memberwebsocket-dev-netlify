// Bound background traffic separately from user-initiated changes.
// p_principal_hash must already be derived from server-verified identity.
// Never accept a principal or a rate category from untrusted request JSON.
const HASH = /^[a-f0-9]{64}$/i;
const PRESENCE = /^user\.(member|pointcard|event|calendar|booking)\.presence\.(online|offline|heartbeat)$/;
const SYNC = /^(admin\.sync\.status|user\.(member|points|event|calendar|booking)\.sync\.status)$/;
const SENSITIVE_WRITES = new Set([
  'admin.member.remove', 'admin.member.force-logout', 'admin.member.update',
  'admin.member-tiers.save', 'admin.terms.activate', 'admin.settings.copy',
  'admin.stamps.add', 'admin.service_minutes.add',
  'admin.member-grants.add', 'admin.service-grants.add',
  'admin.booking.status.complete', 'admin.booking.completed.correct',
  'admin.booking.receipt.register',
  'user.pointcard.ticket.redeem', 'user.event.ticket.redeem',
  'user.event.ticket.transfer',
]);

async function derivedHash(hash, category) {
  const bytes = new TextEncoder().encode(`api-rate-v2:${category}:${hash}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Preserve existing shared quotas for every unrecognized action. */
export async function partitionRateLimitParams(rpcName, params, action) {
  if (rpcName !== 'consume_api_rate_limit'
    || !params || typeof params !== 'object' || Array.isArray(params)
    || !HASH.test(params.p_principal_hash || '')
    || typeof params.p_is_write !== 'boolean'
    || !Number.isSafeInteger(params.p_cost) || params.p_cost < 1 || params.p_cost > 20
    || !Number.isSafeInteger(params.p_read_limit) || params.p_read_limit < 1
    || !Number.isSafeInteger(params.p_write_limit) || params.p_write_limit < 1
    || typeof action !== 'string') return params;

  let category;
  let changes;
  if (params.p_is_write && PRESENCE.test(action)) {
    category = 'presence';
    changes = { p_write_limit: 120 };
  } else if (!params.p_is_write && SYNC.test(action)) {
    category = 'sync';
    changes = { p_read_limit: Math.max(params.p_read_limit, 180) };
  } else if (params.p_is_write && SENSITIVE_WRITES.has(action)) {
    category = 'sensitive';
    changes = { p_write_limit: Math.min(params.p_write_limit, 12) };
  } else {
    return params;
  }
  return {
    ...params,
    ...changes,
    p_principal_hash: await derivedHash(params.p_principal_hash, category),
  };
}
