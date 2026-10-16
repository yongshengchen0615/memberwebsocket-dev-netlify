const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.join(__dirname, '../..');
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function receiptHarness() {
  const dom = new JSDOM('<div id="bookingView"></div><div id="bookingList"><article data-booking-id="booking"></article></div>', { runScripts:'outside-only',url:'https://example.test/',pretendToBeVisual:true });
  const w = dom.window;
  const cameras = [], actions = [], closes = [];
  const finalize = deferred();
  let uploads = 0;
  Object.defineProperty(w.navigator, 'mediaDevices', { value: { getUserMedia() { const pending = deferred(); cameras.push(pending); return pending.promise; } } });
  w.HTMLMediaElement.prototype.play = async () => {};
  w.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
  w.HTMLCanvasElement.prototype.toBlob = callback => callback(new w.Blob(['image'], { type:'image/jpeg' }));
  w.BookingSystem = { getSession:() => ({ config:{},idToken:'fixture' }), request:async (_,__,___,action) => {
    actions.push(action);
    if (action === 'user.booking.receipt.list') return { bookings:[{ bookingId:'booking',canSubmitReceipt:true,updatedAt:'version' }] };
    if (action === 'user.booking.receipt.prepare') return { receiptId:'receipt',objectPath:'object',uploadToken:'token' };
    if (action === 'user.booking.receipt.finalize') return finalize.promise;
    throw new Error('Unexpected action');
  } };
  w.supabase = { createClient:() => ({ storage:{ from:() => ({ uploadToSignedUrl:async () => { uploads++; return {}; } }) } }) };
  const timeout = w.setTimeout.bind(w);
  w.setTimeout = (callback, ms) => ms === 900 ? closes.push(callback) : timeout(callback, ms);
  w.eval(fs.readFileSync(path.join(root, 'booking/booking-receipt.js'), 'utf8'));
  w.dispatchEvent(new w.Event('booking:bookings-rendered'));
  await tick();
  const el = id => w.document.getElementById(id);
  const open = () => w.document.querySelector('[data-booking-receipt-control] button').click();
  const activate = async index => {
    const stream = { stops:0,getTracks() { return [{ stop:() => stream.stops++ }]; } };
    cameras[index].resolve(stream);
    await tick();
    Object.defineProperty(el('bookingReceiptCamera'), 'videoWidth', { value:100,configurable:true });
    Object.defineProperty(el('bookingReceiptCamera'), 'videoHeight', { value:100,configurable:true });
    return stream;
  };
  return { dom,w,el,open,activate,cameras,actions,finalize,closes,uploads:() => uploads };
}

test('late camera permission cannot activate a closed receipt dialog or survive navigation', async () => {
  const h = await receiptHarness();
  try {
    h.open();
    h.el('bookingReceiptClose').click();
    const old = await h.activate(0);
    assert.equal(old.stops,1);
    assert.equal(h.el('bookingReceiptCamera').srcObject,null);
    assert.equal(h.el('bookingReceiptCapture').disabled,true);
    h.open();
    h.w.dispatchEvent(new h.w.Event('pagehide'));
    assert.equal((await h.activate(1)).stops,1);
  } finally { h.dom.window.close(); }
});

test('receipt submission locks retake and closes immediately after commit, preventing duplicate uploads', async () => {
  const h = await receiptHarness();
  try {
    h.open(); await h.activate(0);
    h.el('bookingReceiptCapture').click(); await tick();
    assert.equal(h.el('bookingReceiptSubmit').disabled,false);
    h.el('bookingReceiptSubmit').click(); await tick();
    assert.equal(h.el('bookingReceiptRetake').disabled,true);
    h.finalize.resolve({ receiptId:'receipt',status:'awaiting_review' }); await tick();
    assert.equal(h.el('bookingReceiptSubmit').disabled,true,'Success feedback must not unlock submission');
    h.el('bookingReceiptSubmit').dispatchEvent(new h.w.Event('click'));
    assert.equal(h.actions.filter(action => action === 'user.booking.receipt.prepare').length,1);
    assert.equal(h.uploads(),1);
    assert.equal(h.closes.length,0,'Successful close must not depend on a background timer');
    assert.equal(h.el('bookingReceiptModal').classList.contains('hidden'),true);
    await tick();
  } finally { h.dom.window.close(); }
});

test('late photo reads cannot revive a closed receipt dialog', async () => {
  const h = await receiptHarness();
  try {
    let reader;
    h.w.FileReader = class { constructor() { reader=this; } readAsDataURL() {} };
    h.open(); await h.activate(0);
    h.el('bookingReceiptCapture').click();
    h.el('bookingReceiptClose').click();
    reader.result = 'data:image/jpeg;base64,aW1hZ2U=';
    reader.onload();
    assert.equal(h.el('bookingReceiptSubmit').disabled,true);
    assert.equal(h.el('bookingReceiptPreview').hasAttribute('src'),false);
  } finally { h.dom.window.close(); }
});

test('point transfer discards stale receiver reads, locks inputs, preserves retry identity and refreshes visible balance', async () => {
  const dom = new JSDOM('<div id="pointsView"></div><div id="activeCardView" data-card-id="card"></div><button id="pointTransferButton"></button>', { runScripts:'outside-only',url:'https://example.test/',pretendToBeVisual:true });
  const w = dom.window, receivers = [], transfers = [];
  let balance = 20;
  w.confirm = () => true;
  w.MemberSystem = { getSession:() => ({ config:{},idToken:'fixture' }), request:async (_,__,___,action,payload) => {
    if (action === 'points.transfer.options') return { cards:[{ cardId:'card',title:'Card',balance }] };
    if (action === 'points.transfer.receiver') { const result=deferred(); receivers.push({ ...result,code:payload.memberCode }); return result.promise; }
    if (action === 'points.transfer.create') { const result=deferred(); transfers.push({ ...result,payload }); return result.promise; }
    throw new Error('Unexpected action');
  } };
  try {
    w.eval(fs.readFileSync(path.join(root,'points/point-transfer.js'),'utf8'));
    w.dispatchEvent(new w.CustomEvent('user-tour:ready',{ detail:{ surface:'points',profile:{ memberCode:'SELF' } } }));
    await tick();
    const el = id => w.document.getElementById(id);
    el('pointTransferButton').click();
    el('pointTransferMemberCode').value='OLD'; el('pointTransferLookup').click();
    el('pointTransferMemberCode').value='NEW'; el('pointTransferMemberCode').dispatchEvent(new w.Event('input'));
    el('pointTransferLookup').click();
    receivers[1].resolve({ memberCode:'NEW',displayName:'New receiver' }); await tick();
    receivers[0].resolve({ memberCode:'OLD',displayName:'Old receiver' }); await tick();
    assert.match(el('pointTransferReceiver').textContent,/NEW/);
    el('pointTransferAmount').value='2';
    el('pointTransferForm').dispatchEvent(new w.Event('submit',{ cancelable:true })); await tick();
    assert.equal(transfers.length,1);
    for (const id of ['pointTransferMemberCode','pointTransferAmount','pointTransferLookup','pointTransferClose']) assert.equal(el(id).disabled,true);
    // An uncertain result must retry the same immutable request id.
    transfers[0].resolve(Promise.reject(Object.assign(new Error('uncertain'),{code:'API_RESPONSE_UNCERTAIN'}))); await tick();
    const pending=JSON.parse(w.sessionStorage.getItem('point-transfer-pending:v1:SELF'));
    assert.equal(pending.requestId,transfers[0].payload.requestId);
    assert.equal(el('pointTransferMemberCode').disabled,true,'Uncertain result locks immutable receiver');
    el('pointTransferForm').dispatchEvent(new w.Event('submit',{ cancelable:true })); await tick();
    assert.equal(transfers[1].payload.requestId,transfers[0].payload.requestId);
    transfers[1].resolve({ transferId:'transfer',senderBalance:18 }); balance=18; await tick();
    assert.equal(el('pointTransferAmount').max,'18');
    assert.match(el('pointTransferCardSummary').textContent,/18/);
    assert.equal(el('pointTransferMemberCode').disabled,false);
    assert.equal(w.sessionStorage.getItem('point-transfer-pending:v1:SELF'),null);
  } finally { w.close(); }
});

test('reload with an uncertain transfer restores exactly the previous request identity even after balance reaches zero',async()=>{
  const dom=new JSDOM('<div id="pointsView"></div><div id="activeCardView" data-card-id="card"></div><button id="pointTransferButton"></button>',{runScripts:'outside-only',url:'https://example.test/',pretendToBeVisual:true});
  const w=dom.window, calls=[];
  const pending={cardId:'card',memberCode:'RECEIVER',amount:3,requestId:'pt-original-unique-123'};
  w.sessionStorage.setItem('point-transfer-pending:v1:SELF',JSON.stringify(pending));
  w.confirm=()=>true;
  w.MemberSystem={getSession:()=>({config:{},idToken:'fixture'}),request:async(_,__,___,action,payload)=>{
    if(action==='points.transfer.options')return {cards:[]};
    if(action==='points.transfer.create'){calls.push(payload);return {transferId:'previous-transfer',senderBalance:0,alreadyApplied:true};}
    throw new Error('Unexpected action: '+action);
  }};
  try{
    w.eval(fs.readFileSync(path.join(root,'points/point-transfer.js'),'utf8'));
    w.dispatchEvent(new w.CustomEvent('user-tour:ready',{detail:{surface:'points',profile:{memberCode:'SELF'}}}));
    await tick();
    const el=id=>w.document.getElementById(id);
    assert.equal(el('pointTransferButton').disabled,false);
    el('pointTransferButton').click();
    assert.equal(el('pointTransferMemberCode').value,'RECEIVER');
    assert.equal(el('pointTransferAmount').value,'3');
    assert.equal(el('pointTransferAmount').max,'');
    assert.equal(el('pointTransferMemberCode').disabled,true);
    el('pointTransferForm').dispatchEvent(new w.Event('submit',{cancelable:true}));
    await tick();
    assert.equal(calls.length,1);
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0])),pending);
    assert.equal(w.sessionStorage.getItem('point-transfer-pending:v1:SELF'),null);
    assert.match(el('pointTransferMessage').textContent,/previous-transfer/);
  }finally{w.close();}
});
