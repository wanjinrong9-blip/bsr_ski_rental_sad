import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {join,resolve} from 'node:path';
import {openDb} from '../src/db.mjs';
import {candidateProvisionAccount} from '../src/identity.mjs';
import {validateRuntimeConfig} from '../src/runtime-config.mjs';
import {initializeShowcase} from '../src/runtime-provenance.mjs';
import {candidateRequest} from './candidate-fixtures.mjs';
import {makeShowcaseFixture} from './018-showcase-fixtures.mjs';
import {consent,testPhoto} from './damage-helpers.mjs';
import {futureDate} from './future-date.mjs';

const root=resolve(import.meta.dirname,'..');
const firstAdmin={operator:'018-operations-test',name:'虚构权限管理员',
  email:'ops-admin@example.test',password:'Private#OpsAdmin2026'};
const identities=[
  {role:'customer',name:'虚构顾客甲',email:'ops-customer@example.test',temporaryPassword:'Private#OpsCustomer2026'},
  {role:'staff',name:'虚构租赁专员',email:'ops-staff@example.test',storeId:1,temporaryPassword:'Private#OpsStaff2026'},
  {role:'manager',name:'虚构门店经理',email:'ops-manager@example.test',storeId:1,temporaryPassword:'Private#OpsManager2026'},
  {role:'contractor',name:'虚构检修技师',email:'ops-tech@example.test',storeId:1,temporaryPassword:'Private#OpsTech2026'},
  {role:'owner',name:'虚构经营负责人',email:'ops-owner@example.test',temporaryPassword:'Private#OpsOwner2026'}
];
const pause=ms=>new Promise(done=>setTimeout(done,ms));
const cookie=response=>{
  const header=response.headers['set-cookie'];
  return (Array.isArray(header)?header[0]:header||'').split(';')[0];
};

async function withShowcase(run){
  const fixture=await makeShowcaseFixture();
  let child;
  try{
    const config=validateRuntimeConfig(fixture.env,{root,publicDir:join(root,'public')});
    initializeShowcase(config,firstAdmin);
    const db=openDb(fixture.dbPath,{runMode:'showcase'}),ids={};
    try{
      const admin=db.prepare("SELECT * FROM users WHERE role='admin'").get();
      ids.admin=admin.id;
      for(const [index,identity] of identities.entries()){
        const created=candidateProvisionAccount(db,admin,
          {...identity,verificationRef:`FICTIONAL-OPS-${index+1}`},{runMode:'showcase'});
        ids[identity.role]=created.id;
        // Identity rotation is covered separately; these are ready synthetic
        // roles for the operations-only scenario.
        db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(created.id);
      }
      db.prepare(`UPDATE users SET phone=?,address=?,birth_year=?,height_cm=?,weight_kg=?,shoe_size=?
        WHERE id=?`).run('000-000-000','虚构顾客地址，仅供自动化测试',1998,172,68,'EU 42',ids.customer);
    }finally{db.close();}
    child=spawn(process.execPath,[join(root,'src','server.mjs')],{
      cwd:root,env:{...process.env,...fixture.env,NODE_ENV:'local'},
      stdio:['ignore','pipe','pipe'],windowsHide:true
    });
    let stderr='';child.stdout.resume();child.stderr.setEncoding('utf8');
    child.stderr.on('data',part=>{stderr+=part;});
    let ready=false;
    for(let attempt=0;attempt<120;attempt++){
      if(child.exitCode!==null)break;
      try{if((await candidateRequest(fixture,'/api/health')).status===200){ready=true;break;}}catch{}
      await pause(40);
    }
    assert.equal(ready,true,stderr);
    const sessions={};
    for(const identity of [
      {...firstAdmin,role:'admin',temporaryPassword:firstAdmin.password},...identities
    ]){
      const login=await candidateRequest(fixture,'/api/auth/login',{
        method:'POST',headers:{Origin:fixture.origin},
        body:{email:identity.email,password:identity.temporaryPassword}
      });
      assert.equal(login.status,200,`${identity.role}: ${JSON.stringify(login.data)}`);
      sessions[identity.role]=cookie(login);
    }
    const request=(path,method='GET',body,role='customer')=>candidateRequest(fixture,path,{
      method,body,headers:{...(method==='GET'?{}:{Origin:fixture.origin}),
        Cookie:sessions[role],...(path==='/api/reservations'&&method==='POST'?
          {'Idempotency-Key':randomUUID()}:{})}
    });
    return await run({fixture,ids,sessions,request});
  }finally{
    if(child&&child.exitCode===null){const closed=new Promise(done=>child.once('close',done));child.kill();await closed;}
    fixture.cleanup();
  }
}

async function createPaidPrepared({request,ids},days=24){
  const created=await request('/api/reservations','POST',{
    storeId:1,pickupAt:futureDate(days),returnAt:futureDate(days+1),customerSkill:'中级',
    items:[{variantId:1,qty:1}],damageConsent:consent
  });
  assert.equal(created.status,201,`SHOWCASE 预约应进入模拟流程：${JSON.stringify(created.data)}`);
  const id=created.data.id;
  let detail=await request(`/api/reservations/${id}`);
  assert.equal(detail.status,200);
  let contract=detail.data.contracts?.[0];
  if(!contract){
    const issued=await request(`/api/reservations/${id}/contracts`,'POST',{});
    assert.equal(issued.status,201,JSON.stringify(issued.data));
    contract=issued.data;
  }
  const signed=await request(`/api/contracts/${contract.id}/sign`,'POST',{
    accepted:true,snapshotHash:contract.snapshot_hash,name:'虚构顾客甲'
  });
  assert.equal(signed.status,200,JSON.stringify(signed.data));
  const paid=await request(`/api/reservations/${id}/pay`,'POST',{});
  assert.equal(paid.status,200,JSON.stringify(paid.data));
  let prep=await request(`/api/preparations/${id}`,'GET',undefined,'staff');
  assert.equal(prep.status,200);
  prep=await request(`/api/preparations/${id}`,'PATCH',{
    version:prep.data.version,action:'claim',assignedTo:ids.staff
  },'manager');
  assert.equal(prep.status,200,JSON.stringify(prep.data));
  prep=await request(`/api/preparations/${id}`,'PATCH',{
    version:prep.data.version,action:'pick'
  },'staff');
  assert.equal(prep.status,200,JSON.stringify(prep.data));
  prep=await request(`/api/preparations/${id}`,'PATCH',{
    version:prep.data.version,action:'check',
    units:prep.data.units.map(unit=>({unitId:unit.unit_id,size:true,clean:true,safety:true}))
  },'staff');
  assert.equal(prep.status,200,JSON.stringify(prep.data));
  prep=await request(`/api/preparations/${id}`,'PATCH',{
    version:prep.data.version,action:'ready'
  },'staff');
  assert.equal(prep.status,200,JSON.stringify(prep.data));
  detail=await request(`/api/preparations/${id}`);
  assert.equal(detail.data.status,'READY','顾客应看到店员已备妥的同一份记录');
  assert.equal(detail.data.handler_name,'虚构租赁专员');
  const picked=await request('/api/operations/pickup','POST',{code:paid.data.pickupCode},'staff');
  assert.equal(picked.status,200,JSON.stringify(picked.data));
  assert.equal(picked.data.units.length,1);
  return {id,unitId:picked.data.units[0].unitId,paid:paid.data};
}

test('SHOWCASE 无损归还贯通备货、核码、具名进度、模拟退款和经营汇总',async()=>{
  await withShowcase(async context=>{
    const {request}=context;
    const rental=await createPaidPrepared(context);
    const before=await request(`/api/reservations/${rental.id}`);
    assert.equal(before.data.status,'ACTIVE');
    assert.ok(before.data.workflow.steps.every(step=>step.handler?.name));
    const returned=await request('/api/operations/return','POST',{
      reservationId:rental.id,returnStoreId:1,
      items:[{unitId:rental.unitId,condition:'GOOD',note:'虚构无损验收'}]
    },'staff');
    assert.equal(returned.status,200,JSON.stringify(returned.data));
    assert.equal(returned.data.status,'COMPLETED');
    const final=await request(`/api/reservations/${rental.id}`);
    assert.equal(final.data.status,'COMPLETED');
    assert.equal(final.data.payments.filter(item=>item.type==='REFUND').length,1);
    assert.equal(final.data.refund_nok,final.data.deposit_nok);
    const ownerReport=await request('/api/reports','GET',undefined,'owner');
    assert.equal(ownerReport.status,200);
    assert.ok(ownerReport.data.overview.orders>=1);
  });
});

test('SHOWCASE 受损单在 24H 内提交虚构照片与鉴定，经理核价后超押金转人工补差',async()=>{
  await withShowcase(async context=>{
    const {request,fixture}=context;
    const rental=await createPaidPrepared(context,28);
    const returned=await request('/api/operations/return','POST',{
      reservationId:rental.id,returnStoreId:1,
      items:[{unitId:rental.unitId,condition:'DAMAGED',note:'虚构板面边缘损伤，待照片鉴定'}]
    },'staff');
    assert.equal(returned.status,200,JSON.stringify(returned.data));
    assert.equal(returned.data.status,'REVIEW');
    const order=await request(`/api/reservations/${rental.id}`);
    const damage=order.data.damage.cases[0];
    assert.ok(damage?.sla?.dueAt);
    assert.equal(Date.parse(damage.sla.dueAt)-Date.parse(damage.created_at),24*3600000);
    const upload=await request(`/api/damage-cases/${damage.id}/photos`,'POST',{
      version:damage.version,part:'板面边缘',caption:'自动化虚构损伤图片',
      mime:'image/png',base64:testPhoto
    },'contractor');
    assert.equal(upload.status,201,JSON.stringify(upload.data));
    const photoId=upload.data.photos[0].id;
    const unauthorized=await candidateRequest(fixture,`/api/damage-photos/${photoId}`);
    assert.equal(unauthorized.status,401,'未登录访客不能取得私有鉴定照片');
    assert.equal((await request(`/api/damage-photos/${photoId}`,'GET',undefined,'owner')).status,403);
    const assessed=await request(`/api/damage-cases/${damage.id}`,'PATCH',{
      version:upload.data.version,action:'submit',grade:'MODERATE',part:'板面边缘',
      diagnosis:'虚构可修复损伤',laborNok:700,partsNok:0,replacementNok:1500,
      valueBasis:'仅自动化测试折旧估值'
    },'contractor');
    assert.equal(assessed.status,200,JSON.stringify(assessed.data));
    assert.ok(assessed.data.sla.firstFeedbackAt);
    const staffOrder=await request(`/api/reservations/${rental.id}`,'GET',undefined,'staff');
    const review=await request(`/api/reservations/${rental.id}/staff-review`,'POST',{
      reviewVersion:staffOrder.data.staffReviewVersion,
      checks:{identity:true,items:true,evidence:true},note:'逐件核对虚构合同、归还与照片'
    },'staff');
    assert.equal(review.status,200,JSON.stringify(review.data));
    const approved=await request(`/api/damage-cases/${damage.id}/review`,'POST',{
      version:assessed.data.version,decision:'approve',note:'虚构照片与修复成本核对通过'
    },'manager');
    assert.equal(approved.status,200,JSON.stringify(approved.data));
    const settlement=await request(`/api/operations/refunds/${rental.id}/approve`,'POST',{},'manager');
    assert.equal(settlement.status,200,JSON.stringify(settlement.data));
    assert.equal(settlement.data.status,'SETTLEMENT');
    assert.ok(settlement.data.supplementNok>0);
    assert.equal(settlement.data.deductedNok,order.data.deposit_nok);
    const customerView=await request(`/api/reservations/${rental.id}`);
    assert.equal(customerView.data.status,'SETTLEMENT');
    const alert=await request('/api/order-alerts?view=urgent','GET',undefined,'manager');
    assert.equal(alert.status,200);
    assert.ok(alert.data.items.some(item=>item.id===rental.id));
    const contacted=await request(`/api/reservations/${rental.id}/damage/contact`,'POST',{
      channel:'PHONE',outcome:'REACHED',note:'已向虚构顾客说明超押金补差'
    },'staff');
    assert.equal(contacted.status,200,JSON.stringify(contacted.data));
  });
});
