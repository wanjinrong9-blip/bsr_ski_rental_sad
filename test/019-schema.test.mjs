import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {openDb} from '../src/db.mjs';
import {initializeCandidate} from '../src/runtime-provenance.mjs';
import {readySyntheticSource} from './018-showcase-ready-fixture.mjs';

const expectedTables=['wechat_bindings','mini_login_challenges','mini_code_uses',
  'mini_sessions','mini_quotes','customer_carts','customer_cart_lines'];
const exists=(db,name)=>Boolean(db.prepare(`SELECT name FROM sqlite_master
  WHERE type='table' AND name=?`).get(name));
const tableColumns=(db,name)=>new Set(db.prepare(`PRAGMA table_info(${name})`).all().map(row=>row.name));
const uniqueColumns=(db,name)=>db.prepare(`PRAGMA index_list(${name})`).all()
  .filter(index=>index.unique).map(index=>db.prepare(`PRAGMA index_info(${index.name})`).all()
    .map(column=>column.name));
const rows=db=>db.prepare('SELECT id,quote_json,rent_nok,deposit_nok,total_nok FROM reservations ORDER BY id').all();
const candidateTables=['runtime_installation','stores','users','price_policies','reservations'];
const candidateSnapshot=db=>Object.fromEntries(candidateTables.map(table=>[table,
  db.prepare('SELECT * FROM '+table+' ORDER BY '+(table==='runtime_installation'?'singleton_id':'id')).all()]));
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('019 migration is idempotent and does not rewrite prior DEMO order amounts or policies',()=>{
  const dir=mkdtempSync(join(tmpdir(),'bsr-mini-schema-019-'));
  const path=join(dir,'demo.sqlite');
  try{
    const first=openDb(path);
    const orders=rows(first);
    const policies=first.prepare('SELECT * FROM price_policies ORDER BY id').all();
    const provenance=first.prepare('SELECT * FROM runtime_installation').all();
    for(const table of expectedTables)assert.equal(exists(first,table),true,`missing ${table}`);
    first.close();
    for(let i=0;i<2;i++){
      const db=openDb(path);
      assert.deepEqual(rows(db),orders);
      assert.deepEqual(db.prepare('SELECT * FROM price_policies ORDER BY id').all(),policies);
      assert.deepEqual(db.prepare('SELECT * FROM runtime_installation').all(),provenance);
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
      assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
      db.close();
    }
  }finally{rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

test('older CANDIDATE gains 019 tables without changing prior rows or source',()=>{
  const dir=mkdtempSync(join(tmpdir(),'bsr-mini-old-candidate-019-'));
  const path=join(dir,'candidate.sqlite');
  try{
    initializeCandidate({runMode:'candidate',dbPath:path},{
      operator:'019-candidate-migration',name:'虚构候选管理员',
      email:'candidate-019@example.test',password:'Private#Candidate0192026'
    });
    const old=openDb(path,{runMode:'candidate'});
    let original,hash,counts;
    try{
      old.prepare(`INSERT INTO stores(name,subtitle,address,open_hours)
        VALUES('虚构候选门店','仅迁移测试','虚构地址','09:00–16:00')`).run();
      original=candidateSnapshot(old);
      hash=digest(original);
      counts=Object.fromEntries(candidateTables.map(table=>[table,original[table].length]));
      old.exec(`DROP TABLE mini_sessions; DROP TABLE mini_login_challenges;
        DROP TABLE mini_code_uses; DROP TABLE mini_quotes;
        DROP TABLE wechat_bindings; DROP TABLE customer_cart_lines;
        DROP TABLE customer_carts;`);
    }finally{old.close();}
    for(let pass=0;pass<2;pass++){
      const upgraded=openDb(path,{runMode:'candidate'});
      try{
        for(const table of expectedTables)assert.equal(exists(upgraded,table),true,table);
        const current=candidateSnapshot(upgraded);
        assert.equal(digest(current),hash);
        assert.deepEqual(Object.fromEntries(candidateTables.map(table=>[table,current[table].length])),
          counts);
        assert.equal(upgraded.prepare(`SELECT run_mode FROM runtime_installation
          WHERE singleton_id=1`).get().run_mode,'CANDIDATE');
        assert.equal(upgraded.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
        assert.equal(upgraded.prepare('PRAGMA foreign_key_check').all().length,0);
      }finally{upgraded.close();}
    }
  }finally{
    if(!resolve(dir).startsWith(resolve(tmpdir())+sep))
      throw new Error('Refuse to remove a test directory outside OS temp');
    rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});

test('identity migration creates separated private records and unique active binding keys in SHOWCASE',()=>{
  const dir=mkdtempSync(join(tmpdir(),'bsr-mini-schema-019-'));
  const path=join(dir,'showcase.sqlite');
  try{
    readySyntheticSource(path);
    const db=openDb(path,{runMode:'showcase'});
    for(const table of expectedTables)assert.equal(exists(db,table),true,`missing ${table}`);
    const bindings=tableColumns(db,'wechat_bindings');
    for(const column of ['app_id','openid_digest','user_id','bound_at','unbound_at'])
      assert.equal(bindings.has(column),true,`wechat_bindings missing ${column}`);
    const challenges=tableColumns(db,'mini_login_challenges');
    for(const column of ['challenge_hash','app_id','openid_digest','expires_at','consumed_at'])
      assert.equal(challenges.has(column),true,`mini_login_challenges missing ${column}`);
    const sessions=tableColumns(db,'mini_sessions');
    for(const column of ['token_hash','binding_id','user_id','expires_at','auth_epoch','revoked_at'])
      assert.equal(sessions.has(column),true,`mini_sessions missing ${column}`);
    const indexes=uniqueColumns(db,'wechat_bindings');
    assert.equal(indexes.some(columns=>['app_id','openid_digest'].every(c=>columns.includes(c))),true,
      'active AppID/OpenID pair needs a unique index');
    assert.equal(indexes.some(columns=>['app_id','user_id'].every(c=>columns.includes(c))),true,
      'one customer cannot have two active bindings for one AppID');
    for(const name of ['idx_wechat_bindings_openid_active',
      'idx_wechat_bindings_customer_active']){
      const sql=db.prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name=?`)
        .get(name)?.sql;
      assert.match(sql,/WHERE\s+unbound_at\s+IS\s+NULL/i,
        'historical unbound rows must not block a fresh binding');
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mini_sessions').get().n,0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,0);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
    db.close();
  }finally{rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
