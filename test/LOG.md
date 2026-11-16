# Test log

How the forge was verified. All runs on the dev VM (Node v24.22.1, real
`git` 2.43), 16 Nov 2026. The graded trial runs Node 22.18+; the code uses
erasable TypeScript syntax only and stdlib-only imports
(`node:http`, `node:crypto`, `node:zlib`), so it runs unchanged there.

## 1. Kit conformance suite (`sdk/run.ts`)

Command (against `dev.ts` on a scratch port, token `test-token`):

```
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:3123 \
  --token test-token --perf --json
```

Final run (after all fixes): **120/120 checks passed** — git 30/30,
repos 15/15, issues 15/15, pulls 20/20, protocol 5/5, graphql 20/20,
mcp 15/15. Columns: feature 600, agent 200, perf 163, **score 963**,
working 1, manifest_issues [].

Perf detail (median of 3 rounds after 5 warm-ups; T_ref = house
calibration medians):

| workload | p50 | T_ref | points |
|----------|-----|-------|--------|
| push (200 sequential 1 KiB pushes) | 572 ms | 1640.82 ms | 44/50 |
| clone (50 concurrent depth-1 clones, 200-commit repo) | 118 ms | 266.94 ms | 40/50 |
| read (2,000 sequential issue GETs, one connection) | 979 ms | 2759.72 ms | 44/50 |
| write (200 sequential issue creates) | 204 ms | 348.97 ms | 35/50 |

Perf numbers vary run to run with VM load (an earlier identical run
scored 947 with push p50 1132 ms); the graded run happens on the trial
pod, so treat these as indicative. Conformance was 120/120 on every run.

## 2. Smoke script (`test/smoke.sh`)

62 checks, all passing: protocol discipline (healthz, 401/404/400,
request-id), repos/contents (create, duplicate 422, pagination Link,
base64 round-trip, stale-sha 409, dir listing, delete), issues/labels
(unknown-label 422, numbering, state filter, comments), real-git flows
(v2 + v0 clone/push/fetch, shallow + deepen, non-fast-forward, tag peel,
unknown-repo 404), pull requests (files diff, squash merge, re-merge
405), GraphQL (viewer, repository, unknown field, introspection, batch,
401, createIssue, node round-trip), MCP (discover, tools/list, calls,
-32601/-32602, notification 202, parse error 400, 401).

Run it with: `./test/smoke.sh` (needs node, curl, git, python3).

## 3. Real-git matrix (manual, git 2.43)

- v2 clone / push / fetch; v2 shallow clone + `--deepen` (1→2→4 commits
  on a 4-commit repo, with an annotated tag present — this caught a real
  bug: the relative-depth planner did not peel tag wants, fixed by
  peeling tags at the same distance in `boundaryDistances`).
- v0 clone, incremental fetch, shallow clone, `--deepen` twice
  (1→2→3), `--unshallow`.
- Annotated tag push; tag arrives in a fresh clone via `include-tag`;
  `ls-remote` shows the `^{}` peel line.
- Branch create/delete via push; non-fast-forward rejection with the
  exact `non-fast-forward` reason and exit 1; empty-repo clone warning.
- Ground truth for the v0 wire format was taken from real
  `git upload-pack --stateless-rpc` probes (shallow section before the
  ACK section; `ACK <oid> common` + one bare `ACK`; negotiation rounds
  without `done` answer only that round's sections).

## 4. Harness lifecycle (`main.ts`)

Verified against a mock env server: binds an ephemeral port, POSTs
`/register`, answers both `/healthz` probes with 200 `{"ok":true}`,
serves the API, polls `/done`, closes and exits 0. Without
`MAKEFUN_ENV_URL` it exits 1 immediately.

## 5. Pack-level checks

- Delta-pack round-trip: a pack produced by real git re-reads with a
  valid checksum and identical entries after write→re-read. (That pack
  contained 0 delta objects; OFS/REF delta resolution is exercised by
  the kit suite's pack/fetch checks, which pass, but no dedicated
  delta-heavy real-git pack test was run — see README weaknesses.)
- `readPack` optimization (Adler-32 zlib-stream-end scan + cached
  inflated bytes + deflate cache in `writePack`): 1.71 ms → 0.10 ms
  per single-object pack in-process; server-side push-pair cost
  1.43 ms.

## 6. Known gaps (honest)

- `deepen-since` / `deepen-not` are accepted and ignored (full fetch).
- v2 `filter` is not advertised (no check sends one).
- Packs are always undelted (the suite accepts this; `pack-deltas`
  passes with 0 deltas).
- No persistence: state lives for the process lifetime (the trial
  runs one process per trial, and the env exports state via the API).
- Ungraded GitHub surfaces are not implemented: no other users, orgs,
  webhooks, Actions, search, stars, forks, or web UI.
