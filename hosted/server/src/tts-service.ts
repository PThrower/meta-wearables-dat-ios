/**
 * TTS Service interface and stub implementation
 *
 * Provides the interface for text-to-speech synthesis used by the
 * GuidanceOrchestrator. The stub returns silence until a real
 * TTS backend (Gemini built-in TTS or Google Cloud TTS) is wired in.
 *
 * Output format: 16kHz 16-bit mono PCM (codecType 3 in the FRAU protocol).
 */

export interface TTSService {
  /** Synthesize text to PCM audio (16kHz 16-bit mono). */
  synthesize(text: string, opts?: { voice?: string }): Promise<Uint8Array>;
}

/**
 * Stub TTS service — returns empty PCM (silence).
 *
 * Drop-in replacement: swap with a real implementation that calls
 * Gemini built-in TTS or Google Cloud TTS when ready.
 */
export class StubTTSService implements TTSService {
  async synthesize(_text: string, _opts?: { voice?: string }): Promise<Uint8Array> {
    // Return silence — no actual synthesis until a real TTS backend is wired
    return new Uint8Array(0);
  }
}
