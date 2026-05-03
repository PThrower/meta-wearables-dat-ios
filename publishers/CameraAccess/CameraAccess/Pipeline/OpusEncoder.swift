/*
 * OpusEncoder.swift
 *
 * Stateful Opus encoder using Apple's AudioToolbox AudioConverter API.
 * Converts raw PCM (Int16 LE) to Opus-encoded frames for bandwidth-efficient
 * transport over the FRAU wire protocol (codecType 4).
 *
 * Uses AudioToolbox's built-in Opus codec (kAudioFormatOpus, available iOS 11+).
 * The AudioConverter handles the Opus encoding natively -- no third-party C libs needed.
 *
 * Settings for voice streaming from Ray-Ban Meta glasses:
 *   - Sample rate: 16kHz (sufficient for HFP 8kHz source + phone mic)
 *   - Bitrate: 16 kbps (voice-optimized)
 *   - Channels: 1 (mono)
 *   - Frame size: 960 samples (60ms at 16kHz)
 *
 * Usage:
 *   let encoder = try OpusEncoder(sampleRate: 16000, channels: 1, bitrate: 16000)
 *   let opusFrames = encoder.encode(pcmData: pcmBuffer)
 *   // Each Data in opusFrames is an Opus packet ready for FRAU codecType=4
 */

import Foundation
import AVFoundation
import AudioToolbox

final class OpusEncoder {
    private var audioConverter: AudioConverterRef?
    private let sampleRate: Int
    private let channels: Int
    private let frameSize: Int  // samples per Opus frame (960 = 60ms at 16kHz)
    private let bitrate: Int

    // Buffered PCM samples that haven't filled a complete Opus frame yet
    private var sampleBuffer: [Int16] = []

    // Source buffer pointer for AudioConverter callback
    // fileprivate so the free function callback can access them
    fileprivate var sourceBuffer: UnsafePointer<UInt8>?
    fileprivate var sourceBytesRemaining: UInt32 = 0
    fileprivate let _channels: Int  // callback needs this

    // MARK: - Initialization

    init(sampleRate: Int = 16000, channels: Int = 1, bitrate: Int = 16000, frameSize: Int = 960) throws {
        self.sampleRate = sampleRate
        self.channels = channels
        self.bitrate = bitrate
        self.frameSize = frameSize
        self._channels = channels

        try setupConverter()
    }

    deinit {
        if let converter = audioConverter {
            AudioConverterDispose(converter)
        }
    }

    private func setupConverter() throws {
        // Input: PCM Int16 LE
        var inputDesc = AudioStreamBasicDescription(
            mSampleRate: Float64(sampleRate),
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
            mBytesPerPacket: UInt32(channels * 2),
            mFramesPerPacket: 1,
            mBytesPerFrame: UInt32(channels * 2),
            mChannelsPerFrame: UInt32(channels),
            mBitsPerChannel: 16,
            mReserved: 0
        )

        // Output: Opus
        var outputDesc = AudioStreamBasicDescription(
            mSampleRate: Float64(sampleRate),
            mFormatID: kAudioFormatOpus,
            mFormatFlags: 0,
            mBytesPerPacket: 0,
            mFramesPerPacket: UInt32(frameSize),
            mBytesPerFrame: 0,
            mChannelsPerFrame: UInt32(channels),
            mBitsPerChannel: 0,
            mReserved: 0
        )

        let result = AudioConverterNew(&inputDesc, &outputDesc, &audioConverter)
        guard result == noErr, let converter = audioConverter else {
            NSLog("[OpusEncoder] AudioConverterNew failed: \(result)")
            throw OpusEncoderError.converterCreationFailed
        }

        // Set bitrate
        var encodeBitRate = UInt32(bitrate)
        AudioConverterSetProperty(
            converter,
            kAudioConverterEncodeBitRate,
            UInt32(MemoryLayout<UInt32>.size),
            &encodeBitRate
        )

        // Set codec quality to maximum for voice
        var quality = UInt32(kAudioConverterQuality_Max)
        AudioConverterSetProperty(
            converter,
            kAudioConverterCodecQuality,
            UInt32(MemoryLayout<UInt32>.size),
            &quality
        )

        NSLog("[OpusEncoder] Initialized: \(sampleRate)Hz, \(channels)ch, \(bitrate)bps, frameSize=\(frameSize)")
    }

    // MARK: - Encoding

    /// Encode raw PCM data into one or more Opus frames.
    /// - Parameter pcmData: Raw PCM audio data (Int16 LE, interleaved if multi-channel).
    /// - Returns: Array of Opus-encoded frames, each ready for a FRAU packet.
    func encode(pcmData: Data) -> [Data] {
        guard !pcmData.isEmpty, let converter = audioConverter else { return [] }

        // Append new samples to buffer
        let newSamples = pcmData.withUnsafeBytes { buffer -> [Int16] in
            let ptr = buffer.bindMemory(to: Int16.self)
            return Array(ptr)
        }
        sampleBuffer.append(contentsOf: newSamples)

        var encodedFrames: [Data] = []

        // Encode complete Opus frames from the buffer
        while sampleBuffer.count >= frameSize {
            let frameSamples = Array(sampleBuffer.prefix(frameSize))
            sampleBuffer.removeFirst(frameSize)

            if let encoded = encodeFrame(converter, samples: frameSamples) {
                encodedFrames.append(encoded)
            }
        }

        return encodedFrames
    }

    /// Encode a single Opus frame using AudioConverterFillComplexBuffer.
    private func encodeFrame(_ converter: AudioConverterRef, samples: [Int16]) -> Data? {
        var frameByteCount = UInt32(samples.count * 2)

        // Set up source buffer for the callback
        let sampleData = samples.withUnsafeBufferPointer { ptr in
            Data(buffer: ptr)
        }

        // Output buffer — Opus compresses significantly; 400 bytes is generous for 960 samples at 16kbps
        let maxOutputSize: UInt32 = 400
        var outputBuffer = [UInt8](repeating: 0, count: Int(maxOutputSize))

        var outputPacketDesc = AudioStreamPacketDescription(
            mStartOffset: 0,
            mVariableFramesInPacket: 0,
            mDataByteSize: maxOutputSize
        )

        // Set source data for the callback
        sampleData.withUnsafeBytes { rawBuffer in
            self.sourceBuffer = rawBuffer.baseAddress!.assumingMemoryBound(to: UInt8.self)
        }
        self.sourceBytesRemaining = frameByteCount

        var outputBufferList = AudioBufferList(
            mNumberBuffers: 1,
            mBuffers: AudioBuffer(
                mNumberChannels: UInt32(channels),
                mDataByteSize: maxOutputSize,
                mData: &outputBuffer
            )
        )

        var inPacketDesc: UnsafeMutablePointer<AudioStreamPacketDescription>? = nil
        var outPacketDesc = outputPacketDesc

        let result = AudioConverterFillComplexBuffer(
            converter,
            encoderInputCallback,
            Unmanaged.passUnretained(self).toOpaque(),
            &frameByteCount,  // ioOutputDataPacketSize — number of PCM frames to encode
            &outputBufferList,
            &outPacketDesc
        )

        guard result == noErr else {
            NSLog("[OpusEncoder] AudioConverterFillComplexBuffer failed: \(result)")
            return nil
        }

        let encodedSize = Int(outputBufferList.mBuffers.mDataByteSize)
        guard encodedSize > 0 else { return nil }

        return Data(outputBuffer.prefix(encodedSize))
    }

    // MARK: - State Management

    /// Reset encoder state (e.g., on stream reconnect or codecType change).
    func reset() {
        sampleBuffer.removeAll(keepingCapacity: true)
        sourceBuffer = nil
        sourceBytesRemaining = 0
    }

    /// Get current buffer level (samples waiting for next frame).
    var bufferedSampleCount: Int {
        return sampleBuffer.count
    }
}

// MARK: - AudioConverter Input Callback

/// Static callback that provides PCM data to the AudioConverter.
/// The `inUserData` pointer is the OpusEncoder instance.
private func encoderInputCallback(
    _ inAudioConverter: AudioConverterRef,
    _ ioNumberDataPackets: UnsafeMutablePointer<UInt32>,
    _ ioData: UnsafeMutablePointer<AudioBufferList>,
    _ outDataPacketDescription: UnsafeMutablePointer<UnsafeMutablePointer<AudioStreamPacketDescription>?>?,
    _ inUserData: UnsafeMutableRawPointer?
) -> OSStatus {
    guard let userData = inUserData else {
        return kAudioConverterErr_UnspecifiedError
    }

    let encoder = Unmanaged<OpusEncoder>.fromOpaque(userData).takeUnretainedValue()

    let bytesToProvide = min(encoder.sourceBytesRemaining, ioNumberDataPackets.pointee * 2)

    guard bytesToProvide > 0, let source = encoder.sourceBuffer else {
        ioNumberDataPackets.pointee = 0
        ioData.pointee.mBuffers.mDataByteSize = 0
        return 168_416_881  // '!dat' — no more input data for this frame
    }

    ioData.pointee.mNumberBuffers = 1
    ioData.pointee.mBuffers.mData = UnsafeMutableRawPointer(mutating: source)
    ioData.pointee.mBuffers.mDataByteSize = bytesToProvide
    ioData.pointee.mBuffers.mNumberChannels = UInt32(encoder._channels)

    // Advance buffer pointer
    encoder.sourceBuffer = source.advanced(by: Int(bytesToProvide))
    encoder.sourceBytesRemaining -= bytesToProvide
    ioNumberDataPackets.pointee = bytesToProvide / 2

    return noErr
}

// MARK: - Errors

enum OpusEncoderError: Error, LocalizedError {
    case converterCreationFailed
    case encodingFailed

    var errorDescription: String? {
        switch self {
        case .converterCreationFailed:
            return "Failed to create AudioConverter for Opus encoding"
        case .encodingFailed:
            return "Opus encoding failed"
        }
    }
}
