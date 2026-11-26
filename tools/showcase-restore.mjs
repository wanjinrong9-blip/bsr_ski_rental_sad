// Offline, exclusive recovery of an artificial SHOWCASE instance into an absent private file.
import {DatabaseSync} from 'node:sqlite';
import {constants,createReadStream,lstatSync,readFileSync,realpathSync,statSync} from 'node:fs';
import {copyFile,link,mkdtemp,rm,unlink} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateRuntimeConfig} from '../src/runtime-config.mjs';
import {preflightRuntime} from '../src/runtime-provenance.mjs';
import {isInsidePath} from '../src/startup-config.mjs';
import {verifyBackup} from './backup-verify.mjs';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const publicDir=join(root,'public');
const deny=(code,message)=>{const error=new Error(message);error.code=code;throw error;};
const pathExists=path=>{try{lstatSync(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
async function sha256(path){
 const hash=createHash('sha256');
 for await(const chunk of createReadStream(path))hash.update(chunk);
 return hash.digest('hex');
}

function assertTargetAbsent(config){
 if(config.runMode!=='showcase')deny('RUN_MODE_INVALID','只允许恢复合成预览数据');
 const target=config.dbPath;
 for(const suffix of ['','-wal','-shm','-journal'])
  if(pathExists(target+suffix))deny('RESTORE_TARGET_EXISTS','恢复目标或 SQLite 附属文件已存在');
 let parent;
 try{parent=statSync(dirname(target));}catch{deny('RESTORE_PARENT_MISSING','须预先建立私有目标目录');}
 if(!parent.isDirectory())deny('RESTORE_PARENT_INVALID','恢复目标目录无效');
 const realParent=realpathSync.native(dirname(target));
 if(isInsidePath(realpathSync.native(publicDir),realParent))
  deny('RESTORE_TARGET_PUBLIC','恢复目标不能位于公开资源目录');
 if(isInsidePath(realpathSync.native(config.backupDir),realParent))
  deny('RESTORE_TARGET_IN_BACKUP','恢复目标不能位于备份目录');
 return target;
}

function readManifest(backupPath,manifestPath,backupDir){
 const backup=resolve(backupPath),manifestFile=resolve(manifestPath);
 if(manifestFile!==backup+'.json')deny('MANIFEST_PATH_INVALID','清单须与备份同名');
 for(const file of [backup,manifestFile]){
  let stat;
  try{stat=lstatSync(file);}catch{deny('BACKUP_MISSING','备份或清单不存在');}
  if(!stat.isFile()||stat.nlink!==1)deny('BACKUP_NOT_REGULAR','备份与清单须为普通独立文件');
  if(!isInsidePath(backupDir,file)||!isInsidePath(realpathSync.native(backupDir),realpathSync.native(file)))
   deny('BACKUP_OUTSIDE_PRIVATE_DIR','备份与清单须位于指定私有备份目录');
 }
 let manifest;
 try{manifest=JSON.parse(readFileSync(manifestFile,'utf8'));}
 catch{deny('MANIFEST_INVALID','备份清单无效');}
 if(manifest?.format!==1||manifest.file!==basename(backup)||
    !/^[a-f0-9]{64}$/.test(String(manifest.sha256||''))||
    manifest.integrity!=='ok'||manifest.foreignKeyErrors!==0||
    manifest.restoreDrill!=='PASS'||!manifest.counts||typeof manifest.counts!=='object')
  deny('MANIFEST_INVALID','备份清单缺少完整性字段');
 if(manifest.runMode!=='SHOWCASE')deny('MANIFEST_MODE_MISMATCH','备份清单不是合成预览来源');
 if(typeof manifest.instanceId!=='string'||!manifest.instanceId||
    !Number.isInteger(manifest.schemaVersion)||manifest.schemaVersion<1||
    !Number.isInteger(manifest.datasetVersion)||manifest.datasetVersion<1||manifest.synthetic!==true)
  deny('MANIFEST_INVALID','合成预览来源字段不完整');
 return {backup,manifest};
}

function snapshotProvenance(path){
 const db=new DatabaseSync(path,{readOnly:true});
 try{
  const installation=db.prepare('SELECT run_mode,instance_id,schema_version,init_state FROM runtime_installation WHERE singleton_id=1').get();
  if(installation?.run_mode!=='SHOWCASE'||installation.init_state!=='READY')
   deny('SOURCE_NOT_SHOWCASE','备份不是已就绪的合成预览来源');
  const dataset=db.prepare('SELECT instance_id,dataset_version,synthetic FROM showcase_dataset WHERE singleton_id=1').get();
  if(!dataset||dataset.instance_id!==installation.instance_id||dataset.synthetic!==1)
   deny('SOURCE_DATASET_MISMATCH','数据集标记无效');
  return {instanceId:installation.instance_id,schemaVersion:installation.schema_version,
   datasetVersion:dataset.dataset_version};
 }finally{db.close();}
}

function revokeSessions(path,operator,backupHash){
 const db=new DatabaseSync(path);
 try{
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE');
  let counts;
  try{
   const installation=db.prepare("SELECT instance_id FROM runtime_installation WHERE singleton_id=1 AND run_mode='SHOWCASE' AND init_state='READY'").get();
   if(!installation)deny('SOURCE_NOT_SHOWCASE','来源用途已改变');
   const now=new Date().toISOString();
   const revokedSessions=Number(db.prepare('UPDATE sessions SET revoked_at=? WHERE revoked_at IS NULL').run(now).changes);
   const hasMiniTable=name=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
   const revokedMiniSessions=hasMiniTable('mini_sessions')?
    Number(db.prepare('UPDATE mini_sessions SET revoked_at=? WHERE revoked_at IS NULL').run(now).changes):0;
   const consumedMiniChallenges=hasMiniTable('mini_login_challenges')?
    Number(db.prepare('UPDATE mini_login_challenges SET consumed_at=? WHERE consumed_at IS NULL').run(now).changes):0;
   const accounts=Number(db.prepare('UPDATE users SET auth_epoch=auth_epoch+1').run().changes);
   db.prepare("INSERT INTO runtime_checks(instance_id,phase,result,reason_code,checked_at) VALUES(?,'RESTORE','PASS','BACKUP_VERIFIED_SESSIONS_REVOKED',?)")
    .run(installation.instance_id,now);
   db.prepare("INSERT INTO audit_log(actor_id,action,target_type,target_id,detail_json,created_at) VALUES(NULL,'SHOWCASE_RESTORED','runtime_installation',1,?,?)")
    .run(JSON.stringify({operator,backupSha256:backupHash,revokedSessions,
      revokedMiniSessions,consumedMiniChallenges,accounts}),now);
   db.exec('COMMIT');
   counts={revokedSessions,revokedMiniSessions,consumedMiniChallenges,accounts};
  }catch(error){db.exec('ROLLBACK');throw error;}
  if(db.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)
   deny('RESTORE_INTEGRITY_FAILED','恢复副本完整性检查失败');
  return counts;
 }finally{db.close();}
}

export async function restoreShowcaseBackup({env=process.env,backupPath,manifestPath,operator=env.BSR_RESTORE_OPERATOR}={}){
 if(typeof backupPath!=='string'||!backupPath.trim()||typeof manifestPath!=='string'||!manifestPath.trim())
  deny('BACKUP_ARGUMENTS_MISSING','必须提供备份及对应清单');
 if(typeof operator!=='string'||operator.trim().length<2||operator.trim().length>100)
  deny('RESTORE_OPERATOR_MISSING','须标记离线恢复操作员');
 // Refuse a wrong mode before config validation can inspect another runtime.
 if(env.BSR_RUN_MODE!=='showcase')deny('RUN_MODE_INVALID','仅 SHOWCASE 可用此恢复程序');
 const config=validateRuntimeConfig(env,{root,publicDir});
 const target=assertTargetAbsent(config);
 const {backup,manifest}=readManifest(backupPath,manifestPath,config.backupDir);
 let stagingDir,localCopy;
 try{
  stagingDir=await mkdtemp(join(tmpdir(),'bsr-showcase-restore-check-'));
  const checked=join(stagingDir,'checked.sqlite');
  await copyFile(backup,checked,constants.COPYFILE_EXCL);
  if(await sha256(checked)!==manifest.sha256)deny('BACKUP_HASH_MISMATCH','备份哈希与清单不一致');
  const source=preflightRuntime({...config,dbPath:checked},{requireReady:true});
  if(source.status!=='ready'||source.runMode!=='showcase')deny('SOURCE_NOT_SHOWCASE','来源用途不符');
  const provenance=snapshotProvenance(checked);
  if(provenance.instanceId!==manifest.instanceId)deny('MANIFEST_INSTANCE_MISMATCH','实例来源与清单不符');
  if(provenance.schemaVersion!==manifest.schemaVersion)deny('MANIFEST_SCHEMA_MISMATCH','结构版本与清单不符');
  if(provenance.datasetVersion!==manifest.datasetVersion)deny('MANIFEST_DATASET_MISMATCH','数据集版本与清单不符');
  // SQLite integrity verification may create sidecars, so use a disposable copy.
  const integrityCopy=join(stagingDir,'integrity.sqlite');
  await copyFile(backup,integrityCopy,constants.COPYFILE_EXCL);
  await verifyBackup(integrityCopy,manifest);
  assertTargetAbsent(config);
  localCopy=join(dirname(target),'.'+basename(target)+'.restore-'+randomBytes(8).toString('hex')+'.partial');
  await copyFile(checked,localCopy,constants.COPYFILE_EXCL);
  const counts=revokeSessions(localCopy,operator.trim(),manifest.sha256);
  const restored=preflightRuntime({...config,dbPath:localCopy},{requireReady:true});
  if(restored.instanceId!==source.instanceId)deny('RESTORE_INSTANCE_MISMATCH','恢复副本实例发生变化');
  assertTargetAbsent(config);
  await link(localCopy,target); // Atomic exclusive publication; EEXIST never replaces operator data.
  const published=preflightRuntime(config,{requireReady:true});
  if(published.instanceId!==source.instanceId)deny('RESTORE_INSTANCE_MISMATCH','恢复目标来源复检失败');
  return {status:'ready',runMode:'showcase',instanceId:published.instanceId,...counts};
 }finally{
  if(localCopy){
   for(const suffix of ['','-wal','-shm','-journal'])await unlink(localCopy+suffix).catch(()=>{});
  }
  if(stagingDir)await rm(stagingDir,{recursive:true,force:true});
 }
}

async function runCli(){
 const args=process.argv.slice(2);
 if(args.length!==4||args[0]!=='--backup'||args[2]!=='--manifest')
  deny('RESTORE_USAGE','用法：node tools/showcase-restore.mjs --backup <私有备份> --manifest <对应清单>');
 const result=await restoreShowcaseBackup({backupPath:args[1],manifestPath:args[3]});
 process.stdout.write(JSON.stringify(result)+'\n');
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 runCli().catch(error=>{
  process.stderr.write(`合成预览恢复失败：${error.code||'RESTORE_FAILED'}\n`);
  process.exitCode=1;
 });
}
