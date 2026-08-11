import { spawn } from "node:child_process";
import { resolve } from "node:path";

const helper = spawn(resolve("vendor/audio/LanBrowser.AudioCapture.exe"), [String(process.pid)], {
  cwd: resolve("vendor/audio"),
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
const chunks = [];
let helperError = "";
helper.stdout.on("data", (chunk) => chunks.push(chunk));
helper.stderr.on("data", (chunk) => { helperError += chunk; });

await new Promise((resolveWait) => setTimeout(resolveWait, 500));
const player = spawn("ffplay", [
  "-nodisp", "-autoexit", "-loglevel", "error", "-volume", "20",
  "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=1.5",
], { windowsHide: true, stdio: "ignore" });
await new Promise((resolveWait, reject) => {
  player.once("exit", (code) => code === 0 ? resolveWait() : reject(new Error(`ffplay 退出 (${code})`)));
  player.once("error", reject);
});
await new Promise((resolveWait) => setTimeout(resolveWait, 300));
helper.kill();
await new Promise((resolveWait) => helper.once("exit", resolveWait));

const data = Buffer.concat(chunks);
if (data.length < 20 || data.subarray(0, 4).toString("ascii") !== "LBAU") {
  throw new Error(helperError.trim() || "没有收到音频采集数据");
}
const format = {
  sampleRate: data.readUInt32LE(4),
  channels: data.readUInt16LE(8),
  bitsPerSample: data.readUInt16LE(10),
  encoding: data.readUInt8(12) === 1 ? "float" : "pcm",
};
let sumSquares = 0;
let samples = 0;
if (format.encoding === "float" && format.bitsPerSample === 32) {
  for (let offset = 16; offset + 4 <= data.length; offset += 4) {
    const value = data.readFloatLE(offset);
    if (Number.isFinite(value)) {
      sumSquares += value * value;
      samples += 1;
    }
  }
} else if (format.bitsPerSample === 16) {
  for (let offset = 16; offset + 2 <= data.length; offset += 2) {
    const value = data.readInt16LE(offset) / 32768;
    sumSquares += value * value;
    samples += 1;
  }
} else {
  throw new Error(`测试脚本暂不支持 ${format.encoding}/${format.bitsPerSample}bit`);
}
const rms = Math.sqrt(sumSquares / Math.max(1, samples));
if (rms < 0.0001) throw new Error(`采集到的音频为静音 (RMS ${rms})`);
console.log(JSON.stringify({ ok: true, bytes: data.length - 16, rms, ...format }));
