# Changelog

## 0.5.0
- Lenient intent pre-emption (default): a user message carrying a link / image noun / visual action switches route immediately — the vision model is same-price and same-capability as flash, so no cost to being eager. `strictIntents: true` restores conservative "link + analysis verb" behavior.
- Kept per-model routing: flash main session -> A (auto-switch), pro main session -> B (subagent vision), subagent always switches (readable image). Fatal-failure fallback to the original model.

## 0.4.0
- Per-model routing via `autoSwitchModels` (default `["deepseek-v4-flash"]`): the main session auto-switches only for models in the list; a pro main session stays put (deep reasoning preserved) and delegates image reading to a subagent that always switches to vision.
- Subagent detection via `agent.options.subagentDepth` — children always switch.

## 0.3.0
- User-message pre-emption: a message carrying a link + analysis verb, an image noun, or a visual action switches before any read_image call, avoiding the first-attempt failure.
- Reverse event scan (first hit stops), failure fallback, structured audit logs, Responses-API tool-output image blocks.

## 0.2.0
- Initial router: switch to `deepseek-v4-flash-vision-exp` when history carries image blocks or read_image calls; fatal-failure fallback; multi-provider `targetProviders`; intent detection.
