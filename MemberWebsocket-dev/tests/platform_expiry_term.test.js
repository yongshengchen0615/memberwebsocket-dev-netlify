const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const term=require('../platform/expiry-term.js'),dir=path.join(__dirname,'../platform');
test('AC-EXP-001: date + duration saves an exact access boundary',()=>{
 const started='2026-11-01T02:13:00.000Z',end=term.termExpiry(started,30);
 assert.equal(end,'2026-12-01T02:13:00.000Z');assert.equal(term.termDays(started,end),30);
 assert.equal(term.termDays(started,'2026-12-01T02:14:00.000Z'),null);
});
test('AC-EXP-002: remaining day counter is ceil while active, zero after expiry',()=>{
 const until=Date.parse('2026-12-01T02:13:00.000Z'),iso=new Date(until).toISOString();
 assert.equal(term.remainingDays(iso,until-86400000),1);assert.equal(term.remainingDays(iso,until-1),1);
 assert.equal(term.remainingDays(iso,until),0);assert.equal(term.remainingDays(iso,until+86400000),0);
 assert.equal(term.remainingDays(null),null);
});
test('AC-EXP-003: invalid days and non-integer legacy expiry cannot be converted',()=>{
 for(const n of [0,-1,1.5,36501,NaN,Infinity])assert.throws(()=>term.termExpiry('2026-11-01T02:13:00Z',n),RangeError);
 assert.throws(()=>term.termExpiry('bad-date',30),RangeError);
 assert.equal(term.termDays('2026-11-01T02:13:00Z','2026-11-28T00:00:00Z'),null);
});
test('AC-EXP-004: accessible mode inputs, preview, existing privileged save action',()=>{
 const html=fs.readFileSync(path.join(dir,'index.html'),'utf8'),js=fs.readFileSync(path.join(dir,'app.js'),'utf8');
 for(const id of ['expiryDialog','expiryStartedAt','expiryDays','expiryAt','expiryComputedAt','expiryRemainingDays','expiryTermFields','expiryExactFields'])assert.ok(html.includes('id="'+id+'"'));
 for(const value of ['term','exact','unlimited'])assert.ok(html.includes('value="'+value+'"'));
 assert.ok(html.includes('expiry-preview" role="status" aria-live="polite"'));
 assert.ok(html.includes('expiry-term.js?v=expiry-term-20261101-1'));
 assert.ok(js.includes('platform.tenant.expiry.save'));assert.ok(js.includes('expiryPending={tenantId:expiryTenant.id,expectedVersion:expiryTenant.version,requestId:crypto.randomUUID(),expiresAt}'));
});
