const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const read=path=>fs.readFileSync('MemberWebsocket-dev/'+path,'utf8');
const script=read('admin/booking-risk.js');
const css=read('admin/booking-panel.css');
const loader=read('admin/booking-panel.js');
const html=read('admin/index.html');

test('AC-RISK-FIGMA-001: context, four policy groups and overview remain in correct order',()=>{
 for(const part of ['booking-risk-lead','booking-risk-scope-note','僅影響新的線上預約','01  政策開關','02  爽約計次','03  限制期限','04  客服聯絡方式','booking-risk-preview','booking-risk-records-intro']){
  assert.ok(script.includes(part),'Missing '+part);
 }
 const order=['01  政策開關','02  爽約計次','03  限制期限','04  客服聯絡方式','booking-risk-records-intro'];
 for(let i=1;i<order.length;i++)assert.ok(script.indexOf(order[i])>script.indexOf(order[i-1]),'Ordering '+order[i]);
});
test('AC-RISK-FIGMA-002: keyboard and assistive hints are connected to fields',()=>{
 assert.match(script,/input\.setAttribute\('aria-describedby',\[hint\?\.id,error\.id\]/);
 for(const key of ['lookback_days','threshold_count','grace_minutes','duration_count','duration_unit','contact_text']){
  assert.ok(script.includes(key+':'),'No field hint for '+key);
 }
 assert.match(script,/aria-live':'polite'/);
 assert.match(script,/role:'status'/);
 assert.match(script,/novalidate:''/);
});
test('AC-RISK-FIGMA-003: mobile is single-column and actions remain tappable',()=>{
 assert.match(css,/Booking-risk Figma layout 20261029/i);
 assert.match(css,/@media\(max-width:680px\)/);
 assert.match(css, /\.booking-risk-field-grid,\s*\n\s*#bookingPanel #bookingRiskSettings \.booking-risk-field-group:nth-child\(2\) \.booking-risk-field-grid\{grid-template-columns:minmax\(0,1fr\)\}/);
 assert.match(css,/\.booking-risk-form-actions \.button,\s*\n\s*#bookingPanel #bookingRiskSettings \.booking-risk-record-list>li \.button\{width:100%;min-height:46px\}/);
 assert.match(css,/booking-risk-records\{grid-template-columns:minmax\(0,1fr\)\}/);
});
test('AC-RISK-FIGMA-004: APIs and retirement behavior survive visual changes',()=>{
 for(const term of ["run('save'","run('get'","'revoke'","'release'","BOOKING_CONFLICT","validate=policy","window.confirm","人工解除","撤銷誤判"])assert.ok(script.includes(term),term);
 for(const term of ['會員申覆','appeal_enabled','admin.booking.risk.resolve','user.booking.risk.appeal'])assert.equal(script.includes(term),false,term);
 assert.match(loader,/figma-20261029-1/);
 assert.match(html,/booking-panel\.css\?v=[^"']+figma-20261029-1/);
});
