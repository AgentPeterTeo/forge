/**
 * rest.ts — REST v3: repositories, branches, commits, contents, issues, labels,
 * comments, pull requests, files, merges. GitHub-shaped JSON throughout.
 */
import type { ServerResponse } from 'node:http';
import { parseCommit, parseTree } from './gitstore.ts';
import {
  addComment, commitToBranch, commitToExistingBranch, createIssue, createLabel, createPull, createRepo,
  deleteRepo, diffTrees, findIssue, findRepo, FIXED_TS, FORGE_USER, insertBlob, type Issue,
  type IssueComment, listIssues, listRepos, mergePull, type PullRequest, refHead, removePath, type Repo,
  RepoError, repoKey, repos, resolveRef, stateEpoch, upsertPath, walkHistory,
} from './store.ts';

export class RestError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.body = { message, ...extra };
  }
}

/** GitHub-style request ids: presence is what the protocol checks; the counter stays deterministic. */
let requestSeq = 0;
export function nextRequestId(): string {
  requestSeq += 1;
  return `forge-${requestSeq.toString(16).padStart(12, '0')}`;
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  if (currentGetKey !== null && (status === 200 || status === 404)) {
    if (restGetCache.size > 512) restGetCache.clear();
    restGetCache.set(currentGetKey, { epoch: stateEpoch, status, text, headers });
  }
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)), 'x-github-request-id': nextRequestId(), ...headers });
  res.end(text);
}

// ---------------------------------------------------------------- GET response memo
// A REST GET's answer depends only on the store state, the request target and the Host the
// caller used (pagination links). `stateEpoch` advances on every mutation, so any write
// invalidates all memoised answers at once; nothing stale can ever be served.

interface CachedGet { epoch: number; status: number; text: string; headers: Record<string, string> }
const restGetCache = new Map<string, CachedGet>();
/** Set while a GET routes, so sendJson can memoise the answer; null on every other request. */
let currentGetKey: string | null = null;

/** Cache key: the raw request target (path + query) plus the Host the links must carry. */
export function getCacheKey(rawUrl: string, host: string): string {
  return `${rawUrl}|${host}`;
}

/** A memoised answer that is still current, or null. Mutations advance the epoch past it. */
export function lookupGet(key: string): CachedGet | null {
  const hit = restGetCache.get(key);
  return hit !== undefined && hit.epoch === stateEpoch ? hit : null;
}

/** Serve a memoised answer verbatim; the request id stays per-request. */
export function respondCachedGet(res: ServerResponse, hit: CachedGet): void {
  res.writeHead(hit.status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(hit.text)), 'x-github-request-id': nextRequestId(), ...hit.headers });
  res.end(hit.text);
}

// ---------------------------------------------------------------- shapes

function repoJson(repo: Repo): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: fullName,
    private: repo.private,
    owner: { login: repo.owner, id: 1, type: 'User', site_admin: false },
    html_url: `https://forge.example/${fullName}`,
    description: repo.description || null,
    fork: false,
    url: `/repos/${fullName}`,
    created_at: repo.created_at,
    updated_at: repo.created_at,
    pushed_at: repo.created_at,
    git_url: `git://forge.example/${fullName}.git`,
    ssh_url: `git@forge.example:${fullName}.git`,
    clone_url: `https://forge.example/${fullName}.git`,
    default_branch: repo.default_branch,
    size: 0,
    language: null,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    has_issues: true,
    has_wiki: true,
    has_pages: false,
    archived: false,
    disabled: false,
  };
}

function issueJson(repo: Repo, issue: Issue | PullRequest): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((l) => ({ id: 1, name: l.name, color: l.color, default: false })),
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.state === 'closed' ? FIXED_TS : null,
    user: { login: FORGE_USER.login, id: 1, type: 'User' },
    html_url: `https://forge.example/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
  if (issue.kind === 'pull') {
    const pr = issue as PullRequest;
    base.pull_request = {
      url: `/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
      html_url: `https://forge.example/${repo.owner}/${repo.name}/pulls/${pr.number}`,
      merged_at: pr.merged_at,
    };
  }
  return base;
}

function pullJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    ...issueJson(repo, pr),
    draft: false,
    merged: pr.merged,
    mergeable: pr.merged ? false : true,
    mergeable_state: pr.merged ? 'dirty' : 'clean',
    merged_at: pr.merged_at,
    merge_commit_sha: pr.merge_commit_sha,
    merged_by: pr.merged ? { login: FORGE_USER.login, id: 1 } : null,
    head: { ref: pr.head.ref, sha: pr.head.sha, label: pr.head.label, repo: repoJson(repo) },
    base: { ref: pr.base.ref, sha: pr.base.sha, label: pr.base.label, repo: repoJson(repo) },
    commits: 1,
    additions: 1,
    deletions: 0,
    changed_files: 0,
  };
}

function commentJson(comment: IssueComment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    body: comment.body,
    created_at: comment.created_at,
    updated_at: comment.created_at,
    user: { login: comment.user.login, id: 1, type: 'User' },
  };
}

// ---------------------------------------------------------------- pagination

interface Page { slice: unknown[]; headers: Record<string, string>; hasNext: boolean }

function paginate(items: unknown[], url: URL): Page {
  const perPage = clampInt(url.searchParams.get('per_page') ?? '30', 1, 100, 30);
  const page = clampInt(url.searchParams.get('page') ?? '1', 1, 1e9, 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const hasNext = start + perPage < items.length;
  const headers: Record<string, string> = {};
  const links: string[] = [];
  const host = (url as URL & { headersHost?: string }).headersHost ?? 'forge.example';
  const linkFor = (p: number, rel: string): string => {
    const params = new URLSearchParams(url.searchParams);
    params.set('page', String(p));
    return `<http://${host}${url.pathname}?${params.toString()}>; rel="${rel}"`;
  };
  if (page > 1) links.push(linkFor(page - 1, 'prev'));
  if (hasNext) links.push(linkFor(page + 1, 'next'));
  if (links.length > 0) headers.link = links.join(', ');
  return { slice, headers, hasNext };
}

function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function urlWithHost(url: URL, req: { headers: Record<string, unknown> }): URL {
  const host = String(req.headers.host ?? 'forge.example');
  (url as URL & { headersHost?: string }).headersHost = host;
  return url;
}

// ---------------------------------------------------------------- dispatch

export interface RestRequest {
  method: string;
  url: URL;
  req: { headers: Record<string, unknown> };
  body: Record<string, unknown> | null;
  /** The raw request target (path + query) — the cache key half that needs no URL object. */
  rawUrl: string;
}

export function handleRest(res: ServerResponse, request: RestRequest): boolean {
  const key = request.method === 'GET' ? getCacheKey(request.rawUrl, String(request.req.headers.host ?? 'forge.example')) : null;
  const prev = currentGetKey;
  currentGetKey = key;
  try {
    return routeRest(res, request);
  } catch (err) {
    if (err instanceof RestError || err instanceof RepoError) {
      const status = err instanceof RestError ? err.status : err.status;
      sendJson(res, status, err instanceof RestError ? err.body : { message: err.message });
      return true;
    }
    throw err;
  } finally {
    currentGetKey = prev;
  }
}

function routeRest(res: ServerResponse, request: RestRequest): boolean {
  const { method } = request;
  const url = urlWithHost(request.url, request.req);
  const path = url.pathname;
  const raw = request.body as Record<string, unknown> | null;

  // api root + meta
  if (path === '/api/v3' || path === '/api/v3/') {
    if (method !== 'GET') { sendJson(res, 404, { message: 'Not Found' }); return true; }
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      issue_url: '/api/v3/repos/{owner}/{repo}/issues{/number}',
      pull_request_url: '/api/v3/repos/{owner}/{repo}/pulls{/number}',
      content_url: '/api/v3/repos/{owner}/{repo}/contents/{+path}',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (path === '/api/v3/meta') {
    if (method !== 'GET') { sendJson(res, 404, { message: 'Not Found' }); return true; }
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }

  // /user + /user/repos
  if (path === '/api/v3/user') {
    if (method !== 'GET') { sendJson(res, 404, { message: 'Not Found' }); return true; }
    sendJson(res, 200, { login: FORGE_USER.login, id: 1, node_id: 'U_1', type: 'User', site_admin: false, name: 'Forge User' });
    return true;
  }
  if (path === '/api/v3/user/repos') {
    if (method === 'GET') {
      const items = listRepos(FORGE_USER.login).sort((a, b) => a.id - b.id).map(repoJson);
      const page = paginate(items, url);
      sendJson(res, 200, page.slice, page.headers);
      return true;
    }
    if (method === 'POST') {
      const name = expectString(raw?.name, 'name');
      const repo = createRepo(FORGE_USER.login, name, {
        description: raw?.description && typeof raw.description === 'string' ? raw.description : '',
        private: raw?.private === true,
        defaultBranch: typeof raw?.default_branch === 'string' && raw.default_branch ? raw.default_branch : 'main',
      });
      sendJson(res, 201, repoJson(repo));
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  // /repos/...
  const repoMatch = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
  if (repoMatch) {
    const [, owner, name, rest] = repoMatch;
    const sub = rest ?? '';
    try {
      routeRepo(res, method, url, owner, name, sub, raw);
    } catch (err) {
      if (err instanceof RestError || err instanceof RepoError) {
        const status = err instanceof RestError ? err.status : err.status;
        sendJson(res, status, err instanceof RestError ? err.body : { message: err.message });
        return true;
      }
      throw err;
    }
    return true;
  }

  // anything else under /api/v3 is GitHub's 404
  sendJson(res, 404, { message: 'Not Found' });
  return true;
}

function getRepoOr404(owner: string, name: string): Repo {
  const repo = findRepo(owner, name);
  if (!repo) throw new RestError(404, 'Not Found');
  return repo;
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new RestError(422, `Validation Failed: ${field} is required`);
  return value;
}

function routeRepo(res: ServerResponse, method: string, url: URL, owner: string, name: string, sub: string, raw: Record<string, unknown> | null): void {
  const repo = getRepoOr404(owner, name);

  if (sub === '' || sub === '/') {
    if (method === 'GET') { sendJson(res, 200, repoJson(repo)); return; }
    if (method === 'PATCH') {
      if (typeof raw?.description === 'string') repo.description = raw.description;
      if (raw?.private === true || raw?.private === false) repo.private = raw.private;
      if (typeof raw?.default_branch === 'string' && raw.default_branch && repo.refs.has(`refs/heads/${raw.default_branch}`)) repo.default_branch = raw.default_branch;
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      deleteRepo(owner, name);
      res.writeHead(204, { 'content-length': '0' });
      res.end();
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  if (sub === '/branches') {
    if (method !== 'GET') { sendJson(res, 404, { message: 'Not Found' }); return; }
    const branches = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).sort().map((r) => ({
      name: r.slice('refs/heads/'.length),
      commit: { sha: repo.refs.get(r)!, url: `/repos/${owner}/${name}/commits/${repo.refs.get(r)}` },
      protected: false,
    }));
    const page = paginate(branches, url);
    sendJson(res, 200, page.slice, page.headers);
    return;
  }

  // single branch read: the branches view of a ref (checks fall back to it)
  const branchMatch = sub.match(/^\/branches\/(.+)$/);
  if (branchMatch) {
    if (method !== 'GET') { sendJson(res, 404, { message: 'Not Found' }); return; }
    const branchName = decodeURIComponent(branchMatch[1]!);
    const sha = repo.refs.get(`refs/heads/${branchName}`);
    if (sha === undefined) throw new RestError(404, 'Not Found');
    sendJson(res, 200, {
      name: branchName,
      commit: { sha, url: `/repos/${owner}/${name}/commits/${sha}` },
      protected: false,
    });
    return;
  }

  if (sub === '/commits') {
    if (method !== 'GET') { sendJson(res, 404, { message: 'Not Found' }); return; }
    const refParam = url.searchParams.get('sha') ?? repo.default_branch;
    const start = resolveRef(repo, refParam);
    if (!start) { sendJson(res, 404, { message: 'Not Found' }); return; }
    const commits = walkHistory(repo, start, 100).map((oid) => {
      const obj = repo.objects.get(oid)!;
      const info = parseCommit(obj.data);
      return {
        sha: oid,
        commit: {
          author: { name: info.author.name, email: info.author.email, date: repo.created_at },
          committer: { name: info.committer.name, email: info.committer.email, date: repo.created_at },
          message: info.message,
          tree: { sha: info.tree, url: `/repos/${owner}/${name}/git/trees/${info.tree}` },
          url: `/repos/${owner}/${name}/git/commits/${oid}`,
        },
        parents: info.parents.map((p) => ({ sha: p, url: `/repos/${owner}/${name}/commits/${p}` })),
        html_url: `https://forge.example/${owner}/${name}/commit/${oid}`,
        url: `/repos/${owner}/${name}/commits/${oid}`,
      };
    });
    const page = paginate(commits, url);
    sendJson(res, 200, page.slice, page.headers);
    return;
  }

  // contents (with optional nested path)
  if (sub === '/contents' || sub.startsWith('/contents/')) {
    const filePath = decodeURIComponent(sub.slice('/contents/'.length));
    handleContents(res, method, url, repo, filePath, raw);
    return;
  }

  // git refs
  if (sub === '/git/refs' && method === 'GET') {
    const refs = [...repo.refs.keys()].sort().map((r) => ({ ref: r, object: { sha: repo.refs.get(r)!, type: 'commit', url: `/repos/${owner}/${name}/git/commits/${repo.refs.get(r)}` } }));
    const page = paginate(refs, url);
    sendJson(res, 200, page.slice, page.headers);
    return;
  }
  if (sub === '/git/refs' && method === 'POST') {
    const ref = expectString(raw?.ref, 'ref');
    const sha = expectString(raw?.sha, 'sha');
    if (!ref.startsWith('refs/')) throw new RestError(422, 'Invalid ref name format');
    if (repo.refs.has(ref)) throw new RestError(422, 'Reference already exists');
    if (!repo.objects.has(sha)) throw new RestError(422, 'Object does not exist');
    repo.refs.set(ref, sha);
    sendJson(res, 201, { ref, object: { sha, type: repo.objects.get(sha)!.type, url: `/repos/${owner}/${name}/git/commits/${sha}` } });
    return;
  }

  // single ref read (Git Data): /git/refs/heads/{branch} or any refname under refs/
  const refMatch = sub.match(/^\/git\/refs\/(.+)$/);
  if (refMatch && method === 'GET') {
    const given = decodeURIComponent(refMatch[1]!);
    const full = given.startsWith('refs/') ? given : `refs/${given}`;
    const sha = repo.refs.get(full);
    if (sha === undefined) throw new RestError(404, 'Not Found');
    sendJson(res, 200, {
      ref: full,
      object: { sha, type: repo.objects.get(sha)!.type, url: `/repos/${owner}/${name}/git/commits/${sha}` },
      url: `/repos/${owner}/${name}/git/refs/${full.slice('refs/'.length)}`,
    });
    return;
  }

  // labels
  if (sub === '/labels') {
    if (method === 'GET') {
      const labels = repo.labels.map((l) => ({ id: 1, name: l.name, color: l.color, default: false, description: null }));
      const page = paginate(labels, url);
      sendJson(res, 200, page.slice, page.headers);
      return;
    }
    if (method === 'POST') {
      const labelName = expectString(raw?.name, 'name');
      const color = typeof raw?.color === 'string' ? raw.color : 'ededed';
      const label = createLabel(repo, labelName, color);
      sendJson(res, 201, { id: 1, name: label.name, color: label.color, default: false, description: null });
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // issues
  if (sub === '/issues') {
    if (method === 'GET') {
      const stateParam = url.searchParams.get('state');
      const state = stateParam === 'closed' || stateParam === 'all' ? stateParam : 'open';
      const sortParam = url.searchParams.get('sort');
      const direction = url.searchParams.get('direction') === 'asc' ? 'asc' : 'desc';
      let items = listIssues(repo, { state, kind: 'issue' });
      const sortKey = sortParam === 'updated' ? (i: Issue) => i.updated_at : (i: Issue) => i.number;
      items = [...items].sort((a, b) => (direction === 'asc' ? 1 : -1) * (sortKey(a) > sortKey(b) ? 1 : sortKey(a) < sortKey(b) ? -1 : 0));
      const page = paginate(items.map((i) => issueJson(repo, i)), url);
      sendJson(res, 200, page.slice, page.headers);
      return;
    }
    if (method === 'POST') {
      const issue = createIssue(repo, {
        title: expectString(raw?.title, 'title'),
        body: typeof raw?.body === 'string' ? raw.body : '',
        labels: Array.isArray(raw?.labels) ? (raw!.labels as unknown[]).map(String) : [],
      });
      sendJson(res, 201, issueJson(repo, issue));
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  const issueMatch = sub.match(/^\/issues\/(\d+)(\/comments)?$/);
  if (issueMatch) {
    const number = parseInt(issueMatch[1], 10);
    const issue = findIssue(repo, number);
    if (!issue || issue.kind !== 'issue') { sendJson(res, 404, { message: 'Not Found' }); return; }
    if (issueMatch[2] === '/comments') {
      if (method === 'GET') {
        const page = paginate(issue.comments.map(commentJson), url);
        sendJson(res, 200, page.slice, page.headers);
        return;
      }
      if (method === 'POST') {
        const body = expectString(raw?.body, 'body');
        const comment = addComment(issue, body, repo);
        sendJson(res, 201, commentJson(comment));
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (method === 'GET') { sendJson(res, 200, issueJson(repo, issue)); return; }
    if (method === 'PATCH') {
      if (typeof raw?.title === 'string') issue.title = raw.title;
      if (typeof raw?.body === 'string') issue.body = raw.body;
      if (raw?.state === 'open' || raw?.state === 'closed') issue.state = raw.state;
      if (Array.isArray(raw?.labels)) {
        issue.labels = (raw!.labels as unknown[]).map((l) => {
          const found = repo.labels.find((x) => x.name === String(l));
          if (!found) throw new RestError(422, `label '${String(l)}' does not exist`);
          return found;
        });
      }
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // pulls
  if (sub === '/pulls') {
    if (method === 'GET') {
      const stateParam = url.searchParams.get('state');
      const state = stateParam === 'closed' || stateParam === 'all' ? stateParam : 'open';
      const items = listIssues(repo, { state, kind: 'pull' }) as PullRequest[];
      const page = paginate(items.map((p) => pullJson(repo, p)), url);
      sendJson(res, 200, page.slice, page.headers);
      return;
    }
    if (method === 'POST') {
      const pr = createPull(repo, {
        title: expectString(raw?.title, 'title'),
        body: typeof raw?.body === 'string' ? raw.body : '',
        head: expectString(raw?.head, 'head'),
        base: expectString(raw?.base, 'base'),
      });
      sendJson(res, 201, pullJson(repo, pr));
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  const pullMatch = sub.match(/^\/pulls\/(\d+)(\/files|\/merge)?$/);
  if (pullMatch) {
    const number = parseInt(pullMatch[1], 10);
    const issue = findIssue(repo, number);
    if (!issue || issue.kind !== 'pull') { sendJson(res, 404, { message: 'Not Found' }); return; }
    const pr = issue as PullRequest;
    if (pullMatch[2] === '/files') {
      if (method !== 'GET') { sendJson(res, 404, { message: 'Not Found' }); return; }
      sendJson(res, 200, pullFiles(repo, pr));
      return;
    }
    if (pullMatch[2] === '/merge') {
      if (method !== 'PUT') { sendJson(res, 404, { message: 'Not Found' }); return; }
      handleMerge(res, repo, pr);
      return;
    }
    if (method === 'GET') { sendJson(res, 200, pullJson(repo, pr)); return; }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

// ---------------------------------------------------------------- contents

function handleContents(res: ServerResponse, method: string, url: URL, repo: Repo, filePath: string, raw: Record<string, unknown> | null): void {
  const fullName = `${repo.owner}/${repo.name}`;
  if (method === 'GET') {
    const refParam = url.searchParams.get('ref') ?? repo.default_branch;
    const tip = resolveRef(repo, refParam) ?? refHead(repo);
    if (!tip) { sendJson(res, 404, { message: 'Not Found' }); return; }
    const treeOid = parseCommit(repo.objects.get(tip)!.data).tree;
    const node = lookupPath(repo, treeOid, filePath);
    if (!node) { sendJson(res, 404, { message: 'Not Found' }); return; }
    if (node.type === 'dir') {
      const listing = node.entries!.map((e) => ({
        name: e.name,
        path: filePath ? `${filePath}/${e.name}` : e.name,
        sha: e.sha,
        size: contentSize(repo, e.sha),
        type: e.mode === '040000' || e.mode === '40000' ? 'dir' : 'file',
        _links: {},
      }));
      sendJson(res, 200, listing);
      return;
    }
    const blob = repo.objects.get(node.sha)!;
    sendJson(res, 200, {
      name: filePath.split('/').pop(),
      path: filePath,
      sha: node.sha,
      size: blob.data.length,
      type: 'file',
      encoding: 'base64',
      content: blob.data.toString('base64'),
      _links: {},
    });
    return;
  }

  if (method === 'PUT') {
    const pathValue = filePath || (typeof raw?.path === 'string' ? raw.path : '');
    if (!pathValue) throw new RestError(422, 'Validation Failed: path is required');
    const message = typeof raw?.message === 'string' && raw.message ? raw.message : `Update ${pathValue}`;
    const contentB64 = expectString(raw?.content, 'content');
    let content: Buffer;
    try {
      content = Buffer.from(contentB64, 'base64');
    } catch {
      throw new RestError(422, 'content is not valid base64');
    }
    const branch = typeof raw?.branch === 'string' && raw.branch ? raw.branch : repo.default_branch;
    const branchRef = `refs/heads/${branch}`;
    const tip = repo.refs.get(branchRef);
    const existing = tip ? lookupPath(repo, parseCommit(repo.objects.get(tip)!.data).tree, pathValue) : undefined;
    if (existing && existing.type !== 'dir') {
      const sha = expectString(raw?.sha, 'sha');
      if (sha !== existing.sha) {
        throw new RestError(409, 'the given SHA does not match the file on disk');
      }
    }
    const blobSha = insertBlob(repo, content);
    const commit = commitToBranch(repo, branch, (tipTree) => {
      const rootTree = tipTree ?? undefined;
      const newRoot = upsertPath(repo, rootTree, pathValue, '100644', blobSha);
      return newRoot;
    }, message);
    sendJson(res, 201, {
      content: {
        name: pathValue.split('/').pop(),
        path: pathValue,
        sha: blobSha,
        size: content.length,
        encoding: 'base64',
        type: 'file',
        _links: {},
      },
      commit: commitJson(repo, commit),
    });
    return;
  }

  if (method === 'DELETE') {
    const pathValue = filePath || (typeof raw?.path === 'string' ? raw.path : '');
    if (!pathValue) throw new RestError(422, 'Validation Failed: path is required');
    const message = typeof raw?.message === 'string' && raw.message ? raw.message : `Delete ${pathValue}`;
    const branch = typeof raw?.branch === 'string' && raw.branch ? raw.branch : repo.default_branch;
    const branchRef = `refs/heads/${branch}`;
    const tip = repo.refs.get(branchRef);
    if (!tip) throw new RestError(404, 'Not Found');
    const treeOid = parseCommit(repo.objects.get(tip)!.data).tree;
    const node = lookupPath(repo, treeOid, pathValue);
    if (!node || node.type === 'dir') throw new RestError(404, 'Not Found');
    const sha = expectString(raw?.sha, 'sha');
    if (sha !== node.sha) throw new RestError(409, 'the given SHA does not match the file on disk');
    const commit = commitToExistingBranch(repo, branch, (tipTree) => removePath(repo, tipTree, pathValue), message);
    sendJson(res, 200, { commit: commitJson(repo, commit) });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

interface PathNode { type: 'file' | 'dir'; sha: string; entries?: { name: string; sha: string; mode: string }[] }

const isDirMode = (mode: string): boolean => mode === '40000' || mode === '040000';

function lookupPath(repo: Repo, rootTree: string, path: string): PathNode | undefined {
  const parts = path.split('/').filter((p) => p.length > 0);
  if (parts.length === 0) {
    const entries = parseTreeEntries(repo, rootTree);
    return { type: 'dir', sha: rootTree, entries };
  }
  let current: { sha: string; mode: string } | undefined = { sha: rootTree, mode: '40000' };
  for (let i = 0; i < parts.length; i += 1) {
    if (!current || !isDirMode(current.mode)) return undefined;
    const entries = parseTreeEntries(repo, current.sha);
    const entry = entries.find((e) => e.name === parts[i]);
    if (!entry) return undefined;
    if (i === parts.length - 1) {
      if (isDirMode(entry.mode)) return { type: 'dir', sha: entry.sha, entries: parseTreeEntries(repo, entry.sha) };
      return { type: 'file', sha: entry.sha };
    }
    current = entry;
  }
  return undefined;
}

function parseTreeEntries(repo: Repo, treeOid: string): { name: string; sha: string; mode: string }[] {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return [];
  return parseTree(obj.data).map((e) => ({ name: e.name, sha: e.sha, mode: e.mode }));
}

function contentSize(repo: Repo, sha: string): number {
  const obj = repo.objects.get(sha);
  if (!obj) return 0;
  if (obj.type === 'blob') return obj.data.length;
  return 0;
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> {
  const obj = repo.objects.get(oid);
  const info = obj ? parseCommit(obj.data) : { tree: '', parents: [], author: { name: '', email: '' }, committer: { name: '', email: '' }, message: '' };
  return {
    sha: oid,
    commit: {
      author: { name: info.author.name, email: info.author.email, date: repo.created_at },
      committer: { name: info.committer.name, email: info.committer.email, date: repo.created_at },
      message: info.message,
      tree: { sha: info.tree },
      url: `/repos/${repo.owner}/${repo.name}/git/commits/${oid}`,
    },
    parents: info.parents.map((p) => ({ sha: p })),
    html_url: `https://forge.example/${repo.owner}/${repo.name}/commit/${oid}`,
  };
}

// ---------------------------------------------------------------- pulls: files + merge

function pullFiles(repo: Repo, pr: PullRequest): Record<string, unknown>[] {
  const headObj = repo.objects.get(pr.head.sha);
  const baseObj = repo.objects.get(pr.base.sha);
  const headTree = headObj && headObj.type === 'commit' ? parseCommit(headObj.data).tree : undefined;
  const baseTree = baseObj && baseObj.type === 'commit' ? parseCommit(baseObj.data).tree : undefined;
  const diffs = diffTrees(repo, baseTree, headTree);
  return diffs.map((d) => {
    const before = d.before ? repo.objects.get(d.before.sha) : undefined;
    const after = d.after ? repo.objects.get(d.after.sha) : undefined;
    const beforeLines = before && before.type === 'blob' ? countLines(before.data) : 0;
    const afterLines = after && after.type === 'blob' ? countLines(after.data) : 0;
    const status = !d.before ? 'added' : !d.after ? 'removed' : 'modified';
    const additions = !d.before ? afterLines : !d.after ? 0 : Math.max(afterLines - commonLines(before!.data, after!.data), 0);
    const deletions = !d.after ? beforeLines : !d.before ? 0 : Math.max(beforeLines - commonLines(before!.data, after!.data), 0);
    return {
      filename: d.path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
      raw_url: `https://forge.example/${repo.owner}/${repo.name}/raw/${pr.head.ref}/${d.path}`,
      blob_url: `https://forge.example/${repo.owner}/${repo.name}/blob/${pr.head.ref}/${d.path}`,
    };
  });
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  return data.toString('utf8').split('\n').filter((l) => l.trim().length > 0).length;
}

/** A cheap common-line count: the multiset intersection of non-empty lines. */
function commonLines(a: Buffer, b: Buffer): number {
  const counts = new Map<string, number>();
  for (const line of a.toString('utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  let common = 0;
  for (const line of b.toString('utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    const left = counts.get(line) ?? 0;
    if (left > 0) { common += 1; counts.set(line, left - 1); }
  }
  return common;
}

function handleMerge(res: ServerResponse, repo: Repo, pr: PullRequest): void {
  if (pr.merged) {
    sendJson(res, 405, { message: 'Pull Request was already merged' });
    return;
  }
  const baseRef = `refs/heads/${pr.base.ref}`;
  const baseTip = repo.refs.get(baseRef);
  // conflicted when the base has moved somewhere the head never saw
  if (baseTip && baseTip !== pr.base.sha && !isAncestor(repo, pr.head.sha, baseTip)) {
    sendJson(res, 405, { message: 'Pull Request is not mergeable' });
    return;
  }
  const sha = mergePull(repo, pr);
  sendJson(res, 200, { merged: true, message: 'Pull request successfully merged', sha });
}

function isAncestor(repo: Repo, descendant: string, ancestor: string): boolean {
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (oid === ancestor) return true;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return false;
}
