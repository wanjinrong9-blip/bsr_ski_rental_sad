import {createInterface} from 'node:readline/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateRuntimeConfig} from '../src/runtime-config.mjs';
import {preflightRuntime,initializeShowcase} from '../src/runtime-provenance.mjs';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const publicDir=join(root,'public');

function askHidden(prompt){
  return new Promise((done,reject)=>{
    const input=process.stdin;
    if(!input.isTTY||typeof input.setRawMode!=='function'){
      reject(new Error('初始化凭据只能在交互终端中输入'));
      return;
    }
    const previous=input.isRaw;
    let value='';
    const cleanup=()=>{
      input.off('data',onData);
      input.setRawMode(previous);
      input.pause();
      process.stdout.write('\n');
    };
    const onData=chunk=>{
      for(const char of String(chunk)){
        if(char==='\r'||char==='\n'){
          cleanup();done(value);return;
        }
        if(char==='\u0003'){
          cleanup();reject(new Error('初始化已取消'));return;
        }
        if(char==='\u007f'||char==='\b'){
          value=value.slice(0,-1);continue;
        }
        if(char>=' '&&value.length<256)value+=char;
      }
    };
    process.stdout.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.on('data',onData);
  });
}

async function main(){
  const command=process.argv[2];
  if(!['preflight','init'].includes(command)||process.argv.length!==3)
    throw new Error('用法：node tools/showcase-setup.mjs preflight|init');
  const config=validateRuntimeConfig(process.env,{root,publicDir});
  if(config.runMode!=='showcase')throw new Error('请明确设置 BSR_RUN_MODE=showcase');
  const state=preflightRuntime(config);
  if(command==='preflight'){
    process.stdout.write(JSON.stringify({runMode:'showcase',status:state.status,
      instanceId:state.instanceId||null,schemaVersion:state.schemaVersion||null})+'\n');
    return;
  }
  if(state.status!=='needs_init')throw new Error('合成预览已经初始化，不能重复执行');
  if(!process.stdin.isTTY||!process.stdout.isTTY)
    throw new Error('合成预览初始化只能在交互终端中执行');
  const rl=createInterface({input:process.stdin,output:process.stdout});
  let operator,name,email;
  try{
    operator=await rl.question('初始化操作员标识：');
    name=await rl.question('虚构首个管理员姓名：');
    email=await rl.question('首个管理员私有邮箱：');
  }finally{rl.close();}
  const password=await askHidden('该实例专用强密码（输入不回显）：');
  const repeated=await askHidden('再次输入强密码（输入不回显）：');
  if(password!==repeated)throw new Error('两次密码不一致，尚未创建数据空间');
  const result=initializeShowcase(config,{operator,name,email,password});
  process.stdout.write(JSON.stringify({runMode:'showcase',status:result.status,
    instanceId:result.instanceId,adminId:result.id,counts:{stores:result.summary.stores,
      variants:result.summary.variants,units:result.summary.units,policies:result.summary.policies}})+'\n');
}

main().catch(error=>{
  const code=error?.code||'SETUP_FAILED';
  const safeMessage=error?.code?error.message:'合成预览检查或初始化失败';
  process.stderr.write(`${code}: ${safeMessage}\n`);
  process.exitCode=1;
});
