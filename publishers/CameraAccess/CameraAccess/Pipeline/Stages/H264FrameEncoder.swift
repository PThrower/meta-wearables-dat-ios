/*
 * H264FrameEncoder.swift
 *
 * Hardware-accelerated H.264 encoder using VideoToolbox VTCompressionSession.
 *
 * Session is created lazily on the first encode() call using actual pixel buffer
 * dimensions. VTCompressionSession requires valid dimensions at creation time;
 * placeholder dimensions (e.g. 1x1) cause all callbacks to return errors.
 *
 * Uses a non-blocking pipeline: the C-style callback stores the encoded frame,
 * and encode() returns the previously stored frame. 1-frame pipeline delay.
 *
 * Thread safety: pending frame state is protected by Mutex from the DAT SDK,
 * replacing the previous NSLock + mutable ivar pattern.
 */

import CoreMedia
import CoreVideo
import Foundation
import MWDATCore
import VideoToolbox

struct H264EncoderConfig: Sendable {
    let bitrate: Int
    let keyframeInterval: Int
    let expectedFPS: Int

    static let `default` = H264EncoderConfig(
        bitrate: 750_000,
        keyframeInterval: 30,
        expectedFPS: 15
    )
}

/// Pending frame state protected by SDK Mutex for Sendable-safe access.
struct PendingFrameState: Sendable {
    var frame: EncodedFrame?
    var isKeyframe: Bool = false
}

final class H264FrameEncoder: FrameEncoder, Sendable {
    let codec: RelayVideoCodec = .h264

    private var session: VTCompressionSession?
    private var config: H264EncoderConfig
    private var frameCount: Int = 0
    private var keyframeRequested = false

    // Pipeline state: callback writes, encode() reads. Protected by SDK Mutex.
    let pendingState = Mutex<PendingFrameState>(PendingFrameState())

    // Last encoded dimensions — recreate session if they change
    private var lastWidth: Int = 0
    private var lastHeight: Int = 0

    // Encoder's pixel buffer pool — get from VTCompressionSession after creation.
    // Using this pool avoids a format conversion copy per frame (pipeline BGRA → encoder NV12).
    // The encoder owns the buffer lifecycle, reducing peak allocation count.
    private var encoderBufferPool: CVPixelBufferPool?

    init(config: H264EncoderConfig = .default) {
        self.config = config
        // Session created lazily in encode() when we have real dimensions
    }

    private func createSession(width: Int, height: Int) throws {
        // Invalidate existing session if any
        if let existing = session {
            VTCompressionSessionInvalidate(existing)
            session = nil
        }

        var compressionSession: VTCompressionSession?

        let callback: VTCompressionOutputCallback = { refcon, _, status, _, sampleBuffer in
            guard let refcon = refcon else { return }
            let encoder = Unmanaged<H264FrameEncoder>.fromOpaque(refcon).takeUnretainedValue()

            guard status == noErr, let sampleBuffer = sampleBuffer else {
                NSLog("[H264] callback ERROR status=\(status)")
                return
            }

            let isKeyframe = encoder.pendingState.withLock { $0.isKeyframe }

            let frame = encoder.extractNALUnits(
                from: sampleBuffer,
                isKeyframe: isKeyframe
            )

            if let frame = frame {
                encoder.pendingState.withLock { $0.frame = frame }
            }
        }

        let status = VTCompressionSessionCreate(
            allocator: nil,
            width: Int32(width),
            height: Int32(height),
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: nil,
            imageBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
            ] as CFDictionary,
            compressedDataAllocator: nil,
            outputCallback: callback,
            refcon: Unmanaged.passUnretained(self).toOpaque(),
            compressionSessionOut: &compressionSession
        )

        guard status == noErr, let session = compressionSession else {
            throw H264EncoderError.sessionCreateFailed(status)
        }

        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_Baseline_AutoLevel)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: true as CFBoolean)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: Int32(config.bitrate) as CFNumber)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: Int32(config.keyframeInterval) as CFNumber)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: Int32(config.expectedFPS) as CFNumber)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering, value: false as CFBoolean)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaximizePowerEfficiency, value: true as CFBoolean)

        // Data rate limit: 1.5x target bitrate over 1-second window.
        // Prevents encoder from spiking internal buffer allocation during complex scenes.
        // On 4GB devices, unbounded encoder buffers can spike 100-200MB.
        let dataRateLimitBytes = Int64(config.bitrate) * 3 / 2 / 8  // 1.5x bitrate in bytes/sec
        let dataRateLimits = [NSNumber(value: dataRateLimitBytes), NSNumber(value: 1)] as CFArray
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_DataRateLimits, value: dataRateLimits)

        let prepareStatus = VTCompressionSessionPrepareToEncodeFrames(session)
        guard prepareStatus == noErr else {
            throw H264EncoderError.prepareFailed(prepareStatus)
        }

        self.session = session
        self.lastWidth = width
        self.lastHeight = height

        // Cache the encoder's pixel buffer pool for zero-copy frame submission.
        // Callers can get buffers from this pool to avoid BGRA→NV12 copy overhead.
        self.encoderBufferPool = VTCompressionSessionGetPixelBufferPool(session)

        NSLog("[H264] session created: \(width)x\(height)")
    }

    // MARK: - Encode

    func encode(_ pixelBuffer: CVPixelBuffer, width: Int, height: Int) -> EncodedFrame? {
        // Lazy session creation with real dimensions
        if session == nil {
            do {
                try createSession(width: width, height: height)
            } catch {
                NSLog("[H264] session create failed: \(error)")
                return nil
            }
        }

        // Recreate session if dimensions changed
        if width != lastWidth || height != lastHeight {
            NSLog("[H264] dimension change: \(lastWidth)x\(lastHeight) -> \(width)x\(height)")
            pendingState.withLock { $0.frame = nil }
            frameCount = 0
            do {
                try createSession(width: width, height: height)
            } catch {
                NSLog("[H264] session recreate failed: \(error)")
                return nil
            }
        }

        guard let session = session else { return nil }

        // Return the previously encoded frame (pipeline delay)
        let result = pendingState.withLock { state -> EncodedFrame? in
            let frame = state.frame
            state.frame = nil
            return frame
        }

        let needsKeyframe = keyframeRequested || frameCount == 0 || (frameCount % config.keyframeInterval == 0)
        keyframeRequested = false

        // Store keyframe status for the callback to use
        pendingState.withLock { $0.isKeyframe = needsKeyframe }

        let presentationTimestamp = CMTime(
            seconds: Double(frameCount) / Double(config.expectedFPS),
            preferredTimescale: 1000
        )
        let duration = CMTime(seconds: 1.0 / Double(config.expectedFPS), preferredTimescale: 1000)

        let frameProperties: CFDictionary? = needsKeyframe
            ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary
            : nil

        var flags: VTEncodeInfoFlags = []

        let status = VTCompressionSessionEncodeFrame(
            session,
            imageBuffer: pixelBuffer,
            presentationTimeStamp: presentationTimestamp,
            duration: duration,
            frameProperties: frameProperties,
            sourceFrameRefcon: nil,
            infoFlagsOut: &flags
        )

        if status != noErr {
            NSLog("[H264] encode#\(frameCount) FAILED status=\(status)")
            return result
        }

        frameCount += 1

        // For the first frame, check if output arrived synchronously
        if result == nil && frameCount == 1 {
            return pendingState.withLock { state -> EncodedFrame? in
                let frame = state.frame
                state.frame = nil
                return frame
            }
        }

        return result
    }

    private func extractNALUnits(from sampleBuffer: CMSampleBuffer, isKeyframe: Bool) -> EncodedFrame? {
        guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return nil }

        let length = CMBlockBufferGetDataLength(blockBuffer)
        var nalData = Data(count: length)
        nalData.withUnsafeMutableBytes { dest in
            _ = CMBlockBufferCopyDataBytes(blockBuffer, atOffset: 0, dataLength: length, destination: dest.baseAddress!)
        }

        nalData = convertAVCCToAnnexB(nalData)

        var hasParameterSets = false

        if isKeyframe, let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer) {
            var parameterSets = Data()
            var index: Int = 0
            while true {
                var pointer: UnsafePointer<UInt8>?
                var size: Int = 0
                let paramStatus = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                    formatDescription,
                    parameterSetIndex: index,
                    parameterSetPointerOut: &pointer,
                    parameterSetSizeOut: &size,
                    parameterSetCountOut: nil,
                    nalUnitHeaderLengthOut: nil
                )
                guard paramStatus == noErr, let ptr = pointer, size > 0 else { break }
                parameterSets.append(contentsOf: [0x00, 0x00, 0x00, 0x01])
                parameterSets.append(ptr, count: size)
                index += 1
            }

            if !parameterSets.isEmpty {
                parameterSets.append(nalData)
                nalData = parameterSets
                hasParameterSets = true
            }
        }

        guard !nalData.isEmpty else { return nil }

        var encodedWidth = 0
        var encodedHeight = 0
        if let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer) {
            let dims = CMVideoFormatDescriptionGetDimensions(formatDesc)
            encodedWidth = Int(dims.width)
            encodedHeight = Int(dims.height)
        }

        return EncodedFrame(
            payload: nalData,
            isKeyframe: isKeyframe,
            hasParameterSets: hasParameterSets,
            width: encodedWidth,
            height: encodedHeight
        )
    }

    private func convertAVCCToAnnexB(_ avccData: Data) -> Data {
        var result = Data()
        var offset = 0
        while offset + 4 <= avccData.count {
            let nalLength = avccData.withUnsafeBytes { ptr in
                ptr.loadUnaligned(fromByteOffset: offset, as: UInt32.self).bigEndian
            }
            offset += 4
            guard offset + Int(nalLength) <= avccData.count else { break }
            result.append(contentsOf: [0x00, 0x00, 0x00, 0x01])
            result.append(avccData[offset..<(offset + Int(nalLength))])
            offset += Int(nalLength)
        }
        return result
    }

    /// Get a pixel buffer from the encoder's internal pool.
    /// Rendering directly into this buffer avoids a BGRA→NV12 copy during encode.
    /// Returns nil if session hasn't been created yet.
    func getEncoderBuffer() -> CVPixelBuffer? {
        guard let pool = encoderBufferPool else { return nil }
        var buffer: CVPixelBuffer?
        let status = CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &buffer)
        return status == kCVReturnSuccess ? buffer : nil
    }

    func forceKeyframe() {
        keyframeRequested = true
    }

    func destroy() {
        if let session = session {
            VTCompressionSessionInvalidate(session)
        }
        session = nil
        encoderBufferPool = nil
        frameCount = 0
        keyframeRequested = false
        lastWidth = 0
        lastHeight = 0
        pendingState.withLock { $0 = PendingFrameState() }
    }
}

enum H264EncoderError: LocalizedError {
    case sessionCreateFailed(OSStatus)
    case prepareFailed(OSStatus)

    var errorDescription: String? {
        switch self {
        case .sessionCreateFailed(let s): return "VTCompressionSession create failed: \(s)"
        case .prepareFailed(let s): return "VTCompressionSession prepare failed: \(s)"
        }
    }
}
