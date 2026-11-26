import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hashPassword,openDb} from '../src/db.mjs';
import {createMiniApi} from '../src/mini-api.mjs';
import {preparation,updatePreparation} from '../src/fulfillment.mjs';
import {approveRefund,pickup,returnRental} from '../src/domain.mjs';
import {assessDamage,contactDamageCustomer,recordDamageSupplement,
  reviewDamage,uploadDamagePhoto} from '../src/damage.mjs';
import {staffReview,staffReviewVersion} from '../src/order-workflow.mjs';
import {readySyntheticSource} from './018-showcase-ready-fixture.mjs';
import {futureDate} from './future-date.mjs';
import {consent,testPhoto} from './damage-helpers.mjs';

const previousNodeEnv=process.env.NODE_ENV;
process.env.NODE_ENV='test';
test.after(()=>{if(previousNodeEnv===undefined)delete process.env.NODE_ENV;
  else process.env.NODE_ENV=previousNodeEnv;});

const env={BSR_WECHAT_MINI_ENABLED:'1',BSR_WECHAT_APP_ID:'wx1234567890abcdef',
  BSR_WECHAT_OPENID_KEY:'019-private-order-sync-test-openid-key',
  BSR_WECHAT_APP_SECRET:'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6'};
const password='Private#OrderSync2026';
const codes={a:'orderSyncCodeA0123456789',b:'orderSyncCodeB0123456789'};
const openids={a:'oC00000000000000000000000000',b:'oD00000000000000000000000000'};

function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'bsr-mini-order-sync-019-'));
  const path=join(dir,'showcase.sqlite');
  readySyntheticSource(path);
  const db=openDb(path,{runMode:'showcase'});
  const now=new Date().toISOString();
  const add=(name,email,role,storeId=null)=>Number(db.prepare(`INSERT INTO users
    (name,email,password_hash,role,store_id,phone,address,birth_year,height_cm,
     weight_kg,shoe_size,created_at,account_state,provisioning_method,verified_at,
     must_change_password,auth_epoch)
    VALUES(?,?,?,?,?,'+47 9000 2026','虚构挪威地址',1999,172,68,'42',
      ?,'ACTIVE','OFFLINE_ADMIN',?,0,1)`)
    .run(name,email,hashPassword(password),role,storeId,now,now).lastInsertRowid);
  const customerId=add('虚构顾客甲','sync-a@example.test','customer');
  add('虚构顾客乙','sync-b@example.test','customer');
  const staffId=add('虚构租赁专员','sync-staff@example.test','staff',1);
  const staff=db.prepare('SELECT * FROM users WHERE id=?').get(staffId);
  const managerId=add('虚构门店经理','sync-manager@example.test','manager',1);
  const technicianId=add('虚构装备检修技师','sync-tech@example.test','contractor',1);
  const manager=db.prepare('SELECT * FROM users WHERE id=?').get(managerId);
  const technician=db.prepare('SELECT * FROM users WHERE id=?').get(technicianId);
  const adapter={exchangeCode:async code=>({openid:openids[Object.keys(codes)
    .find(who=>codes[who]===code)]})};
  const api=createMiniApi({db,runMode:'showcase',env,adapter});
  return {db,api,staff,manager,technician,customerId,close(){db.close();rmSync(dir,{recursive:true,
    force:true,maxRetries:5,retryDelay:100});}};
}

async function request(api,path,{method='GET',payload,token,key}={}){
  const req={method,headers:{...(token?{authorization:`Bearer ${token}`}:{ }),
    ...(key?{'idempotency-key':key}:{})},socket:{remoteAddress:'127.0.0.1'},
    bsrClientIp:'127.0.0.1',payload};
  const res={};
  res.writeHead=(status,headers)=>{res.status=status;res.headers=headers;};
  res.end=bytes=>{res.bytes=bytes;};
  res.handled=await api.handle(req,res,new URL(path,'https://example.test'),{
    body:async r=>r.payload,
    json:(response,status,data)=>{response.status=status;response.data=data;}
  });
  return res;
}

async function login(api,who){
  const started=await request(api,'/api/mini/auth/wechat',
    {method:'POST',payload:{code:codes[who]}});
  assert.equal(started.status,200);
  const bound=await request(api,'/api/mini/auth/bind',{method:'POST',
    payload:{challenge:started.data.challenge,email:`sync-${who}@example.test`,
      password,explicitConsent:true}});
  assert.equal(bound.status,200);
  return bound.data.sessionToken;
}

test('Mini customer and Web staff share one committed order through preparation, pickup and clean return',async()=>{
  const f=fixture();
  try{
    const token=await login(f.api,'a'),otherToken=await login(f.api,'b');
    const cart=await request(f.api,'/api/mini/cart',{method:'PUT',token,
      payload:{expectedVersion:0,storeId:1,pickupAt:futureDate(9),
        returnAt:futureDate(10),items:[{variantId:1,qty:1}]}});
    assert.equal(cart.status,200);
    const quoted=await request(f.api,'/api/mini/quote',
      {method:'POST',token,payload:{cartVersion:cart.data.version}});
    assert.equal(quoted.status,200);
    const created=await request(f.api,'/api/mini/reservations',{method:'POST',token,
      key:'019-order-sync-book-2026',payload:{cartVersion:cart.data.version,
        quoteId:quoted.data.quoteId,customerSkill:'初级',damageConsent:consent}});
    assert.equal(created.status,201);
    const id=created.data.id;
    assert.equal(f.db.prepare('SELECT assigned_staff_id FROM reservations WHERE id=?').get(id).assigned_staff_id,
      f.staff.id);
    const contract=await request(f.api,`/api/mini/reservations/${id}/contracts`,
      {method:'POST',token});
    assert.equal(contract.status,201);
    assert.equal(contract.data.snapshot.simulation,true);
    const signed=await request(f.api,`/api/mini/contracts/${contract.data.id}/sign`,
      {method:'POST',token,payload:{accepted:true,
        snapshotHash:contract.data.snapshot_hash,name:'虚构顾客甲'}});
    assert.equal(signed.status,200);
    assert.ok(signed.data.signed_at);
    const paid=await request(f.api,`/api/mini/reservations/${id}/pay`,
      {method:'POST',token});
    assert.equal(paid.status,200);
    assert.equal(paid.data.status,'CONFIRMED');
    assert.equal(paid.data.simulation,true);
    const initial=await request(f.api,`/api/mini/reservations/${id}`,{token});
    assert.equal(initial.data.workflow.currentKey,'PREPARATION');
    assert.equal(initial.data.preparation?.status,'QUEUED');

    // The Web employee service uses this same domain operation and SQLite row.
    let prep=preparation(f.db,f.staff,id);
    prep=updatePreparation(f.db,f.staff,id,{version:prep.version,action:'claim'});
    assert.equal(prep.assigned_to,f.staff.id);
    prep=updatePreparation(f.db,f.staff,id,{version:prep.version,action:'pick'});
    assert.equal(prep.status,'CHECKING');
    assert.equal(prep.units.length,1);
    prep=updatePreparation(f.db,f.staff,id,{version:prep.version,action:'check',
      units:prep.units.map(unit=>({unitId:unit.unit_id,size:true,clean:true,safety:true}))});
    prep=updatePreparation(f.db,f.staff,id,{version:prep.version,action:'ready'});
    assert.equal(prep.status,'READY');
    const ready=await request(f.api,`/api/mini/reservations/${id}`,{token});
    assert.equal(ready.status,200);
    assert.equal(ready.data.id,id);
    assert.equal(ready.data.status,'READY');
    assert.equal(ready.data.preparation.status,'READY');
    assert.equal(ready.data.preparation.assigned_to,f.staff.id);
    assert.ok(ready.data.preparation.ready_at);
    const step=ready.data.workflow.steps.find(s=>s.key==='PREPARATION');
    assert.equal(step.status,'DONE');
    assert.equal(step.actor.id,f.staff.id);
    assert.ok(step.at);
    assert.equal(ready.data.workflow.currentKey,'PICKUP');
    assert.equal(ready.data.workflow.handler.id,f.staff.id);
    await assert.rejects(request(f.api,`/api/mini/reservations/${id}`,
      {token:otherToken}),error=>error?.status===404);

    const pickupCode=ready.data.pickup_code;
    const handed=pickup(f.db,f.staff.id,pickupCode);
    assert.equal(handed.status,'ACTIVE');
    const active=await request(f.api,`/api/mini/reservations/${id}`,{token});
    assert.equal(active.data.status,'ACTIVE');
    assert.equal(active.data.workflow.steps.find(s=>s.key==='PICKUP').status,'DONE');
    assert.equal(active.data.workflow.steps.find(s=>s.key==='PICKUP').actor.id,f.staff.id);
    const returned=returnRental(f.db,f.staff.id,id,
      handed.units.map(unit=>({unitId:unit.unitId,condition:'GOOD',note:'外观正常'})),1);
    assert.equal(returned.status,'COMPLETED');
    assert.equal(returned.refundNok,48);
    const complete=await request(f.api,`/api/mini/reservations/${id}`,{token});
    assert.equal(complete.data.status,'COMPLETED');
    assert.equal(complete.data.refund_nok,48);
    assert.equal(complete.data.refund_status,'REFUNDED');
    assert.equal(complete.data.workflow.currentKey,'DONE');
    assert.equal(complete.data.simulation,true);
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM payments
      WHERE reservation_id=? AND type='REFUND' AND status='SUCCEEDED'`).get(id).n,1);
  }finally{f.close();}
});

test('Mini customer sees Web damage assessment, 24-hour feedback and contact-gated supplement on one order',async()=>{
  const f=fixture();
  try{
    const token=await login(f.api,'a'),otherToken=await login(f.api,'b');
    const cart=await request(f.api,'/api/mini/cart',{method:'PUT',token,
      payload:{expectedVersion:0,storeId:1,pickupAt:futureDate(15),
        returnAt:futureDate(16),items:[{variantId:1,qty:1}]}});
    assert.equal(cart.status,200);
    const quoted=await request(f.api,'/api/mini/quote',
      {method:'POST',token,payload:{cartVersion:cart.data.version}});
    assert.equal(quoted.status,200);
    const created=await request(f.api,'/api/mini/reservations',{method:'POST',token,
      key:'019-order-sync-damaged-2026',payload:{cartVersion:cart.data.version,
        quoteId:quoted.data.quoteId,customerSkill:'初级',damageConsent:consent}});
    assert.equal(created.status,201);
    const id=created.data.id;
    const contract=await request(f.api,`/api/mini/reservations/${id}/contracts`,
      {method:'POST',token});
    assert.equal(contract.status,201);
    assert.equal((await request(f.api,`/api/mini/contracts/${contract.data.id}/sign`,
      {method:'POST',token,payload:{accepted:true,
        snapshotHash:contract.data.snapshot_hash,name:'虚构顾客甲'}})).status,200);
    assert.equal((await request(f.api,`/api/mini/reservations/${id}/pay`,
      {method:'POST',token})).status,200);

    let prep=preparation(f.db,f.staff,id);
    prep=updatePreparation(f.db,f.staff,id,{version:prep.version,action:'claim'});
    prep=updatePreparation(f.db,f.staff,id,{version:prep.version,action:'pick'});
    prep=updatePreparation(f.db,f.staff,id,{version:prep.version,action:'check',
      units:prep.units.map(unit=>({unitId:unit.unit_id,size:true,clean:true,safety:true}))});
    prep=updatePreparation(f.db,f.staff,id,{version:prep.version,action:'ready'});
    const handed=pickup(f.db,f.staff.id,
      f.db.prepare('SELECT pickup_code FROM reservations WHERE id=?').get(id).pickup_code);
    assert.equal(handed.status,'ACTIVE');
    const returned=returnRental(f.db,f.staff.id,id,
      handed.units.map(unit=>({unitId:unit.unitId,condition:'DAMAGED',
        note:'测试：板面边缘疑似受损，待技师鉴定'})),1);
    assert.equal(returned.status,'REVIEW');
    const pending=await request(f.api,`/api/mini/reservations/${id}`,{token});
    assert.equal(pending.status,200);
    assert.equal(pending.data.refund_nok,0);
    assert.equal(pending.data.refund_status,'REVIEW');
    assert.equal(pending.data.damage.cases.length,1);
    assert.equal(pending.data.damage.cases[0].assessor_id,f.technician.id);
    const damageId=pending.data.damage.cases[0].id;
    assert.equal(Date.parse(pending.data.damage.cases[0].feedback_due_at)-
      Date.parse(pending.data.damage.cases[0].created_at),24*3600000);
    assert.equal(pending.data.workflow.currentKey,'ASSESSMENT');
    assert.equal(pending.data.workflow.handler.name,f.technician.name);
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM payments
      WHERE reservation_id=? AND type='REFUND'`).get(id).n,0);

    let damage=uploadDamagePhoto(f.db,f.technician,damageId,{version:1,
      part:'板面边缘',caption:'合成图片：板面边缘受损位置',mime:'image/png',base64:testPhoto});
    assert.equal(damage.photos.length,1);
    const photoId=damage.photos[0].id;
    const ownPhoto=await request(f.api,`/api/mini/damage-photos/${photoId}`,{token});
    assert.equal(ownPhoto.status,200);
    assert.equal(ownPhoto.headers['content-type'],'image/png');
    assert.equal(ownPhoto.headers['cache-control'],'private, no-store');
    assert.equal(ownPhoto.headers['x-content-type-options'],'nosniff');
    assert.deepEqual(ownPhoto.bytes,Buffer.from(testPhoto,'base64'));
    await assert.rejects(request(f.api,`/api/mini/damage-photos/${photoId}`,
      {token:otherToken}),error=>error?.status===404);
    await assert.rejects(request(f.api,`/api/mini/damage-photos/${photoId}`),
      error=>error?.status===401);
    damage=assessDamage(f.db,f.technician,damageId,{version:damage.version,
      action:'submit',grade:'MODERATE',part:'板面边缘',
      diagnosis:'测试：板面边缘可修复损伤，按工时费估算',laborNok:650,
      partsNok:0,replacementNok:1000,valueBasis:'测试：购入年限与折旧后的重置价值'});
    assert.equal(damage.fee_nok,650);
    assert.ok(Date.parse(damage.first_feedback_at)<=Date.parse(damage.feedback_due_at));
    const assessed=await request(f.api,`/api/mini/reservations/${id}`,{token});
    assert.equal(assessed.data.damage.cases[0].status,'SUBMITTED');
    assert.equal(assessed.data.damage.cases[0].photos.length,1);
    assert.equal(assessed.data.workflow.steps.find(step=>step.key==='ASSESSMENT').status,'DONE');
    assert.equal(assessed.data.workflow.currentKey,'STAFF_REVIEW');

    damage=reviewDamage(f.db,f.manager,damageId,{version:damage.version,
      decision:'approve',note:'照片与折旧估值依据已核对'});
    assert.equal(damage.status,'APPROVED');
    staffReview(f.db,f.staff,id,{reviewVersion:staffReviewVersion(f.db,id),
      checks:{identity:true,items:true,evidence:true},
      note:'已核对合同、实物与受损照片资料'});
    const approved=approveRefund(f.db,f.manager.id,id);
    assert.equal(approved.status,'SETTLEMENT');
    assert.equal(approved.damageFeeNok,650);
    assert.equal(approved.supplementNok,650-pending.data.deposit_nok);
    assert.equal(approved.refundNok,0);
    const awaiting=await request(f.api,`/api/mini/reservations/${id}`,{token});
    assert.equal(awaiting.data.damage.settlement.status,'AWAITING_CONTACT');
    assert.equal(awaiting.data.workflow.currentKey,'SETTLEMENT');
    assert.equal(awaiting.data.workflow.steps.find(step=>step.key==='MANAGER_REVIEW').actor.id,
      f.manager.id);
    assert.equal(awaiting.data.damage.settlement.supplement_nok,approved.supplementNok);
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM payments
      WHERE reservation_id=? AND type='REFUND'`).get(id).n,0);
    await assert.rejects(request(f.api,`/api/mini/reservations/${id}`,
      {token:otherToken}),error=>error?.status===404);

    assert.throws(()=>recordDamageSupplement(f.db,f.staff,id,{version:1,
      amountNok:approved.supplementNok,reference:'SYN-019-DAMAGE',confirmed:true}),
    error=>error?.status===409);
    contactDamageCustomer(f.db,f.staff,id,{channel:'PHONE',outcome:'REACHED',
      note:'已向虚构顾客说明照片、核价与补差金额'});
    const contacted=await request(f.api,`/api/mini/reservations/${id}`,{token});
    assert.equal(contacted.data.damage.contacts.at(-1).outcome,'REACHED');
    assert.equal(contacted.data.damage.settlement.status,'CONTACTED');
    const receipt=recordDamageSupplement(f.db,f.staff,id,{
      version:contacted.data.damage.settlement.version,
      amountNok:approved.supplementNok,reference:'SYN-019-DAMAGE',confirmed:true});
    assert.equal(receipt.ok,true);
    const complete=await request(f.api,`/api/mini/reservations/${id}`,{token});
    assert.equal(complete.data.status,'COMPLETED');
    assert.equal(complete.data.damage.settlement.status,'SETTLED');
    assert.equal(complete.data.damage.settlement.paid_nok,approved.supplementNok);
    assert.equal(complete.data.workflow.currentKey,'DONE');
    assert.equal(complete.data.simulation,true);
  }finally{f.close();}
});
