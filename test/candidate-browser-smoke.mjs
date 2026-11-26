// Run explicitly after candidate implementation: node test/candidate-browser-smoke.mjs
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,X509Certificate} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {makeCandidateFixture,candidateRequest} from './candidate-fixtures.mjs';
import {validateRuntimeConfig} from '../src/runtime-config.mjs';
import {initializeCandidate} from '../src/runtime-provenance.mjs';
import {hashPassword,openDb} from '../src/db.mjs';
import {testPhoto} from './damage-helpers.mjs';

const root=resolve(import.meta.dirname,'..'),publicDir=join(root,'public');
const output=join(root,'test-results');mkdirSync(output,{recursive:true});
const chromePath=process.env.BSR_CHROME||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(fn,label){for(let i=0;i<120;i++){if(await fn())return;await pause(75);}throw new Error('等待超时：'+label);}

async function connect(url,errors){
  const socket=new WebSocket(url);
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  let seq=0;const pending=new Map();
  socket.onmessage=event=>{
    const message=JSON.parse(event.data);
    if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text);
    const item=pending.get(message.id);
    if(item){pending.delete(message.id);clearTimeout(item.timer);
      message.error?item.reject(new Error(message.error.message)):item.resolve(message.result);}
  };
  return {
    socket,
    call(method,params={}){return new Promise((resolve,reject)=>{
      const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP 超时：'+method));},10000);
      pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));
    });},
    async eval(expression){
      const response=await this.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
      if(response.exceptionDetails)throw new Error(response.exceptionDetails.exception?.description||response.exceptionDetails.text);
      return response.result.value;
    }
  };
}

const fixture=await makeCandidateFixture('bsr-candidate-browser-');
const config=validateRuntimeConfig(fixture.env,{root,publicDir});
initializeCandidate(config,{operator:'browser-test',name:'Candidate Admin',
  email:'admin-browser@example.test',password:'BrowserAdmin#2026A'});
{
  const db=openDb(fixture.dbPath,{runMode:'candidate'});
  try{
    const now='2026-11-16T10:00:00.000Z';
    db.prepare('INSERT INTO stores(id,name,subtitle,address,open_hours) VALUES(1,?,?,?,?)')
      .run('Synthetic Browser Store','Test only','Synthetic address','09:00–16:00');
    const user=db.prepare(`INSERT INTO users(name,email,password_hash,role,created_at,
      account_state,provisioning_method,verified_at,must_change_password)
      VALUES(?,?,?,'customer',?,'ACTIVE','OFFLINE_ADMIN',?,0)`);
    const evidenceId=Number(user.run('Evidence Customer','evidence@example.test',
      hashPassword('EvidenceCustomer#2026A'),now,now).lastInsertRowid);
    user.run('Outside Customer','outside@example.test',hashPassword('OutsideCustomer#2026A'),now,now);
    db.prepare('INSERT INTO variants(id,name,category,style,size,skill,description,visual) VALUES(?,?,?,?,?,?,?,?)')
      .run(1,'Synthetic Ski','ski','test','170 cm','beginner','test only','ski');
    db.prepare('INSERT INTO units(id,inventory_no,variant_id,store_id,status) VALUES(1,?,?,?,?)')
      .run('BROWSER-UNIT-1',1,1,'MAINTENANCE');
    db.prepare(`INSERT INTO reservations(id,code,user_id,store_id,pickup_at,return_at,status,rent_nok,
      deposit_nok,total_nok,pickup_code,quote_json,created_at)
      VALUES(1,'BROWSER-ORDER-1',?,1,'2026-12-05T09:00:00Z','2026-12-06T16:00:00Z','REVIEW',
      100,8,108,'BROWSER-PICK-1','{}',?)`).run(evidenceId,now);
    const snapshot=JSON.stringify({customerId:evidenceId,customer:{name:'Evidence Customer',
      email:'evidence@example.test',phone:''},skill:'初级',channel:'COUNTER_MANUAL',
      employee:{id:1,name:'Candidate Admin'},store:'Synthetic Browser Store',days:2,
      pickupAt:'2026-12-05T09:00:00Z',returnAt:'2026-12-06T16:00:00Z',lines:[],
      rentNok:100,depositNok:8,totalNok:108,adjustments:[],
      terms:'Synthetic browser fixture only; no qualified electronic signature.'});
    db.prepare(`INSERT INTO contracts(id,reservation_id,code,version,created_by,created_at,snapshot_json,snapshot_hash)
      VALUES(1,1,'BROWSER-CONTRACT-1',1,1,?,?,?)`).run(now,snapshot,'synthetic-hash');
    db.prepare(`INSERT INTO inspections(id,reservation_id,unit_id,condition,note,inspected_by,created_at)
      VALUES(1,1,1,'DAMAGED','Synthetic inspection',1,?)`).run(now);
    db.prepare(`INSERT INTO damage_cases(id,inspection_id,reservation_id,unit_id,status,part,created_at)
      VALUES(1,1,1,1,'DRAFT','Edge',?)`).run(now);
    db.prepare(`INSERT INTO damage_photos(id,case_id,uploaded_by,part,caption,mime,image,created_at)
      VALUES(1,1,1,'Edge','Synthetic one-pixel photo','image/png',?,?)`)
      .run(Buffer.from(testPhoto,'base64'),now);
  }finally{db.close();}
}
const child=spawn(process.execPath,[join(root,'src','server.mjs')],{
  cwd:root,env:{...process.env,...fixture.env,NODE_ENV:'local'},
  stdio:['ignore','pipe','pipe'],windowsHide:true
});
let chrome,browser,page,secondPage;const errors=[];let stderr='';
child.stdout.resume();child.stderr.setEncoding('utf8');child.stderr.on('data',part=>{stderr+=part;});
try{
  await wait(async()=>{try{return (await candidateRequest(fixture,'/api/health')).status===200;}catch{return false;}},'HTTPS 候选服务 '+stderr);
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
  page=await connect(targets.find(item=>item.id===targetId).webSocketDebuggerUrl,errors);
  await page.call('Page.enable');await page.call('Runtime.enable');
  await page.call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await page.call('Page.navigate',{url:fixture.origin+'/#/login'});
  await wait(()=>page.eval("!!document.querySelector('.login-form')"),'候选登录页');
  assert.equal(await page.eval("!!document.querySelector('[data-demo]')"),false);
  assert.equal(await page.eval("document.body.innerText.includes('Demo123!')"),false);
  assert.equal(await page.eval("!!document.querySelector('[data-action=toggle-login]')"),false);
  assert.equal(await page.eval("sessionStorage.getItem('bsr-session')"),null);
  const login=await page.eval("fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin-browser@example.test',password:'BrowserAdmin#2026A'})}).then(async r=>({status:r.status,data:await r.json()}))");
  assert.equal(login.status,200,JSON.stringify(login));
  assert.equal(login.data.sessionToken,undefined);
  await page.call('Page.navigate',{url:fixture.origin+'/?candidate-test=1#/users'});
  await wait(()=>page.eval("!!document.querySelector('.top-logout')"),'候选管理员工作台');
  assert.equal(await page.eval("sessionStorage.getItem('bsr-session')"),null);
  await page.call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await pause(250);
  assert.equal(await page.eval('document.documentElement.scrollWidth<=innerWidth+1'),true);
  await page.call('Page.bringToFront');
  const screenshot=await page.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  writeFileSync(join(output,'candidate-mobile.png'),Buffer.from(screenshot.data,'base64'));
  await page.eval("document.querySelector('[data-action=new-candidate-user]').click()");
  await wait(()=>page.eval("!!document.querySelector('form[data-form=provision-user]')"),'候选开通表单');
  await page.eval(`(()=>{const form=document.querySelector('form[data-form=provision-user]');
    form.elements.name.value='Browser Customer';form.elements.email.value='browser-customer@example.test';
    form.elements.role.value='customer';form.elements.verificationRef.value='BROWSER-OFFLINE-001';
    form.elements.temporaryPassword.value='BrowserCustomer#2026A';form.requestSubmit();return true;})()`);
  await wait(()=>page.eval("document.body.innerText.includes('browser-customer@example.test')"),'浏览器开通账号');
  const {targetId:secondId}=await browser.call('Target.createTarget',{url:fixture.origin+'/#/users'});
  const secondTargets=await (await fetch('http://127.0.0.1:'+debugPort+'/json/list')).json();
  secondPage=await connect(secondTargets.find(item=>item.id===secondId).webSocketDebuggerUrl,errors);
  await secondPage.call('Page.enable');await secondPage.call('Runtime.enable');
  await wait(()=>secondPage.eval("!!document.querySelector('.top-logout')"),'第二标签共享会话');
  await page.eval("document.querySelector('.top-logout').click()");
  await wait(()=>page.eval("!!document.querySelector('.login-form')"),'浏览器退出');
  assert.equal(await secondPage.eval("fetch('/api/me').then(r=>r.status)"),401);
  await secondPage.call('Page.navigate',{url:fixture.origin+'/?after-logout=1#/users'});
  await wait(()=>secondPage.eval("location.hash==='#/catalog'&&document.body.innerText.includes('访客')"),'第二标签回到访客页');
  const initialCustomer=await page.eval(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({email:'browser-customer@example.test',password:'BrowserCustomer#2026A'})})
    .then(async r=>({status:r.status,data:await r.json()}))`);
  assert.equal(initialCustomer.status,200,JSON.stringify(initialCustomer));
  assert.equal(initialCustomer.data.user.mustChangePassword,true);
  assert.equal(await page.eval("fetch('/api/reservations').then(r=>r.status)"),403);
  await page.call('Page.navigate',{url:fixture.origin+'/?first-change=1#/login'});
  await wait(()=>page.eval("!!document.querySelector('form[data-form=change-password]')"),'首次改密界面');
  await page.eval(`(()=>{const form=document.querySelector('form[data-form=change-password]');
    form.elements.currentPassword.value='BrowserCustomer#2026A';
    form.elements.newPassword.value='BrowserCustomerNew#2026A';form.requestSubmit();return true;})()`);
  await wait(()=>page.eval("!!document.querySelector('form[data-form=login]')"),'首次改密后返回登录');
  assert.equal(await page.eval("fetch('/api/me').then(r=>r.status)"),401);
  const renewedCustomer=await page.eval(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({email:'browser-customer@example.test',password:'BrowserCustomerNew#2026A'})})
    .then(async r=>({status:r.status,data:await r.json()}))`);
  assert.equal(renewedCustomer.status,200,JSON.stringify(renewedCustomer));
  assert.equal(renewedCustomer.data.user.mustChangePassword,false);
  assert.equal(await page.eval("fetch('/api/auth/logout',{method:'POST'}).then(r=>r.status)"),200);
  const evidence=await page.eval(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({email:'evidence@example.test',password:'EvidenceCustomer#2026A'})})
    .then(async r=>({status:r.status,data:await r.json()}))`);
  assert.equal(evidence.status,200,JSON.stringify(evidence));
  assert.equal(evidence.data.sessionToken,undefined);
  const protectedMedia=await page.eval(`Promise.all([
    fetch('/api/damage-photos/1').then(async r=>({status:r.status,type:r.headers.get('content-type'),size:(await r.arrayBuffer()).byteLength})),
    fetch('/api/contracts/1/print').then(async r=>({status:r.status,type:r.headers.get('content-type'),html:await r.text()}))
  ]).then(([photo,contract])=>({photo,contract:{status:contract.status,type:contract.type,
    synthetic:contract.html.includes('Synthetic Browser Store')}}))`);
  assert.equal(protectedMedia.photo.status,200);
  assert.equal(protectedMedia.photo.type,'image/png');
  assert.ok(protectedMedia.photo.size>0);
  assert.equal(protectedMedia.contract.status,200);
  assert.match(protectedMedia.contract.type,/text\/html/);
  assert.equal(protectedMedia.contract.synthetic,true);
  assert.equal(await page.eval("sessionStorage.getItem('bsr-session')"),null);
  assert.equal(await page.eval("fetch('/api/auth/logout',{method:'POST'}).then(r=>r.status)"),200);
  const outside=await page.eval(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({email:'outside@example.test',password:'OutsideCustomer#2026A'})})
    .then(async r=>({status:r.status,data:await r.json()}))`);
  assert.equal(outside.status,200,JSON.stringify(outside));
  assert.equal(await page.eval("fetch('/api/damage-photos/1').then(r=>r.status)"),404);
  assert.equal(await page.eval("fetch('/api/contracts/1/print').then(r=>r.status)"),404);
  assert.deepEqual(errors,[]);
  console.log('candidate-browser-smoke PASS: login, UI provisioning and first password change, cross-tab logout, cookie-protected photo/contract, no demo shortcut, mobile width');
}finally{
  secondPage?.socket.close();page?.socket.close();browser?.socket.close();
  if(chrome&&chrome.exitCode===null){const closed=new Promise(resolve=>chrome.once('close',resolve));chrome.kill();await closed;}
  if(child.exitCode===null){const closed=new Promise(resolve=>child.once('close',resolve));child.kill();await closed;}
  fixture.cleanup();
}
