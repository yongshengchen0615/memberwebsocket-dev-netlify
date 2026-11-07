const test=require('node:test'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url'),path=require('node:path');
const shared=name=>import(pathToFileURL(path.join(__dirname,'../supabase/functions/_shared',name)));
test('platform preserves a configured credential key without contacting Vault',async()=>{
 const {resolvePlatformEncryptionKey}=await shared('platform-key.mjs');
 assert.equal(await resolvePlatformEncryptionKey({configuredKey:' existing-key ',db:{rpc:()=>assert.fail('must preserve configured key')}}),'existing-key');
});
test('platform Vault key resolves asynchronously and encrypts credentials with real WebCrypto',async()=>{
 const {resolvePlatformEncryptionKey}=await shared('platform-key.mjs');
 const {sealCredentials,openCredentials}=await shared('platform-crypto.mjs');
 const key=Buffer.alloc(32,7).toString('base64');let calls=0;
 const resolved=await resolvePlatformEncryptionKey({configuredKey:'',db:{rpc:async name=>{assert.equal(name,'platform_credential_key');calls++;return {data:key,error:null};}}});
 const payload={channelAccessToken:'synthetic-access-token',channelSecret:'a'.repeat(32)};
 const envelope=await sealCredentials('tenant-id',payload,resolved);assert.deepEqual(await openCredentials('tenant-id',envelope,key),payload);assert.equal(calls,1);
});
test('platform fails closed without leaking Vault errors or key material',async()=>{
 const {resolvePlatformEncryptionKey}=await shared('platform-key.mjs');
 for(const rpc of [async()=>({error:{message:'private-vault-error'},data:null}),async()=>({data:null}),async()=>{throw new Error('private-vault-error');}])await assert.rejects(resolvePlatformEncryptionKey({db:{rpc}}),e=>e.status===503&&e.code==='PLATFORM_KEY_UNAVAILABLE'&&!e.message.includes('private'));
});
