const test=require('node:test'),assert=require('node:assert/strict');
test('AC-181-001: expiry requires an actual calendar date and explicit timezone',async()=>{
 const {normalizeExpiry}=await import('../supabase/functions/_shared/tenant-access.mjs');
 assert.equal(normalizeExpiry(null),null);
 assert.equal(normalizeExpiry('2026-10-20T00:30:00+08:00'),'2026-10-19T16:30:00.000Z');
 for(const value of [undefined,'2026-02-30T00:00:00Z','2026-10-19T24:00:00Z','2026-10-19T12:00:00','not-a-date'])assert.throws(()=>normalizeExpiry(value));
});
test('AC-181-002: expired access is denied at the exact UTC boundary',async()=>{
 const {assertBusinessAction}=await import('../supabase/functions/_shared/business-policy.mjs');
 const c={status:'active',runtime_schema:'business_'+'a'.repeat(32),features:{membership:true},expires_at:'2026-10-19T12:00:00.000Z'};
 assert.doesNotThrow(()=>assertBusinessAction(c,'admin.bootstrap',{},Date.parse(c.expires_at)-1));
 assert.throws(()=>assertBusinessAction(c,'admin.bootstrap',{},Date.parse(c.expires_at)),e=>e.code==='TENANT_EXPIRED');
});
test('AC-184-03: revocation rejects old verified identities after reinstatement',async()=>{
 const {assertTenantIdentity}=await import('../supabase/functions/_shared/tenant-access.mjs');
 const c={access_revoked_before:'2026-10-19T12:00:00Z'};
 for(const issuedAtMs of [0,NaN,Date.parse(c.access_revoked_before)-1,Date.parse(c.access_revoked_before)])
  assert.throws(()=>assertTenantIdentity(c,{issuedAtMs}),e=>e.code==='TENANT_REAUTH_REQUIRED');
 assert.doesNotThrow(()=>assertTenantIdentity(c,{issuedAtMs:Date.parse(c.access_revoked_before)+1000}));
});
