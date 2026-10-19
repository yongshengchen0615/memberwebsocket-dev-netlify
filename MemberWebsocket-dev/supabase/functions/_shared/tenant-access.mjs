// Business access and verified LINE token freshness are independent of grants.
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
