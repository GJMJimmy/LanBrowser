const HEADER_SIZE = 8;

const asBytes = (value) => value instanceof Uint8Array
  ? value
  : new Uint8Array(value.buffer || value, value.byteOffset || 0, value.byteLength);

export function encodeFrame(generation, sequence, jpeg) {
  const payload = asBytes(jpeg);
  const packet = new Uint8Array(HEADER_SIZE + payload.byteLength);
  const header = new DataView(packet.buffer);
  header.setUint32(0, Number(generation) >>> 0);
  header.setUint32(4, Number(sequence) >>> 0);
  packet.set(payload, HEADER_SIZE);
  return packet;
}

export class SequencedFrameReader {
  constructor() {
    this.lastGeneration = 0;
    this.lastSequence = 0;
  }

  accept(value) {
    const packet = asBytes(value);
    if (packet.byteLength <= HEADER_SIZE) return null;
    const header = new DataView(packet.buffer, packet.byteOffset, HEADER_SIZE);
    const generation = header.getUint32(0);
    const sequence = header.getUint32(4);
    if (generation < this.lastGeneration) return null;
    if (generation > this.lastGeneration) {
      this.lastGeneration = generation;
      this.lastSequence = 0;
    }
    if (sequence <= this.lastSequence) return null;
    this.lastSequence = sequence;
    return { generation, sequence, payload: packet.subarray(HEADER_SIZE) };
  }

  reset() {
    this.lastGeneration = 0;
    this.lastSequence = 0;
  }
}
