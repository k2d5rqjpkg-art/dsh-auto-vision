// dsh-auto-vision v0.2 —— 自动视觉路由插件（零依赖，仅用 cordis ctx 事件）
//
// 监听 agent/request / agent/request-error 两个官方扩展点：
//   1) 会话历史出现图片块 / read_image 调用 / 视觉意图文本时，
//      自动把 DeepSeek 路由的模型切到视觉模型（deepseek-v4-flash-vision-exp）；
//   2) 切换后若目标模型请求致命失败（无权限/无适配器/服务错误），
//      自动回退原模型并给一次重试机会，避免会话卡死在 vision 路由。
//
// v0.2 相对 v0.1 的完善（详见 README「不足修复记录」）：
//   - 事件扫描改为倒序（命中即停，长会话性能优化）
//   - 新增失败回退保护（agent/request-error 联动）
//   - 支持 targetProviders 数组（多 DeepSeek 入口）
//   - 新增视觉意图文本触发（intentEnabled / intentPattern 可配）
//   - 结构化审计日志（切换原因：image-block / read-image / read-image-failure / intent）
//   - 覆盖 Responses API 的 function_call_output / custom_tool_call_output 图片块
//
// 配置（cordis.patch.yml 的 config，全部可选）：
//   enabled:          bool   默认 true
//   targetProviders:  string[] 默认 ["deepseek-official", "deepseek"]
//   targetProvider:   string  兼容 v0.1 的单值写法（加入 targetProviders）
//   targetModel:      string  默认 "deepseek-v4-flash-vision-exp"
//   intentEnabled:    bool   默认 true，是否启用视觉意图文本检测
//   intentPattern:    string  自定义意图正则（覆盖内置词表）

const name = "auto-vision";

const DEFAULT_PROVIDERS = ["deepseek-official", "deepseek"];
const DEFAULT_TARGET_MODEL = "deepseek-v4-flash-vision-exp";

// 致命错误码：切换后遇到这些错误则回退原模型（其余如 RATE_LIMIT/CONTEXT_WINDOW 交给重试）
const FATAL_CODES = new Set(["AUTH", "FORBIDDEN", "NO_ADAPTER", "SERVER", "INVALID_REQUEST"]);

// 内置视觉意图词表（v0.2 收紧：去掉单字"上"避免"上传/以上"误触发）：
//   动词侧：看/识别/分析/解读/提取/描述 + 图类名词（0-6 字符内）
//   名词侧：图类名词 + 位置/内容词（里/中/内/是什么/内容/显示/写/有什么/信息）
const VISION_INTENT_RE = /(?:看|看看|识别|分析|解读|提取|描述)[^。；\n]{0,6}(?:图片|图像|截图|照片|画面|这张图|这幅图|此图|下图|上图)|(?:图片|图像|截图|照片|画面|这张图|这幅图|此图|图)[^。；\n]{0,8}(?:里|中|内|是什么|内容|显示|写|有什么|信息)/;

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
  // user/message 的 data 可能是 {role, content} 或 {message: {...}}；汇总所有可查的 content
  return [data.content, data.message?.content, data.output].filter(Boolean);
}

function eventVerdict(ev, intentPattern, intentEnabled) {
  if (!ev || typeof ev !== "object") return { needs: false };
  const d = ev.data;
  if (!d || typeof d !== "object") return { needs: false };
  switch (ev.type) {
    case "user/message": {
      const contents = messagesOf(d);
      if (contents.some(contentHasImage)) return { needs: true, reason: "image-block" };
      if (intentEnabled) {
        const text = contents.map(contentText).join(" ");
        if (intentPattern.test(text)) return { needs: true, reason: "intent" };
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
      if (/does not declare image input|read_image|does not accept image/i.test(text)) return { needs: true, reason: "read-image-failure" };
      if (d.error) {
        const detail = `${d.error.code ?? ""} ${d.error.name ?? ""} ${d.error.message ?? ""}`;
        if (/image input|read_image|does not accept image/i.test(detail)) return { needs: true, reason: "read-image-failure" };
      }
      return { needs: false };
    }
    // Responses API 工具输出也可能携带图片
    case "function_call_output":
    case "custom_tool_call_output":
      if (contentHasImage(d.content) || contentHasImage(d.output)) return { needs: true, reason: "image-block" };
      return { needs: false };
    default:
      return { needs: false };
  }
}

// 倒序扫描：图片/读图事件通常出现在近期，命中即停
function scanEvents(events, intentPattern, intentEnabled) {
  for (let i = events.length - 1; i >= 0; i--) {
    const v = eventVerdict(events[i], intentPattern, intentEnabled);
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
  const intentPattern = config?.intentPattern ? new RegExp(config.intentPattern, "i") : VISION_INTENT_RE;

  // 记录被本插件切换过的 agent（原模型），以及切换后是否致命失败
  const switched = new WeakMap();
  const failed = new WeakMap();

  ctx.on("agent/request", async (payload, next) => {
    const resolved = await next();
    if (!enabled || !resolved || typeof resolved !== "object") return resolved;
    if (!providers.has(resolved.provider)) return resolved;
    if (resolved.model === targetModel) return resolved;
    // 上一次切换后致命失败：回退原模型，给一次机会，避免反复切死
    if (failed.get(payload.agent)) {
      failed.delete(payload.agent);
      return resolved;
    }
    const events = payload?.agent?.session?.events;
    const verdict = Array.isArray(events) ? scanEvents(events, intentPattern, intentEnabled) : { needs: false, reason: null };
    if (!verdict.needs) return resolved;
    switched.set(payload.agent, { provider: resolved.provider, model: resolved.model });
    ctx.logger?.info?.(`auto-vision: ${resolved.model} -> ${targetModel} (${verdict.reason})`);
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
