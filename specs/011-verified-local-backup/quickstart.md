# 验证本地备份

在项目根目录运行 `npm run backup`（或 `node tools/backup-verify.mjs`）。命令只读源库，默认把 `.sqlite` 和 `.sqlite.json` 清单写入被 Git 忽略的 `data/backups/`。成功输出 `integrity: "ok"`、`foreignKeyErrors: 0`、`restoreDrill: "PASS"` 及关键表记录数。

运行 `node --test test/backup-restore.test.mjs` 验证 WAL 内已提交数据、BLOB、独立恢复副本、哈希核对，以及成功和失败路径均不遗留临时 WAL/SHM 文件。运行 `node --test test/*.test.mjs` 检查业务回归。可在备份时另开终端请求 `/api/health`，预览应继续返回 200。

备份仍含顾客资料、会话和照片，仅供本机课程预览及恢复演练。不要复制到公开仓库或静态目录。正式部署另需加密、异地副本、密钥管理、保留期限、自动调度及恢复时间目标。
