const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

export function accessUrl(host, port, token) {
  const url = new URL(`http://${host}:${port}/`);
  url.searchParams.set("token", token);
  return url.href;
}

export function terminalLink(value, interactive = Boolean(process.stdout.isTTY)) {
  const url = String(value).replace(CONTROL_CHARACTERS, "");
  if (!interactive) return url;
  return `\u001b]8;;${url}\u001b\\${url}\u001b]8;;\u001b\\`;
}
