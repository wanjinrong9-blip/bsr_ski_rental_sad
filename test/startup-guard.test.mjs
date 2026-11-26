import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import net from 'node:net';
import {validatePreviewConfig} from '../src/startup-config.mjs';

const root=resolve(import.meta.dirname,'..');
const publicDir=join(root,'public');
const serverPath=join(root,'src','server.mjs');
const temp=mkdtempSync(join(tmpdir(),'bsr-startup-guard-'));

async function freePort(){
  const socket=net.createServer();
  await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const port=socket.address().port;
  await new Promise(resolve=>socket.close(resolve));
  return port;
}

function start(env){
  const child=spawn(process.execPath,[serverPath],{cwd:root,env:{...process.env,NODE_ENV:'local',...env},stdio:['ignore','pipe','pipe'],windowsHide:true});
  let stderr='';child.stderr.setEncoding('utf8');child.stderr.on('data',chunk=>{stderr+=chunk;});
  child.stdout.resume();
  return {child,get stderr(){return stderr;}};
}

async function rejected(env){
  const run=start(env);
  let timer;
  const result=await Promise.race([
    new Promise(resolve=>run.child.once('close',(code,signal)=>resolve({code,signal}))),
    new Promise(resolve=>{timer=setTimeout(()=>resolve(null),8000);})
  ]);
  clearTimeout(timer);
  if(!result){run.child.kill();await new Promise(resolve=>run.child.once('close',resolve));}
  assert.ok(result,'危险配置应在监听前立即退出');
  assert.notEqual(result.code,0,run.stderr);
  return run.stderr;
}

test('启动前拒绝公网/局域网监听及无效端口，不创建数据库',async()=>{
  for(const [key,value] of [['HOST','0.0.0.0'],['HOST','::'],['HOST','192.168.1.8'],['HOST','demo.example'],['HOST',' localhost '],['HOST',''],['PORT','0'],['PORT','65536'],['PORT','abc'],['PORT',''],['PORT','1.5'],['PORT','1e3']]){
    const dbPath=join(temp,`${key}-${value.replaceAll(/[^a-z0-9]/gi,'-')}.sqlite`);
    await rejected({HOST:'127.0.0.1',PORT:'4173',BSR_DB_PATH:dbPath,[key]:value});
    assert.equal(existsSync(dbPath),false,`${key}=${value} 创建了数据库`);
  }
});

test('明确允许本机回环地址和有效端口',()=>{
  assert.equal(validatePreviewConfig({dbPath:join(temp,'allowed.sqlite'),publicDir}).host,'127.0.0.1');
  for(const host of ['127.0.0.1','::1','localhost','LOCALHOST']){
    assert.doesNotThrow(()=>validatePreviewConfig({host,port:'4173',dbPath:join(temp,'allowed.sqlite'),publicDir}));
  }
  for(const port of ['1','65535'])assert.equal(validatePreviewConfig({host:'localhost',port,dbPath:join(temp,'allowed.sqlite'),publicDir}).port,Number(port));
  assert.doesNotThrow(()=>validatePreviewConfig({host:'localhost',port:'4173',dbPath:join(root,'public-backups','allowed.sqlite'),publicDir}));
});

test('数据库不得位于静态资源目录，路径大小写和链接不能绕过',async t=>{
  const dbPath=join(publicDir,`startup-guard-${process.pid}.sqlite`);
  try{
    await rejected({HOST:'127.0.0.1',PORT:'4173',BSR_DB_PATH:dbPath});
    assert.equal(existsSync(dbPath),false);
    assert.throws(()=>validatePreviewConfig({host:'localhost',port:'4173',dbPath:join(publicDir,'nested','db.sqlite'),publicDir}));
    if(process.platform==='win32')assert.throws(()=>validatePreviewConfig({host:'localhost',port:'4173',dbPath:dbPath.toUpperCase(),publicDir}));
    const alias=join(temp,'public-alias');
    try{symlinkSync(publicDir,alias,process.platform==='win32'?'junction':'dir');}
    catch(error){if(['EPERM','EACCES'].includes(error.code)){t.diagnostic('当前系统不允许建立测试用目录链接');return;}throw error;}
    assert.throws(()=>validatePreviewConfig({host:'localhost',port:'4173',dbPath:join(alias,'db.sqlite'),publicDir}));
  }finally{rmSync(dbPath,{force:true});}
});

test('安全配置保持健康检查可用，静态目录链接不能读取外部文件',async t=>{
  const port=await freePort(),dbPath=join(temp,'safe.sqlite');
  const run=start({HOST:'127.0.0.1',PORT:String(port),BSR_DB_PATH:dbPath});
  try{
    let health;
    for(let i=0;i<100;i++){
      try{health=await fetch(`http://127.0.0.1:${port}/api/health`);if(health.ok)break;}catch{}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.equal(health?.status,200,run.stderr);
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status,200);
    for(const path of ['styles.css','app.js'])assert.equal((await fetch(`http://127.0.0.1:${port}/${path}`)).status,200);
    const imageName=`startup-guard-asset-${process.pid}.png`;
    const imagePath=join(publicDir,imageName);
    try{
      writeFileSync(imagePath,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO++fH0AAAAASUVORK5CYII=','base64'));
      const imageResponse=await fetch(`http://127.0.0.1:${port}/${imageName}`);
      assert.equal(imageResponse.status,200);
      assert.match(imageResponse.headers.get('content-type')||'',/image\/png/);
    }finally{rmSync(imagePath,{force:true});}
    assert.equal(existsSync(dbPath),true);
    const outsideDir=join(temp,'outside-static');mkdirSync(outsideDir);
    writeFileSync(join(outsideDir,'private.txt'),'synthetic-private-marker');
    const alias=join(publicDir,`startup-guard-link-${process.pid}`);
    try{
      try{symlinkSync(outsideDir,alias,process.platform==='win32'?'junction':'dir');}
      catch(error){if(['EPERM','EACCES'].includes(error.code)){t.diagnostic('当前系统不允许建立测试用目录链接');return;}throw error;}
      for(const method of ['GET','HEAD']){
        const response=await fetch(`http://127.0.0.1:${port}/${encodeURIComponent(alias.split(/[\\/]/).at(-1))}/private.txt`,{method});
        assert.equal(response.status,403);
        assert.equal((await response.text()).includes('synthetic-private-marker'),false);
      }
    }finally{rmSync(alias,{force:true});}
  }finally{
    run.child.kill();
    await new Promise(resolve=>run.child.once('close',resolve));
  }
});

test.after(()=>rmSync(temp,{recursive:true,force:true}));
