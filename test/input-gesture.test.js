import test from "node:test";
import assert from "node:assert/strict";
import { TouchGesture, TouchScrollBuffer, normalizeWheel } from "../public/input.js";

test("touch drag becomes remote scroll and not a click", () => {
  const gesture = new TouchGesture(8);
  gesture.start({ x: 120, y: 300 });
  assert.deepEqual(gesture.move({ x: 118, y: 220 }), { deltaX: 2, deltaY: 80 });
  assert.equal(gesture.end({ x: 118, y: 220 }).click, false);
});

test("short touch remains a click", () => {
  const gesture = new TouchGesture(8);
  gesture.start({ x: 100, y: 100 });
  assert.equal(gesture.end({ x: 104, y: 103 }).click, true);
});

test("wheel line and page units are converted to pixels", () => {
  assert.deepEqual(normalizeWheel({ deltaX: 1, deltaY: -3, deltaMode: 1 }, 700), { deltaX: 16, deltaY: -48 });
  assert.deepEqual(normalizeWheel({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 700), { deltaX: 0, deltaY: 700 });
});

test("touch scroll bursts are coalesced before being sent", () => {
  const scroll = new TouchScrollBuffer();
  scroll.push({ x: 100, y: 200, deltaX: 2, deltaY: 20 });
  scroll.push({ x: 101, y: 180, deltaX: 3, deltaY: 30 });
  assert.deepEqual(scroll.flush(), { x: 101, y: 180, deltaX: 5, deltaY: 50 });
  assert.equal(scroll.flush(), null);
});
