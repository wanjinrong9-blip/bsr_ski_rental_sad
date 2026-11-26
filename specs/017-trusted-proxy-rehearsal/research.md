# 017 技术研究与决策

日期：2026-11-18。范围仅为本机演练和阿里云购买前的准备。资料中的阿里云条款以部署当日官方文档重新核对。

## 决策 1：同机代理终止 HTTPS，Node 继续回环监听

现有 `validatePreviewConfig` 已防止 Node 监听 `0.0.0.0`，应保留。候选传输显式分为默认 `direct-tls` 与新增 `trusted-local-proxy`。后者由将来的同机 Nginx 接受外部 HTTPS 并转发到回环 Node HTTP；不能把运行模式改成 demo 或靠外网绑定绕过安全闸门。部署平台暂按单台 Linux ECS 研究，不绑定用户尚未购买的实例/地域。

阿里云官方分别提供 [ECS 安全组规则](https://help.aliyun.com/zh/ecs/user-guide/security-groups-for-different-use-cases) 和 [Nginx 证书配置](https://help.aliyun.com/zh/ssl-certificate/install-ssl-certificates-on-nginx-servers-or-tengine-servers)。安全组未来只开放必要 Web 端口，应用端口不得公网开放。

## 决策 2：每请求代理凭据与精确主机检查

单纯看 `X-Forwarded-Proto` 或 `X-Forwarded-For` 无法证明请求经过受控代理；它们可由客户端提交。代理模式要求私有环境中的随机代理密钥，代理覆盖访客同名头后逐请求注入。Node 在所有路由前核对唯一 Host 与外部 HTTPS 来源、单值协议和密钥。密钥比较采用固定时序；密钥值不进入应用日志/审计正文/健康检查。即便本机其他进程直连回环端口，也不应在无密钥时获得候选资料。

备选“仅信任 `127.0.0.1` 的连接”未采用：同机直连仍可伪造请求来源；仅依赖代理配置无法单独证明应用侧边界。

## 决策 3：限速使用已核验的单值客户地址

当前候选来源限速键基于 `req.socket.remoteAddress`；代理后所有访客会合并为同一代理地址。代理先丢弃访客的 `X-BSR-Client-IP`/转发头，再用连接的实际来源生成单值 `X-BSR-Client-IP`。应用只在代理认证后接受该值，并使用 `net.isIP` 拒绝逗号链、空值及非法地址。直连 HTTPS 保持原 socket 来源。限速表仍只存安装实例+来源的哈希，不增加明文 IP 表。

备选“直接相信 `X-Forwarded-For` 第一项”未采用：未受信任的客户端可任意更换首项绕开限速。

## 决策 4：配置和资料 fail closed

`BSR_CANDIDATE_TRANSPORT` 仅在 `BSR_RUN_MODE=candidate` 有效。代理模式须有 HTTPS origin、足够强的随机密钥、独立候选数据库和私有备份目录；不需要本地 TLS 证书。所有配置验证必须在 `preflightRuntime` 和 `openDb` 之前。缺文件或错误时不得创建候选库。候选 `bookingEnabled:false` 及其交易 POST 阻断完全保留；演示种子账号和已知密码不能用作外网预览。

阿里云 [数据盘初始化与自动挂载说明](https://help.aliyun.com/zh/ecs/user-guide/initialize-a-data-disk-whose-size-does-not-exceed-2-tib-on-a-linux-instance)要求部署时明确持久挂载；[云盘快照说明](https://help.aliyun.com/zh/ecs/user-guide/snapshot-overview/)不等于应用一致性 SQLite 备份，继续运行现有备份/隔离恢复命令。

## 决策 5：先不做实际云端与全功能教师预览

未来中国内地地域的网站域名可能需先完成 ICP 备案；非中国内地地域的条件不同，地域未选时不替用户决定。[阿里云备案说明](https://help.aliyun.com/zh/icp-filing/basic-icp-service/product-overview/faq-about-icp-filing-applications-in-different-scenarios)

本包只准备模板和演练，用户购买后再填域名、证书、IP 与安全组。候选模式的空目录和关闭预约不能展示完整租赁系统；把 demo 模式直接对外开放会暴露已知账号与密码。后续 018 须单独定义受控账号、合成目录/订单及全部业务界面可用的安全预览，不得在 017 偷开候选交易。
