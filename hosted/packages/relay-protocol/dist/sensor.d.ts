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
export declare function isSensorFrame(buf: Uint8Array): boolean;
export interface SensorHeader {
    version: number;
    payloadLength: number;
    sequence: number;
    sensorFlags: number;
    frequencyHz: number;
    timestampMs: number;
    json: object;
}
export declare function parseSensorHeader(buf: Uint8Array): SensorHeader | null;
