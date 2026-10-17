import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const source=fs.readFileSync(new URL('../.github/workflows/publish-platform-preview.yml',import.meta.url),'utf8');
const begin='      - name: Require every actual CI test lane for this exact commit\\n';
const next='      - name: Build and verify the exact platform frontend';
const before=source.indexOf(begin.replace('\\n','\n'));
const after=source.indexOf(next,before);
assert.ok(before>=0 && after>before,'Platform CI gate must exist');
const step=source.slice(before,after);
const script=step.slice(step.indexOf('        run: |\n')+'        run: |\n'.length).replace(/^ {10}/gm,'');
const sha='abcdef0123456789abcdef0123456789abcdef01';
const lanes=[
  'Regression tests','DOM integration tests','Chromium admin, member, receipt and GPS E2E',
  'Browser JavaScript syntax','Supabase Edge Function typecheck','Static wiring and architecture checks',
];
const baseRuns=()=>({workflow_runs:[
  {id:11,head_sha:sha,name:'Test Netlify build',conclusion:'success'},
  {id:12,head_sha:sha,name:'MemberWebsocket Ticket Policy UI Tests',conclusion:'success'},
  {id:321,head_sha:sha,name:'Test MemberWebsocket Dev',conclusion:'success'},
]});
const baseJobs=()=>({jobs:[...lanes.map((name,id)=>({id,name,conclusion:'success'})),
  {id:50,name:'Validate MemberWebsocket Dev',conclusion:'success',runner_id:7654,steps:[{name:'Verify',conclusion:'success'}]}]});
function run(runs=baseRuns(),jobs=baseJobs()){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'platform-ci-gate-'));
  try{
    fs.writeFileSync(path.join(dir,'runs.json'),JSON.stringify(runs));
    fs.writeFileSync(path.join(dir,'jobs.json'),JSON.stringify(jobs));
    fs.writeFileSync(path.join(dir,'gh'),'#!/bin/sh\ncase "$*" in *"/jobs?"*) cat "$MOCK_JOBS";; *) cat "$MOCK_RUNS";; esac\n',{mode:0o755});
    fs.writeFileSync(path.join(dir,'sleep'),'#!/bin/sh\nexit 0\n',{mode:0o755});
    return spawnSync('bash',['-c',script],{
      encoding:'utf8',timeout:8000,
      env:{...process.env,PATH:dir+':'+process.env.PATH,
        MOCK_RUNS:path.join(dir,'runs.json'),MOCK_JOBS:path.join(dir,'jobs.json'),
        GITHUB_REPOSITORY:'fixture/member',GITHUB_REF_NAME:'feature/productization-super-admin',GITHUB_SHA:sha},
    });
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
test('platform publish allows only all six successful test lanes and both other workflows',()=>{
  const result=run();
  assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
});
test('a runnerless summary failure is allowed only when all six real test lanes passed',()=>{
  const runs=baseRuns();runs.workflow_runs[2].conclusion='failure';
  const jobs=baseJobs();jobs.jobs[6]={name:'Validate MemberWebsocket Dev',conclusion:'failure',runner_id:0,steps:[]};
  const result=run(runs,jobs);
  assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
  assert.match(result.stdout,/six real test lanes/);
});
test('validator test failure with an allocated runner is never ignored',()=>{
  const runs=baseRuns();runs.workflow_runs[2].conclusion='failure';
  const jobs=baseJobs();jobs.jobs[6]={name:'Validate MemberWebsocket Dev',conclusion:'failure',runner_id:77,steps:[{name:'Require every test lane',conclusion:'failure'}]};
  assert.equal(run(runs,jobs).status,1);
});
test('a failed, missing or skipped required lane blocks release, even after a runnerless summary failure',()=>{
  const runs=baseRuns();runs.workflow_runs[2].conclusion='failure';
  for(const invalid of ['failure','skipped','cancelled',null]){
    const jobs=baseJobs();jobs.jobs[1].conclusion=invalid;
    jobs.jobs[6]={name:'Validate MemberWebsocket Dev',conclusion:'failure',runner_id:0,steps:[]};
    assert.equal(run(runs,jobs).status,1,'Must reject '+invalid);
  }
});
test('a failed independent build or ticket policy run blocks release',()=>{
  for(const name of ['Test Netlify build','MemberWebsocket Ticket Policy UI Tests']){
    const runs=baseRuns();runs.workflow_runs.find(x=>x.name===name).conclusion='failure';
    assert.equal(run(runs).status,1,name);
  }
});
test('successes for a different commit cannot authorize a release',()=>{
  const runs=baseRuns();runs.workflow_runs.forEach(x=>x.head_sha='f'.repeat(40));
  assert.equal(run(runs).status,1);
});
