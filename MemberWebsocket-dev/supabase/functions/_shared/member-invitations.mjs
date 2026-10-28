// Raw invitation secrets exist only for the response URL and incoming claim.
// Persistence receives a SHA-256 digest; neither secret nor digest is logged.
export class InvitationError extends Error {
  constructor(status, code, message='目前無法使用這份邀請。') { super(message); this.status=status; this.code=code; this.details=null; }
}
export async function hashInvitationToken(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new InvitationError(400,'INVITATION_TOKEN_INVALID');
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
}
export async function mintInvitationToken() {
  const token=Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
  return {token,hash:await hashInvitationToken(token)};
}
export function invitationUrl(tenant, expectedChannelId, token) {
  const line=tenant?.module_line?.membership?.line || {};
  const channel=line.memberChannelId || tenant?.line_config?.memberChannelId;
  const liff=line.memberLiffId || tenant?.line_config?.memberLiffId;
  if (!tenant?.id || tenant.features?.membership!==true || typeof tenant.slug!=='string' || !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(tenant.slug)
    || typeof channel!=='string' || !/^\d{5,30}$/.test(channel) || channel!==expectedChannelId
    || typeof liff!=='string' || !new RegExp('^'+channel+'-[A-Za-z0-9_-]{1,80}$').test(liff)) throw new InvitationError(503,'INVITATION_CONFIG_INCOMPLETE');
  if (typeof token!=='string' || !/^[a-f0-9]{64}$/.test(token)) throw new InvitationError(400,'INVITATION_TOKEN_INVALID');
  const url=new URL('https://liff.line.me/'+liff);
  url.searchParams.set('business',tenant.slug);url.searchParams.set('invitation',token);return url.href;
}
export function invitationDatabaseError(error) {
  const message=typeof error?.message==='string'?error.message:'';
  const statuses={INVITATION_TOKEN_INVALID:400,INVITATION_TOKEN_EXPIRED:410,INVITATION_SELF_NOT_ALLOWED:409,
    INVITATION_ACTIVE_MEMBER:409,INVITATION_ALREADY_CLAIMED:409,INVITATION_SOURCE_UNAVAILABLE:403,
    INVITATION_TENANT_UNAVAILABLE:403,MEMBERSHIP_REQUIRED:403,TERMS_RECONSENT_REQUIRED:403};
  const code=Object.keys(statuses).find(code=>message===code);
  // No raw database diagnostics, hashes, member identities or secrets in errors.
  return code?new InvitationError(statuses[code],code):new InvitationError(503,'INVITATION_UNAVAILABLE','邀請服務暫時無法使用，請稍後重試。');
}
