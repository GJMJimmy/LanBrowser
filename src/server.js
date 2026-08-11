import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import { WebSocketServer } from "ws";
import { loadConfig } from "./config.js";
import { SessionManager } from "./session-manager.js";
import { assets } from "./generated-assets.js";

const config = loadConfig();
const sessions = new SessionManager(config);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

function tokenMatches(candidate) {
  const left = createHash("sha256").update(String(candidate || "")).digest();
  return config.tokens.some((token) => {
    const right = createHash("sha256").update(token).digest();
    return timingSafeEqual(left, right);
  });
}

function getToken(requestUrl, request) {
  const url = new URL(requestUrl, "http://localhost");
  return url.searchParams.get("token") || request.headers["x-lan-browser-token"] || "";
}

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  let path = url.pathname === "/" ? "/index.html" : url.pathname;
  if (path === "/health") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true, sessions: sessions.size, maxSessions: config.maxSessions }));
    return;
  }
  if (path.includes("..") || !assets[path]) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  const extension = path.slice(path.lastIndexOf("."));
  res.writeHead(200, {
    "content-type": MIME[extension] || "application/octet-stream",
    "cache-control": path === "/index.html" ? "no-store" : "no-cache",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    "referrer-policy": "no-referrer",
  });
  res.end(assets[path]);
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024, perMessageDeflate: false });

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", "http://localhost");
  if (url.pathname !== "/signal" || !tokenMatches(getToken(request.url, request))) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws));
});

wss.on("connection", (ws) => {
  let sessionId = "";
  ws.once("message", async (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.type !== "offer") throw new Error("信令消息无效");
      const result = await sessions.create(message.offer);
      sessionId = result.id;
      ws.send(JSON.stringify({ type: "answer", sessionId, answer: result.answer }));
    } catch (error) {
      ws.send(JSON.stringify({ type: "error", message: error.message || "连接失败" }));
      ws.close();
    }
  });
  ws.on("close", () => {
    // 信令完成后 WebRTC 会话独立存活，客户端主动关闭由 DataChannel 状态处理。
  });
  ws.on("error", () => {});
});

const shutdown = async () => {
  server.close();
  wss.close();
  await sessions.close();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

server.listen(config.port, config.host, () => {
  const addresses = Object.values(networkInterfaces()).flat().filter((item) => item?.family === "IPv4" && !item.internal);
  console.log("\n  LAN Browser 已启动\n");
  if (config.configPath) console.log(`  配置: ${config.configPath}`);
  console.log(`  本机: http://127.0.0.1:${config.port}/?token=${config.token}`);
  for (const address of addresses) console.log(`  内网: http://${address.address}:${config.port}/?token=${config.token}`);
  console.log("\n  请妥善保管访问口令；按 Ctrl+C 停止服务。\n");
});
