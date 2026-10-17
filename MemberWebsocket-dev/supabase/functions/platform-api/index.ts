import { createClient } from 'npm:@supabase/supabase-js@2.57.0';
import { verifyLineIdTokenContract } from '../_shared/auth-contract.ts';
import { PlatformError } from '../_shared/platform-policy.mjs';
import { createPlatformHandler } from '../_shared/platform-handler.mjs';

const env = (name: string) => (Deno.env.get(name) || '').trim();
const allowedOrigins = new Set([
  'https://yongshengchen0615.github.io',
  'https://memberwebsocket-dev-netlify.netlify.app',
  'https://develop--memberwebsocket-dev-netlify.netlify.app',
  ...env('ALLOWED_ORIGINS').split(',').map(x => x.trim()).filter(Boolean),
]);
const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {auth:{persistSession:false,autoRefreshToken:false}});
export const handler = createPlatformHandler({
  db, allowedOrigins,
  encryptionKey:() => env('PLATFORM_CREDENTIAL_ENCRYPTION_KEY'),
  verifyIdentity:(idToken: string) => verifyLineIdTokenContract({
    idToken, expectedChannelId:env('LINE_ADMIN_CHANNEL_ID') || '2010791619',
    createError:(status,code,message) => new PlatformError(status,code,message),
  }),
});
Deno.serve(handler);
