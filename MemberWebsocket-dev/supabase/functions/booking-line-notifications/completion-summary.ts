type Settlement = {service_minutes?:unknown;reward_details?:unknown};
function pointsText(value:unknown):string {
  return (Array.isArray(value)?value:[]).map(item=>{
    const title=String(item?.pointCardTitle||'指定集點卡').trim();const points=Math.max(0,Number(item?.points||0));
    return points>0?`${title} +${points} 點`:'';
  }).filter(Boolean).join('、')||'本次無符合自動集點規則';
}
export function completionSummary(normal:Settlement,delegate:Settlement|null):string {
  if(delegate)return [
    `好友正常服務已結算：${Math.max(0,Number(normal.service_minutes||0))} 分鐘`,
    `您的代約獎勵時間：${Math.max(0,Number(delegate.service_minutes||0))} 分鐘`,
    `您的代約獎勵集點：${pointsText(delegate.reward_details)}`,
  ].join('\n');
  return [`完成服務時間：${Math.max(0,Number(normal.service_minutes||0))} 分鐘`,`獲得集點：${pointsText(normal.reward_details)}`].join('\n');
}
