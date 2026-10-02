// Минимальный WebSocket-сервер (RFC 6455) без внешних зависимостей.
// Нужен только текстовый обмен JSON-сообщениями, поэтому поддержано:
// текстовые кадры, фрагментация, ping/pong, close, лимит размера сообщения.

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 16 * 1024;          // клиентам хватает с запасом
const HEARTBEAT_MS = 25_000;            // хостинги рвут «тихие» соединения примерно через минуту

export class WsConn extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frags = [];
    this.fragOp = 0;
    this.readyState = 1;               // 1 открыт, 2 закрывается, 3 закрыт
    this.alive = true;
    socket.setNoDelay(true);
    socket.on('data', (d) => this.#onData(d));
    socket.on('close', () => this.#closed());
    socket.on('error', () => this.#closed());
  }

  #onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0, op = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        if (this.buf.readUInt32BE(2) !== 0) return this.close(1009);
        len = this.buf.readUInt32BE(6); off = 10;
      }
      if (len > MAX_MESSAGE) return this.close(1009);
      if (!masked) return this.close(1002);           // клиент обязан маскировать кадры
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      this.#frame(fin, op, payload);
      if (this.readyState !== 1) return;
    }
  }

  #frame(fin, op, payload) {
    switch (op) {
      case 0x8: // close
        this.#send(0x8, payload.subarray(0, 2));
        this.readyState = 2;
        this.socket.end();
        return this.#closed();
      case 0x9: return this.#send(0xA, payload);       // ping → pong
      case 0xA: this.alive = true; return;              // pong
      case 0x0: case 0x1: case 0x2: {
        if (op !== 0x0) { this.fragOp = op; this.frags = []; }
        this.frags.push(payload);
        const total = this.frags.reduce((s, b) => s + b.length, 0);
        if (total > MAX_MESSAGE) return this.close(1009);
        if (!fin) return;
        const msg = Buffer.concat(this.frags);
        this.frags = [];
        this.alive = true;
        if (this.fragOp === 0x1) this.emit('message', msg.toString('utf8'));
        return;
      }
      default: return this.close(1002);
    }
  }

  #send(op, payload) {
    if (this.readyState === 3 || this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | op; header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | op; header[1] = 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
    this.socket.write(Buffer.concat([header, payload]));
  }

  send(text) { if (this.readyState === 1) this.#send(0x1, Buffer.from(text, 'utf8')); }
  ping() { if (this.readyState === 1) this.#send(0x9, Buffer.alloc(0)); }

  close(code = 1000) {
    if (this.readyState !== 1) return;
    const b = Buffer.alloc(2); b.writeUInt16BE(code);
    this.#send(0x8, b);
    this.readyState = 2;
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref();
  }

  #closed() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }
}

/** Подключает WebSocket к http-серверу по пути `path`. */
export function attachWebSocket(server, onConnection, { path = '/ws' } = {}) {
  const conns = new Set();
  server.on('upgrade', (req, socket) => {
    let pathname = '';
    try { pathname = new URL(req.url, 'http://x').pathname; } catch {}
    const key = req.headers['sec-websocket-key'];
    if (pathname !== path || (req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const ws = new WsConn(socket);
    conns.add(ws);
    ws.on('close', () => conns.delete(ws));
    onConnection(ws, req);
  });
  const timer = setInterval(() => {
    for (const ws of conns) {
      if (!ws.alive) { ws.socket.destroy(); continue; }
      ws.alive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  timer.unref();
  return { conns };
}
