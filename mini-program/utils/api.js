const config = require('./config');

const localSessionKey = 'bsr-mini-local-session';
const wechatSessionKey = 'bsr-mini-wechat-session';
let sessionToken = '';
const downloadedPhotoPaths = new Set();

function isWechatShowcase() { return config.mode === 'wechat-showcase'; }
function sessionKey() { return isWechatShowcase() ? wechatSessionKey : localSessionKey; }
function cartKey() { return isWechatShowcase() ? 'bsr-mini-wechat-cart' : 'bsr-mini-cart'; }
function windowKey() { return isWechatShowcase() ? 'bsr-mini-wechat-window' : 'bsr-mini-window'; }
function pendingKey() { return isWechatShowcase() ? 'bsr-mini-wechat-pending' : 'bsr-mini-pending'; }

function assertLocalDemo() {
  if (config.mode !== 'local-demo' || config.apiBase !== 'http://127.0.0.1:4173') {
    throw new Error('本机演示仅允许连接电脑回环服务');
  }
  const account = typeof wx.getAccountInfoSync === 'function' ? wx.getAccountInfoSync() : null;
  const appId = account && account.miniProgram && account.miniProgram.appId;
  if (appId && appId !== 'touristappid') {
    const device = typeof wx.getDeviceInfo === 'function' ? wx.getDeviceInfo()
      : typeof wx.getSystemInfoSync === 'function' ? wx.getSystemInfoSync() : null;
    if (appId !== config.devtoolsAppId || device?.platform !== 'devtools') {
      throw new Error('当前 AppID 或真机不可连接本机教学数据；请使用已配置 AppID 的开发者工具模拟器');
    }
  }
}

function assertWechatShowcase() {
  if (!isWechatShowcase() || !/^https:\/\/([a-z0-9-]+\.)+[a-z]{2,}(?::443)?$/i.test(config.apiBase || '') ||
      !/^wx[A-Za-z0-9]{16}$/.test(config.appId || '')) {
    throw new Error('请先配置正式 AppID 和已登记的 HTTPS 业务域名');
  }
  const actual = typeof wx.getAccountInfoSync === 'function'
    ? wx.getAccountInfoSync()?.miniProgram?.appId : null;
  if (actual !== config.appId) throw new Error('运行中的小程序 AppID 与服务配置不一致');
}

function assertRuntime() {
  if (isWechatShowcase()) return assertWechatShowcase();
  return assertLocalDemo();
}

function mapPath(path) {
  if (!/^\/api\/[A-Za-z0-9/?=&%_.:-]+$/.test(path || '') || path.startsWith('//')) {
    throw new Error('接口路径无效');
  }
  if (!isWechatShowcase()) return path;
  if (/^\/api\/(bootstrap|me|cart|quote|catalog(?:\?.*)?|reservations(?:\/\d+(?:\/(?:cancel|contracts|pay))?)?|contracts\/\d+\/sign|auth\/(?:wechat|bind|logout|unbind))$/.test(path)) {
    return path.replace(/^\/api\//, '/api/mini/');
  }
  throw new Error('安全模式不提供此接口');
}

function clearDownloadedPhotos() {
  if (typeof wx.getFileSystemManager === 'function') {
    const files = wx.getFileSystemManager();
    for (const filePath of downloadedPhotoPaths) {
      try { files.unlink({ filePath, fail() {} }); } catch {}
    }
  }
  downloadedPhotoPaths.clear();
}

function clearPrivateCache() {
  clearDownloadedPhotos();
  wx.removeStorageSync(cartKey());
  wx.removeStorageSync(pendingKey());
  if (typeof getApp === 'function') {
    const app = getApp();
    if (app?.globalData) {
      app.globalData.user = null;
      app.globalData.cart = [];
      app.globalData.cartVersion = 0;
      app.globalData.boot = null;
    }
  }
}

function setToken(token) {
  const nextToken = typeof token === 'string' ? token : '';
  if (sessionToken && sessionToken !== nextToken) clearDownloadedPhotos();
  sessionToken = nextToken;
  if (sessionToken) wx.setStorageSync(sessionKey(), sessionToken);
  else wx.removeStorageSync(sessionKey());
}

function restoreToken() {
  sessionToken = wx.getStorageSync(sessionKey()) || '';
  if (isWechatShowcase() && !/^[a-f0-9]{64}$/.test(sessionToken)) setToken('');
}

function request(path, method = 'GET', data, extraHeaders = {}) {
  try { assertRuntime(); path = mapPath(path); }
  catch (error) { return Promise.reject(error); }
  const unauthenticated = ['/api/mini/bootstrap', '/api/mini/auth/wechat', '/api/mini/auth/bind'].includes(path);
  return new Promise((resolve, reject) => {
    wx.request({
      url: config.apiBase + path,
      method,
      data,
      timeout: 12000,
      header: {
        'Content-Type': 'application/json',
        ...(sessionToken && !unauthenticated ? isWechatShowcase()
          ? { Authorization: `Bearer ${sessionToken}` }
          : { 'X-BSR-Session': sessionToken } : {}),
        ...extraHeaders
      },
      success(response) {
        const result = response.data;
        if (response.statusCode >= 200 && response.statusCode < 300) {
          if (isWechatShowcase() && path.startsWith('/api/mini/catalog') && Array.isArray(result?.items)) {
            return resolve({ ...result, items: result.items.map(item => ({ ...item, available: item.availableCount })) });
          }
          return resolve(result);
        }
        if (response.statusCode === 401 && !unauthenticated) {
          setToken('');
          if (isWechatShowcase()) clearPrivateCache();
        }
        const error = new Error((result && (result.error || result.message)) || `请求失败（${response.statusCode}）`);
        error.status = response.statusCode;
        error.code = result && result.code;
        error.currentVersion = result && result.currentVersion;
        reject(error);
      },
      fail(error) {
        const wrapped = new Error(isWechatShowcase()
          ? '网络连接失败。请检查微信网络和服务状态，稍后重试；未确认结果的预约可用原提交标识找回。'
          : '无法连接本机 BSR 预览。请在电脑启动网页服务，并在微信开发者工具中关闭仅本机调试的域名校验。');
        wrapped.network = true;
        wrapped.cause = error;
        reject(wrapped);
      }
    });
  });
}

async function bootstrap() {
  const result = await request('/api/bootstrap');
  if (isWechatShowcase()) {
    if (result.status !== 'ready' || result.synthetic !== true || result.customerOnly !== true) {
      throw new Error('微信顾客服务尚未开放');
    }
    const user = sessionToken ? await request('/api/me').catch(error => {
      if (error.status === 401) return null;
      throw error;
    }) : null;
    return { ...result, user };
  }
  if (result.runMode !== 'demo' || result.demo !== true) {
    throw new Error('本机演示只能连接本机教学数据');
  }
  return result;
}

async function login(email, password) {
  if (isWechatShowcase()) throw new Error('请使用微信身份验证和显式账号绑定');
  const result = await request('/api/auth/login', 'POST', { email, password });
  if (!result.sessionToken || result.user?.role !== 'customer') {
    if (result.sessionToken) {
      setToken(result.sessionToken);
      try { await request('/api/auth/logout', 'POST'); } finally { setToken(''); }
    }
    throw new Error('小程序仅提供顾客工作台，请使用顾客账号');
  }
  setToken(result.sessionToken);
  return result.user;
}

async function wechatLogin(code) {
  if (!isWechatShowcase()) throw new Error('本机演示未启用微信身份验证');
  const result = await request('/api/auth/wechat', 'POST', { code });
  if (result.status === 'authenticated' && result.user?.role === 'customer' && result.sessionToken) {
    setToken(result.sessionToken);
  }
  return result;
}

async function bindWechat(challenge, email, password) {
  if (!isWechatShowcase()) throw new Error('本机演示未启用微信身份绑定');
  const result = await request('/api/auth/bind', 'POST',
    { challenge, email, password, explicitConsent: true });
  if (result.status !== 'authenticated' || result.user?.role !== 'customer' || !result.sessionToken) {
    throw new Error('绑定未完成，请重新登录微信');
  }
  setToken(result.sessionToken);
  return result.user;
}

async function unbindWechat(password) {
  if (!isWechatShowcase()) throw new Error('本机演示没有微信身份绑定');
  const result = await request('/api/auth/unbind', 'POST', { password });
  setToken(''); clearPrivateCache();
  return result;
}

async function logout() {
  try { if (sessionToken) await request('/api/auth/logout', 'POST'); }
  finally { setToken(''); clearPrivateCache(); }
}

function downloadDamagePhoto(photoId) {
  try { assertRuntime(); }
  catch (error) { return Promise.reject(error); }
  const id = Number(photoId);
  if (!Number.isSafeInteger(id) || id <= 0) return Promise.reject(new Error('照片编号无效'));
  if (!sessionToken) return Promise.reject(new Error('请先登录后查看鉴定照片'));
  const path = isWechatShowcase()
    ? '/api/mini/damage-photos/' + id : '/api/damage-photos/' + id;
  const tokenAtStart = sessionToken;
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url: config.apiBase + path,
      header: isWechatShowcase()
        ? { Authorization: 'Bearer ' + tokenAtStart }
        : { 'X-BSR-Session': tokenAtStart },
      success(response) {
        if (sessionToken !== tokenAtStart) {
          if (response.tempFilePath && typeof wx.getFileSystemManager === 'function') {
            try { wx.getFileSystemManager().unlink({
              filePath: response.tempFilePath, fail() {}
            }); } catch {}
          }
          return reject(new Error('登录状态已变化，请重新打开订单后查看照片'));
        }
        if (response.statusCode === 200 && response.tempFilePath) {
          downloadedPhotoPaths.add(response.tempFilePath);
          return resolve(response.tempFilePath);
        }
        if (response.statusCode === 401) {
          setToken('');
          clearPrivateCache();
        }
        reject(new Error(response.statusCode === 404
          ? '照片不存在或无权查看' : '照片获取失败，请稍后重试'));
      },
      fail() { reject(new Error('网络连接失败，鉴定照片未下载；请稍后重试')); }
    });
  });
}

function canPreviewDamagePhoto(localPath) {
  return !!sessionToken && downloadedPhotoPaths.has(localPath);
}

module.exports = { request, bootstrap, login, wechatLogin, bindWechat, unbindWechat,
  logout, setToken, restoreToken, clearPrivateCache, assertLocalDemo,
  assertWechatShowcase, isWechatShowcase, mapPath, cartKey, windowKey, pendingKey,
  downloadDamagePhoto, canPreviewDamagePhoto };
