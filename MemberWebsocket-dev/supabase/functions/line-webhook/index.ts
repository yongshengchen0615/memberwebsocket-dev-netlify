import { createClient } from 'npm:@supabase/supabase-js@2.57.0';
import { createLineWebhookHandler } from '../_shared/line-webhook.mjs';
import { resolvePlatformEncryptionKey } from '../_shared/platform-key.mjs';

const env=(name:string)=>(Deno.env.get(name)||'').trim();
const db=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}});
Deno.serve(createLineWebhookHandler({db,encryptionKey:()=>resolvePlatformEncryptionKey({configuredKey:env('PLATFORM_CREDENTIAL_ENCRYPTION_KEY'),db})}));
