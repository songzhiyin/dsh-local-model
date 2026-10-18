# dsh-local-model

**让 DeepSeek Harness 直连本地模型 —— 不用登录账号，也不消耗云端 token。**

[![npm](https://img.shields.io/npm/v/dsh-local-model?color=blue)](https://www.npmjs.com/package/dsh-local-model)
[![license](https://img.shields.io/npm/l/dsh-local-model)](./LICENSE)
[![node](https://img.shields.io/node/v/dsh-local-model)](./package.json)
[![DSH](https://img.shields.io/badge/DSH-%5E0.2.0--rc.2-6c5ce7)](https://github.com/deepseek-ai/deepseek-harness)

> A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that connects the
> harness to **local models** through any OpenAI-compatible endpoint or Ollama's native API.
> No account sign-in, no cloud token consumption. · [English](#english) section below.

---

## 目录

- [这个插件做什么](#这个插件做什么)
- [支持的本地后端](#支持的本地后端)
- [安装](#安装)
- [快速开始](#快速开始)
- [配置项](#配置项)
- [常见问题](#常见问题)
- [工作原理](#工作原理)
- [开发与发布](#开发与发布)
- [License](#license)

## 这个插件做什么

DeepSeek Harness 默认走 DeepSeek 云端模型。本插件注册一个自定义 LLM 适配器（provider 路由 `local`），
把 Harness 的模型请求**直接转发到你本机的推理服务**：

- 🚫 **零账号依赖** —— 完全不访问 `api.deepseek.com` 或任何账号接口，不读取账号凭据，因此不产生任何云端计费。
- 🔌 **双传输协议** —— OpenAI 兼容协议 + Ollama 原生协议，两者都支持。
- 🧰 **完整工具调用** —— 正确转换 Harness 的工具调用/工具结果历史，Agent 的 bash、文件、子代理等工具都能正常用。
- 🩹 **文本工具调用兜底** —— 部分本地模型（如 `qwen2.5-coder`）会把工具调用写成纯文本 JSON，插件会自动识别并转成真正的工具调用。
- 🔍 **模型自动发现** —— 自动从本地端点拉取模型列表（Ollama `/api/tags`、OpenAI `/v1/models`）。
- ⚡ **热更新** —— 所有配置字段都是 volatile，改完无需重启。
- 🖥️ **可视化界面** —— 自带浏览器端 UI：在「设置 → 模型」的 **Local Model** 卡片里可直接
  **测试连接**并列出本机可用模型；插件配置也在图形界面里完成，无需手改配置文件。

## 支持的本地后端

| 后端 | `api` | `baseURL` |
| --- | --- | --- |
| **Ollama（原生，推荐）** | `ollama` | `http://127.0.0.1:11434` |
| **Ollama（OpenAI 端点）** | `openai` | `http://127.0.0.1:11434/v1` |
| **LM Studio** | `openai` | `http://localhost:1234/v1` |
| **llama.cpp server** | `openai` | `http://localhost:8080/v1` |
| **vLLM / SGLang** | `openai` | `http://localhost:8000/v1` |
| **LocalAI / text-generation-webui** | `openai` | `<你的端点>/v1` |

> **优先推荐直接使用本地模型**：只要后端提供 OpenAI 兼容端点，就用 `openai` 模式直连；
> 用 Ollama 且想要原生 `thinking`/reasoning 支持时，用 `ollama` 模式。

## 安装

### 方式 A：命令行安装（推荐）

```bash
dsh plugin --profile web add dsh-local-model
```

> 其中 `web` 是 profile 名；桌面版通常为 `desktop`，请按你的 profile 调整。

### 方式 B：在 Harness 界面里安装

打开 **设置 → 插件市场**（或 **插件** 页），搜索 `dsh-local-model`，点击一键安装。
大多数插件安装后刷新页面即可生效，无需重启。

### 方式 C：从 GitHub 安装

```bash
dsh plugin --profile web add github:<songzhiyin>/dsh-local-model
```

### 方式 D：手动安装（无需发布）

```bash
# 1. 克隆到 profile 之外任意目录
git clone https://github.com/songzhiyin/dsh-local-model.git

# 2. 在 profile 里把它作为本地 link 安装
cd ~/.dsh/profiles/desktop
pnpm add link:/绝对路径/dsh-local-model

# 3. 编辑 ~/.dsh/profiles/desktop/package.json，
#    在 dsh.profile.bundles 里加入 "dsh-local-model"

# 4. 重启 Harness（或在插件页刷新）
```

## 快速开始

以 Ollama 为例：

```bash
# 1. 启动 Ollama 并拉取一个带 tools 能力的模型
ollama serve
ollama pull qwen2.5-coder:14b

# 2. 安装插件（见上一节）
dsh plugin --profile web add dsh-local-model
```

然后在 Harness 里：

1. **设置 → 模型** → 找到 **Local Model** provider，确认端点（默认 `http://127.0.0.1:11434/v1`）；
2. 打开任意会话，在**模型选择器**里把 provider 切到 **Local Model**，选一个模型；
3. 直接开始对话即可 —— 全程本地推理。

> 💡 跑 Agent 工具调用建议选**原生支持 function calling** 的模型（如 `qwen3-coder`、`llama3.1`、`devstral`）；
> 若模型只会把工具调用写成文本（如部分 `qwen2.5-coder` 版本），插件内置的兜底也会把它转成真正的工具调用。

## 配置项

在 **插件页 → dsh-local-model → 配置**，或 **设置 → 模型 → Local Model** 中设置：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `api` | `"openai" \| "ollama"` | `"openai"` | 传输协议 |
| `baseURL` | string | `http://127.0.0.1:11434/v1` | 本地端点根地址；留空按 `api` 自动选择 |
| `apiKey` | string | `""` | 本地服务需要鉴权时填写（如 LM Studio 的 key） |
| `defaultModel` | string | `""` | 端点无法枚举模型时的兜底模型名 |
| `contextWindow` | integer | `8192` | 默认上下文窗口（token） |
| `maxTokens` | integer | `2048` | 默认单次最大输出 token 数 |
| `temperature` | number | `0.7` | 默认采样温度（0–2） |
| `streamIdleTimeoutMs` | number | `300000` | 流式读取空闲超时（毫秒） |
| `models` | array | `[]` | 静态模型清单，用于端点不支持列表查询时手动声明 |

`models` 示例：

```json
[
  { "id": "qwen2.5-coder:14b", "name": "Qwen2.5-Coder 14B", "contextWindow": 32768, "maxTokens": 4096 }
]
```

## 可视化界面

插件包含一个浏览器端半身（`lib/client.js`），它向「设置 → 模型」页的 provider 卡片扩展槽位
`settings.models.provider-card`（keyed，key = `dsh-local-model`）注册一张卡片：

```
┌─ 本地模型连接测试 ─────────────────────────────────┐
│ provider: local · 名称: Local Model · 已配置: 是    │
│ 协议  [ openai（OpenAI 兼容） ▾ ]                   │
│ 端点  [ http://127.0.0.1:11434/v1 ]  [ 测试连接 ]   │
│ ✅ 连接成功，发现 4 个模型                           │
│ (qwen3-coder:30b) (llama3.1:8b) …                   │
└────────────────────────────────────────────────────┘
```

- 切换 `openai` / `ollama` 协议会自动填入对应的默认端点；
- 「测试连接」分别请求 `/models` 或 `/api/tags`，直接显示可用模型列表；
- 失败时给出可操作的提示（服务未启动 / 地址错误 / CORS 跨域）。

> 该卡片只做连通性验证；**api / baseURL / apiKey 等配置仍由上方「编辑」按钮的配置表单负责**（由插件
> 的 `Config` schema 自动渲染）。

客户端半身是**手写的 Lazy-CJS bundle**（`window.__ModuleLoader__.load({ id, factory })`），
只依赖平台模块表里的 `react`，不需要任何打包步骤、也不需要 `dsh.client.external`。

## 常见问题

**Q：模型列表是空的？**
确认本地服务已启动且 `baseURL` 正确。若端点不支持 `/models`（或 `/api/tags`），请在 `models` 里手动声明。

**Q：报 `AUTH` 错误？**
说明本地服务需要鉴权，把 key 填进 `apiKey`。

**Q：模型把工具调用当纯文本吐出来（`{"name":"skill","arguments":{...}}`）？**
这是该模型的工具调用能力问题，不是插件问题。插件已内置**文本工具调用兜底**：会识别 `{...}` JSON、
`<tool_call>...</tool_call>`、` ```json {...} ``` ` 三种写法，并在工具名匹配时自动转成真正的工具调用。
如果仍不稳定，建议换用原生支持 function calling 的模型。

**Q：reasoning / 思考内容怎么显示？**
`openai` 模式读取 `reasoning_content`，`ollama` 模式读取 `thinking`，都会映射为 Harness 的 reasoning 块。

**Q：长对话被截断？**
多数本地服务有自己的上下文上限（Ollama 默认 `num_ctx=4096`）。可以用环境变量放宽，例如
`OLLAMA_CONTEXT_LENGTH=32768 ollama serve`，或改用长上下文模型（如 `devstral`）。

**Q：「测试连接」报 `Failed to fetch`，但命令行 `curl` 明明能通？**
这是 **`localhost` 的 IPv6 陷阱**：在部分环境下 `localhost` 会先解析到 IPv6 `::1`，
而 Ollama 等本地服务通常只监听 IPv4 `127.0.0.1`，于是浏览器直连失败。

本插件已内置两道防护：

1. **探测默认走宿主进程**（`ctx.get("remote.llm").discoverModels()`）——由 Node 侧发起请求，
   完全绕开浏览器的 CORS / IPv6 / Electron 网络策略；
2. 默认地址一律用 **`127.0.0.1`** 而不是 `localhost`，并对回环地址做
   `localhost ⇄ 127.0.0.1` 的自动兜底重试。

如果你在配置里手写了 `localhost`，建议改成 `127.0.0.1`。

## 工作原理

插件通过 `ctx.llm.registerAdapter(["local"], adapter)` 注册一个 `LlmAdapter`，把 Harness 的
`GenerateOptions` 翻译成目标协议的请求，再把流式响应翻译回 Harness 的 `StreamChunk`
（`block-start` / `text-delta` / `reasoning-delta` / `tool-call-delta` / `block-end` / `usage` / `finish`）。

- 不访问任何 DeepSeek 云端端点；
- 不读取账号凭据，因此不产生云端 token 消耗；
- 文件引用与图片由 Harness 运行时自动投影为文本句柄（文本模型），适配器只需处理文本与工具调用。

## 开发与发布

```bash
git clone https://github.com/songzhiyin/dsh-local-model.git
cd dsh-local-model

# 本地 link 到你的 DSH profile 做开发（改代码即时生效）
cd ~/.dsh/profiles/desktop
pnpm add link:/绝对路径/dsh-local-model
```

发布到 npm：

```bash
npm publish          # publishConfig.access 已设为 public
```

上架插件市场（可选，让更多人发现）：
向 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 仓库提交一个 PR，
加入一条注册表条目（`name` / `owner` / `url` / `category` / `description` / `npm` / `install` / `added`），
市场与官网会自动收录。

## License

[MIT](./LICENSE)

---

<a id="english"></a>

## English

**Connect DeepSeek Harness to local models — no account sign-in, no cloud token usage.**

`dsh-local-model` registers a `local` LLM adapter that routes every model call to your own machine:

- **Zero account dependency** — never touches `api.deepseek.com` or any account endpoint.
- **Two transports** — OpenAI-compatible `/chat/completions`, and Ollama's native `/api/chat` (NDJSON, with `thinking` support).
- **Full tool calling** — converts Harness tool-call / tool-result history correctly, plus a fallback that recovers tool calls some local models emit as plain-text JSON.
- **Model discovery** — pulls the model list from `GET /models` or `GET /api/tags`.
- **Visual configuration** — configure it from the Harness **Plugins** page or **Settings → Models**; no config file editing.

### Install

```bash
dsh plugin --profile web add dsh-local-model
```

Or search for `dsh-local-model` in **Settings → Plugin Market** inside Harness.

### Quick start (Ollama)

```bash
ollama serve
ollama pull qwen3-coder          # any tool-capable model works
dsh plugin --profile web add dsh-local-model
```

Then, inside Harness: **Settings → Models** confirms the **Local Model** provider
(default endpoint `http://127.0.0.1:11434/v1`), and you pick it from the session's model selector.

### Config

| Field | Default | Description |
| --- | --- | --- |
| `api` | `"openai"` | `"openai"` (OpenAI-compatible) or `"ollama"` (native) |
| `baseURL` | `http://127.0.0.1:11434/v1` | Local endpoint root |
| `apiKey` | `""` | Optional auth key required by your local server |
| `defaultModel` | `""` | Fallback model id when the endpoint lists none |
| `contextWindow` | `8192` | Default context window (tokens) |
| `maxTokens` | `2048` | Default max output tokens per call |
| `temperature` | `0.7` | Default sampling temperature (0–2) |
| `streamIdleTimeoutMs` | `300000` | Stream idle timeout (ms) |
| `models` | `[]` | Static model list for endpoints without discovery |

MIT licensed.
