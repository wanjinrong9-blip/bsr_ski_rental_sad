# Implementation Plan: 受控 HTTPS 入口的本机演练

**Date**: 2026-11-18  
**Spec**: [spec.md](spec.md)  
**Scope**: 阿里云 ECS 购买前的本机安全入口与恢复演练；不创建云资源、不上传或开放公网。

## Summary

给既有候选模式增加显式 `trusted-local-proxy` 传输；默认 `direct-tls` 不变。应用仍只绑定回环地址，未来 Nginx 在同机终止外部 HTTPS。候选服务在打开数据库前验证外部来源、代理密钥与私有路径；每个请求在路由和静态文件之前核对唯一 Host、代理密钥、转发协议和清洗后的客户 IP。浏览器端仍使用原有 Secure/HttpOnly/SameSite 会话及精确 Origin 检查。课程演示模式维持回环且不得切换该入口。采用临时库、临时本机 HTTPS 测试代理验证成功和攻击路径，另交付不含密钥的阿里云 ECS/Nginx 配置样例与数据盘/备份核对表。

## Technical Context

- **Language/Version**: Node.js 24，原生 `http`/`https`/`net`/`crypto`/SQLite，无新增运行依赖。
- **Primary Dependencies**: 现有 `src/runtime-config.mjs`、`src/startup-config.mjs`、`src/server.mjs`、`src/identity.mjs` 与候选初始化/恢复命令。
- **Storage**: 仍为单实例 SQLite WAL；不新增业务表。配置密钥仅来自私有运行环境，客户 IP 只写入现有哈希限速桶，不明文入业务记录。
- **Testing**: Node 自带测试运行器；隔离候选库和本机 HTTPS 测试代理，现有候选安全、浏览器与演示全套回归。
- **Target Platform**: 本机演练；将来拟用单台 Linux ECS + 同机 Nginx + 私有持久数据盘。地域、域名及证书未知，不生成可直接公网启用的配置。
- **Performance Goals**: 代理内单请求校验仅做固定长度比较及地址解析；不在业务请求调用外部服务。
- **Constraints**: Node 仅监听 `127.0.0.1`/`::1`/`localhost`；不接受原始访客 `X-Forwarded-For`；不导入现有 `data/bsr.sqlite`；候选交易继续关闭。
- **Scale/Scope**: 单实例、一个预期 HTTPS 来源、一组受控代理密钥；多实例、CDN 和真实流量容量另行验收。

## Constitution Check

| 原则 | 本包设计和证据 |
| --- | --- |
| I 业务价值与可追溯 | 系统管理员/授权账号/部署操作者的三类需求 → 017 FR/SC → 入口配置、请求校验、演练与文档。用户已排除云端预览写入核心业务设计需求 PDF，本包仅记独立部署资料。 |
| II 合同、金额与政策真实性 | 候选目录和交易门槛不放开；不导入演示价目、合同或订单，也不声称真实支付。 |
| III 单件库存 | 017 不改库存模型；候选仍不允许预约和换装，原 016/库存测试回归。 |
| IV 最小权限与隐私 | 代理密钥不入仓库/公开目录；先校验入口再读用户/静态资源；仍用候选账号对象权限、HttpOnly/Secure Cookie 和会话撤销。 |
| V 可验证与恢复 | 先留旧直连和演示基线，新增错误配置与伪造请求红灯；临时库完成备份恢复及重启；完整回归与隔离浏览器。 |

**Gate**: 这是候选安全入口的本机技术能力，不能推定阿里云实际网络和证书已验收。018 须另建安全合成数据全功能预览，不能通过改变 `bookingEnabled` 或暴露 `Demo123!` 绕过。

## Project Structure

```text
src/startup-config.mjs             # 继续强制应用回环监听
src/runtime-config.mjs             # 候选传输、外部来源、私有密钥的只读预检
src/proxy-boundary.mjs             # 单请求的可信代理、Host、IP 与协议校验
src/identity.mjs                   # 经核验客户 IP 的来源限速；直连保持旧取值
src/server.mjs                     # 路由前校验及候选内部 HTTP/直连 HTTPS 选择
test/017-trusted-proxy.test.mjs    # 负面配置、可信代理、备份恢复与不触碰演示数据
test/017-proxy-browser.mjs         # 隔离 Chrome 验证本机 HTTPS 代理与 390px 页面
deploy/aliyun/                     # 不含秘密的 ECS/Nginx 配置模板与核对清单
docs/云端预览准备.md               # 阿里云前置条件与 016/017 状态
specs/017-trusted-proxy-rehearsal/ # 本包文档与验收记录
```

现有 `public/` 和业务表不修改；现有候选直连浏览器测试继续有效。测试夹具按职责合并为一个专项文件，另有独立浏览器脚本。

## Implementation Order

1. 用 011 工具备份现有本地演示库并验证完整性；记录 016 的完整测试/候选直连基线。配置预检与故障注入只用临时路径。
2. 为错误传输、弱/缺代理密钥、错误外部来源、外网绑定、演示模式误启代理及数据库指向公开目录写启动红灯；要求验证在打开数据库前拒绝。
3. 在 `runtime-config` 增加 `BSR_CANDIDATE_TRANSPORT=direct-tls|trusted-local-proxy`，默认前者。代理模式要求 `BSR_PUBLIC_ORIGIN` 是唯一 HTTPS origin、`BSR_PROXY_SECRET` 是非占位高熵值、私有备份和候选数据库路径有效；不读本地 TLS 证书。密钥绝不输出到错误、健康检查或日志。
4. 在独立 `proxy-boundary` 模块用固定时序比较密钥；要求唯一 Host、`X-Forwarded-Proto=https`、唯一且合法的 `X-BSR-Client-IP`，并拒绝 absolute-form URL 与恶意重复头。仅在校验成功后设置请求内的可信客户地址；`identity` 用它而不读原始 `X-Forwarded-For`。
5. `server` 在所有 API、静态与健康检查前调用代理边界；代理候选内部用 HTTP、直连候选继续用 HTTPS、演示仍为回环 HTTP。保留候选 Cookie、Origin、登录、限速和交易阻断。
6. 用本机 HTTPS 测试代理模拟 Nginx：覆盖访客提交的敏感代理头，再转发到仅本机候选端口。验证两个客户端的独立限速、正确登录/退出、密钥和头伪造零业务副作用、长连接及候选预约关闭。浏览器如可用则核 390px 与安全 Cookie。
7. 编写阿里云 ECS/Nginx **模板**与持久数据盘、私有备份、恢复、安全组/证书/域名的待执行核对表；不把占位密钥渲染成可运行生产配置。用隔离候选库完成重启和现有恢复命令回归，更新 README 与独立云端准备文档。
8. 跑 017 专项、原有完整 Node/浏览器回归；逐条记录 SC-001～SC-005 的本机证据、尚需购买后执行的项目和 018 全功能预览缺口。

## Rollback and Data Safety

- 配置的默认值是原有直连 HTTPS；不设置新传输变量即可停用代理适配。不得把原运行服务改成公网监听作为回退。
- 017 无业务表迁移；候选 `sessions` 与现有审计结构继续使用。若入口校验失败，停止代理路径，不复制或改写数据文件。
- SQLite 业务文件与独立备份都应在 ECS 私有持久数据盘，Nginx 只能转发到回环端口。云盘快照不能代替 SQLite 应用一致性备份与隔离恢复。
- 真实阿里云安全组、域名/证书、ICP备案及演示资料入口必须在购买和单独验收后配置；本包不得自动开通。
