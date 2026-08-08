#!/usr/bin/env swift
// tools/ocr.swift — macOS Vision OCR 截图文字识别（零依赖，中文/英文）
// 用法：
//   tools/ocr <图片路径...>         # 识别一个或多个图片文件，按阅读顺序输出文字
//   tools/ocr --clipboard           # 识别剪贴板中的截图（⌘⇧4 截图后直接用）
//   tools/ocr --json <图片路径>     # 输出带归一化坐标的 JSON，用于理解页面布局
// 编译：swiftc -O -o tools/ocr tools/ocr.swift

import Vision
import AppKit

let args = CommandLine.arguments
let jsonMode = args.contains("--json")
let clipboard = args.contains("--clipboard")
let files = args.dropFirst().filter { !$0.hasPrefix("--") }

var jsonItems: [String] = []

func esc(_ s: String) -> String {
    s.replacingOccurrences(of: "\\", with: "\\\\")
     .replacingOccurrences(of: "\"", with: "\\\"")
}

func ocrImage(_ cg: CGImage) {
    let request = VNRecognizeTextRequest { req, _ in
        guard let obs = req.results as? [VNRecognizedTextObservation] else { return }
        // Vision 坐标原点在左下角：按 Y 从顶到底，同行按 X 从左到右
        let sorted = obs.sorted { a, b in
            if abs(a.boundingBox.midY - b.boundingBox.midY) > 0.012 {
                return a.boundingBox.midY > b.boundingBox.midY
            }
            return a.boundingBox.minX < b.boundingBox.minX
        }
        if jsonMode {
            for o in sorted {
                guard let t = o.topCandidates(1).first else { continue }
                let b = o.boundingBox
                jsonItems.append("{\"text\":\"\(esc(t.string))\",\"x\":\(b.minX),\"y\":\(b.minY),\"w\":\(b.width),\"h\":\(b.height)}")
            }
        } else {
            for o in sorted {
                if let t = o.topCandidates(1).first { print(t.string) }
            }
        }
    }
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.usesLanguageCorrection = true
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    try? handler.perform([request])
}

if clipboard {
    guard let img = NSPasteboard.general.readObjects(forClasses: [NSImage.self], options: nil)?.first as? NSImage,
          let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        print("ERR: 剪贴板中没有图片（请先 ⌘⇧4 截图或复制图片）")
        exit(1)
    }
    ocrImage(cg)
} else if files.isEmpty {
    print("用法: tools/ocr <图片路径...> | --clipboard | --json <图片路径>")
    exit(1)
} else {
    for f in files {
        guard let img = NSImage(contentsOfFile: f),
              let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            print("ERR: 无法读取 \(f)")
            continue
        }
        if !jsonMode { print("== \(f) ==") }
        ocrImage(cg)
    }
}

if jsonMode {
    print("[\(jsonItems.joined(separator: ","))]")
}
