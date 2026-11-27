import {reservationHeaders} from './reservation-key.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {consent} from './damage-helpers.mjs';
import {orderWorkflow} from '../src/order-workflow.mjs';

const temp=mkdtempSync(join(tmpdir(),'bsr-signpay-'));
process.env.NODE_ENV='test';
process.env.BSR_DB_PATH=join(temp,'test.sqlite');
const {server,db}=await import('../src/server.mjs');
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const date=(days,hour=11)=>new Date(Date.now()+days*86400000).toISOString().slice(0,10)+`T${String(hour).padStart(2,'0')}:00:00Z`;
async function request(path,method='GET',data,cookie=''){
 if(path==='/api/reservations'&&method==='POST')data={...data,damageConsent:consent};
 const res=await fetch(base+path,{method,headers:{...reservationHeaders(path,method),...(cookie?{cookie}:{}),...(data?{'content-type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});
 return {status:res.status,data:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]||''};
}
async function login(email,password='Demo123!'){const r=await request('/api/auth/login','POST',{email,password});assert.equal(r.status,200);return r.cookie;}
async function create(customer,storeId=1){const r=await request('/api/reservations','POST',{storeId,pickupAt:date(8),returnAt:date(9,13),items:[{variantId:storeId===1?1:5,qty:1}],customerSkill:'中级'},customer);assert.equal(r.status,201,JSON.stringify(r.data));return r.data.id;}

test('顾客本人先签当前合同，才可登记一组演示付款',async()=>{
 const customer=await login('customer@bsr.demo'),id=await create(customer);
 let r=await request(`/api/reservations/${id}/pay`,'POST',{},customer);assert.equal(r.status,409);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM payments WHERE reservation_id=?').get(id).n,0);
 const contract=await request(`/api/reservations/${id}/contracts`,'POST',{},customer);assert.equal(contract.status,201,JSON.stringify(contract.data));
 assert.equal(contract.data.snapshot.channel,'ONLINE_SELF_SERVICE');
 assert.equal(contract.data.created_by,1,'合同实际发起人是顾客');
 assert.equal(db.prepare('SELECT created_by FROM reservations WHERE id=?').get(id).created_by,null,'自助合同不能伪计员工开单');
 r=await request(`/api/reservations/${id}/pay`,'POST',{},customer);assert.equal(r.status,409);
 const signed=await request(`/api/contracts/${contract.data.id}/sign`,'POST',{name:'测试顾客',accepted:true,snapshotHash:contract.data.snapshot_hash},customer);assert.equal(signed.status,200,JSON.stringify(signed.data));
 const ownOrder=(await request(`/api/reservations/${id}`,'GET',undefined,customer)).data;
 const signedStep=ownOrder.workflow.steps.find(step=>step.key==='CONTRACT');
 assert.equal(signedStep.handler.id,1);assert.equal(signedStep.at,signed.data.signed_at);
 assert.match(signedStep.label,/顾客本人/);
 const techFlow=orderWorkflow(db,{role:'contractor'},db.prepare('SELECT * FROM reservations WHERE id=?').get(id));
 const techContract=techFlow.steps.find(step=>step.key==='CONTRACT');
 assert.match(techContract.handler.name,/隐去个人信息/);assert.equal(techContract.handler.id,undefined);
 const paid=await request(`/api/reservations/${id}/pay`,'POST',{},customer);assert.equal(paid.status,200,JSON.stringify(paid.data));assert.equal(paid.data.status,'CONFIRMED');
 assert.equal(db.prepare('SELECT COUNT(*) n FROM payments WHERE reservation_id=?').get(id).n,2);
 assert.equal(db.prepare('SELECT status FROM preparations WHERE reservation_id=?').get(id).status,'QUEUED');
 r=await request(`/api/reservations/${id}/pay`,'POST',{},customer);assert.equal(r.status,409);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM payments WHERE reservation_id=?').get(id).n,2);
});

test('跨账号、过期暂留不能绕过合同与付款门槛',async()=>{
 const customer=await login('customer@bsr.demo');
 const second=await request('/api/auth/register','POST',{name:'第二顾客',email:'other-signpay@example.test',password:'Other123!'});assert.equal(second.status,201);
 const other=await login('other-signpay@example.test','Other123!'),id=await create(customer,2);
  assert.equal((await request(`/api/reservations/${id}/contracts`,'POST',{},other)).status,404);
 const c=(await request(`/api/reservations/${id}/contracts`,'POST',{},customer)).data;assert.ok(c.id);
  assert.equal((await request(`/api/contracts/${c.id}/sign`,'POST',{name:'其他顾客',accepted:true,snapshotHash:c.snapshot_hash},other)).status,404);
 db.prepare('UPDATE reservations SET hold_expires_at=? WHERE id=?').run(date(-1),id);
 assert.equal((await request(`/api/contracts/${c.id}/sign`,'POST',{name:'测试顾客',accepted:true,snapshotHash:c.snapshot_hash},customer)).status,409);
 assert.equal((await request(`/api/reservations/${id}/pay`,'POST',{},customer)).status,409);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM payments WHERE reservation_id=?').get(id).n,0);
});

test('无门店经办人、历史已付订单与并发重复提交保持可核对',async()=>{
 const customer=await login('customer@bsr.demo');
 const noHandler=await create(customer);
 db.prepare('UPDATE reservations SET assigned_staff_id=NULL WHERE id=?').run(noHandler);
 assert.equal((await request(`/api/reservations/${noHandler}/contracts`,'POST',{},customer)).status,409);
 assert.equal((await request(`/api/reservations/${noHandler}/pay`,'POST',{},customer)).status,409);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM payments WHERE reservation_id=?').get(noHandler).n,0);

 const legacy=db.prepare("SELECT id,rent_nok,deposit_nok,total_nok,contract_version FROM reservations WHERE code='BR-DEMO001'").get();
 const oldContract=db.prepare('SELECT snapshot_hash,snapshot_json FROM contracts WHERE reservation_id=? ORDER BY version DESC LIMIT 1').get(legacy.id);
 const oldPayments=db.prepare('SELECT COUNT(*) n FROM payments WHERE reservation_id=?').get(legacy.id).n;
 const id=await create(customer),contract=(await request(`/api/reservations/${id}/contracts`,'POST',{},customer)).data;
 assert.equal((await request(`/api/contracts/${contract.id}/sign`,'POST',{name:'测试顾客',accepted:true,snapshotHash:contract.snapshot_hash},customer)).status,200);
 const results=await Promise.all([request(`/api/reservations/${id}/pay`,'POST',{},customer),request(`/api/reservations/${id}/pay`,'POST',{},customer)]);
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM payments WHERE reservation_id=?').get(id).n,2);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM preparations WHERE reservation_id=?').get(id).n,1);
 assert.deepEqual(db.prepare('SELECT id,rent_nok,deposit_nok,total_nok,contract_version FROM reservations WHERE id=?').get(legacy.id),legacy);
 assert.deepEqual(db.prepare('SELECT snapshot_hash,snapshot_json FROM contracts WHERE reservation_id=? ORDER BY version DESC LIMIT 1').get(legacy.id),oldContract);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM payments WHERE reservation_id=?').get(legacy.id).n,oldPayments);
});

test('现场纸质见证先于付款，员工开单与自助发起分别归属',async()=>{
 const staff=await login('staff@bsr.demo'),manager=await login('manager@bsr.demo');
 const customer=await request('/api/customers','POST',{name:'现场签付顾客',email:'counter-signpay@example.test',phone:'+47 9000 9111',address:'测试地址，非真实个人资料',birthYear:1998,heightCm:170,weightKg:65,shoeSize:'EU 40',password:'Test12345!'},staff);
 assert.equal(customer.status,201,JSON.stringify(customer.data));
 const created=await request('/api/operations/reservations','POST',{customerId:customer.data.id,storeId:1,pickupAt:date(15),returnAt:date(16),customerSkill:'中级',items:[{variantId:13,qty:1}],damageConsent:consent},staff);
 assert.equal(created.status,201,JSON.stringify(created.data));const id=created.data.id;
 const payment={reference:'DEMO-COUNTER-008',confirmed:true};
 assert.equal((await request(`/api/operations/reservations/${id}/pay`,'POST',payment,staff)).status,409);
 const c=(await request(`/api/reservations/${id}/contracts`,'POST',{},staff)).data;
 assert.equal(c.created_by,2);assert.equal(c.snapshot.channel,'COUNTER_MANUAL');assert.equal(c.snapshot.employee.id,2);
 assert.equal((await request(`/api/operations/reservations/${id}/pay`,'POST',payment,staff)).status,409);
 const signed=await request(`/api/contracts/${c.id}/sign`,'POST',{name:'现场签付顾客',accepted:true,snapshotHash:c.snapshot_hash,paperSigned:true,note:'自动化演示：已见证纸质签署并归档'},staff);
 assert.equal(signed.status,200,JSON.stringify(signed.data));
 const signedOrder=(await request(`/api/reservations/${id}`,'GET',undefined,staff)).data;
 const signedStep=signedOrder.workflow.steps.find(step=>step.key==='CONTRACT');
 assert.equal(signedStep.handler.id,signed.data.signed_by);
 assert.equal(signedStep.handler.id,2);assert.match(signedStep.label,/纸质签署见证/);
 assert.equal(signedStep.at,signed.data.signed_at);
 assert.equal((await request(`/api/operations/reservations/${id}/pay`,'POST',payment,staff)).status,200);
 assert.equal(db.prepare('SELECT created_by FROM reservations WHERE id=?').get(id).created_by,2);
 const year=Number(new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Oslo',year:'numeric'}).format(new Date()));
 const report=await request(`/api/reports?year=${year}`,'GET',undefined,manager);assert.equal(report.status,200);
 assert.equal(report.data.byEmployeeYear.find(row=>row.id===2).contracts,1,'此前顾客自助合同不可计入员工开单');
});

test.after(()=>{server.close();db.close();rmSync(temp,{recursive:true,force:true});});
