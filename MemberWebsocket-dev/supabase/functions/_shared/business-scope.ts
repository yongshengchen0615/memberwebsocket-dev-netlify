import { AsyncLocalStorage } from 'node:async_hooks';
type Context=Record<string,any>;
export const scope=new AsyncLocalStorage<Context>();
export const businessContext=()=>scope.getStore();
export const rawEnv=(name:string)=>(Deno.env.get(name)||'').trim();
export function businessEnv(name:string):string|undefined {
 if(name==='ALLOWED_ORIGINS')return [rawEnv(name)||'https://yongshengchen0615.github.io','https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app','https://platform--memberwebsocket-dev-netlify.netlify.app'].join(',');
 const c=scope.getStore();if(!c)return Deno.env.get(name);
 if(name==='LINE_ADMIN_CHANNEL_ID')return (c.adminCustomLineReady??c.customLineReady)?c.line_config?.adminChannelId||rawEnv(name)||'2010791619':rawEnv(name)||'2010791619';
 if(/^LINE_(MEMBER|POINTS|EVENT|CALENDAR|BOOKING)_CHANNEL_ID$/.test(name))return c.customLineReady?c.line_config?.memberChannelId||Deno.env.get(name):Deno.env.get(name);
 if(/^LINE_.*(ACCESS_TOKEN|CHANNEL_SECRET)$/.test(name))return /SECRET$/.test(name)?c.credentials?.channelSecret||'':c.credentials?.channelAccessToken||'';
 const liff=name.match(/^LINE_(MEMBER|POINTS|EVENT|CALENDAR|BOOKING)_LIFF_ID$/);
 if(liff)return c.customLineReady?c.line_config?.[liff[1].toLowerCase()+'LiffId']||Deno.env.get(name):Deno.env.get(name);
 return Deno.env.get(name);
}
function link(uri:string,c:Context){try{const u=new URL(uri);if(u.hostname==='liff.line.me'){u.searchParams.set('business',c.slug);return u.href;}}catch{}return uri;}
export async function businessFetch(input:RequestInfo|URL,init?:RequestInit):Promise<Response>{
 const c=scope.getStore();if(!c)return fetch(input,init);
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
 let body:any;try{body=typeof init?.body==='string'?JSON.parse(init.body):null;}catch{}
 if(body&&url.hostname==='api.line.me'){
  const visit=(node:any)=>{if(!node||typeof node!=='object')return;for(const [k,v]of Object.entries(node)){if(k==='uri'&&typeof v==='string')node[k]=link(v,c);else visit(v);}};visit(body);
 }else if(body&&url.hostname===new URL(rawEnv('SUPABASE_URL')).hostname&&url.pathname.startsWith('/functions/v1/'))body.business=c.slug;
 return fetch(input,body?{...init,body:JSON.stringify(body)}:init);
}
