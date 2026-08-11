import test from "node:test";
import assert from "node:assert/strict";
import { AudioPlaybackQueue } from "../public/audio.js";

const source = () => ({
  starts: [],
  stops: 0,
  start(time) { this.starts.push(time); },
  stop() { this.stops += 1; },
});

test("audio backlog reset stops already scheduled sources before rewinding the timeline", () => {
  const queue = new AudioPlaybackQueue({ initialDelay: 0.05, maxLead: 0.3 });
  const context = { currentTime: 10 };
  const oldSources = Array.from({ length: 3 }, source);
  for (const item of oldSources) queue.schedule(context, item, 0.1);

  queue.schedule(context, source(), 0.1);

  assert.equal(oldSources.reduce((sum, item) => sum + item.stops, 0), oldSources.length);
});
