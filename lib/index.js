/**
 * dsh-local-model — 让 DeepSeek Harness 直连本地模型。
 *
 * 通过 `ctx.llm.registerAdapter()` 注册一个自定义 LLM 适配器，支持两种本地传输：
 *   - "openai" : 任意 OpenAI 兼容的 chat completions 服务
 *                （llama.cpp server、LM Studio、vLLM、text-generation-webui、
 *                  LocalAI、以及 Ollama 自带的 /v1 端点）。
 *   - "ollama" : Ollama 原生 /api/chat NDJSON 流（含 thinking/reasoning 支持）。
 *
 * 所有请求都直接发往本机 HTTP 端点，不经过 DeepSeek 账号，不消耗 token 流量。
 *
 * @module dsh-local-model
 */
import { LlmAdapter, LlmError } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";

const name = "dsh-local-model";
const inject = ["llm"];

/** 注册到 LLM 服务里的 provider 路由 id。 */
const PROVIDER = "local";
/** 在模型选择 UI 里显示的 provider 名称。 */
const PROVIDER_NAME = "Local Model";

// 默认使用 127.0.0.1 而不是 localhost：在部分环境下 localhost 会先解析到 IPv6 ::1，
// 而 Ollama 等本地推理服务通常只监听 IPv4，浏览器直连会因此失败。
const DEFAULT_OPENAI_BASE = "http://127.0.0.1:11434/v1";
const DEFAULT_OLLAMA_BASE = "http://127.0.0.1:11434";

// ---------------------------------------------------------------------------
// 配置 Schema（schemastery）。字段标记 `.volatile()` 以便热更新，无需重启。
// ---------------------------------------------------------------------------
const Config = z.object({
  api: z.union(["openai", "ollama"]).default("openai").loose().volatile(),
  baseURL: z.string().default("").volatile(),
  apiKey: z.string().default("").volatile(),
  defaultModel: z.string().default("").volatile(),
  contextWindow: z.number().step(1).min(1).default(8192).volatile(),
  maxTokens: z.number().step(1).min(1).default(2048).volatile(),
  temperature: z.number().min(0).max(2).default(0.7).volatile(),
  streamIdleTimeoutMs: z.number().min(1).default(300000).volatile(),
  models: z
    .array(
      z.object({
        id: z.string().required(),
        name: z.string(),
        contextWindow: z.number().step(1).min(1),
        maxTokens: z.number().step(1).min(1),
      }),
    )
    .default([])
    .volatile(),
});

/** schemastery 的 volatile 字段在解析后是带 `.get()` 的单元格，这里统一解包。 */
function unwrap(value) {
  return value != null && typeof value.get === "function" ? value.get() : value;
}

/** 读取并校验一次配置快照（容错处理原始配置与已解析配置两种情况）。 */
function resolveOptions(config) {
  const api = unwrap(config?.api) || "openai";
  const configuredBase = (unwrap(config?.baseURL) || "").trim();
  const baseURL =
    configuredBase || (api === "ollama" ? DEFAULT_OLLAMA_BASE : DEFAULT_OPENAI_BASE);
  return {
    api,
    baseURL: baseURL.replace(/\/+$/, ""),
    apiKey: (unwrap(config?.apiKey) || "").trim(),
    defaultModel: (unwrap(config?.defaultModel) || "").trim(),
    contextWindow: unwrap(config?.contextWindow) ?? 8192,
    maxTokens: unwrap(config?.maxTokens) ?? 2048,
    temperature: unwrap(config?.temperature) ?? 0.7,
    streamIdleTimeoutMs: unwrap(config?.streamIdleTimeoutMs) ?? 300000,
    models: unwrap(config?.models) ?? [],
  };
}

// ---------------------------------------------------------------------------
// 消息 / 工具 转换（DSH 词汇 -> OpenAI 兼容词汇）
// ---------------------------------------------------------------------------

/** 提取内容块里的纯文本。 */
function textOf(blocks) {
  let out = "";
  for (const block of blocks) {
    if (block.type === "text") out += block.text;
  }
  return out;
}

/**
 * 把 DSH 的 RequestMessage 列表转换成 OpenAI chat completions 的 messages。
 * 说明：运行时会预先做两个投影——文件引用被替换为句柄文本、文本模型会把图片
 * 替换为占位文本——所以到达这里的内容基本只剩 text / reasoning / tool-call。
 */
function toOpenAiMessages(options) {
  const messages = [];
  if (options.system) messages.push({ role: "system", content: options.system });
  for (const msg of options.messages) {
    switch (msg.role) {
      case "system":
        messages.push({ role: "system", content: textOf(msg.content) });
        break;
      case "developer":
        // 本地服务通常不支持 developer 角色，降级为 user。
        messages.push({ role: "user", content: textOf(msg.content) });
        break;
      case "user":
        messages.push({ role: "user", content: textOf(msg.content) });
        break;
      case "assistant": {
        const item = { role: "assistant", content: "" };
        const toolCalls = [];
        for (const block of msg.content) {
          if (block.type === "text") item.content += block.text;
          else if (block.type === "tool-call") {
            toolCalls.push({
              id: String(block.id),
              type: "function",
              function: { name: block.name, arguments: block.arguments },
            });
          }
          // reasoning / image / file / tool-addition / tool-removal 不进入历史
        }
        if (toolCalls.length) item.tool_calls = toolCalls;
        messages.push(item);
        break;
      }
      case "tool":
        messages.push({
          role: "tool",
          tool_call_id: String(msg.toolCallId),
          content: textOf(msg.content),
        });
        break;
      default:
        break;
    }
  }
  return messages;
}

/** 把工具调用参数解析成对象；Ollama 原生 API 要求 arguments 是对象而不是 JSON 字符串。 */
function argumentsObject(raw) {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      /* 参数不是合法 JSON 时落到空对象，至少不让整个请求 400 */
    }
  }
  return {};
}

/**
 * 转换成 Ollama 原生 /api/chat 的 messages。
 *
 * 与 OpenAI 兼容协议不同，Ollama 要求历史里 assistant 的
 * `tool_calls[].function.arguments` 是 JSON **对象**；直接复用 OpenAI 的字符串
 * 形式会被服务端以 `Value looks like object, but can't find closing '}' symbol`
 * 拒绝（400），导致工具调用之后的每一轮都失败。
 */
function toOllamaMessages(options) {
  return toOpenAiMessages(options).map((message) => {
    if (!Array.isArray(message.tool_calls)) return message;
    return {
      ...message,
      tool_calls: message.tool_calls.map((call) => ({
        ...call,
        function: { ...call.function, arguments: argumentsObject(call.function.arguments) },
      })),
    };
  });
}

/** 把 DSH 的 ToolSchema 转换成 OpenAI 的 tools。 */
function toOpenAiTools(tools) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? { type: "object", properties: {} },
    },
  }));
}

// ---------------------------------------------------------------------------
// 流式响应 -> StreamChunk 翻译
// ---------------------------------------------------------------------------

/** 创建一个新内容块。 */
function createBlock(blocks, type, key) {
  const block = {
    index: blocks.length,
    type,
    key,
    text: "",
    toolId: "",
    toolName: "",
    toolArgs: "",
    placeholder: "call_" + blocks.length,
    emittedName: false,
    started: false,
  };
  blocks.push(block);
  return block;
}

/** 找到同类型的未关闭块；找不到就新建。 */
function ensureBlock(blocks, type, key) {
  let block = blocks.find(
    (b) => b.type === type && (key === undefined || b.key === key),
  );
  if (!block) block = createBlock(blocks, type, key);
  return block;
}

/** 产出某个块的 block-end 块。 */
function blockEnd(block) {
  let content;
  if (block.type === "text") content = { type: "text", text: block.text };
  else if (block.type === "reasoning")
    content = { type: "reasoning", text: block.text };
  else
    content = {
      type: "tool-call",
      id: block.toolId || block.placeholder,
      name: block.toolName || "",
      arguments: block.toolArgs,
    };
  return { type: "block-end", index: block.index, block: content };
}

function mapFinishReason(raw) {
  if (raw === "tool_calls" || raw === "function_call") {
    return "tool-calls";
  }
  if (raw === "length" || raw === "max_tokens") return "max-tokens";
  return "stop";
}

function mergeUsage(usage, raw) {
  if (raw.prompt_tokens != null) usage.inputTokens = raw.prompt_tokens;
  if (raw.completion_tokens != null) usage.outputTokens = raw.completion_tokens;
  if (raw.cache_read_input_tokens != null) usage.cacheReadTokens = raw.cache_read_input_tokens;
  if (raw.reasoning_tokens != null) usage.reasoningTokens = raw.reasoning_tokens;
}

/**
 * 判断一段文本是否「看起来像」工具调用的开头，用于决定是否先缓冲而不流式输出。
 * 覆盖 `{...}` JSON、`<tool_call>...</tool_call>` 以及 ```json/``` 代码围栏三种常见形式。
 */
function looksLikeToolCallStart(text) {
  const t = (text || "").trimStart();
  return t.startsWith("{") || t.startsWith("<tool") || t.startsWith("```");
}

/**
 * 把「模型写成纯文本的工具调用」解析回结构化工具调用。
 * 兼容多种写法：`{name, arguments}`、`{function:{name, arguments}}`、
 * `<tool_call>{...}</tool_call>`、```` ```json {...} ``` ````，
 * arguments 既可以是 JSON 字符串也可以是对象。
 * @returns { name, arguments } | null
 */
function parseToolCallText(text, toolNames) {
  if (typeof text !== "string") return null;
  let t = text.trim();
  if (!t) return null;
  const wrapped = t.match(/^<tool_call>\s*([\s\S]*?)\s*<\/tool_call>\s*$/i);
  if (wrapped) t = wrapped[1].trim();
  const fenced = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) t = fenced[1].trim();

  let obj = null;
  try {
    obj = JSON.parse(t);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;

  const fn = obj.function && typeof obj.function === "object" ? obj.function : obj;
  const name = fn.name ?? fn.tool ?? fn.tool_name;
  if (typeof name !== "string" || name.length === 0) return null;
  // 有工具清单时校验名字，避免把普通 JSON 文本误判成工具调用。
  if (toolNames && toolNames.length > 0 && !toolNames.includes(name)) return null;

  let args = fn.arguments ?? fn.parameters ?? fn.args;
  if (args === undefined || args === null) args = {};
  const argsStr = typeof args === "string" ? args : JSON.stringify(args);
  return { name, arguments: argsStr };
}

/**
 * 关闭一个文本块：若整段文本能被解析成（且在工具清单内的）工具调用，
 * 则转成 tool-call 块；否则按普通文本块关闭（被缓冲的块在此处补发文本增量）。
 */
function closeTextBlock(block, toolNames) {
  const tc = parseToolCallText(block.text, toolNames);
  if (tc) {
    return [
      {
        type: "block-end",
        index: block.index,
        block: {
          type: "tool-call",
          id: "call_" + block.index,
          name: tc.name,
          arguments: tc.arguments,
        },
      },
    ];
  }
  const chunks = [];
  if (block.buffered) {
    chunks.push({ type: "block-start", index: block.index, blockType: "text" });
    if (block.text) {
      chunks.push({ type: "text-delta", index: block.index, text: block.text });
    }
  }
  chunks.push({ type: "block-end", index: block.index, block: { type: "text", text: block.text } });
  return chunks;
}

/** 逐行读取响应体（兼容 SSE 与 NDJSON）。 */
async function* readLines(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (line.length > 0) yield line;
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) yield buffer;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

/**
 * 翻译 OpenAI 兼容的 SSE 流（chat.completions）。
 * 每个 `data:` 行形如
 *   { choices: [{ delta: { content, reasoning_content, tool_calls }, finish_reason }], usage? }
 */
async function* translateOpenAi(lines, toolNames) {
  const blocks = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let finish = "stop";

  for await (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "" || payload === "[DONE]") continue;

    let raw;
    try {
      raw = JSON.parse(payload);
    } catch {
      throw new LlmError("local model: stream 中存在非法 JSON", "MALFORMED_RESPONSE");
    }
    if (raw.error) throw providerError(raw.error);
    if (raw.usage) mergeUsage(usage, raw.usage);

    const choice = raw.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};

    if (typeof delta.reasoning_content === "string" && delta.reasoning_content !== "") {
      const block = ensureBlock(blocks, "reasoning");
      if (!block.started) {
        block.started = true;
        yield { type: "block-start", index: block.index, blockType: "reasoning" };
      }
      block.text += delta.reasoning_content;
      yield { type: "reasoning-delta", index: block.index, text: delta.reasoning_content };
    }

    if (typeof delta.content === "string" && delta.content !== "") {
      const block = ensureBlock(blocks, "text");
      if (!block.started) {
        block.started = true;
        block.buffered = looksLikeToolCallStart(delta.content);
        if (!block.buffered) {
          yield { type: "block-start", index: block.index, blockType: "text" };
        }
      }
      block.text += delta.content;
      if (!block.buffered) {
        yield { type: "text-delta", index: block.index, text: delta.content };
      }
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const key = "t" + (typeof tc.index === "number" ? tc.index : 0);
        const block = ensureBlock(blocks, "tool-call", key);
        if (!block.started) {
          block.started = true;
          yield { type: "block-start", index: block.index, blockType: "tool-call" };
        }
        if (typeof tc.id === "string" && tc.id !== "") block.toolId = tc.id;
        if (typeof tc.function?.name === "string" && tc.function.name !== "" && !block.emittedName) {
          block.toolName = tc.function.name;
          block.emittedName = true;
          yield {
            type: "tool-call-delta",
            index: block.index,
            id: block.toolId || block.placeholder,
            name: block.toolName,
            argumentsDelta: "",
          };
        }
        if (typeof tc.function?.arguments === "string" && tc.function.arguments !== "") {
          block.toolArgs += tc.function.arguments;
          yield {
            type: "tool-call-delta",
            index: block.index,
            id: block.toolId || block.placeholder,
            argumentsDelta: tc.function.arguments,
          };
        }
      }
    }

    if (choice.finish_reason) {
      finish = mapFinishReason(choice.finish_reason);
    }
  }

  if (blocks.length === 0 && finish === "stop") {
    throw new LlmError("local model: 模型没有返回任何内容", "EMPTY_RESPONSE");
  }

  for (const block of blocks) {
    if (block.type === "text") {
      yield* closeTextBlock(block, toolNames);
      continue;
    }
    yield blockEnd(block);
  }
  usage.totalTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  yield { type: "usage", usage };
  yield { type: "finish", reason: { kind: finish } };
}

/**
 * 翻译 Ollama 原生 /api/chat 的 NDJSON 流。
 * 每个行形如 { message: { role, content, thinking?, tool_calls? }, done, done_reason, prompt_eval_count, eval_count }
 */
async function* translateOllama(lines, toolNames) {
  const blocks = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let finish = "stop";

  for await (const line of lines) {
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new LlmError("local model: Ollama NDJSON 流中存在非法 JSON", "MALFORMED_RESPONSE");
    }
    if (raw.error) throw providerError(raw.error);
    if (raw.prompt_eval_count != null) usage.inputTokens = raw.prompt_eval_count;
    if (raw.eval_count != null) usage.outputTokens = raw.eval_count;

    const msg = raw.message ?? {};

    if (typeof msg.thinking === "string" && msg.thinking !== "") {
      const block = ensureBlock(blocks, "reasoning");
      if (!block.started) {
        block.started = true;
        yield { type: "block-start", index: block.index, blockType: "reasoning" };
      }
      block.text += msg.thinking;
      yield { type: "reasoning-delta", index: block.index, text: msg.thinking };
    }

    if (typeof msg.content === "string" && msg.content !== "") {
      const block = ensureBlock(blocks, "text");
      if (!block.started) {
        block.started = true;
        block.buffered = looksLikeToolCallStart(msg.content);
        if (!block.buffered) {
          yield { type: "block-start", index: block.index, blockType: "text" };
        }
      }
      block.text += msg.content;
      if (!block.buffered) {
        yield { type: "text-delta", index: block.index, text: msg.content };
      }
    }

    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        const block = createBlock(blocks, "tool-call", undefined);
        block.toolName = tc.function?.name ?? "";
        block.toolArgs =
          typeof tc.function?.arguments === "string"
            ? tc.function.arguments
            : JSON.stringify(tc.function?.arguments ?? {});
        block.toolId = "call_" + block.index;
        block.started = true;
        yield { type: "block-start", index: block.index, blockType: "tool-call" };
        yield {
          type: "tool-call-delta",
          index: block.index,
          id: block.toolId,
          name: block.toolName,
          argumentsDelta: "",
        };
        if (block.toolArgs) {
          yield {
            type: "tool-call-delta",
            index: block.index,
            id: block.toolId,
            argumentsDelta: block.toolArgs,
          };
        }
      }
    }

    if (raw.done) {
      if (raw.done_reason) finish = mapFinishReason(raw.done_reason);
      break;
    }
  }

  if (blocks.length === 0 && finish === "stop") {
    throw new LlmError("local model: 模型没有返回任何内容", "EMPTY_RESPONSE");
  }

  for (const block of blocks) {
    if (block.type === "text") {
      yield* closeTextBlock(block, toolNames);
      continue;
    }
    yield blockEnd(block);
  }
  usage.totalTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  yield { type: "usage", usage };
  yield { type: "finish", reason: { kind: finish } };
}

function providerError(error) {
  const message =
    typeof error?.message === "string" ? error.message : JSON.stringify(error);
  return new LlmError(`local model: ${message}`, "SERVER");
}

function httpCode(status) {
  if (status === 401 || status === 403) return "AUTH";
  if (status === 429) return "RATE_LIMIT";
  if (status >= 500) return "SERVER";
  return "TRANSPORT";
}

function requestHeaders(connection, api) {
  const headers = {
    "content-type": "application/json",
    accept: api === "ollama" ? "application/x-ndjson" : "text/event-stream",
  };
  if (connection.apiKey) headers.authorization = `Bearer ${connection.apiKey}`;
  return headers;
}

// ---------------------------------------------------------------------------
// 模型发现
// ---------------------------------------------------------------------------

/** 把回环地址换成另一种写法（localhost ⇄ 127.0.0.1），用于失败后的兜底重试。 */
function loopbackAlternate(base) {
  if (/\/\/localhost(?=[:/]|$)/i.test(base)) {
    return base.replace(/\/\/localhost(?=[:/]|$)/i, "//127.0.0.1");
  }
  if (/\/\/127\.0\.0\.1(?=[:/]|$)/.test(base)) {
    return base.replace(/\/\/127\.0\.0\.1(?=[:/]|$)/, "//localhost");
  }
  return undefined;
}

/** 单次查询模型列表；非 2xx 抛错，让发现接口能把原因带回界面。 */
async function fetchModelsOnce(connection, signal) {
  const isOllama = connection.api === "ollama";
  const res = await fetch(`${connection.baseURL}${isOllama ? "/api/tags" : "/models"}`, {
    signal,
    headers: requestHeaders(connection, connection.api),
  });
  if (!res.ok) {
    throw new LlmError(
      `local model: 模型列表查询失败 ${res.status} ${res.statusText}`,
      httpCode(res.status),
      { status: res.status },
    );
  }
  const data = await res.json();
  const rows = isOllama ? (data.models ?? []) : (data.data ?? []);
  return rows
    .map((m) => String((isOllama ? m?.name : m?.id) ?? ""))
    .filter((id) => id.length > 0)
    .map((id) => ({ provider: PROVIDER, id, name: id, inputModalities: ["text"] }));
}

/** 向本地端点查询模型列表；回环地址首次失败时自动换另一种写法重试一次。 */
async function fetchModels(connection, signal) {
  try {
    return await fetchModelsOnce(connection, signal);
  } catch (error) {
    const alternate = loopbackAlternate(connection.baseURL);
    if (alternate === undefined) throw error;
    return await fetchModelsOnce({ ...connection, baseURL: alternate }, signal);
  }
}

function modelInfo(connection, provider, model) {
  const configured = connection.models.find((m) => m.id === model);
  return {
    provider,
    id: model,
    name: configured?.name ?? model,
    inputModalities: ["text"],
    context: { contextWindow: configured?.contextWindow ?? connection.contextWindow },
    defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
  };
}

// ---------------------------------------------------------------------------
// 适配器
// ---------------------------------------------------------------------------

class LocalModelAdapter extends LlmAdapter {
  /** `options` 是惰性读取函数：每次调用都拿到最新配置，支持热更新。 */
  constructor(options) {
    super();
    this.options = options;
  }

  providerInfo(provider) {
    return { id: provider, name: PROVIDER_NAME };
  }

  async listModels(provider) {
    const connection = this.options();
    const seen = new Set();
    const result = [];

    let live = [];
    try {
      live = await fetchModels(connection);
    } catch {
      /* 查询失败时回退到静态配置 */
    }
    for (const m of live) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        result.push(m);
      }
    }
    for (const m of connection.models) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        result.push({
          provider,
          id: m.id,
          name: m.name ?? m.id,
          inputModalities: ["text"],
        });
      }
    }
    if (result.length === 0 && connection.defaultModel) {
      result.push({
        provider,
        id: connection.defaultModel,
        name: connection.defaultModel,
        inputModalities: ["text"],
      });
    }
    return result;
  }

  resolveModel(provider, model, _signal) {
    return Promise.resolve(modelInfo(this.options(), provider, model));
  }

  stream(options) {
    return this.streamWith(options, this.options());
  }

  async *streamWith(options, connection) {
    try {
      yield* connection.api === "ollama"
        ? this.generateOllama(options, connection)
        : this.generateOpenAi(options, connection);
    } catch (error) {
      if (options.signal?.aborted) {
        throw new LlmError("local model: 请求被中止", "ABORTED", { cause: error });
      }
      if (error instanceof LlmError) throw error;
      throw new LlmError(
        `local model: 传输失败 (${error?.message ?? error})`,
        "TRANSPORT",
        { cause: error },
      );
    }
  }

  async *generateOpenAi(options, connection) {
    const body = {
      model: options.model,
      messages: toOpenAiMessages(options),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (options.temperature != null) body.temperature = options.temperature;
    if (options.maxTokens != null) body.max_tokens = options.maxTokens;
    if (options.stop && options.stop.length) body.stop = options.stop;
    const tools = toOpenAiTools(options.tools);
    if (tools) body.tools = tools;
    const toolNames = (options.tools ?? []).map((t) => t.name);

    const response = await fetch(`${connection.baseURL}/chat/completions`, {
      method: "POST",
      headers: requestHeaders(connection, "openai"),
      body: JSON.stringify(body),
      signal: options.signal,
      redirect: "error",
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new LlmError(
        `local model: 请求失败 ${response.status} ${response.statusText}` +
          (text ? ` — ${text.slice(0, 500)}` : ""),
        httpCode(response.status),
        { status: response.status },
      );
    }
    if (!response.body) {
      throw new LlmError("local model: 响应体为空", "EMPTY_RESPONSE");
    }
    yield* translateOpenAi(readLines(response.body, options.signal), toolNames);
  }

  async *generateOllama(options, connection) {
    const body = {
      model: options.model,
      messages: toOllamaMessages(options),
      stream: true,
    };
    const opts = {};
    if (options.temperature != null) opts.temperature = options.temperature;
    if (options.maxTokens != null) opts.num_predict = options.maxTokens;
    if (options.stop && options.stop.length) opts.stop = options.stop;
    if (Object.keys(opts).length) body.options = opts;
    const tools = toOpenAiTools(options.tools);
    if (tools) body.tools = tools;
    const toolNames = (options.tools ?? []).map((t) => t.name);

    const response = await fetch(`${connection.baseURL}/api/chat`, {
      method: "POST",
      headers: requestHeaders(connection, "ollama"),
      body: JSON.stringify(body),
      signal: options.signal,
      redirect: "error",
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new LlmError(
        `local model: 请求失败 ${response.status} ${response.statusText}` +
          (text ? ` — ${text.slice(0, 500)}` : ""),
        httpCode(response.status),
        { status: response.status },
      );
    }
    if (!response.body) {
      throw new LlmError("local model: 响应体为空", "EMPTY_RESPONSE");
    }
    yield* translateOllama(readLines(response.body, options.signal), toolNames);
  }
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

function apply(ctx, config) {
  const options = () => resolveOptions(config);
  // 启动时立即校验一次，配置错误尽早暴露。
  options();

  const adapter = new LocalModelAdapter(options);
  // 固定 settingsNs：客户端 UI 用同一个值作为 keyed 槽位的 key。
  const settingsNs = name;

  // 在「模型」设置页声明一个可配置的 provider。
  ctx.llm.registerConfigurableProviders([
    {
      provider: PROVIDER,
      displayName: PROVIDER_NAME,
      settingsNs,
      settingsPath: [],
    },
  ]);

  // 注册适配器，接管 `local` 路由。
  ctx.llm.registerAdapter([PROVIDER], adapter);

  // 注册模型发现：设置页（以及本插件自带的客户端 UI）可用它让**宿主进程**去探测本地端点。
  // 这里刻意不吞异常：失败原因会经 Remote 信封回到界面，用户能看到到底哪里不对。
  ctx.llm.registerModelDiscovery(settingsNs, async (request, signal) => {
    const api = String(request.api ?? "").includes("ollama") ? "ollama" : "openai";
    const base = (request.baseURL || "").trim().replace(/\/+$/, "");
    if (!base) {
      throw new LlmError("local model: 模型探测需要一个端点地址", "INVALID_DISCOVERY");
    }
    const models = await fetchModels({ api, baseURL: base, apiKey: request.apiKey || "" }, signal);
    return models.map((m) => ({ id: m.id, name: m.name ?? m.id }));
  });
}

export { Config, apply, inject, name, resolveOptions };
