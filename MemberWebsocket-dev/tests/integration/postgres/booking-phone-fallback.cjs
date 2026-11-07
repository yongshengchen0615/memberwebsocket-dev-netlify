const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const database=require('./database.cjs');
const fixture=require('../business-runtime-fixture.cjs');
const migration=fs.readFileSync(path.resolve(__dirname,'../../../supabase/migrations/20261107093000_booking_phone_fallback.sql'),'utf8');
const signature='(time without time zone,time without time zone,integer,integer,integer,text,integer,boolean,time without time zone,timestamp with time zone,text,boolean,boolean,jsonb,text)';
const id = n => 'U'+String(n).repeat(32);

test('AC-001..005 PostgreSQL 17: upgrading two merchants, tenant ACLs, invalid numbers and future provisioning',async()=>{
  const h=await fixture({...await database()});
  try{
    const first=await h.approve(id(5),'phone-fallback-a-'+crypto.randomUUID().slice(0,6));
    const second=await h.approve(id(6),'phone-fallback-b-'+crypto.randomUUID().slice(0,6));
    const a=first.runtime_schema,b=second.runtime_schema;
    assert.notEqual(a,b);
    await h.db.exec(migration);
    for(const schema of ['public',a,b]){
      const column=(await h.db.query(`select exists(select 1 from information_schema.columns where table_schema=$1 and table_name='booking_settings' and column_name='phone_booking_number') ok`,[schema])).rows[0];
      assert.equal(column.ok,true,schema+' missing phone column');
      const rights=(await h.db.query(`select has_function_privilege('anon',$1,'execute') anon,has_function_privilege('authenticated',$1,'execute') member,has_function_privilege('service_role',$1,'execute') service`,[schema+'.save_booking_shared_settings_v8'+signature])).rows[0];
      assert.deepEqual(rights,{anon:false,member:false,service:true},schema+' settings RPC must only allow service role');
    }
    await h.db.query('update '+a+".booking_settings set phone_booking_number='06-1234567' where id=1");
    assert.equal((await h.db.query('select phone_booking_number from '+a+'.booking_settings where id=1')).rows[0].phone_booking_number,'06-1234567');
    assert.equal((await h.db.query('select phone_booking_number from '+b+'.booking_settings where id=1')).rows[0].phone_booking_number,'');
    await assert.rejects(h.db.query('update '+b+".booking_settings set phone_booking_number='javascript:alert(1)' where id=1"),/booking_settings_phone_booking_number_check/);
    assert.equal((await h.db.query('select phone_booking_number from '+b+'.booking_settings where id=1')).rows[0].phone_booking_number,'');
    const third=await h.approve(id(7),'phone-fallback-c-'+crypto.randomUUID().slice(0,6));
    const c=third.runtime_schema;
    assert.equal((await h.db.query('select phone_booking_number from '+c+'.booking_settings where id=1')).rows[0].phone_booking_number,'');
    assert.ok((await h.db.query('select to_regprocedure($1) fn',[c+'.save_booking_shared_settings_v8'+signature])).rows[0].fn);
    const restored=await h.db.backupRestore();
    assert.equal((await restored.client.query('select phone_booking_number from '+a+'.booking_settings where id=1')).rows[0].phone_booking_number,'06-1234567');
    assert.equal((await restored.client.query('select phone_booking_number from '+b+'.booking_settings where id=1')).rows[0].phone_booking_number,'');
  }finally{await h.db.close();}
});
