/*
 * SensorTypes.swift
 *
 * Shared types for on-device sensor stages (sound classification, GPS location).
 * Independent of the frame pipeline — sensors have their own lifecycle and
 * relay results via `sensor_result` JSON messages through RelayStage.
 */

import Foundation

// MARK: - Sensor Type

/// Discriminated union for sensor stage types.
enum SensorType: String, Sendable, Codable, CaseIterable {
    case sound = "sensor-sound"
    case location = "sensor-location"
    case locationSignificant = "sensor-location-significant"
    case locationVisits = "sensor-location-visits"
    case locationGeofence = "sensor-location-geofence"

    /// Resolve the CLLocationManager mode string for location variants.
    var locationMode: String? {
        switch self {
        case .location: return "continuous"
        case .locationSignificant: return "significant"
        case .locationVisits: return "visits"
        case .locationGeofence: return "geofence"
        default: return nil
        }
    }
}

// MARK: - Sound Classification

struct SoundLabel: Sendable, Codable, Identifiable {
    let id = UUID()
    let label: String
    let confidence: Double
}

struct SoundClassification: Sendable, Codable {
    let labels: [SoundLabel]
}

// MARK: - Location Update

struct LocationUpdate: Sendable, Codable {
    let eventType: String       // "location_update", "significant_change", "visit_detected", "geofence_enter", "geofence_exit"
    let latitude: Double
    let longitude: Double
    let altitude: Double
    let horizontalAccuracy: Double
    let speed: Double           // m/s, -1 if unavailable
    let course: Double          // degrees, -1 if unavailable
    let timestamp: Double       // Unix epoch seconds

    // Geofence fields (only set for geofence_enter / geofence_exit)
    var regionId: String?
    var regionLabel: String?

    // Visit fields (only set for visit_detected)
    var visitArrival: Double?
    var visitDeparture: Double?
}

// MARK: - SensorStageConfig

/// Configuration for sensor stages, parsed from server `sensor_stage_config` WS message.
struct SensorStageConfig: Sendable {
    let sensors: [SensorConfig]

    struct SensorConfig: Sendable {
        let type: SensorType
        let config: [String: Any]
    }

    static func fromServerConfig(_ msg: [String: Any]) -> SensorStageConfig {
        var sensors: [SensorConfig] = []
        if let sensorArray = msg["sensors"] as? [[String: Any]] {
            for sensorMsg in sensorArray {
                guard let typeStr = sensorMsg["sensorType"] as? String,
                      let sensorType = SensorType(rawValue: typeStr) else { continue }
                let config = sensorMsg["config"] as? [String: Any] ?? [:]
                sensors.append(SensorConfig(type: sensorType, config: config))
            }
        }
        return SensorStageConfig(sensors: sensors)
    }
}

// MARK: - JSON Serialization

extension SoundClassification {
    var jsonDict: [String: Any] {
        return [
            "type": "sensor_result",
            "sensorType": "sensor-sound",
            "labels": labels.map { [
                "label": $0.label,
                "confidence": $0.confidence,
            ] },
        ] as [String: Any]
    }
}

extension LocationUpdate {
    var jsonDict: [String: Any] {
        var dict: [String: Any] = [
            "type": "sensor_result",
            "sensorType": "sensor-location",
            "eventType": eventType,
            "latitude": latitude,
            "longitude": longitude,
            "altitude": altitude,
            "horizontalAccuracy": horizontalAccuracy,
            "speed": speed,
            "course": course,
            "timestamp": timestamp,
        ]
        if let regionId { dict["regionId"] = regionId }
        if let regionLabel { dict["regionLabel"] = regionLabel }
        if let visitArrival { dict["visitArrival"] = visitArrival }
        if let visitDeparture { dict["visitDeparture"] = visitDeparture }
        return dict
    }
}
