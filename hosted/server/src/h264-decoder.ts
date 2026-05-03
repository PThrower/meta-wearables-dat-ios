/**
 * h264-decoder.ts — Server-side H.264 to JPEG decoding via ffmpeg pipe
 *
 * Manages a persistent ffmpeg subprocess per session that:
 * 1. Receives H.264 Annex-B NAL units on stdin
 * 2. Outputs JPEG frames on stdout
 * 3. Decoded JPEGs are forwarded to the AI orchestrator
 *
 * Usage:
 *   const decoder = new H264ToJpegDecoder(sessionId);
 *   decoder.start();
 *   decoder.feed(nalUnit);              // push H.264 data
 *   decoder.onJpeg = (jpeg) => { ... }  // receive decoded JPEG
 *   decoder.stop();
 */

import { spawn, type Subprocess } from "bun";

const JPEG_SOI = 0xffd8;  // JPEG Start of Image marker

export class H264ToJpegDecoder {
  private sessionId: string;
  private proc: Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private buffer = new Uint8Array(0);
  private _onJpeg: ((jpeg: Uint8Array) => void) | null = null;
  private running = false;
  private frameCount = 0;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /** Set the callback for decoded JPEG frames */
  set onJpeg(cb: (jpeg: Uint8Array) => void) {
    this._onJpeg = cb;
  }

  /** Start the ffmpeg decoder subprocess */
  start(): void {
    if (this.running) return;

    try {
      this.proc = spawn({
        cmd: [
          "ffmpeg",
          "-hide_banner",
          "-loglevel", "error",
          "-probesize", "32",
          "-analyzeduration", "0",
          "-f", "h264",
          "-i", "pipe:0",            // H.264 input from stdin
          "-f", "image2pipe",
          "-vcodec", "mjpeg",
          "-q:v", "5",               // JPEG quality (2=best, 31=worst)
          "-vf", "fps=fps=8",        // Output at 8fps — sufficient for recording + AI
          "pipe:1",                  // JPEG output to stdout
        ],
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });

      this.running = true;
      this.readLoop();
      console.log(`[h264-decoder] Started for session=${this.sessionId}`);
    } catch (err) {
      console.error(`[h264-decoder] Failed to start ffmpeg: ${err}`);
    }
  }

  /** Feed an H.264 NAL unit (Annex-B or AVCC format) into the decoder */
  feed(data: Uint8Array): void {
    if (!this.running || !this.proc?.stdin) return;
    try {
      this.proc.stdin.write(data);
    } catch {
      // Pipe may be broken if ffmpeg exited
      this.restart();
    }
  }

  /** Stop the decoder and clean up */
  stop(): void {
    this.running = false;
    try {
      this.proc?.stdin?.end();
    } catch { /* ignore */ }
    try {
      this.proc?.kill();
    } catch { /* ignore */ }
    this.proc = null;
    this.buffer = new Uint8Array(0);
    if (this.frameCount > 0) {
      console.log(`[h264-decoder] Stopped for session=${this.sessionId} decoded=${this.frameCount} frames`);
    }
  }

  /** Is the decoder running? */
  get active(): boolean {
    return this.running && this.proc !== null;
  }

  /** Read decoded JPEG frames from ffmpeg stdout */
  private async readLoop(): Promise<void> {
    if (!this.proc?.stdout) return;

    const reader = this.proc.stdout.getReader();

    try {
      while (this.running) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;

        // Append to buffer
        const prev = this.buffer;
        this.buffer = new Uint8Array(prev.length + value.length);
        this.buffer.set(prev);
        this.buffer.set(value, prev.length);

        // Extract complete JPEG frames from buffer
        this.extractJpegs();
      }
    } catch {
      // Reader closed — ffmpeg exited
    } finally {
      reader.releaseLock();
      if (this.running) {
        this.restart();
      }
    }
  }

  /** Extract complete JPEG frames from the internal buffer */
  private extractJpegs(): void {
    while (true) {
      // Find JPEG SOI marker (0xFF 0xD8)
      const soiIdx = this.findMarker(this.buffer, 0xff, 0xd8);
      if (soiIdx === -1) {
        this.buffer = new Uint8Array(0);
        return;
      }

      // Find JPEG EOI marker (0xFF 0xD9)
      const eoiIdx = this.findMarker(this.buffer, 0xff, 0xd9, soiIdx + 2);
      if (eoiIdx === -1) {
        // Incomplete frame — keep buffer from SOI onwards
        if (soiIdx > 0) {
          this.buffer = this.buffer.slice(soiIdx);
        }
        return;
      }

      // Extract complete JPEG: SOI to EOI + 2 bytes (includes EOI marker)
      const jpeg = this.buffer.slice(soiIdx, eoiIdx + 2);
      this.buffer = this.buffer.slice(eoiIdx + 2);

      this.frameCount++;
      if (this._onJpeg) {
        this._onJpeg(jpeg);
      }
    }
  }

  /** Find a two-byte marker sequence in a buffer */
  private findMarker(buf: Uint8Array, b1: number, b2: number, start = 0): number {
    for (let i = start; i < buf.length - 1; i++) {
      if (buf[i] === b1 && buf[i + 1] === b2) return i;
    }
    return -1;
  }

  /** Restart the ffmpeg subprocess on failure */
  private restart(): void {
    this.stop();
    // Backoff restart
    setTimeout(() => {
      if (!this.running) {
        this.start();
      }
    }, 1000);
  }
}
