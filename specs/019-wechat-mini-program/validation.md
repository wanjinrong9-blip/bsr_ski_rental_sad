# 019 验证记录：网页与微信小程序共享租赁业务

2026-11-26 上传进展：开发者工具上传表单填写版本号 `0.1.0` 后显示“代码上传成功”，详情显示当天 13:32 上传约 1004 KB，发布状态仍为“未发布”。未进入微信后台核验版本列表或提交审核；后台 URL 被电脑控制工具禁止访问。客户端仍为 `local-demo`、`http://127.0.0.1:4173`，真机无法使用该电脑回环地址；开发包上传不关闭 T038/T039，也不构成正式业务验收。以下 11 月 25 日的模拟器/测试记录按历史证据保留。

更新：2026-11-25。当前记录本机源码、接口、隔离合成实例及微信开发者工具模拟器证据；正式 AppID `wx51ce51fc873371a6` 已配置并在项目详情核对，名称“WJR同学的BSR系统分析设计作业”、发布状态“未发布”。**没有真机微信登录/扫码或小程序发布证据**。用户提供的小程序备案号为湘ICP备2026056763号-1X；网站 `bsrski.cn` 曾因“网站主办者冲突”退回，现据用户说明域名仍在审核，当前控制台状态未复核。Spec Kit 当前指针为 019。

## 前置基线与边界（T001/T003）

018 已从早期只读方案推进到本机 Phase 1～5：独立 SHOWCASE 合成库初始化、六角色受管理账号、正常/受损模拟订单、备份恢复与两次重启均通过。`node --test test/*.test.mjs` 在 018 收口时为 **191/191 通过**，原始输出为 `test-results/018-full-final.log`；`018-showcase-browser.mjs` 用真实浏览器经本机 HTTPS 可信代理覆盖六角色、两种终态和桌面/390px 页面。`018-showcase-phase3-browser.mjs`、`017-proxy-browser.mjs`、`candidate-browser-smoke.mjs`、`preview-smoke.mjs` 也通过；017 的一次 Chrome 临时文件 `EBUSY` 重跑后通过。详见 [018 验证记录](../018-secure-synthetic-showcase/validation.md)。这满足 019 隔离合成实例的**本机依赖**，不等于 019 跨端验收、真实微信身份或对公网开放。

018 阶段的 T041 曾因没有 Git 包而未完成；2026-11-22 已在应用目录建立**本地**仓库，并对拟发布暂存清单完成 T037 私有文件审阅，详见 [Git 发布包审阅](../../docs/Git发布包审阅.md)。工作区 `data/` 内仍有本机演示库和备份，但均被 Git 排除；019 不得用公开 `Demo123!` 演示账号替代独立受控身份。018 Phase 2 的主文件与 WAL 摘要只是历史快照。本轮对运行中 `data/bsr.sqlite` 以 SQLite 只读连接开启一致性读取事务，对所有非系统表按表名、每行 JSON 排序后计算逻辑 SHA-256；未执行迁移或写入。结果：`legacy-demo`、50 表、用户 7、预约 4、价目 64、共享购物车 1、微信绑定 0；逻辑摘要 `21b3aa5aece610bb856323144970d411d98e6ed74c55b265abce945e0f6b404d`，`integrity_check=ok`、外键违规 0。`data/` 没有持久 CANDIDATE 库，所以不虚构其摘要；独立旧 CANDIDATE 夹具的迁移前后逻辑摘要相等、运行模式和历史业务行不变，见 `019-schema.test.mjs`。

## 网页业务入口盘点（T002）

| 用户行为 / 要求 | 当前 Web 实现与服务端事实 | 019 验证界限 |
| --- | --- | --- |
| 顾客导航、目录、时间库存（FR-001/004/006；SC-002/005） | `public/app.js` 的 `catalog`/`cart`/`orders` 路由、取货/归还日期选择与分类筛选；`GET /api/catalog` 通过 `availability()` 和价目给每个规格的区间余量。SHOWCASE 须受管理登录，CANDIDATE 不开放目录交易。 | 小程序页面已有本机测试号模拟器显示；同窗口真实两端比对和最后单件专项与跨端同顾客购物车比对已在隔离实例通过。 |
| 共享购物车、报价（FR-004～006；SC-002/003） | `public/app.js` 已登录顾客 `GET/PUT /api/cart`，带 `expectedVersion`；访客本机暂存并在登录时合并。`src/cart.mjs` 管服务端版本与冲突；`POST /api/quote` 统一核算 NOK、逐件参考价值 8% 押金和政策。 | `019-web-mini-e2e.mjs` 让真实 Chrome Web Cookie 与独立 Mini Bearer 在同一虚构顾客 ID 上双向修改购物车并核对版本；正式微信身份和真机仍待验。 |
| 同意、预约与本人订单（FR-004～006/010/011；SC-002/003/005） | 结账弹窗列出租金、押金、09:00/16:00、超时和损坏说明；`POST /api/reservations` 使用服务端库存复核和幂等键。`GET /api/reservations` 与单号详情按顾客 ID 限本人。 | 018 证明 Web 合成全流程；019 双客户端脚本由 Mini HTTP 预约，Chrome 实际订单页显示同一订单 ID、取货码及 NOK 金额；原生小程序真机联合流程仍待验。 |
| 取货码、备货、交还和受损（FR-004/010/011；SC-002/005） | `public/app.js` 订单详情显示取货码、责任阶段、合同与金额；`src/fulfillment.mjs` 的准备事件、`/api/operations/pickup`、`/api/operations/return` 和 `src/damage.mjs` 的照片、24 小时反馈、经理核价写同一订单。 | `019-web-mini-e2e.mjs` 用 Web 员工完成备货、取货、受损交还、鉴定与模拟补差；Mini Bearer 读取同一订单阶段及 24 小时期限，Chrome 390px 订单页刷新见“已完成”。真机原生页面待验。 |
| 网页小程序入口（FR-002/003/013；SC-001/006） | `public/app.js` 有顶部与导航入口；`src/mini-entry.mjs` 的 OFF/PAUSED 均不提供图片，READY 要求私有完整 PNG、匹配 AppID、首页场景、期限和 HMAC 人工批准凭据；`GET /api/mini-entry/code` 仅 READY 返回图片。 | 本地凭据只证明图片未被更换及运营者批准，不证明微信签发；没有正式码或手机扫码证据。 |

## 当前 019 本机实现

| 范围 | 当前证据 | 不可声称的结果 |
| --- | --- | --- |
| 原生顾客端 | `mini-program/` 有目录、分类/尺码/款式、租期库存、购物车、本人订单、详情、账号页和用户提供的 BSR 标志；安全模式源代码实现 `wx.login`、显式绑定及独立令牌。受损详情新增逐张照片入口：授权下载到临时文件，再用 `wx.previewImage` 查看；退出、会话过期或切换账号时尝试删除已记录的临时文件。本机 `order-damage-page.test.cjs` 和 `secure-api.test.cjs` 验证了调用、Bearer、401/404 和模拟清理。2026-11-23 使用 Stable 2.02.2609250、基础库 3.18.0 测试号模拟器检查五页，问题面板 0、调试器错误 0。2026-11-25 同版工具项目详情显示正式 AppID、状态“未发布”；其电脑模拟器使用非灰度基础库 3.17.6，检查目录 32 款、购物车金额、订单列表/详情及“我的”页，所查页面问题面板 0、编译错误 0。当前 DEMO 库没有受损鉴定单，照片按钮和 `wx.previewImage` 的真实模拟器交互尚未目视执行。 | 真机照片预览/布局/扫码、真实微信登录。 |
| 服务端共享购物车与订单 | `src/cart.mjs` 由 Web `/api/cart` 与私有 `/api/mini/cart` 共用；`src/mini-api.mjs` 在 SHOWCASE 显式启用后提供目录、报价、预约、合同、本人订单及取消。`019-cross-client-rental.test.mjs` 覆盖最后一件、报价过期/版本、幂等及取消；`019-order-sync.test.mjs` 覆盖无损/受损及私有照片原件：本人 Mini Bearer 可读合成 PNG，其他顾客统一 404，匿名 401，响应为 `private, no-store`；`019-web-mini-e2e.mjs` 用真实 Chrome 顾客、独立 Mini HTTP Bearer 和 Web 店员/经理/技师证实**同一顾客、购物车与订单 ID**贯穿备货、取货、24 小时受损反馈、经理核价、联系补差与完成。 | 正式微信客户端与网页浏览器联合操作、原生照片预览真机验收仍待；本机调用和授权检查不等于微信平台通过。 |
| 微信身份与平台适配 | `src/wechat-platform.mjs` 有私有服务端 `code2Session` HTTPS 适配；`src/mini-identity.mjs` 有一次性临时码/绑定挑战、仅顾客账号证明、AppID/OpenID 活跃唯一键、令牌摘要、撤销/解绑和限速。`019-mini-identity.test.mjs`、`019-mini-api.test.mjs` 用测试注入验证 Web Cookie 与 Mini Bearer 隔离。安全接口默认 OFF，仅在 SHOWCASE 私有环境配置 `BSR_WECHAT_MINI_ENABLED=1`、`BSR_WECHAT_APP_ID`、`BSR_WECHAT_APP_SECRET`、`BSR_WECHAT_OPENID_KEY` 后启用；这里仅列变量名。 | 正式 AppID 已在客户端项目详情核对；没有获取或保存私有 AppSecret，未从真实微信取得并交换临时码；官方小程序码获取适配尚未完成。 |
| 结构与恢复 | `src/db.mjs` 增加绑定、挑战、已用临时码、独立会话、共享购物车和小程序报价表。`019-recovery.test.mjs` 2/2：旧 DEMO 文件移除 019 私有表后重新打开两次，只补结构、不改历史订单与价目；隔离 SHOWCASE 完整性校验备份/恢复后，旧 Mini Bearer、Web Cookie 与待绑定挑战均失效，恢复绑定不允许同一顾客绑定另一 OpenID，原顾客可重新使用 Web 与 Mini 登录，SQLite 完整性及外键正常。 | 固定首页码以私有配置、签署凭据和请求时到期检查为权威，无需数据库状态表；动态场景映射尚未设计；本地 Git 暂存包已检查，未来实际上传和生产恢复仍待验收。 |
| 网页扫码状态 | `019-mini-entry.test.mjs` 6/6 验证 OFF/PAUSED/READY、旧 PNG 配置拒绝、AppID/场景/签署/PNG CRC/私有路径与开关。`019-web-qr-browser.mjs` 在独立 SHOWCASE 中使用**本地签署的 BSR 标志测试图，绝非微信码**，验证 OFF/PAUSED 不显示图片、READY 显示受控图片；Chrome 桌面和 390px 均无横向溢出，小屏按钮可滚动至导航上方操作，合成截图位于 Git 忽略的 `test-results/`。 | 正式微信码来源、发行状态及真实手机扫码仍待验收；测试图不能作为小程序码。 |

2026-11-23 本机完整 Node 回归 `node --test test/*.test.mjs` **220/220 通过、0 失败、0 跳过**；原生逻辑 `node --test mini-program/tests/*.test.cjs` **13/13 通过、0 失败、0 跳过**；`node test/019-web-mini-e2e.mjs` 复跑通过。新增原生测试覆盖照片 Bearer 下载、退出清理、401/404 与逐张预览；`019-recovery.test.mjs` 2/2 覆盖旧库迁移和恢复后的双端会话撤销；`019-order-sync.test.mjs` 两种终态 2/2，包含受损补差及本人原图读取；`019-mini-pages.test.mjs` 6/6 覆盖原生 bootstrap、登录/绑定挑战、购物车冲突、同意、网络错误、令牌过期和 NOK 合成提示。本轮命令结果由执行者即时核对，未另存新日志；`test-results/019-node-suite-214.log`、`test-results/019-mini-native-11.log` 是之前的历史输出，不能作为 220/220 和 13/13 的原始日志。018 收口时的 191/191 是实施 019 身份和业务路由前的历史基线。品牌与测试号模拟器检查另见 [019 品牌调试清单](../../docs/019-品牌调试检查清单.md)。

## 双客户端与浏览器本机验收（T026/T027/T033）

`node test/019-web-mini-e2e.mjs` 在临时 SHOWCASE 合成库和本机 HTTPS 中通过：真实 Chrome 顾客使用受管理的安全 Cookie，独立 Mini HTTP 客户端用测试假 `code2Session` 显式绑定后持 Bearer；两种会话互不能代用。两端 `/me` 返回同一虚构顾客 ID；Chrome 把购物车置为 1 件，Mini 读取同版本，再改为 2 件，Chrome 回读同版本及数量。Mini 报价预约后，Chrome API 和订单卡核对同一订单 ID、取货码、NOK 总额和押金。Web 员工/经理/技师随后完成合同、模拟支付、备货、交付、2 件交还（1 件虚构受损）、24 小时初评期限、照片证据、复核、扣押金、联系与模拟补差；Mini 每阶段读取同一订单，最终 Chrome 刷新订单卡见“已完成”。`test-results/019-web-mini-e2e.log` 保存通过结果。

`node test/017-proxy-browser.mjs` 验证本机 HTTPS/代理登录、Cookie、390px 和退出；`node test/018-showcase-browser.mjs` 复跑通过六个受管理角色、两种终态、12 个角色路由及桌面/390px 浏览器业务交接。T027 浏览器在 1440px 和 390px 都断言无全局横向溢出；同一脚本现在检查网页小程序入口 OFF 时显示“筹备中”、没有二维码图片，并生成 `test-results/019-mini-entry-off-390px.png`，目检无横向溢出。订单截图 `019-web-mini-browser-desktop.png`、`019-web-mini-browser-390px.png`、`019-web-mini-damage-390px.png` 仅含一次性虚构身份/订单，未见真实顾客资料或可重用凭据。截图位于 Git 忽略的 `test-results/`。以上证明本机 Web 浏览器与 Mini **HTTP 客户端**共享业务状态，不证明正式小程序原生页面、真机或微信平台签发身份。

另运行 `node test/019-web-qr-browser.mjs`，OFF/PAUSED/READY 三态浏览器检查均通过。READY 截图中的 BSR 标志是故意使用的**合成测试图**，只验证网页布局与受控图片路径，不可扫码；390px 全页图人工复查后未见裁切，固定底栏占据视口底部，但操作按钮可滚动到其上方。

## 019 FR/SC 可追溯状态

| 要求 | 已有证据 / 未完成的验证 |
| --- | --- |
| FR-001 | Web 六角色与原生顾客端源码并存，共用 SQLite 业务库；隔离小程序令牌订单已与 Web 员工履约同一行，真机联合流程待验。 |
| FR-002～003 / SC-001 | 筹备入口和无假码通过；正式 AppID 已配置并在开发者工具项目详情核对，签发码、场景核验、10 次真机扫码待平台条件。 |
| FR-004～006 / SC-002～003、SC-005 | 共享购物车/NOK 报价、09:00/16:00 日期库存、8% 押金、幂等/最后一件、同一订单无损及受损补差终态均有隔离测试；真实 Chrome 顾客与独立 Mini HTTP 双向比对同一购物车/订单、390px 页面通过；真机仍待测。 |
| FR-007～009 / SC-004 | 服务端假平台注入已测 `code2Session` 响应、一次性挑战、仅顾客显式绑定、独立令牌、Web/Mini 会话隔离、撤销、停用与恢复失效；小程序安全模式源代码调用 `wx.login`，但正式 AppID 的本机项目配置不等于平台身份联调，不能声称真实微信登录。默认 `local-demo` 仍只用回环演示登录，不可发布。 |
| FR-010～011 | `019-order-sync.test.mjs` 在独立小程序会话下读回 Web 员工备货、核码交付、无损归还及单次模拟退押，也读回受损初评照片元数据、授权照片原件、24 小时期限、经理复核、联系后补差和完成；具名阶段/时间与模拟标识由共用领域返回。原生订单页增加鉴定明细、联系记录与逐张照片预览入口，本机模拟 `wx.downloadFile`/`wx.previewImage` 调用通过。真实平台、真机照片预览待验。 |
| FR-012～013 / SC-006 | 回环开发仅供本机；本地 Git 暂存包路径与定向凭据扫描通过，PDF/Logo 可随应用源码审阅。小程序备案号由用户提供，网站 `bsrski.cn` 据用户说明仍在审核；HTTPS 合法请求域名登记、微信版本审核、私密 AppSecret、真实扫码、实际上传前复核仍未验收。不得对外开放。 |
| FR-014 | 4.12 六章课程设计需求 PDF 已补 UC-16～21、椭圆用例图、身份类图、S-UC19、两张 ERD 与附录 J；requirement.txt、系统规约及追溯矩阵已更新。91 页 A4 编译，无 overfull；封面、单页目录、新增图、分页受影响的旧序列图和附录均经渲染目检，未见重叠/裁切。 |
| FR-015 / SC-007 | 最近全量 Node 220/220、2026-11-25 原生逻辑 15/15；017 代理、018 六角色 Web 浏览器、019 Web Chrome + Mini HTTP 双客户端全链与网页扫码 OFF/PAUSED/合成 READY 三态此前通过，390px 合成页面截图目检。正式 AppID 本机模拟器的目录、购物车、订单/详情、个人页可见，所查页面问题面板 0；真实平台身份、原生真机及扫码仍待验，不能标记 019 完成。 |

## 4.12 设计需求 PDF 与图面检查（T036）

2026-11-20 已由本机 Tectonic 从 LaTeX 源编译 4.12 成品：output/pdf/BSR滑雪租赁系统设计需求文档_4.12_网页与小程序共享业务版.pdf，91 页 A4、683278 字节，SHA-256 EEB4027A9A91500BC168113913AD78A3B27E92F97964BEC6026AD4031E3FC91E。图示增补 U-MINI 椭圆系统用例、C-MINI 模块类图、S-UC19 分析序列及拆开的 ER-MINI-A/B；系统规约和追溯矩阵对应 FR-M01～M08、DR-11、BR-10、NFR-08、AC-07。

首轮编译暴露 4.2 旧序列图被前页类图/表格挤到页底的 overfull vbox；在序列图区前分页后复编，最终日志无 overfull、未定义引用或缺字错误。残余 underfull 为局部 ERD 字段换行，实际渲染检查封面、单页目录、用例 33 页、身份类图 44 页、旧序列 46 页、S-UC19 50 页、ER-MINI-A/B 66～67 页、附录 J 89～90 页均未见重叠或裁切；页码为 PDF 内印刷页码，物理页从 1 起算再加 1。字体依赖 Windows 字体，跨平台编译仍需适配。文档审阅不替代 BSR 签字、微信真机和正式交易验收。

## 小程序码本机发布闸门（T013/T015/T017 部分）

本地默认 OFF；PAUSED 不读或返回图片；READY 须同时明确发布、启用小程序身份接口、匹配同一 AppID，并提供位于项目目录外的 PNG 和 HMAC 人工批准凭据。图像通过 PNG 结构及 CRC 检查，凭据绑定 SHA-256、AppID、固定公开首页场景和期限。遗留“仅放 PNG 并确认”的配置不能切到 READY。私有工具 tools/attest-mini-entry.mjs 只有在操作员明确声明已核对平台来源时才签署本地凭据，重复签署不能覆盖。正式平台条件尚未核验，因此没有执行签署，也没有打开入口。定向 Node 测试 6/6 通过。

HMAC 只证明本地批准和文件完整性；操作员仍可能签署一张并非微信签发的图片，故不能把 READY 测试夹具、来源字段或 PNG 格式检查当作微信平台证明。T017 的正式码取得和签发者核实、T038/T039 真机扫码仍未完成；T013/T015 的真实平台部分继续保持未验收。

## 2026-11-23 增量验证与安全边界

- `019-schema.test.mjs` 3/3：在独立旧 CANDIDATE 夹具中移除 019 表再迁移两次，比较运行模式、门店、用户、政策与历史订单的逻辑摘要，检查 `integrity_check`、外键和活跃绑定唯一索引的谓词。`019-recovery.test.mjs` 2/2 的旧 DEMO 与恢复撤销证据继续成立；这些测试均未更改当前 `data/` 运行库。
- `019-mini-identity.test.mjs` 6/6：解绑旧 OpenID 后以新一次性码与账号证明重新绑定，历史解绑行保留且仅有一条活跃绑定。`019-mini-api.test.mjs` 5/5：同一可信来源 10 分钟内最多进行 30 次服务端微信临时码交换；第 31 次在调用平台适配器前返回 429，另一来源仍可继续，限速表只保存带命名空间的 HMAC 摘要。`019-wechat-platform.test.mjs` 4/4 的失败分支均断言每次仅调用上游一次，避免重试耗尽平台额度。额度值是本站本机保护策略，仍需与实际平台限制核对。
- `019-mini-entry.test.mjs` 6/6：确定性时钟验证运行中的 READY 在凭据到期时立即显示 PAUSED，图片路由停止提供码。固定首页入口以私有启动配置、图片摘要和人工签署凭据为权威，不额外存数据库状态；动态场景需要另行设计映射。HMAC 凭据无法独立证明图片由微信签发。
- `019-mini-pages.test.mjs` 6/6：新增未登录装备在登录后保存到空的账号购物车，以及账号已有 Web 购物车时让顾客选择保留 Web 版本或用本地清单替换，PUT 带当前版本。`019-cross-client-rental.test.mjs` 2/2 补查护具类目、09:00～16:00 日期段、参考价值 8% 押金、NOK 报价及订单中的价格/政策同意快照。受管理 SHOWCASE 仍要求登录，访客车用于可浏览的本地 DEMO；没有将匿名交易开放到受管理实例。
- 新增用例后全量 Node **220/220**、Mini 原生 **13/13**，均 0 失败、0 跳过。隔离 `019-web-qr-browser.mjs` OFF/PAUSED/合成 READY 和 `019-web-mini-e2e.mjs` 同单履约复跑均以退出码 0 通过。截至当日，正式 AppID、平台签发码、微信真机和公网业务验收仍留空；11 月 25 日 AppID 接入见下节。

## 2026-11-25 正式小程序标识接入

- 用户提供的小程序名称为“WJR同学的BSR系统分析设计作业”，AppID 为 `wx51ce51fc873371a6`，备案号为湘ICP备2026056763号-1X。公开 AppID 已写入 `mini-program/project.config.json` 和配置示例；本机被 Git 忽略的 `project.private.config.json` 与之同步。未取得 AppSecret，也未把私密值写入源码。
- 微信开发者工具 **2.02.2609250 Stable** 的“详情→基本信息”显示相同项目名称和 AppID，发布状态“未发布”；电脑模拟器使用非灰度基础库 3.17.6，目录显示 32 款规格；购物车一笔样例显示租金 NOK 774、押金 NOK 384、合计 NOK 1158；订单列表显示合成单 BR-DEMO004/003，BR-DEMO004 详情显示阶段、负责人 Emma Berg 和取货码区域；“我的”页显示小程序名称及用户提供的备案号。所查页面问题面板 0、编译错误 0。没有点击“预览”或“上传”，没有产生微信代码包上传记录。
- `node --test mini-program/tests/*.test.cjs` 重新执行 **15/15 通过、0 失败、0 跳过**。新增测试包含本机 AppID 一致性，以及损坏照片在退出或切换账号后拒绝继续预览并清理迟到的临时文件。上一轮完整 Node 220/220 和浏览器检查是独立的历史证据，本次未据此声称真机通过。
- 官方[项目配置](https://developers.weixin.qq.com/miniprogram/dev/devtools/projectconfig.md)说明本地私有配置可覆盖公开配置；[网络请求](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.md)规定合法 HTTPS 请求域名等条件；[发布流程](https://developers.weixin.qq.com/miniprogram/dev/framework/quickstart/release.md)区分本地编译、预览、上传、审核和发布；[小程序码](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/qr-code.md)由微信平台签发。当前仍是 `local-demo` + 回环 HTTP + 开发者工具关闭域名校验，不能作为手机端网络验收。

## 下一道关口

下一步是等待网站域名审核与 HTTPS 请求域名登记，之后配置私有服务端凭据、核验真实微信登录，才进行手机端订单/照片和正式小程序码扫码验证。应用目录已有本地 Git 仓库和暂存包审阅记录；未创建远端、提交或上传，实际发布前还须重审变更后的暂存清单。T004 的官方规则本轮已复查，实际平台能力仍待登记和审核结果。直接打开的网页仍是本机 DEMO，正式微信业务默认 OFF；最终 GitHub、云端权限和小程序发布仍待用户后续决定。
