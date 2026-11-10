const {test}=require('node:test');
const database=require('./database.cjs');
test('PG17 AC-003: new merchant ticket/bonus schema, RPC behavior and grants',async()=>{
 await require('../fixtures/provisioning-contract.cjs')({...await database()});
});
