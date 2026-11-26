// Offline restore into a NEW candidate data file. Never point BSR_DB_PATH at a running instance.
import {DatabaseSync} from 'node:sqlite';
import {constants} from 'node:fs';
import {createReadStream,lstatSync,readFileSync,realpathSync,statSync} from 'node:fs';
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

function safeManifest(backupPath,manifestPath,backupDir){
  const backup=resolve(backupPath),manifestFile=resolve(manifestPath);
  if(manifestFile!==backup+'.json')deny('MANIFEST_PATH_INVALID','清单必须与备份同名并位于同一目录');
  for(const file of [backup,manifestFile]){
    let stat;
    try{stat=lstatSync(file);}catch{deny('BACKUP_MISSING','备份或清单不可读取');}
    if(!stat.isFile()||stat.nlink!==1)deny('BACKUP_NOT_REGULAR','备份和清单必须是独立普通文件');
    if(!isInsidePath(backupDir,file)||!isInsidePath(realpathSync.native(backupDir),realpathSync.native(file)))
      deny('BACKUP_OUTSIDE_PRIVATE_DIR','备份和清单必须位于私有备份目录');
  }
  let manifest;
  try{manifest=JSON.parse(readFileSync(manifestFile,'utf8'));}
  catch{deny('MANIFEST_INVALID','备份清单不是有效 JSON');}
  if(manifest?.format!==1||manifest.file!==basename(backup)||
      !/^[a-f0-9]{64}$/.test(String(manifest.sha256||''))||
      manifest.integrity!=='ok'||manifest.foreignKeyErrors!==0||
      manifest.restoreDrill!=='PASS'||!manifest.counts||typeof manifest.counts!=='object')
    deny('MANIFEST_INVALID','备份清单缺少通过验收所需的校验项');
  return {backup,manifest};
}

function newTarget(config){
  if(config.runMode!=='candidate')deny('RUN_MODE_INVALID','只允许恢复正式候选数据');
  const target=config.dbPath;
  if(pathExists(target)||pathExists(target+'-wal')||pathExists(target+'-shm'))
    deny('RESTORE_TARGET_EXISTS','恢复目标已存在；不会覆盖现有或运行中的数据库');
  let parent;
  try{parent=statSync(dirname(target));}catch{deny('RESTORE_PARENT_MISSING','请预先建立私有目标目录');}
  if(!parent.isDirectory())deny('RESTORE_PARENT_INVALID','恢复目标目录无效');
  if(isInsidePath(realpathSync.native(publicDir),realpathSync.native(dirname(target))))
    deny('RESTORE_TARGET_PUBLIC','恢复目标不能位于公开资源目录');
  if(isInsidePath(realpathSync.native(config.backupDir),realpathSync.native(dirname(target))))
    deny('RESTORE_TARGET_IN_BACKUP','恢复目标不能位于备份目录或其链接目标');
  return target;
}

function revokeRestoredSessions(path,operator,backupHash){
  const db=new DatabaseSync(path);
  try{
    db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE');
    let result;
    try{
      const row=db.prepare("SELECT instance_id FROM runtime_installation WHERE singleton_id=1 AND run_mode='CANDIDATE' AND init_state='READY'").get();
      if(!row)deny('SOURCE_NOT_CANDIDATE','备份不是已完成初始化的候选实例');
      const now=new Date().toISOString();
      const revoked=Number(db.prepare('UPDATE sessions SET revoked_at=? WHERE revoked_at IS NULL').run(now).changes);
      const accounts=Number(db.prepare('UPDATE users SET auth_epoch=auth_epoch+1').run().changes);
      db.prepare("INSERT INTO runtime_checks(instance_id,phase,result,reason_code,checked_at) VALUES(?,'RESTORE','PASS','BACKUP_VERIFIED_SESSIONS_REVOKED',?)")
        .run(row.instance_id,now);
      db.prepare("INSERT INTO audit_log(actor_id,action,target_type,target_id,detail_json,created_at) VALUES(NULL,'CANDIDATE_RESTORED','runtime_installation',1,?,?)")
        .run(JSON.stringify({operator,backupSha256:backupHash,revokedSessions:revoked,accounts}),now);
      db.exec('COMMIT');
      result={revokedSessions:revoked,accounts};
    }catch(error){db.exec('ROLLBACK');throw error;}
    const integrity=db.prepare('PRAGMA integrity_check').get()?.integrity_check;
    const foreignKeys=db.prepare('PRAGMA foreign_key_check').all();
    if(integrity!=='ok'||foreignKeys.length)deny('RESTORE_INTEGRITY_FAILED','恢复副本完整性检查未通过');
    return result;
  }finally{db.close();}
}

export async function restoreCandidateBackup({env=process.env,backupPath,manifestPath,operator=env.BSR_RESTORE_OPERATOR}={}){
  if(typeof backupPath!=='string'||!backupPath.trim()||typeof manifestPath!=='string'||!manifestPath.trim())
    deny('BACKUP_ARGUMENTS_MISSING','必须提供备份及对应清单路径');
  if(typeof operator!=='string'||operator.trim().length<2||operator.trim().length>100)
    deny('RESTORE_OPERATOR_MISSING','须通过 BSR_RESTORE_OPERATOR 标记线下恢复操作员');
  const config=validateRuntimeConfig(env,{root,publicDir});
  const target=newTarget(config);
  const {backup,manifest}=safeManifest(backupPath,manifestPath,config.backupDir);
  let stagingDir,localCopy;
  try{
    stagingDir=await mkdtemp(join(tmpdir(),'bsr-candidate-restore-check-'));
    const checkedCopy=join(stagingDir,'checked.sqlite');
    await copyFile(backup,checkedCopy,constants.COPYFILE_EXCL);
    if(await sha256(checkedCopy)!==manifest.sha256)deny('BACKUP_HASH_MISMATCH','备份 SHA-256 与清单不一致');
    const source=preflightRuntime({...config,dbPath:checkedCopy},{requireReady:true});
    if(source.status!=='ready')deny('SOURCE_NOT_READY','备份候选来源未就绪');
    // The 011 SQLite integrity verifier may create WAL sidecars even in
    // read-only mode. Use a second disposable copy so the publish copy stays pristine.
    const integrityCopy=join(stagingDir,'integrity.sqlite');
    await copyFile(backup,integrityCopy,constants.COPYFILE_EXCL);
    await verifyBackup(integrityCopy,manifest);
    // Recheck immediately before writing. Hard-link publication below is atomic and exclusive.
    newTarget(config);
    localCopy=join(dirname(target),'.'+basename(target)+'.restore-'+randomBytes(8).toString('hex')+'.partial');
    await copyFile(checkedCopy,localCopy,constants.COPYFILE_EXCL);
    const result=revokeRestoredSessions(localCopy,operator.trim(),manifest.sha256);
    const restored=preflightRuntime({...config,dbPath:localCopy},{requireReady:true});
    if(restored.instanceId!==source.instanceId)deny('RESTORE_INSTANCE_MISMATCH','恢复副本来源发生变化');
    newTarget(config);
    await link(localCopy,target); // EEXIST if another process created the target; never replaces it.
    const final=preflightRuntime(config,{requireReady:true});
    if(final.instanceId!==source.instanceId)deny('RESTORE_INSTANCE_MISMATCH','恢复目标来源复检未通过');
    return {status:'ready',runMode:'candidate',instanceId:final.instanceId,
      revokedSessions:result.revokedSessions,accounts:result.accounts};
  }finally{
    if(localCopy){
      await unlink(localCopy).catch(()=>{});
      await unlink(localCopy+'-wal').catch(()=>{});
      await unlink(localCopy+'-shm').catch(()=>{});
      await unlink(localCopy+'-journal').catch(()=>{});
    }
    if(stagingDir)await rm(stagingDir,{recursive:true,force:true});
    // A published target is deliberately retained if post-publication validation fails.
    // Its preflight will keep an invalid copy closed rather than overwrite or guess.
  }
}

async function runCli(){
  const args=process.argv.slice(2);
  if(args.length!==4||args[0]!=='--backup'||args[2]!=='--manifest')
    deny('RESTORE_USAGE','用法：node tools/candidate-restore.mjs --backup <私有备份> --manifest <对应清单>');
  const result=await restoreCandidateBackup({backupPath:args[1],manifestPath:args[3]});
  process.stdout.write(JSON.stringify(result)+'\n');
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  runCli().catch(error=>{
    // Never echo filesystem paths, personal data, or underlying SQLite diagnostics.
    process.stderr.write(`候选恢复失败：${error.code||'RESTORE_FAILED'}\n`);
    process.exitCode=1;
  });
}
