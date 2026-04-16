/* @ts-self-types="./frame_relay_wasm.d.ts" */
import * as wasm from "./frame_relay_wasm_bg.wasm";
import { __wbg_set_wasm } from "./frame_relay_wasm_bg.js";

__wbg_set_wasm(wasm);
wasm.__wbindgen_start();
export {
    AudioHeader, AudioResampler, FrameHeader, FrameRelay, classify_frame, decode_audio_header, decode_frame_prefix, encode_audio_frame, encode_frame_prefix, encode_video_frame, extract_audio_payload, extract_video_payload, is_audio_frame, is_video_frame, validate_frame
} from "./frame_relay_wasm_bg.js";
