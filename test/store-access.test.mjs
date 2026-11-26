import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {consent,testPhoto} from './damage-helpers.mjs';
import {futureDate} from './future-date.mjs';

const temp=mkdtempSync(join(tmpdir(),'bsr-store-access-'));
process.env.NODE_ENV='test';process.env.BSR_DB_PATH=join(temp,'access.sqlite');
const {server,db}=await import('../src/server.mjs');
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
async function request(path,method='GET',data,token='',key){
 const response=await fetch(base+path,{method,headers:{...(token?{'x-bsr-session':token}:{}),...(key?{'Idempotency-Key':key}:{}),...(data?{'content-type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});
 const text=await response.text();let result;try{result=JSON.parse(text);}catch{result=text;}
 return {status:response.status,data:result};
}
async function login(email){const response=await request('/api/auth/login','POST',{email,password:'Demo123!'});assert.equal(response.status,200);return response.data.sessionToken;}
const accounts={};let northOrder,northCode,northContract,damageCaseId,damagePhotoId;
test.before(async()=>{
 db.prepare("INSERT INTO users(name,email,password_hash,role,store_id,created_at) SELECT 'North Manager','northmanager@bsr.demo',password_hash,'manager',2,created_at FROM users WHERE email='manager@bsr.demo'").run();
 for(const [role,email] of Object.entries({customer:'customer@bsr.demo',staff:'staff@bsr.demo',northStaff:'staff2@bsr.demo',manager:'manager@bsr.demo',northManager:'northmanager@bsr.demo',owner:'owner@bsr.demo',admin:'admin@bsr.demo'}))accounts[role]=await login(email);
 const response=await request('/api/reservations','POST',{storeId:2,pickupAt:futureDate(47),returnAt:futureDate(48),customerSkill:'中级',items:[{variantId:9,qty:1}],damageConsent:consent},accounts.customer,'store-access-north-order-001');
 assert.equal(response.status,201,JSON.stringify(response.data));northOrder=response.data.id;northCode=response.data.code;
 const issued=await request(`/api/reservations/${northOrder}/contracts`,'POST',{},accounts.customer);
 assert.equal(issued.status,201,JSON.stringify(issued.data));northContract=issued.data.id;
 const signed=await request(`/api/contracts/${northContract}/sign`,'POST',{accepted:true,snapshotHash:issued.data.snapshot_hash,name:'自动化测试顾客'},accounts.customer);
 assert.equal(signed.status,200,JSON.stringify(signed.data));
 const paid=await request(`/api/reservations/${northOrder}/pay`,'POST',{},accounts.customer);
 assert.equal(paid.status,200,JSON.stringify(paid.data));
 damageCaseId=db.prepare("SELECT id FROM damage_cases WHERE reservation_id=(SELECT id FROM reservations WHERE code='BR-DEMO003')").get()?.id;
 assert.ok(damageCaseId,'演示受损订单应具备鉴定单');
 const assessor=db.prepare('SELECT assessor_id FROM damage_cases WHERE id=?').get(damageCaseId).assessor_id;
 damagePhotoId=Number(db.prepare('INSERT INTO damage_photos(case_id,uploaded_by,part,caption,mime,image,created_at) VALUES(?,?,?,?,?,?,?)')
  .run(damageCaseId,assessor,'板刃','测试合成证据','image/png',Buffer.from(testPhoto,'base64'),new Date().toISOString()).lastInsertRowid);
});

test('门店人员只列出所属店订单；顾客仍见本人订单',async()=>{
 const south=(await request('/api/reservations','GET',undefined,accounts.staff));
 const north=(await request('/api/reservations','GET',undefined,accounts.northStaff));
 const manager=(await request('/api/reservations','GET',undefined,accounts.manager));
 const northManager=(await request('/api/reservations','GET',undefined,accounts.northManager));
 const customer=(await request('/api/reservations','GET',undefined,accounts.customer));
 assert.equal(south.status,200);assert.equal(north.status,200);assert.equal(manager.status,200);assert.equal(northManager.status,200);assert.equal(customer.status,200);
 assert.ok(south.data.length>0);assert.ok(north.data.length>0);
 assert.ok(south.data.every(order=>order.store_id===1));
 assert.ok(manager.data.every(order=>order.store_id===1));
 assert.ok(north.data.every(order=>order.store_id===2));
 assert.ok(northManager.data.every(order=>order.store_id===2));
 assert.ok(customer.data.some(order=>order.id===northOrder));
 const southPrep=await request('/api/preparations','GET',undefined,accounts.staff);
 const northPrep=await request('/api/preparations','GET',undefined,accounts.northStaff);
 assert.equal(southPrep.status,200);assert.equal(northPrep.status,200);
 assert.ok(southPrep.data.every(prep=>prep.id!==northOrder));
 assert.ok(northPrep.data.some(prep=>prep.id===northOrder));
});

test('跨店店员/经理不能按 ID 查看订单、合同、准备和损坏详情',async()=>{
 for(const token of [accounts.staff,accounts.manager]){
  for(const path of [`/api/reservations/${northOrder}`,`/api/reservations/${northOrder}/contracts`,`/api/preparations/${northOrder}`,`/api/reservations/${northOrder}/damage`]){
   const result=await request(path,'GET',undefined,token);
   assert.equal(result.status,404,`${path}: ${JSON.stringify(result.data)}`);
  }
 }
 assert.equal((await request(`/api/reservations/${northOrder}`,'GET',undefined,accounts.northStaff)).status,200);
 assert.equal((await request(`/api/reservations/${northOrder}`,'GET',undefined,accounts.northManager)).status,200);
 assert.equal((await request(`/api/reservations/${northOrder}`,'GET',undefined,accounts.customer)).status,200);
 for(const token of [accounts.staff,accounts.manager]){
  assert.equal((await request(`/api/contracts/${northContract}/print`,'GET',undefined,token)).status,404);
 }
 assert.equal((await request('/api/reservations/1','GET',undefined,accounts.northManager)).status,404);
});

test('经营负责人和权限管理员只能看汇总，不得取逐单、合同、鉴定明细',async()=>{
 for(const token of [accounts.owner,accounts.admin]){
  assert.equal((await request('/api/reservations','GET',undefined,token)).status,403);
  assert.equal((await request('/api/preparations','GET',undefined,token)).status,403);
  for(const path of [`/api/reservations/${northOrder}`,`/api/reservations/${northOrder}/contracts`,`/api/preparations/${northOrder}`,`/api/reservations/${northOrder}/damage`]){
   const result=await request(path,'GET',undefined,token);
   assert.equal(result.status,403,`${path}: ${JSON.stringify(result.data)}`);
  }
  assert.equal((await request(`/api/contracts/${northContract}/print`,'GET',undefined,token)).status,403);
 }
 assert.equal((await request('/api/reports','GET',undefined,accounts.owner)).status,200);
});

test('店员不能为其他门店直接创建或处理订单',async()=>{
 const create=await request('/api/operations/reservations','POST',{
  customerId:1,storeId:2,pickupAt:futureDate(49),returnAt:futureDate(50),
  customerSkill:'初级',items:[{variantId:9,qty:1}],damageConsent:consent
 },accounts.staff,'store-access-forbidden-counter-001');
 assert.equal(create.status,403,JSON.stringify(create.data));
});

test('受损鉴定列表、详情及照片按原订单门店授权',async()=>{
 const own=await request('/api/damage-cases','GET',undefined,accounts.staff);
 assert.equal(own.status,200);
 assert.ok(own.data.some(item=>item.id===damageCaseId));
 assert.equal((await request(`/api/damage-cases/${damageCaseId}`,'GET',undefined,accounts.staff)).status,200);
 assert.equal((await request(`/api/damage-photos/${damagePhotoId}`,'GET',undefined,accounts.staff)).status,200);
 const north=await request('/api/damage-cases','GET',undefined,accounts.northStaff);
 assert.equal(north.status,200);
 assert.ok(north.data.every(item=>item.id!==damageCaseId));
 for(const token of [accounts.northStaff,accounts.northManager,accounts.owner,accounts.admin]){
  const expected=[accounts.northStaff,accounts.northManager].includes(token)?404:403;
  assert.equal((await request(`/api/damage-cases/${damageCaseId}`,'GET',undefined,token)).status,expected);
  assert.equal((await request(`/api/damage-photos/${damagePhotoId}`,'GET',undefined,token)).status,expected);
 }
 for(const token of [accounts.owner,accounts.admin]){
  assert.equal((await request('/api/damage-cases','GET',undefined,token)).status,403);
 }
});

test('跨店变更、受损沟通和准备写入在查询状态或幂等记录前拒绝',async()=>{
 const demo=db.prepare("SELECT id FROM reservations WHERE code='BR-DEMO002'").get();
 const damaged=db.prepare("SELECT id FROM reservations WHERE code='BR-DEMO003'").get();
 const before={adjustments:db.prepare('SELECT COUNT(*) AS n FROM contract_adjustments WHERE reservation_id=?').get(demo.id).n,
  contacts:db.prepare('SELECT COUNT(*) AS n FROM damage_contacts WHERE reservation_id=?').get(damaged.id).n,
  prep:db.prepare('SELECT version FROM preparations WHERE reservation_id=?').get(northOrder)?.version};
 const quote=await request(`/api/reservations/${demo.id}/amendments/quote`,'POST',{effectiveAt:new Date().toISOString(),removeUnitIds:[],addItems:[{variantId:9,qty:1}]},accounts.northStaff);
 assert.equal(quote.status,404);
 const commit=await request(`/api/reservations/${demo.id}/amendments`,'POST',{reference:'DUPLICATE-OTHER-STORE',quoteHash:'untrusted'},accounts.northStaff);
 assert.equal(commit.status,404);
 const contact=await request(`/api/reservations/${damaged.id}/damage/contact`,'POST',{channel:'PHONE',outcome:'REACHED',note:'跨店越权测试，不应记录'},accounts.northStaff);
 assert.equal(contact.status,404);
 const supplement=await request(`/api/reservations/${damaged.id}/damage/supplement`,'POST',{reference:'OTHER-STORE',amountNok:1,confirmed:true},accounts.northStaff);
 assert.equal(supplement.status,404);
 const prep=await request(`/api/preparations/${northOrder}`,'PATCH',{version:1,action:'claim'},accounts.staff);
 assert.equal(prep.status,404);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM contract_adjustments WHERE reservation_id=?').get(demo.id).n,before.adjustments);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM damage_contacts WHERE reservation_id=?').get(damaged.id).n,before.contacts);
 assert.equal(db.prepare('SELECT version FROM preparations WHERE reservation_id=?').get(northOrder)?.version,before.prep);
});

test('订单提醒和已读操作不得跨店，经营负责人和权限管理员只能看匿名汇总',async()=>{
 const south=await request('/api/order-alerts','GET',undefined,accounts.staff);
 const north=await request('/api/order-alerts','GET',undefined,accounts.northStaff);
 assert.equal(south.status,200);assert.equal(north.status,200);
 assert.ok(south.data.items.every(item=>item.id!==northOrder));
 assert.ok(north.data.items.some(item=>item.id===northOrder));
 assert.ok(north.data.items.every(item=>item.id!==1));
 assert.equal((await request('/api/order-alerts/read','POST',{kind:'reservation',entries:[{id:northOrder,noticeVersion:1}]},accounts.staff)).status,403);
 for(const token of [accounts.owner,accounts.admin]){
  const aggregate=await request('/api/order-alerts','GET',undefined,token);
  assert.equal(aggregate.status,200);
  assert.ok(aggregate.data.counts);
  assert.ok(!aggregate.data.items||aggregate.data.items.length===0);
  assert.ok(!JSON.stringify(aggregate.data).includes(northCode));
  assert.ok(!JSON.stringify(aggregate.data).includes('customer@bsr.demo'));
  assert.equal((await request('/api/order-alerts/read','POST',{kind:'reservation',entries:[{id:northOrder,noticeVersion:1}]},token)).status,403);
 }
});

test('异店核码仅给接收店员最小归还资料，归还须核对原订单码与实际接收门店',async()=>{
 const order=db.prepare("SELECT id,code,pickup_code FROM reservations WHERE code='BR-DEMO002'").get();
 const unit=db.prepare('SELECT ru.unit_id FROM rental_units ru JOIN reservation_items ri ON ri.id=ru.reservation_item_id WHERE ri.reservation_id=? AND ru.returned=0').get(order.id);
 assert.ok(unit);
 const lookup=await request(`/api/operations/lookup?code=${encodeURIComponent(order.code)}`,'GET',undefined,accounts.northStaff);
 assert.equal(lookup.status,200);
 assert.deepEqual(Object.keys(lookup.data).sort(),['crossStoreReturn','id','code','store_id','status','return_at','receivingStoreId','units'].sort());
 assert.equal(lookup.data.crossStoreReturn,true);
 assert.equal(lookup.data.id,order.id);
 assert.equal(lookup.data.code,order.code);
 assert.ok(lookup.data.units.some(item=>item.unit_id===unit.unit_id));
 assert.ok(lookup.data.units.every(item=>Object.keys(item).sort().join(',')===['unit_id','inventory_no','name','size'].sort().join(',')));
 const pickupCodeLookup=await request(`/api/operations/lookup?code=${encodeURIComponent(order.pickup_code)}`,'GET',undefined,accounts.northStaff);
 assert.equal(pickupCodeLookup.status,200);
 assert.deepEqual(pickupCodeLookup.data,lookup.data);
 const payload={reservationId:order.id,returnStoreId:2,items:[{unitId:unit.unit_id,condition:'GOOD',note:'异店完整归还验收'}]};
 assert.equal((await request('/api/operations/return','POST',{...payload,code:order.code},accounts.staff)).status,403);
 assert.equal((await request('/api/operations/return','POST',{...payload,code:'BR-WRONG'},accounts.northStaff)).status,404);
 assert.equal(db.prepare('SELECT returned FROM rental_units WHERE unit_id=?').get(unit.unit_id).returned,0);
 const returned=await request('/api/operations/return','POST',{...payload,code:order.code},accounts.northStaff);
 assert.equal(returned.status,200);
 assert.equal(returned.data.returnStoreId,2);
 assert.ok(Array.isArray(returned.data.items));
 assert.ok(returned.data.receivedAt);
 assert.ok(['customerContact','customer_name','payments','quote','rentNok','refundNok','lateFeeNok','feesNok','supplementNok'].every(key=>!Object.hasOwn(returned.data,key)));
 assert.equal(db.prepare('SELECT return_store_id FROM rental_units WHERE unit_id=?').get(unit.unit_id).return_store_id,2);
});

test('按 ID 或完整码探测外店订单时与不存在对象得到相同拒绝响应',async()=>{
 const outside=await request('/api/reservations/1','GET',undefined,accounts.northStaff);
 const absent=await request('/api/reservations/99999999','GET',undefined,accounts.northStaff);
 assert.deepEqual(outside,absent);
 const inactive=db.prepare("SELECT code FROM reservations WHERE store_id=1 AND status<>'ACTIVE' LIMIT 1").get();
 assert.ok(inactive);
 const unavailable=await request(`/api/operations/lookup?code=${encodeURIComponent(inactive.code)}`,'GET',undefined,accounts.northStaff);
 const unknown=await request('/api/operations/lookup?code=BR-UNKNOWN-CODE','GET',undefined,accounts.northStaff);
 assert.deepEqual(unavailable,unknown);
});

test.after(()=>{server.close();db.close();rmSync(temp,{recursive:true,force:true});});
