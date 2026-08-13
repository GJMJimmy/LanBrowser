import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CdpConnection } from "./cdp.js";
import { normalizeNavigation } from "./url-policy.js";
import { normalizeZoom, zoomFactor } from "../public/zoom.js";

const EDGE_LOCATIONS = [
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe"),
  process.env["PROGRAMFILES(X86)"] && join(process.env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe"),
].filter(Boolean);

const CHROME_LOCATIONS = [
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
  process.env["PROGRAMFILES(X86)"] && join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
].filter(Boolean);

export function findEdge(customPath = "") {
  if (customPath && existsSync(customPath)) return customPath;
  return [...EDGE_LOCATIONS, ...CHROME_LOCATIONS].find(existsSync) || "";
}

const findBrowserCandidates = (customPath) => {
  if (customPath) return existsSync(customPath) ? [customPath] : [];
  return [...new Set([...EDGE_LOCATIONS, ...CHROME_LOCATIONS].filter(existsSync))];
};

const waitForDevTools = async (file, timeoutMs = 5_000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const [port, path] = (await readFile(file, "utf8")).trim().split(/\r?\n/);
      if (port && path) return `ws://127.0.0.1:${port}${path}`;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error("等待 Edge 调试端口超时");
};

const AUDIO_BINDING = "__lanBrowserAudio";
const AUDIO_CAPTURE_SCRIPT = `(() => {
  if (window.__lanBrowserStartAudio) return;
  const send = (message) => window.${AUDIO_BINDING}(JSON.stringify(message));
  window.__lanBrowserStopAudio = async () => {
    const state = window.__lanBrowserAudioState;
    window.__lanBrowserAudioState = null;
    if (!state) return;
    state.processor.onaudioprocess = null;
    state.processor.disconnect();
    state.source.disconnect();
    for (const track of state.stream.getTracks()) track.stop();
    await state.context.close();
  };
  window.__lanBrowserStartAudio = async () => {
    await window.__lanBrowserStopAudio();
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { suppressLocalAudioPlayback: true, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    for (const track of stream.getVideoTracks()) track.stop();
    if (!stream.getAudioTracks().length) throw new Error("浏览器未提供标签页音轨");
    const context = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    const source = context.createMediaStreamSource(stream);
    const channels = 2;
    const processor = context.createScriptProcessor(2048, channels, channels);
    const silent = context.createGain();
    silent.gain.value = 0;
    let quietBlocks = 0;
    let silenceReported = false;
    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer;
      const channelCount = Math.max(1, Math.min(2, input.numberOfChannels));
      const frames = input.length;
      const bytes = new Uint8Array(frames * channelCount * 4);
      const view = new DataView(bytes.buffer);
      const channelData = Array.from({ length: channelCount }, (_, index) => input.getChannelData(index));
      let peak = 0;
      for (let frame = 0; frame < frames; frame += 1) {
        for (let channel = 0; channel < channelCount; channel += 1) {
          const sample = channelData[channel][frame];
          peak = Math.max(peak, Math.abs(sample));
          view.setFloat32((frame * channelCount + channel) * 4, sample, true);
        }
      }
      if (peak < 0.0001) {
        quietBlocks += 1;
        if (quietBlocks >= 3 && !silenceReported) {
          silenceReported = true;
          send({ type: "reset" });
        }
        if (silenceReported) return;
      } else {
        quietBlocks = 0;
        silenceReported = false;
      }
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 8192) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      }
      send({ type: "data", data: btoa(binary) });
    };
    source.connect(processor);
    processor.connect(silent);
    silent.connect(context.destination);
    await context.resume();
    window.__lanBrowserAudioState = { context, source, processor, stream };
    return true;
  };
})()`;

export class EdgeSession {
  constructor(config, callbacks = {}) {
    this.config = config;
    this.callbacks = callbacks;
    this.process = null;
    this.cdp = null;
    this.sessionId = null;
    this.profileDir = "";
    this.closed = false;
    this.width = config.frameWidth;
    this.height = config.frameHeight;
    this.zoom = 100;
    this.framePending = false;
    this.frameGeneration = 0;
    this.screencastUpdate = Promise.resolve();
    this.lastActivity = Date.now();
    this.browserError = "";
    this.targets = [];
    this.targetIndex = -1;
    this.targetSwitch = Promise.resolve();
    this.captureSessionId = null;
    this.captureTitle = `VIRTUAL_BROWSER_AUDIO_${randomUUID()}`;
    this.audioReady = false;
  }

  async start() {
    const browserPaths = findBrowserCandidates(this.config.edgePath);
    if (!browserPaths.length) throw new Error("未找到 Microsoft Edge 或 Google Chrome，请设置 LAN_BROWSER_EDGE_PATH");
    const baseArgs = [
      "--headless=new",
      "--disable-gpu",
      "--in-process-gpu",
      "--disable-software-rasterizer",
      "--disable-webgl",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--no-first-run",
      "--no-default-browser-check",
      "--autoplay-policy=no-user-gesture-required",
      `--auto-select-tab-capture-source-by-title=${this.captureTitle}`,
      "--disable-features=Translate,OptimizationHints,MediaRouter",
      "--remote-debugging-port=0",
    ];
    if (this.config.noSandbox) baseArgs.push("--no-sandbox");
    if (this.config.outboundProxy) baseArgs.push(`--proxy-server=${this.config.outboundProxy}`);

    let wsUrl = "";
    for (const browserPath of browserPaths) {
      this.profileDir = join(this.config.dataDir, "sessions", randomUUID());
      await mkdir(this.profileDir, { recursive: true });
      this.browserError = "";
      this.process = spawn(browserPath, [...baseArgs, `--user-data-dir=${this.profileDir}`, "about:blank"], {
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      });
      this.process.stderr.on("data", (chunk) => {
        this.browserError = (this.browserError + chunk.toString()).slice(-2000);
      });
      try {
        wsUrl = await waitForDevTools(join(this.profileDir, "DevToolsActivePort"));
        break;
      } catch {
        if (this.process.exitCode === null) this.process.kill();
        await rm(this.profileDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
      }
    }
    if (!wsUrl) throw new Error("Edge/Chrome 无头模式启动失败，请设置 LAN_BROWSER_EDGE_PATH");
    const step = async (name, operation) => {
      try { return await operation; }
      catch (error) {
        const detail = this.browserError.trim().split(/\r?\n/).at(-1);
        throw new Error(`${name}失败: ${error.message}${detail ? ` (${detail})` : ""}`);
      }
    };
    this.cdp = new CdpConnection(wsUrl);
    await step("连接浏览器", this.cdp.connect());
    const { targetId } = await step("创建页面", this.cdp.send("Target.createTarget", { url: "about:blank" }));
    const attached = await step("附加页面", this.cdp.send("Target.attachToTarget", { targetId, flatten: true }));
    this.sessionId = attached.sessionId;
    this.targets.push({ targetId, sessionId: attached.sessionId, title: "新标签页", url: "about:blank" });
    this.targetIndex = 0;

    this.cdp.on("Page.screencastFrame", (params, sessionId) => {
      this.cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId }, sessionId).catch(() => {});
      if (sessionId !== this.sessionId) return;
      if (!this.framePending) {
        this.framePending = true;
        Promise.resolve(this.callbacks.onFrame?.(Buffer.from(params.data, "base64"), this.frameGeneration))
          .finally(() => { this.framePending = false; });
      }
    });
    this.cdp.on("Page.frameNavigated", (params, sessionId) => {
      if (sessionId === this.sessionId && !params.frame.parentId) {
        this.#restartScreencast(sessionId).catch((error) => {
          this.callbacks.onState?.({ type: "error", message: `更新页面画面失败: ${error.message}` });
        });
        this.#emitPageState();
      }
    });
    this.cdp.on("Page.loadEventFired", (_params, sessionId) => {
      if (sessionId === this.sessionId) this.#emitPageState();
    });
    this.cdp.on("Target.targetCreated", ({ targetInfo }) => {
      const openedByUs = targetInfo.type === "page" && this.targets.some((target) => target.targetId === targetInfo.openerId);
      if (!openedByUs || this.targets.some((target) => target.targetId === targetInfo.targetId)) return;
      this.targetSwitch = this.targetSwitch
        .then(() => this.#attachPopup(targetInfo.targetId))
        .catch((error) => this.callbacks.onState?.({ type: "error", message: `新标签页打开失败: ${error.message}` }));
    });
    this.cdp.on("Target.targetDestroyed", ({ targetId: destroyedId }) => {
      const index = this.targets.findIndex((target) => target.targetId === destroyedId);
      if (index < 0) return;
      const wasActive = index === this.targetIndex;
      this.targets.splice(index, 1);
      if (index < this.targetIndex) this.targetIndex -= 1;
      else if (index === this.targetIndex) this.targetIndex = Math.min(index, this.targets.length - 1);
      if (wasActive && this.targets.length) {
        this.targetSwitch = this.targetSwitch
          .then(() => this.#activateTarget(this.targetIndex))
          .catch((error) => this.callbacks.onState?.({ type: "error", message: `切换标签页失败: ${error.message}` }));
      } else this.#emitTabsState();
    });
    this.cdp.on("Runtime.bindingCalled", ({ name, payload }, sessionId) => {
      if (name !== AUDIO_BINDING || sessionId !== this.captureSessionId) return;
      try {
        const message = JSON.parse(payload);
        if (message.type === "data" && typeof message.data === "string") {
          this.callbacks.onAudioData?.(Buffer.from(message.data, "base64"));
        } else if (message.type === "reset") this.callbacks.onAudioReset?.();
      } catch (error) {
        this.callbacks.onAudioError?.(error);
      }
    });
    await step("监听新标签页", this.cdp.send("Target.setDiscoverTargets", { discover: true }));

    await step("启用页面", this.cdp.send("Page.enable", {}, this.sessionId));
    await step("启用脚本环境", this.cdp.send("Runtime.enable", {}, this.sessionId));
    await step("启动画面流", this.#restartScreencast(this.sessionId));
    if (this.config.audio) {
      try {
        await this.#initializeAudioCapture();
        this.audioReady = true;
      } catch (error) {
        this.callbacks.onAudioError?.(new Error(`启动标签页音频失败: ${error.message}`));
      }
    }
    try {
      await this.navigate(this.config.startUrl);
    } catch (error) {
      this.callbacks.onState?.({ type: "error", message: `起始页打开失败: ${error.message}` });
    }
  }

  async command(message) {
    this.lastActivity = Date.now();
    switch (message.type) {
      case "navigate": return this.navigate(message.url);
      case "back": return this.#history(-1);
      case "forward": return this.#history(1);
      case "reload": return this.cdp.send("Page.reload", { ignoreCache: false }, this.sessionId);
      case "tab-new": return this.#newTab(message.url);
      case "tab-activate": return this.#activateTargetById(message.id);
      case "tab-close": return this.#closeTab(message.id);
      case "resize": return this.resize(message.width, message.height);
      case "zoom": return this.setZoom(message.percent);
      case "hitTest": return this.#hitTest(message);
      case "mouse": return this.#mouse(message);
      case "wheel": return this.#wheel(message);
      case "key": return this.#key(message);
      case "text": return this.#text(message);
      default: throw new Error("不支持的控制命令");
    }
  }

  async navigate(input) {
    const url = normalizeNavigation(input, { blockPrivate: !this.config.allowPrivate });
    const result = await this.cdp.send("Page.navigate", { url }, this.sessionId);
    if (result.errorText) throw new Error(result.errorText);
    this.callbacks.onState?.({ type: "page", url, loading: true });
    return result;
  }

  async resize(width, height) {
    this.width = Math.round(Math.min(3840, Math.max(320, Number(width) || this.width)));
    this.height = Math.round(Math.min(2160, Math.max(240, Number(height) || this.height)));
    await this.#restartScreencast(this.sessionId);
  }

  async setZoom(percent) {
    this.zoom = normalizeZoom(percent, this.zoom);
    await this.#restartScreencast(this.sessionId);
    this.callbacks.onState?.({ type: "zoom", percent: this.zoom });
  }

  #applyMetrics(sessionId) {
    const factor = zoomFactor(this.zoom);
    return this.cdp.send("Emulation.setDeviceMetricsOverride", {
      width: Math.max(1, Math.round(this.width / factor)),
      height: Math.max(1, Math.round(this.height / factor)),
      deviceScaleFactor: factor,
      mobile: false,
    }, sessionId);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try { await this.cdp?.send("Browser.close"); } catch {}
    this.cdp?.close();
    if (this.process && this.process.exitCode === null) this.process.kill();
    if (this.profileDir) await rm(this.profileDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }

  async #initializeAudioCapture() {
    await this.#markCaptureTarget();
    const capture = await this.cdp.send("Target.createTarget", {
      url: this.config.captureUrl,
      background: true,
    });
    const attached = await this.cdp.send("Target.attachToTarget", { targetId: capture.targetId, flatten: true });
    this.captureSessionId = attached.sessionId;
    await this.cdp.send("Runtime.enable", {}, this.captureSessionId);
    await this.cdp.send("Runtime.addBinding", { name: AUDIO_BINDING }, this.captureSessionId);
    await this.cdp.send("Runtime.evaluate", { expression: AUDIO_CAPTURE_SCRIPT }, this.captureSessionId);
    await this.#restartAudioCapture();
    const target = this.targets[this.targetIndex];
    if (target) await this.cdp.send("Target.activateTarget", { targetId: target.targetId });
    await this.#restartScreencast(this.sessionId);
  }

  async #markCaptureTarget() {
    const result = await this.cdp.send("Runtime.evaluate", {
      expression: `(window.__lanBrowserOriginalTitle ??= document.title, document.title=${JSON.stringify(this.captureTitle)}, true)`,
      returnByValue: true,
    }, this.sessionId);
    return result.result?.value;
  }

  async #restartAudioCapture() {
    if (!this.captureSessionId) return;
    await this.#markCaptureTarget();
    try {
      const result = await this.cdp.send("Runtime.evaluate", {
        expression: "window.__lanBrowserStartAudio()",
        awaitPromise: true,
        returnByValue: true,
      }, this.captureSessionId, 20_000);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "标签页音频捕获失败");
    } finally {
      await this.cdp.send("Runtime.evaluate", {
        expression: "if (window.__lanBrowserOriginalTitle !== undefined) { document.title = window.__lanBrowserOriginalTitle; delete window.__lanBrowserOriginalTitle; }",
      }, this.sessionId).catch(() => {});
    }
  }

  async #mouse(message) {
    const allowed = new Set(["mousePressed", "mouseReleased", "mouseMoved"]);
    if (!allowed.has(message.event)) throw new Error("无效的鼠标事件");
    const result = await this.cdp.send("Input.dispatchMouseEvent", {
      type: message.event,
      x: this.#cssCoordinate(message.x, this.width),
      y: this.#cssCoordinate(message.y, this.height),
      button: ["left", "middle", "right"].includes(message.button) ? message.button : "none",
      buttons: Number(message.buttons) || 0,
      clickCount: Math.min(3, Math.max(0, Number(message.clickCount) || 0)),
      modifiers: Number(message.modifiers) || 0,
    }, this.sessionId);
    if (message.event === "mouseReleased") await this.#emitFocusState();
    return result;
  }

  async #hitTest(message) {
    const requestId = Math.max(0, Math.round(Number(message.requestId) || 0));
    const x = this.#cssCoordinate(message.x, this.width);
    const y = this.#cssCoordinate(message.y, this.height);
    const result = await this.cdp.send("Runtime.evaluate", {
      expression: `(() => {
        let element = document.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)});
        while (element?.shadowRoot) element = element.shadowRoot.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)}) || element;
        const labelControl = element?.closest?.("label")?.control;
        element = labelControl || element?.closest?.("input, textarea, [contenteditable]") || element;
        if (!element || element.disabled || element.readOnly) return { editable: false };
        const tag = element.tagName;
        const blocked = new Set(["button", "checkbox", "radio", "range", "color", "file", "submit", "reset", "image", "hidden"]);
        const inputType = tag === "INPUT" ? String(element.type || "text").toLowerCase() : "";
        const editable = tag === "TEXTAREA" || element.isContentEditable || (tag === "INPUT" && !blocked.has(inputType));
        return {
          editable,
          inputMode: editable ? (element.inputMode || (inputType === "number" ? "decimal" : "text")) : "text",
        };
      })()`,
      returnByValue: true,
    }, this.sessionId);
    this.callbacks.onState?.({ type: "hit-test", requestId, ...(result.result?.value || { editable: false }) });
  }

  #wheel(message) {
    const factor = zoomFactor(this.zoom);
    return this.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: this.#cssCoordinate(message.x, this.width),
      y: this.#cssCoordinate(message.y, this.height),
      deltaX: Math.max(-1200, Math.min(1200, (Number(message.deltaX) || 0) / factor)),
      deltaY: Math.max(-1200, Math.min(1200, (Number(message.deltaY) || 0) / factor)),
      modifiers: Number(message.modifiers) || 0,
    }, this.sessionId);
  }

  #cssCoordinate(value, maximum) {
    const pixels = Math.max(0, Math.min(maximum, Number(value) || 0));
    return pixels / zoomFactor(this.zoom);
  }

  #key(message) {
    const type = message.event === "up" ? "keyUp" : "keyDown";
    const printable = type === "keyDown" && typeof message.key === "string" && [...message.key].length === 1;
    return this.cdp.send("Input.dispatchKeyEvent", {
      type,
      key: String(message.key || "").slice(0, 32),
      code: String(message.code || "").slice(0, 32),
      text: printable && !message.ctrlKey && !message.altKey && !message.metaKey ? message.key : undefined,
      modifiers: Number(message.modifiers) || 0,
      windowsVirtualKeyCode: Number(message.keyCode) || 0,
      autoRepeat: Boolean(message.repeat),
    }, this.sessionId);
  }

  #text(message) {
    const text = String(message.text || "").slice(0, 4096);
    if (!text) return Promise.resolve();
    return this.cdp.send("Input.insertText", { text }, this.sessionId);
  }

  async #history(offset) {
    const history = await this.cdp.send("Page.getNavigationHistory", {}, this.sessionId);
    const target = history.entries?.[history.currentIndex + offset];
    if (target) return this.cdp.send("Page.navigateToHistoryEntry", { entryId: target.id }, this.sessionId);
  }

  #startScreencast(sessionId) {
    return this.cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: this.config.frameQuality,
      maxWidth: this.width,
      maxHeight: this.height,
      everyNthFrame: 1,
    }, sessionId);
  }

  #restartScreencast(sessionId) {
    const update = async () => {
      if (sessionId !== this.sessionId || this.closed) return;
      await this.cdp.send("Page.stopScreencast", {}, sessionId).catch(() => {});
      await this.#applyMetrics(sessionId);
      if (sessionId !== this.sessionId || this.closed) return;
      this.frameGeneration = (this.frameGeneration + 1) >>> 0 || 1;
      await this.#startScreencast(sessionId);
    };
    this.screencastUpdate = this.screencastUpdate.then(update, update);
    return this.screencastUpdate;
  }

  async #attachPopup(targetId) {
    const attached = await this.cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const nextIndex = this.targets.length;
    this.targets.push({ targetId, sessionId: attached.sessionId, title: "新标签页", url: "about:blank" });
    await this.#activateTarget(nextIndex, true);
  }

  async #newTab(input = "about:blank") {
    const url = input && input !== "about:blank"
      ? normalizeNavigation(input, { blockPrivate: !this.config.allowPrivate })
      : "about:blank";
    const { targetId } = await this.cdp.send("Target.createTarget", { url });
    const attached = await this.cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const nextIndex = this.targets.length;
    this.targets.push({ targetId, sessionId: attached.sessionId, title: "新标签页", url });
    await this.#activateTarget(nextIndex, true);
  }

  #activateTargetById(id) {
    const index = this.targets.findIndex((target) => target.targetId === String(id || ""));
    if (index < 0) throw new Error("标签页不存在");
    return this.#activateTarget(index);
  }

  async #closeTab(id) {
    if (this.targets.length <= 1) return;
    const index = this.targets.findIndex((target) => target.targetId === String(id || ""));
    if (index < 0) throw new Error("标签页不存在");
    const target = this.targets[index];
    if (index === this.targetIndex) {
      const nextIndex = index === this.targets.length - 1 ? index - 1 : index + 1;
      await this.#activateTarget(nextIndex);
    }
    await this.cdp.send("Target.closeTarget", { targetId: target.targetId });
  }

  async #activateTarget(index, initialize = false) {
    const target = this.targets[index];
    if (!target) return;
    const previousSession = this.sessionId;
    if (previousSession && previousSession !== target.sessionId) {
      await this.cdp.send("Page.stopScreencast", {}, previousSession).catch(() => {});
    }
    this.sessionId = target.sessionId;
    this.targetIndex = index;
    if (initialize) {
      await this.cdp.send("Page.enable", {}, this.sessionId);
      await this.cdp.send("Runtime.enable", {}, this.sessionId);
    }
    await this.cdp.send("Target.activateTarget", { targetId: target.targetId }).catch(() => {});
    if (this.audioReady) await this.#restartAudioCapture();
    await this.#restartScreencast(this.sessionId);
    await this.#emitPageState();
    this.#emitTabsState();
  }

  async #emitPageState() {
    try {
      const result = await this.cdp.send("Runtime.evaluate", {
        expression: "JSON.stringify({url:location.href,title:document.title})",
        returnByValue: true,
      }, this.sessionId);
      const state = JSON.parse(result.result?.value || "{}");
      const target = this.targets[this.targetIndex];
      if (target) Object.assign(target, { title: state.title || "新标签页", url: state.url || "about:blank" });
      this.callbacks.onState?.({ type: "page", ...state, loading: false });
      this.#emitTabsState();
    } catch {}
  }

  #emitTabsState() {
    this.callbacks.onState?.({
      type: "tabs",
      activeId: this.targets[this.targetIndex]?.targetId || "",
      tabs: this.targets.map((target) => ({
        id: target.targetId,
        title: target.title || "新标签页",
        url: target.url || "about:blank",
      })),
    });
  }

  async #emitFocusState() {
    try {
      const result = await this.cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const element = document.activeElement;
          if (!element) return { editable: false };
          const tag = element.tagName;
          const blocked = new Set(["button", "checkbox", "radio", "range", "color", "file", "submit", "reset", "image", "hidden"]);
          const inputType = tag === "INPUT" ? String(element.type || "text").toLowerCase() : "";
          return {
            editable: tag === "TEXTAREA" || element.isContentEditable || (tag === "INPUT" && !blocked.has(inputType)),
            inputMode: element.inputMode || (inputType === "number" ? "decimal" : "text"),
            multiline: tag === "TEXTAREA" || element.isContentEditable,
          };
        })()`,
        returnByValue: true,
      }, this.sessionId);
      this.callbacks.onState?.({ type: "focus", ...(result.result?.value || { editable: false }) });
    } catch {}
  }
}
