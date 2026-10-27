const fs=require('node:fs'),cp=require('node:child_process'),{gzipSync}=require('node:zlib'),{performance}=require('node:perf_hooks');
const {JSDOM}=require('../MemberWebsocket-dev/tests/integration/node_modules/jsdom');
const base=process.argv[2]||'80c4f1fee091b0b39d8021b3944521d58ba4cc67',candidate=cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const files=['admin/business-line-settings.js','admin/business-line-settings.css','platform/app.js','admin/workspace.html'];
const source=(file,old)=>old?cp.execFileSync('git',['show',base+':MemberWebsocket-dev/'+file]):fs.readFileSync('MemberWebsocket-dev/'+file);
const assets=files.map(file=>{const before=source(file,true),after=source(file,false);return{file,baseSHA256:require('node:crypto').createHash('sha256').update(before).digest('hex'),candidateSHA256:require('node:crypto').createHash('sha256').update(after).digest('hex'),baseBytes:before.length,candidateBytes:after.length,baseGzipBytes:[1,2,3].map(()=>gzipSync(before,{level:9}).length),candidateGzipBytes:[1,2,3].map(()=>gzipSync(after,{level:9}).length)};});
const features={membership:true,points:true,events:true,calendar:true,booking:true},line={adminChannelId:'2010791619',adminLiffId:'2010791619-admin',memberChannelId:'2010787602'};
for(const key of ['memberLiffId','pointsLiffId','eventLiffId','calendarLiffId','bookingLiffId'])line[key]='2010787602-'+key;
const tenant={id:'synthetic',slug:'synthetic',status:'active',version:1,features,line,moduleLine:{},credentialsConfigured:false};
function visible(input){for(let n=input;n&&n.nodeType===1;n=n.parentElement){if(n.hidden)return false;if(n.tagName==='DETAILS'&&!n.open&&!n.querySelector('summary')?.contains(input))return false;}return true;}
async function run(js){
 const dom=new JSDOM('<nav id="businessLineFeatureNav"></nav><div id="businessLineFeatureContent"></div>',{url:'https://allowed.test/admin/?business=synthetic',runScripts:'outside-only'}),w=dom.window;let calls=0;
 try{w.AbortSignal=AbortSignal;w.MemberAdminSession={get:()=>({idToken:'synthetic',config:{business:'synthetic',supabaseFunctionUrl:'https://fixture.test/functions/v1/api'}})};
  w.fetch=async()=>{calls++;return{ok:true,json:async()=>({ok:true,data:{tenant:structuredClone(tenant),application:{status:'approved'}}})};};
  const start=performance.now();w.eval(js);await w.BusinessLineSettings.apply({features});const durationMs=performance.now()-start;
  return{durationMs:Math.round(durationMs*100)/100,bootstrapRequests:calls,defaultVisibleEntryInputs:[...w.document.querySelectorAll('[data-business-line-feature=membership] form:first-of-type input')].filter(visible).length};
 }finally{w.close();}
}
(async()=>{const before=source(files[0],true).toString(),after=source(files[0],false).toString(),samples={base:[],candidate:[]};
 for(let i=0;i<15;i++){const order=i%2?['candidate','base']:['base','candidate'];for(const kind of order){const value=await run(kind==='base'?before:after);if(i>=3)samples[kind].push(value);}}
 const summary={};for(const [kind,rows]of Object.entries(samples)){const values=rows.map(r=>r.durationMs).sort((a,b)=>a-b);summary[kind]={samples:rows.length,p50Ms:values[Math.floor(values.length*.5)],p95Ms:values[Math.ceil(values.length*.95)-1],bootstrapRequests:[...new Set(rows.map(r=>r.bootstrapRequests))],defaultVisibleEntryInputs:[...new Set(rows.map(r=>r.defaultVisibleEntryInputs))]};}
 const result={base,candidate,measuredAt:new Date().toISOString(),environment:{node:process.version,tool:'JSDOM 26.1.0; gzip level 9; isolated synthetic 5-feature configured merchant; alternating versions, 3 warmups then 12 samples each'},limitations:'DOM script/render timing with stubbed transport is not Chromium layout or live network/API latency. No speedup is claimed. Asset gzip samples are deterministic and not observed CDN transfer.',assets,summary,samples};
 fs.writeFileSync('docs/superpowers/line-settings-59-performance.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({assets,summary}));
})();
