const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const core=fs.readFileSync('MemberWebsocket-dev/admin/booking-panel-core.js','utf8');
const loader=fs.readFileSync('MemberWebsocket-dev/admin/booking-panel.js','utf8');
const css=fs.readFileSync('MemberWebsocket-dev/admin/booking-panel.css','utf8');
test('AC-BUX-006: booking risk policy has a dedicated semantic tab',()=>{
 assert.match(core,/id="bookingAdminRiskSubtab"[^>]+role="tab"[^>]+aria-controls="bookingAdminRiskPanel"/);
 assert.match(core,/id="bookingAdminRiskPanel"[^>]+role="tabpanel"[^>]+aria-labelledby="bookingAdminRiskSubtab"/);
 assert.match(core,/risk: \[els\.bookingAdminRiskSubtab, els\.bookingAdminRiskPanel\]/);
 assert.equal((core.match(/BookingRiskSettings\?\.mount\(els\.bookingAdminRiskMount,/g)||[]).length,2);
 assert.doesNotMatch(core,/BookingRiskSettings\?\.mount\(els\.bookingAdminSettingsPanel,/);
 assert.match(loader,/risk-tab-20261023-1/);
 assert.match(css,/#bookingPanel #bookingRiskSettings>form/);
});
test('AC-BUX-007: original booking settings and risk write APIs remain separate',()=>{
 for(const id of ['bookingAdminAdvanceDays','bookingAdminMaxAdvanceDays','bookingAdminSaveSettingsButton'])assert.ok(core.includes('id="'+id+'"'));
 assert.match(core,/admin\.booking\.settings\.save/);
 assert.match(core,/admin\.booking\.risk\.'\+action/);
 assert.match(core,/bookingAdminRiskOpenAdvanceSettings\.addEventListener/);
 assert.match(core,/bookingAdminSubtabs\.addEventListener\('keydown'/);
});
