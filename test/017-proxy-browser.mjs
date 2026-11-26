// Isolated browser rehearsal for the future hosted candidate ingress.
// The proxy, application, browser and database remain on loopback/temporary paths.
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import {spawn} from 'node:child_process';
import {createHash,randomBytes,X509Certificate} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {makeCandidateFixture,freePort} from './candidate-fixtures.mjs';
import {validateRuntimeConfig} from '../src/runtime-config.mjs';
import {initializeCandidate} from '../src/runtime-provenance.mjs';

const root=resolve(import.meta.dirname,'..'),publicDir=join(root,'public');
const output=join(root,'test-results');mkdirSync(output,{recursive:true});
const chromePath=process.env.BSR_CHROME||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(fn,label){for(let i=0;i<120;i++){if(await fn())return;await pause(75);}throw new Error('等待超时：'+label);}

async function connect(url,errors){
  const socket=new WebSocket(url);
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  let seq=0;const pending=new Map();
  socket.onmessage=event=>{const message=JSON.parse(event.data);
    if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text);
    const item=pending.get(message.id);if(item){pending.delete(message.id);clearTimeout(item.timer);
      message.error?item.reject(new Error(message.error.message)):item.resolve(message.result);}};
  return {socket,call(method,params={}){return new Promise((resolve,reject)=>{
    const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP 超时：'+method));},10000);
    pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});},
    async eval(expression){const response=await this.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
      if(response.exceptionDetails)throw new Error(response.exceptionDetails.exception?.description||response.exceptionDetails.text);
      return response.result.value;}};
}

async function requestInternal(port,headers){return new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port,path:'/api/health',headers},res=>{
    res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();});}
async function closeChild(child){if(child?.exitCode===null){const closed=new Promise(resolve=>child.once('close',resolve));child.kill();await closed;}}

const fixture=await makeCandidateFixture('bsr-017-proxy-browser-');
const domain='preview.example.test',proxyPort=await freePort(),origin=`https://${domain}:${proxyPort}`;
const secret=randomBytes(32).toString('hex');
const env={...fixture.env,BSR_CANDIDATE_TRANSPORT:'trusted-local-proxy',BSR_PUBLIC_ORIGIN:origin,
  BSR_PROXY_SECRET:secret};delete env.BSR_TLS_CERT_PATH;delete env.BSR_TLS_KEY_PATH;
let child,proxy,chrome,browser,page;const errors=[];
try{
  initializeCandidate(validateRuntimeConfig(env,{root,publicDir}),{
    operator:'017-browser-test',name:'Proxy Browser Admin',email:'proxy-browser@example.test',
    password:'ProxyBrowser#2026Strong'});
  proxy=https.createServer({cert:readFileSync(fixture.certPath),key:readFileSync(fixture.keyPath)},(incoming,outgoing)=>{
    const headers={...incoming.headers,host:`${domain}:${proxyPort}`,
      'x-bsr-proxy-secret':secret,'x-bsr-client-ip':incoming.socket.remoteAddress,
      'x-forwarded-proto':'https'};
    delete headers['x-forwarded-for'];
    const upstream=http.request({hostname:'127.0.0.1',port:fixture.port,path:incoming.url,
      method:incoming.method,headers},response=>{outgoing.writeHead(response.statusCode,response.headers);response.pipe(outgoing);});
    upstream.on('error',()=>{if(!outgoing.headersSent)outgoing.writeHead(502);outgoing.end();});
    incoming.pipe(upstream);
  });
  await new Promise((resolve,reject)=>proxy.once('error',reject).listen(proxyPort,'127.0.0.1',resolve));
  child=spawn(process.execPath,[join(root,'src','server.mjs')],{
    cwd:root,env:{...process.env,...env,NODE_ENV:'local'},stdio:['ignore','pipe','pipe'],windowsHide:true});
  let stderr='';child.stdout.resume();child.stderr.setEncoding('utf8');child.stderr.on('data',part=>{stderr+=part;});
  const headers={Host:`${domain}:${proxyPort}`,'X-BSR-Proxy-Secret':secret,
    'X-BSR-Client-IP':'127.0.0.1','X-Forwarded-Proto':'https'};
  await wait(async()=>{try{return (await requestInternal(fixture.port,headers))===200;}catch{return false;}},
    '回环候选应用 '+stderr);
  assert.equal(proxy.address().address,'127.0.0.1');
  assert.equal(await requestInternal(fixture.port,{}),403,'绕过代理的本机请求也被拒绝');

  const cert=new X509Certificate(readFileSync(fixture.certPath));
  const spki=createHash('sha256').update(cert.publicKey.export({format:'der',type:'spki'})).digest('base64');
  chrome=spawn(chromePath,[
    '--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--no-proxy-server',
    '--host-resolver-rules=MAP '+domain+' 127.0.0.1',
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
  await page.call('Page.enable');await page.call('Runtime.enable');await page.call('Network.enable');
  await page.call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await page.call('Page.navigate',{url:origin+'/#/login'});
  await wait(()=>page.eval("!!document.querySelector('.login-form')"),'代理后的候选登录页');
  assert.equal(await page.eval('document.documentElement.scrollWidth<=innerWidth+1'),true);
  assert.equal(await page.eval("document.body.innerText.includes('Demo123!')"),false);
  assert.equal(await page.eval("fetch('/api/bootstrap').then(r=>r.json()).then(j=>j.capabilities.bookingEnabled)"),false);
  const shot=await page.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  writeFileSync(join(output,'017-proxy-candidate-mobile.png'),Buffer.from(shot.data,'base64'));
  await page.eval(`(()=>{const form=document.querySelector('form[data-form=login]');
    form.elements.email.value='proxy-browser@example.test';
    form.elements.password.value='ProxyBrowser#2026Strong';form.requestSubmit();return true;})()`);
  await wait(()=>page.eval("!!document.querySelector('.top-logout')"),'代理后的管理员登录');
  assert.equal(await page.eval("sessionStorage.getItem('bsr-session')"),null);
  assert.equal(await page.eval("document.cookie.includes('__Host-bsr_candidate_session')"),false,'HttpOnly session is not script-readable');
  const cookies=(await page.call('Network.getCookies',{urls:[origin]})).cookies;
  const session=cookies.find(cookie=>cookie.name==='__Host-bsr_candidate_session');
  assert.ok(session,'browser stored candidate cookie');
  assert.equal(session.secure,true);assert.equal(session.httpOnly,true);assert.equal(session.sameSite,'Strict');
  assert.equal(await page.eval("fetch('/api/quote',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>r.status)"),409);
  await page.eval("document.querySelector('.top-logout').click()");
  await wait(()=>page.eval("!!document.querySelector('.login-form')"),'代理后的退出');
  assert.equal(await page.eval("fetch('/api/me').then(r=>r.status)"),401);
  assert.deepEqual(errors,[]);
  console.log('017 proxy browser PASS: HTTPS hostname mapping, 390px candidate page, Secure HttpOnly cookie, login/logout and booking gate');
}finally{
  page?.socket.close();browser?.socket.close();
  if(chrome&&chrome.exitCode===null){const closed=new Promise(resolve=>chrome.once('close',resolve));chrome.kill();await closed;}
  await closeChild(child);
  if(proxy){proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}
  await pause(150);fixture.cleanup();
}
