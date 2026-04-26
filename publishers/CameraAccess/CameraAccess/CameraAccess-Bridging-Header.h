/*
 * CameraAccess-Bridging-Header.h
 *
 * Bridging header for Swift <-> C interop.
 * Imports the vendored google/liblc3 decoder used by Even Realities G1/G2
 * BLE microphone audio (LC3 codec, 10ms frames, 16kHz mono).
 *
 * HEADER_SEARCH_PATHS includes BLE/lc3/ so <lc3.h> resolves.
 * LC3_EXPORT is defined internally by lc3_private.h (included by lc3.h).
 */

#include <lc3.h>
