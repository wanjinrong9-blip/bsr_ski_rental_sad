# Render 免费网页部署填写指南

2026-11-27。邮件验证后进入 Render Dashboard，截图中的入口选择 **Web Services → New Web Service**。本系统含登录、订单和库存后端，需要 Web Service；Static Sites 只能托管静态页面，Private Services 不提供老师可直接打开的公网入口。本项目使用已有 SQLite，不另建 Postgres、Cron Job 或付费资源。

## 填写顺序

1. 点击 **New Web Service**。
2. 代码来源选择 **Public Git Repository**（公开仓库 URL）；粘贴 `https://github.com/wanjinrong9-blip/bsr_ski_rental_sad.git`。公开 URL 手动部署无需再为仓库安装额外的 GitHub App。若选择已连接的 GitHub 仓库，也应核对仓库名和 `main` 分支。
3. 按下表设置。页面字段位置可能随平台更新变化。

| 字段 | 内容 |
| --- | --- |
| Name | `bsr-temporary-preview`（如重名，可加本人姓名缩写） |
| Language / Runtime | **Docker** |
| Branch | `main` |
| Region | Singapore（新加坡，可用时选择） |
| Root Directory | 留空，仓库根目录 |
| Dockerfile Path | `deploy/render/Dockerfile` |
| Docker Build Context | `.`（若页面提供此项） |
| Docker Command | 留空，使用镜像中的 CMD |
| Instance Type | **Free / $0** |
| Health Check Path（Advanced） | `/api/health` |
| Auto Deploy | Off；公开 URL 来源按平台规则手动部署 |

4. 添加三个环境变量：`BSR_TEMPORARY_PREVIEW=1`、`BSR_RUN_MODE=showcase`、`BSR_PREVIEW_SEED=<本实例专用的32字节随机十六进制种子>`。第三项是私有配置，**不能填示例文本、公开演示密码，也不要发到 GitHub、截图或聊天中**；由本机安全生成并留存教师演示账号交接资料后填写。Render 自动提供 `PORT` 与 `RENDER_EXTERNAL_URL`，不把应用的回环端口 4175 填成外网端口。
5. 核对为免费实例且没有付费磁盘，然后执行 Deploy。若平台要求支付信息或出现收费金额，停在页面核对，不更换收费套餐。
6. 等待构建和健康检查成功，打开实际生成的 `https://<站点名>.onrender.com`。只有实际能打开、六角色登录和模拟预约验收后，才把它交给老师，并回填项目 README。

当前真实网址尚未取得；不要把上面的占位地址发给老师。控制台显示运行成功也须再从老师实际网络验证。免费服务空闲 15 分钟休眠，唤醒约一分钟，本地演示记录会在休眠/重启等情况下丢失；详情与后续 bsrski.cn 替换计划见 [状态说明](临时公网演示与小程序状态.md)。

本项目所有者的电脑已生成 `.preview-private/render.env`（三个待填环境变量）和 `.preview-private/teacher-access.txt`（对应的六角色演示账号）。它们被 Git 忽略，不在仓库、PDF或聊天正文公开。项目所有者可从本机读取并把三个值分别填入 Render 的 Environment Variables；教师账号只私下交接。代码公开仓库的克隆者应自行生成专用随机种子，不能复用项目所有者的文件。

官方依据：[Docker 部署](https://render.com/docs/docker)、[免费实例](https://render.com/docs/free)、[公开仓库与手动部署](https://render.com/docs/deploys)。
