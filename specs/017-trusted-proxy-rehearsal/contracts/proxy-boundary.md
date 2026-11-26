# 017 候选入口与受信任代理契约

此契约仅描述本机演练与以后阿里云 ECS 上同机代理的对接要求；没有配置真实域名或打开公网。

## 启动配置

| 变量 | 直连候选 | 受控代理候选 | 错误处理 |
| --- | --- | --- | --- |
| `BSR_RUN_MODE` | `candidate` | `candidate` | demo 不可使用代理传输 |
| `BSR_CANDIDATE_TRANSPORT` | 未设置或 `direct-tls` | `trusted-local-proxy` | 其他值在打开数据库前拒绝 |
| `HOST` | 回环地址 | 回环地址 | `0.0.0.0`、外网地址在打开数据库前拒绝 |
| `PORT` | 合法端口 | 合法端口 | 非 1–65535 十进制整数拒绝 |
| `BSR_DB_PATH` | 独立候选库 | 独立候选库 | 演示库或公开目录拒绝 |
| `BSR_BACKUP_DIR` | 已存在私有目录 | 已存在私有目录 | 缺失、公开路径或包含业务库拒绝 |
| `BSR_PUBLIC_ORIGIN` | 与本机 HTTPS 地址/端口一致 | 唯一完整 `https://host[:port]` origin | 含路径、查询、片段、账号或非 HTTPS 拒绝 |
| `BSR_TLS_CERT_PATH` / `BSR_TLS_KEY_PATH` | 必填、配对且在有效期 | 不提供；由前置代理终止 HTTPS | 直连缺失或代理混用拒绝 |
| `BSR_PROXY_SECRET` | 不提供 | 64 位随机十六进制字节串 | 缺失、重复单字符、占位值或长度/格式错误拒绝；值不得输出 |

`BSR_PROXY_SECRET` 应由密码学随机源生成 32 字节后以 64 个 hex 字符表示；不能把示例占位内容当密钥。私有环境文件和以后 Nginx 的受限配置由部署者生成，不进入 Git、PDF、截图、HTTP 响应或日志。

## 每个受控代理请求

代理必须覆盖或清除访客传入的同名安全头，然后向回环 Node 转发：

| 字段 | 要求 | 未通过的结果 |
| --- | --- | --- |
| `Host` | 原始报文中恰好一个，严格等于 `BSR_PUBLIC_ORIGIN` 的 host（包含非默认端口） | 403 |
| `X-BSR-Proxy-Secret` | 原始报文中恰好一个，值与私有密钥固定时序比较 | 403 |
| `X-Forwarded-Proto` | 恰好一个，精确 `https` | 403 |
| `X-BSR-Client-IP` | 恰好一个有效 IPv4/IPv6，无逗号链、空白附加或端口 | 403 |
| URL target | origin-form 相对路径，以单个 `/` 开始；拒绝 absolute-form 与 `//` | 403 |
| `Origin` | 所有非 GET/HEAD API 写入须精确等于 `BSR_PUBLIC_ORIGIN` | 现有 403 |

校验顺序：入口字段 → 请求内可信客户地址 → URL/静态/API 路由 → 候选会话与对象权限。健康检查、静态资源、SSE、登录和注销均执行入口字段校验。未认证的来源字段不得写入可信请求上下文；应用永不从原始 `X-Forwarded-For` 推断访客 IP。代理故障或密钥不一致时优先拒绝，不改用 demo/直连模式。

响应不得包含代理密钥或原始受保护数据库资料。候选登录 Cookie 保持 `__Host-bsr_candidate_session`、`Secure`、`HttpOnly`、`SameSite=Strict`、`Path=/`，不返回可供脚本保存的会话令牌。

## 阿里云部署模板边界

预备 Nginx 模板应只让 Nginx 对外接收 443，并将应用端口设为回环；Nginx 必须覆盖 `X-BSR-Proxy-Secret`、`X-BSR-Client-IP` 和 `X-Forwarded-Proto`，清除访客 `X-Forwarded-For`，保持单一 Host。真实证书、域名、地域、数据盘挂载和安全组由用户购买后再填，不允许示例模板直接作为已启用的公网配置。

## 验证矩阵

1. 正确代理请求：健康、静态、登录、本人读取、退出成功；Cookie 仍安全。
2. 缺/错/重复密钥、Host、协议、客户地址、absolute-form URL：全部 403，受保护内容和业务写入差异 0。
3. 访客伪造 `X-Forwarded-For`/自定义头：测试代理覆盖后，应用只使用代理标记的地址；甲被限速不影响乙。
4. 候选 `/api/bootstrap` 仍为 `demo:false`、空门店和 `bookingEnabled:false`；预约、报价、签署、支付、换装写入继续 409。
5. 直连候选 HTTPS 与本地演示 HTTP 原回归均通过，且仍仅绑定回环地址。
