import path from 'node:path';
import { pathToFileURL } from 'node:url';

const siteId='196e1d2c-8216-4ba8-aeb9-1706660adc2b';
const releaseBranch='Integrated-Marketing-Platform';
const markerKeys=new Set(['PLATFORM_BACKEND_VERIFIED_SHA','PLATFORM_CI_VERIFIED_SHA']);
const fail=code=>{throw new Error(code);};

// A successful CLI exit did not prove that an attestation reached native builds.
export async function setReleaseMarker({branch,sha,key,token,fetchImpl=fetch}) {
 if(branch!==releaseBranch || !/^[a-f0-9]{40}$/.test(sha||'') || !markerKeys.has(key) || !token)fail('MARKER_INPUT_INVALID');
 async function request(method,resource,body,missingAllowed=false) {
  let r;
  try{
   r=await fetchImpl('https://api.netlify.com/api/v1'+resource,{method,redirect:'error',signal:AbortSignal.timeout(20000),
    headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  }catch{fail(method==='GET'?'MARKER_READ_UNAVAILABLE':'MARKER_WRITE_OUTCOME_UNKNOWN');}
  if(missingAllowed&&r.status===404)return null;
  if(!r.ok)fail('MARKER_HTTP_'+r.status);
  try{return await r.json();}catch{fail(method==='GET'?'MARKER_RESPONSE_INVALID':'MARKER_WRITE_OUTCOME_UNKNOWN');}
 }
 const site=await request('GET',`/sites/${siteId}`);
 if(site?.id!==siteId || site.name!=='memberwebsocket-dev-netlify' || site.build_settings?.repo_path!=='yongshengchen0615/memberwebsocket-dev-netlify'
  || site.build_settings?.repo_branch!=='master' || !/^[a-zA-Z0-9_-]+$/.test(site.account_slug||''))fail('MARKER_SITE_INVALID');
 const base=`/accounts/${site.account_slug}/env`, item=`${base}/${key}?site_id=${siteId}`;
 // Native builds match the case-preserved Git branch. Copying the CLI's
 // lowercase normalization made saved markers invisible to this branch.
 const context={context:'branch',context_parameter:branch,value:sha};
 function checkScope(row){
  const scopes=Array.isArray(row?.scopes)?row.scopes.map(s=>s==='post-processing'?'post_processing':s).sort().join(','):'';
  // These are public commit attestations, never credentials. Free plans expose
  // the default scopes; branch contexts remain strictly isolated on every plan.
  const supportedScopes=scopes==='builds'||scopes==='builds,functions,post_processing,runtime';
  if(row?.key!==key || row.is_secret===true || !supportedScopes
   || !Array.isArray(row.values) || row.values.length!==1 || row.values[0]?.context!=='branch'
   || row.values[0].context_parameter!==context.context_parameter)fail('MARKER_SCOPE_INVALID');
 }
 let row=await request('GET',item,null,true);
 if(row)checkScope(row);
 if(!row || row.values[0].value!==sha){
  if(row)await request('PATCH',item,context);
  else await request('POST',`${base}?site_id=${siteId}`,[{key,is_secret:false,values:[context]}]);
  row=await request('GET',item,null,true);
  if(!row)fail('MARKER_READBACK_MISMATCH');
  checkScope(row);
  if(row.values[0].value!==sha)fail('MARKER_READBACK_MISMATCH');
 }
 return {status:'marker-verified',key,sha,branch};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 console.log(JSON.stringify(await setReleaseMarker({branch:process.env.GITHUB_REF_NAME,sha:process.env.GITHUB_SHA,
  key:process.argv[2],token:process.env.NETLIFY_AUTH_TOKEN})));
}
