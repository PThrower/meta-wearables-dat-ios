/*
 * AudioSource.swift
 *
 * Enum representing a physical audio input source.
 * Each source maps to a codecType value used in the FRAU wire protocol
 * to distinguish audio streams on the relay server.
 *
 * codecType values:
 *   0 = Built-in phone mic (48kHz)
 *   1 = Glasses HFP mic (8kHz narrowband / 16kHz wideband)
 *   2 = Playback audio (server → glasses, variable sample rate)
 *
 * See docs/MULTI-SOURCE-AUDIO.md for architecture details.
 */

import Foundation

enum AudioSource: Sendable {
    case builtInMic
    case bluetoothHFP

    /// FRAU wire protocol codecType field value.
    var codecType: UInt8 {
        switch self {
        case .builtInMic: return 0
        case .bluetoothHFP: return 1
        }
    }

    /// Human-readable name for UI display.
    var displayName: String {
        switch self {
        case .builtInMic: return "Phone Mic"
        case .bluetoothHFP: return "Glasses Mic"
        }
    }
}
