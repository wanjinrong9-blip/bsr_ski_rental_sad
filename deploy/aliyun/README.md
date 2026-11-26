# 阿里云轻量应用服务器部署材料（未启用）

更新：2026-11-25。已核验用户购买的阿里云轻量应用服务器：**广州、Ubuntu 24.04、2 vCPU / 2 GiB、40 GiB 系统盘、无独立数据盘**。域名为 `bsrski.cn`；网站 ICP 订单此前曾退回，用户现告知域名仍在审核，本轮未重新核对控制台，因此不以此安排上线。小程序备案号由用户提供，为湘ICP备2026056763号-1X；正式 AppID `wx51ce51fc873371a6` 已在开发者工具项目详情核对，微信平台业务仍未验收。本项目没有部署到服务器。实例此前核验的 Web 防火墙 80/443 规则已禁用，SSH 22 仍沿用云平台原有放行规则，尚未限制管理来源。不要将本地演示账号、数据库或服务直接暴露到公网。

这里有 **017 空候选环境**与 **018/019 独立合成全功能环境**的未启用模板，目标为同机 Nginx 和只监听回环地址的 Node 服务。原 systemd 模板要求 `/srv/bsr` 是已挂载的数据盘，**不能在已购系统盘实例上直接启用**。另备系统盘 SHOWCASE 模板，改用 `/var/lib/bsr`，但必须先在目标 Ubuntu 完成异机备份与隔离恢复验证，且经容量验收；本模板不是上线许可。`__...__` 均为故意保留的占位符；仓库无证书、代理密钥或可用公网入口，也没有执行上传。

## 已购实例与原选型建议

| 项目 | 建议 | 依据与边界 |
| --- | --- | --- |
| 镜像 | 切到**系统镜像**，选 Ubuntu 24.04 64 位；若所选地域没有，则选 Ubuntu 22.04 64 位 | 截图中的 DeepSeek Harness 是应用镜像，不适合现有 Node、Nginx、systemd 模板；购买页实际可选版本为准。[系统镜像说明](https://help.aliyun.com/zh/simple-application-server/product-overview/images) |
| 套餐 | 先选通用型 **2 vCPU / 4 GiB / 50 GiB 系统盘**；预算紧时可选 **2 vCPU / 2 GiB / 40 GiB** | 两档均是官方列出的通用型规格；前者为六角色演示、Node 与 Nginx 同机留出余量，后者须另做容量验证。价格、带宽和库存以购买页实时显示为准。[实例规格](https://help.aliyun.com/zh/simple-application-server/product-overview/instance-families/) |
| 地域 | 面向中国内地老师优先核对北京等内地地域，连同 ICP 备案时间一起安排；急需无内地备案预览可评估中国香港 | 内地网站域名上线需备案；香港不走工信部 ICP，但内地访问延迟可能较高。地域确定后再定域名解析和证书。[轻量备案说明](https://help.aliyun.com/zh/simple-application-server/user-guide/apply-for-an-icp-filing-for-a-domain-name) |
| 购买时长 | 北京等内地地域如要申请轻量服务器备案服务码，累计购买时长须达到 **3 个月** | 可通过续费累计；不要把短期购买误当作已具备备案资格。[轻量备案说明](https://help.aliyun.com/zh/simple-application-server/user-guide/apply-for-an-icp-filing-for-a-domain-name) |
| 数据盘 | 建议按预算加购**一块**数据盘存放 `/srv/bsr`，容量按预览数据、备份和照片估算 | 轻量应用服务器最多附加一块数据盘；需初始化、挂载并设置开机自动挂载。若暂不购买，不能沿用下面的挂载检查模板。[数据盘指南](https://help.aliyun.com/zh/simple-application-server/user-guide/attach-a-data-disk) |

上表保留原购买阶段的选型依据，**不是对已购实例的待办购买指令**。目前实例为 2/2/40、广州、Ubuntu 24.04、单系统盘。2 GiB 内存和 40 GiB 空间是否足够六角色并发、照片及备份，仍须在目标机测量，不预设达标。

## 已准备的模板

| 文件 | 将来放置位置 | 作用 |
| --- | --- | --- |
| `candidate.env.template` | `/etc/bsr/candidate.env`，权限 0600 | Node 候选用途、回环端口、外部 HTTPS 来源、私有数据路径、代理密钥 |
| `nginx-candidate.conf.template` | Nginx 站点配置，由管理员审阅并启用 | 仅 443 HTTPS → `127.0.0.1:4174`；覆盖 Host、协议与客户地址 |
| `proxy-secret.conf.template` | `/etc/bsr/proxy-secret.conf`，权限 0600 | Nginx 向应用写入同一个私有代理密钥 |
| `bsr-candidate.service.template` | systemd 服务配置，由管理员审阅并启用 | 以低权限用户运行；数据盘未挂载或候选库不存在时不启动 |
| `showcase.env.template`、`bsr-showcase.service.template` | 私有环境文件与 systemd 服务配置 | 独立合成库、回环 4175；数据盘、库或备份目录缺失时拒绝启动；微信登录和扫码入口默认关闭 |
| `showcase-system-disk.env.template`、`bsr-showcase-system-disk.service.template` | 已购单系统盘实例的**替代**私有环境与 systemd 服务模板 | 使用 `/var/lib/bsr`，仍为回环 4175、合成库、微信与扫码 OFF；不要求 `/srv/bsr` 挂载，但必须先完成**异机备份、隔离恢复和容量验证**，不能与数据盘版同时启用 |
| `nginx-showcase.conf.template`、`proxy-secret-showcase.conf.template` | 私有 Nginx 配置及专用代理密钥 | 独立子域名与代理密钥；只把 443 的请求转给回环 4175，清洗访客可伪造的代理头 |

这些文件 **不能直接启用**。在服务器上用密码学随机源执行 `openssl rand -hex 32`，将生成的 64 位十六进制值分别写入两个私有配置；不得将结果发到聊天、提交到 Git、写入截图、终端录屏或公开日志。Nginx 配置必须覆盖访客传来的 `X-BSR-Proxy-Secret`、`X-BSR-Client-IP`、`X-Forwarded-Proto`，并清除 `X-Forwarded-For`。本模板仅假定轻量服务器直接收到访客连接；以后若加负载均衡或 CDN，`$remote_addr` 将不再自动代表访客，须重新设计可信链并重测来源限速。Nginx 与 systemd 模板的语法、路径和权限仍待在实际 Ubuntu 服务器上验证，包括 `nginx -t`，本机 Windows 测试不能替代。

## 已购实例的下一步核验顺序

### 离线生成与校验系统盘配置（020）

新增 `tools/render-showcase-system-disk.mjs`，无第三方依赖、网络调用或数据库操作。它从已审阅模板生成同一组 env、代理密钥 include 和 Nginx 配置；一个随机密钥同时写入前两份文件，避免手工填写不一致。仅允许 `bsrski.cn` 及其合法小写子域名；这只是范围检查，不证明备案、证书或域名解析已完成。

在当前项目目录，用已有的仓库外私有父目录执行以下命令；示例目标目录必须尚不存在：

```sh
node tools/render-showcase-system-disk.mjs render --domain bsrski.cn --output-dir /var/lib/bsr-private/config-20261126
node tools/render-showcase-system-disk.mjs check --domain bsrski.cn --output-dir /var/lib/bsr-private/config-20261126
```

命令不输出密钥，不覆盖目录，不启用服务，也不修改 DNS 或防火墙。输出是 `showcase-system-disk.env`、`proxy-secret-showcase.conf`、`nginx-showcase.conf` 三个私有文件；Linux/macOS 检查目录 0700 和文件 0600，Windows ACL 由操作员另行核验。新组使用独立随机密钥，不与候选实例共用。`check` 比对当前源码版本模板，拒绝文件缺失、多余文件、链接、残留占位符以及域名、密钥、监听和数据库路径的变更；应用模板升级后应重新生成并验收。

这些含密钥的输出禁止提交 Git。目标 Ubuntu 上仍须核验权限、证书、`nginx -t`、systemd 配置、合成库、容量及异机恢复；本机检查不代替实际部署验收。[020 范围与证据](../../specs/020-system-disk-deploy-config/quickstart.md)。

1. 核对 `bsrski.cn` 的网站 ICP 最新状态：此前控制台曾显示因“网站主办者冲突”退回，用户现告知域名仍在审核，本轮没有重新打开控制台确认。以阿里云和管局当前结果为准；小程序备案号已由用户提供，不能代替网站域名的备案。[轻量备案说明](https://help.aliyun.com/zh/simple-application-server/user-guide/apply-for-an-icp-filing-for-a-domain-name)
2. 核验单系统盘的实际可用空间、内存与部署运行开销。选择 `/var/lib/bsr` 系统盘方案时，先配置**异机**备份目的地、执行 SQLite 一致性备份并在独立位置恢复验收；同盘 `backups/` 只作临时副本，不能单独防止整盘故障。若后续购置并挂载数据盘，才改用 `/srv/bsr` 版本。[轻量数据盘指南](https://help.aliyun.com/zh/simple-application-server/user-guide/attach-a-data-disk)
3. 在目标 Ubuntu 上创建低权限服务用户、私有目录与独立**合成**数据库；填充系统盘环境文件，但保持 systemd 服务禁用。验证 Node 版本、systemd 沙箱、文件权限、单实例写入、备份/恢复及 2 GiB 资源余量。不得复制本机 `data/bsr.sqlite` 或演示凭据。
4. 备案、域名与证书条件具备后，在私有路径配置有效证书并运行 `nginx -t`；测试受信代理与伪造头拒绝。正式开放前，80/443 继续禁用；22 端口目前尚未收紧，应先确认可靠的管理来源，再限制 SSH，不要直接关闭导致失去访问。[阿里云 Nginx 证书指南](https://help.aliyun.com/zh/ssl-certificate/install-ssl-certificates-on-nginx-servers-or-tengine-servers) [轻量防火墙指南](https://help.aliyun.com/zh/simple-application-server/user-guide/manage-the-firewall-of-a-server)
5. 待用户验收与明确发布决定，再考虑启用 Web 入口。微信正式 AppID 已在本机配置；合法 HTTPS 请求域名、私有平台凭据、平台签发码与真机验收另设闸门；真实支付/退款/签署也须业务方与服务方确认。轻量服务器快照只作第二层恢复手段。[轻量快照指南](https://help.aliyun.com/zh/simple-application-server/user-guide/manage-snapshots)

## 业务边界

017 候选库没有演示商品、门店、订单或公开演示账号，且 `bookingEnabled=false`，只证明安全入口和候选身份。018/019 的独立 SHOWCASE 已在本机以六个受管理角色和虚构数据验证完整租赁流程；云端模板只是将该模式所需路径、端口、代理和默认关闭的小程序入口写明，**尚未在 Ubuntu、云端或正式微信平台运行**。部署前须在目标机创建新合成库、线下交付独立账号、验证异机备份恢复、域名/证书/代理配置及 `nginx -t`，并获得用户发布决定。不得把本地 `demo` 模式、`Demo123!` 演示密码、`data/bsr.sqlite`、备份和受损照片上传。

本机代理契约和测试范围见 [017 接口契约](../../specs/017-trusted-proxy-rehearsal/contracts/proxy-boundary.md) 与 [验收指南](../../specs/017-trusted-proxy-rehearsal/quickstart.md)。
