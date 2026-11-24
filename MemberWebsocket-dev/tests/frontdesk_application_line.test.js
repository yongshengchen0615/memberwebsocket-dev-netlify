const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const base=path.resolve(__dirname,'..');
const source=file=>readFileSync(path.join(base,file),'utf8');

test('AC-001: applicant LINE message originates in LIFF, never from the merchant bot Push API',()=>{
 const handler=source('supabase/functions/_shared/frontdesk-handler.mjs');
 assert.doesNotMatch(handler,/sendFrontdeskApplicationLineMessage|lineApplicationMessage|bot\/message\/push/);
 assert.match(handler,/profile\/'+identity\.lineUserId/,'existing OA friend verification is preserved');
 assert.match(handler,/platform_frontdesk_request/,'application still persists server-side pending state');
 const app=source('frontdesk/app.js');
 assert.match(app,/sendFrontdeskApplicationFromCurrentChat\(result\.staff\)/);
 assert.match(app,/sdk\.sendMessages\(\[\{type:'text',text:frontdeskApplicationText\(\)\}\]\)/);
 assert.doesNotMatch(app,/lineApplicationMessage|line\.me\/R\/oaMessage\//);
});

test('AC-002: auto-send is guarded by LINE 1:1 chat, OA configuration and chat_message.write consent',()=>{
 const app=source('frontdesk/app.js');
 assert.match(app,/person\?\.status!=='pending'/);
 assert.match(app,/frontdeskPolicy\?\.oaId/);
 assert.match(app,/sdk\?\.isInClient\?\.\(\)/);
 assert.match(app,/context\?\.type!=='utou'/);
 assert.match(app,/context\.scope\.includes\('chat_message\.write'\)/);
 assert.match(app,/sdk\.permission\?\.query\?\.\('chat_message\.write'\)/);
 assert.match(app,/permission\?\.state!=='granted'/);
});

test('AC-003: application persists first; failures never falsely claim successful LINE delivery',()=>{
 const app=source('frontdesk/app.js');
 const save=app.indexOf("const result=await request('frontdesk.apply')");
 const send=app.indexOf('const delivery=await sendFrontdeskApplicationFromCurrentChat(result.staff)',save);
 const reload=app.indexOf('await load()',send);
 assert.ok(save>0&&send>save&&reload>send);
 assert.match(app,/delivery==='failed'/);
 assert.match(app,/delivery==='permission_required'/);
 assert.match(app,/申請已建立，但目前不是具備聊天發訊授權/);
 assert.match(app,/申請已建立，已在目前 LINE 聊天室/);
});

test('AC-004: sender text does not leak user identifiers, credentials or access grants',()=>{
 const app=source('frontdesk/app.js');
 const start=app.indexOf('function frontdeskApplicationText()');
 const end=app.indexOf('async function sendFrontdeskApplicationFromCurrentChat',start);
 assert.ok(start>=0&&end>start);
 const text=app.slice(start,end);
 assert.match(text,/櫃檯人員權限申請/);
 assert.match(text,/等待商家管理員審核/);
 assert.doesNotMatch(text,/idToken|channelAccessToken|lineUserId|permissionMode|已核准/);
});

test('AC-005: LINE app cannot auto-send to an arbitrary OA from external or unrelated contexts',()=>{
 const app=source('frontdesk/app.js');
 assert.match(app,/context\?\.type!=='utou'/);
 assert.doesNotMatch(app,/liff\.shareTargetPicker|window\.open\(.+oaMessage/);
 assert.match(app,/自動送訊僅支援從商家 LINE 官方帳號一對一聊天室/);
});
