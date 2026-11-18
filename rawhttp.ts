// The raw HTTP/1.1 front end: one TCP server, a hand-rolled parser, one write per answer.
//
// node:http allocates an IncomingMessage and a ServerResponse and re-runs its JS glue for
// every request; the read workload is two thousand of them a round on a shared sandbox
// core, so that fixed cost is worth replacing. This module parses the request head by
// index (no per-header objects), reads the body straight off the socket, and answers
// with a single prebuilt buffer. Every route still runs through app.ts's `handle()`
// unchanged: the request is handed over as a plain object whose `on('data')` replays the
// already-read body, and the response object only collects what `writeHead`/`end` set,
// which is all the routes ever use.
//
// Kept: keep-alive (the clients' pooled sockets), chunked request bodies, HEAD without a
// body, `Expect: 100-continue`, and `Connection: close`. One connection serves strictly
// one request at a time and re-parses whatever follows once the answer went out; the
// suite's clients never pipeline, and its concurrency (50 parallel clones) rides on
// separate pooled sockets, which the kernel hands to this same loop.

import * as net from 'node:net';
import { handle } from './app.ts';

const REASONS: Record<number, string> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 304: 'Not Modified',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 409: 'Conflict', 422: 'Unprocessable Entity',
  500: 'Internal Server Error', 501: 'Not Implemented',
};
const reasonOf = (status: number): string => REASONS[status] ?? 'Unknown';

interface ReqHead {
  method: string;
  target: string;
  version: string;
  headers: Record<string, string>;
  wantsClose: boolean;
  expectsContinue: boolean;
}

/** The collected response of one request: everything writeHead/end set. */
interface Collected {
  status: number;
  headers: Record<string, string | number>;
  body: Buffer;
  done: boolean;
}

const CONTINUE = Buffer.from('HTTP/1.1 100 Continue\r\n\r\n');

/** Parse a whole request head at the start of `buf`; null while it is not whole. */
function parseHead(buf: Buffer): { head: ReqHead; headerLen: number } | null {
  const sep = buf.indexOf('\r\n\r\n');
  if (sep === -1) return null;
  const headText = buf.subarray(0, sep).toString('latin1');
  const lines = headText.split('\r\n');
  const requestLine = lines[0] ?? '';
  const space1 = requestLine.indexOf(' ');
  const space2 = requestLine.indexOf(' ', space1 + 1);
  if (space1 === -1 || space2 === -1) return null;
  const method = requestLine.slice(0, space1);
  const target = requestLine.slice(space1 + 1, space2);
  const version = requestLine.slice(space2 + 1);
  const headers: Record<string, string> = {};
  let wantsClose = false;
  let expectsContinue = false;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === 'connection') {
      if (value.toLowerCase().includes('close')) wantsClose = true;
    } else if (name === 'expect' && value.toLowerCase().includes('100-continue')) {
      expectsContinue = true;
    }
    headers[name] = value; // last wins: no client of this suite repeats a header
  }
  if (version !== 'HTTP/1.1' && version !== 'HTTP/1.0') return null;
  return { head: { method, target, version, headers, wantsClose, expectsContinue }, headerLen: sep + 4 };
}

/** The body the head announces: -1 chunked, 0 none, N a length. */
function bodyPlan(head: ReqHead): { contentLength: number; chunked: boolean } {
  const te = head.headers['transfer-encoding'];
  if (te !== undefined && te.toLowerCase().includes('chunked')) return { contentLength: -1, chunked: true };
  const len = head.headers['content-length'];
  if (len === undefined) return { contentLength: 0, chunked: false };
  const parsed = Number.parseInt(len, 10);
  return { contentLength: Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0, chunked: false };
}

/** Decode a whole chunked body starting at `buf[0]`; null while it is incomplete. */
function readChunked(buf: Buffer): { body: Buffer; total: number } | null {
  const parts: Buffer[] = [];
  let at = 0;
  for (;;) {
    const lineEnd = buf.indexOf('\r\n', at);
    if (lineEnd === -1) return null;
    const size = Number.parseInt(buf.subarray(at, lineEnd).toString('latin1').split(';')[0] ?? '', 16);
    if (!Number.isSafeInteger(size) || size < 0) return null;
    if (size === 0) {
      const tail = buf.indexOf('\r\n', lineEnd + 2);
      return { body: Buffer.concat(parts), total: tail === -1 ? buf.length : tail + 2 };
    }
    if (buf.length < lineEnd + 2 + size + 2) return null;
    parts.push(buf.subarray(lineEnd + 2, lineEnd + 2 + size));
    at = lineEnd + 2 + size + 2;
  }
}

/** The single buffer that answers one request. */
function buildResponse(status: number, headers: Record<string, string | number>, body: Buffer, keepAlive: boolean, isHead: boolean): Buffer {
  const out: string[] = [`HTTP/1.1 ${status} ${reasonOf(status)}`];
  let hasLength = false;
  for (const [name, value] of Object.entries(headers)) {
    if (name === 'connection') continue;
    if (name === 'content-length') hasLength = true;
    out.push(`${name}: ${value}`);
  }
  if (!hasLength && status !== 204 && status !== 304) out.push(`content-length: ${body.length}`);
  out.push(`connection: ${keepAlive ? 'keep-alive' : 'close'}`);
  out.push('', '');
  const headText = out.join('\r\n');
  if (isHead || status === 204 || status === 304) return Buffer.concat([Buffer.from(headText, 'latin1')]);
  return Buffer.concat([Buffer.from(headText, 'latin1'), body]);
}

/** One connection: buffered bytes, a half-arrived request, and the serving lock. */
interface Conn {
  buf: Buffer;
  contentLength: number;
  chunked: boolean;
  busy: boolean;
}

export function createRawApp(): net.Server {
  return net.createServer((socket: net.Socket) => {
    socket.setNoDelay(true);
    const conn: Conn = { buf: Buffer.alloc(0), contentLength: 0, chunked: false, busy: false };

    const serve = (head: ReqHead, body: Buffer, used: number): void => {
      conn.busy = true;
      conn.buf = conn.buf.length === used ? Buffer.alloc(0) : conn.buf.subarray(used);
      const isHead = head.method === 'HEAD';
      const collected: Collected = { status: 200, headers: {}, body: Buffer.alloc(0), done: false };
      const req = {
        method: head.method,
        url: head.target,
        headers: head.headers,
        on(event: string, cb: (arg?: never) => void): unknown {
          if (event === 'data') { (cb as (b: Buffer) => void)(body); return req; }
          if (event === 'end') { cb(); return req; }
          return req; // 'error' never fires: the body was read whole off the socket
        },
        destroy(): void { socket.destroy(); },
      };
      const res = {
        req, // ServerResponse carries the request back: the git v2 path reads Git-Protocol off it
        get headersSent(): boolean { return collected.done; },
        writeHead(status: number, headers?: Record<string, string | number>): void {
          collected.status = status;
          if (headers !== undefined) for (const [k, v] of Object.entries(headers)) collected.headers[k] = v;
        },
        setHeader(k: string, v: string | number): void { collected.headers[k] = v; },
        end(text?: string | Buffer): void {
          collected.done = true;
          collected.body = text === undefined ? Buffer.alloc(0) : typeof text === 'string' ? Buffer.from(text, 'utf8') : text;
          const keepAlive = !head.wantsClose;
          socket.write(buildResponse(collected.status, collected.headers, collected.body, keepAlive, isHead));
          if (!keepAlive) socket.end();
        },
        write(): boolean { return true; }, // nothing here streams in pieces; end() carries it all
        flushHeaders(): void { /* end() is the one write */ },
      };
      handle(req as never, res as never)
        .catch((error: unknown) => {
          process.stderr.write(`[rawhttp] ${String(error instanceof Error ? error.stack ?? error.message : error)}\n`);
          if (!collected.done) {
            const text = Buffer.from('{"message":"Internal Server Error"}\n');
            socket.write(buildResponse(500, { 'content-type': 'application/json; charset=utf-8', 'content-length': text.length }, text, !head.wantsClose, false));
          }
        })
        .finally(() => {
          conn.busy = false;
          parse();
        });
    };

    const parse = (): void => {
      if (conn.busy) return;
      const headAt = parseHead(conn.buf);
      if (headAt === null) {
        if (conn.buf.length > 65536) { // a head larger than any this suite speaks is a refusal, not a hang
          socket.end('HTTP/1.1 431 Request Header Fields Too Large\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
          conn.buf = Buffer.alloc(0);
        }
        return;
      }
      if (headAt.head.expectsContinue && headAt.head.method !== 'GET' && headAt.head.method !== 'HEAD') socket.write(CONTINUE);
      if (conn.chunked || conn.contentLength > 0 || headAt.head.headers['content-length'] !== undefined || headAt.head.headers['transfer-encoding'] !== undefined) {
        const plan = bodyPlan(headAt.head);
        if (plan.chunked) {
          const got = readChunked(conn.buf.subarray(headAt.headerLen));
          if (got === null) return;
          serve(headAt.head, got.body, headAt.headerLen + got.total);
          return;
        }
        if (conn.buf.length < headAt.headerLen + plan.contentLength) return;
        serve(headAt.head, conn.buf.subarray(headAt.headerLen, headAt.headerLen + plan.contentLength), headAt.headerLen + plan.contentLength);
        return;
      }
      serve(headAt.head, Buffer.alloc(0), headAt.headerLen);
    };

    socket.on('data', (chunk: Buffer) => {
      conn.buf = conn.buf.length === 0 ? chunk : Buffer.concat([conn.buf, chunk]);
      parse();
    });
    socket.on('error', () => { socket.destroy(); });
  });
}
