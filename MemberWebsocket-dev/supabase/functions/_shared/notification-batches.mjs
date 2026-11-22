/** Bounded delivery waves prevent one slow LINE request from serializing all recipients. */
export async function processNotificationBatches(rows,limit,process) {
  if(!Number.isSafeInteger(limit) || limit<1 || typeof process!=='function')
    throw new Error('INVALID_BATCH_LIMIT');
  for(let offset=0;offset<rows.length;offset+=limit) {
    await Promise.all(rows.slice(offset,offset+limit).map(process));
  }
}
