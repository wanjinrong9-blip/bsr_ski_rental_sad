# Tasks: 需求与系统分析设计模型一致性

**Input**: [spec.md](spec.md)、[plan.md](plan.md)、[research.md](research.md)、[data-model.md](data-model.md)、[traceability.md](contracts/traceability.md)、[diagram-conventions.md](contracts/diagram-conventions.md)。  
**Organization**: 按 US1 业务现状/蓝图、US2 用例到分析模型、US3 数据设计分阶段；最后统一 LaTeX/PDF 验收。  
**Path convention**: 以下相对路径均从 `bsr-app/` 根目录计算；`../usecase/` 与 `../output/BSR设计需求文档_LaTeX/` 位于父工作区。  
**Current state**: 44/44 源文件任务完成，4.8 PDF 与 13/13 模型质量项已本地审阅；BSR 现场和政策签字、正式外部服务与生产验收不在此结论内。

## Phase 1: Setup（文档工程准备）

**Purpose**: 固定旧版可恢复状态并建立图源目录，不改业务代码。

- [x] T001 保存现有 `../output/BSR设计需求文档_LaTeX/main.tex`、`body.tex`、`updates/` 的可恢复副本和文件摘要到 `../output/BSR设计需求文档_LaTeX/archive/v20261028-pre-model/README.md`，记录原 PDF/图片版本而不改旧图。
- [x] T002 [P] 盘点 `../output/BSR设计需求文档_LaTeX/body.tex` 与 `updates/` 中 UC 编号、`\input`、`\includegraphics`、图号和重复/缺失引用，输出 `../usecase/旧文档盘点.md`。
- [x] T003 [P] 建立 `../output/BSR设计需求文档_LaTeX/diagrams/README.md`，定义可编辑图源、导出图、图号、UC/模块命名及 A4 可读性检查方法，遵守 `specs/007-system-model-alignment/contracts/diagram-conventions.md`。

**Checkpoint**: 旧正文有恢复入口、旧图号清单和新图源命名空间。

---

## Phase 2: Foundational（所有用户故事的共同前置）

**Purpose**: 在绘图前锁定编号语义、来源标签与视觉样例。

- [x] T004 根据 `../usecase/系统规约.md` UC-01～UC-15 和 T002 的盘点，在 `../usecase/旧新用例映射.md` 逐项填写旧 UC01～UC24 的旧名称、新编号、同义/拆分/合并/废弃/待确认关系及图注影响；旧 UC10“自动退还押金”不得直接等同新 UC-10“受损鉴定”。
- [x] T005 [P] 按 `specs/007-system-model-alignment/contracts/traceability.md` 在 `../usecase/需求追溯矩阵.md` 建立 FR/DR/BR/NFR→UC→图→实体→验收证据字段和“本地演示/目标/待 BSR 确认/生产缺口/待访谈”状态词汇。
- [x] T006 [P] 在 `../output/BSR设计需求文档_LaTeX/diagrams/index.md` 建图号与章节索引，列出五对业务流程、系统用例图、六组类图、九张核心序列图、六类状态图和分模块 ERD 的预期文件名。
- [x] T007 用老师课件的线型/图例和现有 `../output/BSR设计需求文档_LaTeX/main.tex` 的颜色、字号，在 `../output/BSR设计需求文档_LaTeX/diagrams/style.tex` 制作一张可读的图形样例，并记录导入/编译方法于同目录 `README.md`；先验证样式再批量画图。

**Checkpoint**: T004–T007 完成后，才能将旧图改号或将新模型写入正文。

---

## Phase 3: US1 业务现状与改进蓝图（P1，MVP）

**Goal**: 五个重点场景均能区分已证实的现状与待 BSR 确认的改进流程。

**Independent test**: 只审本章，就能逐张指出业务执行者、业务工人、实体、证据/待访谈节点、系统替代的信息搬运以及仍由人做的实物动作。

- [x] T008 [US1] 为预约/现场开单、交付、归还、维修、跨店转移建立证据行和待访谈标记，在 `../usecase/业务现状证据.md` 写来源、可信度、具体动作及缺失信息，不把本地页面倒推为旧业务事实。
- [x] T009 [P] [US1] 在 `../output/BSR设计需求文档_LaTeX/updates/business.tex` 更新组织愿景、业务执行者/工人/实体、五个业务用例及候选度量；无 BSR 基线或目标值时标待确认。
- [x] T010 [P] [US1] 在 `../output/BSR设计需求文档_LaTeX/diagrams/business-as-is-rental.tex` 画预约、交付、归还三张现状序列图，每个确定动作引用 T008 证据，无证据节点标待访谈。
- [x] T011 [P] [US1] 在 `../output/BSR设计需求文档_LaTeX/diagrams/business-as-is-service.tex` 画维修、跨店转移两张现状序列图，并标实物、合同/工单等业务实体及证据状态。
- [x] T012 [US1] 在 `../output/BSR设计需求文档_LaTeX/diagrams/business-to-be.tex` 画五张改进业务序列图，分别标出系统自动核库存/计费/提醒、员工备货验货与实物搬运，附“蓝图待 BSR 确认”。
- [x] T013 [US1] 在 `../output/BSR设计需求文档_LaTeX/body.tex` 的第 2 章接入 T009–T012 内容，替换与新证据冲突的旧图注和表述，保留六章标题编号。
- [x] T014 [US1] 对照 `specs/007-system-model-alignment/spec.md` 的 US1 验收场景，在 `../usecase/业务建模审阅记录.md` 逐图记录五对场景的来源、责任人、信息流改进与未签字项；未核实节点维持待访谈。

**Checkpoint**: US1 可单独审阅；不需要先完成类图或 ERD。

---

## Phase 4: US2 用例到分析模型（P1）

**Goal**: UC-01～UC-15 的关键概念、事件、异常和责任岗位能在系统用例、类、序列、状态模型中查到。

**Independent test**: 抽查日期段库存、当前合同签署、分批异店归还、24 小时初评、押金争议，沿需求→UC→图查无断链与相反结论。

- [x] T015 [P] [US2] 在 `../output/BSR设计需求文档_LaTeX/diagrams/system-usecases.tex` 按顾客、门店、维修、经营/管理边界绘制系统用例图，覆盖 UC-01～UC-15，并区分拟接入外部服务与当前演示。
- [x] T016 [P] [US2] 在 `../usecase/需求追溯矩阵.md` 填 UC-01～UC-15 对应的 FR/DR/BR/NFR、执行者、前后置和验收证据；原文未证实的现状不得标“已实现”。
- [x] T017 [P] [US2] 在 `../output/BSR设计需求文档_LaTeX/diagrams/classes-customer-inventory.tex` 分开画顾客/预约与库存/门店两组类图，含类名、关键属性/操作、泛化及关系基数，区分规格与物理单件。
- [x] T018 [P] [US2] 在 `../output/BSR设计需求文档_LaTeX/diagrams/classes-contract-damage.tex` 分开画合同/履约与受损/维修两组类图，表达合同版本、准备单件、检查、照片鉴定和安全验收。
- [x] T019 [P] [US2] 在 `../output/BSR设计需求文档_LaTeX/diagrams/classes-finance-workforce.tex` 分开画费用/结算与人员/运营两组类图，表达 NOK 分项、押金抵扣、班次与打卡、提醒已读与业务未解决状态。
- [x] T020 [P] [US2] 在 `../output/BSR设计需求文档_LaTeX/diagrams/sequences-reservation.tex` 为 UC-02、UC-03、UC-04 各画分析序列图，含边界/控制/实体类、库存二次校验、旧报价失效和规则重新同意分支。
- [x] T021 [P] [US2] 在 `../output/BSR设计需求文档_LaTeX/diagrams/sequences-contract-fulfillment.tex` 为 UC-05、UC-06、UC-07 各画分析序列图，含合同版本、演示/目标签付差异、备货安全检查和核码拒绝分支。
- [x] T022 [P] [US2] 在 `../output/BSR设计需求文档_LaTeX/diagrams/sequences-return-settlement.tex` 为 UC-09、UC-10、UC-11 各画分析序列图，含逐件实还、异店当前门店、24 小时初评、经理复核、争议与补差分支。
- [x] T023 [P] [US2] 在 `../output/BSR设计需求文档_LaTeX/diagrams/states-core.tex` 分开画订单、物理单件、备货/交付状态图，为每条转移写触发、守卫、执行者及副作用。
- [x] T024 [P] [US2] 在 `../output/BSR设计需求文档_LaTeX/diagrams/states-service.tex` 分开画受损鉴定、维修、押金/退款状态图，保证技师提交不等于可租、已读不等于订单解决、有争议不退款。
- [x] T025 [US2] 在 `../output/BSR设计需求文档_LaTeX/updates/requirements.tex` 按 T004 映射及现行 UC-01～UC-15 重新组织执行者、用例规约、字段和异常；每用例保留利益、可检验前后置、基本/扩展流程、质量与设计约束。
- [x] T026 [US2] 将 T017–T019 的六组类图与来源 UC 对照说明写入 `../output/BSR设计需求文档_LaTeX/updates/analysis-classes.tex`，明确“目标类/当前表”差距。
- [x] T027 [US2] 将 T020–T022 的九张分析序列及异常分支说明写入 `../output/BSR设计需求文档_LaTeX/updates/analysis-sequences.tex`，不得把接口清单代替边界/控制/实体协作。
- [x] T028 [US2] 将 T023–T024 的六类对象状态、转移守卫和责任岗位写入 `../output/BSR设计需求文档_LaTeX/updates/analysis-states.tex`，与规约术语一致。
- [x] T029 [US2] 在 `../output/BSR设计需求文档_LaTeX/body.tex` 的第 3–4 章接入 T015、T025–T028，按 T004 清理旧 UC 图号与冲突图文；不能只修改标题而保留旧语义。
- [x] T030 [US2] 在 `../usecase/模型一致性审阅记录.md` 按 US2 验收场景检查 UC-02/05/09/10/11 的基本与异常流程、类关系、九张序列和六类状态图，记录未通过项。

**Checkpoint**: US2 图集与系统规约可独立审阅；US3 的最终 ERD 对照以六组类图为输入。

---

## Phase 5: US3 数据设计与 ERD（P2）

**Goal**: 数据层可从分析类追溯到模块 ERD、字段约束和当前数据库差距。

**Independent test**: 抽查每个 ERD 模块的 PK/FK/基数/约束及历史快照；能解释单件防双占、异店归还、合同/费率不回写。

- [x] T031 [US3] 在 `../usecase/数据字典.md` 为 `specs/007-system-model-alignment/data-model.md` 的六组实体补字段名、业务含义、类型、必填、PK/FK/唯一/检查、来源 UC/BR、现有列与目标差距。
- [x] T032 [P] [US3] 在 `../output/BSR设计需求文档_LaTeX/diagrams/erd-customer-inventory-contract.tex` 分开画顾客预约、商品单件门店、合同与逐件交接三组 ERD，标 1:n 外键、多对多时间化连接和自反类别父键。
- [x] T033 [P] [US3] 在 `../output/BSR设计需求文档_LaTeX/diagrams/erd-service-finance-workforce.tex` 分开画受损维修、费用押金、人员排班提醒三组 ERD，标照片授权、费率/政策版本和结算分项。
- [x] T034 [US3] 对照 `src/db.mjs` 与现有升级模块，将目标 ERD 与已落库表逐项比较，输出 `../usecase/现有目标数据差异.md`；泛化单表/子表选择与未实现字段须说明。
- [x] T035 [US3] 在 `../output/BSR设计需求文档_LaTeX/updates/data.tex` 写 PK/FK、约束、历史快照、区间占用和数据访问方式，由 T031–T034 支持，不把目标表称为现有表。
- [x] T036 [US3] 在 `../output/BSR设计需求文档_LaTeX/updates/erd.tex` 按 T032–T033 的六组 ERD 加图注、关系说明和来源 UC，保持图与字段字典一致。
- [x] T037 [US3] 在 `../output/BSR设计需求文档_LaTeX/body.tex` 的第 5–6 章接入 T035–T036，移除语义冲突的旧 ERD 图注并确保总览只作模块索引。
- [x] T038 [US3] 在 `../usecase/数据设计审阅记录.md` 逐模块核对 1:n、m:n、自反、泛化、唯一恒定主键和费用/合同/费率快照，记录现有实现差距与需迁移项。

**Checkpoint**: US3 的字段字典与模块 ERD 可独立检查；任何目标/现有差异有明确标记。

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: 合并三条故事的文档，检查内容、模型、编译与实际演示描述。

- [x] T039 [P] 复核 `../usecase/需求追溯矩阵.md` 的 FR/DR/BR/NFR→UC-01～UC-15→图→实体→证据双向链接，标待访谈、待 BSR 确认和生产缺口，不把未绘/未测填“完成”。
- [x] T040 [P] 在 `../output/BSR设计需求文档_LaTeX/main.tex` 统一六章目录、图号/交叉引用、图注和版式；核对学生万锦融/信管2402与“设计需求文档”性质，不加入论文专用词。
- [x] T041 依 `specs/007-system-model-alignment/quickstart.md` 编译 `../output/BSR设计需求文档_LaTeX/main.tex`，修复缺图、缺 `\input`、重复标签和 LaTeX 错误，保存编译诊断于 `../usecase/PDF审阅记录.md`。
- [x] T042 逐页检查 `../output/BSR设计需求文档_LaTeX/main.pdf` 的目录、中文、颜色层级、A4 图表可读性、裁切与跨页，逐项记录并修正 `../usecase/PDF审阅记录.md`；编译成功但图不可读仍未通过。
- [x] T043 [P] 运行现有 `test/*.test.mjs` 与 `test/preview-smoke.mjs` 核对文档所称“本地演示已实现”行为，并将结果及代码缺口写入 `docs/需求覆盖与升级审计.md`；测试不能代替 BSR 现状访谈或政策签字。
- [x] T044 按 `specs/007-system-model-alignment/spec.md` SC-001～SC-006 总审 `../usecase/系统规约.md`、`../usecase/需求追溯矩阵.md` 与 `../output/BSR设计需求文档_LaTeX/main.pdf`，在 `../usecase/交付检查清单.md` 记录通过、未通过和待 BSR 决策。

## Dependencies & Execution Order

```text
Phase 1 Setup (T001–T003)
  └─ Phase 2 Foundation (T004–T007)
       ├─ US1 (T008–T014) ───────────────┐
       ├─ US2 (T015–T030) ───────────────┼─ Phase 6 (T039–T044)
       └─ US3 dictionary (T031) ── US2 classes (T017–T019) ── US3 ERD/integration (T032–T038)
```

- T001 的恢复副本应先于修改现有 TeX；T002/T003 可在不同文件上并行。T004 依赖 T002；T007 依赖 T003/T006。
- US1 与 US2 在 Foundation 后可分别独立完成和审阅；US3 的字段字典可提前做，最终 ERD 必须核对 US2 分析类。
- T013、T029、T037 都修改 `body.tex`，不得同时编辑；按章顺序合并，避免覆盖彼此改动。T039/T040 可分别处理矩阵与主样式，T041 需等待正文与图全部接入。
- 商业政策无 BSR 批准时保持演示/待确认标记；这不阻止模型稿完成，但不能把蓝图标为已签字。

## Parallel Opportunities

- Setup：T002 清点旧文档与 T003 建图源规范处理不同文件。
- US1：T010 与 T011 分场景画现状图；T009 与二者处理不同源文件。
- US2：T017–T024 按类、序列、状态图文件分工；各组在 T025–T029 合并前独立审阅。
- US3：T032 与 T033 分模块 ERD；待 T034 统一与当前表对照。
- 文档质量：T039 追溯与 T040 主样式可在不同文件进行，编译 T041 必须在合并后。

## Parallel Example: US2

```text
Task: T017 [US2] 顾客/预约与库存/门店类图 → ../output/BSR设计需求文档_LaTeX/diagrams/classes-customer-inventory.tex
Task: T018 [US2] 合同/履约与受损/维修类图 → ../output/BSR设计需求文档_LaTeX/diagrams/classes-contract-damage.tex
Task: T019 [US2] 费用/结算与人员/运营类图 → ../output/BSR设计需求文档_LaTeX/diagrams/classes-finance-workforce.tex
```

这些任务的文件互不相同；不表示当前会话已经委派其他人或同时编辑。

## Implementation Strategy

**MVP first**：完成 T001–T007 后先交 US1 的五对业务流程和证据表，单独审阅组织愿景、现状真实性及蓝图职责。  
**Incremental**：US2 再给系统用例、六组类图、九张序列和六类状态；US3 最后将分析类映射为 ERD 和数据字典。每条故事有独立审阅记录，统一 PDF 只在三条故事内容稳定后编译定稿。  
**Stop conditions**：旧新 UC 语义未映射、现状无来源却写为事实、图与规约相反、或 PDF 图不可读时，不把该任务勾选完成。

## Notes

- `[P]` 仅表示任务处理不同文件、无未完成前置依赖；真正同时编辑时仍需遵守共享文件顺序。
- 任务完成才可将 `- [ ]` 改为 `- [x]`，并在审阅记录中附证据；本文件生成时全部未完成。
- 不初始化或上传 GitHub；运行演示与课堂分析设计文档分别验收。




