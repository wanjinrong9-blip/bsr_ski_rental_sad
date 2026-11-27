import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {reservationHeaders} from './reservation-key.mjs';
import {consent,approveCase} from './damage-helpers.mjs';
import {prepareAndSign,signBeforePay} from './fulfillment-helpers.mjs';
import {futureDate} from './future-date.mjs';

const temp=mkdtempSync(join(tmpdir(),'bsr-dispute-followup-023-'));
process.env.NODE_ENV='test';
process.env.BSR_DB_PATH=join(temp,'disputes.sqlite');
const {server,db}=await import('../src/server.mjs');
const {approveRefund}=await import('../src/domain.mjs');
const {submitCustomerDamageDispute}=await import('../src/damage.mjs');
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;

async function request(path,method='GET',data,token=''){
  const res=await fetch(base+path,{method,headers:{...reservationHeaders(path,method),
    ...(token?{'x-bsr-session':token}:{}),...(data?{'content-type':'application/json'}:{})},
    body:data?JSON.stringify(data):undefined});
  return {status:res.status,data:await res.json()};
}
const accounts={};
async function session(role){
  if(!accounts[role]){
    const login=await request('/api/auth/login','POST',{
      email:`${role}@bsr.demo`,password:'Demo123!'});
    assert.equal(login.status,200,JSON.stringify(login.data));
    accounts[role]=login.data.sessionToken;
  }
  return accounts[role];
}

let day=300;
async function reviewedDamage(fee){
  const customer=await session('customer'),staff=await session('staff');
  const manager=await session('manager'),tech=await session('contractor');
  day+=3;
  const created=await request('/api/reservations','POST',{storeId:1,
    pickupAt:futureDate(day),returnAt:futureDate(day+1),customerSkill:'中级',
    items:[{variantId:7,qty:1}],damageConsent:consent},customer);
  assert.equal(created.status,201,JSON.stringify(created.data));
  const id=created.data.id;
  await signBeforePay(request,id,customer);
  const pay=await request(`/api/reservations/${id}/pay`,'POST',{},customer);
  assert.equal(pay.status,200,JSON.stringify(pay.data));
  await prepareAndSign(request,id,staff,customer);
  const picked=await request('/api/operations/pickup','POST',{code:pay.data.pickupCode},staff);
  assert.equal(picked.status,200,JSON.stringify(picked.data));
  const returned=await request('/api/operations/return','POST',{reservationId:id,
    items:picked.data.units.map(unit=>({unitId:unit.unitId,condition:'DAMAGED',
      feeNok:0,note:'测试：归还发现疑似损伤，提交技师鉴定'}))},staff);
  assert.equal(returned.status,200,JSON.stringify(returned.data));
  assert.equal(returned.data.status,'REVIEW');
  const order=(await request(`/api/reservations/${id}`,'GET',undefined,manager)).data;
  await approveCase(request,order.damage.cases[0].id,tech,manager,fee);
  return {id,customer,staff,manager,order};
}

async function contact(order,outcome,note=`测试：${outcome}，保留照片与费用沟通记录`){
  return request(`/api/reservations/${order.id}/damage/contact`,'POST',{
    channel:'PHONE',outcome,note},order.staff);
}

// Rejected money operations must leave all persisted business facts unchanged.
function snapshot(id){
  return {
    order:db.prepare('SELECT * FROM reservations WHERE id=?').get(id),
    inspections:db.prepare('SELECT * FROM inspections WHERE reservation_id=? ORDER BY id').all(id),
    settlements:db.prepare('SELECT * FROM damage_settlements WHERE reservation_id=?').all(id),
    payments:db.prepare('SELECT * FROM payments WHERE reservation_id=? ORDER BY id').all(id),
    receipts:db.prepare('SELECT * FROM damage_receipts WHERE reservation_id=? ORDER BY id').all(id),
    contacts:db.prepare('SELECT * FROM damage_contacts WHERE reservation_id=? ORDER BY id').all(id),
    audit:db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n,
    notifications:db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n
  };
}

test('异议后未接通仍阻止HTTP及domain核价，拒绝不写订单、账务或通知，确认后可退款',async()=>{
  const order=await reviewedDamage(80);
  assert.equal((await contact(order,'DISPUTED')).status,200);
  assert.equal((await contact(order,'NO_ANSWER')).status,200);
  const before=snapshot(order.id);
  const rejected=await request(`/api/operations/refunds/${order.id}/approve`,'POST',{},order.manager);
  assert.equal(rejected.status,409,JSON.stringify(rejected.data));
  assert.match(rejected.data.error,/异议/);
  assert.deepEqual(snapshot(order.id),before);
  const managerId=db.prepare("SELECT id FROM users WHERE email='manager@bsr.demo'").get().id;
  assert.throws(()=>approveRefund(db,managerId,order.id),error=>error.status===409&&/异议/.test(error.message));
  assert.deepEqual(snapshot(order.id),before);

  const blank=await contact(order,'REACHED','   ');
  assert.equal(blank.status,400);
  assert.deepEqual(snapshot(order.id),before,'空白确认不能解除异议或保存联系记录');
  const confirmed=await contact(order,'REACHED','已再次联系顾客并说明照片与费用，确认本次沟通结果');
  assert.equal(confirmed.status,200);
  const settled=await request(`/api/operations/refunds/${order.id}/approve`,'POST',{},order.manager);
  assert.equal(settled.status,200,JSON.stringify(settled.data));
  assert.equal(settled.data.status,'COMPLETED');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payments WHERE reservation_id=? AND type=\'REFUND\'').get(order.id).n,1);
});

test('既有补差结算的异议不被未接通清除，明确确认后恢复补差与原凭证幂等',async()=>{
  const order=await reviewedDamage(650);
  const approved=await request(`/api/operations/refunds/${order.id}/approve`,'POST',{},order.manager);
  assert.equal(approved.status,200,JSON.stringify(approved.data));
  assert.equal(approved.data.status,'SETTLEMENT');
  const due=approved.data.supplementNok;
  let response=await contact(order,'REACHED');
  assert.equal(response.status,200);
  const firstReceipt={version:response.data.settlement.version,amountNok:1,
    reference:'TEST-023-FIRST',confirmed:true};
  response=await request(`/api/reservations/${order.id}/damage/supplement`,'POST',firstReceipt,order.staff);
  assert.equal(response.status,200,JSON.stringify(response.data));

  assert.equal((await contact(order,'DISPUTED')).status,200);
  for(let i=0;i<2;i++){
    response=await contact(order,'NO_ANSWER');
    assert.equal(response.status,200);
    assert.equal(response.data.settlement.status,'DISPUTED');
  }
  let before=snapshot(order.id);
  const duplicate=await request(`/api/reservations/${order.id}/damage/supplement`,'POST',firstReceipt,order.staff);
  assert.equal(duplicate.status,200,JSON.stringify(duplicate.data));
  assert.equal(duplicate.data.duplicate,true);
  assert.deepEqual(snapshot(order.id),before,'已登记凭证的重试不新增款项或清除异议');
  const remaining={version:response.data.settlement.version,amountNok:due-1,
    reference:'TEST-023-REMAINING',confirmed:true};
  const blocked=await request(`/api/reservations/${order.id}/damage/supplement`,'POST',remaining,order.staff);
  assert.equal(blocked.status,409,JSON.stringify(blocked.data));
  assert.deepEqual(snapshot(order.id),before);
  assert.equal(before.order.status,'SETTLEMENT');
  assert.equal(before.settlements[0].paid_nok,1);

  const confirmed=await contact(order,'REACHED','已核对异议所涉照片与费用，顾客确认沟通处理结果');
  assert.equal(confirmed.status,200);
  assert.equal(confirmed.data.settlement.status,'CONTACTED');
  const paid=await request(`/api/reservations/${order.id}/damage/supplement`,'POST',{
    ...remaining,version:confirmed.data.settlement.version},order.staff);
  assert.equal(paid.status,200,JSON.stringify(paid.data));
  assert.equal(paid.data.damage.settlement.status,'SETTLED');
  assert.equal(db.prepare('SELECT status FROM reservations WHERE id=?').get(order.id).status,'COMPLETED');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM damage_receipts WHERE reservation_id=?').get(order.id).n,2);
});

test('本人受损异议按提交标识幂等，阻止核价且不重开已完成订单',async()=>{
  const order=await reviewedDamage(80);
  const customer=db.prepare("SELECT * FROM users WHERE email='customer@bsr.demo'").get();
  const input={requestKey:'TEST-023-CUSTOMER-REVIEW',note:'本人对受损照片与费用依据有异议，请门店再次核对'};
  const before=snapshot(order.id);
  const submitted=submitCustomerDamageDispute(db,customer,order.id,input);
  assert.equal(submitted.ok,true);
  assert.equal(submitted.duplicate,false);
  assert.equal(submitted.damage.disputeActive,true);
  assert.equal(submitted.damage.settlement,null);
  const after=snapshot(order.id);
  assert.deepEqual(after.order,before.order);
  assert.deepEqual(after.inspections,before.inspections);
  assert.deepEqual(after.payments,before.payments);
  assert.deepEqual(after.settlements,before.settlements);
  assert.deepEqual(after.receipts,before.receipts);
  assert.equal(after.contacts.length,before.contacts.length+1);
  assert.equal(after.contacts.at(-1).actor_id,customer.id);
  assert.equal(after.contacts.at(-1).channel,'CUSTOMER_PORTAL');
  assert.equal(after.contacts.at(-1).outcome,'DISPUTED');
  const auditEntry=db.prepare("SELECT * FROM audit_log WHERE action='CUSTOMER_DAMAGE_DISPUTED' AND actor_id=? AND target_id=? ORDER BY id DESC LIMIT 1").get(customer.id,order.id);
  assert.deepEqual(JSON.parse(auditEntry.detail_json),input);
  const expectedRecipients=[customer.id,...db.prepare("SELECT id FROM users WHERE store_id=? AND role IN ('staff','manager')").all(order.order.store_id).map(row=>row.id)].sort((a,b)=>a-b);
  const notified=db.prepare("SELECT user_id FROM notifications WHERE title IN ('顾客本人提出结算异议','本人结算异议已记录') AND body LIKE ? ORDER BY user_id").all(`订单 ${order.order.code}：%`).map(row=>row.user_id);
  assert.deepEqual(notified,expectedRecipients);

  const duplicate=submitCustomerDamageDispute(db,customer,order.id,input);
  assert.equal(duplicate.duplicate,true);
  assert.deepEqual(snapshot(order.id),after);
  assert.throws(()=>submitCustomerDamageDispute(db,customer,order.id,{...input,note:'更换异议内容不能复用原来的提交标识'}),error=>error.status===409);
  assert.deepEqual(snapshot(order.id),after);
  const rejected=await request(`/api/operations/refunds/${order.id}/approve`,'POST',{},order.manager);
  assert.equal(rejected.status,409,JSON.stringify(rejected.data));
  assert.deepEqual(snapshot(order.id),after);
  const projected=await request(`/api/reservations/${order.id}/damage`,'GET',undefined,order.customer);
  assert.equal(projected.data.disputeActive,true);

  assert.equal((await contact(order,'NO_ANSWER')).status,200);
  const stillBlocked=await request(`/api/operations/refunds/${order.id}/approve`,'POST',{},order.manager);
  assert.equal(stillBlocked.status,409);
  assert.equal((await contact(order,'REACHED','已核对本人提出的异议，记录沟通确认结果与费用说明')).status,200);
  const settled=await request(`/api/operations/refunds/${order.id}/approve`,'POST',{},order.manager);
  assert.equal(settled.status,200,JSON.stringify(settled.data));
  assert.equal(settled.data.status,'COMPLETED');
  const completed=snapshot(order.id);
  assert.equal(submitCustomerDamageDispute(db,customer,order.id,input).duplicate,true);
  assert.deepEqual(snapshot(order.id),completed,'完成后的旧请求重试只返回既有记录');
  assert.throws(()=>submitCustomerDamageDispute(db,customer,order.id,{...input,requestKey:'TEST-023-CLOSED-NEW'}),error=>error.status===409);
  assert.deepEqual(snapshot(order.id),completed,'已完成订单的新异议不能重开账务');
});

test('本人异议拒绝他人、非顾客、非法状态与非法输入且不留下副作用',async()=>{
  const order=await reviewedDamage(80);
  const customer=db.prepare("SELECT * FROM users WHERE email='customer@bsr.demo'").get();
  const staff=db.prepare("SELECT * FROM users WHERE email='staff@bsr.demo'").get();
  const registered=await request('/api/auth/register','POST',{name:'异议权限测试顾客',
    email:'dispute-other-023@bsr.demo',password:'Test12345!'});
  assert.equal(registered.status,201,JSON.stringify(registered.data));
  const other=db.prepare("SELECT * FROM users WHERE email='dispute-other-023@bsr.demo'").get();
  const input={requestKey:'TEST-023-ACCESS-REVIEW',note:'本人需要核对本次损坏费用与鉴定依据'};
  const before=snapshot(order.id);
  for(const [user,id,status] of [[null,order.id,403],[staff,order.id,403],
    [other,order.id,404],[customer,99999999,404]]){
    assert.throws(()=>submitCustomerDamageDispute(db,user,id,input),error=>error.status===status);
    assert.deepEqual(snapshot(order.id),before);
  }
  for(const invalid of [{...input,note:'   '},{...input,note:'不足五'},
    {...input,note:'超'.repeat(2001)},{...input,requestKey:undefined},
    {...input,requestKey:'short'},{...input,requestKey:'bad key with spaces'},
    {...input,requestKey:'a'.repeat(101)}]){
    assert.throws(()=>submitCustomerDamageDispute(db,customer,order.id,invalid),error=>error.status===400);
    assert.deepEqual(snapshot(order.id),before);
  }
  day+=3;
  const held=await request('/api/reservations','POST',{storeId:1,
    pickupAt:futureDate(day),returnAt:futureDate(day+1),customerSkill:'中级',
    items:[{variantId:7,qty:1}],damageConsent:consent},order.customer);
  assert.equal(held.status,201,JSON.stringify(held.data));
  const pending=snapshot(held.data.id);
  assert.throws(()=>submitCustomerDamageDispute(db,customer,held.data.id,input),error=>error.status===409);
  assert.deepEqual(snapshot(held.data.id),pending);
});

test('本人可暂停已有补差结算，未接通不解除异议，明确确认后恢复补差',async()=>{
  const order=await reviewedDamage(650);
  const customer=db.prepare("SELECT * FROM users WHERE email='customer@bsr.demo'").get();
  const approved=await request(`/api/operations/refunds/${order.id}/approve`,'POST',{},order.manager);
  assert.equal(approved.status,200,JSON.stringify(approved.data));
  assert.equal(approved.data.status,'SETTLEMENT');
  const before=snapshot(order.id);
  const input={requestKey:'12345678-1234-4234-8234-123456789012',note:'本人对补差账单有异议，请核实照片部位及费用依据'};
  const submitted=submitCustomerDamageDispute(db,customer,order.id,input);
  assert.equal(submitted.damage.disputeActive,true);
  assert.equal(submitted.damage.settlement.status,'DISPUTED');
  assert.equal(submitted.damage.settlement.version,before.settlements[0].version+1);
  assert.deepEqual(snapshot(order.id).payments,before.payments);
  assert.deepEqual(snapshot(order.id).order,before.order);
  const after=snapshot(order.id);
  assert.equal(submitCustomerDamageDispute(db,customer,order.id,input).duplicate,true);
  assert.deepEqual(snapshot(order.id),after);
  let contacted=await contact(order,'NO_ANSWER');
  assert.equal(contacted.status,200);
  assert.equal(contacted.data.disputeActive,true);
  assert.equal(contacted.data.settlement.status,'DISPUTED');
  const receipt={version:contacted.data.settlement.version,amountNok:approved.data.supplementNok,
    reference:'TEST-023-CUSTOMER-SUPPLEMENT',confirmed:true};
  const awaiting=snapshot(order.id);
  const blocked=await request(`/api/reservations/${order.id}/damage/supplement`,'POST',receipt,order.staff);
  assert.equal(blocked.status,409,JSON.stringify(blocked.data));
  assert.deepEqual(snapshot(order.id),awaiting);
  contacted=await contact(order,'REACHED','已联系顾客并就本人提出的异议核对证据与费用，记录确认结果');
  assert.equal(contacted.status,200);
  assert.equal(contacted.data.disputeActive,false);
  const paid=await request(`/api/reservations/${order.id}/damage/supplement`,'POST',{
    ...receipt,version:contacted.data.settlement.version},order.staff);
  assert.equal(paid.status,200,JSON.stringify(paid.data));
  assert.equal(paid.data.damage.settlement.status,'SETTLED');
  assert.equal(db.prepare('SELECT status FROM reservations WHERE id=?').get(order.id).status,'COMPLETED');
});

test.after(async()=>{
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
  db.close();
  rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100});
});
