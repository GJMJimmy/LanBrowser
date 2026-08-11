import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CdpConnection } from "./cdp.js";
import { normalizeNavigation } from "./url-policy.js";

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
    this.framePending = false;
    this.lastActivity = Date.now();
    this.browserError = "";
    this.targets = [];
    this.targetIndex = -1;
    this.targetSwitch = Promise.resolve();
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
    this.targets.push({ targetId, sessionId: attached.sessionId });
    this.targetIndex = 0;

    this.cdp.on("Page.screencastFrame", (params, sessionId) => {
      this.cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId }, sessionId).catch(() => {});
      if (sessionId !== this.sessionId) return;
      if (!this.framePending) {
        this.framePending = true;
        Promise.resolve(this.callbacks.onFrame?.(Buffer.from(params.data, "base64")))
          .finally(() => { this.framePending = false; });
      }
    });
    this.cdp.on("Page.frameNavigated", (params, sessionId) => {
      if (sessionId === this.sessionId && !params.frame.parentId) this.#emitPageState();
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
      this.targets.splice(index, 1);
      if (index < this.targetIndex) this.targetIndex -= 1;
    });
    await step("监听新标签页", this.cdp.send("Target.setDiscoverTargets", { discover: true }));

    await step("启用页面", this.cdp.send("Page.enable", {}, this.sessionId));
    await step("启用脚本环境", this.cdp.send("Runtime.enable", {}, this.sessionId));
    await step("设置画面尺寸", this.resize(this.width, this.height));
    await step("启动画面流", this.#startScreencast(this.sessionId));
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
      case "resize": return this.resize(message.width, message.height);
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
    await this.cdp.send("Emulation.setDeviceMetricsOverride", {
      width: this.width,
      height: this.height,
      deviceScaleFactor: 1,
      mobile: false,
    }, this.sessionId);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try { await this.cdp?.send("Browser.close"); } catch {}
    this.cdp?.close();
    if (this.process && this.process.exitCode === null) this.process.kill();
    if (this.profileDir) await rm(this.profileDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }

  async #mouse(message) {
    const allowed = new Set(["mousePressed", "mouseReleased", "mouseMoved"]);
    if (!allowed.has(message.event)) throw new Error("无效的鼠标事件");
    const result = await this.cdp.send("Input.dispatchMouseEvent", {
      type: message.event,
      x: Math.max(0, Math.min(this.width, Number(message.x) || 0)),
      y: Math.max(0, Math.min(this.height, Number(message.y) || 0)),
      button: ["left", "middle", "right"].includes(message.button) ? message.button : "none",
      buttons: Number(message.buttons) || 0,
      clickCount: Math.min(3, Math.max(0, Number(message.clickCount) || 0)),
      modifiers: Number(message.modifiers) || 0,
    }, this.sessionId);
    if (message.event === "mouseReleased") await this.#emitFocusState();
    return result;
  }

  #wheel(message) {
    return this.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: Math.max(0, Math.min(this.width, Number(message.x) || 0)),
      y: Math.max(0, Math.min(this.height, Number(message.y) || 0)),
      deltaX: Math.max(-1200, Math.min(1200, Number(message.deltaX) || 0)),
      deltaY: Math.max(-1200, Math.min(1200, Number(message.deltaY) || 0)),
      modifiers: Number(message.modifiers) || 0,
    }, this.sessionId);
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
    const targetIndex = this.targetIndex + offset;
    if (targetIndex >= 0 && targetIndex < this.targets.length) return this.#activateTarget(targetIndex);
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

  async #attachPopup(targetId) {
    const attached = await this.cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const nextIndex = this.targets.length;
    this.targets.push({ targetId, sessionId: attached.sessionId });
    await this.#activateTarget(nextIndex, true);
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
    await this.cdp.send("Page.bringToFront", {}, this.sessionId).catch(() => {});
    await this.cdp.send("Emulation.setDeviceMetricsOverride", {
      width: this.width,
      height: this.height,
      deviceScaleFactor: 1,
      mobile: false,
    }, this.sessionId);
    await this.#startScreencast(this.sessionId);
    await this.#emitPageState();
  }

  async #emitPageState() {
    try {
      const result = await this.cdp.send("Runtime.evaluate", {
        expression: "JSON.stringify({url:location.href,title:document.title})",
        returnByValue: true,
      }, this.sessionId);
      const state = JSON.parse(result.result?.value || "{}");
      this.callbacks.onState?.({ type: "page", ...state, loading: false });
    } catch {}
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
