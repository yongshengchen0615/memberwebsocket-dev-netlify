// Business access and verified LINE token freshness are independent of grants.
export function normalizeExpiry(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)
    || !Number.isFinite(Date.parse(value)) || !Number.isFinite(Date.parse(value.slice(0,10)+'T00:00:00Z'))
    || new Date(value.slice(0,10)+'T00:00:00Z').toISOString().slice(0,10)!==value.slice(0,10))
    throw new TypeError('Invalid expiry');
  return new Date(value).toISOString();
}
export function tenantExpired(tenant, now = Date.now()) {
  if (!tenant?.expires_at) return false;
  const expiry = Date.parse(tenant.expires_at);
  return !Number.isFinite(expiry) || expiry <= now;
}
export function assertTenantIdentity(tenant, identity) {
  const cutoff = Date.parse(tenant?.access_revoked_before || '');
  if (Number.isFinite(cutoff) && (!Number.isFinite(identity?.issuedAtMs) || identity.issuedAtMs <= cutoff))
    throw Object.assign(new Error('使用資格曾被停用，請重新使用 LINE 登入。'), {status:401,code:'TENANT_REAUTH_REQUIRED'});
}
