import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {consent} from './damage-helpers.mjs';
import {futureDate} from './future-date.mjs';

const temp=mkdtempSync(join(tmpdir(),'bsr-idempotent-reservation-'));
process.env.NODE_ENV='test';process.env.BSR_DB_PATH=join(temp,'orders.sqlite');
const {server,db}=await import('../src/server.mjs');
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
async function request(path,method='GET',data,token='',key){
 const res=await fetch(base+path,{method,headers:{...(token?{'x-bsr-session':token}:{}),...(key!==undefined?{'Idempotency-Key':key}:{}),...(data?{'content-type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});
 return {status:res.status,data:await res.json()};
}
async function login(email,password='Demo123!'){const r=await request('/api/auth/login','POST',{email,password});assert.equal(r.status,200);return r.data.sessionToken;}
const payload=(offset=12,variantId=1)=>({storeId:1,pickupAt:futureDate(offset),returnAt:futureDate(offset+1),customerSkill:'中级',items:[{variantId,qty:1}],damageConsent:consent});

test('缺失或无效提交标识拒绝，失败请求不占用标识',async()=>{
 const customer=await login('customer@bsr.demo'),input=payload(12),key='test-reservation-failed-001';
 const before=db.prepare('SELECT COUNT(*) n FROM reservations').get().n;
 assert.equal((await request('/api/reservations','POST',input,customer)).status,428);
 assert.equal((await request('/api/reservations','POST',input,customer,'short')).status,400);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM reservations').get().n,before);
 assert.equal((await request('/api/reservations','POST',{...input,damageConsent:{...consent,accepted:false}},customer,key)).status,422);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM reservation_requests WHERE request_key=?').get(key).n,0);
 assert.equal((await request('/api/reservations','POST',input,customer,key)).status,201);
});

test('同键并发重试只建一单，改负载冲突且不延长暂留',async()=>{
 const customer=await login('customer@bsr.demo'),input=payload(16,3),key='test-reservation-concurrent-001';
 const before=db.prepare('SELECT COUNT(*) n FROM reservations').get().n;
 const results=await Promise.all([request('/api/reservations','POST',input,customer,key),request('/api/reservations','POST',input,customer,key)]);
 assert.deepEqual(results.map(r=>r.status).sort(),[200,201]);
 assert.equal(results[0].data.id,results[1].data.id);
 assert.equal(results.filter(r=>r.data.replayed).length,1);
 const id=results[0].data.id,original=db.prepare('SELECT code,hold_expires_at,rent_nok,deposit_nok FROM reservations WHERE id=?').get(id);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM reservations').get().n,before+1);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM reservation_requests WHERE reservation_id=?').get(id).n,1);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM damage_consents WHERE reservation_id=?').get(id).n,1);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE target_type='reservation' AND target_id=? AND action='RESERVATION_CREATED'").get(id).n,1);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id=? AND body LIKE ?").get(1,`%${original.code}%`).n,1);
 const altered={...input,items:[{variantId:3,qty:2}]};
 assert.equal((await request('/api/reservations','POST',altered,customer,key)).status,409);
 assert.deepEqual(db.prepare('SELECT code,hold_expires_at,rent_nok,deposit_nok FROM reservations WHERE id=?').get(id),original);
 db.prepare("UPDATE reservations SET status='CANCELLED',hold_expires_at=? WHERE id=?").run(new Date(Date.now()-60000).toISOString(),id);
 const replay=await request('/api/reservations','POST',input,customer,key);
 assert.equal(replay.status,200);assert.equal(replay.data.id,id);assert.equal(replay.data.status,'CANCELLED');
 assert.equal(db.prepare('SELECT COUNT(*) n FROM reservations').get().n,before+1);
});

test('现场重试不重复审计，键按实际员工与渠道隔离',async()=>{
 const staff=await login('staff@bsr.demo'),other=await login('staff2@bsr.demo'),customer=await login('customer@bsr.demo');
 const key='test-counter-order-request-001',input={...payload(21,9),customerId:1};
 const first=await request('/api/operations/reservations','POST',input,staff,key);assert.equal(first.status,201,JSON.stringify(first.data));
 const again=await request('/api/operations/reservations','POST',input,staff,key);assert.equal(again.status,200);assert.equal(again.data.id,first.data.id);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='COUNTER_ORDER_CREATED' AND target_id=?").get(first.data.id).n,1);
 assert.equal((await request('/api/operations/reservations','POST',{...input,customerId:999},staff,key)).status,409);
 const second=await request('/api/operations/reservations','POST',{...payload(23,9),storeId:2,customerId:1},other,key);
 assert.equal(second.status,201,JSON.stringify(second.data));assert.notEqual(second.data.id,first.data.id);
 const online=await request('/api/reservations','POST',payload(25,9),customer,key);
 assert.equal(online.status,201,JSON.stringify(online.data));assert.notEqual(online.data.id,first.data.id);
});

test('迁移重复运行仍保留历史金额、合同哈希和外键',async()=>{
 const before=db.prepare("SELECT id,rent_nok,deposit_nok,total_nok,status FROM reservations WHERE code='BR-DEMO001'").get();
 const contract=db.prepare('SELECT snapshot_hash FROM contracts WHERE reservation_id=? ORDER BY version DESC LIMIT 1').get(before.id);
 const {openDb}=await import('../src/db.mjs');
 const second=openDb(process.env.BSR_DB_PATH);second.close();
 assert.deepEqual(db.prepare('SELECT id,rent_nok,deposit_nok,total_nok,status FROM reservations WHERE id=?').get(before.id),before);
 assert.deepEqual(db.prepare('SELECT snapshot_hash FROM contracts WHERE reservation_id=? ORDER BY version DESC LIMIT 1').get(before.id),contract);
 assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test.after(()=>{server.close();db.close();rmSync(temp,{recursive:true,force:true});});
