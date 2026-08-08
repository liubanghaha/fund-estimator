# 截图识别工具

让 AI（纯文本模型）"看到"你发的截图。**用法：把截图保存到项目任意位置（或告诉我路径），我运行下面的命令读取文字。**

## 1. OCR 文字提取（已就绪 ✅ 零依赖）

macOS 自带 Vision 框架，中文识别准确，秒级返回。

```bash
./tools/ocr 图片.png              # 按阅读顺序输出全部文字
./tools/ocr --clipboard           # 识别剪贴板截图（⌘⇧4 截图后直接用）
./tools/ocr --json 图片.png       # 输出带坐标的 JSON（分析页面布局用）
```

重新编译（改源码后）：`swiftc -O -o tools/ocr tools/ocr.swift`

**能力边界**：只能提取文字/数字，看不出图形特征（曲线形状、颜色、布局）。

## 2. 视觉模型看图（DeepSeek-VL2，待网络就绪 ⏸️）

方案：`mlx-vlm` + `mlx-community/deepseek-vl2-tiny-4bit`（HF 下载约 2GB），M1 Pro 可跑。

**已安装**：`~/.venvs/vlm`（mlx-vlm 0.6.8，支持 deepseek_vl_v2 架构）

**未完成原因**：2026-08-03 实测当前网络对 HuggingFace（190B/s）和 ModelScope（1KB/s）限速，2GB 模型无法下载。清华镜像等国内源正常。

**恢复步骤**（有代理/网络恢复后执行）：

```bash
# ① 下载模型（HF 官方源，需代理；或换国内镜像）
export HF_ENDPOINT=https://hf-mirror.com
~/.venvs/vlm/bin/python -m mlx_vlm.generate \
  --model mlx-community/deepseek-vl2-tiny-4bit \
  --image 图片.png --prompt "描述这张截图" --max-tokens 300

# ② 或从 ModelScope 下载原始权重后本地转 MLX 4bit
#    pip install modelscope -i https://pypi.tuna.tsinghua.edu.cn/simple
#    modelscope download --model deepseek-ai/DeepSeek-VL2-tiny
#    ~/.venvs/vlm/bin/python -m mlx_vlm.convert \
#      --hf-path ./DeepSeek-VL2-tiny --mlx-path ./vl2-tiny-mlx -q --q-bits 4
```

**替代方案**（无需本地下载）：
- 硅基流动 SiliconFlow API：托管 DeepSeek-OCR / 开源视觉模型，OpenAI 兼容，需注册 key
- 阿里云百炼 Qwen-VL / 腾讯混元视觉：需 key

## 3. 推荐工作流

```
你发截图 → 我跑 ./tools/ocr 提取文字数值 → 结合代码定位问题
（VL 模型就绪后：我直接"看图"描述图形特征，配合 OCR 双通道）
```
