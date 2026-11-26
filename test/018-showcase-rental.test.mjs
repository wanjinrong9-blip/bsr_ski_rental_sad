import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {openDb} from '../src/db.mjs';
import {candidateProvisionAccount,candidateChangePassword} from '../src/identity.mjs';
import {validateRuntimeConfig} from '../src/runtime-config.mjs';
import {initializeShowcase} from '../src/runtime-provenance.mjs';
import {consent} from './damage-helpers.mjs';
import {futureDate} from './future-date.mjs';
import {candidateRequest} from './candidate-fixtures.mjs';
import {makeShowcaseFixture} from './018-showcase-fixtures.mjs';

const root=resolve(import.meta.dirname,'..');
const administrator={operator:'018-rental-test',name:'虚构权限管理员',
  email:'synthetic-rental-admin@example.test',password:'Private#ShowcaseAdmin2026'};
const windowAt=(start=12,end=13)=>({
  storeId:1,pickupAt:futureDate(start),returnAt:futureDate(end)
});
const profile={phone:'00000000',address:'虚构地址，仅供合成测试',birthYear:1999,
  heightCm:175,weightKg:70,shoeSize:'EU 42'};
const cookie=response=>{
  const header=response.headers['set-cookie'];
  return (Array.isArray(header)?header[0]:header||'').split(';')[0];
};
const headers=(fixture,session='',key='')=>({Origin:fixture.origin,
  ...(session?{Cookie:session}:{}),...(key?{'Idempotency-Key':key}:{})});

async function setup(customerCount=1){
  const fixture=await makeShowcaseFixture();
  let child;
  try{
    const config=validateRuntimeConfig(fixture.env,{root,publicDir:join(root,'public')});
    initializeShowcase(config,administrator);
    const db=openDb(fixture.dbPath,{runMode:'showcase'});
    try{
      const admin=db.prepare("SELECT * FROM users WHERE role='admin'").get();
      for(let number=1;number<=customerCount;number++){
        const email=`synthetic-customer-${number}@example.test`;
        const temporaryPassword=`Private#SyntheticCustomer${number}A`;
        const created=candidateProvisionAccount(db,admin,{
          name:`虚构顾客${number}`,email,role:'customer',temporaryPassword,
          verificationRef:`FICTIONAL-CUSTOMER-${number}`
        },{runMode:'showcase'});
        const account=db.prepare('SELECT * FROM users WHERE id=?').get(created.id);
        candidateChangePassword(db,account,{
          currentPassword:temporaryPassword,newPassword:`Private#RotatedCustomer${number}B`
        },{runMode:'showcase'});
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
      await new Promise(done=>setTimeout(done,40));
    }
    assert.equal(ready,true,stderr);
    const sessions=[];
    for(let number=1;number<=customerCount;number++){
      const login=await candidateRequest(fixture,'/api/auth/login',{
        method:'POST',headers:headers(fixture),
        body:{email:`synthetic-customer-${number}@example.test`,
          password:`Private#RotatedCustomer${number}B`}
      });
      assert.equal(login.status,200,JSON.stringify(login.data));
      sessions.push(cookie(login));
    }
    return {fixture,child,sessions,
      request(path,{method='GET',body,session=sessions[0],key}={}){
        return candidateRequest(fixture,path,{method,body,
          headers:headers(fixture,session,key)});
      },
      async cleanup(){
        if(child.exitCode===null){const closed=new Promise(done=>child.once('close',done));child.kill();await closed;}
        fixture.cleanup();
      }};
  }catch(error){
    if(child&&child.exitCode===null){const closed=new Promise(done=>child.once('close',done));child.kill();await closed;}
    fixture.cleanup();throw error;
  }
}

function orderInput(variantId,qty=1,period=windowAt()){
  return {...period,items:[{variantId,qty}],customerSkill:'中级',
    customerProfile:profile,damageConsent:consent};
}

test('SHOWCASE 时间段目录、购物车与报价以 NOK 计算每件参考价值 8% 押金',async()=>{
  const ctx=await setup();
  try{
    const period=windowAt();
    const catalog=await ctx.request(`/api/catalog?storeId=1&pickupAt=${encodeURIComponent(period.pickupAt)}&returnAt=${encodeURIComponent(period.returnAt)}`);
    assert.equal(catalog.status,200,JSON.stringify(catalog.data));
    const goggles=catalog.data.items.find(item=>item.subtype==='护目镜');
    const knees=catalog.data.items.find(item=>item.subtype==='护膝');
    assert.ok(goggles&&knees);
    assert.equal(goggles.available,2);
    assert.equal(knees.available,2);
    const cart=await ctx.request('/api/cart',{method:'PUT',body:{
      expectedVersion:0,...period,items:[{variantId:goggles.id,qty:1},{variantId:knees.id,qty:1}]
    }});
    assert.equal(cart.status,200,JSON.stringify(cart.data));
    assert.equal(cart.data.items.length,2);
    assert.equal((await ctx.request('/api/cart')).data.version,cart.data.version);
    const quoted=await ctx.request('/api/quote',{method:'POST',body:{
      ...period,items:[{variantId:goggles.id,qty:1},{variantId:knees.id,qty:1}]
    }});
    assert.equal(quoted.status,200,JSON.stringify(quoted.data));
    assert.equal(quoted.data.currency,'NOK');
    assert.equal(quoted.data.lines.length,2);
    for(const line of quoted.data.lines){
      assert.equal(line.unitDepositNok,Math.round(line.referenceValueNok*0.08));
      assert.equal(line.depositNok,line.unitDepositNok*line.qty);
      assert.ok(line.policyVersion>=1);
    }
    assert.equal(quoted.data.totalNok,quoted.data.rentNok+quoted.data.depositNok);
  }finally{await ctx.cleanup();}
});

test('SHOWCASE 服务端拒绝 09:00 前取货和 16:00 后归还，不写入预约',async()=>{
  const ctx=await setup();
  try{
    const early=windowAt();
    early.pickupAt=early.pickupAt.replace('T11:00:00.000Z','T05:00:00.000Z');
    const late=windowAt();
    late.returnAt=late.returnAt.replace('T11:00:00.000Z','T20:00:00.000Z');
    for(const period of [early,late]){
      const response=await ctx.request('/api/quote',{method:'POST',body:{
        ...period,items:[{variantId:1,qty:1}]
      }});
      assert.equal(response.status,400,JSON.stringify(response.data));
    }
    const db=openDb(ctx.fixture.dbPath,{runMode:'showcase'});
    try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n,0);}
    finally{db.close();}
  }finally{await ctx.cleanup();}
});

test('SHOWCASE 创建预约时重查库存，重复提交稳定，并保留旧价目快照与取消释放',async()=>{
  const ctx=await setup();
  try{
    const period=windowAt(),input=orderInput(1,1,period),key=randomUUID();
    const created=await ctx.request('/api/reservations',{
      method:'POST',body:input,key
    });
    assert.equal(created.status,201,JSON.stringify(created.data));
    assert.equal(created.data.quote.lines[0].unitDepositNok,
      Math.round(created.data.quote.lines[0].referenceValueNok*0.08));
    const replay=await ctx.request('/api/reservations',{method:'POST',body:input,key});
    assert.equal(replay.status,200,JSON.stringify(replay.data));
    assert.equal(replay.data.id,created.data.id);
    assert.equal(replay.data.replayed,true);
    const originalRent=created.data.quote.lines[0].unitRentNok;
    const originalPolicy=created.data.quote.lines[0].policyId;
    const db=openDb(ctx.fixture.dbPath,{runMode:'showcase'});
    try{
      const policy=db.prepare('SELECT * FROM price_policies WHERE id=?').get(originalPolicy);
      db.prepare(`INSERT INTO price_policies
        (variant_id,store_id,version,daily_nok,deposit_nok,extra_day_factor,
         effective_from,status,approved_by,created_at)
        VALUES(?,?,2,?,?,?,'2026-01-01','APPROVED',?,?)`)
        .run(policy.variant_id,policy.store_id,policy.daily_nok+100,
          policy.deposit_nok,policy.extra_day_factor,policy.approved_by,
          new Date().toISOString());
    }finally{db.close();}
    const freshQuote=await ctx.request('/api/quote',{method:'POST',body:input});
    assert.equal(freshQuote.status,200,JSON.stringify(freshQuote.data));
    assert.equal(freshQuote.data.lines[0].unitRentNok,originalRent+100);
    const detail=await ctx.request(`/api/reservations/${created.data.id}`);
    assert.equal(detail.status,200,JSON.stringify(detail.data));
    assert.equal(detail.data.quote.lines[0].unitRentNok,originalRent);
    const cancelled=await ctx.request(`/api/reservations/${created.data.id}/cancel`,{
      method:'POST',body:{}
    });
    assert.equal(cancelled.status,200,JSON.stringify(cancelled.data));
    const catalog=await ctx.request(`/api/catalog?storeId=1&pickupAt=${encodeURIComponent(period.pickupAt)}&returnAt=${encodeURIComponent(period.returnAt)}`);
    assert.equal(catalog.status,200);
    assert.equal(catalog.data.items.find(item=>item.id===1).available,2);
    const saved=openDb(ctx.fixture.dbPath,{runMode:'showcase'});
    try{
      assert.equal(saved.prepare('SELECT COUNT(*) AS n FROM reservations').get().n,1);
      assert.equal(saved.prepare('SELECT COUNT(*) AS n FROM reservation_requests').get().n,1);
    }finally{saved.close();}
  }finally{await ctx.cleanup();}
});

test('SHOWCASE 两个顾客争最后两件时仅一单成功，相邻租期库存仍可用',async()=>{
  const ctx=await setup(2);
  try{
    const period=windowAt(),first=orderInput(1,2,period),second=orderInput(1,2,period);
    const [a,b]=await Promise.all([
      ctx.request('/api/reservations',{method:'POST',body:first,session:ctx.sessions[0],key:randomUUID()}),
      ctx.request('/api/reservations',{method:'POST',body:second,session:ctx.sessions[1],key:randomUUID()})
    ]);
    assert.deepEqual([a.status,b.status].sort((x,y)=>x-y),[201,409],
      JSON.stringify([a.data,b.data]));
    const blocked=await ctx.request('/api/quote',{method:'POST',body:{
      ...period,items:[{variantId:1,qty:1}]
    }});
    assert.equal(blocked.status,409,JSON.stringify(blocked.data));
    const next=windowAt(14,15);
    const available=await ctx.request(`/api/catalog?storeId=1&pickupAt=${encodeURIComponent(next.pickupAt)}&returnAt=${encodeURIComponent(next.returnAt)}`);
    assert.equal(available.status,200,JSON.stringify(available.data));
    assert.equal(available.data.items.find(item=>item.id===1).available,2);
    const db=openDb(ctx.fixture.dbPath,{runMode:'showcase'});
    try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n,1);}
    finally{db.close();}
  }finally{await ctx.cleanup();}
});
