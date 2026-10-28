import { createClient } from 'npm:@supabase/supabase-js@2.57.0';
import { verifyPlatformIdToken, verifyMerchantAdminIdToken } from '../_shared/platform-auth.mjs';
import { createPlatformHandler } from '../_shared/platform-handler.mjs';
import { resolvePlatformEncryptionKey } from '../_shared/platform-key.mjs';

const env = (name: string) => (Deno.env.get(name) || '').trim();
const allowedOrigins = new Set([
  'https://yongshengchen0615.github.io',
  'https://memberwebsocket-dev-netlify.netlify.app',
  'https://develop--memberwebsocket-dev-netlify.netlify.app',
  'https://platform--memberwebsocket-dev-netlify.netlify.app',
  'https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app',
  ...env('ALLOWED_ORIGINS').split(',').map(x => x.trim()).filter(Boolean),
]);
const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {auth:{persistSession:false,autoRefreshToken:false}});
export const handler = createPlatformHandler({
  db, allowedOrigins, publicSupabaseUrl:env('SUPABASE_PUBLIC_URL') || env('SUPABASE_URL'),
  encryptionKey:() => resolvePlatformEncryptionKey({configuredKey:env('PLATFORM_CREDENTIAL_ENCRYPTION_KEY'),db}),
  verifyIdentity:(idToken: string) => verifyPlatformIdToken({idToken}),
  verifyApplicantIdentity:(idToken: string, channelId?: string) => verifyMerchantAdminIdToken({idToken}, channelId),
  verifiedMemberOaBindingsJson:env('MEMBER_OA_VERIFIED_LINKS_JSON'),
  allowedActions:new Set(['platform.member-oa.readiness','platform.member-oa.inspect']),
});
Deno.serve(handler);

