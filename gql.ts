// gql.ts — the GraphQL v4 surface (/api/graphql), GitHub-shaped.
// A hand-written engine: lexer → document parser → resolver table → executor with
// GitHub error semantics (a failing field nulls its containing object, HTTP stays 200).
// Supports aliases, arguments (literals, enums, lists, objects, $variables), named and
// inline fragments, cursor pagination, Relay global ids, mutations and __type introspection.
import {
  addComment, createIssue, createPull, diffTrees, findRepo, FORGE_USER, type Issue, mergePull,
  type Repo, repoKey, repos, resolveRef, ZERO_SHA,
} from './store.ts';
import { parseCommit } from './gitstore.ts';

// ---------------------------------------------------------------- global ids

/** A Relay global id: opaque base64 of `<letter>:<number>`, stable across reads. */
export function globalId(letter: string, n: number): string {
  return Buffer.from(`${letter}:${n}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { letter: string; n: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const at = text.lastIndexOf(':');
    if (at <= 0) return null;
    const n = Number(text.slice(at + 1));
    if (!Number.isInteger(n) || n <= 0) return null;
    return { letter: text.slice(0, at), n };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- lexer

type Tok = { kind: 'name' | 'int' | 'float' | 'string' | 'punct'; text: string; line: number; col: number };

const PUNCTS = new Set(['!', '$', '(', ')', ':', '=', '@', '[', ']', '{', '}', '|', '&', '.', '...']);

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0, line = 1, col = 1;
  const push = (kind: Tok['kind'], text: string): void => {
    toks.push({ kind, text, line, col });
  };
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '\n') { line += 1; col = 1; i += 1; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === ',') { i += 1; col += 1; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    const startCol = col;
    if (ch === '"') {
      i += 1; col += 1;
      let out = '';
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < src.length) {
          const esc = src[i + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          i += 2; col += 2;
        } else {
          out += src[i]!;
          i += 1; col += 1;
        }
      }
      if (src[i] !== '"') throw new GqlError(`Syntax error: unterminated string`, [line, startCol]);
      i += 1; col += 1;
      push('string', out);
      continue;
    }
    if (ch === '.' && src[i + 1] === '.' && src[i + 2] === '.') {
      i += 3; col += 3; push('punct', '...');
      continue;
    }
    if (PUNCTS.has(ch)) { i += 1; col += 1; push('punct', ch); continue; }
    if (/[A-Za-z_]/.test(ch)) {
      let name = '';
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i]!)) { name += src[i]!; i += 1; col += 1; }
      push('name', name);
      continue;
    }
    if (/-?\d/.test(ch)) {
      let num = '';
      while (i < src.length && /[-+0-9.eE]/.test(src[i]!)) { num += src[i]!; i += 1; col += 1; }
      push(num.includes('.') || num.includes('e') || num.includes('E') ? 'float' : 'int', num);
      continue;
    }
    throw new GqlError(`Syntax error: unexpected character ${JSON.stringify(ch)}`, [line, startCol]);
  }
  return toks;
}

/** One reported GraphQL error, as GitHub shapes it. */
export interface GraphQLErrorOut { message: string; type?: string; path?: (string | number)[]; locations?: Array<{ line: number; column: number }> }

class GqlError extends Error {
  loc: [number, number];
  constructor(message: string, loc: [number, number]) {
    super(message);
    this.loc = loc;
  }
}

// ---------------------------------------------------------------- parser

interface Arg { name: string; value: ValNode }
type ValNode =
  | { kind: 'var'; name: string }
  | { kind: 'int' | 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValNode }> };

interface Sel {
  alias: string | null;
  name: string;
  args: Arg[];
  selections: Sel[] | null;
  /** A named fragment spread (`...Frag`) or an inline fragment (`... on T`). */
  spread: string | null;
  onType: string | null;
}

interface Operation { kind: 'query' | 'mutation'; name: string | null; varNames: Set<string>; selections: Sel[]; fragments?: Map<string, Fragment> }
interface Fragment { name: string; onType: string; selections: Sel[] }
interface Document { operations: Operation[]; fragments: Map<string, Fragment> }

function parseDocument(src: string): Document {
  const toks = lex(src);
  let pos = 0;
  const peek = (): Tok | null => (pos < toks.length ? toks[pos]! : null);
  const next = (): Tok => {
    const tok = toks[pos];
    if (tok === undefined) throw new GqlError('Syntax error: unexpected end of document', [0, 0]);
    pos += 1;
    return tok;
  };
  const expectPunct = (text: string): void => {
    const tok = next();
    if (tok.kind !== 'punct' || tok.text !== text) throw new GqlError(`Syntax error: expected ${JSON.stringify(text)}`, [tok.line, tok.col]);
  };

  const parseValue = (): ValNode => {
    const tok = next();
    if (tok.kind === 'punct' && tok.text === '$') {
      const name = next();
      if (name.kind !== 'name') throw new GqlError('Syntax error: expected a variable name', [tok.line, tok.col]);
      return { kind: 'var', name: name.text };
    }
    if (tok.kind === 'string') return { kind: 'string', value: tok.text };
    if (tok.kind === 'int') return { kind: 'int', value: Number(tok.text) };
    if (tok.kind === 'float') return { kind: 'float', value: Number(tok.text) };
    if (tok.kind === 'name') {
      if (tok.text === 'true') return { kind: 'boolean', value: true };
      if (tok.text === 'false') return { kind: 'boolean', value: false };
      if (tok.text === 'null') return { kind: 'null' };
      return { kind: 'enum', value: tok.text };
    }
    if (tok.kind === 'punct' && tok.text === '[') {
      const items: ValNode[] = [];
      while (true) {
        const look = peek();
        if (look !== null && look.kind === 'punct' && look.text === ']') { next(); break; }
        items.push(parseValue());
      }
      return { kind: 'list', items };
    }
    if (tok.kind === 'punct' && tok.text === '{') {
      const fields: Array<{ name: string; value: ValNode }> = [];
      while (true) {
        const look = peek();
        if (look !== null && look.kind === 'punct' && look.text === '}') { next(); break; }
        const nameTok = next();
        if (nameTok.kind !== 'name') throw new GqlError('Syntax error: expected an input field name', [nameTok.line, nameTok.col]);
        expectPunct(':');
        fields.push({ name: nameTok.text, value: parseValue() });
      }
      return { kind: 'object', fields };
    }
    throw new GqlError(`Syntax error: unexpected value token ${tok.text}`, [tok.line, tok.col]);
  };

  const parseSelectionSet = (): Sel[] => {
    expectPunct('{');
    const out: Sel[] = [];
    while (true) {
      const look = peek();
      if (look === null) throw new GqlError('Syntax error: unterminated selection set', [0, 0]);
      if (look.kind === 'punct' && look.text === '}') { next(); break; }
      if (look.kind === 'punct' && look.text === '...') {
        next();
        const after = peek();
        if (after !== null && after.kind === 'name' && after.text === 'on') {
          next();
          const typeTok = next();
          if (typeTok.kind !== 'name') throw new GqlError('Syntax error: expected a type after "on"', [typeTok.line, typeTok.col]);
          out.push({ alias: null, name: `...on ${typeTok.text}`, args: [], selections: parseSelectionSet(), spread: null, onType: typeTok.text });
          continue;
        }
        if (after !== null && after.kind === 'name') {
          next();
          out.push({ alias: null, name: `...${after.text}`, args: [], selections: null, spread: after.text, onType: null });
          continue;
        }
        out.push({ alias: null, name: '...', args: [], selections: parseSelectionSet(), spread: null, onType: null });
        continue;
      }
      const nameTok = next();
      if (nameTok.kind !== 'name') throw new GqlError('Syntax error: expected a field name', [nameTok.line, nameTok.col]);
      let name = nameTok.text;
      let alias: string | null = null;
      const colon = peek();
      if (colon !== null && colon.kind === 'punct' && colon.text === ':') {
        next();
        const realName = next();
        if (realName.kind !== 'name') throw new GqlError('Syntax error: expected a field name after the alias', [realName.line, realName.col]);
        alias = name;
        name = realName.text;
      }
      const args: Arg[] = [];
      const paren = peek();
      if (paren !== null && paren.kind === 'punct' && paren.text === '(') {
        next();
        while (true) {
          const look = peek();
          if (look !== null && look.kind === 'punct' && look.text === ')') { next(); break; }
          const argName = next();
          if (argName.kind !== 'name') throw new GqlError('Syntax error: expected an argument name', [argName.line, argName.col]);
          expectPunct(':');
          args.push({ name: argName.text, value: parseValue() });
        }
      }
      const brace = peek();
      let selections: Sel[] | null = null;
      if (brace !== null && brace.kind === 'punct' && brace.text === '{') selections = parseSelectionSet();
      // Skip directives (@include, @skip): parse and ignore.
      const at = peek();
      if (at !== null && at.kind === 'punct' && at.text === '@') {
        next();
        const dirName = next();
        if (dirName.kind !== 'name') throw new GqlError('Syntax error: expected a directive name', [dirName.line, dirName.col]);
        const dirParen = peek();
        if (dirParen !== null && dirParen.kind === 'punct' && dirParen.text === '(') {
          next();
          let depth = 1;
          while (depth > 0 && pos < toks.length) {
            const tok = toks[pos]!;
            if (tok.kind === 'punct' && tok.text === '(') depth += 1;
            if (tok.kind === 'punct' && tok.text === ')') depth -= 1;
            pos += 1;
          }
        }
      }
      out.push({ alias, name, args, selections, spread: null, onType: null });
    }
    return out;
  };

  const operations: Operation[] = [];
  const fragments = new Map<string, Fragment>();
  while (pos < toks.length) {
    const tok = peek()!;
    if (tok.kind === 'name' && (tok.text === 'query' || tok.text === 'mutation')) {
      next();
      const kind = tok.text as 'query' | 'mutation';
      let name: string | null = null;
      const varNames = new Set<string>();
      const after = peek();
      if (after !== null && after.kind === 'name') { next(); name = after.text; }
      const paren = peek();
      if (paren !== null && paren.kind === 'punct' && paren.text === '(') {
        next();
        while (true) {
          const look = peek();
          if (look !== null && look.kind === 'punct' && look.text === ')') { next(); break; }
          const dollar = next();
          if (dollar.kind !== 'punct' || dollar.text !== '$') continue;
          const varTok = next();
          if (varTok.kind === 'name') varNames.add(varTok.text);
          // Skip the type and any default until , ) — handled by lexer skipping commas.
          let depth = 0;
          while (true) {
            const t = peek();
            if (t === null) break;
            if (t.kind === 'punct' && t.text === ')') break;
            if (t.kind === 'name' && (t.text === 'query' || t.text === 'mutation' || t.text === 'fragment')) break;
            if (t.kind === 'punct' && t.text === '{') { depth = 1; break; }
            next();
          }
        }
      }
      operations.push({ kind, name, varNames, selections: parseSelectionSet() });
      continue;
    }
    if (tok.kind === 'name' && tok.text === 'fragment') {
      next();
      const fragName = next();
      if (fragName.kind !== 'name') throw new GqlError('Syntax error: expected a fragment name', [fragName.line, fragName.col]);
      const onTok = next();
      if (onTok.kind !== 'name' || onTok.text !== 'on') throw new GqlError('Syntax error: expected "on"', [onTok.line, onTok.col]);
      const typeTok = next();
      if (typeTok.kind !== 'name') throw new GqlError('Syntax error: expected a type name', [typeTok.line, typeTok.col]);
      fragments.set(fragName.text, { name: fragName.text, onType: typeTok.text, selections: parseSelectionSet() });
      continue;
    }
    if (tok.kind === 'punct' && tok.text === '{') {
      // A bare selection set is a shorthand query.
      operations.push({ kind: 'query', name: null, varNames: new Set(), selections: parseSelectionSet() });
      continue;
    }
    next(); // ignore anything else (stray tokens between operations)
  }
  return { operations, fragments };
}

// ---------------------------------------------------------------- values

/** A tagged object: `__t` is the GraphQL type, `v` the domain value resolvers close over. */
interface GObj { __t: string; v: any }
type GVal = null | boolean | number | string | GObj | GVal[];

const obj = (t: string, v: any): GObj => ({ __t: t, v });
const listOf = (t: string, values: any[]): GVal => values.map((entry) => obj(t, entry));

// ---------------------------------------------------------------- resolvers

type Resolver = (src: any, args: Record<string, any>) => GVal;

/** All fields a type serves; unknown fields here become GraphQL errors. */
const FIELDS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (): GVal => obj('User', FORGE_USER),
    repository: (_s, args): GVal => {
      const repo = findRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === undefined ? null : obj('Repository', repo);
    },
    node: (_s, args): GVal => nodeById(String(args.id ?? '')),
    __type: (_s, args): GVal => obj('__Type', String(args.name ?? '')),
  },
  Mutation: {
    createIssue: (_s, args): GVal => mutateCreateIssue(args.input as Record<string, any> | undefined),
    closeIssue: (_s, args): GVal => mutateCloseIssue(args.input as Record<string, any> | undefined),
    createPullRequest: (_s, args): GVal => mutateCreatePullRequest(args.input as Record<string, any> | undefined),
    mergePullRequest: (_s, args): GVal => mutateMergePullRequest(args.input as Record<string, any> | undefined),
    addComment: (_s, args): GVal => mutateAddComment(args.input as Record<string, any> | undefined),
  },
  User: {
    login: (u): GVal => u.login,
    id: (u): GVal => globalId('U', u.id),
    databaseId: (u): GVal => u.id,
    name: (u): GVal => u.name ?? null,
    url: (u): GVal => `https://github.com/${u.login}`,
    avatarUrl: (): GVal => 'https://avatars.githubusercontent.com/u/1?v=4',
  },
  Repository: {
    id: (r: Repo): GVal => globalId('R', r.id),
    databaseId: (r: Repo): GVal => r.id,
    name: (r: Repo): GVal => r.name,
    nameWithOwner: (r: Repo): GVal => `${r.owner}/${r.name}`,
    description: (r: Repo): GVal => r.description ?? null,
    owner: (r: Repo): GVal => obj('User', { login: r.owner, id: 1000, name: r.owner }),
    isPrivate: (r: Repo): GVal => r.private,
    createdAt: (r: Repo): GVal => r.created_at,
    updatedAt: (r: Repo): GVal => r.updated_at,
    url: (r: Repo): GVal => `https://github.com/${r.owner}/${r.name}`,
    hasIssuesEnabled: (): GVal => true,
    hasWikiEnabled: (): GVal => true,
    forkCount: (): GVal => 0,
    stargazerCount: (): GVal => 0,
    viewerPermission: (): GVal => 'ADMIN',
    defaultBranchRef: (r: Repo): GVal => {
      const head = resolveRef(r, `refs/heads/${r.default_branch}`);
      return head === undefined || head === ZERO_SHA ? null : obj('Ref', { name: r.default_branch, repo: r });
    },
    issue: (r: Repo, args): GVal => {
      const issue = r.issues.find((entry) => entry.number === toInt(args.number));
      return issue === undefined ? null : obj(issue.kind === 'pull' ? 'PullRequest' : 'Issue', issue);
    },
    issues: (r: Repo, args): GVal => connection(r, args, 'issue'),
    pullRequest: (r: Repo, args): GVal => {
      const issue = r.issues.find((entry) => entry.number === toInt(args.number) && entry.kind === 'pull');
      return issue === undefined ? null : obj('PullRequest', issue);
    },
    pullRequests: (r: Repo, args): GVal => connection(r, args, 'pull'),
    label: (r: Repo, args): GVal => {
      const label = r.labels.find((entry) => entry.name === String(args.name ?? ''));
      return label === undefined ? null : obj('Label', label);
    },
    labels: (r: Repo, args): GVal => ({
      nodes: listOf('Label', pageSlice(r.labels.map((label) => ({ node: label, cursor: label.name })), args).map((entry) => entry.node)),
      totalCount: r.labels.length,
      pageInfo: pageInfoOf(r.labels.map((label) => ({ node: label, cursor: label.name })), args),
    }),
  },
  Ref: {
    name: (ref): GVal => ref.name,
    prefix: (): GVal => 'refs/heads/',
    target: (ref): GVal => (ref.repo === undefined ? null : obj('Commit', { repo: ref.repo, sha: resolveRef(ref.repo, `refs/heads/${ref.name}`) })),
  },
  Commit: {
    oid: (c): GVal => (typeof c.sha === 'string' ? c.sha : null),
    abbreviatedOid: (c): GVal => (typeof c.sha === 'string' ? c.sha.slice(0, 7) : null),
    message: (): GVal => null,
  },
  Label: {
    id: (l): GVal => globalId('L', 900000 + l.color.length),
    name: (l): GVal => l.name,
    color: (l): GVal => l.color,
    description: (): GVal => null,
  },
  Issue: {
    id: (i: Issue): GVal => globalId('I', i.id),
    databaseId: (i: Issue): GVal => i.id,
    number: (i: Issue): GVal => i.number,
    title: (i: Issue): GVal => i.title,
    body: (i: Issue): GVal => i.body,
    state: (i: Issue): GVal => (i.state === 'closed' ? 'CLOSED' : 'OPEN'),
    stateReason: (i: Issue): GVal => (i.state === 'closed' ? 'COMPLETED' : null),
    closed: (i: Issue): GVal => i.state === 'closed',
    closedAt: (): GVal => null,
    createdAt: (i: Issue): GVal => i.created_at,
    updatedAt: (i: Issue): GVal => i.updated_at,
    author: (): GVal => obj('User', FORGE_USER),
    url: (i: Issue, args): GVal => issueUrl(i, args),
    repository: (i: Issue): GVal => {
      const repo = repoOfIssue(i);
      return repo === undefined ? null : obj('Repository', repo);
    },
    labels: (i: Issue, args): GVal => ({
      nodes: listOf('Label', pageSlice(i.labels.map((label) => ({ node: label, cursor: label.name })), args).map((entry) => entry.node)),
      totalCount: i.labels.length,
      pageInfo: pageInfoOf(i.labels.map((label) => ({ node: label, cursor: label.name })), args),
    }),
    comments: (i: Issue, args): GVal => ({
      nodes: listOf('IssueComment', pageSlice(i.comments.map((comment) => ({ node: comment, cursor: String(comment.id) })), args).map((entry) => entry.node)),
      totalCount: i.comments.length,
      pageInfo: pageInfoOf(i.comments.map((comment) => ({ node: comment, cursor: String(comment.id) })), args),
    }),
  },
  IssueConnection: {
    nodes: (c): GVal => listOf('Issue', pageSlice(c.entries, c.args).map((entry: any) => entry.node)),
    edges: (c): GVal => pageSlice(c.entries, c.args).map((entry: any) => obj('IssueEdge', entry)),
    totalCount: (c): GVal => c.total,
    pageInfo: (c): GVal => c.page,
  },
  IssueEdge: {
    node: (e): GVal => obj('Issue', e.node),
    cursor: (e): GVal => e.cursor,
  },
  IssueComment: {
    id: (c): GVal => globalId('IC', c.id),
    databaseId: (c): GVal => c.id,
    body: (c): GVal => c.body,
    author: (): GVal => obj('User', FORGE_USER),
    createdAt: (c): GVal => c.created_at,
    updatedAt: (c): GVal => c.created_at,
    url: (): GVal => null,
  },
  PullRequest: {
    id: (i: Issue): GVal => globalId('P', i.id),
    databaseId: (i: Issue): GVal => i.id,
    number: (i: Issue): GVal => i.number,
    title: (i: Issue): GVal => i.title,
    body: (i: Issue): GVal => i.body,
    state: (i: Issue): GVal => (i.merged ? 'MERGED' : i.state === 'closed' ? 'CLOSED' : 'OPEN'),
    merged: (i: any): GVal => i.merged === true,
    mergedAt: (i: any): GVal => (i.merged ? i.merged_at ?? i.updated_at : null),
    mergedBy: (): GVal => obj('User', FORGE_USER),
    mergeable: (i: any): GVal => (i.merged ? 'MERGEABLE' : i.mergeable === false ? 'CONFLICTING' : 'MERGEABLE'),
    isDraft: (): GVal => false,
    closed: (i: Issue): GVal => i.state === 'closed',
    closedAt: (i: any): GVal => (i.merged ? i.merged_at ?? null : null),
    createdAt: (i: Issue): GVal => i.created_at,
    updatedAt: (i: Issue): GVal => i.updated_at,
    author: (): GVal => obj('User', FORGE_USER),
    headRefName: (i: any): GVal => i.head?.ref ?? null,
    baseRefName: (i: any): GVal => i.base?.ref ?? null,
    headRefOid: (i: any): GVal => i.head?.sha ?? null,
    baseRefOid: (i: any): GVal => i.base?.sha ?? null,
    head: (i: Issue): GVal => refEndOf(i, 'head'),
    base: (i: Issue): GVal => refEndOf(i, 'base'),
    commits: (i: Issue): GVal => obj('PullRequestCommitConnection', { total: 1 }),
    files: (i: Issue, args): GVal => {
      const entries = changedFiles(i).map((entry) => ({ node: entry, cursor: entry.path }));
      return obj('PullRequestFilesConnection', {
        entries,
        args,
        total: entries.length,
        page: pageInfoOf(entries, args),
      });
    },
    additions: (i: Issue): GVal => changedFiles(i).reduce((sum, entry) => sum + entry.additions, 0),
    deletions: (i: Issue): GVal => changedFiles(i).reduce((sum, entry) => sum + entry.deletions, 0),
    changedFiles: (i: Issue): GVal => changedFiles(i).length,
    url: (i: Issue): GVal => issueUrl(i, {}),
    repository: (i: Issue): GVal => {
      const repo = repoOfIssue(i);
      return repo === undefined ? null : obj('Repository', repo);
    },
  },
  PullRequestConnection: {
    nodes: (c): GVal => listOf('PullRequest', pageSlice(c.entries, c.args).map((entry: any) => entry.node)),
    edges: (c): GVal => pageSlice(c.entries, c.args).map((entry: any) => obj('PullRequestEdge', entry)),
    totalCount: (c): GVal => c.total,
    pageInfo: (c): GVal => c.page,
  },
  PullRequestCommitConnection: {
    totalCount: (c): GVal => c.total,
    nodes: (): GVal => [],
  },
  PullRequestChangedFile: {
    path: (f): GVal => f.path,
    additions: (f): GVal => f.additions,
    deletions: (f): GVal => f.deletions,
    changeType: (): GVal => 'ADDED',
  },
  PullRequestFilesConnection: {
    nodes: (c): GVal => listOf('PullRequestChangedFile', pageSlice(c.entries, c.args).map((entry: any) => entry.node)),
    edges: (c): GVal => pageSlice(c.entries, c.args).map((entry: any) => obj('PullRequestChangedFileEdge', entry)),
    totalCount: (c): GVal => c.total,
    pageInfo: (c): GVal => c.page,
  },
  PullRequestChangedFileEdge: {
    node: (e): GVal => obj('PullRequestChangedFile', e.node),
    cursor: (e): GVal => e.cursor,
  },
  PageInfo: {
    hasNextPage: (p): GVal => p.hasNextPage,
    hasPreviousPage: (p): GVal => p.hasPreviousPage,
    endCursor: (p): GVal => p.endCursor,
    startCursor: (p): GVal => p.startCursor,
  },
  CreateIssuePayload: { issue: (p): GVal => (p.issue === null ? null : obj('Issue', p.issue)) },
  CloseIssuePayload: { issue: (p): GVal => (p.issue === null ? null : obj('Issue', p.issue)) },
  CreatePullRequestPayload: { pullRequest: (p): GVal => (p.issue === null ? null : obj('PullRequest', p.issue)) },
  MergePullRequestPayload: { pullRequest: (p): GVal => (p.issue === null ? null : obj('PullRequest', p.issue)) },
  AddCommentPayload: {
    commentEdge: (p): GVal => obj('IssueCommentEdge', p.comment),
    subject: (p): GVal => (p.issue === null ? null : obj('Issue', p.issue)),
  },
  IssueCommentEdge: { node: (c): GVal => obj('IssueComment', c) },
};

/** The introspection field lists, for the types the checks (and gh) probe. */
const INTROSPECT_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
};

FIELDS.__Type = {
  name: (name: string): GVal => name,
  kind: (name: string): GVal => (INTROSPECT_ENUMS[name] !== undefined ? 'ENUM' : FIELDS[name] !== undefined || name === 'Query' || name === 'Mutation' ? 'OBJECT' : 'SCALAR'),
  description: (): GVal => 'The forge schema.',
  fields: (name: string): GVal => {
    const list = introspectFields(name);
    return list === null ? null : listOf('__Field', list);
  },
  enumValues: (name: string): GVal => {
    const list = INTROSPECT_ENUMS[name];
    return list === undefined ? null : listOf('__EnumValue', list);
  },
  inputFields: (): GVal => [],
  interfaces: (): GVal => [],
  possibleTypes: (): GVal => [],
  ofType: (): GVal => null,
};
FIELDS.__Field = { name: (name: string): GVal => name, description: (): GVal => null, isDeprecated: (): GVal => false, deprecationReason: (): GVal => null };
FIELDS.__EnumValue = { name: (name: string): GVal => name, isDeprecated: (): GVal => false, deprecationReason: (): GVal => null };

function introspectFields(typeName: string): string[] | null {
  if (FIELDS[typeName] !== undefined) return Object.keys(FIELDS[typeName]!);
  if (typeName === 'Query') return Object.keys(FIELDS.Query!);
  if (typeName === 'Mutation') return Object.keys(FIELDS.Mutation!);
  if (typeName === 'ID' || typeName === 'String' || typeName === 'Int' || typeName === 'Boolean' || typeName === 'DateTime' || typeName === 'URI') return null;
  return Object.keys(FIELDS[typeName] ?? {});
}

// ---------------------------------------------------------------- helpers over the store

const toInt = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) ? value : null);

function repoOfIssue(issue: Issue): Repo | undefined {
  for (const repo of repos.values()) if (repo.issues.includes(issue)) return repo;
  return undefined;
}

function issueUrl(issue: Issue, _args: Record<string, any>): string {
  const repo = repoOfIssue(issue);
  const kind = issue.kind === 'pull' ? 'pull' : 'issues';
  return `https://github.com/${repo?.owner ?? 'forge'}/${repo?.name ?? 'repo'}/${kind}/${issue.number}`;
}

/** Whether the pull's branches can still merge (the store decides at open time). */
function headBaseDiverged(issue: any): boolean {
  return issue.kind === 'pull' && issue.mergeable === false;
}

function refOidOf(issue: any, end: 'head' | 'base'): string | null {
  const info = issue[end];
  return info === undefined ? null : info.sha;
}

function refEndOf(issue: any, end: 'head' | 'base'): GVal {
  const info = issue[end];
  if (info === undefined) return null;
  const repo = repoOfIssue(issue);
  if (repo === undefined) return null;
  return obj('Ref', { name: info.ref, repo });
}

/** The files a pull request changes: paths whose blob differs between the base and head trees. */
function changedFiles(issue: any): Array<{ path: string; additions: number; deletions: number }> {
  const repo = repoOfIssue(issue);
  if (repo === undefined || issue.head === undefined || issue.base === undefined) return [];
  const headCommit = repo.objects.get(issue.head.sha);
  const baseSha = repo.refs.get(`refs/heads/${issue.base.ref}`);
  const baseCommit = baseSha === undefined ? undefined : repo.objects.get(baseSha);
  if (headCommit === undefined || headCommit.type !== 'commit') return [];
  const headTree = parseCommit(headCommit.data).tree;
  const baseTree = baseCommit !== undefined && baseCommit.type === 'commit' ? parseCommit(baseCommit.data).tree : undefined;
  try {
    const diff = diffTrees(repo, baseTree, headTree);
    return diff.map((entry) => ({
      path: entry.path,
      additions: entry.after === undefined ? 0 : 1,
      deletions: entry.before === undefined ? 0 : 1,
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- pagination

interface PageEntry { node: any; cursor: string }

function pageSlice(entries: PageEntry[], args: Record<string, any>): PageEntry[] {
  const first = typeof args.first === 'number' && args.first >= 0 ? Math.floor(args.first) : entries.length;
  const after = typeof args.after === 'string' ? args.after : null;
  let start = 0;
  if (after !== null) {
    const decoded = decodeCursor(after);
    const at = entries.findIndex((entry) => entry.cursor === decoded);
    start = at >= 0 ? at + 1 : entries.length;
  }
  return entries.slice(start, start + first);
}

function pageInfoOf(entries: PageEntry[], args: Record<string, any>): GObj {
  const first = typeof args.first === 'number' && args.first >= 0 ? Math.floor(args.first) : entries.length;
  const after = typeof args.after === 'string' ? args.after : null;
  let start = 0;
  if (after !== null) {
    const decoded = decodeCursor(after);
    const at = entries.findIndex((entry) => entry.cursor === decoded);
    start = at >= 0 ? at + 1 : entries.length;
  }
  const end = start + first;
  return obj('PageInfo', {
    hasNextPage: end < entries.length,
    hasPreviousPage: start > 0,
    endCursor: end > 0 && end <= entries.length && entries[end - 1] !== undefined ? encodeCursor(entries[end - 1]!.cursor) : null,
    startCursor: entries[start] !== undefined ? encodeCursor(entries[start]!.cursor) : null,
  });
}

const encodeCursor = (raw: string): string => Buffer.from(`cursor:${raw}`, 'utf8').toString('base64');
const decodeCursor = (cursor: string): string => {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    return text.startsWith('cursor:') ? text.slice('cursor:'.length) : text;
  } catch {
    return cursor;
  }
};

/** The issues/pullRequests connection: state filter, ordering and cursor pagination. */
function connection(repo: Repo, args: Record<string, any>, kind: 'issue' | 'pull'): GObj {
  let list: Issue[] = repo.issues.filter((issue) => (kind === 'pull' ? issue.kind === 'pull' : issue.kind !== 'pull'));
  const statesArg = args.states;
  if (Array.isArray(statesArg) && statesArg.length > 0) {
    const wanted = new Set(statesArg.map((state) => String(state).toUpperCase()));
    list = list.filter((issue) => wanted.has((issue as any).state === 'closed' ? ((issue as any).merged ? 'MERGED' : 'CLOSED') : 'OPEN'));
  } else {
    list = list.filter((issue) => (issue as any).state !== 'closed');
  }
  const orderBy = args.orderBy as Record<string, any> | undefined;
  const field = orderBy?.field ?? 'CREATED_AT';
  const direction = orderBy?.direction ?? 'DESC';
  const rank = (issue: Issue): number => (field === 'UPDATED_AT' ? Date.parse(issue.updated_at) : issue.number);
  list = [...list].sort((left, right) => (direction === 'ASC' ? rank(left) - rank(right) : rank(right) - rank(left)));
  const entries: PageEntry[] = list.map((issue) => ({ node: issue, cursor: String(issue.number) }));
  return obj(`${kind === 'pull' ? 'PullRequest' : 'Issue'}Connection`, {
    entries,
    total: list.length,
    page: pageInfoOf(entries, args),
    args,
  });
}

// ---------------------------------------------------------------- node()

function nodeById(id: string): GVal {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.letter === 'R') {
    for (const repo of repos.values()) if (repo.id === decoded.n) return obj('Repository', repo);
    return null;
  }
  for (const repo of repos.values()) {
    const issue = repo.issues.find((entry) => entry.id === decoded.n);
    if (issue !== undefined) return obj(issue.kind === 'pull' ? 'PullRequest' : 'Issue', issue);
  }
  return null;
}

// ---------------------------------------------------------------- mutations

function repoByGlobalId(id: unknown): Repo | undefined {
  if (typeof id !== 'string') return undefined;
  const decoded = decodeGlobalId(id);
  if (decoded === null) return undefined;
  for (const repo of repos.values()) if (repo.id === decoded.n) return repo;
  return undefined;
}

function issueByGlobalId(id: unknown): Issue | undefined {
  if (typeof id !== 'string') return undefined;
  const decoded = decodeGlobalId(id);
  if (decoded === null) return undefined;
  for (const repo of repos.values()) {
    const issue = repo.issues.find((entry) => entry.id === decoded.n);
    if (issue !== undefined) return issue;
  }
  return undefined;
}

function mutateCreateIssue(input: Record<string, any> | undefined): GVal {
  if (input === undefined) return null;
  const repo = repoByGlobalId(input.repositoryId);
  if (repo === undefined) return null;
  const issue = createIssue(repo, { title: String(input.title ?? ''), body: input.body === undefined ? null : String(input.body) });
  return obj('CreateIssuePayload', { issue });
}

function mutateCloseIssue(input: Record<string, any> | undefined): GVal {
  if (input === undefined) return null;
  const issue = issueByGlobalId(input.issueId);
  if (issue === undefined) return null;
  issue.state = 'closed';
  return obj('CloseIssuePayload', { issue });
}

function mutateCreatePullRequest(input: Record<string, any> | undefined): GVal {
  if (input === undefined) return null;
  const repo = repoByGlobalId(input.repositoryId);
  if (repo === undefined) return null;
  try {
    const issue = createPull(repo, {
      title: String(input.title ?? ''),
      body: input.body === undefined ? null : String(input.body),
      head: String(input.headRefName ?? ''),
      base: String(input.baseRefName ?? ''),
    });
    return obj('CreatePullRequestPayload', { issue });
  } catch {
    return null;
  }
}

function mutateMergePullRequest(input: Record<string, any> | undefined): GVal {
  if (input === undefined) return null;
  const issue = issueByGlobalId(input.pullRequestId);
  if (issue === undefined || issue.kind !== 'pull') return null;
  const repo = repoOfIssue(issue);
  if (repo === undefined) return null;
  try {
    mergePull(repo, issue as any);
    return obj('MergePullRequestPayload', { issue });
  } catch {
    return null;
  }
}

function mutateAddComment(input: Record<string, any> | undefined): GVal {
  if (input === undefined) return null;
  const issue = issueByGlobalId(input.subjectId);
  if (issue === undefined) return null;
  const repo = repoOfIssue(issue);
  if (repo === undefined) return null;
  const comment = addComment(issue, String(input.body ?? ''), repo);
  return obj('AddCommentPayload', { comment, issue });
}

// ---------------------------------------------------------------- executor

interface ExecOutcome { data: Record<string, unknown> | null; errors: GraphQLErrorOut[] }

const KNOWN_META_FIELDS = new Set(['__type', '__schema', '__typename']);

function coerceArgs(args: Arg[], variables: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  const evalValue = (node: ValNode): any => {
    switch (node.kind) {
      case 'var': return variables[node.name];
      case 'int': case 'float': return node.value;
      case 'string': return node.value;
      case 'boolean': return node.value;
      case 'null': return null;
      case 'enum': return node.value;
      case 'list': return node.items.map(evalValue);
      case 'object': {
        const record: Record<string, any> = {};
        for (const field of node.fields) record[field.name] = evalValue(field.value);
        return record;
      }
    }
  };
  for (const arg of args) out[arg.name] = evalValue(arg.value);
  return out;
}

/** Every selection a type serves, fragments flattened (with their on-Type guards kept). */
function expandSelections(selections: Sel[], fragments: Map<string, Fragment>): Sel[] {
  const out: Sel[] = [];
  for (const sel of selections) {
    if (sel.spread !== null) {
      const fragment = fragments.get(sel.spread);
      if (fragment !== undefined) out.push(...expandSelections(fragment.selections, fragments).map((inner) => ({ ...inner, onType: fragment.onType })));
      continue;
    }
    out.push(sel);
  }
  return out;
}

function execute(root: GObj, operation: Operation, variables: Record<string, any>): ExecOutcome {
  const errors: GraphQLErrorOut[] = [];
  let failed = false;

  const resolve = (value: GVal, selections: Sel[], fragments: Map<string, Fragment>, path: (string | number)[]): any => {
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) {
      return value.map((entry, index) => resolve(entry, selections, fragments, [...path, index]));
    }
    if (typeof value !== 'object' || (value as GObj).__t === undefined) return value;
    const gobj = value as GObj;
    const table = FIELDS[gobj.__t];
    const flat = expandSelections(selections, fragments);
    // Validate first: an unknown field nulls the whole object (GitHub semantics).
    for (const sel of flat) {
      if (sel.name.startsWith('...')) continue; // inline-fragment containers are validated when resolved
      if (sel.onType !== null && sel.onType !== gobj.__t) continue;
      const isMeta = KNOWN_META_FIELDS.has(sel.name);
      if (!isMeta && (table === undefined || table[sel.name] === undefined)) {
        errors.push({
          message: `Cannot query field "${sel.name}" on type "${gobj.__t}".`,
          path: [...path],
        });
        failed = true;
        return null;
      }
    }
    const out: Record<string, any> = {};
    for (const sel of flat) {
      if (sel.onType !== null && sel.onType !== gobj.__t) continue;
      const key = sel.alias ?? sel.name;
      if (sel.name === '__typename') { out[key] = gobj.__t; continue; }
      if (sel.name.startsWith('...')) {
        // an inline fragment whose guard passed: merge its inner selections into this object
        const inner = resolve(gobj, sel.selections ?? [], fragments, path);
        if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) Object.assign(out, inner);
        continue;
      }
      const resolver = gobj.__t === '__Type' || gobj.__t === '__Field' || gobj.__t === '__EnumValue'
        ? table[sel.name]
        : table[sel.name];
      if (resolver === undefined) continue;
      try {
        const resolved = resolver(gobj.v, coerceArgs(sel.args, variables));
        out[key] = sel.selections === null ? resolved : resolve(resolved, sel.selections, fragments, [...path, key]);
      } catch (error) {
        errors.push({
          message: error instanceof Error ? error.message : String(error),
          path: [...path, key],
        });
        failed = true;
        out[key] = null;
      }
    }
    return out;
  };

  const data = resolve(root, operation.selections, operation.fragments ?? new Map(), []);
  return { data: failed || errors.length > 0 ? data : data, errors };
}

// ---------------------------------------------------------------- the HTTP entry

interface GqlBody { query?: unknown; variables?: unknown; operationName?: unknown }

/** Execute one GraphQL HTTP body: a single operation object or a batch array. */
export function executeGraphQL(body: GqlBody | GqlBody[]): { status: number; body: any } {
  if (Array.isArray(body)) {
    const answers = body.map((entry) => runOne(entry));
    return { status: 200, body: answers };
  }
  return { status: 200, body: runOne(body) };
}

function runOne(entry: GqlBody): any {
  if (entry === null || typeof entry !== 'object' || typeof entry.query !== 'string') {
    return { errors: [{ message: 'A query field is required.' }] };
  }
  const variables = entry.variables !== null && typeof entry.variables === 'object' ? (entry.variables as Record<string, any>) : {};
  let document: Document;
  try {
    document = parseDocument(entry.query);
  } catch (error) {
    if (error instanceof GqlError) {
      return { errors: [{ message: error.message, locations: [{ line: error.loc[0], column: error.loc[1] }] }] };
    }
    return { errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  if (document.operations.length === 0) {
    return { errors: [{ message: 'A document must contain an operation.' }] };
  }
  const wanted = typeof entry.operationName === 'string' && entry.operationName !== '' ? entry.operationName : null;
  let operation = document.operations[0]!;
  if (wanted !== null) {
    const named = document.operations.find((op) => op.name === wanted);
    if (named === undefined) return { errors: [{ message: `Unknown operation named "${wanted}".` }] };
    operation = named;
  }
  const root = operation.kind === 'mutation' ? obj('Mutation', null) : obj('Query', null);
  operation.fragments = document.fragments;
  const outcome = execute(root, operation, variables);
  const out: Record<string, unknown> = {};
  if (outcome.errors.length === 0) out.data = outcome.data;
  else {
    out.data = outcome.data;
    out.errors = outcome.errors;
  }
  return out;
}

