import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {openDb,CANDIDATE_SCHEMA_VERSION} from '../src/db.mjs';
import {initializeCandidate,preflightRuntime} from '../src/runtime-provenance.mjs';

const base=resolve('test-results');
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
function isolated(){
  const dir=mkdtempSync(join(base,'candidate-source-'));
  return {path:join(dir,'source.sqlite'),cleanup(){
    if(!resolve(dir).startsWith(base+sep))throw new Error('unsafe cleanup path');
    rmSync(dir,{recursive:true,force:true});
  }};
}
const admin={operator:'provenance-test',name:'First Admin',email:'first@example.test',password:'UniqueSource#2026A'};
const checkUnchanged=(path,expected)=>{
  assert.equal(hash(path),expected);
  assert.equal(existsSync(path+'-wal'),false);
  assert.equal(existsSync(path+'-shm'),false);
};

test('unmarked historical database is blocked without any source mutation',()=>{
  const f=isolated();
  try{
    const legacy=new DatabaseSync(f.path);
    legacy.exec('CREATE TABLE historical_order(id INTEGER PRIMARY KEY, rent_nok INTEGER NOT NULL)');
    legacy.prepare('INSERT INTO historical_order(rent_nok) VALUES(?)').run(1250);
    legacy.close();
    const before=hash(f.path);
    assert.throws(()=>preflightRuntime({runMode:'candidate',dbPath:f.path}),{code:'SOURCE_UNMARKED'});
    checkUnchanged(f.path,before);
    const source=new DatabaseSync(f.path,{readOnly:true});
    assert.equal(source.prepare('SELECT rent_nok FROM historical_order').get().rent_nok,1250);
    source.close();
  }finally{f.cleanup();}
});

test('newer and mixed candidate sources are rejected without mutation',()=>{
  for(const variant of ['newer','mixed']){
    const f=isolated();
    try{
      initializeCandidate({runMode:'candidate',dbPath:f.path},admin);
      const db=openDb(f.path,{runMode:'candidate'});
      if(variant==='newer')db.prepare('UPDATE runtime_installation SET schema_version=?').run(CANDIDATE_SCHEMA_VERSION+1);
      else db.prepare(`INSERT INTO users(name,email,password_hash,role,created_at)
        VALUES('Demo User','customer@bsr.demo','not-a-real-hash','customer',?)`).run(new Date().toISOString());
      db.close();
      const before=hash(f.path);
      assert.throws(()=>preflightRuntime({runMode:'candidate',dbPath:f.path}),
        {code:variant==='newer'?'SOURCE_NEWER_VERSION':'SOURCE_DEMO_MIXED'});
      checkUnchanged(f.path,before);
    }finally{f.cleanup();}
  }
});
