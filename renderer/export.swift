import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

struct Book: Decodable {
    struct Layout: Decodable {
        let trimWidth: CGFloat
        let trimHeight: CGFloat
        let bleed: CGFloat
    }

    struct Spread: Decodable {
        let paper: String
        let layers: [Layer]
    }

    struct Layer: Decodable {
        enum Kind: String, Decodable { case photo, text }
        let type: Kind
        let frame: Rect
        let image: Rect?
        let assetId: String?
        let lines: [String]?
        let style: TextStyle?
        let align: String?
    }

    struct TextStyle: Decodable {
        let nativeFont: String
        let size: CGFloat
        let leading: CGFloat
        let color: String
    }

    let layout: Layout
    let spreads: [Spread]
}

struct Rect: Decodable {
    let x: CGFloat
    let y: CGFloat
    let width: CGFloat
    let height: CGFloat

    func quartz(pageX: CGFloat, pageHeight: CGFloat) -> CGRect {
        CGRect(x: x - pageX, y: pageHeight - y - height, width: width, height: height)
    }
}

enum ExportError: String, Error {
    case invalidImage = "A book photo could not be read as a JPEG."
    case invalidLayout = "The book contains an invalid layout."
    case contextUnavailable = "The PDF file could not be created."
}

// These map the raw JPEG unit square into the oriented unit square, in Quartz coordinates.
let orientations: [UInt32: CGAffineTransform] = [
    2: CGAffineTransform(a: -1, b: 0, c: 0, d: 1, tx: 1, ty: 0),
    3: CGAffineTransform(a: -1, b: 0, c: 0, d: -1, tx: 1, ty: 1),
    4: CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: 1),
    5: CGAffineTransform(a: 0, b: -1, c: -1, d: 0, tx: 1, ty: 1),
    6: CGAffineTransform(a: 0, b: -1, c: 1, d: 0, tx: 0, ty: 1),
    7: CGAffineTransform(a: 0, b: 1, c: 1, d: 0, tx: 0, ty: 0),
    8: CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: 1, ty: 0),
]

struct JPEG {
    let image: CGImage
    let orientation: UInt32

    init(url: URL) throws {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              CGImageSourceGetType(source) as String? == UTType.jpeg.identifier,
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            throw ExportError.invalidImage
        }
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        self.image = image
        orientation = (properties?[kCGImagePropertyOrientation] as? NSNumber)?.uint32Value ?? 1
    }

    func draw(in pdf: CGContext, at rect: CGRect) {
        pdf.translateBy(x: rect.minX, y: rect.minY)
        pdf.scaleBy(x: rect.width, y: rect.height)
        pdf.concatenate(orientations[orientation] ?? .identity)
        pdf.draw(image, in: CGRect(x: 0, y: 0, width: 1, height: 1))
    }
}

func color(_ hex: String) throws -> CGColor {
    guard hex.count == 7, hex.first == "#", let value = UInt32(hex.dropFirst(), radix: 16) else {
        throw ExportError.invalidLayout
    }
    return CGColor(
        red: CGFloat((value >> 16) & 255) / 255,
        green: CGFloat((value >> 8) & 255) / 255,
        blue: CGFloat(value & 255) / 255,
        alpha: 1
    )
}

func drawText(_ layer: Book.Layer, in pdf: CGContext, pageX: CGFloat, height: CGFloat) throws {
    guard let style = layer.style, let lines = layer.lines,
          (1...200).contains(style.size), (1...250).contains(style.leading),
          ["Georgia", "HelveticaNeue"].contains(style.nativeFont),
          lines.count <= 100 else {
        throw ExportError.invalidLayout
    }
    let font = CTFontCreateWithName(style.nativeFont as CFString, style.size, nil)
    let attributes = [
        kCTFontAttributeName: font,
        kCTForegroundColorAttributeName: try color(style.color),
    ] as CFDictionary
    pdf.textMatrix = .identity
    for (index, line) in lines.enumerated() {
        let text = CFAttributedStringCreate(nil, line as CFString, attributes)!
        let ctLine = CTLineCreateWithAttributedString(text)
        let width = CGFloat(CTLineGetTypographicBounds(ctLine, nil, nil, nil))
        let available = layer.frame.width - width
        let offset = layer.align == "center" ? available / 2 : layer.align == "right" ? available : 0
        pdf.textPosition = CGPoint(
            x: layer.frame.x - pageX + offset,
            y: height - layer.frame.y - style.size - CGFloat(index) * style.leading
        )
        CTLineDraw(ctLine, pdf)
    }
}

func export(book: Book, assets: URL, output: URL) throws {
    let layout = book.layout
    let pageWidth = layout.trimWidth + layout.bleed
    let pageHeight = layout.trimHeight + 2 * layout.bleed
    var mediaBox = CGRect(x: 0, y: 0, width: pageWidth, height: pageHeight)
    guard let pdf = CGContext(output as CFURL, mediaBox: &mediaBox, nil) else {
        throw ExportError.contextUnavailable
    }
    let bleedBox = withUnsafeBytes(of: &mediaBox) { Data($0) }
    var photos: [String: JPEG] = [:]

    for spread in book.spreads {
        guard spread.layers.count <= 12 else { throw ExportError.invalidLayout }
        let paper = try color(spread.paper)
        for isLeft in [true, false] {
            let pageX: CGFloat = isLeft ? 0 : pageWidth
            var trimBox = CGRect(
                x: isLeft ? layout.bleed : 0,
                y: layout.bleed,
                width: layout.trimWidth,
                height: layout.trimHeight
            )
            pdf.beginPDFPage([
                kCGPDFContextTrimBox: withUnsafeBytes(of: &trimBox) { Data($0) },
                kCGPDFContextBleedBox: bleedBox,
            ] as CFDictionary)
            pdf.setFillColor(paper)
            pdf.fill(mediaBox)
            for layer in spread.layers {
                let frame = layer.frame.quartz(pageX: pageX, pageHeight: pageHeight)
                if !frame.intersects(mediaBox) { continue }
                pdf.saveGState()
                pdf.clip(to: frame.intersection(mediaBox))
                switch layer.type {
                case .photo:
                    guard let id = layer.assetId, let image = layer.image,
                          id.range(of: #"^[a-zA-Z0-9-]{1,64}$"#, options: .regularExpression) != nil,
                          image.width > 0, image.height > 0,
                          image.width < 1_000_000_000, image.height < 1_000_000_000 else {
                        throw ExportError.invalidLayout
                    }
                    let photo = try photos[id] ?? JPEG(url: assets.appendingPathComponent(id + ".jpg"))
                    photos[id] = photo
                    photo.draw(in: pdf, at: image.quartz(pageX: pageX, pageHeight: pageHeight))
                case .text:
                    try drawText(layer, in: pdf, pageX: pageX, height: pageHeight)
                }
                pdf.restoreGState()
            }
            pdf.endPDFPage()
        }
    }
    pdf.closePDF()
}

do {
    guard CommandLine.arguments.count == 3 else { throw ExportError.invalidLayout }
    let plan = URL(fileURLWithPath: CommandLine.arguments[1])
    let book = try JSONDecoder().decode(Book.self, from: Data(contentsOf: plan))
    try export(book: book, assets: plan.deletingLastPathComponent(), output: URL(fileURLWithPath: CommandLine.arguments[2]))
} catch {
    let message = (error as? ExportError)?.rawValue ?? "The renderer could not read the book layout."
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}
