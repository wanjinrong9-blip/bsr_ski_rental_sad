# Railway 临时课程演示

2026-11-27：用户要求停用 Render。现有 Docker 镜像已适配 Railway，仍保持 Node 回环监听、可信本机代理及独立 SHOWCASE 合成数据；`deploy/render/` 文件名为兼容旧模板保留，不表示继续使用 Render 平台。

## 状态与免费范围

已完成域名/端口适配与专项 11/11 验证；尚未创建 Railway 实例或取得公网网址，真实构建与教师访问未验收。GitHub 登录授权正在等待项目所有者确认。

[Railway 官方价格](https://railway.com/pricing)提供免绑卡 Free 方案；新账号有首 30 天一次性 5 美元试用额度，之后 Free 方案每月有 1 美元使用额度。额度消耗取决于资源与流量，不能保证固定运行天数；试用结束或耗尽会停止服务，需要切换 Free 并重新部署或由用户另行决定。账号可能受自动验证限制，不能预先保证部署成功。此次只用免费额度，不绑定银行卡、不订阅 Hobby/Pro。

## 最小配置

源码：`wanjinrong9-blip/bsr_ski_rental_sad` 的 `main` 分支。仓库根目录 `railway.json` 指定 Dockerfile 和 `/api/health`。Dockerfile 的构建上下文仍为仓库根目录，不上传本地数据库和秘密。

运行变量：

| 变量 | 值 |
| --- | --- |
| `NODE_ENV` | `production` |
| `BSR_RUN_MODE` | `showcase` |
| `BSR_TEMPORARY_PREVIEW` | `1` |
| `BSR_PREVIEW_PROVIDER` | `railway` |
| `BSR_PREVIEW_SEED` | 私有 32 字节随机值的 64 位小写十六进制形式 |
| `PORT` | `10000`，公网域名目标端口也设为 `10000` |

在 Networking 生成平台 HTTPS 域名，使用自动注入的 `RAILWAY_PUBLIC_DOMAIN`；只接受 `*.up.railway.app`，不要填入含路径的地址。应用自动设为 `127.0.0.1:4175`，平台端口由 Nginx 监听；不要改为公开监听应用端口。禁止把随机种子放在 GitHub、镜像或公开说明里。

使用独立虚构账号、门店和装备。模拟支付不扣款，NOK 规则不变。本方案不挂载持久卷，重新部署或平台回收可能重置订单、照片、会话和账号改动；页面已有临时演示提示，请勿输入真实资料。网页入口上线不会自动完成微信合法域名、微信登录、审核或发布。

网站 ICP 通过后按既有安排切换至已购阿里云与 bsrski.cn，临时合成记录不当作真实业务资料迁入。
