const test=require('node:test');
const assert=require('node:assert/strict');
const configPath=require.resolve('../utils/config'),apiPath=require.resolve('../utils/api');
const origin='https://bsr-temporary-preview-production.up.railway.app';
require.cache[configPath]={id:configPath,filename:configPath,loaded:true,exports:{mode:'account-showcase',apiBase:origin}};
delete require.cache[apiPath];
const api=require('../utils/api'),storage=new Map(),calls=[];
let role='customer',expired=false;
global.wx={getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,v),removeStorageSync:k=>storage.delete(k),request(o){
  calls.push(o);const path=o.url.slice(origin.length);
  if(path==='/api/auth/login')return o.success({statusCode:200,cookies:['__Host-bsr_showcase_session='+'a'.repeat(64)+'; HttpOnly; Secure; Path=/'],data:{user:{id:7,name:'虚构顾客',role,phone:'test',birthYear:1998}}});
  if(path==='/api/auth/logout')return o.success({statusCode:200,cookies:['__Host-bsr_showcase_session=; Max-Age=0'],data:{ok:true}});
  if(expired)return o.success({statusCode:401,data:{error:'请重新登录'}});
  if(path==='/api/bootstrap')return o.success({statusCode:200,data:{runMode:'showcase',synthetic:true,demo:false,user:null}});
  o.success({statusCode:200,data:{items:[]}});
}};
test('HTTPS account experience captures its own managed cookie and sends Origin without demo/Bearer credentials',async()=>{
  assert.equal((await api.bootstrap()).synthetic,true);
  const user=await api.login('private@example.test','private-account-password');assert.equal(user.id,7);assert.equal(user.birthYear,1998);
  await api.request('/api/cart');const call=calls.at(-1);
  assert.equal(call.header.Origin,origin);assert.match(call.header.Cookie,/^__Host-bsr_showcase_session=/);
  assert.equal(call.header.Authorization,undefined);assert.equal(call.header['X-BSR-Session'],undefined);
  await api.logout();await api.request('/api/catalog?storeId=1');assert.equal(calls.at(-1).header.Cookie,undefined);
});
test('non-customer login revokes the issued cookie; expired sessions clear private state',async()=>{
  role='manager';await assert.rejects(api.login('other@example.test','private-password'),/顾客工作台/);
  assert.equal(calls.at(-1).url,origin+'/api/auth/logout');
  role='customer';await api.login('private@example.test','private-password');expired=true;
  await assert.rejects(api.request('/api/cart'),/重新登录/);
  assert.equal(storage.has('bsr-mini-account-cookie'),false);expired=false;
});
test('account experience cannot call employee routes or bypass HTTPS host validation',async()=>{
  assert.throws(()=>api.mapPath('/api/operations/refunds/1/approve'),/不提供/);
  assert.throws(()=>api.mapPath('/api/auth/register'),/不提供/);
  const config=require.cache[configPath].exports;
  for(const bad of ['http://example.com','https://127.0.0.1','https://user:secret@example.com','https://example.com/path']){
    config.apiBase=bad;assert.throws(()=>api.assertAccountShowcase());
  }
  config.apiBase=origin;assert.doesNotThrow(()=>api.assertAccountShowcase());
});
