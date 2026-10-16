const {test}=require('node:test');
const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const fs=require('node:fs');
const path=require('node:path');
test('scheduler health reports missing/stale/disabled/failed jobs and protects cron secrets',async()=>{
  const db=new PGlite();
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role;create schema cron;
      create table cron.job(jobid int,jobname text,schedule text,active boolean,command text);
      create table cron.job_run_details(jobid int,runid int,status text,start_time timestamptz,end_time timestamptz,return_message text);
      insert into cron.job values(1,'issue-fixed-tickets','5 16 * * *',true,'SECRET-COMMAND'),
        (2,'dispatch-scheduled-grant-messages','* * * * *',true,'SECRET-COMMAND'),
        (3,'dispatch-booking-line-notifications','15 seconds',false,'SECRET-COMMAND'),
        (4,'sync-booking-day-before-reminders','*/5 * * * *',true,'SECRET-COMMAND');
      insert into cron.job_run_details values(1,1,'succeeded',now()-interval '25 hours',now(),'SECRET-ERROR'),
        (2,2,'succeeded',now()-interval '16 minutes',now(),'SECRET-ERROR'),
        (3,3,'succeeded',now(),now(),'SECRET-ERROR'),(4,4,'failed',now(),now(),'SECRET-ERROR');`);
    await db.exec(fs.readFileSync(path.join(__dirname,'../../supabase/migrations/20261004051846_e2e_automation_health.sql'),'utf8'));
    const health=(await db.query('select admin_e2e_automation_health() as value')).rows[0].value;
    assert.equal(health.jobs.length,5);
    const find=name=>health.jobs.find(job=>job.name===name);
    assert.equal(find('issue-fixed-tickets').fresh,true);
    assert.equal(find('dispatch-scheduled-grant-messages').fresh,false);
    assert.equal(find('dispatch-booking-line-notifications').active,false);
    assert.equal(find('sync-booking-day-before-reminders').lastStatus,'failed');
    assert.equal(find('prune-e2e-failure-artifacts').active,false);
    assert.equal(find('prune-e2e-failure-artifacts').lastStatus,null);
    assert.doesNotMatch(JSON.stringify(health),/SECRET|command|return_message/);
    assert.equal((await db.query("select has_function_privilege('anon','admin_e2e_automation_health()','execute') allowed")).rows[0].allowed,false);
    assert.equal((await db.query("select has_function_privilege('service_role','admin_e2e_automation_health()','execute') allowed")).rows[0].allowed,true);
  }finally{await db.close();}
});
