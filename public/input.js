export class TouchGesture {
  constructor(threshold = 8) {
    this.threshold = threshold;
    this.active = false;
    this.moved = false;
    this.origin = null;
    this.last = null;
  }

  start(point) {
    this.active = true;
    this.moved = false;
    this.origin = { ...point };
    this.last = { ...point };
  }

  move(point) {
    if (!this.active) return { deltaX: 0, deltaY: 0 };
    const distance = Math.hypot(point.x - this.origin.x, point.y - this.origin.y);
    if (!this.moved && distance <= this.threshold) return { deltaX: 0, deltaY: 0 };
    const previous = this.moved ? this.last : this.origin;
    this.moved = true;
    this.last = { ...point };
    return { deltaX: previous.x - point.x, deltaY: previous.y - point.y };
  }

  end(point) {
    if (!this.active) return { click: false };
    const distance = Math.hypot(point.x - this.origin.x, point.y - this.origin.y);
    const click = !this.moved && distance <= this.threshold;
    this.active = false;
    this.origin = this.last = null;
    return { click };
  }

  cancel() {
    this.active = false;
    this.moved = false;
    this.origin = this.last = null;
  }
}

export class TouchScrollBuffer {
  constructor() {
    this.clear();
  }

  push(value) {
    this.x = value.x;
    this.y = value.y;
    this.deltaX += Number(value.deltaX) || 0;
    this.deltaY += Number(value.deltaY) || 0;
    this.pending = true;
  }

  flush() {
    if (!this.pending) return null;
    const value = { x: this.x, y: this.y, deltaX: this.deltaX, deltaY: this.deltaY };
    this.clear();
    return value;
  }

  clear() {
    this.x = 0;
    this.y = 0;
    this.deltaX = 0;
    this.deltaY = 0;
    this.pending = false;
  }
}

const INTERACTION_MODES = new Set(["computer", "touch"]);
const INPUT_MODES = new Set(["none", "text", "decimal", "numeric", "tel", "search", "email", "url"]);

export class InteractionController {
  constructor({ mode = "computer", threshold = 8 } = {}) {
    this.gesture = new TouchGesture(threshold);
    this.requestSequence = 0;
    this.activePointerId = null;
    this.hitTest = null;
    this.mode = INTERACTION_MODES.has(mode) ? mode : "computer";
  }

  setMode(mode) {
    if (!INTERACTION_MODES.has(mode)) throw new TypeError("Unsupported interaction mode");
    if (mode === this.mode) return false;
    this.cancel();
    this.mode = mode;
    return true;
  }

  start(pointerId, point) {
    this.cancel();
    this.activePointerId = pointerId;
    if (this.mode === "computer") return { kind: "mouse", event: "mousePressed", point: { ...point } };

    this.gesture.start(point);
    const requestId = ++this.requestSequence;
    this.hitTest = { requestId, keyboard: null };
    return { kind: "touch-start", requestId, point: { ...point } };
  }

  resolveHitTest({ requestId, editable, inputMode }) {
    if (!this.hitTest || Number(requestId) !== this.hitTest.requestId) return false;
    this.hitTest.keyboard = editable
      ? { inputMode: INPUT_MODES.has(inputMode) ? inputMode : "text" }
      : null;
    return true;
  }

  move(pointerId, point) {
    if (pointerId !== this.activePointerId) return null;
    if (this.mode === "computer") return { kind: "mouse", event: "mouseMoved", point: { ...point } };

    const delta = this.gesture.move(point);
    if (!delta.deltaX && !delta.deltaY) return null;
    return { kind: "scroll", point: { ...point }, ...delta };
  }

  end(pointerId, point) {
    if (pointerId !== this.activePointerId) return null;
    if (this.mode === "computer") {
      this.activePointerId = null;
      return { kind: "mouse", event: "mouseReleased", point: { ...point } };
    }

    const result = this.gesture.end(point);
    const keyboard = this.hitTest?.keyboard || null;
    this.activePointerId = null;
    this.hitTest = null;
    if (result.click) return { kind: "tap", point: { ...point }, keyboard };
    return { kind: "touch-end" };
  }

  cancel(pointerId) {
    if (pointerId !== undefined && pointerId !== this.activePointerId) return false;
    const wasActive = this.activePointerId !== null;
    this.gesture.cancel();
    this.activePointerId = null;
    this.hitTest = null;
    return wasActive;
  }
}

export function normalizeWheel(event, pageHeight) {
  const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? pageHeight : 1;
  return { deltaX: event.deltaX * scale, deltaY: event.deltaY * scale };
}
