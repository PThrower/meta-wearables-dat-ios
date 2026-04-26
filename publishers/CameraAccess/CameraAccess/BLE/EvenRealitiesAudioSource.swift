/*
 * EvenRealitiesAudioSource.swift
 *
 * Receives raw audio data from EvenRealitiesManager (BLE mic capture),
 * decodes LC3 (G1) or passes through PCM (G2), wraps in AudioPacket,
 * and publishes to the existing AudioEventBus.
 *
 * G1: LC3-encoded packets (0xF1 command, ~200 bytes each).
 *     Each packet may contain multiple 40-byte LC3 frames (10ms, 16kHz, 32kbps).
 *     Decoded to 16kHz PCM s16le mono by LC3Decoder (google/liblc3).
 *
 * G2: Audio arrives on UUID 6402 as raw LC3 packets (same format as G1)
 *     or as PCM 16kHz s16le mono via the EvenHub SDK path.
 *
 * Output is always 16kHz PCM — same as HFP glasses mic (codecType=1).
 */

import Foundation

actor EvenRealitiesAudioSource {
    private var eventBus: AudioEventBus?
    private var sequenceNumber: UInt64 = 0
    private var isEnabled = false

    // LC3 decoder (lazy-initialized on first LC3 frame)
    private var lc3Decoder: LC3Decoder?

    // Audio buffer for accumulating decoded PCM before publishing
    private var audioBuffer = Data()
    private let minBufferBytes: Int = 640 // ~20ms of 16kHz s16le mono

    // Stats
    private var lc3FramesDecoded: UInt64 = 0
    private var lc3DecodeErrors: UInt64 = 0
    private var plcFrames: UInt64 = 0

    func setEventBus(_ bus: AudioEventBus) {
        self.eventBus = bus
    }

    // MARK: - LC3 Decode

    /// Initialize the LC3 decoder on first use.
    private func ensureLC3Decoder() {
        if lc3Decoder == nil {
            do {
                lc3Decoder = try LC3Decoder()
                NSLog("[EvenAudio] LC3 decoder initialized (16kHz, 10ms frames)")
            } catch {
                NSLog("[EvenAudio] LC3 decoder init failed: \(error)")
            }
        }
    }

    /// Decode a raw LC3 frame (40 bytes) to PCM (320 bytes).
    private func decodeLC3Frame(_ frame: Data) -> Data? {
        ensureLC3Decoder()
        guard let decoder = lc3Decoder else { return nil }

        do {
            let pcm = try decoder.decode(frame: frame)
            lc3FramesDecoded += 1
            return pcm
        } catch {
            lc3DecodeErrors += 1
            if lc3DecodeErrors <= 3 || lc3DecodeErrors % 100 == 0 {
                NSLog("[EvenAudio] LC3 decode error #\(lc3DecodeErrors): \(error)")
            }
            // Use packet loss concealment
            if let plc = try? decoder.decodePacketLoss() {
                plcFrames += 1
                return plc
            }
            return nil
        }
    }

    // MARK: - Audio Input

    /// Called by EvenRealitiesManager when BLE audio data arrives.
    ///
    /// G1 format (NUS 0xF1): [0xF1] [seq] [LC3 data...]
    ///   - LC3 data is ~200 bytes containing multiple 40-byte frames
    ///   - May have a 5-byte trailer (value, 0x00, status, 0xFF, seqCounter)
    ///
    /// G2 format (UUID 6402): Raw LC3 packets, similar structure
    ///   - 205-byte packets: 5 x 40-byte LC3 frames + 5-byte trailer
    func handleRawAudio(_ data: Data, isLC3: Bool = true) async {
        guard isEnabled else { return }

        if isLC3 {
            // Strip any non-LC3 overhead.
            // G1: data is the payload after 0xF1+seq (raw LC3 bytes)
            // G2: data is raw from 6402 characteristic (may have trailer)
            let lc3Payload = stripLC3Payload(data)

            // Split into 40-byte LC3 frames (10ms @ 16kHz @ 32kbps)
            let frameSize = 40
            var offset = 0
            while offset + frameSize <= lc3Payload.count {
                let frame = lc3Payload.subdata(in: offset..<(offset + frameSize))
                if let pcm = decodeLC3Frame(frame) {
                    audioBuffer.append(pcm)
                }
                offset += frameSize
            }

            // Check if leftover bytes look like a trailer (5 bytes: status data)
            // G2 trailer format: [1B value][0x00][1B status][0xFF][1B seq]
            // We just ignore trailing bytes < frameSize

            if audioBuffer.count >= minBufferBytes {
                await publishBuffer()
            }
            return
        }

        // PCM path (G2 EvenHub SDK or pre-decoded audio)
        audioBuffer.append(data)
        if audioBuffer.count >= minBufferBytes {
            await publishBuffer()
        }
    }

    /// Called with already-decoded PCM data.
    func handleDecodedPCM(_ pcmData: Data) async {
        guard isEnabled else { return }
        audioBuffer.append(pcmData)
        if audioBuffer.count >= minBufferBytes {
            await publishBuffer()
        }
    }

    func enable() {
        isEnabled = true
        audioBuffer.removeAll()
        sequenceNumber = 0
        lc3FramesDecoded = 0
        lc3DecodeErrors = 0
        plcFrames = 0
        NSLog("[EvenAudio] Audio source enabled")
    }

    func disable() async {
        isEnabled = false
        if !audioBuffer.isEmpty {
            await publishBuffer()
        }
        lc3Decoder = nil // Release decoder memory
        NSLog("[EvenAudio] Audio source disabled (decoded=\(lc3FramesDecoded) errors=\(lc3DecodeErrors) plc=\(plcFrames))")
    }

    // MARK: - Private

    /// Strip trailer bytes from LC3 payload if present.
    /// G2 packets have a 5-byte trailer: [val][0x00][status][0xFF][seqCounter]
    /// G1 packets are raw LC3 data with no trailer.
    private func stripLC3Payload(_ data: Data) -> Data {
        // If data length is not a clean multiple of 40, check for G2 trailer
        let frameSize = 40
        let remainder = data.count % frameSize

        if remainder == 0 {
            return data // Clean frame alignment — no trailer
        }

        // G2 trailer is 5 bytes
        if remainder == 5 && data.count >= 5 {
            // Verify trailer signature: byte at offset -4 should be 0x00, byte at -2 should be 0xFF
            let trailerStart = data.count - 5
            if data[trailerStart + 1] == 0x00 && data[trailerStart + 3] == 0xFF {
                return data.prefix(data.count - 5)
            }
        }

        // Unknown trailer format — return data that aligns to frame boundaries
        let alignedLen = (data.count / frameSize) * frameSize
        return data.prefix(alignedLen)
    }

    private func publishBuffer() async {
        guard let bus = eventBus, !audioBuffer.isEmpty else { return }

        let packet = AudioPacket(
            pcmData: audioBuffer,
            codecType: 1, // Same as HFP glasses mic: 16kHz PCM
            sampleRate: 16000,
            channels: 1,
            bitsPerSample: 16,
            sequenceNumber: sequenceNumber,
            timestampMs: UInt64(Date().timeIntervalSince1970 * 1000)
        )

        await bus.publish(packet)
        sequenceNumber += 1
        audioBuffer.removeAll()
    }
}
