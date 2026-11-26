import {DatabaseSync,backup} from 'node:sqlite';
import {createHash,randomBytes} from 'node:crypto';
import {createReadStream,realpathSync} from 'node:fs';
import {access,copyFile,mkdir,mkdtemp,rename,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const coreTables=['stores','users','units','reservations','reservation_items','contracts','payments','damage_photos'];
const within=(parent,child)=>{const rel=relative(parent,child);return rel===''||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep));};

// Resolve the deepest existing ancestor, so a junction/symlink cannot redirect
// a not-yet-created backup directory into the static web root.
function canonicalizeProspectivePath(path){
 let current=resolve(path);
 const missing=[];
 for(;;){
  try{return resolve(realpathSync.native(current),...missing.reverse());}
  catch(error){
   if(!['ENOENT','ENOTDIR'].includes(error?.code))throw error;
   const parent=dirname(current);
   if(parent===current)throw error;
   missing.push(basename(current));
   current=parent;
  }
 }
}

async function sha256(path){
 const hash=createHash('sha256');
 for await(const chunk of createReadStream(path))hash.update(chunk);
 return hash.digest('hex');
}

function inspect(path){
 const db=new DatabaseSync(path,{readOnly:true});
 try{
  const integrity=db.prepare('PRAGMA integrity_check').all();
  if(integrity.length!==1||integrity[0].integrity_check!=='ok')throw new Error('数据库完整性检查失败');
  const foreignKeys=db.prepare('PRAGMA foreign_key_check').all();
  if(foreignKeys.length)throw new Error(`外键检查发现 ${foreignKeys.length} 项错误`);
  const counts={};
  for(const table of coreTables){
   const exists=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
   if(!exists)throw new Error(`缺少核心表 ${table}`);
   counts[table]=db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
  }
  return {integrity:'ok',foreignKeyErrors:0,counts};
 }finally{db.close();}
}

function provenance(path){
 const db=new DatabaseSync(path,{readOnly:true});
 try{
  const installation=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_installation'").get();
  if(!installation)return {};
  const row=db.prepare('SELECT run_mode,instance_id,schema_version,init_state FROM runtime_installation WHERE singleton_id=1').get();
  if(!row)return {};
  if(row.run_mode==='SHOWCASE'){
   const marker=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='showcase_dataset'").get();
   if(!marker||row.init_state!=='READY')throw new Error('合成预览来源尚未就绪');
   const dataset=db.prepare('SELECT instance_id,dataset_version,synthetic FROM showcase_dataset WHERE singleton_id=1').get();
   if(!dataset||dataset.instance_id!==row.instance_id||dataset.synthetic!==1||dataset.dataset_version<1)
    throw new Error('合成预览数据集标记与来源不符');
   return {runMode:'SHOWCASE',instanceId:row.instance_id,schemaVersion:row.schema_version,
    datasetVersion:dataset.dataset_version,synthetic:true};
  }
  return {runMode:row.run_mode,instanceId:row.instance_id,schemaVersion:row.schema_version};
 }finally{db.close();}
}

export async function verifyBackup(path,manifest){
 const actualHash=await sha256(path);
 if(actualHash!==manifest.sha256)throw new Error('备份 SHA-256 与清单不一致');
 const check=inspect(path);
 if(JSON.stringify(check.counts)!==JSON.stringify(manifest.counts))throw new Error('备份关键记录数与清单不一致');
 if(manifest.runMode){
  const actual=provenance(path);
  for(const field of ['runMode','instanceId','schemaVersion','datasetVersion','synthetic']){
   if(Object.hasOwn(manifest,field)&&actual[field]!==manifest[field])
    throw new Error(`备份来源字段 ${field} 与清单不一致`);
  }
 }
 return check;
}

export async function createVerifiedBackup({sourcePath=join(root,'data','bsr.sqlite'),outputDir=join(root,'data','backups')}={}){
 const sourceFile=resolve(sourcePath),output=resolve(outputDir),publicDir=join(root,'public');
 if(within(publicDir,output)||within(realpathSync.native(publicDir),canonicalizeProspectivePath(output)))
  throw new Error('备份不能保存在对外静态资源目录或其链接目标');
 await access(sourceFile);await mkdir(output,{recursive:true});
 const stamp=new Date().toISOString().replace(/[-:]/g,'').replace(/\..+/, 'Z');
 const name=`bsr-${stamp}-${randomBytes(4).toString('hex')}.sqlite`;
 const finalPath=join(output,name),manifestPath=finalPath+'.json';
 let drillDir,tempDir,source;
 try{
  // Keep SQLite's temporary WAL/SHM companions in one disposable directory.
  tempDir=await mkdtemp(join(output,'.bsr-backup-work-'));
  const tempPath=join(tempDir,'snapshot.sqlite');
  source=new DatabaseSync(sourceFile,{readOnly:true});
  await backup(source,tempPath);
  source.close();source=null;
  const check=inspect(tempPath),meta=provenance(tempPath),hash=await sha256(tempPath);
  drillDir=await mkdtemp(join(tmpdir(),'bsr-restore-drill-'));
  const restored=join(drillDir,'restored.sqlite');
  await copyFile(tempPath,restored);
  if(await sha256(restored)!==hash)throw new Error('恢复副本哈希不匹配');
  const restoredCheck=inspect(restored);
  if(JSON.stringify(restoredCheck)!==JSON.stringify(check))throw new Error('恢复副本完整性或记录数不匹配');
  const manifest={format:1,createdAt:new Date().toISOString(),source:basename(sourceFile),file:name,sha256:hash,...meta,...check,restoreDrill:'PASS'};
  await rename(tempPath,finalPath);
  await writeFile(manifestPath+'.partial',JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  await rename(manifestPath+'.partial',manifestPath);
  return {backupPath:finalPath,manifestPath,sha256:hash,integrity:check.integrity,foreignKeyErrors:0,restoreDrill:'PASS',counts:check.counts};
 }catch(error){
  await Promise.allSettled([rm(finalPath,{force:true}),rm(manifestPath,{force:true}),rm(manifestPath+'.partial',{force:true})]);
  throw error;
 }finally{
  if(source)source.close();
  if(drillDir)await rm(drillDir,{recursive:true,force:true});
  if(tempDir)await rm(tempDir,{recursive:true,force:true});
 }
}

async function runCli(){
 const args=process.argv.slice(2),options={};
 for(let i=0;i<args.length;i++){
  if(args[i]==='--source'&&args[i+1])options.sourcePath=args[++i];
  else if(args[i]==='--output'&&args[i+1])options.outputDir=args[++i];
  else throw new Error(`未知或缺少参数：${args[i]}`);
 }
 const result=await createVerifiedBackup(options);
 process.stdout.write(JSON.stringify(result)+'\n');
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 runCli().catch(error=>{process.stderr.write(`备份失败：${error.message}\n`);process.exitCode=1;});
}
