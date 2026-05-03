/*
 * YOLOOverlayRenderer.swift
 *
 * SwiftUI helper functions for rendering YOLO-specific overlay elements.
 * Provides Shape and View builders that BoundingBoxOverlayView calls.
 *
 * - Per-class colors: Golden angle HSV distribution for 80 COCO classes
 * - Segmentation masks: Semi-transparent colored overlay per detection
 * - Pose keypoints: 17 COCO keypoints with skeleton connections
 */

import SwiftUI

// MARK: - Per-Class Color

/// Generate a unique color for a YOLO class index using golden angle HSV.
/// Same algorithm as OC-SORT track coloring (137 degrees hue separation).
func yoloClassColor(for classIndex: Int) -> Color {
    let hue = Double((classIndex * 137) % 360) / 360.0
    return Color(hue: hue, saturation: 0.8, brightness: 0.9)
}

// MARK: - Detection Label Badge

/// Creates a label badge view for a YOLO detection.
@ViewBuilder
func yoloDetectionBadge(
    detection: YOLODetection,
    rect: CGRect,
    geometryWidth: CGFloat,
    geometryHeight: CGFloat
) -> some View {
    let color = yoloClassColor(for: detection.classIndex)
    let labelText = "\(detection.classLabel) \(Int(detection.confidence * 100))%"

    Text(labelText)
        .font(.system(size: 8, weight: .bold, design: .monospaced))
        .foregroundColor(.black)
        .padding(.horizontal, 3)
        .padding(.vertical, 1)
        .background(color)
        .position(
            x: min(rect.minX + 35, geometryWidth - 30),
            y: max(8, rect.minY - 6)
        )
}

// MARK: - Bounding Box

/// Creates a bounding box rectangle for a YOLO detection.
@ViewBuilder
func yoloBoundingBox(
    detection: YOLODetection,
    rect: CGRect
) -> some View {
    let color = yoloClassColor(for: detection.classIndex)

    Rectangle()
        .stroke(color, lineWidth: 2)
        .frame(width: rect.width, height: rect.height)
        .position(x: rect.midX, y: rect.midY)
}

// MARK: - Pose Skeleton

/// Renders 17 COCO keypoints and skeleton connections for a pose detection.
@ViewBuilder
func yoloPoseOverlay(
    keypoints: [YOLOKeypoint],
    geometryWidth: CGFloat,
    geometryHeight: CGFloat,
    color: Color = .cyan
) -> some View {
    // Skeleton connections
    ForEach(0..<COCOSkeletonConnections.count, id: \.self) { idx in
        let (i, j) = COCOSkeletonConnections[idx]
        if i < keypoints.count, j < keypoints.count,
           keypoints[i].confidence > 0.3, keypoints[j].confidence > 0.3 {
            let p1 = CGPoint(
                x: keypoints[i].x * geometryWidth,
                y: keypoints[i].y * geometryHeight
            )
            let p2 = CGPoint(
                x: keypoints[j].x * geometryWidth,
                y: keypoints[j].y * geometryHeight
            )
            Path { path in
                path.move(to: p1)
                path.addLine(to: p2)
            }
            .stroke(color.opacity(0.7), lineWidth: 1.5)
        }
    }

    // Keypoint dots
    ForEach(Array(keypoints.enumerated()), id: \.offset) { _, kp in
        if kp.confidence > 0.3 {
            Circle()
                .fill(color.opacity(0.9))
                .frame(width: 4, height: 4)
                .position(
                    x: kp.x * geometryWidth,
                    y: kp.y * geometryHeight
                )
        }
    }
}
