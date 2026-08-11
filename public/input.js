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

export function normalizeWheel(event, pageHeight) {
  const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? pageHeight : 1;
  return { deltaX: event.deltaX * scale, deltaY: event.deltaY * scale };
}
