import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {consent} from './damage-helpers.mjs';
import {signBeforePay} from './fulfillment-helpers.mjs';
import {futureDate} from './future-date.mjs';
import {hashPassword} from '../src/db.mjs';

const root=resolve(tmpdir());
const temp=mkdtempSync(join(root,'bsr-explicit-skill-reprepare-'));
process.env.NODE_ENV='test';
process.env.BSR_DB_PATH=join(temp,'isolated.sqlite');
const {server,db}=await import('../src/server.mjs');
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;

async function request(path,method='GET',data,token='',key){
  const response=await fetch(base+path,{method,headers:{
    ...(token?{'x-bsr-session':token}:{}),
    ...(data?{'content-type':'application/json'}:{}),
    ...(key?{'Idempotency-Key':key}:{})
  },body:data?JSON.stringify(data):undefined});
  return {status:response.status,data:await response.json()};
}
async function login(role){
  const result=await request('/api/auth/login','POST',{
    email:`${role}@bsr.demo`,password:'Demo123!'
  });
  assert.equal(result.status,200);
  return result.data.sessionToken;
}
const customer=await login('customer'),staff=await login('staff');
const booking=(days,skill='中级')=>({storeId:1,pickupAt:futureDate(days),returnAt:futureDate(days+1),
  customerSkill:skill,items:[{variantId:13,qty:1}],damageConsent:consent});
const rows=()=>({
  reservations:db.prepare('SELECT COUNT(*) n FROM reservations').get().n,
  holds:db.prepare("SELECT COUNT(*) n FROM reservations WHERE status='HOLD'").get().n,
  requests:db.prepare('SELECT COUNT(*) n FROM reservation_requests').get().n,
  consents:db.prepare('SELECT COUNT(*) n FROM damage_consents').get().n
});
const prepState=id=>({
  preparation:db.prepare('SELECT status,public_note,version,assigned_to,ready_at FROM preparations WHERE reservation_id=?').get(id),
  order:db.prepare('SELECT status FROM reservations WHERE id=?').get(id),
  units:db.prepare('SELECT unit_id,active,size_checked,clean_checked,safety_checked FROM preparation_units WHERE reservation_id=? ORDER BY unit_id').all(id),
  events:db.prepare('SELECT COUNT(*) n FROM preparation_events WHERE reservation_id=?').get(id).n,
  notifications:db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id=1').get().n
});

test('online order rejects omitted, blank and unsupported self-assessed skill without side effects',async()=>{
  const path='/api/reservations';
  for(const [label,skill] of [['omitted',undefined],['blank',''],['whitespace','   '],['null',null],['unsupported','大师'],['number',1],['object',{}],['array',[]]]){
    const input=booking(210+(label.length%3)*3,skill);
    if(skill===undefined)delete input.customerSkill;
    const before=rows(),key=`explicit-online-${label}-${randomUUID()}`;
    const result=await request(path,'POST',input,customer,key);
    assert.equal(result.status,422,`${label}: ${JSON.stringify(result.data)}`);
    assert.deepEqual(rows(),before,`${label}: rejected order must not reserve stock or create an idempotency row`);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM reservation_requests WHERE request_key=?').get(key).n,0);
  }
});

test('counter order rejects omitted, blank and unsupported self-assessed skill without side effects',async()=>{
  const path='/api/operations/reservations';
  for(const [label,skill] of [['omitted',undefined],['blank',''],['whitespace','   '],['null',null],['unsupported','大师'],['number',1],['object',{}],['array',[]]]){
    const input={...booking(220+(label.length%3)*3,skill),customerId:1};
    if(skill===undefined)delete input.customerSkill;
    const before=rows(),key=`explicit-counter-${label}-${randomUUID()}`;
    const result=await request(path,'POST',input,staff,key);
    assert.equal(result.status,422,`${label}: ${JSON.stringify(result.data)}`);
    assert.deepEqual(rows(),before,`${label}: rejected order must not reserve stock or create an idempotency row`);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM reservation_requests WHERE request_key=?').get(key).n,0);
  }
});

test('four explicit levels persist in both channels and contracts; legacy null stays unknown',async()=>{
  const levels=['初级','中级','高级','专家+'];
  for(const [channel,path,token] of [['online','/api/reservations',customer],['counter','/api/operations/reservations',staff]]){
    for(const [index,level] of levels.entries()){
      const data={...booking(300+(channel==='counter'?12:0)+index*3,`  ${level}  `),...(channel==='counter'?{customerId:1}:{})};
      const created=await request(path,'POST',data,token,randomUUID());
      assert.equal(created.status,201,`${channel} ${level}: ${JSON.stringify(created.data)}`);
      assert.equal(db.prepare('SELECT customer_skill FROM reservations WHERE id=?').get(created.data.id).customer_skill,level);
      const contract=await request(`/api/reservations/${created.data.id}/contracts`,'POST',{},token);
      assert.equal(contract.status,201,`${channel} ${level}: ${JSON.stringify(contract.data)}`);
      assert.equal(contract.data.snapshot.skill,level);
    }
  }
  const historic=await request('/api/reservations','POST',booking(330,'中级'),customer,randomUUID());
  assert.equal(historic.status,201);
  db.prepare('UPDATE reservations SET customer_skill=NULL WHERE id=?').run(historic.data.id);
  const contract=await request(`/api/reservations/${historic.data.id}/contracts`,'POST',{},customer);
  assert.equal(contract.status,201,JSON.stringify(contract.data));
  assert.equal(contract.data.snapshot.skill,'历史未登记');
  const hash=contract.data.snapshot_hash;
  assert.equal(db.prepare('SELECT customer_skill FROM reservations WHERE id=?').get(historic.data.id).customer_skill,null);
  const viewed=await request(`/api/reservations/${historic.data.id}`,'GET',undefined,customer);
  assert.equal(viewed.status,200);
  assert.equal(viewed.data.customer_skill,null);
  assert.equal(viewed.data.contracts[0].snapshot_hash,hash);
  assert.equal(viewed.data.contracts[0].snapshot.skill,'历史未登记');
});

test('a rejected idempotency key can be corrected, then replays only the same booking',async()=>{
  const key=randomUUID(),invalid=booking(335,'');
  const before=rows();
  assert.equal((await request('/api/reservations','POST',invalid,customer,key)).status,422);
  assert.deepEqual(rows(),before);
  const valid={...invalid,customerSkill:'初级'};
  const created=await request('/api/reservations','POST',valid,customer,key);
  assert.equal(created.status,201);
  const replay=await request('/api/reservations','POST',valid,customer,key);
  assert.equal(replay.status,200);
  assert.equal(replay.data.id,created.data.id);
  assert.equal((await request('/api/reservations','POST',{...valid,customerSkill:'高级'},customer,key)).status,409);
  assert.equal(rows().reservations,before.reservations+1);
});

test('restart releases the old unit; another order can pick it, stale version and failed repick preserve allocations',async()=>{
  const only=db.prepare("SELECT id FROM units WHERE store_id=1 AND variant_id=13 AND status='AVAILABLE' ORDER BY id LIMIT 1").get().id;
  db.prepare("UPDATE units SET status='MAINTENANCE' WHERE store_id=1 AND variant_id=13 AND id<>?").run(only);
  const first=await request('/api/reservations','POST',booking(240,'中级'),customer,randomUUID());
  const second=await request('/api/reservations','POST',booking(244,'中级'),customer,randomUUID());
  assert.equal(first.status,201);assert.equal(second.status,201);
  for(const id of [first.data.id,second.data.id]){
    await signBeforePay(request,id,customer);
    assert.equal((await request(`/api/reservations/${id}/pay`,'POST',{},customer)).status,200);
  }
  const path1=`/api/preparations/${first.data.id}`,path2=`/api/preparations/${second.data.id}`;
  let prep1=(await request(path1,'GET',undefined,staff)).data;
  prep1=(await request(path1,'PATCH',{action:'claim',version:prep1.version},staff)).data;
  const stale=prep1.version-1;
  assert.equal((await request(path1,'PATCH',{action:'pick',version:stale},staff)).status,409);
  prep1=(await request(path1,'PATCH',{action:'pick',version:prep1.version},staff)).data;
  assert.deepEqual(prep1.units.map(row=>row.unit_id),[only]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM preparation_units WHERE unit_id=? AND active=1').get(only).n,1);
  const foreignStaff=await login('staff2');
  const reliefEmail=`relief-${randomUUID()}@bsr.demo`;
  db.prepare("INSERT INTO users(name,email,password_hash,role,store_id,created_at) VALUES(?,?,?,'staff',1,?)")
    .run('Test Relief',reliefEmail,hashPassword('Demo123!'),new Date().toISOString());
  const reliefLogin=await request('/api/auth/login','POST',{email:reliefEmail,password:'Demo123!'});
  assert.equal(reliefLogin.status,200);
  const relief=reliefLogin.data.sessionToken;
  const unchanged=prepState(first.data.id);
  assert.equal((await request(path1,'PATCH',{action:'restart',version:prep1.version,note:'ab'},staff)).status,400);
  assert.deepEqual(prepState(first.data.id),unchanged,'short note must not change prepared unit or events');
  assert.equal((await request(path1,'PATCH',{action:'restart',version:prep1.version,note:'其他门店尝试重备'},foreignStaff)).status,404);
  assert.deepEqual(prepState(first.data.id),unchanged,'another store must not change preparation');
  assert.equal((await request(path1,'PATCH',{action:'restart',version:prep1.version,note:'未指派同事尝试重备'},relief)).status,403);
  assert.deepEqual(prepState(first.data.id),unchanged,'unassigned same-store worker must not change preparation');
  let prep2=(await request(path2,'GET',undefined,staff)).data;
  prep2=(await request(path2,'PATCH',{action:'claim',version:prep2.version},staff)).data;
  assert.equal((await request(path2,'PATCH',{action:'pick',version:prep2.version},staff)).status,409);
  assert.equal((await request(path2,'GET',undefined,staff)).data.version,prep2.version);
  assert.equal((await request(path1,'PATCH',{action:'restart',version:stale,note:'重新核对单件'},staff)).status,409);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM preparation_units WHERE reservation_id=? AND active=1').get(first.data.id).n,1);
  prep1=(await request(path1,'PATCH',{action:'restart',version:prep1.version,note:'重新核对单件'},staff)).data;
  assert.equal(prep1.status,'PICKING');
  assert.equal(prep1.units.length,0);
  assert.equal(prep1.version,unchanged.preparation.version+1);
  const restarted=prepState(first.data.id);
  assert.equal((await request(path1,'PATCH',{action:'restart',version:unchanged.preparation.version,note:'另一员工过期操作'},relief)).status,409);
  assert.equal((await request(path1,'PATCH',{action:'restart',version:unchanged.preparation.version,note:'经理过期操作'},await login('manager'))).status,409);
  assert.deepEqual(prepState(first.data.id),restarted,'concurrent stale operations must not change the winning state');
  const customerProgress=await request(path1,'GET',undefined,customer);
  assert.equal(customerProgress.status,200);
  assert.equal(customerProgress.data.status,'PICKING');
  assert.equal(customerProgress.data.public_note,'重新核对单件');
  assert.equal(customerProgress.data.handler_name,'Emma Berg');
  assert.equal(customerProgress.data.events.at(-1).actor_name,'Emma Berg');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM preparation_units WHERE unit_id=? AND active=1').get(only).n,0);
  prep2=(await request(path2,'PATCH',{action:'pick',version:prep2.version},staff)).data;
  assert.deepEqual(prep2.units.map(row=>row.unit_id),[only]);
  assert.equal((await request(path1,'PATCH',{action:'pick',version:prep1.version},staff)).status,409);
  assert.equal((await request(path1,'GET',undefined,staff)).data.version,prep1.version);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM preparation_units WHERE reservation_id=? AND active=1').get(second.data.id).n,1);
  // Simulate a concurrent inventory fault after allocation. A failed repick must roll back its release.
  db.prepare("UPDATE preparations SET status='BLOCKED' WHERE reservation_id=?").run(second.data.id);
  db.prepare("UPDATE units SET status='MAINTENANCE' WHERE id=?").run(only);
  const before=db.prepare('SELECT active FROM preparation_units WHERE reservation_id=? AND unit_id=?').get(second.data.id,only).active;
  const failed=await request(path2,'PATCH',{action:'pick',version:prep2.version},staff);
  assert.equal(failed.status,409);
  assert.equal(before,1);
  assert.equal(db.prepare('SELECT active FROM preparation_units WHERE reservation_id=? AND unit_id=?').get(second.data.id,only).active,1);
  assert.equal((await request(path2,'GET',undefined,staff)).data.version,prep2.version);
  const closed=prepState(second.data.id);
  db.prepare("UPDATE reservations SET status='ACTIVE' WHERE id=?").run(second.data.id);
  const activeSnapshot=prepState(second.data.id);
  assert.equal((await request(path2,'PATCH',{action:'restart',version:prep2.version,note:'已交付订单不能重备'},staff)).status,409);
  assert.deepEqual(prepState(second.data.id),activeSnapshot,'closed order must not change preparation');
  db.prepare("UPDATE reservations SET status='CANCELLED' WHERE id=?").run(second.data.id);
  const cancelledSnapshot=prepState(second.data.id);
  assert.equal((await request(path2,'PATCH',{action:'restart',version:prep2.version,note:'已取消订单不能重备'},staff)).status,409);
  assert.deepEqual(prepState(second.data.id),cancelledSnapshot,'cancelled order must not change preparation');
  db.prepare("UPDATE reservations SET status=? WHERE id=?").run(closed.order.status,second.data.id);
});

test.after(async()=>{
  await new Promise(resolve=>server.close(resolve));
  db.close();
  if(!resolve(temp).startsWith(root+sep))throw new Error('Refusing to remove non-temporary fixture');
  rmSync(temp,{recursive:true,force:true});
});
