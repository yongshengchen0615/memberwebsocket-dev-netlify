const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function fixture(file,withSdk){
 const calls=[],location={origin:'https://app.test',href:'https://app.test/points/?business=merchant-a',assign:url=>calls.push({url})};
 const window={location,setTimeout,clearTimeout,...(withSdk?{liff:{openWindow:options=>calls.push(options)}}:{})};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),{window,document:{addEventListener(){},removeEventListener(){}},URL,AbortController});
 return{system:window.MemberSystem||window.BookingSystem,calls,location};
}
for(const file of ['member-system.js','booking/common.js']){
 test(file+': missing cross-feature membership LIFF opens same merchant membership discovery',()=>{
  for(const withSdk of [false,true]){
   const h=fixture(file,withSdk);
   assert.equal(h.system.openMemberJoin({business:'merchant-a',pointsLiffId:'2010787602-Points'}),true);
   const url=h.calls[0]?.url||h.location.href;
   assert.equal(url,'https://app.test/member/?business=merchant-a');
   if(withSdk)assert.equal(h.calls[0].external,false);
  }
 });
 test(file+': missing or unsafe business cannot create an unscoped or foreign recovery URL',()=>{
  for(const business of [undefined,'','../other','https://evil.example','merchant-a&business=other']){
   const h=fixture(file,true);assert.equal(h.system.openMemberJoin({business}),false);assert.equal(h.calls.length,0);
  }
 });
 test(file+': configured membership LIFF retains its existing LINE launch route',()=>{
  const h=fixture(file,true);assert.equal(h.system.openMemberJoin({business:'merchant-a',memberLiffId:'2010787602-Member'}),true);
  assert.equal(h.calls[0].url,'https://liff.line.me/2010787602-Member?business=merchant-a');assert.equal(h.calls[0].external,false);
 });
}
