// Generate a reviewable, immutable business template. Never captures table data.
import fs from 'node:fs';
import snapshot from '../MemberWebsocket-dev/tests/integration/fixtures/business-template.cjs';
const target=process.argv[2];
if(!target || !/supabase\/migrations\/\d+_business_runtime\.sql$/.test(target))throw Error('Pass the CLI-created business_runtime migration');
let body=fs.readFileSync('scripts/business-runtime.sql','utf8');
const applications=fs.readFileSync('MemberWebsocket-dev/supabase/migrations/20261017164510_platform_admin_applications.sql','utf8');
let approval=applications.match(/create function public.platform_approve_application\([\s\S]*?end \$\$;/)[0];
approval=approval.replace('create function','create or replace function').replace(" update platform_private.applications set status='approved'", " perform public.platform_provision_business(v_tenant.id);\n select * into v_tenant from platform_private.tenants where id=v_tenant.id;\n update platform_private.applications set status='approved'");
body=body.replace('-- APPROVAL_FUNCTION',()=>approval);
if(JSON.stringify(snapshot).includes('$business_template$'))throw Error('Unsafe template delimiter');
fs.writeFileSync(target,body.replace('-- IMMUTABLE_TEMPLATE',()=>`insert into platform_private.business_templates(version,snapshot) values ('business-v1-20261019',$business_template$${JSON.stringify(snapshot)}$business_template$::jsonb);`));
