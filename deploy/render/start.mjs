import {spawn} from 'node:child_process';
import {chmodSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(import.meta.dirname,'../..');
const runtimeDirectory='/runtime/nginx';
const templatePath=resolve(import.meta.dirname,'nginx.conf.template');

export function renderNginxConfig({platformPort,config},template=readFileSync(templatePath,'utf8')){
  const portText=String(platformPort??'');
  if(!/^\d+$/.test(portText)||Number(portText)<1||Number(portText)>65535||Number(portText)===4175)
    throw new Error('Invalid platform port');
  let origin;
  try{origin=new URL(config?.publicOrigin);}catch{throw new Error('Invalid preview origin');}
  if(config?.runMode!=='showcase'||config.transport!=='trusted-local-proxy'||
      config.host!=='127.0.0.1'||config.port!==4175||
      origin.protocol!=='https:'||origin.port||origin.pathname!=='/'||origin.search||origin.hash||
      origin.username||origin.password||origin.origin!==config.publicOrigin||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:onrender\.com|up\.railway\.app)$/.test(origin.hostname)||
      !/^[a-f0-9]{64}$/i.test(config.proxySecret||''))
    throw new Error('Invalid temporary preview proxy configuration');
  const rendered=template.replaceAll('__PLATFORM_PORT__',String(Number(portText)))
    .replaceAll('__PUBLIC_HOST__',origin.host)
    .replaceAll('__PROXY_SECRET__',config.proxySecret);
  if(/__[A-Z_]+__/.test(rendered))throw new Error('Unresolved proxy template');
  return rendered;
}

// Any component exit stops its sibling. Signals allow SQLite to close before
// the supervisor forces termination at the end of the grace period.
export function supervise(children,{signalSource=process,graceMs=8000}={}){
  return new Promise(resolveExit=>{
    const active=new Set(children);
    let stopping=false,finished=false,exitCode=1,timer;
    const onTerm=()=>stop(0);
    const finish=()=>{
      if(finished)return;
      finished=true;
      clearTimeout(timer);
      signalSource.off('SIGTERM',onTerm);
      signalSource.off('SIGINT',onTerm);
      resolveExit(exitCode);
    };
    const terminate=signal=>{
      for(const child of active){
        try{child.kill(signal);}catch{/* Continue stopping the sibling. */}
      }
    };
    const stop=code=>{
      if(stopping)return;
      stopping=true;exitCode=code;
      if(active.size===0){finish();return;}
      timer=setTimeout(()=>{terminate('SIGKILL');finish();},graceMs);
      terminate('SIGTERM');
    };
    for(const child of children){
      child.once('exit',code=>{
        active.delete(child);
        if(!stopping)stop(Number.isInteger(code)&&code!==0?code:1);
        if(active.size===0)finish();
      });
      child.once('error',()=>{
        active.delete(child);
        stop(1);
        if(active.size===0)finish();
      });
    }
    signalSource.once('SIGTERM',onTerm);
    signalSource.once('SIGINT',onTerm);
    if(active.size===0)finish();
  });
}

async function runApplication(){
  const {server,db}=await import('../../src/server.mjs');
  let stopping=false;
  const close=()=>{
    if(stopping)return;
    stopping=true;
    server.close(()=>{db.close();process.exitCode=0;});
    server.closeAllConnections();
  };
  process.once('SIGTERM',close);
  process.once('SIGINT',close);
}

export async function startTemporaryPreview(env=process.env){
  const platformPort=env.PORT;
  for(const dir of ['/runtime/data','/runtime/backups',runtimeDirectory,
      `${runtimeDirectory}/client_temp`,`${runtimeDirectory}/proxy_temp`]){
    mkdirSync(dir,{recursive:true,mode:0o700});
    chmodSync(dir,0o700);
  }
  const {prepareTemporaryPreview}=await import('../../tools/temporary-preview-setup.mjs');
  const {config}=await prepareTemporaryPreview(env);
  const nginxConfig=renderNginxConfig({platformPort,config});
  const configPath=`${runtimeDirectory}/nginx.conf`;
  writeFileSync(configPath,nginxConfig,{mode:0o600});
  chmodSync(configPath,0o600);
  const appEnv={...env,NODE_ENV:'production',HOST:'127.0.0.1',PORT:'4175',
    BSR_RUN_MODE:'showcase',BSR_CANDIDATE_TRANSPORT:'trusted-local-proxy',
    BSR_PUBLIC_ORIGIN:config.publicOrigin,BSR_DB_PATH:config.dbPath,
    BSR_BACKUP_DIR:config.backupDir,BSR_PROXY_SECRET:config.proxySecret};
  delete appEnv.BSR_PREVIEW_SEED;
  const application=spawn(process.execPath,[fileURLToPath(import.meta.url),'--application'],
    {cwd:root,env:appEnv,stdio:'inherit'});
  const nginx=spawn('nginx',['-p',`${runtimeDirectory}/`,'-c',configPath,'-g','daemon off;'],
    {cwd:root,env:{PATH:env.PATH},stdio:'inherit'});
  return supervise([application,nginx]);
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length===3&&process.argv[2]==='--application')await runApplication();
    else if(process.argv.length===2)process.exit(await startTemporaryPreview());
    else throw new Error('Unsupported startup arguments');
  }catch{
    console.error('Temporary preview startup failed. Check private service configuration.');
    process.exitCode=1;
  }
}
