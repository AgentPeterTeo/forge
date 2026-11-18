/**
 * store.ts — the in-memory forge state: repos, issues, pulls, labels, comments.
 * One Map of repos; every surface (REST, GraphQL, MCP, git) shares this state.
 */
import { buildCommit, buildTag, buildTree, closure, parseCommit, parseTree, storeObject, type GitObject, type ObjMap, type TreeEntry } from './gitstore.ts';

export const FIXED_TS = '2026-01-01T00:00:00Z';
export const FORGE_USER = { login: 'adaiversen', id: 1000, type: 'User', name: 'ada iversen' } as const;

export interface Label { name: string; color: string }
export interface IssueComment { id: number; body: string; created_at: string; user: { login: string } }

export interface Issue {
  kind: 'issue';
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  created_at: string;
  updated_at: string;
  user: { login: string };
  comments: IssueComment[];
}

export interface PullRequest extends Issue {
  kind: 'pull';
  head: { ref: string; sha: string; label: string };
  base: { ref: string; sha: string; label: string };
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  mergeable: boolean;
}

export interface Repo {
  owner: string;
  name: string;
  id: number;
  private: boolean;
  description: string;
  default_branch: string;
  created_at: string;
  objects: ObjMap;
  refs: Map<string, string>; // full refname -> oid
  issues: Array<Issue | PullRequest>; // shared number space, GitHub-style
  labels: Label[];
  nextIssueNumber: number;
  nextCommentId: number;
}

let nextRepoId = 49000;
let nextIssueId = 100000;
let nextCommentId = 5000000;

export const repos = new Map<string, Repo>(); // key: owner/name (lowercase)

export function repoKey(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

export function findRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

export function createRepo(owner: string, name: string, options: { description?: string; private?: boolean; defaultBranch?: string } = {}): Repo {
  const key = repoKey(owner, name);
  if (repos.has(key)) throw new RepoError(422, `name already exists on this account`);
  const repo: Repo = {
    owner,
    name,
    id: nextRepoId++,
    private: options.private ?? false,
    description: options.description ?? '',
    default_branch: options.defaultBranch ?? 'main',
    created_at: FIXED_TS,
    objects: new Map(),
    refs: new Map(),
    issues: [],
    labels: [],
    nextIssueNumber: 1,
    nextCommentId: 1,
  };
  repos.set(key, repo);
  return repo;
}

export function deleteRepo(owner: string, name: string): boolean {
  return repos.delete(repoKey(owner, name));
}

export function listRepos(owner: string): Repo[] {
  return [...repos.values()].filter((r) => r.owner.toLowerCase() === owner.toLowerCase());
}

export class RepoError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------- issue/pull helpers

export function listIssues(repo: Repo, opts: { state?: 'open' | 'closed' | 'all'; kind?: 'issue' | 'pull' } = {}): Array<Issue | PullRequest> {
  const state = opts.state ?? 'open';
  let items = repo.issues;
  if (opts.kind === 'issue') items = items.filter((i) => i.kind === 'issue');
  if (opts.kind === 'pull') items = items.filter((i) => i.kind === 'pull');
  if (state !== 'all') items = items.filter((i) => i.state === state);
  return items;
}

export function findIssue(repo: Repo, number: number): Issue | PullRequest | undefined {
  return repo.issues.find((i) => i.number === number);
}

export function createIssue(repo: Repo, input: { title: string; body?: string; labels?: string[] }): Issue {
  if (typeof input.title !== 'string' || input.title.trim() === '') throw new RepoError(422, 'title is required');
  const labels = resolveLabels(repo, input.labels);
  const issue: Issue = {
    kind: 'issue',
    number: repo.nextIssueNumber++,
    id: nextIssueId++,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels,
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    user: { login: FORGE_USER.login },
    comments: [],
  };
  repo.issues.push(issue);
  return issue;
}

export function createPull(repo: Repo, input: { title: string; body?: string; head: string; base: string }): PullRequest {
  if (typeof input.title !== 'string' || input.title.trim() === '') throw new RepoError(422, 'title is required');
  const headRef = repo.refs.get(`refs/heads/${input.head}`);
  const baseRef = repo.refs.get(`refs/heads/${input.base}`);
  if (!headRef) throw new RepoError(422, `head ref ${input.head} does not exist`);
  if (!baseRef) throw new RepoError(422, `base ref ${input.base} does not exist`);
  const pr: PullRequest = {
    kind: 'pull',
    number: repo.nextIssueNumber++,
    id: nextIssueId++,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: [],
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    user: { login: FORGE_USER.login },
    comments: [],
    head: { ref: input.head, sha: headRef, label: `${repo.owner}:${input.head}` },
    base: { ref: input.base, sha: baseRef, label: `${repo.owner}:${input.base}` },
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    mergeable: true,
  };
  repo.issues.push(pr);
  return pr;
}

export function addComment(issue: Issue | PullRequest, body: string, repo: Repo): IssueComment {
  const comment: IssueComment = {
    id: nextCommentId++,
    body,
    created_at: FIXED_TS,
    user: { login: FORGE_USER.login },
  };
  issue.comments.push(comment);
  issue.updated_at = FIXED_TS;
  return comment;
}

export function createLabel(repo: Repo, name: string, color: string): Label {
  if (repo.labels.some((l) => l.name === name)) throw new RepoError(422, 'label already exists');
  const label = { name, color: color ?? 'ededed' };
  repo.labels.push(label);
  return label;
}

function resolveLabels(repo: Repo, names?: string[]): Label[] {
  if (!names || names.length === 0) return [];
  return names.map((name) => {
    const found = repo.labels.find((l) => l.name === name);
    if (!found) throw new RepoError(422, `label '${name}' does not exist`);
    return found;
  });
}

// ---------------------------------------------------------------- git helpers on repos

export const ZERO_SHA = '0000000000000000000000000000000000000000';

export function refHead(repo: Repo): string | undefined {
  return repo.refs.get(`refs/heads/${repo.default_branch}`);
}

export function isUnborn(repo: Repo): boolean {
  return refHead(repo) === undefined;
}

/** The refs to advertise: HEAD is handled separately by the callers. */
export function sortedRefs(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

/** Insert a commit object graph into the repo, returning its oid. */
export function insertCommit(repo: Repo, tree: string, parents: string[], message: string): string {
  return storeObject(repo.objects, 'commit', buildCommit({
    tree,
    parents,
    author: { name: FORGE_USER.login, email: 'forge@forge' },
    committer: { name: FORGE_USER.login, email: 'forge@forge' },
    message,
  }));
}

export function insertBlob(repo: Repo, data: Buffer): string {
  return storeObject(repo.objects, 'blob', data);
}

export function insertTree(repo: Repo, entries: TreeEntry[]): string {
  return storeObject(repo.objects, 'tree', buildTree(entries));
}

export function insertTag(repo: Repo, tag: string, target: string, type: 'commit' | 'tree' | 'blob' | 'tag', message: string): string {
  return storeObject(repo.objects, 'tag', buildTag({ object: target, type, tag, message }));
}

/** Update a path in a tree (recursive), returning the new root tree oid. */
export function upsertPath(repo: Repo, rootTree: string | undefined, path: string, mode: string, blobSha: string): string {
  const parts = path.split('/').filter((p) => p.length > 0);
  if (parts.length === 0) throw new RepoError(422, 'empty path');
  return upsertDir(repo, rootTree, parts, mode, blobSha);
}

function upsertDir(repo: Repo, treeOid: string | undefined, parts: string[], mode: string, blobSha: string): string {
  const name = parts[0];
  if (parts.length === 1) {
    const entries: TreeEntry[] = treeOid ? parseTree(repo.objects.get(treeOid)!.data) : [];
    const existing = entries.findIndex((e) => e.name === name);
    const entry: TreeEntry = { mode, name, sha: blobSha };
    if (existing >= 0) entries[existing] = entry;
    else entries.push(entry);
    return insertTree(repo, entries);
  }
  const entries: TreeEntry[] = treeOid ? parseTree(repo.objects.get(treeOid)!.data) : [];
  const isDir = (e: TreeEntry): boolean => e.mode === '40000' || e.mode === '040000';
  const child = entries.find((e) => e.name === name && isDir(e));
  const childSha = upsertDir(repo, child?.sha, parts.slice(1), mode, blobSha);
  const idx = entries.findIndex((e) => e.name === name);
  const entry: TreeEntry = { mode: '40000', name, sha: childSha };
  if (idx >= 0) entries[idx] = entry;
  else entries.push(entry);
  return insertTree(repo, entries);
}

/** Remove a path from a tree (recursive), returning the new root tree oid or undefined when the tree empties. */
export function removePath(repo: Repo, treeOid: string | undefined, path: string): string | undefined {
  const parts = path.split('/').filter((p) => p.length > 0);
  if (parts.length === 0 || !treeOid) return treeOid;
  const entries = parseTree(repo.objects.get(treeOid)!.data);
  const name = parts[0];
  if (parts.length === 1) {
    const kept = entries.filter((e) => e.name !== name);
    if (kept.length === 0) return undefined;
    return insertTree(repo, kept);
  }
  const child = entries.find((e) => e.name === name && (e.mode === '40000' || e.mode === '040000'));
  if (!child) return treeOid;
  const childSha = removePath(repo, child.sha, parts.slice(1).join('/'));
  const idx = entries.findIndex((e) => e.name === name);
  if (childSha === undefined) {
    entries.splice(idx, 1);
    if (entries.length === 0) return undefined;
    return insertTree(repo, entries);
  }
  entries[idx] = { ...child, sha: childSha };
  return insertTree(repo, entries);
}

/** Commit a change to a branch (creating it from the default branch when missing); returns the commit oid. */
export function commitToBranch(repo: Repo, branch: string, mutate: (tip: string | undefined) => string | undefined, message: string): string {
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName) ?? refHead(repo);
  const tipTree = tip === undefined ? undefined : parseCommit(repo.objects.get(tip)!.data).tree;
  let newTree = mutate(tipTree);
  if (newTree === undefined) {
    // deleting the last file empties the tree; use the empty tree
    newTree = insertTree(repo, []);
  }
  const parent = repo.refs.get(refName);
  const commit = insertCommit(repo, newTree, parent ? [parent] : [], message);
  repo.refs.set(refName, commit);
  return commit;
}

/** Commit a change to a branch that must already exist; returns the commit oid. */
export function commitToExistingBranch(repo: Repo, branch: string, mutate: (tip: string | undefined) => string | undefined, message: string): string {
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName);
  if (!tip) throw new RepoError(422, `branch ${branch} does not exist`);
  const tipTree = parseCommit(repo.objects.get(tip)!.data).tree;
  let newTree = mutate(tipTree);
  if (newTree === undefined) newTree = insertTree(repo, []);
  const commit = insertCommit(repo, newTree, [tip], message);
  repo.refs.set(refName, commit);
  return commit;
}

/** Walk commit history from a ref (or oid), newest first. */
export function walkHistory(repo: Repo, start: string, limit = 100): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0 && out.length < limit) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return out;
}

/** Resolve a short ref name, full ref name, or oid to an oid the repo holds. */
export function resolveRef(repo: Repo, ref: string): string | undefined {
  if (repo.objects.has(ref)) return ref;
  const candidates = [ref, `refs/heads/${ref}`, `refs/tags/${ref}`, `refs/${ref}`];
  for (const c of candidates) {
    const sha = repo.refs.get(c);
    if (sha) return sha;
  }
  return undefined;
}

/** Changed files between two trees: [{path, oldSha, newSha, oldMode, newMode}]. */
export interface TreeDiff { path: string; before?: { sha: string; mode: string }; after?: { sha: string; mode: string } }

export function diffTrees(repo: Repo, beforeTree: string | undefined, afterTree: string | undefined, prefix = ''): TreeDiff[] {
  const beforeEntries = beforeTree ? parseTree(repo.objects.get(beforeTree)!.data) : [];
  const afterEntries = afterTree ? parseTree(repo.objects.get(afterTree)!.data) : [];
  const byName = new Map<string, TreeEntry>();
  for (const e of beforeEntries) byName.set(e.name, e);
  const out: TreeDiff[] = [];
  for (const e of afterEntries) {
    const old = byName.get(e.name);
    byName.delete(e.name);
    if (old && old.sha === e.sha) continue;
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    const dirAfter = e.mode === '40000' || e.mode === '040000';
    const dirBefore = old !== undefined && (old.mode === '40000' || old.mode === '040000');
    if (dirAfter || dirBefore) {
      out.push(...diffTrees(repo, dirBefore ? old!.sha : undefined, dirAfter ? e.sha : undefined, path));
      if (!dirAfter) out.push({ path, after: { sha: e.sha, mode: e.mode } });
      if (old && !dirBefore) out.push({ path, before: { sha: old.sha, mode: old.mode } });
      continue;
    }
    out.push({ path, before: old ? { sha: old.sha, mode: old.mode } : undefined, after: { sha: e.sha, mode: e.mode } });
  }
  for (const [name, old] of byName) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (old.mode === '40000' || old.mode === '040000') {
      out.push(...diffTrees(repo, old.sha, undefined, path));
      continue;
    }
    out.push({ path, before: { sha: old.sha, mode: old.mode } });
  }
  return out;
}

/** Merge a pull request: a merge commit on base pointing at the head tree. */
export function mergePull(repo: Repo, pr: PullRequest): string {
  const baseRef = `refs/heads/${pr.base.ref}`;
  const baseTip = repo.refs.get(baseRef);
  const headTip = pr.head.sha;
  const headCommit = repo.objects.get(headTip);
  if (!headCommit || headCommit.type !== 'commit') throw new RepoError(422, 'head commit missing');
  const headTree = parseCommit(headCommit.data).tree;
  const parents = baseTip ? [baseTip, headTip] : [headTip];
  const mergeSha = insertCommit(repo, headTree, parents, `Merge pull request #${pr.number} from ${repo.owner}/${pr.head.ref}`);
  repo.refs.set(baseRef, mergeSha);
  pr.merged = true;
  pr.state = 'closed';
  pr.merged_at = FIXED_TS;
  pr.merge_commit_sha = mergeSha;
  return mergeSha;
}

/** Objects reachable from a repo's wants, minus what the client already holds. */
export function repoClosure(repo: Repo, wants: string[], opts: { depth?: number; exclude?: Set<string> } = {}) {
  return closure(repo.objects, wants, opts);
}

export type { GitObject, ObjMap };
