/*
 * YOLOModelManager.swift
 *
 * Actor that handles YOLO CoreML model download, caching, compilation, and loading.
 * Models are cached as compiled .mlmodelc in Library/Caches/YOLOModels/.
 * Bundled .mlpackage models are compiled on first use.
 * Server-served models are downloaded, extracted, and compiled.
 *
 * Memory-safe on 4GB devices:
 *   - FileHandle streaming ZIP extraction (never loads full ZIP into RAM)
 *   - Streaming inflate to file (never accumulates decompressed data in RAM)
 *   - LRU model cache (max 1 model in memory at once)
 *   - Early temp cleanup (ZIP deleted after extraction, before compilation)
 *
 * zlib accessed via Swiftzlib module map (Swiftzlib/module.modulemap).
 * Gives us real z_stream struct with correct MemoryLayout on all platforms.
 */

import CoreML
import Foundation
import Swiftzlib

actor YOLOModelManager {
    // MARK: - Cache

    private let cacheDir: URL = {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
        return caches.appendingPathComponent("YOLOModels", isDirectory: true)
    }()

    /// Maximum number of compiled MLModel instances kept in memory.
    /// On 4GB devices (2GB per-process limit), even one model can be 50-200MB.
    /// Keeping only 1 minimizes Jetsam risk — model is evicted when stage stops.
    private static let maxLoadedModels = 1

    // In-memory model cache (keyed by modelId) with LRU eviction
    private var loadedModels: [String: MLModel] = [:]
    private var loadedModelOrder: [String] = []  // oldest first

    // Download progress stream
    private var progressContinuations: [String: AsyncStream<Double>.Continuation] = [:]

    // MARK: - Public

    /// Known YOLO11 CoreML model download URLs.
    /// Standard FP16 models from Ultralytics — compatible with all devices running iOS 16+.
    /// Used as fallback when server sends empty/missing modelUrl.
    private static let knownModelUrls: [String: String] = [
        "yolo11n":     "https://github.com/ultralytics/yolo-ios-app/releases/download/v8.3.0/yolo11n.mlpackage.zip",
        "yolo11s":     "https://github.com/ultralytics/yolo-ios-app/releases/download/v8.3.0/yolo11s.mlpackage.zip",
        "yolo11m":     "https://github.com/ultralytics/yolo-ios-app/releases/download/v8.3.0/yolo11m.mlpackage.zip",
        "yolo11n-seg": "https://github.com/ultralytics/yolo-ios-app/releases/download/v8.3.0/yolo11n-seg.mlpackage.zip",
        "yolo11s-seg": "https://github.com/ultralytics/yolo-ios-app/releases/download/v8.3.0/yolo11s-seg.mlpackage.zip",
        "yolo11m-seg": "https://github.com/ultralytics/yolo-ios-app/releases/download/v8.3.0/yolo11m-seg.mlpackage.zip",
        "yolo11n-pose": "https://github.com/ultralytics/yolo-ios-app/releases/download/v8.3.0/yolo11n-pose.mlpackage.zip",
        "yolo11s-pose": "https://github.com/ultralytics/yolo-ios-app/releases/download/v8.3.0/yolo11s-pose.mlpackage.zip",
        "yolo11m-pose": "https://github.com/ultralytics/yolo-ios-app/releases/download/v8.3.0/yolo11m-pose.mlpackage.zip",
        "YOLO11PokerInt8LUT": "https://github.com/ebowwa/meta-wearables-dat-ios/releases/download/poker-model-v1.0/YOLO11PokerInt8LUT.mlpackage.zip",
    ]

    /// Load result including model and resource metrics.
    struct ModelLoadResult: Sendable {
        let model: MLModel
        let diskSizeBytes: Int64
        let downloadSizeBytes: Int64
    }

    /// Minimum free memory (bytes) required before loading a model.
    /// 4GB devices (iPhone 13 mini, SE 3) have a 2098MB per-process Jetsam limit.
    /// H264 streaming encoder alone uses ~600MB. Need enough headroom for model load spike.
    private static let minFreeMemoryForLoad: Int64 = 400 * 1024 * 1024  // 400MB

    /// Maximum phys_footprint (MB) before model load is refused.
    /// Tracks actual resident memory including compressed pages.
    private static let maxFootprintForLoad: Double = 1500.0

    /// Load a compiled MLModel, downloading or compiling as needed.
    /// - Parameters:
    ///   - id: Model identifier (e.g. "yolo11n", "yolo11s-seg")
    ///   - serverUrl: Optional server URL to download from. Nil/empty = use known or bundled model.
    /// - Returns: ModelLoadResult with compiled model and resource metrics.
    func loadModel(id: String, serverUrl: String? = nil) async throws -> ModelLoadResult {
        // Memory pressure check — refuse to load if device is near Jetsam limit
        let freeMemory = Int64(os_proc_available_memory())
        let footprintMB = Self.physFootprintMB()
        NSLog("[YOLOModel] Available memory: \(freeMemory / (1024*1024))MB, footprint: \(String(format: "%.0f", footprintMB))MB")
        if freeMemory > 0 && freeMemory < Self.minFreeMemoryForLoad {
            NSLog("[YOLOModel] MEMORY WARNING: only \(freeMemory / (1024*1024))MB free, refusing to load model '\(id)'")
            throw YOLOModelError.insufficientMemory(freeMB: freeMemory / (1024*1024))
        }
        if footprintMB > Self.maxFootprintForLoad {
            NSLog("[YOLOModel] MEMORY WARNING: footprint \(String(format: "%.0f", footprintMB))MB exceeds limit \(String(format: "%.0f", Self.maxFootprintForLoad))MB, refusing to load model '\(id)'")
            throw YOLOModelError.insufficientMemory(freeMB: freeMemory / (1024*1024))
        }

        // Return cached model if available
        if let cached = loadedModels[id] {
            touchModel(id)  // LRU: move to most-recent
            let compiledUrl = cacheDir.appendingPathComponent("\(id).mlmodelc")
            let diskSize = Self.directorySize(at: compiledUrl)
            return ModelLoadResult(model: cached, diskSizeBytes: diskSize, downloadSizeBytes: 0)
        }

        // Ensure cache directory exists
        try FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)

        let compiledUrl = cacheDir.appendingPathComponent("\(id).mlmodelc")

        // Check for existing compiled model — delete stale/corrupt cache on failure
        if FileManager.default.fileExists(atPath: compiledUrl.path) {
            if let model = try? await loadCompiledModel(at: compiledUrl) {
                insertModel(id, model)
                let diskSize = Self.directorySize(at: compiledUrl)
                return ModelLoadResult(model: model, diskSizeBytes: diskSize, downloadSizeBytes: 0)
            }
            NSLog("[YOLOModel] Cached model failed to load, deleting stale cache at \(compiledUrl.lastPathComponent)")
            try? FileManager.default.removeItem(at: compiledUrl)
        }

        // Resolve download URL: server-provided > known defaults
        let resolvedUrl = serverUrl?.isEmpty == false ? serverUrl : Self.knownModelUrls[id]

        // If URL available, download and compile
        if let resolvedUrl {
            let result = try await downloadAndCompile(id: id, serverUrl: resolvedUrl, compiledUrl: compiledUrl)
            insertModel(id, result.model)
            return result
        }

        // Try bundled .mlpackage -> compile to cache
        if let bundledUrl = findBundledModel(id: id) {
            let model = try await compileBundledModel(at: bundledUrl, to: compiledUrl)
            insertModel(id, model)
            let diskSize = Self.directorySize(at: compiledUrl)
            return ModelLoadResult(model: model, diskSizeBytes: diskSize, downloadSizeBytes: 0)
        }

        throw YOLOModelError.modelNotFound(id: id)
    }

    /// Unload a model from the in-memory cache. Called when YOLOStage stops.
    func unloadModel(id: String) {
        if loadedModels.removeValue(forKey: id) != nil {
            loadedModelOrder.removeAll { $0 == id }
            NSLog("[YOLOModel] Unloaded model '\(id)' from memory")
        }
    }

    // MARK: - Disk Size

    /// Recursively calculate directory size in bytes.
    nonisolated static func directorySize(at url: URL) -> Int64 {
        let manager = FileManager.default
        guard let enumerator = manager.enumerator(at: url, includingPropertiesForKeys: [.fileSizeKey], options: [], errorHandler: nil) else {
            return 0
        }
        var total: Int64 = 0
        for case let fileUrl as URL in enumerator {
            if let size = try? fileUrl.resourceValues(forKeys: [.fileSizeKey]).fileSize {
                total += Int64(size)
            }
        }
        return total
    }

    /// Extract class labels from a compiled MLModel's metadata.
    /// Ultralytics stores them as "{0: 'label', 1: 'label2', ...}" in creatorDefinedKey["names"].
    /// Returns nil if no labels found (caller falls back to COCO defaults).
    static func extractClassLabels(from model: MLModel) -> [String]? {
        guard let creatorDict = model.modelDescription.metadata[.creatorDefinedKey] as? [String: Any],
              let namesRaw = creatorDict["names"] as? String else {
            return nil
        }
        // Parse "{0: '10C', 1: '10D', ...}" → sorted by index → [String]
        var labels: [(Int, String)] = []
        let pattern = #"(\d+)\s*:\s*['"]([^'"]+)['"]"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
        let range = NSRange(namesRaw.startIndex..., in: namesRaw)
        for match in regex.matches(in: namesRaw, range: range) {
            guard let idxRange = Range(match.range(at: 1), in: namesRaw),
                  let labelRange = Range(match.range(at: 2), in: namesRaw),
                  let idx = Int(namesRaw[idxRange]) else { continue }
            labels.append((idx, String(namesRaw[labelRange])))
        }
        guard !labels.isEmpty else { return nil }
        labels.sort { $0.0 < $1.0 }
        return labels.map { $0.1 }
    }

    /// Get the compiled URL for a model if it exists in cache.
    func compiledUrl(for id: String) -> URL? {
        let url = cacheDir.appendingPathComponent("\(id).mlmodelc")
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    /// Clear all cached models (compiled files and in-memory).
    func clearCache() async {
        loadedModels.removeAll()
        loadedModelOrder.removeAll()
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

    // MARK: - LRU Cache Management

    private func insertModel(_ id: String, _ model: MLModel) {
        loadedModels[id] = model
        touchModel(id)
        evictIfNeeded()
    }

    private func touchModel(_ id: String) {
        loadedModelOrder.removeAll { $0 == id }
        loadedModelOrder.append(id)
    }

    private func evictIfNeeded() {
        while loadedModels.count > Self.maxLoadedModels, let oldest = loadedModelOrder.first {
            loadedModels.removeValue(forKey: oldest)
            loadedModelOrder.removeFirst()
            NSLog("[YOLOModel] LRU evicted model '\(oldest)' from memory")
        }
    }

    // MARK: - Private

    private func loadCompiledModel(at url: URL) async throws -> MLModel {
        let beforeMB = Self.physFootprintMB()
        NSLog("[YOLOModel] Loading compiled model, footprint before: \(String(format: "%.0f", beforeMB))MB")

        let config = MLModelConfiguration()
        // Use .cpuAndGPU instead of .all to avoid Neural Engine memory spike.
        // On 4GB devices (2GB per-process limit), ANE allocation during MLModel(contentsOf:)
        // can push phys_footprint past the Jetsam limit by 200-400MB.
        // CPU+GPU inference is ~10-20ms slower per frame but keeps the app alive.
        config.computeUnits = .cpuAndGPU
        let model = try MLModel(contentsOf: url, configuration: config)

        let afterMB = Self.physFootprintMB()
        NSLog("[YOLOModel] Model loaded, footprint after: \(String(format: "%.0f", afterMB))MB (delta: +\(String(format: "%.0f", afterMB - beforeMB))MB)")
        return model
    }

    private func downloadAndCompile(id: String, serverUrl: String, compiledUrl: URL) async throws -> ModelLoadResult {
        guard let url = URL(string: serverUrl) else {
            throw YOLOModelError.invalidURL(serverUrl)
        }

        // Download to temp file
        let tempDir = FileManager.default.temporaryDirectory.appendingPathComponent("yolo_download_\(id)")
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let downloadedFile = tempDir.appendingPathComponent("\(id).mlpackage.zip")

        let continuation = progressContinuations[id]

        // Download to temp file via URLSession (streams to disk natively, no RAM buffering)
        NSLog("[YOLOModel] Downloading \(id)...")
        let (tempLocalUrl, response) = try await URLSession.shared.download(from: url)
        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            throw YOLOModelError.downloadFailed(statusCode: (response as? HTTPURLResponse)?.statusCode ?? -1)
        }

        // Move downloaded temp file to our expected path
        if FileManager.default.fileExists(atPath: downloadedFile.path) {
            try FileManager.default.removeItem(at: downloadedFile)
        }
        try FileManager.default.moveItem(at: tempLocalUrl, to: downloadedFile)
        continuation?.yield(1.0)

        // Check magic bytes to detect ZIP (read only first 4 bytes, not entire file)
        let headerHandle = try FileHandle(forReadingFrom: downloadedFile)
        let headerData = (try headerHandle.read(upToCount: 4)) ?? Data()
        try? headerHandle.close()
        let isZip = headerData.count >= 4 && headerData[0] == 0x50 && headerData[1] == 0x4B
        let fileSize = try FileManager.default.attributesOfItem(atPath: downloadedFile.path)[.size] as? Int64 ?? 0
        let downloadSizeBytes = fileSize
        NSLog("[YOLOModel] Downloaded \(fileSize) bytes, isZip=\(isZip)")

        let extractedDir = tempDir.appendingPathComponent("extracted")
        try FileManager.default.createDirectory(at: extractedDir, withIntermediateDirectories: true)

        if isZip {
            NSLog("[YOLOModel] Extracting ZIP...")
            try self.extractZip(at: downloadedFile, to: extractedDir)
            NSLog("[YOLOModel] ZIP extraction done")

            // Early cleanup: delete ZIP now to free disk before compilation
            try? FileManager.default.removeItem(at: downloadedFile)
            NSLog("[YOLOModel] Deleted ZIP after extraction")
        } else {
            // Assume it's a raw mlmodel or mlpackage — copy directly
            let dest = extractedDir.appendingPathComponent(downloadedFile.lastPathComponent)
            try FileManager.default.copyItem(at: downloadedFile, to: dest)
        }

        // Find .mlpackage or .mlmodelc in extracted contents
        if let mlmodelcUrl = findMLModelC(in: extractedDir) {
            NSLog("[YOLOModel] Found .mlmodelc at \(mlmodelcUrl.lastPathComponent)")
            if FileManager.default.fileExists(atPath: compiledUrl.path) {
                try FileManager.default.removeItem(at: compiledUrl)
            }
            try FileManager.default.copyItem(at: mlmodelcUrl, to: compiledUrl)
            // Early cleanup: delete extracted files after copy to cache
            try? FileManager.default.removeItem(at: extractedDir)
            guard validateCompiledModel(at: compiledUrl) else {
                try? FileManager.default.removeItem(at: compiledUrl)
                throw YOLOModelError.invalidArchive
            }
            let model: MLModel
            do { model = try await loadCompiledModel(at: compiledUrl) } catch {
                try? FileManager.default.removeItem(at: compiledUrl)
                throw YOLOModelError.compilationFailed(error)
            }
            let diskSize = Self.directorySize(at: compiledUrl)
            return ModelLoadResult(model: model, diskSizeBytes: diskSize, downloadSizeBytes: downloadSizeBytes)
        }

        // Check if extracted dir itself IS an .mlmodelc (flat structure: Manifest.json + Data/com.apple.CoreML/)
        let isFlatModelC = isExtractedMLModelC(in: extractedDir)
        NSLog("[YOLOModel] isExtractedMLModelC=\(isFlatModelC)")
        if isFlatModelC {
            let tempModelC = tempDir.appendingPathComponent("\(id)_flat.mlmodelc")
            if FileManager.default.fileExists(atPath: tempModelC.path) {
                try FileManager.default.removeItem(at: tempModelC)
            }
            try FileManager.default.copyItem(at: extractedDir, to: tempModelC)
            // Early cleanup: extracted files copied, free the originals
            try? FileManager.default.removeItem(at: extractedDir)
            NSLog("[YOLOModel] Compiling flat mlmodelc at \(tempModelC.lastPathComponent)...")
            let compiled = try await MLModel.compileModel(at: tempModelC)
            // Delete temp model copy now — compiled output is what we need
            try? FileManager.default.removeItem(at: tempModelC)
            if FileManager.default.fileExists(atPath: compiledUrl.path) {
                try FileManager.default.removeItem(at: compiledUrl)
            }
            try FileManager.default.moveItem(at: compiled, to: compiledUrl)
            NSLog("[YOLOModel] Compiled to \(compiledUrl.lastPathComponent)")
            guard validateCompiledModel(at: compiledUrl) else {
                try? FileManager.default.removeItem(at: compiledUrl)
                throw YOLOModelError.invalidArchive
            }
            let model: MLModel
            do { model = try await loadCompiledModel(at: compiledUrl) } catch {
                try? FileManager.default.removeItem(at: compiledUrl)
                throw YOLOModelError.compilationFailed(error)
            }
            let diskSize = Self.directorySize(at: compiledUrl)
            return ModelLoadResult(model: model, diskSizeBytes: diskSize, downloadSizeBytes: downloadSizeBytes)
        }

        let mlpackageUrl = findMLPackage(in: extractedDir)
        NSLog("[YOLOModel] findMLPackage result: \(mlpackageUrl?.lastPathComponent ?? "nil")")
        guard let mlpackageUrl else {
            NSLog("[YOLOModel] ERROR: No .mlmodelc, flat .mlmodelc, or .mlpackage found in extracted archive")
            throw YOLOModelError.invalidArchive
        }

        // Compile
        let compiled = try await MLModel.compileModel(at: mlpackageUrl)
        // Early cleanup: delete extracted files after compilation
        try? FileManager.default.removeItem(at: extractedDir)
        // Move to cache
        if FileManager.default.fileExists(atPath: compiledUrl.path) {
            try FileManager.default.removeItem(at: compiledUrl)
        }
        try FileManager.default.moveItem(at: compiled, to: compiledUrl)

        guard validateCompiledModel(at: compiledUrl) else {
            try? FileManager.default.removeItem(at: compiledUrl)
            throw YOLOModelError.invalidArchive
        }
        let loadedModel: MLModel
        do { loadedModel = try await loadCompiledModel(at: compiledUrl) } catch {
            try? FileManager.default.removeItem(at: compiledUrl)
            throw YOLOModelError.compilationFailed(error)
        }
        let diskSize = Self.directorySize(at: compiledUrl)
        return ModelLoadResult(model: loadedModel, diskSizeBytes: diskSize, downloadSizeBytes: downloadSizeBytes)
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

    /// Returns true if a compiled .mlmodelc directory has the required Manifest.json and CoreML data.
    /// Catches incomplete/corrupt cache before handing it to MLModel(contentsOf:) which would
    /// throw a raw "The file 'Manifest.json' doesn't exist" CoreML error.
    private func validateCompiledModel(at url: URL) -> Bool {
        let manifest = url.appendingPathComponent("Manifest.json")
        let coreML = url.appendingPathComponent("Data/com.apple.CoreML")
        return FileManager.default.fileExists(atPath: manifest.path)
            && FileManager.default.fileExists(atPath: coreML.path)
    }

    /// Check if a directory itself contains a flat .mlmodelc structure
    /// (Manifest.json + Data/com.apple.CoreML/) without the .mlmodelc extension.
    private func isExtractedMLModelC(in directory: URL) -> Bool {
        let manifest = directory.appendingPathComponent("Manifest.json")
        let coreMLDir = directory.appendingPathComponent("Data/com.apple.CoreML")
        return FileManager.default.fileExists(atPath: manifest.path)
            && FileManager.default.fileExists(atPath: coreMLDir.path)
    }

    /// Find .mlmodelc (pre-compiled) inside an extracted directory.
    private func findMLModelC(in directory: URL) -> URL? {
        guard let contents = try? FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: nil
        ) else { return nil }

        for item in contents {
            if item.pathExtension == "mlmodelc" { return item }
            if item.hasDirectoryPath {
                if let nested = findMLModelC(in: item) { return nested }
            }
        }
        return nil
    }

    /// Extract a ZIP file using FileHandle for streaming — never loads full ZIP into RAM.
    /// Deflated entries are inflated directly to output files via streaming inflate.
    /// Ref: PKZIP APPNOTE — local file header signature = 0x04034b50
    private nonisolated func extractZip(at source: URL, to destination: URL) throws {
        let handle = try FileHandle(forReadingFrom: source)
        defer { try? handle.close() }

        let fileSize = try FileManager.default.attributesOfItem(atPath: source.path)[.size] as? Int64 ?? 0
        NSLog("[YOLOModel] Streaming ZIP extraction: \(fileSize) bytes on disk")

        let localFileHeaderSignature: UInt32 = 0x04034b50
        let dataDescriptorSignature: UInt32 = 0x08074b50

        var offset: UInt64 = 0

        while offset < UInt64(fileSize) - 4 {
            try handle.seek(toOffset: offset)
            let sigData = try handle.read(upToCount: 4) ?? Data()
            guard sigData.count == 4, sigData.readUInt32(at: 0) == localFileHeaderSignature else { break }

            // Read fixed 30-byte local file header (minus the 4-byte sig already read)
            try handle.seek(toOffset: offset + 4)
            let headerRest = try handle.read(upToCount: 26) ?? Data()
            guard headerRest.count == 26 else { break }

            // Parse fields relative to header start (offset + 0)
            let flags = headerRest.readUInt16(at: 2)
            let compressionMethod = headerRest.readUInt16(at: 4)
            let compressedSize = Int(headerRest.readUInt32(at: 14))
            let uncompressedSize = Int(headerRest.readUInt32(at: 18))
            let filenameLength = Int(headerRest.readUInt16(at: 22))
            let extraLength = Int(headerRest.readUInt16(at: 24))

            let dataStart = offset + 30 + UInt64(filenameLength) + UInt64(extraLength)

            // Read filename
            try handle.seek(toOffset: offset + 30)
            let filenameData = try handle.read(upToCount: filenameLength) ?? Data()
            let filename = String(data: filenameData, encoding: .utf8) ?? ""

            // Skip directories
            guard !filename.hasSuffix("/"), !filename.isEmpty else {
                offset = dataStart + UInt64(compressedSize)
                continue
            }

            // Sanitize path — preserve directory tree, prevent traversal
            let components = filename
                .components(separatedBy: "/")
                .filter { !$0.isEmpty && $0 != "." && $0 != ".." }
            guard !components.isEmpty else {
                offset = dataStart + UInt64(compressedSize)
                continue
            }
            let sanitized = components.joined(separator: "/")

            let destFile = destination.appendingPathComponent(sanitized)
            let destDir = destFile.deletingLastPathComponent()
            try FileManager.default.createDirectory(at: destDir, withIntermediateDirectories: true)

            if compressionMethod == 0 {
                // Stored (no compression) — stream directly to file in chunks
                try handle.seek(toOffset: dataStart)
                let outHandle = try FileHandle(forWritingTo: destFile)
                defer { try? outHandle.close() }

                var remaining = compressedSize
                let chunkSize = 256 * 1024
                while remaining > 0 {
                    let toRead = min(remaining, chunkSize)
                    let chunk = try handle.read(upToCount: toRead) ?? Data()
                    guard !chunk.isEmpty else { break }
                    try outHandle.write(contentsOf: chunk)
                    remaining -= chunk.count
                }
            } else if compressionMethod == 8 {
                // Deflate — streaming inflate: read compressed data in chunks, inflate to output file
                try handle.seek(toOffset: dataStart)
                let outHandle = try FileHandle(forWritingTo: destFile)
                defer { try? outHandle.close() }
                try Self.streamingInflate(from: handle, compressedSize: compressedSize, to: outHandle)
            }

            offset = dataStart + UInt64(compressedSize)

            // Skip data descriptor if present (bit 3 of general purpose flags)
            if flags & 0x08 != 0 {
                try handle.seek(toOffset: offset)
                if let ddBytes = try handle.read(upToCount: 4), ddBytes.count == 4 {
                    if ddBytes.readUInt32(at: 0) == dataDescriptorSignature {
                        offset += 16
                    } else {
                        offset += 12
                    }
                }
            }
        }

        NSLog("[YOLOModel] Streaming ZIP extraction complete")
    }

    /// Inflate raw deflated data directly to a FileHandle — writes 64KB chunks
    /// as they're produced, never accumulating the full decompressed buffer in RAM.
    /// ZIP method 8 stores raw deflate (no zlib header/trailer).
    /// Input data is provided as a single buffer (used for small entries).
    private static func inflateRawDeflateToStream(_ data: Data, to output: FileHandle) throws {
        NSLog("[YOLOModel] streaming inflate: \(data.count) compressed bytes -> file")

        var stream = z_stream()
        stream.zalloc = nil
        stream.zfree = nil
        stream.opaque = nil

        let streamSize = Int32(MemoryLayout<z_stream>.size)
        let ret = inflateInit2_(&stream, -MAX_WBITS, ZLIB_VERSION, streamSize)
        guard ret == Z_OK else {
            NSLog("[YOLOModel] inflate: inflateInit2_ FAILED ret=\(ret)")
            throw YOLOModelError.invalidArchive
        }
        defer { inflateEnd(&stream) }

        let chunkSize = 65536 // 64KB output chunks — fixed, small buffer

        try data.withUnsafeBytes { inputPtr in
            guard let base = inputPtr.baseAddress else {
                NSLog("[YOLOModel] inflate: empty input data")
                throw YOLOModelError.invalidArchive
            }
            stream.next_in = UnsafeMutablePointer<Bytef>(mutating: base.assumingMemoryBound(to: Bytef.self))
            stream.avail_in = UInt32(data.count)

            var done = false
            while !done {
                var chunk = [UInt8](repeating: 0, count: chunkSize)
                var produced = 0
                var inflateRet: Int32 = Z_OK
                try chunk.withUnsafeMutableBufferPointer { outPtr in
                    stream.next_out = outPtr.baseAddress
                    stream.avail_out = UInt32(chunkSize)
                    inflateRet = inflate(&stream, Z_FINISH)
                    produced = chunkSize - Int(stream.avail_out)
                }
                // Write produced bytes directly to file — no accumulation
                if produced > 0 {
                    try output.write(contentsOf: chunk[0..<produced])
                }

                switch inflateRet {
                case Z_STREAM_END:
                    done = true
                case Z_OK:
                    break // need more output space
                default:
                    NSLog("[YOLOModel] inflate: FAILED ret=\(inflateRet)")
                    throw YOLOModelError.invalidArchive
                }
            }
        }

        NSLog("[YOLOModel] streaming inflate: done total_out=\(stream.total_out)")
    }

    /// Streaming inflate: reads compressed data in 256KB chunks from the source FileHandle,
    /// inflates, and writes 64KB output chunks to the destination FileHandle.
    /// Never loads the full compressed entry into RAM — critical for large model weight files.
    private static func streamingInflate(from input: FileHandle, compressedSize: Int, to output: FileHandle) throws {
        NSLog("[YOLOModel] streaming inflate: \(compressedSize) compressed bytes (chunked input)")

        var stream = z_stream()
        stream.zalloc = nil
        stream.zfree = nil
        stream.opaque = nil

        let streamSize = Int32(MemoryLayout<z_stream>.size)
        let ret = inflateInit2_(&stream, -MAX_WBITS, ZLIB_VERSION, streamSize)
        guard ret == Z_OK else {
            NSLog("[YOLOModel] streaming inflate: inflateInit2_ FAILED ret=\(ret)")
            throw YOLOModelError.invalidArchive
        }
        defer { inflateEnd(&stream) }

        let inChunkSize = 256 * 1024   // 256KB input reads
        let outChunkSize = 65536       // 64KB output buffer

        var totalRead: Int = 0
        var inflateRet: Int32 = Z_OK

        while inflateRet != Z_STREAM_END {
            // Read next input chunk if zlib consumed all previous input
            guard stream.avail_in == 0 else {
                // Shouldn't happen — inner loop drains all input before we get here
                break
            }
            guard totalRead < compressedSize else { break }

            let toRead = min(compressedSize - totalRead, inChunkSize)
            let chunk = try input.read(upToCount: toRead) ?? Data()
            guard !chunk.isEmpty else { break }
            totalRead += chunk.count

            // Set up input and drain it entirely within this closure —
            // this guarantees stream.next_in is valid for all inflate() calls
            let chunkLen = chunk.count
            try chunk.withUnsafeBytes { rawBuf in
                guard let base = rawBuf.baseAddress else { return }
                stream.next_in = UnsafeMutablePointer<Bytef>(mutating: base.assumingMemoryBound(to: Bytef.self))
                stream.avail_in = UInt32(chunkLen)

                // Drain all input from this chunk
                while stream.avail_in > 0 && inflateRet != Z_STREAM_END {
                    var outBuf = [UInt8](repeating: 0, count: outChunkSize)
                    var produced = 0
                    try outBuf.withUnsafeMutableBufferPointer { outPtr in
                        stream.next_out = outPtr.baseAddress
                        stream.avail_out = UInt32(outChunkSize)
                        inflateRet = inflate(&stream, Z_NO_FLUSH)
                        produced = outChunkSize - Int(stream.avail_out)
                    }
                    if produced > 0 {
                        try output.write(contentsOf: outBuf[0..<produced])
                    }
                    if inflateRet != Z_OK && inflateRet != Z_STREAM_END {
                        NSLog("[YOLOModel] streaming inflate: FAILED ret=\(inflateRet)")
                        throw YOLOModelError.invalidArchive
                    }
                }
            }
            // chunk.withUnsafeBytes exits — stream.next_in is now dangling,
            // but stream.avail_in == 0, so inflate() won't read from it.
        }

        NSLog("[YOLOModel] streaming inflate: done total_out=\(stream.total_out)")
    }

    // MARK: - Memory Helpers

    /// Get current process physical footprint in MB.
    /// Uses task_info(TASK_VM_INFO) phys_footprint — includes resident, compressed,
    /// and IOAccelerated memory. More accurate than os_proc_available_memory() for
    /// detecting Jetsam risk since it reflects what the kernel tracks for per-process-limit.
    nonisolated static func physFootprintMB() -> Double {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        guard result == KERN_SUCCESS else { return 0 }
        return Double(info.phys_footprint) / 1_048_576.0
    }
}

// MARK: - Errors

enum YOLOModelError: LocalizedError {
    case modelNotFound(id: String)
    case invalidURL(String)
    case downloadFailed(statusCode: Int)
    case invalidArchive
    case compilationFailed(Error)
    case insufficientMemory(freeMB: Int64)

    var errorDescription: String? {
        switch self {
        case .modelNotFound(let id):
            return "YOLO model '\(id)' not found in bundle or cache"
        case .invalidURL(let url):
            return "Invalid model URL: \(url)"
        case .downloadFailed(let code):
            return "Model download failed (HTTP \(code))"
        case .invalidArchive:
            return "YOLO model download failed or is corrupt — please try again"
        case .compilationFailed(let error):
            return "Model compilation failed: \(error.localizedDescription)"
        case .insufficientMemory(let freeMB):
            return "Insufficient memory to load model (only \(freeMB)MB free)"
        }
    }
}

// MARK: - Data ZIP helpers

private extension Data {
    func readUInt16(at offset: Int) -> UInt16 {
        guard offset + 2 <= count else { return 0 }
        return UInt16(self[offset]) | UInt16(self[offset + 1]) << 8
    }

    func readUInt32(at offset: Int) -> UInt32 {
        guard offset + 4 <= count else { return 0 }
        return UInt32(self[offset])
            | UInt32(self[offset + 1]) << 8
            | UInt32(self[offset + 2]) << 16
            | UInt32(self[offset + 3]) << 24
    }
}
