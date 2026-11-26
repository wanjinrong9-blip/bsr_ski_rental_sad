import {createHash} from 'node:crypto';
import {validateMiniCodeImage} from './mini-entry.mjs';

/**
 * Server-only WeChat Mini Program adapter. Never import this file from public/
 * or mini-program/. WeChat session_key and AppSecret stay inside this boundary.
 * Mini Program code issuance is an explicit private setup operation, separate
 * from login. It never enables the website's public QR entry automatically.
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

async function boundedImage(response) {
  const maxBytes = 2 * 1024 * 1024;
  if (Number(response.headers?.get('content-length')) > maxBytes || !response.body?.getReader)
    throw new Error('image size');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error('image size'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks, size);
  // Existing public entry accepts PNG only. JSON errors and other formats
  // fail closed; do not silently convert or replace the platform image.
  validateMiniCodeImage(bytes);
  return bytes;
}

export function createWechatMiniCodeAdapter(config, options = {}) {
  const {appId, appSecret} = readConfig(config);
  if (options.fetchImpl !== undefined && process.env.NODE_ENV !== 'test')
    throw error('WECHAT_TEST_ADAPTER_FORBIDDEN', '微信测试适配器只允许隔离测试使用', 503);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 5000;
  if (typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 20 || timeoutMs > 10000)
    throw error('WECHAT_CONFIG_INVALID', '微信小程序服务端配置无效', 503);
  const page = 'pages/catalog/index', scene = 'home', envVersion = 'release';
  async function obtainMiniCode() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const request = {method: 'POST', redirect: 'error', cache: 'no-store',
      signal: controller.signal, headers: {'Content-Type': 'application/json'}};
    try {
      const tokenResponse = await fetchImpl('https://api.weixin.qq.com/cgi-bin/stable_token',
        {...request, body: JSON.stringify({grant_type: 'client_credential', appid: appId, secret: appSecret})});
      if (!tokenResponse?.ok) throw new Error('platform token');
      const token = await boundedJson(tokenResponse, 16384);
      if ((token.errcode !== undefined && Number(token.errcode) !== 0) ||
          typeof token.access_token !== 'string' || !/^[A-Za-z0-9_-]{16,512}$/.test(token.access_token) ||
          !Number.isInteger(token.expires_in) || token.expires_in < 1 || token.expires_in > 7200)
        throw new Error('platform token');
      const endpoint = 'https://api.weixin.qq.com/wxa/getwxacodeunlimit';
      const query = new URLSearchParams({access_token: token.access_token});
      const response = await fetchImpl(`${endpoint}?${query}`, {...request,
        body: JSON.stringify({page, scene, check_path: true, env_version: envVersion, width: 430})});
      if (!response?.ok) throw new Error('platform image');
      const bytes = await boundedImage(response);
      return {bytes, provenance: {version: 1, source: 'wechat-api-request', appId, page, scene,
        envVersion, endpoint, imageSha256: createHash('sha256').update(bytes).digest('hex'),
        obtainedAt: new Date().toISOString()}};
    } catch {
      throw error('WECHAT_CODE_UNAVAILABLE', '微信小程序码获取失败；请在私有平台环境核对资格与发布状态', 503);
    } finally { clearTimeout(timer); }
  }
  return Object.freeze({obtainMiniCode});
}
