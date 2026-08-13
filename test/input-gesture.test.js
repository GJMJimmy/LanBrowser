import test from "node:test";
import assert from "node:assert/strict";
import { InteractionController, TouchGesture, TouchScrollBuffer, normalizeWheel } from "../public/input.js";

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

test("touch tap opens the mobile keyboard only for an editable hit", () => {
  const interaction = new InteractionController({ mode: "touch", threshold: 8 });

  const ordinary = interaction.start(1, { x: 80, y: 120 });
  interaction.resolveHitTest({ requestId: ordinary.requestId, editable: false });
  assert.deepEqual(interaction.end(1, { x: 82, y: 122 }), {
    kind: "tap",
    point: { x: 82, y: 122 },
    keyboard: null,
  });

  const editable = interaction.start(2, { x: 100, y: 160 });
  interaction.resolveHitTest({ requestId: editable.requestId, editable: true, inputMode: "email" });
  assert.deepEqual(interaction.end(2, { x: 101, y: 161 }), {
    kind: "tap",
    point: { x: 101, y: 161 },
    keyboard: { inputMode: "email" },
  });
});

test("touch drag scrolls without clicking or opening the keyboard", () => {
  const interaction = new InteractionController({ mode: "touch", threshold: 8 });
  const started = interaction.start(7, { x: 120, y: 300 });
  interaction.resolveHitTest({ requestId: started.requestId, editable: true, inputMode: "text" });

  assert.deepEqual(interaction.move(7, { x: 118, y: 220 }), {
    kind: "scroll",
    point: { x: 118, y: 220 },
    deltaX: 2,
    deltaY: 80,
  });
  assert.deepEqual(interaction.end(7, { x: 118, y: 220 }), { kind: "touch-end" });
});

test("stale hit-test responses cannot open the keyboard", () => {
  const interaction = new InteractionController({ mode: "touch" });
  const stale = interaction.start(1, { x: 10, y: 10 });
  interaction.cancel(1);
  interaction.start(2, { x: 40, y: 40 });

  assert.equal(interaction.resolveHitTest({ requestId: stale.requestId, editable: true }), false);
  assert.equal(interaction.end(2, { x: 40, y: 40 }).keyboard, null);
});

test("computer mode emits mouse actions and switching modes cancels an active touch", () => {
  const interaction = new InteractionController({ mode: "touch" });
  interaction.start(1, { x: 10, y: 10 });
  assert.equal(interaction.setMode("computer"), true);

  assert.deepEqual(interaction.start(2, { x: 30, y: 40 }), {
    kind: "mouse",
    event: "mousePressed",
    point: { x: 30, y: 40 },
  });
  assert.deepEqual(interaction.move(2, { x: 50, y: 60 }), {
    kind: "mouse",
    event: "mouseMoved",
    point: { x: 50, y: 60 },
  });
  assert.deepEqual(interaction.end(2, { x: 50, y: 60 }), {
    kind: "mouse",
    event: "mouseReleased",
    point: { x: 50, y: 60 },
  });
});
