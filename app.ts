// The server: one HTTP surface routing every protocol the suite speaks to its module.
//
//   GET  /healthz                     the boot probe (no auth), 200 {"ok":true}
//        /api/v3/...                  REST v3            -> rest.ts   (Bearer token required, else 401)
//   POST /api/graphql                 GraphQL v4         -> gql.ts     (Bearer token required, else 401)
//   POST /mcp                         MCP streamable HTTP-> mcp.ts     (Bearer token required, else 401)
//        /{owner}/{repo}.git/...      git smart HTTP     -> githttp.ts (the git protocol carries no token)
//
// The token is the one the environment hands the entry (wire.ts TOKEN_ENV); REST, GraphQL and
// MCP all carry it as `Authorization: Bearer <token>`. Everything else is GitHub's 404.
//
// app.ts stays separate from main.ts: this is the server; main.ts is the lifecycle.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { executeGraphQL } from './gql.ts';
import { handleGitPost, handleInfoRefs } from './githttp.ts';
import { handleMcp } from './mcp.ts';
import { getCacheKey, handleRest, lookupGet, nextRequestId, respondCachedGet } from './rest.ts';
import { bumpEpoch, findRepo } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
/** The env var that carries the bearer token (wire.ts TOKEN_ENV). */
const TOKEN_ENV = 'MAKEFUN_SHOP_TOKEN';
/** The largest body accepted (git receive-pack packs land under this). */
const MAX_BODY_BYTES = 256 * 1024 * 1024;

/** The expected bearer token; empty when the env did not hand one (local boots). */
const TOKEN = process.env[TOKEN_ENV] ?? '';
/** Precomputed full header values: one string compare instead of scheme-slice-trim-compare. */
const AUTH_HEADERS: ReadonlyArray<string> = TOKEN === '' ? [] : [`Bearer ${TOKEN}`, `token ${TOKEN}`];

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': String(Buffer.byteLength(text)), 'x-github-request-id': nextRequestId(), ...headers });
  res.end(text);
}

/** The request target split by hand: `path` is everything before the first '?'. */
function splitTarget(rawUrl: string): { path: string; hasQuery: boolean } {
  const q = rawUrl.indexOf('?');
  return q === -1 ? { path: rawUrl, hasQuery: false } : { path: rawUrl.slice(0, q), hasQuery: true };
}

/** Whether the request carries the token, as `Bearer <t>` or `token <t>` (GitHub accepts both). */
function isAuthorized(req: IncomingMessage): boolean {
  if (AUTH_HEADERS.length === 0) return true; // no token was handed to the entry: everything is local
  const header = String(req.headers.authorization ?? '');
  return header === AUTH_HEADERS[0] || header === AUTH_HEADERS[1];
}

/** Whether a GET/HEAD carries no body at all, so the reader can be skipped entirely. */
function isBodylessGet(req: IncomingMessage): boolean {
  const len = req.headers['content-length'];
  const te = req.headers['transfer-encoding'];
  return len === undefined && te === undefined;
}

/** GitHub's 401 body for a request without credentials. */
function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Requires authentication' });
}

/** Read the whole request body as a Buffer, refusing anything over MAX_BODY_BYTES. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a REST/GraphQL/MCP body: null when empty, the parsed JSON when it parses, a `_malformed` marker otherwise. */
function parseBody(raw: Buffer): Record<string, unknown> | null {
  if (raw.length === 0) return null;
  const text = raw.toString('utf8');
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { _raw: parsed };
  } catch {
    return { _malformed: text };
  }
}

/** The git smart-HTTP paths: /{owner}/{repo}.git/{info/refs|git-upload-pack|git-receive-pack}. */
const GIT_ROUTE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((error) => {
      // A bug in a handler is this server's, never the client's: answer 500 and stay up.
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end('');
      process.stderr.write(`[app] ${String(error instanceof Error ? error.stack ?? error.message : error)}\n`);
    });
  });
  // Every benchmarked operation is a small request answered in one write; Nagle only adds
  // delay to those, so disable it per connection the way the entry's own client already does.
  server.on('connection', (socket: import('node:net').Socket) => socket.setNoDelay(true));
  return server;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const rawUrl = req.url ?? '/';
  const { path } = splitTarget(rawUrl);

  // The env's boot check calls this twice: 200 {"ok":true}.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // REST v3: everything under /api/v3, token required.
  if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
    if (!isAuthorized(req)) {
      unauthorized(res);
      return;
    }
    const host = String(req.headers.host ?? 'forge.example');
    if (method === 'GET' && isBodylessGet(req)) {
      // The hot read path: a memoised answer serves without a body read or a URL object.
      const hit = lookupGet(getCacheKey(rawUrl, host));
      if (hit !== null) {
        respondCachedGet(res, hit);
        return;
      }
      const url = new URL(rawUrl, `http://${host}`);
      const handled = handleRest(res, { method, url, req, body: null, rawUrl });
      if (!handled) sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (method !== 'GET' && method !== 'HEAD') bumpEpoch(); // any write invalidates memoised answers
    const raw = await readBody(req);
    const body = parseBody(raw);
    if (body !== null && body._malformed !== undefined) {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
    const url = new URL(rawUrl, `http://${host}`);
    const handled = handleRest(res, { method, url, req, body, rawUrl });
    if (!handled) sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // GraphQL v4: one POST endpoint.
  if (path === '/api/graphql') {
    if (!isAuthorized(req)) {
      unauthorized(res);
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    bumpEpoch(); // a GraphQL POST may mutate: assume it does, misses are only lost warmth
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = raw.length === 0 ? null : JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
    const outcome = executeGraphQL((parsed ?? {}) as never);
    sendJson(res, outcome.status ?? 200, outcome.body);
    return;
  }

  // MCP streamable HTTP.
  if (path === '/mcp') {
    if (!isAuthorized(req)) {
      unauthorized(res);
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    bumpEpoch(); // MCP tools create issues: assume a POST mutates
    const raw = await readBody(req);
    handleMcp(res, raw.toString('utf8'));
    return;
  }

  // git smart HTTP: no token on this wire, the protocol has its own paths.
  const gitMatch = path.match(GIT_ROUTE);
  if (gitMatch !== null) {
    const [, owner, name, service] = gitMatch as unknown as [string, string, string, string];
    const repo = findRepo(decodeURIComponent(owner), decodeURIComponent(name));
    if (service === 'info/refs') {
      const url = new URL(rawUrl, `http://${String(req.headers.host ?? 'forge.example')}`);
      handleInfoRefs(res, repo, url.searchParams.get('service') ?? '', url);
      return;
    }
    if (service === 'git-receive-pack') bumpEpoch(); // a push changes refs: memoised answers age out
    const raw = await readBody(req);
    handleGitPost(res, repo, service, raw);
    return;
  }

  // Everything else, every method: GitHub's 404 body.
  sendJson(res, 404, { message: 'Not Found' });
}
