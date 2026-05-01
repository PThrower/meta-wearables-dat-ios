// ToolMeasurementStage.swift
// Pipeline stage actor for measuring fastener/tool dimensions in mm.
// Uses VNDetectRectanglesRequest (reference cards) + VNDetectContoursRequest
// (fastener outlines) + homography solver for pixel-to-mm calibration.
// activationMode: "measure" — dispatched as measure_stage_config from server.

import CoreImage
import CoreMedia
import CoreVideo
import Foundation
import Vision

actor ToolMeasurementStage: @preconcurrency FramePipelineStage {
    nonisolated let stageId: String = "measure"
    var config: FrameStageConfig

    // Measurement configuration
    private var measureConfig: ToolMeasureConfig

    // Homography calibration state
    private var lastHomography: Matrix3x3?
    private var smoothedDimensions: (width: Double, height: Double)?
    private var consecutiveDetections: Int = 0

    // Dual output
    var onResult: ((ToolMeasureResult) async -> Void)?
    var previewBus: PreviewBus?

    // Stage state
    private var isRunning = false
    private var lastProcessTime: ContinuousClock.Instant = .now

    init(config: ToolMeasureConfig = ToolMeasureConfig()) {
        self.config = FrameStageConfig(targetFPS: UInt(max(1, config.targetFPS)), isEnabled: true)
        self.measureConfig = config
    }

    func setOnResult(_ handler: @escaping (ToolMeasureResult) async -> Void) {
        self.onResult = handler
    }

    func setPreviewBus(_ bus: PreviewBus) {
        self.previewBus = bus
    }

    func updateConfig(_ newConfig: ToolMeasureConfig) {
        self.measureConfig = newConfig
        self.config = FrameStageConfig(targetFPS: UInt(max(1, newConfig.targetFPS)), isEnabled: true)
        self.lastHomography = nil
        self.smoothedDimensions = nil
        self.consecutiveDetections = 0
    }

    func start() async {
        guard !isRunning else { return }
        isRunning = true
        lastHomography = nil
        smoothedDimensions = nil
        consecutiveDetections = 0
        NSLog("[ToolMeasurementStage] Started: ref=\(measureConfig.referenceObject) maxError=\(measureConfig.maxMeasurementError)mm fps=\(measureConfig.targetFPS)")
    }

    func stop() async {
        isRunning = false
        lastHomography = nil
        smoothedDimensions = nil
        consecutiveDetections = 0
        NSLog("[ToolMeasurementStage] Stopped")
    }

    func processFrame(_ packet: FramePacket) async {
        guard isRunning else { return }

        // FPS throttle
        let now = ContinuousClock.now
        let elapsed = now.duration(to: packet.timestamp).components.seconds
        if abs(elapsed) < 1.0 / Double(max(1, measureConfig.targetFPS)) { return }

        let startTime = CFAbsoluteTimeGetCurrent()

        do {
            let result = try analyzeFrame(packet)
            if let result {
                consecutiveDetections += 1
                await onResult?(result)

                #if DEBUG
                let source = PreviewSource(stageId: "measure", label: "Tool Measure")
                await previewBus?.publish(.json(source: source, value: result.jsonDict()))
                #endif
            } else {
                consecutiveDetections = 0
            }
        } catch {
            NSLog("[ToolMeasurementStage] Frame analysis error: \(error)")
        }

        lastProcessTime = packet.timestamp
    }

    // MARK: - Frame Analysis

    private func analyzeFrame(_ packet: FramePacket) throws -> ToolMeasureResult? {
        let pixelBuffer = packet.sampleBuffer.imageBuffer ?? CMSampleBufferGetImageBuffer(packet.sampleBuffer)
        guard let pixelBuffer else { return nil }

        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        guard width > 0, height > 0 else { return nil }

        // Create CIImage from pixel buffer
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)

        // Create CGImage for Vision requests that need it
        let ciContext = CIContext(options: [.useSoftwareRenderer: false])
        guard let cgImage = ciContext.createCGImage(ciImage, from: ciImage.extent) else { return nil }

        // Step 1: Detect reference object
        guard let refResult = detectReferenceObject(cgImage: cgImage, width: width, height: height) else {
            return nil
        }

        // Step 2: Detect target contour (fastener)
        guard let contourResult = detectTargetContour(cgImage: cgImage) else {
            return nil
        }

        // Step 3: Compute homography from reference object
        let H: Matrix3x3
        if let cachedH = lastHomography {
            H = cachedH
        } else {
            guard let computedH = HomographySolver.solve(
                src: refResult.pixelCorners,
                dst: refResult.mmCorners
            ) else {
                return nil
            }
            H = computedH
            lastHomography = H
        }

        // Step 4: Transform contour bounding box to mm
        let contourBox = contourResult.boundingBox
        let topLeft = HomographySolver.transformPoint(
            (Double(contourBox.origin.x) * Double(width), Double(contourBox.origin.y) * Double(height)),
            H: H
        )
        let bottomRight = HomographySolver.transformPoint(
            (Double(contourBox.origin.x + contourBox.width) * Double(width),
             Double(contourBox.origin.y + contourBox.height) * Double(height)),
            H: H
        )

        var widthMm = abs(bottomRight.x - topLeft.x)
        var heightMm = abs(bottomRight.y - topLeft.y)

        // Step 5: EMA smoothing
        if measureConfig.smoothingAlpha < 1.0 {
            if let prev = smoothedDimensions {
                let a = measureConfig.smoothingAlpha
                widthMm = a * widthMm + (1 - a) * prev.width
                heightMm = a * heightMm + (1 - a) * prev.height
            }
            smoothedDimensions = (widthMm, heightMm)
        }

        // Step 6: Determine if circular
        let aspectRatio = max(widthMm, heightMm) / (min(widthMm, heightMm) + 1e-6)
        let isCircular = aspectRatio < MeasuredDimensions.circularAspectRatioThreshold
        let diameterMm = isCircular ? (widthMm + heightMm) / 2 : nil

        let dimensions = MeasuredDimensions(
            widthMm: widthMm,
            heightMm: heightMm,
            diameterMm: diameterMm,
            isCircular: isCircular,
            aspectRatio: aspectRatio
        )

        // Step 7: Estimate measurement error
        // Error increases with distance from reference object and with frame resolution
        let errorEstimate = estimateError(refResult: refResult, contourArea: contourResult.area, frameWidth: width)

        guard errorEstimate <= measureConfig.maxMeasurementError else {
            return nil // reject unreliable measurement
        }

        // Step 8: Match to standard tool sizes
        let suggestions = ToolSizeMatcher.suggest(
            dimensions: dimensions,
            fastenerType: nil, // will be filled by upstream tool-id node when available
            toleranceMm: measureConfig.maxMeasurementError
        )

        guard !suggestions.isEmpty else { return nil }

        let inferenceTimeMs = (CFAbsoluteTimeGetCurrent() - startTime) * 1000.0

        return ToolMeasureResult(
            dimensions: dimensions,
            measurementErrorEstimate: errorEstimate,
            referenceObject: refResult.referenceType,
            suggestions: suggestions,
            fastenerType: nil,
            inferenceTimeMs: inferenceTimeMs,
            timestamp: CFAbsoluteTimeGetCurrent()
        )
    }

    // MARK: - Reference Object Detection

    private struct ReferenceResult {
        let referenceType: ReferenceObject
        let pixelCorners: [(x: Double, y: Double)]
        let mmCorners: [(x: Double, y: Double)]
    }

    private func detectReferenceObject(cgImage: CGImage, width: Int, height: Int) -> ReferenceResult? {
        // Try rectangular reference (credit card) first
        if measureConfig.referenceObject == "credit_card" || measureConfig.referenceObject == "auto" {
            if let result = detectRectangularReference(cgImage: cgImage, frameWidth: width, frameHeight: height) {
                return result
            }
        }

        // Try circular references (coins)
        if measureConfig.referenceObject == "auto" || measureConfig.referenceObject != "credit_card" {
            if let result = detectCircularReference(cgImage: cgImage, frameWidth: width, frameHeight: height) {
                return result
            }
        }

        return nil
    }

    private func detectRectangularReference(cgImage: CGImage, frameWidth: Int, frameHeight: Int) -> ReferenceResult? {
        let request = VNDetectRectanglesRequest()
        request.minimumAspectRatio = 1.3  // credit card aspect ~1.586
        request.maximumAspectRatio = 2.0
        request.minimumConfidence = 0.8
        request.maximumObservations = 1
        request.minimumSize = 0.1 // at least 10% of frame

        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        do {
            try handler.perform([request])
        } catch {
            return nil
        }

        guard let observation = request.results?.first as? VNRectangleObservation else {
            return nil
        }

        // Convert normalized corners to pixel coordinates
        let w = Double(frameWidth)
        let h = Double(frameHeight)
        let pixelCorners: [(x: Double, y: Double)] = [
            (observation.topLeft.x * w, (1 - observation.topLeft.y) * h),
            (observation.topRight.x * w, (1 - observation.topRight.y) * h),
            (observation.bottomRight.x * w, (1 - observation.bottomRight.y) * h),
            (observation.bottomLeft.x * w, (1 - observation.bottomLeft.y) * h),
        ]

        // Credit card real-world corners (mm)
        let dims = ReferenceObject.creditCard.dimensionsMm!
        let mmCorners: [(x: Double, y: Double)] = [
            (0, 0),
            (dims.width, 0),
            (dims.width, dims.height),
            (0, dims.height),
        ]

        return ReferenceResult(
            referenceType: .creditCard,
            pixelCorners: pixelCorners,
            mmCorners: mmCorners
        )
    }

    private func detectCircularReference(cgImage: CGImage, frameWidth: Int, frameHeight: Int) -> ReferenceResult? {
        let request = VNDetectContoursRequest()
        request.contrastAdjustment = 1.5
        request.detectsDarkOnLight = true
        request.maximumImageDimension = 1024 // balance speed/accuracy

        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        do {
            try handler.perform([request])
        } catch {
            return nil
        }

        guard let observation = request.results?.first as? VNContoursObservation else {
            return nil
        }

        // Find circular contours that match known coin sizes
        for contour in observation.topLevelContours {
            let aspectRatio = Double(contour.aspectRatio)
            guard aspectRatio > 0.8 && aspectRatio < 1.2 else { continue } // near-circular
            guard contour.pointCount >= 20 else { continue } // enough points to be meaningful

            // Get bounding circle
            let circle = contour.boundingCircle()
            let normalizedRadius = Double(circle.radius)

            // Skip tiny or huge contours
            guard normalizedRadius > 0.05 && normalizedRadius < 0.4 else { continue }

            // For circular references, we can't directly compute a 4-point homography.
            // Instead, compute pixel-per-metric ratio from the circle.
            // We'll approximate with a square bounding box for the homography.

            // Try each known coin to find the best match
            let candidateCoins: [ReferenceObject] = [.usQuarter, .usPenny, .usNickel, .usDime]

            for coin in candidateCoins {
                guard let coinDiameter = coin.diameterMm else { continue }
                let w = Double(frameWidth)
                let h = Double(frameHeight)

                // Circle center and radius in pixel coords
                let cx = Double(circle.center.x) * w
                let cy = (1 - Double(circle.center.y)) * h
                let pixelRadius = normalizedRadius * max(w, h)

                // Build 4 corners of the bounding square in pixels
                let pixelCorners: [(x: Double, y: Double)] = [
                    (cx - pixelRadius, cy - pixelRadius),
                    (cx + pixelRadius, cy - pixelRadius),
                    (cx + pixelRadius, cy + pixelRadius),
                    (cx - pixelRadius, cy + pixelRadius),
                ]

                // Real-world square corners (coin diameter = square side)
                let mmCorners: [(x: Double, y: Double)] = [
                    (0, 0),
                    (coinDiameter, 0),
                    (coinDiameter, coinDiameter),
                    (0, coinDiameter),
                ]

                return ReferenceResult(
                    referenceType: coin,
                    pixelCorners: pixelCorners,
                    mmCorners: mmCorners
                )
            }
        }

        return nil
    }

    // MARK: - Target Contour Detection

    private struct ContourResult {
        let boundingBox: CGRect   // normalized coordinates
        let area: Float           // normalized area
    }

    private func detectTargetContour(cgImage: CGImage) -> ContourResult? {
        let request = VNDetectContoursRequest()
        request.contrastAdjustment = 2.0
        request.detectsDarkOnLight = true
        request.maximumImageDimension = 4096 // full resolution for measurement accuracy

        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        do {
            try handler.perform([request])
        } catch {
            return nil
        }

        guard let observation = request.results?.first as? VNContoursObservation else {
            return nil
        }

        // Find the most likely fastener contour:
        // - Not too small (< 1% of frame) — noise
        // - Not too large (> 40% of frame) — probably the reference object
        // - Near-circular or hexagonal aspect ratio

        var bestContour: ContourResult?
        var bestScore: Float = 0

        for contour in observation.topLevelContours {
            let bb = contour.boundingBox
            let area = contour.calculateArea(useOrientedArea: false)
            let aspectRatio = Float(bb.width) / (Float(bb.height) + 1e-6)

            // Filter by size
            guard area > 0.001 && area < 0.15 else { continue }

            // Score: prefer medium-sized, compact contours
            let sizeScore: Float = area > 0.005 && area < 0.08 ? 1.0 : 0.5
            let shapeScore: Float = (aspectRatio > 0.5 && aspectRatio < 2.0) ? 1.0 : 0.3
            let pointScore: Float = contour.pointCount > 10 ? 1.0 : 0.5

            let score = sizeScore * shapeScore * pointScore
            if score > bestScore {
                bestScore = score
                bestContour = ContourResult(boundingBox: bb, area: area)
            }
        }

        return bestContour
    }

    // MARK: - Error Estimation

    private func estimateError(refResult: ReferenceResult, contourArea: Float, frameWidth: Int) -> Double {
        // Base error from pixel resolution
        // At 1080p, a 5mm object at 10cm distance spans ~50-100 pixels
        // Sub-pixel accuracy ~0.5 pixel → 0.025-0.05mm at that scale
        let baseErrorMm = 0.5

        // Increase error estimate for small objects (fewer pixels = more relative error)
        let areaThreshold = contourArea < 0.005 ? 1.5 : 1.0

        // Increase error for low resolution
        let resolutionFactor = frameWidth < 720 ? 2.0 : (frameWidth < 1080 ? 1.5 : 1.0)

        // Increase error if using circular reference (less precise than rectangular)
        let refTypeFactor = refResult.referenceType.isCircular ? 1.3 : 1.0

        // Consecutive detection stability bonus
        let stabilityFactor = consecutiveDetections > 3 ? 0.8 : 1.0

        return baseErrorMm * areaThreshold * resolutionFactor * refTypeFactor * stabilityFactor
    }
}
