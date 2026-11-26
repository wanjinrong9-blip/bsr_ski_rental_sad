// Public AppID is known; copy the relevant fields into utils/config.js only
// after registering the HTTPS request domain and configuring the private
// server-side AppSecret. This is not a working domain, QR or release switch.
module.exports = Object.freeze({
  mode: 'wechat-showcase',
  apiBase: 'https://replace-with-registered-domain.invalid',
  appId: 'wx51ce51fc873371a6'
});
