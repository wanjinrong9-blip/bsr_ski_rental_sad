import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {openDb} from '../src/db.mjs';
import {createReservation} from '../src/domain.mjs';
import {candidateChangePassword,candidateProvisionAccount} from '../src/identity.mjs';
import {validateRuntimeConfig} from '../src/runtime-config.mjs';
import {initializeShowcase} from '../src/runtime-provenance.mjs';
import {candidateRequest} from './candidate-fixtures.mjs';
import {makeShowcaseFixture} from './018-showcase-fixtures.mjs';
import {consent} from './damage-helpers.mjs';
import {futureDate} from './future-date.mjs';

const root=resolve(import.meta.dirname,'..');
const admin={operator:'018-simulation-test',name:'虚构权限管理员',
  email:'simulation-admin@example.test',password:'Private#SimulationAdmin2026'};
const identities=[
  {name:'虚构顾客甲',email:'simulation-customer@example.test',role:'customer',
    temporaryPassword:'Private#SimulationCustomer2026',readyPassword:'Private#RotatedCustomer2026'},
  {name:'虚构租赁专员',email:'simulation-staff@example.test',role:'staff',storeId:1,
    temporaryPassword:'Private#SimulationStaff2026',readyPassword:'Private#RotatedStaff2026'}
];
const pause=ms=>new Promise(done=>setTimeout(done,ms));
const firstCookie=response=>{
  const header=response.headers['set-cookie'];
  return (Array.isArray(header)?header[0]:header||'').split(';')[0];
};
const profile={phone:'000-000-000',address:'虚构顾客地址，仅供课程测试',birthYear:1998,
  heightCm:173,weightKg:69,shoeSize:'EU 42'};
const input=()=>({storeId:1,pickupAt:futureDate(24),returnAt:futureDate(25),
  customerSkill:'中级',items:[{variantId:1,qty:1}],customerProfile:profile,
  damageConsent:consent});

function assertSimulation(value,context){
  assert.equal(value?.simulation,true,`${context} 缺少 machine-readable simulation=true`);
  assert.match(String(value?.simulationNotice||''),/合成|模拟/,
    `${context} 缺少显眼的合成/模拟文字`);
  assert.match(String(value?.simulationNotice||''),/不代表真实|不产生真实|无真实/,
    `${context} 未明确排除真实收付款或签署`);
}

async function withShowcase(run,{seedReview=false}={}){
  const fixture=await makeShowcaseFixture();
  let child;
  try{
    const config=validateRuntimeConfig(fixture.env,{root,publicDir:join(root,'public')});
    initializeShowcase(config,admin);
    const db=openDb(fixture.dbPath,{runMode:'showcase'}),ids={};
    try{
      const operator=db.prepare("SELECT * FROM users WHERE role='admin'").get();
      for(const [index,identity] of identities.entries()){
        const created=candidateProvisionAccount(db,operator,
          {...identity,verificationRef:`FICTIONAL-SIMULATION-${index+1}`},
          {runMode:'showcase'});
        ids[identity.role]=created.id;
        const account=db.prepare('SELECT * FROM users WHERE id=?').get(created.id);
        candidateChangePassword(db,account,{currentPassword:identity.temporaryPassword,
          newPassword:identity.readyPassword},{runMode:'showcase'});
      }
      if(seedReview){
        ids.reviewOrder=createReservation(db,ids.customer,input(),null,randomUUID()).id;
        db.prepare("UPDATE reservations SET status='REVIEW' WHERE id=?").run(ids.reviewOrder);
      }
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
    for(const identity of identities){
      const response=await candidateRequest(fixture,'/api/auth/login',{
        method:'POST',headers:{Origin:fixture.origin},
        body:{email:identity.email,password:identity.readyPassword}
      });
      assert.equal(response.status,200,JSON.stringify(response.data));
      sessions[identity.role]=firstCookie(response);
    }
    const request=(path,{method='GET',body,role='customer',key}={})=>
      candidateRequest(fixture,path,{method,body,headers:{Cookie:sessions[role],
        ...(method!=='GET'?{Origin:fixture.origin}:{}),
        ...(key?{'Idempotency-Key':key}:{})}});
    return await run({fixture,ids,request});
  }finally{
    if(child&&child.exitCode===null){const closed=new Promise(done=>child.once('close',done));child.kill();await closed;}
    fixture.cleanup();
  }
}

test('SHOWCASE 报价、订单、合同快照、签署、模拟收退均携带可读及机器可读标记',async()=>{
  await withShowcase(async({request})=>{
    const bootstrap=await request('/api/bootstrap');
    assert.equal(bootstrap.data.synthetic,true);
    assert.match(bootstrap.data.notice,/合成|模拟/);
    const quote=await request('/api/quote',{method:'POST',body:input()});
    assert.equal(quote.status,200,JSON.stringify(quote.data));
    assertSimulation(quote.data,'报价');
    assert.equal(quote.data.currency,'NOK');
    const created=await request('/api/reservations',{
      method:'POST',body:input(),key:randomUUID()
    });
    assert.equal(created.status,201,JSON.stringify(created.data));
    assertSimulation(created.data,'预约创建');
    assertSimulation(created.data.quote,'冻结报价');
    const id=created.data.id;
    const issued=await request(`/api/reservations/${id}/contracts`,{method:'POST',body:{}});
    assert.equal(issued.status,201,JSON.stringify(issued.data));
    assertSimulation(issued.data,'合同');
    assert.equal(issued.data.snapshot.simulation,true,'冻结快照必须保留模拟语义');
    assert.match(issued.data.snapshot.terms,/不代表真实银行交易/);
    const html=await request(`/api/contracts/${issued.data.id}/print`);
    assert.equal(html.status,200);
    assert.match(html.text,/合成预览|模拟合同/);
    assert.match(html.text,/不代表真实银行交易/);
    const signed=await request(`/api/contracts/${issued.data.id}/sign`,{
      method:'POST',body:{accepted:true,snapshotHash:issued.data.snapshot_hash,
        name:'虚构顾客甲'}
    });
    assert.equal(signed.status,200,JSON.stringify(signed.data));
    assertSimulation(signed.data,'签署记录');
    assert.equal(signed.data.snapshot.simulation,true);
    const paid=await request(`/api/reservations/${id}/pay`,{method:'POST',body:{}});
    assert.equal(paid.status,200,JSON.stringify(paid.data));
    assertSimulation(paid.data,'支付记录');
    assert.ok(paid.data.providerRef,'模拟流水也应可核对');
    const detail=await request(`/api/reservations/${id}`);
    assert.equal(detail.status,200);
    assertSimulation(detail.data,'订单详情');
    assert.ok(detail.data.payments.length>=2);
    for(const payment of detail.data.payments)assert.equal(payment.simulation,true,
      '租金与押金流水须逐项标记模拟');
    const cancelled=await request(`/api/reservations/${id}/cancel`,{
      method:'POST',body:{}});
    assert.equal(cancelled.status,200,JSON.stringify(cancelled.data));
    assertSimulation(cancelled.data,'取消退款');
    const after=await request(`/api/reservations/${id}`);
    const refund=after.data.payments.find(item=>item.type==='CANCELLATION_REFUND');
    assert.ok(refund,'取消后应留下可核对的模拟退款流水');
    assert.equal(refund.simulation,true);
  });
});

test('SHOWCASE 店员现场开单与纸质见证后的收款响应仍明确为模拟',async()=>{
  await withShowcase(async({request,ids})=>{
    const created=await request('/api/operations/reservations',{
      method:'POST',role:'staff',key:randomUUID(),
      body:{...input(),customerId:ids.customer}
    });
    assert.equal(created.status,201,JSON.stringify(created.data));
    assertSimulation(created.data,'现场开单');
    const contract=await request(`/api/reservations/${created.data.id}/contracts`,{
      method:'POST',role:'staff',body:{}
    });
    assert.equal(contract.status,201,JSON.stringify(contract.data));
    const signed=await request(`/api/contracts/${contract.data.id}/sign`,{
      method:'POST',role:'staff',body:{accepted:true,
        snapshotHash:contract.data.snapshot_hash,name:'虚构顾客甲',
        paperSigned:true,note:'虚构纸质合同已当面见证归档'}
    });
    assert.equal(signed.status,200,JSON.stringify(signed.data));
    assertSimulation(signed.data,'纸质签署见证');
    const paid=await request(`/api/operations/reservations/${created.data.id}/pay`,{
      method:'POST',role:'staff',body:{confirmed:true,reference:'SYN-COUNTER-001'}
    });
    assert.equal(paid.status,200,JSON.stringify(paid.data));
    assertSimulation(paid.data,'现场模拟收款');
  });
});

test('SHOWCASE 受损联系结果明确为人工沟通的合成记录，不宣称已真实收款',async()=>{
  await withShowcase(async({request,ids})=>{
    const contacted=await request(`/api/reservations/${ids.reviewOrder}/damage/contact`,{
      method:'POST',role:'staff',body:{channel:'PHONE',outcome:'REACHED',
        note:'已向虚构顾客解释虚构损伤费用和后续核对方式'}
    });
    assert.equal(contacted.status,200,JSON.stringify(contacted.data));
    assertSimulation(contacted.data,'受损联系');
    assert.equal(contacted.data.contacts.length,1);
    assert.equal(contacted.data.contacts[0].outcome,'REACHED');
    assert.equal(contacted.data.contacts[0].simulation,true,
      '联系记录不可被误读为真实联系或收款凭据');
    assert.equal(contacted.data.settlement?.paid_nok||0,0);
  },{seedReview:true});
});
