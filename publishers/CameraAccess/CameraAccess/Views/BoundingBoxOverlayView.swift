//
// BoundingBoxOverlayView.swift
//
// SwiftUI overlay that renders AI-detected bounding boxes on top of the camera preview.
// Coordinates are 0-1 normalized (converted from 1024-space at parse time).
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

  var body: some View {
    if showOverlay && !boxes.isEmpty {
      GeometryReader { geometry in
        ZStack {
          ForEach(Array(boxes.enumerated()), id: \.element.id) { index, box in
            let color = colorForIndex(index)
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
        }
      }
      .allowsHitTesting(false)
    }
  }

  private func colorForIndex(_ i: Int) -> Color {
    let palette: [Color] = [.green, .blue, .yellow, .red, .purple, .orange, .teal, .pink]
    return palette[i % palette.count]
  }
}
