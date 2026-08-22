/**
 * Auto-switch the DeepSeek route to the vision model when the session history
 * starts carrying image blocks or `read_image` tool calls, and fall back to
 * the original model after a fatal failure on the switched route.
 *
 * DeepSeek's vision input is only accepted by `deepseek-v4-flash-vision-exp`;
 * the harness's `read_image` tool refuses to run under a route whose model
 * does not declare image input. This plugin observes the durable session
 * history before every request and, when it shows a picture is already in
 * context or about to be read, points the request at the vision model. Pure
 * text history keeps the original model, so the switch is strictly on demand.
 *
 * @module @deepseek-ai/dsh-llm-auto-vision
 */

import type { Context, Events } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

export const name = 'llm-auto-vision'
export const inject = ['agents']

/** The resolved provider/model pair a request is routed to. */
export type CallConfig = Awaited<ReturnType<Events['agent/request']>>

/** Options for {@link apply}. */
export type Config = Readonly<{
  /** Master switch; default `true`. */
  enabled?: boolean
  /** Provider routes that participate in the switch; default `['deepseek-official', 'deepseek']`. */
  targetProviders?: readonly string[]
  /** The vision model requests are pointed at; default `deepseek-v4-flash-vision-exp`. */
  targetModel?: string
  /** Detect vision intent in user text (e.g. "看下这张图"); default `true`. */
  intentEnabled?: boolean
  /** Custom intent regular expression source, overriding the built-in vocabulary. */
  intentPattern?: string
}>

/** Runtime schema for {@link Config}. */
export const Config = z.object({
  enabled: z.boolean().default(true),
  targetProviders: z.array(z.string()).min(1).default(['deepseek-official', 'deepseek']),
  targetModel: z.string().default('deepseek-v4-flash-vision-exp'),
  intentEnabled: z.boolean().default(true),
  intentPattern: z.string().optional(),
})

/**
 * Built-in vision-intent vocabulary: an action verb followed by an image noun
 * within six characters, or an image noun followed by a location/content word.
 * Kept deliberately narrow so prose like "介绍图片上传功能" does not match.
 */
const VISION_INTENT_RE = /(?:看|看看|识别|分析|解读|提取|描述)[^。；\n]{0,6}(?:图片|图像|截图|照片|画面|这张图|这幅图|此图|下图|上图)|(?:图片|图像|截图|照片|画面|这张图|这幅图|此图|图)[^。；\n]{0,8}(?:里|中|内|是什么|内容|显示|写|有什么|信息)/

/** Fatal provider errors that make a switched route a dead end worth retreating from. */
const FATAL_CODES = new Set(['AUTH', 'FORBIDDEN', 'NO_ADAPTER', 'SERVER', 'INVALID_REQUEST'])

/** A verdict over one session event. */
export interface VisionVerdict {
  readonly needs: boolean
  readonly reason?: 'image-block' | 'read-image' | 'read-image-failure' | 'intent'
}

function contentHasImage(content: unknown): boolean {
  return Array.isArray(content)
    && content.some((block) => typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'image')
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string')
    .map((block) => (block as { text: string }).text)
    .join(' ')
}

/** Collect every content array a session event may carry. */
function contentsOf(data: unknown): unknown[] {
  if (typeof data !== 'object' || data === null) return []
  const record = data as { content?: unknown; message?: { content?: unknown }; output?: unknown }
  return [record.content, record.message?.content, record.output].filter((value) => value !== undefined)
}

/** Decide whether one durable session event requires the vision model. */
export function eventVerdict(
  event: SessionEvent | { type: string; data?: unknown },
  intentPattern: RegExp,
  intentEnabled: boolean,
): VisionVerdict {
  const data = event.data
  switch (event.type) {
    case 'user/message': {
      const contents = contentsOf(data)
      if (contents.some(contentHasImage)) return { needs: true, reason: 'image-block' }
      if (intentEnabled && contents.map(contentText).join(' ').match(intentPattern)) {
        return { needs: true, reason: 'intent' }
      }
      return { needs: false }
    }
    case 'assistant/message': {
      const message = (data as { message?: { content?: unknown } } | undefined)?.message
      if (message !== undefined && contentHasImage(message.content)) return { needs: true, reason: 'image-block' }
      return { needs: false }
    }
    case 'tool/call': {
      if ((data as { name?: unknown } | undefined)?.name === 'read_image') {
        return { needs: true, reason: 'read-image' }
      }
      return { needs: false }
    }
    case 'tool/result': {
      const message = (data as { message?: { content?: unknown } } | undefined)?.message
      if (message !== undefined && contentHasImage(message.content)) return { needs: true, reason: 'image-block' }
      const text = message === undefined ? '' : contentText(message.content)
      if (/does not declare image input|read_image|does not accept image/i.test(text)) {
        return { needs: true, reason: 'read-image-failure' }
      }
      const error = (data as { error?: { code?: string; name?: string; message?: string } } | undefined)?.error
      if (error !== undefined) {
        const detail = `${error.code ?? ''} ${error.name ?? ''} ${error.message ?? ''}`
        if (/image input|read_image|does not accept image/i.test(detail)) {
          return { needs: true, reason: 'read-image-failure' }
        }
      }
      return { needs: false }
    }
    default:
      return { needs: false }
  }
}

/**
 * Scan the durable session history backwards — picture-carrying events almost
 * always land near the tail — and return the first verdict that needs vision.
 */
export function scanEvents(
  events: readonly SessionEvent[],
  intentPattern: RegExp,
  intentEnabled: boolean,
): VisionVerdict {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const verdict = eventVerdict(events[index], intentPattern, intentEnabled)
    if (verdict.needs) return verdict
  }
  return { needs: false }
}

/**
 * Install the auto-vision router.
 * @param ctx - plugin context; owns the two waterfall listeners.
 * @param config - plugin options.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const providers = new Set(config.targetProviders ?? ['deepseek-official', 'deepseek'])
  const targetModel = config.targetModel ?? 'deepseek-v4-flash-vision-exp'
  const enabled = config.enabled ?? true
  const intentEnabled = config.intentEnabled ?? true
  const intentPattern = config.intentPattern === undefined ? VISION_INTENT_RE : new RegExp(config.intentPattern, 'i')

  // Per-agent switch bookkeeping: the original route we displaced, and whether
  // the displaced route then failed fatally (retreat once, then retry).
  const switched = new WeakMap<Agent, { provider: string; model: string }>()
  const failed = new WeakMap<Agent, true>()

  ctx.on('agent/request', async (payload, next) => {
    const resolved: CallConfig = await next()
    if (!enabled || typeof resolved !== 'object' || resolved === null) return resolved
    if (!providers.has(resolved.provider)) return resolved
    if (resolved.model === targetModel) return resolved
    if (failed.get(payload.agent)) {
      failed.delete(payload.agent)
      return resolved
    }
    const events = payload.agent.session.events
    const verdict = scanEvents(events, intentPattern, intentEnabled)
    if (!verdict.needs) return resolved
    switched.set(payload.agent, { provider: resolved.provider, model: resolved.model })
    ctx.logger.info(`llm-auto-vision: ${resolved.model} -> ${targetModel} (${verdict.reason ?? 'unknown'})`)
    return { ...resolved, model: targetModel }
  })

  ctx.on('agent/request-error', async (payload, next) => {
    const previous = switched.get(payload.agent)
    if (previous !== undefined && payload.failure !== undefined && FATAL_CODES.has(payload.failure.code)) {
      failed.set(payload.agent, true)
      ctx.logger.warn(`llm-auto-vision: ${payload.failure.code} on switched route; falling back to ${previous.model}`)
    }
    return next()
  })
}
