/**
 * githttp.ts — git smart HTTP: info/refs (v0+v2), upload-pack (v2 ls-refs/fetch + v0), receive-pack v0.
 * Wire formats follow the client in the kit exactly (pkt-line framing, sideband, report-status).
 */
import type { ServerResponse } from 'node:http';
import {
  type GitObject, type ObjMap, closure, isDescendant, parseCommit, peelToCommit, readPack, writePack,
} from './gitstore.ts';
import { findRepo, type Repo, RepoError, ZERO_SHA } from './store.ts';

const MAX_BODY = 256 * 1024 * 1024;
const ZERO_OID = ZERO_SHA;
const UP_CAPS = 'multi_ack_detailed multi_ack thin-pack side-band-64k ofs-delta shallow deepen-since deepen-not no-progress include-tag allow-tip-sha1 allow-reachable-sha1-in-want no-done filter object-format=sha1 agent=forge/1.0';
const RP_CAPS = 'report-status-v2 report-status side-band-64k delete-refs ofs-delta atomic push-options object-format=sha1 agent=forge/1.0';
const V2_FETCH_CAPS = 'shallow filter ref-in-want sideband-all sideband-some-ack';

// ---------------------------------------------------------------- pkt-line

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  if (len > 0xffff) throw new Error('pkt-line too long');
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

export function pktLines(payloads: Array<string | Buffer>): Buffer {
  return Buffer.concat(payloads.map((p) => (typeof p === 'string' && p === 'flush' ? FLUSH : typeof p === 'string' && p === 'delim' ? DELIM : pktLine(p))));
}

interface Pkt { kind: 'data' | 'flush' | 'delim'; data?: Buffer }

/**
 * Parse pkt-lines from `body`. With `stopAtFlush`, stops at the first flush pkt and returns
 * the offset just after it — receive-pack packs are raw bytes after that point.
 */
export function decodePkts(body: Buffer, options: { stopAtFlush?: boolean } = {}): { pkts: Pkt[]; next: number } {
  const out: Pkt[] = [];
  let off = 0;
  while (off < body.length) {
    if (off + 4 > body.length) throw new GitHttpError(400, 'truncated pkt-line header');
    const head = body.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new GitHttpError(400, `bad pkt-line length ${JSON.stringify(head)}`);
    const len = parseInt(head, 16);
    if (len === 0) {
      out.push({ kind: 'flush' });
      off += 4;
      if (options.stopAtFlush) return { pkts: out, next: off };
      continue;
    }
    if (len === 1) { out.push({ kind: 'delim' }); off += 4; continue; }
    if (len < 4 || off + len > body.length) throw new GitHttpError(400, 'pkt-line length exceeds body');
    out.push({ kind: 'data', data: body.subarray(off + 4, off + len) });
    off += len;
  }
  return { pkts: out, next: off };
}

export class GitHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------- request plumbing

export function sendBytes(res: ServerResponse, status: number, contentType: string, body: Buffer, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(body.length), ...headers });
  res.end(body);
}

export function notFoundRepo(res: ServerResponse): void {
  sendBytes(res, 404, 'application/json', Buffer.from(JSON.stringify({ message: 'Not Found' })));
}

// ---------------------------------------------------------------- info/refs

export function handleInfoRefs(res: ServerResponse, repo: Repo | undefined, service: string, url: URL): void {
  if (!repo) { notFoundRepo(res); return; }
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    notFoundRepo(res);
    return;
  }
  const protocolHeader = (res.req?.headers['git-protocol'] ?? '').toString();
  const v2 = service === 'git-upload-pack' && (protocolHeader.includes('version=2') || url.searchParams.get('git-protocol') === 'version=2');
  const contentType = `application/x-${service}-advertisement`;
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  let body: Buffer;
  if (v2) {
    const caps = ['version 2', 'agent=forge/1.0', 'ls-refs=unborn', `fetch=${V2_FETCH_CAPS}`, 'object-format=sha1', 'server-option'];
    body = pktLines([...lines, ...caps.map((c) => `${c}\n` as string), 'flush']);
  } else {
    const chunks: Buffer[] = [pktLines(lines)];
    const refNames = [...repo.refs.keys()].sort();
    const headSha = repo.refs.get(`refs/heads/${repo.default_branch}`);
    const caps = service === 'git-upload-pack' ? UP_CAPS : RP_CAPS;
    if (refNames.length === 0) {
      // unborn: the capabilities^{} pseudo-ref carries a zero oid
      chunks.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    } else {
      const symrefCap = `symref=HEAD:refs/heads/${repo.default_branch}`;
      const capList = `${symrefCap} ${caps}`;
      if (headSha) chunks.push(pktLine(`${headSha} HEAD\0${capList}\n`));
      let first = headSha === undefined;
      for (const ref of refNames) {
        const sha = repo.refs.get(ref)!;
        const line = first ? `${sha} ${ref}\0${caps}\n` : `${sha} ${ref}\n`;
        chunks.push(pktLine(line));
        first = false;
        const obj = repo.objects.get(sha);
        if (ref.startsWith('refs/tags/') && obj && obj.type === 'tag') {
          const peeled = peelToCommit(repo.objects, sha);
          if (peeled.commit) chunks.push(pktLine(`${peeled.commit} ${ref}^{}\n`));
        }
      }
    }
    chunks.push(FLUSH);
    body = Buffer.concat(chunks);
  }
  sendBytes(res, 200, contentType, body, { 'cache-control': 'no-cache, max-age=0, must-revalidate' });
}

// ---------------------------------------------------------------- POST routing

export function handleGitPost(res: ServerResponse, repo: Repo | undefined, service: string, body: Buffer): void {
  if (!repo) { notFoundRepo(res); return; }
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    notFoundRepo(res);
    return;
  }
  try {
    if (body.length === 0) throw new GitHttpError(400, 'empty request body');
    const resultType = `application/x-${service}-result`;
    if (service === 'git-upload-pack') {
      const { pkts } = decodePkts(body);
      const first = pkts.find((p) => p.kind === 'data');
      const firstText = first?.data?.toString('utf8') ?? '';
      if (firstText.startsWith('command=')) {
        sendBytes(res, 200, resultType, uploadPackV2(repo, pkts));
      } else {
        sendBytes(res, 200, resultType, uploadPackV0(repo, pkts));
      }
    } else {
      const { pkts, next } = decodePkts(body, { stopAtFlush: true });
      sendBytes(res, 200, resultType, receivePack(repo, body.subarray(next), pkts));
    }
  } catch (err) {
    if (err instanceof GitHttpError) {
      sendBytes(res, err.status, 'text/plain', Buffer.from(err.message));
      return;
    }
    // a malformed exchange must answer, never hang: 400 and stay up
    sendBytes(res, 400, 'text/plain', Buffer.from(`git exchange failed: ${(err as Error).message}`));
  }
}

// ---------------------------------------------------------------- upload-pack v2

function uploadPackV2(repo: Repo, pkts: Pkt[]): Buffer {
  const args: string[] = [];
  let command = '';
  let sawDelim = false;
  for (const pkt of pkts) {
    if (pkt.kind === 'flush') break;
    if (pkt.kind === 'delim') { sawDelim = true; continue; }
    const text = (pkt.data ?? Buffer.alloc(0)).toString('utf8').replace(/\n$/, '');
    if (!sawDelim) {
      if (text.startsWith('command=')) command = text.slice(8).trim();
      continue;
    }
    if (text) args.push(text);
  }
  if (command !== 'ls-refs' && command !== 'fetch') {
    throw new GitHttpError(400, `unsupported v2 command ${JSON.stringify(command)}`);
  }
  if (command === 'ls-refs') return lsRefs(repo, args);
  return fetchV2(repo, args);
}

function lsRefs(repo: Repo, args: string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const lines: string[] = [];
  const headSha = repo.refs.get(`refs/heads/${repo.default_branch}`);
  const headWanted = prefixes.length === 0 || prefixes.some((p) => 'HEAD'.startsWith(p));
  if (!headSha && unborn && headWanted) {
    lines.push(`unborn HEAD symref-target:refs/heads/${repo.default_branch}`);
  } else if (headSha && headWanted) {
    const attr = symrefs ? ` symref-target:refs/heads/${repo.default_branch}` : '';
    lines.push(`${headSha} HEAD${attr}`);
  }
  for (const ref of [...repo.refs.keys()].sort()) {
    if (prefixes.length > 0 && !prefixes.some((p) => ref.startsWith(p))) continue;
    const sha = repo.refs.get(ref)!;
    const obj = repo.objects.get(sha);
    let line = `${sha} ${ref}`;
    if (peel && ref.startsWith('refs/tags/') && obj && obj.type === 'tag') {
      const peeled = peelToCommit(repo.objects, sha);
      if (peeled.commit) line += ` peeled:${peeled.commit}`;
    }
    lines.push(line);
  }
  const chunks: Buffer[] = lines.map((l) => pktLine(`${l}\n`));
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  clientShallows: string[];
  depth?: number;
}

function parseFetchArgs(args: string[]): FetchArgs {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallows: string[] = [];
  let depth: number | undefined;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) clientShallows.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = parseInt(arg.slice(7).trim(), 10);
    else if (arg.startsWith('deepen-since ') || arg.startsWith('deepen-not ') || arg.startsWith('filter ')) {
      // accepted, treated as best-effort
    }
  }
  return { wants, haves, clientShallows, depth };
}

/** The objects the client lacks, plus the shallow bookkeeping for this exchange. */
function computePack(repo: Repo, wants: string[], haves: string[], clientShallows: string[], depth?: number): {
  pack: Buffer | null;
  shallow: string[];
  unshallow: string[];
} {
  const full = closure(repo.objects, wants, { depth });
  const haveClosure = haves.length > 0 ? closure(repo.objects, haves, { stopAt: new Set(clientShallows) }) : null;
  const exclude = haveClosure ? new Set(haveClosure.objects.keys()) : undefined;
  const packClosure = closure(repo.objects, wants, { depth, exclude });
  const shallow = [...full.shallow].filter((oid) => !clientShallows.includes(oid));
  const unshallow = clientShallows.filter((oid) => full.objects.has(oid) && !full.shallow.has(oid));
  if (packClosure.objects.size === 0) return { pack: null, shallow, unshallow };
  const objects: GitObject[] = [...packClosure.objects.values()];
  return { pack: writePack(objects), shallow, unshallow };
}

function fetchV2(repo: Repo, args: string[]): Buffer {
  const { wants, haves, clientShallows, depth } = parseFetchArgs(args);
  const { pack, shallow, unshallow } = computePack(repo, wants, haves, clientShallows, depth);
  const chunks: Buffer[] = [];
  if (haves.length > 0) {
    chunks.push(pktLine('acknowledgments\n'));
    const known = haves.filter((oid) => repo.objects.has(oid));
    for (const oid of known) chunks.push(pktLine(`ACK ${oid}\n`));
    if (pack) {
      chunks.push(pktLine('ready\n'));
    } else {
      chunks.push(FLUSH);
      return Buffer.concat(chunks);
    }
    chunks.push(DELIM);
  }
  if (shallow.length > 0 || unshallow.length > 0) {
    chunks.push(pktLine('shallow-info\n'));
    for (const oid of shallow) chunks.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) chunks.push(pktLine(`unshallow ${oid}\n`));
    chunks.push(DELIM);
  }
  chunks.push(pktLine('packfile\n'));
  for (const part of chunkPack(pack!)) {
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), part])));
  }
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

/** Sideband chunks of at most 65500 payload bytes. */
function chunkPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let off = 0; off < pack.length; off += 65500) {
    out.push(pack.subarray(off, off + 65500));
  }
  if (out.length === 0) out.push(pack.subarray(0, 0));
  return out;
}

// ---------------------------------------------------------------- upload-pack v0

function uploadPackV0(repo: Repo, body: Buffer, pkts: Pkt[]): Buffer {
  // section 1: want/shallow/deepen lines, then flush; section 2: have/done, then flush; then the pack
  const wants: string[] = [];
  const clientShallows: string[] = [];
  let depth: number | undefined;
  const haves: string[] = [];
  let section = 1;
  for (const pkt of pkts) {
    if (pkt.kind === 'flush') { section += 1; continue; }
    if (pkt.kind === 'delim') continue;
    const text = (pkt.data ?? Buffer.alloc(0)).toString('utf8').replace(/\n$/, '');
    if (!text) continue;
    if (section === 1) {
      if (text.startsWith('want ')) {
        const parts = text.split(' ');
        wants.push(parts[1]);
      } else if (text.startsWith('shallow ')) clientShallows.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) depth = parseInt(text.slice(7).trim(), 10);
    } else {
      if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    }
  }
  const { pack, shallow, unshallow } = computePack(repo, wants, haves, clientShallows, depth);
  const chunks: Buffer[] = [];
  for (const oid of shallow) chunks.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) chunks.push(pktLine(`unshallow ${oid}\n`));
  chunks.push(pktLine('NAK\n'));
  if (pack) {
    for (const part of chunkPack(pack)) {
      chunks.push(pktLine(Buffer.concat([Buffer.from([1]), part])));
    }
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------- receive-pack v0

interface PushCommand { oldOid: string; newOid: string; ref: string }

function receivePack(repo: Repo, packBytes: Buffer, pkts: Pkt[]): Buffer {
  const commands: PushCommand[] = [];
  let clientCaps: string[] = [];
  for (const pkt of pkts) {
    if (pkt.kind === 'flush') break;
    if (pkt.kind === 'delim') continue;
    let text = (pkt.data ?? Buffer.alloc(0)).toString('utf8');
    if (!text.endsWith('\n')) text += '\n';
    text = text.slice(0, -1); // strip newline
    const nul = text.indexOf('\0');
    let capsPart = '';
    if (nul >= 0) {
      capsPart = text.slice(nul + 1);
      text = text.slice(0, nul);
    }
    if (capsPart) clientCaps = capsPart.split(' ').filter(Boolean);
    const parts = text.split(' ');
    if (parts.length !== 3) throw new GitHttpError(400, `bad receive-pack command ${JSON.stringify(text)}`);
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }

  const report: string[] = [];
  if (commands.length === 0) {
    report.push('unpack ok');
  } else {
    let stored: ObjMap | null = null;
    if (packBytes.length > 0) {
      try {
        const read = readPack(packBytes, (oid) => repo.objects.get(oid));
        stored = read.objects;
      } catch (err) {
        report.push(`unpack ${(err as Error).message}`);
        for (const command of commands) report.push(`ng ${command.ref} unpack error`);
        return frameReport(report, clientCaps);
      }
    }
    report.push('unpack ok');
    for (const [oid, obj] of stored ?? []) repo.objects.set(oid, obj);
    for (const command of commands) {
      const failure = applyCommand(repo, command);
      report.push(failure ? `ng ${command.ref} ${failure}` : `ok ${command.ref}`);
    }
  }
  return frameReport(report, clientCaps);
}

/** Validate one push command; apply it or return the ng reason. */
function applyCommand(repo: Repo, command: PushCommand): string | undefined {
  if (command.ref === 'HEAD') return 'refusing to update HEAD';
  const current = repo.refs.get(command.ref);
  const { oldOid, newOid, ref } = command;
  const oldMatches = current === undefined ? oldOid === ZERO_OID : oldOid === current;
  if (!oldMatches) return current === undefined ? 'lock error creating ref' : 'fetch first';
  if (newOid === ZERO_OID) {
    if (current === undefined) return 'no such ref to delete';
    repo.refs.delete(ref);
    return undefined;
  }
  const obj = repo.objects.get(newOid);
  if (!obj) return 'missing necessary objects';
  if (ref.startsWith('refs/heads/')) {
    if (oldOid !== ZERO_OID && newOid !== oldOid) {
      const newObj = repo.objects.get(newOid);
      const oldObj = repo.objects.get(oldOid);
      if (newObj && oldObj && newObj.type === 'commit' && oldObj.type === 'commit') {
        if (!isDescendant(repo.objects, newOid, oldOid)) return 'non-fast-forward';
      }
    }
    const commit = repo.objects.get(newOid);
    if (commit && commit.type !== 'commit') return 'refusing to point a branch at a non-commit';
  }
  repo.refs.set(ref, newOid);
  return undefined;
}

/** Frame the report-status stream, sideband-wrapped when the client asked for it. */
function frameReport(report: string[], clientCaps: string[]): Buffer {
  const inner = pktLines(report.map((line) => `${line}\n`));
  const chunks: Buffer[] = [];
  if (clientCaps.includes('side-band-64k')) {
    for (let off = 0; off < inner.length; off += 65500) {
      const part = inner.subarray(off, Math.min(off + 65500, inner.length));
      chunks.push(pktLine(Buffer.concat([Buffer.from([1]), part])));
    }
  } else {
    chunks.push(inner);
  }
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

export { MAX_BODY };
