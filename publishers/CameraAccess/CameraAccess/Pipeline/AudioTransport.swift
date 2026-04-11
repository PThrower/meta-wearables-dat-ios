/*
 * AudioTransport.swift
 *
 * Protocol for consuming AudioPacket instances.
 * Decouples audio capture (AudioStage) from audio transport/storage.
 *
 * Implementations:
 *   - AudioRelayStage: encodes as FRAU wire protocol, sends over WebSocket
 *   - Future: AudioRecordingStage, AudioProcessingStage, etc.
 */

import Foundation

protocol AudioTransport: AnyObject, Sendable {
    func sendAudio(_ packet: AudioPacket) async
}
