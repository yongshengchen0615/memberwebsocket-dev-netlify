// The dashboard reads several independent resources per refresh. The SQL
// limiter is shared by API endpoints within one tenant, so an authorized admin
// can legitimately exceed the member read budget while writes remain scarce.
// Only the trusted server-verified admin identity can use this bounded budget.
export const ADMIN_READ_REQUESTS_PER_MINUTE = 180;
const LINE_ADMIN_ACTOR = /^U[0-9a-f]{32}$/;

export function adminReadRateLimitParams(rpcName, params, verifiedAdminActor) {
  if (rpcName !== 'consume_api_rate_limit'
    || typeof verifiedAdminActor !== 'string'
    || !LINE_ADMIN_ACTOR.test(verifiedAdminActor)
    || !params || typeof params !== 'object' || Array.isArray(params)
    || params.p_is_write !== false
    || !Number.isSafeInteger(params.p_read_limit) || params.p_read_limit < 1) return params;
  return {
    ...params,
    p_read_limit: Math.max(params.p_read_limit, ADMIN_READ_REQUESTS_PER_MINUTE),
  };
}
