/*
 * LocationStage.swift
 *
 * On-device GPS location streaming using CoreLocation.
 * Runs as an independent actor (NOT a FramePipelineStage) — has its own
 * CLLocationManager via a delegate wrapper (same pattern as TelemetryService).
 *
 * Supports four modes:
 *   - "continuous": Regular GPS updates with configurable accuracy/interval
 *   - "significant": Battery-efficient ~500m updates via startMonitoringSignificantLocationChanges
 *   - "visits": Detect arrive/stay/leave at locations via startMonitoringVisits
 *   - "geofence": Monitor circular regions with enter/exit notifications
 *
 * Results are relayed as `sensor_result` JSON messages through RelayStage.
 * NSLocationWhenInUseUsageDescription must be in Info.plist (already present).
 * CLLocationManager must be created on the main thread.
 */

import CoreLocation
import Foundation

// MARK: - Location Mode

enum LocationMode: String, Sendable {
    case continuous
    case significant
    case visits
    case geofence
}

// MARK: - Geofence Config

struct GeofenceRegion: Sendable {
    let id: String
    let latitude: Double
    let longitude: Double
    let radius: Double
    let notifyOnEntry: Bool
    let notifyOnExit: Bool
    let label: String?
}

// MARK: - Location Event Type

enum LocationEventType: String, Sendable {
    case update = "location_update"
    case significant = "significant_change"
    case visit = "visit_detected"
    case geofenceEnter = "geofence_enter"
    case geofenceExit = "geofence_exit"
}

// MARK: - LocationStage

actor LocationStage {
    // Location manager (held via delegate wrapper on @MainActor)
    private var locationDelegate: LocationDelegateWrapper?
    private var isEnabled = false

    // Config
    private var mode: LocationMode = .continuous
    private var accuracy: CLLocationAccuracy = kCLLocationAccuracyBest
    private var minDistance: CLLocationDistance = 5.0
    private var updateIntervalSec: Double = 5.0
    private var geofences: [GeofenceRegion] = []

    // Throttle (for continuous mode)
    private var lastUpdateTime: ContinuousClock.Instant?

    // Callback for relaying results
    private var onResult: (@Sendable (LocationUpdate) async -> Void)?

    func setOnResult(_ handler: @escaping @Sendable (LocationUpdate) async -> Void) {
        self.onResult = handler
    }

    func configure(accuracy: String, minDistance: Double, updateIntervalSec: Double,
                   mode: String?, geofences: [[String: Any]]?) {
        // Mode
        self.mode = LocationMode(rawValue: mode ?? "continuous") ?? .continuous

        // Accuracy
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

        // Parse geofences
        if let geofences {
            self.geofences = geofences.compactMap { gf in
                guard let lat = gf["latitude"] as? Double,
                      let lon = gf["longitude"] as? Double,
                      let radius = gf["radius"] as? Double else { return nil }
                return GeofenceRegion(
                    id: gf["id"] as? String ?? UUID().uuidString,
                    latitude: lat,
                    longitude: lon,
                    radius: radius,
                    notifyOnEntry: gf["notifyOnEntry"] as? Bool ?? true,
                    notifyOnExit: gf["notifyOnExit"] as? Bool ?? true,
                    label: gf["label"] as? String
                )
            }
        }
    }

    func start() async {
        guard !isEnabled else { return }
        isEnabled = true

        let desiredAccuracy = accuracy
        let distanceFilter = minDistance
        let currentMode = mode
        let currentGeofences = geofences

        let delegate = await MainActor.run {
            let wrapper = LocationDelegateWrapper()
            wrapper.manager.desiredAccuracy = desiredAccuracy
            wrapper.manager.distanceFilter = distanceFilter

            switch currentMode {
            case .continuous:
                wrapper.startContinuous()
            case .significant:
                wrapper.startSignificantChanges()
            case .visits:
                wrapper.startVisits()
            case .geofence:
                wrapper.startGeofences(currentGeofences)
            }

            return wrapper
        }

        await delegate.setOnLocationUpdate { [weak self] locations in
            Task { [weak self] in
                await self?.handleLocations(locations)
            }
        }

        await delegate.setOnRegionEvent { [weak self] event in
            Task { [weak self] in
                await self?.handleRegionEvent(event)
            }
        }

        await delegate.setOnVisitEvent { [weak self] visit in
            Task { [weak self] in
                await self?.handleVisit(visit)
            }
        }

        self.locationDelegate = delegate
        NSLog("[LocationStage] Started: mode=\(mode.rawValue) accuracy=\(desiredAccuracy) minDistance=\(distanceFilter)m interval=\(updateIntervalSec)s geofences=\(geofences.count)")
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

        // Throttle by updateIntervalSec (continuous mode only)
        if mode == .continuous {
            let now = ContinuousClock.Instant.now
            if let last = lastUpdateTime {
                let elapsed = now - last
                let interval = Duration.seconds(updateIntervalSec)
                guard elapsed >= interval else { return }
            }
            lastUpdateTime = now
        }

        let eventType: LocationEventType = mode == .significant ? .significant : .update

        let update = LocationUpdate(
            eventType: eventType.rawValue,
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

    private func handleRegionEvent(_ event: RegionEvent) {
        guard isEnabled else { return }

        let eventType: LocationEventType = event.isEntry ? .geofenceEnter : .geofenceExit

        let update = LocationUpdate(
            eventType: eventType.rawValue,
            latitude: event.latitude,
            longitude: event.longitude,
            altitude: 0,
            horizontalAccuracy: 0,
            speed: -1,
            course: -1,
            timestamp: Date().timeIntervalSince1970,
            regionId: event.regionId,
            regionLabel: event.regionLabel
        )

        if let onResult {
            Task { await onResult(update) }
        }
    }

    private func handleVisit(_ visit: VisitEvent) {
        guard isEnabled else { return }

        let update = LocationUpdate(
            eventType: LocationEventType.visit.rawValue,
            latitude: visit.latitude,
            longitude: visit.longitude,
            altitude: 0,
            horizontalAccuracy: visit.horizontalAccuracy,
            speed: -1,
            course: -1,
            timestamp: visit.arrivalDate?.timeIntervalSince1970 ?? Date().timeIntervalSince1970,
            visitArrival: visit.arrivalDate?.timeIntervalSince1970,
            visitDeparture: visit.departureDate?.timeIntervalSince1970
        )

        if let onResult {
            Task { await onResult(update) }
        }
    }
}

// MARK: - Event Helpers

struct RegionEvent: Sendable {
    let regionId: String
    let regionLabel: String?
    let latitude: Double
    let longitude: Double
    let isEntry: Bool
}

struct VisitEvent: Sendable {
    let latitude: Double
    let longitude: Double
    let horizontalAccuracy: Double
    let arrivalDate: Date?
    let departureDate: Date?
}

// MARK: - CLLocationManager Delegate Wrapper
// CLLocationManager delegate must be NSObject and created on main thread.

@MainActor
final class LocationDelegateWrapper: NSObject, CLLocationManagerDelegate, @unchecked Sendable {
    let manager = CLLocationManager()
    private var onLocationUpdateHandler: (@Sendable ([CLLocation]) -> Void)?
    private var onRegionEventHandler: (@Sendable (RegionEvent) -> Void)?
    private var onVisitEventHandler: (@Sendable (VisitEvent) -> Void)?
    private var monitoredRegionLabels: [String: String] = [:]

    override init() {
        super.init()
        manager.delegate = self
    }

    func setOnLocationUpdate(_ handler: @escaping @Sendable ([CLLocation]) -> Void) {
        self.onLocationUpdateHandler = handler
    }

    func setOnRegionEvent(_ handler: @escaping @Sendable (RegionEvent) -> Void) {
        self.onRegionEventHandler = handler
    }

    func setOnVisitEvent(_ handler: @escaping @Sendable (VisitEvent) -> Void) {
        self.onVisitEventHandler = handler
    }

    // MARK: - Mode-specific start methods

    func startContinuous() {
        manager.requestWhenInUseAuthorization()
        manager.startUpdatingLocation()
    }

    func startSignificantChanges() {
        manager.requestWhenInUseAuthorization()
        manager.startMonitoringSignificantLocationChanges()
    }

    func startVisits() {
        manager.requestWhenInUseAuthorization()
        manager.startMonitoringVisits()
    }

    func startGeofences(_ geofences: [GeofenceRegion]) {
        manager.requestWhenInUseAuthorization()
        for gf in geofences {
            let center = CLLocationCoordinate2D(latitude: gf.latitude, longitude: gf.longitude)
            let region = CLCircularRegion(
                center: center,
                radius: gf.radius,
                identifier: gf.id
            )
            region.notifyOnEntry = gf.notifyOnEntry
            region.notifyOnExit = gf.notifyOnExit
            if let label = gf.label {
                monitoredRegionLabels[gf.id] = label
            }
            manager.startMonitoring(for: region)
            NSLog("[LocationStage] Monitoring geofence: \(gf.label ?? gf.id) at (\(gf.latitude), \(gf.longitude)) radius=\(gf.radius)m")
        }
    }

    func stop() {
        manager.stopUpdatingLocation()
        manager.stopMonitoringSignificantLocationChanges()
        manager.stopMonitoringVisits()
        for region in manager.monitoredRegions {
            manager.stopMonitoring(for: region)
        }
        monitoredRegionLabels.removeAll()
    }

    // MARK: - CLLocationManagerDelegate

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let wrapper = manager.delegate as? LocationDelegateWrapper else { return }
        Task { @MainActor in
            wrapper.onLocationUpdateHandler?(locations)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        NSLog("[LocationStage] Location error: \(error)")
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didEnterRegion region: CLRegion) {
        guard let wrapper = manager.delegate as? LocationDelegateWrapper else { return }
        let center = (region as? CLCircularRegion)?.center
        let regionId = region.identifier
        let lat = center?.latitude ?? 0
        let lon = center?.longitude ?? 0
        Task { @MainActor in
            let event = RegionEvent(
                regionId: regionId,
                regionLabel: wrapper.monitoredRegionLabels[regionId],
                latitude: lat,
                longitude: lon,
                isEntry: true
            )
            wrapper.onRegionEventHandler?(event)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didExitRegion region: CLRegion) {
        guard let wrapper = manager.delegate as? LocationDelegateWrapper else { return }
        let center = (region as? CLCircularRegion)?.center
        let regionId = region.identifier
        let lat = center?.latitude ?? 0
        let lon = center?.longitude ?? 0
        Task { @MainActor in
            let event = RegionEvent(
                regionId: regionId,
                regionLabel: wrapper.monitoredRegionLabels[regionId],
                latitude: lat,
                longitude: lon,
                isEntry: false
            )
            wrapper.onRegionEventHandler?(event)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didVisit visit: CLVisit) {
        guard let wrapper = manager.delegate as? LocationDelegateWrapper else { return }
        let event = VisitEvent(
            latitude: visit.coordinate.latitude,
            longitude: visit.coordinate.longitude,
            horizontalAccuracy: visit.horizontalAccuracy,
            arrivalDate: visit.arrivalDate,
            departureDate: visit.departureDate
        )
        Task { @MainActor in
            wrapper.onVisitEventHandler?(event)
        }
    }
}
