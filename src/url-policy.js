import { isIP } from "node:net";

const PRIVATE_V4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
];

export function normalizeNavigation(input, { blockPrivate = true } = {}) {
  const value = String(input || "").trim();
  if (!value) throw new Error("地址不能为空");

  let url;
  try {
    const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(value);
    url = new URL(hasScheme ? value : `https://${value}`);
  } catch {
    throw new Error("地址格式无效");
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error("仅允许访问 HTTP 或 HTTPS 地址");
  }
  if (url.username || url.password) throw new Error("地址中不能包含账号密码");

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (blockPrivate && isBlockedHost(host)) {
    throw new Error("默认禁止访问服务端本机和内网地址");
  }
  return url.href;
}

export function isBlockedHost(host) {
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const ipVersion = isIP(host);
  if (ipVersion === 4) return PRIVATE_V4.some((pattern) => pattern.test(host));
  if (ipVersion === 6) {
    return host === "::" || host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb");
  }
  return false;
}
