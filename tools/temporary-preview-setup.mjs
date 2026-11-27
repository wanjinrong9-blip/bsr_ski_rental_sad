// Host-only bootstrap for fictional, ephemeral Render previews. No HTTP caller.
import {createHash,createHmac} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {validateRuntimeConfig} from '../src/runtime-config.mjs';
import {preflightRuntime,initializeShowcase} from '../src/runtime-provenance.mjs';
import {openDb} from '../src/db.mjs';
import {candidateProvisionAccount,candidateChangePassword} from '../src/identity.mjs';

const roles={admin:'虚构权限管理员',customer:'虚构体验顾客',staff:'虚构租赁专员',
  manager:'虚构门店经理',contractor:'虚构维修技师',owner:'虚构经营负责人'};
const reject=message=>{throw new Error(message);};
export function previewCredentials(seed){
  if(typeof seed!=='string'||!/^[a-f0-9]{64}$/.test(seed)||new Set(seed).size<8)
    reject('临时预览需要私有的 32 字节随机种子');
  const derive=label=>createHmac('sha256',seed).update('BSR-TEMPORARY-PREVIEW-v1:'+label).digest('hex');
  return Object.entries(roles).map(([role,name])=>({role,name,email:`${role}@preview.example.test`,
    password:derive('login:'+role).slice(0,24)+'!Aa9'}));
}

export function prepareTemporaryPreview(env,{root=resolve(import.meta.dirname,'..'),runtimeDir='/runtime'}={}){
  if(env.BSR_TEMPORARY_PREVIEW!=='1'||env.BSR_RUN_MODE!=='showcase')
    reject('自动初始化仅用于明确启用的临时 SHOWCASE');
  const seed=env.BSR_PREVIEW_SEED,credentials=previewCredentials(seed);
  let origin;
  try{origin=new URL(env.RENDER_EXTERNAL_URL||env.BSR_PUBLIC_ORIGIN);}catch{reject('缺少 Render HTTPS 站点地址');}
  if(origin.protocol!=='https:'||!/^[-a-z0-9]+\.onrender\.com$/.test(origin.hostname)||
      origin.port||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)
    reject('临时入口必须为 Render 提供的 HTTPS 来源');
  const runtime=resolve(runtimeDir),dbPath=join(runtime,'data','showcase.sqlite');
  const backupDir=join(runtime,'backups'),manifest=join(runtime,'preview-installation.json');
  const fingerprint=createHash('sha256').update(seed).digest('hex');
  const proxySecret=createHmac('sha256',seed).update('BSR-TEMPORARY-PROXY-v1').digest('hex');
  mkdirSync(join(runtime,'data'),{recursive:true,mode:0o700});
  mkdirSync(backupDir,{recursive:true,mode:0o700});
  const managedEnv={BSR_RUN_MODE:'showcase',BSR_CANDIDATE_TRANSPORT:'trusted-local-proxy',
    HOST:'127.0.0.1',PORT:'4175',BSR_DB_PATH:dbPath,BSR_BACKUP_DIR:backupDir,
    BSR_PUBLIC_ORIGIN:origin.origin,BSR_PROXY_SECRET:proxySecret,BSR_MINI_ENTRY_STATE:'OFF'};
  const config=validateRuntimeConfig(managedEnv,{root,publicDir:join(root,'public')});
  const before=preflightRuntime(config);
  if(before.status==='ready'){
    let marker;
    try{marker=JSON.parse(readFileSync(manifest,'utf8'));}catch{reject('已有数据缺少临时预览来源；禁止改写');}
    if(marker.seedFingerprint!==fingerprint||marker.instanceId!==before.instanceId)
      reject('临时预览凭据或来源变化；禁止重置已有账号');
  }else{
    if(existsSync(manifest))reject('数据文件缺失但来源记录仍存在；禁止静默重置');
    const initialized=initializeShowcase(config,{operator:'temporary-render-synthetic-bootstrap',...credentials[0]});
    const db=openDb(dbPath,{runMode:'showcase'});
    try{
      const actor=db.prepare('SELECT * FROM users WHERE id=?').get(initialized.id);
      const storeId=db.prepare('SELECT id FROM stores ORDER BY id LIMIT 1').get().id;
      for(const credential of credentials.slice(1)){
        const temporaryPassword=createHmac('sha256',seed).update('provision:'+credential.role).digest('hex')+'!Aa9';
        const created=candidateProvisionAccount(db,actor,{...credential,storeId,
          temporaryPassword,verificationRef:'FICTIONAL-RENDER-PREVIEW-ONLY'}, {runMode:'showcase'});
        const user=db.prepare('SELECT * FROM users WHERE id=?').get(created.id);
        // Automation owns these fictional identities and completes normal
        // credential rotation before handing out distinct preview passwords.
        candidateChangePassword(db,user,{currentPassword:temporaryPassword,newPassword:credential.password},{runMode:'showcase'});
      }
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    }finally{db.close();}
    writeFileSync(manifest,JSON.stringify({instanceId:initialized.instanceId,seedFingerprint:fingerprint}),{flag:'wx',mode:0o600});
  }
  Object.assign(env,managedEnv);
  return {config,credentials}; // Never log credentials or include them in HTTP responses.
}
