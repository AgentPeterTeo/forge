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
import { handleRest, nextRequestId } from './rest.ts';
import { findRepo } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
/** The env var that carries the bearer token (wire.ts TOKEN_ENV). */
const TOKEN_ENV = 'MAKEFUN_SHOP_TOKEN';
/** The largest body accepted (git receive-pack packs land under this). */
const MAX_BODY_BYTES = 256 * 1024 * 1024;

/** The expected bearer token; empty when the env did not hand one (local boots). */
const TOKEN = process.env[TOKEN_ENV] ?? '';

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': String(Buffer.byteLength(text)), 'x-github-request-id': nextRequestId(), ...headers });
  res.end(text);
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Whether the request carries the token, as `Bearer <t>` or `token <t>` (GitHub accepts both). */
function isAuthorized(req: IncomingMessage): boolean {
  if (TOKEN === '') return true; // no token was handed to the entry: everything is local
  const header = String(req.headers.authorization ?? '');
  const space = header.indexOf(' ');
  if (space <= 0) return false;
  const scheme = header.slice(0, space).trim().toLowerCase();
  if (scheme !== 'bearer' && scheme !== 'token') return false;
  return header.slice(space + 1).trim() === TOKEN;
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
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((error) => {
      // A bug in a handler is this server's, never the client's: answer 500 and stay up.
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end('');
      process.stderr.write(`[app] ${String(error instanceof Error ? error.stack ?? error.message : error)}\n`);
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const path = pathOf(req);

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
    const raw = await readBody(req);
    const body = parseBody(raw);
    if (body !== null && body._malformed !== undefined) {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
    const host = String(req.headers.host ?? 'forge.example');
    const url = new URL(req.url ?? '/', `http://${host}`);
    const handled = handleRest(res, { method, url, req, body });
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
      const url = new URL(req.url ?? '/', `http://${String(req.headers.host ?? 'forge.example')}`);
      handleInfoRefs(res, repo, url.searchParams.get('service') ?? '', url);
      return;
    }
    const raw = await readBody(req);
    handleGitPost(res, repo, service, raw);
    return;
  }

  // Everything else, every method: GitHub's 404 body.
  sendJson(res, 404, { message: 'Not Found' });
}
