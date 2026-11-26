import {readFileSync,realpathSync,statSync} from 'node:fs';
import {createPrivateKey,createPublicKey,X509Certificate} from 'node:crypto';
import {createSecureContext} from 'node:tls';
import {isIP} from 'node:net';
import {dirname,join,resolve} from 'node:path';
import {isInsidePath,validatePreviewConfig} from './startup-config.mjs';

export class RuntimeConfigError extends Error {
  constructor(code,message){super(message);this.name='RuntimeConfigError';this.code=code;}
}

const bad=(code,message)=>{throw new RuntimeConfigError(code,message);};
const samePath=(a,b)=>process.platform==='win32'
  ?resolve(a).toLowerCase()===resolve(b).toLowerCase()
  :resolve(a)===resolve(b);
const inPublic=(publicDir,path)=>{
  const lexical=isInsidePath(publicDir,path);
  const physical=isInsidePath(realpathSync.native(publicDir),realpathSync.native(path));
  return lexical||physical;
};

function privateExistingPath(publicDir,path,kind){
  if(typeof path!=='string'||!path.trim())bad(`${kind}_MISSING`,`${kind} 必须明确指定`);
  const absolute=resolve(path);
  let stat;
  try{stat=statSync(absolute);}
  catch{bad(`${kind}_UNAVAILABLE`,`${kind} 不可读取`);}
  if(inPublic(publicDir,absolute))bad(`${kind}_PUBLIC`,`${kind} 不能位于公开资源目录`);
  return {absolute,stat};
}

function secureOrigin(raw,host,port,transport='direct-tls'){
  if(typeof raw!=='string'||!raw.trim())bad('PUBLIC_ORIGIN_MISSING','BSR_PUBLIC_ORIGIN 必须明确指定');
  let url;
  try{url=new URL(raw);}catch{bad('PUBLIC_ORIGIN_INVALID','BSR_PUBLIC_ORIGIN 无效');}
  const originHost=url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  if(raw!==raw.trim()||!/^https:\/\/[^/?#]+\/?$/i.test(raw)||
      url.protocol!=='https:'||Number(url.port||443)<1||url.pathname!=='/'||
      url.search||url.hash||url.username||url.password)
    bad('PUBLIC_ORIGIN_MISMATCH','BSR_PUBLIC_ORIGIN 必须是单一 HTTPS 来源');
  if(transport==='direct-tls'&&(originHost!==host.toLowerCase()||Number(url.port||443)!==port))
    bad('PUBLIC_ORIGIN_MISMATCH','BSR_PUBLIC_ORIGIN 必须是与回环地址和端口一致的 HTTPS 来源');
  if(transport==='trusted-local-proxy'&&(isIP(originHost)||originHost==='localhost'||
      !originHost.includes('.')||originHost.endsWith('.')))
    bad('PUBLIC_ORIGIN_MISMATCH','代理候选须明确指定非回环域名的 HTTPS 来源');
  return url.origin;
}

function candidateProxySecret(raw){
  const repeatedPattern=typeof raw==='string'&&Array.from({length:Math.min(16,Math.floor(raw.length/2))},
    (_,index)=>index+1).some(size=>raw.length%size===0&&raw===raw.slice(0,size).repeat(raw.length/size));
  if(typeof raw!=='string'||!/^[a-f0-9]{64}$/i.test(raw)||
      repeatedPattern||/(?:change.?me|replace.?me|example|password|demo.?secret)/i.test(raw))
    bad('PROXY_SECRET_INVALID','BSR_PROXY_SECRET 须为私有的 32 字节随机值（64 位十六进制字符）');
  return raw;
}

function candidateTls(env,publicDir,host){
  const cert=privateExistingPath(publicDir,env.BSR_TLS_CERT_PATH,'TLS_CERT');
  const key=privateExistingPath(publicDir,env.BSR_TLS_KEY_PATH,'TLS_KEY');
  if(!cert.stat.isFile()||!key.stat.isFile())bad('TLS_FILES_INVALID','候选证书和私钥必须是普通文件');
  let certBytes,keyBytes,x509;
  try{
    certBytes=readFileSync(cert.absolute);keyBytes=readFileSync(key.absolute);
    x509=new X509Certificate(certBytes);
    const privateKey=createPrivateKey(keyBytes);
    const matchingPublic=createPublicKey(privateKey).export({format:'der',type:'spki'});
    const certificatePublic=x509.publicKey.export({format:'der',type:'spki'});
    if(!matchingPublic.equals(certificatePublic))bad('TLS_PAIR_MISMATCH','候选证书和私钥不配对');
    createSecureContext({cert:certBytes,key:keyBytes});
  }catch(error){
    if(error instanceof RuntimeConfigError)throw error;
    bad('TLS_FILES_INVALID','候选证书或私钥无法使用');
  }
  const now=Date.now();
  if(!Number.isFinite(Date.parse(x509.validFrom))||!Number.isFinite(Date.parse(x509.validTo))||
      now<Date.parse(x509.validFrom)||now>Date.parse(x509.validTo))
    bad('TLS_CERT_EXPIRED','候选证书不在有效期内');
  const matched=isIP(host)?x509.checkIP(host):x509.checkHost(host);
  if(!matched)bad('TLS_HOST_MISMATCH','候选证书未覆盖回环主机');
  return {cert:certBytes,key:keyBytes,certPath:cert.absolute,keyPath:key.absolute};
}

// This function is intentionally read-only. Never call openDb() from validation.
export function validateRuntimeConfig(env=process.env,{root,publicDir}={}){
  if(!root||!publicDir)bad('RUNTIME_PATHS_MISSING','项目根目录与公开资源目录必须明确指定');
  const rawMode=env.BSR_RUN_MODE;
  const runMode=rawMode===undefined?'demo':String(rawMode);
  if(!['demo','candidate','showcase'].includes(runMode))
    bad('RUN_MODE_INVALID','BSR_RUN_MODE 只允许 demo、candidate 或 showcase');
  const preview=validatePreviewConfig({
    host:env.HOST??'127.0.0.1',port:env.PORT??4173,
    dbPath:env.BSR_DB_PATH??join(root,'data','bsr.sqlite'),publicDir
  });
  if(runMode==='demo'){
    if(env.BSR_CANDIDATE_TRANSPORT!==undefined||env.BSR_PROXY_SECRET!==undefined)
      bad('DEMO_PROXY_FORBIDDEN','课程演示不能启用候选代理配置');
    return {...preview,runMode,transport:'local-http',backupDir:null,publicOrigin:null,tls:null,proxySecret:null};
  }
  const transport=env.BSR_CANDIDATE_TRANSPORT??'direct-tls';
  if(!['direct-tls','trusted-local-proxy'].includes(transport))
    bad('CANDIDATE_TRANSPORT_INVALID','候选传输仅允许 direct-tls 或 trusted-local-proxy');
  if(typeof env.BSR_DB_PATH!=='string'||!env.BSR_DB_PATH.trim())
    bad('CANDIDATE_DB_MISSING','受控数据空间必须明确指定');
  const demoPath=join(root,'data','bsr.sqlite');
  if(samePath(preview.dbPath,demoPath))bad('CANDIDATE_DB_IS_DEMO','受控运行不能使用默认演示数据文件');
  const backup=privateExistingPath(publicDir,env.BSR_BACKUP_DIR,'BACKUP_DIR');
  if(!backup.stat.isDirectory())bad('BACKUP_DIR_INVALID','受控备份位置必须是已存在目录');
  if(isInsidePath(backup.absolute,preview.dbPath)||isInsidePath(realpathSync.native(backup.absolute),resolve(preview.dbPath)))
    bad('CANDIDATE_DB_IN_BACKUP','受控业务数据文件不能位于备份目录');
  const publicOrigin=secureOrigin(env.BSR_PUBLIC_ORIGIN,preview.host,preview.port,transport);
  if(transport==='trusted-local-proxy'){
    if(env.BSR_TLS_CERT_PATH||env.BSR_TLS_KEY_PATH)
      bad('TLS_CONFIG_UNEXPECTED','代理候选只在代理层终止 HTTPS，应用不得配置本机 TLS 文件');
    const proxySecret=candidateProxySecret(env.BSR_PROXY_SECRET);
    return {...preview,runMode,transport,backupDir:backup.absolute,publicOrigin,tls:null,proxySecret};
  }
  if(env.BSR_PROXY_SECRET!==undefined)bad('PROXY_CONFIG_UNEXPECTED','直连候选不能使用代理密钥配置');
  const tls=candidateTls(env,publicDir,preview.host);
  return {...preview,runMode,transport,backupDir:backup.absolute,publicOrigin,tls,proxySecret:null};
}
