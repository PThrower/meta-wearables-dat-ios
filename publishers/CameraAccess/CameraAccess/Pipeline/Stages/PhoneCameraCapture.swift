/**
 * PhoneCameraCapture -- AVCaptureSession wrapper for iPhone camera
 *
 * Captures back-camera frames as CMSampleBuffer via AVCaptureVideoDataOutput.
 * Designed to feed frames into FramePipelineManager.onRawSampleBuffer(_:).
 *
 * AVCaptureSession runs on a private dispatch queue.
 * Frame delivery crosses to MainActor via the onFrame callback.
 * Does NOT own AVAudioSession (configured at app launch by CameraAccessApp).
 */

import AVFoundation
import CoreMedia
import Foundation

// MARK: - Delegate (NSObject required by AVCaptureVideoDataOutputSampleBufferDelegate)

private final class SampleBufferDelegate: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    private let handler: (CMSampleBuffer) -> Void

    init(handler: @escaping (CMSampleBuffer) -> Void) {
        self.handler = handler
    }

    func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        handler(sampleBuffer)
    }
}

// MARK: - Errors

enum PhoneCameraError: LocalizedError {
    case cameraUnavailable
    case inputFailed
    case outputFailed
    case permissionDenied

    var errorDescription: String? {
        switch self {
        case .cameraUnavailable: return "No back camera available"
        case .inputFailed: return "Failed to create camera input"
        case .outputFailed: return "Failed to create video output"
        case .permissionDenied: return "Camera permission denied"
        }
    }
}

// MARK: - Capture

actor PhoneCameraCapture {

    private var captureSession: AVCaptureSession?
    private var delegate: SampleBufferDelegate?
    private var _isRunning = false
    private let deviceLock = NSLock()
    private nonisolated(unsafe) var _currentDevice: AVCaptureDevice?

    nonisolated var currentDevice: AVCaptureDevice? {
        deviceLock.lock()
        defer { deviceLock.unlock() }
        return _currentDevice
    }

    private func setCurrentDevice(_ device: AVCaptureDevice?) {
        deviceLock.lock()
        defer { deviceLock.unlock() }
        _currentDevice = device
    }

    private let targetFPS: Int
    private let sessionQueue = DispatchQueue(label: "com.mwdat.phonecamera", qos: .userInteractive)

    init(fps: Int = 30) {
        self.targetFPS = fps
    }

    var isRunning: Bool { _isRunning }

    private func setRunning(_ running: Bool) {
        _isRunning = running
    }

    /// Start capturing from the back camera. Requires camera permission.
    func start(onFrame: @Sendable @escaping (CMSampleBuffer) -> Void) throws {
        guard !_isRunning else { return }

        // Check permission
        let authStatus = AVCaptureDevice.authorizationStatus(for: .video)
        guard authStatus == .authorized else {
            throw PhoneCameraError.permissionDenied
        }

        // Find back camera
        guard let device = AVCaptureDevice.default(
            .builtInWideAngleCamera, for: .video, position: .back
        ) else {
            throw PhoneCameraError.cameraUnavailable
        }

        let session = AVCaptureSession()
        session.beginConfiguration()
        session.sessionPreset = .hd1280x720

        // Configure device FPS
        try device.lockForConfiguration()
        let duration = CMTime(value: 1, timescale: CMTimeScale(targetFPS))
        device.activeVideoMinFrameDuration = duration
        device.activeVideoMaxFrameDuration = duration
        device.unlockForConfiguration()

        // Input
        let input = try AVCaptureDeviceInput(device: device)
        guard session.canAddInput(input) else {
            throw PhoneCameraError.inputFailed
        }
        session.addInput(input)

        // Output -- 420v format compatible with existing CIContext -> CGImage -> JPEG chain
        let output = AVCaptureVideoDataOutput()
        output.alwaysDiscardsLateVideoFrames = true
        output.videoSettings = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
        ]

        let delegate = SampleBufferDelegate { sampleBuffer in
            onFrame(sampleBuffer)
        }
        output.setSampleBufferDelegate(delegate, queue: sessionQueue)
        self.delegate = delegate

        guard session.canAddOutput(output) else {
            throw PhoneCameraError.outputFailed
        }
        session.addOutput(output)

        session.commitConfiguration()

        self.captureSession = session
        self.setCurrentDevice(device)

        // startRunning() is synchronous and slow -- run on session queue
        let actor = self
        sessionQueue.async {
            session.startRunning()
            Task {
                await actor.setRunning(session.isRunning)
            }
        }

        NSLog("[PhoneCamera] Started: 1280x720 @ \(self.targetFPS)fps")
    }

    func stop() {
        guard _isRunning else { return }
        captureSession?.stopRunning()
        captureSession = nil
        setCurrentDevice(nil)
        delegate = nil
        _isRunning = false
        NSLog("[PhoneCamera] Stopped")
    }
}
