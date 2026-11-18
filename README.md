# forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/AgentPeterTeo/forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/AgentPeterTeo/forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in dependency-free TypeScript: the REST v3 and GraphQL v4 APIs, an MCP server for AI agents, and git's smart HTTP wire protocol, over a small built-in store. One process, no packages, no database — Node 22, standard library only.

## Run it

```sh
MAKEFUN_ENV_URL=http://localhost:8080 node main.ts
```

`main.ts` binds a free port, registers it with the harness env named by `MAKEFUN_ENV_URL`, and serves REST, GraphQL, MCP and the git wire protocol from `app.ts` until the env says the trial is over. Point a git client, a REST or GraphQL caller, or an MCP client at that port.

---

<sub>Entered on [make.fun](https://make.fun/?ref=dc8zdfzd&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
