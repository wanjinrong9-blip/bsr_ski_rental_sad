import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';

const root=resolve(tmpdir());
const temp=mkdtempSync(join(root,'bsr-master-atomic-'));
process.env.NODE_ENV='test';
process.env.BSR_DB_PATH=join(temp,'isolated.sqlite');
const {server,db}=await import('../src/server.mjs');
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
async function request(path,method='GET',data,token=''){
  const response=await fetch(base+path,{method,headers:{
    ...(token?{'x-bsr-session':token}:{}),
    ...(data?{'content-type':'application/json'}:{})
  },body:data?JSON.stringify(data):undefined});
  return {status:response.status,data:await response.json()};
}
async function login(role){
  const result=await request('/api/auth/login','POST',{email:`${role}@bsr.demo`,password:'Demo123!'});
  assert.equal(result.status,200);
  return result.data.sessionToken;
}
const customer=await login('customer'),staff=await login('staff'),manager=await login('manager');
const today=new Date().toISOString().slice(0,10);
const suffix=()=>randomUUID().slice(0,10);

async function expectAtomicAuditFailure({action,path,method='POST',input,token,read}){
  const before=read(),beforeAudit=db.prepare('SELECT COUNT(*) n FROM audit_log WHERE action=?').get(action).n;
  db.exec(`CREATE TEMP TRIGGER deny_audit_016 BEFORE INSERT ON main.audit_log WHEN NEW.action='${action}' BEGIN SELECT RAISE(FAIL,'injected audit failure'); END`);
  let result;
  try{result=await request(path,method,input,token);}
  finally{db.exec('DROP TRIGGER IF EXISTS temp.deny_audit_016');}
  assert.ok(result.status>=500,`${action}: injected audit failure must fail the request, got ${result.status}`);
  assert.deepEqual(read(),before,`${action}: business state must roll back with its audit entry`);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_log WHERE action=?').get(action).n,beforeAudit);
}

test('customer profile rolls back when audit persistence fails',async()=>{
  await expectAtomicAuditFailure({action:'PROFILE_UPDATED',path:'/api/me',method:'PATCH',token:customer,
    input:{name:'原子性测试顾客',phone:'+47 9000 1111',address:'隔离测试地址 16',birthYear:2001,heightCm:170,weightKg:65,shoeSize:'EU 40'},
    read:()=>db.prepare('SELECT name,phone,address,birth_year,height_cm,weight_kg,shoe_size FROM users WHERE id=1').get()});
});

test('counter-created customer rolls back when audit persistence fails',async()=>{
  const email=`atomic-${suffix()}@bsr.demo`;
  await expectAtomicAuditFailure({action:'CUSTOMER_CREATED_AT_COUNTER',path:'/api/customers',token:staff,
    input:{name:'现场原子性顾客',email,phone:'+47 9000 2222',address:'隔离测试地址 22',birthYear:2000,heightCm:168,weightKg:60,shoeSize:'EU 39',password:'Test12345!'},
    read:()=>db.prepare('SELECT id,email FROM users WHERE email=?').get(email)||null});
});

test('contractor rate rolls back when audit persistence fails',async()=>{
  await expectAtomicAuditFailure({action:'CONTRACTOR_RATE_APPROVED',path:'/api/contractor-rates',token:manager,
    input:{contractorId:4,hourlyNok:321,effectiveFrom:today,note:'隔离测试费率依据'},
    read:()=>db.prepare('SELECT id,hourly_nok FROM contractor_rates WHERE contractor_id=4 AND effective_from=?').get(today)||null});
});

test('new store rolls back when audit persistence fails',async()=>{
  const name=`Atomic Skardalen ${suffix()}`;
  await expectAtomicAuditFailure({action:'STORE_CREATED',path:'/api/stores',token:manager,
    input:{name,address:'Testveien 16, Troms, Norway',subtitle:'隔离测试站',openHours:'09:00–17:00'},
    read:()=>db.prepare('SELECT id,name FROM stores WHERE name=?').get(name)||null});
});

test('purchased unit rolls back when audit persistence fails',async()=>{
  const inventoryNo=`ATOMIC-016-${suffix()}`;
  await expectAtomicAuditFailure({action:'UNIT_PURCHASED',path:'/api/inventory',token:manager,
    input:{variantId:1,storeId:1,inventoryNo,purchaseDate:today,purchaseCostNok:500,retailNok:1200,skill:'初级'},
    read:()=>db.prepare('SELECT id,inventory_no FROM units WHERE inventory_no=?').get(inventoryNo)||null});
});

test('cleaning completion rolls back when audit persistence fails',async()=>{
  const unit=db.prepare("SELECT id FROM units WHERE store_id=1 AND status='AVAILABLE' ORDER BY id LIMIT 1").get().id;
  db.prepare('UPDATE units SET needs_cleaning=1 WHERE id=?').run(unit);
  await expectAtomicAuditFailure({action:'CLEANING_COMPLETED',path:`/api/inventory/${unit}/clean`,token:staff,
    input:{confirmed:true,note:'完成清洁及干燥检查'},
    read:()=>db.prepare('SELECT needs_cleaning,condition_note FROM units WHERE id=?').get(unit)});
});

test('price policy version rolls back when audit persistence fails',async()=>{
  await expectAtomicAuditFailure({action:'PRICE_POLICY_APPROVED',path:'/api/policies',token:manager,
    input:{variantId:1,storeId:1,dailyNok:500,extraDayFactor:0.8,effectiveFrom:today},
    read:()=>db.prepare('SELECT id,version,daily_nok FROM price_policies WHERE variant_id=1 AND store_id=1 ORDER BY version').all()});
});

test('duplicate local submissions commit one customer, rate, store and unit with one audit each',async()=>{
  async function race({path,input,token,action,read}){
    const before=db.prepare('SELECT COUNT(*) n FROM audit_log WHERE action=?').get(action).n;
    const results=await Promise.all([request(path,'POST',input,token),request(path,'POST',input,token)]);
    assert.deepEqual(results.map(r=>r.status).sort((a,b)=>a-b),[201,409],`${action}: one local request succeeds and one conflicts`);
    assert.equal(read(),1,`${action}: exactly one business row exists`);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_log WHERE action=?').get(action).n,before+1);
  }
  const email=`race-${suffix()}@bsr.demo`;
  await race({path:'/api/customers',token:staff,action:'CUSTOMER_CREATED_AT_COUNTER',
    input:{name:'并发测试顾客',email,phone:'+47 9000 3333',address:'隔离测试地址 33',birthYear:2001,heightCm:170,weightKg:65,shoeSize:'EU 40',password:'Test12345!'},
    read:()=>db.prepare('SELECT COUNT(*) n FROM users WHERE email=?').get(email).n});
  await race({path:'/api/contractor-rates',token:manager,action:'CONTRACTOR_RATE_APPROVED',
    input:{contractorId:4,hourlyNok:333,effectiveFrom:today,note:'隔离并发费率依据'},
    read:()=>db.prepare('SELECT COUNT(*) n FROM contractor_rates WHERE contractor_id=4 AND effective_from=?').get(today).n});
  const name=`Concurrent Skardalen ${suffix()}`;
  await race({path:'/api/stores',token:manager,action:'STORE_CREATED',
    input:{name,address:'Testveien 33, Troms, Norway',subtitle:'隔离并发服务站'},
    read:()=>db.prepare('SELECT COUNT(*) n FROM stores WHERE name=?').get(name).n});
  const inventoryNo=`CONCURRENT-016-${suffix()}`;
  await race({path:'/api/inventory',token:manager,action:'UNIT_PURCHASED',
    input:{variantId:1,storeId:1,inventoryNo,purchaseDate:today,purchaseCostNok:500,retailNok:1200,skill:'初级'},
    read:()=>db.prepare('SELECT COUNT(*) n FROM units WHERE inventory_no=?').get(inventoryNo).n});
});

test('two local cleaning requests preserve a single state transition and audit',async()=>{
  const unit=db.prepare("SELECT id FROM units WHERE store_id=1 AND status='AVAILABLE' AND needs_cleaning=0 ORDER BY id LIMIT 1").get().id;
  db.prepare('UPDATE units SET needs_cleaning=1 WHERE id=?').run(unit);
  const before=db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='CLEANING_COMPLETED'").get().n;
  const results=await Promise.all([0,1].map(()=>request(`/api/inventory/${unit}/clean`,'POST',{confirmed:true,note:'并发清洁测试完成'},staff)));
  assert.deepEqual(results.map(r=>r.status).sort((a,b)=>a-b),[200,409]);
  assert.equal(db.prepare('SELECT needs_cleaning FROM units WHERE id=?').get(unit).needs_cleaning,0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='CLEANING_COMPLETED'").get().n,before+1);
});

test.after(async()=>{
  await new Promise(resolve=>server.close(resolve));
  db.close();
  if(!resolve(temp).startsWith(root+sep))throw new Error('Refusing to remove a non-temporary fixture');
  rmSync(temp,{recursive:true,force:true});
});
