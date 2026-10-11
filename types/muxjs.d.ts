declare module 'mux.js/lib/mp4/transmuxer' {
  export interface TransmuxerEvent {
    type: 'video' | 'audio' | 'combined';
    initSegment: Uint8Array;
    data: Uint8Array;
  }
  export class Transmuxer {
    constructor(options?: { keepOriginalTimestamps?: boolean; remux?: boolean });
    on(event: 'data', cb: (e: TransmuxerEvent) => void): void;
    on(event: string, cb: (...args: unknown[]) => void): void;
    push(data: Uint8Array): void;
    flush(): void;
    reset(): void;
  }
}
