/*
 * YOLOModelManager.swift
 *
 * Actor that handles YOLO CoreML model download, caching, compilation, and loading.
 * Models are cached as compiled .mlmodelc in Library/Caches/YOLOModels/.
 * Bundled .mlpackage models are compiled on first use.
 * Server-served models are downloaded, extracted, and compiled.
 */

import CoreML
import Compression
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

        // Find .mlpackage or .mlmodelc in extracted contents
        if let mlmodelcUrl = findMLModelC(in: extractedDir) {
            // Server sent pre-compiled model — copy directly to cache
            if FileManager.default.fileExists(atPath: compiledUrl.path) {
                try FileManager.default.removeItem(at: compiledUrl)
            }
            try FileManager.default.copyItem(at: mlmodelcUrl, to: compiledUrl)
            return try await loadCompiledModel(at: compiledUrl)
        }

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

    /// Extract a ZIP file using iOS Compression framework.
    /// Parses ZIP local file headers and extracts stored or deflated entries.
    /// Ref: PKZIP APPNOTE — local file header signature = 0x04034b50
    private nonisolated func extractZip(at source: URL, to destination: URL) throws {
        let data = try Data(contentsOf: source)

        // ZIP structures
        let localFileHeaderSignature: UInt32 = 0x04034b50
        let dataDescriptorSignature: UInt32 = 0x08074b50

        var offset = 0

        while offset < data.count - 4 {
            // Read local file header signature
            let sig = data.readUInt32(at: offset)
            guard sig == localFileHeaderSignature else { break }

            // Parse local file header (30 bytes fixed + variable)
            // Offset 26: filename length (2), offset 28: extra field length (2)
            let compressionMethod = data.readUInt16(at: offset + 8)
            let compressedSize = Int(data.readUInt32(at: offset + 18))
            let uncompressedSize = Int(data.readUInt32(at: offset + 22))
            let filenameLength = Int(data.readUInt16(at: offset + 26))
            let extraLength = Int(data.readUInt16(at: offset + 28))

            let dataOffset = offset + 30 + filenameLength + extraLength
            let filenameData = data[offset + 30 ..< offset + 30 + filenameLength]
            let filename = String(data: filenameData, encoding: .utf8) ?? ""

            // Skip directories
            guard !filename.hasSuffix("/"), !filename.isEmpty else {
                offset = dataOffset + compressedSize
                continue
            }

            // Sanitize path — preserve directory tree, prevent traversal
            let components = filename
                .components(separatedBy: "/")
                .filter { !$0.isEmpty && $0 != "." && $0 != ".." }
            guard !components.isEmpty else {
                offset = dataOffset + compressedSize
                continue
            }
            let sanitized = components.joined(separator: "/")

            let destFile = destination.appendingPathComponent(sanitized)
            let destDir = destFile.deletingLastPathComponent()
            try FileManager.default.createDirectory(at: destDir, withIntermediateDirectories: true)

            if compressionMethod == 0 {
                // Stored (no compression)
                let fileData = data[dataOffset ..< dataOffset + compressedSize]
                try fileData.write(to: destFile)
            } else if compressionMethod == 8 {
                // Deflate — use Compression framework
                let compressed = data[dataOffset ..< dataOffset + compressedSize]
                let decompressed = try Self.inflate(compressed, uncompressedSize: uncompressedSize)
                try decompressed.write(to: destFile)
            } else {
                // Unsupported compression — skip
            }

            offset = dataOffset + compressedSize

            // Skip data descriptor if present (bit 3 of general purpose flags)
            let flags = data.readUInt16(at: offset - compressedSize - filenameLength - extraLength - 30 + 6)
            if flags & 0x08 != 0 {
                // Data descriptor follows compressed data
                if offset + 4 < data.count {
                    let ddSig = data.readUInt32(at: offset)
                    if ddSig == dataDescriptorSignature {
                        offset += 16 // sig(4) + crc32(4) + compressed(4) + uncompressed(4)
                    } else {
                        offset += 12 // no sig: crc32(4) + compressed(4) + uncompressed(4)
                    }
                }
            }
        }
    }

    /// Inflate deflated data using iOS Compression framework.
    private static func inflate(_ data: Data.SubSequence, uncompressedSize: Int) throws -> Data {
        let bufferSize = max(uncompressedSize, 4096)
        var output = Data(capacity: bufferSize)
        var offset = 0

        // Process in chunks through libcompression
        let chunkSize = 64 * 1024
        var inputIndex = data.startIndex

        while inputIndex < data.endIndex {
            let remaining = data.distance(from: inputIndex, to: data.endIndex)
            let inputChunkSize = min(remaining, chunkSize)
            let inputChunk = data[inputIndex ..< data.index(inputIndex, offsetBy: inputChunkSize)]

            var outputBuffer = [UInt8](repeating: 0, count: chunkSize)

            let decoded = inputChunk.withUnsafeBytes { inputPtr in
                outputBuffer.withUnsafeMutableBytes { outputPtr in
                    compression_decode_buffer(
                        outputPtr.baseAddress!.assumingMemoryBound(to: UInt8.self),
                        outputPtr.count,
                        inputPtr.baseAddress!.assumingMemoryBound(to: UInt8.self),
                        inputPtr.count,
                        nil,
                        COMPRESSION_ZLIB
                    )
                }
            }

            if decoded == 0 { break }
            output.append(contentsOf: outputBuffer.prefix(decoded))
            inputIndex = data.index(inputIndex, offsetBy: inputChunkSize)
        }

        return output
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
