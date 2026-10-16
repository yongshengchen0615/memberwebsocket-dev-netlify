const TIERS = ['general','silver','gold','platinum'];
const LABELS: Record<string,string> = {general:'一般會員',silver:'銀級會員',gold:'金級會員',platinum:'白金會員'};
// Visibility is presentation only. Claim/redemption RPCs independently enforce eligibility.
export function tierVisibility(keys: unknown, tier: unknown, policy: unknown) {
  const allowed = Array.isArray(keys) ? keys.map(String).filter(key=>TIERS.includes(key)) : [];
  const current = TIERS.indexOf(String(tier));
  const eligible = current>=0 && allowed.includes(String(tier));
  const higher = current>=0 && allowed.some(key=>TIERS.indexOf(key)>current);
  return {visible:eligible || (policy==='higher_preview' && higher),tierEligible:eligible,locked:!eligible,
    requiredTierLabels:allowed.map(key=>LABELS[key]),lockReason:eligible?'':`需符合${allowed.map(key=>LABELS[key]).join('、')||'指定會員階級'}，目前無法領取或使用。`};
}
export async function loadVisibilityPolicy(db: any): Promise<string> {
  const result=await db.from('event_ticket_settings').select('visibility_policy').eq('id',1).maybeSingle();
  if(result.error) throw result.error;
  return result.data?.visibility_policy==='higher_preview'?'higher_preview':'eligible_only';
}
