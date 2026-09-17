import io, re, base64, os
src = io.open("articles/使用指南.html", encoding="utf-8").read()
out = src
# 1) 去掉"给编辑的备注"
out = re.sub(r'<br><span style="color:#BBB">（给编辑的备注：.*?）</span>', "", out, flags=re.S)
# 2) 图注还原成普通图注（去掉「🖼 配图 N · 文件名 —— 」前缀）
out = re.sub(r'🖼 配图 \d+ · [a-z0-9-]+\.png —— ', "", out)
# 3) 图片内联为 base64
def inline(m):
    path = os.path.join("articles", m.group(1))
    b64 = base64.b64encode(io.open(path, "rb").read()).decode()
    return 'src="data:image/png;base64,' + b64 + '"'
out, n = re.subn(r'src="(screenshots/v23/[a-z0-9-]+\.png)"', inline, out)
io.open("articles/使用指南-发布版.html", "w", encoding="utf-8").write(out)
print("内联图片 %d 张 | 发布版大小 %.1f MB" % (n, len(out.encode()) / 1048576))
