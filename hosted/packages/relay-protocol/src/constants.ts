/**
 * Wire protocol constants for caringmind-frame-relay
 *
 * FRLY: video frames  [4B "FRLY"][8B sequence][4B width][4B height][1B quality][8B timestamp_ms][JPEG payload]
 * FRAU: audio frames  [4B "FRAU"][8B sequence][4B sampleRate][2B channels][2B bitsPerSample][8B timestamp_ms][PCM payload]
 */

// --- Header sizes ---

export const HEADER_SIZE = 29;       // FRLY video header: 4 + 8 + 4 + 4 + 1 + 8
export const AUDIO_HEADER_SIZE = 29; // FRAU audio header: 4 + 1 + 8 + 4 + 2 + 2 + 8

// --- Magic bytes ---

export const FRLY_MAGIC = [0x46, 0x52, 0x4c, 0x59]; // "FRLY"
export const FRAU_MAGIC = [0x46, 0x52, 0x41, 0x55]; // "FRAU"
