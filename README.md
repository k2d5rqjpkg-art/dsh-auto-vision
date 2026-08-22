# dsh-auto-vision

DSH（DeepSeek Harness）自动视觉路由插件：会话中出现图片或 `read_image` 调用时，**自动**把 DeepSeek 路由的模型切换到视觉模型 `deepseek-v4-flash-vision-exp`；纯文本任务保持原模型。全程零手动操作。

- **零依赖**：仅使用 cordis 事件接口（`ctx.on`），不引入任何第三方包
- **官方扩展点**：`agent/request` + `agent/request-error` 两个 waterfall
- **失败回退**：切换后目标模型致命失败时自动回退原模型，不会卡死会话
- **v0.2**：倒序扫描 / 多 provider / 意图检测 / 审计日志 / 失败保护

---

## 一、为什么需要

DSH 的 `read_image` 工具有一个硬门槛：**当前路由模型必须声明 `image` 输入**（`inputModalities` 含 `"image"`），否则直接拒绝并提示 "switch to an image-capable model"。

DeepSeek 的视觉模型是独立的 `deepseek-v4-flash-vision-exp`（与 flash **同价**，仅视觉模型接受图片，其他模型返回 400）。DSH 官方内置了该模型的目录条目，但**没有**"按需自动切换"的路由能力——默认会话（flash）遇到图片任务需要手动 `/model` 切换。

本插件补上这一层：**检测到需要看图 → 自动切 vision → 读完继续任务**，用户无感。

## 二、工作原理

```
模型请求前（agent/request）
        │
        ▼
   ┌─────────────────────────────┐
   │ 会话历史倒序扫描（命中即停）      │
   │  · 任何消息含 image 块         │ → 切 vision
   │  · read_image 工具调用（含失败）│ → 切 vision
   │  · 用户消息含视觉意图文本        │ → 切 vision
   │  · 其余                        │ → 保持原模型
   └─────────────────────────────┘

切换后请求致命失败（agent/request-error）
        │
        ▼
   AUTH / FORBIDDEN / NO_ADAPTER / SERVER / INVALID_REQUEST
        │
        ▼
   标记回退 → 下一次请求恢复原模型（给一次重试机会）
```

**关键时序**（"任务中发现网页信息是图片"场景）：

1. flash 主会话执行任务 → 抓取网页 → 决定读图 → 调用 `read_image`（被拒，因为 flash 不支持图片）
2. 失败结果进入会话历史 → 插件在下一请求前检测到 `read_image` 失败错误 → **切到 vision**
3. vision 模型重试 `read_image` → 成功，图片块进入上下文
4. 后续请求历史持续含图 → 保持 vision → 完成分析

**触发判据**（`eventVerdict`）：

| 判据 | 会话事件 | 切换原因（日志） |
|---|---|---|
| 图片块 | user/assistant/tool-result 消息含 `{type:"image"}` | `image-block` |
| 读图调用 | `tool/call` name = read_image | `read-image` |
| 读图失败 | `tool/result` 错误含 "does not declare image input" 等 | `read-image-failure` |
| 意图文本 | user 消息命中意图词表（如"看下这张图"） | `intent` |
| Responses API | `function_call_output` / `custom_tool_call_output` 含图 | `image-block` |

## 三、安装

### 1. 部署插件包

把 `lib/index.js` 放到 profile 的 node_modules：

```powershell
# 将仓库 lib/index.js 复制为
%DSH_HOME%\profiles\web\node_modules\dsh-auto-vision\lib\index.js
# 并放 package.json（name: dsh-auto-vision, type: module）
```

（或运行 `install.ps1` 一键安装。）

### 2. 在 cordis.patch.yml 启用

编辑 `%DSH_HOME%\profiles\web\cordis.patch.yml`：

```yaml
- insert:
    - id: auto-vision
      name: dsh-auto-vision
      config:
        enabled: true
```

### 3. 重启 DSH Desktop 生效

## 四、配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `targetProviders` | `["deepseek-official", "deepseek"]` | 参与切换的 provider 路由 |
| `targetProvider` | — | v0.1 兼容单值写法，并入上述数组 |
| `targetModel` | `deepseek-v4-flash-vision-exp` | 目标视觉模型 |
| `intentEnabled` | `true` | 是否启用意图文本检测 |
| `intentPattern` | 内置词表 | 自定义意图正则（覆盖内置） |

## 五、验证

```bash
node test/verify.mjs    # 15 项用例：加载/各判据/边界/回退/多 provider
```

手动验证（重启后）：

1. 新建 flash 会话，直接贴一张图片 → 应自动切 vision 正常分析（不再报"model does not accept image"）
2. 发一个含图片的公众号/网页链接 → 任务中自动读图
3. 纯文本对话 → 日志无切换记录（保持 flash）

## 六、边界与已知限制

- 仅对 **DeepSeek 系路由**生效（默认 `deepseek-official`/`deepseek`）；其他 provider 不做切换
- 目标模型需要账号有 vision 权限；无权限时插件自动回退原模型（见回退机制）
- 意图文本检测是启发式词表，极端语境可能误触发（可用 `intentPattern` 自定义或 `intentEnabled:false` 关闭）
- 图片只能出现在 user 消息（DeepSeek API 限制）；assistant/tool-result 中的图片块是 read_image 的产物
- 插件切换的是**会话请求路由**；request/header 会记录切换（会话轨迹可见"模型变更"）

## 七、不足修复记录（v0.1 → v0.2）

| 不足（v0.1） | 修复（v0.2） |
|---|---|
| 每次请求全量遍历事件（O(n)，长会话浪费） | 倒序扫描、命中即停 |
| 切到 vision 失败无回退，可能卡死 | `agent/request-error` 联动，致命错误自动回退原模型 |
| 只认单个 provider | `targetProviders` 数组（兼容单值） |
| 无意图检测（只能等 read_image 被拒才切） | 用户消息意图文本直接触发 |
| 无结构化审计 | 日志含切换原因（image-block/read-image/read-image-failure/intent） |
| 未覆盖 Responses API 工具输出图片 | 支持 function_call_output/custom_tool_call_output |
| 无正式测试 | `test/verify.mjs` 15 项用例 |

## 八、与 DSH 官方图片管线的定位

官方（deepseek-ai/deepseek-harness，2026-08 活跃开发中）正在建设图片底层：PR #2676 image-management-strategy（统一图片请求管线、附件规范化）、PR #2726 deepseek-vision-model-catalog（视觉模型目录——vision-exp 入册即来自此）。**本插件是路由层的补充**：官方管线下层（read_image/附件/Files API），本插件管上层"何时用视觉模型"，两者正交、不冲突。

## 九、卸载

```powershell
# 1) 删除 cordis.patch.yml 中的 auto-vision insert 段（或恢复备份 cordis.patch.yml.bak-*）
# 2) 删除 %DSH_HOME%\profiles\web\node_modules\dsh-auto-vision\
# 3) 重启 DSH Desktop
```

## 十、许可证

MIT
