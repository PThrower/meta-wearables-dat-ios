/*
 * H264FrameEncoder.swift
 *
 * Hardware-accelerated H.264 encoder using VideoToolbox VTCompressionSession.
 * Takes CVPixelBuffer directly (no YUV-to-RGB conversion needed) and produces
 * H.264 NAL units with SPS/PPS parameter sets on keyframes.
 *
 * Designed for real-time streaming: real-time mode, average bitrate control,
 * hardware-accelerated on Apple Silicon.
 */

import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

struct H264EncoderConfig: Sendable {
    let bitrate: Int           // Target bitrate in bps (e.g. 750_000 = 750kbps)
    let keyframeInterval: Int  // Force IDR every N frames
    let expectedFPS: Int       // Used for bitrate calculation hints

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

    /// Frame counter for keyframe interval enforcement
    private var frameCount: Int = 0

    /// Whether a keyframe has been requested
    private var keyframeRequested = false

    /// Stored encoded frame from the output callback
    private var pendingSampleBuffer: CMSampleBuffer?

    init(config: H264EncoderConfig = .default) throws {
        self.config = config
        try createSession()
    }

    private func createSession() throws {
        let width: Int32 = 1280
        let height: Int32 = 720

        var compressionSession: VTCompressionSession?

        // C-style callback: pass self through refcon (Unmanaged) since closures
        // that capture context cannot be converted to C function pointers.
        let callback: VTCompressionOutputCallback = { refcon, _, status, _, sampleBuffer in
            guard status == noErr, let sampleBuffer = sampleBuffer else { return }
            guard let refcon = refcon else { return }
            let encoder = Unmanaged<H264FrameEncoder>.fromOpaque(refcon).takeUnretainedValue()
            encoder.pendingSampleBuffer = sampleBuffer
        }

        let refcon = Unmanaged.passUnretained(self).toOpaque()

        let status = VTCompressionSessionCreate(
            allocator: nil,
            width: width,
            height: height,
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: nil,
            imageBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
            ] as CFDictionary,
            compressedDataAllocator: nil,
            outputCallback: callback,
            refcon: refcon,
            compressionSessionOut: &compressionSession
        )

        guard status == noErr, let session = compressionSession else {
            throw H264EncoderError.sessionCreateFailed(status)
        }

        // Configure encoder properties
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

    func encode(_ pixelBuffer: CVPixelBuffer, width: Int, height: Int) -> EncodedFrame? {
        guard let session = session else { return nil }

        pendingSampleBuffer = nil

        let needsKeyframe = keyframeRequested || frameCount == 0 || (frameCount % config.keyframeInterval == 0)
        keyframeRequested = false

        let presentationTimestamp = CMTime(
            seconds: Double(frameCount) / Double(config.expectedFPS),
            preferredTimescale: 1000
        )
        let duration = CMTime(seconds: 1.0 / Double(config.expectedFPS), preferredTimescale: 1000)

        // Build frame properties for keyframe forcing
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

        guard status == noErr else {
            NSLog("[H264Encoder] Encode failed: status=\(status)")
            return nil
        }

        frameCount += 1

        guard let sampleBuffer = pendingSampleBuffer else {
            NSLog("[H264Encoder] No sample buffer received from callback")
            return nil
        }

        return extractNALUnits(from: sampleBuffer, isKeyframe: needsKeyframe, width: width, height: height)
    }

    private func extractNALUnits(from sampleBuffer: CMSampleBuffer, isKeyframe: Bool, width: Int, height: Int) -> EncodedFrame? {
        guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return nil }

        let length = CMBlockBufferGetDataLength(blockBuffer)
        var nalData = Data(count: length)
        nalData.withUnsafeMutableBytes { dest in
            _ = CMBlockBufferCopyDataBytes(blockBuffer, atOffset: 0, dataLength: length, destination: dest.baseAddress!)
        }

        // Convert AVCC length-prefixed NALs to Annex B start-code prefixed NALs
        nalData = convertAVCCToAnnexB(nalData)

        var hasParameterSets = false

        // On keyframes, prepend SPS/PPS from the format description
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

        return EncodedFrame(
            payload: nalData,
            isKeyframe: isKeyframe,
            hasParameterSets: hasParameterSets,
            width: width,
            height: height
        )
    }

    /// Convert AVCC (length-prefixed) NAL units to Annex B (start-code prefixed) format.
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
        pendingSampleBuffer = nil
    }
}

// MARK: - Errors

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
