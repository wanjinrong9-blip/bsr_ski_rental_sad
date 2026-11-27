# 设计需求文档可编辑源文件

当前版本 4.14，2026-11-27。保留六章目录、老师课件图形及原有配色；按《软件方法》上册第二版校核组织边界、业务价值、业务序列抽象级别、线型、实际系统执行者和可检测前后置条件。

Windows 环境需有宋体、黑体和楷体。安装 Tectonic 后在本目录执行 `tectonic main.tex`。成品为 `main.pdf`；父目录的 4.14 PDF 为已编译审阅版。`updates/` 与 `diagrams/` 保存可编辑 TikZ 图源。核心 UC-01～15 从 `docs/requirements/系统规约.md` 生成：在仓库根运行 `python tools/render_uc_spec.py`，再编译，避免修改旧输出目录造成 PDF 与规约漂移。

AppID 为公开标识，不含 AppSecret。照片授权 API 的本机测试不代表微信真机验收。
