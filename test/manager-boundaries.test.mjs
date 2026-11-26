import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {futureDate} from './future-date.mjs';
import {consent} from './damage-helpers.mjs';
import {createReservation} from '../src/domain.mjs';

const temp=mkdtempSync(join(tmpdir(),'bsr-manager-boundaries-'));
process.env.NODE_ENV='test';
process.env.BSR_DB_PATH=join(temp,'boundaries.sqlite');
const {server,db}=await import('../src/server.mjs');
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;

async function request(path,method='GET',data,token=''){
  const response=await fetch(base+path,{method,headers:{...(token?{'x-bsr-session':token}:{}),...(data?{'content-type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});
  const raw=await response.text();let result;try{result=JSON.parse(raw);}catch{result=raw;}
  return {status:response.status,data:result};
}
async function login(email){const response=await request('/api/auth/login','POST',{email,password:'Demo123!'});assert.equal(response.status,200);return response.data.sessionToken;}
const accounts={};
test.before(async()=>{
  for(const [role,email] of Object.entries({manager:'manager@bsr.demo',staff:'staff@bsr.demo',northStaff:'staff2@bsr.demo',owner:'owner@bsr.demo',admin:'admin@bsr.demo'}))accounts[role]=await login(email);
});

test('经理只能发起本店调拨，接收须由目标店员工办理',async()=>{
  const other=db.prepare("SELECT id,status FROM units WHERE store_id=2 AND status='AVAILABLE' ORDER BY id LIMIT 1").get();
  const own=db.prepare("SELECT id,status FROM units WHERE store_id=1 AND status='AVAILABLE' ORDER BY id LIMIT 1").get();
  assert.ok(other&&own);
  const before=db.prepare('SELECT COUNT(*) AS n FROM transfers').get().n;
  const denied=await request('/api/transfers','POST',{unitId:other.id,toStoreId:1},accounts.manager);
  assert.equal(denied.status,403,JSON.stringify(denied.data));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transfers').get().n,before);
  assert.equal(db.prepare('SELECT status FROM units WHERE id=?').get(other.id).status,other.status);

  const dispatched=await request('/api/transfers','POST',{unitId:own.id,toStoreId:2},accounts.manager);
  assert.equal(dispatched.status,201,JSON.stringify(dispatched.data));
  const id=dispatched.data.id;
  assert.equal((await request(`/api/transfers/${id}/receive`,'POST',{},accounts.staff)).status,403);
  assert.equal(db.prepare('SELECT status FROM transfers WHERE id=?').get(id).status,'IN_TRANSIT');
  assert.equal((await request(`/api/transfers/${id}/receive`,'POST',{},accounts.northStaff)).status,200);
  assert.equal(db.prepare('SELECT store_id,status FROM units WHERE id=?').get(own.id).store_id,2);
});

test('门店经理不能发布另一店价目，本店政策仍可发布',async()=>{
  const variantId=9,effectiveFrom=futureDate(2).slice(0,10);
  const before=db.prepare('SELECT COUNT(*) AS n FROM price_policies WHERE variant_id=? AND store_id=2').get(variantId).n;
  const input={variantId,storeId:2,dailyNok:199,extraDayFactor:0.8,effectiveFrom};
  assert.equal((await request('/api/policies','POST',input,accounts.manager)).status,403);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM price_policies WHERE variant_id=? AND store_id=2').get(variantId).n,before);
  const own=await request('/api/policies','POST',{...input,storeId:1},accounts.manager);
  assert.equal(own.status,201,JSON.stringify(own.data));
  assert.equal(db.prepare('SELECT store_id FROM price_policies WHERE id=?').get(own.data.id).store_id,1);
});

test('经理报表只计本店，经营与管理员不获取逐单最近记录或逐件库存',async()=>{
  const expected=db.prepare('SELECT COUNT(*) AS n FROM reservations WHERE store_id=1').get().n;
  const manager=await request('/api/reports','GET',undefined,accounts.manager);
  assert.equal(manager.status,200,JSON.stringify(manager.data));
  assert.equal(manager.data.overview.orders,expected);
  assert.equal(manager.data.byStore.length,1);
  assert.ok(manager.data.recent.every(row=>db.prepare('SELECT 1 FROM reservations WHERE code=? AND store_id=1').get(row.code)));
  for(const role of ['owner','admin']){
    const report=await request('/api/reports','GET',undefined,accounts[role]);
    assert.equal(report.status,200,JSON.stringify(report.data));
    assert.deepEqual(report.data.recent,[]);
    const inventory=await request('/api/inventory','GET',undefined,accounts[role]);
    assert.equal(inventory.status,200,JSON.stringify(inventory.data));
    assert.ok(inventory.data.every(row=>Object.keys(row).sort().join(',')==='count,status,store_id'));
    assert.equal(inventory.data.reduce((sum,row)=>sum+row.count,0),db.prepare('SELECT COUNT(*) AS n FROM units').get().n);
    assert.equal((await request('/api/maintenance','GET',undefined,accounts[role])).status,403);
  }
  const staffInventory=await request('/api/inventory','GET',undefined,accounts.staff);
  assert.equal(staffInventory.status,200);
  assert.ok(staffInventory.data.every(row=>row.store_id===1));
  const networkSummary=await request('/api/inventory/summary','GET',undefined,accounts.manager);
  assert.equal(networkSummary.status,200);
  assert.ok(networkSummary.data.every(row=>Object.keys(row).sort().join(',')==='count,status,store_id'));
  assert.equal(networkSummary.data.reduce((sum,row)=>sum+row.count,0),db.prepare('SELECT COUNT(*) AS n FROM units').get().n);
});

test('经理排班与员工名册只显示所属门店',async()=>{
  const directory=await request('/api/employees','GET',undefined,accounts.manager);
  assert.equal(directory.status,200);
  assert.ok(directory.data.every(row=>row.store_id===1||row.role==='contractor'));
  assert.ok(directory.data.some(row=>row.role==='staff'));
  const shifts=await request('/api/shifts','GET',undefined,accounts.manager);
  assert.equal(shifts.status,200);
  assert.ok(shifts.data.every(row=>row.store_id===1));
  assert.ok(shifts.data.every(row=>['staff','manager','contractor'].includes(row.role)));
  const roster=await request('/api/roster','GET',undefined,accounts.manager);
  assert.equal(roster.status,200);
  assert.ok(roster.data.rows.every(row=>(row.shift?.store_id||row.store_id)===1));
  assert.equal((await request('/api/roster?storeId=2','GET',undefined,accounts.manager)).status,403);
  const workDate=futureDate(90).slice(0,10);
  const contractorShift=await request('/api/shifts','POST',{userId:4,storeId:1,workDate,startTime:'09:00',endTime:'17:00'},accounts.manager);
  assert.equal(contractorShift.status,201,JSON.stringify(contractorShift.data));
  const assigned=await request(`/api/roster?date=${workDate}`,'GET',undefined,accounts.manager);
  assert.equal(assigned.status,200);
  assert.equal(assigned.data.rows.find(row=>row.id===4)?.shift?.store_id,1);
});

test('经理审计仅本店；管理员审计仅权限元数据，不能读逐单业务',async()=>{
  createReservation(db,1,{storeId:2,pickupAt:futureDate(60),returnAt:futureDate(61),customerSkill:'初级',items:[{variantId:9,qty:1}],damageConsent:consent},null,'manager-boundaries-audit-north-001');
  const south=db.prepare('SELECT id FROM reservations WHERE store_id=1 ORDER BY id LIMIT 1').get();
  const north=db.prepare('SELECT id FROM reservations WHERE store_id=2 ORDER BY id LIMIT 1').get();
  assert.ok(south&&north);
  const marker='CROSS_STORE_SECRET_012';
  const insert=db.prepare('INSERT INTO audit_log(actor_id,action,target_type,target_id,detail_json,created_at) VALUES(?,?,?,?,?,?)');
  const ownId=Number(insert.run(3,'STORE_OWN_TEST','reservation',south.id,'{"note":"own"}',new Date().toISOString()).lastInsertRowid);
  const otherId=Number(insert.run(7,'STORE_OTHER_TEST','reservation',north.id,JSON.stringify({note:marker}),new Date().toISOString()).lastInsertRowid);
  const securityId=Number(insert.run(6,'ROLE_UPDATED','user',2,JSON.stringify({privateText:marker}),new Date().toISOString()).lastInsertRowid);
  const manager=await request('/api/audit','GET',undefined,accounts.manager);
  assert.equal(manager.status,200,JSON.stringify(manager.data));
  assert.ok(manager.data.some(row=>row.id===ownId));
  assert.ok(manager.data.every(row=>row.id!==otherId));
  assert.equal(JSON.stringify(manager.data).includes(marker),false);
  const admin=await request('/api/audit','GET',undefined,accounts.admin);
  assert.equal(admin.status,200,JSON.stringify(admin.data));
  assert.ok(admin.data.some(row=>row.id===securityId));
  assert.ok(admin.data.every(row=>row.id!==ownId&&row.id!==otherId));
  assert.equal(JSON.stringify(admin.data).includes(marker),false);
  assert.equal((await request('/api/audit','GET',undefined,accounts.owner)).status,403);
});

test('账号清单仅权限管理员可读取，经理不能枚举全平台顾客',async()=>{
  assert.equal((await request('/api/users','GET',undefined,accounts.manager)).status,403);
  const admin=await request('/api/users','GET',undefined,accounts.admin);
  assert.equal(admin.status,200);
  assert.ok(admin.data.some(row=>row.role==='customer'));
  assert.ok(admin.data.every(row=>Object.keys(row).sort().join(',')==='created_at,email,id,name,role,store_id'));
});

test.after(()=>{server.close();db.close();rmSync(temp,{recursive:true,force:true});});
