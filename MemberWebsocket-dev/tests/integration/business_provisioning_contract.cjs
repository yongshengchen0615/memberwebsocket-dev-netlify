const {test}=require('node:test');
test('AC-003: fresh merchants retain ticket groups and calendar settlement contracts',async()=>{
 await require('./fixtures/provisioning-contract.cjs')();
});
