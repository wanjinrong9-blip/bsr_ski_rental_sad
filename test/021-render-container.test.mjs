import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {renderNginxConfig,supervise} from '../deploy/render/start.mjs';

const root=resolve(import.meta.dirname,'..');
const read=path=>readFileSync(resolve(root,path),'utf8');
const config={runMode:'showcase',transport:'trusted-local-proxy',host:'127.0.0.1',port:4175,
  publicOrigin:'https://bsr-preview-example.onrender.com',proxySecret:'28e6c9b45a13f780'.repeat(4)};

test('Render proxy binds the assigned port and overwrites every trust header',()=>{
  const nginx=renderNginxConfig({platformPort:'10000',config});
  assert.match(nginx,/listen 0\.0\.0\.0:10000;/);
  assert.match(nginx,/proxy_pass http:\/\/127\.0\.0\.1:4175;/);
  assert.match(nginx,/proxy_set_header Host bsr-preview-example\.onrender\.com;/);
  assert.match(nginx,/proxy_set_header X-Forwarded-Proto https;/);
  assert.match(nginx,new RegExp(`proxy_set_header X-BSR-Proxy-Secret ${config.proxySecret};`));
  assert.match(nginx,/proxy_set_header X-BSR-Client-IP \$remote_addr;/);
  for(const header of ['Forwarded','X-Forwarded-For','X-Real-IP','X-Forwarded-Host','Connection'])
    assert.ok(nginx.includes(`proxy_set_header ${header} "";`));
  assert.match(nginx,/proxy_buffering off;/);
  assert.doesNotMatch(nginx,/__[A-Z_]+__|ssl_certificate|listen .*4175/);
});

test('Render config rejects port collisions, non-Render origins and directive injection',()=>{
  for(const platformPort of [undefined,'','0','65536','4175','10000; include private','+10000'])
    assert.throws(()=>renderNginxConfig({platformPort,config}));
  for(const mutation of [
    {runMode:'demo'},{transport:'direct-tls'},{host:'0.0.0.0'},{port:10000},
    {publicOrigin:'http://bsr-preview-example.onrender.com'},
    {publicOrigin:'https://bsr-preview-example.onrender.com.attacker.example'},
    {publicOrigin:'https://bsr-preview-example.onrender.com:4175'},
    {publicOrigin:'https://bsr-preview-example.onrender.com/path'},
    {publicOrigin:'https://user:secret@bsr-preview-example.onrender.com'},
    {publicOrigin:'https://bsr-preview-example.onrender.com/'},
    {proxySecret:'x; include /private/*;'}
  ])assert.throws(()=>renderNginxConfig({platformPort:10000,config:{...config,...mutation}}));
});

function fakeChild({exitOnKill=true}={}){
  const child=new EventEmitter();
  child.signals=[];
  child.kill=signal=>{
    child.signals.push(signal);
    if(exitOnKill||signal==='SIGKILL')queueMicrotask(()=>child.emit('exit',null,signal));
    return true;
  };
  return child;
}

test('A component exit stops its sibling and preserves a nonzero exit status',async()=>{
  const application=fakeChild(),nginx=fakeChild(),signals=new EventEmitter();
  const completion=supervise([application,nginx],{signalSource:signals});
  application.emit('exit',2);
  assert.equal(await completion,2);
  assert.deepEqual(nginx.signals,['SIGTERM']);
  assert.equal(signals.listenerCount('SIGTERM'),0);
});

test('SIGTERM stops both children; a stuck child is killed after the grace period',async()=>{
  const application=fakeChild({exitOnKill:false}),nginx=fakeChild(),signals=new EventEmitter();
  const completion=supervise([application,nginx],{signalSource:signals,graceMs:10});
  signals.emit('SIGTERM');
  assert.equal(await completion,0);
  assert.deepEqual(application.signals,['SIGTERM','SIGKILL']);
  assert.deepEqual(nginx.signals,['SIGTERM']);
});

test('A spawn error stops the running sibling without exposing error details',async()=>{
  const application=fakeChild(),nginx=fakeChild(),signals=new EventEmitter();
  const completion=supervise([application,nginx],{signalSource:signals});
  nginx.emit('error',new Error('private value must never be logged'));
  assert.equal(await completion,1);
  assert.deepEqual(application.signals,['SIGTERM']);
});

test('Blueprint stays free and the Docker context excludes runtime and private files',()=>{
  const blueprint=read('render.yaml'),dockerfile=read('deploy/render/Dockerfile'),ignore=read('.dockerignore');
  assert.match(blueprint,/plan: free/);
  assert.match(blueprint,/healthCheckPath: \/api\/health/);
  assert.match(blueprint,/key: BSR_PREVIEW_SEED\s+sync: false/);
  assert.doesNotMatch(blueprint,/disk:|diskSizeGB:|generateValue: true/);
  assert.match(dockerfile,/FROM node:24-bookworm-slim/);
  assert.match(dockerfile,/USER node/);
  assert.doesNotMatch(dockerfile,/COPY (?:\. |data|\.git)|npm install/);
  assert.ok(ignore.split(/\r?\n/).includes('**'));
  for(const privatePattern of ['**/.env*','**/*.sqlite','**/*.pem','**/*.key','**/project.private.config.json'])
    assert.ok(ignore.includes(privatePattern));
  assert.doesNotMatch(ignore,/^!data|^!\.git/m);
});
