import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {consent} from './damage-helpers.mjs';
import {futureDate} from './future-date.mjs';

const temp=mkdtempSync(join(tmpdir(),'bsr-expired-hold-'));
process.env.NODE_ENV='test';process.env.BSR_DB_PATH=join(temp,'orders.sqlite');
const {server,db}=await import('../src/server.mjs');
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
async function request(path,method='GET',data,token='',key){
 const response=await fetch(base+path,{method,headers:{...(token?{'x-bsr-session':token}:{}),...(key?{'Idempotency-Key':key}:{}),...(data?{'content-type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});
 return {status:response.status,data:await response.json()};
}
const payload={storeId:1,pickupAt:futureDate(70),returnAt:futureDate(71),customerSkill:'中级',items:[{variantId:1,qty:1}],damageConsent:consent};

test('暂留到期在所有读取路径一致可见，释放库存且不修改历史行',async()=>{
 const login=await request('/api/auth/login','POST',{email:'customer@bsr.demo',password:'Demo123!'});
 assert.equal(login.status,200);
 const token=login.data.sessionToken,key='expired-hold-visible-001';
 const catalogPath=`/api/catalog?storeId=1&pickupAt=${encodeURIComponent(payload.pickupAt)}&returnAt=${encodeURIComponent(payload.returnAt)}`;
 const before=(await request(catalogPath)).data.items.find(item=>item.id===1).available;
 const created=await request('/api/reservations','POST',payload,token,key);
 assert.equal(created.status,201,JSON.stringify(created.data));
 const id=created.data.id,original=db.prepare('SELECT code,status,rent_nok,deposit_nok,hold_expires_at,quote_json FROM reservations WHERE id=?').get(id);
 assert.equal((await request(catalogPath)).data.items.find(item=>item.id===1).available,before-1);
 db.prepare('UPDATE reservations SET hold_expires_at=? WHERE id=?').run(new Date(Date.now()-60000).toISOString(),id);
 const expired=(await request(`/api/reservations/${id}`,'GET',undefined,token)).data;
 assert.equal(expired.status,'EXPIRED');assert.equal(expired.workflow.currentKey,'EXPIRED');
 assert.equal(expired.workflow.handler.name,'林雪');
 assert.equal(expired.rent_nok,original.rent_nok);assert.equal(expired.deposit_nok,original.deposit_nok);
 assert.equal((await request('/api/reservations','GET',undefined,token)).data.find(order=>order.id===id).status,'EXPIRED');
 assert.equal((await request(catalogPath)).data.items.find(item=>item.id===1).available,before);
 const auditBefore=db.prepare("SELECT COUNT(*) n FROM audit_log WHERE target_type='reservation' AND target_id=?").get(id).n;
 const replay=await request('/api/reservations','POST',payload,token,key);
 assert.equal(replay.status,200);assert.equal(replay.data.status,'EXPIRED');assert.equal(replay.data.id,id);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE target_type='reservation' AND target_id=?").get(id).n,auditBefore);
 assert.equal(db.prepare('SELECT status,quote_json FROM reservations WHERE id=?').get(id).status,'HOLD');
 assert.equal(db.prepare('SELECT quote_json FROM reservations WHERE id=?').get(id).quote_json,original.quote_json);
 assert.equal((await request(`/api/reservations/${id}/pay`,'POST',{},token)).status,409);
 assert.equal((await request(`/api/reservations/${id}/contracts`,'POST',{},token)).status,409);
 assert.equal((await request(`/api/reservations/${id}/cancel`,'POST',{},token)).status,409);
 assert.equal(db.prepare('SELECT status FROM reservations WHERE id=?').get(id).status,'HOLD');
 const fresh=await request('/api/reservations','POST',payload,token,'expired-hold-new-intent-002');
 assert.equal(fresh.status,201,JSON.stringify(fresh.data));assert.notEqual(fresh.data.id,id);
 assert.equal(fresh.data.status,'HOLD');
});

test.after(()=>{server.close();db.close();rmSync(temp,{recursive:true,force:true});});
