#!/bin/bash
# End-to-end smoke test for the forge. Starts the server on a scratch port,
# exercises REST, git (v2 + v0, real git CLI), GraphQL and MCP, then stops it.
# Usage: ./test/smoke.sh   (requires: node, curl, git, python3)
set -u
cd "$(dirname "$0")/.."

PORT="${SMOKE_PORT:-3129}"
TOKEN="smoke-token"
BASE="http://127.0.0.1:$PORT"
AUTH="Authorization: Bearer $TOKEN"
PASS=0
FAIL=0
TMP="$(mktemp -d)"
export GIT_CONFIG_GLOBAL="$TMP/gitconfig"
git config --global user.name "Conformance"
git config --global user.email "conformance@make.fun"
git config --global init.defaultBranch main

check() { # check <name> <command...>; the command's exit status decides
  local name="$1"; shift
  if "$@" >"$TMP/out" 2>&1; then
    PASS=$((PASS + 1)); echo "PASS $name"
  else
    FAIL=$((FAIL + 1)); echo "FAIL $name"; sed 's/^/  /' "$TMP/out" | head -5
  fi
}

expect_code() { # expect_code <code> <args...> : curl must answer <code>
  local want="$1"; shift
  [ "$(curl -s -o "$TMP/body" -w "%{http_code}" "$@")" = "$want" ]
}
expect_body() { # expect_body <substring> <args...> : curl body contains substring
  local needle="$1"; shift
  curl -s "$@" | grep -qF "$needle"
}

cleanup() {
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

PORT=$PORT MAKEFUN_SHOP_TOKEN=$TOKEN node --experimental-strip-types dev.ts >"$TMP/server.log" 2>&1 &
SERVER_PID=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do curl -s -m 2 "$BASE/healthz" >/dev/null && break; sleep 0.5; done

# --- protocol ---------------------------------------------------------------
check "healthz 200" expect_code 200 "$BASE/healthz"
check "healthz body" expect_body '"ok":true' "$BASE/healthz"
check "api root 200 + scopes" bash -c "curl -s -i $BASE/api/v3/ | grep -qi 'x-oauth-scopes: repo, read:org'"
check "meta version" expect_body '"installed_version"' "$BASE/api/v3/meta"
check "no token -> 401" expect_code 401 "$BASE/api/v3/user"
check "wrong token -> 401" expect_code 401 -H "Authorization: Bearer nope" "$BASE/api/v3/user"
check "unknown route -> JSON 404" expect_code 404 -H "$AUTH" "$BASE/api/v3/bogus"
check "request id present" bash -c "curl -s -i -H '$AUTH' $BASE/api/v3/bogus | grep -qi 'x-github-request-id: [^[:space:]]'"
check "malformed JSON -> 400" expect_code 400 -X POST -H "$AUTH" -d '{bad' "$BASE/api/v3/user/repos"

# --- repos / contents -------------------------------------------------------
check "create repo 201" expect_code 201 -X POST -H "$AUTH" -d '{"name":"smoke","description":"d"}' "$BASE/api/v3/user/repos"
check "duplicate repo 422 + already exists" bash -c "curl -s -X POST -H '$AUTH' -d '{\"name\":\"smoke\"}' $BASE/api/v3/user/repos | grep -qi 'already exists'"
check "get repo" expect_body '"full_name":"adaiversen/smoke"' -H "$AUTH" "$BASE/api/v3/repos/adaiversen/smoke"
check "foreign owner -> 404" expect_code 404 -H "$AUTH" "$BASE/api/v3/repos/someone/smoke"
check "patch description" expect_body '"description":"new"' -X PATCH -H "$AUTH" -d '{"description":"new"}' "$BASE/api/v3/repos/adaiversen/smoke"
check "user repos page + Link" bash -c "curl -s -i -H '$AUTH' '$BASE/api/v3/user/repos?per_page=1&page=1' | grep -qi 'rel=\"next\"' || curl -s -H '$AUTH' '$BASE/api/v3/user/repos?per_page=1' | grep -q smoke"
B64_HELLO="$(printf 'hello forge\n' | base64 -w0)"
check "PUT contents creates (201)" expect_code 201 -X PUT -H "$AUTH" -d "{\"message\":\"add hello\",\"content\":\"$B64_HELLO\"}" "$BASE/api/v3/repos/adaiversen/smoke/contents/hello.txt"
SHA="$(curl -s -H "$AUTH" "$BASE/api/v3/repos/adaiversen/smoke/contents/hello.txt" | python3 -c "import sys,json; print(json.load(sys.stdin)['sha'])")"
check "GET contents round-trips" expect_body "$B64_HELLO" -H "$AUTH" "$BASE/api/v3/repos/adaiversen/smoke/contents/hello.txt"
check "stale sha -> 409" expect_code 409 -X PUT -H "$AUTH" -d "{\"message\":\"x\",\"content\":\"$B64_HELLO\",\"sha\":\"0000000000000000000000000000000000000000\"}" "$BASE/api/v3/repos/adaiversen/smoke/contents/hello.txt"
check "dir listing" expect_body '"name":"hello.txt"' -H "$AUTH" "$BASE/api/v3/repos/adaiversen/smoke/contents/"
check "commits list" expect_body '"message":"add hello"' -H "$AUTH" "$BASE/api/v3/repos/adaiversen/smoke/commits"
check "branches list" expect_body '"name":"main"' -H "$AUTH" "$BASE/api/v3/repos/adaiversen/smoke/branches"
check "DELETE contents" expect_code 200 -X DELETE -H "$AUTH" -d '{"message":"rm","sha":"'"$SHA"'"}' "$BASE/api/v3/repos/adaiversen/smoke/contents/hello.txt"
check "deleted file -> 404" expect_code 404 -H "$AUTH" "$BASE/api/v3/repos/adaiversen/smoke/contents/hello.txt"
curl -s -X PUT -H "$AUTH" -d "{\"message\":\"restore\",\"content\":\"$B64_HELLO\"}" "$BASE/api/v3/repos/adaiversen/smoke/contents/hello.txt" >/dev/null

# --- issues / labels --------------------------------------------------------
check "create label" expect_code 201 -X POST -H "$AUTH" -d '{"name":"bug","color":"ff0000"}' "$BASE/api/v3/repos/adaiversen/smoke/labels"
check "create issue" expect_code 201 -X POST -H "$AUTH" -d '{"title":"First","body":"b","labels":["bug"]}' "$BASE/api/v3/repos/adaiversen/smoke/issues"
check "unknown label -> 422" expect_code 422 -X POST -H "$AUTH" -d '{"title":"X","labels":["nope"]}' "$BASE/api/v3/repos/adaiversen/smoke/issues"
check "issue numbers increment" bash -c "curl -s -X POST -H '$AUTH' -d '{\"title\":\"Second\"}' $BASE/api/v3/repos/adaiversen/smoke/issues | grep -q '\"number\":2'"
check "list open issues" expect_body '"title":"First"' -H "$AUTH" "$BASE/api/v3/repos/adaiversen/smoke/issues?state=open"
check "close issue" expect_body '"state":"closed"' -X PATCH -H "$AUTH" -d '{"state":"closed"}' "$BASE/api/v3/repos/adaiversen/smoke/issues/1"
check "open list omits closed" bash -c "! curl -s -H '$AUTH' '$BASE/api/v3/repos/adaiversen/smoke/issues?state=open' | grep -q '\"number\":1'"
check "comment create" expect_code 201 -X POST -H "$AUTH" -d '{"body":"hi"}' "$BASE/api/v3/repos/adaiversen/smoke/issues/2/comments"
check "comment list" expect_body '"body":"hi"' -H "$AUTH" "$BASE/api/v3/repos/adaiversen/smoke/issues/2/comments"

# --- git over HTTP (real git CLI) -------------------------------------------
H="Authorization: Bearer $TOKEN"
check "v2 clone" git -c http.extraHeader="$H" clone -q "$BASE/adaiversen/smoke.git" "$TMP/c1"
check "v2 clone content" grep -q "hello forge" "$TMP/c1/hello.txt"
(cd "$TMP/c1" && printf 'second\n' >> hello.txt && git add -A && git commit -qm "second" && git tag -a v1 -m "v1")
check "v2 push + tag" git -C "$TMP/c1" -c http.extraHeader="$H" push -q origin main v1
check "v0 clone" git -c protocol.version=0 -c http.extraHeader="$H" clone -q "$BASE/adaiversen/smoke.git" "$TMP/c0"
check "v0 shallow clone" git -c protocol.version=0 -c http.extraHeader="$H" clone --depth 1 -q "$BASE/adaiversen/smoke.git" "$TMP/c0s"
check "v2 shallow + deepen" bash -c "git -c http.extraHeader='$H' clone --depth 1 -q $BASE/adaiversen/smoke.git $TMP/c2 && git -C $TMP/c2 -c http.extraHeader='$H' fetch --deepen=1 -q origin && [ \"\$(git -C $TMP/c2 rev-list --count origin/main)\" = 2 ]"
check "non-fast-forward rejected" bash -c "git -C $TMP/c0 reset -q --hard HEAD~1; git -C $TMP/c0 -c http.extraHeader='$H' push origin main 2>&1 | grep -qi 'non-fast-forward'"
check "ls-remote shows tag peel" bash -c "git -c http.extraHeader='$H' ls-remote $BASE/adaiversen/smoke.git | grep -q 'refs/tags/v1\\^{}'"
check "unknown repo -> 404" expect_code 404 -H "$AUTH" "$BASE/adaiversen/missing.git/info/refs?service=git-upload-pack"

# --- pull requests ----------------------------------------------------------
(cd "$TMP/c1" && git checkout -qb feature && printf 'feat\n' > feat.txt && git add -A && git commit -qm "feat" && git -c http.extraHeader="$H" push -q origin feature)
check "create PR" expect_code 201 -X POST -H "$AUTH" -d '{"title":"Feat","body":"b","head":"feature","base":"main"}' "$BASE/api/v3/repos/adaiversen/smoke/pulls"
check "PR files" expect_body '"filename":"feat.txt"' -H "$AUTH" "$BASE/api/v3/repos/adaiversen/smoke/pulls/3/files"
check "squash merge" expect_body '"merged":true' -X PUT -H "$AUTH" -d '{"merge_method":"squash"}' "$BASE/api/v3/repos/adaiversen/smoke/pulls/3/merge"
check "re-merge -> 405" expect_code 405 -X PUT -H "$AUTH" -d '{"merge_method":"squash"}' "$BASE/api/v3/repos/adaiversen/smoke/pulls/3/merge"

# --- GraphQL ------------------------------------------------------------------
GQL="$BASE/api/graphql"
check "gql viewer" expect_body '"login":"adaiversen"' -X POST -H "$AUTH" -d '{"query":"{ viewer { login } }"}' "$GQL"
check "gql repository fields" expect_body '"nameWithOwner":"adaiversen/smoke"' -X POST -H "$AUTH" -d '{"query":"{ repository(owner:\"adaiversen\",name:\"smoke\"){ nameWithOwner viewerPermission hasIssuesEnabled } }"}' "$GQL"
check "gql unknown field -> errors" expect_body 'noSuchFieldOnViewer' -X POST -H "$AUTH" -d '{"query":"{ viewer { noSuchFieldOnViewer } }"}' "$GQL"
check "gql unknown repo -> null" expect_body '"repository":null' -X POST -H "$AUTH" -d '{"query":"{ repository(owner:\"adaiversen\",name:\"missing\"){ id } }"}' "$GQL"
check "gql introspection Issue" expect_body '"name":"title"' -X POST -H "$AUTH" -d '{"query":"{ Issue: __type(name:\"Issue\"){ fields{ name } } }"}' "$GQL"
check "gql batch" expect_body '"login":"adaiversen"' -X POST -H "$AUTH" -d '[{"query":"{ viewer { login } }"},{"query":"{ viewer { login } }"}]' "$GQL"
check "gql unauthenticated -> 401" expect_code 401 -X POST -d '{"query":"{ viewer { login } }"}' "$GQL"
REPO_GID="$(curl -s -X POST -H "$AUTH" -d '{"query":"{ repository(owner:\"adaiversen\",name:\"smoke\"){ id } }"}' "$GQL" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['repository']['id'])")"
check "gql createIssue" expect_body '"number":4' -X POST -H "$AUTH" -d "{\"query\":\"mutation(\$input:CreateIssueInput!){ createIssue(input:\$input){ issue{ number } } }\",\"variables\":{\"input\":{\"repositoryId\":\"$REPO_GID\",\"title\":\"GQL issue\"}}}" "$GQL"
check "gql node() round-trip" expect_body '"name":"smoke"' -X POST -H "$AUTH" -d "{\"query\":\"query(\$id:ID!){ node(id:\$id){ ... on Repository { name } } }\",\"variables\":{\"id\":\"$REPO_GID\"}}" "$GQL"

# --- MCP ----------------------------------------------------------------------
MCP="$BASE/mcp"
check "mcp discover" expect_body '"2026-07-28"' -X POST -H "$AUTH" -d '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{}}' "$MCP"
check "mcp tools/list has six" bash -c "curl -s -X POST -H '$AUTH' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}' $MCP | grep -o '\"name\":\"[a-z_]*\"' | wc -l | grep -q 6"
check "mcp create_issue" expect_body 'MCP issue' -X POST -H "$AUTH" -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"create_issue","arguments":{"owner":"adaiversen","repo":"smoke","title":"MCP issue"}}}' "$MCP"
check "mcp unknown tool -> -32602" expect_body '"code":-32602' -X POST -H "$AUTH" -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"nope","arguments":{}}}' "$MCP"
check "mcp unknown method -> -32601" expect_body '"code":-32601' -X POST -H "$AUTH" -d '{"jsonrpc":"2.0","id":4,"method":"bogus","params":{}}' "$MCP"
check "mcp notification -> 202" expect_code 202 -X POST -H "$AUTH" -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' "$MCP"
check "mcp parse error -> 400" expect_code 400 -X POST -H "$AUTH" -d '{bad' "$MCP"
check "mcp unauthenticated -> 401" expect_code 401 -X POST -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "$MCP"

echo
echo "smoke: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
