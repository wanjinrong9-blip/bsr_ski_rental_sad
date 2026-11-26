/**
 * Server-only WeChat Mini Program adapter. Never import this file from public/
 * or mini-program/. WeChat session_key and AppSecret stay inside this boundary.
 * Official Mini Program code issuance is deliberately separate: it needs a
 * the registered public AppID and a private platform-issued access token.
 * The AppID is known; this server has not obtained the private token.
 */
export class WechatPlatformError extends Error {
  constructor(code,message,status=503){
    super(message);this.name='WechatPlatformError';this.code=code;this.status=status;
  }
}

const error=(code,message,status)=>new WechatPlatformError(code,message,status);
const appIdPattern=/^wx[A-Za-z0-9]{16}$/;
const secretPattern=/^[A-Za-z0-9_-]{32,128}$/;
const codePattern=/^[A-Za-z0-9_-]{8,256}$/;
const identityPattern=/^[A-Za-z0-9_-]{8,128}$/;

function readConfig(config){
  const appId=config?.appId,appSecret=config?.appSecret;
  if(typeof appId!=='string'||!appIdPattern.test(appId)||
      typeof appSecret!=='string'||!secretPattern.test(appSecret)||
      /^(?:0+|1+|a+|x+|changeme|replace|password|example)$/i.test(appSecret))
    throw error('WECHAT_CONFIG_INVALID','微信小程序服务端配置无效',503);
  return {appId,appSecret};
}

async function boundedJson(response,maxBytes){
  const length=Number(response.headers?.get?.('content-length'));
  if(Number.isFinite(length)&&length>maxBytes)
    throw error('WECHAT_UNAVAILABLE','微信登录服务暂不可用',503);
  if(!response.body?.getReader)throw error('WECHAT_UNAVAILABLE','微信登录服务暂不可用',503);
  const reader=response.body.getReader();
  const chunks=[];let total=0;
  try{
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      total+=value.byteLength;
      if(total>maxBytes){
        await reader.cancel();
        throw error('WECHAT_UNAVAILABLE','微信登录服务暂不可用',503);
      }
      chunks.push(value);
    }
  }finally{reader.releaseLock();}
  try{return JSON.parse(Buffer.concat(chunks.map(chunk=>Buffer.from(chunk)),total).toString('utf8'));}
  catch{throw error('WECHAT_UNAVAILABLE','微信登录服务暂不可用',503);}
}

/**
 * @param {{appId:string,appSecret:string}} config private server settings
 * @param {{fetchImpl?:typeof fetch,timeoutMs?:number,maxResponseBytes?:number}} options
 * A supplied fetch implementation is accepted only in NODE_ENV=test.
 */
export function createWechatCodeSessionAdapter(config,options={}){
  const {appId,appSecret}=readConfig(config);
  const fetchImpl=options.fetchImpl??globalThis.fetch;
  if(options.fetchImpl!==undefined&&process.env.NODE_ENV!=='test')
    throw error('WECHAT_TEST_ADAPTER_FORBIDDEN','微信测试适配器只允许隔离测试使用',503);
  if(typeof fetchImpl!=='function')throw error('WECHAT_CONFIG_INVALID','微信小程序服务端配置无效',503);
  const timeoutMs=options.timeoutMs??5000;
  const maxResponseBytes=options.maxResponseBytes??16384;
  if(!Number.isInteger(timeoutMs)||timeoutMs<20||timeoutMs>10000||
      !Number.isInteger(maxResponseBytes)||maxResponseBytes<256||maxResponseBytes>65536)
    throw error('WECHAT_CONFIG_INVALID','微信小程序服务端配置无效',503);

  async function exchangeCode(rawCode){
    if(typeof rawCode!=='string'||!codePattern.test(rawCode))
      throw error('CODE_INVALID','微信临时登录码无效',400);
    const query=new URLSearchParams({appid:appId,secret:appSecret,js_code:rawCode,
      grant_type:'authorization_code'});
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{
      const response=await fetchImpl(`https://api.weixin.qq.com/sns/jscode2session?${query}`,
        {method:'GET',signal:controller.signal,redirect:'error',cache:'no-store'});
      if(!response?.ok)throw error('WECHAT_UNAVAILABLE','微信登录服务暂不可用',503);
      const payload=await boundedJson(response,maxResponseBytes);
      if(payload?.errcode!==undefined&&Number(payload.errcode)!==0)
        throw error('CODE_INVALID','微信临时登录码已失效，请重试',401);
      if(typeof payload?.openid!=='string'||!identityPattern.test(payload.openid)||
          typeof payload?.session_key!=='string'||payload.session_key.length<8||
          payload.session_key.length>256||
          (payload.unionid!==undefined&&
            (typeof payload.unionid!=='string'||!identityPattern.test(payload.unionid))))
        throw error('WECHAT_UNAVAILABLE','微信登录服务暂不可用',503);
      // Deliberately discard session_key. The caller gets only the identity to
      // bind to a BSR customer account and must issue a separate BSR session.
      return payload.unionid?{openid:payload.openid,unionid:payload.unionid}:{openid:payload.openid};
    }catch(caught){
      if(caught instanceof WechatPlatformError)throw caught;
      throw error('WECHAT_UNAVAILABLE','微信登录服务暂不可用',503);
    }finally{clearTimeout(timer);}
  }
  return Object.freeze({exchangeCode});
}
