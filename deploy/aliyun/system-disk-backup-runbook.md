# 单系统盘 SHOWCASE：备份与异机恢复演练

更新：2026-11-24。适用于已购的 2 vCPU / 2 GiB / 40 GiB、只有系统盘的 Ubuntu 轻量服务器。本文件是**目标机操作步骤**，目前仅依据本机实现和测试编写；尚未在阿里云实例执行。网站 80/443 保持关闭，systemd 服务保持禁用。以下仅使用独立合成数据，不复制本机 DEMO 数据库或真实顾客资料。

## 验收门槛

1. 目标机安装项目要求的 Node.js 24 或更新版本，并在私有目录中建立独立合成库。数据库在 `/var/lib/bsr/data/showcase.sqlite`，本机暂存备份在 `/var/lib/bsr/backups/`；两目录及文件仅允许 `bsr` 服务账号和必要管理员访问。项目代码在 `/opt/bsr/app`，不得把 `data/` 放进公开静态目录。
2. 选定**独立于这台服务器和系统盘**、有访问控制与静态加密的备份目的地及另一台可执行恢复的机器。只在本机 `/var/lib/bsr/backups/` 留副本不满足本门槛；阿里云同实例快照也不替代异机副本。备份与清单均可能含敏感业务信息，不上传 Git、聊天或公开对象存储。
3. 在目标机生成一致性备份；将备份和同名 `.json` 清单通过已批准的加密通道送到异机；在**另一台机器**恢复到一个原本不存在的文件，得到 `status=ready`、`runMode=showcase`、来源实例 ID 一致，且旧会话被撤销。
4. 留存私有演练记录：备份/清单 SHA-256、源机与恢复机身份、演练时间、操作员、结果、恢复耗时、可恢复的数据截止时间。记录不应包含口令、会话、代理密钥、数据库正文或顾客资料。确定恢复目标与备份频率后，再由业务方批准恢复时间目标（RTO）和恢复点目标（RPO）。

## 目标服务器：生成一致性备份

先确认 `node --version` 满足项目 `package.json` 中的 `>=24`，`df -h /var/lib/bsr /tmp` 有足够空间，`systemctl is-enabled bsr-showcase-system-disk` 仍为 `disabled`。备份过程会在本机产生临时快照和校验副本，应为这些额外文件保留空间；不要在磁盘快满时执行或启用服务。

以有权读取合成数据库、写入私有备份目录的账号，在项目目录执行：

```sh
cd /opt/bsr/app
node tools/backup-verify.mjs \
  --source /var/lib/bsr/data/showcase.sqlite \
  --output /var/lib/bsr/backups
```

命令返回备份 `.sqlite` 与同名 `.sqlite.json` 清单路径、哈希和 `restoreDrill: PASS`。这只证明**同机**生成、完整性和隔离副本检查成功，不能证明异机备份。不要把命令的完整输出贴到公开位置。失败时停止，不传送不完整文件，也不启用服务。

将**这两个文件作为一组**传至选定的异机目的地；传输、目标存储加密及权限由经批准的备份系统提供。传输完成后在异机对两文件分别计算 SHA-256，与源机私有记录比较。只复制其中一件或哈希不一致都视为失败。

## 独立恢复机：离线恢复

在不同机器取得同一版本的应用源码，安装 Node.js 24 或更新版本。建立仅操作员可访问的 `/var/lib/bsr/backups` 和 `/var/lib/bsr/recovery-drill`，把已核对的备份及清单放入前者。恢复目标 `/var/lib/bsr/recovery-drill/restored.sqlite` **必须不存在**；若它存在，换新的演练目录，不能删除或覆盖未知文件。恢复机不需要公开 Web 端口，也不启动 Nginx 或 BSR 服务。

在私有交互终端设定**恢复机独有**的临时环境。`BSR_PUBLIC_ORIGIN` 只为通过本地配置结构核验，`restore.example.invalid` 不解析到真实站点；代理密钥在该终端随机生成，不能复制源服务器密钥：

```sh
cd /opt/bsr/app
export BSR_RUN_MODE=showcase
export BSR_CANDIDATE_TRANSPORT=trusted-local-proxy
export HOST=127.0.0.1
export PORT=4175
export BSR_PUBLIC_ORIGIN=https://restore.example.invalid
export BSR_DB_PATH=/var/lib/bsr/recovery-drill/restored.sqlite
export BSR_BACKUP_DIR=/var/lib/bsr/backups
export BSR_PROXY_SECRET="$(openssl rand -hex 32)"
export BSR_RESTORE_OPERATOR=recovery-drill
node tools/showcase-restore.mjs \
  --backup /var/lib/bsr/backups/REPLACE_WITH_VERIFIED_BACKUP.sqlite \
  --manifest /var/lib/bsr/backups/REPLACE_WITH_VERIFIED_BACKUP.sqlite.json
node tools/showcase-setup.mjs preflight
```

将 `REPLACE_WITH_VERIFIED_BACKUP` 换为同一批文件的实际名称。运行前检查本机路径、账号和环境变量；不要在源机执行这一恢复命令。恢复程序会检查清单与文件哈希、SQLite 完整性、外键、SHOWCASE 合成来源，并在**新恢复文件**内撤销旧 Web 和小程序会话；它拒绝覆盖现有目标。演练完成后由操作员按保留策略处理恢复机上的敏感副本，不得把恢复库作为网页演示数据直接开放。

## 判定与启用

只有异机文件哈希匹配、恢复命令和随后 `preflight` 均成功，并核对来源实例 ID、合成标记和关键业务记录后，才记录“异机恢复通过”。再完成 2 GiB 容量、Nginx/systemd 原生语法、防火墙、访问控制、日志脱敏和业务流程验收；ICP备案与发布决定另行满足。在此之前保持 `bsr-showcase-system-disk.service` 禁用，80/443 不开放。

现有本机证据见 `test/018-showcase-restore.test.mjs`、`test/019-recovery.test.mjs`；它们证明程序对正确备份、错误哈希、错误来源、已有目标和会话撤销的处理，**不证明本次阿里云目标机或异机存储已通过**。
