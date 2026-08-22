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

Three on-demand triggers on the agent loop (official extension points, same pattern as `dsh-llm-retry`). Each rewrites `model` to the vision model; pure-text requests keep the original model, so KV-cache behavior is unchanged.

- **`agent/request` — user-message pre-emption (v0.3)**: when a user message arrives, predict ahead of any tool call whether the task will need vision. It switches immediately when the message carries:
  - a link (`mp.weixin.qq.com` / `http(s)://` / `www.`) **plus** an analysis verb (分析/看看/识别/解读/检查/评估/总结/阅读/读/提取/解释), or
  - an image-noun (图片/图像/截图/照片/画面/图表/示意图/架构图/海报/扫描件/OCR/二维码/热榜/封面), or
  - a direct visual action (看图/识别图/提取图片/读图 etc.).
  So handing the agent a WeChat / web link to analyze already lands on the vision route — no failed `read_image` first.
- **`agent/request` — history look-back**: scans the agent's durable session events **backwards** (first hit stops) and switches when history carries image blocks, `read_image` tool calls (including refusals whose failure text names image input), or vision-intent user text.
- **`agent/request-error` — fallback**: on a fatal failure of the switched route (`AUTH` / `FORBIDDEN` / `NO_ADAPTER` / `SERVER` / `INVALID_REQUEST`) it retreats **once** to the original model, so a session recovers instead of looping on a dead route.

The vision model is priced the same as flash, so the switch is effectively cost-neutral. No durable session events are appended; the switch surfaces through the existing `request/header` change record.

## Complete switching pipeline

**A — user hands a link / image task (pre-emption path)**
```
user message (link + analysis verb, or image noun) → plugin switches route to vision
→ agent calls read_image → succeeds immediately → picture enters context → task continues
```

**B — images discovered mid-task (self-healing path)**
```
task in progress on flash → agent searches/fetches and finds a picture that must be read
→ agent calls read_image (first attempt, flash route) → tool/call + failure recorded in history
→ plugin looks back, sees the read_image call → switches route to vision on the next request
→ agent retries read_image → succeeds → picture enters context → task continues (uninterrupted)
```


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
- Source is live on the fork branch (pushed and accessible):
  **https://github.com/k2d5rqjpkg-art/deepseek-harness/tree/feat/llm-auto-vision**
  prepared as an upstream-style package (`packages/llm/llm-auto-vision` + base-bundle registration + bilingual README + Agent Note). The PR is not open from this account (the org's pulls endpoint 404s for me); maintainers are welcome to take this branch.

## Feedback welcome!

Happy to iterate on detection heuristics, the config surface, fallback behavior, or anything else. If the maintainers would prefer this as an upstream feature, I'd be glad to adjust the design (e.g. task-complexity upgrade matrix, context-window-aware switching) accordingly.

---
> ✅ 已发布: https://github.com/deepseek-ai/deepseek-harness/discussions/3956 (2026-08-22, Show Your Plugins!)
