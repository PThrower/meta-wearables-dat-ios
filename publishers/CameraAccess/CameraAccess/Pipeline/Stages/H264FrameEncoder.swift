/*
 * H264FrameEncoder.swift
 *
 * Hardware-accelerated H.264 encoder using VideoToolbox VTCompressionSession.
 * Uses the C-style outputCallback (most reliable across iOS versions/devices).
 * A DispatchSemaphore synchronizes the async callback with encode() callers.
 */

import CoreMedia
import CoreVideo
import Dispatch
import Foundation
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

final class H264FrameEncoder: FrameEncoder, @unchecked Sendable {
    let codec: RelayVideoCodec = .h264

    private var session: VTCompressionSession?
    private var config: H264EncoderConfig
    private var frameCount: Int = 0
    private var keyframeRequested = false

    // Callback synchronization
    private let callbackSemaphore = DispatchSemaphore(value: 0)
    private var callbackSampleBuffer: CMSampleBuffer?
    private var callbackStatus: OSStatus = noErr

    init(config: H264EncoderConfig = .default) throws {
        self.config = config
        try createSession()
    }

    private func createSession() throws {
        var compressionSession: VTCompressionSession?

        // C-style output callback — stores result and signals semaphore.
        let callback: VTCompressionOutputCallback = { refcon, _, status, _, sampleBuffer in
            guard let refcon = refcon else { return }
            let encoder = Unmanaged<H264FrameEncoder>.fromOpaque(refcon).takeUnretainedValue()
            encoder.callbackStatus = status
            encoder.callbackSampleBuffer = sampleBuffer
            encoder.callbackSemaphore.signal()
        }

        let status = VTCompressionSessionCreate(
            allocator: nil,
            width: 1,
            height: 1,
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

        let prepareStatus = VTCompressionSessionPrepareToEncodeFrames(session)
        guard prepareStatus == noErr else {
            throw H264EncoderError.prepareFailed(prepareStatus)
        }
        self.session = session
    }

    // MARK: - Encode

    func encode(_ pixelBuffer: CVPixelBuffer, width: Int, height: Int) -> EncodedFrame? {
        guard let session = session else { return nil }

        let needsKeyframe = keyframeRequested || frameCount == 0 || (frameCount % config.keyframeInterval == 0)
        keyframeRequested = false

        let presentationTimestamp = CMTime(
            seconds: Double(frameCount) / Double(config.expectedFPS),
            preferredTimescale: 1000
        )
        let duration = CMTime(seconds: 1.0 / Double(config.expectedFPS), preferredTimescale: 1000)

        let frameProperties: CFDictionary? = needsKeyframe
            ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary
            : nil

        // Clear previous output
        callbackSampleBuffer = nil
        callbackStatus = noErr

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

        guard status == noErr else {
            NSLog("[H264Encoder] EncodeFrame failed: \(status)")
            return nil
        }

        frameCount += 1

        // Wait for callback to fire (up to 500ms)
        let waitResult = callbackSemaphore.wait(timeout: .now() + 0.5)

        if waitResult == .timedOut {
            NSLog("[H264Encoder] Callback timed out frame=\(frameCount)")
            return nil
        }

        guard callbackStatus == noErr, let sampleBuffer = callbackSampleBuffer else {
            NSLog("[H264Encoder] Callback error: status=\(callbackStatus), hasBuffer=\(callbackSampleBuffer != nil)")
            return nil
        }

        callbackSampleBuffer = nil
        return extractNALUnits(from: sampleBuffer, isKeyframe: needsKeyframe, inputWidth: width, inputHeight: height)
    }

    private func extractNALUnits(from sampleBuffer: CMSampleBuffer, isKeyframe: Bool, inputWidth: Int, inputHeight: Int) -> EncodedFrame? {
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

        var encodedWidth = inputWidth
        var encodedHeight = inputHeight
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

    func forceKeyframe() {
        keyframeRequested = true
    }

    func destroy() {
        if let session = session {
            VTCompressionSessionInvalidate(session)
        }
        session = nil
        frameCount = 0
        keyframeRequested = false
        callbackSampleBuffer = nil
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
