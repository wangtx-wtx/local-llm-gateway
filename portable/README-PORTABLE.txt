Local LLM Gateway - Windows 便携版 / Windows Portable Edition
==============================================================

中文说明
--------

快速开始
1. 在解压前，右键下载的 ZIP →“属性”→勾选底部“解除锁定/Unblock”→“应用”。
2. 将 ZIP 完整解压到普通可写目录，不要直接在压缩包内运行。
3. 双击“启动网关.cmd”。
4. 浏览器会自动打开 http://127.0.0.1:8317/admin。
5. 在 Dashboard 中依次添加 Provider、API Key 和 Model。

Windows 11 的“智能应用控制”可能会阻止带有“来自 Internet”标记的 `.cmd` 或 `.ps1`
脚本。这不是网关启动失败，也不能由 `ExecutionPolicy Bypass` 解决。请务必在解压前解除
ZIP 的锁定；如果已经解压，请删除该目录、解除 ZIP 锁定后重新解压。也可在自己打开的
PowerShell 中执行以下命令，对已解压目录递归解除标记（请先把路径替换为实际目录）：

    Get-ChildItem -LiteralPath 'D:\Apps\LocalLLMGateway' -Recurse -File | Unblock-File

无需安装软件、无需管理员权限，也无需另外安装 Node.js。默认情况下，网关仅允许
本机访问。

首次启动后生成的文件
- .env                  本机配置
- data/gateway.db       配置和用量数据库
- data/master.key       已保存 Provider API Key 的加密主密钥
- logs/                 本机运行日志
- run/gateway.pid       进程记录文件

重要：必须将 data/gateway.db 与 data/master.key 一起备份。master.key 丢失后，
数据库内加密保存的 Provider API Key 无法恢复。

停止与升级
- 双击“停止网关.cmd”停止网关。
- 升级前先停止网关，并备份整个 data 文件夹。
- 将新版解压到新目录，只把旧版的 .env 和 data 文件夹复制过去。
- 绝对不要公开 .env、data/gateway.db、data/master.key 或 logs 文件夹。

安全提示
- 除非清楚网络暴露风险，否则保持 LOCAL_GATEWAY_HOST=127.0.0.1。
- 只从以下官方 Releases 页面下载：
  https://github.com/wangtx-wtx/local-llm-gateway/releases


English Instructions
--------------------

Quick start
1. Before extracting, right-click the downloaded ZIP → Properties → check **Unblock** at
   the bottom → Apply.
2. Fully extract the ZIP to a normal writable folder. Do not run it inside the ZIP.
3. Double-click "Start Gateway.cmd".
4. Your browser opens http://127.0.0.1:8317/admin automatically.
5. Add a Provider, API Key, and Model in the dashboard.

Windows 11 Smart App Control can block `.cmd` or `.ps1` scripts carrying the "from the
Internet" mark. This is not a gateway startup failure, and `ExecutionPolicy Bypass` cannot
override it. Unblock the ZIP before extracting. If it was already extracted, delete that
folder, unblock the ZIP, and extract it again. Alternatively, run this in a PowerShell window
you opened yourself, replacing the path with the extracted folder:

    Get-ChildItem -LiteralPath 'D:\Apps\LocalLLMGateway' -Recurse -File | Unblock-File

No installation, administrator permission, or separate Node.js installation is required.
The gateway is accessible only from this computer by default.

Files created after first launch
- .env                  local settings
- data/gateway.db       configuration and usage database
- data/master.key       encryption key for stored provider API keys
- logs/                 local process logs
- run/gateway.pid       process tracking file

IMPORTANT: Back up data/gateway.db and data/master.key together. If master.key is
lost, encrypted provider API keys in the database cannot be recovered.

Stopping and updating
- Double-click "Stop Gateway.cmd" to stop the gateway.
- Before updating, stop the gateway and back up the entire data folder.
- Extract the new version to a new folder, then copy only .env and data from the old version.
- Never publish .env, data/gateway.db, data/master.key, or the logs folder.

Security
- Keep LOCAL_GATEWAY_HOST=127.0.0.1 unless you understand network exposure.
- Download releases only from:
  https://github.com/wangtx-wtx/local-llm-gateway/releases
