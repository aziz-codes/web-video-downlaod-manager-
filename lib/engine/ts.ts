// MPEG-TS -> fragmented MP4 via mux.js (H.264 + AAC/MP3 audio).

import { Transmuxer } from 'mux.js/lib/mp4/transmuxer';
import { concat } from './mp4';

export class TsTransmuxer {
  private tm = new Transmuxer({ keepOriginalTimestamps: true, remux: true });
  private pending: Uint8Array[] = [];
  private initSent = false;

  constructor() {
    this.tm.on('data', (e) => {
      if (!this.initSent && e.initSegment?.length) {
        this.pending.push(e.initSegment);
        this.initSent = true;
      }
      if (e.data?.length) this.pending.push(e.data);
    });
  }

  /** Transmuxes one TS segment; the first non-empty result includes the init segment. */
  transmux(ts: Uint8Array): Uint8Array {
    this.tm.push(ts);
    this.tm.flush();
    const out = concat(this.pending);
    this.pending = [];
    return out;
  }
}
