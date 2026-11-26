const api = require('../../utils/api');
const cartSync = require('../../utils/cart-sync');

const showError = error => wx.showModal({ title: '操作未完成', content: error.message || '请稍后重试', showCancel: false });

function profileFrom(user) {
  return {
    name: user?.name || '', phone: user?.phone || '', address: user?.address || '',
    birthYear: user?.birthYear ? String(user.birthYear) : '',
    heightCm: user?.heightCm ? String(user.heightCm) : '',
    weightKg: user?.weightKg ? String(user.weightKg) : '', shoeSize: user?.shoeSize || ''
  };
}

Page({
  data: { loading: true, busy: false, user: null, userInitial: '', mode: 'login',
    wechatMode: api.isWechatShowcase(), bindingChallenge: '', bindingExpiresAt: '',
    bindConsent: false, unbindPassword: '',
    loginEmail: '', loginPassword: '', registerName: '', registerEmail: '', registerPassword: '',
    profile: profileFrom(null), error: '' },

  async onShow() {
    this.setData({ loading: true, error: '' });
    try {
      const boot = await getApp().ensureBootstrap(true);
      const user = boot.user?.role === 'customer' ? boot.user : null;
      getApp().globalData.user = user;
      this.setData({ user, userInitial: user?.name?.slice(0, 1) || '', profile: profileFrom(user) });
    } catch (error) { this.setData({ error: error.message, user: null }); }
    finally { this.setData({ loading: false }); }
  },
  onLoginInput(event) { this.setData({ [event.currentTarget.dataset.key]: event.detail.value }); },
  onProfileInput(event) { this.setData({ [`profile.${event.currentTarget.dataset.key}`]: event.detail.value }); },
  toggleMode() { this.setData({ mode: this.data.mode === 'login' ? 'register' : 'login', loginPassword: '', registerPassword: '' }); },

  async onWechatLogin() {
    if (!api.isWechatShowcase() || this.data.busy) return;
    this.setData({ busy: true, bindingChallenge: '', bindConsent: false });
    try {
      const credential = await new Promise((resolve, reject) => wx.login({
        success: result => result.code ? resolve(result.code) : reject(new Error('微信未提供临时登录码')),
        fail: () => reject(new Error('微信身份验证暂不可用，请稍后重试'))
      }));
      const result = await api.wechatLogin(credential);
      if (result.status === 'needs_binding') {
        this.setData({ bindingChallenge: result.challenge, bindingExpiresAt: result.expiresAt });
        return;
      }
      if (result.status !== 'authenticated' || result.user?.role !== 'customer') {
        throw new Error('微信身份验证未完成，请重试');
      }
      const user = await api.request('/api/me');
      const app = getApp();
      app.globalData.user = user;
      if (app.globalData.boot) app.globalData.boot.user = user;
      this.setData({ user, userInitial: user.name.slice(0, 1),
        profile: profileFrom(user), bindingChallenge: '' });
      await cartSync.mergeAfterLogin(app);
    } catch (error) { showError(error); }
    finally { this.setData({ busy: false }); }
  },
  onBindConsent(event) { this.setData({ bindConsent: event.detail.value.includes('yes') }); },
  async onBindWechat() {
    if (!api.isWechatShowcase() || this.data.busy || !this.data.bindingChallenge) return;
    if (!this.data.bindConsent) return showError(new Error('请先确认将微信身份绑定到当前顾客账号'));
    this.setData({ busy: true });
    try {
      await api.bindWechat(this.data.bindingChallenge,
        this.data.loginEmail.trim().toLowerCase(), this.data.loginPassword);
      const user = await api.request('/api/me');
      const app = getApp();
      app.globalData.user = user;
      if (app.globalData.boot) app.globalData.boot.user = user;
      this.setData({ user, userInitial: user.name.slice(0, 1), profile: profileFrom(user),
        bindingChallenge: '', bindingExpiresAt: '', bindConsent: false, loginPassword: '' });
      await cartSync.mergeAfterLogin(app);
      wx.showToast({ title: '顾客账号已绑定', icon: 'success' });
    } catch (error) {
      if (['CHALLENGE_USED', 'CHALLENGE_EXPIRED'].includes(error.code)) {
        this.setData({ bindingChallenge: '', bindConsent: false });
      }
      showError(error);
    } finally { this.setData({ busy: false, loginPassword: '' }); }
  },
  onUnbindInput(event) { this.setData({ unbindPassword: event.detail.value }); },
  async onUnbindWechat() {
    if (!api.isWechatShowcase() || this.data.busy) return;
    if (!this.data.unbindPassword) return showError(new Error('请输入顾客账号密码确认解绑'));
    this.setData({ busy: true });
    try {
      await api.unbindWechat(this.data.unbindPassword);
      getApp().clearIdentity();
      this.setData({ user: null, userInitial: '', profile: profileFrom(null),
        unbindPassword: '', bindingChallenge: '', bindConsent: false });
      wx.showToast({ title: '已解除绑定', icon: 'success' });
    } catch (error) { showError(error); }
    finally { this.setData({ busy: false, unbindPassword: '' }); }
  },

  async onLogin() {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try {
      const user = await api.login(this.data.loginEmail.trim().toLowerCase(), this.data.loginPassword);
      getApp().globalData.user = user;
      if (getApp().globalData.boot) getApp().globalData.boot.user = user;
      await cartSync.mergeAfterLogin(getApp());
      this.setData({ user, userInitial: user.name.slice(0, 1), profile: profileFrom(user), loginPassword: '' });
      wx.showToast({ title: '已登录顾客账号', icon: 'success' });
    } catch (error) { showError(error); }
    finally { this.setData({ busy: false, loginPassword: '' }); }
  },

  async onRegister() {
    if (api.isWechatShowcase()) return showError(new Error('安全展示暂不开放自助注册，请使用已验证顾客账号'));
    if (this.data.busy) return;
    this.setData({ busy: true });
    try {
      await api.request('/api/auth/register', 'POST', { name: this.data.registerName.trim(),
        email: this.data.registerEmail.trim().toLowerCase(), password: this.data.registerPassword });
      this.setData({ mode: 'login', loginEmail: this.data.registerEmail.trim().toLowerCase(), registerPassword: '' });
      wx.showToast({ title: '已创建演示顾客账号', icon: 'success' });
    } catch (error) { showError(error); }
    finally { this.setData({ busy: false, registerPassword: '' }); }
  },

  async onSaveProfile() {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try {
      const saved = await api.request('/api/me', 'PATCH', this.data.profile);
      const user = { ...this.data.user, ...saved };
      getApp().globalData.user = user;
      this.setData({ user, userInitial: user.name.slice(0, 1), profile: profileFrom(user) });
      wx.showToast({ title: '资料已保存', icon: 'success' });
    } catch (error) { showError(error); }
    finally { this.setData({ busy: false }); }
  },

  async onLogout() {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try { await api.logout(); }
    catch (error) { showError(error); }
    finally {
      getApp().clearIdentity();
      if (getApp().globalData.boot) getApp().globalData.boot.user = null;
      this.setData({ busy: false, user: null, userInitial: '', profile: profileFrom(null), loginPassword: '' });
    }
  },
  goOrders() { wx.switchTab({ url: '/pages/orders/index' }); }
});
