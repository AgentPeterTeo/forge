// The Model Context Protocol surface: JSON-RPC 2.0 over the streamable-HTTP transport at
// POST /mcp. The suite (mcp-client.ts) probes server/discover first, negotiates a revision,
// lists tools, then calls them by canonical name (or an alias matched against the schema).
//
// Design notes, mirrored from checks-mcp.ts:
//   * server/discover answers a DiscoverResult: supportedVersions (newest first), capabilities,
//     serverInfo. A missing method falls back to the legacy initialize handshake — we answer both.
//   * tools/list entries need a non-empty description and inputSchema { type: 'object', ... }.
//     The suite maps ITS argument names onto OUR schema property names via ARGUMENT_SYNONYMS,
//     so the properties below use the canonical names the suite documents.
//   * tools/call answers CallToolResult { content, structuredContent, isError }. A missing
//     required argument is a graceful tool error (isError: true), never an HTTP 500; an unknown
//     tool name is a JSON-RPC -32602.
//   * A body that is not JSON is HTTP 400 with -32700, the spec's parse error.
//   * Authentication is decided by the router before this module runs: no Authorization is 401.

import type { ServerResponse } from 'node:http';
import {
  createIssue,
  createPull,
  createRepo,
  findIssue,
  findRepo,
  listIssues,
  mergePull,
  RepoError,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------- protocol constants

/** The revisions this server speaks, newest first (mcp-client.ts's accepted set). */
export const MCP_PROTOCOL_VERSIONS: readonly string[] = Object.freeze(['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
/** The revision the server prefers to settle on. */
export const MCP_PREFERRED_REVISION = MCP_PROTOCOL_VERSIONS[0]!;
/** What serverInfo says about this forge. */
const SERVER_INFO = Object.freeze({ name: 'forge', version: '1.0.0' });

const JSON_TYPE = 'application/json; charset=utf-8';

// ---------------------------------------------------------------- small helpers

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** A graceful tool refusal: the call answered, but the work was not done (isError: true). */
class ToolError extends Error {}

function wantString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') throw new ToolError(`'${key}' is required and must be a non-empty string`);
  return value;
}

function wantNumber(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(number) || number < 1) throw new ToolError(`'${key}' is required and must be a positive number`);
  return Math.floor(number);
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

function mustFindRepo(owner: string, repo: string): Repo {
  const found = findRepo(owner, repo);
  if (found === undefined) throw new ToolError(`repository ${owner}/${repo} not found`);
  return found;
}

// ---------------------------------------------------------------- serializers
// The shapes mirror the REST surface's JSON closely enough that a caller reading either
// recognizes the other (the rest-parity check splits full_name on '/').

function repoSummary(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    description: repo.description,
    default_branch: repo.default_branch,
    owner: { login: repo.owner },
    html_url: `https://forge.example/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.created_at,
  };
}

function issueSummary(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: issue.user.login },
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    created_at: issue.created_at,
    updated_at: issue.updated_at,
  };
}

function pullSummary(pull: PullRequest): Record<string, unknown> {
  return {
    ...issueSummary(pull),
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    mergeable: pull.merged ? false : pull.mergeable,
    head: { ref: pull.head.ref, sha: pull.head.sha, label: pull.head.label },
    base: { ref: pull.base.ref, sha: pull.base.sha, label: pull.base.label },
  };
}

// ---------------------------------------------------------------- the six tools

interface ForgeTool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
  run: (args: Record<string, unknown>) => unknown;
}

function strProp(description: string): Record<string, unknown> {
  return { type: 'string', description };
}

const TOOLS: ForgeTool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository under an owner with a name, description and visibility.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: strProp('The login of the owner the repository is created under.'),
        name: strProp('The repository name.'),
        description: strProp('A short description of the repository.'),
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['owner', 'name'],
    },
    run: (args) => {
      const owner = wantString(args, 'owner');
      const name = wantString(args, 'name');
      try {
        return repoSummary(createRepo(owner, name, {
          description: optionalString(args, 'description') ?? '',
          private: args.private === true,
        }));
      } catch (error) {
        if (error instanceof RepoError) throw new ToolError(error.message);
        throw error;
      }
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: strProp('The login of the repository owner.'),
        repo: strProp('The repository name.'),
      },
      required: ['owner', 'repo'],
    },
    run: (args) => repoSummary(mustFindRepo(wantString(args, 'owner'), wantString(args, 'repo'))),
  },
  {
    name: 'create_issue',
    description: 'Open an issue on a repository with a title and optional body.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: strProp('The login of the repository owner.'),
        repo: strProp('The repository name.'),
        title: strProp('The issue title.'),
        body: strProp('The issue body.'),
      },
      required: ['owner', 'repo', 'title'],
    },
    run: (args) => {
      const repo = mustFindRepo(wantString(args, 'owner'), wantString(args, 'repo'));
      try {
        return issueSummary(createIssue(repo, { title: wantString(args, 'title'), body: optionalString(args, 'body') ?? '' }));
      } catch (error) {
        if (error instanceof RepoError) throw new ToolError(error.message);
        throw error;
      }
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: strProp('The login of the repository owner.'),
        repo: strProp('The repository name.'),
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'The issue state to list.' },
      },
      required: ['owner', 'repo'],
    },
    run: (args) => {
      const repo = mustFindRepo(wantString(args, 'owner'), wantString(args, 'repo'));
      const state = args.state;
      const wanted = state === 'closed' || state === 'all' ? state : 'open';
      return listIssues(repo, { state: wanted, kind: 'issue' }).map(issueSummary);
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: strProp('The login of the repository owner.'),
        repo: strProp('The repository name.'),
        title: strProp('The pull request title.'),
        body: strProp('The pull request body.'),
        head: strProp('The branch the changes come from.'),
        base: strProp('The branch the changes merge into.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    run: (args) => {
      const repo = mustFindRepo(wantString(args, 'owner'), wantString(args, 'repo'));
      try {
        return pullSummary(createPull(repo, {
          title: wantString(args, 'title'),
          body: optionalString(args, 'body') ?? '',
          head: wantString(args, 'head'),
          base: wantString(args, 'base'),
        }));
      } catch (error) {
        if (error instanceof RepoError) throw new ToolError(error.message);
        throw error;
      }
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge one pull request of a repository by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: strProp('The login of the repository owner.'),
        repo: strProp('The repository name.'),
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run: (args) => {
      const repo = mustFindRepo(wantString(args, 'owner'), wantString(args, 'repo'));
      const number = wantNumber(args, 'pull_number');
      const found = findIssue(repo, number);
      if (found === undefined || found.kind !== 'pull') throw new ToolError(`pull request #${number} not found in ${repo.owner}/${repo.name}`);
      if (!found.merged) {
        try {
          mergePull(repo, found);
        } catch (error) {
          if (error instanceof RepoError) throw new ToolError(error.message);
          throw error;
        }
      }
      return pullSummary(found);
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

function toolsListJson(): Array<Record<string, unknown>> {
  return TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
}

// ---------------------------------------------------------------- JSON-RPC

interface RpcAnswer {
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/** One JSON-RPC message: a result answer, an error answer, or null for a notification. */
function oneRpc(message: unknown): RpcAnswer | null {
  if (!isRecord(message)) return { id: null, error: { code: -32600, message: 'Invalid Request' } };
  const id = 'id' in message ? message.id : undefined;
  const isNotification = id === undefined || id === null;
  const answerFor = (payload: { result?: unknown; error?: { code: number; message: string } } | null): RpcAnswer | null => {
    if (payload === null) return null;
    return { id, ...(payload.result !== undefined ? { result: payload.result } : {}), ...(payload.error !== undefined ? { error: payload.error } : {}) } as RpcAnswer;
  };
  if (typeof message.method !== 'string' || message.method === '') {
    return isNotification ? null : { id, error: { code: -32600, message: 'Invalid Request' } };
  }
  const params = isRecord(message.params) ? message.params : {};

  // The modern discovery probe: what this server can speak.
  if (message.method === 'server/discover') {
    return answerFor({
      result: {
        supportedVersions: [...MCP_PROTOCOL_VERSIONS],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { ...SERVER_INFO },
      },
    });
  }

  // The legacy (and still valid) handshake: echo the revision when it is one we speak.
  if (message.method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : MCP_PREFERRED_REVISION;
    return answerFor({
      result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
      },
    });
  }

  if (message.method === 'ping') return answerFor({ result: {} });
  if (message.method === 'tools/list') return answerFor({ result: { tools: toolsListJson() } });

  if (message.method === 'tools/call') {
    const name = params.name;
    if (typeof name !== 'string' || name === '') {
      return answerFor({ error: { code: -32602, message: 'Invalid params: tools/call needs a tool name.' } });
    }
    const tool = TOOL_BY_NAME.get(name);
    if (tool === undefined) {
      return answerFor({ error: { code: -32602, message: `Unknown tool: ${name}` } });
    }
    const args = isRecord(params.arguments) ? params.arguments : {};
    try {
      const value = tool.run(args);
      return answerFor({
        result: {
          content: [{ type: 'text', text: JSON.stringify(value) }],
          structuredContent: value,
          isError: false,
        },
      });
    } catch (error) {
      // A tool that refused: the call answered, with isError and the reason as text.
      const text = error instanceof ToolError ? error.message : error instanceof RepoError ? error.message : 'the tool failed';
      return answerFor({
        result: {
          content: [{ type: 'text', text }],
          isError: true,
        },
      });
    }
  }

  // Notifications take no answer; a method the server does not know is -32601 when asked.
  if (message.method.startsWith('notifications/')) return null;
  return isNotification ? null : answerFor({ error: { code: -32601, message: `Method not found: ${message.method}` } });
}

/**
 * Answer one POST /mcp. `bodyText` is the request body verbatim; an unparseable one is HTTP 400
 * with the spec's -32700. A batch array answers an array; a notification answers an empty 200.
 */
export function handleMcp(res: ServerResponse, bodyText: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
      return;
    }
    const answers = parsed.map(oneRpc).filter((answer): answer is RpcAnswer => answer !== null);
    if (answers.length === 0) {
      res.writeHead(200, { 'content-type': JSON_TYPE });
      res.end('');
      return;
    }
    sendJson(res, 200, answers.map((answer) => ({ jsonrpc: '2.0', ...answer })));
    return;
  }
  const answer = oneRpc(parsed);
  if (answer === null) {
    // A notification: the transport accepts it with an empty 200 and no body.
    res.writeHead(200, { 'content-type': JSON_TYPE });
    res.end('');
    return;
  }
  sendJson(res, 200, { jsonrpc: '2.0', ...answer });
}
