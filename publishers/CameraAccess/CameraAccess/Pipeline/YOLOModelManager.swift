/*
 * YOLOModelManager.swift
 *
 * Actor that handles YOLO CoreML model download, caching, compilation, and loading.
 * Models are cached as compiled .mlmodelc in Library/Caches/YOLOModels/.
 * Bundled .mlpackage models are compiled on first use.
 * Server-served models are downloaded, extracted, and compiled.
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

    // In-memory model cache (keyed by modelId)
    private var loadedModels: [String: MLModel] = [:]

    // Download progress stream
    private var progressContinuations: [String: AsyncStream<Double>.Continuation] = [:]

    // MARK: - Public

    /// Known YOLO11 CoreML model download URLs (Ultralytics GitHub releases).
    /// Used as fallback when server sends empty/missing modelUrl.
    private static let knownModelUrls: [String: String] = [
        "yolo11n": "https://github.com/ultralytics/yolo-ios-app/releases/download/v8.3.0/yolo11n.mlpackage.zip",
        "yolo11s": "https://github.com/ultralytics/yolo-ios-app/releases/download/v8.3.0/yolo11s.mlpackage.zip",
        "yolo11m": "https://github.com/ultralytics/yolo-ios-app/releases/download/v8.3.0/yolo11m.mlpackage.zip",
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

    /// Load a compiled MLModel, downloading or compiling as needed.
    /// - Parameters:
    ///   - id: Model identifier (e.g. "yolo11n", "yolo11s-seg")
    ///   - serverUrl: Optional server URL to download from. Nil/empty = use known or bundled model.
    /// - Returns: ModelLoadResult with compiled model and resource metrics.
    func loadModel(id: String, serverUrl: String? = nil) async throws -> ModelLoadResult {
        // Return cached model if available
        if let cached = loadedModels[id] {
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
                loadedModels[id] = model
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
            loadedModels[id] = result.model
            return result
        }

        // Try bundled .mlpackage -> compile to cache
        if let bundledUrl = findBundledModel(id: id) {
            let model = try await compileBundledModel(at: bundledUrl, to: compiledUrl)
            loadedModels[id] = model
            let diskSize = Self.directorySize(at: compiledUrl)
            return ModelLoadResult(model: model, diskSizeBytes: diskSize, downloadSizeBytes: 0)
        }

        throw YOLOModelError.modelNotFound(id: id)
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
            // Use built-in ZIP extraction via URL resource
            NSLog("[YOLOModel] Extracting ZIP...")
            try self.extractZip(at: downloadedFile, to: extractedDir)
            NSLog("[YOLOModel] ZIP extraction done, listing extracted contents...")
            if let contents = try? FileManager.default.contentsOfDirectory(at: extractedDir, includingPropertiesForKeys: nil) {
                for item in contents {
                    NSLog("[YOLOModel]   extracted: \(item.lastPathComponent) isDir=\(item.hasDirectoryPath)")
                }
            }
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
            let model = try await loadCompiledModel(at: compiledUrl)
            let diskSize = Self.directorySize(at: compiledUrl)
            return ModelLoadResult(model: model, diskSizeBytes: diskSize, downloadSizeBytes: downloadSizeBytes)
        }

        // Check if extracted dir itself IS an .mlmodelc (flat structure: Manifest.json + Data/com.apple.CoreML/)
        // Ultralytics ZIPs ship this way — no wrapping directory with .mlmodelc extension
        let isFlatModelC = isExtractedMLModelC(in: extractedDir)
        NSLog("[YOLOModel] isExtractedMLModelC=\(isFlatModelC)")
        if isFlatModelC {
            // Ultralytics ZIPs ship as flat mlmodelc (Manifest.json + Data/) but
            // are NOT compiled — they need MLModel.compileModel() first.
            // Copy to a temp location with .mlmodelc extension so compileModel can find it.
            let tempModelC = tempDir.appendingPathComponent("\(id)_flat.mlmodelc")
            if FileManager.default.fileExists(atPath: tempModelC.path) {
                try FileManager.default.removeItem(at: tempModelC)
            }
            try FileManager.default.copyItem(at: extractedDir, to: tempModelC)
            NSLog("[YOLOModel] Compiling flat mlmodelc at \(tempModelC.lastPathComponent)...")
            let compiled = try await MLModel.compileModel(at: tempModelC)
            if FileManager.default.fileExists(atPath: compiledUrl.path) {
                try FileManager.default.removeItem(at: compiledUrl)
            }
            try FileManager.default.moveItem(at: compiled, to: compiledUrl)
            NSLog("[YOLOModel] Compiled to \(compiledUrl.lastPathComponent)")
            let model = try await loadCompiledModel(at: compiledUrl)
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
        // Move to cache
        if FileManager.default.fileExists(atPath: compiledUrl.path) {
            try FileManager.default.removeItem(at: compiledUrl)
        }
        try FileManager.default.moveItem(at: compiled, to: compiledUrl)

        let loadedModel = try await loadCompiledModel(at: compiledUrl)
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

    /// Check if a directory itself contains a flat .mlmodelc structure
    /// (Manifest.json + Data/com.apple.CoreML/) without the .mlmodelc extension.
    /// Ultralytics YOLO ZIPs ship in this format.
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
    /// Parses ZIP local file headers and extracts stored or deflated entries.
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
            // Bytes 0-3: sig (already validated), 4-5: version, 6-7: flags, 8-9: compression
            // 10-13: mod time/date, 14-17: crc32, 18-21: compressed size, 22-25: uncompressed size
            // 26-27: filename length, 28-29: extra length
            let flags = headerRest.readUInt16(at: 2)         // offset 6 from entry start
            let compressionMethod = headerRest.readUInt16(at: 4)  // offset 8
            let compressedSize = Int(headerRest.readUInt32(at: 14))  // offset 18
            let uncompressedSize = Int(headerRest.readUInt32(at: 18))  // offset 22
            let filenameLength = Int(headerRest.readUInt16(at: 22))  // offset 26
            let extraLength = Int(headerRest.readUInt16(at: 24))  // offset 28

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
                let chunkSize = 256 * 1024  // 256KB read/write chunks
                while remaining > 0 {
                    let toRead = min(remaining, chunkSize)
                    let chunk = try handle.read(upToCount: toRead) ?? Data()
                    guard !chunk.isEmpty else { break }
                    try outHandle.write(contentsOf: chunk)
                    remaining -= chunk.count
                }
            } else if compressionMethod == 8 {
                // Deflate — read compressed data, then inflate with streaming output to file
                try handle.seek(toOffset: dataStart)
                // Read compressed chunk into memory (one entry at a time, not the whole ZIP)
                let compressedData = try handle.read(upToCount: compressedSize) ?? Data()
                let decompressed = try Self.inflateRawDeflate(compressedData, uncompressedSize: uncompressedSize)
                try decompressed.write(to: destFile)
            }

            offset = dataStart + UInt64(compressedSize)

            // Skip data descriptor if present (bit 3 of general purpose flags)
            if flags & 0x08 != 0 {
                try handle.seek(toOffset: offset)
                if let ddBytes = try handle.read(upToCount: 4), ddBytes.count == 4 {
                    if ddBytes.readUInt32(at: 0) == dataDescriptorSignature {
                        offset += 16  // sig(4) + crc32(4) + compressed(4) + uncompressed(4)
                    } else {
                        offset += 12  // no sig: crc32(4) + compressed(4) + uncompressed(4)
                    }
                }
            }
        }

        NSLog("[YOLOModel] Streaming ZIP extraction complete")
    }
    /// Inflate raw deflated data from ZIP entries using chunked output.
    /// ZIP method 8 stores raw deflate (no zlib header/trailer).
    /// Uses zlib via Swiftzlib module with real z_stream struct.
    /// Uses a small 64KB output buffer to avoid allocating the full uncompressed size in RAM.
    private static func inflateRawDeflate(_ data: Data, uncompressedSize: Int) throws -> Data {
        NSLog("[YOLOModel] inflate: \(data.count) compressed bytes, uncompressedSize=\(uncompressedSize)")

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

        let chunkSize = 65536 // 64KB output chunks — small fixed buffer
        var result = Data()
        result.reserveCapacity(min(uncompressedSize, 4 * 1024 * 1024)) // hint, capped at 4MB

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
                result.append(contentsOf: chunk.prefix(produced))

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

        NSLog("[YOLOModel] inflate: done total_out=\(stream.total_out)")
        return result
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
