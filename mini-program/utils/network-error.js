// Keep diagnostics useful without exposing URLs, request bodies or credentials.
function networkError(cause, localDemo = false) {
  const detail = typeof cause?.errMsg === 'string' ? cause.errMsg : '';
  let code = 'NETWORK_UNAVAILABLE';
  let message = '暂时无法连接服务，请检查网络，稍后重试或点击“重新连接”。';
  if (/url not in domain list|not.*(?:legal|valid).*domain|不在.*合法域名|域名.*不合法/i.test(detail)) {
    code = 'DOMAIN_NOT_ALLOWED';
    message = '小程序服务器域名尚未配置完成，请联系管理员配置微信合法请求域名；重新上传代码不能解除此限制。';
  } else if (/timeout|timed out|超时/i.test(detail)) {
    code = 'REQUEST_TIMEOUT';
    message = '服务响应超时，临时演示服务可能正在启动，请稍后点击“重新连接”。';
  } else if (/certificate|ssl|tls|cert_|证书/i.test(detail)) {
    code = 'TLS_ERROR';
    message = '无法验证服务器的安全连接，请联系管理员检查 HTTPS 证书。';
  } else if (/name_not_resolved|dns|resolve host|域名解析/i.test(detail)) {
    code = 'DNS_ERROR';
    message = '服务器地址暂时无法解析，请切换网络后重新连接；若仍失败请联系管理员。';
  } else if (/proxy|代理/i.test(detail)) {
    code = 'PROXY_ERROR';
    message = '网络代理连接失败，请检查当前网络或代理后重新连接。';
  } else if (/network.*(?:unavailable|offline)|internet_disconnected|无网络|网络不可用/i.test(detail)) {
    code = 'NETWORK_OFFLINE';
    message = '当前网络不可用，请连接网络后重试。';
  } else if (/connection_refused|connection_reset|connection_closed|connect.*fail/i.test(detail)) {
    code = 'CONNECTION_FAILED';
    message = '服务器连接未建立或已中断，请稍后重新连接；若持续失败请联系管理员。';
  }
  const transportCode = detail.match(/\bERR_[A-Z0-9_]{1,60}\b/)?.[0] || '';
  if (localDemo) message = '无法连接电脑上的 BSR 服务，请确认本机服务正在运行；手机不能访问电脑的回环地址。';
  const error = new Error(`${message}（${transportCode || code}）`);
  error.network = true;
  error.code = code;
  error.transportCode = transportCode;
  error.cause = cause;
  return error;
}

module.exports = { networkError };
