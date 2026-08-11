import { randomUUID } from "node:crypto";
import { WebRtcBrowserSession } from "./webrtc-session.js";

export class SessionManager {
  constructor(config) {
    this.config = config;
    this.sessions = new Map();
    this.sweepTimer = setInterval(() => this.sweep(), 30_000).unref();
  }

  get size() { return this.sessions.size; }

  async create(offer) {
    if (this.sessions.size >= this.config.maxSessions) throw new Error("会话已满，请稍后重试");
    const id = randomUUID();
    const session = new WebRtcBrowserSession(this.config, {
      onClose: () => this.sessions.delete(id),
    });
    this.sessions.set(id, session);
    try {
      const answer = await session.acceptOffer(offer);
      return { id, answer };
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  async remove(id) {
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    await session?.close();
  }

  sweep(now = Date.now()) {
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity > this.config.idleTimeoutMs) this.remove(id);
    }
  }

  async close() {
    clearInterval(this.sweepTimer);
    await Promise.allSettled([...this.sessions.values()].map((session) => session.close()));
    this.sessions.clear();
  }
}
