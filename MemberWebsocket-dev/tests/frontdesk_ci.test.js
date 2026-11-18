const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
test('frontdesk physical PostgreSQL races and rollback tests are in the mandatory CI lane',()=>{
 const workflow=fs.readFileSync(path.resolve(__dirname,'../../.github/workflows/test-memberwebsocket-dev.yml'),'utf8');
 const lane=workflow.split('\n  postgres-integration:')[1].split('\n  edge-functions:')[0];
 assert.ok(lane.includes('MemberWebsocket-dev/tests/integration/postgres/frontdesk-access.cjs'));
 assert.ok(workflow.includes('POSTGRES_INTEGRATION: ${{ needs.postgres-integration.result }}'));
});
