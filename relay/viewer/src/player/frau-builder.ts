/**
 * FRAU binary frame builder for viewer mic capture
 *
 * Wire layout (29 byte header + PCM payload):
 *   [0:4]   magic "FRAU" (0x46524155)
 *   [4]     codecType  (u8) — 3 = relay inbound (viewer mic / server audio)
 *   [5:13]  sequence   (u64 LE)
 *   [13:17] sampleRate (u32 LE)
 *   [17:19] channels   (u16 LE)
 *   [19:21] bitsPerSample (u16 LE)
 *   [21:29] timestamp  (u64 LE, ms)
 *   [29:]   PCM payload (Int16Array)
 */

const FRAU_MAGIC_BYTE_0 = 0x46; // 'F'
const FRAU_MAGIC_BYTE_1 = 0x52; // 'R'
const FRAU_MAGIC_BYTE_2 = 0x41; // 'A'
const FRAU_MAGIC_BYTE_3 = 0x55; // 'U'
const FRAU_HEADER_SIZE = 29;

export function buildFrauFrame(
  codecType: number,
  seqNum: number,
  sampleRate: number,
  channels: number,
  bitsPerSample: number,
  pcmInt16: Int16Array
): ArrayBuffer {
  const frameSize = FRAU_HEADER_SIZE + pcmInt16.byteLength;
  const buf = new ArrayBuffer(frameSize);
  const view = new DataView(buf);

  // Magic bytes
  view.setUint8(0, FRAU_MAGIC_BYTE_0);
  view.setUint8(1, FRAU_MAGIC_BYTE_1);
  view.setUint8(2, FRAU_MAGIC_BYTE_2);
  view.setUint8(3, FRAU_MAGIC_BYTE_3);

  // codecType (u8)
  view.setUint8(4, codecType);

  // Sequence number (u64 LE)
  view.setBigUint64(5, BigInt(seqNum), true);

  // Sample rate (u32 LE)
  view.setUint32(13, sampleRate, true);

  // Channels (u16 LE)
  view.setUint16(17, channels, true);

  // Bits per sample (u16 LE)
  view.setUint16(19, bitsPerSample, true);

  // Timestamp ms (u64 LE)
  view.setBigUint64(21, BigInt(Date.now()), true);

  // PCM payload
  const pcmDest = new Int16Array(buf, FRAU_HEADER_SIZE, pcmInt16.length);
  pcmDest.set(pcmInt16);

  return buf;
}
