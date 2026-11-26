import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {consent} from './damage-helpers.mjs';
import {prepareAndSign,signBeforePay} from './fulfillment-helpers.mjs';
import {futureDate} from './future-date.mjs';
import {upgradeFulfillment} from '../src/fulfillment-schema.mjs';

const temporaryRoot=resolve(tmpdir());
const temporary=mkdtempSync(join(temporaryRoot,'bsr-016-amendments-'));
process.env.NODE_ENV='test';
process.env.BSR_DB_PATH=join(temporary,'isolated.sqlite');
const {server,db}=await import('../src/server.mjs');
let base;
for(let attempt=0;attempt<10;attempt++){
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  base=`http://127.0.0.1:${server.address().port}`;
  try{await fetch(base+'/api/health');break;}
  catch(error){await new Promise(done=>server.close(done));if(attempt===9)throw error;}
}

async function request(path,method='GET',data,session='',key=''){
  const response=await fetch(base+path,{method,headers:{
    ...(session?{'x-bsr-session':session}:{}),
    ...(data?{'content-type':'application/json'}:{}),
    ...(key?{'Idempotency-Key':key}:{})
  },body:data?JSON.stringify(data):undefined});
  return {status:response.status,data:await response.json()};
}
async function login(email,password='Demo123!'){
  const result=await request('/api/auth/login','POST',{email,password});
  assert.equal(result.status,200,JSON.stringify(result.data));
  return result.data.sessionToken;
}
const customer=await login('customer@bsr.demo');
const staff=await login('staff@bsr.demo');
const staff2=await login('staff2@bsr.demo');
let day=360;
async function activeOrder(){
  day+=4;
  // Each active test order occupies physical gear indefinitely. Provision isolated
  // fixture units so later cases test amendment rules rather than shared demo stock.
  for(const variantId of [1,9,3,3]){
    const skill=db.prepare('SELECT skill FROM variants WHERE id=?').get(variantId).skill;
    db.prepare(`INSERT INTO units(inventory_no,variant_id,store_id,status,skill_code,home_store_id,data_source)
      VALUES(?,?,1,'AVAILABLE',?,1,'016 isolated fixture')`).run(`T016-${randomUUID()}`,variantId,skill);
  }
  const created=await request('/api/reservations','POST',{
    storeId:1,pickupAt:futureDate(day),returnAt:futureDate(day+1),
    customerSkill:'中级',items:[{variantId:1,qty:1},{variantId:9,qty:1}],damageConsent:consent
  },customer,randomUUID());
  assert.equal(created.status,201,JSON.stringify(created.data));
  const id=created.data.id;
  await signBeforePay(request,id,customer);
  const paid=await request(`/api/reservations/${id}/pay`,'POST',{},customer);
  assert.equal(paid.status,200,JSON.stringify(paid.data));
  await prepareAndSign(request,id,staff,customer);
  const picked=await request('/api/operations/pickup','POST',{code:paid.data.pickupCode},staff);
  assert.equal(picked.status,200,JSON.stringify(picked.data));
  const detail=(await request(`/api/reservations/${id}`,'GET',undefined,customer)).data;
  const ski=detail.units.find(unit=>unit.name.includes('双板'));
  assert.ok(ski,'test fixture must contain a rented ski');
  return {id,proposalInput:{removeUnitIds:[ski.unit_id],addItems:[{variantId:3,qty:1}]}};
}
const proposalPath=id=>`/api/reservations/${id}/amendments/proposals`;
const commitPath=id=>`/api/reservations/${id}/amendments`;
async function quoted(order){
  const result=await request(`${commitPath(order.id)}/quote`,'POST',order.proposalInput,staff);
  assert.equal(result.status,200,JSON.stringify(result.data));
  return result.data;
}
async function propose(order,key=randomUUID()){
  const result=await request(proposalPath(order.id),'POST',order.proposalInput,staff,key);
  assert.equal(result.status,201,JSON.stringify(result.data));
  assert.equal(result.data.status,'PENDING');
  assert.equal(result.data.quote.currency,'NOK');
  assert.equal(result.data.quote.baseVersion,db.prepare('SELECT contract_version FROM reservations WHERE id=?').get(order.id).contract_version);
  return result.data;
}
function commitInput(order,quote,proposalId,reference=`TEST-016-${randomUUID()}`){
  return {...order.proposalInput,effectiveAt:quote.effectiveAt,baseVersion:quote.baseVersion,
    quoteHash:quote.quoteHash,proposalId,reference,customerName:'测试顾客',
    note:'已逐件核查并见证纸质合同变更，仅课程演示',paperSigned:true,
    goodReturnConfirmed:true,newItemsChecked:true,returnStoreId:1};
}
function moneyAndStock(id){
  return {
    order:db.prepare('SELECT status,rent_nok,deposit_nok,total_nok,contract_version FROM reservations WHERE id=?').get(id),
    rentals:db.prepare(`SELECT ru.unit_id,ru.returned,ru.returned_at,u.status AS unit_status
      FROM rental_units ru JOIN units u ON u.id=ru.unit_id JOIN reservation_items ri ON ri.id=ru.reservation_item_id
      WHERE ri.reservation_id=? ORDER BY ru.unit_id`).all(id),
    contracts:db.prepare('SELECT COUNT(*) n FROM contracts WHERE reservation_id=?').get(id).n,
    adjustments:db.prepare('SELECT COUNT(*) n FROM contract_adjustments WHERE reservation_id=?').get(id).n,
    inspections:db.prepare('SELECT COUNT(*) n FROM inspections WHERE reservation_id=?').get(id).n
  };
}
function writeCounts(id){return {
  ...moneyAndStock(id),
  audits:db.prepare('SELECT COUNT(*) n FROM audit_log WHERE target_type=? AND target_id=?').get('reservation',id).n,
  notifications:db.prepare('SELECT COUNT(*) n FROM notifications').get().n,
  unitEvents:db.prepare(`SELECT COUNT(*) n FROM stock_events WHERE unit_id IN (
    SELECT ru.unit_id FROM rental_units ru JOIN reservation_items ri ON ri.id=ru.reservation_item_id WHERE ri.reservation_id=?)`).get(id).n
};}

test('employee testimony alone cannot commit; own customer confirms the exact proposal before a single adjustment',async()=>{
  const order=await activeOrder(),quote=await quoted(order);
  const oldStyle=commitInput(order,quote,undefined,'TEST-016-STAFF-ONLY');
  const unchanged=moneyAndStock(order.id);
  const unconfirmed=await request(commitPath(order.id),'POST',oldStyle,staff);
  assert.equal(unconfirmed.status,409,'staff paper witness must not replace customer confirmation');
  assert.deepEqual(moneyAndStock(order.id),unchanged);

  const proposal=await propose(order);
  assert.equal(proposal.quote.quoteHash,quote.quoteHash);
  const path=`${proposalPath(order.id)}/${proposal.id}`;
  assert.equal((await request(path,'GET',undefined,customer)).data.quote.netNok,proposal.quote.netNok);
  assert.equal((await request(`${path}/confirm`,'POST',{
    accepted:true,baseVersion:proposal.quote.baseVersion,quoteHash:proposal.quote.quoteHash
  },staff)).status,403,'employee cannot impersonate customer confirmation');
  assert.equal((await request(commitPath(order.id),'POST',commitInput(order,proposal.quote,proposal.id),staff)).status,409);
  assert.deepEqual(moneyAndStock(order.id),unchanged);

  const accepted={accepted:true,baseVersion:proposal.quote.baseVersion,quoteHash:proposal.quote.quoteHash};
  const confirmation=await request(`${path}/confirm`,'POST',accepted,customer);
  assert.equal(confirmation.status,200,JSON.stringify(confirmation.data));
  assert.equal(confirmation.data.status,'CONFIRMED');
  assert.equal((await request(`${path}/confirm`,'POST',accepted,customer)).data.status,'CONFIRMED','same confirmation replays');
  const payload=commitInput(order,proposal.quote,proposal.id);
  const saved=await request(commitPath(order.id),'POST',payload,staff);
  assert.equal(saved.status,201,JSON.stringify(saved.data));
  assert.equal(saved.data.demo,true);
  assert.equal((await request(path,'GET',undefined,customer)).data.status,'CONSUMED');
  const repeated=await request(commitPath(order.id),'POST',payload,staff);
  assert.equal(repeated.data.duplicate,true);
  assert.equal(moneyAndStock(order.id).adjustments,unchanged.adjustments+1);
});

test('proposal key replay is stable, changed payload conflicts, and another customer/store cannot see or confirm',async()=>{
  const order=await activeOrder(),key=randomUUID();
  const proposal=await propose(order,key);
  const replay=await request(proposalPath(order.id),'POST',order.proposalInput,staff,key);
  assert.equal(replay.status,200);
  assert.equal(replay.data.id,proposal.id);
  const changed=await request(proposalPath(order.id),'POST',{
    ...order.proposalInput,addItems:[{variantId:3,qty:2}]
  },staff,key);
  assert.equal(changed.status,409);
  const otherEmail=`other-${randomUUID()}@bsr.demo`;
  const other=await request('/api/auth/register','POST',{
    name:'其他顾客',email:otherEmail,password:'Test12345!'
  });
  assert.equal(other.status,201,JSON.stringify(other.data));
  const outsider=await login(otherEmail,'Test12345!');
  const path=`${proposalPath(order.id)}/${proposal.id}`;
  assert.equal((await request(path,'GET',undefined,outsider)).status,404);
  assert.equal((await request(`${path}/confirm`,'POST',{
    accepted:true,baseVersion:proposal.quote.baseVersion,quoteHash:proposal.quote.quoteHash
  },outsider)).status,404);
  assert.equal((await request(proposalPath(order.id),'POST',order.proposalInput,staff2,randomUUID())).status,404);
  assert.equal((await request(path,'GET',undefined,staff2)).status,404);
  assert.equal((await request(proposalPath(order.id),'GET',undefined,customer)).data.items[0].id,proposal.id);
  assert.equal((await request(path,'GET',undefined,customer)).data.status,'PENDING');
  assert.equal(moneyAndStock(order.id).adjustments,0);
});

test('wrong quote, rejection, expiry and changed contract version cannot be committed or alter money/stock',async()=>{
  const rejectedOrder=await activeOrder(),rejected=await propose(rejectedOrder);
  const rejectedPath=`${proposalPath(rejectedOrder.id)}/${rejected.id}`;
  const beforeReject=moneyAndStock(rejectedOrder.id);
  assert.equal((await request(`${rejectedPath}/confirm`,'POST',{
    accepted:true,baseVersion:rejected.quote.baseVersion,quoteHash:'incorrect'
  },customer)).status,409);
  assert.deepEqual(moneyAndStock(rejectedOrder.id),beforeReject);
  const denied=await request(`${rejectedPath}/confirm`,'POST',{
    accepted:false,baseVersion:rejected.quote.baseVersion,quoteHash:rejected.quote.quoteHash
  },customer);
  assert.equal(denied.status,200);
  assert.equal(denied.data.status,'REJECTED');
  assert.equal((await request(commitPath(rejectedOrder.id),'POST',
    commitInput(rejectedOrder,rejected.quote,rejected.id),staff)).status,409);
  assert.deepEqual(moneyAndStock(rejectedOrder.id),beforeReject);

  const expiredOrder=await activeOrder(),expired=await propose(expiredOrder);
  db.prepare('UPDATE amendment_proposals SET expires_at=? WHERE id=?').run(new Date(Date.now()-60_000).toISOString(),expired.id);
  const beforeExpiry=moneyAndStock(expiredOrder.id);
  assert.equal((await request(`${proposalPath(expiredOrder.id)}/${expired.id}/confirm`,'POST',{
    accepted:true,baseVersion:expired.quote.baseVersion,quoteHash:expired.quote.quoteHash
  },customer)).status,409);
  assert.equal((await request(commitPath(expiredOrder.id),'POST',
    commitInput(expiredOrder,expired.quote,expired.id),staff)).status,409);
  assert.deepEqual(moneyAndStock(expiredOrder.id),beforeExpiry);

  const staleOrder=await activeOrder(),stale=await propose(staleOrder);
  db.prepare('UPDATE reservations SET contract_version=contract_version+1 WHERE id=?').run(staleOrder.id);
  const beforeStale=moneyAndStock(staleOrder.id);
  assert.equal((await request(`${proposalPath(staleOrder.id)}/${stale.id}/confirm`,'POST',{
    accepted:true,baseVersion:stale.quote.baseVersion,quoteHash:stale.quote.quoteHash
  },customer)).status,409);
  assert.equal((await request(commitPath(staleOrder.id),'POST',
    commitInput(staleOrder,stale.quote,stale.id),staff)).status,409);
  assert.deepEqual(moneyAndStock(staleOrder.id),beforeStale);

  const closedOrder=await activeOrder(),closed=await propose(closedOrder);
  db.prepare("UPDATE reservations SET status='CANCELLED' WHERE id=?").run(closedOrder.id);
  const beforeClosed=moneyAndStock(closedOrder.id);
  assert.equal((await request(`${proposalPath(closedOrder.id)}/${closed.id}/confirm`,'POST',{
    accepted:true,baseVersion:closed.quote.baseVersion,quoteHash:closed.quote.quoteHash
  },customer)).status,409);
  assert.equal((await request(commitPath(closedOrder.id),'POST',
    commitInput(closedOrder,closed.quote,closed.id),staff)).status,409);
  assert.deepEqual(moneyAndStock(closedOrder.id),beforeClosed);
});

test('twelve malformed or unapproved execution attempts leave contract, stock, events and messages untouched',async()=>{
  const order=await activeOrder(),p=await propose(order),path=`${proposalPath(order.id)}/${p.id}`;
  const accepted=await request(`${path}/confirm`,'POST',{
    accepted:true,baseVersion:p.quote.baseVersion,quoteHash:p.quote.quoteHash
  },customer);
  assert.equal(accepted.status,200);
  const valid=commitInput(order,p.quote,p.id);
  const cases=[
    ['different quote hash',{quoteHash:'invalid'}],
    ['different contract version',{baseVersion:p.quote.baseVersion+1}],
    ['different effective time',{effectiveAt:'2035-01-01T00:00:00.000Z'}],
    ['different removed units',{removeUnitIds:[]}],
    ['different added variant',{addItems:[{variantId:4,qty:1}]}],
    ['different added quantity',{addItems:[{variantId:3,qty:2}]}],
    ['different return store',{returnStoreId:2}],
    ['missing paper witness',{paperSigned:false}],
    ['missing return inspection',{goodReturnConfirmed:false}],
    ['missing new gear inspection',{newItemsChecked:false}],
    ['missing signed name',{customerName:''}],
    ['missing witness note',{note:''}]
  ];
  for(const [label,changes] of cases){
    const before=writeCounts(order.id);
    const outcome=await request(commitPath(order.id),'POST',{
      ...valid,...changes,reference:`TEST-016-REJECT-${randomUUID()}`
    },staff);
    assert.ok(outcome.status>=400,`${label}: ${outcome.status} ${JSON.stringify(outcome.data)}`);
    assert.deepEqual(writeCounts(order.id),before,label);
  }
  const executed=await request(commitPath(order.id),'POST',valid,staff);
  assert.equal(executed.status,201,JSON.stringify(executed.data));
});

test('new pending proposal supersedes old pending but never overwrites a confirmed one',async()=>{
  const order=await activeOrder(),first=await propose(order);
  const secondInput={...order.proposalInput,addItems:[{variantId:3,qty:2}]};
  const second=await request(proposalPath(order.id),'POST',secondInput,staff,randomUUID());
  assert.equal(second.status,201,JSON.stringify(second.data));
  assert.equal((await request(`${proposalPath(order.id)}/${first.id}`,'GET',undefined,customer)).data.status,'SUPERSEDED');
  assert.equal((await request(`${proposalPath(order.id)}/${first.id}/confirm`,'POST',{
    accepted:true,baseVersion:first.quote.baseVersion,quoteHash:first.quote.quoteHash
  },customer)).status,409);
  assert.equal((await request(`${proposalPath(order.id)}/${second.data.id}/confirm`,'POST',{
    accepted:true,baseVersion:second.data.quote.baseVersion,quoteHash:second.data.quote.quoteHash
  },customer)).status,200);
  assert.equal((await request(proposalPath(order.id),'POST',order.proposalInput,staff,randomUUID())).status,409);
  assert.equal(moneyAndStock(order.id).adjustments,0);
});

test('late audit failure rolls back a confirmed amendment and permits one safe retry',async()=>{
  const order=await activeOrder(),p=await propose(order);
  const path=`${proposalPath(order.id)}/${p.id}`;
  assert.equal((await request(`${path}/confirm`,'POST',{
    accepted:true,baseVersion:p.quote.baseVersion,quoteHash:p.quote.quoteHash
  },customer)).status,200);
  const payload=commitInput(order,p.quote,p.id),before=writeCounts(order.id);
  db.exec(`CREATE TRIGGER fail_016_amend_audit BEFORE INSERT ON audit_log
    WHEN NEW.action='CONTRACT_AMENDED' BEGIN SELECT RAISE(ABORT,'injected 016 audit failure'); END`);
  try{
    const failed=await request(commitPath(order.id),'POST',payload,staff);
    assert.equal(failed.status,500,JSON.stringify(failed.data));
    assert.deepEqual(writeCounts(order.id),before);
    assert.equal((await request(path,'GET',undefined,customer)).data.status,'CONFIRMED');
  }finally{db.exec('DROP TRIGGER IF EXISTS fail_016_amend_audit');}
  const saved=await request(commitPath(order.id),'POST',payload,staff);
  assert.equal(saved.status,201,JSON.stringify(saved.data));
  assert.equal(moneyAndStock(order.id).adjustments,before.adjustments+1);
  assert.equal((await request(commitPath(order.id),'POST',payload,staff)).data.duplicate,true);
  assert.equal(moneyAndStock(order.id).adjustments,before.adjustments+1);
});

test('parallel proposal and commit retries each yield one row; repeated schema upgrade preserves history',async()=>{
  const order=await activeOrder(),key=randomUUID();
  const proposals=await Promise.all(Array.from({length:3},()=>request(proposalPath(order.id),'POST',order.proposalInput,staff,key)));
  assert.deepEqual(proposals.map(r=>r.status).sort(),[200,200,201]);
  const ids=new Set(proposals.map(r=>r.data.id));assert.equal(ids.size,1);
  const p=proposals[0].data;
  assert.equal((await request(`${proposalPath(order.id)}/${p.id}/confirm`,'POST',{
    accepted:true,baseVersion:p.quote.baseVersion,quoteHash:p.quote.quoteHash
  },customer)).status,200);
  const payload=commitInput(order,p.quote,p.id),results=await Promise.all(Array.from({length:3},()=>request(commitPath(order.id),'POST',payload,staff)));
  assert.deepEqual(results.map(r=>r.status).sort(),[201,201,201]);
  assert.equal(results.filter(r=>r.data.duplicate===true).length,2);
  assert.equal(moneyAndStock(order.id).adjustments,1);
  const history=db.prepare(`INSERT INTO contract_adjustments(reservation_id,reference,base_version,rent_delta_nok,
    deposit_delta_nok,detail_json,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)`).run(
    order.id,`HIST-016-${randomUUID()}`,1,0,0,'{}',2,new Date().toISOString());
  upgradeFulfillment(db,'demo');upgradeFulfillment(db,'demo');
  assert.equal(db.prepare('SELECT proposal_id FROM contract_adjustments WHERE id=?').get(history.lastInsertRowid).proposal_id,null);
  assert.equal(db.prepare('SELECT proposal_id FROM contract_adjustments WHERE reservation_id=? AND proposal_id IS NOT NULL').get(order.id).proposal_id,p.id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM amendment_proposals WHERE reservation_id=?').get(order.id).n,1);
});

test.after(async()=>{
  await new Promise(done=>server.close(done));
  db.close();
  if(!resolve(temporary).startsWith(temporaryRoot+sep))throw new Error('Refusing to remove a non-temporary fixture');
  rmSync(temporary,{recursive:true,force:true});
});
