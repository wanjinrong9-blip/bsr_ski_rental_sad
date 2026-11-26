# T017：私有获取正式首页小程序码

2026-11-26 实现 `createWechatMiniCodeAdapter` 与 `tools/fetch-mini-code.mjs`。仅供私有服务器准备，不挂入公开 HTTP 路由或小程序客户端。当前无正式 AppSecret，未执行真实取码。

## 固定协议

1. POST `https://api.weixin.qq.com/cgi-bin/stable_token`，JSON 为 `grant_type=client_credential`、私有 `appid/secret`，不强制刷新已有平台令牌。
2. POST `https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=...`，JSON 固定 `page=pages/catalog/index`、`scene=home`、`check_path=true`、`env_version=release`、`width=430`。不接受个人场景、任意页面、跳过发布路径检查或替代 API 主机。
3. 禁止跟随重定向；操作限时 5 秒，token JSON 不超过 16 KiB，图片不超过 2 MiB。失败不自动重试或回退。平台 JSON 错误、过大响应和损坏图片统一失败，不返回原始响应、请求 URL、token 或 AppSecret。
4. 入口现有格式只接受完整 PNG；官方接口文档未保证响应格式，因此 JPEG 等格式明确失败，不自动转码或替换为示意图片。

## 运行方式（条件具备后）

在私有服务环境配置以下变量，私钥不要作为命令参数或写入 Git：

| 变量 | 要求 |
| --- | --- |
| `BSR_RUN_MODE` | `showcase` |
| `BSR_WECHAT_APP_ID`、`BSR_MINI_APP_ID` | 两项为同一正式 AppID |
| `BSR_WECHAT_APP_SECRET` | 平台私有服务端凭据 |
| `BSR_MINI_CODE_FETCH_CONFIRMED` | 操作员在已核对取码资格后明确设置 `1` |
| `BSR_MINI_CODE_OUTPUT_DIR` | 仓库外、已有私有父目录下的全新绝对目录；不允许覆盖或链接回仓库 |

在应用目录执行 `node tools/fetch-mini-code.mjs`。成功后目录含 `code.png` 和 `issuance.json`。后者记录 AppID、首页、场景、release 环境、固定端点、获取时刻和 SHA-256；不含平台私钥、访问令牌、用户或订单资料。POSIX 新目录 0700、文件 0600；Windows ACL 仍需操作员核验。

工具不生成公开供图批准凭据、不更改 READY 或任何数据库。现有 `attest-mini-entry.mjs`、发布开关与 10 次真实手机扫码仍独立验收。获取记录是本地操作记录，不能单独作为微信的独立签名证明；单元测试使用的 Logo 图片不是微信码。

官方依据：[稳定接口凭据](https://developers.weixin.qq.com/miniprogram/dev/server/API/mp-access-token/api_getstableaccesstoken.html)、[不限制的小程序码](https://developers.weixin.qq.com/miniprogram/dev/server/API/qrcode-link/qr-code/api_getunlimitedqrcode.html)。本日已重新读取官方 Markdown 文档核对端点和参数。
