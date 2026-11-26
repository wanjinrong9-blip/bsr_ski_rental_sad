import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {makeCandidateFixture,candidateRequest} from './candidate-fixtures.mjs';
import {validateRuntimeConfig} from '../src/runtime-config.mjs';
import {initializeCandidate} from '../src/runtime-provenance.mjs';
import {hashPassword,openDb} from '../src/db.mjs';

const root=resolve(import.meta.dirname,'..');
const publicDir=join(root,'public');
const serverPath=join(root,'src','server.mjs');
const now='2026-11-16T10:00:00.000Z';
const accounts=[
  ['customer1','customer','customer1@example.test',null],
  ['customer2','customer','customer2@example.test',null],
  ['staff1','staff','staff1@example.test',1],
  ['staff2','staff','staff2@example.test',2],
  ['manager1','manager','manager1@example.test',1],
  ['manager2','manager','manager2@example.test',2],
  ['tech1','contractor','tech1@example.test',null],
  ['tech2','contractor','tech2@example.test',null],
  ['owner','owner','owner@example.test',null]
];
const password=alias=>`${alias}Strong#2026A`;
const cookieOf=response=>response.headers['set-cookie'][0].split(';')[0];

function seedCandidate(db){
  db.prepare('INSERT INTO stores(id,name,subtitle,address,open_hours) VALUES(?,?,?,?,?)')
    .run(1,'North Test','Synthetic','North Test Address','09:00–16:00');
  db.prepare('INSERT INTO stores(id,name,subtitle,address,open_hours) VALUES(?,?,?,?,?)')
    .run(2,'South Test','Synthetic','South Test Address','09:00–16:00');
  const ids={};
  for(const [alias,role,email,storeId] of accounts){
    ids[alias]=Number(db.prepare(`INSERT INTO users(name,email,password_hash,role,store_id,created_at,
      account_state,provisioning_method,verified_at,must_change_password)
      VALUES(?,?,?,?,?,?,'ACTIVE','OFFLINE_ADMIN',?,0)`)
      .run(alias,email,hashPassword(password(alias)),role,storeId,now,now).lastInsertRowid);
  }
  db.prepare('INSERT INTO variants(id,name,category,style,size,skill,description,visual) VALUES(?,?,?,?,?,?,?,?)')
    .run(1,'Synthetic Ski','ski','test','170 cm','beginner','test only','ski');
  db.prepare('INSERT INTO units(id,inventory_no,variant_id,store_id,status) VALUES(?,?,?,?,?)')
    .run(1,'CANDIDATE-TEST-UNIT-1',1,1,'MAINTENANCE');
  const insertOrder=db.prepare(`INSERT INTO reservations(code,user_id,store_id,pickup_at,return_at,status,
    rent_nok,deposit_nok,total_nok,pickup_code,quote_json,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  insertOrder.run('CANDIDATE-TEST-ORDER-1',ids.customer1,1,'2026-12-05T09:00:00Z','2026-12-06T16:00:00Z',
    'REVIEW',100,8,108,'CANDIDATE-TEST-PICK-1','{}',now);
  insertOrder.run('CANDIDATE-TEST-ORDER-2',ids.customer2,2,'2026-12-07T09:00:00Z','2026-12-08T16:00:00Z',
    'HOLD',120,10,130,'CANDIDATE-TEST-PICK-2','{}',now);
  const snapshot=JSON.stringify({customerId:ids.customer1,customer:{name:'customer1',email:'customer1@example.test',phone:''},
    skill:'初级',channel:'COUNTER_MANUAL',employee:{id:ids.staff1,name:'staff1'},store:'North Test',days:2,
    pickupAt:'2026-12-05T09:00:00Z',returnAt:'2026-12-06T16:00:00Z',lines:[],rentNok:100,depositNok:8,
    totalNok:108,adjustments:[],terms:'Synthetic candidate access test; not a signed commercial contract.'});
  db.prepare(`INSERT INTO contracts(id,reservation_id,code,version,created_by,created_at,snapshot_json,snapshot_hash)
    VALUES(1,1,'CANDIDATE-TEST-CONTRACT',1,?,?,?,?)`)
    .run(ids.staff1,now,snapshot,'synthetic-snapshot-hash');
  db.prepare(`INSERT INTO maintenance(id,unit_id,contractor_id,store_id,issue,status,created_at,updated_at)
    VALUES(1,1,?,1,'Synthetic edge damage','ASSIGNED',?,?)`).run(ids.tech1,now,now);
  db.prepare(`INSERT INTO inspections(id,reservation_id,unit_id,condition,note,inspected_by,created_at)
    VALUES(1,1,1,'DAMAGED','Synthetic inspection',?,?)`).run(ids.staff1,now);
  db.prepare(`INSERT INTO damage_cases(id,inspection_id,reservation_id,unit_id,maintenance_id,assessor_id,
    status,part,created_at) VALUES(1,1,1,1,1,?,'DRAFT','Edge',?)`).run(ids.tech1,now);
  db.prepare(`INSERT INTO damage_photos(id,case_id,uploaded_by,part,caption,mime,image,created_at)
    VALUES(1,1,?,'Edge','Synthetic evidence','image/png',?,?)`)
    .run(ids.tech1,Buffer.from([137,80,78,71,13,10,26,10]),now);
  return ids;
}

test('candidate HTTPS enforces two-customer, two-store and technician object boundaries',async()=>{
  const fixture=await makeCandidateFixture('bsr-candidate-objects-');
  let child;
  try{
    const config=validateRuntimeConfig(fixture.env,{root,publicDir});
    initializeCandidate(config,{operator:'object-test',name:'Initial Admin',
      email:'admin@example.test',password:'AdminStrong#2026A'});
    const db=openDb(fixture.dbPath,{runMode:'candidate'});
    let ids;
    try{ids=seedCandidate(db);}finally{db.close();}
    child=spawn(process.execPath,[serverPath],{cwd:root,env:{...process.env,...fixture.env,NODE_ENV:'local'},
      stdio:['ignore','pipe','pipe'],windowsHide:true});
    let stderr='';child.stdout.resume();child.stderr.setEncoding('utf8');child.stderr.on('data',part=>{stderr+=part;});
    let ready=false;
    for(let i=0;i<120;i++){
      if(child.exitCode!==null)break;
      try{if((await candidateRequest(fixture,'/api/health')).status===200){ready=true;break;}}catch{}
      await new Promise(resolve=>setTimeout(resolve,40));
    }
    assert.equal(ready,true,'candidate server failed to start: '+stderr);
    const cookies={};
    for(const [alias,,email] of accounts){
      const response=await candidateRequest(fixture,'/api/auth/login',{
        method:'POST',headers:{Origin:fixture.origin},body:{email,password:password(alias)}});
      assert.equal(response.status,200,alias+': '+JSON.stringify(response.data));
      cookies[alias]=cookieOf(response);
    }
    const admin=await candidateRequest(fixture,'/api/auth/login',{
      method:'POST',headers:{Origin:fixture.origin},body:{email:'admin@example.test',password:'AdminStrong#2026A'}});
    assert.equal(admin.status,200);cookies.admin=cookieOf(admin);
    const get=(alias,path)=>candidateRequest(fixture,path,{headers:{Cookie:cookies[alias]}});
    for(const alias of ['customer1','staff1','manager1'])
      assert.equal((await get(alias,'/api/reservations/1')).status,200,alias+' own order');
    for(const alias of ['customer2','staff2','manager2'])
      assert.equal((await get(alias,'/api/reservations/1')).status,404,alias+' outside order');
    for(const alias of ['customer1','staff1','manager1']){
      assert.equal((await get(alias,'/api/reservations/1/contracts')).status,200,alias+' own contract');
      assert.equal((await get(alias,'/api/contracts/1/print')).status,200,alias+' own printable contract');
    }
    for(const alias of ['customer2','staff2','manager2']){
      assert.equal((await get(alias,'/api/reservations/1/contracts')).status,404,alias+' outside contract');
      assert.equal((await get(alias,'/api/contracts/1/print')).status,404,alias+' outside printable contract');
    }
    assert.equal((await get('customer2','/api/reservations/2')).status,200);
    for(const alias of ['owner','admin']){
      assert.equal((await get(alias,'/api/reservations/1')).status,403);
      assert.equal((await get(alias,'/api/reports')).status,200);
      const summary=await get(alias,'/api/inventory');
      assert.equal(summary.status,200);
      assert.ok(!JSON.stringify(summary.data).includes('CANDIDATE-TEST-UNIT-1'));
    }
    for(const alias of ['customer1','staff1','manager1','tech1']){
      assert.equal((await get(alias,'/api/damage-cases/1')).status,200,alias+' own damage');
      assert.equal((await get(alias,'/api/damage-photos/1')).status,200,alias+' own photo');
    }
    for(const alias of ['customer2','staff2','manager2','tech2']){
      assert.equal((await get(alias,'/api/damage-cases/1')).status,404,alias+' outside damage');
      assert.equal((await get(alias,'/api/damage-photos/1')).status,404,alias+' outside photo');
    }
    const assigned=await get('tech1','/api/maintenance'),unassigned=await get('tech2','/api/maintenance');
    assert.equal(assigned.status,200);assert.equal(unassigned.status,200);
    assert.deepEqual(assigned.data.map(row=>row.id),[1]);assert.deepEqual(unassigned.data,[]);
    const denied=await candidateRequest(fixture,'/api/maintenance/1',{
      method:'PATCH',headers:{Origin:fixture.origin,Cookie:cookies.tech2},
      body:{version:1,action:'note',note:'Outside technician must be denied'}});
    assert.equal(denied.status,403);
    const otherStore=await candidateRequest(fixture,'/api/maintenance/1',{
      method:'PATCH',headers:{Origin:fixture.origin,Cookie:cookies.manager2},
      body:{version:1,action:'note',note:'Outside store manager must be denied'}});
    assert.equal(otherStore.status,403);
    const permitted=await candidateRequest(fixture,'/api/maintenance/1',{
      method:'PATCH',headers:{Origin:fixture.origin,Cookie:cookies.tech1},
      body:{version:1,action:'note',note:'Assigned technician can record work'}});
    assert.equal(permitted.status,200,JSON.stringify(permitted.data));
    const after=openDb(fixture.dbPath,{runMode:'candidate'});
    try{
      assert.equal(after.prepare('SELECT contractor_id FROM maintenance WHERE id=1').get().contractor_id,ids.tech1);
      assert.equal(after.prepare('SELECT COUNT(*) AS n FROM maintenance_events WHERE maintenance_id=1').get().n,1);
    }finally{after.close();}
  }finally{
    if(child&&child.exitCode===null){const closed=new Promise(resolve=>child.once('close',resolve));child.kill();await closed;}
    fixture.cleanup();
  }
});
