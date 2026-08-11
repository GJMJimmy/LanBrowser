import test from "node:test";
import assert from "node:assert/strict";
import { isBlockedHost, normalizeNavigation } from "../src/url-policy.js";

test("normalizes an internet hostname to HTTPS", () => {
  assert.equal(normalizeNavigation("example.com/path"), "https://example.com/path");
});

test("allows HTTP and HTTPS only", () => {
  assert.throws(() => normalizeNavigation("file:///c:/windows"), /HTTP/);
  assert.throws(() => normalizeNavigation("javascript:alert(1)"), /HTTP/);
});

test("blocks loopback and private literal addresses", () => {
  for (const host of ["localhost", "127.0.0.1", "10.2.3.4", "172.16.0.1", "192.168.1.10", "::1", "fd00::1"]) {
    assert.equal(isBlockedHost(host), true, host);
  }
  assert.throws(() => normalizeNavigation("http://192.168.1.2/admin"), /禁止/);
});

test("does not over-block public addresses", () => {
  assert.equal(isBlockedHost("example.com"), false);
  assert.equal(isBlockedHost("8.8.8.8"), false);
  assert.equal(isBlockedHost("172.32.0.1"), false);
});
