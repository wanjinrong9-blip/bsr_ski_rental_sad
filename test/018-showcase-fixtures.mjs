import {DatabaseSync} from 'node:sqlite';
import {existsSync,mkdirSync,mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,join,resolve,sep} from 'node:path';
import {freePort,generateTestCertificate} from './candidate-fixtures.mjs';

const forbidden=[/@bsr\.demo/i,/Demo123!/i,/BR-DEMO/i];
const fixturePrefix='bsr-018-showcase-';

function assertSafeTemporaryDirectory(dir){
  const target=realpathSync(dir),temporaryRoot=realpathSync(tmpdir());
  if(!target.toLowerCase().startsWith((temporaryRoot+sep).toLowerCase()) ||
     !basename(target).startsWith(fixturePrefix)){
    throw new Error('拒绝访问 018 临时夹具目录之外的路径');
  }
  return target;
}

export function assertNoDemoMarkers(value){
  const text=typeof value==='string'?value:JSON.stringify(value);
  if(typeof text!=='string')throw new Error('需要可检查的合成数据');
  for(const marker of forbidden){
    if(marker.test(text))throw new Error('合成预览夹具含已知演示数据标记');
  }
}

function quoted(name){return '"'+String(name).replaceAll('"','""')+'"';}

export function assertNoDemoRows(db){
  if(!(db instanceof DatabaseSync))throw new TypeError('需要 SQLite 数据库');
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  for(const {name} of tables){
    const columns=db.prepare(`PRAGMA table_info(${quoted(name)})`).all()
      .filter(column=>/TEXT|CHAR|CLOB|VARCHAR/i.test(column.type));
    for(const column of columns){
      const rows=db.prepare(`SELECT ${quoted(column.name)} AS value FROM ${quoted(name)} WHERE ${quoted(column.name)} IS NOT NULL`).all();
      for(const {value} of rows){
        if(forbidden.some(marker=>marker.test(String(value)))){
          throw new Error(`合成预览夹具包含演示标记：${name}.${column.name}`);
        }
      }
    }
  }
}

export async function makeShowcaseFixture(){
  const dir=mkdtempSync(join(tmpdir(),fixturePrefix));
  try{
    assertSafeTemporaryDirectory(dir);
    const backupDir=join(dir,'backups');mkdirSync(backupDir);
    const {certPath,keyPath}=generateTestCertificate(dir);
    const port=await freePort(),dbPath=join(dir,'showcase.sqlite');
    const origin=`https://127.0.0.1:${port}`;
    const env={BSR_RUN_MODE:'showcase',HOST:'127.0.0.1',PORT:String(port),
      BSR_DB_PATH:dbPath,BSR_BACKUP_DIR:backupDir,BSR_TLS_CERT_PATH:certPath,
      BSR_TLS_KEY_PATH:keyPath,BSR_PUBLIC_ORIGIN:origin};
    assertNoDemoMarkers(env);
    return {dir,backupDir,certPath,keyPath,dbPath,port,origin,env,
      cleanup(){
        if(!existsSync(dir))return;
        const target=assertSafeTemporaryDirectory(dir);
        rmSync(target,{recursive:true,force:true,maxRetries:10,retryDelay:100});
      }};
  }catch(error){
    if(existsSync(dir))rmSync(assertSafeTemporaryDirectory(dir),{recursive:true,force:true,maxRetries:10,retryDelay:100});
    throw error;
  }
}
