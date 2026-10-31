import fs from 'node:fs';
import path from 'node:path';
const root='MemberWebsocket-dev', keys=new Map();
function visit(dir){for(const item of fs.readdirSync(dir,{withFileTypes:true})){
 const file=path.join(dir,item.name);if(item.isDirectory()){if(!['node_modules','vendor','tests','docs','.temp'].includes(item.name))visit(file);continue;}
 if(!/\.(?:js|mjs|ts|sql)$/.test(file))continue;
 const content=fs.readFileSync(file,'utf8');
 for(const match of content.matchAll(/\b(?:env|rawEnv|businessEnv|Deno\.env\.get)\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g)){
  const key=match[1],refs=keys.get(key)||new Set();refs.add(file+':'+(content.slice(0,match.index).split('\n').length));keys.set(key,refs);
 }
}}
visit(root);
console.log(JSON.stringify({format:1,scope:'Source references only; no configuration values are read',variables:[...keys].sort(([a],[b])=>a.localeCompare(b)).map(([key,refs])=>({key,scope:/^PLATFORM_|^SUPABASE_|^ALLOWED_ORIGINS$/.test(key)?'platform':/^LINE_/.test(key)?'legacy platform defaults; business/module override':'server jobs or application',secret:/TOKEN|SECRET|KEY/.test(key),disposition:'retain pending verified live inventory and provider smoke',references:[...refs].sort()}))},null,2));
