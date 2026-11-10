// Diagnostics contain server-owned metadata only. Never pass request bodies,
// provider payloads, exception messages/stacks or database details to the log.
const codes=new Set([
  'DATABASE_ERROR','LINE_AUTH_UNAVAILABLE','ACCESS_CONTROL_UNAVAILABLE',
  'TEST_MODE_CHECK_FAILED','RATE_LIMIT_UNAVAILABLE','BUSINESS_ACCESS_UNAVAILABLE',
  'BUSINESS_UNAVAILABLE','AUTH_CONFIG_MISSING','SUPABASE_CONFIG_MISSING',
  'SYSTEM_MAINTENANCE','TERMS_UNAVAILABLE','LOGIN_CLAIM_FAILED',
]);
export function serverFailureTrace(service,status,code,{log=value=>console.error(value)}={}){
  if(!Number.isInteger(status)||status<500||status>599)return undefined;
  const requestId=crypto.randomUUID();
  const record={event:'backend_request_failed',request_id:requestId,
    service:service==='api'?'api':'business-router',status,
    code:codes.has(code)?code:'SERVER_ERROR'};
  // An unavailable logging sink must not replace the original error response.
  try{log(JSON.stringify(record));}catch{}
  return requestId;
}
