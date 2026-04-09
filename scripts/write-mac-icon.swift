import AppKit
import Foundation
import ImageIO
import UniformTypeIdentifiers

enum IconBuildError: LocalizedError {
    case invalidArguments
    case failedToLoadImage(String)
    case failedToCreateBitmap(Int)
    case failedToCreateIcnsDestination(String)
    case failedToFinalizeIcns(String)

    var errorDescription: String? {
        switch self {
        case .invalidArguments:
            return "Usage: write-mac-icon.swift <source-png> <output-png> <output-icns>"
        case .failedToLoadImage(let path):
            return "Failed to load app icon source image at \(path)."
        case .failedToCreateBitmap(let size):
            return "Failed to render bitmap for icon size \(size)."
        case .failedToCreateIcnsDestination(let path):
            return "Failed to create ICNS destination at \(path)."
        case .failedToFinalizeIcns(let path):
            return "Failed to finalize ICNS output at \(path)."
        }
    }
}

func makeBitmap(from image: NSImage, size: Int) throws -> NSBitmapImageRep {
    guard let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: size,
        pixelsHigh: size,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ) else {
        throw IconBuildError.failedToCreateBitmap(size)
    }

    rep.size = NSSize(width: size, height: size)

    NSGraphicsContext.saveGraphicsState()
    defer { NSGraphicsContext.restoreGraphicsState() }

    guard let context = NSGraphicsContext(bitmapImageRep: rep) else {
        throw IconBuildError.failedToCreateBitmap(size)
    }

    NSGraphicsContext.current = context
    context.imageInterpolation = .high
    NSColor.clear.setFill()
    NSBezierPath(rect: NSRect(x: 0, y: 0, width: size, height: size)).fill()
    image.draw(
        in: NSRect(x: 0, y: 0, width: size, height: size),
        from: .zero,
        operation: .sourceOver,
        fraction: 1.0
    )
    return rep
}

let arguments = Swift.CommandLine.arguments

guard arguments.count == 4 else {
    throw IconBuildError.invalidArguments
}

let sourceURL = URL(fileURLWithPath: arguments[1])
let outputPNGURL = URL(fileURLWithPath: arguments[2])
let outputICNSURL = URL(fileURLWithPath: arguments[3])

guard let image = NSImage(contentsOf: sourceURL) else {
    throw IconBuildError.failedToLoadImage(sourceURL.path)
}

try FileManager.default.createDirectory(at: outputPNGURL.deletingLastPathComponent(), withIntermediateDirectories: true)
try FileManager.default.createDirectory(at: outputICNSURL.deletingLastPathComponent(), withIntermediateDirectories: true)

let exportSizes = [16, 32, 64, 128, 256, 512, 1024]
let pngRep = try makeBitmap(from: image, size: 1024)
guard let pngData = pngRep.representation(using: NSBitmapImageRep.FileType.png, properties: [:]) else {
    throw IconBuildError.failedToCreateBitmap(1024)
}
try pngData.write(to: outputPNGURL)

guard let destination = CGImageDestinationCreateWithURL(
    outputICNSURL as CFURL,
    UTType.icns.identifier as CFString,
    exportSizes.count,
    nil
) else {
    throw IconBuildError.failedToCreateIcnsDestination(outputICNSURL.path)
}

for size in exportSizes {
    let rep = try makeBitmap(from: image, size: size)
    guard let cgImage = rep.cgImage else {
        throw IconBuildError.failedToCreateBitmap(size)
    }
    CGImageDestinationAddImage(destination, cgImage, nil)
}

if !CGImageDestinationFinalize(destination) {
    throw IconBuildError.failedToFinalizeIcns(outputICNSURL.path)
}
