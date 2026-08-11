import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const asNumber = (value, fallback, min, max) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

const asBoolean = (value, fallback = false) => {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
};

const parseArgs = (argv) => {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const match = String(argv[index]).match(/^--([a-z-]+)(?:=(.*))?$/);
    if (!match) continue;
    const nextIsValue = match[2] === undefined && argv[index + 1] && !String(argv[index + 1]).startsWith("--");
    result[match[1]] = match[2] ?? (nextIsValue ? argv[index + 1] : true);
    if (nextIsValue) index += 1;
  }
  return result;
};

const normalizeTokens = (value) => {
  const values = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
};

function readConfigFile(args, env) {
  const explicit = args.config || env.LAN_BROWSER_CONFIG;
  const candidates = explicit
    ? [resolve(String(explicit))]
    : [join(dirname(process.execPath), "lan-browser.config.json"), join(process.cwd(), "lan-browser.config.json")];
  const configPath = [...new Set(candidates)].find(existsSync);
  if (!configPath) return { fileConfig: {}, configPath: explicit ? resolve(String(explicit)) : "" };
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("根节点必须是 JSON 对象");
    return { fileConfig: parsed, configPath };
  } catch (error) {
    throw new Error(`读取配置文件失败 (${configPath}): ${error.message}`);
  }
}

export function loadConfig(env = process.env, argv = process.argv.slice(2), options = {}) {
  const args = parseArgs(argv);
  const loaded = Object.hasOwn(options, "fileConfig")
    ? { fileConfig: options.fileConfig || {}, configPath: options.configPath || "" }
    : readConfigFile(args, env);
  const file = loaded.fileConfig;
  const frame = file.frame && typeof file.frame === "object" ? file.frame : {};
  const cliTokens = args.token ? [args.token] : args.tokens;
  const envTokens = env.LAN_BROWSER_TOKENS || env.LAN_BROWSER_TOKEN;
  const tokens = normalizeTokens(cliTokens || envTokens || file.tokens || file.token);
  if (!tokens.length) tokens.push(randomBytes(12).toString("base64url"));

  return {
    host: args.host || env.LAN_BROWSER_HOST || file.host || "0.0.0.0",
    port: asNumber(args.port || env.LAN_BROWSER_PORT || file.port, 7798, 1, 65535),
    token: tokens[0],
    tokens,
    startUrl: args["start-url"] || env.LAN_BROWSER_START_URL || file.startUrl || "https://www.bing.com/",
    edgePath: args["browser-path"] || args["edge-path"] || env.LAN_BROWSER_EDGE_PATH || file.browserPath || file.edgePath || "",
    outboundProxy: args.proxy || env.LAN_BROWSER_PROXY || file.proxy || file.outboundProxy || "",
    maxSessions: asNumber(args["max-sessions"] || env.LAN_BROWSER_MAX_SESSIONS || file.maxSessions, 4, 1, 32),
    idleTimeoutMs: asNumber(args["idle-minutes"] || env.LAN_BROWSER_IDLE_MINUTES || file.idleMinutes, 20, 1, 1440) * 60_000,
    frameQuality: asNumber(args.quality || env.LAN_BROWSER_FRAME_QUALITY || frame.quality || file.frameQuality, 72, 30, 90),
    frameWidth: asNumber(args.width || env.LAN_BROWSER_FRAME_WIDTH || frame.width || file.frameWidth, 1440, 320, 3840),
    frameHeight: asNumber(args.height || env.LAN_BROWSER_FRAME_HEIGHT || frame.height || file.frameHeight, 900, 240, 2160),
    dataDir: env.LAN_BROWSER_DATA_DIR || file.dataDir || join(tmpdir(), "lan-browser"),
    publicUrl: env.LAN_BROWSER_PUBLIC_URL || file.publicUrl || "",
    noSandbox: asBoolean(args["no-sandbox"] ?? env.LAN_BROWSER_NO_SANDBOX, asBoolean(file.noSandbox)),
    allowPrivate: asBoolean(args["allow-private"] ?? env.LAN_BROWSER_ALLOW_PRIVATE, asBoolean(file.allowPrivate)),
    audio: asBoolean(args.audio ?? env.LAN_BROWSER_AUDIO, asBoolean(file.audio, true)),
    configPath: loaded.configPath,
  };
}
