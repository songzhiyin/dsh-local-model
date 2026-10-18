# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与
[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 修复

- **Ollama 原生 API 下「已调用工具」后下一轮必然 400**：历史里 assistant 的
  `tool_calls[].function.arguments` 沿用了 OpenAI 协议的 JSON 字符串，而 Ollama
  要求对象，服务端会以 `Value looks like object, but can't find closing '}' symbol`
  拒绝整个请求。新增 `toOllamaMessages()` 单独把参数转成对象，OpenAI 兼容路径保持不变。

## [1.0.0] - 2026-10-14

首个版本。

### 新增

- **双传输协议**：OpenAI 兼容 `/chat/completions`（llama.cpp / LM Studio / vLLM /
  Ollama 的 `/v1` 等）与 Ollama 原生 `/api/chat`（NDJSON，支持 `thinking`/reasoning）。
- **完整工具调用**：DSH 工具调用/工具结果历史与目标协议的双向转换。
- **文本工具调用兜底**：自动识别模型以纯文本写出的工具调用
  （`{...}` JSON、`<tool_call>...</tool_call>`、` ```json {...} ``` `），
  校验工具名后转成真正的工具调用。
- **模型自动发现**：`GET /models`（OpenAI）与 `GET /api/tags`（Ollama），
  并注册 `registerModelDiscovery` 供设置页使用。
- **可视化界面**：注册可配置 provider，插件页与「设置 → 模型」页均有图形配置界面。
- **自带客户端 UI**：浏览器半身（`lib/client.js`）向 `settings.models.provider-card` 槽位
  （keyed，key = `dsh-local-model`）注册「本地模型连接测试」卡片，可一键验证本地服务连通性
  并列出可用模型。手写 Lazy-CJS bundle，零打包依赖。
- **热更新**：配置字段全部 volatile，修改后无需重启。

### 修复

- **`Failed to fetch`（localhost / IPv6 陷阱）**：客户端「测试连接」改为**优先经宿主进程探测**
  （`ctx.remote.llm.discoverModels`），绕开浏览器的 CORS / IPv6 / Electron 网络限制；
  默认端点由 `localhost` 改为 `127.0.0.1`，并对回环地址做 `localhost ⇄ 127.0.0.1` 兜底重试。
- **模型发现吞异常**：`registerModelDiscovery` 不再把失败静默成空列表，
  失败原因会经 Remote 信封回到界面。

[1.0.0]: https://github.com/songzhiyin/dsh-local-model/releases/tag/v1.0.0
