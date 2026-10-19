const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..'),build=path.join(root,'scripts/build-v2-site.mjs');
function run(env){
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'memberos-v2-'));
 const result=spawnSync(process.execPath,[build],{cwd:root,encoding:'utf8',
  env:{...process.env,V2_PLATFORM_FUNCTION_URL:'',V2_PLATFORM_LIFF_ID:'',...env,V2_DIST_DIR:folder}});
 return {folder,result};
}
test('V2 build ships only new HTML/CSS/JS and never old business assets',()=>{
 const {folder,result}=run({});
 try{
   assert.equal(result.status,0,result.stderr);
   assert.ok(fs.existsSync(path.join(folder,'admin/index.html')));
   assert.ok(fs.existsSync(path.join(folder,'platform/index.html')));
   assert.ok(fs.existsSync(path.join(folder,'assets/app.js')));
   assert.ok(!fs.existsSync(path.join(folder,'member-system.js')));
   assert.ok(!fs.existsSync(path.join(folder,'supabase')));
   assert.ok(!fs.existsSync(path.join(folder,'v2')));
   const config=JSON.parse(fs.readFileSync(path.join(folder,'config.json')));
   assert.equal(config.apiUrl,'');assert.equal(config.platformLiffId,'');
 }finally{fs.rmSync(folder,{recursive:true,force:true})}
});
test('V2 build accepts only isolated project URL, never previous production project',()=>{
 for(const env of [
  {V2_PLATFORM_FUNCTION_URL:'https://dbuquirnaskrwcamdxki.supabase.co/functions/v1/platform-v2',V2_PLATFORM_LIFF_ID:'2012345678-v2'},
  {V2_PLATFORM_FUNCTION_URL:'https://test.supabase.co/functions/v1/platform-v2',V2_PLATFORM_LIFF_ID:''},
  {V2_PLATFORM_FUNCTION_URL:'https://test.supabase.co/functions/v1/api',V2_PLATFORM_LIFF_ID:'2012345678-v2'}
 ]){
   const {folder,result}=run(env);try{assert.notEqual(result.status,0)}finally{fs.rmSync(folder,{recursive:true,force:true})}
 }
 const {folder,result}=run({V2_PLATFORM_FUNCTION_URL:'https://newtenantref.supabase.co/functions/v1/platform-v2',V2_PLATFORM_LIFF_ID:'2012345678-v2'});
 try{
   assert.equal(result.status,0,result.stderr);
   const cfg=JSON.parse(fs.readFileSync(path.join(folder,'config.json')));
   assert.equal(cfg.apiUrl,'https://newtenantref.supabase.co/functions/v1/platform-v2');
   assert.equal(cfg.platformLiffId,'2012345678-v2');
 }finally{fs.rmSync(folder,{recursive:true,force:true})}
});
