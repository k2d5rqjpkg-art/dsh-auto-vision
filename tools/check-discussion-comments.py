#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""检查官方 Discussion 帖子评论（默认 #3956：dsh-llm-auto-vision showcase）。

用法:
    python check-discussion-comments.py [discussion_number] [--token <file>]

依赖:
    - 网络可达 GitHub（需代理时设置 https_proxy 环境变量，如 http://127.0.0.1:7890）
    - token 文件默认读 D:\\HARNESS\\.dsh\\gh-token.txt，也可用 --token 指定

输出:
    - 总评论数
    - 每条评论：作者 / 日期 / 正文摘要
"""
import json
import os
import sys
import urllib.request
import urllib.error

GITHUB_GRAPHQL = "https://api.github.com/graphql"
DEFAULT_DISCUSSION = 3956


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    discussion = int(args[0]) if args else DEFAULT_DISCUSSION

    token_path = "D:\\HARNESS\\.dsh\\gh-token.txt"
    if "--token" in sys.argv:
        idx = sys.argv.index("--token")
        if idx + 1 < len(sys.argv):
            token_path = sys.argv[idx + 1]
    token = open(token_path, encoding="utf-8").read().strip()

    query = """
query($num: Int!) {
  repository(owner: "deepseek-ai", name: "deepseek-harness") {
    discussion(number: $num) {
      number title
      comments(first: 20) { totalCount nodes { author { login } createdAt body } }
    }
  }
}
"""
    payload = {"query": query, "variables": {"num": discussion}}
    handlers = []
    proxy = os.environ.get("https_proxy") or os.environ.get("HTTPS_PROXY")
    if proxy:
        handlers.append(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
    opener = urllib.request.build_opener(*handlers)
    req = urllib.request.Request(
        GITHUB_GRAPHQL,
        data=json.dumps(payload).encode(),
        headers={"User-Agent": "dsh-check", "Authorization": f"Bearer {token}",
                 "Content-Type": "application/json"},
    )
    try:
        r = json.loads(opener.open(req, timeout=30).read().decode())
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, e.read().decode()[:300])
        return 1

    if "errors" in r:
        print("ERROR:", json.dumps(r["errors"])[:300])
        return 1

    d = r["data"]["repository"]["discussion"]
    print(f"#{d['number']} {d['title']}")
    print("comments:", d["comments"]["totalCount"])
    for c in d["comments"]["nodes"]:
        print(f"- {c['author']['login']} | {c['createdAt'][:10]} | {c['body'][:100]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
