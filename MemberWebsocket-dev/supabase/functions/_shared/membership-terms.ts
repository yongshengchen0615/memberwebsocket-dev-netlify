import type { SupabaseClient } from './business-runtime.ts';

// Only call after server-side LINE identity and active membership checks.
export async function hasCurrentTermsConsent(supabase: SupabaseClient, memberId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("has_current_membership_terms_consent", { p_member_id: memberId });
  return !error && data === true;
}
