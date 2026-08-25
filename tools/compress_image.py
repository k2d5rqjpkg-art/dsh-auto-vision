#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""compress_image.py — 读图前压缩，降低 DeepSeek 图片 token。

DeepSeek 按缩放后像素计费（每图上限 384 token，512x512 比 800x800 更省）。
DSH 的 read_image/序列化不传 detail（默认 original），把喂进去的图预压到
单边 <= MAX_WIDTH，DeepSeek 缩放后 token 显著更少。

用法:
    python compress_image.py <输入图> [输出图] [--max-width 768] [--quality 82]

    - 输出省略时写 <输入图>.<ext>._compressed (不覆盖原图)
    - 只压超宽/超高/超大的图；小图原样返回（避免无谓损耗）
    - 依赖 PIL；无 PIL 时报错并提示。
"""
import argparse
import os
import sys

MAX_WIDTH = 768
QUALITY = 82
# 超过这些阈值才压缩（小图不折腾）
MIN_SIDE = 1200


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("output", nargs="?")
    ap.add_argument("--max-width", type=int, default=MAX_WIDTH)
    ap.add_argument("--quality", type=int, default=QUALITY)
    args = ap.parse_args()

    try:
        from PIL import Image
    except ImportError:
        print("FATAL: PIL not installed; pip install pillow", file=sys.stderr)
        return 2

    src = args.input
    if not os.path.isfile(src):
        print("FATAL: not a file: " + src, file=sys.stderr)
        return 2
    out = args.output or f"{src}._compressed"

    img = Image.open(src)
    img.load()  # 确保读取
    w, h = img.size
    longest = max(w, h)
    if longest <= args.max_width and longest <= MIN_SIDE:
        print(f"skip: {w}x{h} already small ({os.path.getsize(src)} bytes)")
        return 0

    # 按长边缩放到 max-width，但不超过 MIN_SIDE 时才动手
    if longest > args.max_width:
        ratio = args.max_width / longest
        img = img.resize((max(1, int(w * ratio)), max(1, int(h * ratio))), Image.LANCZOS)

    # 转 RGB（PNG alpha / 调色板统一为 JPEG 可存）再存 JPEG
    if img.mode in ("RGBA", "P", "LA", "PA"):
        bg = Image.new("RGB", img.size, (255, 255, 255))
        img = img.convert("RGBA")
        bg.paste(img, mask=img.split()[-1])
        img = bg
    else:
        img = img.convert("RGB")
    img.save(out, "JPEG", quality=args.quality, optimize=True)

    kb = os.path.getsize(out) / 1024
    print(f"compressed {w}x{h} -> {img.size[0]}x{img.size[1]} ({kb:.0f}KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
