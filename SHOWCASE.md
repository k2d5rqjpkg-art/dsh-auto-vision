# Official showcase & feedback monitoring

dsh-llm-auto-vision 在 DeepSeek Harness 官方社区发布的展示帖与反馈跟进。

## Showcase post

- **板块**: `Show Your Plugins!`
- **链接**: https://github.com/deepseek-ai/deepseek-harness/discussions/3956
- **开源分支**: https://github.com/k2d5rqjpkg-art/deepseek-harness/tree/feat/llm-auto-vision

## Check feedback (comments)

官方帖子目前 **comments: 0**（2026-08-22），等待社区反馈。需要查看评论/回复时运行：

```bash
# 依赖：网络可达 GitHub（走代理时先设 https_proxy），token 默认读 .dsh/gh-token.txt
python tools/check-discussion-comments.py            # 查默认 #3956
python tools/check-discussion-comments.py 3956       # 显式帖子号
python tools/check-discussion-comments.py 3956 --token <token-file>
```

脚本输出：帖子标题、总评论数、每条评论的作者 / 日期 / 正文摘要（GraphQL，读官方仓库 discussions）。

## Feedback triage 约定

收到评论后按此处理：
1. **提问** → 直接回答；涉及用法/配置给示例。
2. **建议 / 设计取舍** → 整理成选项，交给用户拍板。
3. **报错 / 兼容问题** → 定位 → 能改的改插件/配置 → 说明。
4. **官方维护者跟进**（想收编上游）→ 确认 PR 渠道，调整设计（升级矩阵 / 上下文窗口 / 子 agent 路由）。
