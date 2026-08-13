import { InteractionController, TouchScrollBuffer, normalizeWheel } from "/input.js?v=0.3.3";
import { SequencedFrameReader } from "/stream.js?v=0.3.0";
import { AudioPlaybackQueue, decodePcm } from "/audio.js?v=0.3.2";
import { nextZoom, normalizeZoom } from "/zoom.js?v=0.3.4";

/* global lucide */
lucide.createIcons();

const $ = (selector) => document.querySelector(selector);
const elements = {
  viewport: $("#viewport"), frame: $("#frame"), empty: $("#empty-state"), loading: $("#loading-state"),
  loadingText: $("#loading-text"), connectForm: $("#connect-form"), connect: $("#connect"), token: $("#token"),
  error: $("#connect-error"), addressForm: $("#address-form"), address: $("#address"),
  back: $("#back"), forward: $("#forward"), reload: $("#reload"), disconnect: $("#disconnect"),
  audioToggle: $("#audio-toggle"),
  interactionMode: $("#interaction-mode"),
  mobileKeyboard: $("#mobile-keyboard"), mobileInput: $("#mobile-input"),
  displaySettings: $("#display-settings"), displayPanel: $("#display-panel"), resolutionForm: $("#resolution-form"),
  autoResolution: $("#auto-resolution"), resolutionWidth: $("#resolution-width"), resolutionHeight: $("#resolution-height"),
  zoomOut: $("#zoom-out"), zoomPercent: $("#zoom-percent"), zoomIn: $("#zoom-in"), zoomReset: $("#zoom-reset"),
  statusChip: $("#status-chip"), statusText: $("#status-text"), resolution: $("#resolution"), toast: $("#toast"),
};

const state = { peer: null, signal: null, control: null, frames: null, audio: null, audioContext: null, audioGain: null, audioQueue: null, audioFormat: null, audioMuted: false, frameUrl: "", pendingFrameUrl: "", connected: false, moving: false, resizeTimer: null, touchScrollRaf: 0, autoResolution: true, zoom: normalizeZoom(localStorage.getItem("lan-browser-zoom") || 100) };
const frameReader = new SequencedFrameReader();
const storedInteractionMode = localStorage.getItem("lan-browser-interaction-mode");
const defaultInteractionMode = storedInteractionMode || (matchMedia("(pointer: coarse)").matches ? "touch" : "computer");
const interaction = new InteractionController({ mode: defaultInteractionMode });
const queryToken = new URLSearchParams(location.search).get("token") || sessionStorage.getItem("lan-browser-token") || "";
elements.token.value = queryToken;

function setStatus(value, text) {
  elements.statusChip.dataset.state = value;
  elements.statusText.textContent = text;
}

function setRemoteEnabled(enabled) {
  state.connected = enabled;
  elements.viewport.classList.toggle("remote-active", enabled);
  elements.empty.hidden = enabled;
  for (const element of [elements.address, elements.back, elements.forward, elements.reload, elements.disconnect, elements.audioToggle, elements.displaySettings, elements.interactionMode, elements.mobileKeyboard, elements.zoomPercent, elements.zoomReset, $(".go-button")]) element.disabled = !enabled;
  updateZoomControls();
  if (enabled) elements.viewport.focus();
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { elements.toast.hidden = true; }, 4200);
}

async function waitForIce(peer) {
  if (peer.iceGatheringState === "complete") return;
  await new Promise((resolve) => {
    const done = () => {
      if (peer.iceGatheringState === "complete") {
        peer.removeEventListener("icegatheringstatechange", done);
        resolve();
      }
    };
    peer.addEventListener("icegatheringstatechange", done);
    setTimeout(resolve, 6000);
  });
}

async function connect(token) {
  disconnect(false);
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (AudioContextClass) {
    state.audioContext = new AudioContextClass({ latencyHint: "interactive" });
    state.audioGain = state.audioContext.createGain();
    state.audioGain.connect(state.audioContext.destination);
    state.audioGain.gain.value = state.audioMuted ? 0 : 1;
    state.audioQueue = new AudioPlaybackQueue();
    state.audioContext.resume().catch(() => {});
  }
  elements.error.textContent = "";
  elements.connect.disabled = true;
  elements.loading.hidden = false;
  elements.loadingText.textContent = "正在建立 WebRTC 连接";
  setStatus("connecting", "连接中");
  sessionStorage.setItem("lan-browser-token", token);

  try {
    const peer = new RTCPeerConnection({ bundlePolicy: "max-bundle" });
    state.peer = peer;
    const control = peer.createDataChannel("control", { ordered: true });
    const frames = peer.createDataChannel("frames", { ordered: false, maxRetransmits: 0 });
    const audio = peer.createDataChannel("audio", { ordered: true, maxRetransmits: 0 });
    frames.binaryType = "arraybuffer";
    audio.binaryType = "arraybuffer";
    state.control = control;
    state.frames = frames;
    state.audio = audio;
    control.onmessage = (event) => onControl(JSON.parse(event.data));
    frames.onmessage = (event) => onFrame(event.data);
    audio.onmessage = (event) => onAudio(event.data);
    control.onopen = () => {
      setRemoteEnabled(true);
      setStatus("connecting", "启动中");
      elements.loadingText.textContent = "正在启动服务端 Edge";
      sendResize();
      updateZoom(state.zoom);
    };
    peer.onconnectionstatechange = () => {
      if (["failed", "disconnected", "closed"].includes(peer.connectionState)) disconnect(true, "WebRTC 连接已断开");
    };

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await waitForIce(peer);
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const signal = new WebSocket(`${scheme}//${location.host}/signal?token=${encodeURIComponent(token)}`);
    state.signal = signal;
    await new Promise((resolve, reject) => {
      signal.onopen = resolve;
      signal.onerror = () => reject(new Error("无法连接到服务端"));
    });
    signal.send(JSON.stringify({ type: "offer", offer: peer.localDescription }));
    const answer = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("服务端响应超时")), 15000);
      signal.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "answer") { clearTimeout(timeout); resolve(message.answer); }
        if (message.type === "error") { clearTimeout(timeout); reject(new Error(message.message)); }
      };
      signal.onclose = () => reject(new Error("信令连接被拒绝，请检查访问口令"));
    });
    await peer.setRemoteDescription(answer);
    signal.close();
  } catch (error) {
    disconnect(false);
    elements.error.textContent = error.message || "连接失败";
    setStatus("error", "连接失败");
  } finally {
    elements.connect.disabled = false;
    if (!state.connected) elements.loading.hidden = true;
  }
}

function disconnect(showMessage = false, message = "会话已断开") {
  const signal = state.signal;
  const control = state.control;
  const frames = state.frames;
  const audio = state.audio;
  const peer = state.peer;
  if (control?.readyState === "open") control.send(JSON.stringify({ type: "disconnect" }));
  setTimeout(() => {
    signal?.close();
    control?.close();
    frames?.close();
    audio?.close();
    peer?.close();
  }, control?.readyState === "open" ? 80 : 0);
  state.audioContext?.close().catch(() => {});
  state.audioQueue?.close();
  state.signal = state.control = state.frames = state.audio = state.peer = null;
  state.audioContext = state.audioGain = state.audioQueue = null;
  state.audioFormat = null;
  if (state.frameUrl) URL.revokeObjectURL(state.frameUrl);
  if (state.pendingFrameUrl) URL.revokeObjectURL(state.pendingFrameUrl);
  state.frameUrl = "";
  state.pendingFrameUrl = "";
  frameReader.reset();
  elements.frame.removeAttribute("src");
  elements.loading.hidden = true;
  setRemoteEnabled(false);
  setStatus("offline", "未连接");
  if (showMessage) elements.error.textContent = message;
}

function onControl(message) {
  if (message.type === "status") {
    if (message.state === "ready") {
      setStatus("ready", "已连接");
      elements.loading.hidden = true;
      sendResize();
    } else {
      setStatus("connecting", "启动中");
      elements.loading.hidden = false;
      elements.loadingText.textContent = message.message;
    }
  } else if (message.type === "page") {
    if (document.activeElement !== elements.address) elements.address.value = message.url || "";
    if (message.title) document.title = `${message.title} - LAN Browser`;
  } else if (message.type === "focus") {
    if (message.editable) {
      elements.mobileInput.inputMode = message.inputMode || "text";
    } else if (document.activeElement === elements.mobileInput) {
      elements.mobileInput.blur();
    }
  } else if (message.type === "zoom") {
    updateZoom(message.percent, false);
  } else if (message.type === "hit-test") {
    interaction.resolveHitTest(message);
  } else if (message.type === "audio-format") {
    state.audioFormat = message;
  } else if (message.type === "audio-error") {
    showToast(message.message);
  } else if (message.type === "error") showToast(message.message);
}

function onAudio(data) {
  const context = state.audioContext;
  if (!context || !state.audioGain || !state.audioFormat || context.state === "closed") return;
  if (data === "reset") {
    state.audioQueue?.close();
    return;
  }
  const channels = decodePcm(data, state.audioFormat);
  if (!channels.length || !channels[0].length) return;
  const buffer = context.createBuffer(channels.length, channels[0].length, state.audioFormat.sampleRate);
  channels.forEach((samples, index) => buffer.copyToChannel(samples, index));
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(state.audioGain);
  state.audioQueue?.schedule(context, source, buffer.duration);
}

function onFrame(data) {
  const frame = frameReader.accept(data);
  if (!frame) return;
  if (state.pendingFrameUrl) URL.revokeObjectURL(state.pendingFrameUrl);
  const next = URL.createObjectURL(new Blob([frame.payload], { type: "image/jpeg" }));
  state.pendingFrameUrl = next;
  elements.frame.onload = () => {
    if (state.frameUrl) URL.revokeObjectURL(state.frameUrl);
    state.frameUrl = next;
    state.pendingFrameUrl = "";
    elements.resolution.lastChild.textContent = ` ${elements.frame.naturalWidth} x ${elements.frame.naturalHeight}`;
  };
  elements.frame.onerror = () => {
    if (state.pendingFrameUrl === next) state.pendingFrameUrl = "";
    URL.revokeObjectURL(next);
  };
  elements.frame.src = next;
}

function send(message) {
  if (state.control?.readyState === "open") state.control.send(JSON.stringify(message));
}

function updateZoom(value, transmit = true) {
  state.zoom = normalizeZoom(value, state.zoom);
  elements.zoomPercent.value = String(state.zoom);
  localStorage.setItem("lan-browser-zoom", String(state.zoom));
  updateZoomControls();
  if (transmit) send({ type: "zoom", percent: state.zoom });
}

function updateZoomControls() {
  const enabled = state.connected;
  elements.zoomOut.disabled = !enabled || state.zoom <= 25;
  elements.zoomIn.disabled = !enabled || state.zoom >= 500;
  elements.zoomReset.disabled = !enabled || state.zoom === 100;
}

elements.zoomPercent.value = String(state.zoom);

function modifiers(event) {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}

function remotePoint(event) {
  const box = elements.frame.getBoundingClientRect();
  const imageRatio = (elements.frame.naturalWidth || 1) / (elements.frame.naturalHeight || 1);
  const boxRatio = box.width / box.height;
  let width = box.width, height = box.height, left = box.left, top = box.top;
  if (imageRatio > boxRatio) { height = width / imageRatio; top += (box.height - height) / 2; }
  else { width = height * imageRatio; left += (box.width - width) / 2; }
  return {
    x: Math.max(0, Math.min(elements.frame.naturalWidth, (event.clientX - left) * elements.frame.naturalWidth / width)),
    y: Math.max(0, Math.min(elements.frame.naturalHeight, (event.clientY - top) * elements.frame.naturalHeight / height)),
  };
}

const buttonName = (button) => ["left", "middle", "right"][button] || "none";
const touchScroll = new TouchScrollBuffer();
let lastTap = { time: 0, x: 0, y: 0 };

function sendClick(point, clickCount = 1) {
  send({ type: "mouse", event: "mousePressed", ...point, button: "left", buttons: 1, clickCount, modifiers: 0 });
  send({ type: "mouse", event: "mouseReleased", ...point, button: "left", buttons: 0, clickCount, modifiers: 0 });
}

function flushTouchScroll() {
  state.touchScrollRaf = 0;
  const scroll = touchScroll.flush();
  if (scroll) send({ type: "wheel", ...scroll, modifiers: 0 });
}

function queueTouchScroll(point, delta) {
  touchScroll.push({ ...point, ...delta });
  if (!state.touchScrollRaf) state.touchScrollRaf = requestAnimationFrame(flushTouchScroll);
}

function sendTouchMouse(action) {
  send({
    type: "mouse",
    event: action.event,
    ...action.point,
    button: action.event === "mouseMoved" ? "none" : "left",
    buttons: action.event === "mouseReleased" ? 0 : 1,
    clickCount: action.event === "mouseMoved" ? 0 : 1,
    modifiers: 0,
  });
}

function setInteractionMode(mode, remember = true) {
  interaction.setMode(mode);
  touchScroll.clear();
  if (state.touchScrollRaf) cancelAnimationFrame(state.touchScrollRaf);
  state.touchScrollRaf = 0;
  elements.mobileInput.blur();
  elements.viewport.dataset.interactionMode = interaction.mode;
  const isTouch = interaction.mode === "touch";
  const nextMode = isTouch ? "电脑操作" : "触屏操作";
  elements.interactionMode.title = `${isTouch ? "触屏操作" : "电脑操作"}（点击切换为${nextMode}）`;
  elements.interactionMode.setAttribute("aria-label", `切换为${nextMode}`);
  elements.interactionMode.setAttribute("aria-pressed", String(isTouch));
  const current = elements.interactionMode.querySelector("svg, i");
  const icon = document.createElement("i");
  icon.dataset.lucide = isTouch ? "hand" : "mouse-pointer-2";
  current?.replaceWith(icon);
  lucide.createIcons();
  if (remember) localStorage.setItem("lan-browser-interaction-mode", interaction.mode);
}

setInteractionMode(interaction.mode, false);

elements.viewport.addEventListener("pointerdown", (event) => {
  if (!state.connected) return;
  elements.viewport.focus();
  elements.viewport.setPointerCapture(event.pointerId);
  const point = remotePoint(event);
  if (event.pointerType === "touch") {
    if (interaction.activePointerId !== null) return;
    const action = interaction.start(event.pointerId, point);
    if (action.kind === "touch-start") send({ type: "hitTest", requestId: action.requestId, ...point });
    else sendTouchMouse(action);
    event.preventDefault();
    return;
  }
  send({ type: "mouse", event: "mousePressed", ...point, button: buttonName(event.button), buttons: event.buttons, clickCount: event.detail || 1, modifiers: modifiers(event) });
  event.preventDefault();
});
elements.viewport.addEventListener("pointerup", (event) => {
  if (!state.connected) return;
  const point = remotePoint(event);
  if (event.pointerType === "touch") {
    const action = interaction.end(event.pointerId, point);
    if (!action) return;
    if (action.kind === "tap") {
      const now = performance.now();
      const doubleTap = now - lastTap.time < 350 && Math.hypot(point.x - lastTap.x, point.y - lastTap.y) < 24;
      sendClick(point, doubleTap ? 2 : 1);
      if (action.keyboard) {
        elements.mobileInput.inputMode = action.keyboard.inputMode;
        elements.mobileInput.focus({ preventScroll: true });
      }
      lastTap = { time: now, ...point };
    } else if (action.kind === "touch-end") {
      flushTouchScroll();
    } else sendTouchMouse(action);
    event.preventDefault();
    return;
  }
  send({ type: "mouse", event: "mouseReleased", ...point, button: buttonName(event.button), buttons: event.buttons, clickCount: event.detail || 1, modifiers: modifiers(event) });
  event.preventDefault();
});
elements.viewport.addEventListener("pointermove", (event) => {
  if (!state.connected) return;
  if (event.pointerType === "touch") {
    const point = remotePoint(event);
    const action = interaction.move(event.pointerId, point);
    if (!action) return;
    if (action.kind === "scroll") queueTouchScroll(action.point, action);
    else sendTouchMouse(action);
    event.preventDefault();
    return;
  }
  if (state.moving) return;
  state.moving = true;
  requestAnimationFrame(() => {
    const point = remotePoint(event);
    send({ type: "mouse", event: "mouseMoved", ...point, button: "none", buttons: event.buttons, modifiers: modifiers(event) });
    state.moving = false;
  });
});
elements.viewport.addEventListener("pointercancel", (event) => {
  if (event.pointerType === "touch" && event.pointerId === interaction.activePointerId) {
    if (interaction.mode === "computer") sendTouchMouse({ kind: "mouse", event: "mouseReleased", point: remotePoint(event) });
    interaction.cancel(event.pointerId);
    touchScroll.clear();
  }
});
elements.viewport.addEventListener("wheel", (event) => {
  if (!state.connected) return;
  if (event.ctrlKey) {
    updateZoom(nextZoom(state.zoom, event.deltaY < 0 ? 1 : -1));
    event.preventDefault();
    return;
  }
  const point = remotePoint(event);
  const delta = normalizeWheel(event, elements.viewport.clientHeight);
  send({ type: "wheel", ...point, ...delta, modifiers: modifiers(event) });
  event.preventDefault();
}, { passive: false });
elements.viewport.addEventListener("contextmenu", (event) => event.preventDefault());

for (const type of ["keydown", "keyup"]) {
  elements.viewport.addEventListener(type, (event) => {
    if (!state.connected) return;
    if (event.isComposing || event.keyCode === 229) return;
    const zoomDirection = ["+", "="].includes(event.key) ? 1 : ["-", "_"].includes(event.key) ? -1 : 0;
    const zoomShortcut = event.ctrlKey && !event.altKey && !event.metaKey && (zoomDirection || event.key === "0");
    if (zoomShortcut) {
      if (type === "keydown" && !event.repeat) updateZoom(event.key === "0" ? 100 : nextZoom(state.zoom, zoomDirection));
      event.preventDefault();
      return;
    }
    send({ type: "key", event: type === "keydown" ? "down" : "up", key: event.key, code: event.code, keyCode: event.keyCode, repeat: event.repeat, modifiers: modifiers(event), ctrlKey: event.ctrlKey, altKey: event.altKey, metaKey: event.metaKey });
    event.preventDefault();
  });
}
elements.viewport.addEventListener("compositionend", (event) => {
  if (state.connected && event.data) send({ type: "text", text: event.data });
});

function sendResize(force = false) {
  if (!state.autoResolution && !force) return;
  clearTimeout(state.resizeTimer);
  state.resizeTimer = setTimeout(() => {
    send({ type: "resize", width: elements.viewport.clientWidth, height: elements.viewport.clientHeight });
  }, 180);
}
window.addEventListener("resize", () => sendResize());
elements.connectForm.addEventListener("submit", (event) => { event.preventDefault(); connect(elements.token.value.trim()); });
elements.addressForm.addEventListener("submit", (event) => { event.preventDefault(); send({ type: "navigate", url: elements.address.value }); elements.viewport.focus(); });
elements.back.addEventListener("click", () => send({ type: "back" }));
elements.forward.addEventListener("click", () => send({ type: "forward" }));
elements.reload.addEventListener("click", () => send({ type: "reload" }));
elements.disconnect.addEventListener("click", () => disconnect(false));
elements.audioToggle.addEventListener("click", () => {
  state.audioMuted = !state.audioMuted;
  if (state.audioGain) state.audioGain.gain.value = state.audioMuted ? 0 : 1;
  state.audioContext?.resume().catch(() => {});
  elements.audioToggle.title = state.audioMuted ? "取消静音" : "静音";
  elements.audioToggle.setAttribute("aria-pressed", String(state.audioMuted));
  const current = elements.audioToggle.querySelector("svg, i");
  const icon = document.createElement("i");
  icon.dataset.lucide = state.audioMuted ? "volume-x" : "volume-2";
  current?.replaceWith(icon);
  lucide.createIcons();
});
elements.interactionMode.addEventListener("click", () => {
  const nextMode = interaction.mode === "touch" ? "computer" : "touch";
  setInteractionMode(nextMode);
  showToast(nextMode === "touch" ? "已切换为触屏操作" : "已切换为电脑操作");
});
elements.mobileKeyboard.addEventListener("click", () => elements.mobileInput.focus());
elements.zoomOut.addEventListener("click", () => updateZoom(nextZoom(state.zoom, -1)));
elements.zoomIn.addEventListener("click", () => updateZoom(nextZoom(state.zoom, 1)));
elements.zoomReset.addEventListener("click", () => updateZoom(100));
elements.zoomPercent.addEventListener("change", () => updateZoom(elements.zoomPercent.value));
elements.zoomPercent.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    updateZoom(elements.zoomPercent.value);
    elements.zoomPercent.select();
  }
});
elements.displaySettings.addEventListener("click", () => {
  const opening = elements.displayPanel.hidden;
  if (opening && state.autoResolution && elements.frame.naturalWidth) {
    elements.resolutionWidth.value = String(elements.frame.naturalWidth);
    elements.resolutionHeight.value = String(elements.frame.naturalHeight);
  }
  elements.displayPanel.hidden = !opening;
  elements.displaySettings.setAttribute("aria-expanded", String(opening));
});
elements.autoResolution.addEventListener("change", () => {
  elements.resolutionWidth.disabled = elements.autoResolution.checked;
  elements.resolutionHeight.disabled = elements.autoResolution.checked;
});
elements.resolutionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  state.autoResolution = elements.autoResolution.checked;
  if (state.autoResolution) sendResize(true);
  else {
    const width = Math.min(3840, Math.max(320, Number(elements.resolutionWidth.value) || 1440));
    const height = Math.min(2160, Math.max(240, Number(elements.resolutionHeight.value) || 900));
    elements.resolutionWidth.value = String(width);
    elements.resolutionHeight.value = String(height);
    send({ type: "resize", width, height });
  }
  elements.displayPanel.hidden = true;
  elements.displaySettings.setAttribute("aria-expanded", "false");
});
document.addEventListener("pointerdown", (event) => {
  if (!elements.displayPanel.hidden && !elements.displayPanel.contains(event.target) && !elements.displaySettings.contains(event.target)) {
    elements.displayPanel.hidden = true;
    elements.displaySettings.setAttribute("aria-expanded", "false");
  }
});
elements.mobileInput.addEventListener("beforeinput", (event) => {
  if (!state.connected || event.isComposing) return;
  if (event.inputType === "insertText" && event.data) send({ type: "text", text: event.data });
  else if (event.inputType === "deleteContentBackward") {
    send({ type: "key", event: "down", key: "Backspace", code: "Backspace", keyCode: 8 });
    send({ type: "key", event: "up", key: "Backspace", code: "Backspace", keyCode: 8 });
  } else if (event.inputType === "insertLineBreak") {
    send({ type: "key", event: "down", key: "Enter", code: "Enter", keyCode: 13 });
    send({ type: "key", event: "up", key: "Enter", code: "Enter", keyCode: 13 });
  } else return;
  event.preventDefault();
});
elements.mobileInput.addEventListener("compositionend", (event) => {
  if (state.connected && event.data) send({ type: "text", text: event.data });
  elements.mobileInput.value = "";
});

if (queryToken) connect(queryToken);
