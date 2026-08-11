import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { audioAssets } from "./generated-audio.js";
import { PcmChunkAligner } from "./audio-protocol.js";

const HEADER_SIZE = 16;

async function writeAsset(path, base64) {
  if (existsSync(path)) return;
  await writeFile(path, Buffer.from(base64, "base64"));
}

async function audioRuntime(config) {
  if (process.env.NODE_ENV !== "production") {
    return {
      helper: resolve("vendor/audio/LanBrowser.AudioCapture.exe"),
      cwd: resolve("vendor/audio"),
    };
  }
  const version = createHash("sha256").update(audioAssets.helper).digest("hex").slice(0, 12);
  const cwd = join(config.dataDir, "audio-runtime", version);
  await mkdir(cwd, { recursive: true });
  const helper = join(cwd, "LanBrowser.AudioCapture.exe");
  await Promise.all([
    writeAsset(helper, audioAssets.helper),
    writeAsset(join(cwd, "NAudio.dll"), audioAssets.naudio),
  ]);
  return { helper, cwd };
}

export class WindowsAudioCapture {
  constructor(config, callbacks = {}) {
    this.config = config;
    this.callbacks = callbacks;
    this.process = null;
    this.pending = Buffer.alloc(0);
    this.headerRead = false;
    this.closed = false;
    this.errorText = "";
    this.aligner = null;
  }

  async start() {
    const runtime = await audioRuntime(this.config);
    if (!existsSync(runtime.helper)) throw new Error("音频采集组件不存在，请重新构建程序");
    this.process = spawn(runtime.helper, [String(process.pid)], {
      cwd: runtime.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.process.stdout.on("data", (chunk) => this.#onData(chunk));
    this.process.stderr.on("data", (chunk) => { this.errorText = (this.errorText + chunk).slice(-2000); });
    this.process.once("error", (error) => this.callbacks.onError?.(error));
    this.process.once("exit", (code) => {
      if (!this.closed && code !== 0) this.callbacks.onError?.(new Error(this.errorText.trim() || `音频采集进程退出 (${code})`));
    });
  }

  close() {
    this.closed = true;
    if (this.process && this.process.exitCode === null) this.process.kill();
  }

  #onData(chunk) {
    if (!this.headerRead) {
      this.pending = Buffer.concat([this.pending, chunk]);
      if (this.pending.length < HEADER_SIZE) return;
      if (this.pending.subarray(0, 4).toString("ascii") !== "LBAU") {
        this.callbacks.onError?.(new Error("音频采集协议无效"));
        this.close();
        return;
      }
      this.headerRead = true;
      const format = {
        sampleRate: this.pending.readUInt32LE(4),
        channels: this.pending.readUInt16LE(8),
        bitsPerSample: this.pending.readUInt16LE(10),
        encoding: this.pending.readUInt8(12) === 1 ? "float" : "pcm",
      };
      this.aligner = new PcmChunkAligner(format.channels * format.bitsPerSample / 8);
      this.callbacks.onFormat?.(format);
      const remainder = this.pending.subarray(HEADER_SIZE);
      this.pending = Buffer.alloc(0);
      if (remainder.length) this.#emitAudio(remainder);
      return;
    }
    this.#emitAudio(chunk);
  }

  #emitAudio(chunk) {
    const aligned = this.aligner?.push(chunk);
    if (aligned?.length) this.callbacks.onData?.(aligned);
  }
}
