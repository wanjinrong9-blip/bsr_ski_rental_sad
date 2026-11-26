// The public official AppID identifies the Developer Tools project; it is not
// an AppSecret. Local demo remains limited to this computer's simulator.
// Real-device/release configuration requires an approved HTTPS request domain,
// private server credentials and the separate SHOWCASE identity path.
module.exports = Object.freeze({
  mode: 'local-demo',
  apiBase: 'http://127.0.0.1:4173',
  devtoolsAppId: 'wx51ce51fc873371a6'
});
