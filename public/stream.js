const HEADER_SIZE = 4;

const asBytes = (value) => value instanceof Uint8Array
  ? value
  : new Uint8Array(value.buffer || value, value.byteOffset || 0, value.byteLength);

export function encodeFrame(sequence, jpeg) {
  const payload = asBytes(jpeg);
  const packet = new Uint8Array(HEADER_SIZE + payload.byteLength);
  new DataView(packet.buffer).setUint32(0, Number(sequence) >>> 0);
  packet.set(payload, HEADER_SIZE);
  return packet;
}

export class SequencedFrameReader {
  constructor() {
    this.lastSequence = 0;
  }

  accept(value) {
    const packet = asBytes(value);
    if (packet.byteLength <= HEADER_SIZE) return null;
    const sequence = new DataView(packet.buffer, packet.byteOffset, HEADER_SIZE).getUint32(0);
    if (sequence <= this.lastSequence) return null;
    this.lastSequence = sequence;
    return { sequence, payload: packet.subarray(HEADER_SIZE) };
  }

  reset() {
    this.lastSequence = 0;
  }
}
