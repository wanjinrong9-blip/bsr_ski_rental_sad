# Research and decisions: 微信小程序与网页互联

**Date**: 2026-11-18  
**Status (2026-11-25)**: 用户已提供正式 AppID `wx51ce51fc873371a6`、小程序名称 `WJR同学的BSR系统分析设计作业` 和小程序备案号 `湘ICP备2026056763号-1X`；开发者工具已显示该 AppID。`bsrski.cn` 的域名 ICP 仍在审核，真实平台登录、合法 HTTPS 请求域名、真机与发布尚未验收。本文件不是微信审核或上线结果。

## Architecture decision

小程序前端由微信开发者工具开发并上传到微信平台；现有 Web 仍由同一业务服务提供。两端通过后端 API 共享用户、库存、购物车、订单和政策版本。网页扫描入口采用微信平台生成的小程序码，扫码打开小程序，而不是把小程序前端文件放进网页静态目录。若有网页版商品深链，短场景码只解析公开对象，不包含用户令牌。

选择原生小程序页面而非 `web-view` 包装网站：可分别验证微信扫码、登录和移动交互，同时保留网页完整六角色工作台。若将来使用 `web-view`，仍需单独检查业务域名和登录桥接，不视为本包的实现捷径。

## Platform facts to recheck at integration

| Topic | Current design implication | Primary reference |
| --- | --- | --- |
| 小程序登录 | `wx.login` 临时 `code` 送本站服务端；服务端调用 `code2Session` 并用 OpenID 建立本站受控会话；不把 AppSecret/`session_key` 给客户端。 | [微信登录机制](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/login.html)、[code2Session](https://developers.weixin.qq.com/miniprogram/dev/server/API/user-login/api_code2session.html) |
| 扫码入口 | 通过微信小程序码接口生成可扫码进入指定页面/场景的图片；平台凭据只在服务端。开发者工具预览码不用于正式网页。 | [小程序码](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/qr-code.html)、[获取小程序码接口](https://developers.weixin.qq.com/miniprogram/dev/server/API/qrcode-link/qr-code/api_getunlimitedqrcode.html) |
| 网络域名 | 正式小程序网络请求须使用在公众平台登记的 HTTPS 合法域名；官方网络文档同时要求域名完成 ICP 备案，不能用 `127.0.0.1` 或公网 IP。将服务器放在中国香港不会自动免去小程序的业务域名要求。开发工具允许的本机调试例外不能当作发布配置。 | [微信小程序网络能力](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html)、[腾讯微信支付开发指引的网络要求](https://pay.wechatpay.cn/doc/v3/partner/4012088031) |
| 平台发布 | 真实小程序可被扫码访问需要适用主体、类目、备案、审核和版本发布；小程序备案与网站/业务域名的 ICP 备案分别核对。 | [微信公众平台](https://mp.weixin.qq.com/)、[工信部移动应用备案通知](https://www.miit.gov.cn/zwgk/zcwj/wjfb/tz/art/2023/art_920db564162e4312916a01bed6540ad8.html)、[腾讯云备案 FAQ](https://cloud.tencent.com/document/product/243/97691) |
| 网页跳转方式 | 电脑网页展示小程序码是本包主要路径。微信内网页的开放标签及外部浏览器 URL Scheme/Link 条件不同，不纳入初版可用性承诺。 | [URL Scheme 文档](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/url-scheme.html) |

所有功能、调用频率、开放范围和审核条件应以接入当天微信公众平台控制台/官方文档为准。上表链接用于实施复核，不把未取得的平台注册资料当作已验证事实。

## Identity choice

- 微信 OpenID 仅在对应 AppID 下标识平台用户；不代表本站已有顾客，也不自动给予员工角色。初次使用先获平台身份，顾客再经本站原有认证证明账号控制权，之后才将两者关联。
- 绑定关系按 `(appid, openid)` 唯一，顾客同一时间最多绑定一个相应 AppID 的微信身份；换绑需重新验证并撤销旧会话。服务器在日志中使用不可逆摘要而非原始 OpenID。
- 小程序使用专门的 Bearer 会话头，短生命周期、仅存摘要、可撤销；Web 继续 `HttpOnly; Secure` Cookie。浏览器令牌不放进 QR 或小程序的场景参数。
- 微信平台服务调用使用超时、有限重试和响应校验；生产不可用时返回故障，不自动切到本地伪造身份。

## Business data choice

- 两端共享同一个顾客 ID 和服务端购物车；未登录的临时车只在明确登录后合并，遇到同一规格/时间段冲突提示顾客确认。
- 购物车不是库存锁；报价会过期，提交时按当前日期窗口和单件状态重新核算。Web 端可用 SSE，小程序端通过打开/返回页面刷新与有限前台轮询获取进度，不依赖常驻连接。
- NOK 是订单法定/业务账面单位；定位币种仅作参考展示。模拟支付、退押、损坏费、补差和签署在小程序中保持与 Web 一致的合成提示。

## Dependency and evidence boundary

018 的安全合成预览与六角色本机验证已完成；019 已在隔离实例验证 Web 与 Mini HTTP 客户端共享购物车、库存和订单，也在正式 AppID 的开发者工具模拟器编译运行。上述结果不证明真实微信平台登录、正式小程序码、手机扫码或公网业务。用户提供的小程序备案号与 `bsrski.cn` 域名 ICP 是两项不同条件；域名仍在审核，不能自动开放公网。
