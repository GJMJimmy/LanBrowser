import test from "node:test";
import assert from "node:assert/strict";
import { nextZoom, normalizeZoom, zoomFactor } from "../public/zoom.js";

test("zoom accepts integer percentages between 25 and 500", () => {
  assert.equal(normalizeZoom(137), 137);
  assert.equal(normalizeZoom(5), 25);
  assert.equal(normalizeZoom(900), 500);
  assert.equal(normalizeZoom("invalid", 125), 125);
  assert.equal(zoomFactor(175), 1.75);
});

test("zoom buttons follow familiar browser steps", () => {
  assert.equal(nextZoom(100, 1), 110);
  assert.equal(nextZoom(110, 1), 125);
  assert.equal(nextZoom(125, -1), 110);
  assert.equal(nextZoom(137, 1), 150);
  assert.equal(nextZoom(137, -1), 133);
  assert.equal(nextZoom(500, 1), 500);
  assert.equal(nextZoom(25, -1), 25);
});
