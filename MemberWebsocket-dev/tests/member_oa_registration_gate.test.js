const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

test('FJG02-RED: member-profile-api rejects pending activation before terms RPC',()=>{
 const s=read('supabase/functions/member-profile-api/index.ts');
 const pending=s.indexOf('if (member.membership_status !== "active")',s.indexOf('const mergedComplete'));
 const rpc=s.indexOf('supabase.rpc("accept_membership_terms_api"',pending);
 const gate=s.indexOf('await requireMemberOaBeforeActivation(',pending);
 assert.ok(pending>0 && gate>pending && rpc>gate,'member-profile-api must verify member OA before activation RPC');
});
test('FJG02-RED: legacy api rejects pending activation before legacy terms RPC',()=>{
 const s=read('supabase/functions/api/index.ts');
 const action=s.indexOf('if (action === "user.member.profile.save")');
 const rpc=s.indexOf('supabase.rpc("accept_membership_terms"',action);
 const gate=s.indexOf('await requireMemberOaBeforeActivation(',action);
 assert.ok(action>0 && gate>action && rpc>gate,'legacy API must check same gate before terms RPC');
});
test('FJG02-RED: member write sends LINE user access token separately from ID token',()=>{
 const s=read('member-system.js');
 assert.match(s,/action === 'user\.member\.profile\.save'/);
 assert.match(s,/window\.liff\.getAccessToken\(\)/);
 assert.match(s,/lineAccessToken/);
});
test('FJG02-RED: trusted binding gate is unit tested and not inferred from client bool',()=>{
 const s=read('supabase/functions/_shared/member-oa-registration-gate.mjs');
 assert.match(s,/verifiedBindingsJson/);
 assert.match(s,/tenant\.id/);
 assert.doesNotMatch(s,/body\.friendFlag|body\.memberOaLinked/);
});
