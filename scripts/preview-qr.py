#!/usr/bin/env python3
"""
把小程序开发者工具 CLI 的终端二维码还原成可扫描的 PNG。

背景：`cli preview --qr-format image --qr-output <path>` 在当前 CLI/IDE 版本上会报
「二维码输出路径无效或不存在」，文件、目录、绝对/相对路径均无效；`--qr-format base64`
也不打印内容。唯一可靠输出是 `--qr-format terminal` 的 Unicode 半块字符，故在此还原。

用法：
    CLI="/Applications/wechatwebdevtools.app/Contents/MacOS/cli"
    "$CLI" preview --project <项目路径> --qr-format terminal > /tmp/qr-term.txt
    python3 scripts/preview-qr.py /tmp/qr-term.txt preview-qrcode.png

实现要点：不假设渲染约定。终端渲染可能是反色的（深色模块画成空格/白块），静区宽度也不定，
因此对「是否反色」穷举，并在网格中搜索 7x7 定位图案，由三个定位图案的相对位置反推模块尺寸，
再用定位图案之间的定时图案（黑白交替）交叉校验。定位/定时图案全部成立才说明网格对齐无误。
仅用标准库，无第三方依赖。
"""
import re
import struct
import sys
import zlib

# 半块字符 → 上下两个显示色（1=显示黑, 0=显示白）
DISP = {"▀": (1, 0), "▄": (0, 1), "█": (1, 1), " ": (0, 0)}
VALID_N = [21, 25, 29, 33, 37, 41, 45, 49]  # QR 合法模块尺寸


def parse_blocks(text):
    lines = text.split("\n")
    ql = [l for l in lines if l.strip() and re.fullmatch(r"[▀▄█ ]+", l)]
    if not ql:
        raise SystemExit("未找到终端二维码区块（确认预览输出为 --qr-format terminal）")
    w = min(len(l) for l in ql)
    return [l[:w] for l in ql]


def build(ql, invert):
    m = []
    for l in ql:
        top, bot = [], []
        for ch in l:
            t, b = DISP[ch]
            if invert:
                t, b = 1 - t, 1 - b
            top.append(t)
            bot.append(b)
        m.append(top)
        m.append(bot)
    return m


def finder_ok(m, r0, c0):
    h, w = len(m), len(m[0])
    if r0 < 0 or c0 < 0 or r0 + 7 > h or c0 + 7 > w:
        return False
    for r in range(7):
        for c in range(7):
            ring = r in (0, 6) or c in (0, 6)
            core = 2 <= r <= 4 and 2 <= c <= 4
            if m[r0 + r][c0 + c] != (1 if (ring or core) else 0):
                return False
    return True


def timing_ok(m, r0, c0, n):
    for i in range(8, n - 8):
        want = 1 if i % 2 == 0 else 0
        if m[r0 + 6][c0 + i] != want or m[r0 + i][c0 + 6] != want:
            return False
    return True


def locate(ql):
    for invert in (False, True):
        m = build(ql, invert)
        h, w = len(m), len(m[0])
        for r0 in range(4):
            for c0 in range(4):
                if not finder_ok(m, r0, c0):
                    continue
                for n in VALID_N:
                    if r0 + n > h or c0 + n > w:
                        continue
                    if finder_ok(m, r0, c0 + n - 7) and finder_ok(m, r0 + n - 7, c0) and timing_ok(m, r0, c0, n):
                        return [row[c0:c0 + n] for row in m[r0:r0 + n]], n
    raise SystemExit("未找到成立的定位图案组合（渲染约定可能变了，需重新核对）")


def write_png(path, grid, scale=12, quiet=4):
    n = len(grid)
    side = (n + quiet * 2) * scale
    raw = bytearray()
    for y in range(side):
        raw.append(0)  # 每行的 filter type
        gy = y // scale - quiet
        for x in range(side):
            gx = x // scale - quiet
            dark = 0 <= gx < n and 0 <= gy < n and grid[gy][gx] == 1
            raw.append(0 if dark else 255)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", side, side, 8, 0, 0, 0, 0))  # 8bit 灰度
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)
    return side


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else "/tmp/qr-term.txt"
    out = sys.argv[2] if len(sys.argv) > 2 else "preview-qrcode.png"
    ql = parse_blocks(open(src, encoding="utf-8").read())
    grid, n = locate(ql)
    side = write_png(out, grid)
    print(f"已写入 {out}  {side}x{side}  模块 {n}x{n}")
    print("建议校验：用系统 Vision 框架解码确认内容为 https://mp.weixin.qq.com/a/~~...~~")


if __name__ == "__main__":
    main()
