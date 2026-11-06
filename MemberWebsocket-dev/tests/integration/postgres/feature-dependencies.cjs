const {test}=require('node:test');
const database=require('./database.cjs');
test('AC-004 PostgreSQL: scheduler upgrade, replay and re-enable preserve tenant jobs',async()=>{
 const {db}=await database();
 try{await require('../fixtures/feature-dependencies.cjs')(db);}finally{await db.close();}
});
