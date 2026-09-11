# Windows 便携版

便携版面向只想直接使用网关的 Windows 用户。它自带经过 SHA-256 校验的官方
Node.js 运行时，不需要运行 `npm install`，不需要管理员权限，也不会安装系统服务。

## 下载和启动

1. 打开项目的 [Releases](https://github.com/wangtx-wtx/local-llm-gateway/releases)。
2. 下载 `local-llm-gateway-v*-windows-x64-portable.zip`。
3. 将 ZIP **完整解压**到普通可写目录，例如 `D:\Apps\LocalLLMGateway`。
4. 双击 `启动网关.cmd` 或 `Start Gateway.cmd`。
5. 等待浏览器自动打开 `http://127.0.0.1:8317/admin`。
6. 在 Dashboard 中依次添加 Provider、API Key 和 Model。

默认只监听 `127.0.0.1`，局域网中的其他设备无法直接访问。不要为了省事把监听地址
改成 `0.0.0.0`；如确需网络访问，必须同时设置网关 API Key、管理密码并配置防火墙。

## 常用操作

- 启动：双击 `启动网关.cmd`。
- 打开 Dashboard：双击 `打开管理界面.cmd`。
- 停止：双击 `停止网关.cmd`。
- 查看启动错误：打开 `logs\gateway.stderr.log`。

启动脚本只会停止由当前便携目录启动的 Node.js 进程。若 PID 被其他程序复用，它会
拒绝停止，避免误杀电脑上的其他 Node.js、Claude Code 或网关进程。

## 数据和备份

首次启动后会在便携目录中生成：

| 文件 | 用途 |
|---|---|
| `.env` | 本机环境配置，可能包含访问凭据 |
| `data/gateway.db` | Provider、模型、加密后的 API Key 和用量记录 |
| `data/master.key` | 解密数据库中 Provider API Key 的主密钥 |
| `logs/` | 本机运行日志 |

必须将 `gateway.db` 与 `master.key` 一起备份。`master.key` 丢失后，数据库中的加密密钥
无法恢复。不要把 `.env`、`data/` 或日志上传到 GitHub，也不要发送给其他人。

## 升级

1. 双击旧目录中的 `停止网关.cmd`。
2. 备份旧目录的 `.env` 和整个 `data` 文件夹。
3. 将新版本 ZIP 解压到一个新目录。
4. 把旧版本的 `.env` 和 `data` 文件夹复制到新目录。
5. 双击新目录中的 `启动网关.cmd`。

不要直接覆盖仍在运行的目录。保留旧目录直到确认新版本运行正常。

## 校验下载文件

每个 ZIP 都附带同名的 `.sha256` 文件。可在 PowerShell 中执行：

```powershell
Get-FileHash .\local-llm-gateway-v*-windows-x64-portable.zip -Algorithm SHA256
```

将输出与 `.sha256` 文件中的值比较。发布包只应从本项目 GitHub Releases 下载。

## 开发者打包

```powershell
npm ci
npm --prefix web ci
npm run build:all
npm run build:portable
```

脚本会从 Node.js 官方站点下载固定版本的 Windows x64 运行时，验证官方 SHA-256，
然后生成 `artifacts/` 下的 ZIP 与校验文件。打包前还会检查敏感运行时文件，发现
`.env`、数据库、`master.key`、私钥或证书文件时立即失败。

---

# Windows Portable Edition (English)

The portable edition is intended for Windows users who want to run the gateway directly.
It includes an official Node.js runtime verified against the publisher's SHA-256 list. It
does not require `npm install`, administrator permission, or a system service.

## Download and start

1. Open the project's [Releases](https://github.com/wangtx-wtx/local-llm-gateway/releases).
2. Download `local-llm-gateway-v*-windows-x64-portable.zip`.
3. Fully extract the ZIP to a normal writable folder, such as `D:\Apps\LocalLLMGateway`.
4. Double-click `Start Gateway.cmd`.
5. Wait for the browser to open `http://127.0.0.1:8317/admin` automatically.
6. Add a Provider, API Key, and Model in the dashboard.

The default bind address is `127.0.0.1`, so other devices on the local network cannot
connect directly. Do not change it to `0.0.0.0` merely for convenience. Network access
requires a gateway API key, an administrator password, and appropriate firewall rules.

## Common operations

- Start: double-click `Start Gateway.cmd`.
- Open the dashboard: double-click `Open Dashboard.cmd`.
- Stop: double-click `Stop Gateway.cmd`.
- View startup errors: open `logs\gateway.stderr.log`.

The stop script verifies both the executable path and command line. It refuses to stop a
PID that does not belong to this portable directory, preventing accidental termination of
another Node.js process, Claude Code session, or gateway.

## Data and backups

The first launch creates:

| File | Purpose |
|---|---|
| `.env` | Local configuration that may contain credentials |
| `data/gateway.db` | Providers, models, encrypted API keys, and usage records |
| `data/master.key` | Master key used to decrypt provider API keys in the database |
| `logs/` | Local runtime logs |

Always back up `gateway.db` and `master.key` together. Encrypted API keys cannot be
recovered if `master.key` is lost. Never upload `.env`, `data/`, or logs to GitHub, and do
not send them to other people.

## Updating

1. Double-click `Stop Gateway.cmd` in the old directory.
2. Back up `.env` and the entire `data` folder.
3. Extract the new ZIP to a new directory.
4. Copy `.env` and `data` from the old directory into the new directory.
5. Double-click `Start Gateway.cmd` in the new directory.

Do not overwrite a directory while the gateway is running. Keep the old directory until
the new version has been verified.

## Verifying the download

Each ZIP has a matching `.sha256` file. Run this command in PowerShell:

```powershell
Get-FileHash .\local-llm-gateway-v*-windows-x64-portable.zip -Algorithm SHA256
```

Compare the output with the value in the `.sha256` file. Download portable packages only
from this project's GitHub Releases page.

## Building the package

```powershell
npm ci
npm --prefix web ci
npm run build:all
npm run build:portable
```

The builder downloads a pinned Windows x64 Node.js runtime from the official website,
verifies its official SHA-256, and writes the ZIP and checksum to `artifacts/`. Packaging
fails if `.env`, a database, `master.key`, a private key, or a certificate enters the bundle.
