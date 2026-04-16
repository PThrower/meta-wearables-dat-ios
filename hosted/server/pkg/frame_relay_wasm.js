/* @ts-self-types="./frame_relay_wasm.d.ts" */

import * as wasm from "./frame_relay_wasm_bg.wasm";
import { __wbg_set_wasm } from "./frame_relay_wasm_bg.js";
__wbg_set_wasm(wasm);
wasm.__wbindgen_start();
export {
    FrameHeader, FrameRelay, decode_frame_prefix, encode_frame_prefix
} from "./frame_relay_wasm_bg.js";
