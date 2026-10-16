const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const root = path.join(__dirname, '../supabase/functions');
const source = fs.readFileSync(path.join(root, '_shared/request-body.ts'), 'utf8');
const context = vm.createContext({ TextDecoder, setTimeout, clearTimeout });
vm.runInContext(stripTypeScriptTypes(source).replace('export async', 'async'), context);
const read = context.readJsonObject;
class ApiError extends Error { constructor(status, code, message) { super(message); Object.assign(this, {status, code}); } }
const request = (body, headers = {}) => new Request('https://example.test', { method: 'POST', body, headers });

test('accepts UTF-8 JSON at the exact byte limit, including split multibyte sequences', async () => {
  const bytes = new TextEncoder().encode('{"name":"會員"}');
  const stream = new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close(); } });
  const req = new Request('https://example.test', {method:'POST', body:stream, duplex:'half'});
  assert.equal((await read(req, bytes.length, ApiError)).name, '會員');
  await assert.rejects(read(request('{"name":"會員"}'), bytes.length - 1, ApiError), {status:413});
});
test('rejects malformed, empty, scalar, array and null payloads', async () => {
  for (const input of ['', '{', 'null', '[]', 'true', '123', '"text"']) {
    await assert.rejects(read(request(input), 100, ApiError), {status:400});
  }
  await assert.rejects(read(request(new Uint8Array([0xff])), 100, ApiError), {code:'INVALID_JSON'});
});
test('rejects oversized declared length without reading and cancels the stream', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  const req = { headers:new Headers({'content-length':'101'}), body:stream };
  await assert.rejects(read(req,100,ApiError), {status:413});
  assert.ok(cancelled);
});
test('enforces actual size without Content-Length and with an understated header', async () => {
  for (const length of [null, '1']) {
    let pulls=0, cancelled=false;
    const stream=new ReadableStream({ pull(c) { pulls++; c.enqueue(new Uint8Array(60)); }, cancel() {cancelled=true;} });
    const headers=new Headers(); if(length)headers.set('content-length',length);
    await assert.rejects(read({headers,body:stream},100,ApiError), {status:413});
    assert.ok(cancelled); assert.ok(pulls<=3);
  }
});
test('stalled request times out and cancels without waiting for cancellation', async () => {
  let cancelled=false;
  const stream=new ReadableStream({cancel(){cancelled=true; return new Promise(()=>{});}});
  await assert.rejects(read({headers:new Headers(),body:stream},100,ApiError,10), {status:408});
  assert.ok(cancelled);
});

for (const name of ['api','booking-api','booking-admin-api','booking-admin-operations','booking-group-api','booking-group-slots-api','booking-calendar-api','booking-cancellation-api','event-ticket-links','grant-automation','member-profile-api','booking-contact-api']) {
  test(`${name}: invalid JSON is rejected before identity verification or database access`, async () => {
    let handler;
    const sandbox = vm.createContext({
      Deno:{serve(fn){handler=fn;},env:{get(){return '';}}},
      Request, Response, Headers, TextEncoder, URLSearchParams, Date, console,
      readJsonObject:read,
      fetch(){throw Error('Unexpected network access');},
      createClient(){throw Error('Unexpected database access');},
    });
    if (name === 'booking-contact-api') {
      const shared = fs.readFileSync(path.join(root,name,'shared.ts'),'utf8').replace(/^import[^;]+;\n/gm,'').replace(/^export /gm,'');
      vm.runInContext(stripTypeScriptTypes(shared),sandbox);
    }
    let code=fs.readFileSync(path.join(root,name,'index.ts'),'utf8').replace(/^import[^;]+;\n/gm,'').replace(/^export default .+;$/gm,'');
    vm.runInContext(stripTypeScriptTypes(code),sandbox);
    handler ||= sandbox.handleRequest;
    for (const input of ['null','[]','{','']) {
      const response=await handler(request(input));
      assert.equal(response.status,400,`${name}: ${input}`);
      assert.equal((await response.json()).ok,false);
    }
    const large=await handler(request('{"padding":"'+'x'.repeat(1000000)+'"}'));
    assert.equal(large.status,413);
  });
}
