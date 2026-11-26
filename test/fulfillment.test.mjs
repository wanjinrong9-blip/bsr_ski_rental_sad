import {reservationHeaders} from './reservation-key.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {consent} from './damage-helpers.mjs';
import {prepareAndSign,signBeforePay} from './fulfillment-helpers.mjs';
import {futureDate} from './future-date.mjs';
import {randomUUID} from 'node:crypto';
const temp=mkdtempSync(join(tmpdir(),'bsr-fulfillment-'));process.env.NODE_ENV='test';process.env.BSR_DB_PATH=join(temp,'fulfillment.sqlite');
const {server,db}=await import('../src/server.mjs');await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`,tokens={};
async function request(path,method='GET',data,token=''){const res=await fetch(base+path,{method,headers:{...reservationHeaders(path,method),...(method==='POST'&&/\/amendments\/proposals$/.test(path)?{'Idempotency-Key':randomUUID()}:{}),...(token?{'x-bsr-session':token}:{}),...(data?{'content-type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});return {status:res.status,data:await res.json()};}
for(const role of ['customer','staff','manager','contractor','owner','admin'])tokens[role]=(await request('/api/auth/login','POST',{email:`${role}@bsr.demo`,password:'Demo123!'})).data.sessionToken;
tokens.staff2=(await request('/api/auth/login','POST',{email:'staff2@bsr.demo',password:'Demo123!'})).data.sessionToken;
let offset=140;const date=futureDate;
async function create(items=[{variantId:13,qty:1}]){offset+=3;const r=await request('/api/reservations','POST',{storeId:1,pickupAt:date(offset),returnAt:date(offset+1),customerSkill:'中级',items,damageConsent:consent},tokens.customer);assert.equal(r.status,201,JSON.stringify(r.data));return r.data.id;}
async function pay(id){await signBeforePay(request,id,tokens.customer);const r=await request(`/api/reservations/${id}/pay`,'POST',{},tokens.customer);assert.equal(r.status,200,JSON.stringify(r.data));return r.data.pickupCode;}
async function detail(id){return (await request(`/api/reservations/${id}`,'GET',undefined,tokens.customer)).data;}
async function active(items){const id=await create(items),code=await pay(id);await prepareAndSign(request,id,tokens.staff,tokens.customer);const picked=await request('/api/operations/pickup','POST',{code},tokens.staff);assert.equal(picked.status,200);return {id,units:picked.data.units};}
async function approveProposal(id,change,q){
 const p=await request(`/api/reservations/${id}/amendments/proposals`,'POST',{...change,effectiveAt:q.effectiveAt,returnStoreId:1},tokens.staff);
 assert.equal(p.status,201,JSON.stringify(p.data));assert.equal(p.data.quote.quoteHash,q.quoteHash);
 const confirmed=await request(`/api/reservations/${id}/amendments/proposals/${p.data.id}/confirm`,'POST',{accepted:true,baseVersion:q.baseVersion,quoteHash:q.quoteHash},tokens.customer);
 assert.equal(confirmed.status,200,JSON.stringify(confirmed.data));return p.data.id;
}

test('备货逐件检查、实物唯一占用、角色权限及故障阻断，顾客共享同一份准备记录',async()=>{
 const id=await create(),code=await pay(id),path=`/api/preparations/${id}`;
 assert.equal((await request('/api/operations/pickup','POST',{code},tokens.staff)).status,409);
 let p=(await request(path,'GET',undefined,tokens.customer)).data;assert.equal(p.status,'QUEUED');assert.equal(p.handler_name,'Emma Berg');
 assert.equal((await request(path,'PATCH',{version:p.version,action:'claim'},tokens.customer)).status,403);
 p=(await request(path,'PATCH',{version:p.version,action:'claim'},tokens.staff)).data;
 assert.equal((await request(path,'PATCH',{version:p.version,action:'ready'},tokens.staff)).status,409);
 p=(await request(path,'PATCH',{version:p.version,action:'pick'},tokens.staff)).data;assert.equal(p.units.length,1);const unit=p.units[0].unit_id;
 assert.equal((await request('/api/transfers','POST',{unitId:unit,toStoreId:2},tokens.manager)).status,409);
 assert.equal((await request(path,'PATCH',{version:p.version-1,action:'check',units:[]},tokens.staff)).status,409);
 p=(await request(path,'PATCH',{version:p.version,action:'check',units:[{unitId:unit,size:true,clean:true,safety:false}]},tokens.staff)).data;
 assert.equal((await request(path,'PATCH',{version:p.version,action:'ready'},tokens.staff)).status,409);
 await request('/api/maintenance','POST',{unitId:unit,issue:'准备检查发现镜片锁扣异常'},tokens.staff);
 p=(await request(path,'GET',undefined,tokens.customer)).data;assert.equal(p.status,'BLOCKED');assert.equal(p.units.length,0);assert.ok(p.public_note.includes('故障'));assert.equal((await detail(id)).status,'CONFIRMED');
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM preparation_units WHERE unit_id=? AND active=1').get(unit).n,0);
 assert.equal((await request(`/api/reservations/${id}/cancel`,'POST',{},tokens.customer)).status,200);assert.equal((await request(path,'GET',undefined,tokens.customer)).data.status,'CANCELLED');
});

test('当前合同签署是交付门槛，快照与历史档案不被回写，打印需要本人授权',async()=>{
 const id=await create([{variantId:14,qty:1}]),code=await pay(id);
 const c=(await detail(id)).contracts[0];assert.equal(c.snapshot.skill,'中级');assert.equal(c.created_by,1);assert.equal(c.snapshot.channel,'ONLINE_SELF_SERVICE');assert.equal(c.snapshot.employee.name,'Emma Berg');assert.ok(c.snapshot.customer.address);
 assert.equal((await request(`/api/reservations/${id}/contracts`,'POST',{},tokens.customer)).status,409);
 const unsignedId=await create([{variantId:15,qty:1}]);
 const unsigned=(await request(`/api/reservations/${unsignedId}/contracts`,'POST',{},tokens.customer)).data;
 assert.equal((await request(`/api/contracts/${unsigned.id}/sign`,'POST',{name:'测试顾客',accepted:true,snapshotHash:'bad'},tokens.customer)).status,400);
 const other=(await request('/api/auth/register','POST',{name:'其他顾客',email:'privacy@bsr.demo',password:'Test12345!'})).data;
 const otherToken=(await request('/api/auth/login','POST',{email:'privacy@bsr.demo',password:'Test12345!'})).data.sessionToken;assert.ok(other.id);
  assert.equal((await request(`/api/preparations/${id}`,'GET',undefined,otherToken)).status,404);
  assert.equal((await fetch(base+`/api/contracts/${c.id}/print`,{headers:{'x-bsr-session':otherToken}})).status,404);
 assert.equal((await fetch(base+`/api/contracts/${c.id}/print`)).status,401);
 const html=await fetch(base+`/api/contracts/${c.id}/print`,{headers:{'x-bsr-session':tokens.customer}});assert.equal(html.status,200);assert.ok((await html.text()).includes(c.snapshot_hash));
 await request('/api/me','PATCH',{name:'林雪',address:'修改后的演示地址，仅供测试',birthYear:1999},tokens.customer);
 assert.equal((await detail(id)).contracts[0].snapshot.customer.address,c.snapshot.customer.address);
 await prepareAndSign(request,id,tokens.staff,tokens.customer);
 assert.equal((await request(`/api/contracts/${c.id}/sign`,'POST',{name:'重复签署',accepted:true,snapshotHash:c.snapshot_hash},tokens.customer)).status,409);
 assert.equal((await request('/api/operations/pickup','POST',{code},tokens.staff)).status,200);
});

test('分批及异店归还逐件时间留痕，待清洁装备不可再租，全件归还后一次退款',async()=>{
 const x=await active([{variantId:16,qty:2}]),home=db.prepare('SELECT home_store_id FROM units WHERE id=?').get(x.units[0].unitId).home_store_id;
 const code=db.prepare('SELECT code FROM reservations WHERE id=?').get(x.id).code;
 let r=await request('/api/operations/return','POST',{reservationId:x.id,code,returnStoreId:2,items:[{unitId:x.units[0].unitId,condition:'CLEANING',note:'需清洁并彻底干燥'}]},tokens.staff2);assert.equal(r.status,200);assert.equal(r.data.status,'ACTIVE');assert.equal(r.data.remaining,1);
 let o=await detail(x.id),u=o.units.find(u=>u.unit_id===x.units[0].unitId);assert.ok(u.out_at&&u.returned_at);assert.equal(u.return_store_id,2);
 assert.equal(o.refund_nok,0);
 const stock=db.prepare('SELECT * FROM units WHERE id=?').get(u.unit_id);assert.equal(stock.store_id,2);assert.equal(stock.home_store_id,home);assert.equal(stock.needs_cleaning,1);
 assert.equal((await request(`/api/inventory/${u.unit_id}/clean`,'POST',{confirmed:true,note:'完成消毒、清洁与干燥'},tokens.customer)).status,403);
 assert.equal((await request(`/api/inventory/${u.unit_id}/clean`,'POST',{confirmed:true,note:'完成消毒、清洁与干燥'},tokens.staff)).status,403);
 assert.equal((await request(`/api/inventory/${u.unit_id}/clean`,'POST',{confirmed:true,note:'完成消毒、清洁与干燥'},tokens.staff2)).status,200);
 r=await request('/api/operations/return','POST',{reservationId:x.id,returnStoreId:1,items:[{unitId:x.units[1].unitId,condition:'GOOD',note:'完好验收'}]},tokens.staff);assert.equal(r.data.status,'COMPLETED');
 o=await detail(x.id);assert.equal(o.payments.filter(p=>p.type==='REFUND').length,1);assert.ok(o.units.every(u=>u.returned_at));
});

test('租赁中升级与降级即时演示收退，保留其他装备及合同历史，变更幂等',async()=>{
 const x=await active([{variantId:1,qty:1},{variantId:9,qty:1}]),o=await detail(x.id),ski=o.units.find(u=>u.name.includes('双板')),helmet=o.units.find(u=>u.name.includes('头盔'));
 const input={removeUnitIds:[ski.unit_id],addItems:[{variantId:3,qty:1}]};let q=(await request(`/api/reservations/${x.id}/amendments/quote`,'POST',input,tokens.staff)).data;assert.ok(q.netNok>0);
 const proposalId=await approveProposal(x.id,input,q);
 const commit={...input,effectiveAt:q.effectiveAt,baseVersion:q.baseVersion,quoteHash:q.quoteHash,proposalId,reference:'TEST-UPGRADE-001',customerName:'测试顾客',note:'已核实完好归还、检查新增实物并见证顾客纸质签署',paperSigned:true,goodReturnConfirmed:true,newItemsChecked:true,returnStoreId:1};
 assert.equal((await request(`/api/reservations/${x.id}/amendments`,'POST',commit,tokens.customer)).status,403);
 assert.equal((await request(`/api/reservations/${x.id}/amendments`,'POST',{...commit,newItemsChecked:false},tokens.staff)).status,400);
 const saved=await request(`/api/reservations/${x.id}/amendments`,'POST',commit,tokens.staff);assert.equal(saved.status,201,JSON.stringify(saved.data));
 assert.equal((await request(`/api/reservations/${x.id}/amendments`,'POST',commit,tokens.staff)).data.duplicate,true);
 let updated=await detail(x.id);assert.equal(updated.contracts.length,2);assert.equal(updated.contracts[1].snapshot_hash,o.contracts[0].snapshot_hash);assert.equal(updated.units.find(u=>u.unit_id===helmet.unit_id).returned,0);assert.equal(updated.units.find(u=>u.unit_id===ski.unit_id).returned,1);
 const expensive=updated.units.find(u=>!u.returned&&u.name.includes('粉雪')),down={removeUnitIds:[expensive.unit_id],addItems:[{variantId:1,qty:1}]};q=(await request(`/api/reservations/${x.id}/amendments/quote`,'POST',down,tokens.staff)).data;assert.ok(q.netNok<0);
 const downProposalId=await approveProposal(x.id,down,q);
 const done=await request(`/api/reservations/${x.id}/amendments`,'POST',{...commit,...down,effectiveAt:q.effectiveAt,baseVersion:q.baseVersion,quoteHash:q.quoteHash,proposalId:downProposalId,reference:'TEST-DOWNGRADE-002'},tokens.staff);assert.equal(done.status,201,JSON.stringify(done.data));
 updated=await detail(x.id);assert.equal(updated.contracts.length,3);assert.equal(updated.adjustments.length,2);assert.equal(updated.deposit_nok,o.deposit_nok);assert.equal(updated.status,'ACTIVE');
 assert.equal((await request(`/api/reservations/${x.id}/amendments`,'POST',{...commit,reference:'OLD-QUOTE-003'},tokens.staff)).status,409);
});

test('现场开单绑定员工、顾客ID匹配，先见证签署再登记演示付款',async()=>{
 const created=await request('/api/customers','POST',{name:'现场测试顾客',email:'counter@bsr.demo',phone:'+47 9000 9000',address:'测试地址，非真实个人信息',birthYear:2001,heightCm:170,weightKg:65,shoeSize:'EU 40',password:'Test12345!'},tokens.staff);assert.equal(created.status,201,JSON.stringify(created.data));
 assert.equal((await request('/api/customers/search?q=1','GET',undefined,tokens.staff)).data[0].id,1);
 const order=await request('/api/operations/reservations','POST',{customerId:created.data.id,storeId:1,pickupAt:date(200),returnAt:date(201),customerSkill:'高级',items:[{variantId:15,qty:1}],damageConsent:consent},tokens.staff);assert.equal(order.status,201);const id=order.data.id;
 const payment={reference:'DEMO-COUNTER-PAY',confirmed:true};assert.equal((await request(`/api/operations/reservations/${id}/pay`,'POST',payment,tokens.staff)).status,409);
 const contract=(await request(`/api/reservations/${id}/contracts`,'POST',{},tokens.staff)).data;
 assert.equal((await request(`/api/contracts/${contract.id}/sign`,'POST',{name:'现场测试顾客',accepted:true,snapshotHash:contract.snapshot_hash},tokens.staff)).status,400);
 assert.equal((await request(`/api/contracts/${contract.id}/sign`,'POST',{name:'现场测试顾客',accepted:true,snapshotHash:contract.snapshot_hash,paperSigned:true,note:'自动化演示，纸质签署见证不代表真实文件'},tokens.staff)).status,200);
 assert.equal((await request(`/api/operations/reservations/${id}/pay`,'POST',payment,tokens.staff)).status,200);
 const employees=(await request('/api/employee-directory','GET',undefined,tokens.manager)).data;
 const directory=employees.find(e=>e.id===2);assert.ok(directory.contracts_created>=1);assert.ok(directory.attributed_rent_nok>0);assert.ok(!employees.some(e=>e.id===7));
});

test('承包费率按工单创建日冻结，新增费率不回写历史；新门店及采购入库不硬编码',async()=>{
 const first=db.prepare("SELECT id FROM units WHERE variant_id=18 AND store_id=1 AND status='AVAILABLE' LIMIT 1").get();const t1=await request('/api/maintenance','POST',{unitId:first.id,issue:'测试护具接缝异常'},tokens.staff);assert.equal(t1.status,201);assert.equal(db.prepare('SELECT hourly_rate_nok FROM maintenance WHERE id=?').get(t1.data.id).hourly_rate_nok,350);
 const rate=await request('/api/contractor-rates','POST',{contractorId:4,effectiveFrom:new Date().toISOString().slice(0,10),hourlyNok:420,note:'测试新费率依据，不代表真实承包合同'},tokens.manager);assert.equal(rate.status,201);
 assert.equal(db.prepare('SELECT hourly_rate_nok FROM maintenance WHERE id=?').get(t1.data.id).hourly_rate_nok,350);
 const second=db.prepare("SELECT id FROM units WHERE variant_id=19 AND store_id=1 AND status='AVAILABLE' LIMIT 1").get(),t2=await request('/api/maintenance','POST',{unitId:second.id,issue:'测试新工单锁扣检查'},tokens.staff);assert.equal(db.prepare('SELECT hourly_rate_nok FROM maintenance WHERE id=?').get(t2.data.id).hourly_rate_nok,420);
 const store=await request('/api/stores','POST',{name:'第三门店测试站',address:'课程演示地址，不对外营业',subtitle:'扩店验证'},tokens.manager);assert.equal(store.status,201);assert.ok(store.data.id>2);
 const newManager=await request('/api/employee-directory','POST',{name:'第三门店经理',email:'thirdmanager@bsr.demo',password:'Test12345!',role:'manager',storeId:store.data.id},tokens.admin);assert.equal(newManager.status,201,JSON.stringify(newManager.data));
 const newManagerToken=(await request('/api/auth/login','POST',{email:'thirdmanager@bsr.demo',password:'Test12345!'})).data.sessionToken;
 const intake={variantId:3,storeId:store.data.id,inventoryNo:'TEST-INTAKE-0001',purchaseDate:'2026-10-01',purchaseCostNok:5000,retailNok:9000,skill:'高级'};
 assert.equal((await request('/api/inventory','POST',intake,tokens.manager)).status,403);
 const unit=await request('/api/inventory','POST',intake,newManagerToken);assert.equal(unit.status,201,JSON.stringify(unit.data));assert.throws(()=>db.prepare('UPDATE units SET skill_code=? WHERE id=?').run('初级',unit.data.id),/immutable/);
 assert.equal((await request('/api/policies','POST',{variantId:3,storeId:store.data.id,dailyNok:790,effectiveFrom:'2026-10-26',extraDayFactor:.8},newManagerToken)).status,201);
 const q=await request('/api/quote','POST',{storeId:store.data.id,pickupAt:date(230),returnAt:date(231),items:[{variantId:3,qty:1}]});assert.equal(q.status,200);assert.equal(q.data.depositNok,720);
 const foreign=db.prepare("SELECT id FROM units WHERE variant_id=18 AND store_id=2 AND status='AVAILABLE' LIMIT 1").get();
 assert.equal((await request('/api/maintenance','POST',{unitId:foreign.id,issue:'跨店员工不得报故障'},tokens.staff)).status,403);
 const foreignTask=await request('/api/maintenance','POST',{unitId:foreign.id,issue:'北坡门店实物检查异常'},tokens.staff2);assert.equal(foreignTask.status,201);
 assert.equal((await request(`/api/maintenance/${foreignTask.data.id}`,'PATCH',{version:1,action:'assign',contractorId:4},tokens.manager)).status,403);
 assert.ok(!(await request('/api/maintenance','GET',undefined,tokens.manager)).data.some(task=>task.id===foreignTask.data.id));
});

test.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));db.close();rmSync(temp,{recursive:true,force:true});});
