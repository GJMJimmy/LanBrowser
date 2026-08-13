import { readFile, writeFile } from "node:fs/promises";

const file = process.argv[2];
if (!file) throw new Error("缺少 PE 文件路径");

const data = await readFile(file);
if (data.readUInt16LE(0) !== 0x5a4d) throw new Error("不是有效的 PE 文件 (MZ)");
const peOffset = data.readUInt32LE(0x3c);
if (data.readUInt32LE(peOffset) !== 0x00004550) throw new Error("不是有效的 PE 文件 (PE)");

const optionalHeader = peOffset + 24;
const magic = data.readUInt16LE(optionalHeader);
const dataDirectory = optionalHeader + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : 0);
if (!dataDirectory) throw new Error(`不支持的 PE 可选头: 0x${magic.toString(16)}`);

const securityDirectory = dataDirectory + 4 * 8;
const certificateOffset = data.readUInt32LE(securityDirectory);
const certificateSize = data.readUInt32LE(securityDirectory + 4);
if (!certificateOffset || !certificateSize) process.exit(0);
if (certificateOffset + certificateSize > data.length) throw new Error("PE 签名目录超出文件范围");

data.fill(0, securityDirectory, securityDirectory + 8);
const output = certificateOffset + certificateSize === data.length ? data.subarray(0, certificateOffset) : data;
await writeFile(file, output);
