#if DEBUG

import SwiftUI

struct TelemetryHUDView: View {
    @ObservedObject var telemetry: TelemetryService
    @State private var isExpanded = true

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            // Toggle header
            Button(action: { isExpanded.toggle() }) {
                HStack {
                    Image(systemName: "chart.bar.fill")
                        .font(.system(size: 10))
                    Text("TELEMETRY")
                        .font(.system(size: 9, weight: .bold, design: .monospaced))
                    Spacer()
                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 8))
                }
                .foregroundColor(.green)
            }

            if isExpanded {
                Divider().background(.white.opacity(0.2))

                sectionHeader("SESSION")
                row("State", telemetry.sessionStateText)
                row("Uptime", telemetry.uptimeText)
                row("TTFF", telemetry.ttffText)
                thermalRow(telemetry.thermalText)
                row("Memory", telemetry.memoryText)
                row("Mem RSS", telemetry.memoryFootprintText)
                row("Disk", telemetry.diskText)
                row("Brightness", telemetry.brightnessText)
                row("Orient", telemetry.orientationText)
                row("Proximity", telemetry.proximityText)
                row("Motion", telemetry.motionText)
                row("Gyro", telemetry.gyroText)
                row("CPU", telemetry.cpuText)
                row("FG/BG", telemetry.backgroundText)

                Divider().background(.white.opacity(0.2))

                sectionHeader("FRAMES")
                row("FPS", telemetry.fpsText)
                row("Jitter", telemetry.jitterText)
                row("Frames", telemetry.frameCountText)
                row("Drops", telemetry.droppedFramesText)
                if telemetry.cameraInfoText != "--" {
                    row("Camera", telemetry.cameraInfoText)
                }

                Divider().background(.white.opacity(0.2))

                sectionHeader("SENSORS")
                row("GPS", telemetry.locationText)
                row("Mag", telemetry.magnetometerText)
                row("Baro", telemetry.barometerText)
                row("Audio dB", telemetry.audioLevelText)

                Divider().background(.white.opacity(0.2))

                sectionHeader("CONNECTION")
                row("Link", telemetry.connectionText)
                row("Network", telemetry.networkText)
                row("RTT", telemetry.relayLatencyText)
                row("Throughput", telemetry.throughputText)
                row("BT", telemetry.bluetoothText)
                if telemetry.cellularText != "--" {
                    row("Cellular", telemetry.cellularText)
                }
                if !telemetry.deviceInfoText.isEmpty {
                    row("Device", telemetry.deviceInfoText)
                }

                if telemetry.totalErrors > 0 {
                    Divider().background(.white.opacity(0.2))

                    sectionHeader("ERRORS")
                    row("Total", telemetry.errorCountText)
                    if !telemetry.recentErrorsText.isEmpty {
                        Text(telemetry.recentErrorsText)
                            .font(.system(size: 8, design: .monospaced))
                            .foregroundColor(.red.opacity(0.9))
                            .lineLimit(3)
                    }
                }

                if telemetry.photoLatencyText != "--" {
                    Divider().background(.white.opacity(0.2))

                    sectionHeader("PHOTO")
                    row("Latency", telemetry.photoLatencyText)
                }
            }
        }
        .padding(6)
        .background(Color.black.opacity(0.8))
        .cornerRadius(6)
        .font(.system(size: 10, design: .monospaced))
        .foregroundColor(.white)
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 8, weight: .bold, design: .monospaced))
            .foregroundColor(.green.opacity(0.7))
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label)
                .foregroundColor(.white.opacity(0.6))
            Spacer()
            Text(value)
                .foregroundColor(.white)
        }
    }

    private func thermalRow(_ value: String) -> some View {
        let color: Color = {
            switch value {
            case "nominal": return .green
            case "fair": return .yellow
            case "serious": return .orange
            case "critical": return .red
            default: return .white
            }
        }()
        return HStack {
            Text("Thermal")
                .foregroundColor(.white.opacity(0.6))
            Spacer()
            Text(value)
                .foregroundColor(color)
        }
    }
}

#endif
