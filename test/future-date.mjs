// 11:00 UTC falls between 09:00 and 16:00 in Europe/Oslo in both winter and summer.
export const futureDate=days=>{
 const date=new Date(Date.now()+days*86400000);
 date.setUTCHours(11,0,0,0);
 return date.toISOString();
};
