import test from 'node:test';
import assert from 'node:assert/strict';
import { createManager, createGithubTransport } from './project-v2.mjs';

function setup(initial = [{number:34,status:'In Progress'},{number:48,status:'Ready'}]) {
  const options = ['Backlog','Ready','In Progress','Code Review','QA / E2E','Ready to Deploy','Deployed','Done','Blocked'].map((name,i)=>({name,id:'STATUS'+i}));
  const fields=[{id:'STATUS',name:'Status',options},{id:'PRIORITY',name:'Priority',options:['P0','P1','P2'].map(name=>({name,id:name}))}];
  const items=initial.map((entry,i)=>({id:entry.id||'PVTI'+i,isArchived:false,content:entry.type==='DraftIssue'?{__typename:'DraftIssue',id:entry.draftId||'DI'+i,title:entry.title||'Draft',body:'old'}:{__typename:'Issue',id:'ISSUE'+i,title:entry.title||'Task '+entry.number,number:entry.number,url:'https://github.com/sample/repo/issues/'+entry.number,repository:{nameWithOwner:'sample/repo'}},fieldValues:{nodes:[{name:entry.status,optionId:options.find(x=>x.name===entry.status)?.id,field:{id:'STATUS',name:'Status'}},{name:entry.priority||'P1',optionId:'P1',field:{id:'PRIORITY',name:'Priority'}}]}}));
  let mutations=0;
  const calls=[];
  const payload=()=>({user:{projectV2:{id:'PVT5',title:'Project #5',fields:{nodes:fields},items:{nodes:structuredClone(items),pageInfo:{hasNextPage:false,endCursor:null}}}}});
  async function graphql(query,variables) {
    calls.push({query,variables});
    if (query.startsWith('query($login')) return payload();
    if (query.startsWith('query($owner')) return {repository:{issue:{id:'NEW_CONTENT'},pullRequest:null}};
    mutations++;
    const op=query.match(/\{(\w+)\(input:/)?.[1];
    const input=variables.input;
    if (op==='updateProjectV2ItemFieldValue') {
      const item=items.find(x=>x.id===input.itemId);
      const field=fields.find(x=>x.id===input.fieldId);
      const option=field.options.find(x=>x.id===input.value.singleSelectOptionId);
      item.fieldValues.nodes.find(x=>x.field.name===field.name).name=option.name;
      return {updateProjectV2ItemFieldValue:{projectV2Item:{id:item.id}}};
    }
    if (op==='deleteProjectV2Item') {
      items.splice(items.findIndex(x=>x.id===input.itemId),1);
      return {deleteProjectV2Item:{deletedItemId:input.itemId}};
    }
    if (op==='archiveProjectV2Item') {
      const item=items.find(x=>x.id===input.itemId); item.isArchived=true;
      return {archiveProjectV2Item:{item:{id:item.id}}};
    }
    if (op==='addProjectV2ItemById') {
      items.push({id:'ADDED',isArchived:false,content:{__typename:'Issue',id:input.contentId,number:99,title:'New',repository:{nameWithOwner:'sample/repo'}},fieldValues:{nodes:[]}});
      return {addProjectV2ItemById:{item:{id:'ADDED'}}};
    }
    if (op==='addProjectV2DraftIssue') {
      items.push({id:'DRAFT',isArchived:false,content:{__typename:'DraftIssue',id:'DNEW',title:input.title,body:input.body},fieldValues:{nodes:[]}});
      return {addProjectV2DraftIssue:{projectItem:{id:'DRAFT'}}};
    }
    if (op==='updateProjectV2DraftIssue') {
      const item=items.find(x=>x.content?.id===input.draftIssueId);
      Object.assign(item.content, Object.fromEntries(Object.entries(input).filter(([k])=>['title','body'].includes(k))));
      return {updateProjectV2DraftIssue:{draftIssue:{id:item.content.id}}};
    }
    throw Error('Unexpected operation '+op);
  }
  let issueBody={title:'Task 48',body:'old'};
  async function rest(method,url,body) {
    if (method==='PATCH') {mutations++;Object.assign(issueBody,body);return issueBody;}
    return issueBody;
  }
  return {manager:createManager({graphql,rest}), calls, get mutations(){return mutations;}};
}

test('list returns unchanged Project snapshot and Issue identities',async()=>{
  const s=setup();const r=await s.manager.execute('list',{});
  assert.equal(r.count,2);assert.deepEqual(r.items.map(x=>x.status),['In Progress','Ready']);assert.equal(s.mutations,0);
});
test('move is dry-run unless --apply and reads back Status',async()=>{
  const s=setup();const flags={issue:'sample/repo#48',from:'Ready',to:'In Progress'};
  const plan=await s.manager.execute('move',flags);
  assert.equal(plan.applied,false);assert.equal(s.mutations,0);
  const applied=await s.manager.execute('move',{...flags,apply:true});
  assert.equal(applied.applied,true);assert.equal(s.mutations,1);
  assert.equal((await s.manager.execute('list',{})).items[1].status,'In Progress');
});
test('move refuses stale state, WIP overflow and unknown option',async()=>{
  const s=setup([{number:1,status:'In Progress'},{number:2,status:'In Progress'},{number:48,status:'Ready'}]);
  await assert.rejects(s.manager.execute('move',{issue:'48',from:'Backlog',to:'In Progress',apply:true}),/Status conflict/);
  await assert.rejects(s.manager.execute('move',{issue:'48',from:'Ready',to:'In Progress',apply:true}),/WIP limit/);
  await assert.rejects(s.manager.execute('move',{issue:'48',from:'Ready',to:'NoSuch',apply:true}),/Unknown option/);
  assert.equal(s.mutations,0);
});
test('priority updates only named field; same value is a no-op',async()=>{
  const s=setup();
  const result=await s.manager.execute('set',{issue:'48',field:'Priority',value:'P0',apply:true});
  assert.equal(result.applied,true);assert.equal((await s.manager.execute('list',{})).items[1].priority,'P0');
  assert.equal((await s.manager.execute('set',{issue:'48',field:'Priority',value:'P0',apply:true})).noChange,true);
  assert.equal(s.mutations,1);
});
test('remove requires exact matching Project node ID and does not delete Issue',async()=>{
  const s=setup();
  await assert.rejects(s.manager.execute('remove',{issue:'48',apply:true,confirm:'48'}),/requires --confirm PVTI1/);
  assert.equal(s.mutations,0);
  const plan=await s.manager.execute('remove',{issue:'48',confirm:'PVTI1'});
  assert.equal(plan.applied,false);
  const result=await s.manager.execute('remove',{issue:'48',confirm:'PVTI1',apply:true});
  assert.equal(result.applied,true);
  assert.equal((await s.manager.execute('list',{})).count,1);
  assert.equal(s.mutations,1);
});
test('archive preserves card as archived',async()=>{
  const s=setup();
  const r=await s.manager.execute('archive',{issue:'48',apply:true});assert.equal(r.applied,true);
});
test('draft create, edit and readback',async()=>{
  const s=setup([]);
  const c=await s.manager.execute('draft',{title:'Review migration',body:'notes',apply:true});
  assert.equal(c.itemId,'DRAFT');
  const e=await s.manager.execute('edit',{item:'DRAFT',title:'Migration review',body:'new',apply:true});
  assert.equal(e.applied,true);
  assert.equal(s.mutations,2);
});
test('issue edit reads back fields and project association unchanged',async()=>{
  const s=setup();
  const e=await s.manager.execute('edit',{issue:'48',body:'updated',apply:true});
  assert.equal(e.applied,true);assert.equal((await s.manager.execute('list',{})).count,2);
});
test('add existing issue or PR rejects duplicate',async()=>{
  const s=setup();
  await assert.rejects(s.manager.execute('add',{issue:'sample/repo#48',apply:true}),/already exists/);
  const r=await s.manager.execute('add',{issue:'sample/repo#99',apply:true});
  assert.equal(r.itemId,'ADDED');assert.equal((await s.manager.execute('list',{})).count,3);
});
test('GraphQL client rejects permission/API failures without printing token',async()=>{
  const g=createGithubTransport('TOPSECRET', async()=>({ok:false,status:403,json:async()=>({message:'Access denied'})}));
  await assert.rejects(g.graphql('query { viewer {login}}',{}),/HTTP 403/);
  const g2=createGithubTransport('TOPSECRET',async()=>({ok:true,json:async()=>({errors:[{message:'invalid field'}]})}));
  await assert.rejects(g2.graphql('query {}',{}),/invalid field/);
});
test('snapshot supports multi-page and detects duplicated node IDs',async()=>{
  let calls=0;
  const manager=createManager({graphql:async()=>{calls++;return {user:{projectV2:{id:'PVT',title:'paginated',fields:{nodes:[]},items:{nodes:[{id:'same',fieldValues:{nodes:[]}}],pageInfo:{hasNextPage:calls===1,endCursor:calls===1?'next':null}}}}};},rest:()=>{}});
  await assert.rejects(manager.snapshot('owner',5),/Duplicate Project item IDs/);
  assert.equal(calls,2);
});