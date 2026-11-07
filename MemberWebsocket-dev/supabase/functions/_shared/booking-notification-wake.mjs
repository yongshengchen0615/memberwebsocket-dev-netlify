const endpoints=new Set(['booking-api','booking-group-api','booking-admin-operations','booking-cancellation-api']);
export async function wakeBookingNotifications({name,context,body,response,dispatch}) {
 if(!context || !endpoints.has(name) || !response.ok) return false;
 const action=String(body?.action||'');
 if(!/(?:create|update|complete|request|approve|reject)$/.test(action))return false;
 const payload=await response.clone().json().catch(()=>null);
 if(payload?.ok!==true)return false;
 // The outbox is authoritative. A wake-up failure must never turn a committed
 // booking into an apparent failure; the durable cron retries pending work.
 try {const result=await dispatch(context.id);return !result?.error && result?.data===true;}
 catch {return false;}
}
