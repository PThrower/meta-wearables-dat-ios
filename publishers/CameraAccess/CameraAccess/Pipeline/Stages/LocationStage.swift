/*
 * LocationStage.swift
 *
 * On-device GPS location streaming using CoreLocation.
 * Runs as an independent actor (NOT a FramePipelineStage) — has its own
 * CLLocationManager via a delegate wrapper (same pattern as TelemetryService).
 *
 * Results are relayed as `sensor_result` JSON messages through RelayStage.
 * NSLocationWhenInUseUsageDescription must be in Info.plist (already present).
 * CLLocationManager must be created on the main thread.
 */

import CoreLocation
import Foundation

actor LocationStage {
    // Location manager (held via delegate wrapper on @MainActor)
    private var locationDelegate: LocationDelegateWrapper?
    private var isEnabled = false

    // Config
    private var accuracy: CLLocationAccuracy = kCLLocationAccuracyBest
    private var minDistance: CLLocationDistance = 5.0
    private var updateIntervalSec: Double = 5.0

    // Throttle
    private var lastUpdateTime: ContinuousClock.Instant?

    // Callback for relaying results
    private var onResult: (@Sendable (LocationUpdate) async -> Void)?

    func setOnResult(_ handler: @escaping @Sendable (LocationUpdate) async -> Void) {
        self.onResult = handler
    }

    func configure(accuracy: String, minDistance: Double, updateIntervalSec: Double) {
        switch accuracy {
        case "best": self.accuracy = kCLLocationAccuracyBest
        case "tenMeters": self.accuracy = kCLLocationAccuracyHundredMeters
        case "hundredMeters": self.accuracy = kCLLocationAccuracyHundredMeters
        case "kilometer": self.accuracy = kCLLocationAccuracyKilometer
        case "threeKilometers": self.accuracy = kCLLocationAccuracyThreeKilometers
        default: self.accuracy = kCLLocationAccuracyBest
        }
        self.minDistance = minDistance
        self.updateIntervalSec = updateIntervalSec
    }

    func start() async {
        guard !isEnabled else { return }
        isEnabled = true

        // Capture config values before crossing actor boundary
        let desiredAccuracy = accuracy
        let distanceFilter = minDistance

        let delegate = await MainActor.run {
            let wrapper = LocationDelegateWrapper()
            wrapper.manager.desiredAccuracy = desiredAccuracy
            wrapper.manager.distanceFilter = distanceFilter
            wrapper.start()
            return wrapper
        }

        await delegate.setOnLocationUpdate { [weak self] locations in
            Task { [weak self] in
                await self?.handleLocations(locations)
            }
        }

        self.locationDelegate = delegate
        NSLog("[LocationStage] Started: accuracy=\(desiredAccuracy) minDistance=\(distanceFilter)m interval=\(updateIntervalSec)s")
    }

    func stop() async {
        guard isEnabled else { return }
        isEnabled = false

        if let delegate = locationDelegate {
            await delegate.stop()
        }
        locationDelegate = nil
        NSLog("[LocationStage] Stopped")
    }

    // MARK: - Private

    private func handleLocations(_ locations: [CLLocation]) {
        guard isEnabled, let location = locations.last else { return }

        // Throttle by updateIntervalSec
        let now = ContinuousClock.Instant.now
        if let last = lastUpdateTime {
            let elapsed = now - last
            let interval = Duration.seconds(updateIntervalSec)
            guard elapsed >= interval else { return }
        }
        lastUpdateTime = now

        let update = LocationUpdate(
            latitude: location.coordinate.latitude,
            longitude: location.coordinate.longitude,
            altitude: location.altitude,
            horizontalAccuracy: location.horizontalAccuracy,
            speed: location.speed >= 0 ? location.speed : -1,
            course: location.course >= 0 ? location.course : -1,
            timestamp: location.timestamp.timeIntervalSince1970
        )

        if let onResult {
            Task { await onResult(update) }
        }
    }
}

// MARK: - CLLocationManager Delegate Wrapper
// CLLocationManager delegate must be NSObject and created on main thread.

@MainActor
final class LocationDelegateWrapper: NSObject, CLLocationManagerDelegate, @unchecked Sendable {
    let manager = CLLocationManager()
    private var onLocationUpdateHandler: (@Sendable ([CLLocation]) -> Void)?

    override init() {
        super.init()
        manager.delegate = self
    }

    func setOnLocationUpdate(_ handler: @escaping @Sendable ([CLLocation]) -> Void) {
        self.onLocationUpdateHandler = handler
    }

    func start() {
        manager.requestWhenInUseAuthorization()
        manager.startUpdatingLocation()
    }

    func stop() {
        manager.stopUpdatingLocation()
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let wrapper = manager.delegate as? LocationDelegateWrapper else { return }
        Task { @MainActor in
            wrapper.onLocationUpdateHandler?(locations)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        NSLog("[LocationStage] Location error: \(error)")
    }
}
