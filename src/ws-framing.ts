import type { WsFrame } from "./types";

export const WS_MAGIC_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function wsParseFrame(buffer: Buffer): WsFrame | null {
  if (buffer.length < 2) return null;
  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let payloadLength = buffer[1] & 0x7f;
  let offset = 2;
  if (payloadLength === 126) {
    if (buffer.length < 4) return null;
    payloadLength = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    if (buffer.length < 10) return null;
    payloadLength = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  if (masked) {
    if (buffer.length < offset + 4 + payloadLength) return null;
    const maskKey = buffer.slice(offset, offset + 4);
    offset += 4;
    const payload = Buffer.from(buffer.slice(offset, offset + payloadLength));
    for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
    return { fin, opcode, payload, totalLength: offset + payloadLength };
  }
  if (buffer.length < offset + payloadLength) return null;
  return {
    fin,
    opcode,
    payload: buffer.slice(offset, offset + payloadLength),
    totalLength: offset + payloadLength,
  };
}

export function wsMakeFrame(data: string | Buffer, opcode = 0x01): Buffer {
  const payload = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}
