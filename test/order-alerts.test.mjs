import {reservationHeaders} from './reservation-key.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {orderAlerts} from '../src/order-alerts.mjs';
import {consent,approveCase} from './damage-helpers.mjs';
import {prepareAndSign,signBeforePay} from './fulfillment-helpers.mjs';
import {futureDate} from './future-date.mjs';

const temp=mkdtempSync(join(tmpdir(),'bsr-alerts-'));
process.env.NODE_ENV='test';process.env.BSR_DB_PATH=join(temp,'alerts.sqlite');
const {server,db}=await import('../src/server.mjs');
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
async function request(path,method='GET',data,token=''){
  if(path==='/api/reservations'&&method==='POST')data={...data,customerSkill:'中级',damageConsent:consent};
  const res=await fetch(base+path,{method,headers:{...reservationHeaders(path,method),...(token?{'x-bsr-session':token}:{}),...(data?{'content-type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});
  return {status:res.status,data:await res.json()};
}
async function login(role){const res=await request('/api/auth/login','POST',{email:`${role}@bsr.demo`,password:'Demo123!'});assert.equal(res.status,200);return res.data.sessionToken;}
const date=futureDate;
const entry=item=>({id:item.id,noticeVersion:item.noticeVersion});
const alerts=async(token,query='')=>(await request('/api/order-alerts'+query,'GET',undefined,token)).data;

test('非顾客订单提醒权限、维修任务隔离和分页参数校验',async()=>{
  assert.equal((await request('/api/order-alerts')).status,401);
  const customer=await login('customer');
  assert.equal((await request('/api/order-alerts','GET',undefined,customer)).status,403);
  assert.equal((await request('/api/order-alerts/read','POST',{kind:'reservation',entries:[{id:1,noticeVersion:1}]},customer)).status,403);
  for(const role of ['staff','manager','owner','admin','contractor']){
    const token=await login(role),data=await alerts(token);
    assert.ok(data.counts.unresolved>0);assert.equal(data.kind,role==='contractor'?'maintenance':['owner','admin'].includes(role)?'summary':'reservation');
    if(role==='contractor')for(const item of data.items){assert.equal(item.customerName,undefined);assert.equal(item.pickup_code,undefined);assert.equal(item.total_nok,undefined);}
    if(['owner','admin'].includes(role)){
      assert.deepEqual(data.items,[]);
      assert.ok(data.byStoreStatus.length>0);
      assert.ok(data.byStoreStatus.every(group=>!Object.hasOwn(group,'id')&&!Object.hasOwn(group,'customerName')&&!Object.hasOwn(group,'code')));
      assert.equal((await request('/api/order-alerts/read','POST',{kind:'reservation',entries:[{id:1,noticeVersion:1}]},token)).status,403);
      const marked=await request('/api/order-alerts/read','POST',{kind:'summary'},token);
      assert.equal(marked.status,200);
      const after=await alerts(token);
      assert.equal(after.counts.new,0);
      assert.equal(after.counts.unresolved,data.counts.unresolved);
    }
  }
  const manager=await login('manager');
  assert.equal((await request('/api/order-alerts?view=invalid','GET',undefined,manager)).status,400);
  assert.equal((await request('/api/order-alerts?page=-1','GET',undefined,manager)).status,400);
  assert.equal((await request('/api/order-alerts/read','POST',{kind:'maintenance',entries:[{id:1,noticeVersion:1}]},manager)).status,403);
});

test('新增已读按账号持久化且不关闭未解决订单，批量标记仅针对提交的条目',async()=>{
  const manager=await login('manager'),staff=await login('staff');
  const before=await alerts(manager,'?view=new'),first=before.items[0];
  const marked=await request('/api/order-alerts/read','POST',{kind:'reservation',entries:[entry(first)]},manager);assert.equal(marked.status,200);
  const after=await alerts(manager);assert.equal(after.counts.new,before.counts.new-1);assert.equal(after.counts.unresolved,before.counts.unresolved);
  assert.equal(after.items.find(x=>x.id===first.id).isNew,false);
  assert.equal((await alerts(staff)).items.find(x=>x.id===first.id).isNew,true);
  await request('/api/auth/logout','POST',{},manager);const again=await login('manager');
  assert.equal((await alerts(again)).items.find(x=>x.id===first.id).isNew,false);
  assert.equal((await request('/api/order-alerts/read','POST',{kind:'reservation',entries:[entry(first)]},again)).data.marked,0);
  const current=await alerts(again,'?view=new');
  const second=current.items[0];
  assert.equal((await request('/api/order-alerts/read','POST',{kind:'reservation',entries:[entry(second),{id:999999,noticeVersion:1}]},again)).status,403);
  assert.equal((await alerts(again,'?view=new')).items.find(r=>r.id===second.id).isNew,true,'invalid batch rolls back');
  assert.equal((await request('/api/reservations/'+first.id,'GET',undefined,again)).data.attention.isNew,false);
  assert.equal((await request('/api/reservations/'+first.id,'GET',undefined,await login('customer'))).data.attention,undefined);
});

test('新预约和异常进入提醒，完成、取消及失效暂留自动移出，不修改业务状态',async()=>{
  const manager=await login('manager'),staff=await login('staff'),customer=await login('customer');
  const before=(await alerts(manager)).counts.unresolved;
  const create=await request('/api/reservations','POST',{storeId:1,pickupAt:date(25),returnAt:date(26),items:[{variantId:2,qty:1}]},customer);assert.equal(create.status,201);const id=create.data.id;
  let item=(await alerts(manager,'?view=new')).items.find(x=>x.id===id);assert.ok(item.isNew);assert.equal(item.status,'HOLD');
  await signBeforePay(request,id,customer);
  const paid=await request(`/api/reservations/${id}/pay`,'POST',{},customer);
  assert.equal((await alerts(manager)).counts.unresolved,before+1);
  await prepareAndSign(request,id,staff,customer);
  const pickup=await request('/api/operations/pickup','POST',{code:paid.data.pickupCode},staff);assert.equal(pickup.status,200);
  db.prepare('UPDATE reservations SET return_at=? WHERE id=?').run(date(-1),id);
  assert.ok((await alerts(manager,'?view=urgent')).items.find(x=>x.id===id).reason.includes('逾期'));
  const returned=await request('/api/operations/return','POST',{reservationId:id,items:[{unitId:pickup.data.units[0].unitId,condition:'DAMAGED',feeNok:0,note:'板面损伤需复核'}]},staff);assert.equal(returned.status,200);
  item=(await alerts(manager,'?view=urgent')).items.find(x=>x.id===id);assert.equal(item.status,'REVIEW');
  const caseId=(await request(`/api/reservations/${id}`,'GET',undefined,manager)).data.damage.cases[0].id;
  await approveCase(request,caseId,await login('contractor'),manager,60);
  await request(`/api/operations/refunds/${id}/approve`,'POST',{},manager);
  assert.equal((await alerts(manager)).counts.unresolved,before);
  assert.ok(!(await alerts(manager,'?view=new')).items.some(x=>x.id===id));
  const cancel=await request('/api/reservations','POST',{storeId:2,pickupAt:date(27),returnAt:date(28),items:[{variantId:9,qty:1}]},customer);
  assert.equal(cancel.status,201);await request(`/api/reservations/${cancel.data.id}/cancel`,'POST',{},customer);
  assert.equal((await alerts(manager)).counts.unresolved,before);
  const hold=await request('/api/reservations','POST',{storeId:2,pickupAt:date(29),returnAt:date(30),items:[{variantId:9,qty:1}]},customer);
  db.prepare('UPDATE reservations SET hold_expires_at=? WHERE id=?').run(date(-1),hold.data.id);
  assert.equal((await alerts(manager)).counts.unresolved,before);
  assert.equal(db.prepare('SELECT status FROM reservations WHERE id=?').get(hold.data.id).status,'HOLD','reminder reads do not change reservation state');
  const user=db.prepare("SELECT * FROM users WHERE role='manager'").get();
  const future=orderAlerts(db,user,new URLSearchParams(),Date.now()+40*86400000);
  assert.ok(future.counts.urgent>0,'time-based urgency computed on the server');
});

test('维修提醒仅本人可读，重新安排与经理退回生成新待阅，旧版本不会吞掉新提醒',async()=>{
  const manager=await login('manager'),tech=await login('contractor'),staff=await login('staff');
  let list=await alerts(tech),task=list.items[0];assert.ok(task);
  assert.equal((await request('/api/order-alerts/read','POST',{kind:'maintenance',entries:[entry(task)]},tech)).status,200);
  assert.equal((await alerts(tech)).items.find(x=>x.id===task.id).isNew,false);
  let current=db.prepare('SELECT * FROM maintenance WHERE id=?').get(task.id);
  assert.equal((await request(`/api/maintenance/${task.id}`,'PATCH',{version:current.version,action:'assign',contractorId:4,priority:'HIGH',dueAt:date(1)},manager)).status,200);
  assert.equal((await alerts(tech)).items.find(x=>x.id===task.id).isNew,true);
  await request('/api/order-alerts/read','POST',{kind:'maintenance',entries:[entry(task)]},tech);
  assert.equal((await alerts(tech)).items.find(x=>x.id===task.id).isNew,true,'stale acknowledgement preserves new assignment');
  task=(await alerts(tech)).items.find(x=>x.id===task.id);await request('/api/order-alerts/read','POST',{kind:'maintenance',entries:[entry(task)]},tech);
  current=db.prepare('SELECT * FROM maintenance WHERE id=?').get(task.id);
  const fakeVersion={...entry(task),noticeVersion:task.noticeVersion+100000};
  assert.equal((await request('/api/order-alerts/read','POST',{kind:'maintenance',entries:[fakeVersion]},tech)).status,409);
  const inspecting=await request(`/api/maintenance/${task.id}`,'PATCH',{version:current.version,status:'INSPECTING'},tech);assert.equal(inspecting.status,200);
  const ready=await request(`/api/maintenance/${task.id}`,'PATCH',{version:inspecting.data.version,status:'AWAITING_REVIEW',diagnosis:'检查发现边刃损伤',result:'已修复并进行安全测试',hours:1,checklist:{appearance:true,fasteners:true,function:true,cleaning:true}},tech);assert.equal(ready.status,200);
  const rejected=await request(`/api/maintenance/${task.id}`,'PATCH',{version:ready.data.version,action:'review',decision:'reject',note:'请补充边刃检查依据'},manager);assert.equal(rejected.status,200);
  task=(await alerts(tech)).items.find(x=>x.id===task.id);assert.equal(task.isNew,true,'manager rejection creates a new notice');
  await request('/api/order-alerts/read','POST',{kind:'maintenance',entries:[entry(task)]},tech);
  const beforeClose=(await alerts(tech)).counts.unresolved;
  const resubmit=await request(`/api/maintenance/${task.id}`,'PATCH',{version:rejected.data.version,status:'AWAITING_REVIEW',result:'补充检查完成且安全测试通过'},tech);assert.equal(resubmit.status,200);
  const accepted=await request(`/api/maintenance/${task.id}`,'PATCH',{version:resubmit.data.version,action:'review',decision:'accept',note:'补充检查与实物安全验收通过'},manager);assert.equal(accepted.status,200);
  assert.equal((await alerts(tech)).counts.unresolved,beforeClose-1);
  const units=(await request('/api/inventory','GET',undefined,manager)).data;
  const unit=units.find(u=>u.status==='AVAILABLE'&&u.variant_id===10);
  db.prepare("INSERT INTO users(name,email,password_hash,role,created_at) SELECT 'Other technician','other@bsr.demo',password_hash,'contractor',created_at FROM users WHERE id=4").run();
  const other=db.prepare("SELECT id FROM users WHERE email='other@bsr.demo'").get().id;
  const fault=await request('/api/maintenance','POST',{unitId:unit.id,contractorId:other,issue:'另一个技师的任务'},staff);assert.equal(fault.status,201);
  assert.ok(!(await alerts(tech)).items.some(x=>x.id===fault.data.id));
  assert.equal((await request('/api/order-alerts/read','POST',{kind:'maintenance',entries:[{id:fault.data.id,noticeVersion:0}]},tech)).status,403);
});

test('提醒总数不受最近150笔订单限制，搜索、翻页及页面上界有效',async()=>{
  const manager=await login('manager'),before=(await alerts(manager)).counts.unresolved;
  const insert=db.prepare(`INSERT INTO reservations(code,user_id,store_id,pickup_at,return_at,status,rent_nok,deposit_nok,total_nok,pickup_code,quote_json,created_at)
    SELECT ?,user_id,store_id,pickup_at,return_at,'CONFIRMED',rent_nok,deposit_nok,total_nok,?,quote_json,created_at FROM reservations WHERE id=1`);
  for(let i=0;i<155;i++)insert.run('BR-PAGE-'+i,'PAGECODE'+i);
  const data=await alerts(manager,'?page=2');assert.equal(data.counts.unresolved,before+155);assert.equal(data.page,2);assert.equal(data.items.length,12);
  const last=await alerts(manager,'?page=99999');assert.equal(last.page,last.pages);assert.ok(last.items.length>0);
  const search=await alerts(manager,'?search=BR-PAGE-154');assert.equal(search.total,1);assert.equal(search.items[0].code,'BR-PAGE-154');
  const none=await alerts(manager,'?search=no-such-record');assert.equal(none.total,0);assert.equal(none.pages,1);
});

test('普通通知已读仅修改自己的记录，并不会消除未解决订单提醒',async()=>{
  const manager=await login('manager'),customer=await login('customer');
  const own=(await request('/api/notifications','GET',undefined,manager)).data;
  const others=(await request('/api/notifications','GET',undefined,customer)).data;
  const before=(await alerts(manager)).counts.unresolved;
  const result=await request('/api/notifications/read','POST',{ids:[...own.map(x=>x.id),...others.slice(0,2).map(x=>x.id)]},manager);assert.equal(result.status,200);
  assert.ok((await request('/api/notifications','GET',undefined,manager)).data.every(x=>x.read_at));
  for(const n of others.slice(0,2))assert.equal(db.prepare('SELECT read_at FROM notifications WHERE id=?').get(n.id).read_at,n.read_at);
  assert.equal((await alerts(manager)).counts.unresolved,before);
});

test.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));db.close();rmSync(temp,{recursive:true,force:true});});
