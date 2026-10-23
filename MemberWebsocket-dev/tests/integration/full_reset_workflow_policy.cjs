const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const workflow=fs.readFileSync(path.join(__dirname,'../../../.github/workflows/memberwebsocket-sandbox-reset.yml'),'utf8');

test('AC-CLR-030: irreversible reset can be launched only through manual owner-specific workflow',()=>{
 assert.match(workflow,/^on:\s*\n\s{2}workflow_dispatch:\s*$/m);
 assert.doesNotMatch(workflow,/^\s{2}(push|pull_request|schedule|repository_dispatch):\s*$/m);
 assert.match(workflow,/if:\s*github\.actor == 'yongshengchen0615'/);
 assert.match(workflow,/environment:\s*memberwebsocket-dev-reset/);
 assert.match(workflow,/Verify independent environment reviewer protection/);
 assert.match(workflow,/verify_reset_environment\.cjs/);
 assert.match(workflow,/cancel-in-progress:\s*false/);
 assert.match(workflow,/default:\s*plan/);
 assert.match(workflow,/RESET MEMBERWEBSOCKET TEST DATA/);
 assert.match(workflow,/DISPATCH_DISABLED_AND_EXTERNAL_WEBHOOKS_ISOLATED/);
});

test('AC-CLR-031: guarded workflow never uploads unencrypted dump, keys or source payloads',()=>{
 assert.match(workflow,/RESET_DB_URL:\s*\$\{\{\s*secrets\.RESET_DB_URL\s*\}\}/);
 assert.match(workflow,/SUPABASE_SERVICE_ROLE_KEY:\s*\$\{\{\s*secrets\.RESET_SERVICE_ROLE_KEY\s*\}\}/);
 assert.match(workflow,/RESET_BACKUP_KEY_B64:\s*\$\{\{\s*secrets\.RESET_BACKUP_KEY_B64\s*\}\}/);
 assert.match(workflow,/--plan/);
 assert.match(workflow,/--execute/);
 assert.match(workflow,/if:\s*always\(\) && inputs\.operation == 'execute'/);
 assert.match(workflow,/\/\*\.enc/);
 assert.doesNotMatch(workflow,/^\s+path:\s*.*\.(dump|tmp|json|env)\s*$/m);
});
