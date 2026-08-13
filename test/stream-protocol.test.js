import test from "node:test";
import assert from "node:assert/strict";
import { encodeFrame, SequencedFrameReader } from "../public/stream.js";
import { PcmChunkAligner } from "../src/audio-protocol.js";

test("late unordered frames cannot replace a newer frame", () => {
  const reader = new SequencedFrameReader();
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);

  const second = reader.accept(encodeFrame(1, 2, jpeg));
  const lateFirst = reader.accept(encodeFrame(1, 1, jpeg));

  assert.equal(second.sequence, 2);
  assert.deepEqual([...second.payload], [...jpeg]);
  assert.equal(lateFirst, null);
});

test("frames from a previous page generation cannot replace the active tab", () => {
  const reader = new SequencedFrameReader();
  const oldJpeg = Uint8Array.from([0xff, 0xd8, 1, 0xff, 0xd9]);
  const activeJpeg = Uint8Array.from([0xff, 0xd8, 2, 0xff, 0xd9]);

  const active = reader.accept(encodeFrame(8, 1, activeJpeg));
  const delayedPreviousTab = reader.accept(encodeFrame(7, 99, oldJpeg));

  assert.equal(active.generation, 8);
  assert.deepEqual([...active.payload], [...activeJpeg]);
  assert.equal(delayedPreviousTab, null);
});

test("PCM packets decode interleaved float samples per channel", async () => {
  const { decodePcm } = await import("../public/audio.js");
  const interleaved = new Float32Array([0.25, -0.25, 0.5, -0.5]);
  const channels = decodePcm(interleaved.buffer, { channels: 2, bitsPerSample: 32, encoding: "float" });
  assert.deepEqual([...channels[0]], [0.25, 0.5]);
  assert.deepEqual([...channels[1]], [-0.25, -0.5]);
});

test("split PCM chunks are emitted only on complete sample frames", () => {
  const aligner = new PcmChunkAligner(8);
  assert.equal(aligner.push(Buffer.from([1, 2, 3])), null);
  assert.deepEqual([...aligner.push(Buffer.from([4, 5, 6, 7, 8, 9]))], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(aligner.pending.length, 1);
});
