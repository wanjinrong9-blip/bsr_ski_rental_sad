// Explicit Phase 4 browser acceptance: node test/018-showcase-browser.mjs
// Uses a disposable SHOWCASE DB, local trusted HTTPS proxy and fictional records.
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import {spawn} from 'node:child_process';
import {createHash,randomBytes,randomUUID,X509Certificate} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {checkServerIdentity} from 'node:tls';
import {makeShowcaseFixture,assertNoDemoRows} from './018-showcase-fixtures.mjs';
import {freePort} from './candidate-fixtures.mjs';
import {validateRuntimeConfig} from '../src/runtime-config.mjs';
import {initializeShowcase} from '../src/runtime-provenance.mjs';
import {openDb} from '../src/db.mjs';
import {candidateChangePassword,candidateProvisionAccount} from '../src/identity.mjs';
import {consent,approveCase} from './damage-helpers.mjs';
import {signBeforePay} from './fulfillment-helpers.mjs';
import {futureDate} from './future-date.mjs';

const root=resolve(import.meta.dirname,'..'),publicDir=join(root,'public');
const output=join(root,'test-results');mkdirSync(output,{recursive:true});
const chromePath=process.env.BSR_CHROME||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const roles=[
  {role:'admin',name:'虚构权限管理员',email:'browser-admin@example.test',password:'Private#BrowserAdmin2026A'},
  {role:'customer',name:'虚构浏览顾客',email:'browser-customer@example.test',password:'Private#BrowserCustomer2026B'},
  {role:'staff',name:'虚构租赁专员',email:'browser-staff@example.test',password:'Private#BrowserStaff2026B',storeId:1},
  {role:'manager',name:'虚构门店经理',email:'browser-manager@example.test',password:'Private#BrowserManager2026B',storeId:1},
  {role:'contractor',name:'虚构检修技师',email:'browser-tech@example.test',password:'Private#BrowserTech2026B',storeId:1},
  {role:'owner',name:'虚构经营负责人',email:'browser-owner@example.test',password:'Private#BrowserOwner2026B'}
];
const pause=ms=>new Promise(done=>setTimeout(done,ms));
async function wait(check,label){
  let lastError;
  for(let i=0;i<180;i++){
    try{if(await check())return;}catch(error){lastError=error;}
    await pause(100);
  }
  throw new Error('等待超时：'+label+(lastError?`；${lastError.message}`:''));
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
function provisionFictionalAccounts(db){
  const actor=db.prepare("SELECT * FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();
  for(const [index,account] of roles.entries()){
    if(index===0)continue;
    const temporaryPassword=`Private#BrowserTemp2026${index}A`;
    const created=candidateProvisionAccount(db,actor,{...account,temporaryPassword,
      verificationRef:`FICTIONAL-BROWSER-${index}`},{runMode:'showcase'});
    const current=db.prepare('SELECT * FROM users WHERE id=?').get(created.id);
    candidateChangePassword(db,current,{currentPassword:temporaryPassword,
      newPassword:account.password},{runMode:'showcase'});
  }
}
async function closeChild(child){
  if(child?.exitCode===null){const closed=new Promise(done=>child.once('close',done));child.kill();await closed;}
}

const fixture=await makeShowcaseFixture();
const domain='showcase-preview.example.test',proxyPort=await freePort();
const origin=`https://${domain}:${proxyPort}`,secret=randomBytes(32).toString('hex');
const env={...fixture.env,BSR_CANDIDATE_TRANSPORT:'trusted-local-proxy',
  BSR_PUBLIC_ORIGIN:origin,BSR_PROXY_SECRET:secret};
delete env.BSR_TLS_CERT_PATH;delete env.BSR_TLS_KEY_PATH;
let child,proxy,chrome,browser,page;const errors=[];
try{
  initializeShowcase(validateRuntimeConfig(env,{root,publicDir}),{
    operator:'018-trusted-browser',name:roles[0].name,
    email:roles[0].email,password:roles[0].password
  });
  {
    const db=openDb(fixture.dbPath,{runMode:'showcase'});
    try{provisionFictionalAccounts(db);assertNoDemoRows(db);}finally{db.close();}
  }
  proxy=https.createServer({cert:readFileSync(fixture.certPath),key:readFileSync(fixture.keyPath)},
    (incoming,outgoing)=>{
      const headers={...incoming.headers,host:`${domain}:${proxyPort}`,
        'x-bsr-proxy-secret':secret,'x-bsr-client-ip':incoming.socket.remoteAddress,
        'x-forwarded-proto':'https'};
      delete headers['x-forwarded-for'];
      const upstream=http.request({hostname:'127.0.0.1',port:fixture.port,path:incoming.url,
        method:incoming.method,headers},response=>{
          outgoing.writeHead(response.statusCode,response.headers);response.pipe(outgoing);
        });
      upstream.on('error',()=>{if(!outgoing.headersSent)outgoing.writeHead(502);outgoing.end();});
      incoming.pipe(upstream);
    });
  await new Promise((done,reject)=>proxy.once('error',reject).listen(proxyPort,'127.0.0.1',done));
  child=spawn(process.execPath,[join(root,'src','server.mjs')],{
    cwd:root,env:{...process.env,...env,NODE_ENV:'local'},
    stdio:['ignore','pipe','pipe'],windowsHide:true
  });
  let stderr='';child.stdout.resume();child.stderr.setEncoding('utf8');
  child.stderr.on('data',part=>{stderr+=part;});
  const request=(path,method='GET',data,cookie='')=>new Promise((done,reject)=>{
    const body=data===undefined?null:JSON.stringify(data);
    const headers={Host:`${domain}:${proxyPort}`,...(cookie?{Cookie:cookie}:{}),
      ...(method==='GET'?{}:{Origin:origin}),
      ...(body?{'content-type':'application/json','content-length':Buffer.byteLength(body)}:{}),
      ...(method==='POST'&&path==='/api/reservations'?{'Idempotency-Key':randomUUID()}:{})};
    const req=https.request({hostname:'127.0.0.1',port:proxyPort,path,method,
      ca:readFileSync(fixture.certPath),
      checkServerIdentity:(_host,certificate)=>checkServerIdentity('127.0.0.1',certificate),
      headers},response=>{
        const parts=[];response.on('data',part=>parts.push(part));response.on('end',()=>{
          const text=Buffer.concat(parts).toString('utf8');let data;
          try{data=JSON.parse(text);}catch{data=text;}
          done({status:response.statusCode,data,headers:response.headers,
            cookie:(response.headers['set-cookie']?.[0]||'').split(';')[0]});
        });
      });
    req.on('error',reject);if(body)req.write(body);req.end();
  });
  await wait(async()=>{
    if(child.exitCode!==null)throw new Error(stderr);
    const health=await request('/api/health');
    if(health.status!==200)throw new Error(JSON.stringify(health.data));
    return true;
  },'SHOWCASE 可信代理入口');

  const certificate=new X509Certificate(readFileSync(fixture.certPath));
  const spki=createHash('sha256').update(certificate.publicKey.export({format:'der',type:'spki'})).digest('base64');
  chrome=spawn(chromePath,[
    '--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
    '--no-proxy-server','--host-resolver-rules=MAP '+domain+' 127.0.0.1',
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
  await page.call('Page.enable');await page.call('Runtime.enable');await page.call('Network.enable');
  await page.call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await page.call('Page.navigate',{url:origin+'/#/login'});
  await wait(()=>page.eval("!!document.querySelector('form[data-form=login]')"),'代理后的登录页');
  assert.equal(await page.eval("document.body.innerText.includes('Demo123!')"),false);
  assert.equal(await page.eval("document.documentElement.scrollWidth<=innerWidth+1"),true);
  const loginRole=async account=>{
    await wait(()=>page.eval("!!document.querySelector('form[data-form=login]')"),'登录表单');
    await page.eval(`(()=>{const form=document.querySelector('form[data-form=login]');
      form.elements.email.value=${JSON.stringify(account.email)};
      form.elements.password.value=${JSON.stringify(account.password)};
      form.requestSubmit();return true;})()`);
    await wait(()=>page.eval("!!document.querySelector('.top-logout')"),account.role+' 工作台');
    assert.equal(await page.eval("document.body.innerText.includes('合成预览')"),true);
    assert.equal(await page.eval("document.documentElement.scrollWidth<=innerWidth+1"),true);
    const cookies=(await page.call('Network.getCookies',{urls:[origin]})).cookies;
    const session=cookies.find(item=>item.name==='__Host-bsr_showcase_session');
    assert.ok(session&&session.secure&&session.httpOnly&&session.sameSite==='Strict',
      account.role+' 必须使用受管理会话');
  };
  const logoutRole=async()=>{
    await page.eval("document.querySelector('.top-logout').click()");
    await wait(()=>page.eval("location.hash==='#/login'&&!!document.querySelector('form[data-form=login]')"),
      '退出并清除浏览器会话');
  };
  for(const account of roles){await loginRole(account);await logoutRole();}
  const sessions={};
  for(const account of roles){
    const result=await request('/api/auth/login','POST',
      {email:account.email,password:account.password});
    assert.equal(result.status,200,account.role+' 独立会话');
    sessions[account.role]=result.cookie;
  }
  const customerRequest=(path,method='GET',data)=>request(path,method,data,sessions.customer);
  const staffRequest=(path,method='GET',data)=>request(path,method,data,sessions.staff);
  const managerRequest=(path,method='GET',data)=>request(path,method,data,sessions.manager);
  const technicianRequest=(path,method='GET',data)=>request(path,method,data,sessions.contractor);
  const ownerRequest=(path,method='GET',data)=>request(path,method,data,sessions.owner);
  const byRole=(path,method='GET',data,cookie='')=>request(path,method,data,cookie);
  const profile=await customerRequest('/api/me','PATCH',{
    name:roles[1].name,address:'虚构顾客地址，仅供课程测试',birthYear:1999,
    heightCm:170,weightKg:66,shoeSize:'EU 41',phone:'+47 0000 0000'
  });
  assert.equal(profile.status,200,JSON.stringify(profile.data));
  const firstInput={storeId:1,pickupAt:futureDate(8),returnAt:futureDate(9),
    customerSkill:'中级',damageConsent:consent,items:[{variantId:1,qty:1}]};
  const quote=await customerRequest('/api/quote','POST',firstInput);
  assert.equal(quote.status,200,
    `T024 SHOWCASE 业务闸门仍关闭或报价失败：${JSON.stringify(quote.data)}`);
  assert.equal(quote.data.simulation,true,'报价必须标明模拟');
  assert.equal(quote.data.currency,'NOK');
  const clean=await customerRequest('/api/reservations','POST',firstInput);
  assert.equal(clean.status,201,JSON.stringify(clean.data));
  const cleanId=clean.data.id;
  await signBeforePay(byRole,cleanId,sessions.customer);
  const cleanPaid=await customerRequest(`/api/reservations/${cleanId}/pay`,'POST',{});
  assert.equal(cleanPaid.status,200,JSON.stringify(cleanPaid.data));
  assert.equal(cleanPaid.data.simulation,true,'付款响应必须标明模拟');
  let prep=(await staffRequest(`/api/preparations/${cleanId}`)).data;
  const staffUser=(await staffRequest('/api/me')).data;
  let updated=await managerRequest(`/api/preparations/${cleanId}`,'PATCH',
    {version:prep.version,action:'claim',assignedTo:staffUser.id});
  assert.equal(updated.status,200,JSON.stringify(updated.data));prep=updated.data;
  updated=await staffRequest(`/api/preparations/${cleanId}`,'PATCH',
    {version:prep.version,action:'pick'});
  assert.equal(updated.status,200,JSON.stringify(updated.data));prep=updated.data;
  updated=await staffRequest(`/api/preparations/${cleanId}`,'PATCH',
    {version:prep.version,action:'check',
      units:prep.units.map(unit=>({unitId:unit.unit_id,size:true,clean:true,safety:true}))});
  assert.equal(updated.status,200,JSON.stringify(updated.data));prep=updated.data;
  updated=await staffRequest(`/api/preparations/${cleanId}`,'PATCH',
    {version:prep.version,action:'ready'});
  assert.equal(updated.status,200,JSON.stringify(updated.data));
  const customerReady=await customerRequest(`/api/reservations/${cleanId}`);
  assert.equal(customerReady.status,200);
  assert.equal(customerReady.data.preparation.status,'READY');
  assert.equal(customerReady.data.preparation.handler_name,roles[2].name);
  await loginRole(roles[1]);
  await page.call('Page.navigate',{url:origin+'/#/orders'});
  await wait(()=>page.eval("!!document.querySelector('[data-route=orders]')"),'顾客预约进度');
  assert.equal(await page.eval("document.body.innerText.includes('合成')"),true);
  await wait(()=>page.eval("!document.querySelector('.toast.show')"),'登录提示消失');
  const desktop=await page.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  writeFileSync(join(output,'showcase-lifecycle-customer-desktop.png'),Buffer.from(desktop.data,'base64'));
  await page.call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await pause(250);
  assert.equal(await page.eval("document.documentElement.scrollWidth<=innerWidth+1"),true);
  await wait(()=>page.eval("!document.querySelector('.toast.show')"),'移动页面提示消失');
  const mobile=await page.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  writeFileSync(join(output,'showcase-lifecycle-customer-mobile.png'),Buffer.from(mobile.data,'base64'));
  await logoutRole();
  const picked=await staffRequest('/api/operations/pickup','POST',{code:cleanPaid.data.pickupCode});
  assert.equal(picked.status,200,JSON.stringify(picked.data));
  const returned=await staffRequest('/api/operations/return','POST',{
    reservationId:cleanId,code:clean.data.code,returnStoreId:1,
    items:[{unitId:picked.data.units[0].unitId,condition:'GOOD',note:'虚构完好验收'}]
  });
  assert.equal(returned.status,200,JSON.stringify(returned.data));
  const cleanDetail=await customerRequest(`/api/reservations/${cleanId}`);
  assert.equal(cleanDetail.data.status,'COMPLETED');
  assert.equal(cleanDetail.data.payments.filter(payment=>payment.type==='REFUND').length,1);

  const damagedInput={storeId:1,pickupAt:futureDate(12),returnAt:futureDate(13),
    customerSkill:'中级',damageConsent:consent,items:[{variantId:2,qty:1}]};
  const damaged=await customerRequest('/api/reservations','POST',damagedInput);
  assert.equal(damaged.status,201,JSON.stringify(damaged.data));
  await signBeforePay(byRole,damaged.data.id,sessions.customer);
  const damagedPaid=await customerRequest(`/api/reservations/${damaged.data.id}/pay`,'POST',{});
  assert.equal(damagedPaid.status,200);
  prep=(await staffRequest(`/api/preparations/${damaged.data.id}`)).data;
  updated=await managerRequest(`/api/preparations/${damaged.data.id}`,'PATCH',
    {version:prep.version,action:'claim',assignedTo:staffUser.id});
  assert.equal(updated.status,200);prep=updated.data;
  updated=await staffRequest(`/api/preparations/${damaged.data.id}`,'PATCH',
    {version:prep.version,action:'pick'});assert.equal(updated.status,200);prep=updated.data;
  updated=await staffRequest(`/api/preparations/${damaged.data.id}`,'PATCH',
    {version:prep.version,action:'check',units:prep.units.map(unit=>({unitId:unit.unit_id,size:true,clean:true,safety:true}))});
  assert.equal(updated.status,200);prep=updated.data;
  updated=await staffRequest(`/api/preparations/${damaged.data.id}`,'PATCH',
    {version:prep.version,action:'ready'});assert.equal(updated.status,200);
  const damagedPicked=await staffRequest('/api/operations/pickup','POST',
    {code:damagedPaid.data.pickupCode});
  assert.equal(damagedPicked.status,200);
  const damagedReturned=await staffRequest('/api/operations/return','POST',{
    reservationId:damaged.data.id,code:damaged.data.code,returnStoreId:1,
    items:[{unitId:damagedPicked.data.units[0].unitId,condition:'DAMAGED',
      note:'虚构板面边缘缺口'}]
  });
  assert.equal(damagedReturned.status,200);
  const review=(await managerRequest(`/api/reservations/${damaged.data.id}`)).data;
  assert.equal(review.status,'REVIEW');
  assert.ok(review.damage.cases.length>0);
  await approveCase(byRole,review.damage.cases[0].id,sessions.contractor,sessions.manager,180);
  const settlement=await managerRequest(`/api/operations/refunds/${damaged.data.id}/approve`,'POST',{});
  assert.equal(settlement.status,200,JSON.stringify(settlement.data));
  assert.equal(settlement.data.simulation,true,'退款或抵扣必须标明模拟');
  const damagedDetail=await customerRequest(`/api/reservations/${damaged.data.id}`);
  assert.equal(damagedDetail.status,200);
  assert.equal(damagedDetail.data.payments.filter(payment=>payment.type==='REFUND').length,1);
  assert.ok(damagedDetail.data.refund_nok<damagedDetail.data.deposit_nok);
  assert.equal((await ownerRequest('/api/reports')).status,200);
  assert.equal((await request('/api/audit','GET',undefined,sessions.admin)).status,200);
  await page.call('Emulation.setDeviceMetricsOverride',{
    width:1440,height:900,deviceScaleFactor:1,mobile:false
  });
  await loginRole(roles[3]);
  await page.call('Page.navigate',{url:origin+'/#/operations'});
  await wait(()=>page.eval("!!document.querySelector('[data-form=lookup]')"),'经理订单核验入口');
  await page.eval(`(()=>{const form=document.querySelector('[data-form=lookup]');form.elements.code.value=${JSON.stringify(damaged.data.code)};form.requestSubmit();return true;})()`);
  await wait(()=>page.eval("!!document.querySelector('.damage-order-section .damage-settlement-grid')"),
    '经理受损结算详情');
  assert.equal(await page.eval("document.querySelector('.damage-order-section').textContent.includes('课程合成情景')"),true);
  await wait(()=>page.eval("!document.querySelector('.toast.show')"),'经理查询提示消失');
  await page.eval("document.querySelector('.damage-order-section').scrollIntoView({block:'start'})");
  await pause(150);
  for(const viewport of [
    {name:'desktop',width:1440,height:900,mobile:false},
    {name:'mobile',width:390,height:844,mobile:true}
  ]){
    await page.call('Emulation.setDeviceMetricsOverride',{
      width:viewport.width,height:viewport.height,deviceScaleFactor:1,mobile:viewport.mobile
    });
    await page.eval("(()=>{const modal=document.querySelector('.modal'),section=modal.querySelector('.damage-order-section');modal.scrollTop+=section.getBoundingClientRect().top-modal.getBoundingClientRect().top-18;return modal.scrollTop;})()");
    await pause(100);
    assert.equal(await page.eval('document.documentElement.scrollWidth<=innerWidth+1'),true);
    const shot=await page.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    writeFileSync(join(output,`showcase-manager-settlement-${viewport.name}.png`),Buffer.from(shot.data,'base64'));
  }
  await logoutRole();
  for(const scenario of [
    {name:'desktop',width:1440,height:900,mobile:false,variantId:3},
    {name:'mobile',width:390,height:844,mobile:true,variantId:4}
  ]){
    await page.call('Emulation.setDeviceMetricsOverride',{
      width:scenario.width,height:scenario.height,deviceScaleFactor:1,mobile:scenario.mobile
    });
    const before=(await customerRequest('/api/reservations')).data.length;
    await loginRole(roles[1]);
    await page.call('Page.navigate',{url:origin+'/#/catalog'});
    await wait(()=>page.eval("!!document.querySelector('[data-action=search-catalog]')"),
      scenario.name+' 租期入口');
    await page.eval("document.querySelector('[data-action=search-catalog]').click()");
    await wait(()=>page.eval(`!!document.querySelector('[data-add="${scenario.variantId}"]:not(:disabled)')`),
      scenario.name+' 实时可订商品');
    await page.eval(`document.querySelector('[data-add="${scenario.variantId}"]').click()`);
    await wait(()=>page.eval("!!document.querySelector('.top-cart')"),'购物车入口');
    await page.eval("document.querySelector('.top-cart').click()");
    await wait(()=>page.eval("!!document.querySelector('[data-action=cart]:not(:disabled)')"),
      scenario.name+' 费用预览');
    await page.eval("document.querySelector('[data-action=cart]').click()");
    await wait(()=>page.eval("!!document.querySelector('[data-form=damage-consent]')"),
      scenario.name+' 损坏规则');
    await page.eval("(()=>{const area=document.querySelector('[data-damage-policy-scroll]');area.scrollTop=area.scrollHeight;area.dispatchEvent(new Event('scroll',{bubbles:true}));const checkbox=document.querySelector('[data-damage-agree]');if(checkbox.disabled)throw Error('rules unread');checkbox.checked=true;checkbox.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-damage-continue]').click();return true;})()");
    await wait(()=>page.eval("!!document.querySelector('#checkout-skill')"),
      scenario.name+' 预约核对');
    await page.eval("(()=>{const skill=document.querySelector('#checkout-skill');skill.value='中级';skill.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('.modal .cost-list').scrollIntoView({block:'center'});return true;})()");
    await wait(()=>page.eval("!document.querySelector('.toast.show')"),scenario.name+' 加购提示消失');
    const checkoutShot=await page.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    writeFileSync(join(output,`showcase-customer-checkout-${scenario.name}.png`),Buffer.from(checkoutShot.data,'base64'));
    await page.eval("document.querySelector('[data-action=create-reservation]').click()");
    await wait(()=>page.eval("location.hash==='#/orders'&&!!document.querySelector('.order-card')"),
      scenario.name+' 页面创建预约');
    const booked=(await customerRequest('/api/reservations')).data;
    assert.equal(booked.length,before+1,scenario.name+' 页面只创建一笔预约');
    const uiOrder=booked[0];
    assert.equal(uiOrder.lines[0].variant_id,scenario.variantId);
    assert.equal(uiOrder.status,'HOLD');
    assert.equal(await page.eval('document.documentElement.scrollWidth<=innerWidth+1'),true);
    await logoutRole();

    await signBeforePay(byRole,uiOrder.id,sessions.customer);
    const uiPaid=await customerRequest(`/api/reservations/${uiOrder.id}/pay`,'POST',{});
    assert.equal(uiPaid.status,200,JSON.stringify(uiPaid.data));
    let uiPrep=(await staffRequest(`/api/preparations/${uiOrder.id}`)).data;
    await loginRole(roles[2]);
    await page.call('Page.navigate',{url:origin+'/#/preparations'});
    await wait(()=>page.eval(`Array.from(document.querySelectorAll('.prep-ticket')).some(ticket=>ticket.textContent.includes(${JSON.stringify(uiOrder.code)}))`),
      scenario.name+' 店员备货队列');
    await page.eval(`document.querySelector('[data-preparation="${uiOrder.id}"]').click()`);
    await wait(()=>page.eval("!!document.querySelector('[data-prep-action=claim]')"),
      scenario.name+' 店员接单操作');
    await wait(()=>page.eval("!document.querySelector('.toast.show')"),scenario.name+' 备货提示消失');
    assert.equal(await page.eval('document.documentElement.scrollWidth<=innerWidth+1'),true);
    const prepShot=await page.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    writeFileSync(join(output,`showcase-staff-prep-action-${scenario.name}.png`),Buffer.from(prepShot.data,'base64'));
    await logoutRole();
    for(const [role,action,payload] of [
      ['manager','claim',{assignedTo:staffUser.id}],
      ['staff','pick',{}],
      ['staff','check',null],
      ['staff','ready',{}]
    ]){
      const body={version:uiPrep.version,action,
        ...(action==='check'?{units:uiPrep.units.map(unit=>({unitId:unit.unit_id,size:true,clean:true,safety:true}))}:payload)};
      const updated=await (role==='manager'?managerRequest:staffRequest)(
        `/api/preparations/${uiOrder.id}`,'PATCH',body);
      assert.equal(updated.status,200,JSON.stringify(updated.data));
      uiPrep=updated.data;
    }
    await loginRole(roles[2]);
    await page.call('Page.navigate',{url:origin+'/#/operations'});
    await wait(()=>page.eval(`!!document.querySelector('[data-order="${uiOrder.id}"]')`),
      scenario.name+' 店员待交付订单');
    await page.eval(`document.querySelector('[data-order="${uiOrder.id}"]').click()`);
    await wait(()=>page.eval(`!!document.querySelector('[data-pickup="${uiOrder.id}"]:not(:disabled)')`),
      scenario.name+' 店员核码交付按钮');
    await page.eval(`document.querySelector('[data-pickup="${uiOrder.id}"]').click()`);
    await wait(async()=>((await staffRequest(`/api/reservations/${uiOrder.id}`)).data.status==='ACTIVE'),
      scenario.name+' 页面完成交付');
    assert.equal(await page.eval('document.documentElement.scrollWidth<=innerWidth+1'),true);
    await logoutRole();
  }
  const visualRoutes=[
    ['customer','cart','购物车'],
    ['staff','preparations','把装备准备好'],
    ['manager','shifts','每日排班与出勤'],
    ['contractor','damage-cases','受损鉴定与证据'],
    ['owner','reports','从数据看见门店表现'],
    ['admin','audit','关键操作，全程留痕']
  ];
  for(const [role,route,title] of visualRoutes){
    await page.call('Emulation.setDeviceMetricsOverride',{
      width:1440,height:900,deviceScaleFactor:1,mobile:false
    });
    await loginRole(roles.find(account=>account.role===role));
    await page.call('Page.navigate',{url:origin+'/#/'+route});
    await wait(()=>page.eval(`document.querySelector('.page-head h1')?.textContent?.includes(${JSON.stringify(title)})`),
      role+' 的 '+route+' 页面');
    assert.equal(await page.eval("document.querySelector('.synthetic-boundary')!==null"),true);
    assert.equal(await page.eval('document.documentElement.scrollWidth<=innerWidth+1'),true,
      role+' desktop horizontal overflow');
    if(role==='contractor')assert.equal(await page.eval("document.body.innerText.includes('虚构检修技师')"),true);
    if(role==='staff')assert.equal(await page.eval("document.body.innerText.includes('虚构租赁专员')"),true);
    const desktopView=await page.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    writeFileSync(join(output,`showcase-${role}-${route}-desktop.png`),Buffer.from(desktopView.data,'base64'));
    await page.call('Emulation.setDeviceMetricsOverride',{
      width:390,height:844,deviceScaleFactor:1,mobile:true
    });
    await pause(200);
    assert.equal(await page.eval('document.documentElement.scrollWidth<=innerWidth+1'),true,
      role+' 390px horizontal overflow');
    const mobileView=await page.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    writeFileSync(join(output,`showcase-${role}-${route}-mobile.png`),Buffer.from(mobileView.data,'base64'));
    await logoutRole();
  }
  assert.deepEqual(errors,[]);
  console.log('018-showcase-browser PASS: six managed roles, trusted proxy, two terminal outcomes, desktop/390px browser booking and staff handoff, 12 role-route views');
}finally{
  page?.socket.close();browser?.socket.close();
  if(chrome&&chrome.exitCode===null){const closed=new Promise(done=>chrome.once('close',done));chrome.kill();await closed;}
  await closeChild(child);
  if(proxy){proxy.closeAllConnections();await new Promise(done=>proxy.close(done));}
  await pause(150);fixture.cleanup();
}
