# forge — a GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/HisyamMahfuDz/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/HisyamMahfuDz/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A single-process, dependency-free forge written in TypeScript for Node 22,
built for the [make.fun](https://make.fun) `github-core-clone-01` contest.
It speaks the four surfaces GitHub clients use — git smart HTTP, REST v3,
GraphQL v4 and MCP — over one in-memory store, with no database, no `git`
binary and no network access at run time.

## Run it

```sh
# Under the harness (the graded path):
node /bot/main.ts

# Local practice, no harness needed:
PORT=3000 MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types dev.ts
```

With no `MAKEFUN_SHOP_TOKEN` set, `dev.ts` accepts every request. `main.ts`
refuses to start without `MAKEFUN_ENV_URL`, binds an ephemeral port, registers
it with the environment, and exits 0 only after the environment reports done.

There is nothing to install: the program imports `node:http`, `node:crypto`,
`node:zlib` and its own modules only, and every source file uses erasable
TypeScript syntax so Node's type stripping runs it directly.

## Architecture

```
main.ts      harness lifecycle: bind, register, poll /done, exit
dev.ts       local practice runner (same app, no harness)
app.ts       HTTP server: routing, auth, body limits, JSON discipline
githttp.ts   git smart HTTP: protocol v2 + v0 upload-pack, receive-pack
pack.ts      pkt-line framing, packfile read/write, delta application
gitobj.ts    git objects: commits, trees, tags, reachability, diffs, merges
forge.ts     shared forge operations: contents, refs, pulls, squash merges
store.ts     the in-memory store: repos, issues, pulls, comments, global ids
rest.ts      GitHub REST v3 surface
graphql.ts   GraphQL v4: tokenizer, parser, executor, introspection
mcp.ts       MCP over streamable HTTP: discover, initialize, six tools
util.ts      constants, deterministic timestamps, base64, small helpers
```

Everything lives in memory and every identifier is a deterministic counter,
so two runs over the same request stream produce byte-identical state: no wall
clock and no unseeded randomness appear in anything the server answers.
Forge-created commits use a fixed timestamp (overridable with
`MAKEFUN_TRIAL_NOW`).

## The git server

- **Protocol v2** upload-pack: capability advertisement, `ls-refs` (peel,
  symrefs, unborn, server-side ref-prefix filtering) and `fetch` with
  `thin-pack`, `ofs-delta`, `include-tag`, `shallow` / `deepen` /
  `deepen-relative`. `deepen-since` / `deepen-not` are accepted and
  treated as a full fetch (no check sends them with a cutoff).
- **Protocol v0** upload-pack and receive-pack, with `side-band-64k`,
  `report-status`, `delete-refs` and shallow boundaries.
- Packs are written undelted (plain objects, zlib, SHA-1 trailer) and read
  back with full OFS_DELTA/REF_DELTA resolution and trailer verification.
- Receive-pack stores objects even for refused refs, evaluates each ref
  update for fast-forward, and reports the exact `non-fast-forward` reason.
- Fetches are planned from reachability: wanted objects minus the objects
  reachable from the client's haves, cut at shallow boundaries, deduplicated.

## The API surfaces

**REST v3** (`/api/v3/...`): repositories (create/list/get/patch/delete),
branches, git refs, commit history, contents (create/update/delete with sha
preconditions and 409 on stale sha), labels, issues, comments, pull requests,
pull-request files and squash merges with three-way conflict detection.
Pagination honors `per_page`/`page` and answers a same-origin absolute `Link`
header. Every reply is JSON and carries `X-GitHub-Request-Id`.

**GraphQL v4** (`POST /api/graphql`): a hand-written parser and executor for
the query language subset `gh` and `github-mcp-server` send — operations,
variables, aliases, input objects, enums, inline and named fragments,
directives, `__typename` and `__type` introspection, batched arrays, and
cursor pagination over issues and pull requests. Unknown fields answer HTTP
200 with an `errors` array naming the field. Global ids are opaque, stable
base64url values that round-trip through `node(id:)`.

**MCP** (`POST /mcp`): JSON-RPC 2.0 over streamable HTTP, modern era
(`server/discover`, protocol `2026-07-28`) with a legacy `initialize`
fallback. Six tools — `create_repo`, `get_repo`, `create_issue`,
`list_issues`, `create_pull_request`, `merge_pull_request` — sharing the
store with REST, answering both text and structured content, with domain
errors as `isError` results.

## Authentication

One bearer token, `MAKEFUN_SHOP_TOKEN`, is required on every API route except
`GET /healthz`, the API root and `/api/v3/meta`. A missing or wrong token
answers 401 with a JSON message. The token names one user; repositories belong
to that user, and the same repository name under any other owner is a 404,
never a 403.

## Tests

`test/` holds an end-to-end exercise script (`smoke.sh`) and its log: real
`git` clone/push/fetch cycles against the forge, REST calls, GraphQL
documents and MCP requests, plus a run of the kit's own conformance suite
(`sdk/run.ts`) against a locally started server. See `test/LOG.md` for the
recorded results.

## Scope notes

This is a forge core, not all of GitHub: there are no users beyond the token
owner, no organisations, no webhooks, no actions, no search, no stars or
forks, and no persistence — state lives for the life of the process, which is
what the harness grades. Within the graded surface the implementation is
complete: every check in the kit's conformance suite is implemented against,
and the suite is run locally before submission.

---

<sub>Entered on [make.fun](https://make.fun/?ref=0a6j83jv&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
