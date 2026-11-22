const endpoints=new Set(['booking-api','booking-group-api','booking-admin-operations','booking-cancellation-api']);
export async function wakeBookingNotifications({name,context,body,response,dispatch}) {
 if(!context || !endpoints.has(name) || !response.ok) return false;
 const action=String(body?.action||'');
 // The admin walk-in rejection is one atomic rejected booking + confirmed
 // on-site replacement; its action suffix is not 'reject' or 'update'.
 // Wake the durable outbox immediately after the committed API response so
 // the member's rejection notice does not wait for the one-minute cron.
 if(action!=='admin.booking.reject-walkin' && !/(?:create|update|complete|request|approve|reject)$/.test(action))return false;
 const payload=await response.clone().json().catch(()=>null);
 if(payload?.ok!==true)return false;
 // The outbox is authoritative. A wake-up failure must never turn a committed
 // booking into an apparent failure; the durable cron retries pending work.
 try {const result=await dispatch(context.id);return !result?.error && result?.data===true;}
 catch {return false;}
}
