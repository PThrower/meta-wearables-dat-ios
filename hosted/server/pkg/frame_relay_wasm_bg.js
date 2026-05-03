/**
 * Audio frame metadata parsed from a FRAU binary header.
 */
export class AudioHeader {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(AudioHeader.prototype);
        obj.__wbg_ptr = ptr;
        AudioHeaderFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        AudioHeaderFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_audioheader_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get bits_per_sample() {
        const ret = wasm.__wbg_get_audioheader_bits_per_sample(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get channels() {
        const ret = wasm.__wbg_get_audioheader_channels(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get codec_type() {
        const ret = wasm.__wbg_get_audioheader_codec_type(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get sample_rate() {
        const ret = wasm.__wbg_get_audioheader_sample_rate(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {bigint}
     */
    get sequence() {
        const ret = wasm.__wbg_get_audioheader_sequence(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @returns {bigint}
     */
    get timestamp_ms() {
        const ret = wasm.__wbg_get_audioheader_timestamp_ms(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @param {number} arg0
     */
    set bits_per_sample(arg0) {
        wasm.__wbg_set_audioheader_bits_per_sample(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set channels(arg0) {
        wasm.__wbg_set_audioheader_channels(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set codec_type(arg0) {
        wasm.__wbg_set_audioheader_codec_type(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set sample_rate(arg0) {
        wasm.__wbg_set_audioheader_sample_rate(this.__wbg_ptr, arg0);
    }
    /**
     * @param {bigint} arg0
     */
    set sequence(arg0) {
        wasm.__wbg_set_audioheader_sequence(this.__wbg_ptr, arg0);
    }
    /**
     * @param {bigint} arg0
     */
    set timestamp_ms(arg0) {
        wasm.__wbg_set_audioheader_timestamp_ms(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) AudioHeader.prototype[Symbol.dispose] = AudioHeader.prototype.free;

/**
 * Streaming audio resampler with linear interpolation.
 *
 * Maintains phase continuity across chunks for glitch-free streaming.
 * Input/output are raw PCM bytes (i16 LE interleaved).
 *
 * Common use cases in this system:
 * - 8kHz  -> 16kHz (glasses HFP mic upsample)
 * - 16kHz -> 48kHz (mic to AudioContext)
 * - 48kHz -> 16kHz (browser mic capture downsample)
 */
export class AudioResampler {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        AudioResamplerFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_audioresampler_free(ptr, 0);
    }
    /**
     * Create a new resampler.
     * `channels` is typically 1 (mono) for this system.
     * @param {number} from_rate
     * @param {number} to_rate
     * @param {number} channels
     */
    constructor(from_rate, to_rate, channels) {
        const ret = wasm.audioresampler_new(from_rate, to_rate, channels);
        this.__wbg_ptr = ret >>> 0;
        AudioResamplerFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Process a chunk of interleaved PCM i16 LE bytes.
     * Returns resampled PCM i16 LE bytes.
     * @param {Uint8Array} pcm_bytes
     * @returns {Uint8Array}
     */
    process(pcm_bytes) {
        const ptr0 = passArray8ToWasm0(pcm_bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.audioresampler_process(this.__wbg_ptr, ptr0, len0);
        var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v2;
    }
    /**
     * Get the input-to-output sample rate ratio.
     * @returns {number}
     */
    ratio() {
        const ret = wasm.audioresampler_ratio(this.__wbg_ptr);
        return ret;
    }
    /**
     * Reset resampler state (e.g., on stream reconnect).
     */
    reset() {
        wasm.audioresampler_reset(this.__wbg_ptr);
    }
}
if (Symbol.dispose) AudioResampler.prototype[Symbol.dispose] = AudioResampler.prototype.free;

/**
 * Video frame metadata parsed from a FRLY binary prefix.
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
     * @returns {number}
     */
    get height() {
        const ret = wasm.__wbg_get_frameheader_height(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get quality() {
        const ret = wasm.__wbg_get_frameheader_quality(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {bigint}
     */
    get sequence() {
        const ret = wasm.__wbg_get_frameheader_sequence(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @returns {bigint}
     */
    get timestamp_ms() {
        const ret = wasm.__wbg_get_frameheader_timestamp_ms(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @returns {number}
     */
    get width() {
        const ret = wasm.__wbg_get_frameheader_width(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} arg0
     */
    set height(arg0) {
        wasm.__wbg_set_frameheader_height(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set quality(arg0) {
        wasm.__wbg_set_frameheader_quality(this.__wbg_ptr, arg0);
    }
    /**
     * @param {bigint} arg0
     */
    set sequence(arg0) {
        wasm.__wbg_set_frameheader_sequence(this.__wbg_ptr, arg0);
    }
    /**
     * @param {bigint} arg0
     */
    set timestamp_ms(arg0) {
        wasm.__wbg_set_frameheader_timestamp_ms(this.__wbg_ptr, arg0);
    }
    /**
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
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(FrameRelay.prototype);
        obj.__wbg_ptr = ptr;
        FrameRelayFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
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
     * Create a relay from a quality preset name.
     * Returns `null` if the preset is not recognized.
     * @param {string} preset
     * @returns {FrameRelay | undefined}
     */
    static from_preset(preset) {
        const ptr0 = passStringToWasm0(preset, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.framerelay_from_preset(ptr0, len0);
        return ret === 0 ? undefined : FrameRelay.__wrap(ret);
    }
    /**
     * Get the configured max FPS.
     * @returns {number}
     */
    max_fps() {
        const ret = wasm.framerelay_max_fps(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get the minimum interval in milliseconds between relayed frames.
     * @returns {bigint}
     */
    min_interval_ms() {
        const ret = wasm.framerelay_min_interval_ms(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
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
     * Update the max FPS at runtime (e.g., when viewer changes quality preset).
     * @param {number} fps
     */
    set_max_fps(fps) {
        wasm.framerelay_set_max_fps(this.__wbg_ptr, fps);
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
 * Classify a binary frame by its magic bytes.
 *
 * Returns:
 * - `0` = unknown / too short
 * - `1` = video (FRLY)
 * - `2` = audio (FRAU)
 * @param {Uint8Array} buf
 * @returns {number}
 */
export function classify_frame(buf) {
    const ptr0 = passArray8ToWasm0(buf, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.classify_frame(ptr0, len0);
    return ret;
}

/**
 * Decode a FRAU header from a binary buffer.
 * @param {Uint8Array} buf
 * @returns {AudioHeader | undefined}
 */
export function decode_audio_header(buf) {
    const ptr0 = passArray8ToWasm0(buf, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.decode_audio_header(ptr0, len0);
    return ret === 0 ? undefined : AudioHeader.__wrap(ret);
}

/**
 * Decode a FRLY header from a binary buffer.
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
 * Encode a complete FRAU frame (29-byte header + PCM payload).
 * @param {number} codec_type
 * @param {bigint} sequence
 * @param {number} sample_rate
 * @param {number} channels
 * @param {number} bits_per_sample
 * @param {bigint} timestamp_ms
 * @param {Uint8Array} pcm
 * @returns {Uint8Array}
 */
export function encode_audio_frame(codec_type, sequence, sample_rate, channels, bits_per_sample, timestamp_ms, pcm) {
    const ptr0 = passArray8ToWasm0(pcm, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.encode_audio_frame(codec_type, sequence, sample_rate, channels, bits_per_sample, timestamp_ms, ptr0, len0);
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * Encode a 29-byte FRLY header prefix (no JPEG payload).
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

/**
 * Encode a complete FRLY frame (header + JPEG payload).
 * @param {bigint} sequence
 * @param {number} width
 * @param {number} height
 * @param {number} quality
 * @param {bigint} timestamp_ms
 * @param {Uint8Array} jpeg
 * @returns {Uint8Array}
 */
export function encode_video_frame(sequence, width, height, quality, timestamp_ms, jpeg) {
    const ptr0 = passArray8ToWasm0(jpeg, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.encode_video_frame(sequence, width, height, quality, timestamp_ms, ptr0, len0);
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * Extract the PCM payload bytes from a FRAU frame (skips 29-byte header).
 * @param {Uint8Array} buf
 * @returns {Uint8Array}
 */
export function extract_audio_payload(buf) {
    const ptr0 = passArray8ToWasm0(buf, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.extract_audio_payload(ptr0, len0);
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * Extract the JPEG payload bytes from a FRLY frame (skips 29-byte header).
 * @param {Uint8Array} buf
 * @returns {Uint8Array}
 */
export function extract_video_payload(buf) {
    const ptr0 = passArray8ToWasm0(buf, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.extract_video_payload(ptr0, len0);
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * Check whether a buffer starts with the FRAU magic bytes.
 * @param {Uint8Array} buf
 * @returns {boolean}
 */
export function is_audio_frame(buf) {
    const ptr0 = passArray8ToWasm0(buf, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.is_audio_frame(ptr0, len0);
    return ret !== 0;
}

/**
 * Check whether a buffer starts with the FRLY magic bytes.
 * @param {Uint8Array} buf
 * @returns {boolean}
 */
export function is_video_frame(buf) {
    const ptr0 = passArray8ToWasm0(buf, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.is_video_frame(ptr0, len0);
    return ret !== 0;
}

/**
 * Validate a binary frame's header integrity.
 *
 * Checks magic bytes and minimum header size.
 * Returns `true` if the frame header is well-formed.
 * @param {Uint8Array} buf
 * @returns {boolean}
 */
export function validate_frame(buf) {
    const ptr0 = passArray8ToWasm0(buf, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.validate_frame(ptr0, len0);
    return ret !== 0;
}
export function __wbg___wbindgen_throw_6b64449b9b9ed33c(arg0, arg1) {
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
const AudioHeaderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_audioheader_free(ptr >>> 0, 1));
const AudioResamplerFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_audioresampler_free(ptr >>> 0, 1));
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

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
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

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;


let wasm;
export function __wbg_set_wasm(val) {
    wasm = val;
}
