# 本地备份命令契约

`node tools/backup-verify.mjs [--source PATH] [--output DIRECTORY]`

缺省源为 `data/bsr.sqlite`，缺省输出为 `data/backups/`。成功时输出一行 JSON，含备份绝对路径、清单绝对路径、SHA-256、验证状态与核心表行数；失败时写标准错误并返回非零代码，不输出顾客内容。备份文件与清单仅在完整性检查及隔离恢复演练通过后发布。该命令不覆盖原库、不删除旧文件、不上传网络。
