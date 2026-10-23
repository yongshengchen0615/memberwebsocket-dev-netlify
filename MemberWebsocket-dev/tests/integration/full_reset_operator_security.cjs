const test=require('node:test');
const assert=require('node:assert/strict');
const {randomBytes}=require('node:crypto');
const op=require('./full-reset-operator.cjs');
test('AC-CLR-022: encrypted backup is authenticated and tamper resistant',()=>{
 const key=randomBytes(32),plain=randomBytes(2048);
 const blob=op.cipher(key,plain);
 assert.notDeepEqual(blob,plain);
 assert.deepEqual(op.decipher(key,blob),plain);
 const corrupted=Buffer.from(blob);corrupted[50]^=255;
 assert.throws(()=>op.decipher(key,corrupted));
 assert.throws(()=>op.decipher(randomBytes(32),blob));
});
test('AC-CLR-023: operator validates exact project, confirmation, isolation and 256-bit key',()=>{
 assert.equal(op.validateProjectOrigin('https://dbuquirnaskrwcamdxki.supabase.co/'),
  'https://dbuquirnaskrwcamdxki.supabase.co');
 for(const bad of [
  'https://example.com','http://dbuquirnaskrwcamdxki.supabase.co',
  'https://dbuquirnaskrwcamdxki.supabase.co.evil.example']){
  assert.throws(()=>op.validateProjectOrigin(bad),/SUPABASE_URL_NOT_ALLOWLISTED/);
 }
 for(const bad of [
  'postgresql://postgres:pw@db.dbuquirnaskrwcamdxki.supabase.co:5432/reset_restore_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'postgresql://postgres:pw@127.0.0.1:5432/postgres',
  'postgresql://postgres:pw@127.0.0.1:5432/reset_restore_bad']){
  assert.throws(()=>op.validateRestoreDatabaseUrl(bad),/RESTORE_DB_MUST_BE_LOCAL|RESTORE_DB_DISPOSABLE_NAME_REQUIRED/);
 }
 assert.equal(op.validateRestoreDatabaseUrl('postgresql://postgres:pw@127.0.0.1:5432/reset_restore_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa').pathname,
  '/reset_restore_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
 const env={RESET_CONFIRM:'RESET MEMBERWEBSOCKET TEST DATA',
  RESET_BACKUP_KEY_B64:randomBytes(32).toString('base64'),
  RESET_PROVIDER_ISOLATION_ATTESTATION:'DISPATCH_DISABLED_AND_EXTERNAL_WEBHOOKS_ISOLATED'};
 assert.equal(op.validateResetSecrets(env).length,32);
 assert.throws(()=>op.validateResetSecrets({...env,RESET_CONFIRM:'WRONG'}),/RESET_CONFIRMATION_MISMATCH/);
 assert.throws(()=>op.validateResetSecrets({...env,RESET_BACKUP_KEY_B64:'abcd'}),/RESET_BACKUP_KEY_MUST_BE_32_BYTES/);
 assert.throws(()=>op.validateResetSecrets({...env,RESET_PROVIDER_ISOLATION_ATTESTATION:'YES'}),
  /EXTERNAL_PROVIDER_ISOLATION_NOT_ATTESTED/);
});
test('AC-CLR-024: storage keys are encoded per path segment; API errors do not become success',async()=>{
 assert.equal(op.encoded('booking-receipts','a/hello world.txt'),
  'booking-receipts/a/hello%20world.txt');
 const original=global.fetch;
 try{
  global.fetch=async()=>({ok:false,status:403});
  await assert.rejects(op.storageCall('https://dbuquirnaskrwcamdxki.supabase.co','synthetic',
   '/bucket/booking-receipts/empty',{method:'POST'}),/STORAGE_API_403_POST/);
 }finally{global.fetch=original}
});
