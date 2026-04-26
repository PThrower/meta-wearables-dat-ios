/*
 * LC3Decoder.swift
 *
 * Swift wrapper around google/liblc3 C decoder for Even Realities G1/G2
 * BLE microphone audio. LC3 frames arrive over BLE (10ms, 16kHz mono)
 * and are decoded to PCM s16le for the audio pipeline.
 *
 * Parameters for Even Realities glasses:
 *   Frame duration: 10ms (10000 us)
 *   Sample rate: 16kHz
 *   Bitrate: ~32kbps (40 bytes per frame)
 *   Output: 160 samples of 16-bit PCM per frame (320 bytes)
 *
 * The C sources (lc3/) are from google/liblc3 v1.1.3 (Apache 2.0).
 */

import Foundation

// C functions (lc3_decode, lc3_setup_decoder, etc.) are available via
// CameraAccess-Bridging-Header.h which includes lc3.h from the vendored
// google/liblc3 C sources.

enum LC3Error: Error {
    case setupFailed
    case decodeFailed
    case invalidParameters
}

// MARK: - LC3Decoder

final class LC3Decoder: @unchecked Sendable {
    // 10ms frame at 16kHz = 160 samples
    static let frameDurationUs: Int = 10_000
    static let sampleRateHz: Int = 16_000
    static let samplesPerFrame: Int = 160
    static let bytesPerPCMFrame: Int = 320 // 160 samples * 2 bytes

    // Decoder state — typed pointer from C library
    private var decoderMemory: UnsafeMutableRawPointer?
    private var decoder: lc3_decoder_t?

    init() throws {
        let dtUs = Int32(Self.frameDurationUs)
        let srHz = Int32(Self.sampleRateHz)
        let srPcmHz = Int32(0) // 0 = same as srHz

        // Allocate decoder memory
        let memSize = Int(lc3_decoder_size(dtUs, srHz))
        guard let mem = malloc(memSize) else {
            throw LC3Error.setupFailed
        }
        self.decoderMemory = mem

        // Initialize decoder
        let dec = lc3_setup_decoder(dtUs, srHz, srPcmHz, mem)
        guard dec != nil else {
            free(mem)
            self.decoderMemory = nil
            throw LC3Error.setupFailed
        }
        self.decoder = dec
    }

    deinit {
        if let mem = decoderMemory {
            free(mem)
        }
    }

    /// Decode a single LC3 frame to PCM (Int16, mono, 16kHz).
    /// Returns 160 samples (320 bytes) of PCM data.
    func decode(frame: Data) throws -> Data {
        guard let dec = decoder else {
            throw LC3Error.invalidParameters
        }

        // Output buffer: 160 samples * 2 bytes = 320 bytes
        var pcmBuffer = [Int16](repeating: 0, count: Self.samplesPerFrame)

        let result = frame.withUnsafeBytes { framePtr in
            pcmBuffer.withUnsafeMutableBytes { pcmPtr in
                lc3_decode(
                    dec,
                    framePtr.baseAddress,
                    Int32(frame.count),
                    LC3_PCM_FORMAT_S16,
                    pcmPtr.baseAddress,
                    1 // stride = 1 (mono)
                )
            }
        }

        guard result >= 0 else {
            throw LC3Error.decodeFailed
        }

        // Convert Int16 array to Data
        return pcmBuffer.withUnsafeBufferPointer { buffer in
            Data(buffer: buffer)
        }
    }

    /// Decode with packet loss concealment (for dropped BLE packets).
    /// Returns synthesized PCM frame.
    func decodePacketLoss() throws -> Data {
        guard let dec = decoder else {
            throw LC3Error.invalidParameters
        }

        var pcmBuffer = [Int16](repeating: 0, count: Self.samplesPerFrame)

        let result = pcmBuffer.withUnsafeMutableBytes { pcmPtr in
            lc3_decode(
                dec,
                nil,     // NULL input = PLC
                0,       // 0 bytes = PLC
                LC3_PCM_FORMAT_S16,
                pcmPtr.baseAddress,
                1
            )
        }

        guard result >= 0 else {
            throw LC3Error.decodeFailed
        }

        return pcmBuffer.withUnsafeBufferPointer { buffer in
            Data(buffer: buffer)
        }
    }
}
