export const MIN_ZOOM = 25;
export const MAX_ZOOM = 500;
export const ZOOM_STEPS = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 133, 150, 175, 200, 250, 300, 400, 500];

export function normalizeZoom(value, fallback = 100) {
  const number = Number(value);
  if (!Number.isFinite(number)) return normalizeZoom(fallback, 100);
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(number)));
}

export function zoomFactor(value) {
  return normalizeZoom(value) / 100;
}

export function nextZoom(value, direction) {
  const current = normalizeZoom(value);
  if (direction > 0) return ZOOM_STEPS.find((step) => step > current) ?? MAX_ZOOM;
  return ZOOM_STEPS.findLast((step) => step < current) ?? MIN_ZOOM;
}
