/*
 * NodePreviewView.swift
 *
 * Debug overlay that renders live preview tiles from all pipeline stages.
 * Debug-only -- guarded by #if DEBUG.
 */

#if DEBUG

import SwiftUI

// MARK: - Numeric Entry (identifiable for ForEach)

struct NumericEntry: Identifiable {
    let label: String
    let value: Double
    let unit: String
    var id: String { label }
}

// MARK: - Preview State Holder

@MainActor
class PreviewStore: ObservableObject {
    @Published var sources: [String: PreviewSourceState] = [:]
    @Published var sourceOrder: [String] = []

    struct PreviewSourceState {
        let source: PreviewSource
        var text: String?
        var numerics: [NumericEntry]
        var image: UIImage?
        var status: (label: String, state: PreviewState)?
        var lastUpdate: ContinuousClock.Instant
    }

    func update(_ event: PreviewEvent) {
        let stageId = event.source.stageId
        var state = sources[stageId] ?? PreviewSourceState(
            source: event.source,
            text: nil,
            numerics: [],
            image: nil,
            status: nil,
            lastUpdate: .now
        )

        switch event {
        case .text(_, let value):
            state.text = value
        case .numeric(_, let label, let value, let unit):
            if let idx = state.numerics.firstIndex(where: { $0.label == label }) {
                state.numerics[idx] = NumericEntry(label: label, value: value, unit: unit)
            } else {
                state.numerics.append(NumericEntry(label: label, value: value, unit: unit))
            }
        case .image(_, let value):
            state.image = value
        case .status(_, let label, let st):
            state.status = (label, st)
        case .waveform, .json:
            break
        }
        state.lastUpdate = .now

        if sources[stageId] == nil {
            sourceOrder.append(stageId)
        }
        sources[stageId] = state
    }
}

// MARK: - Node Preview View

struct NodePreviewView: View {
    @ObservedObject var store: PreviewStore
    @State private var isExpanded = true
    @State private var collapsedSources: Set<String> = []

    var body: some View {
        nodeContent
            .padding(6)
            .background(Color.black.opacity(0.85))
            .cornerRadius(8)
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(Color.cyan.opacity(0.3), lineWidth: 1)
            )
    }

    @ViewBuilder
    private var nodeContent: some View {
        VStack(alignment: .leading, spacing: 2) {
            headerView
            if isExpanded {
                Divider().background(.white.opacity(0.15))
                tilesList
            }
        }
    }

    private var headerView: some View {
        Button(action: { isExpanded.toggle() }) {
            HStack(spacing: 6) {
                Image(systemName: "square.grid.2x2")
                    .font(.system(size: 10))
                Text("NODE PREVIEW")
                    .font(.system(size: 9, weight: .bold, design: .monospaced))
                Spacer()
                Text("\(store.sources.count)")
                    .font(.system(size: 8, weight: .bold, design: .monospaced))
                    .foregroundColor(.cyan)
                    .padding(.horizontal, 4)
                    .padding(.vertical, 1)
                    .background(Color.cyan.opacity(0.2))
                    .cornerRadius(4)
                Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                    .font(.system(size: 8))
            }
            .foregroundColor(.cyan)
        }
    }

    private var tilesList: some View {
        let order = store.sourceOrder
        return ScrollView(.vertical, showsIndicators: false) {
            LazyVStack(alignment: .leading, spacing: 4) {
                ForEach(Array(order.enumerated()), id: \.offset) { _, stageId in
                    if let state = store.sources[stageId] {
                        StagePreviewTile(
                            state: state,
                            isCollapsed: collapsedSources.contains(stageId),
                            onToggle: {
                                if collapsedSources.contains(stageId) {
                                    collapsedSources.remove(stageId)
                                } else {
                                    collapsedSources.insert(stageId)
                                }
                            }
                        )
                    }
                }
            }
        }
        .frame(maxHeight: 300)
    }
}

// MARK: - Stage Tile

struct StagePreviewTile: View {
    let state: PreviewStore.PreviewSourceState
    let isCollapsed: Bool
    let onToggle: () -> Void

    var body: some View {
        tileContent
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(Color.white.opacity(0.05))
            .cornerRadius(4)
    }

    @ViewBuilder
    private var tileContent: some View {
        VStack(alignment: .leading, spacing: 2) {
            tileHeader
            if !isCollapsed {
                tileBody
            }
        }
    }

    private var tileHeader: some View {
        Button(action: onToggle) {
            HStack(spacing: 4) {
                statusDot
                Text(state.source.label)
                    .font(.system(size: 9, weight: .semibold, design: .monospaced))
                    .foregroundColor(.white)
                Spacer()
                Image(systemName: isCollapsed ? "chevron.right" : "chevron.down")
                    .font(.system(size: 7))
                    .foregroundColor(.white.opacity(0.4))
            }
        }
    }

    @ViewBuilder
    private var tileBody: some View {
        if let image = state.image {
            Image(uiImage: image)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(maxHeight: 80)
                .cornerRadius(4)
        }

        if let status = state.status {
            HStack(spacing: 4) {
                Circle()
                    .fill(colorForState(status.state))
                    .frame(width: 6, height: 6)
                Text(status.label)
                    .font(.system(size: 8, design: .monospaced))
                    .foregroundColor(colorForState(status.state))
            }
        }

        ForEach(state.numerics) { numeric in
            numericRow(numeric)
        }

        if let text = state.text {
            Text(text)
                .font(.system(size: 8, design: .monospaced))
                .foregroundColor(.white.opacity(0.8))
                .lineLimit(3)
                .padding(.vertical, 1)
        }
    }

    @ViewBuilder
    private var statusDot: some View {
        if let status = state.status {
            Circle().fill(colorForState(status.state)).frame(width: 6, height: 6)
        } else {
            Circle().fill(Color.white.opacity(0.2)).frame(width: 6, height: 6)
        }
    }

    private func numericRow(_ entry: NumericEntry) -> some View {
        HStack {
            Text(entry.label)
                .font(.system(size: 8, design: .monospaced))
                .foregroundColor(.white.opacity(0.5))
            Spacer()
            Text(formatNumeric(entry.value, unit: entry.unit))
                .font(.system(size: 8, weight: .medium, design: .monospaced))
                .foregroundColor(numericColor(entry.value, label: entry.label))
        }
    }

    private func colorForState(_ s: PreviewState) -> Color {
        switch s {
        case .nominal: return .green
        case .active: return .cyan
        case .warning: return .yellow
        case .error: return .red
        case .idle: return .gray
        case .disabled: return .gray.opacity(0.5)
        }
    }

    private func formatNumeric(_ value: Double, unit: String) -> String {
        let formatted: String
        if abs(value) >= 1000 {
            formatted = String(format: "%.0f", value)
        } else if abs(value) >= 100 {
            formatted = String(format: "%.1f", value)
        } else {
            formatted = String(format: "%.2f", value)
        }
        return unit.isEmpty ? formatted : "\(formatted) \(unit)"
    }

    private func numericColor(_ value: Double, label: String) -> Color {
        if label.contains("CPU") {
            return value > 80 ? .red : value > 50 ? .yellow : .green
        } else if label.contains("Battery") {
            return value < 20 ? .red : value < 50 ? .yellow : .green
        } else if label.contains("Latency") {
            return value > 200 ? .red : value > 100 ? .yellow : .green
        } else if label.contains("Dropped") {
            return value > 0 ? .yellow : .green
        } else if label.contains("Encode") {
            return value > 100 ? .red : value > 50 ? .yellow : .green
        }
        return .white
    }
}

#endif
