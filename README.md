# Local LLM Gateway

[![CI](https://github.com/wangtx-wtx/local-llm-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/wangtx-wtx/local-llm-gateway/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.13-339933.svg)](https://nodejs.org/)

一个本地多模型 LLM API 网关:协议兼容层 + 模型控制平面 + API Key 池 + 用量记账 + 可观测性 Dashboard。

```
Agent / IDE / SDK  ──►  http://127.0.0.1:8317/v1  ──►  多 Provider / 多模型 / 多 Key
```

- 客户端只需 `model = "glm-5.3"` 或别名 `"coding"`,无需关心上游是谁、什么协议、哪个 Key。
- 同时对外暴露 **OpenAI Chat Completions**、**OpenAI Responses**、**Anthropic Messages** 三种协议；通过统一 Canonical Protocol 提供自动兼容转换。转换并非所有协议专属能力的无损映射，具体范围见下方说明。
- 后台动态添加 Provider / Model / API Key / Alias,**不重启即生效**(Registry Snapshot 原子热替换)。
- Token 用量按 **Model / Provider / API Key / Key×Model** 记账,区分 `0`(供应商明确为 0)与 `—`(未提供),区分 **Exact / Estimated**,区分 **Logical Request Usage**(客户端最终收到)与 **Upstream Attempt Usage**(供应商实际计费)。

## 协议转换范围 / Protocol conversion scope

网关的适配器和路由架构支持三种客户端协议与三种上游原生协议之间的 `3 × 3`
转换。这里的“支持”表示存在 Canonical 转换代码路径，**不表示所有组合均已通过同等级
端到端测试，也不表示协议专属功能能够无损转换**。

The adapter and routing architecture implements a `3 × 3` conversion path between the
three client protocols and three native upstream protocols. “Implemented” does **not** mean
that every combination has equivalent end-to-end coverage or lossless feature fidelity.

| 上游原生协议 / Native upstream | Chat 客户端 | Responses 客户端 | Anthropic 客户端 |
|---|---|---|---|
| OpenAI Chat Completions | 已端到端验证 / E2E verified | 已端到端验证 / E2E verified | 已端到端验证 / E2E verified |
| OpenAI Responses | 代码路径已实现 / Implemented | 代码路径已实现 / Implemented | 代码路径已实现 / Implemented |
| Anthropic Messages | 代码路径已实现 / Implemented | 代码路径已实现 / Implemented | 代码路径已实现 / Implemented |

当前同等级端到端证据使用的是内置 Chat-only 假上游；尚未对 Responses 原生上游、
Anthropic 原生上游的全部交叉组合和真实第三方供应商完成同等级验证。

Current equivalent E2E evidence uses the bundled chat-only fake upstream. The complete
cross-product for native Responses and native Anthropic upstreams, and real third-party
provider behavior, has not yet been verified to the same standard.

主要降级项 / Important fidelity limits:

- 可靠的跨协议工具抽象是 function calling；Web Search、Computer Use、File Search、MCP 等托管工具不会跨协议保留。
- Responses 的 `previous_response_id`/服务端状态不能由 Chat 或 Anthropic 上游模拟。
- Anthropic document、推理签名、图片工具结果以及部分 Responses 专属字段可能被降级或丢弃。
- 模型的某个协议模式可由管理员设为 `unsupported`，此时对应接口会明确拒绝，而非转换。
- Function calling is the portable tool abstraction; hosted tools such as Web Search, Computer Use, File Search, and MCP are not preserved across protocols.
- Responses server-side state such as `previous_response_id` cannot be emulated by Chat or Anthropic upstreams.

完整限制请阅读 [协议兼容矩阵](docs/PROTOCOLS.md#compatibility-matrix) 和
[Responses 兼容说明](docs/RESPONSES_COMPATIBILITY.md#what-cannot-be-emulated)。

## 快速开始

### Windows 便携版（推荐普通用户）

无需安装 Node.js，也不需要管理员权限：

1. 在 [Releases](https://github.com/wangtx-wtx/local-llm-gateway/releases) 下载文件名包含 `windows-x64-portable.zip` 的压缩包。
2. 完整解压到一个可写目录，不要直接在 ZIP 内运行。
3. 双击 `启动网关.cmd`（或 `Start Gateway.cmd`）。
4. 浏览器会自动打开 Dashboard；依次添加 Provider、API Key 和 Model。

停止时双击 `停止网关.cmd`。首次启动产生的 `.env`、`data/gateway.db` 和
`data/master.key` 只保存在解压目录中。升级前请停止网关，并将数据库与
`master.key` **一起备份**。详细说明见 [Windows 便携版指南](docs/WINDOWS_PORTABLE.md)。

**English:** Download the `windows-x64-portable.zip` asset from
[Releases](https://github.com/wangtx-wtx/local-llm-gateway/releases), fully extract it,
and double-click `Start Gateway.cmd`. No administrator permission or separate Node.js
installation is required. Back up `data/gateway.db` and `data/master.key` together.
See the [bilingual Windows portable guide](docs/WINDOWS_PORTABLE.md) for details.

### 源码运行

```bash
# 需要 Node >= 22.13.0(内置 node:sqlite 自 22.13 起无需 --experimental-sqlite)
# 生产部署建议使用 Node 24 LTS
npm install
npm run build
npm start          # http://127.0.0.1:8317
```

可选:预先生成固定主密钥(否则首次启动会自动生成 `./data/master.key`):

```bash
node dist/config/generate-key.js
# 将输出填入 .env 的 LOCAL_GATEWAY_MASTER_KEY
```

想要 Dashboard 界面,再执行一次前端构建(可选):

```bash
npm run build:web        # 产物在 web/dist,由网关直接托管
```

启动后:

| 用途 | 地址 |
|---|---|
| OpenAI 兼容 | `http://127.0.0.1:8317/v1` |
| Responses | `http://127.0.0.1:8317/v1/responses` |
| Anthropic Messages | `http://127.0.0.1:8317/v1/messages` |
| 模型列表 | `http://127.0.0.1:8317/v1/models` |
| Dashboard | `http://127.0.0.1:8317/admin` |
| 管理 API | `http://127.0.0.1:8317/api/admin` |
| Metrics | `http://127.0.0.1:8317/metrics` |
| 健康检查 | `http://127.0.0.1:8317/health` / `/ready` |

> Dashboard 支持**中英文切换**,按钮在右上角,选择会记入浏览器本地存储。

> 首次启动会自动生成 `./data/master.key`(用于 AES-256-GCM 加密 API Key 秘密)。
> **请务必备份该文件:丢失后数据库中已加密的密钥将无法解密。**

首次启动时没有任何 Provider / Model,`/v1/models` 返回空列表。请先在 Dashboard 的
**Providers** 页面添加一个上游端点,再在 **Models** 页面注册模型,即可开始调用。

## 配置

参考 `.env.example`。全部环境变量以 `LOCAL_GATEWAY_` 前缀:

| 变量 | 默认 | 说明 |
|---|---|---|
| `LOCAL_GATEWAY_HOST` | `127.0.0.1` | 监听地址。设为非回环地址时**必须**同时配置下方两个密钥,否则拒绝启动 |
| `LOCAL_GATEWAY_PORT` | `8317` | 监听端口 |
| `LOCAL_GATEWAY_DB_PATH` | `./data/gateway.db` | SQLite 数据库(WAL 模式) |
| `LOCAL_GATEWAY_API_KEY` | — | 客户端访问 `/v1` 的密钥(`Authorization: Bearer` 或 `x-api-key`) |
| `LOCAL_GATEWAY_ADMIN_PASSWORD` | — | Dashboard / 管理 API 密码(逐请求以 `x-admin-password` 头校验) |
| `LOCAL_GATEWAY_MASTER_KEY` | 自动生成 | API Key 秘密加密主密钥(32 字节 base64 或 hex) |
| `LOCAL_GATEWAY_LOG_LEVEL` | `INFO` | `DEBUG` / `INFO` / `WARN` / `ERROR` |
| `LOCAL_GATEWAY_PERSIST_LOGS` | `true` | 是否将结构化日志写入 `logs` 表供 Dashboard 查询 |
| `LOCAL_GATEWAY_REQUEST_TIMEOUT_MS` | `120000` | 上游响应头超时 |
| `LOCAL_GATEWAY_CONNECT_TIMEOUT_MS` | `15000` | 上游 TCP 连接超时 |
| `LOCAL_GATEWAY_STREAM_IDLE_TIMEOUT_MS` | `120000` | 流式响应空闲超时(超过则中断上游) |
| `LOCAL_GATEWAY_MAX_CONCURRENT_REQUESTS` | `16` | Provider 级默认并发上限 |
| `LOCAL_GATEWAY_MAX_QUEUE_SIZE` | `256` | 每层信号量默认排队上限(超出返回 429) |
| `LOCAL_GATEWAY_MAX_BODY_BYTES` | `33554432` | 请求体大小上限(32 MiB) |
| `LOCAL_GATEWAY_TOTAL_DEADLINE_MS` | `600000` | 单次上游尝试的硬性截止时间 |

> 并发、重试、退避、熔断阈值、选 Key 策略等运行期参数在 Dashboard 的 **Settings** 页面配置,
> 保存在数据库内,保存即生效,无需重启。

## 客户端使用示例

OpenAI SDK:

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8317/v1", api_key="any")
r = client.chat.completions.create(model="glm-5.3", messages=[{"role":"user","content":"你好"}])
```

Responses API(**即使上游模型只支持 Chat Completions 也能用**,网关会做完整的状态机仿真):

```bash
curl http://127.0.0.1:8317/v1/responses -H 'content-type: application/json' -d '{
  "model": "glm-5.3",
  "input": "你好",
  "stream": true
}'
```

Anthropic Messages:

```bash
curl http://127.0.0.1:8317/v1/messages -H 'content-type: application/json' -d '{
  "model": "coding",
  "max_tokens": 512,
  "messages": [{"role":"user","content":"你好"}]
}'
```

配置了 `LOCAL_GATEWAY_API_KEY` 后,请为上述请求加上 `-H "authorization: Bearer <key>"`。

## 开发

```bash
npm run dev            # tsc --watch
npm run verify         # typecheck + lint + test + 打包配置校验
npm test               # 全部测试
npm run test:unit      # 单元测试
npm run test:integration
npm run test:acceptance  # 任务书 §96 验收测试
```

### 端到端自检脚本

`scripts/smoke.mjs` 与 `scripts/check-concurrency.mjs` 用于检查**已经在运行**的网关,
它们**不会**自行启动网关。请先在另一个终端启动服务:

```bash
npm run build && npm start          # 终端 A:启动网关 (http://127.0.0.1:8317)

npm run smoke                       # 终端 B:三协议 + 记账 + 热添加模型
npm run check:concurrency           # 终端 B:并发排队与队列指标
```

脚本会自带一个 chat-only 的假上游并按 Dashboard 的方式通过管理 API 注册它,
因此不需要任何真实 API Key。若网关不在默认地址:

```bash
node scripts/smoke.mjs http://127.0.0.1:9000
```

前端开发(需要网关已在 8317 运行,dev server 会代理 API):

```bash
npm run build:web               # 生产构建
npm --prefix web run dev        # 热更新开发服务器
```

## 文档

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 架构、请求生命周期、重试/降级决策树
- [docs/PROTOCOLS.md](docs/PROTOCOLS.md) — 三协议与 Canonical 转换、兼容性矩阵
- [docs/RESPONSES_COMPATIBILITY.md](docs/RESPONSES_COMPATIBILITY.md) — Responses 兼容层状态机细节
- [docs/PROVIDERS.md](docs/PROVIDERS.md) — 各类型 Provider 接入方式
- [docs/DATABASE.md](docs/DATABASE.md) — SQLite Schema 与双账本记账模型
- [docs/SECURITY.md](docs/SECURITY.md) — 威胁模型与安全边界
- [docs/TESTING.md](docs/TESTING.md) — 测试策略、国际化约定与扩展方式
- [docs/WINDOWS_PORTABLE.md](docs/WINDOWS_PORTABLE.md) — Windows 便携版下载、启动、升级与安全说明

## Docker

```bash
cp .env.example .env
# 必填:容器内绑定 0.0.0.0,因此下面两项必须设置,否则网关拒绝启动
#   LOCAL_GATEWAY_API_KEY=...
#   LOCAL_GATEWAY_ADMIN_PASSWORD=...
docker compose up -d --build
```

数据(数据库与 `master.key`)保存在名为 `gateway-data` 的卷中。**请与数据库一同备份该卷。**

## License

[MIT](LICENSE)。安全问题请按照 [SECURITY.md](SECURITY.md) 私下报告；参与开发请阅读
[CONTRIBUTING.md](CONTRIBUTING.md)。
