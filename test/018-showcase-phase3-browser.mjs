// Run explicitly: node test/018-showcase-phase3-browser.mjs
// All browser state, data and certificates live in a disposable SHOWCASE fixture.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,X509Certificate} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {makeShowcaseFixture} from './018-showcase-fixtures.mjs';
import {candidateRequest} from './candidate-fixtures.mjs';
import {validateRuntimeConfig} from '../src/runtime-config.mjs';
import {initializeShowcase} from '../src/runtime-provenance.mjs';

const root=resolve(import.meta.dirname,'..'),publicDir=join(root,'public');
const output=join(root,'test-results');mkdirSync(output,{recursive:true});
const chromePath=process.env.BSR_CHROME||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const pause=ms=>new Promise(done=>setTimeout(done,ms));
async function wait(check,label){
  for(let i=0;i<180;i++){
    try{if(await check())return;}catch{}
    await pause(100);
  }
  throw new Error('等待超时：'+label);
}
async function connect(url,errors){
  const socket=new WebSocket(url);
  await new Promise((done,reject)=>{socket.onopen=done;socket.onerror=reject;});
  let sequence=0;const pending=new Map();
  socket.onmessage=event=>{
    const message=JSON.parse(event.data);
    if(message.method==='Runtime.exceptionThrown')
      errors.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text);
    const item=pending.get(message.id);
    if(item){pending.delete(message.id);clearTimeout(item.timer);
      message.error?item.reject(new Error(message.error.message)):item.resolve(message.result);}
  };
  return {socket,
    call(method,params={}){return new Promise((done,reject)=>{
      const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP 超时：'+method));},10000);
      pending.set(id,{resolve:done,reject,timer});socket.send(JSON.stringify({id,method,params}));
    });},
    async eval(expression){
      const response=await this.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
      if(response.exceptionDetails)throw new Error(response.exceptionDetails.exception?.description||response.exceptionDetails.text);
      return response.result.value;
    }
  };
}

const fixture=await makeShowcaseFixture();
let child,chrome,browser,page;const errors=[];
try{
  const config=validateRuntimeConfig(fixture.env,{root,publicDir});
  initializeShowcase(config,{operator:'018-browser-check',name:'虚构权限管理员',
    email:'visual-admin@example.test',password:'Private#VisualAdmin2026A'});
  child=spawn(process.execPath,[join(root,'src','server.mjs')],{
    cwd:root,env:{...process.env,...fixture.env,NODE_ENV:'local'},
    stdio:['ignore','pipe','pipe'],windowsHide:true
  });
  let stderr='';child.stdout.resume();child.stderr.setEncoding('utf8');
  child.stderr.on('data',part=>{stderr+=part;});
  await wait(async()=>{
    if(child.exitCode!==null)throw new Error(stderr);
    try{return (await candidateRequest(fixture,'/api/health')).status===200;}catch{return false;}
  },'SHOWCASE HTTPS 服务');

  const certificate=new X509Certificate(readFileSync(fixture.certPath));
  const spki=createHash('sha256').update(certificate.publicKey.export({format:'der',type:'spki'})).digest('base64');
  chrome=spawn(chromePath,[
    '--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
    '--disable-background-timer-throttling','--disable-backgrounding-occluded-windows',
    '--remote-debugging-port=0','--ignore-certificate-errors-spki-list='+spki,
    '--user-data-dir='+join(fixture.dir,'chrome'),'about:blank'
  ],{windowsHide:true,stdio:'ignore'});
  await wait(()=>existsSync(join(fixture.dir,'chrome','DevToolsActivePort')),'Chrome 调试端口');
  const [debugPort,path]=readFileSync(join(fixture.dir,'chrome','DevToolsActivePort'),'utf8').trim().split('\n');
  browser=await connect('ws://127.0.0.1:'+debugPort+path.trim(),errors);
  const {targetId}=await browser.call('Target.createTarget',{url:'about:blank'});
  const targets=await (await fetch('http://127.0.0.1:'+debugPort+'/json/list')).json();
  page=await connect(targets.find(target=>target.id===targetId).webSocketDebuggerUrl,errors);
  await page.call('Page.enable');await page.call('Runtime.enable');
  await page.call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await page.call('Page.navigate',{url:fixture.origin+'/#/catalog'});
  await wait(()=>page.eval("!!document.querySelector('form[data-form=login]')"),'受管理登录页');
  assert.equal(await page.eval("location.hash==='#/login'"),true);
  assert.equal(await page.eval("document.body.innerText.includes('合成预览')"),true);
  assert.equal(await page.eval("document.body.innerText.includes('Demo123!')"),false);
  assert.equal(await page.eval("!!document.querySelector('[data-demo]')"),false);
  assert.equal(await page.eval("!!document.querySelector('[data-action=toggle-login]')"),false);
  assert.equal(await page.eval("document.documentElement.scrollWidth<=innerWidth+1"),true);
  let screenshot=await page.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  writeFileSync(join(output,'showcase-phase3-login-desktop.png'),Buffer.from(screenshot.data,'base64'));

  await page.eval(`(()=>{const form=document.querySelector('form[data-form=login]');
    form.elements.email.value='visual-admin@example.test';
    form.elements.password.value='Private#VisualAdmin2026A';form.requestSubmit();return true;})()`);
  await wait(()=>page.eval("location.hash==='#/users'&&!!document.querySelector('[data-action=new-candidate-user]')"),
    '管理员账号页');
  assert.equal(await page.eval("document.body.innerText.includes('虚构人员资料')"),true);
  assert.equal(await page.eval("document.body.innerText.includes('Demo123!')"),false);
  assert.equal(await page.eval("document.documentElement.scrollWidth<=innerWidth+1"),true);
  await wait(()=>page.eval("!document.querySelector('#toast.show')"),'登录提示消失');
  screenshot=await page.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  writeFileSync(join(output,'showcase-phase3-admin-desktop.png'),Buffer.from(screenshot.data,'base64'));
  await page.eval("document.querySelector('[data-action=new-candidate-user]').click()");
  await wait(()=>page.eval("!!document.querySelector('form[data-form=provision-user]')"),'账号开通表单');
  await page.eval(`(()=>{const form=document.querySelector('form[data-form=provision-user]');
    form.elements.name.value='虚构浏览顾客';
    form.elements.email.value='visual-customer@example.test';
    form.elements.role.value='customer';form.elements.verificationRef.value='FICTIONAL-VISUAL-001';
    form.elements.temporaryPassword.value='Private#VisualCustomer2026A';
    form.requestSubmit();return true;})()`);
  await wait(()=>page.eval("document.body.innerText.includes('visual-customer@example.test')"),'浏览器开通顾客');
  await page.eval("document.querySelector('.top-logout').click()");
  await wait(()=>page.eval("location.hash==='#/login'&&!!document.querySelector('form[data-form=login]')"),
    '管理员退出');
  assert.equal(await page.eval("fetch('/api/me').then(response=>response.status)"),401);

  await page.eval(`(()=>{const form=document.querySelector('form[data-form=login]');
    form.elements.email.value='visual-customer@example.test';
    form.elements.password.value='Private#VisualCustomer2026A';form.requestSubmit();return true;})()`);
  await wait(()=>page.eval("!!document.querySelector('form[data-form=change-password]')"),
    '顾客首次改密页');
  assert.equal(await page.eval("fetch('/api/catalog?storeId=1').then(response=>response.status)"),403);
  await page.eval(`(()=>{const form=document.querySelector('form[data-form=change-password]');
    form.elements.currentPassword.value='Private#VisualCustomer2026A';
    form.elements.newPassword.value='Private#VisualCustomer2026B';form.requestSubmit();return true;})()`);
  await wait(()=>page.eval("!!document.querySelector('form[data-form=login]')"),'改密后重新登录');
  await page.eval(`(()=>{const form=document.querySelector('form[data-form=login]');
    form.elements.email.value='visual-customer@example.test';
    form.elements.password.value='Private#VisualCustomer2026B';form.requestSubmit();return true;})()`);
  await wait(()=>page.eval("location.hash==='#/catalog'&&!!document.querySelector('[data-action=search-catalog]')"),
    '虚构装备目录');
  await page.eval("document.querySelector('[data-action=search-catalog]').click()");
  await wait(()=>page.eval("document.querySelectorAll('.product').length>=10"),'选定时段后虚构库存');
  assert.equal(await page.eval("document.body.innerText.includes('虚构库存')"),true);
  assert.equal(await page.eval("document.body.innerText.includes('合成模拟 · 虚构资料')"),true);
  assert.equal(await page.eval("!!document.querySelector('.top-logout')"),true);
  assert.equal(await page.eval("!!document.querySelector('[data-route=cart]')"),true);
  assert.equal(await page.eval("document.documentElement.scrollWidth<=innerWidth+1"),true);

  await page.call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await pause(250);
  assert.equal(await page.eval("document.documentElement.scrollWidth<=innerWidth+1"),true);
  await wait(()=>page.eval("!document.querySelector('#toast.show')"),'登录提示消失');
  screenshot=await page.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  writeFileSync(join(output,'showcase-phase3-customer-mobile.png'),Buffer.from(screenshot.data,'base64'));
  assert.deepEqual(errors,[]);
  console.log('018-showcase-phase3-browser PASS: managed login, UI provisioning, logout, first password change, synthetic catalog and 390px layout');
}finally{
  page?.socket.close();browser?.socket.close();
  if(chrome&&chrome.exitCode===null){const closed=new Promise(done=>chrome.once('close',done));chrome.kill();await closed;}
  if(child&&child.exitCode===null){const closed=new Promise(done=>child.once('close',done));child.kill();await closed;}
  fixture.cleanup();
}
