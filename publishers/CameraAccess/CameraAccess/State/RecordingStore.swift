//
// RecordingStore.swift
//
// Photo capture and video recording state.
//

import MWDATCamera
import Photos
import SwiftUI

@MainActor
@Observable
final class RecordingStore {

  var isRecording: Bool = false
  var capturedPhoto: UIImage?
  var showPhotoPreview: Bool = false

  private let recordingStage: RecordingStage

  init(recordingStage: RecordingStage) {
    self.recordingStage = recordingStage
  }

  // MARK: - Video Recording

  func startRecording() async throws {
    let documentsDir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyyMMdd_HHmmss"
    let filename = "recording_\(formatter.string(from: Date())).mov"
    let url = documentsDir.appendingPathComponent(filename)

    do {
      try await recordingStage.startRecording(to: url)
      isRecording = true
      NSLog("[RecordingStore] Recording started: \(filename)")
    } catch {
      NSLog("[RecordingStore] Recording failed to start: \(error)")
      // Error reporting goes through coordinator → errorStore
      throw RecordingError.startFailed(error.localizedDescription)
    }
  }

  func stopRecording() async {
    let url = await recordingStage.stopRecording()
    isRecording = false
    NSLog("[RecordingStore] Recording stopped: \(url?.lastPathComponent ?? "nil")")

    if let url {
      do {
        try await saveToPhotos(url: url)
      } catch {
        NSLog("[RecordingStore] Failed to save to Photos: \(error)")
      }
    }
  }

  // MARK: - Photo Capture

  func capturePhoto(from streamSession: StreamSession?, phoneFrame: UIImage?, isPhoneCamera: Bool) {
    if isPhoneCamera {
      if let frame = phoneFrame {
        capturedPhoto = frame
        showPhotoPreview = true
      }
      return
    }
    streamSession?.capturePhoto(format: .jpeg)
  }

  func handleCapturedPhoto(_ image: UIImage) {
    capturedPhoto = image
    showPhotoPreview = true
  }

  func dismissPhotoPreview() {
    showPhotoPreview = false
    capturedPhoto = nil
  }

  // MARK: - Private

  private func saveToPhotos(url: URL) async throws {
    try await PHPhotoLibrary.shared().performChanges {
      PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: url)
    }
  }
}

// MARK: - Errors

enum RecordingError: LocalizedError {
  case startFailed(String)

  var errorDescription: String? {
    switch self {
    case .startFailed(let msg): return "Recording failed: \(msg)"
    }
  }
}
