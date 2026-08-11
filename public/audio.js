export function decodePcm(value, format) {
  const channels = Math.max(1, Number(format.channels) || 1);
  const bits = Number(format.bitsPerSample) || 32;
  const bytes = value instanceof Uint8Array
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value);
  const sampleBytes = bits / 8;
  const frameCount = Math.floor(bytes.byteLength / sampleBytes / channels);
  const output = Array.from({ length: channels }, () => new Float32Array(frameCount));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const offset = (frame * channels + channel) * sampleBytes;
      let sample = 0;
      if (format.encoding === "float" && bits === 32) sample = view.getFloat32(offset, true);
      else if (bits === 16) sample = view.getInt16(offset, true) / 32768;
      else if (bits === 24) sample = (view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getInt8(offset + 2) << 16)) / 8388608;
      else if (bits === 32) sample = view.getInt32(offset, true) / 2147483648;
      output[channel][frame] = Math.max(-1, Math.min(1, sample));
    }
  }
  return output;
}

export class AudioPlaybackQueue {
  constructor({ initialDelay = 0.04, maxLead = 0.3 } = {}) {
    this.initialDelay = initialDelay;
    this.maxLead = maxLead;
    this.nextTime = 0;
    this.sources = new Set();
  }

  schedule(context, source, duration) {
    const now = context.currentTime;
    if (this.nextTime < now || this.nextTime > now + this.maxLead) {
      this.#stopSources();
      this.nextTime = now + this.initialDelay;
    }
    const startTime = this.nextTime;
    this.nextTime += duration;
    this.sources.add(source);
    source.onended = () => this.sources.delete(source);
    source.start(startTime);
    return startTime;
  }

  close() {
    this.#stopSources();
    this.nextTime = 0;
  }

  #stopSources() {
    for (const source of this.sources) {
      source.onended = null;
      try { source.stop(); } catch {}
    }
    this.sources.clear();
  }
}
