# Implementation Plan: 安全合成数据全功能预览

**Date**: 2026-11-18  
**Spec**: [spec.md](spec.md)  
**Scope**: 本机隔离实现和验收准备；不改真实候选业务策略、不购买或开放云资源。

## Summary

在 017 的受控 HTTPS 本机代理边界上新增显式 `BSR_RUN_MODE=showcase`。该模式沿用候选级别的账号、会话、代理与对象权限，使用独立来源标记和空白私有 SQLite 实例；经线下初始化后只写虚构门店、规格、单件装备与政策，管理员再开通六角色所需私有账号。把现有“候选”的安全职责与“交易暂禁”职责拆开：合成预览允许模拟完整业务，正式候选继续禁交易，课程演示继续回环。所有收付款、退款、签署、费率和照片维持可见的合成语义。用隔离实例完成六角色浏览器、攻击、迁移、备份恢复演练，不发布到云端。

## Technical Context

- **Language/Version**: Node.js 24，ES modules；现有原生 HTTP/HTTPS 与 `node:sqlite`。
- **Primary Dependencies**: 复用 `src/runtime-config.mjs`、`src/runtime-provenance.mjs`、`src/proxy-boundary.mjs`、`src/identity.mjs`、`src/server.mjs`、现有业务模块与 `public/`；无新增运行依赖为默认目标。
- **Storage**: 独立私有 SQLite WAL；来源标记 `SHOWCASE`；单进程单写入；合成数据集版本与政策快照。备份清单绑定用途和实例标识。
- **Testing**: Node 内建测试运行器、隔离数据库、本机 HTTPS 测试代理及独立 Chrome 浏览器流程。真实操作的会话 Cookie、跨角色共享状态和 390px 页面必须验证。
- **Target Platform**: 先在本机受控入口完成演练；未来阿里云单实例部署须另行取得实例、域名、证书与授权。
- **Performance Goals**: 预览验收规模为至少 2 门店、6 角色、20 单件装备、2 笔完整订单；普通页面在本机测试环境 3 秒内可操作。该数字不是生产容量承诺。
- **Constraints**: 绝不调用 `seed(db)` 的演示账号/订单路径；不复制现有运行库；密钥、附件、备份不位于 `public/`；候选预约继续关闭；无真实支付/签名。
- **Scale/Scope**: 单实例合成预览；真实多店商用容量与并发阈值不由此验收。

## Constitution Check

| 原则 | 设计门槛与验证 |
| --- | --- |
| I 可追溯需求 | 018 FR-001～014 对应三条用户故事、数据模型、接口契约及任务；现行业务、合成假设、BSR 未批准事项分别标记。用户排除云端预览写入核心 PDF，本包不修改该 PDF。 |
| II 合同/金额真实性 | NOK 记账，政策版本和订单快照；模拟交易、签署、退款、补差与 8% 押金明确演示标识。商业费率、真实渠道仍待 BSR 批准。 |
| III 单件库存 | 合成数据也按每件唯一 ID、门店、状态和时间区间运行；并发、冲突、重复请求和受损隔离进入回归。 |
| IV 最小权限 | 候选级 Cookie/代理/会话撤销；六角色对象权限矩阵；只有人工生成附件，隔离私有资料；错误来源在路由前阻断。 |
| V 可验证与恢复 | 新模式启动/迁移负面测试、六角色浏览器、全量回归、隔离备份恢复及旧会话失效；不触及演示/候选生产资料。 |

**Gate (2026-11-20)**: Phase 1–5 已按任务逐项完成隔离本机验证；六角色可信代理浏览器、桌面/390px 顾客页面预约、员工备货和页面交付、两笔终态订单及离线恢复通过。T041 的最终仓库发布包审计仍须在准备实际包时执行。不能以本地模拟通过声称 BSR 正式政策或阿里云上线已获验收。

## Project Structure

```text
src/runtime-config.mjs             # 三用途只读启动验证与受控入口
src/runtime-provenance.mjs         # SHOWCASE 来源检查、锁与初始化
src/db.mjs                         # 新实例 schema 与显式非演示数据入口
src/identity.mjs                   # 管理会话、账号、限速共用
src/proxy-boundary.mjs             # 017 本机可信代理共用
src/server.mjs                     # 安全模式与交易许可独立判定
src/fulfillment.mjs                # 现有备货/交付/归还逻辑复核
src/damage.mjs                     # 鉴定及押金演示结算复核
public/app.js                      # 六角色 UI 与模式标识
public/fulfillment.js              # 员工流程与顾客同步
public/damage.js                   # 检修证据与演示结算
tools/showcase-setup.mjs           # 私有交互初始化与预检
tools/showcase-restore.mjs         # 合成来源限定的离线恢复
tools/backup-verify.mjs            # 备份清单用途检查
test/018-showcase-*.test.mjs       # 模式、来源、账户、流程、恢复
test/018-showcase-browser.mjs      # 隔离浏览器六角色与安全检查
specs/018-secure-synthetic-showcase/
```

现有 `tools/candidate-setup.mjs` 与 `tools/candidate-restore.mjs` 保留候选专用拒绝规则。不得为了代码复用而让候选恢复命令接受 SHOWCASE。

## Implementation Order

1. 记录 017 已通过的候选代理、安全、演示流程与当前资料目录基线；为 018 新建全临时测试目录，先写模式互斥与已知演示凭据负面测试。
2. 扩展只读配置预检和来源检查，加入独立 `SHOWCASE` 标记。`runtime_installation` 新建 schema 允许 `SHOWCASE`；现有 DEMO/CANDIDATE 库不做用途转换，幂等迁移只维护结构兼容。启动在创建/打开业务库前先验证配置及现有库来源。
3. 建立受控线下初始化命令：交互输入初始管理员强凭据；单写者锁与事务写入来源、合成门店、分类、规格、单件装备、政策版本和数据集标记；半成品不得就绪。管理员再通过受保护账号管理界面开通五类角色，初始密码强、首次登录改密。
4. 在服务端将 `managedSecurity`（candidate/showcase）与 `transactionsBlocked`（candidate）分开；必须逐个审阅 `isCandidate` 分支，特别是启动、静态资源、`/api/bootstrap`、身份、目录、购物车、预约、模拟支付/签署、损坏、价格、管理员接口及 SSE。用能力表显式告知前端。
5. 在前端把安全账号登录/退出/首次改密与“正式候选未批准”页面拆开；showcase 显示合成预览警示和六角色完整工作台。统一金额、确认、模拟交易、导出与附件标识；不得以 `demo:false` 直接推断交易关闭。
6. 完成正常和异常订单的跨角色同步测试，包含时间段库存、并发最后一件、两小时新用户超时宽限、8% 押金、24 小时检验、补差与自动模拟退押；仅使用合成测试附件。
7. 做 SHOWCASE 专用备份/隔离恢复，清单核对用途、实例、完整性、外键与摘要；恢复副本撤销全部旧会话。错误或候选备份不得覆盖目标。完成重启和旧库幂等迁移测试。
8. 使用真实浏览器走六角色流程及来源/越权矩阵，再跑全量 Node 回归和 demo/candidate 浏览器基线。只有全部本机证据齐备才可把 018 任务标记完成；云端、商业政策与真实渠道保留待办。

## Rollback and Data Safety

- `BSR_RUN_MODE` 缺省仍是回环课程演示。停止合成实例不影响候选和演示库。绝不将 SHOWCASE 文件重命名或复制成 CANDIDATE 来回退。
- 初始化先取得互斥锁并用事务提交；若 schema 准备中断，标记保持未就绪并在隔离目录修复或移走，不能当空白库重新播种到旧文件。旧 DEMO/CANDIDATE schema 不经强制重建。
- 每次迁移或恢复前有可验证备份；备份目录与数据库、静态目录隔离。恢复只到新目标文件，核验通过才由操作者安排替换，原库仍保留。
- 出现安全、政策真实性或库存错误时停止合成实例，保留私有审计和备份供定位；不以开放 demo 作为临时替代。

## Deferred Decisions

- BSR 正式价目、损坏费、取消规则、真实渠道和电子签署服务商未获批准；本包一律采用“仅供课程合成预览”的版本化示例数据。
- 未来云地域、域名、HTTPS 证书、备案、教师账号交付及公网权限，待用户购买服务后另行执行和验收。
