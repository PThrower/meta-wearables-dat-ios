//
// AppPickerSheet.swift
//
// Sheet for selecting which AI app to activate on the relay server.
// Fetches available apps from GET /apps and shows a picker list.
//

import SwiftUI

struct AppPickerSheet: View {
  @Environment(StreamCoordinator.self) private var coordinator
  @Environment(\.dismiss) var dismiss
  @State private var fetched = false

  var body: some View {
    NavigationView {
      Group {
        if coordinator.isLoadingApps {
          VStack(spacing: 12) {
            ProgressView()
              .scaleEffect(1.2)
            Text("Loading apps...")
              .font(.system(size: 13, design: .monospaced))
              .foregroundColor(.secondary)
          }
          .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let error = coordinator.appFetchError {
          VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle")
              .font(.system(size: 28))
              .foregroundColor(.orange)
            Text(error)
              .font(.system(size: 13, design: .monospaced))
              .foregroundColor(.secondary)
              .multilineTextAlignment(.center)
              .padding(.horizontal, 24)
            Button("Retry") {
              coordinator.availableApps = []
              fetched = false
              fetchIfNeeded()
            }
            .buttonStyle(.bordered)
          }
          .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if coordinator.availableApps.isEmpty {
          VStack(spacing: 12) {
            Image(systemName: "app.badge")
              .font(.system(size: 28))
              .foregroundColor(.secondary)
            Text("No apps available")
              .font(.system(size: 13, design: .monospaced))
              .foregroundColor(.secondary)
          }
          .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
          ScrollView {
            LazyVStack(alignment: .leading, spacing: 2) {
              ForEach(coordinator.availableApps) { app in
                Button {
                  coordinator.activateApp(app.id)
                  dismiss()
                } label: {
                  HStack(spacing: 10) {
                    Image(systemName: app.icon)
                      .font(.system(size: 14))
                      .foregroundColor(coordinator.activeAppId == app.id ? .blue : .secondary)
                      .frame(width: 24)

                    VStack(alignment: .leading, spacing: 2) {
                      Text(app.name)
                        .font(.system(size: 14, weight: coordinator.activeAppId == app.id ? .medium : .regular))
                        .foregroundColor(coordinator.activeAppId == app.id ? .primary : .secondary)
                      Text(app.description)
                        .font(.system(size: 11))
                        .foregroundColor(.secondary)
                        .lineLimit(2)
                    }

                    Spacer()

                    if coordinator.activeAppId == app.id {
                      Image(systemName: "checkmark")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundColor(.blue)
                    }
                  }
                  .padding(.horizontal, 12)
                  .padding(.vertical, 10)
                  .background(coordinator.activeAppId == app.id ? Color.blue.opacity(0.08) : Color(UIColor.secondarySystemGroupedBackground))
                  .cornerRadius(8)
                }
              }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
          }
        }
      }
      .navigationTitle("AI Apps")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .navigationBarTrailing) {
          Button("Cancel") { dismiss() }
        }
      }
    }
    .task { fetchIfNeeded() }
  }

  private func fetchIfNeeded() {
    guard !fetched else { return }
    fetched = true
    Task { await coordinator.fetchApps() }
  }
}
