import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const runtimePath=file=>/^MemberWebsocket-dev\/.+\.(?:js|mjs|ts)$/.test(file)
 && !/^MemberWebsocket-dev\/(?:tests|vendor|docs)\//.test(file);

// Conservative lexical guard for named timer APIs, including aliases. It is
// deliberately not a semantic JS parser: dynamic/eval indirection is prohibited
// by review, and annotations never substitute for executed behavior tests.
export function timerSites(source){
 const sites=[];
 const lines=source.split(/\r?\n/);
 let blockComment=false;
 for(let i=0;i<lines.length;i++){
  let line=lines[i];
  if(blockComment){
   const end=line.indexOf('*/');if(end<0)continue;
   line=line.slice(end+2);blockComment=false;
  }
  while(line.trimStart().startsWith('/*')){
   const end=line.indexOf('*/');
   if(end<0){blockComment=true;line='';break;}
   line=line.slice(end+2);
  }
  const trimmed=line.trim();
  if(!trimmed||trimmed.startsWith('//'))continue;
  for(const match of line.matchAll(/\b(setTimeout|setInterval)\b/g)){
   sites.push({line:i+1,signature:match[1]+':'+trimmed,annotation:lines[i-1]?.trim()||''});
  }
 }
 return sites;
}
function justified(annotation){
 return /^\/\/ timer-policy: (?:deadline|debounce|heartbeat|recovery|animation); reason=.{8,}; cleanup=.{3,}; test=\S+\.(?:js|cjs|mjs|ts)$/.test(annotation);
}
export function inspectTimers(before,after){
 const remaining=new Map();
 for(const site of timerSites(before))remaining.set(site.signature,(remaining.get(site.signature)||0)+1);
 const introduced=[];
 for(const site of timerSites(after)){
  const count=remaining.get(site.signature)||0;
  if(count){remaining.set(site.signature,count-1);continue;}
  introduced.push({...site,approved:justified(site.annotation)});
 }
 return introduced;
}
function main(){
 const args=process.argv.slice(2);
 if(args.length!==2||args[0]!=='--base')throw Error('Usage: node scripts/runtime-quality.mjs --base <reviewed-base-sha>');
 const git=(...parameters)=>execFileSync('git',parameters,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 const base=git('rev-parse','--verify',args[1]+'^{commit}');
 const previousFiles=new Set(git('ls-tree','-r','--name-only',base,'--','MemberWebsocket-dev').split('\n'));
 const files=git('ls-files','--cached','--others','--exclude-standard','--','MemberWebsocket-dev').split('\n').filter(runtimePath);
 let rejected=0,introduced=0;
 for(const file of new Set(files)){
  if(!existsSync(file))continue;
  const before=previousFiles.has(file)?git('show',base+':'+file):'';
  for(const site of inspectTimers(before,readFileSync(file,'utf8'))){
   introduced++;
   if(!site.approved)rejected++;
   process.stdout.write(`${site.approved?'REVIEWED EXCEPTION':'REJECT'} ${file}:${site.line} ${site.signature}\n`);
  }
 }
 process.stdout.write(`Timer design gate: ${introduced} new/changed sites, ${rejected} missing purpose/cleanup/test evidence.\n`);
 if(rejected)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{main();}catch(error){process.stderr.write(`Runtime quality base/check failed: ${error.message}\n`);process.exitCode=1;}
}
