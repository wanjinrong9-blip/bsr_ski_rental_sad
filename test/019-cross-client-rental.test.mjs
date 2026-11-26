import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hashPassword,openDb} from '../src/db.mjs';
import {createMiniApi} from '../src/mini-api.mjs';
import {readySyntheticSource} from './018-showcase-ready-fixture.mjs';
import {futureDate} from './future-date.mjs';
import {consent} from './damage-helpers.mjs';

const priorNodeEnv=process.env.NODE_ENV;
process.env.NODE_ENV='test';
test.after(()=>{if(priorNodeEnv===undefined)delete process.env.NODE_ENV;
  else process.env.NODE_ENV=priorNodeEnv;});

const appId='wx1234567890abcdef';
const env={BSR_WECHAT_MINI_ENABLED:'1',BSR_WECHAT_APP_ID:appId,
  BSR_WECHAT_OPENID_KEY:'019-private-cross-client-fixture-openid-key',
  BSR_WECHAT_APP_SECRET:'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6'};
const password='Private#CrossClient2026';
const pickupAt=futureDate(9),returnAt=futureDate(10);
const window={storeId:1,pickupAt,returnAt};
const item={variantId:1,qty:1};

function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'bsr-mini-rental-019-'));
  const path=join(dir,'showcase.sqlite');
  readySyntheticSource(path);
  const db=openDb(path,{runMode:'showcase'});
  const add=(name,email)=>Number(db.prepare(`INSERT INTO users
    (name,email,password_hash,role,store_id,phone,address,birth_year,height_cm,
     weight_kg,shoe_size,created_at,account_state,provisioning_method,verified_at,
     must_change_password,auth_epoch)
    VALUES(?,?,?,'customer',NULL,'+47 9000 2026','虚构挪威地址',1999,172,68,'42',
      ?,'ACTIVE','OFFLINE_ADMIN',?,0,1)`)
    .run(name,email,hashPassword(password),new Date().toISOString(),
      new Date().toISOString()).lastInsertRowid);
  const a=add('虚构顾客甲','cross-a@example.test');
  const b=add('虚构顾客乙','cross-b@example.test');
  // A real last-unit competition, without modifying any live/demo inventory.
  db.prepare("UPDATE units SET status='RETIRED' WHERE variant_id=1 AND id<>(SELECT MIN(id) FROM units WHERE variant_id=1)").run();
  const codes={a:'crossClientCodeA0123456789',b:'crossClientCodeB0123456789'};
  const openids={a:'oA00000000000000000000000000',b:'oB00000000000000000000000000'};
  const adapter={exchangeCode:async code=>({openid:openids[Object.keys(codes).find(k=>codes[k]===code)]})};
  const api=createMiniApi({db,runMode:'showcase',env,adapter});
  return {db,a,b,api,codes,close(){db.close();rmSync(dir,{recursive:true,force:true,
    maxRetries:5,retryDelay:100});}};
}

async function request(api,path,{method='GET',payload,token,key}={}){
  const req={method,headers:{...(token?{authorization:`Bearer ${token}`}:{ }),
    ...(key?{'idempotency-key':key}:{})},socket:{remoteAddress:'127.0.0.1'},
    bsrClientIp:'127.0.0.1',payload};
  const response={};
  response.handled=await api.handle(req,response,new URL(path,'https://example.test'),{
    body:async r=>r.payload,
    json:(res,status,data)=>{res.status=status;res.data=data;}
  });
  return response;
}

async function authenticate(f,who){
  const login=await request(f.api,'/api/mini/auth/wechat',
    {method:'POST',payload:{code:f.codes[who]}});
  assert.equal(login.status,200);
  assert.equal(login.data.status,'needs_binding');
  const bound=await request(f.api,'/api/mini/auth/bind',
    {method:'POST',payload:{challenge:login.data.challenge,
      email:`cross-${who}@example.test`,password,explicitConsent:true}});
  assert.equal(bound.status,200);
  return bound.data.sessionToken;
}

const catalogPath=()=>`/api/mini/catalog?storeId=1&pickupAt=${encodeURIComponent(pickupAt)}&returnAt=${encodeURIComponent(returnAt)}`;
const quote=(f,token,cartVersion)=>request(f.api,'/api/mini/quote',
  {method:'POST',token,payload:{cartVersion}});
const submit=(f,token,cartVersion,quoteId,key)=>request(f.api,'/api/mini/reservations',
  {method:'POST',token,key,payload:{cartVersion,quoteId,
    customerSkill:'初级',damageConsent:consent}});

test('two Mini customers share one physical unit; quote is fresh, order is isolated, cancel releases stock',async()=>{
  const f=fixture();
  try{
    const ta=await authenticate(f,'a'),tb=await authenticate(f,'b');
    const catalog=await request(f.api,catalogPath(),{token:ta});
    assert.equal(catalog.status,200);
    const variant=catalog.data.items.find(row=>row.variantId===item.variantId);
    assert.ok(variant);
    assert.equal(variant.category,'护具');
    assert.equal(variant.visual,'knee-pad');
    assert.equal(catalog.data.pickupAt,pickupAt);
    assert.equal(catalog.data.returnAt,returnAt);
    assert.equal(variant.availableCount,1);
    assert.equal(variant.depositNok,48,'8% of NOK 600 reference value');
    assert.equal(variant.depositRate,0.08);
    assert.equal(variant.dailyNok,80);
    const cartA=await request(f.api,'/api/mini/cart',
      {method:'PUT',token:ta,payload:{expectedVersion:0,...window,items:[item]}});
    const cartB=await request(f.api,'/api/mini/cart',
      {method:'PUT',token:tb,payload:{expectedVersion:0,...window,items:[item]}});
    assert.equal(cartA.data.version,1);
    assert.equal(cartB.data.version,1);
    const qa=await quote(f,ta,1),qb=await quote(f,tb,1);
    assert.equal(qa.status,200);
    assert.equal(qb.status,200);
    assert.equal(qa.data.currency,'NOK');
    assert.equal(qa.data.rentNok,80);
    assert.equal(qa.data.depositNok,48);
    assert.equal(qa.data.totalNok,128);
    assert.equal(qa.data.simulation,true);
    assert.ok(typeof qa.data.quoteId==='string'&&qa.data.quoteId.length>=16);
    const first=await submit(f,ta,1,qa.data.quoteId,'019-last-unit-a-2026');
    assert.equal(first.status,201);
    assert.equal(first.data.status,'HOLD');
    const snapshot=f.db.prepare('SELECT pickup_at,return_at,quote_json FROM reservations WHERE id=?').get(first.data.id);
    assert.equal(snapshot.pickup_at,pickupAt);
    assert.equal(snapshot.return_at,returnAt);
    assert.equal(JSON.parse(snapshot.quote_json).currency,'NOK');
    const accepted=f.db.prepare('SELECT user_id,policy_version,policy_json,accepted_at FROM damage_consents WHERE reservation_id=?').get(first.data.id);
    assert.equal(accepted.user_id,f.a);
    assert.equal(accepted.policy_version,consent.version);
    assert.ok(Date.parse(accepted.accepted_at)>0);
    assert.ok(JSON.parse(accepted.policy_json));
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n,1);
    const same=await submit(f,ta,1,qa.data.quoteId,'019-last-unit-a-2026');
    assert.equal(same.status,200);
    assert.equal(same.data.id,first.data.id);
    await assert.rejects(submit(f,tb,1,qb.data.quoteId,'019-last-unit-b-2026'),
      error=>error?.status===409);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n,1);
    const own=await request(f.api,`/api/mini/reservations/${first.data.id}`,{token:ta});
    assert.equal(own.status,200);
    assert.equal(own.data.id,first.data.id);
    assert.equal(own.data.user_id,f.a);
    assert.ok(own.data.pickup_code);
    assert.equal(own.data.deposit_nok,48);
    assert.ok(own.data.workflow?.current);
    const mine=await request(f.api,'/api/mini/reservations',{token:ta});
    assert.deepEqual(mine.data.map(row=>row.id),[first.data.id]);
    const notMine=await request(f.api,'/api/mini/reservations',{token:tb});
    assert.deepEqual(notMine.data,[]);
    await assert.rejects(request(f.api,`/api/mini/reservations/${first.data.id}`,
      {token:tb}),error=>[403,404].includes(error?.status));
    const cancelled=await request(f.api,`/api/mini/reservations/${first.data.id}/cancel`,
      {method:'POST',token:ta,key:'019-cancel-last-unit-a'});
    assert.equal(cancelled.status,200);
    assert.equal(f.db.prepare('SELECT status FROM reservations WHERE id=?').get(first.data.id).status,'CANCELLED');
    const after=await request(f.api,catalogPath(),{token:tb});
    assert.equal(after.data.items.find(row=>row.variantId===item.variantId).availableCount,1);
    const refreshed=await quote(f,tb,1);
    assert.equal(refreshed.status,200);
    const second=await submit(f,tb,1,refreshed.data.quoteId,'019-last-unit-b-2026-new');
    assert.equal(second.status,201);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n,2);
    assert.equal(f.db.prepare('SELECT user_id FROM reservations WHERE id=?').get(second.data.id).user_id,f.b);
  }finally{f.close();}
});

test('Mini booking rejects stale cart version and a quote issued before cart change',async()=>{
  const f=fixture();
  try{
    const token=await authenticate(f,'a');
    const first=await request(f.api,'/api/mini/cart',
      {method:'PUT',token,payload:{expectedVersion:0,...window,items:[item]}});
    assert.equal(first.status,200);
    const quoteBefore=await quote(f,token,1);
    assert.equal(quoteBefore.status,200);
    const revised=await request(f.api,'/api/mini/cart',
      {method:'PUT',token,payload:{expectedVersion:1,...window,
        returnAt:futureDate(11),items:[item]}});
    assert.equal(revised.data.version,2);
    await assert.rejects(request(f.api,'/api/mini/cart',
      {method:'PUT',token,payload:{expectedVersion:1,...window,items:[]}}),
      error=>error?.code==='CART_STALE'&&error?.status===409);
    await assert.rejects(submit(f,token,1,quoteBefore.data.quoteId,'019-old-cart-quote-a'),
      error=>error?.status===409);
    await assert.rejects(submit(f,token,2,quoteBefore.data.quoteId,'019-new-cart-old-quote-a'),
      error=>error?.status===409);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n,0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM reservation_requests').get().n,0);
  }finally{f.close();}
});
