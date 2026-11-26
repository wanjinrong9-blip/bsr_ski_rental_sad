# Local development and validation guide: Web + WeChat Mini Program

**Status**: 本机部分实现，正式微信平台和手机验收仍待完成。实际顾客端目录为 `mini-program/`，使用说明见 [README](../../mini-program/README.md)；本指南保留后续平台接入与验收步骤，不是发布或云端部署指南。

## What can be done before platform credentials

1. Recheck the completed 017 trusted proxy and 018 SHOWCASE six-role regression before further integration. Do not expose current DEMO with public teaching credentials.
2. Use an isolated temporary SHOWCASE instance for Mini integration. Never point mini tests at `data/bsr.sqlite` or a real customer database.
3. Run Node tests for new schema, Web/Mini cart versioning, in-process fake `code2Session`, one-use challenge, binding uniqueness, session revocation, own/other order access, concurrent last unit, duplicate submit, NOK/policy snapshots and unsupported modes.
4. Build and inspect native mini pages with the public official AppID in `project.config.json` and simulator-only `local-demo` API configuration. Never put an AppSecret, platform token, customer database or private session in the mini-program source.
5. In the Web browser, confirm the mini entry card shows “微信小程序筹备中” while no real platform code is installed. Verify no generic URL QR, demo credentials or private configuration are exposed by static files.
6. Run two-client integration against the same isolated database: Web customer/cart ↔ mini test client/cart, mini reservation ↔ staff Web preparation/return/repair ↔ mini order progress. Confirm one order ID and one inventory commitment.
7. Repeat full Node tests, 017 proxy browser, 018 six-role browser and 019 desktop/390px Web entry browser. Record exact counts and unresolved failures in `validation.md`.

## Platform prerequisites for real WeChat test

- The user has supplied Mini Program AppID `wx51ce51fc873371a6`, registered name `WJR同学的BSR系统分析设计作业`, and Mini Program filing number `湘ICP备2026056763号-1X`. The supplied filing screenshot lists service-content tag `生活服务-工具`; verify the actual account permissions and permitted service category separately in [WeChat Official Accounts Platform](https://mp.weixin.qq.com/). Manage AppSecret privately on the server. The public AppID is not an AppSecret.
- Prepare a valid HTTPS domain for the same backend, complete the ICP requirement stated by WeChat for the legal request domain, add it to the Mini Program's domain list, and separately satisfy applicable website and Mini Program filing/review requirements. Hosting the server in Hong Kong does not by itself waive the Mini Program request-domain rule. Alibaba Cloud server selection alone does not create this domain or publish the Mini Program.
- In a private environment, configure AppID/AppSecret and issue a platform-generated Mini Program code for the homepage. Never paste secrets into a chat, commit, screenshot or `public/` file. Review the code image and site release flag before enabling the Web card.
- `mini-program/` is open in official WeChat Developer Tools Stable 2.02.2609250 with that AppID; the simulator shows the catalogue (32 specifications) with 0 reported problems and the project is “未发布”. After a legal request domain and service are ready, test with an authorized test member and a real phone. Development-tool exceptions for local network requests are **not** release evidence.
- On the phone: scan the website code in WeChat, verify entry page, complete a new or existing customer binding, build cart, confirm 8% reference-value deposit and damage policy, place a synthetic order, refresh order after staff Web updates, log out and verify old token refusal.

## Evidence and stop conditions

Record app version, test account scope, domain, QR issue time, WeChat developer-tool version, phone/WeChat versions, exact automated test totals and redacted screenshots. Do not record passwords, AppSecret, platform token, OpenID, raw code, bearer token, QR private scene maps or personal photos.

The user reports Mini Program filing complete; this is separate from the `bsrski.cn` domain ICP review. While the legal HTTPS request domain, real platform exchange, official QR, phone verification, applicable review or publication approval remain outstanding, keep the Web entry in preparation state and leave platform acceptance tasks unchecked. A local mock exchange is evidence for application logic only; it cannot prove real WeChat scanning or login.
