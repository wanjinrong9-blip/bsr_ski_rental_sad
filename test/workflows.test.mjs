import {reservationHeaders} from './reservation-key.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {consent,approveCase} from './damage-helpers.mjs';
import {prepareAndSign,signBeforePay} from './fulfillment-helpers.mjs';
import {futureDate} from './future-date.mjs';

const temp = mkdtempSync(join(tmpdir(),'bsr-workflows-'));
process.env.NODE_ENV='test';
process.env.BSR_DB_PATH=join(temp,'test.sqlite');
const { server, db } = await import('../src/server.mjs');
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;

async function request(path,method='GET',data,cookie='') {
  if(path==='/api/reservations'&&method==='POST')data={...data,customerSkill:'中级',damageConsent:consent};
  const response=await fetch(base+path,{method,headers:{...reservationHeaders(path,method),...(cookie?{cookie}:{}),...(data?{'content-type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});
  return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]||''};
}
async function login(email){const result=await request('/api/auth/login','POST',{email,password:'Demo123!'});assert.equal(result.status,200);return result.cookie;}
const date=futureDate;

test('顾客预约、支付、核码交付、逐件归还与无异常自动退款',async()=>{
  const customer=await login('customer@bsr.demo');
  const staff=await login('staff@bsr.demo');
  const input={storeId:1,pickupAt:date(5),returnAt:date(6),items:[{variantId:1,qty:1}]};
  const q=await request('/api/quote','POST',input);
  assert.equal(q.status,200);
  assert.equal(q.data.currency,'NOK');
  assert.equal(q.data.totalNok,q.data.rentNok+q.data.depositNok);
  const created=await request('/api/reservations','POST',input,customer);
  assert.equal(created.status,201);
  const id=created.data.id;
  await signBeforePay(request,id,customer);
  const paid=await request(`/api/reservations/${id}/pay`,'POST',{},customer);
  assert.equal(paid.status,200);
  await prepareAndSign(request,id,staff,customer);
  const picked=await request('/api/operations/pickup','POST',{code:paid.data.pickupCode},staff);
  assert.equal(picked.status,200);
  assert.equal(picked.data.units.length,1);
  const returned=await request('/api/operations/return','POST',{reservationId:id,items:[{unitId:picked.data.units[0].unitId,condition:'GOOD',feeNok:0,note:'外观正常'}]},staff);
  assert.equal(returned.status,200);
  assert.equal(returned.data.refundStatus,'REFUNDED');
  const detail=await request(`/api/reservations/${id}`,'GET',undefined,customer);
  assert.equal(detail.data.status,'COMPLETED');
  assert.equal(detail.data.payments.filter(p=>p.type==='REFUND').length,1);
  const duplicate=await request('/api/operations/return','POST',{reservationId:id,items:[]},staff);
  assert.equal(duplicate.status,409);
});

test('损坏验收进入经理复核且押金退款幂等',async()=>{
  const customer=await login('customer@bsr.demo');
  const staff=await login('staff@bsr.demo');
  const manager=await login('manager@bsr.demo');
  const input={storeId:1,pickupAt:date(8),returnAt:date(9),items:[{variantId:5,qty:1}]};
  const created=await request('/api/reservations','POST',input,customer);
  assert.equal(created.status,201);
  const id=created.data.id;
  await signBeforePay(request,id,customer);
  const paid=await request(`/api/reservations/${id}/pay`,'POST',{},customer);
  await prepareAndSign(request,id,staff,customer);
  const picked=await request('/api/operations/pickup','POST',{code:paid.data.pickupCode},staff);
  assert.equal(picked.status,200);
  const returned=await request('/api/operations/return','POST',{reservationId:id,items:[{unitId:picked.data.units[0].unitId,condition:'DAMAGED',feeNok:0,note:'板面边缘有明显缺口'}]},staff);
  assert.equal(returned.data.status,'REVIEW');
  const unauthorized=await request(`/api/operations/refunds/${id}/approve`,'POST',{},staff);
  assert.equal(unauthorized.status,403);
  const caseId=(await request(`/api/reservations/${id}`,'GET',undefined,manager)).data.damage.cases[0].id;
  await approveCase(request,caseId,await login('contractor@bsr.demo'),manager,180);
  const approved=await request(`/api/operations/refunds/${id}/approve`,'POST',{},manager);
  assert.equal(approved.status,200);
  const duplicate=await request(`/api/operations/refunds/${id}/approve`,'POST',{},manager);
  assert.equal(duplicate.status,409);
  const detail=await request(`/api/reservations/${id}`,'GET',undefined,customer);
  assert.equal(detail.data.payments.filter(p=>p.type==='REFUND').length,1);
  assert.equal(detail.data.refund_nok,detail.data.deposit_nok-180);
});

test('按租期防超卖、版本化价目不回写历史订单',async()=>{
  const customer=await login('customer@bsr.demo');
  const manager=await login('manager@bsr.demo');
  const input={storeId:1,pickupAt:date(12),returnAt:date(13),items:[{variantId:3,qty:4}]};
  const created=await request('/api/reservations','POST',input,customer);
  assert.equal(created.status,201);
  const original=created.data.quote.lines[0].unitRentNok;
  const overbook=await request('/api/reservations','POST',{...input,items:[{variantId:3,qty:3}]},customer);
  assert.equal(overbook.status,409);
  const policy=await request('/api/policies','POST',{variantId:3,storeId:1,dailyNok:999,depositNok:1500,extraDayFactor:0.8,effectiveFrom:new Date().toISOString().slice(0,10)},manager);
  assert.equal(policy.status,201);
  const detail=await request(`/api/reservations/${created.data.id}`,'GET',undefined,customer);
  assert.equal(detail.data.lines[0].unit_rent_nok,original);
});

test('角色限制、故障隔离、调拨与接收',async()=>{
  const manager=await login('manager@bsr.demo');
  const staff=await login('staff@bsr.demo');
  const northStaff=await login('staff2@bsr.demo');
  const inventory=await request('/api/inventory','GET',undefined,manager);
  const unit=inventory.data.find(x=>x.status==='AVAILABLE'&&x.store_id===1);
  const dispatch=await request('/api/transfers','POST',{unitId:unit.id,toStoreId:2},manager);
  assert.equal(dispatch.status,201);
  const receive=await request(`/api/transfers/${dispatch.data.id}/receive`,'POST',{},northStaff);
  assert.equal(receive.status,200);
  const current=await request('/api/inventory','GET',undefined,northStaff);
  assert.equal(current.data.find(x=>x.id===unit.id).store_id,2);
  const fault=await request('/api/maintenance','POST',{unitId:unit.id,issue:'固定器无法锁紧'},northStaff);
  assert.equal(fault.status,201);
  const isolated=await request('/api/inventory','GET',undefined,northStaff);
  assert.equal(isolated.data.find(x=>x.id===unit.id).status,'MAINTENANCE');
});

test('所有非顾客角色打卡、去重与经理每日排班联动',async()=>{
  const customer=await login('customer@bsr.demo');
  assert.equal((await request('/api/attendance','POST',{kind:'IN'},customer)).status,403);
  for(const role of ['staff','manager','contractor','owner','admin']) {
    const session=await login(`${role}@bsr.demo`);
    assert.equal((await request('/api/attendance','POST',{kind:'OUT'},session)).status,409);
    const punched=await request('/api/attendance','POST',{kind:'IN'},session);assert.equal(punched.status,200);
    assert.equal(punched.data.timeZone,'Europe/Oslo');assert.ok(punched.data.profile.employee_no);
    assert.equal((await request('/api/attendance','POST',{kind:'IN'},session)).status,409);
    const roster=await request('/api/roster','GET',undefined,session);
    assert.equal(roster.data.rows.find(p=>p.id===punched.data.profile.id).status,'ON_DUTY');
    const done=await request('/api/attendance','POST',{kind:'OUT'},session);assert.equal(done.status,200);
    assert.ok(done.data.today.clock_out_at);assert.equal(done.data.records[0].minutes,0);
    assert.equal((await request('/api/attendance','POST',{kind:'OUT'},session)).status,409);
  }
  const staff=await login('staff@bsr.demo');const own=await request('/api/roster','GET',undefined,staff);
  assert.equal(own.data.rows.length,1);assert.equal(own.data.rows[0].role,'staff');
});

test('排班创建、编辑、冲突校验和已有打卡保护',async()=>{
  const manager=await login('manager@bsr.demo'),staff=await login('staff@bsr.demo');
  const input={userId:2,storeId:1,workDate:new Date(Date.now()+25*86400000).toISOString().slice(0,10),startTime:'09:00',endTime:'17:00'};
  const created=await request('/api/shifts','POST',input,manager);assert.equal(created.status,201);
  assert.equal((await request('/api/shifts','POST',input,manager)).status,409);
  assert.equal((await request(`/api/shifts/${created.data.id}`,'PATCH',{...input,startTime:'10:00'},manager)).status,200);
  const roster=await request(`/api/roster?date=${input.workDate}&storeId=1`,'GET',undefined,manager);
  assert.equal(roster.data.rows.find(r=>r.id===2).shift.start_time,'10:00');
  assert.equal((await request('/api/shifts','POST',{...input,workDate:'2026-02-31'},manager)).status,400);
  assert.equal((await request('/api/shifts','POST',input,staff)).status,403);
  const today=await request('/api/roster','GET',undefined,manager);const row=today.data.rows.find(p=>p.id===2);
  assert.equal((await request(`/api/shifts/${row.shift.id}`,'PATCH',{...input,userId:2,workDate:today.data.date},manager)).status,409);
});

test('维修必须完成安全检查和经理验收才恢复库存，版本冲突不会覆盖',async()=>{
  const staff=await login('staff@bsr.demo'),manager=await login('manager@bsr.demo'),tech=await login('contractor@bsr.demo');
  const units=(await request('/api/inventory','GET',undefined,manager)).data;
  const unit=units.find(u=>u.status==='AVAILABLE'&&u.variant_id===2&&u.store_id===1);
  const fault=await request('/api/maintenance','POST',{unitId:unit.id,issue:'板底划伤需修补与打蜡',priority:'HIGH'},staff);assert.equal(fault.status,201);
  assert.equal((await request('/api/maintenance','POST',{unitId:unit.id,issue:'重复登记故障'},staff)).status,409);
  const taskId=fault.data.id;
  const update=data=>request(`/api/maintenance/${taskId}`,'PATCH',data,tech);
  assert.equal((await update({version:1,status:'COMPLETED',result:'已修好'})).status,409);
  assert.equal((await update({version:1,status:'INSPECTING',diagnosis:'板底出现划伤'})).status,200);
  assert.equal((await update({version:1,status:'REPAIRING'})).status,409);
  assert.equal((await update({version:2,status:'AWAITING_REVIEW',result:'修补并打蜡',hours:1})).status,400);
  const submitted=await update({version:2,status:'AWAITING_REVIEW',diagnosis:'板底浅层划伤',result:'修补打蜡与功能检测完成',hours:1.5,costNok:75,parts:'修补蜡一份',checklist:{appearance:true,fasteners:true,function:true,cleaning:true}});
  assert.equal(submitted.status,200);
  const pending=(await request('/api/inventory','GET',undefined,staff)).data.find(u=>u.id===unit.id);assert.equal(pending.status,'MAINTENANCE');
  assert.equal((await update({version:3,action:'review',decision:'accept',note:'测试通过'})).status,403);
  const rejected=await request(`/api/maintenance/${taskId}`,'PATCH',{version:3,action:'review',decision:'reject',note:'需补充检查边刃'},manager);assert.equal(rejected.status,200);
  assert.equal((await update({version:4,status:'AWAITING_REVIEW',result:'补充边刃检查完成'})).status,200);
  const accepted=await request(`/api/maintenance/${taskId}`,'PATCH',{version:5,action:'review',decision:'accept',note:'实物检查与安全测试均通过'},manager);assert.equal(accepted.status,200);
  assert.equal((await request('/api/inventory','GET',undefined,staff)).data.find(u=>u.id===unit.id).status,'AVAILABLE');
  const history=(await request('/api/inventory/movements','GET',undefined,manager)).data.filter(e=>e.unit_id===unit.id);
  assert.ok(history.some(e=>e.to_status==='MAINTENANCE'));assert.ok(history.some(e=>e.to_status==='AVAILABLE'));
  const ticket=(await request('/api/maintenance','GET',undefined,tech)).data.find(t=>t.id===taskId);assert.ok(ticket.events.length>=6);assert.equal(ticket.cost_nok,75);
});

test('库存变更推送可被其他角色会话接收',async()=>{
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),5000);
  const stream=await fetch(base+'/api/events',{signal:controller.signal});const reader=stream.body.getReader();
  try {
    const initial=new TextDecoder().decode((await reader.read()).value);assert.match(initial,/event: connected/);
    const staff=await login('staff@bsr.demo'),manager=await login('manager@bsr.demo');
    const units=(await request('/api/inventory','GET',undefined,manager)).data;
    const unit=units.find(u=>u.status==='AVAILABLE'&&u.variant_id===10);
    assert.equal((await request('/api/maintenance','POST',{unitId:unit.id,issue:'雪杖握把开裂'},staff)).status,201);
    const update=new TextDecoder().decode((await reader.read()).value);assert.match(update,/event: change/);assert.match(update,/maintenance/);
  } finally {controller.abort();clearTimeout(timer);await reader.cancel().catch(()=>{});}
});

test.after(async()=>{
  await new Promise(resolve=>server.close(resolve));
  db.close();
  rmSync(temp,{recursive:true,force:true});
});
