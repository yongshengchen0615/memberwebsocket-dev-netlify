import { createClient } from 'npm:@supabase/supabase-js@2.57.0';
import { createFrontdeskHandler } from '../_shared/frontdesk-handler.mjs';
import { resolvePlatformEncryptionKey } from '../_shared/platform-key.mjs';
const env=(name:string)=>(Deno.env.get(name)||'').trim();
const db=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}});
const allowedOrigins=new Set(['https://memberwebsocket-dev-netlify.netlify.app','https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app','https://develop--memberwebsocket-dev-netlify.netlify.app',...env('ALLOWED_ORIGINS').split(',').filter(Boolean)]);
Deno.serve(createFrontdeskHandler({db,allowedOrigins,encryptionKey:()=>resolvePlatformEncryptionKey({configuredKey:env('PLATFORM_CREDENTIAL_ENCRYPTION_KEY'),db})}));
