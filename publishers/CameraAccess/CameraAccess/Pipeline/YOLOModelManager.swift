/*
 * YOLOModelManager.swift
 *
 * Actor that handles YOLO CoreML model download, caching, compilation, and loading.
 * Models are cached as compiled .mlmodelc in Library/Caches/YOLOModels/.
 * Bundled .mlpackage models are compiled on first use.
 * Server-served models are downloaded, extracted, and compiled.
 */

import CoreML
import Foundation

actor YOLOModelManager {
    // MARK: - Cache

    private let cacheDir: URL = {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
        return caches.appendingPathComponent("YOLOModels", isDirectory: true)
    }()

    // In-memory model cache (keyed by modelId)
    private var loadedModels: [String: MLModel] = [:]

    // Download progress stream
    private var progressContinuations: [String: AsyncStream<Double>.Continuation] = [:]

    // MARK: - Public

    /// Load a compiled MLModel, downloading or compiling as needed.
    /// - Parameters:
    ///   - id: Model identifier (e.g. "yolo11n", "yolo11s-seg")
    ///   - serverUrl: Optional server URL to download from. Nil = use bundled model.
    /// - Returns: Compiled MLModel ready for inference.
    func loadModel(id: String, serverUrl: String? = nil) async throws -> MLModel {
        // Return cached model if available
        if let cached = loadedModels[id] {
            return cached
        }

        // Ensure cache directory exists
        try FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)

        let compiledUrl = cacheDir.appendingPathComponent("\(id).mlmodelc")

        // Check for existing compiled model
        if FileManager.default.fileExists(atPath: compiledUrl.path) {
            let model = try await loadCompiledModel(at: compiledUrl)
            loadedModels[id] = model
            return model
        }

        // If server URL provided, download and compile
        if let serverUrl {
            let model = try await downloadAndCompile(id: id, serverUrl: serverUrl, compiledUrl: compiledUrl)
            loadedModels[id] = model
            return model
        }

        // Try bundled .mlpackage -> compile to cache
        if let bundledUrl = findBundledModel(id: id) {
            let model = try await compileBundledModel(at: bundledUrl, to: compiledUrl)
            loadedModels[id] = model
            return model
        }

        throw YOLOModelError.modelNotFound(id: id)
    }

    /// Get the compiled URL for a model if it exists in cache.
    func compiledUrl(for id: String) -> URL? {
        let url = cacheDir.appendingPathComponent("\(id).mlmodelc")
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    /// Clear all cached models (compiled files and in-memory).
    func clearCache() async {
        loadedModels.removeAll()
        progressContinuations.values.forEach { $0.finish() }
        progressContinuations.removeAll()
        try? FileManager.default.removeItem(at: cacheDir)
    }

    /// Observe download progress for a specific model.
    func downloadProgress(id: String) -> AsyncStream<Double> {
        AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            progressContinuations[id] = continuation
        }
    }

    // MARK: - Private

    private func loadCompiledModel(at url: URL) async throws -> MLModel {
        let config = MLModelConfiguration()
        config.computeUnits = .all  // Prefer Neural Engine
        return try MLModel(contentsOf: url, configuration: config)
    }

    private func downloadAndCompile(id: String, serverUrl: String, compiledUrl: URL) async throws -> MLModel {
        guard let url = URL(string: serverUrl) else {
            throw YOLOModelError.invalidURL(serverUrl)
        }

        // Download to temp file
        let tempDir = FileManager.default.temporaryDirectory.appendingPathComponent("yolo_download_\(id)")
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let downloadedFile = tempDir.appendingPathComponent("\(id).mlpackage.zip")

        let continuation = progressContinuations[id]

        // Download with progress
        let (asyncBytes, response) = try await URLSession.shared.bytes(from: url)
        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            throw YOLOModelError.downloadFailed(statusCode: (response as? HTTPURLResponse)?.statusCode ?? -1)
        }

        let totalBytes = response.expectedContentLength
        var receivedBytes: Int64 = 0
        var data = Data()
        data.reserveCapacity(Int(totalBytes))

        for try await byte in asyncBytes {
            data.append(byte)
            receivedBytes += 1
            if totalBytes > 0 {
                continuation?.yield(Double(receivedBytes) / Double(totalBytes))
            }
        }
        continuation?.yield(1.0)

        try data.write(to: downloadedFile)

        // Extract: try ZIP first, fall back to direct file
        // On iOS, ZIP extraction is limited — if server sends a compiled .mlmodelc,
        // we can use it directly. For .mlpackage, we need to compile.
        let extractedDir = tempDir.appendingPathComponent("extracted")
        try FileManager.default.createDirectory(at: extractedDir, withIntermediateDirectories: true)

        // Check if downloaded file is a ZIP (by magic bytes)
        let header = data.prefix(4)
        let isZip = header.count >= 4 && header[0] == 0x50 && header[1] == 0x4B
        if isZip {
            // Use built-in ZIP extraction via URL resource
            try self.extractZip(at: downloadedFile, to: extractedDir)
        } else {
            // Assume it's a raw mlmodel or mlpackage — copy directly
            let dest = extractedDir.appendingPathComponent(downloadedFile.lastPathComponent)
            try FileManager.default.copyItem(at: downloadedFile, to: dest)
        }

        // Find .mlpackage in extracted contents
        guard let mlpackageUrl = findMLPackage(in: extractedDir) else {
            throw YOLOModelError.invalidArchive
        }

        // Compile
        let compiled = try await MLModel.compileModel(at: mlpackageUrl)
        // Move to cache
        if FileManager.default.fileExists(atPath: compiledUrl.path) {
            try FileManager.default.removeItem(at: compiledUrl)
        }
        try FileManager.default.moveItem(at: compiled, to: compiledUrl)

        return try await loadCompiledModel(at: compiledUrl)
    }

    private func compileBundledModel(at source: URL, to destination: URL) async throws -> MLModel {
        let compiled = try await MLModel.compileModel(at: source)
        if FileManager.default.fileExists(atPath: destination.path) {
            try FileManager.default.removeItem(at: destination)
        }
        try FileManager.default.moveItem(at: compiled, to: destination)
        return try await loadCompiledModel(at: destination)
    }

    /// Search app bundle for a .mlpackage matching the model ID.
    private func findBundledModel(id: String) -> URL? {
        Bundle.main.urls(forResourcesWithExtension: "mlpackage", subdirectory: nil)?
            .first { $0.deletingPathExtension().lastPathComponent == id }
    }

    /// Find .mlpackage inside an extracted directory.
    private func findMLPackage(in directory: URL) -> URL? {
        guard let contents = try? FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: nil
        ) else { return nil }

        for item in contents {
            if item.pathExtension == "mlpackage" { return item }
            if item.hasDirectoryPath {
                if let nested = findMLPackage(in: item) { return nested }
            }
        }
        return nil
    }

    /// Extract a ZIP file using iOS-native APIs.
    /// Uses Compression framework via NSData / NSItemProvider.
    private nonisolated func extractZip(at source: URL, to destination: URL) throws {
        // Use FileManager's built-in — on iOS 16+, we can use
        // the system-level decompression. Fall back to manual extraction.
        // For simplicity, we use the Compression framework via a C interop approach.
        // In practice, the server should send pre-compiled .mlmodelc or use a
        // ZIP library. For now, attempt to use NSItemProvider.
        let data = try Data(contentsOf: source)
        // Try writing as-is and let the OS handle extraction
        // This is a placeholder — production will use a proper ZIP library
        // or the server will serve .mlmodelc directly
        try data.write(to: destination.appendingPathComponent(source.lastPathComponent))
    }
}

// MARK: - Errors

enum YOLOModelError: LocalizedError {
    case modelNotFound(id: String)
    case invalidURL(String)
    case downloadFailed(statusCode: Int)
    case invalidArchive
    case compilationFailed(Error)

    var errorDescription: String? {
        switch self {
        case .modelNotFound(let id):
            return "YOLO model '\(id)' not found in bundle or cache"
        case .invalidURL(let url):
            return "Invalid model URL: \(url)"
        case .downloadFailed(let code):
            return "Model download failed (HTTP \(code))"
        case .invalidArchive:
            return "Downloaded archive does not contain a valid .mlpackage"
        case .compilationFailed(let error):
            return "Model compilation failed: \(error.localizedDescription)"
        }
    }
}
