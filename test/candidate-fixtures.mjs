import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import net from 'node:net';
import https from 'node:https';

export async function freePort(){
  const socket=net.createServer();
  await new Promise((resolve,reject)=>socket.once('error',reject).listen(0,'127.0.0.1',resolve));
  const port=socket.address().port;
  await new Promise(resolve=>socket.close(resolve));
  return port;
}

function opensslBinary(){
  const candidates=[
    process.env.BSR_TEST_OPENSSL,
    'C:/Program Files/Git/usr/bin/openssl.exe',
    'C:/Program Files/Git/mingw64/bin/openssl.exe',
    'openssl'
  ].filter(Boolean);
  for(const binary of candidates){
    const check=spawnSync(binary,['version'],{encoding:'utf8',windowsHide:true});
    if(!check.error&&check.status===0)return binary;
  }
  throw new Error('本机缺少 OpenSSL；候选 HTTPS 测试需要仅供测试的临时证书');
}

export function generateTestCertificate(dir){
  mkdirSync(dir,{recursive:true});
  const certPath=join(dir,'localhost.crt'),keyPath=join(dir,'localhost.key');
  const result=spawnSync(opensslBinary(),[
    'req','-x509','-newkey','rsa:2048','-nodes',
    '-keyout',keyPath,'-out',certPath,'-days','1',
    '-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'
  ],{encoding:'utf8',windowsHide:true});
  if(result.error||result.status!==0)throw new Error('测试证书生成失败：'+(result.error?.message||result.stderr?.slice(-250)||result.status));
  return {certPath,keyPath};
}

export async function makeCandidateFixture(prefix='bsr-candidate-'){
  const dir=mkdtempSync(join(tmpdir(),prefix));
  try{
    const backupDir=join(dir,'backups');mkdirSync(backupDir);
    const {certPath,keyPath}=generateTestCertificate(dir);
    const port=await freePort();
    const dbPath=join(dir,'candidate.sqlite');
    const origin='https://127.0.0.1:'+port;
    return {
      dir,backupDir,certPath,keyPath,dbPath,port,origin,
      env:{BSR_RUN_MODE:'candidate',HOST:'127.0.0.1',PORT:String(port),BSR_DB_PATH:dbPath,
        BSR_BACKUP_DIR:backupDir,BSR_TLS_CERT_PATH:certPath,BSR_TLS_KEY_PATH:keyPath,
        BSR_PUBLIC_ORIGIN:origin},
      cleanup(){const target=resolve(dir),temporaryRoot=resolve(tmpdir());
        if(!target.startsWith(temporaryRoot+sep))throw new Error('拒绝清理临时目录之外的测试夹具');
        rmSync(target,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
    };
  }catch(error){const target=resolve(dir),temporaryRoot=resolve(tmpdir());
    if(!target.startsWith(temporaryRoot+sep))throw new Error('拒绝清理临时目录之外的测试夹具',{cause:error});
    rmSync(target,{recursive:true,force:true,maxRetries:10,retryDelay:100});throw error;}
}

export async function candidateRequest(fixture,path,{method='GET',body,headers={}}={}){
  const payload=body===undefined?null:JSON.stringify(body);
  return new Promise((resolve,reject)=>{
    const req=https.request(fixture.origin+path,{
      method,ca:readFileSync(fixture.certPath),
      headers:{...(payload?{'content-type':'application/json','content-length':Buffer.byteLength(payload)}:{}),...headers}
    },res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));
      res.on('end',()=>{
        const text=Buffer.concat(chunks).toString('utf8');
        let data;try{data=JSON.parse(text);}catch{data=text;}
        resolve({status:res.statusCode,headers:res.headers,data,text});
      });
    });
    req.on('error',reject);if(payload)req.write(payload);req.end();
  });
}

export function noCandidateArtifacts(fixture){
  return !existsSync(fixture.dbPath)&&!existsSync(fixture.dbPath+'-wal')&&!existsSync(fixture.dbPath+'-shm');
}
