# -*- coding: utf-8 -*-
"""生成 GitHub Social preview 封面 (1280x640)"""
from PIL import Image, ImageDraw, ImageFont

W, H = 1280, 640
REG = "C:/Windows/Fonts/msyh.ttc"
BOLD = "C:/Windows/Fonts/msyhbd.ttc"

def f(size, bold=False):
    return ImageFont.truetype(BOLD if bold else REG, size)

img = Image.new("RGB", (W, H), (15, 23, 42))
d = ImageDraw.Draw(img)

# 竖直渐变：深蓝 -> 靛紫
c1 = (23, 32, 58)
c2 = (67, 56, 202)
for y in range(H):
    t = y / (H - 1)
    col = tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))
    d.line([(0, y), (W, y)], fill=col)

# 装饰：右下大圆环 + 左下小点阵
d.ellipse([980, -170, 1380, 230], outline=(129, 140, 248), width=2)
d.ellipse([1050, -100, 1230, 80], outline=(56, 189, 248), width=2)
for gx in range(70, 200, 26):
    for gy in range(470, 600, 26):
        d.ellipse([gx, gy, gx + 3, gy + 3], fill=(71, 85, 105))

# 顶部小标签
d.text((64, 70), "NETWORK PROXY  ·  REMOTE ACCESS", font=f(22), fill=(147, 197, 253))

# 主标题
d.text((60, 116), "B 机借 A 机网络上网", font=f(76, True), fill=(255, 255, 255))

# 副标题
d.text((64, 238), "UU远程端口映射 · 双协议代理 · 独立 exe · 浏览器扩展",
       font=f(28), fill=(203, 213, 225))

# 技术标签 chips
def chip(x, y, text, fs=24, pad=14, fill=(30, 41, 59), fg=(226, 232, 240), edge=(99, 102, 241)):
    ft = f(fs)
    tw = d.textlength(text, font=ft)
    w = int(tw) + pad * 2
    h = fs + pad * 2
    d.rounded_rectangle([x, y, x + w, y + h], radius=10, fill=fill, outline=edge, width=2)
    d.text((x + pad, y + pad - 2), text, font=ft, fill=fg)
    return w

chips = ["SOCKS5", "HTTP", "Python", "Windows", "UU Remote"]
x = 64
for c in chips:
    w = chip(x, 330, c)
    x += w + 14

# 右侧拓扑示意图
def node(x, y, w, h, title, sub):
    d.rounded_rectangle([x, y, x + w, y + h], radius=14, fill=(15, 23, 42),
                        outline=(99, 102, 241), width=3)
    d.text((x + w / 2, y + 28), title, font=f(30, True), fill=(255, 255, 255), anchor="mm")
    d.text((x + w / 2, y + 58), sub, font=f(18), fill=(165, 180, 200), anchor="mm")

ax, node_w, node_h = 820, 150, 100
bx = 1080
ny = 250
node(ax, ny, node_w, node_h, "A 机", "出口 · Proxy :10800")
node(bx, ny, node_w, node_h, "B 机", "浏览 · 走 A 网")

my = ny + node_h / 2
d.line([(ax + node_w, my), (bx, my)], fill=(148, 163, 184), width=3)
d.polygon([(bx, my), (bx - 13, my - 8), (bx - 13, my + 8)], fill=(148, 163, 184))
d.polygon([(ax + node_w, my), (ax + node_w + 13, my - 8), (ax + node_w + 13, my + 8)],
          fill=(148, 163, 184))

label = "UU 远程端口映射"
lf = f(18)
lw = d.textlength(label, font=lf)
mx = (ax + node_w + bx) / 2
# 标签放在节点上方，避免压住节点内文字
d.rounded_rectangle([mx - lw / 2 - 12, my - 58, mx + lw / 2 + 12, my - 28], radius=9,
                    fill=(30, 41, 59), outline=(129, 140, 248))
d.text((mx, my - 43), label, font=lf, fill=(196, 181, 253), anchor="mm")

# 底部仓库地址
d.text((64, 576), "github.com/williampotee-88/uu-remote-proxy", font=f(26), fill=(148, 163, 184))

out = "social_preview.png"
img.save(out, "PNG")
print("saved", out, img.size)
