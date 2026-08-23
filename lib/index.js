// dsh-auto-vision v0.5 —— 自动视觉路由插件（零依赖，仅用 cordis ctx 事件）
//
// 监听 agent/request / agent/request-error：
//   1) 会话历史出现图片块 / read_image 调用 / 视觉信号时，把 DeepSeek 路由切到视觉模型；
//   2) 用户消息/任务一进来就预判视觉需求，提前切 vision（减少首次 read_image 失败）。
//   3) 主会话按模型分流：flash 直接切（A）；pro 保持（B，交给子 agent）；子 agent 恒切（可读图）。
//   4) 切换后致命失败自动回退原模型一次。
//
// v0.5 相对 v0.4 的增强（依据：vision 与 flash 文本同源、价格一致、benchmark 甚至 ≥ flash）：
//   - 放宽用户消息预判：默认"宽松"模式 —— 含链接 / 图片名词 / 视觉动作 即切（切 vision 无代价）；
//     保守模式（strictIntents: true）才要求"链接+分析动词"。
//   - 子 agent 预判同样放宽，读图更快（不必等 read_image 失败自愈）。
//
// 配置（cordis.patch.yml 的 config，全部可选）：
//   enabled:          bool   默认 true
//   targetProviders:  string[] 默认 ["deepseek-official", "deepseek"]
//   targetProvider:   string  兼容单值写法（并入 targetProviders）
//   targetModel:      string  默认 "deepseek-v4-flash-vision-exp"
//   autoSwitchModels: string[] 主会话可自动切换的基础模型，默认 ["deepseek-v4-flash"]
//   strictIntents:    bool   默认 false —— false=宽松（链接即切）；true=保守（链接+分析动词才切）
//   intentEnabled:    bool   默认 true，启用用户消息预判

const name = "auto-vision";

const DEFAULT_PROVIDERS = ["deepseek-official", "deepseek"];
const DEFAULT_TARGET_MODEL = "deepseek-v4-flash-vision-exp";

// 致命错误码：切换后遇到这些则回退原模型（RATE_LIMIT/CONTEXT_WINDOW 交给重试）
const FATAL_CODES = new Set(["AUTH", "FORBIDDEN", "NO_ADAPTER", "SERVER", "INVALID_REQUEST"]);

// —— 历史回看词表（v0.2 基础）——
const HISTORY_INTENT_RE = new RegExp([
  "(?:看|看看|识别|分析|解读|提取|描述)[^。；\\n]{0,6}",
  "(?:图片|图像|截图|照片|画面|这张图|这幅图|此图|下图|上图)|",
  "(?:图片|图像|截图|照片|画面|这张图|这幅图|此图|图)[^。；\\n]{0,8}",
  "(?:里|中|内|是什么|内容|显示|写|有什么|信息)",
].join(""));

// —— 用户消息"主动预判"（v0.5：宽松模式链接即切）——
// loose=true（默认）：含链接 / 图片名词 / 视觉动作 都触发（切 vision 无代价，减少漏判）。
// loose=false（strictIntents）：仅"链接+分析动词"或图片名词/视觉动作才触发（保守）。
function userNeedsVision(text, loose) {
  const hasLink = /(mp\.weixin\.qq\.com|https?:\/\/|www\.)/.test(text);
  const hasAnalysis = /(分析|看看|识别|解读|检查|评估|总结|阅读|读|提取|解释)/.test(text);
  const hasImgNoun = /(图片|图像|截图|照片|画面|图表|示意图|架构图|海报|扫描件|OCR|二维码|热榜|封面)/.test(text);
  const hasVisualAction = /(看|识别|提取|读|解释|解读)[^。；\n]{0,5}(图片|图像|截图|照片|画面|图|图表)/.test(text);
  if (loose) return hasLink || hasImgNoun || hasVisualAction;
  return (hasLink && hasAnalysis) || hasImgNoun || hasVisualAction;
}

function contentHasImage(content) {
  if (!Array.isArray(content)) return false;
  return content.some((b) => b && typeof b === "object" && b.type === "image");
}

function contentText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join(" ");
}

function messagesOf(data) {
  return [data?.content, data?.message?.content, data?.output].filter(Boolean);
}

function eventVerdict(ev, historyPattern, intentEnabled, loose) {
  if (!ev || typeof ev !== "object") return { needs: false };
  const d = ev.data;
  if (!d || typeof d !== "object") return { needs: false };
  switch (ev.type) {
    case "user/message": {
      const contents = messagesOf(d);
      if (contents.some(contentHasImage)) return { needs: true, reason: "image-block" };
      if (intentEnabled) {
        const text = contents.map(contentText).join(" ");
        if (userNeedsVision(text, loose)) return { needs: true, reason: "intent" };
      }
      return { needs: false };
    }
    case "assistant/message":
      if (contentHasImage(d.message?.content)) return { needs: true, reason: "image-block" };
      return { needs: false };
    case "tool/call":
      if (d.name === "read_image") return { needs: true, reason: "read-image" };
      return { needs: false };
    case "tool/result": {
      if (contentHasImage(d.message?.content)) return { needs: true, reason: "image-block" };
      const text = contentText(d.message?.content);
      if (/does not declare image input|read_image|does not accept image/i.test(text)) {
        return { needs: true, reason: "read-image-failure" };
      }
      if (d.error) {
        const detail = `${d.error.code ?? ""} ${d.error.name ?? ""} ${d.error.message ?? ""}`;
        if (/image input|read_image|does not accept image/i.test(detail)) return { needs: true, reason: "read-image-failure" };
      }
      return { needs: false };
    }
    case "function_call_output":
    case "custom_tool_call_output":
      if (contentHasImage(d.content) || contentHasImage(d.output)) return { needs: true, reason: "image-block" };
      return { needs: false };
    default:
      return { needs: false };
  }
}

function scanEvents(events, historyPattern, intentEnabled, loose) {
  for (let i = events.length - 1; i >= 0; i--) {
    const v = eventVerdict(events[i], historyPattern, intentEnabled, loose);
    if (v.needs) return v;
  }
  return { needs: false, reason: null };
}

function apply(ctx, config) {
  const providers = new Set([
    ...(Array.isArray(config?.targetProviders) ? config.targetProviders : []),
    ...(config?.targetProvider ? [config.targetProvider] : []),
    ...DEFAULT_PROVIDERS,
  ]);
  const targetModel = config?.targetModel ?? DEFAULT_TARGET_MODEL;
  const enabled = config?.enabled ?? true;
  const intentEnabled = config?.intentEnabled ?? true;
  // 宽松预判（默认）：vision 与 flash 同源同价，切 vision 无代价 → 链接/图片相关即切，减少漏判。
  const loose = config?.strictIntents !== true;
  // 主会话"可自动切换"的基础模型（A 方案）：flash 类直接切；pro 等不在列表则主会话不切，
  // 交给 B 方案（派子 agent → 子 agent 恒切 vision 读图 → 回传文字 → 主会话保持原模型）。
  const autoSwitchModels = Array.isArray(config?.autoSwitchModels)
    ? config.autoSwitchModels
    : ["deepseek-v4-flash"];
  // 历史回看词表（user/message 内部用 userNeedsVision 预判）
  const historyPattern = HISTORY_INTENT_RE;

  const switched = new WeakMap();
  const failed = new WeakMap();

  ctx.on("agent/request", async (payload, next) => {
    const resolved = await next();
    if (!enabled || !resolved || typeof resolved !== "object") return resolved;
    if (!providers.has(resolved.provider)) return resolved;
    if (resolved.model === targetModel) return resolved;
    if (failed.get(payload.agent)) {
      failed.delete(payload.agent);
      return resolved;
    }
    const agent = payload.agent;
    const events = agent?.session?.events;
    const verdict = Array.isArray(events)
      ? scanEvents(events, historyPattern, intentEnabled, loose)
      : { needs: false, reason: null };
    if (!verdict.needs) return resolved;
    // 分流：子 agent 恒切（保证 B 方案读图）；主会话仅在基础模型属于 autoSwitchModels 时切（A 方案）。
    const isSubagent = (agent?.options?.subagentDepth ?? 0) >= 1;
    if (!isSubagent) {
      const baseModel = agent?.options?.model;
      const allowed = autoSwitchModels.includes(baseModel) || autoSwitchModels.includes("*");
      if (!allowed) return resolved;
    }
    switched.set(agent, { provider: resolved.provider, model: resolved.model });
    ctx.logger?.info?.(`auto-vision: ${resolved.model} -> ${targetModel} (${verdict.reason ?? "unknown"})${isSubagent ? " [subagent]" : ""}`);
    return { ...resolved, model: targetModel };
  });

  ctx.on("agent/request-error", async (payload, next) => {
    const prev = switched.get(payload.agent);
    if (prev && payload?.failure?.code && FATAL_CODES.has(payload.failure.code)) {
      failed.set(payload.agent, true);
      ctx.logger?.warn?.(`auto-vision: ${payload.failure.code} on switched route; falling back to ${prev.model}`);
    }
    return next();
  });
}

export { name, apply };
