/*
 * RecordingStage.swift
 *
 * Pipeline stage that appends CMSampleBuffer frames to an AVAssetWriter.
 * Uses passthrough (no re-encode) for minimal CPU overhead.
 *
 * Lifecycle:
 *   startRecording(to:) -> processFrame (appends) -> stopRecording() -> file URL
 */

import AVFoundation
import CoreMedia
import Foundation

actor RecordingStage: @preconcurrency FramePipelineStage {
    nonisolated let stageId = "recording"
    var config: FrameStageConfig

    // Writer state
    private var assetWriter: AVAssetWriter?
    private var writerInput: AVAssetWriterInput?
    private var outputFileURL: URL?
    private var isRecording = false

    init(config: FrameStageConfig = FrameStageConfig(targetFPS: 30)) {
        self.config = config
    }

    // MARK: - Recording Control

    /// Start recording to a file URL. Creates AVAssetWriter with passthrough output.
    func startRecording(to url: URL) throws {
        guard !isRecording else { return }

        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)

        // Determine format from first available description — we set up the input
        // lazily on the first frame when we can inspect the sample buffer.
        assetWriter = writer
        outputFileURL = url
        isRecording = false // Will flip to true once writer starts

        NSLog("[RecordingStage] Prepared writer for \(url.lastPathComponent)")
    }

    /// Stop recording and finalize the file. Returns the output file URL.
    @discardableResult
    func stopRecording() async -> URL? {
        guard let writer = assetWriter, isRecording else {
            let url = outputFileURL
            reset()
            return url
        }

        writerInput?.markAsFinished()
        await writer.finishWriting()

        let url = outputFileURL
        let success = writer.status == .completed
        NSLog("[RecordingStage] Stopped recording: \(url?.lastPathComponent ?? "nil"), success=\(success)")

        if !success, let error = writer.error {
            NSLog("[RecordingStage] Writer error: \(error)")
        }

        reset()
        return url
    }

    var currentlyRecording: Bool {
        isRecording
    }

    // MARK: - FramePipelineStage

    nonisolated func processFrame(_ packet: FramePacket) async {
        await appendFrame(packet)
    }

    func start() async {
        // No-op — recording starts explicitly via startRecording(to:)
    }

    func stop() async {
        await stopRecording()
    }

    // MARK: - Frame Append

    private func appendFrame(_ packet: FramePacket) {
        guard let writer = assetWriter else { return }

        // Lazily create writer input from the first frame's format description
        if writerInput == nil {
            guard let formatDescription = CMSampleBufferGetFormatDescription(packet.sampleBuffer) else {
                NSLog("[RecordingStage] No format description in sample buffer")
                return
            }

            let mediaType = CMFormatDescriptionGetMediaType(formatDescription)
            guard mediaType == kCMMediaType_Video else {
                NSLog("[RecordingStage] Non-video media type: \(mediaType)")
                return
            }

            let input = AVAssetWriterInput(mediaType: .video, outputSettings: nil)
            input.expectsMediaDataInRealTime = true

            guard writer.canAdd(input) else {
                NSLog("[RecordingStage] Cannot add writer input")
                return
            }
            writer.add(input)
            writerInput = input
        }

        // Start writing on first frame
        if !isRecording {
            guard writer.startWriting() else {
                NSLog("[RecordingStage] Failed to start writing: \(writer.error?.localizedDescription ?? "unknown")")
                return
            }
            writer.startSession(atSourceTime: CMSampleBufferGetPresentationTimeStamp(packet.sampleBuffer))
            isRecording = true
            NSLog("[RecordingStage] Writing started")
        }

        // Append frame
        if let input = writerInput, input.isReadyForMoreMediaData {
            input.append(packet.sampleBuffer)
        }
    }

    // MARK: - Private

    private func reset() {
        assetWriter = nil
        writerInput = nil
        outputFileURL = nil
        isRecording = false
    }
}
