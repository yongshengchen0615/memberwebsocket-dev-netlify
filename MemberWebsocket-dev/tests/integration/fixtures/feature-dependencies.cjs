const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../..');
module.exports=async db=>{
  await db.exec(`create schema platform_private;create schema business_a;create schema business_b;
   create table platform_private.tenants(id text,runtime_schema text,features jsonb);
   create table public.job_calls(tenant text,kind text);
   create table business_a.fixed_ticket_templates(status text,calendar_enabled boolean);
   create table business_b.fixed_ticket_templates(status text,calendar_enabled boolean);
   insert into business_a.fixed_ticket_templates values('active',true);
   insert into business_b.fixed_ticket_templates values('active',false);
   insert into platform_private.tenants values('A','business_a','{"events":true,"calendar":false}'),('B','business_b','{"events":true,"calendar":false}');
   create function business_a.issue_fixed_tickets() returns int language plpgsql as $$begin insert into public.job_calls values('A','fixed');return 1;end$$;
   create function business_b.issue_fixed_tickets() returns int language plpgsql as $$begin insert into public.job_calls values('B','fixed');return 1;end$$;
   create function public.platform_tick_businesses() returns int language plpgsql as $$declare t record;due boolean;begin
    for t in select * from platform_private.tenants loop
     if (t.features->>'events')::boolean then execute format('select %I.issue_fixed_tickets()',t.runtime_schema); end if;
     insert into public.job_calls values(t.id,'other');
    end loop;return 2;end$$;`);
  const dir=path.join(root,'supabase/migrations'),name=fs.readdirSync(dir).find(name=>name.endsWith('_fixed_ticket_calendar_dependency.sql'));
  assert.ok(name);const sql=fs.readFileSync(path.join(dir,name),'utf8');
  await db.exec(sql);await db.exec(sql);
  await db.query('select public.platform_tick_businesses()');
  assert.deepEqual((await db.query("select tenant,kind from public.job_calls order by tenant,kind")).rows,[{tenant:'A',kind:'other'},{tenant:'B',kind:'fixed'},{tenant:'B',kind:'other'}]);
  await db.exec(`truncate public.job_calls;update platform_private.tenants set features='{"events":true,"calendar":true}' where id='A'`);
  await db.query('select public.platform_tick_businesses()');
  assert.equal((await db.query("select count(*)::int n from public.job_calls where kind='fixed'")).rows[0].n,2);

};
