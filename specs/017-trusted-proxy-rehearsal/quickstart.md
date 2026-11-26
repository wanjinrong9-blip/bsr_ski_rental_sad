# 017 本机验收指南

**当前状态**：2026-11-18 本机代理、来源限速隔离、重启恢复和浏览器演练通过。所有破坏性测试均使用独立的临时候选资料空间，不向公网监听；阿里云实际环境尚未验收。

## 运行前核对

1. 在 `bsr-app` 执行 `node tools/backup-verify.mjs --source data/bsr.sqlite --output data/backups`，保存完整性、外键和隔离恢复结果；备份仍在被忽略的私有目录。
2. 记录直接候选 HTTPS 与本地演示 HTTP 的现有测试基线。017 修改配置和服务入口，不能只运行新增专项。
3. 017 所需域名、证书和代理密钥均用临时测试值；未购买阿里云产品前不填写真实域名或开放安全组。

## 单独验证

| 标准 | 本机检查 | 通过证据 |
| --- | --- | --- |
| SC-001 | 代理/直连/演示正确配置各一例；错误模式、外网 HOST、弱密钥、错误 HTTPS 来源、私有路径等至少 12 例 | 无效配置非零退出且没有新候选数据库或公网监听 |
| SC-002 | 本机 HTTPS 测试代理下登录/注销；直连绕过、缺/错/重复头、Host/协议/IP/URL/Origin 伪造至少 20 例 | 合法账号功能正常，恶意请求 403，受保护内容/业务资料无副作用 |
| SC-003 | 两个客户地址分别尝试登录，甲触发限速，乙正常登录；检查 Cookie 属性 | 甲被限制、乙未被合并限制；Cookie 为 Secure/HttpOnly/SameSite=Strict |
| SC-004 | 隔离候选库重启、在线备份、离线恢复、旧会话撤销 | `integrity=ok`、外键 0、隔离恢复 PASS；原 demo 库不变 |
| SC-005 | `node --test test/*.test.mjs`、候选与演示浏览器冒烟、监听地址与产物清单 | 完整回归通过；只有本机回环监听；云服务与 GitHub 上传均未发生 |

专项命令：`node --test test/017-trusted-proxy.test.mjs`。候选本机代理浏览器命令：`node test/017-proxy-browser.mjs`。浏览器断言与请求级伪造测试分别保留。

## 2026-11-18 本机验收记录

- 实现前 017 专项 **0/2**，接入后扩展为 **3/3 通过**（`test-results/017-restore-progress.log`）；17 类无效配置、29 类伪造或直连请求均拒绝。未经代理的健康检查和静态资源均返回 403；正确本机 HTTPS 代理可登录、读取本人资料、退出。候选目录仍为空且预约关闭。
- 两个不同代理清洗后的客户 IP 分别写入来源限速桶，访客伪造的 `X-Forwarded-For` 和同名自定义头没有进入来源键。甲以五次失败登录触发自身来源阻断后，正确凭据返回 429；乙使用另一个代理客户地址仍可登录。登录 Cookie 为 `Secure`、`HttpOnly`、`SameSite=Strict`，写入 Origin 精确核对；SC-003 的本机行为已验证。
- 临时候选库经代理模式启动、停止、应用一致性备份、向新私有文件恢复并重启。旧会话被撤销、新登录可用，候选预约仍关闭；专项 3/3 中的第三项为此验证。对运行中的本地演示库另执行备份：完整性 `ok`、外键错误 0、隔离恢复 `PASS`，私有备份位于被忽略的 `data/backups/`；没有用运行库做破坏性测试。
- 完整 `node --test test/*.test.mjs` **130/130 通过**（`test-results/017-full-final.log`）。`node test/preview-smoke.mjs` 演示浏览器通过（`test-results/017-demo-browser.log`）。`node test/candidate-browser-smoke.mjs` 的首次并行运行已完成断言，但 Windows 临时目录清理遇 EPERM；改进测试夹具的临时根检查与清理重试后，单独重跑通过（`test-results/017-candidate-browser-final.log`）。`node test/017-proxy-browser.mjs` 经外观域名映射、真实浏览器和本机 HTTPS 代理通过登录退出、安全 Cookie、390px 布局与预约阻断（`test-results/017-proxy-browser-final.log`）；截图 `test-results/017-proxy-candidate-mobile.png` 未见重叠。
- 本机 017 配置保持应用 `HOST` 回环；阿里云 Nginx/systemd 模板仅静态检查，当前 Windows 没有对应服务，无法证明其原生语法或真实 ECS 网络行为。没有 Git 初始化、上传、云实例、真实域名或公网访问。目标教师可操作的安全合成数据全功能预览属于后续 018。

## 准备材料复核

检查 `deploy/aliyun/` 中的 Nginx 样例是否只转发到回环地址、是否用占位符而非真实密钥、是否列明持久数据盘自动挂载、备份恢复和安全组规则。阿里云账号/实例/地域/域名/ICP备案/证书未落实时，结论只能写为“模板已准备、本机演练通过”，不得写成“阿里云部署完成”。将来若选择中国内地 ECS，应按当时官方要求办理备案后再启用网站域名。

2026-11-18 模板静态检查：`nginx-candidate.conf.template` 只有 443 监听和 `127.0.0.1:4174` 后端，覆盖 Host、HTTPS 协议及客户 IP，并从私有 include 读取代理密钥；`candidate.env.template` 与 `proxy-secret.conf.template` 仍是不能通过正式配置校验的占位符；systemd 模板在启动前检查 `/srv/bsr` 挂载和候选库可读。当前 Windows 环境没有 Nginx 或 systemd，**尚未运行其原生语法检查，也未在 ECS 启用模板**。实际服务器上仍需先执行 `nginx -t`、服务配置检查、域名证书验证和恢复演练。

## 保留边界

017 的候选目录为空且预约关闭，不能当成老师可操作全部租赁流程的成品。下一独立工作包应为安全的合成数据全功能预览；不得直接公开 `demo` 模式及其 `Demo123!`。现有支付/退款/补差和签署仍为课程演示，不因代理接入变成真实交易。
