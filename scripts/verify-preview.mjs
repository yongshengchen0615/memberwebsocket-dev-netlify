import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const workflow=fs.readFileSync(path.join(root,'.github/workflows/test-memberwebsocket-dev.yml'),'utf8');
function commands(job){
  const lines=workflow.split('\n');const start=lines.findIndex(line=>line===`  ${job}:`);
  if(start<0)throw new Error('Missing established CI job: '+job);
  const result=[];
  for(let i=start+1;i<lines.length;i++){
    if(/^  \S/.test(lines[i]))break;
    const match=/^        run: (\||>-)/.exec(lines[i]);if(!match)continue;
    const body=[];while(i+1<lines.length&&(lines[i+1].startsWith('          ')||!lines[i+1].trim()))body.push(lines[++i].slice(10));
    result.push(body.join(match[1]==='>-'?' ':'\n').trim());
  }
  if(!result.length)throw new Error('No executable CI commands: '+job);
  return result;
}
const jobs=['regression','integration','browser-syntax','edge-functions','wiring'];
const plan=jobs.map(job=>({job,commands:commands(job)}));
if(process.argv.includes('--plan')){console.log(JSON.stringify(plan,null,2));process.exit(0);}
// This opt-in validation lane runs only for the current PR. Production and
// ordinary previews retain their existing static build and existing CI gates.
if(process.env.CONTEXT!=='deploy-preview'||process.env.REVIEW_ID!=='17'){
  const {status}=await import('node:child_process').then(({spawnSync})=>spawnSync(process.execPath,['scripts/build-site.mjs'],{cwd:root,stdio:'inherit'}));
  process.exit(status??1);
}
if(!/^[a-f0-9]{40}$/.test(process.env.COMMIT_REF||''))throw new Error('Exact COMMIT_REF required');
const work=path.join(root,'.ci-tools');fs.mkdirSync(path.join(work,'results'),{recursive:true});
const env={...process.env,PLAYWRIGHT_BROWSERS_PATH:path.join(work,'browsers'),DENO_DIR:path.join(work,'deno-cache')};
const report={commit:env.COMMIT_REF,reviewId:env.REVIEW_ID,startedAt:new Date().toISOString(),node:process.version,status:'running',checks:[]};
async function run(name,command,cwd=root){
 const started=Date.now();console.log(`VALIDATE ${name}`);
 const child=spawn('bash',['-euo','pipefail','-c',command],{cwd,env,stdio:['ignore','pipe','pipe']});let output='';
 for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{const value=chunk.toString();output+=value;process.stdout.write(value);});
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
 const skipped=[...output.matchAll(/(?:ℹ skipped |# skipped |\b)(\d+) skipped\b/g)].map(x=>Number(x[1]));
 const nodeSkipped=[...output.matchAll(/(?:ℹ|#) skipped (\d+)/g)].map(x=>Number(x[1]));
 const needsCases=/^(regression-|integration-|browser-all$|ticket-policy-browser$|edge-functions-2$|build-contracts$)/.test(name);
 const hasCases=/(?:ℹ|#) tests [1-9]|[1-9]\d* passed/.test(output);
 const check={name,command,exitCode:code,durationMs:Date.now()-started,skipped:skipped.reduce((a,b)=>a+b,0)+nodeSkipped.reduce((a,b)=>a+b,0),summary:output.split('\n').filter(line=>/tests |pass |fail |passed|failed|skipped|vulnerabilities|^ok \|/.test(line)).slice(-35),tail:code===0?undefined:output.split('\n').slice(-80)};
 report.checks.push(check);fs.writeFileSync(path.join(work,'results',name.replace(/[^\w-]/g,'_')+'.log'),output);
 fs.writeFileSync(path.join(work,'results','report.json'),JSON.stringify(report,null,2));
 if(code!==0||check.skipped!==0||(needsCases&&!hasCases))throw new Error(`Required validation failed: ${name} (exit ${code}, skipped ${check.skipped})`);
}
try{
 await run('install-integration','npm ci --ignore-scripts --no-audit --no-fund',path.join(root,'MemberWebsocket-dev/tests/integration'));
 await run('install-browser','npm ci --ignore-scripts --no-audit --no-fund',path.join(root,'MemberWebsocket-dev/tests/browser'));
 await run('install-deno','npm install --prefix .ci-tools --no-audit --no-fund deno@2.9.6 @supabase/supabase-js@2.57.0');
 if(!fs.existsSync(path.join(root,'node_modules')))fs.symlinkSync(path.join(work,'node_modules'),path.join(root,'node_modules'),'dir');
 env.PATH=path.join(work,'node_modules/.bin')+path.delimiter+process.env.PATH;
 await run('install-chromium','npx --no-install playwright install chromium --only-shell',path.join(root,'MemberWebsocket-dev/tests/browser'));
 for(const {job,commands:steps} of plan){
   let index=0;for(let command of steps){
     if(command.startsWith('npm ci'))continue;
     command=command.replace(/\bdeno (check|test) /g,'deno $1 --node-modules-dir=manual ');
     await run(job+'-'+(++index),command);
   }
 }
 await run('browser-all','npm test',path.join(root,'MemberWebsocket-dev/tests/browser'));
 await run('ticket-policy-browser','npx --no-install playwright test ticket-policy-settings.spec.cjs settings-layout.spec.cjs ticket-selection.spec.cjs',path.join(root,'MemberWebsocket-dev/tests/browser'));
 await run('audit-integration','npm audit --audit-level=low',path.join(root,'MemberWebsocket-dev/tests/integration'));
 await run('audit-browser','npm audit --audit-level=low',path.join(root,'MemberWebsocket-dev/tests/browser'));
 await run('build-contracts','node --test scripts/deploy.test.mjs scripts/netlify-publish-workflow.test.mjs');
 await run('release-build','node scripts/build-site.mjs');
 report.status='passed';report.completedAt=new Date().toISOString();
 fs.writeFileSync(path.join(root,'dist/validation-report.json'),JSON.stringify(report,null,2));
 console.log(`VERIFIED ${report.commit}: ${report.checks.length} required checks passed`);
}catch(error){report.status='failed';report.completedAt=new Date().toISOString();report.error=error.message;fs.writeFileSync(path.join(work,'results','report.json'),JSON.stringify(report,null,2));throw error;}
