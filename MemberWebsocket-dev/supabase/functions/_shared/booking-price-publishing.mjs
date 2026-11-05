const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const QUOTED_WRITES=new Set([
 'user.booking.create','user.booking.update','user.booking.group.create','user.booking.group.update',
 'admin.booking.phone.create','admin.booking.items.update','admin.booking.participants.items.update','admin.booking.receipt.register',
 'admin.booking.service.save','admin.booking.services.batch',
]);
export function pricePublishTime(mode,value){
 if(mode==='immediate')return null;
 const m=typeof value==='string'&&/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):00(Z|\+08:00)$/.exec(value);
 if(mode!=='scheduled'||!m)throw Error('INVALID_PRICE_PUBLISH_TIME');
 const local=new Date(Date.UTC(Number(m[1]),Number(m[2])-1,Number(m[3]),Number(m[4]),Number(m[5])));
 if(!Number.isFinite(local.getTime())||local.toISOString().slice(0,16)!==value.slice(0,16))throw Error('INVALID_PRICE_PUBLISH_TIME');
 return value;
}

// Each Edge invocation creates its own client/options. Quotes never live in
// module-level state or the shared tenant runtime.
export function bookingPriceOptions(body={}){
 // This module is deployed only in isolated -preview booking functions.
 // The trusted Edge endpoint, never a caller boolean, selects price context.
 const raw=body.expectedPrices??[];
 if(!Array.isArray(raw)||raw.length>100)throw Error('INVALID_BOOKING_PRICE_QUOTE');
 const seen=new Set();
 const quote=raw.map(row=>{
  if(!row||!UUID.test(String(row.serviceId))||!UUID.test(String(row.priceVersion))
   ||!Number.isSafeInteger(row.priceAmount)||row.priceAmount<0||row.priceAmount>10000000||seen.has(row.serviceId))
   throw Error('INVALID_BOOKING_PRICE_QUOTE');
  seen.add(row.serviceId);
  return {serviceId:row.serviceId,priceAmount:row.priceAmount,priceVersion:row.priceVersion};
 });
 const encoded=JSON.stringify(quote);
 if(encoded.length>16000)throw Error('INVALID_BOOKING_PRICE_QUOTE');
 return {global:{headers:{'x-booking-price-preview':'1','x-booking-price-check':QUOTED_WRITES.has(body.action)?'1':'0','x-booking-price-quote':encoded}}};
}

/** @template {object} T @param {T} client @param {object} [body] @returns {T} */
export function withBookingPrices(client,body={}){
 // All calls through the preview Edge use the preview ledger.
 return new Proxy(client,{get(target,key){
  if(key==='from')return table=>{
   const query=target.from(table);
   if(table!=='booking_services')return query;
   return new Proxy(query,{get(builder,method){
    if(method==='select')return (...args)=>target.from('booking_services_priced').select(...args);
    const value=Reflect.get(builder,method,builder);
    return typeof value==='function'?value.bind(builder):value;
   }});
  };
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
}

/** @type {Array<[string, number, string]>} */
const ERRORS=[
 ['BOOKING_PRICE_USE_PUBLISHING',409,'請使用「調整價格」選擇立即發佈或設定發佈時間。'],
 ['BOOKING_PRICE_CHANGED',409,'預約項目價格已變更，請重新確認最新價格後再送出。'],
 ['BOOKING_PRICE_TIME_CONFLICT',409,'此項目在相同時間已有待發佈價格，請改期或先取消原排程。'],
 ['BOOKING_PRICE_ALREADY_EFFECTIVE',409,'這筆價格已生效，請以新的價格發佈紀錄調整。'],
 ['BOOKING_PRICE_REQUEST_CONFLICT',409,'操作識別已用於其他價格設定，請重新開啟後再試。'],
 ['BOOKING_PRICE_CONFLICT',409,'價格排程已被其他操作更新，請重新載入。'],
 ['BOOKING_PRICE_NOT_FOUND',404,'找不到這筆價格發佈紀錄。'],
 ['INVALID_PRICE_PUBLISH_TIME',400,'請選擇有效的未來台北時間，精確至分鐘。'],
 ['INVALID_BOOKING_PRICE_QUOTE',400,'價格確認資料不完整，請重新載入預約項目。'],
 ['INVALID_PRICE_REQUEST',400,'價格操作識別不正確，請重新開啟後再試。'],
];
export function bookingPriceError(error){
 const message=String(error?.message||'')+' '+String(error?.details||'');
 const row=ERRORS.find(([code])=>message.includes(code));
 return row?{status:row[1],code:row[0],message:row[2]}:null;
}
