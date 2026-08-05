// 将 SVG 转换为 PNG 图标（macOS 自带 swift 运行）
// 用法: swift svg2png.swift <输入.svg> <输出.png> <尺寸>
import Foundation
import AppKit

let args = CommandLine.arguments
guard args.count == 4, let size = Int(args[3]) else {
    print("用法: swift svg2png.swift <input.svg> <output.png> <size>")
    exit(1)
}

let inputPath = args[1]
let outputPath = args[2]

guard let svgData = FileManager.default.contents(atPath: inputPath),
      let image = NSImage(data: svgData) else {
    print("SVG 解析失败: \(inputPath)")
    exit(1)
}
image.size = NSSize(width: size, height: size)

guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
) else {
    print("Bitmap 创建失败")
    exit(1)
}

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
image.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
NSGraphicsContext.restoreGraphicsState()

guard let png = bitmap.representation(using: .png, properties: [:]) else {
    print("PNG 导出失败")
    exit(1)
}
try? png.write(to: URL(fileURLWithPath: outputPath))
print("已生成 \(outputPath) (\(size)x\(size))")
