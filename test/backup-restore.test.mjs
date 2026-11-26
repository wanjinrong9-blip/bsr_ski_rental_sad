import test from 'node:test';
import assert from 'node:assert/strict';
import {appendFileSync,copyFileSync,mkdtempSync,readFileSync,rmSync,existsSync,readdirSync,statSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createVerifiedBackup,verifyBackup} from '../tools/backup-verify.mjs';
import {openDb} from '../src/db.mjs';

const temp=mkdtempSync(join(tmpdir(),'bsr-backup-test-'));
const sourcePath=join(temp,'source.sqlite'),outputDir=join(temp,'backups');

test('在线 WAL 备份含已提交记录和 BLOB，隔离恢复后原库可继续写入',async()=>{
 const live=openDb(sourcePath);
 try{
  live.exec('PRAGMA wal_autocheckpoint=0');
  live.exec('CREATE TABLE backup_probe(id INTEGER PRIMARY KEY,private_blob BLOB NOT NULL)');
  const content=Buffer.from('private synthetic assessment image bytes');
  live.prepare('INSERT INTO backup_probe(private_blob) VALUES(?)').run(content);
  assert.ok(statSync(sourcePath+'-wal').size>0);
  const result=await createVerifiedBackup({sourcePath,outputDir});
  assert.equal(result.integrity,'ok');assert.equal(result.foreignKeyErrors,0);assert.equal(result.restoreDrill,'PASS');
  assert.ok(existsSync(result.backupPath)&&existsSync(result.manifestPath));
  assert.deepEqual(readdirSync(outputDir).sort(),[result.backupPath.split(/[\\/]/).at(-1),result.manifestPath.split(/[\\/]/).at(-1)].sort(),
   '成功备份只发布数据库与清单，不遗留临时 SQLite/WAL/SHM');
  const manifest=JSON.parse(readFileSync(result.manifestPath,'utf8'));
  assert.deepEqual((await verifyBackup(result.backupPath,manifest)).counts,result.counts);
  live.prepare('INSERT INTO backup_probe(private_blob) VALUES(?)').run(Buffer.from('later write'));
  const restored=new DatabaseSync(result.backupPath,{readOnly:true});
  try{
   assert.equal(restored.prepare('SELECT COUNT(*) n FROM backup_probe').get().n,1);
   assert.deepEqual(Buffer.from(restored.prepare('SELECT private_blob FROM backup_probe').get().private_blob),content);
  }finally{restored.close();}
  await assert.rejects(verifyBackup(result.backupPath,{...manifest,sha256:'0'.repeat(64)}),/SHA-256/);
  const altered=join(temp,'altered.sqlite');copyFileSync(result.backupPath,altered);appendFileSync(altered,'changed');
  await assert.rejects(verifyBackup(altered,manifest),/SHA-256/);
 }finally{live.close();}
});

test('错误源与公开目录拒绝发布备份',async()=>{
 const missing=join(temp,'missing.sqlite'),empty=join(temp,'empty');
 await assert.rejects(createVerifiedBackup({sourcePath:missing,outputDir:empty}));
 assert.ok(!existsSync(empty)||readdirSync(empty).length===0);
 const invalid=join(temp,'invalid.sqlite'),failedOutput=join(temp,'failed-backups');
 writeFileSync(invalid,'not a sqlite database');
 await assert.rejects(createVerifiedBackup({sourcePath:invalid,outputDir:failedOutput}));
 assert.deepEqual(readdirSync(failedOutput),[],'失败备份不遗留临时目录或部分成果');
 await assert.rejects(createVerifiedBackup({sourcePath,outputDir:join(process.cwd(),'public','backups')}),/静态资源目录/);
});

test('公开目录链接不能将未创建的备份子目录导入静态资源',async()=>{
 const link=join(temp,'public-link');
 const destination=join(process.cwd(),'public','backup-link-test');
 symlinkSync(join(process.cwd(),'public'),link,process.platform==='win32'?'junction':'dir');
 assert.equal(existsSync(destination),false);
 await assert.rejects(createVerifiedBackup({sourcePath:join(temp,'does-not-matter.sqlite'),outputDir:join(link,'backup-link-test')}),/静态资源目录/);
 assert.equal(existsSync(destination),false,'拒绝时不得在真实公开目录创建子目录');
});

test.after(()=>rmSync(temp,{recursive:true,force:true}));
