# WebAssembly in iOS Swift Apps -- Cross-Platform XR Strategy

> **Core motivation:** One `.wasm` binary that runs frame processing, scene analysis, and spatial logic across iOS, Android XR, Meta Ray-Ban, and other smart glasses platforms. Write once, ship everywhere the camera goes.

## Why Wasm for XR/Glasses

The wearable/AR landscape is fragmented across operating systems and runtimes:

```
Fragmented reality (today):
+------------------+     +------------------+     +------------------+
| iOS (Swift)      |     | Android XR (Kotlin)  | Meta Ray-Ban     |
| iPhone + iPad    |     | Samsung Moohan  |     | Ray-Ban Meta     |
| Apple Vision Pro |     | Google Glass?   |     | Orion (future)   |
|                  |     | Qualcomm AR      |     |                  |
+------------------+     +------------------+     +------------------+
  Swift / Obj-C           Kotlin / C++             C / Android NDK
  Metal / Vision          ARCore / Vulkan          Custom DSP
  AVFoundation            MediaPipe                Proprietary SDK
       |                       |                        |
       v                       v                        v
  Rewrite logic           Rewrite logic           Rewrite logic
  per platform             per platform             per platform

Unified reality (with Wasm):
+------------------+     +------------------+     +------------------+
| iOS Host App     |     | Android XR Host  |     | Glasses Host App |
+------------------+     +------------------+     +------------------+
        |                        |                        |
        +------------------------+------------------------+
                                 |
                    +------------------------+
                    |  .wasm compute module  |
                    |  (frame processing,    |
                    |   scene analysis,      |
                    |   spatial logic)       |
                    +------------------------+
                    One binary. All platforms.
```

| Benefit | Impact for MWDAT |
|---------|-----------------|
| **Single compute binary** | Frame analysis, object detection, spatial mapping -- one `.wasm` file |
| **Near-native speed** | 80-95% of native. Critical for real-time 30fps+ camera streams |
| **Offline processing** | All compute runs on-device. No server round-trip. Privacy-first |
| **Independent update cadence** | Update vision algorithms without full App Store release (via WKWebView path) |
| **Sandboxed** | Wasm crash doesn't take down the host app. Important for glasses stability |
| **Server reuse** | Same module runs server-side for batch processing or fallback |

## Supported XR Platforms

| Platform | OS | Wasm Runtime Options | Status |
|----------|-----|---------------------|--------|
| **iPhone/iPad** | iOS | WKWebView, JSC, WasmKit, WasmInterpreter | Production-ready |
| **Apple Vision Pro** | visionOS | WKWebView, JSC, WasmKit | Production-ready |
| **Samsung Moohan** | Android XR | WebView (Chromium), WasmEdge, WAMR | In market |
| **Google Android XR glasses** | Android XR | WebView, WasmEdge, WAMR | Announced |
| **Meta Ray-Ban** | Custom Android | Limited (NDK/proprietary) | Requires host app |
| **Meta Orion (future)** | Custom OS | TBD | Announced |
| **XREAL / Rokid / TCL** | Android | WebView, WasmEdge | In market |
| **Qualcomm AR reference** | Android | WAMR, WasmEdge | Reference design |

### Platform-Specific Notes

**iOS / visionOS:**
- No JIT. Use interpreter or AOT.
- Bundled modules only (no runtime download outside WKWebView).
- WasmKit (Swift-native) is the lightest runtime option.

**Android XR:**
- Full Wasm support via Chromium WebView.
- WasmEdge and WAMR provide native embedding without WebView overhead.
- JIT available. Best raw Wasm performance of any glasses platform.

**Meta Ray-Ban:**
- Currently a closed platform. No general Wasm runtime.
- Strategy: process frames on the paired phone (iOS/Android), not on the glasses themselves.
- Future: Meta may open up on-device compute via WASI.

**General Android glasses (XREAL, Rokid, etc.):**
- Standard Android underneath. Full Wasm support via WebView or native runtimes.
- Lower compute budgets than phones -- keep Wasm modules small and focused.

## Definitions

| Term | Definition |
|------|-----------|
| **WebAssembly (Wasm)** | A portable binary instruction format for a stack-based virtual machine. Not "web-only" -- it runs in browsers, embedded runtimes, and native apps. |
| **WASI** | WebAssembly System Interface. A standardized API for Wasm modules to interact with the outside world (files, network, etc.) in a capability-based security model. |
| **WAT** | WebAssembly Text Format. Human-readable text representation of the Wasm binary. Used for debugging and learning. |
| **Linear Memory** | A contiguous byte array that a Wasm module uses as its memory. The host can read/write into it. This is the only shared data surface between host and module. |
| **Exports** | Functions a Wasm module exposes to the host for calling. |
| **Imports** | Host functions that a Wasm module can call (e.g., to access platform APIs). |
| **JavaScriptCore (JSC)** | Apple's built-in JavaScript engine, included in iOS. Supports Wasm execution natively. |
| **WKWebView** | Apple's web view component backed by JSC. Can load and execute Wasm modules via JavaScript. |
| **WasmKit** | A Swift-native Wasm runtime included in Swift 6.2+ toolchains. Runs Wasm without a JS engine. |
| **SwiftWasm** | The toolchain for compiling Swift source code to Wasm targets. Officially supported as of Swift 6.1+. |
| **Embedded Swift** | A subset of Swift that produces dramatically smaller Wasm binaries by omitting runtime features like reflection and metadata. |
| **AOT Compilation** | Ahead-of-Time compilation. Compiles Wasm bytecode to native machine code before execution. Faster startup, no JIT needed. |
| **SIMD** | Single Instruction, Multiple Data. Hardware-level parallelism for vector operations. Supported in Wasm for compute-heavy tasks. |

---

## Architecture Overview

Two integration paths for running Wasm in an iOS Swift app:

```
Path A: WKWebView / JavaScriptCore Bridge     Path B: Native Wasm Runtime (WasmKit)
+---------------------------+                 +---------------------------+
|  Swift App (Host)         |                 |  Swift App (Host)         |
|                           |                 |                           |
|  +---------------------+  |                 |  +---------------------+  |
|  | WKWebView / JSC     |  |                 |  | WasmKit Runtime     |  |
|  |  +---------------+  |  |                 |  |  (Swift-native)     |  |
|  |  | JS Layer      |  |  |                 |  +---------------------+  |
|  |  |  +---------+  |  |  |                 |           |               |
|  |  |  | .wasm   |  |  |  |                 |  +---------------------+  |
|  |  |  | module  |  |  |  |                 |  | .wasm module        |  |
|  |  |  +---------+  |  |  |                 |  +---------------------+  |
|  |  +---------------+  |  |                 +---------------------------+
|  +---------------------+  |
+---------------------------+

Communication via:                    Communication via:
- evaluateJavaScript()                - Direct function calls
- message handlers                   - Linear memory read/write
- JavaScript bridge callbacks         - No JS layer overhead
```

**Path A (WKWebView/JSC)** -- Use when you already have a WebView, need JS interop, or want maximum compatibility.

**Path B (WasmKit/native runtime)** -- Use when you want minimal overhead, no JS layer, and direct Swift-to-Wasm calls.

---

## Path A: WKWebView + JavaScriptCore

### How It Works

1. Bundle your `.wasm` file as a resource in the Xcode project.
2. WKWebView loads a minimal HTML/JS page that fetches and instantiates the Wasm module.
3. Swift calls into JS via `evaluateJavaScript()`, which calls into Wasm exports.
4. Wasm results flow back through JS to Swift via WKScriptMessage handlers.

### Setup: Loading a Wasm Module in WKWebView

```swift
import WebKit

class WasmBridge: NSObject, WKScriptMessageHandler {
    private var webView: WKWebView!

    override init() {
        super.init()
        let config = WKWebViewConfiguration()
        let contentController = config.userContentController
        contentController.add(self, name: "wasmBridge")

        webView = WKWebView(frame: .zero, configuration: config)
    }

    func loadWasmModule() {
        // HTML that loads and instantiates the Wasm module
        let html = """
        <html><body><script>
        let wasmExports = null;

        async function initWasm() {
            const response = await fetch('module.wasm');
            const bytes = await response.arrayBuffer();
            const { instance } = await WebAssembly.instantiate(bytes);
            wasmExports = instance.exports;
            window.webkit.messageHandlers.wasmBridge.postMessage('ready');
        }

        function callWasmFunction(a, b) {
            if (!wasmExports) return null;
            return wasmExports.add(a, b);
        }

        function processImageData(pixelPtr, length) {
            if (!wasmExports) return null;
            wasmExports.processPixels(pixelPtr, length);
            // Read result from linear memory
            const result = new Uint8Array(wasmExports.memory.buffer, pixelPtr, length);
            return Array.from(result);
        }

        initWasm();
        </script></body></html>
        """

        webView.loadHTMLString(html, baseURL: Bundle.main.resourceURL)
    }

    // WKScriptMessageHandler -- receives messages from JS
    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        if message.name == "wasmBridge" {
            print("Wasm module status: \(message.body)")
        }
    }

    // Call a Wasm function from Swift
    func callAdd(a: Int, b: Int, completion: @escaping (Int) -> Void) {
        let js = "callWasmFunction(\(a), \(b))"
        webView.evaluateJavaScript(js) { result, error in
            if let value = result as? Int {
                completion(value)
            }
        }
    }
}
```

### Passing Binary Data Through JSC

For larger payloads (images, audio, protobuf), pass data via base64 or write directly to the Wasm module's linear memory:

```swift
func processImage(pixelData: Data, completion: @escaping (Data) -> Void) {
    // Base64 encode the image data for transfer to JS
    let base64 = pixelData.base64EncodedString()

    let js = """
    (function() {
        const binary = atob('\(base64)');
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        // Allocate in Wasm memory and copy
        const ptr = wasmExports.allocate(bytes.length);
        const wasmMemory = new Uint8Array(wasmExports.memory.buffer);
        wasmMemory.set(bytes, ptr);
        wasmExports.processPixels(ptr, bytes.length);
        // Read result
        const result = wasmMemory.slice(ptr, ptr + bytes.length);
        wasmExports.deallocate(ptr, bytes.length);
        return btoa(String.fromCharCode(...result));
    })()
    """

    webView.evaluateJavaScript(js) { result, error in
        if let b64 = result as? String,
           let decoded = Data(base64Encoded: b64) {
            completion(decoded)
        }
    }
}
```

### JSC Direct (No WebView)

For headless Wasm execution without a WebView, use JavaScriptCore directly:

```swift
import JavaScriptCore

class JSCWasmRunner {
    private let context = JSContext()!

    func loadAndRun(wasmURL: URL) {
        // JSC supports WebAssembly since iOS 11+
        // Load Wasm via JS glue code
        context.evaluateScript("""
        var wasmExports = null;

        async function loadWasm(url) {
            const response = await fetch(url);
            const bytes = await response.arrayBuffer();
            const result = await WebAssembly.instantiate(bytes);
            wasmExports = result.instance.exports;
        }
        """)
    }

    func call(function: String, args: [Any]) -> JSValue? {
        let fn = context.objectForKeyedSubscript(function)
        return fn?.call(withArguments: args)
    }
}
```

**Note:** JSC's async/await support is limited. For complex async Wasm loading, WKWebView is more reliable.

---

## Path B: Native Wasm Runtime (WasmKit / WasmInterpreter)

### Why a Native Runtime

| Factor | WKWebView/JSC | Native Runtime |
|--------|---------------|----------------|
| Startup overhead | High (WebView init) | Low |
| Memory footprint | Heavy (full browser engine) | Light (few MB) |
| JS bridge latency | ~1-5ms per call | ~0.01ms per call |
| Binary size impact | None (system framework) | Small (runtime library) |
| Debugging | Safari Web Inspector | Native debugging |
| Threading | Main thread only | Configurable |

### Using WasmInterpreter (Third-Party Swift Package)

[WasmInterpreter](https://github.com/mrcdll/swift-wasm-interpreter) provides a Swift-native interface:

```swift
// Package.swift dependency:
// .package(url: "https://github.com/mrcdll/swift-wasm-interpreter", from: "0.1.0")

import WasmInterpreter

class WasmRuntime {
    private let vm: WasmInterpreter

    init(wasmURL: URL) throws {
        vm = try WasmInterpreter(module: wasmURL)
    }

    // Call an exported function directly
    func callAdd(a: Int32, b: Int32) throws -> Int32 {
        return try vm.call("add", a, b) as Int32
    }

    // Write data into Wasm linear memory
    func writeData(_ data: Data, at offset: Int) throws {
        try vm.writeToHeap(data: data, byteOffset: offset)
    }

    // Read data from Wasm linear memory
    func readData(at offset: Int, length: Int) throws -> Data {
        return try vm.dataFromHeap(byteOffset: offset, length: length)
    }

    // Allocate memory inside the Wasm module
    func allocate(size: Int) throws -> Int {
        return Int(try vm.call("allocate", Int32(size)) as Int32)
    }

    // Deallocate memory inside the Wasm module
    func deallocate(at offset: Int) throws {
        try vm.call("deallocate", Int32(offset))
    }
}
```

### Full Data Exchange Pattern

The host and Wasm module communicate through shared linear memory. A common pattern:

1. **Host allocates** memory in the Wasm module.
2. **Host writes** input data to the allocated region.
3. **Host calls** the Wasm export function with the memory offset and size.
4. **Wasm reads** input from memory, processes it, writes result to memory.
5. **Host reads** the result from the Wasm memory region.

```
Swift Host                          Wasm Module (Linear Memory)
+-----------+                       +---------------------------+
|           |  1. allocate(size)    | [.................]       |
|           | ------------------->  |       ^                   |
|           |  <-- offset ----------|       |                   |
|           |                       |                           |
|           |  2. writeToHeap()     | [input_data........]      |
|           | ------------------->  |                           |
|           |                       |                           |
|           |  3. call("process",   |                           |
|           |      offset, size)    |  4. read input, process,  |
|           | ------------------->  |     write output          |
|           |                       | [output_data.......]      |
|           |  5. dataFromHeap()    |                           |
|           | <-------------------  |                           |
+-----------+                       +---------------------------+
```

### Protobuf for Structured Data

For complex data structures (not just raw byte arrays), use Protocol Buffers to serialize on the Swift host side, pass the bytes through linear memory, and deserialize inside Wasm (or vice versa):

```swift
// Wasm side (compiled from Swift via SwiftWasm, or Rust/C++)
@_cdecl("allocate")
func allocate(size: Int) -> UnsafeMutableRawPointer {
    UnsafeMutableRawPointer.allocate(
        byteCount: size,
        alignment: MemoryLayout<UInt8>.alignment
    )
}

@_cdecl("deallocate")
func deallocate(pointer: UnsafeMutableRawPointer) {
    pointer.deallocate()
}

@_cdecl("process_data")
func processData(
    inputPtr: UnsafeMutableRawPointer,
    inputSize: Int,
    outputSizePtr: UnsafeMutablePointer<Int>
) -> UnsafeRawPointer {
    // Deserialize protobuf from inputPtr
    let inputData = Data(bytes: inputPtr, count: inputSize)
    // ... process ...
    // Serialize result
    let outputData = /* serialized result */
    outputSizePtr.pointee = outputData.count
    return outputData.withUnsafeBytes { $0.baseAddress! }
}
```

```swift
// Host side
func processInWasm(_ payload: MyMessage) throws -> MyResponse {
    let serialized = try payload.serializedData()

    let offset = try runtime.allocate(size: serialized.count)
    try runtime.writeData(serialized, at: offset)

    let sizeOffset = try runtime.allocate(size: MemoryLayout<Int32>.size)

    let resultOffset = try runtime.call(
        "process_data",
        Int32(offset),
        Int32(serialized.count),
        Int32(sizeOffset)
    ) as Int32

    let resultSize = try runtime.readData(
        at: sizeOffset,
        length: MemoryLayout<Int32>.size
    ).withUnsafeBytes { $0.load(as: Int32.self) }

    let resultData = try runtime.readData(
        at: Int(resultOffset),
        length: Int(resultSize)
    )

    // Cleanup
    try runtime.deallocate(at: offset)
    try runtime.deallocate(at: sizeOffset)

    return try MyResponse(serializedData: resultData)
}
```

---

## Compiling to Wasm

### Option 1: Rust to Wasm (Most Common)

Best for: performance-critical compute, existing Rust libraries, maximum portability.

```bash
# Install target
rustup target add wasm32-unknown-unknown

# Build
cargo build --target wasm32-unknown-unknown --release

# Or with wasm-pack (generates JS bindings too)
wasm-pack build --target web
```

```rust
// src/lib.rs
#[no_mangle]
pub extern "C" fn add(a: i32, b: i32) -> i32 {
    a + b
}

#[no_mangle]
pub extern "C" fn process_pixels(ptr: *mut u8, len: usize) {
    let slice = unsafe { std::slice::from_raw_parts_mut(ptr, len) };
    for pixel in slice.iter_mut() {
        *pixel = (*pixel as f32 * 1.2).min(255.0) as u8;
    }
}

// Memory management exports for host
#[no_mangle]
pub extern "C" fn allocate(size: usize) -> *mut u8 {
    let layout = std::alloc::Layout::from_size_align(size, 1).unwrap();
    unsafe { std::alloc::alloc(layout) }
}

#[no_mangle]
pub extern "C" fn deallocate(ptr: *mut u8, size: usize) {
    let layout = std::alloc::Layout::from_size_align(size, 1).unwrap();
    unsafe { std::alloc::dealloc(ptr, layout) }
}
```

### Option 2: C/C++ to Wasm (via Emscripten)

Best for: existing C/C++ libraries (zlib, libpng, audio codecs, crypto).

```bash
# Install Emscripten
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk && ./emsdk install latest && ./emsdk activate latest

# Compile
emcc source.cpp -O3 -s WASM=1 -s EXPORTED_FUNCTIONS="['_add','_process']" -o module.wasm
```

```cpp
// source.cpp
extern "C" {
    int add(int a, int b) { return a + b; }

    void process(unsigned char* data, int length) {
        for (int i = 0; i < length; i++) {
            data[i] = data[i] * 2;
        }
    }
}
```

### Option 3: Swift to Wasm (SwiftWasm)

Best for: sharing Swift logic between iOS native and Wasm targets.

Since Swift 6.1+, SwiftWasm is built on the official toolchain:

```bash
# Install Swift SDK for Wasm (Swift 6.3)
swift sdk install https://download.swift.org/swift-6.3-release/wasm-sdk/swift-6.3-RELEASE/swift-6.3-RELEASE_wasm.artifactbundle.tar.gz \
  --checksum <checksum>

# Verify
swift sdk list

# Build
swift build --swift-sdk swift-6.3-RELEASE_wasm

# Run (uses WasmKit runtime)
swift run --swift-sdk swift-6.3-RELEASE_wasm

# Embedded Swift (much smaller binaries)
swift build --swift-sdk swift-6.3-RELEASE_wasm-embedded
```

```swift
// Sources/MyWasmModule/main.swift
@main
struct WasmModule {
    static func main() {
#if os(WASI)
        print("Running in WebAssembly!")
#else
        print("Running natively!")
#endif
    }
}
```

For library modules that export functions for the host to call:

```swift
// Sources/MyWasmModule/Exports.swift
@_cdecl("compute")
func compute(inputPtr: UnsafeMutableRawPointer, size: Int) -> Int {
    let buffer = UnsafeBufferPointer<UInt8>(
        start: inputPtr.assumingMemoryBound(to: UInt8.self),
        count: size
    )
    // Process buffer...
    return resultSize
}
```

Build with `--allow-undefined` so `@_cdecl` functions are exported:

```bash
swift build --triple wasm32-unknown-wasi -c release -Xlinker --allow-undefined
```

---

## iOS App Store Considerations

### Executable Code Restrictions

Apple's App Store guidelines restrict downloading and executing new code at runtime:

- **Bundled Wasm modules are allowed.** Include `.wasm` files in your app bundle.
- **Downloading new Wasm modules at runtime is restricted** on iOS. You cannot fetch and execute new `.wasm` files after app installation unless running inside a WKWebView context.
- **JIT compilation is disabled on iOS.** All Wasm execution uses interpretation or AOT. This is fine for most use cases.

### Workarounds for Dynamic Modules

If you need to update Wasm logic without an App Store release:

1. **WKWebView exception:** Web content loaded in a WKWebView can execute Wasm fetched from a server. This is permitted because WKWebView is considered a "web browser" context.
2. **Data-driven approach:** Instead of new Wasm modules, ship a generic Wasm interpreter and feed it different bytecode/data configurations that are downloaded at runtime.
3. **Full app update:** Bundle updated Wasm modules in a standard App Store release.

### Binary Size

| Approach | Typical Module Size |
|----------|-------------------|
| Rust (optimized, `--release`) | 10KB - 500KB |
| C/C++ (Emscripten, minimal) | 20KB - 1MB |
| Swift (Embedded Swift) | 50KB - 500KB |
| Swift (full runtime) | 500KB - 5MB |
| C/C++ (Emscripten, full) | 1MB - 10MB |

Use `wasm-opt` and `wasm-strip` to minimize size:

```bash
wasm-opt -Oz module.wasm -o module.opt.wasm
wasm-strip module.opt.wasm
```

---

## Performance Characteristics

### When Wasm Wins

| Use Case | Expected Speedup vs JS | vs Native |
|----------|----------------------|-----------|
| Image processing | 3-5x | 80-95% |
| Crypto/hash operations | 5-10x | 85-95% |
| Audio DSP | 3-8x | 80-90% |
| Parsing (JSON, protobuf) | 2-5x | 85-95% |
| Compression | 3-6x | 85-95% |
| Math/scientific compute | 4-10x | 80-95% |
| ML inference | 2-5x | 75-90% |

### When Wasm Doesn't Help

- UI rendering (keep native)
- Simple CRUD operations
- Network I/O (bound by latency, not compute)
- Small utility functions (bridge overhead exceeds gain)

### Optimization Tips

1. **Batch calls.** One call with 1000 items beats 1000 calls with 1 item. Bridge crossing has overhead.
2. **Keep data in Wasm memory.** Avoid copying data back and forth between host and Wasm for intermediate steps.
3. **Use SIMD.** Enable SIMD in your Wasm build for parallel vector operations (image processing, math).
4. **Pre-allocate memory.** Growing linear memory at runtime is expensive. Allocate what you need upfront.
5. **AOT compile.** If your runtime supports it, AOT compilation eliminates interpretation overhead entirely.
6. **Profile on real devices.** Simulator performance does not reflect device performance.

---

## Recommended Stack for com.mwdat-ios

Given this project's context (wearable camera SDK, cross-platform XR targets):

```
Strategy: Wasm as the portable compute layer between host apps and vision logic

┌─────────────────────────────────────────────────────────┐
│  Host Apps (platform-native UI + camera SDK integration) │
│                                                         │
│  iOS App ─────┐                                         │
│  Android XR ──┤── all call the same ──┐                 │
│  Glasses App ─┘   .wasm functions     │                 │
│                                      ▼                  │
│                     ┌────────────────────────────┐      │
│                     │  Vision Compute Module     │      │
│                     │  (.wasm binary)            │      │
│                     │                            │      │
│                     │  - Frame analysis          │      │
│                     │  - Object detection        │      │
│                     │  - Scene understanding     │      │
│                     │  - Spatial mapping logic   │      │
│                     │  - Privacy filter          │      │
│                     └────────────────────────────┘      │
│                               │                         │
│          Same binary also runs on server for             │
│          batch processing / fallback / training          │
└─────────────────────────────────────────────────────────┘

Compute Module Stack:
  Source Language: Rust (best Wasm support, smallest binaries, no GC)
  Compile Target: wasm32-unknown-unknown (bare) or wasm32-wasip1 (WASI)
  iOS Runtime: WasmInterpreter (Swift package) or WasmKit
  Android Runtime: WasmEdge or WAMR (native embedding)
  Data Exchange: FlatBuffers over linear memory (zero-copy, no serialization)
  Memory Pattern: Host allocates -> writes -> calls -> reads -> deallocates

iOS Integration Path:
  - Use WasmInterpreter for direct Swift-to-Wasm calls (no JS overhead)
  - Fallback to WKWebView for modules that need JS ecosystem libraries
  - Bundle all .wasm modules in the app bundle

Android XR Integration Path:
  - Use WasmEdge embedded runtime (no WebView needed)
  - Or use Chromium WebView if already present in the app

Cross-Platform Contract:
  - Define a shared "vision module interface" (allocate, process_frame, deallocate)
  - Each platform host implements the same bridge API in their native language
  - The .wasm binary is identical across all platforms
  - FlatBuffer schemas define the data contract between host and module

Benefits for MWDAT:
  - One vision processing binary for iOS, Android XR, and glasses platforms
  - Update vision algorithms independent of platform-specific app releases
  - Privacy-first: all frame analysis runs on-device in a sandbox
  - Test vision logic once, deploy across all XR hardware
  - Future-proof: new glasses platforms just need a thin Wasm host layer
```

---

## Deep Dive: Runtime Comparison for XR Targets

Different XR devices have wildly different compute budgets. The runtime you pick matters.

### Runtime Benchmarks (2026)

| Metric | WAMR (Intel) | WasmEdge | WasmKit (Swift) | Wazero (Go) |
|--------|-------------|----------|-----------------|-------------|
| Cold start | **~2ms** | ~15ms | ~10ms | ~20ms |
| Memory footprint | **~100KB** | ~20MB | ~5MB | ~15MB |
| Language | C | C++ | Swift | Go |
| AOT support | Yes | Yes | No | No |
| JIT support | Yes | No | No | No |
| SIMD | Yes | Yes | Limited | Yes |
| Android support | Yes (NDK) | Yes (NDK + Java SDK) | No | Yes |
| iOS support | Manual port | Manual port | Native | No |
| Embedded/RTOS | Yes (seL4, Zephyr) | Yes (seL4) | No | No |
| License | Apache-2.0 | Apache-2.0 | Apache-2.0 | Apache-2.0 |

### Which Runtime for Which Device

```
Device Category          Recommended Runtime       Why
─────────────────────    ──────────────────────    ───────────────────────
iPhone / iPad            WasmKit or WasmInterp     Swift-native, no JS overhead
Apple Vision Pro         WasmKit                   Same as iOS, visionOS compatible
Android phone (paired)   WasmEdge                  Best Android support, Java SDK
Samsung Moohan (XR)      WasmEdge                  Android XR = standard Android
Android XR glasses       WAMR                      ~100KB footprint, AOT, minimal
XREAL / Rokid (Android)  WAMR or WasmEdge          Depends on available RAM
Meta Ray-Ban             NONE (process on phone)   Closed platform, no runtime access
Server / cloud           WasmEdge or Wasmtime      Full features, no size constraints
Embedded RTOS (future)   WAMR                      Designed for microcontrollers
```

### WAMR for Glasses (The constrained-device play)

WAMR is the right choice for actual glasses hardware because:

- **100KB memory footprint** -- glasses have 512MB-2GB RAM total, can't afford a 20MB runtime
- **AOT compilation** -- pre-compile `.wasm` to native ARM code. No interpreter overhead. No JIT (which iOS bans anyway)
- **C implementation** -- trivially portable to any platform with a C compiler
- **Bytecode Alliance project** -- backed by Intel, Mozilla, Fastly. Not going away.

```c
// WAMR embedded in an Android glasses native app
// (simplified, based on WAMR C API)

#include "wasm_export.h"

static wasm_module_t module;
static wasm_module_inst_t module_inst;
static wasm_exec_env_t exec_env;

int init_wasm_runtime(const uint8_t *wasm_bytes, uint32_t wasm_size) {
    // Initialize runtime with custom memory limits
    RuntimeInitArgs init_args = {0};
    init_args.mem_alloc_type = Alloc_With_Allocator;
    init_args.allocator.malloc_func = malloc;
    init_args.allocator.free_func = free;
    init_args.allocator.realloc_func = realloc;

    if (!wasm_runtime_full_init(&init_args)) return -1;

    // Load module
    module = wasm_runtime_load(wasm_bytes, wasm_size, NULL, 0);
    if (!module) return -1;

    // Instantiate with 1MB stack, 8MB heap (glasses-friendly)
    module_inst = wasm_runtime_instantiate(module, 1*1024*1024, 8*1024*1024, NULL, 0);
    if (!module_inst) return -1;

    exec_env = wasm_runtime_create_exec_env(module_inst);
    return 0;
}

// Call process_frame on each camera frame
int process_camera_frame(const uint8_t *frame_data, uint32_t frame_size,
                         uint8_t **output, uint32_t *output_size) {
    wasm_function_inst_t func = wasm_runtime_lookup_function(module_inst, "process_frame");

    uint32_t args[3];
    args[0] = (uint32_t)(uintptr_t)frame_data;  // pointer into module memory
    args[1] = frame_size;
    args[2] = 0;  // out_len will be written here

    if (!wasm_runtime_call_wasm(exec_env, func, 3, args)) return -1;

    *output_size = args[2];
    *output = (uint8_t*)(uintptr_t)args[0];  // pointer to result in module memory
    return 0;
}
```

### WasmEdge for Android XR (The full-featured play)

For Android XR headsets with more compute (Samsung Moohan, etc.), WasmEdge gives you more features:

```kotlin
// WasmEdge embedded in an Android XR app
// Based on WasmEdge Android NDK integration

class VisionRuntime(context: Context) {
    private var store: Long = 0
    private var module: Long = 0
    private var instance: Long = 0

    init {
        System.loadLibrary("wasmedge")
        store = wasmedge.createStore()
    }

    fun loadModule(assetName: String) {
        val bytes = context.assets.open(assetName).readBytes()
        module = wasmedge.loadModule(store, bytes)
        instance = wasmedge.instantiateModule(store, module)
    }

    fun processFrame(frameBytes: ByteArray): ByteArray {
        // Call allocate in wasm module
        val inputPtr = wasmedge.callFunction(instance, "allocate", frameBytes.size.toLong())

        // Write frame data to wasm memory
        wasmedge.writeMemory(instance, inputPtr, frameBytes)

        // Allocate space for output length
        val outLenPtr = wasmedge.callFunction(instance, "allocate", 4)

        // Call process_frame
        val resultPtr = wasmedge.callFunction(
            instance, "process_frame",
            inputPtr, frameBytes.size.toLong(), outLenPtr
        )

        // Read output length and data
        val outLen = wasmedge.readMemoryInt(instance, outLenPtr)
        val result = wasmedge.readMemory(instance, resultPtr, outLen)

        // Cleanup
        wasmedge.callFunction(instance, "deallocate", inputPtr, frameBytes.size.toLong())
        wasmedge.callFunction(instance, "deallocate", outLenPtr, 4)
        wasmedge.callFunction(instance, "deallocate", resultPtr, outLen.toLong())

        return result
    }
}
```

---

## Deep Dive: Meta Ray-Ban Realities

The Meta Wearables Device Access Toolkit (DAT SDK) is what this project (`com.mwdat-ios`) already uses. Here is how Wasm fits in:

### Current Architecture (Without Wasm)

```
Meta Ray-Ban Glasses                    iPhone
+-----------------+    BLE/WiFi     +--------------------+
| Camera sensor   | ----------->   | MWDATCamera SDK    |
| Microphone      |                | (StreamSession)    |
|                 |                |                    |
| No user code    |                | VideoFrame ->      |
| runs here       |                |   UIImage          |
|                 |                |                    |
| Frame data is   |                | Host app processes |
| sent raw to     |                | frames in Swift    |
| paired phone    |                |                    |
+-----------------+                +--------------------+
```

### Target Architecture (With Wasm)

```
Meta Ray-Ban Glasses                    iPhone                          Android XR
+-----------------+    BLE/WiFi     +--------------------+          +--------------------+
| Camera sensor   | ----------->   | MWDATCamera SDK    |          | Android XR SDK     |
| Microphone      |                |                    |          |                    |
|                 |                | +----------------+ |          | +----------------+ |
| No Wasm runtime |                | | Wasm Runtime   | |          | | Wasm Runtime   | |
| (closed platform|                | |                | |          | |                | |
|  no 3rd-party   |                | | vision.wasm    | |          | | vision.wasm    | |
|  code execution)|                | | (same binary)  | |          | | (same binary)  | |
|                 |                | +----------------+ |          | +----------------+ |
| Frame data sent |                |       |            |          |       |            |
| to phone for    |                |  Processed on      |          |  Processed on      |
| processing      |                |  device, sandboxed |          |  device, sandboxed |
+-----------------+                +--------------------+          +--------------------+
                                          |                                |
                                          +------ Same .wasm binary ------+

Server (fallback / batch / training)
+--------------------+
| WasmEdge / Wasmtime|
| vision.wasm        |
| (same binary)      |
+--------------------+
```

**Key insight:** The glasses themselves cannot run Wasm. But the *paired phone* can. And the same `.wasm` binary that processes Ray-Ban frames on an iPhone also processes frames on Android XR glasses natively.

### Frame Pipeline With Wasm

```swift
// Modified StreamSession handler in com.mwdat-ios
// Adding Wasm processing to the existing MWDAT pipeline

func onVideoFrame(_ frame: VideoFrame) {
    // 1. Get pixel data from DAT SDK frame
    guard let pixelBuffer = frame.pixelBuffer else { return }

    // 2. Convert to FlatBuffer (zero-copy where possible)
    let frameData = flatBufferData(from: pixelBuffer)

    // 3. Process through Wasm vision module
    Task.detached {
        do {
            let result = try wasmRuntime.processFrame(frameData)

            // 4. Use result on main thread
            await MainActor.run {
                updateUI(with: result)
            }
        } catch {
            print("Wasm processing failed: \(error)")
            // Fall back to Swift-native processing
        }
    }
}
```

### Why Process on the Paired Phone (Not the Glasses)

| Factor | On-Glasses | On Paired Phone |
|--------|-----------|-----------------|
| Compute power | Very limited (DSP-class) | Phone-class A-series/Snapdragon |
| RAM | ~512MB shared | 6-16GB |
| Battery impact | High (glasses battery is tiny) | Low (phone has large battery) |
| Thermal budget | Minimal (against face) | Ample |
| Wasm runtime available | No | Yes |
| Latency (local) | ~0ms | ~5-20ms (BLE/WiFi transfer) |
| SDK access | None for 3rd party | Full DAT SDK |
| Privacy | On-device | On-device (no server round-trip) |

The ~5-20ms transfer latency from glasses to phone is acceptable for most vision tasks. Real-time AR overlay needs <16ms total, which is tight but feasible for simpler models on the phone's Wasm runtime.

---

## Deep Dive: FlatBuffers vs Protocol Buffers for Wasm Data Exchange

### Why FlatBuffers

FlatBuffers provide **zero-copy access** to serialized data. In a Wasm linear memory context, this means:

- **No deserialization step.** The Wasm module reads the FlatBuffer directly from linear memory. No parsing, no allocation, no intermediate objects.
- **No serialization step for output.** Build the FlatBuffer directly in linear memory. The host reads it in-place.
- **Smaller GC pressure.** FlatBuffers don't create heap objects. Critical in Wasm where memory is limited.

### Comparison

| Factor | FlatBuffers | Protocol Buffers |
|--------|------------|-----------------|
| Access pattern | Zero-copy (read in place) | Parse then access |
| Deserialize cost | ~0 | O(n) allocation + parsing |
| Serialize cost | Build directly in buffer | Serialize to new buffer |
| Schema evolution | Supported | Supported |
| Wasm suitability | Ideal (no GC, no alloc) | Good but requires allocation |
| Swift support | Official | Official |
| Kotlin support | Official | Official |
| Rust support | Official | Official via prost |

### FlatBuffer Schema for Camera Frames

```
// frame_schema.fbs

table BoundingBox {
    x: float;
    y: float;
    width: float;
    height: float;
    label: string;
    confidence: float;
}

table DetectedObject {
    bbox: BoundingBox;
    category: string;
    attributes: [string];
}

table FrameMetadata {
    timestamp: uint64;
    frame_number: uint32;
    width: uint32;
    height: uint32;
    format: string;  // "RGBA", "YUV", "BGRA"
}

table FrameData {
    metadata: FrameMetadata;
    pixel_data: [ubyte];  // Raw pixel bytes
}

table FrameResult {
    metadata: FrameMetadata;
    objects: [DetectedObject];
    scene_description: string;
    processing_time_ms: float;
    error: string;
}

root_type FrameData;
root_type FrameResult;
```

Generate code for all platforms:

```bash
# Install flatc
# brew install flatbuffers  (macOS)

# Generate for all target languages
flatc --swift -o Generated/Swift frame_schema.fbs
flatc --kotlin -o Generated/Kotlin frame_schema.fbs
flatc --rust -o Generated/Rust frame_schema.fbs
flatc --cpp -o Generated/Cpp frame_schema.fbs
```

---

## Deep Dive: wasmVision (Reference Project)

[wasmVision](https://github.com/wasmvision/wasmvision) is an existing open-source project (240 GitHub stars) that does exactly what we are describing: a computer vision processing engine using WebAssembly.

### Architecture

```
wasmVision Architecture:
+----------------------------------------------------------+
|  wasmVision Engine (Go binary)                            |
|                                                          |
|  +------------+    +------------+    +----------------+  |
|  | Capture    |    | Wazero     |    | OpenCV + CUDA  |  |
|  | (camera,   |--->| Wasm       |--->| (hardware      |  |
|  |  video,    |    | Runtime    |    |  acceleration) |  |
|  |  stream)   |    |            |    |                |  |
|  +------------+    +-----+------+    +----------------+  |
|                          |                               |
|              +-----------+-----------+                   |
|              |           |           |                   |
|         +----+---+  +----+---+  +----+---+               |
|         |proc1   |  |proc2   |  |proc3   |              |
|         |.wasm   |  |.wasm   |  |.wasm   |              |
|         |(Go/Rust|  |(Go/Rust|  |(Go/Rust|              |
|         | /C)    |  | /C)    |  | /C)    |              |
|         +--------+  +--------+  +--------+              |
|              |           |           |                    |
|              v           v           v                    |
|         logging     datastore     http                    |
+----------------------------------------------------------+
```

### What We Can Learn from wasmVision

1. **Processor model.** Each vision operation is a separate `.wasm` module. They chain together in a pipeline. This is the right granularity -- one module per operation (face detection, blur, style transfer, etc.).

2. **wasmCV interface.** They defined a standard interface (`wasmcv`) for passing image data between host and Wasm. We should define our own interface tailored to our frame pipeline.

3. **Language flexibility.** Processors can be written in Go, Rust, or C. All compile to the same `.wasm` target.

4. **Hardware acceleration.** The host engine handles OpenCV/CUDA. Wasm modules request operations through the interface. The module doesn't need to know about the GPU.

5. **Limitations for our use case:**
   - wasmVision is a standalone binary, not a library you embed in an iOS app
   - Uses Wazero (Go-based runtime), not available on iOS natively
   - Designed for server/desktop, not mobile constraints
   - But the *processor model* and *interface design* are directly applicable

### Our Approach (Inspired by wasmVision)

```
Our Processor Pipeline (inside the iOS/Android app):

Host App
  |
  +-- WasmRuntime (WasmKit on iOS, WasmEdge on Android)
       |
       +-- FramePipeline
            |
            +-- Processor: preprocess.wasm (resize, normalize, color convert)
            |     input: raw pixels from DAT SDK
            |     output: normalized pixel buffer
            |
            +-- Processor: detect.wasm (object detection model inference)
            |     input: normalized pixels
            |     output: bounding boxes + labels
            |
            +-- Processor: classify.wasm (scene classification)
            |     input: normalized pixels
            |     output: scene labels + confidence
            |
            +-- Processor: privacy.wasm (face blur, license plate redact)
                  input: raw pixels + detected faces
                  output: filtered pixels

Each processor is:
  - A separate .wasm module (10-200KB each)
  - Written in Rust (or C/C++)
  - Uses the same FlatBuffer interface
  - Independently testable and replaceable
  - Same binary on iOS, Android XR, and server
```

---

## Deep Dive: Android XR Platform Specifics

### Samsung Moohan / Google Android XR

Android XR is standard Android with XR-specific APIs. This means:

- **Standard Android Wasm support** -- Chromium WebView, V8 engine, all work
- **WasmEdge can be embedded via NDK** -- compile WasmEdge as a native library in your APK
- **WAMR can be embedded via NDK** -- even lighter, better for glasses form factor
- **No special Wasm restrictions** beyond standard Android (can download modules at runtime)

### Android XR Integration Options

```
Option A: WebView (simplest)
+-------------------------------------------+
| Android XR Activity                       |
|  +-------------------------------------+ |
|  | WebView                             | |
|  |  +-------------------------------+  | |
|  |  | JS + Wasm module              |  | |
|  |  | fetch + WebAssembly.instantiate|  | |
|  |  +-------------------------------+  | |
|  +-------------------------------------+ |
+-------------------------------------------+
Pros: No native code, works immediately
Cons: JS bridge overhead, WebView memory cost

Option B: WasmEdge embedded (recommended)
+-------------------------------------------+
| Android XR Activity (Kotlin/Java)         |
|  +-------------------------------------+ |
|  | WasmEdge NDK (.so)                  | |
|  |  +-------------------------------+  | |
|  |  | .wasm module (direct calls)   |  | |
|  |  +-------------------------------+  | |
|  +-------------------------------------+ |
+-------------------------------------------+
Pros: No JS overhead, direct native calls, AOT
Cons: NDK build complexity, larger APK

Option C: WAMR embedded (glasses-optimized)
+-------------------------------------------+
| Android XR Native Activity (C/C++)        |
|  +-------------------------------------+ |
|  | WAMR library (~100KB)               | |
|  |  +-------------------------------+  | |
|  |  | AOT-compiled .wasm            |  | |
|  |  +-------------------------------+  | |
|  +-------------------------------------+ |
+-------------------------------------------+
Pros: Minimal footprint, AOT speed, perfect for glasses
Cons: C API only, more integration work
```

### Build Matrix

```
Target Device          OS            Runtime       Language    Build Target
───────────────────    ──────────    ──────────    ────────    ────────────
iPhone 15/16           iOS 18+       WasmKit       Swift       N/A (host)
iPad Pro               iPadOS 18+    WasmKit       Swift       N/A (host)
Vision Pro             visionOS 2+   WasmKit       Swift       N/A (host)
Samsung Moohan         Android XR    WasmEdge      Kotlin      N/A (host)
Google XR glasses      Android XR    WAMR          Kotlin/C    N/A (host)
XREAL Air 2            Android       WAMR          Kotlin/C    N/A (host)
Rokid AR Lite          Android       WAMR          Kotlin/C    N/A (host)
Meta Ray-Ban           N/A           Phone-side    Swift       N/A (host)
── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──
Vision Module          N/A           N/A           Rust        wasm32-unknown-unknown
Pre-processor          N/A           N/A           Rust        wasm32-unknown-unknown
Detector               N/A           N/A           Rust        wasm32-unknown-unknown
Privacy Filter         N/A           N/A           Rust        wasm32-unknown-unknown
```

---

## Quick Reference

### Cross-Platform Module Contract

The same Rust source compiles to one `.wasm` binary called from every platform:

```rust
// vision_core/src/lib.rs -- the shared compute module
//
// This binary runs identically on iOS, Android XR, glasses, and server.

#[no_mangle]
pub extern "C" fn allocate(size: usize) -> *mut u8 {
    let layout = std::alloc::Layout::from_size_align(size, 8).unwrap();
    unsafe { std::alloc::alloc(layout) }
}

#[no_mangle]
pub extern "C" fn deallocate(ptr: *mut u8, size: usize) {
    let layout = std::alloc::Layout::from_size_align(size, 8).unwrap();
    unsafe { std::alloc::dealloc(ptr, layout) }
}

/// Process a single camera frame.
/// Input: FlatBuffer-encoded FrameData at `ptr` with `len` bytes.
/// Output: FlatBuffer-encoded FrameResult written to a new allocation.
/// `out_len` is set to the result byte count.
#[no_mangle]
pub extern "C" fn process_frame(
    ptr: *const u8,
    len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    let input = unsafe { std::slice::from_raw_parts(ptr, len) };

    // Deserialize FlatBuffer input
    let frame = flatbuffers::root::<FrameData>(input).unwrap();

    // --- Platform-independent vision logic here ---
    let result = analyze_frame(frame);

    // Serialize result to FlatBuffer
    let mut builder = flatbuffers::FlatBufferBuilder::new_with_capacity(1024);
    let offset = FrameResult::create(&mut builder, &result);
    builder.finish(offset, None);
    let output = builder.finished_data();

    unsafe { *out_len = output.len() };

    // Allocate and copy result for host to read
    let out_ptr = allocate(output.len());
    unsafe { std::ptr::copy_nonoverlapping(output.as_ptr(), out_ptr, output.len()) };
    out_ptr
}
```

**iOS host (Swift):**

```swift
// Same module, same binary, different host language
func analyzeFrame(_ frameData: FrameData) throws -> FrameResult {
    let serialized = try serializeFrame(frameData)

    let inputOffset = try wasm.allocate(size: serialized.count)
    try wasm.writeData(serialized, at: inputOffset)

    let outLenOffset = try wasm.allocate(size: MemoryLayout<Int>.size)

    let resultOffset = try wasm.call(
        "process_frame",
        Int32(inputOffset),
        Int32(serialized.count),
        Int32(outLenOffset)
    ) as Int32

    let resultLen = try wasm.readInt(at: outLenOffset)
    let resultData = try wasm.readData(at: Int(resultOffset), length: resultLen)

    try wasm.deallocate(at: inputOffset)
    try wasm.deallocate(at: outLenOffset)
    try wasm.deallocate(at: Int(resultOffset))

    return try deserializeFrameResult(resultData)
}
```

**Android XR host (Kotlin):**

```kotlin
// Same module, same binary, different host language
suspend fun analyzeFrame(frameData: FrameData): FrameResult {
    val serialized = frameData.toByteArray()
    val inputOffset = runtime.call("allocate", serialized.size) as Int

    runtime.writeMemory(inputOffset, serialized)

    val outLenOffset = runtime.call("allocate", 4) as Int

    val resultOffset = runtime.call(
        "process_frame",
        inputOffset,
        serialized.size,
        outLenOffset
    ) as Int

    val resultLen = runtime.readInt(outLenOffset)
    val resultBytes = runtime.readMemory(resultOffset, resultLen)

    runtime.call("deallocate", inputOffset)
    runtime.call("deallocate", outLenOffset)
    runtime.call("deallocate", resultOffset)

    return FrameResult.parseFrom(resultBytes)
}
```

The `.wasm` binary is byte-identical in both cases. Only the host-side glue changes.

### File Structure in Xcode Project

```
MWDATApp/
├── Wasm/
│   ├── Modules/
│   │   ├── image-processor.wasm      # Bundled Wasm module
│   │   └── video-codec.wasm
│   ├── Runtime/
│   │   ├── WasmRuntime.swift          # Runtime wrapper
│   │   ├── WasmBridge.swift           # Host-module communication
│   │   └── MemoryManager.swift        # Linear memory helpers
│   └── Generated/
│       └── Proto/                     # Generated protobuf Swift types
├── Sources/
│   └── (wasm source, if using SwiftWasm)
└── Makefile                            # Build wasm modules
```

### Common Build Commands

```makefile
# Makefile for building Wasm modules

RUST_TARGET = wasm32-unknown-unknown
OPT_LEVEL = -Oz

build-rust:
	cargo build --target $(RUST_TARGET) --release
	wasm-opt $(OPT_LEVEL) target/wasm32-unknown-unknown/release/module.wasm \
	  -o MWDATApp/Wasm/Modules/module.wasm
	wasm-strip MWDATApp/Wasm/Modules/module.wasm

build-swift:
	swift build --swift-sdk swift-6.3-RELEASE_wasm-embedded -c release
	cp .build/release/Module.wasm MWDATApp/Wasm/Modules/module.wasm

build-cpp:
	emcc src/module.cpp $(OPT_LEVEL) -s WASM=1 \
	  -s EXPORTED_FUNCTIONS="['_allocate','_deallocate','_process']" \
	  -o MWDATApp/Wasm/Modules/module.wasm
```

### Resources

**Runtimes:**
- [Swift.org -- Getting Started with Swift SDKs for WebAssembly](https://www.swift.org/documentation/articles/wasm-getting-started.html)
- [WasmKit (Swift-native runtime)](https://github.com/swiftwasm/WasmKit)
- [WasmEdge Runtime](https://wasmedge.org/) -- [Android integration guide](https://wasmedge.org/docs/contribute/source/os/android/build)
- [WAMR (WebAssembly Micro Runtime)](https://github.com/bytecodealliance/wasm-micro-runtime) -- [Documentation](https://wamr.gitbook.io/)
- [wasmVision](https://github.com/wasmvision/wasmvision) -- CV processing engine using Wasm (Go + Wazero + OpenCV)
- [SwiftWasm Book](https://book.swiftwasm.org/)

**Data Serialization:**
- [FlatBuffers](https://flatbuffers.dev/) -- Zero-copy serialization for Wasm data exchange
- [Google FlatBuffers GitHub](https://github.com/google/flatbuffers) (26K stars)

**Compilation:**
- [wasm-pack (Rust to Wasm)](https://github.com/nickswitzerland/wasm-pack)
- [Emscripten (C/C++ to Wasm)](https://emscripten.org/)

**XR Platform SDKs:**
- [Meta Wearables Device Access Toolkit](https://wearables.developer.meta.com/docs/getting-started-toolkit/) -- Ray-Ban camera SDK
- [Android XR Developer Guide](https://www.digitalapplied.com/blog/android-xr-google-ai-glasses-developer-guide)
- [WasmEdge on Smart Devices](https://wasmedge.org/docs/start/usage/wasm-smart-devices)

**Research:**
- [WebAssembly enables low latency interoperable AR/VR software](https://arxiv.org/pdf/2110.07128v2) -- Academic paper on Wasm for AR
- [WebAssembly on Resource-Constrained IoT Devices](https://www.arxiv.org/pdf/2512.00035) -- Performance benchmarks
- [Computer Vision at the Edge with WebAssembly (Wasm I/O 2024 talk)](https://www.youtube.com/watch?v=0oq7kSf7zfI)
- [wasmVision: Computer Vision using WebAssembly (Wasm I/O 2025 talk)](https://www.youtube.com/watch?v=1aC0A6z4wX0)
- [Kevin Zhow -- Write WebAssembly in Swift and use it in Swift App](https://blog.kevinzhow.com/posts/swift-webassembly/en)
- [WebAssembly in Mobile Apps: Faster Execution and Portability](https://booleaninc.com/blog/webassembly-in-mobile-apps/)
