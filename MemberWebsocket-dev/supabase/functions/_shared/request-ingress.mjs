export class RequestIngressError extends Error {
  constructor(status,code,message){super(message);this.status=status;this.code=code;}
}

// The absolute deadline includes every chunk. Neither a slow sender nor a
// cancellation promise controlled by that sender may hold the response open.
export async function readRequestBytes(request,maxBytes,timeoutMs=10000){
  if(Number(request.headers.get('content-length'))>maxBytes){
    void request.body?.cancel().catch(()=>{});
    throw new RequestIngressError(413,'BODY_TOO_LARGE','請求資料過大。');
  }
  if(!request.body)return new Uint8Array();
  const reader=request.body.getReader(),chunks=[];
  let size=0,complete=false,timer;
  const deadline=new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(new RequestIngressError(408,'REQUEST_TIMEOUT','請求傳送逾時。')),timeoutMs);
  });
  try{
    // Race the whole consume operation once. Racing every chunk against the
    // same pending deadline retains a promise reaction for every tiny chunk.
    const consume=async()=>{
      while(true){
        const {done,value}=await reader.read();
        if(done){complete=true;break;}
        size+=value.byteLength;
        if(size>maxBytes)throw new RequestIngressError(413,'BODY_TOO_LARGE','請求資料過大。');
        chunks.push(value);
      }
      const bytes=new Uint8Array(size);let offset=0;
      for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
      return bytes;
    };
    return await Promise.race([consume(),deadline]);
  }finally{
    clearTimeout(timer);
    if(!complete)void reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
}
