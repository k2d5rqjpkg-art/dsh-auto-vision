# 社区帖子草稿（复制到官方 Discussions 发布）

> 分类: **Show Your Plugins!**
> 发布入口: https://github.com/deepseek-ai/deepseek-harness/discussions/new?category=Show+Your+Plugins
> 说明: 账号 API 发帖被组织限制（404），请登录浏览器手动发布。

---

## 标题

[Unofficial] dsh-llm-auto-vision — auto-switch DeepSeek route to the vision model on demand

## 正文

> **⚠️ Unofficial / 非官方**: third-party plugin, independently maintained; not reviewed or endorsed by DeepSeek.
> 第三方插件，独立维护，未经 DeepSeek 官方审核或推荐。

# dsh-llm-auto-vision

A small host-plane plugin that **automatically points requests at `deepseek-v4-flash-vision-exp`** whenever images enter session history — so you never need to `/model`-switch by hand before a picture task (reading a web-page image, analyzing a WeChat article's screenshots, interpreting a chart, etc.).

## Why

DeepSeek accepts image input only on `deepseek-v4-flash-vision-exp`; the harness `read_image` tool refuses to run under a route whose model does not declare image input. A flash-routed session currently requires a manual model switch before any image task, and the agent itself has no model-switching tool.

## How it works

Two waterfall listeners on the agent loop (official extension points, same pattern as `dsh-llm-retry`):

- **`agent/request`** — after downstream resolution, scans the agent's durable session history **backwards** (first hit stops) and rewrites `model` to the vision model when history carries:
  - image blocks (`user` / `assistant` / `tool/result`), or
  - `read_image` tool calls (including refusals whose failure text names image input), or
  - vision-intent user text (built-in vocabulary, e.g. "看下这张图"; configurable `intentPattern`).
  Pure-text requests keep the original model, so KV-cache behavior is unchanged.
- **`agent/request-error`** — on a fatal failure of the switched route (`AUTH` / `FORBIDDEN` / `NO_ADAPTER` / `SERVER` / `INVALID_REQUEST`) it retreats **once** to the original model, so a session recovers instead of looping on a dead route.

The vision model is priced the same as flash, so the switch is effectively cost-neutral. No durable session events are appended; the switch surfaces through the existing `request/header` change record.

## Config (all optional)

```yaml
- id: auto-vision
  name: dsh-auto-vision          # local plugin package
  config:
    enabled: true                # default
    targetProviders: ["deepseek-official", "deepseek"]
    targetModel: deepseek-v4-flash-vision-exp
    intentEnabled: true
    intentPattern: "..."         # override built-in intent vocabulary
```

## Status

- 11 unit + real-Loader composition tests passing; `tsc -b tsconfig.host.json`, oxlint, and translation-pairing all clean.
- Also prepared as an upstream-style package (`packages/llm/llm-auto-vision` + base-bundle registration + bilingual README + Agent Note) in my fork:
  **https://github.com/k2d5rqjpkg-art/deepseek-harness/tree/feat/llm-auto-vision**
  (I couldn't open the PR from this account — the org's pulls endpoint 404s for me; happy to open it if a maintainer confirms a different route.)

## Feedback welcome!

Happy to iterate on detection heuristics, the config surface, fallback behavior, or anything else. If the maintainers would prefer this as an upstream feature, I'd be glad to adjust the design (e.g. task-complexity upgrade matrix, context-window-aware switching) accordingly.

---
> ✅ 已发布: https://github.com/deepseek-ai/deepseek-harness/discussions/3956 (2026-08-22, Show Your Plugins!)
