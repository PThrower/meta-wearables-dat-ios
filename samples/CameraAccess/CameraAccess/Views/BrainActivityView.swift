//
// BrainActivityView.swift
//
// SwiftUI view for visualizing TRIBE v2 brain predictions.
// Shows real-time ROI activations as animated bars.
//

import SwiftUI

/// Overlay view for displaying brain activity
struct BrainActivityOverlay: View {
    let prediction: BrainPrediction?
    let isMockMode: Bool
    let connectionStatus: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Header
            HStack {
                Text("Brain Activity")
                    .font(.headline)
                    .foregroundColor(.white)

                Spacer()

                if isMockMode {
                    Text("MOCK")
                        .font(.caption)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.orange)
                        .cornerRadius(4)
                        .foregroundColor(.white)
                }
            }

            // Connection status
            Text(connectionStatus)
                .font(.caption2)
                .foregroundColor(.gray)

            if let prediction = prediction {
                // ROI Bars
                VStack(spacing: 6) {
                    ROIProgressBar(
                        label: "Visual Cortex",
                        value: prediction.visualCortex,
                        color: .blue
                    )

                    ROIProgressBar(
                        label: "Auditory Cortex",
                        value: prediction.auditoryCortex,
                        color: .green
                    )

                    ROIProgressBar(
                        label: "Language Network",
                        value: prediction.languageNetwork,
                        color: .purple
                    )

                    ROIProgressBar(
                        label: "Prefrontal",
                        value: prediction.prefrontal,
                        color: .orange
                    )

                    ROIProgressBar(
                        label: "Motor",
                        value: prediction.motor,
                        color: .red
                    )
                }

                // Timestamp
                Text("t = \(String(format: "%.1f", prediction.timestamp))s")
                    .font(.caption2)
                    .foregroundColor(.gray)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            } else {
                Text("Waiting for predictions...")
                    .font(.caption)
                    .foregroundColor(.gray)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 20)
            }
        }
        .padding(12)
        .background(Color.black.opacity(0.7))
        .cornerRadius(12)
    }
}

/// Individual ROI progress bar
struct ROIProgressBar: View {
    let label: String
    let value: Float
    let color: Color

    var body: some View {
        HStack(spacing: 8) {
            Text(label)
                .font(.caption)
                .foregroundColor(.white)
                .frame(width: 100, alignment: .leading)

            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    // Background track
                    RoundedRectangle(cornerRadius: 4)
                        .fill(Color.gray.opacity(0.3))

                    // Active fill
                    RoundedRectangle(cornerRadius: 4)
                        .fill(color)
                        .frame(width: geometry.size.width * CGFloat(value.clamped(to: 0...1)))
                        .animation(.easeInOut(duration: 0.3), value: value)
                }
            }
            .frame(height: 16)

            // Value label
            Text(String(format: "%.2f", value))
                .font(.caption2)
                .foregroundColor(.white)
                .frame(width: 40, alignment: .trailing)
        }
    }
}

/// Full brain visualization view (standalone)
struct BrainVisualizationView: View {
    @ObservedObject var brainService: TribeBrainService

    var body: some View {
        ZStack {
            // Gradient background
            LinearGradient(
                gradient: Gradient(colors: [Color.black, Color.blue.opacity(0.3)]),
                startPoint: .top,
                endPoint: .bottom
            )
            .edgesIgnoringSafeArea(.all)

            VStack(spacing: 24) {
                // Title
                Text("TRIBE v2")
                    .font(.largeTitle)
                    .fontWeight(.bold)
                    .foregroundColor(.white)

                Text("Live Brain Prediction")
                    .font(.subheadline)
                    .foregroundColor(.gray)

                // Brain visualization
                if let prediction = brainService.currentPrediction {
                    BrainHeatmapView(prediction: prediction)
                        .frame(height: 300)
                        .cornerRadius(16)
                        .padding(.horizontal)

                    // ROI Details
                    VStack(spacing: 12) {
                        ROIDetailRow(name: "Visual", value: prediction.visualCortex, color: .blue)
                        ROIDetailRow(name: "Auditory", value: prediction.auditoryCortex, color: .green)
                        ROIDetailRow(name: "Language", value: prediction.languageNetwork, color: .purple)
                        ROIDetailRow(name: "Prefrontal", value: prediction.prefrontal, color: .orange)
                        ROIDetailRow(name: "Motor", value: prediction.motor, color: .red)
                    }
                    .padding()
                    .background(Color.black.opacity(0.5))
                    .cornerRadius(12)
                    .padding(.horizontal)
                } else {
                    ProgressView()
                        .scaleEffect(2)
                        .foregroundColor(.white)

                    Text("Waiting for brain activity...")
                        .foregroundColor(.gray)
                        .padding(.top, 16)
                }

                // Status
                VStack {
                    Text(brainService.connectionStatus)
                        .font(.caption)
                        .foregroundColor(.gray)

                    if brainService.isMockMode {
                        Text("Using mock server")
                            .font(.caption2)
                            .foregroundColor(.orange)
                    }
                }
            }
            .padding()
        }
    }
}

/// Simplified brain heatmap visualization
struct BrainHeatmapView: View {
    let prediction: BrainPrediction

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                // Background brain silhouette (simplified)
                BrainSilhouette()
                    .fill(Color.gray.opacity(0.3))

                // Overlay heat zones based on activation
                BrainHeatOverlay(prediction: prediction)
            }
        }
        .background(Color.black)
    }
}

/// Simplified brain shape
struct BrainSilhouette: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()

        // Simple brain outline
        let centerX = rect.midX
        let centerY = rect.midY
        let size = min(rect.width, rect.height) * 0.4

        // Left hemisphere
        path.addEllipse(in: CGRect(
            x: centerX - size,
            y: centerY - size * 0.8,
            width: size * 0.9,
            height: size * 1.6
        ))

        // Right hemisphere
        path.addEllipse(in: CGRect(
            x: centerX + size * 0.1,
            y: centerY - size * 0.8,
            width: size * 0.9,
            height: size * 1.6
        ))

        return path
    }
}

/// Heat overlay showing active regions
struct BrainHeatOverlay: View {
    let prediction: BrainPrediction

    var body: some View {
        GeometryReader { geometry in
            let centerX = geometry.midX
            let centerY = geometry.midY
            let unit = min(geometry.width, geometry.height) * 0.15

            ZStack {
                // Visual cortex (back of brain)
                Circle()
                    .fill(Color.blue.opacity(Double(prediction.visualCortex)))
                    .frame(width: unit * 2, height: unit * 2)
                    .position(x: centerX, y: centerY + unit * 2)

                // Auditory cortex (sides)
                Circle()
                    .fill(Color.green.opacity(Double(prediction.auditoryCortex)))
                    .frame(width: unit * 1.5, height: unit * 1.5)
                    .position(x: centerX - unit * 2, y: centerY)

                Circle()
                    .fill(Color.green.opacity(Double(prediction.auditoryCortex)))
                    .frame(width: unit * 1.5, height: unit * 1.5)
                    .position(x: centerX + unit * 2, y: centerY)

                // Prefrontal (front of brain)
                Circle()
                    .fill(Color.orange.opacity(Double(prediction.prefrontal)))
                    .frame(width: unit * 1.8, height: unit * 1.2)
                    .position(x: centerX, y: centerY - unit * 2)

                // Language network (left hemisphere)
                Circle()
                    .fill(Color.purple.opacity(Double(prediction.languageNetwork)))
                    .frame(width: unit * 1.5, height: unit * 1.5)
                    .position(x: centerX - unit, y: centerY - unit * 0.5)

                // Motor cortex (top)
                Circle()
                    .fill(Color.red.opacity(Double(prediction.motor)))
                    .frame(width: unit * 1.5, height: unit)
                    .position(x: centerX, y: centerY - unit * 2.5)
            }
        }
    }
}

/// ROI detail row with percentage
struct ROIDetailRow: View {
    let name: String
    let value: Float
    let color: Color

    var body: some View {
        HStack {
            Circle()
                .fill(color)
                .frame(width: 12, height: 12)

            Text(name)
                .foregroundColor(.white)
                .frame(width: 80, alignment: .leading)

            Spacer()

            Text("\(Int(value * 100))%")
                .foregroundColor(.white)
                .fontWeight(.bold)
        }
    }
}

// MARK: - Extensions

extension Float {
    func clamped(to range: ClosedRange<Float>) -> Float {
        return min(max(self, range.lowerBound), range.upperBound)
    }
}

// MARK: - Preview

#Preview {
    ZStack {
        Color.black.edgesIgnoringSafeArea(.all)

        VStack {
            Spacer()

            BrainActivityOverlay(
                prediction: BrainPrediction(
                    roiActivations: [
                        "visual_cortex": 0.72,
                        "auditory_cortex": 0.35,
                        "language_network": 0.58,
                        "prefrontal": 0.41,
                        "motor": 0.15
                    ],
                    timestamp: 12.5,
                    shape: [10, 20484],
                    mock: true
                ),
                isMockMode: true,
                connectionStatus: "Connected (ok)"
            )
            .padding()

            Spacer()
        }
    }
}
