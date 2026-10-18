/**
 * dsh-local-model — 客户端半身（浏览器）。
 *
 * 这是一个手写的 Lazy-CJS 客户端 bundle：执行时只向 `window.__ModuleLoader__` 注册工厂，
 * 模块体在首次物化时才运行。它向「设置 → 模型」页的 provider 卡片扩展槽位
 * `settings.models.provider-card`（keyed，key = 本插件的 settingsNs）注册一张
 * 「本地模型连接测试」卡片。
 *
 * 探测策略（关键）：
 *   1. **优先走宿主进程** —— 通过 `ctx.get("remote.llm").discoverModels()` 让 Node 侧发起请求，
 *      彻底绕开浏览器的 CORS、IPv6(`::1`)、Electron 网络策略等限制。
 *   2. 宿主不可用时才退回浏览器直连 fetch，并对回环地址做 localhost ⇄ 127.0.0.1 兜底。
 *
 * 只依赖平台模块表里的 `react`（baseline），因此无需打包器、无需 dsh.client.external。
 *
 * @module dsh-local-model/client
 */
window.__ModuleLoader__.load({
  id: "dsh-local-model",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;

    /** 与宿主半身 `lib/index.js` 中固定的 settingsNs 保持一致。 */
    const SETTINGS_NS = "dsh-local-model";

    // 用 127.0.0.1 而不是 localhost：localhost 可能先解析到 IPv6 ::1，
    // 而 Ollama 等本地服务通常只监听 IPv4。
    const DEFAULT_OPENAI = "http://127.0.0.1:11434/v1";
    const DEFAULT_OLLAMA = "http://127.0.0.1:11434";

    /** 由 apply 写入，供组件按需读取客户端服务（如 remote）。 */
    let pluginCtx = null;

    const css = {
      card: {
        marginTop: 10,
        padding: "12px 14px",
        border: "1px solid var(--dsh-border, rgba(127,127,127,.28))",
        borderRadius: 10,
        fontSize: 13,
        lineHeight: 1.6,
      },
      title: { fontWeight: 600, marginBottom: 4, fontSize: 13 },
      meta: { opacity: 0.65, fontSize: 12, marginBottom: 10 },
      row: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 },
      label: { minWidth: 44, opacity: 0.7, fontSize: 12 },
      input: {
        flex: "1 1 240px",
        minWidth: 180,
        padding: "6px 9px",
        borderRadius: 7,
        border: "1px solid var(--dsh-border, rgba(127,127,127,.35))",
        background: "transparent",
        color: "inherit",
        font: "inherit",
        fontSize: 12,
      },
      select: {
        padding: "6px 9px",
        borderRadius: 7,
        border: "1px solid var(--dsh-border, rgba(127,127,127,.35))",
        background: "transparent",
        color: "inherit",
        font: "inherit",
        fontSize: 12,
      },
      button: {
        padding: "6px 14px",
        borderRadius: 7,
        border: "1px solid var(--dsh-border, rgba(127,127,127,.35))",
        background: "transparent",
        color: "inherit",
        cursor: "pointer",
        font: "inherit",
        fontSize: 12,
      },
      ok: { color: "#16a34a", fontSize: 12 },
      err: { color: "#dc2626", fontSize: 12, wordBreak: "break-word" },
      hint: { opacity: 0.6, fontSize: 12, marginTop: 6 },
      chips: { marginTop: 6, display: "flex", flexWrap: "wrap", gap: 6 },
      chip: {
        padding: "2px 9px",
        borderRadius: 999,
        border: "1px solid var(--dsh-border, rgba(127,127,127,.35))",
        fontSize: 12,
      },
    };

    /** 把回环地址换成另一种写法（localhost ⇄ 127.0.0.1）。 */
    function loopbackAlternate(root) {
      if (/\/\/localhost(?=[:/]|$)/i.test(root)) {
        return root.replace(/\/\/localhost(?=[:/]|$)/i, "//127.0.0.1");
      }
      if (/\/\/127\.0\.0\.1(?=[:/]|$)/.test(root)) {
        return root.replace(/\/\/127\.0\.0\.1(?=[:/]|$)/, "//localhost");
      }
      return undefined;
    }

    function normalizeBase(base) {
      return String(base || "").trim().replace(/\/+$/, "");
    }

    /**
     * 让宿主进程探测端点（无 CORS / IPv6 / Electron 网络限制）。
     *
     * 注意：宿主探测只是可选增强，客户端半身并没有（也不应）把 `remote.llm`
     * 写进 inject。直接读 `ctx.remote.llm` 会被 Cordis 的服务访问器拦截并抛
     * `cannot get property "remote.llm" without inject`；`ctx.get()` 按名字取
     * 服务、不校验 inject，因此这里用它拿到命名空间服务，再按需调用。
     */
    async function discoverViaHost(base, api) {
      let remote;
      try {
        remote =
          pluginCtx && typeof pluginCtx.get === "function"
            ? pluginCtx.get("remote.llm")
            : undefined;
      } catch (error) {
        return { ok: false, unavailable: true };
      }
      if (!remote || typeof remote.discoverModels !== "function") {
        return { ok: false, unavailable: true };
      }
      const response = await remote.discoverModels(SETTINGS_NS, { baseURL: base, api });
      if (response && response.ok) {
        const models = (response.value || [])
          .map((m) => m && m.id)
          .filter((id) => typeof id === "string" && id.length > 0);
        return { ok: true, models };
      }
      const message =
        (response && response.error && response.error.message) || "宿主探测未成功（原因未知）";
      return { ok: false, unavailable: false, message };
    }

    /** 浏览器直连单次探测。 */
    async function probeOnce(url) {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.json();
    }

    /**
     * 浏览器直连探测（宿主不可用时的退路），带回环地址兜底重试。
     * @param base - 端点根地址
     * @param api - `openai` 或 `ollama`
     */
    async function probe(base, api) {
      const root = normalizeBase(base);
      if (!root) throw new Error("请先填写端点地址");
      const path = api === "ollama" ? "/api/tags" : "/models";
      const extract = (data) =>
        (api === "ollama" ? data.models || [] : data.data || [])
          .map((m) => (api === "ollama" ? m && m.name : m && m.id))
          .filter((id) => typeof id === "string" && id.length > 0);
      try {
        return extract(await probeOnce(root + path));
      } catch (error) {
        const alternate = loopbackAlternate(root);
        if (alternate === undefined) throw error;
        return extract(await probeOnce(alternate + path));
      }
    }

    /**
     * 本地模型连接测试卡片。
     * 由 `settings.models.provider-card` 槽位派发，接收
     * `{ provider, configured, keyConfigured }`。
     */
    function LocalModelCard(props) {
      const provider = (props && props.provider) || {};
      const [api, setApi] = React.useState("openai");
      const [base, setBase] = React.useState(DEFAULT_OPENAI);
      const [state, setState] = React.useState({ kind: "idle" });

      const onApi = React.useCallback((next) => {
        setApi(next);
        setBase((current) =>
          current === DEFAULT_OPENAI || current === DEFAULT_OLLAMA
            ? next === "ollama"
              ? DEFAULT_OLLAMA
              : DEFAULT_OPENAI
            : current,
        );
      }, []);

      const run = React.useCallback(async () => {
        setState({ kind: "loading" });
        const endpoint = normalizeBase(base);

        // 1) 优先让宿主进程去探测。
        try {
          const viaHost = await discoverViaHost(endpoint, api);
          if (viaHost.ok) {
            setState({ kind: "ok", models: viaHost.models, via: "host" });
            return;
          }
          if (!viaHost.unavailable) {
            setState({ kind: "err", message: viaHost.message, via: "host" });
            return;
          }
        } catch (error) {
          setState({
            kind: "err",
            message: (error && error.message) || String(error),
            via: "host",
          });
          return;
        }

        // 2) 宿主路径不可用时才退回浏览器直连。
        try {
          setState({ kind: "ok", models: await probe(endpoint, api), via: "browser" });
        } catch (error) {
          setState({
            kind: "err",
            message: (error && error.message) || String(error),
            via: "browser",
          });
        }
      }, [api, base]);

      const children = [
        h("div", { key: "title", style: css.title }, "本地模型连接测试"),
        h(
          "div",
          { key: "meta", style: css.meta },
          `provider: ${provider.provider || "local"} · 名称: ${provider.displayName || "Local Model"}` +
            ` · 已配置: ${props && props.configured ? "是" : "否"}`,
        ),
        h("div", { key: "api", style: css.row }, [
          h("span", { key: "l", style: css.label }, "协议"),
          h(
            "select",
            { key: "s", style: css.select, value: api, onChange: (e) => onApi(e.target.value) },
            [
              h("option", { key: "o", value: "openai" }, "openai（OpenAI 兼容）"),
              h("option", { key: "c", value: "ollama" }, "ollama（原生 API）"),
            ],
          ),
        ]),
        h("div", { key: "ep", style: css.row }, [
          h("span", { key: "l", style: css.label }, "端点"),
          h("input", {
            key: "i",
            style: css.input,
            value: base,
            spellCheck: false,
            placeholder: api === "ollama" ? DEFAULT_OLLAMA : DEFAULT_OPENAI,
            onChange: (e) => setBase(e.target.value),
            onKeyDown: (e) => {
              if (e.key === "Enter") run();
            },
          }),
          h(
            "button",
            {
              key: "b",
              type: "button",
              style: css.button,
              disabled: state.kind === "loading",
              onClick: run,
            },
            state.kind === "loading" ? "测试中…" : "测试连接",
          ),
        ]),
      ];

      if (state.kind === "ok") {
        children.push(
          h("div", { key: "result" }, [
            h(
              "div",
              { key: "ok", style: css.ok },
              `✅ 连接成功，发现 ${state.models.length} 个模型` +
                (state.via === "host" ? "（经由宿主进程探测）" : "（浏览器直连）"),
            ),
            state.models.length > 0
              ? h(
                  "div",
                  { key: "chips", style: css.chips },
                  state.models.map((id) => h("span", { key: id, style: css.chip }, id)),
                )
              : h("div", { key: "none", style: css.hint }, "该端点未返回任何模型。"),
          ]),
        );
      } else if (state.kind === "err") {
        children.push(
          h("div", { key: "result" }, [
            h("div", { key: "err", style: css.err }, `❌ ${state.message}`),
            h(
              "div",
              { key: "hint", style: css.hint },
              "请确认本地推理服务已启动、端点地址正确（推荐用 127.0.0.1 而不是 localhost）。",
            ),
          ]),
        );
      } else if (state.kind === "idle") {
        children.push(
          h(
            "div",
            { key: "hint", style: css.hint },
            "此卡片只做连通性验证；api / baseURL / apiKey 等插件配置请点上方的「编辑」填写。",
          ),
        );
      }

      return h("div", { style: css.card }, children);
    }

    /** 客户端必需服务。 */
    const inject = ["slots"];

    /**
     * 把卡片挂到 Local Model provider 卡片的扩展区。
     * @param ctx - 浏览器插件上下文
     */
    function apply(ctx) {
      pluginCtx = ctx;
      ctx.slots.inject("settings.models.provider-card", () =>
        ctx.slots.register(
          { name: "settings.models.provider-card", key: SETTINGS_NS },
          LocalModelCard,
        ),
      );
    }

    exports.SETTINGS_NS = SETTINGS_NS;
    exports.LocalModelCard = LocalModelCard;
    exports.probe = probe;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
