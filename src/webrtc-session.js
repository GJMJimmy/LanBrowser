import { RTCPeerConnection } from "werift";
import { EdgeSession } from "./edge-session.js";
import { encodeFrame } from "../public/stream.js";
import { WindowsAudioCapture } from "./audio-capture.js";

const MAX_CONTROL_MESSAGE = 16 * 1024;
const MAX_FRAME_BUFFER = 2 * 1024 * 1024;
const MAX_AUDIO_BUFFER = 128 * 1024;

export class WebRtcBrowserSession {
  constructor(config, callbacks = {}) {
    this.config = config;
    this.callbacks = callbacks;
    this.peer = new RTCPeerConnection({
      iceUseIpv4: true,
      iceUseIpv6: false,
      iceUseTcp: true,
    });
    this.edge = null;
    this.control = null;
    this.frames = null;
    this.audioChannel = null;
    this.audioCapture = null;
    this.audioFormat = null;
    this.closed = false;
    this.browserReady = false;
    this.disconnectTimer = null;
    this.lastActivity = Date.now();
    this.frameSequence = 0;
    this.peer.onDataChannel.subscribe((channel) => this.#bindChannel(channel));
    this.peer.connectionStateChange.subscribe((state) => {
      this.callbacks.onConnectionState?.(state);
      if (state === "connected") {
        clearTimeout(this.disconnectTimer);
        this.disconnectTimer = null;
      } else if (state === "disconnected") {
        clearTimeout(this.disconnectTimer);
        this.disconnectTimer = setTimeout(() => this.close(), 2_000);
      } else if (["failed", "closed"].includes(state)) this.close();
    });
  }

  async acceptOffer(offer) {
    if (!offer || offer.type !== "offer" || typeof offer.sdp !== "string") {
      throw new Error("WebRTC offer 无效");
    }
    await this.peer.setRemoteDescription(offer);
    const answer = await this.peer.createAnswer();
    await this.peer.setLocalDescription(answer);
    return this.peer.localDescription;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.disconnectTimer);
    this.control?.close();
    this.frames?.close();
    this.audioChannel?.close();
    this.audioCapture?.close();
    await Promise.allSettled([this.edge?.close(), this.peer.close()]);
    this.callbacks.onClose?.();
  }

  #bindChannel(channel) {
    if (channel.label === "control") {
      this.control = channel;
      channel.onMessage.subscribe((data) => this.#onControl(data));
      channel.stateChanged.subscribe((state) => {
        if (state === "open") this.#maybeStartBrowser();
        else if (state === "closed") this.close();
      });
    } else if (channel.label === "frames") {
      this.frames = channel;
      channel.bufferedAmountLowThreshold = 256 * 1024;
      channel.stateChanged.subscribe((state) => {
        if (state === "open") this.#maybeStartBrowser();
      });
    } else if (channel.label === "audio") {
      this.audioChannel = channel;
      channel.bufferedAmountLowThreshold = 128 * 1024;
      channel.stateChanged.subscribe((state) => {
        if (state === "open") this.#maybeStartAudio();
      });
    } else {
      channel.close();
    }
  }

  async #maybeStartBrowser() {
    if (this.edge || this.closed || this.control?.readyState !== "open" || this.frames?.readyState !== "open") return;
    this.edge = new EdgeSession(this.config, {
      onFrame: (frame) => this.#sendFrame(frame),
      onState: (state) => this.#sendControl(state),
    });
    this.#sendControl({ type: "status", state: "starting", message: "正在启动服务端浏览器" });
    try {
      await this.edge.start();
      this.browserReady = true;
      this.#sendControl({ type: "status", state: "ready", message: "已连接" });
      await this.#maybeStartAudio();
    } catch (error) {
      this.#sendControl({ type: "error", message: error.message || "浏览器启动失败" });
      await this.close();
    }
  }

  async #onControl(data) {
    this.lastActivity = Date.now();
    if (typeof data !== "string" || Buffer.byteLength(data) > MAX_CONTROL_MESSAGE) return;
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (message.type === "disconnect") {
      await this.close();
      return;
    }
    if (!this.edge || !this.browserReady) return;
    try {
      await this.edge.command(message);
    } catch (error) {
      this.#sendControl({ type: "error", message: error.message || "操作失败" });
    }
  }

  #sendControl(message) {
    if (this.control?.readyState === "open") this.control.send(JSON.stringify(message));
  }

  #sendFrame(frame) {
    if (this.frames?.readyState !== "open") return;
    if (this.frames.bufferedAmount > MAX_FRAME_BUFFER) return;
    this.frameSequence = (this.frameSequence + 1) >>> 0 || 1;
    this.frames.send(encodeFrame(this.frameSequence, frame));
  }

  async #maybeStartAudio() {
    if (!this.config.audio || this.audioCapture || !this.edge || this.audioChannel?.readyState !== "open") return;
    this.audioCapture = new WindowsAudioCapture(this.config, {
      onFormat: (format) => {
        this.audioFormat = format;
        this.#sendControl({ type: "audio-format", ...format });
      },
      onData: (data) => {
        if (this.audioChannel?.readyState !== "open" || this.audioChannel.bufferedAmount > MAX_AUDIO_BUFFER) return;
        this.audioChannel.send(data);
      },
      onError: (error) => this.#sendControl({ type: "audio-error", message: error.message || "音频采集不可用" }),
    });
    try {
      await this.audioCapture.start();
    } catch (error) {
      this.#sendControl({ type: "audio-error", message: error.message || "音频采集不可用" });
    }
  }
}
