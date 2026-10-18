// A new, standalone Edge Function. It never falls back to the legacy Supabase project.
import { createClient } from 'npm:@supabase/supabase-js@2.57.0';
import { createPlatformV2Handler } from '../_shared/platform-v2-handler.mjs';
const env = (key: string) => (Deno.env.get(key) || '').trim();
const projectUrl=env('V2_SUPABASE_URL'), secret=env('V2_SUPABASE_SECRET_KEY');
const origins=new Set(env('V2_ALLOWED_ORIGINS').split(',').map(x=>x.trim()).filter(Boolean));
if(!projectUrl||!secret||!env('V2_LINE_CHANNEL_ID')||!origins.size)
  throw new Error('V2 control plane requires independent project, LINE channel and origins');
if(projectUrl.includes('dbuquirnaskrwcamdxki'))
  throw new Error('Refusing legacy Supabase project for V2');
const db=createClient(projectUrl,secret,{auth:{persistSession:false,autoRefreshToken:false}});
Deno.serve(createPlatformV2Handler({
  db,allowedOrigins:origins,lineChannelId:env('V2_LINE_CHANNEL_ID'),
  encryptionKey:()=>env('V2_LINE_ENCRYPTION_KEY')
}));
