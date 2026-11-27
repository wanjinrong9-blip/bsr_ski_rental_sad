import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {prepareTemporaryPreview} from '../tools/temporary-preview-setup.mjs';
import {renderNginxConfig} from '../deploy/render/start.mjs';
import {preflightRuntime} from '../src/runtime-provenance.mjs';

test('Railway uses its assigned HTTPS domain, isolated identities and platform port',()=>{
  const dir=mkdtempSync(join(tmpdir(),'bsr-railway-'));
  try{
    const env={BSR_TEMPORARY_PREVIEW:'1',BSR_RUN_MODE:'showcase',BSR_PREVIEW_PROVIDER:'railway',
      RAILWAY_PUBLIC_DOMAIN:'bsr-preview-production.up.railway.app',PORT:'8080',
      BSR_PREVIEW_SEED:randomBytes(32).toString('hex')};
    const {config,credentials}=prepareTemporaryPreview(env,{runtimeDir:dir});
    assert.equal(config.publicOrigin,'https://bsr-preview-production.up.railway.app');
    assert.equal(credentials.length,6);assert.equal(preflightRuntime(config).status,'ready');
    const proxy=renderNginxConfig({platformPort:8080,config});
    assert.match(proxy,/listen 0\.0\.0\.0:8080;/);
    assert.match(proxy,/listen \[::\]:8080 ipv6only=on;/);
    for(const name of ['client_body','proxy','fastcgi','uwsgi','scgi'])
      assert.match(proxy,new RegExp(`${name}_temp_path /runtime/nginx/`));
    const healthServer=proxy.slice(proxy.indexOf('server_name healthcheck.railway.app;'));
    assert.match(healthServer,/location = \/api\/health/);
    assert.match(healthServer,/location \/ \{ return 421; \}/);
    assert.match(healthServer,/limit_except GET \{ deny all; \}/);
    assert.match(proxy,/proxy_set_header Host bsr-preview-production\.up\.railway\.app;/);
    assert.match(proxy,/proxy_pass http:\/\/127\.0\.0\.1:4175;/);
    const deployment=JSON.parse(readFileSync(new URL('../railway.json',import.meta.url),'utf8'));
    assert.equal(deployment.build.dockerfilePath,'deploy/render/Dockerfile');
    assert.equal(deployment.deploy.healthcheckPath,'/api/health');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('Railway never accepts a different provider or a forged platform hostname',()=>{
  const dir=mkdtempSync(join(tmpdir(),'bsr-railway-deny-'));
  try{
    const base={BSR_TEMPORARY_PREVIEW:'1',BSR_RUN_MODE:'showcase',BSR_PREVIEW_PROVIDER:'railway',
      BSR_PREVIEW_SEED:randomBytes(32).toString('hex')};
    for(const change of [{RAILWAY_PUBLIC_DOMAIN:'evil.test'},
      {RAILWAY_PUBLIC_DOMAIN:'bsr.up.railway.app.evil.test'},
      {RAILWAY_PUBLIC_DOMAIN:'bsr.up.railway.app/path'},
      {RAILWAY_PUBLIC_DOMAIN:'bsr.onrender.com'},
      {BSR_PREVIEW_PROVIDER:'other',RAILWAY_PUBLIC_DOMAIN:'bsr.up.railway.app'}]){
      const target=join(dir,'must-not-exist');
      assert.throws(()=>prepareTemporaryPreview({...base,...change},{runtimeDir:target}));
      assert.equal(existsSync(target),false);
    }
  }finally{rmSync(dir,{recursive:true,force:true});}
});
