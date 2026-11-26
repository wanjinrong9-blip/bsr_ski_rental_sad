import {reservationHeaders} from './reservation-key.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {consent,testPhoto,approveCase} from './damage-helpers.mjs';
import {prepareAndSign,signBeforePay} from './fulfillment-helpers.mjs';
import {futureDate} from './future-date.mjs';
const temp=mkdtempSync(join(tmpdir(),'bsr-damage-'));
process.env.NODE_ENV='test';process.env.BSR_DB_PATH=join(temp,'damage.sqlite');
const {server,db}=await import('../src/server.mjs');await new Promise(r=>server.listen(0,'127.0.0.1',r));
// Extra inventory exists only in this isolated test database; damaged stock stays isolated.
for(let i=0;i<20;i++)db.prepare("INSERT INTO units(inventory_no,variant_id,store_id,status,condition_note) VALUES(?,7,1,'AVAILABLE','自动化测试专用库存')").run(`TEST-DAMAGE-${i}`);
const base=`http://127.0.0.1:${server.address().port}`;
async function request(path,method='GET',data,token=''){
  const res=await fetch(base+path,{method,headers:{...reservationHeaders(path,method),...(token?{'x-bsr-session':token}:{}),...(data?{'content-type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});
  return {status:res.status,data:await res.json()};
}
const accounts={};
async function session(role){if(!accounts[role])accounts[role]=(await request('/api/auth/login','POST',{email:`${role}@bsr.demo`,password:'Demo123!'})).data.sessionToken;return accounts[role];}
let day=50;
function input(items=[{variantId:7,qty:1}]){day+=3;return {storeId:1,pickupAt:futureDate(day),returnAt:futureDate(day+1),customerSkill:'中级',items,damageConsent:consent};}
async function createDamaged(items=[{variantId:7,qty:1}]){
  const customer=await session('customer'),staff=await session('staff'),manager=await session('manager'),tech=await session('contractor');
  const created=await request('/api/reservations','POST',input(items),customer);assert.equal(created.status,201,JSON.stringify(created.data));const id=created.data.id;
  await signBeforePay(request,id,customer);
  const pay=await request(`/api/reservations/${id}/pay`,'POST',{},customer);
  await prepareAndSign(request,id,staff,customer);
  const picked=await request('/api/operations/pickup','POST',{code:pay.data.pickupCode},staff);assert.equal(picked.status,200);
  const returned=await request('/api/operations/return','POST',{reservationId:id,items:picked.data.units.map(u=>({unitId:u.unitId,condition:'DAMAGED',feeNok:0,note:'测试：归还时发现疑似损坏待鉴定'}))},staff);assert.equal(returned.status,200);assert.equal(returned.data.status,'REVIEW');
  const order=(await request(`/api/reservations/${id}`,'GET',undefined,manager)).data;return {id,customer,staff,manager,tech,order,cases:order.damage.cases};
}
const assessment=(version,fee=100,action='submit')=>({version,action,grade:fee?'MODERATE':'NONE',part:'鞋扣连接位置',diagnosis:'测试：鞋扣连接处出现局部损伤',laborNok:fee,partsNok:0,replacementNok:fee?1000:0,valueBasis:fee?'测试：购入年限与折旧估值依据':''});
const photo=version=>({version,part:'鞋扣连接位置',caption:'测试合成图片，不代表真实损坏照片',mime:'image/png',base64:testPhoto});

test('下单接口强制明确同意当前版本，并保存不可变规则快照',async()=>{
  const customer=await session('customer'),data=input();
  for(const invalid of [undefined,{...consent,accepted:false},{...consent,readToEnd:false},{...consent,version:'old'}]){
    const result=await request('/api/reservations','POST',{...data,damageConsent:invalid},customer);assert.equal(result.status,422);
  }
  const created=await request('/api/reservations','POST',data,customer);assert.equal(created.status,201);
  const saved=db.prepare('SELECT * FROM damage_consents WHERE reservation_id=?').get(created.data.id);assert.equal(saved.user_id,1);assert.equal(saved.policy_version,consent.version);assert.equal(JSON.parse(saved.policy_json).currency,'NOK');
  const detail=(await request(`/api/reservations/${created.data.id}`,'GET',undefined,customer)).data;assert.equal(detail.damage.consent.policy_version,consent.version);
});

test('疑似受损即冻结押金，前台不能定价或绕过照片鉴定直接结算',async()=>{
  const x=await createDamaged();assert.equal(x.order.refund_nok,0);assert.equal(x.order.refund_status,'REVIEW');assert.equal(x.order.payments.filter(p=>p.type==='REFUND').length,0);
  assert.equal((await request(`/api/operations/refunds/${x.id}/approve`,'POST',{},x.manager)).status,409);
  assert.equal((await request(`/api/damage-cases/${x.cases[0].id}`,'PATCH',assessment(1),x.staff)).status,403);
  assert.equal((await request(`/api/damage-cases/${x.cases[0].id}`,'PATCH',assessment(1),x.tech)).status,400,'photos required');
  const saved=await request(`/api/damage-cases/${x.cases[0].id}`,'PATCH',assessment(1,100,'save'),x.tech);assert.equal(saved.status,200);assert.equal(saved.data.status,'DRAFT');
  assert.equal((await request(`/api/damage-cases/${x.cases[0].id}/review`,'POST',{version:saved.data.version,decision:'approve',note:'不能越过提交'},x.manager)).status,409);
});

test('照片内容校验、私有授权及版本冲突，提交后证据锁定且可退回补充',async()=>{
  const x=await createDamaged(),id=x.cases[0].id;
  assert.equal((await request(`/api/damage-cases/${id}/photos`,'POST',{...photo(1),mime:'image/svg+xml'},x.tech)).status,400);
  assert.equal((await request(`/api/damage-cases/${id}/photos`,'POST',{...photo(1),base64:Buffer.from('<script>bad</script>').toString('base64')},x.tech)).status,400);
  assert.equal((await request(`/api/damage-cases/${id}/photos`,'POST',photo(1),x.customer)).status,403);
  let result=await request(`/api/damage-cases/${id}/photos`,'POST',photo(1),x.tech);assert.equal(result.status,201);const p=result.data.photos[0];
  assert.equal((await fetch(base+`/api/damage-photos/${p.id}`)).status,401);
  const registered=await request('/api/auth/register','POST',{name:'另一顾客',email:'another@bsr.demo',password:'Test12345!'});assert.equal(registered.status,201);
  const another=(await request('/api/auth/login','POST',{email:'another@bsr.demo',password:'Test12345!'})).data.sessionToken;
  assert.equal((await fetch(base+`/api/damage-photos/${p.id}`,{headers:{'x-bsr-session':another}})).status,404);
  const image=await fetch(base+`/api/damage-photos/${p.id}`,{headers:{'x-bsr-session':x.customer}});assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/png');assert.match(image.headers.get('cache-control'),/no-store/);
  assert.equal((await request(`/api/damage-cases/${id}`,'PATCH',assessment(1),x.tech)).status,409);
  result=await request(`/api/damage-cases/${id}`,'PATCH',assessment(result.data.version),x.tech);assert.equal(result.status,200);
  assert.equal((await request(`/api/damage-cases/${id}/photos`,'POST',photo(result.data.version),x.tech)).status,409);
  result=await request(`/api/damage-cases/${id}/review`,'POST',{version:result.data.version,decision:'reject',note:'补充受损位置与估值依据'},x.manager);assert.equal(result.status,200);assert.equal(result.data.status,'RETURNED');
  result=await request(`/api/damage-cases/${id}`,'PATCH',assessment(result.data.version,80),x.tech);assert.equal(result.status,200);assert.equal(result.data.fee_nok,80);
  assert.ok(result.data.events.filter(e=>e.action==='SUBMITTED').length===2,'prior submitted snapshots remain');
});

test('鉴定为无损或正常磨损必须零收费，经理复核后退回全部押金',async()=>{
  const x=await createDamaged(),id=x.cases[0].id;
  let result=await request(`/api/damage-cases/${id}/photos`,'POST',photo(1),x.tech);
  assert.equal((await request(`/api/damage-cases/${id}`,'PATCH',{...assessment(result.data.version,0),laborNok:10},x.tech)).status,400);
  result=await request(`/api/damage-cases/${id}`,'PATCH',assessment(result.data.version,0),x.tech);assert.equal(result.status,200);
  await request(`/api/damage-cases/${id}/review`,'POST',{version:result.data.version,decision:'approve',note:'仅正常磨损，不收费'},x.manager);
  const reviewVersion=(await request(`/api/reservations/${x.id}`,'GET',undefined,x.staff)).data.staffReviewVersion;
  assert.equal((await request(`/api/reservations/${x.id}/staff-review`,'POST',{reviewVersion,checks:{identity:true,items:true,evidence:true},note:'跨店越权不应保存复核记录'},await session('staff2'))).status,404);
  await request(`/api/reservations/${x.id}/staff-review`,'POST',{reviewVersion,checks:{identity:true,items:true,evidence:true},note:'核对实物、顾客合同及技师证据后提交'},x.staff);
  const done=await request(`/api/operations/refunds/${x.id}/approve`,'POST',{},x.manager);assert.equal(done.data.refundNok,x.order.deposit_nok);assert.equal(done.data.feeNok,0);assert.equal(done.data.status,'COMPLETED');
});

test('轻微、中度、严重按修复成本计算并以折旧估值封顶，不可修复按折旧估值',async()=>{
  for(const level of ['MINOR','MODERATE','SEVERE','TOTAL_LOSS']){
    const x=await createDamaged(),id=x.cases[0].id;
    let result=await request(`/api/damage-cases/${id}/photos`,'POST',photo(1),x.tech);
    result=await request(`/api/damage-cases/${id}`,'PATCH',{...assessment(result.data.version,1200),grade:level,replacementNok:800},x.tech);assert.equal(result.status,200);assert.equal(result.data.fee_nok,800);
  }
});

test('超押金补差需联系、支持部分登记与幂等，异议和旧版本阻止结清',async()=>{
  const x=await createDamaged();await approveCase(request,x.cases[0].id,x.tech,x.manager,650);
  const due=650-x.order.deposit_nok;
  const reviewed=await request(`/api/operations/refunds/${x.id}/approve`,'POST',{},x.manager);assert.equal(reviewed.status,200);assert.equal(reviewed.data.status,'SETTLEMENT');assert.equal(reviewed.data.deductedNok,x.order.deposit_nok);assert.equal(reviewed.data.supplementNok,due);assert.equal(reviewed.data.refundNok,0);
  let d=(await request(`/api/reservations/${x.id}/damage`,'GET',undefined,x.staff)).data;
  const receipt=(version,amountNok=100,reference='DEMO-ONE')=>({version,amountNok,reference,confirmed:true});
  assert.equal((await request(`/api/reservations/${x.id}/damage/supplement`,'POST',receipt(d.settlement.version),x.staff)).status,409);
  d=(await request(`/api/reservations/${x.id}/damage/contact`,'POST',{channel:'PHONE',outcome:'DISPUTED',note:'顾客有异议，暂停结清并进一步沟通'},x.staff)).data;
  assert.equal((await request(`/api/reservations/${x.id}/damage/supplement`,'POST',receipt(d.settlement.version),x.staff)).status,409);
  d=(await request(`/api/reservations/${x.id}/damage/contact`,'POST',{channel:'PHONE',outcome:'REACHED',note:'已说明照片与费用，顾客确认本次沟通结果'},x.staff)).data;
  assert.equal((await request(`/api/reservations/${x.id}/damage/supplement`,'POST',receipt(1),x.staff)).status,409);
  let paid=await request(`/api/reservations/${x.id}/damage/supplement`,'POST',receipt(d.settlement.version),x.staff);assert.equal(paid.status,200);assert.equal(paid.data.damage.settlement.paid_nok,100);
  assert.equal((await request(`/api/reservations/${x.id}/damage/supplement`,'POST',receipt(d.settlement.version),x.staff)).data.duplicate,true);
  assert.equal((await request(`/api/reservations/${x.id}/damage/supplement`,'POST',receipt(paid.data.damage.settlement.version,101),x.staff)).status,409);
  const version=paid.data.damage.settlement.version;
  assert.equal((await request(`/api/reservations/${x.id}/damage/supplement`,'POST',receipt(version,due-99,'DEMO-TWO'),x.staff)).status,409);
  assert.equal((await request(`/api/reservations/${x.id}/damage/supplement`,'POST',receipt(version,due-100,'DEMO-TWO'),x.customer)).status,403);
  paid=await request(`/api/reservations/${x.id}/damage/supplement`,'POST',receipt(version,due-100,'DEMO-TWO'),x.staff);assert.equal(paid.status,200);assert.equal(paid.data.damage.settlement.status,'SETTLED');
  assert.equal(db.prepare('SELECT status FROM reservations WHERE id=?').get(x.id).status,'COMPLETED');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM damage_receipts WHERE reservation_id=?').get(x.id).n,2);
  assert.ok(!(await request('/api/order-alerts?view=urgent','GET',undefined,x.manager)).data.items.some(r=>r.id===x.id));
});

test('多件受损必须全部鉴定通过后汇总结算，不按单件重复扣押金',async()=>{
  const x=await createDamaged([{variantId:6,qty:2}]);assert.equal(x.order.deposit_nok,288);
  await approveCase(request,x.cases[0].id,x.tech,x.manager,500);
  assert.equal((await request(`/api/operations/refunds/${x.id}/approve`,'POST',{},x.manager)).status,409);
  await approveCase(request,x.cases[1].id,x.tech,x.manager,500);
  const result=await request(`/api/operations/refunds/${x.id}/approve`,'POST',{},x.manager);assert.equal(result.data.feeNok,1000);assert.equal(result.data.deductedNok,x.order.deposit_nok);assert.equal(result.data.supplementNok,1000-x.order.deposit_nok);
  assert.equal((await request(`/api/operations/refunds/${x.id}/approve`,'POST',{},x.manager)).status,409);
});

test('历史订单无新条款记录不能自动追溯收费，须人工沟通确认',async()=>{
  const manager=await session('manager'),tech=await session('contractor'),staff=await session('staff');
  const historic=db.prepare("SELECT * FROM reservations WHERE code='BR-DEMO003'").get(),c=db.prepare('SELECT * FROM damage_cases WHERE reservation_id=?').get(historic.id);assert.ok(c);
  await approveCase(request,c.id,tech,manager,80);
  assert.equal((await request(`/api/operations/refunds/${historic.id}/approve`,'POST',{},manager)).status,409);
  await request(`/api/reservations/${historic.id}/damage/contact`,'POST',{channel:'IN_PERSON',outcome:'REACHED',note:'历史演示订单按原约定人工协商，顾客确认沟通结果'},staff);
  assert.equal((await request(`/api/operations/refunds/${historic.id}/approve`,'POST',{},manager)).status,200);
  assert.equal(db.prepare('SELECT * FROM damage_consents WHERE reservation_id=?').get(historic.id),undefined);
});
test.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));db.close();rmSync(temp,{recursive:true,force:true});});
