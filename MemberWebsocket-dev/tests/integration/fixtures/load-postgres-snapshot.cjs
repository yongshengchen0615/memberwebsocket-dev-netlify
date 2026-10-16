const {PGlite}=require('@electric-sql/pglite');
const {btree_gist}=require('@electric-sql/pglite/contrib/btree_gist');
const snapshot=require('./schema-before-legacy-cleanup.json');
const fs=require('node:fs');const path=require('node:path');
// Real production function definitions and integrity constraints, with empty tables.
module.exports=async function loadPostgresSnapshot(){
  const db=new PGlite({extensions:{btree_gist}});
  try{
    await db.exec('create extension btree_gist;');await db.exec(snapshot.ddl);
    await db.exec("create function extensions.digest(text,text) returns bytea language sql immutable as $$ select case when lower($2)='sha256' then sha256(convert_to($1,'UTF8')) else null end $$;");
    let pending=snapshot.functions;
    while(pending.length){const retry=[],errors=[];for(const sql of pending){try{await db.exec(sql);}catch(e){retry.push(sql);errors.push(e.message);}}if(retry.length===pending.length)throw new Error(errors.join('\n'));pending=retry;}
    for(const c of snapshot.constraints.filter(c=>c.type!=='f'&&c.type!=='t'))await db.exec(`alter table ${c.schema}.${c.table} add constraint ${c.name} ${c.def};`);
    for(const c of snapshot.constraints.filter(c=>c.type==='f'))await db.exec(`alter table ${c.schema}.${c.table} add constraint ${c.name} ${c.def};`);
    // The original snapshot excludes standalone indexes; retain ticket/completion domain partial uniqueness (2026-10-06).
    for(const index of require('./schema-current-ticket-indexes.json'))await db.exec(index.ddl+';');
    for(const t of snapshot.triggers)await db.exec(t.def+';');
    await db.exec('begin;'+['20261005101816_prepare_current_schema_contract.sql','20261005101853_retire_unused_legacy_schema.sql','20261005121343_fix_rate_limit_after_test_mode_cleanup.sql'].map(name=>fs.readFileSync(path.resolve(__dirname,'../../../supabase/migrations',name),'utf8')).join('\n')+'commit;');
    return db;
  }catch(e){await db.close();throw e;}
};
