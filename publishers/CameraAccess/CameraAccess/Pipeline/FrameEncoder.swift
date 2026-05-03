/*
 * FrameEncoder.swift
 *
 * Abstraction layer for video frame encoding.
 * JPEG and H.264 encoders conform to this protocol so RelayStage
 * can delegate encoding without knowing the specific codec.
 */

import CoreMedia
import Foundation

// MARK: - Relay Video Codec

enum RelayVideoCodec: UInt8, CaseIterable, Sendable {
    case jpeg = 0
    case h264 = 1

    var displayName: String {
        switch self {
        case .jpeg: return "JPEG"
        case .h264: return "H.264"
        }
    }
}

// MARK: - Encoded Frame Output

struct EncodedFrame: Sendable {
    /// Compressed payload (JPEG bytes or H.264 NAL units)
    let payload: Data
    /// True for self-contained frames (every JPEG frame, H.264 IDR/keyframes)
    let isKeyframe: Bool
    /// True when payload includes codec parameter sets (SPS/PPS for H.264)
    let hasParameterSets: Bool
    /// Width of the encoded frame
    let width: Int
    /// Height of the encoded frame
    let height: Int
}

// MARK: - Frame Encoder Protocol

protocol FrameEncoder: Sendable {
    var codec: RelayVideoCodec { get }

    /// Encode a raw pixel buffer into a compressed frame.
    /// Returns nil if encoding fails or the encoder is not ready.
    func encode(_ pixelBuffer: CVPixelBuffer, width: Int, height: Int) -> EncodedFrame?

    /// Request the next frame be a keyframe (used for H.264).
    /// No-op for JPEG (every frame is already a keyframe).
    func forceKeyframe()

    /// Release encoder resources.
    func destroy()
}

// Default no-op for JPEG
extension FrameEncoder {
    func forceKeyframe() {}
}
