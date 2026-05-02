/*
 * YOLODecoder.swift
 *
 * Decodes raw CoreML model outputs into YOLODetection instances.
 * Handles three YOLO CoreML export formats:
 *   A: NMS-pipelined (VNRecognizedObjectObservation from Vision framework)
 *   B: Traditional [1, 4+nc, num_anchors] — raw xywh + class confidences, needs NMS
 *   C: End-to-end [1, max_det, 6] — xyxy pixel coords, NMS already applied
 *
 * Also handles segmentation mask decoding (prototype @ coefficients) and
 * pose keypoint decoding (17 COCO keypoints appended after class confidences).
 */

import CoreML
import CoreVideo
import Foundation
import Vision

enum YOLODecoder {
    // MARK: - Format A: Vision NMS-pipelined (VNRecognizedObjectObservation)

    /// Decode detections from VNCoreMLRequest results when model uses NMS output layer.
    /// Vision framework handles NMS internally and returns VNRecognizedObjectObservation.
    static func decodeVisionNMS(
        from results: [VNObservation],
        classLabels: [String],
        task: YOLOTask,
        confidence: Float,
        maxSize: CGSize
    ) -> [YOLODetection] {
        guard let observations = results as? [VNRecognizedObjectObservation] else { return [] }

        return observations.compactMap { obs in
            guard let bestLabel = obs.labels.first, bestLabel.confidence >= confidence else { return nil }

            let classIndex = bestLabel.identifier.flatMap { Int($0) } ?? 0
            let label = classIndex < classLabels.count ? classLabels[classIndex] : "class_\(classIndex)"

            // Vision uses bottom-left origin, convert to top-left (0,0 = top-left)
            let bb = obs.boundingBox
            let bbox = NormalizedBoundingBox(
                x1: bb.origin.x,
                y1: 1.0 - bb.origin.y - bb.height,
                x2: bb.origin.x + bb.width,
                y2: 1.0 - bb.origin.y
            )

            return YOLODetection(
                bbox: bbox,
                confidence: Double(bestLabel.confidence),
                classIndex: classIndex,
                classLabel: label,
                task: task
            )
        }
    }

    // MARK: - Format B: Traditional [1, 4+nc, num_anchors]

    /// Decode traditional YOLO output: raw xywh center + class confidences.
    /// Requires Swift-side NMS.
    static func decodeTraditional(
        output: MLMultiArray,
        classLabels: [String],
        task: YOLOTask,
        confidence: Float,
        iouThreshold: Float,
        maxDetections: Int,
        inputSize: Int
    ) -> [YOLODetection] {
        let nc = classLabels.count
        // Shape: [1, 4+nc+extra, num_anchors] where extra depends on task
        // For detect: [1, 4+nc, 8400]
        // For segment: [1, 4+nc+32, 8400]
        // For pose:   [1, 4+nc+51, 8400]
        let numAnchors = output.shape[2].intValue
        let channels = output.shape[1].intValue
        let strides = output.strides

        var candidates: [(CGRect, Float, Int, [Float]?, [YOLOKeypoint]?)] = []

        for a in 0..<numAnchors {
            // xywh center format (pixels)
            let cx = output[[0, 0, a] as [NSNumber]].floatValue
            let cy = output[[0, 1, a] as [NSNumber]].floatValue
            let w = output[[0, 2, a] as [NSNumber]].floatValue
            let h = output[[0, 3, a] as [NSNumber]].floatValue

            // Find best class
            var bestClass = 0
            var bestScore: Float = 0
            for c in 0..<nc {
                let score = output[[0, NSNumber(value: 4 + c), NSNumber(value: a)] as [NSNumber]].floatValue
                if score > bestScore {
                    bestScore = score
                    bestClass = c
                }
            }

            guard bestScore >= confidence else { continue }

            // Convert xywh to xyxy normalized
            let x1 = (cx - w / 2) / Float(inputSize)
            let y1 = (cy - h / 2) / Float(inputSize)
            let x2 = (cx + w / 2) / Float(inputSize)
            let y2 = (cy + h / 2) / Float(inputSize)
            let box = CGRect(x: CGFloat(x1), y: CGFloat(y1), width: CGFloat(x2 - x1), height: CGFloat(y2 - y1))

            // Segmentation: 32 mask coefficients
            var maskCoeffs: [Float]?
            if task == .segment {
                let offset = 4 + nc
                var coeffs = [Float](repeating: 0, count: 32)
                for i in 0..<32 {
                    coeffs[i] = output[[0, NSNumber(value: offset + i), NSNumber(value: a)] as [NSNumber]].floatValue
                }
                maskCoeffs = coeffs
            }

            // Pose: 17 keypoints x 3 (x, y, confidence)
            var keypoints: [YOLOKeypoint]?
            if task == .pose {
                let offset = 4 + nc
                var kps: [YOLOKeypoint] = []
                for k in 0..<17 {
                    let kx = output[[0, NSNumber(value: offset + k * 3), NSNumber(value: a)] as [NSNumber]].floatValue
                    let ky = output[[0, NSNumber(value: offset + k * 3 + 1), NSNumber(value: a)] as [NSNumber]].floatValue
                    let kc = output[[0, NSNumber(value: offset + k * 3 + 2), NSNumber(value: a)] as [NSNumber]].floatValue
                    let name = k < COCOKeypointNames.count ? COCOKeypointNames[k] : "keypoint_\(k)"
                    kps.append(YOLOKeypoint(
                        name: name,
                        x: Double(kx) / Double(inputSize),
                        y: Double(ky) / Double(inputSize),
                        confidence: Double(kc)
                    ))
                }
                keypoints = kps
            }

            candidates.append((box, bestScore, bestClass, maskCoeffs, keypoints))
        }

        // NMS
        let boxes = candidates.map { $0.0 }
        let scores = candidates.map { $0.1 }
        let keptIndices = nonMaxSuppression(boxes: boxes, scores: scores, threshold: iouThreshold)

        let limitedIndices = Array(keptIndices.prefix(maxDetections))

        return limitedIndices.map { idx in
            let (box, score, classIdx, maskCoeffs, keypoints) = candidates[idx]
            let label = classIdx < classLabels.count ? classLabels[classIdx] : "class_\(classIdx)"

            return YOLODetection(
                bbox: NormalizedBoundingBox(
                    x1: Double(box.origin.x),
                    y1: Double(box.origin.y),
                    x2: Double(box.origin.x + box.width),
                    y2: Double(box.origin.y + box.height)
                ),
                confidence: Double(score),
                classIndex: classIdx,
                classLabel: label,
                task: task,
                maskCoefficients: maskCoeffs,
                keypoints: keypoints
            )
        }
    }

    // MARK: - Format C: End-to-end [1, max_det, 6]

    /// Decode end-to-end YOLO output: xyxy pixel coords with NMS already applied.
    /// Shape: [1, max_det, 6] where each row is [x1, y1, x2, y2, confidence, classIndex]
    static func decodeEndToEnd(
        output: MLMultiArray,
        classLabels: [String],
        task: YOLOTask,
        confidence: Float,
        maxDetections: Int,
        inputSize: Int
    ) -> [YOLODetection] {
        let numDets = output.shape[1].intValue
        var detections: [YOLODetection] = []

        for i in 0..<min(numDets, maxDetections) {
            let x1 = output[[0, i, 0] as [NSNumber]].floatValue
            let y1 = output[[0, i, 1] as [NSNumber]].floatValue
            let x2 = output[[0, i, 2] as [NSNumber]].floatValue
            let y2 = output[[0, i, 3] as [NSNumber]].floatValue
            let conf = output[[0, i, 4] as [NSNumber]].floatValue
            let cls = output[[0, i, 5] as [NSNumber]].intValue

            guard conf >= confidence else { break } // End-to-end outputs are sorted by confidence
            guard x1 > 0 || y1 > 0 || x2 > 0 || y2 > 0 else { continue } // Skip zero padding

            let classIndex = max(0, min(cls, classLabels.count - 1))
            let label = classLabels[classIndex]

            detections.append(YOLODetection(
                bbox: NormalizedBoundingBox(
                    x1: Double(x1) / Double(inputSize),
                    y1: Double(y1) / Double(inputSize),
                    x2: Double(x2) / Double(inputSize),
                    y2: Double(y2) / Double(inputSize)
                ),
                confidence: Double(conf),
                classIndex: classIndex,
                classLabel: label,
                task: task
            ))
        }

        return detections
    }

    // MARK: - NMS (Greedy IoU)

    /// Greedy Non-Maximum Suppression.
    /// Returns indices of kept boxes, sorted by descending score.
    static func nonMaxSuppression(boxes: [CGRect], scores: [Float], threshold: Float) -> [Int] {
        guard !boxes.isEmpty else { return [] }

        // Sort by score descending
        let sortedIndices = scores.indices.sorted { scores[$0] > scores[$1] }
        var kept: [Int] = []
        var suppressed = Set<Int>()

        for idx in sortedIndices {
            guard !suppressed.contains(idx) else { continue }
            kept.append(idx)

            for otherIdx in sortedIndices where otherIdx != idx && !suppressed.contains(otherIdx) {
                let iou = computeIoU(boxes[idx], boxes[otherIdx])
                if iou > threshold {
                    suppressed.insert(otherIdx)
                }
            }
        }

        return kept
    }

    // MARK: - Segmentation Mask Decoding

    /// Decode segmentation mask from prototype masks and per-detection coefficients.
    /// Returns a CGImage mask (8-bit grayscale) resized to the given dimensions.
    static func decodeMask(
        protoMasks: MLMultiArray,
        coefficients: [Float],
        outputSize: CGSize
    ) -> CGImage? {
        // protoMasks shape: [1, 32, proto_h, proto_w]
        let protoH = protoMasks.shape[2].intValue
        let protoW = protoMasks.shape[3].intValue
        guard coefficients.count == 32, protoH > 0, protoW > 0 else { return nil }

        // Compute mask = sigmoid(coefficients @ prototypes)
        // For each spatial position: mask[h,w] = sigmoid(sum(coeff[i] * proto[i,h,w]))
        var maskData = [UInt8](repeating: 0, count: protoH * protoW)

        for h in 0..<protoH {
            for w in 0..<protoW {
                var sum: Float = 0
                for c in 0..<32 {
                    let proto = protoMasks[[0, c, h, w] as [NSNumber]].floatValue
                    sum += coefficients[c] * proto
                }
                // Sigmoid
                let sigmoid = 1.0 / (1.0 + expf(-sum))
                // Threshold at 0.5, scale to 0-255
                maskData[h * protoW + w] = sigmoid > 0.5 ? 255 : 0
            }
        }

        // Create CGImage from mask data
        let colorSpace = CGColorSpaceCreateDeviceGray()
        guard let context = CGContext(
            data: &maskData,
            width: protoW,
            height: protoH,
            bitsPerComponent: 8,
            bytesPerRow: protoW,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else { return nil }

        guard let cgImage = context.makeImage() else { return nil }

        // Resize to output dimensions
        let scaledSize = outputSize
        guard scaledSize.width > 0, scaledSize.height > 0 else { return cgImage }

        let destContext = CGContext(
            data: nil,
            width: Int(scaledSize.width),
            height: Int(scaledSize.height),
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.none.rawValue
        )
        destContext?.interpolationQuality = .none
        destContext?.draw(cgImage, in: CGRect(origin: .zero, size: scaledSize))

        return destContext?.makeImage()
    }

    // MARK: - Output Format Detection

    /// Detect which YOLO output format the model uses based on output tensor shapes.
    static func detectOutputFormat(model: MLModel) -> YOLOOutputFormat {
        guard let description = try? model.prediction(from: MLFeatureProvider()) else {
            return .traditional
        }
        let outputNames = description.featureNames

        // Vision NMS output: returns VNRecognizedObjectObservation (handled by Vision)
        // We detect this at runtime by checking VNObservation types

        // End-to-end: single output [1, max_det, 6]
        if let name = outputNames.first {
            if let value = try? description.featureValue(for: name),
               let array = value.multiArrayValue {
                if array.shape.count == 3 && array.shape[2].intValue == 6 {
                    return .endToEnd
                }
            }
        }

        return .traditional
    }

    // MARK: - IoU

    private static func computeIoU(_ a: CGRect, _ b: CGRect) -> Float {
        let intersection = a.intersection(b)
        guard !intersection.isNull else { return 0 }
        let unionArea = a.width * a.height + b.width * b.height - intersection.width * intersection.height
        guard unionArea > 0 else { return 0 }
        return Float((intersection.width * intersection.height) / unionArea)
    }
}

// MARK: - Output Format

enum YOLOOutputFormat {
    case visionNMS      // VNRecognizedObjectObservation
    case traditional    // [1, 4+nc, anchors] — needs NMS
    case endToEnd       // [1, max_det, 6] — NMS already applied
}
