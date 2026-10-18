// Greenfield-only static builder: output NEVER contains legacy JS/CSS/HTML.
// All public configuration is explicitly scoped to the new Supabase V2 project.
import {cp,mkdir,rm,readFile,writeFile,readdir,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=path.join(root,'MemberWebsocket-dev','v2');
const out=path.resolve(process.env.V2_DIST_DIR||path.join(root,'dist'));
if(out===root||source.startsWith(out+path.sep)||out===source)
  throw new Error('Invalid destination: would overwrite source or repository');
const api=(process.env.V2_PLATFORM_FUNCTION_URL||'').trim();
const liff=(process.env.V2_PLATFORM_LIFF_ID||'').trim();
if(Boolean(api)!==Boolean(liff))throw new Error('V2 API URL and LIFF ID must be configured together');
if(api){
  const url=new URL(api);
  if(url.protocol!=='https:'||!url.hostname.endsWith('.supabase.co')
    ||url.pathname!=='/functions/v1/platform-v2'
    ||url.hostname.includes('dbuquirnaskrwcamdxki')
    ||url.username||url.password||url.search||url.hash
    ||!/^\d+-[A-Za-z0-9_-]+$/.test(liff))
    throw new Error('V2 must use a NEW Supabase project, valid endpoint and LIFF ID');
}
await rm(out,{recursive:true,force:true});await mkdir(out,{recursive:true});
const permitted=/\.(?:html|css|js|json|svg|png|jpe?g|webp|ico)$/i;
for(const name of await readdir(source)){
  const src=path.join(source,name);const info=await stat(src);
  if(info.isDirectory()&&['assets','admin','platform'].includes(name)){
    await cp(src,path.join(out,name),{recursive:true,filter:async file=>{
      const s=await stat(file);return s.isDirectory()||permitted.test(file);
    }});
  }else if(info.isFile()&&permitted.test(name)){
    await cp(src,path.join(out,name));
  }
}
await writeFile(path.join(out,'config.json'),JSON.stringify({
  apiUrl:api,platformLiffId:liff,environment:api?'configured':'unconfigured'
},null,2)+'\n');
const html=await readFile(path.join(out,'index.html'),'utf8');
if(!html.includes('MemberOS')||!html.includes('</body>'))throw new Error('V2 entry not built');
console.log('V2-only site generated ('+(api?'configured':'no platform connection')+'). Existing member site untouched.');
