// Isolated browser + Mini HTTP acceptance. Run explicitly:
// node test/019-web-mini-e2e.mjs
// A fake WeChat response exists only in this NODE_ENV=test process.
import assert from 'node:assert/strict';
import {createHash,X509Certificate} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {hashPassword,openDb} from '../src/db.mjs';
import {makeShowcaseFixture} from './018-showcase-fixtures.mjs';
import {readySyntheticSource} from './018-showcase-ready-fixture.mjs';
import {candidateRequest} from './candidate-fixtures.mjs';
import {futureDate} from './future-date.mjs';
import {approveCase,consent} from './damage-helpers.mjs';

const root=resolve(import.meta.dirname,'..');
const output=join(root,'test-results');
mkdirSync(output,{recursive:true});
const chromePath=process.env.BSR_CHROME||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const email='mini-browser-customer@example.test';
const password='Private#MiniBrowser2026';
const staffEmail='mini-browser-staff@example.test';
const managerEmail='mini-browser-manager@example.test';
const technicianEmail='mini-browser-tech@example.test';
const appId='wx1234567890abcdef';
const code='miniBrowserCode0123456789';
const openid='oB00000000000000000000000000';
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
let server,db,chrome,browser,page;
const errors=[];
const realFetch=globalThis.fetch;
let fakeWechatCalls=0;
try{
  readySyntheticSource(fixture.dbPath);
  {
    const seeded=openDb(fixture.dbPath,{runMode:'showcase'});
    try{
      const now=new Date().toISOString();
      seeded.prepare('INSERT INTO users (name,email,password_hash,role,created_at,account_state,provisioning_method,verified_at,must_change_password,auth_epoch) VALUES (?,?,?, ?,? , ?, ?, ?,0,1)')
        .run('虚构双端顾客',email,hashPassword(password),'customer',now,'ACTIVE','OFFLINE_ADMIN',now);
      seeded.prepare('UPDATE users SET phone=?,address=?,birth_year=?,height_cm=?,weight_kg=?,shoe_size=? WHERE email=?')
        .run('+47 9000 2026','虚构挪威地址',1999,172,68,'EU 42',email);
      const addWorker=seeded.prepare('INSERT INTO users (name,email,password_hash,role,store_id,created_at,account_state,provisioning_method,verified_at,must_change_password,auth_epoch) VALUES (?,?,?,?,?,?,?,?,?,0,1)');
      addWorker.run('虚构双端租赁专员',staffEmail,hashPassword(password),'staff',1,
        now,'ACTIVE','OFFLINE_ADMIN',now);
      addWorker.run('虚构双端经理',managerEmail,hashPassword(password),'manager',1,
        now,'ACTIVE','OFFLINE_ADMIN',now);
      addWorker.run('虚构双端检修技师',technicianEmail,hashPassword(password),'contractor',1,
        now,'ACTIVE','OFFLINE_ADMIN',now);
    }finally{seeded.close();}
  }
  Object.assign(process.env,fixture.env,{
    NODE_ENV:'test',
    BSR_WECHAT_MINI_ENABLED:'1',
    BSR_WECHAT_APP_ID:appId,
    BSR_WECHAT_APP_SECRET:'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6',
    BSR_WECHAT_OPENID_KEY:'browser-mini-independent-openid-key-2026'
  });
  globalThis.fetch=(url,options)=>{
    if(String(url).startsWith('https://api.weixin.qq.com/sns/jscode2session?')){
      const query=new URL(String(url)).searchParams;
      assert.equal(query.get('appid'),appId);
      assert.equal(query.get('js_code'),code);
      fakeWechatCalls++;
      return Promise.resolve(new Response(JSON.stringify({
        openid,session_key:'isolated-test-session-key'
      }),{status:200,headers:{'content-type':'application/json'}}));
    }
    return realFetch(url,options);
  };
  ({server,db}=await import('../src/server.mjs'));
  await new Promise((done,reject)=>server.once('error',reject).listen(fixture.port,'127.0.0.1',done));
  const req=(path,{method='GET',body,cookie,token,key}={})=>
    candidateRequest(fixture,path,{method,body,headers:{
      ...(cookie?{Cookie:cookie}:{}),
      ...(token?{Authorization:'Bearer '+token}:{}),
      ...(key?{'Idempotency-Key':key}:{}),
      ...(method==='GET'||path.startsWith('/api/mini/')?{}:{Origin:fixture.origin})
    }});
  assert.equal((await req('/api/health')).status,200);
  assert.equal((await req('/api/mini/bootstrap')).data.status,'ready');

  const certificate=new X509Certificate(readFileSync(fixture.certPath));
  const spki=createHash('sha256')
    .update(certificate.publicKey.export({format:'der',type:'spki'})).digest('base64');
  chrome=spawn(chromePath,[
    '--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
    '--no-proxy-server','--remote-debugging-port=0',
    '--ignore-certificate-errors-spki-list='+spki,
    '--user-data-dir='+join(fixture.dir,'chrome'),'about:blank'
  ],{windowsHide:true,stdio:'ignore'});
  await wait(()=>existsSync(join(fixture.dir,'chrome','DevToolsActivePort')),'Chrome 调试端口');
  const [debugPort,debugPath]=readFileSync(join(fixture.dir,'chrome','DevToolsActivePort'),'utf8').trim().split('\n');
  browser=await connect('ws://127.0.0.1:'+debugPort+debugPath.trim(),errors);
  const {targetId}=await browser.call('Target.createTarget',{url:'about:blank'});
  const targets=await (await realFetch('http://127.0.0.1:'+debugPort+'/json/list')).json();
  page=await connect(targets.find(target=>target.id===targetId).webSocketDebuggerUrl,errors);
  await page.call('Page.enable');await page.call('Runtime.enable');await page.call('Network.enable');
  await page.call('Emulation.setDeviceMetricsOverride',
    {width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await page.call('Page.navigate',{url:fixture.origin+'/#/login'});
  await wait(()=>page.eval("!!document.querySelector('form[data-form=login]')"),'顾客登录表单');
  await page.eval('(()=>{const f=document.querySelector("form[data-form=login]");'
    +'f.elements.email.value='+JSON.stringify(email)+';'
    +'f.elements.password.value='+JSON.stringify(password)+';f.requestSubmit();return true})()');
  await wait(()=>page.eval("!!document.querySelector('.top-logout')"),'顾客网页会话');
  assert.equal(await page.eval("document.body.innerText.includes('合成')"),true);
  const cookies=(await page.call('Network.getCookies',{urls:[fixture.origin]})).cookies;
  const cookie=cookies.find(item=>item.name==='__Host-bsr_showcase_session');
  assert.ok(cookie?.httpOnly&&cookie?.secure&&cookie?.sameSite==='Strict');

  const miniEntry=await req('/api/mini-entry');
  assert.equal(miniEntry.status,200);
  assert.equal(miniEntry.data.status,'off');
  await page.call('Page.navigate',{url:fixture.origin+'/#/mini'});
  await wait(()=>page.eval("!!document.querySelector('.mini-entry-card')"),
    '网页小程序筹备入口');
  assert.equal(await page.eval("document.body.innerText.includes('小程序筹备中')"),true);
  assert.equal(await page.eval("!!document.querySelector('img[alt=\"BSR 微信小程序扫码图片\"]')"),false);
  assert.equal(await page.eval('document.documentElement.scrollWidth<=innerWidth+1'),true);
  await page.call('Emulation.setDeviceMetricsOverride',
    {width:390,height:844,deviceScaleFactor:1,mobile:true});
  await pause(250);
  assert.equal(await page.eval('document.documentElement.scrollWidth<=innerWidth+1'),true);
  const miniEntryMobile=await page.call('Page.captureScreenshot',
    {format:'png',captureBeyondViewport:false});
  writeFileSync(join(output,'019-mini-entry-off-390px.png'),
    Buffer.from(miniEntryMobile.data,'base64'));
  await page.call('Emulation.setDeviceMetricsOverride',
    {width:1440,height:900,deviceScaleFactor:1,mobile:false});

  const login=await req('/api/mini/auth/wechat',{method:'POST',body:{code}});
  assert.equal(login.status,200,JSON.stringify(login.data));
  const bound=await req('/api/mini/auth/bind',{method:'POST',body:{
    challenge:login.data.challenge,email,password,explicitConsent:true
  }});
  assert.equal(bound.status,200,JSON.stringify(bound.data));
  const token=bound.data.sessionToken;
  assert.equal(fakeWechatCalls,1);
  assert.equal((await req('/api/mini/me',{cookie:cookie.name+'='+cookie.value})).status,401);
  assert.equal((await req('/api/cart',{token})).status,401);
  const webMe=await page.eval('(async()=>{const r=await fetch("/api/me");'
    +'return {status:r.status,data:await r.json()}})()');
  const miniMe=await req('/api/mini/me',{token});
  assert.equal(webMe.status,200);
  assert.equal(miniMe.status,200);
  assert.equal(webMe.data.id,miniMe.data.id);
  assert.equal(miniMe.data.id,bound.data.user.id);

  const rental={storeId:1,pickupAt:futureDate(9),returnAt:futureDate(10)};
  const browserPut=await page.eval('(async()=>{const r=await fetch("/api/cart",{method:"PUT",'
    +'headers:{"content-type":"application/json"},body:JSON.stringify('
    +JSON.stringify({expectedVersion:0,...rental,items:[{variantId:1,qty:1}]})
    +')});return {status:r.status,data:await r.json()}})()');
  assert.equal(browserPut.status,200,JSON.stringify(browserPut.data));
  const miniSaw=await req('/api/mini/cart',{token});
  assert.equal(miniSaw.status,200);
  assert.equal(miniSaw.data.version,browserPut.data.version);
  assert.deepEqual(miniSaw.data.items.map(item=>({variantId:item.variantId,qty:item.qty})),
    [{variantId:1,qty:1}]);

  const miniPut=await req('/api/mini/cart',{method:'PUT',token,body:{
    expectedVersion:miniSaw.data.version,...rental,items:[{variantId:1,qty:2}]
  }});
  assert.equal(miniPut.status,200,JSON.stringify(miniPut.data));
  const browserSaw=await page.eval('(async()=>{const r=await fetch("/api/cart");'
    +'return {status:r.status,data:await r.json()}})()');
  assert.equal(browserSaw.status,200);
  assert.equal(browserSaw.data.version,miniPut.data.version);
  assert.equal(browserSaw.data.items[0].qty,2);

  const quote=await req('/api/mini/quote',{method:'POST',token,
    body:{cartVersion:miniPut.data.version}});
  assert.equal(quote.status,200,JSON.stringify(quote.data));
  assert.equal(quote.data.currency,'NOK');
  const created=await req('/api/mini/reservations',{method:'POST',token,
    key:'019-browser-mini-quote-2026',body:{
      quoteId:quote.data.quoteId,cartVersion:miniPut.data.version,
      customerSkill:'初级',damageConsent:consent
    }});
  assert.equal(created.status,201,JSON.stringify(created.data));
  assert.equal(created.data.simulation,true);
  const id=created.data.id;
  const webDetail=await page.eval('(async()=>{const r=await fetch("/api/reservations/'+id+'");'
    +'return {status:r.status,data:await r.json()}})()');
  const miniDetail=await req('/api/mini/reservations/'+id,{token});
  assert.equal(webDetail.status,200);
  assert.equal(miniDetail.status,200);
  assert.equal(webDetail.data.id,miniDetail.data.id);
  assert.equal(webDetail.data.total_nok,miniDetail.data.total_nok);
  assert.equal(webDetail.data.deposit_nok,miniDetail.data.deposit_nok);
  assert.equal(webDetail.data.code,miniDetail.data.code);

  await page.call('Page.navigate',{url:fixture.origin+'/#/orders'});
  await wait(()=>page.eval('!!document.querySelector("[data-order=\\"'+id+'\\"]")'),
    '网页订单列表出现小程序订单');
  assert.equal(await page.eval('document.body.innerText.includes('
    +JSON.stringify(created.data.code)+')'),true);
  assert.equal(await page.eval('document.documentElement.scrollWidth<=innerWidth+1'),true);
  await wait(()=>page.eval("!document.querySelector('.toast.show')"),'登录提示消失');
  const desktop=await page.call('Page.captureScreenshot',
    {format:'png',captureBeyondViewport:false});
  writeFileSync(join(output,'019-web-mini-browser-desktop.png'),Buffer.from(desktop.data,'base64'));
  await page.call('Emulation.setDeviceMetricsOverride',
    {width:390,height:844,deviceScaleFactor:1,mobile:true});
  await pause(250);
  assert.equal(await page.eval('document.documentElement.scrollWidth<=innerWidth+1'),true);
  const mobile=await page.call('Page.captureScreenshot',
    {format:'png',captureBeyondViewport:false});
  writeFileSync(join(output,'019-web-mini-browser-390px.png'),Buffer.from(mobile.data,'base64'));
  const managedLogin=async accountEmail=>{
    const result=await req('/api/auth/login',{method:'POST',
      body:{email:accountEmail,password}});
    assert.equal(result.status,200,JSON.stringify(result.data));
    return result.headers['set-cookie'][0].split(';')[0];
  };
  const staffCookie=await managedLogin(staffEmail);
  const managerCookie=await managedLogin(managerEmail);
  const techCookie=await managedLogin(technicianEmail);
  const web=(path,method='GET',body,cookie)=>
    req(path,{method,body,cookie});
  const issued=await req('/api/mini/reservations/'+id+'/contracts',
    {method:'POST',token});
  assert.equal(issued.status,201,JSON.stringify(issued.data));
  const signed=await req('/api/mini/contracts/'+issued.data.id+'/sign',
    {method:'POST',token,body:{accepted:true,
      snapshotHash:issued.data.snapshot_hash,name:'虚构双端顾客'}});
  assert.equal(signed.status,200,JSON.stringify(signed.data));
  const paid=await req('/api/mini/reservations/'+id+'/pay',{method:'POST',token});
  assert.equal(paid.status,200,JSON.stringify(paid.data));
  let prep=await web('/api/preparations/'+id,'GET',undefined,staffCookie);
  assert.equal(prep.status,200,JSON.stringify(prep.data));
  const staff=(await web('/api/me','GET',undefined,staffCookie)).data;
  let changed=await web('/api/preparations/'+id,'PATCH',
    {version:prep.data.version,action:'claim',assignedTo:staff.id},managerCookie);
  assert.equal(changed.status,200,JSON.stringify(changed.data));
  prep=changed;
  changed=await web('/api/preparations/'+id,'PATCH',
    {version:prep.data.version,action:'pick'},staffCookie);
  assert.equal(changed.status,200,JSON.stringify(changed.data));
  prep=changed;
  changed=await web('/api/preparations/'+id,'PATCH',
    {version:prep.data.version,action:'check',
      units:prep.data.units.map(unit=>({
        unitId:unit.unit_id,size:true,clean:true,safety:true
      }))},staffCookie);
  assert.equal(changed.status,200,JSON.stringify(changed.data));
  prep=changed;
  changed=await web('/api/preparations/'+id,'PATCH',
    {version:prep.data.version,action:'ready'},staffCookie);
  assert.equal(changed.status,200,JSON.stringify(changed.data));
  const miniReady=await req('/api/mini/reservations/'+id,{token});
  assert.equal(miniReady.data.preparation.status,'READY');
  assert.equal(miniReady.data.workflow.currentKey,'PICKUP');

  const picked=await web('/api/operations/pickup','POST',
    {code:paid.data.pickupCode},staffCookie);
  assert.equal(picked.status,200,JSON.stringify(picked.data));
  const returned=await web('/api/operations/return','POST',{
    reservationId:id,code:created.data.code,returnStoreId:1,
    items:picked.data.units.map((unit,index)=>({
      unitId:unit.unitId,condition:index===0?'DAMAGED':'GOOD',
      note:index===0?'虚构护膝外层存在可修复破损':'虚构完好验收'
    }))
  },staffCookie);
  assert.equal(returned.status,200,JSON.stringify(returned.data));
  const miniPending=await req('/api/mini/reservations/'+id,{token});
  assert.equal(miniPending.data.status,'REVIEW');
  assert.equal(miniPending.data.damage.cases.length,1);
  assert.equal(miniPending.data.refund_nok,0);
  const damageId=miniPending.data.damage.cases[0].id;
  assert.equal(Date.parse(miniPending.data.damage.cases[0].feedback_due_at)
    -Date.parse(miniPending.data.damage.cases[0].created_at),24*3600000);
  await approveCase(web,damageId,techCookie,managerCookie,180);
  const settlement=await web('/api/operations/refunds/'+id+'/approve',
    'POST',{},managerCookie);
  assert.equal(settlement.status,200,JSON.stringify(settlement.data));
  assert.equal(settlement.data.status,'SETTLEMENT');
  assert.ok(settlement.data.supplementNok>0);
  const miniAwaiting=await req('/api/mini/reservations/'+id,{token});
  assert.equal(miniAwaiting.data.damage.settlement.status,'AWAITING_CONTACT');
  assert.equal(miniAwaiting.data.refund_nok,0);
  const contacted=await web('/api/reservations/'+id+'/damage/contact',
    'POST',{channel:'PHONE',outcome:'REACHED',
      note:'已向虚构顾客说明照片、核价与补差金额'},staffCookie);
  assert.equal(contacted.status,200,JSON.stringify(contacted.data));
  const miniContacted=await req('/api/mini/reservations/'+id,{token});
  assert.equal(miniContacted.data.damage.settlement.status,'CONTACTED');
  const supplement=await web('/api/reservations/'+id+'/damage/supplement',
    'POST',{version:miniContacted.data.damage.settlement.version,
      amountNok:settlement.data.supplementNok,
      reference:'SYN-019-BROWSER-MINI',confirmed:true},staffCookie);
  assert.equal(supplement.status,200,JSON.stringify(supplement.data));
  const miniComplete=await req('/api/mini/reservations/'+id,{token});
  assert.equal(miniComplete.data.status,'COMPLETED');
  assert.equal(miniComplete.data.damage.settlement.status,'SETTLED');
  assert.equal(miniComplete.data.workflow.currentKey,'DONE');
  const webComplete=await page.eval('(async()=>{const r=await fetch("/api/reservations/'+id+'");'
    +'return {status:r.status,data:await r.json()}})()');
  assert.equal(webComplete.status,200);
  assert.equal(webComplete.data.id,miniComplete.data.id);
  assert.equal(webComplete.data.status,miniComplete.data.status);
  await page.call('Page.reload',{ignoreCache:true});
  await wait(()=>page.eval('!!document.querySelector("[data-order=\\"'+id+'\\"]")'),
    '网页刷新后显示受损订单终态');
  await wait(()=>page.eval('document.querySelector(".order-card")?.innerText.includes("已完成")'),
    '网页订单卡展示受损结清');
  assert.equal(await page.eval('document.documentElement.scrollWidth<=innerWidth+1'),true);
  const finalMobile=await page.call('Page.captureScreenshot',
    {format:'png',captureBeyondViewport:false});
  writeFileSync(join(output,'019-web-mini-damage-390px.png'),
    Buffer.from(finalMobile.data,'base64'));
  assert.deepEqual(errors,[]);
  console.log('019-web-mini-e2e PASS: managed Chrome customer and independent Mini bearer share cart and one NOK order through Web staff preparation, damaged return, 24h assessment, supplement and completion; 1440/390px no horizontal overflow');
}finally{
  globalThis.fetch=realFetch;
  page?.socket.close();browser?.socket.close();
  if(chrome&&chrome.exitCode===null){
    const closed=new Promise(done=>chrome.once('close',done));
    chrome.kill();await closed;
  }
  if(server){
    server.closeAllConnections();
    await new Promise(done=>server.close(done));
  }
  db?.close();
  await pause(100);
  fixture.cleanup();
}
