import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {Worker} from 'node:worker_threads';
import {openDb} from '../src/db.mjs';
import {preflightRuntime,initializeCandidate} from '../src/runtime-provenance.mjs';

const base=resolve('test-results');
mkdirSync(base,{recursive:true});
function fixture(){
  const dir=mkdtempSync(join(base,'candidate-data-'));
  const cleanup=()=>{
    if(!resolve(dir).startsWith(base+sep))throw new Error('Refusing to remove data outside test-results');
    rmSync(dir,{recursive:true,force:true});
  };
  return {dir,dbPath:join(dir,'candidate.sqlite'),cleanup};
}
const digest=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const admin={operator:'course-operator',name:'Initial Administrator',email:'initial@example.test',password:'UniqueCandidate123!'};

test('new candidate initializes exactly one admin and zero demo business records',()=>{
  const f=fixture();
  try{
    const config={runMode:'candidate',dbPath:f.dbPath};
    assert.deepEqual(preflightRuntime(config),{status:'needs_init',runMode:'candidate'});
    assert.equal(existsSync(f.dbPath),false);
    const created=initializeCandidate(config,admin);
    assert.equal(created.status,'ready');
    const beforePreflight=digest(f.dbPath);
    const hadWal=existsSync(f.dbPath+'-wal'),hadShm=existsSync(f.dbPath+'-shm');
    assert.equal(preflightRuntime(config,{requireReady:true}).status,'ready');
    assert.equal(digest(f.dbPath),beforePreflight);
    assert.equal(existsSync(f.dbPath+'-wal'),hadWal);
    assert.equal(existsSync(f.dbPath+'-shm'),hadShm);
    const db=openDb(f.dbPath,{runMode:'candidate'});
    try{
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users").get().n,1);
      assert.equal(db.prepare("SELECT role,provisioning_method,account_state FROM users").get().role,'admin');
      for(const table of ['stores','variants','units','price_policies','reservations','payments','damage_photos'])
        assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,0,table);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM initial_admin_event').get().n,1);
    }finally{db.close();}
    assert.throws(()=>initializeCandidate(config,admin),/已经初始化/);
    assert.throws(()=>openDb(f.dbPath),/候选数据空间不能以演示用途打开/);
  }finally{f.cleanup();}
});

test('bad bootstrap secret does not create a database or directory',()=>{
  const f=fixture();
  try{
    const path=join(f.dir,'new','candidate.sqlite');
    assert.throws(()=>initializeCandidate({runMode:'candidate',dbPath:path},{...admin,password:'Demo123!'}),/非预置强凭据/);
    assert.equal(existsSync(path),false);
    assert.equal(existsSync(join(f.dir,'new')),false);
  }finally{f.cleanup();}
});

test('demo database cannot be promoted and stays byte-for-byte unchanged',()=>{
  const f=fixture();
  try{
    const db=openDb(f.dbPath);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n>0,true);
    db.close();
    const before=digest(f.dbPath);
    assert.throws(()=>preflightRuntime({runMode:'candidate',dbPath:f.dbPath}),/演示或其他数据空间/);
    assert.equal(digest(f.dbPath),before);
  }finally{f.cleanup();}
});

test('interrupted candidate schema cannot restart as an unmarked installation',()=>{
  const f=fixture();
  try{
    const interrupted=openDb(f.dbPath,{runMode:'candidate',initialize:true});
    interrupted.close();
    const before=digest(f.dbPath);
    assert.throws(()=>preflightRuntime({runMode:'candidate',dbPath:f.dbPath}),{code:'SOURCE_UNMARKED'});
    assert.throws(()=>initializeCandidate({runMode:'candidate',dbPath:f.dbPath},admin),{code:'SOURCE_UNMARKED'});
    assert.equal(digest(f.dbPath),before);
    const check=new DatabaseSync(f.dbPath,{readOnly:true});
    try{assert.equal(check.prepare('SELECT COUNT(*) n FROM users').get().n,0);}finally{check.close();}
  }finally{f.cleanup();}
});

test('two simultaneous candidate initializers never create a second initial admin',async()=>{
  const f=fixture(),start=new SharedArrayBuffer(4),workers=[];
  try{
    const run=()=>new Promise((resolve,reject)=>{
      const worker=new Worker(new URL('./candidate-init-worker.mjs',import.meta.url),{
        workerData:{path:f.dbPath,admin,start}});
      workers.push(worker);
      let ready=false;
      worker.on('message',message=>{
        if(message.ready){ready=true;resolve({worker,result:new Promise((complete)=>worker.once('message',complete))});}
      });
      worker.on('error',reject);
      worker.on('exit',code=>{if(!ready)reject(new Error(`worker exited ${code}`));});
    });
    const participants=await Promise.all([run(),run()]);
    Atomics.store(new Int32Array(start),0,1);Atomics.notify(new Int32Array(start),0,2);
    const outcomes=await Promise.all(participants.map(item=>item.result));
    assert.equal(outcomes.filter(item=>item.ok).length,1,JSON.stringify(outcomes));
    assert.equal(preflightRuntime({runMode:'candidate',dbPath:f.dbPath},{requireReady:true}).status,'ready');
    const db=openDb(f.dbPath,{runMode:'candidate'});
    try{
      assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n,1);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM initial_admin_event').get().n,1);
    }finally{db.close();}
  }finally{
    await Promise.allSettled(workers.map(worker=>worker.terminate()));
    f.cleanup();
  }
});
