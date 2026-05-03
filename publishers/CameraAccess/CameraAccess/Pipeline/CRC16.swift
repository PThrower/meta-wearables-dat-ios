/*
 * CRC16.swift
 *
 * CRC-16/CCITT-FALSE checksum for wire protocol header integrity.
 * Used by both FRLY (video) and FRAU (audio) wire protocols.
 *
 * Polynomial: 0x1021, init: 0xFFFF, no reflect, no final XOR.
 */

import Foundation

enum CRC16 {
    /// CRC-16/CCITT-FALSE over a range of bytes in Data.
    static func ccittFalse(_ data: Data, offset: Int = 0, length: Int? = nil) -> UInt16 {
        let len = length ?? (data.count - offset)
        var crc: UInt16 = 0xFFFF
        let end = offset + len
        for i in offset..<end {
            crc ^= UInt16(data[i]) << 8
            for _ in 0..<8 {
                if crc & 0x8000 != 0 {
                    crc = (crc << 1) ^ 0x1021
                } else {
                    crc = crc << 1
                }
            }
        }
        return crc
    }
}
