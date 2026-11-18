/**
 * gitstore.ts — git object model: hashing, trees, commits, tags, packfile read/write.
 * Everything is hand-rolled: no git binary, no parse libs. SHA-1 objects only.
 */
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject { type: ObjType; data: Buffer }
export type ObjMap = Map<string, GitObject>;

const TYPE_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** SHA-1 of a git object (type + size + NUL + payload). */
export function hashObject(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(`${type} ${data.length}`);
  h.update(new Uint8Array([0]));
  h.update(data);
  return h.digest('hex');
}

export function storeObject(objects: ObjMap, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  objects.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------- trees

export interface TreeEntry { mode: string; name: string; sha: string }

/** git's tree ordering: names compared byte-wise, directories as if suffixed with '/'. */
export function treeSortKey(entry: TreeEntry): Buffer {
  const isDir = entry.mode === '40000' || entry.mode === '040000';
  return Buffer.from(isDir ? `${entry.name}/` : entry.name, 'utf8');
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka.compare(kb);
  });
  const chunks: Buffer[] = [];
  for (const e of sorted) {
    chunks.push(Buffer.from(`${e.mode} ${e.name}`, 'utf8'), Buffer.from([0]), Buffer.from(e.sha, 'hex'));
  }
  return Buffer.concat(chunks);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const nul = data.indexOf(0, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) {
      throw new Error('malformed tree entry');
    }
    entries.push({
      mode: data.subarray(i, sp).toString('utf8'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      sha: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    i = nul + 21;
  }
  return entries;
}

// ---------------------------------------------------------------- commits / tags

export interface CommitPerson { name: string; email: string }
export interface CommitInfo {
  tree: string;
  parents: string[];
  author: CommitPerson;
  committer: CommitPerson;
  message: string;
}

export function buildCommit(info: CommitInfo): Buffer {
  const lines: string[] = [`tree ${info.tree}`];
  for (const p of info.parents) lines.push(`parent ${p}`);
  // Fixed deterministic stamp: every byte the server stores is reproducible.
  lines.push(`author ${info.author.name} <${info.author.email}> 1767225600 +0000`);
  lines.push(`committer ${info.committer.name} <${info.committer.email}> 1767225600 +0000`);
  lines.push('', info.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author: CommitPerson = { name: 'unknown', email: 'unknown@forge' };
  let committer: CommitPerson = { name: 'unknown', email: 'unknown@forge' };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = parsePerson(line.slice(7));
    else if (line.startsWith('committer ')) committer = parsePerson(line.slice(10));
  }
  return { tree, parents, author, committer, message };
}

function parsePerson(s: string): CommitPerson {
  const lt = s.indexOf('<');
  const gt = s.indexOf('>', lt);
  if (lt < 0 || gt < 0) return { name: s.trim(), email: 'unknown@forge' };
  return { name: s.slice(0, lt).trim(), email: s.slice(lt + 1, gt).trim() };
}

// ------------------------------------------------------------- parsed-object memo
// Objects in a repo's object map are immutable once stored, and every walk (closure,
// isDescendant, history, clone) re-parses the same commits and trees over and over.
// Memoising the parse per object map removes that repeated text split/scan work; the
// WeakMap key is the map itself, so a deleted repo's memo is collected with it.

const commitInfoMemo = new WeakMap<ObjMap, Map<string, CommitInfo>>();
export function parseCommitCached(objects: ObjMap, oid: string): CommitInfo | undefined {
  const obj = objects.get(oid);
  if (obj === undefined || obj.type !== 'commit') return undefined;
  let perRepo = commitInfoMemo.get(objects);
  if (perRepo === undefined) {
    perRepo = new Map<string, CommitInfo>();
    commitInfoMemo.set(objects, perRepo);
  }
  let info = perRepo.get(oid);
  if (info === undefined) {
    info = parseCommit(obj.data);
    perRepo.set(oid, info);
  }
  return info;
}

const treeMemo = new WeakMap<ObjMap, Map<string, TreeEntry[]>>();
export function parseTreeCached(objects: ObjMap, oid: string): TreeEntry[] | undefined {
  const obj = objects.get(oid);
  if (obj === undefined || obj.type !== 'tree') return undefined;
  let perRepo = treeMemo.get(objects);
  if (perRepo === undefined) {
    perRepo = new Map<string, TreeEntry[]>();
    treeMemo.set(objects, perRepo);
  }
  let entries = perRepo.get(oid);
  if (entries === undefined) {
    entries = parseTree(obj.data);
    perRepo.set(oid, entries);
  }
  return entries;
}

export interface TagInfo { object: string; type: ObjType; tag: string; message: string }

export function buildTag(info: TagInfo): Buffer {
  const text = `object ${info.object}\ntype ${info.type}\ntag ${info.tag}\ntagger forge <forge@forge> 1767225600 +0000\n\n${info.message}`;
  return Buffer.from(text, 'utf8');
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type: ObjType = 'commit';
  let tag = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as ObjType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
  }
  return { object, type, tag, message };
}

// ---------------------------------------------------------------- packfile write (no deltas)

export function writePack(objects: GitObject[]): Buffer {
  const chunks: Buffer[] = [];
  chunks.push(Buffer.from('PACK'), u32(2), u32(objects.length));
  for (const obj of objects) {
    chunks.push(objHeader(TYPE_CODES[obj.type], obj.data.length));
    chunks.push(deflateSync(obj.data, { level: 6 }));
  }
  const body = Buffer.concat(chunks);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

/** The pack object header: 3-bit type + size as varint, low 4 bits in the first byte. */
function objHeader(type: number, size: number): Buffer {
  const out: number[] = [];
  let first = (type << 4) | (size & 0x0f);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    out.push(first | 0x80);
    first = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  out.push(first);
  return Buffer.from(out);
}

// ---------------------------------------------------------------- packfile read

export interface ReadPackResult { objects: ObjMap }

/**
 * Parse a packfile, resolving ofs- and ref-deltas against bases inside (or outside) the pack.
 * `external` resolves a base oid when it is not in the pack itself.
 */
export function readPack(pack: Buffer, external?: (oid: string) => GitObject | undefined): ReadPackResult {
  if (pack.length < 32 || pack.subarray(0, 4).toString('utf8') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const objects: ObjMap = new Map();
  const byOffset = new Map<number, { oid: string; obj: GitObject }>();
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const start = off;
    const header = readObjHeader(pack, off);
    off = header.next;
    let payload: Buffer;
    let base: GitObject | undefined;
    if (header.type === 6) {
      const ofs = readOfsVarint(pack, off);
      off = ofs.next;
      const prior = byOffset.get(start - ofs.value);
      if (!prior) throw new Error('ofs-delta base not found in pack');
      base = prior.obj;
    } else if (header.type === 7) {
      const baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
      base = objects.get(baseOid) ?? external?.(baseOid);
      if (!base) throw new Error(`ref-delta base ${baseOid} not available`);
    }
    const inflated = inflateAt(pack, off);
    off = inflated.next;
    const type: ObjType = base ? base.type : CODE_TYPES[header.type] ?? 'blob';
    payload = base ? applyDelta(inflated.data, base.data) : inflated.data;
    const obj: GitObject = { type, data: payload };
    const oid = hashObject(obj.type, obj.data);
    objects.set(oid, obj);
    byOffset.set(start, { oid, obj });
  }
  return { objects };
}

function readObjHeader(pack: Buffer, off: number): { type: number; size: number; next: number } {
  let byte = pack[off];
  off += 1;
  const type = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  while (byte & 0x80) {
    byte = pack[off];
    off += 1;
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }
  return { type, size, next: off };
}

/** The negative-offset varint git uses for ofs-delta: 7 bits per byte, +1 per continuation. */
function readOfsVarint(pack: Buffer, off: number): { value: number; next: number } {
  let byte = pack[off];
  off += 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = pack[off];
    off += 1;
    value = ((value + 1) << 7) | (byte & 0x7f);
  }
  return { value, next: off };
}

/** Inflate a zlib stream at `off`, reporting where the stream ended. */
export function inflateAt(buf: Buffer, off: number): { data: Buffer; next: number } {
  const view = buf.subarray(off);
  const inflated = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: inflated.buffer, next: off + inflated.engine.bytesWritten };
}

// ---------------------------------------------------------------- delta application

export function applyDelta(delta: Buffer, base: Buffer): Buffer {
  let off = 0;
  // base size varint
  off = skipVarint(delta, off);
  const resultSize = readVarint(delta, off);
  off = resultSize.next;
  const out = Buffer.alloc(resultSize.value);
  let w = 0;
  while (off < delta.length) {
    const op = delta[off];
    off += 1;
    if (op & 0x80) {
      // copy from base: bits 0-3 select offset bytes, bits 4-6 select size bytes
      let cpOff = 0;
      let cpSize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) { cpOff |= delta[off] << (bit * 8); off += 1; }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (1 << (4 + bit))) { cpSize |= delta[off] << (bit * 8); off += 1; }
      }
      if (cpSize === 0) cpSize = 0x10000;
      base.copy(out, w, cpOff, cpOff + cpSize);
      w += cpSize;
    } else if (op > 0) {
      delta.copy(out, w, off, off + op);
      off += op;
      w += op;
    } else {
      throw new Error('unsupported delta opcode 0');
    }
  }
  if (w !== resultSize.value) throw new Error(`delta produced ${w} bytes, expected ${resultSize.value}`);
  return out;
}

function readVarint(buf: Buffer, off: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let byte = buf[off];
  off += 1;
  value |= (byte & 0x7f) << shift;
  while (byte & 0x80) {
    shift += 7;
    byte = buf[off];
    off += 1;
    value |= (byte & 0x7f) << shift;
  }
  return { value, next: off };
}

function skipVarint(buf: Buffer, off: number): number {
  while (buf[off] & 0x80) off += 1;
  return off + 1;
}

// ---------------------------------------------------------------- reachability

export interface ClosureOpts {
  /** Stop after N commit generations from each want (git's depth). */
  depth?: number;
  /** Objects already held by the client: excluded from the result. */
  exclude?: Set<string>;
  /** Client shallow boundaries: commits whose parents the client does not have; traversal stops below them. */
  stopAt?: Set<string>;
}

export interface ClosureResult {
  objects: ObjMap;
  /** Commit oids at the depth boundary (still parents below the cut). */
  shallow: Set<string>;
}

/** Collect every object reachable from `roots` (any type), with optional depth and subtraction. */
export function closure(objects: ObjMap, roots: string[], opts: ClosureOpts = {}): ClosureResult {
  const seen = new Set<string>();
  const result: ObjMap = new Map();
  const shallow = new Set<string>();
  const exclude = opts.exclude;
  const depth = opts.depth;
  const stopAt = opts.stopAt;

  interface Item { oid: string; generation: number }
  const queue: Item[] = roots.map((oid) => ({ oid, generation: 1 }));

  while (queue.length > 0) {
    const { oid, generation } = queue.shift()!;
    if (seen.has(oid)) continue;
    const obj = objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (!exclude || !exclude.has(oid)) result.set(oid, obj);
    if (obj.type === 'commit') {
      const info = parseCommitCached(objects, oid)!;
      if (info.tree) queue.push({ oid: info.tree, generation: Infinity });
      if (stopAt !== undefined && stopAt.has(oid)) {
        if (info.parents.length > 0) shallow.add(oid);
      } else if (depth !== undefined && generation >= depth) {
        if (info.parents.length > 0) shallow.add(oid);
      } else {
        for (const p of info.parents) queue.push({ oid: p, generation: generation + 1 });
      }
    } else if (obj.type === 'tag') {
      const info = parseTag(obj.data);
      if (info.object) queue.push({ oid: info.object, generation });
    }
    // blobs need no traversal; trees queue their children only through commits' trees below
    if (obj.type === 'tree') {
      for (const entry of parseTreeCached(objects, oid)!) {
        queue.push({ oid: entry.sha, generation: Infinity });
      }
    }
  }
  return { objects: result, shallow };
}

/** True when `descendant` (a commit oid) has `ancestor` in its history. */
export function isDescendant(objects: ObjMap, descendant: string, ancestor: string): boolean {
  if (descendant === ancestor) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (oid === ancestor) return true;
    const info = parseCommitCached(objects, oid);
    if (info === undefined) continue;
    for (const p of info.parents) queue.push(p);
  }
  return false;
}

/** Peel a ref to the commit it points at (through tags). */
export function peelToCommit(objects: ObjMap, oid: string): { commit?: string; tag?: string } {
  let current = oid;
  let tag: string | undefined;
  for (let hops = 0; hops < 10; hops += 1) {
    const obj = objects.get(current);
    if (!obj) return {};
    if (obj.type === 'tag') {
      tag = current;
      current = parseTag(obj.data).object;
      continue;
    }
    if (obj.type === 'commit') return { commit: current, tag };
    return {};
  }
  return {};
}
