import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDb} from '../src/db.mjs';
import {createReservation,returnRental} from '../src/domain.mjs';
import {saveShift} from '../src/workforce.mjs';
import {orderWorkflow} from '../src/order-workflow.mjs';
import {consent} from './damage-helpers.mjs';
import {futureDate} from './future-date.mjs';

const temp=mkdtempSync(join(tmpdir(),'bsr-extra-store-'));
const db=openDb(join(temp,'guards.sqlite'));
test.after(()=>{db.close();rmSync(temp,{recursive:true,force:true});});

const profile={name:'林雪',phone:'+47 9000 0001',address:'Skardalen 18, Norway',birthYear:1999,heightCm:168,weightKg:60,shoeSize:'38'};
const orderInput={storeId:2,pickupAt:futureDate(60),returnAt:futureDate(61),customerSkill:'初级',items:[{variantId:9,qty:1}],damageConsent:consent,customerProfile:profile};

test('新订单只分配原门店员工，没有本店员工时不回退到外店经理',()=>{
  db.prepare('UPDATE users SET store_id=1 WHERE id=7').run();
  const created=createReservation(db,1,orderInput,null,'store-guard-assign-none-001');
  const unassigned=db.prepare('SELECT store_id,assigned_staff_id FROM reservations WHERE id=?').get(created.id);
  assert.equal(unassigned.store_id,2);
  assert.equal(unassigned.assigned_staff_id,null);
  db.prepare('UPDATE users SET store_id=2 WHERE id=7').run();
  const second=createReservation(db,1,orderInput,null,'store-guard-assign-local-002');
  assert.equal(db.prepare('SELECT assigned_staff_id FROM reservations WHERE id=?').get(second.id).assigned_staff_id,7);
});

test('异店接收产生补差，只通知原订单门店员工',()=>{
  const order=db.prepare("SELECT id,code FROM reservations WHERE code='BR-DEMO002'").get();
  const unit=db.prepare('SELECT ru.unit_id FROM rental_units ru JOIN reservation_items ri ON ri.id=ru.reservation_item_id WHERE ri.reservation_id=? AND ru.returned=0').get(order.id);
  assert.ok(unit);
  const due=new Date(Date.now()-3*3600000).toISOString();
  db.prepare('UPDATE reservations SET return_at=?,deposit_nok=0,late_policy_version=?,late_hourly_percent=10,late_grace_minutes=0 WHERE id=?').run(due,'STORE-GUARD-TEST',order.id);
  db.prepare('UPDATE reservation_items SET rental_to=? WHERE reservation_id=?').run(due,order.id);
  const count=id=>db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND title='请联系顾客补差'").get(id).n;
  const before=[count(2),count(3),count(7)];
  const result=returnRental(db,7,order.id,[{unitId:unit.unit_id,condition:'GOOD',note:'异店完整归还验收'}],2);
  assert.ok(result.supplementNok>0);
  assert.deepEqual([count(2)-before[0],count(3)-before[1],count(7)-before[2]],[1,1,0]);
});

test('经理不能新建或编辑其他门店排班，也不能把外店员工排到本店',()=>{
  const manager=db.prepare('SELECT * FROM users WHERE id=3').get();
  const date=futureDate(11).slice(0,10);
  const input={userId:7,storeId:2,workDate:date,startTime:'09:00',endTime:'17:00'};
  const denied=error=>error?.status===403;
  assert.throws(()=>saveShift(db,manager,input),denied);
  const otherShift=db.prepare('SELECT id,store_id,user_id FROM shifts WHERE store_id=2 ORDER BY id LIMIT 1').get();
  assert.ok(otherShift);
  assert.throws(()=>saveShift(db,manager,{...input,userId:2,storeId:1},otherShift.id),denied);
  assert.equal(db.prepare('SELECT store_id FROM shifts WHERE id=?').get(otherShift.id).store_id,2);
  assert.throws(()=>saveShift(db,manager,{...input,storeId:1}),denied);
});

test('技师的鉴定流程不暴露顾客本人付款姓名',()=>{
  const order=db.prepare("SELECT * FROM reservations WHERE code='BR-DEMO003'").get();
  const customer=db.prepare('SELECT name FROM users WHERE id=?').get(order.user_id);
  db.prepare("INSERT INTO audit_log(actor_id,action,target_type,target_id,detail_json,created_at) VALUES(?,'PAYMENT_DEMO_SUCCEEDED','reservation',?,'{}',?)")
    .run(order.user_id,order.id,new Date().toISOString());
  const contractor=db.prepare('SELECT * FROM users WHERE id=4').get();
  const workflow=orderWorkflow(db,contractor,order);
  assert.equal(workflow.steps.find(step=>step.key==='PAYMENT').actor.name,'顾客（隐去个人信息）');
  assert.equal(JSON.stringify(workflow).includes(customer.name),false);
});
