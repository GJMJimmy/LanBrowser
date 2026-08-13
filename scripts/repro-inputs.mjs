import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import WebSocket from "ws";
import { RTCPeerConnection } from "werift";

const appPort = 7798;
let fixturePort = 0;
const token = "input-repro-token";
const timeout = (promise, label, ms = 20_000) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}超时`)), ms)),
]);
const hash = (data) => createHash("sha256").update(data).digest("hex");

const fixture = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  if (req.url === "/linked") {
    res.end("<!doctype html><title>linked</title><style>body{background:#13795b;color:white;font:48px sans-serif}</style>LINKED");
    return;
  }
  res.end(`<!doctype html><title>fixture</title><style>
    *{box-sizing:border-box}html,body{margin:0}body{height:3200px;background:repeating-linear-gradient(#f4c95d 0 400px,#e85d75 400px 800px,#4ea5d9 800px 1200px)}
    a,button,input{position:fixed;left:20px;width:220px;height:48px;z-index:10;font:16px sans-serif}
    a{top:20px;padding:14px;background:#111;color:#fff}button{top:82px}input{top:144px;padding:8px}
  </style><a href="/linked" target="_blank">OPEN LINK</a><button id="sound">PLAY SOUND</button><input id="text" placeholder="TYPE HERE"><script>
    let context, oscillator;
    document.querySelector('#sound').onclick=()=>{
      if (oscillator) { oscillator.stop(); oscillator=null; return; }
      context ||= new AudioContext();
      oscillator=context.createOscillator();oscillator.frequency.value=880;oscillator.connect(context.destination);oscillator.start();
    };
  </script>`);
});

const waitForHealth = async () => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${appPort}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("服务启动失败");
};

const waitForNoSessions = async () => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${appPort}/health`);
    const health = await response.json();
    if (health.sessions === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("客户端断开后服务端会话未释放");
};

const connectClient = async () => {
  const peer = new RTCPeerConnection({ iceUseIpv4: true, iceUseIpv6: false });
  const control = peer.createDataChannel("control", { ordered: true });
  const frames = peer.createDataChannel("frames", { ordered: false, maxRetransmits: 0 });
  const audio = peer.createDataChannel("audio", { ordered: true, maxRetransmits: 0 });
  let lastFrame = null;
  let audioChunks = [];
  const messages = [];
  frames.onMessage.subscribe((data) => { if (Buffer.isBuffer(data)) lastFrame = data; });
  audio.onMessage.subscribe((data) => {
    if (Buffer.isBuffer(data)) audioChunks.push(data);
    else if (data === "reset") audioChunks = [];
  });
  control.onMessage.subscribe((data) => {
    if (typeof data !== "string") return;
    const message = JSON.parse(data);
    messages.push(message);
  });
  const channelsOpen = Promise.all([
    control.stateChanged.watch((state) => state === "open"),
    frames.stateChanged.watch((state) => state === "open"),
    audio.stateChanged.watch((state) => state === "open"),
  ]);

  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  const ws = new WebSocket(`ws://127.0.0.1:${appPort}/signal?token=${token}`);
  await timeout(new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); }), "信令连接");
  ws.send(JSON.stringify({ type: "offer", offer: peer.localDescription }));
  const answer = await timeout(new Promise((resolve, reject) => {
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "answer") resolve(message.answer);
      if (message.type === "error") reject(new Error(message.message));
    });
  }), "SDP answer");
  await peer.setRemoteDescription(answer);
  await timeout(channelsOpen, "DataChannel");
  await timeout(control.onMessage.watch((data) => typeof data === "string" && JSON.parse(data).state === "ready"), "浏览器启动", 40_000);
  await timeout(frames.onMessage.watch((data) => Buffer.isBuffer(data)), "首帧", 10_000);
  return {
    peer, control, frames, audio, messages,
    getLastFrame: () => lastFrame,
    takeAudio: () => { const result = Buffer.concat(audioChunks); audioChunks = []; return result; },
    close: async () => {
      if (control.readyState === "open") control.send(JSON.stringify({ type: "disconnect" }));
      await new Promise((resolve) => setTimeout(resolve, 80));
      ws.close(); control.close(); frames.close(); audio.close(); await peer.close();
    },
  };
};

const audioRms = (data, format) => {
  let sum = 0;
  let count = 0;
  if (format.encoding === "float" && format.bitsPerSample === 32) {
    for (let offset = 0; offset + 4 <= data.length; offset += 4) {
      const value = data.readFloatLE(offset);
      if (Number.isFinite(value)) { sum += value * value; count += 1; }
    }
  } else if (format.bitsPerSample === 16) {
    for (let offset = 0; offset + 2 <= data.length; offset += 2) {
      const value = data.readInt16LE(offset) / 32768;
      sum += value * value;
      count += 1;
    }
  }
  return Math.sqrt(sum / Math.max(1, count));
};

let browserService;
try {
  await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  fixturePort = fixture.address().port;
  const serverExecutable = process.env.LAN_BROWSER_REPRO_EXE || process.execPath;
  const serverArgs = ["--port", String(appPort), "--token", token, "--no-sandbox", "--allow-private", "--start-url", `http://127.0.0.1:${fixturePort}/`];
  if (!process.env.LAN_BROWSER_REPRO_EXE) serverArgs.unshift("src/server.js");
  browserService = spawn(serverExecutable, serverArgs, {
    cwd: new URL("..", import.meta.url),
    windowsHide: true,
    stdio: ["ignore", "ignore", "inherit"],
  });
  await waitForHealth();
  const client = await connectClient();
  try {
    await new Promise((resolve) => setTimeout(resolve, 500));
    client.takeAudio();
    client.control.send(JSON.stringify({ type: "mouse", event: "mousePressed", x: 100, y: 105, button: "left", buttons: 1, clickCount: 1, modifiers: 0 }));
    client.control.send(JSON.stringify({ type: "mouse", event: "mouseReleased", x: 100, y: 105, button: "left", buttons: 0, clickCount: 1, modifiers: 0 }));
    const cachedAudioFormat = client.messages.find((message) => message.type === "audio-format");
    const audioFormat = cachedAudioFormat || JSON.parse(await timeout(client.control.onMessage.watch((data) => {
      if (typeof data !== "string") return false;
      return JSON.parse(data).type === "audio-format";
    }), "音频格式"));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const rms = audioRms(client.takeAudio(), audioFormat);
    if (rms < 0.0001) throw new Error(`WebRTC 音频为静音 (RMS ${rms})`);
    console.log(`PASS WebRTC audio carried non-silent PCM (RMS ${rms.toFixed(5)})`);
    client.control.send(JSON.stringify({ type: "mouse", event: "mousePressed", x: 100, y: 105, button: "left", buttons: 1, clickCount: 1, modifiers: 0 }));
    client.control.send(JSON.stringify({ type: "mouse", event: "mouseReleased", x: 100, y: 105, button: "left", buttons: 0, clickCount: 1, modifiers: 0 }));
    client.takeAudio();
    await new Promise((resolve) => setTimeout(resolve, 900));
    const tailRms = audioRms(client.takeAudio(), audioFormat);
    if (tailRms > 0.001) throw new Error(`测试音停止后仍有声音 (RMS ${tailRms})`);
    console.log("PASS audio became silent after playback stopped");

    const ordinaryHit = client.control.onMessage.watch((data) => {
      if (typeof data !== "string") return false;
      const message = JSON.parse(data);
      return message.type === "hit-test" && message.requestId === 101 && message.editable === false;
    }, 5_000);
    client.control.send(JSON.stringify({ type: "hitTest", requestId: 101, x: 100, y: 105 }));
    await ordinaryHit;
    console.log("PASS hit test classified a normal control as non-editable");

    const editableHit = client.control.onMessage.watch((data) => {
      if (typeof data !== "string") return false;
      const message = JSON.parse(data);
      return message.type === "hit-test" && message.requestId === 102 && message.editable === true;
    }, 5_000);
    client.control.send(JSON.stringify({ type: "hitTest", requestId: 102, x: 100, y: 168 }));
    await editableHit;
    console.log("PASS hit test classified the text field as editable");

    const zoomed = client.control.onMessage.watch((data) => {
      if (typeof data !== "string") return false;
      const message = JSON.parse(data);
      return message.type === "zoom" && message.percent === 200;
    }, 5_000);
    client.control.send(JSON.stringify({ type: "zoom", percent: 200 }));
    await zoomed;
    const zoomedEditableHit = client.control.onMessage.watch((data) => {
      if (typeof data !== "string") return false;
      const message = JSON.parse(data);
      return message.type === "hit-test" && message.requestId === 103 && message.editable === true;
    }, 5_000);
    client.control.send(JSON.stringify({ type: "hitTest", requestId: 103, x: 400, y: 336 }));
    await zoomedEditableHit;
    console.log("PASS 200% zoom scaled the page and remote input coordinates together");

    const resetZoom = client.control.onMessage.watch((data) => {
      if (typeof data !== "string") return false;
      const message = JSON.parse(data);
      return message.type === "zoom" && message.percent === 100;
    }, 5_000);
    client.control.send(JSON.stringify({ type: "zoom", percent: 100 }));
    await resetZoom;

    const editableFocus = client.control.onMessage.watch((data) => {
      if (typeof data !== "string") return false;
      const message = JSON.parse(data);
      return message.type === "focus" && message.editable === true;
    }, 5_000);
    client.control.send(JSON.stringify({ type: "mouse", event: "mousePressed", x: 100, y: 168, button: "left", buttons: 1, clickCount: 1, modifiers: 0 }));
    client.control.send(JSON.stringify({ type: "mouse", event: "mouseReleased", x: 100, y: 168, button: "left", buttons: 0, clickCount: 1, modifiers: 0 }));
    await editableFocus;
    console.log("PASS remote input focus was reported to the mobile client");

    const beforeScroll = hash(client.getLastFrame());
    const changedFrame = client.frames.onMessage.watch((data) => Buffer.isBuffer(data) && hash(data) !== beforeScroll, 5_000);
    client.control.send(JSON.stringify({ type: "wheel", x: 400, y: 300, deltaX: 0, deltaY: 600, modifiers: 0 }));
    await changedFrame;
    console.log("PASS scroll produced a changed frame");

    const linkedPage = client.control.onMessage.watch((data) => {
      if (typeof data !== "string") return false;
      const message = JSON.parse(data);
      return message.type === "page" && message.url?.endsWith("/linked");
    }, 5_000);
    client.control.send(JSON.stringify({ type: "mouse", event: "mousePressed", x: 100, y: 42, button: "left", buttons: 1, clickCount: 1, modifiers: 0 }));
    client.control.send(JSON.stringify({ type: "mouse", event: "mouseReleased", x: 100, y: 42, button: "left", buttons: 0, clickCount: 1, modifiers: 0 }));
    await linkedPage;
    console.log("PASS target=_blank link switched the streamed page");

    const originalPage = client.control.onMessage.watch((data) => {
      if (typeof data !== "string") return false;
      const message = JSON.parse(data);
      return message.type === "page" && message.url === `http://127.0.0.1:${fixturePort}/`;
    }, 5_000);
    client.control.send(JSON.stringify({ type: "back" }));
    await originalPage;
    console.log("PASS back returned to the opener tab");
  } finally {
    await client.close();
    await waitForNoSessions();
    console.log("PASS disconnect released the browser and audio session");
  }
} finally {
  fixture.closeAllConnections?.();
  await new Promise((resolve) => fixture.close(resolve));
  if (browserService && browserService.exitCode === null) {
    browserService.kill();
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3_000);
      browserService.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}

process.exit(0);
