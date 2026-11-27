# Railway 临时课程演示

2026-11-27 已上线：[BSR 网页登录](https://bsr-temporary-preview-production.up.railway.app/#/login)。项目 humorous-endurance，服务 bsr-temporary-preview，区域 US East。Render 已按用户要求停用；deploy/render/ 路径为兼容原镜像模板保留。

## 已验证与免费范围

- 云端 Docker 构建及 Nginx 配置检查通过；IPv4/IPv6 接入，健康检查 /api/health 返回 200。
- 六角色登录、本人身份、各自工作台接口与退出均返回 200；匿名 /api/me 返回 401；会话 Cookie 为 Secure、HttpOnly。
- 实时更新接口返回 text/event-stream 并收到 connected 事件。浏览器检查顾客登录、日期库存和小程序筹备提示，无所查控制台错误。
- 本机专项测试 11/11；此前完整 Node 回归 244/244。云端尚未逐项重跑完整租赁与跨端业务验收，老师实际网络仍需试开。
- 账号保存在本机被 Git 忽略的 .preview-private/老师演示访问账号.txt，仅由项目所有者私下提供。种子、账号密码、原数据库均不上传 GitHub。

[官方价格](https://railway.com/pricing)与[Free 说明](https://docs.railway.com/pricing/free-plan)：新账号试用最多 30 天或一次性 5 美元额度，先到即止；后续 Free 每月 1 美元额度。当前未绑卡、未订阅 Hobby/Pro，不保证固定可用天数。试用停止后需按平台流程选择 Free 并检查/重新部署，网站备案通过后优先迁移阿里云。

## 实际部署配置

来源为 wanjinrong9-blip/bsr_ski_rental_sad 的 main 分支，Root Directory 为仓库根目录。控制台手工选择 Dockerfile builder；RAILWAY_DOCKERFILE_PATH=deploy/render/Dockerfile。控制台已提示新服务不能再启用旧 Config as Code，故 railway.json 只作历史配置参考，不能依靠它自动应用设置。

| 变量 | 值 |
| --- | --- |
| NODE_ENV | production |
| BSR_RUN_MODE | showcase |
| BSR_TEMPORARY_PREVIEW | 1 |
| BSR_PREVIEW_PROVIDER | railway |
| BSR_PREVIEW_SEED | 私有 32 字节随机值，64 位小写十六进制；不得公开 |
| PORT | 10000 |
| RAILWAY_DOCKERFILE_PATH | deploy/render/Dockerfile |

Networking 公网目标端口为 10000，来源由 RAILWAY_PUBLIC_DOMAIN 自动提供。应用始终只监听 127.0.0.1:4175，由 Nginx 覆写可信代理头。Nginx 以 node 用户运行，所有临时目录在 /runtime/nginx；平台探针 Host healthcheck.railway.app 仅允许 GET/HEAD /api/health，其他路径拒绝。健康检查超时 300 秒，失败最多重试 3 次。镜像构建时以非 root 用户运行 nginx -t。

独立 SHOWCASE 包含两家虚构门店、48 件虚构装备和 NOK 示例价格；资金及签署均为模拟。不挂载付费持久卷，重建或平台回收可能重置订单、会话、照片及账号改动。请勿输入真实资料。网页上线不会自动完成微信合法请求域名、真机登录、审核发布和扫码入口。

正式域名 bsrski.cn 的网站 ICP 通过后迁移至已购阿里云，临时合成记录不作为真实业务数据迁入。
