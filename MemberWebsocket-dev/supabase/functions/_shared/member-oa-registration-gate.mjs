// A new membership may only be activated after a server-authorized, tenant-
// specific LINE Official Account link has been confirmed. Never trust request
// body flags, the client-selected business, or LINE Login ID token alone.
import { verifyMemberOaFriendship, MemberOaFriendshipError } from './member-oa-friendship.mjs';

const configError = () => { throw new MemberOaFriendshipError(503,'MEMBER_OA_CONFIG_INCOMPLETE','此商家的會員 LINE 官方帳號尚未完成安全設定。'); };

function trustedMemberOaBinding(tenant, channel, verifiedBindingsJson) {
  if (!tenant || typeof tenant.id !== 'string' || tenant.features?.membership !== true) configError();
  const membership = tenant.module_line?.membership?.line || {};
  const shared = tenant.line_config || {};
  const memberChannelId = String(membership.memberChannelId || shared.memberChannelId || '');
  const memberLiffId = String(membership.memberLiffId || shared.memberLiffId || '');
  if (!/^\d{5,30}$/.test(memberChannelId) ||
      !memberLiffId.startsWith(memberChannelId+'-') ||
      String(channel) !== memberChannelId) configError();
  let bindings;
  try {
    if (typeof verifiedBindingsJson !== 'string' || verifiedBindingsJson.length > 20000) configError();
    bindings = JSON.parse(verifiedBindingsJson);
  } catch { configError(); }
  if (!Array.isArray(bindings)) configError();
  const valid = bindings.filter(item=>item && item.tenantId === tenant.id
    && item.memberLoginChannelId === memberChannelId
    && typeof item.memberOaId === 'string' && /^@[A-Za-z0-9._-]{3,40}$/.test(item.memberOaId));
  // Misconfigured duplicate mappings or one Login Channel reused for two shops
  // must never turn a per-merchant requirement into a shared-account check.
  if (valid.length !== 1 || bindings.some(item=>item && item.tenantId !== tenant.id
      && item.memberLoginChannelId === memberChannelId)) configError();
  return valid[0];
}

export async function requireMemberOaBeforeActivation({
  tenant, expectedChannelId, identity, member, lineAccessToken,
  verifiedBindingsJson, fetchImpl = undefined,
}) {
  // Existing active members can still edit profiles or reaccept terms after an
  // OA block. This rule only protects the *first* pending -> active transition.
  if (member?.membership_status === 'active') return { required:false };
  const link = trustedMemberOaBinding(tenant, expectedChannelId, verifiedBindingsJson);
  await verifyMemberOaFriendship({
    expectedChannelId: link.memberLoginChannelId,
    expectedLineUserId: identity?.lineUserId,
    memberOaLinked: true, // trusted binding from server-side verified env only
    accessToken:lineAccessToken,
    ...(fetchImpl ? {fetchImpl} : {}),
  });
  return { required:true };
}

// Safe bootstrap metadata uses exactly the activation gate's binding resolver.
// Missing configuration must not make established members' bootstrap unusable.
export function memberOaGuidance({tenant,expectedChannelId,member,verifiedBindingsJson}) {
  const required=member?.membership_status!=='active';
  try {
    const binding=trustedMemberOaBinding(tenant,expectedChannelId,verifiedBindingsJson);
    return {required,configured:true,addFriendUrl:'https://line.me/R/ti/p/'+encodeURIComponent(binding.memberOaId)};
  } catch { return {required,configured:false}; }
}
export function strictLineAccessToken(value) {
  if (typeof value!=='string' || !value.trim() || value.length>4096) {
    throw new MemberOaFriendshipError(401,'LINE_ACCESS_TOKEN_REQUIRED','請重新登入 LINE 並確認好友狀態。');
  }
  return value;
}
