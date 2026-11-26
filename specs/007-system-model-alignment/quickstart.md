# Validation Quickstart: 需求与模型一致性

**Status**：实施核对版（2026-10-29）。现行 UC-01～UC-15 已接入 LaTeX；旧编号语义见《旧新用例映射》。本指南的 BSR 签字和生产验证仍为待办。

## 1 资料与工作目录

- 需求基线：`../usecase/requirement.txt`、`../usecase/系统规约.md`、`../usecase/项目大纲.md`（相对 `bsr-app/` 根目录）。
- 正式排版：`../output/BSR设计需求文档_LaTeX/main.tex`、`body.tex`、`updates/`、`media/`。
- 追溯规则：[traceability.md](contracts/traceability.md)；图示规则：[diagram-conventions.md](contracts/diagram-conventions.md)；领域实体底稿：[data-model.md](data-model.md)。

## 2 开始编辑前的盘点

在项目根目录（`BS滑雪租赁系统/`）使用 PowerShell：

```powershell
rg -n 'UC[0-9]{2}|UC-[0-9]{2}' 'output/BSR设计需求文档_LaTeX/body.tex' 'output/BSR设计需求文档_LaTeX/updates'
rg -n '\\includegraphics|\\input\{' 'output/BSR设计需求文档_LaTeX/main.tex' 'output/BSR设计需求文档_LaTeX/body.tex'
rg -n '^## UC-[0-9]{2}' 'usecase/系统规约.md'
```

预期：旧正文与新规约编号不一致会被列出。先填旧→新语义映射表，再修改图注和正文；不做仅按数字的全局替换。

## 3 模型审阅清单

1. 五个重点业务场景各有现状和改进序列。对现状图逐节点检查来源或“待访谈”；蓝图逐节点检查负责岗位、业务实体、系统动作与自动化的信息流。
2. UC-01～UC-15 均在系统用例图和追溯矩阵中；每个核心异常分支能在相关序列或状态图找到。
3. 六组类图分开审阅。随机抽取类的属性/操作，核对其来自规约字段、事件或规则；检查泛化、基数和关联方向。
4. 逐张核对订单、单件、准备/交付、鉴定、维修、押金/退款状态图的触发、守卫、责任和副作用。
5. 对每个模块 ERD 核 PK/FK/唯一/非空/检查及字段字典；专查单件不双占、当前店/归属店分离、合同和费率历史快照。

## 4 PDF 构建与视觉检查

完成图源、导出图和 TeX 更新后，使用 Codex 内置 LaTeX 编译器对 `output/BSR设计需求文档_LaTeX/` 编译；只有返回成功才算构建通过。再逐页查看 PDF，重点检查目录层级、图表编号、中文字体、裁切、跨页表格、色彩重点与参考示例的一致性。旧输出 PDF 不作为最新内容验收证据。

编译若失败，先修文件路径、未定义命令、图像和引用，再检查布局；最多按诊断逐步修复。视觉上不可读的图，即使编译成功也要重排或拆图。

## 5 系统行为交叉核对

当图或文字写“本地演示已实现”时，可在 `bsr-app/` 运行现有回归：

```powershell
node --test test/*.test.mjs
node test/preview-smoke.mjs
```

测试用于证明当前代码行为；不能证明 BSR 旧业务现状、正式收费政策、真实资金到账或合格电子签署。若代码与目标图不一致，更新 `docs/需求覆盖与升级审计.md`，标清“当前实现/目标缺口”，不要修改图义来掩盖差距。

## 6 完成记录

保存需求/旧编号映射、图源索引、编译诊断、PDF 审阅问题、自动/浏览器测试结果及 BSR 待签决策。所有未绘、未测、未访谈项目保留显式状态；不以空白或“默认完成”处理。
