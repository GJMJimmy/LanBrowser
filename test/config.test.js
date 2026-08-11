import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

test("loads defaults and creates a token", () => {
  const config = loadConfig({});
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 7798);
  assert.ok(config.token.length >= 16);
});

test("clamps numeric settings", () => {
  const config = loadConfig({ LAN_BROWSER_PORT: "99999", LAN_BROWSER_MAX_SESSIONS: "0", LAN_BROWSER_FRAME_QUALITY: "12" });
  assert.equal(config.port, 65535);
  assert.equal(config.maxSessions, 1);
  assert.equal(config.frameQuality, 30);
});

test("command line arguments override environment variables", () => {
  const config = loadConfig({ LAN_BROWSER_PORT: "7000", LAN_BROWSER_TOKEN: "env" }, ["--port", "8123", "--token=cli", "--no-sandbox"]);
  assert.equal(config.port, 8123);
  assert.equal(config.token, "cli");
  assert.equal(config.noSandbox, true);
});

test("loads port, tokens, and resolution from a config file object", () => {
  const config = loadConfig({}, [], {
    fileConfig: {
      port: 8899,
      tokens: ["phone-token", "desktop-token"],
      frame: { width: 1920, height: 1080, quality: 80 },
    },
  });
  assert.equal(config.port, 8899);
  assert.deepEqual(config.tokens, ["phone-token", "desktop-token"]);
  assert.equal(config.token, "phone-token");
  assert.equal(config.frameWidth, 1920);
  assert.equal(config.frameHeight, 1080);
  assert.equal(config.frameQuality, 80);
});

test("environment and command line override config file values", () => {
  const config = loadConfig(
    { LAN_BROWSER_PORT: "7000", LAN_BROWSER_TOKENS: "env-a,env-b" },
    ["--port", "8123", "--token=cli"],
    { fileConfig: { port: 6000, tokens: ["file"] } },
  );
  assert.equal(config.port, 8123);
  assert.deepEqual(config.tokens, ["cli"]);
});
