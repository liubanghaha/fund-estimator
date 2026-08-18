#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
「语言边界」公众号头像生成器
概念：可说 / 不可说（维特根斯坦《逻辑哲学论》命题7）
风格：深色底 + 青蓝渐变（AI 时代科技感），纯图形无文字
构图：左侧「可说」= 青蓝渐变 + 文字行纹理；右侧「不可说」= 虚空星尘；
      正中一道明亮的竖线 = 语言边界本身。
输出：1024x1024 PNG（正方形原图）+ 圆形裁剪预览 + 144px 小尺寸预览
"""
import random

from PIL import Image, ImageDraw, ImageFilter, ImageChops

SS = 4                 # 超采样倍数（抗锯齿）
FINAL = 1024
W = FINAL * SS         # 渲染尺寸 4096
C = W // 2             # 画布中心
R = int(372 * SS)      # 主圆半径（最终 372px，保证圆形裁剪后不切边）

BG = (7, 11, 20)       # 深色底 #070B14


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def new_layer():
    return Image.new("RGBA", (W, W), (0, 0, 0, 0))


def hgrad(c_left, c_right, alpha=255):
    """横向渐变（逐列绘制）"""
    im = new_layer()
    d = ImageDraw.Draw(im)
    for x in range(W):
        d.line([x, 0, x, W], fill=lerp(c_left, c_right, x / (W - 1)) + (alpha,))
    return im


def vgrad(c_top, c_bottom, alpha=255):
    """纵向渐变（逐行绘制）"""
    im = new_layer()
    d = ImageDraw.Draw(im)
    for y in range(W):
        d.line([0, y, W, y], fill=lerp(c_top, c_bottom, y / (W - 1)) + (alpha,))
    return im


def half_mask(left=True):
    """左右半圆 mask（pieslice：0°=3点钟，顺时针，90°=6点，270°=12点）"""
    m = Image.new("L", (W, W), 0)
    bbox = [C - R, C - R, C + R, C + R]
    if left:
        ImageDraw.Draw(m).pieslice(bbox, 90, 270, fill=255)
    else:
        ImageDraw.Draw(m).pieslice(bbox, 270, 450, fill=255)
    return m


def clip_alpha(layer, mask):
    """把层的 alpha 乘上区域 mask，之后用 alpha_composite 正常叠加"""
    layer.putalpha(ImageChops.multiply(layer.getchannel("A"), mask))
    return layer


# ---------------------------------------------------------------- 画布底色
img = Image.new("RGBA", (W, W), BG + (255,))
mask_left = half_mask(left=True)
mask_right = half_mask(left=False)


def put(layer, mask=None):
    """统一叠加入口：先裁剪 alpha 再合成"""
    global img
    if mask is not None:
        clip_alpha(layer, mask)
    img = Image.alpha_composite(img, layer)


# ---------------------------------------------------------------- 左侧「可说」：青蓝渐变 + 边界处提亮
vg = vgrad((59, 130, 246), (99, 102, 241))          # 蓝500 -> 靛500（纵向）
hg = hgrad((37, 99, 235), (34, 211, 238))           # 蓝600 -> 青400（横向）
g = ImageChops.blend(vg, hg, 0.5)
boost = hgrad((0, 0, 0), (42, 140, 205), 255)       # 靠近边界补一层青色高光
g = ImageChops.add(g, boost)
put(g, mask_left)

# ---------------------------------------------------------------- 右侧「不可说」：虚空 + 靛色星云
nebula = new_layer()
dn = ImageDraw.Draw(nebula)
dn.ellipse([C + int(R * 0.12), C - int(R * 0.55),
            C + int(R * 1.00), C + int(R * 0.30)], fill=(37, 33, 96, 160))
nebula = nebula.filter(ImageFilter.GaussianBlur(int(R * 0.22)))
put(nebula, mask_right)

# 边界光晕向虚空一侧渗透（语言边缘的光）
glow = new_layer()
dg = ImageDraw.Draw(glow)
gw = int(R * 0.10)
for i in range(gw):
    a = int(100 * (1 - i / gw) ** 1.6)
    dg.line([C - 2 * SS + i, 0, C - 2 * SS + i, W], fill=(34, 211, 238, a))
glow = glow.filter(ImageFilter.GaussianBlur(int(R * 0.035)))
put(glow, mask_right)

# ---------------------------------------------------------------- 左侧文字行纹理（语言/文章 意象）
tl = new_layer()
dt = ImageDraw.Draw(tl)
LINES = [
    # (行中心y, 行尾x, 透明度)
    (296, 448, 0.34), (362, 404, 0.26), (428, 472, 0.40), (494, 358, 0.22),
    (560, 434, 0.32), (626, 478, 0.44), (692, 392, 0.24), (758, 420, 0.38),
]
line_w = 8
x0 = 186
for y, xe, a in LINES:
    dt.rounded_rectangle(
        [x0 * SS, y * SS - line_w * SS // 2, xe * SS, y * SS + line_w * SS // 2],
        radius=line_w * SS // 2, fill=(224, 242, 254, int(a * 255)))
# 末行光标（AI 时代"正在生成"的小细节）
dt.rounded_rectangle([440 * SS, 758 * SS - 62, 440 * SS + 26, 758 * SS + 62],
                     radius=13, fill=(34, 211, 238, 225))
put(tl, mask_left)

# ---------------------------------------------------------------- 右侧星尘
rng = random.Random(20240601)
star_pts = []
for _ in range(70):
    while True:
        x = C + R * (0.10 + 0.84 * rng.random())
        y = C + (2 * rng.random() - 1) * R * 0.92
        if (x - C) ** 2 + (y - C) ** 2 <= (R * 0.95) ** 2:
            break
    star_pts.append((x, y, rng.uniform(2.5, 9.0), rng.randint(40, 175),
                     rng.choice([(255, 255, 255), (165, 243, 252), (199, 210, 254)])))
st = new_layer()
ds = ImageDraw.Draw(st)
for x, y, rad, a, col in star_pts:
    ds.ellipse([x - rad, y - rad, x + rad, y + rad], fill=col + (a,))
put(st.filter(ImageFilter.GaussianBlur(10)), mask_right)   # 星尘柔光
put(st, mask_right)

# ---------------------------------------------------------------- 边界线：顶部/底部青色、中间亮白
bl = new_layer()
db = ImageDraw.Draw(bl)
bw = 6 * SS
x0l = C - bw // 2
for y in range(W):
    f = (1 - abs(y / (W - 1) - 0.5) * 2) ** 0.8
    c = lerp((125, 211, 252), (255, 255, 255), f)
    db.line([x0l, y, x0l + bw, y], fill=c + (255,))
put(bl)

# ---------------------------------------------------------------- 外圈
rg = new_layer()
dr = ImageDraw.Draw(rg)
dr.ellipse([C - R, C - R, C + R, C + R],
           outline=(147, 197, 253, 80), width=5 * SS)
dr.ellipse([C - R - 26, C - R - 26, C + R + 26, C + R + 26],
           outline=(147, 197, 253, 42), width=2 * SS)
put(rg)

# ---------------------------------------------------------------- 输出
out = img.resize((FINAL, FINAL), Image.LANCZOS).convert("RGB")
out.save("design/avatar-language-boundary.png")

alpha = Image.new("L", (FINAL, FINAL), 0)
ImageDraw.Draw(alpha).ellipse([0, 0, FINAL - 1, FINAL - 1], fill=255)
preview = out.convert("RGBA")
preview.putalpha(alpha)
preview.save("design/avatar-language-boundary-circle.png")

out.resize((144, 144), Image.LANCZOS).save("design/avatar-language-boundary-144.png")
print("done")
