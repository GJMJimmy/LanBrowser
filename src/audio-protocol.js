export class PcmChunkAligner {
  constructor(frameBytes) {
    this.frameBytes = Math.max(1, Number(frameBytes) || 1);
    this.pending = Buffer.alloc(0);
  }

  push(chunk) {
    const input = this.pending.length ? Buffer.concat([this.pending, chunk]) : Buffer.from(chunk);
    const alignedLength = input.length - (input.length % this.frameBytes);
    if (!alignedLength) {
      this.pending = input;
      return null;
    }
    const output = input.subarray(0, alignedLength);
    this.pending = Buffer.from(input.subarray(alignedLength));
    return output;
  }
}
