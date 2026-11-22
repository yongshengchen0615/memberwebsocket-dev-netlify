/** Bounded delivery waves prevent a slow LINE request from serializing all recipients.
 * Preserve FIFO for one LINE user, even when different recipients are processed concurrently.
 */
export async function processNotificationBatches(rows,limit,process,recipientOf) {
  if(!Number.isSafeInteger(limit) || limit<1 || typeof process!=='function')
    throw new Error('INVALID_BATCH_LIMIT');
  for(let offset=0;offset<rows.length;offset+=limit) {
    const previousByRecipient=new Map();
    const tasks=rows.slice(offset,offset+limit).map(row=>{
      const recipient=typeof recipientOf==='function' ? String(recipientOf(row)||'') : '';
      const previous=recipient ? previousByRecipient.get(recipient) : null;
      const current=previous ? previous.then(()=>process(row)) : Promise.resolve(process(row));
      if(recipient)previousByRecipient.set(recipient,current);
      return current;
    });
    await Promise.all(tasks);
  }
}
