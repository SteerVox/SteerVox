import AppKit
import Foundation
import ImageIO
import UniformTypeIdentifiers

struct Geometry {
    let frame: CGRect
    let scale: CGFloat

    init(frame: CGRect) {
        self.frame = frame
        self.scale = min(frame.width / 800, frame.height / 600)
    }

    func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
        CGPoint(x: frame.minX + x * scale, y: frame.minY + y * scale)
    }

    func rect(_ x: CGFloat, _ y: CGFloat, _ width: CGFloat, _ height: CGFloat) -> CGRect {
        CGRect(
            x: frame.minX + x * scale,
            y: frame.minY + y * scale,
            width: width * scale,
            height: height * scale
        )
    }

    func value(_ base: CGFloat) -> CGFloat {
        base * scale
    }
}

struct RibbonPalette {
    let glow: CGColor
    let shadow: CGColor
    let main: CGColor
    let highlight: CGColor
}

func cgColor(_ hex: Int, alpha: CGFloat = 1) -> CGColor {
    let red = CGFloat((hex >> 16) & 0xFF) / 255
    let green = CGFloat((hex >> 8) & 0xFF) / 255
    let blue = CGFloat(hex & 0xFF) / 255
    return NSColor(red: red, green: green, blue: blue, alpha: alpha).cgColor
}

func gradient(_ colors: [CGColor], locations: [CGFloat]) -> CGGradient {
    CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors as CFArray, locations: locations)!
}

func fitRect(content: CGSize, in bounds: CGRect) -> CGRect {
    let scale = min(bounds.width / content.width, bounds.height / content.height)
    let width = content.width * scale
    let height = content.height * scale
    return CGRect(
        x: bounds.midX - width / 2,
        y: bounds.midY - height / 2,
        width: width,
        height: height
    )
}

func withBitmap(width: Int, height: Int, draw: (CGContext, CGRect) -> Void) -> NSBitmapImageRep {
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: width,
        pixelsHigh: height,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    )!

    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let ctx = NSGraphicsContext.current!.cgContext
    let rect = CGRect(x: 0, y: 0, width: width, height: height)
    ctx.clear(rect)
    ctx.translateBy(x: 0, y: rect.height)
    ctx.scaleBy(x: 1, y: -1)
    ctx.setAllowsAntialiasing(true)
    ctx.setShouldAntialias(true)
    ctx.interpolationQuality = .high
    draw(ctx, rect)
    NSGraphicsContext.restoreGraphicsState()

    return rep
}

func writePNG(_ rep: NSBitmapImageRep, to url: URL) throws {
    let data = rep.representation(using: .png, properties: [:])!
    try data.write(to: url)
}

func writeICNS(to url: URL, draw: (CGContext, CGRect) -> Void) throws {
    let sizes = [16, 32, 64, 128, 256, 512, 1024]
    guard let destination = CGImageDestinationCreateWithURL(
        url as CFURL,
        UTType.icns.identifier as CFString,
        sizes.count,
        nil
    ) else {
        throw NSError(domain: "SteerVoxBranding", code: 1, userInfo: [NSLocalizedDescriptionKey: "Failed to create ICNS destination."])
    }

    for size in sizes {
        let rep = withBitmap(width: size, height: size, draw: draw)
        guard let cgImage = rep.cgImage else {
            throw NSError(domain: "SteerVoxBranding", code: 2, userInfo: [NSLocalizedDescriptionKey: "Failed to render CGImage for ICNS size \(size)."])
        }
        CGImageDestinationAddImage(destination, cgImage, nil)
    }

    if !CGImageDestinationFinalize(destination) {
        throw NSError(domain: "SteerVoxBranding", code: 3, userInfo: [NSLocalizedDescriptionKey: "Failed to finalize ICNS output."])
    }
}

func roundedRectPath(_ rect: CGRect, radius: CGFloat) -> CGPath {
    CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)
}

func wavePath(_ geometry: Geometry) -> CGPath {
    let path = CGMutablePath()
    path.move(to: geometry.point(10, 230))
    path.addLine(to: geometry.point(100, 230))
    path.addCurve(to: geometry.point(155, 205), control1: geometry.point(120, 230), control2: geometry.point(130, 205))
    path.addCurve(to: geometry.point(225, 265), control1: geometry.point(180, 205), control2: geometry.point(195, 265))
    path.addCurve(to: geometry.point(290, 175), control1: geometry.point(255, 265), control2: geometry.point(265, 175))
    path.addCurve(to: geometry.point(340, 230), control1: geometry.point(310, 175), control2: geometry.point(320, 230))
    return path
}

func ribbonPath(_ geometry: Geometry, startY: CGFloat) -> CGPath {
    let path = CGMutablePath()
    if startY == 200 {
        path.move(to: geometry.point(483, 200))
        path.addCurve(to: geometry.point(775, 190), control1: geometry.point(555, 150), control2: geometry.point(655, 150))
        return path
    }
    if startY == 230 {
        path.move(to: geometry.point(483, 230))
        path.addCurve(to: geometry.point(775, 250), control1: geometry.point(565, 220), control2: geometry.point(635, 290))
        return path
    }
    path.move(to: geometry.point(483, 260))
    path.addCurve(to: geometry.point(755, 340), control1: geometry.point(555, 290), control2: geometry.point(635, 370))
    return path
}

func supportPath(_ geometry: Geometry) -> CGPath {
    let path = CGMutablePath()
    path.move(to: geometry.point(300, 250))
    path.addLine(to: geometry.point(300, 330))
    path.addCurve(to: geometry.point(500, 330), control1: geometry.point(300, 392), control2: geometry.point(500, 392))
    path.addLine(to: geometry.point(500, 250))
    return path
}

func drawGradientStroke(
    _ ctx: CGContext,
    path: CGPath,
    width: CGFloat,
    gradient: CGGradient,
    start: CGPoint,
    end: CGPoint
) {
    ctx.saveGState()
    ctx.addPath(path)
    ctx.setLineWidth(width)
    ctx.setLineCap(.round)
    ctx.setLineJoin(.round)
    ctx.replacePathWithStrokedPath()
    ctx.clip()
    ctx.drawLinearGradient(gradient, start: start, end: end, options: [])
    ctx.restoreGState()
}

func stroke(
    _ ctx: CGContext,
    path: CGPath,
    color: CGColor,
    width: CGFloat,
    lineCap: CGLineCap = .round,
    lineJoin: CGLineJoin = .round
) {
    ctx.saveGState()
    ctx.addPath(path)
    ctx.setStrokeColor(color)
    ctx.setLineWidth(width)
    ctx.setLineCap(lineCap)
    ctx.setLineJoin(lineJoin)
    ctx.strokePath()
    ctx.restoreGState()
}

func fillRoundedRect(_ ctx: CGContext, rect: CGRect, radius: CGFloat, color: CGColor) {
    ctx.saveGState()
    ctx.addPath(roundedRectPath(rect, radius: radius))
    ctx.setFillColor(color)
    ctx.fillPath()
    ctx.restoreGState()
}

func drawBars(_ ctx: CGContext, geometry: Geometry, monochrome: Bool) {
    let barColors = monochrome
        ? Array(repeating: cgColor(0x000000), count: 9)
        : [
            cgColor(0x9CD254),
            cgColor(0xAED94B),
            cgColor(0xCDE33C),
            cgColor(0xEDDF30),
            cgColor(0xFCD233),
            cgColor(0xFDB535),
            cgColor(0xF98A35),
            cgColor(0xF98A35),
            cgColor(0xFCA734),
        ]

    let bars: [(CGFloat, CGFloat, CGFloat)] = [
        (340, 222, 16),
        (353, 215, 30),
        (366, 205, 50),
        (379, 190, 80),
        (392, 175, 110),
        (405, 190, 80),
        (418, 205, 50),
        (431, 215, 30),
        (444, 200, 60),
    ]

    for (index, bar) in bars.enumerated() {
        fillRoundedRect(
            ctx,
            rect: geometry.rect(bar.0, bar.1, 8, bar.2),
            radius: geometry.value(4),
            color: barColors[index]
        )
    }
}

func drawCoreMark(
    _ ctx: CGContext,
    geometry: Geometry,
    monochrome: Bool,
    glow: Bool,
    lightShell: Bool = false
) {
    let cyan = RibbonPalette(
        glow: cgColor(0x5ED0D7, alpha: glow ? 0.30 : 0),
        shadow: monochrome ? cgColor(0x000000) : cgColor(0x38B3BA),
        main: monochrome ? cgColor(0x000000) : cgColor(0x5ED0D7),
        highlight: monochrome ? cgColor(0x000000) : cgColor(0xB6F3F8)
    )
    let lime = RibbonPalette(
        glow: cgColor(0x98D746, alpha: glow ? 0.28 : 0),
        shadow: monochrome ? cgColor(0x000000) : cgColor(0x7AB92A),
        main: monochrome ? cgColor(0x000000) : cgColor(0x98D746),
        highlight: monochrome ? cgColor(0x000000) : cgColor(0xD5F99B)
    )
    let orange = RibbonPalette(
        glow: cgColor(0xF58723, alpha: glow ? 0.30 : 0),
        shadow: monochrome ? cgColor(0x000000) : cgColor(0xDE6C10),
        main: monochrome ? cgColor(0x000000) : cgColor(0xF58723),
        highlight: monochrome ? cgColor(0x000000) : cgColor(0xFFC684)
    )

    let wave = wavePath(geometry)
    let cyanPath = ribbonPath(geometry, startY: 200)
    let limePath = ribbonPath(geometry, startY: 230)
    let orangePath = ribbonPath(geometry, startY: 260)
    let support = supportPath(geometry)

    if glow {
        stroke(ctx, path: wave, color: cgColor(0xFFFFFF, alpha: 0.20), width: geometry.value(46))
        stroke(ctx, path: cyanPath, color: cyan.glow, width: geometry.value(52))
        stroke(ctx, path: limePath, color: lime.glow, width: geometry.value(52))
        stroke(ctx, path: orangePath, color: orange.glow, width: geometry.value(56))
    }

    if monochrome {
        stroke(ctx, path: wave, color: cgColor(0x000000), width: geometry.value(12))
    } else {
        drawGradientStroke(
            ctx,
            path: wave,
            width: geometry.value(12),
            gradient: gradient(
                lightShell
                    ? [cgColor(0xF7FBFF, alpha: 0.0), cgColor(0xB7C5D2)]
                    : [cgColor(0xE2E5E8, alpha: 0), cgColor(0xA5A9AE)],
                locations: [0, 1]
            ),
            start: geometry.point(10, 230),
            end: geometry.point(340, 230)
        )
        if lightShell {
            ctx.saveGState()
            ctx.translateBy(x: 0, y: geometry.value(-4))
            stroke(ctx, path: wave, color: cgColor(0xFFFFFF, alpha: 0.82), width: geometry.value(5.5))
            ctx.restoreGState()
        }
    }

    stroke(ctx, path: cyanPath, color: cyan.shadow, width: geometry.value(24))
    stroke(ctx, path: limePath, color: lime.shadow, width: geometry.value(24))
    stroke(ctx, path: orangePath, color: orange.shadow, width: geometry.value(24))

    if !monochrome {
        ctx.saveGState()
        ctx.translateBy(x: 0, y: -geometry.value(4))
        stroke(ctx, path: cyanPath, color: cyan.main, width: geometry.value(24))
        stroke(ctx, path: limePath, color: lime.main, width: geometry.value(24))
        stroke(ctx, path: orangePath, color: orange.main, width: geometry.value(24))
        ctx.restoreGState()

        ctx.saveGState()
        ctx.translateBy(x: 0, y: geometry.value(6))
        stroke(ctx, path: cyanPath, color: cyan.highlight, width: geometry.value(6))
        stroke(ctx, path: limePath, color: lime.highlight, width: geometry.value(6))
        stroke(ctx, path: orangePath, color: orange.highlight, width: geometry.value(6))
        ctx.restoreGState()
    }

    let shellFill = monochrome
        ? cgColor(0x000000)
        : lightShell
            ? cgColor(0xFFFFFF)
            : cgColor(0x2C2D2E)
    let shellOutline = lightShell ? cgColor(0x232A31, alpha: 0.34) : nil

    ctx.saveGState()
    ctx.setShadow(
        offset: CGSize(width: 0, height: geometry.value(8)),
        blur: geometry.value(glow ? (lightShell ? 26 : 18) : (lightShell ? 14 : 10)),
        color: lightShell
            ? cgColor(0x000000, alpha: glow ? 0.24 : 0.16)
            : cgColor(0x000000, alpha: glow ? 0.28 : 0.12)
    )
    fillRoundedRect(ctx, rect: geometry.rect(330, 100, 140, 260), radius: geometry.value(70), color: shellFill)
    stroke(ctx, path: support, color: shellFill, width: geometry.value(32))
    fillRoundedRect(ctx, rect: geometry.rect(385, 430, 30, 65), radius: geometry.value(8), color: shellFill)
    fillRoundedRect(ctx, rect: geometry.rect(310, 490, 180, 36), radius: geometry.value(18), color: shellFill)
    ctx.restoreGState()

    if let shellOutline, !monochrome {
        stroke(ctx, path: roundedRectPath(geometry.rect(330, 100, 140, 260), radius: geometry.value(70)), color: shellOutline, width: geometry.value(2.5))
        stroke(ctx, path: support, color: shellOutline, width: geometry.value(3.0))
        stroke(ctx, path: roundedRectPath(geometry.rect(385, 430, 30, 65), radius: geometry.value(8)), color: shellOutline, width: geometry.value(2.1))
        stroke(ctx, path: roundedRectPath(geometry.rect(310, 490, 180, 36), radius: geometry.value(18)), color: shellOutline, width: geometry.value(2.3))
    }

    if !monochrome {
        ctx.saveGState()
        ctx.addPath(roundedRectPath(geometry.rect(330, 100, 140, 260), radius: geometry.value(70)))
        ctx.clip()
        ctx.setStrokeColor(lightShell ? cgColor(0xFFFFFF, alpha: 0.70) : cgColor(0x3E4041, alpha: 0.50))
        ctx.setLineWidth(geometry.value(6))
        ctx.move(to: geometry.point(353, 126))
        ctx.addQuadCurve(to: geometry.point(386, 176), control: geometry.point(346, 160))
        ctx.strokePath()
        ctx.restoreGState()
    }

    drawBars(ctx, geometry: geometry, monochrome: monochrome)
}

func drawTransparentBrandMark(_ ctx: CGContext, rect: CGRect) {
    let compositionRect = CGRect(
        x: rect.minX + rect.width * 0.05,
        y: rect.minY + rect.height * 0.15,
        width: rect.width * 0.90,
        height: rect.height * 0.70
    )
    let artRect = fitRect(content: CGSize(width: 800, height: 600), in: compositionRect)
    drawCoreMark(ctx, geometry: Geometry(frame: artRect), monochrome: false, glow: false, lightShell: true)
}

func drawGlowLogoMark(_ ctx: CGContext, rect: CGRect) {
    ctx.saveGState()
    ctx.setFillColor(cgColor(0x000000))
    ctx.fill(rect)
    ctx.restoreGState()

    ctx.saveGState()
    ctx.drawRadialGradient(
        gradient([cgColor(0xFFFFFF, alpha: 0.92), cgColor(0xFFFFFF, alpha: 0)], locations: [0, 1]),
        startCenter: CGPoint(x: rect.midX - rect.width * 0.02, y: rect.midY),
        startRadius: rect.width * 0.02,
        endCenter: CGPoint(x: rect.midX - rect.width * 0.02, y: rect.midY),
        endRadius: rect.width * 0.30,
        options: []
    )
    ctx.restoreGState()

    ctx.saveGState()
    ctx.drawRadialGradient(
        gradient([cgColor(0x52E6FF, alpha: 0.42), cgColor(0x52E6FF, alpha: 0)], locations: [0, 1]),
        startCenter: CGPoint(x: rect.midX + rect.width * 0.22, y: rect.midY + rect.height * 0.05),
        startRadius: rect.width * 0.02,
        endCenter: CGPoint(x: rect.midX + rect.width * 0.22, y: rect.midY + rect.height * 0.05),
        endRadius: rect.width * 0.28,
        options: []
    )
    ctx.restoreGState()

    ctx.saveGState()
    ctx.drawRadialGradient(
        gradient([cgColor(0x9CEB3C, alpha: 0.34), cgColor(0x9CEB3C, alpha: 0)], locations: [0, 1]),
        startCenter: CGPoint(x: rect.midX + rect.width * 0.20, y: rect.midY - rect.height * 0.02),
        startRadius: rect.width * 0.01,
        endCenter: CGPoint(x: rect.midX + rect.width * 0.20, y: rect.midY - rect.height * 0.02),
        endRadius: rect.width * 0.22,
        options: []
    )
    ctx.restoreGState()

    ctx.saveGState()
    ctx.drawRadialGradient(
        gradient([cgColor(0xFF8D20, alpha: 0.36), cgColor(0xFF8D20, alpha: 0)], locations: [0, 1]),
        startCenter: CGPoint(x: rect.midX + rect.width * 0.16, y: rect.midY - rect.height * 0.16),
        startRadius: rect.width * 0.02,
        endCenter: CGPoint(x: rect.midX + rect.width * 0.16, y: rect.midY - rect.height * 0.16),
        endRadius: rect.width * 0.22,
        options: []
    )
    ctx.restoreGState()

    let compositionRect = CGRect(
        x: rect.minX + rect.width * 0.08,
        y: rect.minY + rect.height * 0.14,
        width: rect.width * 0.84,
        height: rect.height * 0.72
    )
    let artRect = fitRect(content: CGSize(width: 800, height: 600), in: compositionRect)
    drawCoreMark(ctx, geometry: Geometry(frame: artRect), monochrome: false, glow: true, lightShell: true)
}

func drawAppIcon(_ ctx: CGContext, rect: CGRect) {
    drawTransparentBrandMark(ctx, rect: rect)
}

func drawLogoCard(_ ctx: CGContext, rect: CGRect) {
    drawGlowLogoMark(ctx, rect: rect)
}

func drawTrayMark(_ ctx: CGContext, rect: CGRect) {
    let artRect = fitRect(content: CGSize(width: 800, height: 600), in: CGRect(x: 18, y: 34, width: rect.width - 36, height: rect.height - 68))
    let geometry = Geometry(frame: artRect)

    let wave = wavePath(geometry)
    let cyanPath = ribbonPath(geometry, startY: 200)
    let limePath = ribbonPath(geometry, startY: 230)
    let orangePath = ribbonPath(geometry, startY: 260)
    let support = supportPath(geometry)

    stroke(ctx, path: wave, color: cgColor(0x000000), width: geometry.value(18))
    stroke(ctx, path: cyanPath, color: cgColor(0x000000), width: geometry.value(26))
    stroke(ctx, path: limePath, color: cgColor(0x000000), width: geometry.value(26))
    stroke(ctx, path: orangePath, color: cgColor(0x000000), width: geometry.value(28))
    fillRoundedRect(ctx, rect: geometry.rect(330, 100, 140, 260), radius: geometry.value(70), color: cgColor(0x000000))
    stroke(ctx, path: support, color: cgColor(0x000000), width: geometry.value(36))
    fillRoundedRect(ctx, rect: geometry.rect(385, 430, 30, 65), radius: geometry.value(8), color: cgColor(0x000000))
    fillRoundedRect(ctx, rect: geometry.rect(310, 490, 180, 36), radius: geometry.value(18), color: cgColor(0x000000))
}

let outputDir: URL = {
    if let path = CommandLine.arguments.dropFirst().first {
        return URL(fileURLWithPath: path, isDirectory: true)
    }
    return URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("frontend/public", isDirectory: true)
}()

let icnsURL: URL? = {
    guard CommandLine.arguments.count > 2 else { return nil }
    return URL(fileURLWithPath: CommandLine.arguments[2])
}()

try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)
if let icnsURL {
    try FileManager.default.createDirectory(at: icnsURL.deletingLastPathComponent(), withIntermediateDirectories: true)
}

let brandIconURL = outputDir.appendingPathComponent("brand-mark.png")
let logoURL = outputDir.appendingPathComponent("logo-mark.png")
let trayURL = outputDir.appendingPathComponent("tray-mark.png")

try writePNG(withBitmap(width: 1024, height: 1024, draw: drawAppIcon), to: brandIconURL)
try writePNG(withBitmap(width: 1024, height: 1024, draw: drawLogoCard), to: logoURL)
try writePNG(withBitmap(width: 512, height: 512, draw: drawTrayMark), to: trayURL)
if let icnsURL {
    try writeICNS(to: icnsURL, draw: drawAppIcon)
}

print("Generated \(brandIconURL.path)")
print("Generated \(logoURL.path)")
print("Generated \(trayURL.path)")
if let icnsURL {
    print("Generated \(icnsURL.path)")
}
