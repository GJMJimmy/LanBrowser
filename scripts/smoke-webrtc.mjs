import WebSocket from "ws";
import { RTCPeerConnection } from "werift";

const baseUrl = process.env.LAN_BROWSER_SMOKE_URL || "ws://127.0.0.1:7788/signal";
const token = process.env.LAN_BROWSER_SMOKE_TOKEN || "lan-browser-demo";
const timeoutMs = 45_000;

const withTimeout = (promise, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}超时`)), timeoutMs)),
]);

const peer = new RTCPeerConnection({ iceUseIpv4: true, iceUseIpv6: false });
const control = peer.createDataChannel("control", { ordered: true });
const frames = peer.createDataChannel("frames", { ordered: false, maxRetransmits: 0 });

const controlOpen = control.readyState === "open" ? Promise.resolve() : control.stateChanged.watch((state) => state === "open");
const framesOpen = frames.readyState === "open" ? Promise.resolve() : frames.stateChanged.watch((state) => state === "open");
const firstFrame = frames.onMessage.asPromise();
let reportedError = "";
const readyState = new Promise((resolve) => {
  control.onMessage.subscribe((data) => {
    if (typeof data !== "string") return;
    const message = JSON.parse(data);
    if (message.type === "status" && message.state === "ready") resolve(message);
    if (message.type === "error") reportedError = message.message;
  });
});

const offer = await peer.createOffer();
await peer.setLocalDescription(offer);

const ws = new WebSocket(`${baseUrl}?token=${encodeURIComponent(token)}`);
await withTimeout(new Promise((resolve, reject) => {
  ws.once("open", resolve);
  ws.once("error", reject);
}), "信令连接");
ws.send(JSON.stringify({ type: "offer", offer: peer.localDescription }));

const answer = await withTimeout(new Promise((resolve, reject) => {
  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === "answer") resolve(message.answer);
    else if (message.type === "error") reject(new Error(message.message));
  });
  ws.once("close", () => reject(new Error("信令连接提前关闭")));
}), "SDP answer");
await peer.setRemoteDescription(answer);
await withTimeout(Promise.all([controlOpen, framesOpen]), "DataChannel");
await withTimeout(readyState, "服务端 Edge 启动");
const [frame] = await withTimeout(firstFrame, "首帧画面");

if (!Buffer.isBuffer(frame) || frame.length < 1024 || frame[0] !== 0xff || frame[1] !== 0xd8) {
  throw new Error("收到的首帧不是有效 JPEG");
}

console.log(JSON.stringify({ ok: true, frameBytes: frame.length, connectionState: peer.connectionState, reportedError }));
ws.close();
control.close();
frames.close();
await peer.close();
