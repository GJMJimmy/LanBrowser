import WebSocket from "ws";

export class CdpConnection {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async connect(timeoutMs = 8_000) {
    this.socket = new WebSocket(this.url, { perMessageDeflate: false });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket.terminate();
        reject(new Error("CDP WebSocket 连接超时"));
      }, timeoutMs);
      this.socket.once("open", () => { clearTimeout(timer); resolve(); });
      this.socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    this.socket.on("message", (data) => this.#onMessage(data));
    this.socket.on("close", () => this.#rejectPending(new Error("CDP 连接已关闭")));
  }

  send(method, params = {}, sessionId, timeoutMs = 10_000) {
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error("CDP 尚未连接"));
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 请求超时`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.socket.send(JSON.stringify(message));
    });
  }

  on(method, handler) {
    const handlers = this.listeners.get(method) || new Set();
    handlers.add(handler);
    this.listeners.set(method, handlers);
    return () => handlers.delete(handler);
  }

  close() {
    this.socket?.close();
    this.#rejectPending(new Error("CDP 连接已关闭"));
  }

  #onMessage(data) {
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result || {});
      return;
    }
    const handlers = this.listeners.get(message.method);
    if (handlers) for (const handler of handlers) handler(message.params || {}, message.sessionId);
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
