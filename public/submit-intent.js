// One saved intent per signed-in actor and channel. Keep the exact first payload
// so a retry after an uncertain network response has identical server semantics.
const storageKey=(channel,actorId)=>`bsr-submit-v1-${channel}-${actorId}`;

export function readSubmission(channel,actorId){
  if(!actorId)return null;
  try {
    const entry=JSON.parse(sessionStorage.getItem(storageKey(channel,actorId))||'null');
    return entry&&typeof entry.key==='string'&&entry.payload&&typeof entry.signature==='string'?entry:null;
  } catch { return null; }
}

export function pendingSubmission(channel,actorId,payload,signature=JSON.stringify(payload)){
  const existing=readSubmission(channel,actorId);
  if(existing?.signature===signature)return existing;
  const entry={signature,key:crypto.randomUUID(),payload};
  sessionStorage.setItem(storageKey(channel,actorId),JSON.stringify(entry));
  return entry;
}

export function clearSubmission(channel,actorId){
  if(actorId)sessionStorage.removeItem(storageKey(channel,actorId));
}
