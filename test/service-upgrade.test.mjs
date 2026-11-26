import {reservationHeaders} from './reservation-key.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {consent,testPhoto} from './damage-helpers.mjs';
import {upgradeCatalog} from '../src/catalog-upgrade.mjs';
import {checkDamageSLA} from '../src/order-workflow.mjs';
import {prepareAndSign,signBeforePay} from './fulfillment-helpers.mjs';
import {futureDate} from './future-date.mjs';

const temp=mkdtempSync(join(tmpdir(),'bsr-service-'));
process.env.NODE_ENV='test';process.env.BSR_DB_PATH=join(temp,'service.sqlite');
const {server,db}=await import('../src/server.mjs');await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`,tokens={};
async function request(path,method='GET',data,token=''){
 const res=await fetch(base+path,{method,headers:{...reservationHeaders(path,method),...(token?{'x-bsr-session':token}:{}),...(data?{'content-type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});
 return {status:res.status,data:await res.json()};
}
for(const role of ['customer','staff','manager','contractor','owner','admin'])tokens[role]=(await request('/api/auth/login','POST',{email:`${role}@bsr.demo`,password:'Demo123!'})).data.sessionToken;
const date=futureDate;

test('新增护具与滑雪镜、8%押金按件计且保留历史合同，迁移可重复运行',async()=>{
 const before=db.prepare('SELECT COUNT(*) AS n FROM units').get().n;upgradeCatalog(db);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM units').get().n,before);
 const items=(await request(`/api/catalog?storeId=1&pickupAt=${date(100)}&returnAt=${date(101)}`)).data.items;
 assert.equal(items.length,32);for(const name of ['护膝','护目镜','护腕','护背','滑雪服','滑雪裤'])assert.ok(items.some(i=>i.subtype===name),name);
 for(const i of items){assert.equal(i.depositNok,Math.round(i.retail_nok*.08));assert.equal(i.depositBasis,'RETAIL');}
 const knee=items.find(i=>i.subtype==='护膝');assert.equal(knee.depositNok,40);assert.equal(knee.skill,'不适用');
 const input={storeId:1,pickupAt:date(100),returnAt:date(102),customerSkill:'中级',items:[{variantId:knee.id,qty:2}]};
 const order=await request('/api/reservations','POST',{...input,damageConsent:consent},tokens.customer);assert.equal(order.status,201);assert.equal(order.data.quote.depositNok,80);assert.equal(order.data.quote.lines[0].referenceValueNok,500);assert.equal(order.data.quote.lines[0].depositRate,.08);
 const policy=await request('/api/policies','POST',{variantId:knee.id,storeId:1,dailyNok:99,depositNok:99999,extraDayFactor:.8,effectiveFrom:new Date().toISOString().slice(0,10)},tokens.manager);assert.equal(policy.status,201);
 const q=await request('/api/quote','POST',input);assert.equal(q.data.lines[0].unitDepositNok,40,'manual policy input cannot override 8% rule');
 const detail=(await request(`/api/reservations/${order.data.id}`,'GET',undefined,tokens.customer)).data;assert.equal(detail.quote.rentNok,order.data.quote.rentNok);assert.equal(detail.deposit_nok,80);
 assert.equal(db.prepare("SELECT deposit_nok FROM reservations WHERE code='BR-DEMO001'").get().deposit_nok,900,'old contract keeps original deposit');
});

test('具名进度、可操作门店复核及24小时首次反馈，退回后须重做复核',async()=>{
 const created=await request('/api/reservations','POST',{storeId:1,pickupAt:date(110),returnAt:date(111),customerSkill:'中级',items:[{variantId:7,qty:1}],damageConsent:consent},tokens.customer);assert.equal(created.status,201);const id=created.data.id;
 const detail=()=>request(`/api/reservations/${id}`,'GET',undefined,tokens.customer);
 assert.equal((await detail()).data.workflow.currentKey,'CONTRACT');
 await signBeforePay(request,id,tokens.customer);
 assert.equal((await detail()).data.workflow.currentKey,'PAYMENT');
 const paid=await request(`/api/reservations/${id}/pay`,'POST',{},tokens.customer);
 assert.equal((await detail()).data.workflow.handler.name,'Emma Berg');
 await prepareAndSign(request,id,tokens.staff,tokens.customer);
 const picked=await request('/api/operations/pickup','POST',{code:paid.data.pickupCode},tokens.staff);assert.equal(picked.status,200);
 await request('/api/operations/return','POST',{reservationId:id,items:picked.data.units.map(u=>({unitId:u.unitId,condition:'DAMAGED',note:'锁扣有异常，等待技师照片检验'}))},tokens.staff);
 let order=(await detail()).data;assert.equal(order.workflow.currentKey,'ASSESSMENT');assert.equal(order.workflow.handler.name,'Jonas Vik');assert.ok(order.workflow.steps.every(s=>s.handler?.name));
 const c=order.damage.cases[0],path=`/api/damage-cases/${c.id}`,review={checks:{identity:true,items:true,evidence:true},note:'核对实物归还、顾客合同和照片证据'};
 assert.ok(Math.abs(Date.parse(c.sla.dueAt)-Date.parse(c.created_at)-24*3600000)<1000);
 assert.equal((await request(`/api/reservations/${id}/staff-review`,'POST',review,tokens.staff)).status,409);
 let assessed=(await request(path+'/photos','POST',{version:c.version,part:'锁扣位置',caption:'自动化合成测试图',mime:'image/png',base64:testPhoto},tokens.contractor)).data;
 const assessment=version=>({version,action:'submit',grade:'MINOR',part:'锁扣位置',diagnosis:'测试：锁扣表面损伤，需修复',laborNok:100,partsNok:0,replacementNok:1000,valueBasis:'合成测试折旧估值依据'});
 assessed=(await request(path,'PATCH',assessment(assessed.version),tokens.contractor)).data;
 assert.ok(assessed.sla.firstFeedbackAt);const first=assessed.sla.firstFeedbackAt;
 assert.equal((await detail()).data.workflow.currentKey,'STAFF_REVIEW');
 for(const role of ['customer','contractor','owner','admin'])assert.equal((await request(`/api/reservations/${id}/staff-review`,'POST',review,tokens[role])).status,403);
 assert.equal((await request(`/api/reservations/${id}/staff-review`,'POST',{...review,checks:{identity:true}},tokens.staff)).status,400);
 review.reviewVersion=(await request(`/api/reservations/${id}`,'GET',undefined,tokens.staff)).data.staffReviewVersion;
 assert.equal((await request(`/api/reservations/${id}/staff-review`,'POST',review,tokens.staff)).status,200);
 order=(await detail()).data;assert.equal(order.staff_reviewed_by,2);assert.equal(order.workflow.currentKey,'MANAGER_REVIEW');assert.equal(order.workflow.handler.name,db.prepare("SELECT name FROM users WHERE role='manager' ORDER BY id LIMIT 1").get().name);
 assert.equal((await request(`/api/reservations/${id}/staff-review`,'POST',review,tokens.staff)).status,409);
 let returned=await request(path+'/review','POST',{version:assessed.version,decision:'reject',note:'请补充核验损伤范围'},tokens.manager);assert.equal(returned.status,200);
 assert.equal((await detail()).data.staff_reviewed_at,null);
 assessed=(await request(path,'PATCH',assessment(returned.data.version),tokens.contractor)).data;assert.equal(assessed.sla.firstFeedbackAt,first,'first feedback time is immutable');
 await request(path+'/review','POST',{version:assessed.version,decision:'approve',note:'照片和费用依据核定通过'},tokens.manager);
 assert.equal((await request(`/api/operations/refunds/${id}/approve`,'POST',{},tokens.manager)).status,409,'manager cannot skip renewed staff review');
 assert.equal((await request(`/api/reservations/${id}/staff-review`,'POST',review,tokens.staff)).status,409,'stale evidence version cannot be approved');
 review.reviewVersion=(await request(`/api/reservations/${id}`,'GET',undefined,tokens.staff)).data.staffReviewVersion;
 await request(`/api/reservations/${id}/staff-review`,'POST',review,tokens.staff);
 assert.equal((await request(`/api/operations/refunds/${id}/approve`,'POST',{},tokens.manager)).status,200);
 assert.equal((await detail()).data.workflow.currentKey,'DONE');
});

test('24H未反馈仅提醒一次，不伪造检验或自动收费',async()=>{
 const c=db.prepare("SELECT * FROM damage_cases WHERE first_feedback_at IS NULL ORDER BY id LIMIT 1").get();assert.ok(c);
 const before=db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='DAMAGE_SLA_OVERDUE' AND target_id=?").get(c.id).n;
 const future=Date.parse(c.feedback_due_at)+1000;assert.ok(checkDamageSLA(db,future)>=1);assert.equal(checkDamageSLA(db,future),0);
 const current=db.prepare('SELECT * FROM damage_cases WHERE id=?').get(c.id);assert.equal(current.first_feedback_at,null);assert.ok(current.overdue_notified_at);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='DAMAGE_SLA_OVERDUE' AND target_id=?").get(c.id).n,before+1);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM damage_settlements WHERE reservation_id=?').get(c.reservation_id).n,0);
});

test('班次限制08–22点，维修工时按15分钟记录',async()=>{
 const shift={userId:2,storeId:1,workDate:date(80).slice(0,10),startTime:'07:59',endTime:'16:00'};
 assert.equal((await request('/api/shifts','POST',shift,tokens.manager)).status,400);
 assert.equal((await request('/api/shifts','POST',{...shift,startTime:'08:00',endTime:'22:01'},tokens.manager)).status,400);
 assert.equal((await request('/api/shifts','POST',{...shift,startTime:'08:00',endTime:'22:00'},tokens.manager)).status,201);
 const unit=db.prepare("SELECT id FROM units WHERE variant_id=13 AND status='AVAILABLE' LIMIT 1").get();
 const fault=await request('/api/maintenance','POST',{unitId:unit.id,issue:'测试镜片连接处异常'},tokens.staff);assert.equal(fault.status,201);
 const path=`/api/maintenance/${fault.data.id}`;
 assert.equal((await request(path,'PATCH',{version:1,status:'INSPECTING',hours:.1},tokens.contractor)).status,400);
 assert.equal((await request(path,'PATCH',{version:1,status:'INSPECTING',hours:.25},tokens.contractor)).status,200);
});

test.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));db.close();rmSync(temp,{recursive:true,force:true});});
