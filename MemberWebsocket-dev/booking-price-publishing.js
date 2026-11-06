(() => {
  'use strict';
  const STORE_ID='00000000-0000-4000-8000-000000000010';
  function payload(config,body={},services=[]) {
    if(config?.pricePublishing!==true)return body;
    if(Array.isArray(body.expectedPrices))return {...body,pricePublishing:true};
    const ids=new Set();
    const add=id=>{if(id&&id!==STORE_ID)ids.add(String(id));};
    for(const item of body.items||[])add(item.serviceId);
    for(const person of body.participants||[])for(const item of person.items||[])add(item.serviceId);
    for(const op of body.operations||[])if(op.serviceId)add(op.serviceId);
    if(body.serviceId)add(body.serviceId);
    const byId=new Map(services.map(s=>[String(s.serviceId),s]));
    const quote=[...ids].map(id=>{
      const s=byId.get(id);
      if(!s?.priceVersion||!Number.isSafeInteger(s.priceAmount))throw Error('價格資料已變更，請重新載入預約項目後確認。');
      return {serviceId:id,priceAmount:s.priceAmount,priceVersion:s.priceVersion};
    });
    return {...body,pricePublishing:true,expectedPrices:quote};
  }
  window.BookingPricePublishing=Object.freeze({payload});
})();
