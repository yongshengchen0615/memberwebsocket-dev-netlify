import { openCredentials } from './platform-crypto.mjs';

const encoder = new TextEncoder();
const botId = /^U[0-9a-f]{32}$/;
const types = new Set(['message','follow','unfollow','join','leave','memberJoined','memberLeft','postback','beacon','accountLink','things','unsend','videoPlayComplete']);
class IngressError extends Error {
  constructor(status, code) { super(code); this.status=status; this.code=code; }
}
async function deadline(promise, ms, status=503) {
  let timer;
  try { return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new IngressError(status,'TIMEOUT')),ms);})]); }
  finally { clearTimeout(timer); }
}
async function rawBody(request, timeout) {
  const reader=request.body?.getReader();
  if (!reader) throw new IngressError(400,'INVALID_BODY');
  const chunks=[];let length=0;
  try {
    const read=async()=>{while(true){
      const {done,value}=await reader.read();if(done)break;
      length+=value.byteLength;if(length>262144)throw new IngressError(413,'BODY_TOO_LARGE');
      chunks.push(value);
    }};
    await deadline(read(),timeout,408);
  } catch(error) { void reader.cancel().catch(()=>{}); throw error; }
  finally { reader.releaseLock(); }
  const bytes=new Uint8Array(length);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return bytes;
}
export async function verifyLineSignature(raw, signature, secret) {
  if(typeof secret!=='string'||!secret) return false;
  try {
    const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
    return await crypto.subtle.verify('HMAC',key,Uint8Array.from(atob(signature),c=>c.charCodeAt(0)),raw);
  } catch { return false; }
}
export function createLineWebhookHandler({db,encryptionKey,bodyTimeoutMs=3000,rpcTimeoutMs=5000}) {
  return async request=>{
    const json=(status,code)=>new Response(JSON.stringify(code?{ok:false,error:{code}}:{ok:true}),{
      status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...(status===405?{Allow:'POST'}:{}),...(status===429?{'Retry-After':'60'}:{})},
    });
    const rpc=async(name,params)=>{
      const result=await deadline(db.rpc(name,params),rpcTimeoutMs);
      if(result.error)throw new IngressError(String(result.error.message).includes('LINE_WEBHOOK_RATE_LIMIT')?429:503,'STORAGE_UNAVAILABLE');
      return result.data;
    };
    try {
      if(request.method!=='POST')throw new IngressError(405,'METHOD_NOT_ALLOWED');
      const signature=request.headers.get('x-line-signature')||'';
      // A SHA-256 digest has exactly 32 bytes, represented by 44 Base64 chars.
      // Reject combined duplicate headers and non-canonical Base64 up front.
      if(!/^[A-Za-z0-9+/]{43}=$/.test(signature)||btoa(atob(signature))!==signature)throw new IngressError(401,'INVALID_SIGNATURE');
      const raw=await rawBody(request,bodyTimeoutMs);
      let payload;
      try { payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)); }
      catch {throw new IngressError(400,'INVALID_BODY');}
      if(!payload||!botId.test(payload.destination)||!Array.isArray(payload.events)||payload.events.length>100)
        throw new IngressError(400,'INVALID_BODY');
      // Destination only narrows the candidate; no business data is read here.
      const candidates=await rpc('platform_line_webhook_candidate',{p_destination:payload.destination});
      if(!Array.isArray(candidates)||!candidates.length||candidates.length>5)throw new IngressError(401,'INVALID_SIGNATURE');
      let candidate,storageError=false;
      const key=await encryptionKey();
      // A shared Channel can have several module bindings. Only a membership
      // binding whose own credential verifies may establish OA observations.
      const ordered=[...candidates].sort((a,b)=>Number(b.feature==='membership')-Number(a.feature==='membership'));
      for(const option of ordered){
        try{
          const scope=option.tenantId+(option.scope==='module'?':'+option.feature:'');
          const credentials=await openCredentials(scope,option.envelope,key);
          if(await verifyLineSignature(raw,signature,credentials.channelSecret)){candidate=option;break;}
        }catch{storageError=true;}
      }
      if(!candidate)throw new IngressError(storageError?503:401,storageError?'INGRESS_UNAVAILABLE':'INVALID_SIGNATURE');
      const events=payload.events.map(event=>{
        if(!event||typeof event.webhookEventId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(event.webhookEventId)
          ||!Number.isSafeInteger(event.timestamp)||event.timestamp<0||event.timestamp>8640000000000000
          ||typeof event.type!=='string'||event.type.length>100)
          throw new IngressError(400,'INVALID_EVENT');
        const receipt={eventId:event.webhookEventId,type:types.has(event.type)?event.type:'other',timestamp:event.timestamp,redelivery:event.deliveryContext?.isRedelivery===true};
        if((event.type==='follow'||event.type==='unfollow')&&event.source?.type==='user'&&typeof event.source.userId==='string'&&botId.test(event.source.userId))
          receipt.sourceUserId=event.source.userId;
        return receipt;
      });
      // This transaction rechecks current grant + credential revision, deduplicates
      // and persists terminal receipts plus private membership OA observations.
      // Observations never register members or issue rewards.
      await rpc('platform_line_webhook_ingest',{p_channel_id:candidate.channelId,p_feature:candidate.feature,p_revision:candidate.revision,p_events:events});
      return json(200);
    } catch(error) {
      const safe=error instanceof IngressError?error:new IngressError(503,'INGRESS_UNAVAILABLE');
      return json(safe.status,safe.code);
    }
  };
}
