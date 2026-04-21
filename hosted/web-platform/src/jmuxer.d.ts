declare module "jmuxer" {
  interface JMuxerOptions {
    node: string | HTMLVideoElement;
    mode?: "both" | "audio" | "video";
    videoCodec?: "H264" | "H265";
    flushingTime?: number;
    maxDelay?: number;
    clearBuffer?: boolean;
    fps?: number;
    debug?: boolean;
    onReady?: () => void;
    onData?: (data: Uint8Array) => void;
    onError?: (e: unknown) => void;
    onUnsupportedCodec?: () => void;
    onMissingVideoFrames?: () => void;
    onKeyframePosition?: (time: number) => void;
  }

  export default class JMuxer {
    constructor(options: JMuxerOptions);
    feed(data: { video?: Uint8Array; audio?: Uint8Array; duration?: number }): void;
    destroy(): void;
    reset(): void;
    createStream(): unknown;
  }
}
