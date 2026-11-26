import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {futureDate} from './future-date.mjs';
import {consent} from './damage-helpers.mjs';

const privateDir=mkdtempSync(join(tmpdir(),'bsr-019-two-clients-'));
process.env.NODE_ENV='test';
process.env.BSR_DB_PATH=join(privateDir,'local.sqlite');
const {server,db}=await import('../src/server.mjs');
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;

async function request(path,method='GET',body,identity={},extra={}){
  const response=await fetch(base+path,{method,headers:{
    ...(identity.cookie?{cookie:identity.cookie}:{}),
    ...(identity.token?{'x-bsr-session':identity.token}:{}),
    ...(body!==undefined?{'content-type':'application/json'}:{}),...extra},
    body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:await response.json(),
    cookie:response.headers.get('set-cookie')?.split(';')[0]||''};
}
async function login(email){
  const response=await request('/api/auth/login','POST',{email,password:'Demo123!'});
  assert.equal(response.status,200);
  return {cookie:response.cookie,token:response.data.sessionToken};
}

test('网页和本机小程序适配器读写同一顾客购物车与订单',async()=>{
  const web=await login('customer@bsr.demo');
  const mini=await login('customer@bsr.demo');
  const pickupAt=futureDate(9),returnAt=futureDate(10);
  const window={storeId:1,pickupAt,returnAt};
  const first=await request('/api/cart','PUT',{expectedVersion:0,...window,items:[{variantId:1,qty:1}]},web);
  assert.equal(first.status,200);
  assert.equal(first.data.version,1);
  const seenOnMini=await request('/api/cart','GET',undefined,mini);
  assert.deepEqual(seenOnMini.data.items.map(({variantId,qty})=>({variantId,qty})),[{variantId:1,qty:1}]);

  const second=await request('/api/cart','PUT',{expectedVersion:1,...window,
    items:[{variantId:1,qty:1},{variantId:5,qty:1}]},mini);
  assert.equal(second.status,200);
  const seenOnWeb=await request('/api/cart','GET',undefined,web);
  assert.equal(seenOnWeb.data.version,2);
  assert.equal(seenOnWeb.data.items.length,2);
  const stale=await request('/api/cart','PUT',{expectedVersion:1,...window,items:[{variantId:1,qty:1}]},web);
  assert.equal(stale.status,409);
  assert.equal(stale.data.code,'CART_STALE');
  assert.equal(stale.data.currentVersion,2);

  const orderInput={...window,items:seenOnWeb.data.items.map(({variantId,qty})=>({variantId,qty})),
    customerSkill:'中级',damageConsent:consent};
  const created=await request('/api/reservations','POST',orderInput,mini,
    {'Idempotency-Key':'019-mini-web-shared-order-2026'});
  assert.equal(created.status,201);
  const fromWeb=await request(`/api/reservations/${created.data.id}`,'GET',undefined,web);
  const fromMini=await request(`/api/reservations/${created.data.id}`,'GET',undefined,mini);
  assert.equal(fromWeb.status,200);
  assert.equal(fromMini.status,200);
  assert.equal(fromWeb.data.lines.length,2);
  assert.equal(fromWeb.data.id,fromMini.data.id);
  assert.equal(fromWeb.data.total_nok,fromMini.data.total_nok);
  assert.equal(fromWeb.data.deposit_nok,fromMini.data.deposit_nok);
  assert.equal(fromWeb.data.workflow.current,fromMini.data.workflow.current);
});

test.after(async()=>{
  await new Promise(resolve=>server.close(resolve));db.close();
  rmSync(privateDir,{recursive:true,force:true});
});
