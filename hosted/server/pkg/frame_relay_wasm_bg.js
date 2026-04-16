/**
 * Frame metadata passed alongside each frame buffer.
 */
export class FrameHeader {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(FrameHeader.prototype);
        obj.__wbg_ptr = ptr;
        FrameHeaderFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FrameHeaderFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_frameheader_free(ptr, 0);
    }
    /**
     * Frame height in pixels.
     * @returns {number}
     */
    get height() {
        const ret = wasm.__wbg_get_frameheader_height(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * JPEG quality (0-100).
     * @returns {number}
     */
    get quality() {
        const ret = wasm.__wbg_get_frameheader_quality(this.__wbg_ptr);
        return ret;
    }
    /**
     * Monotonically increasing sequence number.
     * @returns {bigint}
     */
    get sequence() {
        const ret = wasm.__wbg_get_frameheader_sequence(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * Unix timestamp in milliseconds.
     * @returns {bigint}
     */
    get timestamp_ms() {
        const ret = wasm.__wbg_get_frameheader_timestamp_ms(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * Frame width in pixels.
     * @returns {number}
     */
    get width() {
        const ret = wasm.__wbg_get_frameheader_width(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Frame height in pixels.
     * @param {number} arg0
     */
    set height(arg0) {
        wasm.__wbg_set_frameheader_height(this.__wbg_ptr, arg0);
    }
    /**
     * JPEG quality (0-100).
     * @param {number} arg0
     */
    set quality(arg0) {
        wasm.__wbg_set_frameheader_quality(this.__wbg_ptr, arg0);
    }
    /**
     * Monotonically increasing sequence number.
     * @param {bigint} arg0
     */
    set sequence(arg0) {
        wasm.__wbg_set_frameheader_sequence(this.__wbg_ptr, arg0);
    }
    /**
     * Unix timestamp in milliseconds.
     * @param {bigint} arg0
     */
    set timestamp_ms(arg0) {
        wasm.__wbg_set_frameheader_timestamp_ms(this.__wbg_ptr, arg0);
    }
    /**
     * Frame width in pixels.
     * @param {number} arg0
     */
    set width(arg0) {
        wasm.__wbg_set_frameheader_width(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) FrameHeader.prototype[Symbol.dispose] = FrameHeader.prototype.free;

/**
 * Core relay state: tracks frame routing statistics and throttling.
 */
export class FrameRelay {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FrameRelayFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_framerelay_free(ptr, 0);
    }
    /**
     * Get the effective relay FPS based on relayed frames.
     * @param {bigint} elapsed_ms
     * @returns {number}
     */
    effective_fps(elapsed_ms) {
        const ret = wasm.framerelay_effective_fps(this.__wbg_ptr, elapsed_ms);
        return ret;
    }
    /**
     * Create a new relay with a maximum FPS throttle.
     * @param {number} max_fps
     */
    constructor(max_fps) {
        const ret = wasm.framerelay_new(max_fps);
        this.__wbg_ptr = ret >>> 0;
        FrameRelayFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Reset all counters.
     */
    reset() {
        wasm.framerelay_reset(this.__wbg_ptr);
    }
    /**
     * Decide whether a frame should be relayed or dropped.
     * Returns true if the frame passes the throttle gate.
     * @param {bigint} now_ms
     * @returns {boolean}
     */
    should_relay(now_ms) {
        const ret = wasm.framerelay_should_relay(this.__wbg_ptr, now_ms);
        return ret !== 0;
    }
    /**
     * @returns {bigint}
     */
    get frames_dropped() {
        const ret = wasm.__wbg_get_framerelay_frames_dropped(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @returns {bigint}
     */
    get frames_received() {
        const ret = wasm.__wbg_get_framerelay_frames_received(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @returns {bigint}
     */
    get frames_relayed() {
        const ret = wasm.__wbg_get_framerelay_frames_relayed(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @returns {bigint}
     */
    get last_relayed_sequence() {
        const ret = wasm.__wbg_get_framerelay_last_relayed_sequence(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @param {bigint} arg0
     */
    set frames_dropped(arg0) {
        wasm.__wbg_set_framerelay_frames_dropped(this.__wbg_ptr, arg0);
    }
    /**
     * @param {bigint} arg0
     */
    set frames_received(arg0) {
        wasm.__wbg_set_framerelay_frames_received(this.__wbg_ptr, arg0);
    }
    /**
     * @param {bigint} arg0
     */
    set frames_relayed(arg0) {
        wasm.__wbg_set_framerelay_frames_relayed(this.__wbg_ptr, arg0);
    }
    /**
     * @param {bigint} arg0
     */
    set last_relayed_sequence(arg0) {
        wasm.__wbg_set_framerelay_last_relayed_sequence(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) FrameRelay.prototype[Symbol.dispose] = FrameRelay.prototype.free;

/**
 * Decode a frame header from a binary buffer prefix.
 * Returns JsValue (null on failure, FrameHeader on success).
 * @param {Uint8Array} buf
 * @returns {FrameHeader | undefined}
 */
export function decode_frame_prefix(buf) {
    const ptr0 = passArray8ToWasm0(buf, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.decode_frame_prefix(ptr0, len0);
    return ret === 0 ? undefined : FrameHeader.__wrap(ret);
}

/**
 * Encode a frame header into a binary prefix buffer.
 * Format: [4 bytes "FRLY"][8 bytes sequence][4 bytes width][4 bytes height]
 *         [1 byte quality][8 bytes timestamp_ms]
 * Total: 29 bytes prefix, followed by JPEG payload.
 * @param {FrameHeader} header
 * @returns {Uint8Array}
 */
export function encode_frame_prefix(header) {
    _assertClass(header, FrameHeader);
    const ret = wasm.encode_frame_prefix(header.__wbg_ptr);
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
}
export function __wbg___wbindgen_throw_bd5a70920abf0236(arg0, arg1) {
    throw new Error(getStringFromWasm0(arg0, arg1));
}
export function __wbindgen_init_externref_table() {
    const table = wasm.__wbindgen_externrefs;
    const offset = table.grow(4);
    table.set(0, undefined);
    table.set(offset + 0, undefined);
    table.set(offset + 1, null);
    table.set(offset + 2, true);
    table.set(offset + 3, false);
}
const FrameHeaderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_frameheader_free(ptr >>> 0, 1));
const FrameRelayFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_framerelay_free(ptr >>> 0, 1));

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let WASM_VECTOR_LEN = 0;


let wasm;
export function __wbg_set_wasm(val) {
    wasm = val;
}
