// Native Mini page and service decisions with a deterministic, in-process wx shim.
// This does not exercise official WeChat services or a phone.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);
const appId='wx1234567890abcdef';

function replaceModule(path,exports){
  const id=require.resolve(path);
  const previous=require.cache[id];
  require.cache[id]={id,filename:id,loaded:true,exports};
  return ()=>{if(previous)require.cache[id]=previous;else delete require.cache[id];};
}

function pageContext(page,data={}){
  return {data:{...page.data,...data},setData(values){Object.assign(this.data,values);}};
}

test('native bootstrap, binding and expired bearer restore one customer login state',async()=>{
  const restoreConfig=replaceModule('../mini-program/utils/config.js',
    {mode:'wechat-showcase',apiBase:'https://bsr.example.org',appId});
  const apiId=require.resolve('../mini-program/utils/api.js');
  const oldApi=require.cache[apiId];
  delete require.cache[apiId];
  const storage=new Map();
  const calls=[];
  let failure='';
  global.wx={
    getAccountInfoSync:()=>({miniProgram:{appId}}),
    getStorageSync:key=>storage.get(key),
    setStorageSync:(key,value)=>storage.set(key,value),
    removeStorageSync:key=>storage.delete(key),
    request(options){
      calls.push(options);
      if(failure==='network')return options.fail(new Error('simulated offline'));
      if(failure==='expired')return options.success({statusCode:401,
        data:{code:'SESSION_EXPIRED',error:'会话过期'}});
      const path=new URL(options.url).pathname;
      const data={
        '/api/mini/bootstrap':{status:'ready',synthetic:true,customerOnly:true},
        '/api/mini/auth/wechat':{status:'needs_binding',challenge:'c'.repeat(64)},
        '/api/mini/auth/bind':{status:'authenticated',sessionToken:'a'.repeat(64),
          user:{id:17,role:'customer',name:'虚构顾客'}},
        '/api/mini/me':{id:17,role:'customer',name:'虚构顾客'}
      }[path];
      options.success({statusCode:data?200:404,data:data||{error:'missing'}});
    }
  };
  try{
    const api=require('../mini-program/utils/api.js');
    api.restoreToken();
    assert.equal((await api.bootstrap()).user,null);
    const challenge=await api.wechatLogin('fake-once-code');
    assert.equal(challenge.status,'needs_binding');
    assert.equal(challenge.challenge.length,64);
    const user=await api.bindWechat(challenge.challenge,'fiction@example.test','proof');
    assert.equal(user.id,17);
    assert.equal((await api.bootstrap()).user.id,17);
    assert.equal(calls.find(row=>row.url.endsWith('/api/mini/me')).header.Authorization,
      'Bearer '+'a'.repeat(64));
    storage.set(api.cartKey(),[{variantId:1,qty:1}]);
    storage.set(api.pendingKey(),{key:'fictional-retry'});
    failure='network';
    await assert.rejects(api.request('/api/catalog?storeId=1'),
      error=>error.network===true&&/稍后重试/.test(error.message));
    assert.equal(storage.has('bsr-mini-wechat-session'),true);
    failure='expired';
    await assert.rejects(api.request('/api/me'),
      error=>error.status===401&&error.code==='SESSION_EXPIRED');
    assert.equal(storage.has('bsr-mini-wechat-session'),false);
    assert.equal(storage.has(api.cartKey()),false);
    assert.equal(storage.has(api.pendingKey()),false);
  }finally{
    delete global.wx;
    if(oldApi)require.cache[apiId]=oldApi;else delete require.cache[apiId];
    restoreConfig();
  }
});

test('native account requires explicit binding consent and clears an expired challenge',async()=>{
  const messages=[];
  const restoreApi=replaceModule('../mini-program/utils/api.js',{
    isWechatShowcase:()=>true,
    isAccountShowcase:()=>false,
    wechatLogin:async()=>({status:'needs_binding',challenge:'c'.repeat(64),
      expiresAt:'2026-12-01T09:00:00Z'}),
    bindWechat:async()=>{
      const error=new Error('绑定挑战过期');error.code='CHALLENGE_EXPIRED';throw error;
    }
  });
  const restoreCartSync=replaceModule('../mini-program/utils/cart-sync.js',
    {mergeAfterLogin:async()=>{throw new Error('expired challenge must not merge cart');}});
  let page;
  global.Page=definition=>{page=definition;};
  global.getApp=()=>({globalData:{user:null,boot:null}});
  global.wx={
    login:options=>options.success({code:'one-time-fake-code'}),
    showModal:options=>messages.push(options)
  };
  const pageId=require.resolve('../mini-program/pages/account/index.js');
  try{
    delete require.cache[pageId];
    require('../mini-program/pages/account/index.js');
    const context=pageContext(page,{loginEmail:'fiction@example.test',loginPassword:'proof'});
    await page.onWechatLogin.call(context);
    assert.equal(context.data.bindingChallenge.length,64);
    await page.onBindWechat.call(context);
    assert.match(messages.at(-1).content,/请先确认/);
    page.onBindConsent.call(context,{detail:{value:['yes']}});
    await page.onBindWechat.call(context);
    assert.equal(context.data.bindingChallenge,'');
    assert.equal(context.data.loginPassword,'');
    assert.match(messages.at(-1).content,/过期/);
  }finally{
    delete require.cache[pageId];
    delete global.Page;delete global.getApp;delete global.wx;
    restoreCartSync();restoreApi();
  }
});

test('stale Mini cart reloads Web version and asks customer to reconfirm',async()=>{
  const remote={version:4,items:[{variantId:2,qty:1}],storeId:1,
    pickupAt:'2026-12-01T08:00:00.000Z',returnAt:'2026-12-02T15:00:00.000Z'};
  const restoreApi=replaceModule('../mini-program/utils/api.js',
    {request:async path=>{assert.equal(path,'/api/cart');return remote;}});
  const cartId=require.resolve('../mini-program/utils/cart-sync.js');
  const previous=require.cache[cartId];
  delete require.cache[cartId];
  try{
    const cartSync=require('../mini-program/utils/cart-sync.js');
    const app={globalData:{cartVersion:3,cart:[{variantId:1,qty:2}]},
      saveCart(items){this.globalData.cart=items;},
      saveWindow(window){this.globalData.window=window;}};
    const stale=new Error('stale');stale.code='CART_STALE';
    await assert.rejects(cartSync.handleStale(app,stale),
      error=>error.code==='CART_STALE'&&/网页或另一设备更新/.test(error.message));
    assert.equal(app.globalData.cartVersion,4);
    assert.deepEqual(app.globalData.cart,remote.items);
    assert.equal(app.globalData.window.pickupDate,'2026-12-01');
  }finally{
    if(previous)require.cache[cartId]=previous;else delete require.cache[cartId];
    restoreApi();
  }
});

test('Mini login preserves guest equipment when account cart is empty',async()=>{
  const booking=require('../mini-program/utils/booking.js');
  const today=booking.osloToday();
  const window={storeId:1,pickupDate:booking.addCalendarDays(today,3),
    returnDate:booking.addCalendarDays(today,4)};
  const guest=[{variantId:7,qty:2}];
  const calls=[];
  const restoreApi=replaceModule('../mini-program/utils/api.js',{
    request:async(path,method='GET',body)=>{
      calls.push({path,method,body});
      if(method==='GET')return {version:0,items:[]};
      return {version:1,items:body.items,storeId:body.storeId,
        pickupAt:body.pickupAt,returnAt:body.returnAt};
    }
  });
  const cartId=require.resolve('../mini-program/utils/cart-sync.js');
  const previous=require.cache[cartId];delete require.cache[cartId];
  const app={globalData:{cart:guest,cartVersion:null,window},
    saveCart(items){this.globalData.cart=items;},
    saveWindow(value){this.globalData.window=value;}};
  try{
    const cartSync=require('../mini-program/utils/cart-sync.js');
    await cartSync.mergeAfterLogin(app);
    assert.equal(calls.length,2);
    assert.deepEqual(calls[1].body.items,guest);
    assert.equal(calls[1].body.expectedVersion,0);
    assert.equal(app.globalData.cartVersion,1);
    assert.deepEqual(app.globalData.cart,guest);
  }finally{
    if(previous)require.cache[cartId]=previous;else delete require.cache[cartId];
    restoreApi();
  }
});

test('Mini login asks before replacing a Web cart and keeps the chosen version',async()=>{
  const booking=require('../mini-program/utils/booking.js');
  const today=booking.osloToday();
  const window={storeId:1,pickupDate:booking.addCalendarDays(today,3),
    returnDate:booking.addCalendarDays(today,4)};
  const remoteItems=[{variantId:1,qty:1}];
  const guestItems=[{variantId:7,qty:2}];
  let choice=true;
  const calls=[],prompts=[];
  const restoreApi=replaceModule('../mini-program/utils/api.js',{
    request:async(path,method='GET',body)=>{
      calls.push({path,method,body});
      if(method==='GET')return {version:5,items:remoteItems};
      return {version:6,items:body.items,storeId:body.storeId,
        pickupAt:body.pickupAt,returnAt:body.returnAt};
    }
  });
  const cartId=require.resolve('../mini-program/utils/cart-sync.js');
  const previous=require.cache[cartId];delete require.cache[cartId];
  global.wx={showModal:options=>{
    prompts.push(options.content);
    options.success({confirm:choice});
  }};
  const app={globalData:{cart:guestItems,cartVersion:null,window},
    saveCart(items){this.globalData.cart=items;},
    saveWindow(value){this.globalData.window=value;}};
  try{
    const cartSync=require('../mini-program/utils/cart-sync.js');
    await cartSync.mergeAfterLogin(app);
    assert.equal(calls.filter(call=>call.method==='PUT').length,0);
    assert.deepEqual(app.globalData.cart,remoteItems);
    assert.equal(app.globalData.cartVersion,5);
    assert.match(prompts[0],/使用网页版/);
    choice=false;
    app.globalData.cart=guestItems;
    await cartSync.mergeAfterLogin(app);
    const update=calls.find(call=>call.method==='PUT');
    assert.equal(update.body.expectedVersion,5);
    assert.deepEqual(update.body.items,guestItems);
    assert.deepEqual(app.globalData.cart,guestItems);
    assert.equal(app.globalData.cartVersion,6);
  }finally{
    delete global.wx;
    if(previous)require.cache[cartId]=previous;else delete require.cache[cartId];
    restoreApi();
  }
});

test('native checkout requires policy reading and shows NOK synthetic quote before submit',async()=>{
  const booking=require('../mini-program/utils/booking.js');
  const today=booking.osloToday();
  const window={storeId:1,pickupDate:booking.addCalendarDays(today,2),
    returnDate:booking.addCalendarDays(today,3)};
  const calls=[],messages=[];
  const restoreApi=replaceModule('../mini-program/utils/api.js',{
    isWechatShowcase:()=>true,pendingKey:()=> 'bsr-mini-wechat-pending',
    request:async(path)=>{
      calls.push(path);
      if(path==='/api/me')return {id:17,name:'虚构顾客',phone:'+47 9000 0000',
        address:'虚构地址',birthYear:1999,heightCm:172,weightKg:68,shoeSize:'EU 42'};
      if(path==='/api/quote')return {quoteId:'synthetic-quote',
        rentNok:80,depositNok:8,totalNok:88};
      throw new Error('unexpected request '+path);
    }
  });
  const restoreSync=replaceModule('../mini-program/utils/cart-sync.js',
    {saveRemote:async()=>{throw new Error('quote not confirmed');}});
  const pageId=require.resolve('../mini-program/pages/cart/index.js');
  let page;
  const app={globalData:{user:{id:17},window,cart:[{variantId:1,qty:1}],
    cartVersion:2}};
  global.Page=definition=>{page=definition;};
  global.getApp=()=>app;
  global.wx={
    getStorageSync:()=>null,
    showModal:options=>{messages.push(options);options.success?.({confirm:false});}
  };
  try{
    delete require.cache[pageId];
    require('../mini-program/pages/cart/index.js');
    const context=pageContext(page,{quote:{totalNok:88},policy:{version:'synthetic-v1'},
      skillIndex:0});
    page.openPolicy.call(context);
    page.onAccepted.call(context,{detail:{value:['yes']}});
    assert.equal(context.data.accepted,false);
    await page.onCheckout.call(context);
    assert.match(messages.at(-1).content,/阅读到末尾/);
    assert.deepEqual(calls,[]);
    page.onPolicyBottom.call(context);
    page.onAccepted.call(context,{detail:{value:['yes']}});
    assert.equal(context.data.accepted,true);
    await page.onCheckout.call(context);
    assert.deepEqual(calls,['/api/me','/api/quote']);
    assert.match(messages.at(-1).content,/NOK 80/);
    assert.match(messages.at(-1).content,/NOK 8/);
    assert.match(messages.at(-1).content,/合成预览不产生真实扣款/);
    assert.equal(calls.includes('/api/reservations'),false);
  }finally{
    delete require.cache[pageId];
    delete global.Page;delete global.getApp;delete global.wx;
    restoreSync();restoreApi();
  }
});
