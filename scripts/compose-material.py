#!/usr/bin/env python3
"""运营物料：把开发者工具截图套上统一的手机外框 + 纯色背景。

输入：pic/material-raw/*.png（scripts/capture-material.js 产出，594x1284）
输出：pic/material-clean/*.png（1080x2160）

用法：
  /path/to/python scripts/compose-material.py
"""
import glob
import os

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(ROOT, "pic", "material-raw")
OUT_DIR = os.path.join(ROOT, "pic", "material-clean")

# 画布与设备参数（1080 宽）
CANVAS_W, CANVAS_H = 1080, 2160
SCREEN_W = 880                      # 屏幕内容宽度，1840 高 ≈ 1:2 画布
BEZEL = 14                          # 边框宽度
SCREEN_RADIUS = 64                  # 屏幕圆角
BG_COLOR = (244, 245, 247)          # 纯色背景 #F4F5F7
FRAME_COLOR = (28, 28, 30)          # 机身 #1C1C1E

os.makedirs(OUT_DIR, exist_ok=True)


def rounded_mask(size, radius):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius=radius, fill=255)
    return m


def compose(src_path, dst_path):
    src = Image.open(src_path).convert("RGB")
    scale = SCREEN_W / src.width
    screen_h = round(src.height * scale)
    screen = src.resize((SCREEN_W, screen_h), Image.LANCZOS)

    dev_w, dev_h = SCREEN_W + BEZEL * 2, screen_h + BEZEL * 2
    x, y = (CANVAS_W - dev_w) // 2, (CANVAS_H - dev_h) // 2

    canvas = Image.new("RGB", (CANVAS_W, CANVAS_H), BG_COLOR)

    # 投影：单独一层做高斯模糊，避免把画面也糊掉
    shadow = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        [x + 6, y + 26, x + dev_w + 6, y + dev_h + 26],
        radius=SCREEN_RADIUS + BEZEL,
        fill=(0, 0, 0, 78),
    )
    canvas.paste(Image.alpha_composite(
        canvas.convert("RGBA"), shadow.filter(ImageFilter.GaussianBlur(38))
    ).convert("RGB"), (0, 0))

    # 机身
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle(
        [x, y, x + dev_w, y + dev_h],
        radius=SCREEN_RADIUS + BEZEL,
        fill=FRAME_COLOR,
    )

    # 屏幕（圆角裁切后贴入）
    canvas.paste(
        screen,
        (x + BEZEL, y + BEZEL),
        rounded_mask((SCREEN_W, screen_h), SCREEN_RADIUS),
    )

    canvas.save(dst_path, "PNG", optimize=True)
    return canvas.size


def main():
    files = sorted(glob.glob(os.path.join(SRC_DIR, "*.png")))
    if not files:
        raise SystemExit(f"没找到源图：{SRC_DIR}\n先跑 scripts/capture-material.js")

    for f in files:
        name = os.path.splitext(os.path.basename(f))[0]
        out = os.path.join(OUT_DIR, f"{name}.png")
        size = compose(f, out)
        kb = os.path.getsize(out) // 1024
        print(f"  ✅ {name}.png  {size[0]}x{size[1]}  {kb} KB")

    print(f"\n完成 {len(files)} 张 → {OUT_DIR}")


if __name__ == "__main__":
    main()
