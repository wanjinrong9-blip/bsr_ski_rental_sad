import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {createWechatCodeSessionAdapter,WechatPlatformError} from '../src/wechat-platform.mjs';

const previousNodeEnv=process.env.NODE_ENV;
process.env.NODE_ENV='test';
after(()=>{if(previousNodeEnv===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previousNodeEnv;});

const config={appId:'wx1234567890abcdef',appSecret:'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6'};
const validCode='0123456789abcdef0123456789abcdef';
const success={openid:'oX00000000000000000000000000',session_key:'secret-session-key-0123456789'};
const respond=(data,status=200)=>new Response(typeof data==='string'?data:JSON.stringify(data),
  {status,headers:{'content-type':'application/json'}});

test('私有配置与测试注入只在隔离测试模式接受',()=>{
  assert.throws(()=>createWechatCodeSessionAdapter({}),
    error=>error instanceof WechatPlatformError&&error.code==='WECHAT_CONFIG_INVALID');
  assert.throws(()=>createWechatCodeSessionAdapter({...config,appId:'touristappid'}),/服务端配置无效/);
  assert.throws(()=>createWechatCodeSessionAdapter({...config,appSecret:'changeme'}),/服务端配置无效/);
  process.env.NODE_ENV='production';
  try{
    assert.throws(()=>createWechatCodeSessionAdapter(config,{fetchImpl:async()=>respond(success)}),
      error=>error.code==='WECHAT_TEST_ADAPTER_FORBIDDEN');
  }finally{process.env.NODE_ENV='test';}
});

test('仅用官方 HTTPS code2Session 端点并丢弃 session_key',async()=>{
  let calls=0;
  const adapter=createWechatCodeSessionAdapter(config,{fetchImpl:async(url,options)=>{
    calls++;
    const parsed=new URL(url);
    assert.equal(parsed.origin,'https://api.weixin.qq.com');
    assert.equal(parsed.pathname,'/sns/jscode2session');
    assert.equal(parsed.searchParams.get('appid'),config.appId);
    assert.equal(parsed.searchParams.get('secret'),config.appSecret);
    assert.equal(parsed.searchParams.get('js_code'),validCode);
    assert.equal(parsed.searchParams.get('grant_type'),'authorization_code');
    assert.equal(options.method,'GET');
    assert.equal(options.redirect,'error');
    assert.ok(options.signal);
    return respond({...success,unionid:'uX00000000000000000000000000'});
  }});
  const identity=await adapter.exchangeCode(validCode);
  assert.deepEqual(identity,{openid:success.openid,unionid:'uX00000000000000000000000000'});
  assert.equal('session_key' in identity,false);
  assert.equal(calls,1);
  await assert.rejects(adapter.exchangeCode('x'),error=>error.code==='CODE_INVALID');
  assert.equal(calls,1);
});

test('平台拒绝、损坏及过大响应不泄露平台内容或私钥',async()=>{
  for(const response of [
    respond({errcode:40029,errmsg:'invalid code with private detail'}),
    respond({errcode:0,openid:'short',session_key:success.session_key}),
    respond({openid:success.openid}),
    respond('not-json'),
    respond({error:'temporary'},503),
    respond('x'.repeat(17000))
  ]){
    let calls=0;
    const adapter=createWechatCodeSessionAdapter(config,{fetchImpl:async()=>{
      calls+=1;
      return response;
    }});
    await assert.rejects(adapter.exchangeCode(validCode),error=>{
      assert.ok(error instanceof WechatPlatformError);
      const output=JSON.stringify({code:error.code,message:error.message});
      assert.equal(output.includes(config.appSecret),false);
      assert.equal(output.includes('invalid code with private detail'),false);
      assert.equal(output.includes('session_key'),false);
      return true;
    });
    assert.equal(calls,1,'a failed code exchange must not retry upstream');
  }
});

test('平台超时后返回稳定错误，不创建 BSR 会话',async()=>{
  const adapter=createWechatCodeSessionAdapter(config,{timeoutMs:25,fetchImpl:async(_url,{signal})=>
    new Promise((_resolve,reject)=>{
      signal.addEventListener('abort',()=>reject(new Error('request URL contained a secret')),{once:true});
    })});
  await assert.rejects(adapter.exchangeCode(validCode),error=>{
    assert.equal(error.code,'WECHAT_UNAVAILABLE');
    assert.equal(error.message.includes('secret'),false);
    return true;
  });
});
