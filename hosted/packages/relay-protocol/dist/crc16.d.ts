/**
 * CRC-16/CCITT-FALSE
 *
 * Polynomial: 0x1021, Init: 0xFFFF, no reflect, no final XOR.
 * Used for header integrity in FRLY and FRAU wire protocols.
 */
export declare function crc16(buf: Uint8Array, offset: number, length: number): number;
