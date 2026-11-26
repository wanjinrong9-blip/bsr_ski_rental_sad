import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createVerifiedBackup} from '../tools/backup-verify.mjs';
import {openDb} from '../src/db.mjs';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const publicDir=join(root,'public');

test('备份路径按词法与真实路径拒绝公开目录，允许词头相似的兄弟目录',async()=>{
 const temp=mkdtempSync(join(tmpdir(),'bsr-candidate-backup-'));
 const sibling=mkdtempSync(join(dirname(publicDir),'public-backup-private-'));
 const sourcePath=join(temp,'source.sqlite');
 const db=openDb(sourcePath);
 db.close();
 try{
  const direct=join(publicDir,`candidate-backup-forbidden-${basename(temp)}`);
  await assert.rejects(createVerifiedBackup({sourcePath,outputDir:direct}),/静态资源目录/);
  assert.equal(existsSync(direct),false);

  const link=join(temp,'linked-public');
  symlinkSync(publicDir,link,process.platform==='win32'?'junction':'dir');
  const redirected=join(link,basename(direct));
  await assert.rejects(createVerifiedBackup({sourcePath,outputDir:redirected}),/静态资源目录/);
  assert.equal(existsSync(direct),false,'链接拒绝不得在公开目录留下子目录');

  const result=await createVerifiedBackup({sourcePath,outputDir:sibling});
  assert.equal(result.restoreDrill,'PASS');
  assert.ok(existsSync(result.backupPath));
 }finally{
  rmSync(temp,{recursive:true,force:true});
  rmSync(sibling,{recursive:true,force:true});
 }
});
