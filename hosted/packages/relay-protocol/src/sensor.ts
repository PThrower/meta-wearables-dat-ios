/**
 * Sensor telemetry (FRSE) parsing — v1
 *
 * Wire layout (36 byte header):
 *   [0:4]   magic "FRSE"
 *   [4]     version      (u8) — must be 1
 *   [5:9]   payloadLen   (u32 LE)
 *   [9:17]  sequence     (u64 LE)
 *   [17:21] sensorFlags  (u32 LE) — bitmask of included sensor groups
 *   [21]    frequencyHz  (u8) — capture frequency (1-255 Hz)
 *   [22:26] reserved     (4 bytes, zero)
 *   [26:34] timestamp    (u64 LE, ms)
 *   [34:36] headerCrc16  (u16 LE)
 *   [35:]   JSON payload (UTF-8, only fields for flags set groups)
 *
 * sensorFlags bitmask:
 *   0x0001  motion       (accelXYZ, isStationary)
 *   0x0002  gyro         (rotationXYZ)
 *   0x0004  magnetometer (magXYZ)
 *   0x0008  barometer    (pressureKPa)
 *   0x0010  location     (speed, altitude, accuracy)
 *   0x0020  proximity    (near)
 *   0x0040  battery      (level, state, lowPowerMode)
 *   0x0080  network      (type, expensive, constrained)
 *   0x0100  thermal      (state)
 *   0x0200  orientation  (orientation)
 *   0x0400  memory       (availableMB, pressure, footprintMB)
 *   0x0800  cpu          (usagePercent)
 *   0x1000  disk         (availableGB, totalGB)
 *   0x2000  streamMetrics (fps, jitter, totalFrames, encodeTimeEma)
 */

import { FRSE_MAGIC, SENSOR_HEADER_SIZE, PROTOCOL_VERSION, SENSOR_CRC_OFFSET, SENSOR_HEADER_BEFORE_CRC } from "./constants.js";
import { crc16 } from "./crc16.js";

export function isSensorFrame(buf: Uint8Array): boolean {
  return buf.length >= 4 && buf[0] === FRSE_MAGIC[0] && buf[1] === FRSE_MAGIC[1] && buf[2] === FRSE_MAGIC[2] && buf[3] === FRSE_MAGIC[3];
}

export interface SensorHeader {
  version: number;
  payloadLength: number;
  sequence: number;
  sensorFlags: number;
  frequencyHz: number;
  timestampMs: number;
  json: object;
}

export function parseSensorHeader(buf: Uint8Array): SensorHeader | null {
  if (buf.length < SENSOR_HEADER_SIZE) return null;
  if (buf[0] !== FRSE_MAGIC[0] || buf[1] !== FRSE_MAGIC[1] || buf[2] !== FRSE_MAGIC[2] || buf[3] !== FRSE_MAGIC[3]) return null;

  const version = buf[4];
  if (version !== PROTOCOL_VERSION) return null;

  const view = new DataView(buf.buffer, buf.byteOffset);

  // Validate CRC16 over header bytes [0..32]
  const expectedCrc = view.getUint16(SENSOR_CRC_OFFSET, true);
  const computedCrc = crc16(buf, 0, SENSOR_HEADER_BEFORE_CRC);
  if (expectedCrc !== computedCrc) return null;

  const payloadLength = view.getUint32(5, true);

  // Parse JSON payload
  let json: object = {};
  if (buf.length >= SENSOR_HEADER_SIZE + payloadLength && payloadLength > 0) {
    try {
      const jsonBytes = buf.subarray(SENSOR_HEADER_SIZE, SENSOR_HEADER_SIZE + payloadLength);
      json = JSON.parse(new TextDecoder().decode(jsonBytes));
    } catch {
      // Malformed JSON — still return header but with empty object
    }
  }

  return {
    version,
    payloadLength,
    sequence: Number(view.getBigUint64(9, true)),
    sensorFlags: view.getUint32(17, true),
    frequencyHz: buf[21],
    timestampMs: Number(view.getBigUint64(26, true)),
    json,
  };
}
