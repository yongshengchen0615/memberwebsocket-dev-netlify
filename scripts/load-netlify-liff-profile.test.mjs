import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { loadNetlifyLiffProfile, validateNetlifyLiffProfile } from './load-netlify-liff-profile.mjs';

const fields = [
  'memberLiffId', 'pointsLiffId', 'adminLiffId', 'platformLiffId',
  'eventLiffId', 'calendarLiffId', 'bookingLiffId',
];
const profile = Object.fromEntries(fields.map((key,i)=>[key,'1234567890-Protected'+i]));
const envFor = file => ({ NETLIFY_SITE_ID:'00000000-0000-0000-0000-000000000000',
  NETLIFY_AUTH_TOKEN:'synthetic-do-not-use', GITHUB_ENV:file });

test('AC-011: valid site profile is exported into GitHub Actions without branch ambiguity',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'site-liff-profile-'));
  try{
    const file=path.join(dir,'env');
    const calls=[];
    const result=loadNetlifyLiffProfile('master',envFor(file),(command,args)=>{
      calls.push([command,args]);
      return {status:0,stdout:JSON.stringify(profile)+'\n',stderr:''};
    });
    assert.equal(result.status,'site-profile');
    assert.equal(calls[0][0],'npx');
    assert.ok(calls[0][1].includes('PUBLIC_LIFF_CONFIG_PRODUCTION'));
    assert.ok(calls[0][1].includes('production'));
    assert.match(readFileSync(file,'utf8'),/^PUBLIC_LIFF_CONFIG_PRODUCTION=\{/);
    assert.deepEqual(JSON.parse(readFileSync(file,'utf8').split('=')[1]),profile);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('AC-012: absent site profile uses pinned baseline; CLI auth and network errors block releases',()=>{
  const env=envFor('/a/path/not/written');
  assert.equal(validateNetlifyLiffProfile(' ', 'master'),null);
  assert.equal(loadNetlifyLiffProfile('Integrated-Marketing-Platform',env,()=>({
    status:1,stderr:'Environment variable not found',
  })).status,'pinned-default');
  for(const message of ['403 forbidden','network timeout','authentication failed']){
    assert.throws(()=>loadNetlifyLiffProfile('master',env,()=>({status:1,stderr:message})),/Unable to read Netlify/);
  }
  assert.equal(loadNetlifyLiffProfile('feature/not-ours',{},()=>{throw Error('must not run');}).status,'not-applicable');
});

test('AC-013: malformed or partial profile cannot be published',()=>{
  for(const value of ['not-json','{}','[]',JSON.stringify({...profile,adminLiffId:'bad'}),JSON.stringify({...profile,extra:'unexpected'})]){
    assert.throws(()=>validateNetlifyLiffProfile(value,'master'));
    assert.throws(()=>validateNetlifyLiffProfile(value,'Integrated-Marketing-Platform'));
  }
});
