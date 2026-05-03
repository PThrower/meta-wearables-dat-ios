/**
 * CRC-16/CCITT-FALSE
 *
 * Polynomial: 0x1021, Init: 0xFFFF, no reflect, no final XOR.
 * Used for header integrity in FRLY and FRAU wire protocols.
 */
export function crc16(buf, offset, length) {
    let crc = 0xffff;
    const end = offset + length;
    for (let i = offset; i < end; i++) {
        crc ^= buf[i] << 8;
        for (let j = 0; j < 8; j++) {
            if (crc & 0x8000) {
                crc = (crc << 1) ^ 0x1021;
            }
            else {
                crc = crc << 1;
            }
        }
        crc &= 0xffff;
    }
    return crc;
}
