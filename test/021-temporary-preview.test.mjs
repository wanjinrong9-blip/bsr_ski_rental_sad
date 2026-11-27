import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {prepareTemporaryPreview,previewCredentials} from '../tools/temporary-preview-setup.mjs';
import {openDb,verifyPassword} from '../src/db.mjs';
import {preflightRuntime} from '../src/runtime-provenance.mjs';
const env=()=>({BSR_TEMPORARY_PREVIEW:'1',BSR_RUN_MODE:'showcase',
  RENDER_EXTERNAL_URL:'https://bsr-test.onrender.com',BSR_PREVIEW_SEED:randomBytes(32).toString('hex'),PORT:'10000'});
function fixture(fn){const dir=mkdtempSync(join(tmpdir(),'bsr-temporary-'));try{return fn(dir);}finally{rmSync(dir,{recursive:true,force:true});}}

test('temporary bootstrap refuses demo, weak seed and non-Render origins before creating files',()=>fixture(dir=>{
  for(const change of [{BSR_RUN_MODE:'demo'},{BSR_TEMPORARY_PREVIEW:'0'},
    {BSR_PREVIEW_SEED:'0'.repeat(64)},{RENDER_EXTERNAL_URL:'http://bsr-test.onrender.com'},
    {RENDER_EXTERNAL_URL:'https://bsr-test.onrender.com.evil.test'},
    {RENDER_EXTERNAL_URL:'https://bsr-test.onrender.com/path'}]){
    const runtime=join(dir,'not-created');
    assert.throws(()=>prepareTemporaryPreview({...env(),...change},{runtimeDir:runtime}));
    assert.equal(existsSync(runtime),false);
  }
}));
test('temporary preview has six distinct rotated synthetic accounts and 48 units',()=>fixture(dir=>{
  const input=env(),{config,credentials}=prepareTemporaryPreview(input,{runtimeDir:dir});
  assert.equal(config.host,'127.0.0.1');assert.equal(config.port,4175);
  assert.equal(input.BSR_MINI_ENTRY_STATE,'OFF');
  assert.equal(new Set(credentials.map(row=>row.password)).size,6);
  assert.deepEqual(credentials,previewCredentials(input.BSR_PREVIEW_SEED));
  const db=openDb(config.dbPath,{runMode:'showcase'});
  try{
    assert.equal(db.prepare('SELECT COUNT(*) n FROM units').get().n,48);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n,6);
    for(const credential of credentials){
      const user=db.prepare('SELECT * FROM users WHERE email=?').get(credential.email);
      assert.equal(user.role,credential.role);assert.equal(user.must_change_password,0);
      assert.equal(verifyPassword(credential.password,user.password_hash),true);
      assert.equal(verifyPassword('Demo123!',user.password_hash),false);
    }
  }finally{db.close();}
  assert.equal(preflightRuntime(config).status,'ready');
}));
test('restart preserves edited data; changed seed refuses to rewrite existing accounts',()=>fixture(dir=>{
  const input=env(),first=prepareTemporaryPreview(input,{runtimeDir:dir});
  const db=openDb(first.config.dbPath,{runMode:'showcase'});
  db.prepare("UPDATE users SET name='虚构已编辑顾客' WHERE role='customer'").run();db.close();
  const second=prepareTemporaryPreview(input,{runtimeDir:dir});
  assert.equal(preflightRuntime(first.config).instanceId,preflightRuntime(second.config).instanceId);
  const check=openDb(first.config.dbPath,{runMode:'showcase'});
  assert.equal(check.prepare("SELECT name FROM users WHERE role='customer'").get().name,'虚构已编辑顾客');check.close();
  assert.throws(()=>prepareTemporaryPreview({...input,BSR_PREVIEW_SEED:randomBytes(32).toString('hex')},{runtimeDir:dir}),/禁止重置/);
}));
