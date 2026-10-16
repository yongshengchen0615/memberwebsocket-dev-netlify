const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const coverage=require('../e2e-feature-coverage.js');
const matrix=require('./trello-e2e-coverage.json');
const root=path.resolve(__dirname,'..');

test('QA and completed card matrix links every card to existing evidence and registered features',()=>{
  const features=new Set(coverage.catalog.map(row=>row.id));
  const paired=fs.readFileSync(path.join(root,'admin/e2e-control.js'),'utf8');
  assert.equal(matrix.cards.length,44);
  assert.equal(new Set(matrix.cards.map(row=>row.card)).size,44);
  assert.equal(matrix.cards.filter(row=>row.list==='QA').length,11);
  assert.equal(matrix.cards.filter(row=>row.list==='完成').length,33);
  assert.equal(matrix.cards.reduce((sum,row)=>sum+row.checklistTotal,0),409);
  assert.equal(matrix.cards.reduce((sum,row)=>sum+row.checklistOpen,0),83);
  for(const row of matrix.cards){
    assert.match(row.card,/^https:\/\/trello.com\/c\/[A-Za-z0-9]+$/);
    assert.ok(row.remaining.length>0,row.card);
    assert.ok(row.runtimeFeatureIds.length>0,row.card);
    assert.ok(row.evidencePaths.length>0,row.card);
    for(const id of row.runtimeFeatureIds)assert.ok(features.has(id),'Missing feature '+id+' for '+row.card);
    for(const file of row.evidencePaths)assert.ok(fs.existsSync(path.join(root,file)),'Missing evidence '+file+' for '+row.card);
    for(const key of row.pairedKeys)assert.ok(paired.includes("caseDef('"+key+"'"),'Missing paired node '+key);
    assert.ok(row.checklistOpen>=0&&row.checklistOpen<=row.checklistTotal);
  }
});
