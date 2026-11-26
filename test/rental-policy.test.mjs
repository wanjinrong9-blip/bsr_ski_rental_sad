import {reservationHeaders} from './reservation-key.mjs';
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {lateCharge,rentalPolicy} from '../src/rental-policy.mjs';
import {normalizeWindow} from '../src/domain.mjs';
import {consent} from './damage-helpers.mjs';
import {prepareAndSign,signBeforePay} from './fulfillment-helpers.mjs';

test('挪威取还时段在服务端强制校验，归还最迟 16:00',()=>{
  assert.throws(()=>normalizeWindow('2030-01-01T07:59:00Z','2030-01-02T14:00:00Z'),/09:00/);
  assert.throws(()=>normalizeWindow('2030-01-01T08:00:00Z','2030-01-02T15:01:00Z'),/16:00/);
  const valid=normalizeWindow('2030-01-01T08:00:00Z','2030-01-02T15:00:00Z');
  assert.equal(valid.days,2);
});

test('超时费用以单件日租金计：首租两小时免收、起算小时进位、24 小时封顶',()=>{
  const due='2030-01-01T15:00:00Z',at=minutes=>new Date(Date.parse(due)+minutes*60000).toISOString();
  assert.equal(lateCharge(100,due,at(120),120).feeNok,0);
  assert.deepEqual(
    {fee:lateCharge(100,due,at(121),120).feeNok,hours:lateCharge(100,due,at(121),120).billableHours},
    {fee:10,hours:1}
  );
  assert.equal(lateCharge(100,due,at(1),0).feeNok,10);
  assert.equal(lateCharge(100,due,at(12*60),0).feeNok,100);
  assert.equal(lateCharge(100,due,at(24*60),0).feeNok,100);
  assert.equal(lateCharge(100,due,at(24*60+1),0).feeNok,110);
  assert.equal(lateCharge(100,due,at(48*60),0).feeNok,200);
});

const temp=mkdtempSync(join(tmpdir(),'bsr-late-policy-'));
process.env.NODE_ENV='test';
process.env.BSR_DB_PATH=join(temp,'rental.sqlite');
const {server,db}=await import('../src/server.mjs');
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();rmSync(temp,{recursive:true,force:true});});
const base=`http://127.0.0.1:${server.address().port}`;
async function request(path,method='GET',data,token=''){
  const response=await fetch(base+path,{method,headers:{...reservationHeaders(path,method),...(token?{'x-bsr-session':token}:{}),...(data?{'content-type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});
  return {status:response.status,data:await response.json()};
}
const tokens={};
for(const role of ['customer','staff'])tokens[role]=(await request('/api/auth/login','POST',{email:`${role}@bsr.demo`,password:'Demo123!'})).data.sessionToken;
const firstEmail='first-rental-'+Date.now()+'@bsr.test';
assert.equal((await request('/api/auth/register','POST',{name:'首租测试顾客',email:firstEmail,password:'Test12345!'})).status,201);
tokens.customer=(await request('/api/auth/login','POST',{email:firstEmail,password:'Test12345!'})).data.sessionToken;
assert.equal((await request('/api/me','PATCH',{name:'首租测试顾客',phone:'4700000000',address:'测试街道 1 号',birthYear:2000,heightCm:170,weightKg:65,shoeSize:'EU 42'},tokens.customer)).status,200);
const date=(days)=>{const d=new Date(Date.now()+days*86400000);d.setUTCHours(10,0,0,0);return d.toISOString();};
async function create(days,variantId=13){
  const result=await request('/api/reservations','POST',{storeId:1,pickupAt:date(days),returnAt:date(days+1),customerSkill:'中级',items:[{variantId,qty:1}],damageConsent:consent},tokens.customer);
  assert.equal(result.status,201,JSON.stringify(result.data));return result.data.id;
}
async function activate(id){
  await signBeforePay(request,id,tokens.customer);
  const paid=await request(`/api/reservations/${id}/pay`,'POST',{},tokens.customer);
  assert.equal(paid.status,200,JSON.stringify(paid.data));
  await prepareAndSign(request,id,tokens.staff,tokens.customer);
  const picked=await request('/api/operations/pickup','POST',{code:paid.data.pickupCode},tokens.staff);
  assert.equal(picked.status,200,JSON.stringify(picked.data));
  return picked.data.units[0].unitId;
}
const detail=async id=>(await request(`/api/reservations/${id}`,'GET',undefined,tokens.customer)).data;
const catalog=async(start,end)=>(await request(`/api/catalog?storeId=1&pickupAt=${encodeURIComponent(start)}&returnAt=${encodeURIComponent(end)}`)).data;

test('首笔有效租赁享 2 小时宽限；占用未归还的逾期装备；实际归还后冻结费用并抵扣押金',async()=>{
  const id=await create(60),unitId=await activate(id);
  let order=await detail(id);
  assert.equal(order.late.graceMinutes,rentalPolicy.firstRentalGraceMinutes);
  assert.equal(order.contracts[0].snapshot.latePolicy.graceMinutes,120);
  assert.match(order.contracts[0].snapshot.terms,/10%/);
  const availabilityBefore=await catalog(date(40),date(41));
  const quantityBefore=availabilityBefore.items.find(item=>item.id===13).available;
  const due=new Date(Date.now()-121*60000).toISOString();
  // Synthetic clock fixture: emulate an overdue active booking without waiting in real time.
  db.prepare('UPDATE reservations SET return_at=? WHERE id=?').run(due,id);
  db.prepare('UPDATE reservation_items SET rental_to=? WHERE reservation_id=?').run(due,id);
  const availabilityAfter=await catalog(date(40),date(41));
  assert.equal(availabilityAfter.items.find(item=>item.id===13).available,quantityBefore-1);
  order=await detail(id);
  assert.equal(order.late.units[0].billableHours,1);
  const daily=db.prepare('SELECT daily_nok FROM price_policies WHERE id=(SELECT policy_id FROM reservation_items WHERE reservation_id=?)').get(id).daily_nok;
  const expected=Math.max(1,Math.round(daily*0.1));
  const returned=await request('/api/operations/return','POST',{reservationId:id,items:[{unitId,condition:'GOOD',note:'无异常'}]},tokens.staff);
  assert.equal(returned.status,200,JSON.stringify(returned.data));
  assert.equal(returned.data.lateFeeNok,expected);
  order=await detail(id);
  assert.equal(order.late.assessedNok,expected);
  assert.equal(order.late.units[0].feeNok,expected);
  assert.equal(order.damage.settlement.damage_fee_nok,0);
  assert.equal(order.damage.settlement.late_fee_nok,expected);
  assert.equal(order.refund_nok,order.deposit_nok-expected);
});

test('第二笔有效租赁无免费宽限；旧单无新条款不追溯',async()=>{
  const id=await create(70),unitId=await activate(id);
  let order=await detail(id);
  assert.equal(order.late.graceMinutes,0);
  const due=new Date(Date.now()-60000).toISOString();
  db.prepare('UPDATE reservations SET return_at=? WHERE id=?').run(due,id);
  db.prepare('UPDATE reservation_items SET rental_to=? WHERE reservation_id=?').run(due,id);
  const result=await request('/api/operations/return','POST',{reservationId:id,items:[{unitId,condition:'GOOD',note:'正常'}]},tokens.staff);
  assert.equal(result.status,200);
  assert.ok(result.data.lateFeeNok>0);
  const oldId=await create(80),oldUnit=await activate(oldId);
  db.prepare('UPDATE reservations SET late_policy_version=NULL,return_at=? WHERE id=?').run(due,oldId);
  db.prepare('UPDATE reservation_items SET rental_to=? WHERE reservation_id=?').run(due,oldId);
  const historical=await request('/api/operations/return','POST',{reservationId:oldId,items:[{unitId:oldUnit,condition:'GOOD',note:'正常'}]},tokens.staff);
  assert.equal(historical.status,200);
  assert.equal(historical.data.lateFeeNok,0);
  order=await detail(oldId);
  assert.equal(order.late.applicable,false);
});

test('经营端按挪威年度列示员工开单归属与超时费，不自动发奖金',async()=>{
  const manager=(await request('/api/auth/login','POST',{email:'manager@bsr.demo',password:'Demo123!'})).data.sessionToken;
  const year=Number(new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Oslo',year:'numeric'}).format(new Date()));
  const report=await request(`/api/reports?year=${year}`,'GET',undefined,manager);
  assert.equal(report.status,200);
  assert.equal(report.data.employeeYear,year);
  assert.equal(report.data.byEmployeeYear.find(row=>row.name==='Emma Berg').contracts,0,'顾客自助预约不得计为员工业绩');
  assert.ok(report.data.damage.late_fee_nok>0);
  assert.equal(report.data.damage.fee_nok,report.data.damage.damage_fee_nok+report.data.damage.late_fee_nok);
  assert.equal((await request(`/api/reports?year=${year}`,'GET',undefined,tokens.customer)).status,403);
});
