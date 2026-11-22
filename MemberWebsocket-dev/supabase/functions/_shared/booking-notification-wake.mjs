const endpoints=new Set(['booking-api','booking-group-api','booking-admin-operations','booking-cancellation-api']);
function eligible({name,context,body,response}) {
  if(!context || !endpoints.has(name) || !response.ok) return false;
  const action=String(body?.action||'');
  return action==='admin.booking.reject-walkin' || /(?:create|update|complete|request|approve|reject)$/.test(action);
}
async function committed(response) {
  const payload=await response.clone().json().catch(()=>null);
  return payload?.ok===true;
}
async function dispatchTrusted(context,dispatch) {
  // The durable outbox is authoritative; a failed wake must never turn a
  // committed booking into a failed API operation. The tenant scheduler retries.
  try {const result=await dispatch(context.id);return !result?.error && result?.data===true;}
  catch {return false;}
}
export async function wakeBookingNotifications(input) {
  if(!eligible(input) || !await committed(input.response)) return false;
  return dispatchTrusted(input.context,input.dispatch);
}
export async function scheduleBookingNotificationWake(input,waitUntil) {
  if(!eligible(input) || !await committed(input.response)) return false;
  const task=dispatchTrusted(input.context,input.dispatch);
  // Supabase EdgeRuntime tracks this task after the HTTP response. No
  // untracked fire-and-forget, and local runtimes retain the awaited fallback.
  if(typeof waitUntil==='function') {
    try {waitUntil(task);return true;}catch {return task;}
  }
  return task;
}
