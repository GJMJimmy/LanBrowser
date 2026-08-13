import test from "node:test";
import assert from "node:assert/strict";
import { accessUrl, terminalLink } from "../src/terminal-link.js";

test("terminal links use OSC 8 while keeping the URL visible", () => {
  const url = "http://127.0.0.1:8080/?token=abc";
  assert.equal(terminalLink(url, true), `\u001b]8;;${url}\u001b\\${url}\u001b]8;;\u001b\\`);
  assert.equal(terminalLink(url, false), url);
});

test("access URLs safely encode tokens", () => {
  assert.equal(accessUrl("192.168.1.20", 8080, "a+b & c"), "http://192.168.1.20:8080/?token=a%2Bb+%26+c");
});

test("terminal links strip control characters", () => {
  assert.equal(terminalLink("https://example.com/\u001b]8;;bad", true).includes("\u001b]8;;bad"), false);
});
