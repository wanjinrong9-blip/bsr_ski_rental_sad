// Run explicitly: node test/019-web-qr-browser.mjs
// The READY image below is the BSR logo with a local HMAC test receipt.
// It is deliberately NOT a WeChat-issued Mini Program code.
import assert from 'node:assert/strict';
import {createHash,createHmac,X509Certificate} from 'node:crypto';
import {spawn} from 'node:child_process';
import {copyFileSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {makeShowcaseFixture} from './018-showcase-fixtures.mjs';
import {readySyntheticSource} from './018-showcase-ready-fixture.mjs';
import {candidateRequest} from './candidate-fixtures.mjs';

const root=resolve(import.meta.dirname,'..');
const output=join(root,'test-results');
mkdirSync(output,{recursive:true});
const chromePath=process.env.BSR_CHROME||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const appId='wx1234567890abcdef';
const attestKey='5'.repeat(64);
const pause=ms=>new Promise(done=>setTimeout(done,ms));

async function wait(check,label){
  let last;
  for(let i=0;i<160;i++){
    try{if(await check())return;}catch(error){last=error;}
    await pause(100);
  }
  throw new Error('等待超时：'+label+(last?'; '+last.message:''));
}
async function connect(url,errors){
  const socket=new WebSocket(url);
  await new Promise((done,reject)=>{socket.onopen=done;socket.onerror=reject;});
  let sequence=0;
  const pending=new Map();
  socket.onmessage=event=>{
    const message=JSON.parse(event.data);
    if(message.method==='Runtime.exceptionThrown')
      errors.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text);
    const item=pending.get(message.id);
    if(item){
      pending.delete(message.id);clearTimeout(item.timer);
      message.error?item.reject(new Error(message.error.message)):item.resolve(message.result);
    }
  };
  return {socket,
    call(method,params={}){
      return new Promise((done,reject)=>{
        const id=++sequence;
        const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP 超时：'+method));},10000);
        pending.set(id,{resolve:done,reject,timer});
        socket.send(JSON.stringify({id,method,params}));
      });
    },
    async eval(expression){
      const response=await this.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
      if(response.exceptionDetails)
        throw new Error(response.exceptionDetails.exception?.description||response.exceptionDetails.text);
      return response.result.value;
    }
  };
}

const fixture=await makeShowcaseFixture();
const qrFile=join(fixture.dir,'synthetic-bsr-logo-not-wechat-code.png');
const receiptFile=join(fixture.dir,'private-synthetic-receipt.json');
const logo=join(root,'public','bsr-logo.png');
let server,db,chrome,browser,page;
const errors=[];
async function stop(){
  if(!server)return;
  server.closeAllConnections();
  await new Promise(done=>server.close(done));
  db.close();server=null;db=null;
}
async function start(state){
  await stop();
  process.env.BSR_MINI_ENTRY_STATE=state;
  ({server,db}=await import('../src/server.mjs?qr-browser-state='+state.toLowerCase()));
  await new Promise((done,reject)=>server.once('error',reject)
    .listen(fixture.port,'127.0.0.1',done));
}
async function visual(state,ready){
  const expected=ready?'已开放微信扫码':'小程序筹备中';
  for(const [width,height,label,mobile] of [[1440,900,'desktop',false],
    [390,844,'390px',true]]){
    await page.call('Emulation.setDeviceMetricsOverride',
      {width,height,deviceScaleFactor:1,mobile});
    await page.call('Page.navigate',{url:fixture.origin+'/?qr-test='+state+'-'+label+'#/mini'});
    await wait(()=>page.eval("!!document.querySelector('.mini-entry-card')"),
      state+' 网页入口');
    await wait(()=>page.eval('document.body.innerText.includes('
      +JSON.stringify(expected)+')'),state+' 状态文字');
    assert.equal(await page.eval('document.documentElement.scrollWidth<=innerWidth+1'),true);
    const image=await page.eval('(()=>{const e=document.querySelector('
      +JSON.stringify('img[alt="BSR 微信小程序扫码图片"]')
      +');return e?{src:e.getAttribute("src"),loaded:e.naturalWidth>0}:null})()');
    if(ready){
      await wait(()=>page.eval('document.querySelector('
        +JSON.stringify('img[alt="BSR 微信小程序扫码图片"]')
        +')?.naturalWidth>0'),state+' 合成图片已加载');
      assert.equal(image?.src,'/api/mini-entry/code');
    }else assert.equal(image,null);
    assert.equal(await page.eval('document.documentElement.innerHTML.includes('
      +JSON.stringify(fixture.dir)+')'),false);
    await wait(()=>page.eval("!document.querySelector('.toast.show')"),
      state+' 提示消失');
    const shot=await page.call('Page.captureScreenshot',
      {format:'png',captureBeyondViewport:width===390});
    writeFileSync(join(output,'019-web-qr-'+state.toLowerCase()+'-'+label+'.png'),
      Buffer.from(shot.data,'base64'));
    if(width===390){
      await page.eval("document.querySelector('.mini-entry-actions button').scrollIntoView({block:'center',behavior:'instant'})");
      const action=await page.eval("(()=>{const button=document.querySelector('.mini-entry-actions button').getBoundingClientRect();const nav=document.querySelector('.mobile-nav').getBoundingClientRect();return {top:button.top,bottom:button.bottom,navTop:nav.top}})()");
      assert.ok(action.top>=0&&action.bottom<action.navTop,
        state+' 小屏继续使用网页版按钮不被底部导航遮挡 '+JSON.stringify(action));
    }
  }
}

try{
  readySyntheticSource(fixture.dbPath);
  copyFileSync(logo,qrFile);
  const now=Date.now();
  const payload={version:1,source:'operator-attested',appId,page:'pages/catalog/index',
    scene:'home',imageSha256:createHash('sha256').update(readFileSync(qrFile)).digest('hex'),
    approvedAt:new Date(now-1000).toISOString(),
    expiresAt:new Date(now+3600000).toISOString()};
  const mac=createHmac('sha256',Buffer.from(attestKey,'hex'))
    .update(JSON.stringify(payload)).digest('hex');
  writeFileSync(receiptFile,JSON.stringify({...payload,mac}));
  Object.assign(process.env,fixture.env,{
    NODE_ENV:'test',
    BSR_WECHAT_MINI_ENABLED:'1',
    BSR_WECHAT_APP_ID:appId,
    BSR_WECHAT_APP_SECRET:'synthetic-test-only-app-secret-for-browser',
    BSR_WECHAT_OPENID_KEY:'synthetic-browser-openid-key-not-for-release',
    BSR_MINI_APP_ID:appId,
    BSR_MINI_RELEASE_QR_FILE:qrFile,
    BSR_MINI_RELEASE_RECEIPT_FILE:receiptFile,
    BSR_MINI_RELEASE_ATTEST_KEY:attestKey,
    BSR_MINI_RELEASE_CONFIRMED:'1'
  });
  await start('OFF');
  assert.deepEqual((await candidateRequest(fixture,'/api/mini-entry')).data,
    {status:'off',qrUrl:null});
  assert.equal((await candidateRequest(fixture,'/api/mini-entry/code')).status,404);

  const certificate=new X509Certificate(readFileSync(fixture.certPath));
  const spki=createHash('sha256')
    .update(certificate.publicKey.export({format:'der',type:'spki'})).digest('base64');
  chrome=spawn(chromePath,[
    '--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
    '--no-proxy-server','--remote-debugging-port=0',
    '--ignore-certificate-errors-spki-list='+spki,
    '--user-data-dir='+join(fixture.dir,'chrome'),'about:blank'
  ],{windowsHide:true,stdio:'ignore'});
  await wait(()=>existsSync(join(fixture.dir,'chrome','DevToolsActivePort')),
    'Chrome 调试端口');
  const [debugPort,debugPath]=readFileSync(join(fixture.dir,'chrome','DevToolsActivePort'),
    'utf8').trim().split('\n');
  browser=await connect('ws://127.0.0.1:'+debugPort+debugPath.trim(),errors);
  const {targetId}=await browser.call('Target.createTarget',{url:'about:blank'});
  const targets=await (await fetch('http://127.0.0.1:'+debugPort+'/json/list')).json();
  page=await connect(targets.find(target=>target.id===targetId).webSocketDebuggerUrl,errors);
  await page.call('Page.enable');await page.call('Runtime.enable');
  await page.call('Page.navigate',{url:fixture.origin+'/#/login'});
  await wait(()=>page.eval("!!document.querySelector('form[data-form=login]')"),
    '合成管理员登录表单');
  await page.eval('(()=>{const f=document.querySelector("form[data-form=login]");'
    +'f.elements.email.value="synthetic-admin@example.test";'
    +'f.elements.password.value="Private#Synthetic2026";f.requestSubmit()})()');
  await wait(()=>page.eval("!!document.querySelector('.top-logout')"),
    '合成管理员网页会话');
  await visual('OFF',false);

  await start('PAUSED');
  assert.deepEqual((await candidateRequest(fixture,'/api/mini-entry')).data,
    {status:'paused',qrUrl:null});
  assert.equal((await candidateRequest(fixture,'/api/mini-entry/code')).status,404);
  await visual('PAUSED',false);

  await start('READY');
  assert.deepEqual((await candidateRequest(fixture,'/api/mini-entry')).data,
    {status:'ready',qrUrl:'/api/mini-entry/code'});
  const imageResponse=await candidateRequest(fixture,'/api/mini-entry/code');
  assert.equal(imageResponse.status,200);
  assert.equal(imageResponse.headers['content-type'],'image/png');
  assert.equal(imageResponse.headers['x-content-type-options'],'nosniff');
  await visual('READY',true);
  assert.deepEqual(errors,[]);
  console.log('019-web-qr-browser PASS: OFF/PAUSED with no code, synthetic READY image, desktop/390px no overflow; no WeChat-issued code or phone scan claimed');
}finally{
  page?.socket.close();browser?.socket.close();
  if(chrome&&chrome.exitCode===null){
    const closed=new Promise(done=>chrome.once('close',done));
    chrome.kill();await closed;
  }
  await stop();
  fixture.cleanup();
}
