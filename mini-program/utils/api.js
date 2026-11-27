const config = require('./config');
const { networkError } = require('./network-error');

const localSessionKey = 'bsr-mini-local-session';
const wechatSessionKey = 'bsr-mini-wechat-session';
const accountSessionKey = 'bsr-mini-account-cookie';
let sessionToken = '';
const downloadedPhotoPaths = new Set();

function isWechatShowcase() { return config.mode === 'wechat-showcase'; }
function isAccountShowcase() { return config.mode === 'account-showcase'; }
function sessionKey() { return isAccountShowcase() ? accountSessionKey : isWechatShowcase() ? wechatSessionKey : localSessionKey; }
function cartKey() { return isAccountShowcase() ? 'bsr-mini-account-cart' : isWechatShowcase() ? 'bsr-mini-wechat-cart' : 'bsr-mini-cart'; }
function windowKey() { return isAccountShowcase() ? 'bsr-mini-account-window' : isWechatShowcase() ? 'bsr-mini-wechat-window' : 'bsr-mini-window'; }
function pendingKey() { return isAccountShowcase() ? 'bsr-mini-account-pending' : isWechatShowcase() ? 'bsr-mini-wechat-pending' : 'bsr-mini-pending'; }

function assertAccountShowcase() {
  if (!isAccountShowcase() || !/^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(config.apiBase || '') ||
      /\.(?:localhost|local|internal|invalid|test|onion)$/.test(config.apiBase || '')) {
    throw new Error('顾客账号体验仅允许公网 HTTPS 地址；微信合法请求域名须另行配置');
  }
}

function adaptWebUser(user) {
  if (!user || typeof user !== 'object') return null;
  return { id: user.id, name: user.name, email: user.email, role: user.role, storeId: user.storeId,
    phone: user.phone || '', address: user.address || '', birthYear: user.birthYear ?? null,
    heightCm: user.heightCm ?? null, weightKg: user.weightKg ?? null, shoeSize: user.shoeSize || '',
    mustChangePassword: user.mustChangePassword === true };
}

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
  if (isAccountShowcase()) return assertAccountShowcase();
  if (isWechatShowcase()) return assertWechatShowcase();
  return assertLocalDemo();
}

function mapPath(path) {
  if (!/^\/api\/[A-Za-z0-9/?=&%_.:-]+$/.test(path || '') || path.startsWith('//')) {
    throw new Error('接口路径无效');
  }
  if (isAccountShowcase()) {
    if (/^\/api\/(bootstrap|me|cart|quote|catalog(?:\?.*)?|reservations(?:\/\d+(?:\/(?:cancel|contracts|pay|damage\/dispute))?)?|contracts\/\d+\/sign|auth\/(?:login|logout))$/.test(path)) return path;
    throw new Error('顾客账号体验不提供此接口');
  }
  if (!isWechatShowcase()) return path;
  if (/^\/api\/(bootstrap|me|cart|quote|catalog(?:\?.*)?|reservations(?:\/\d+(?:\/(?:cancel|contracts|pay|damage\/dispute))?)?|contracts\/\d+\/sign|auth\/(?:wechat|bind|logout|unbind))$/.test(path)) {
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
  let nextToken = typeof token === 'string' ? token : '';
  if (isAccountShowcase() && !/^__Host-bsr_showcase_session=[a-f0-9]{64}$/.test(nextToken)) nextToken = '';
  if (sessionToken && sessionToken !== nextToken) {
    if (isAccountShowcase()) clearPrivateCache(); else clearDownloadedPhotos();
  }
  sessionToken = nextToken;
  if (sessionToken) wx.setStorageSync(sessionKey(), sessionToken);
  else wx.removeStorageSync(sessionKey());
}

function restoreToken() {
  sessionToken = wx.getStorageSync(sessionKey()) || '';
  if (isWechatShowcase() && !/^[a-f0-9]{64}$/.test(sessionToken)) setToken('');
  if (isAccountShowcase() && !/^__Host-bsr_showcase_session=[a-f0-9]{64}$/.test(sessionToken)) setToken('');
}

function captureAccountCookie(response) {
  const values = Array.isArray(response.cookies) ? [...response.cookies] : [];
  for (const [name, value] of Object.entries(response.header || {})) {
    if (name.toLowerCase() === 'set-cookie') values.push(...(Array.isArray(value) ? value : [value]));
  }
  for (const value of values) {
    const match = String(value).match(/^__Host-bsr_showcase_session=([a-f0-9]{64}|)(?:;|$)/);
    if (match) setToken(match[1] ? `__Host-bsr_showcase_session=${match[1]}` : '');
  }
}

function authHeaders(token = sessionToken) {
  if (isAccountShowcase()) return { Origin: config.apiBase, ...(token ? { Cookie: token } : {}) };
  return token ? isWechatShowcase() ? { Authorization: `Bearer ${token}` } : { 'X-BSR-Session': token } : {};
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
      // Temporary hosting can need longer to serve the first read after startup.
      // Never automatically retry a booking/payment write with an uncertain outcome.
      timeout: /\/bootstrap$/.test(path) ? 30000 : 12000,
      header: {
        'Content-Type': 'application/json',
        ...extraHeaders,
        ...(!unauthenticated ? authHeaders() : {})
      },
      success(response) {
        const result = response.data;
        if (isAccountShowcase()) captureAccountCookie(response);
        if (response.statusCode >= 200 && response.statusCode < 300) {
          if (isWechatShowcase() && path.startsWith('/api/mini/catalog') && Array.isArray(result?.items)) {
            return resolve({ ...result, items: result.items.map(item => ({ ...item, available: item.availableCount })) });
          }
          return resolve(result);
        }
        if (response.statusCode === 401 && !unauthenticated) {
          setToken('');
          if (isWechatShowcase() || isAccountShowcase()) clearPrivateCache();
        }
        const error = new Error((result && (result.error || result.message)) || `请求失败（${response.statusCode}）`);
        error.status = response.statusCode;
        error.code = result && result.code;
        error.currentVersion = result && result.currentVersion;
        reject(error);
      },
      fail(error) {
        reject(networkError(error, !isWechatShowcase() && !isAccountShowcase()));
      }
    });
  });
}

async function bootstrap() {
  const result = await request('/api/bootstrap');
  if (isAccountShowcase()) {
    if (result.runMode !== 'showcase' || result.synthetic !== true || result.demo !== false) {
      setToken(''); clearPrivateCache();
      throw new Error('顾客账号体验只能连接受控合成展示服务');
    }
    const user = adaptWebUser(result.user);
    if (user && (user.role !== 'customer' || user.mustChangePassword)) {
      await logout();
      throw new Error(user.mustChangePassword ? '请先在网页更换一次性密码，再登录顾客账号体验' : '小程序仅提供顾客工作台，请使用顾客账号');
    }
    if (!user && sessionToken) { setToken(''); clearPrivateCache(); }
    return { ...result, user };
  }
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
  if (isAccountShowcase()) {
    try {
      if (sessionToken) await logout();
      const result = await request('/api/auth/login', 'POST', { email, password });
      const user = adaptWebUser(result.user);
      if (!sessionToken || user?.role !== 'customer' || user.mustChangePassword) {
        if (sessionToken) await logout();
        throw new Error(user?.mustChangePassword ? '请先在网页更换一次性密码，再登录顾客账号体验' : '小程序仅提供顾客工作台，请使用顾客账号');
      }
      return user;
    } catch (error) { setToken(''); clearPrivateCache(); throw error; }
  }
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
      header: authHeaders(tokenAtStart),
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
      fail(error) { reject(networkError(error, !isWechatShowcase() && !isAccountShowcase())); }
    });
  });
}

function canPreviewDamagePhoto(localPath) {
  return !!sessionToken && downloadedPhotoPaths.has(localPath);
}

module.exports = { request, bootstrap, login, wechatLogin, bindWechat, unbindWechat,
  logout, setToken, restoreToken, clearPrivateCache, assertLocalDemo,
  assertWechatShowcase, assertAccountShowcase, isWechatShowcase, isAccountShowcase, adaptWebUser, mapPath, cartKey, windowKey, pendingKey,
  downloadDamagePhoto, canPreviewDamagePhoto };
