import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli=new URL('./runtime-quality.mjs',import.meta.url).pathname;
function fixture(t){
 const cwd=mkdtempSync(join(tmpdir(),'runtime-quality-'));t.after(()=>rmSync(cwd,{recursive:true,force:true}));
 const git=(...args)=>{const p=spawnSync('git',args,{cwd,encoding:'utf8'});assert.equal(p.status,0,p.stderr);return p.stdout.trim();};
 git('init','-q');git('config','user.name','Synthetic');git('config','user.email','synthetic@example.test');
 mkdirSync(join(cwd,'MemberWebsocket-dev'));writeFileSync(join(cwd,'MemberWebsocket-dev/app.js'),'setTimeout(oldWork, 100);\n');
 git('add','.');git('commit','-qm','baseline');
 return{cwd,write(source,name='app.js'){writeFileSync(join(cwd,'MemberWebsocket-dev',name),source);},
 run(base='HEAD'){return spawnSync(process.execPath,[cli,'--base',base],{cwd,encoding:'utf8'});}};
}
test('AC-003: unchanged legacy sites and removal pass, newly introduced arbitrary waits fail',t=>{
 const h=fixture(t);assert.equal(h.run().status,0);h.write('');assert.equal(h.run().status,0);
 h.write('setTimeout(newWork, 800);');const result=h.run();assert.equal(result.status,1);assert.match(result.stdout,/app.js:1/);
});
test('AC-003: new files, duplicate sites and timer aliases cannot silently expand the baseline',t=>{
 const h=fixture(t);h.write('setTimeout(oldWork, 100);\nsetTimeout(oldWork, 100);');assert.equal(h.run().status,1);
 h.write('');h.write('const later = window.setTimeout;','new.js');assert.equal(h.run().status,1);
});
test('AC-003: a changed deadline requires purpose, cleanup and a regression test at that site',t=>{
 const h=fixture(t);
 for(const annotation of ['','// timer-policy: sleep; reason=wait for API; cleanup=finally; test=deadline.test.js\n','// timer-policy: deadline; reason=bound request\n']){
  h.write(annotation+'window.setTimeout(abort, 15000);');assert.equal(h.run().status,1);
 }
 h.write('// timer-policy: deadline; reason=bound stalled request; cleanup=finally; test=deadline.test.js\nwindow.setTimeout(abort, 15000);');
 assert.equal(h.run().status,0);
});
test('AC-003: unknown base is a failing gate, never an empty successful inventory',t=>{
 const h=fixture(t);const result=h.run('missing-ref');assert.notEqual(result.status,0);assert.match(result.stderr,/base|revision/i);
});
test('AC-003: test-only timer fixtures and comment-only mentions are excluded',t=>{
 const h=fixture(t);mkdirSync(join(h.cwd,'MemberWebsocket-dev/tests'));h.write('// setTimeout is not used here\n');
 writeFileSync(join(h.cwd,'MemberWebsocket-dev/tests/fixture.js'),'setTimeout(testOnly,100);');assert.equal(h.run().status,0);
});
test('AC-003: a named timer after a block comment remains executable and must be reviewed',t=>{
 const h=fixture(t);
 for(const source of ['/* note */ setTimeout(work,800);','/* note\n continued */ setInterval(work,800);']){
  h.write(source);assert.equal(h.run().status,1);
 }
});
