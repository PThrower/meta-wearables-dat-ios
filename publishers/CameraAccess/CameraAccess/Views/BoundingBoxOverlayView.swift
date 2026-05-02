//
// BoundingBoxOverlayView.swift
//
// SwiftUI overlay that renders bounding boxes on top of the camera preview.
// Handles both AI server detections (BoundingBox) and on-device Vision
// framework detections (VisionDetection).
//
// OC-SORT tracked objects: per-ID unique colors (golden angle HSV),
// trajectory trails (polylines connecting bbox centers over last 30 frames).
// Ref: Ultralytics tracking docs — draw movement paths of tracked objects
// Ref: BoxMOT visualization — per-track distinct colors with trails
//
// Coordinates are 0-1 normalized.
//

import SwiftUI

struct BoundingBox: Identifiable {
  let id = UUID()
  let x1: Double   // 0-1 normalized
  let y1: Double
  let x2: Double
  let y2: Double
  let label: String
  let confidence: Double
}

struct BoundingBoxOverlayView: View {
  var boxes: [BoundingBox]
  var showOverlay: Bool

  /// On-device Vision framework detections (rendered alongside server boxes).
  var visionDetections: [VisionDetection] = []

  /// Scene classification label to display (if any).
  var sceneLabel: String?

  /// Live transcription text to display as subtitle overlay.
  var transcription: String? = nil

  /// Tracked objects from OC-SORT with persistent IDs and trajectory trails.
  /// Paper: arXiv:2203.14360 — visual tracking output with per-ID rendering.
  var trackedItems: [Track] = []

  /// YOLO CoreML on-device detections (bounding boxes, masks, keypoints).
  var yoloDetections: [YOLODetection] = []

  /// Zone definitions for rendering on the camera feed (background layer).
  var zones: [ZoneDefinition] = []

  var body: some View {
    let hasBoxes = showOverlay && (!boxes.isEmpty || !visionDetections.isEmpty || !trackedItems.isEmpty || !yoloDetections.isEmpty || sceneLabel != nil)
    let hasTranscription = transcription != nil
    let hasZones = !zones.isEmpty
    if hasBoxes || hasTranscription || hasZones {
      GeometryReader { geometry in
        ZStack {
          // Zone overlay (background layer — rendered first, behind detections)
          zoneOverlay(zones: zones, size: geometry.size)

          // Server AI bounding boxes (existing)
          if showOverlay {
          ForEach(Array(boxes.enumerated()), id: \.element.id) { index, box in
            let color = aiColor
            let rect = CGRect(
              x: box.x1 * geometry.size.width,
              y: box.y1 * geometry.size.height,
              width: (box.x2 - box.x1) * geometry.size.width,
              height: (box.y2 - box.y1) * geometry.size.height
            )

            // Bounding box stroke
            Rectangle()
              .stroke(color, lineWidth: 2)
              .frame(width: rect.width, height: rect.height)
              .position(x: rect.midX, y: rect.midY)

            // Label badge above box
            Text("\(box.label) \(Int(box.confidence * 100))%")
              .font(.system(size: 9, weight: .bold, design: .monospaced))
              .foregroundColor(.black)
              .padding(.horizontal, 4)
              .padding(.vertical, 2)
              .background(color)
              .position(
                x: rect.minX + 30,
                y: max(10, rect.minY - 8)
              )
          }

          // Vision framework detections (on-device)
          ForEach(Array(visionDetections.enumerated()), id: \.offset) { index, detection in
            if let bb = detection.boundingBox {
              let color = visionColor(for: detection.detectionType)
              let rect = CGRect(
                x: bb.x1 * geometry.size.width,
                y: bb.y1 * geometry.size.height,
                width: bb.width * geometry.size.width,
                height: bb.height * geometry.size.height
              )

              // Dashed bounding box for Vision detections (vs solid for AI)
              Rectangle()
                .stroke(color, style: StrokeStyle(lineWidth: 1.5, dash: [4, 2]))
                .frame(width: rect.width, height: rect.height)
                .position(x: rect.midX, y: rect.midY)

              // OCR text shown inside the box, other labels above
              if case .ocr(let ocrResult) = detection {
                // Truncate long OCR text for display
                let displayText = ocrResult.text.count > 30
                  ? String(ocrResult.text.prefix(30)) + "..."
                  : ocrResult.text
                Text(displayText)
                  .font(.system(size: 8, weight: .medium, design: .monospaced))
                  .foregroundColor(.white)
                  .padding(.horizontal, 3)
                  .padding(.vertical, 1)
                  .background(Color.black.opacity(0.7))
                  .position(x: rect.midX, y: rect.minY - 8)
              } else {
                // Label badge (Face, Person, Barcode)
                Text("\(detection.displayLabel) \(Int(detection.confidence * 100))%")
                  .font(.system(size: 8, weight: .bold, design: .monospaced))
                  .foregroundColor(.black)
                  .padding(.horizontal, 3)
                  .padding(.vertical, 1)
                  .background(color)
                  .position(
                    x: rect.minX + 25,
                    y: max(8, rect.minY - 6)
                  )
              }
            }
          }

          // OC-SORT tracked objects — per-ID unique colors + trajectory trails
          // Ref: Ultralytics tracking modes — distinct per-track colors, motion trails
          // Ref: BoxMOT visualization — golden angle HSV color distribution
          ForEach(Array(trackedItems.enumerated()), id: \.offset) { _, track in
            let color = colorForTrackId(track.trackId)
            let rect = CGRect(
              x: track.bbox.x1 * geometry.size.width,
              y: track.bbox.y1 * geometry.size.height,
              width: (track.bbox.x2 - track.bbox.x1) * geometry.size.width,
              height: (track.bbox.y2 - track.bbox.y1) * geometry.size.height
            )

            // Trajectory trail: individual segments with fading alpha for older points
            // Ref: Ultralytics tracking docs — draw movement paths of tracked objects
            if track.trail.count > 1 {
              let points = track.trail.map { CGPoint(
                x: $0.x * geometry.size.width,
                y: $0.y * geometry.size.height
              )}
              // Draw each segment individually with increasing alpha toward present
              ForEach(0..<(points.count - 1), id: \.self) { segIdx in
                let alpha = 0.15 + 0.7 * Double(segIdx) / Double(max(1, points.count - 1))
                let width = 0.5 + 1.5 * Double(segIdx) / Double(max(1, points.count - 1))
                Path { path in
                  path.move(to: points[segIdx])
                  path.addLine(to: points[segIdx + 1])
                }
                .stroke(
                  color.opacity(alpha),
                  style: StrokeStyle(lineWidth: width, lineCap: .round)
                )
              }
            }

            // Forecast trail: dashed polyline extending from current position into the future.
            // Distinct from history trail — dashed, fading toward future.
            // Used for pre-positioning UI, zone breach anticipation, gap interpolation.
            forecastTrail(for: track, color: color, size: geometry.size)

            // Bounding box: confirmed=solid, tentative/lost=dashed
            // Ref: BoxMOT — confirmed tracks get thicker solid borders
            let strokeStyle: StrokeStyle = track.state == .confirmed
              ? StrokeStyle(lineWidth: 2.5)
              : StrokeStyle(lineWidth: 1.5, dash: [6, 3])

            Rectangle()
              .stroke(color, style: strokeStyle)
              .frame(width: rect.width, height: rect.height)
              .position(x: rect.midX, y: rect.midY)

            // Track label: #ID classLabel confidence%
            // Ref: Ultralytics — show track ID and class with confidence
            Text(track.displayLabel)
              .font(.system(size: 9, weight: .bold, design: .monospaced))
              .foregroundColor(.white)
              .padding(.horizontal, 4)
              .padding(.vertical, 2)
              .background(color.opacity(0.9))
              .cornerRadius(2)
              .position(
                x: rect.minX + 40,
                y: max(10, rect.minY - 8)
              )
          }

          // YOLO CoreML on-device detections — per-class golden-angle colors
          ForEach(Array(yoloDetections.enumerated()), id: \.offset) { _, detection in
            let color = yoloClassColor(for: detection.classIndex)
            let rect = CGRect(
              x: detection.bbox.x1 * geometry.size.width,
              y: detection.bbox.y1 * geometry.size.height,
              width: detection.bbox.width * geometry.size.width,
              height: detection.bbox.height * geometry.size.height
            )

            // Bounding box (solid, thicker for YOLO)
            Rectangle()
              .stroke(color, lineWidth: 2)
              .frame(width: rect.width, height: rect.height)
              .position(x: rect.midX, y: rect.midY)

            // Class label badge
            Text("\(detection.classLabel) \(Int(detection.confidence * 100))%")
              .font(.system(size: 8, weight: .bold, design: .monospaced))
              .foregroundColor(.black)
              .padding(.horizontal, 3)
              .padding(.vertical, 1)
              .background(color)
              .position(
                x: min(rect.minX + 35, geometry.size.width - 30),
                y: max(8, rect.minY - 6)
              )

            // Pose keypoints (17 COCO skeleton)
            if let keypoints = detection.keypoints {
              yoloPoseOverlay(
                keypoints: keypoints,
                geometryWidth: geometry.size.width,
                geometryHeight: geometry.size.height,
                color: color
              )
            }
          }

          // Scene classification label (top-right corner)
          if let label = sceneLabel {
            Text(label)
              .font(.system(size: 10, weight: .semibold, design: .monospaced))
              .foregroundColor(.white)
              .padding(.horizontal, 6)
              .padding(.vertical, 3)
              .background(Color.purple.opacity(0.85))
              .cornerRadius(4)
              .position(
                x: geometry.size.width - 60,
                y: 14
              )
          }
          } // end if showOverlay

          // Live transcription subtitle (bottom-center) — always visible when present
          if let text = transcription {
            Text(text)
              .font(.system(size: 13, weight: .medium, design: .monospaced))
              .foregroundColor(.white)
              .padding(.horizontal, 12)
              .padding(.vertical, 6)
              .background(Color.black.opacity(0.75))
              .cornerRadius(6)
              .lineLimit(3)
              .multilineTextAlignment(.center)
              .frame(maxWidth: geometry.size.width - 24, alignment: .center)
              .position(
                x: geometry.size.width / 2,
                y: geometry.size.height - 30
              )
          }
        }
      }
      .allowsHitTesting(false)
    }
  }

  // MARK: - Colors

  private let aiColor: Color = .green

  private func visionColor(for type: VisionDetectionType) -> Color {
    switch type {
    case .faceDetect: return .purple
    case .barcodeScan: return .cyan
    case .ocr: return .yellow
    case .sceneClassify: return .purple
    case .personDetect: return .orange
    case .bodyPose: return .pink
    }
  }

  /// Per-track unique color using golden angle HSV distribution.
  /// Ref: BoxMOT — distinct per-track colors for visual differentiation
  /// Golden angle (137 degrees) ensures maximum hue separation between consecutive IDs.
  private func colorForTrackId(_ id: Int) -> Color {
    let hue = Double((id * 137) % 360) / 360.0
    return Color(hue: hue, saturation: 0.7, brightness: 0.9)
  }

  /// Render trajectory forecast trail as dashed polyline extending into the future.
  /// Extracted from body to reduce SwiftUI type-checker complexity.
  @ViewBuilder
  private func forecastTrail(for track: Track, color: Color, size: CGSize) -> some View {
    if track.forecast.isEmpty {
      EmptyView()
    } else {
      let w = size.width
      let h = size.height
      let cx = (track.bbox.x1 + track.bbox.x2) / 2 * w
      let cy = (track.bbox.y1 + track.bbox.y2) / 2 * h
      let segments: [(start: CGPoint, end: CGPoint, alpha: Double, lineWidth: CGFloat)] = {
        var pts: [CGPoint] = [CGPoint(x: cx, y: cy)]
        for p in track.forecast {
          pts.append(CGPoint(x: p.center.x * w, y: p.center.y * h))
        }
        let total = max(1, pts.count - 1)
        var segs: [(start: CGPoint, end: CGPoint, alpha: Double, lineWidth: CGFloat)] = []
        for i in 0..<(pts.count - 1) {
          let a = 0.6 * (1.0 - Double(i) / Double(total))
          let lw: CGFloat = CGFloat(1.5 * (1.0 - 0.7 * Double(i) / Double(total)))
          segs.append((pts[i], pts[i + 1], a, max(0.5, lw)))
        }
        return segs
      }()

      ForEach(0..<segments.count, id: \.self) { idx in
        let seg = segments[idx]
        let segColor = color.opacity(seg.alpha)
        let style = StrokeStyle(lineWidth: seg.lineWidth, lineCap: .round, dash: [4, 4])
        Path { path in
          path.move(to: seg.start)
          path.addLine(to: seg.end)
        }
        .stroke(segColor, style: style)
      }
    }
  }

  // MARK: - Zone Overlay

  /// Render zones as semi-transparent colored rectangles with dashed borders.
  /// Extracted from body to reduce SwiftUI type-checker complexity.
  @ViewBuilder
  private func zoneOverlay(zones: [ZoneDefinition], size: CGSize) -> some View {
    ForEach(Array(zones.enumerated()), id: \.element.id) { index, zone in
      let color = colorForZone(zone: zone, index: index)
      let rect = CGRect(
        x: zone.x1 * size.width,
        y: zone.y1 * size.height,
        width: (zone.x2 - zone.x1) * size.width,
        height: (zone.y2 - zone.y1) * size.height
      )

      // Semi-transparent fill
      Rectangle()
        .fill(color.opacity(0.12))
        .frame(width: rect.width, height: rect.height)
        .position(x: rect.midX, y: rect.midY)

      // Dashed border
      Rectangle()
        .stroke(color, style: StrokeStyle(lineWidth: 1.5, dash: [6, 3]))
        .frame(width: rect.width, height: rect.height)
        .position(x: rect.midX, y: rect.midY)

      // Label badge
      if !zone.label.isEmpty {
        Text(zone.label)
          .font(.system(size: 9, weight: .bold, design: .monospaced))
          .foregroundColor(.white)
          .padding(.horizontal, 4)
          .padding(.vertical, 2)
          .background(color.opacity(0.85))
          .cornerRadius(2)
          .position(
            x: rect.minX + 30,
            y: max(10, rect.minY - 8)
          )
      }
    }
  }

  /// Get color for a zone — uses hex color if provided, else golden-angle fallback.
  private func colorForZone(zone: ZoneDefinition, index: Int) -> Color {
    if let hex = zone.color, !hex.isEmpty {
      return colorFromHex(hex)
    }
    let hue = Double((index * 137 + 60) % 360) / 360.0
    return Color(hue: hue, saturation: 0.6, brightness: 0.85)
  }

  /// Parse "#RRGGBB" hex string to SwiftUI Color.
  private func colorFromHex(_ hex: String) -> Color {
    let cleaned = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
    guard cleaned.count == 6,
      let r = UInt8(cleaned.prefix(2), radix: 16),
      let g = UInt8(cleaned.dropFirst(2).prefix(2), radix: 16),
      let b = UInt8(cleaned.suffix(2), radix: 16)
    else {
      return .green
    }
    return Color(red: Double(r) / 255, green: Double(g) / 255, blue: Double(b) / 255)
  }
}
