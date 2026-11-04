const {test,expect}=require('playwright/test');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..');let server,base;
const terms={id:'terms-join-1',version:'7',title:'會員申請條款',summary:'QA 會員申請測試條款',body:'完整條款內容：會員申請前必須閱讀並同意目前有效版本。',required:true};
const incomplete={memberId:'member-join-qa',memberCode:'',displayName:'QA Join Member',surname:'',salutation:'',birthday:'',phone:'',tier:'一般會員',status:'active',profileComplete:false,membershipRequired:true};
function html(){return fs.readFileSync(path.join(root,'member/index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/href="\.\.\//g,'href="/').replace(/href="\.\//g,'href="/member/').replace('</body>','<script src="/fixture.js"></script><script src="/member/app.js"></script><script src="/member/profile-extension.js"></script></body>');}
test.beforeAll(async()=>{server=http.createServer((req,res)=>{try{const u=new URL(req.url,'http://localhost');if(u.pathname==='/member-join'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html());return;}if(u.pathname==='/fixture.js'){res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});res.end(`
const terms=${JSON.stringify(terms)},incomplete=${JSON.stringify(incomplete)};
const active={...incomplete,memberCode:'QA-VERIFIED-1',surname:'林',salutation:'ms',birthday:'1991-01-01',phone:'+886912345678',phoneVerified:true,membershipRequired:false,profileComplete:true,joinedAt:'2026-10-05T00:00:00Z'};
let activeProfile=structuredClone(active);
window.qaJoinCalls=[];window.TestModeClient={getSessionToken:()=> 'qa-test-session'};
window.MemberPhone={compose:(country,phone)=>{const digits=String(phone||'').replace(/\\D/g,'');return country==='+886'&&/^09\\d{8}$/.test(digits)?'+886'+digits.slice(1):'';},normalizeStored:v=>String(v||''),split:v=>({countryCode:'+886',localNumber:String(v||'').startsWith('+886')?'0'+String(v).slice(4):String(v||'')})};
window.MembershipProgress={render(){}};
window.MemberSystem={bindDialogKeyboard(){},loadConfig:async()=>({brandName:'QA Lumen Club'}),signIn:async()=> 'fixture-id-token',
request:async(_c,_t,_token,action,payload={})=>{window.qaJoinCalls.push({action,payload:structuredClone(payload)});
if(action==='user.member.bootstrap')return {profile:location.search.includes('active=1')?{...structuredClone(activeProfile),phoneVerificationRequired:location.search.includes('otp=1')}:structuredClone(incomplete),terms:structuredClone(terms),consentRequired:false,phoneVerificationRequired:location.search.includes('otp=1')};
if(action==='user.member.phone.send')return {sent:true};
if(action==='user.member.profile.save'){if(location.search.includes('active=1')){if(location.search.includes('otp=1')&&payload.phone!==activeProfile.phone&&payload.otpCode!=='123456')throw Object.assign(new Error('新電話簡訊驗證碼不正確'),{code:'PHONE_OTP_INVALID'});activeProfile={...activeProfile,phone:payload.phone,phoneVerified:true};return {profile:{...structuredClone(activeProfile),phoneVerificationRequired:location.search.includes('otp=1')}};}if(location.search.includes('otp=1')&&payload.otpCode!=='123456')throw Object.assign(new Error('手機號碼尚未驗證'),{code:'PHONE_OTP_INVALID'});if(payload.accepted!==true)throw Object.assign(new Error('必須同意條款'),{code:'TERMS_CONSENT_REQUIRED'});if(payload.termsId!==terms.id||payload.termsVersion!==terms.version)throw Object.assign(new Error('條款版本已更新'),{code:'TERMS_VERSION_STALE'});return {profile:{...structuredClone(incomplete),memberCode:'QA-JOIN-1',surname:payload.surname,salutation:payload.salutation,birthday:payload.birthday,phone:payload.phone,joinedAt:'2026-10-05T00:00:00.000Z',profileComplete:true,membershipRequired:false}};}throw Object.assign(new Error('Unknown action: '+action),{code:'UNKNOWN_ACTION'});},
subscribeRealtime:()=>()=>{},formatDate:v=>String(v||''),initials:()=> 'QA'};`);return;}
const file=path.resolve(root,'.'+u.pathname);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'application/octet-stream'});fs.createReadStream(file).pipe(res);}catch(e){res.writeHead(500);res.end(e.message);}});await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;});
test.afterAll(async()=>new Promise(r=>server.close(r)));
test.beforeEach(async({page})=>{await page.route('https://**',r=>r.abort());});
test('membership application terms block unchecked submit and persist current consent on join',async({page})=>{
await page.goto(base+'/member-join');await expect(page.locator('#profileSetupView')).toBeVisible();await expect(page.locator('#joinTermsSummary')).toContainText('版本 7');await expect(page.locator('#joinTermsTitle')).toContainText('v7');await expect(page.locator('#joinTermsBody')).toContainText('會員申請前必須閱讀並同意');
await page.locator('#profileSurname').fill('測');await page.locator('#profileSalutation').selectOption('mr');await page.evaluate(()=>{const e=document.getElementById('profileBirthday');e.value='1990-01-15';e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));});await page.locator('#profileCountryCode').selectOption('+886');await page.locator('#profilePhone').fill('0912345678');
await page.locator('#saveProfileButton').click();await expect(page.locator('#profileFormMessage')).toContainText('請閱讀並勾選同意會員條款');expect(await page.evaluate(()=>qaJoinCalls.filter(x=>x.action==='user.member.profile.save').length)).toBe(0);
await page.locator('#joinTermsAccepted').check();await expect.poll(()=>page.evaluate(()=>qaJoinCalls.filter(x=>x.action==='user.member.bootstrap').length)).toBeGreaterThanOrEqual(2);await expect(page.locator('#joinTermsAccepted')).toBeChecked();
await page.locator('#saveProfileButton').click();await expect(page.locator('#memberView')).toBeVisible();await expect(page.locator('#profileSetupView')).toBeHidden();
await page.locator('#copyMemberCodeButton').click();await expect(page.locator('#copyMemberCodeButton')).toHaveText('已複製');expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe('QA-JOIN-1');
await expect(page.locator('#copyMemberCodeButton')).toBeEnabled();await page.evaluate(()=>history.replaceState(null,'','/MemberWebsocket-dev/member/'));await page.evaluate(fs.readFileSync(path.join(root,'user-test-control.js'),'utf8').replace('  window.MemberUserTestControl =','  window.qaNodes={memberCodeCopyCase};\n  window.MemberUserTestControl ='));expect((await page.evaluate(()=>qaNodes.memberCodeCopyCase())).status).toBe('passed');
const saves=await page.evaluate(()=>qaJoinCalls.filter(x=>x.action==='user.member.profile.save'));expect(saves).toHaveLength(1);expect(saves[0].payload).toMatchObject({surname:'測',salutation:'mr',birthday:'1990-01-15',phone:'+886912345678',termsId:'terms-join-1',termsVersion:'7',accepted:true});
});
test('member phone OTP appears beneath number input and must be entered before joining', async ({page}) => {
  await page.goto(base + '/member-join?otp=1');
  await expect(page.locator('#profilePhoneVerification')).toBeVisible();
  await page.locator('#profileSurname').fill('林');
  await page.locator('#profileSalutation').selectOption('ms');
  await page.evaluate(() => {
    const input = document.querySelector('#profileBirthday');
    input.value = '1991-01-01';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.locator('#profilePhone').fill('0912345678');
  await page.locator('#joinTermsAccepted').check();
  await page.locator('#saveProfileButton').click();
  await expect(page.locator('#profileFormMessage')).toContainText('請先發送此手機號碼');
  expect(await page.evaluate(() => qaJoinCalls.some(x => x.action === 'user.member.profile.save'))).toBe(false);
  await page.locator('#profilePhoneSendCodeButton').click();
  await expect(page.locator('#profilePhoneVerificationMessage')).toContainText('驗證碼已發送');
  await page.locator('#profilePhoneCode').fill('123456');
  await page.locator('#profilePhone').fill('0912345679');
  await expect(page.locator('#profilePhoneCode')).toHaveValue('');
  await expect(page.locator('#profilePhoneVerificationMessage')).toContainText('手機號碼已變更');
  await page.locator('#profilePhoneSendCodeButton').click();
  await page.locator('#profilePhoneCode').fill('123456');
  await page.locator('#saveProfileButton').click();
  await expect(page.locator('#memberView')).toBeVisible();
  const calls = await page.evaluate(() => qaJoinCalls.filter(x => x.action === 'user.member.profile.save'));
  expect(calls).toHaveLength(1);
  expect(calls[0].payload.otpCode).toBe('123456');
  expect(calls[0].payload.phone).toBe('+886912345679');
});
test('verified phone skips resend; changing it requires fresh OTP and preserves old value on error', async ({page}) => {
  await page.goto(base + '/member-join?active=1&otp=1');
  await expect(page.locator('#memberView')).toBeVisible();
  await expect(page.locator('#memberPhone')).toContainText('+886912345678');
  await page.locator('#editPhoneButton').click();
  await expect(page.locator('#phoneEditModal')).toBeVisible();
  await expect(page.locator('#phoneEditStatusMessage')).toContainText('不必重複驗證');
  await expect(page.locator('#phoneEditVerification')).toBeHidden();
  await page.locator('#savePhoneEditButton').click();
  expect(await page.evaluate(() => qaJoinCalls.filter(x => x.action === 'user.member.phone.send' || x.action === 'user.member.profile.save'))).toHaveLength(0);
  await page.locator('#editPhoneButton').click();
  await page.locator('#phoneEditInput').fill('0923456789');
  await expect(page.locator('#phoneEditVerification')).toBeVisible();
  await page.locator('#savePhoneEditButton').click();
  await expect(page.locator('#phoneEditMessage')).toContainText('請先發送新電話');
  await page.locator('#phoneEditSendCodeButton').click();
  await expect(page.locator('#phoneEditVerificationMessage')).toContainText('驗證碼已發送');
  await page.locator('#phoneEditCode').fill('987654');
  await page.locator('#savePhoneEditButton').click();
  await expect(page.locator('#phoneEditMessage')).toContainText('驗證碼不正確');
  await expect(page.locator('#memberPhone')).toContainText('+886912345678');
  await page.locator('#phoneEditCode').fill('123456');
  await page.locator('#savePhoneEditButton').click();
  await expect(page.locator('#phoneEditModal')).toBeHidden();
  await expect(page.locator('#memberPhone')).toContainText('+886923456789');
  const calls = await page.evaluate(() => qaJoinCalls.filter(x => x.action === 'user.member.phone.send' || x.action === 'user.member.profile.save'));
  expect(calls.filter(x => x.action === 'user.member.phone.send')).toHaveLength(1);
  expect(calls.filter(x => x.action === 'user.member.profile.save' && x.payload.otpCode === '123456')).toHaveLength(1);
});
