import CocoCore
import CoreGraphics
import Vision

enum TextRecognizer {
    static func recognize(_ image: CGImage) throws -> [TextBox] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .fast
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image).perform([request])
        return (request.results ?? []).compactMap { observation in
            observation.topCandidates(1).first.map { TextBox(text: $0.string, rect: observation.boundingBox) }
        }
    }
}
