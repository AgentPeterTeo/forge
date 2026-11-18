// A local smoke test: boot the server in-process and exercise every surface once. Not part of
// the scored server; run with:
//   MAKEFUN_SHOP_TOKEN=smoke-token ~/.hermes/tools/node22/bin/node --experimental-strip-types smoke.ts

import { createApp } from './app.ts';

const TOKEN = 'smoke-token';
const server = createApp();
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve());
});
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('no port');
const base = `http://127.0.0.1:${address.port}`;
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

let failures = 0;
function ok(name: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`PASS ${name}`);
  else {
    failures += 1;
    console.log(`FAIL ${name} ${detail}`);
  }
}

async function call(path: string, init: RequestInit = {}): Promise<{ status: number; text: string; headers: Headers; body: any }> {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // git pkt-line streams are not JSON
  }
  return { status: response.status, text, headers: response.headers, body };
}

// 1. boot probe
{
  const r = await call('/healthz');
  ok('healthz', r.status === 200 && r.body?.ok === true, `status=${r.status}`);
}

// 2. REST: 401 without a token, root with one
{
  const anon = await call('/api/v3/repos/adaiversen/smoke');
  ok('rest-401', anon.status === 401 && typeof anon.body?.message === 'string', `status=${anon.status}`);
  const root = await call('/api/v3/', { headers: auth });
  ok('rest-root', root.status === 200 && root.headers.get('x-oauth-scopes') !== null, `status=${root.status}`);
}

// 3. REST: create repo, issue, read them back
{
  const made = await call('/api/v3/user/repos', { method: 'POST', headers: auth, body: JSON.stringify({ name: 'smoke', description: 'smoke test repo' }) });
  ok('rest-create-repo', made.status === 201 && made.body?.full_name === 'adaiversen/smoke', `status=${made.status} ${made.text.slice(0, 120)}`);
  const issue = await call('/api/v3/repos/adaiversen/smoke/issues', { method: 'POST', headers: auth, body: JSON.stringify({ title: 'first issue', body: 'hello' }) });
  ok('rest-create-issue', issue.status === 201 && issue.body?.number === 1, `status=${issue.status} ${issue.text.slice(0, 120)}`);
  const list = await call('/api/v3/repos/adaiversen/smoke/issues', { headers: auth });
  ok('rest-list-issues', list.status === 200 && Array.isArray(list.body) && list.body.length === 1, `status=${list.status}`);
  const branch = await call('/api/v3/repos/adaiversen/smoke/branches/main', { headers: auth });
  ok('rest-branch-empty-404', branch.status === 404, `status=${branch.status}`);
  const ref = await call('/api/v3/repos/adaiversen/smoke/git/refs/heads/main', { headers: auth });
  ok('rest-ref-empty-404', ref.status === 404, `status=${ref.status}`);
}

// 3b. REST: seed a commit via contents PUT (creates refs/heads/main on the empty repo)
{
  const put = await call('/api/v3/repos/adaiversen/smoke/contents/hello.txt', {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify({ message: 'first commit', content: Buffer.from('hello forge\n').toString('base64') }),
  });
  ok('rest-put-contents', put.status === 201, `status=${put.status} ${put.text.slice(0, 120)}`);
  const got = await call('/api/v3/repos/adaiversen/smoke/contents/hello.txt', { headers: auth });
  const back = typeof got.body?.content === 'string' ? Buffer.from(got.body.content, 'base64').toString() : '';
  ok('rest-get-contents', got.status === 200 && back === 'hello forge\n', `status=${got.status}`);
  const branch = await call('/api/v3/repos/adaiversen/smoke/branches/main', { headers: auth });
  ok('rest-branch-after-commit', branch.status === 200 && typeof branch.body?.commit?.sha === 'string', `status=${branch.status}`);
  const ref = await call('/api/v3/repos/adaiversen/smoke/git/refs/heads/main', { headers: auth });
  ok('rest-ref-after-commit', ref.status === 200 && typeof ref.body?.object?.sha === 'string', `status=${ref.status}`);
}

// 4. GraphQL: viewer, repository query, pagination shape
{
  const anon = await call('/api/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ viewer { login } }' }) });
  ok('gql-401', anon.status === 401, `status=${anon.status}`);
}

// (each GraphQL case in its own block, so one failure does not hide the rest)
{
  const viewer = await call('/api/graphql', { method: 'POST', headers: auth, body: JSON.stringify({ query: '{ viewer { login } }' }) });
  ok('gql-viewer', viewer.status === 200 && viewer.body?.data?.viewer?.login === 'adaiversen', `status=${viewer.status} text=${viewer.text.slice(0, 300)}`);
  const repo = await call('/api/graphql', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      query: 'query($owner:String!$name:String!){ repository(owner:$owner, name:$name){ name description issues(first:10, states:[OPEN]){ pageInfo{ hasNextPage } nodes{ number title state } } } }',
      variables: { owner: 'adaiversen', name: 'smoke' },
    }),
  });
  const nodes = repo.body?.data?.repository?.issues?.nodes;
  ok('gql-repository', repo.status === 200 && Array.isArray(nodes) && nodes.length === 1 && nodes[0]?.title === 'first issue', JSON.stringify(repo.body).slice(0, 300));
  const bad = await call('/api/graphql', { method: 'POST', headers: auth, body: JSON.stringify({ query: '{ viewer { noSuchField } }' }) });
  ok('gql-unknown-field-null', bad.status === 200 && bad.body?.data?.viewer === null && Array.isArray(bad.body?.errors), JSON.stringify(bad.body).slice(0, 300));
}

// 5. MCP: discover, initialize, tools/list, tools/call, parse error, 401
{
  const anon = await call('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
  ok('mcp-401', anon.status === 401, `status=${anon.status}`);
  const discover = await call('/mcp', { method: 'POST', headers: auth, body: JSON.stringify({ jsonrpc: '2.0', id: 'd1', method: 'server/discover', params: {} }) });
  const versions: string[] = discover.body?.result?.supportedVersions ?? [];
  ok('mcp-discover', discover.status === 200 && versions.includes('2026-07-28'), JSON.stringify(discover.body).slice(0, 200));
  const init = await call('/mcp', { method: 'POST', headers: auth, body: JSON.stringify({ jsonrpc: '2.0', id: 'i1', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } }) });
  ok('mcp-initialize', init.status === 200 && init.body?.result?.protocolVersion === '2025-06-18', JSON.stringify(init.body).slice(0, 200));
  const tools = await call('/mcp', { method: 'POST', headers: auth, body: JSON.stringify({ jsonrpc: '2.0', id: 't1', method: 'tools/list', params: {} }) });
  const names: string[] = (tools.body?.result?.tools ?? []).map((tool: any) => tool.name);
  ok('mcp-tools-list', tools.status === 200 && names.length >= 6 && ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request'].every((n) => names.includes(n)), JSON.stringify(names));
  const listed = await call('/mcp', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ jsonrpc: '2.0', id: 'c1', method: 'tools/call', params: { name: 'list_issues', arguments: { owner: 'adaiversen', repo: 'smoke', state: 'open' } } }),
  });
  const resultText = JSON.stringify(listed.body?.result?.structuredContent ?? '');
  ok('mcp-list-issues', listed.status === 200 && resultText.includes('first issue'), JSON.stringify(listed.body).slice(0, 300));
  const created = await call('/mcp', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ jsonrpc: '2.0', id: 'c2', method: 'tools/call', params: { name: 'create_issue', arguments: { owner: 'adaiversen', repo: 'smoke', title: 'from mcp', body: 'x' } } }),
  });
  ok('mcp-create-issue', created.status === 200 && created.body?.result?.structuredContent?.number === 2, JSON.stringify(created.body).slice(0, 300));
  const unknown = await call('/mcp', { method: 'POST', headers: auth, body: JSON.stringify({ jsonrpc: '2.0', id: 'u1', method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } }) });
  ok('mcp-unknown-tool', unknown.status !== 500 && unknown.body?.error?.code === -32602, JSON.stringify(unknown.body).slice(0, 200));
  const bad = await call('/mcp', { method: 'POST', headers: auth, body: '{not json' });
  ok('mcp-parse-error', bad.status === 400 && bad.body?.error?.code === -32700, `status=${bad.status}`);
}

// 6. git smart HTTP: advertisement
{
  const r = await call('/adaiversen/smoke.git/info/refs?service=git-upload-pack');
  ok('git-info-refs', r.status === 200 && r.text.includes('refs/heads/main'), `status=${r.status} head=${r.text.slice(0, 60)}`);
}

server.close();
console.log(failures === 0 ? 'SMOKE OK' : `SMOKE FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
