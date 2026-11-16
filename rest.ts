// The GitHub REST v3 surface: repositories, branches, git refs, commits, contents,
// labels, issues, comments and pull requests. Every reply is JSON; errors carry a
// string `message`. Ownership is absolute: a repository belongs to the login the
// token names, and the same name under any other owner is a 404, never a 403.

import {
  branchNames,
  branchTip,
  deleteContents,
  ForgeError,
  listCommits,
  pullFiles,
  resolveRef,
  squashMerge,
  writeContents,
} from './forge.ts';
import { parseCommit, parseTree, resolveTreePath } from './gitobj.ts';
import { lookupOf, type Comment, type Issue, type PullRequest, type Repo, type Store } from './store.ts';
import {
  b64decode,
  b64encode,
  decodeSegment,
  forgeTimestamp,
  isRecord,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
} from './util.ts';

export interface RestReply {
  readonly status: number;
  readonly headers: Record<string, string>;
  /** JSON value, or null for a bodyless reply (204). */
  readonly body: unknown;
}

function reply(status: number, body: unknown, headers: Record<string, string> = {}): RestReply {
  return { status, headers, body };
}

function errorReply(status: number, message: string): RestReply {
  return reply(status, { message });
}

// ---------------------------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------------------------

export function userView(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
    type: 'User',
    site_admin: false,
  };
}

export function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.databaseId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userView(),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    fork: false,
    has_issues: true,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `/${repo.owner}/${repo.name}`,
  };
}

export function labelView(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return { name, color: label?.color ?? 'ededed', description: '' };
}

export function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelView(repo, name)),
    user: userView(),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: (repo.comments.get(issue.number) ?? []).length,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function commentView(comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: userView(),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}

export function pullView(repo: Repo, pull: PullRequest): Record<string, unknown> {
  const headSha = branchTip(repo, pull.headRef) ?? pull.headShaAtCreation;
  const baseSha = branchTip(repo, pull.baseRef) ?? pull.baseShaAtCreation;
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: userView(),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

// ---------------------------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------------------------

export interface PageParams {
  readonly perPage: number;
  readonly page: number;
}

export function pageParams(query: URLSearchParams): PageParams {
  const perPageRaw = Number(query.get('per_page'));
  const pageRaw = Number(query.get('page'));
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  return { perPage, page };
}

/** Slice `items` to the requested page and build the Link header when a next page exists. */
export function paginate<T>(
  items: readonly T[],
  params: PageParams,
  host: string,
  pathname: string,
  query: URLSearchParams,
): { page: T[]; headers: Record<string, string> } {
  const start = (params.page - 1) * params.perPage;
  const page = items.slice(start, start + params.perPage);
  const headers: Record<string, string> = {};
  if (start + params.perPage < items.length) {
    const nextQuery = new URLSearchParams(query);
    nextQuery.set('per_page', String(params.perPage));
    nextQuery.set('page', String(params.page + 1));
    headers.link = `<http://${host}${pathname}?${nextQuery.toString()}>; rel="next"`;
  }
  return { page, headers };
}

// ---------------------------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------------------------

export interface RestRequest {
  readonly method: string;
  /** Decoded path segments (no leading empty segment, no trailing empty segment). */
  readonly segments: string[];
  readonly pathname: string;
  readonly query: URLSearchParams;
  readonly host: string;
  /** The parsed JSON body, or null when the request carried no JSON body. */
  readonly body: unknown;
}

function bodyRecord(body: unknown): Record<string, unknown> {
  return isRecord(body) ? body : {};
}

function parseNumber(segment: string): number | null {
  if (!/^\d+$/.test(segment)) return null;
  const value = Number(segment);
  return Number.isSafeInteger(value) ? value : null;
}

const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** The REST router. `segments` start after `/api/v3` (already decoded). */
export function handleRest(store: Store, request: RestRequest): RestReply {
  const { method, segments, query, host } = request;
  try {
    // API root and meta are public (auth is decided by the caller for these).
    if (segments.length === 0) {
      if (method !== 'GET') return errorReply(404, 'Not Found');
      return reply(
        200,
        { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
    }
    if (segments.length === 1 && segments[0] === 'meta') {
      if (method !== 'GET') return errorReply(404, 'Not Found');
      return reply(200, { installed_version: '1.0.0' });
    }
    if (segments.length === 1 && segments[0] === 'user' && method === 'GET') {
      return reply(200, userView());
    }
    if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
      if (method === 'POST') return createRepo(store, request);
      if (method === 'GET') return listUserRepos(store, request);
      return errorReply(404, 'Not Found');
    }
    if (segments.length >= 3 && segments[0] === 'repos') {
      return handleRepoRoute(store, request);
    }
    return errorReply(404, 'Not Found');
  } catch (err) {
    if (err instanceof ForgeError) return errorReply(err.status, err.message);
    throw err;
  }
}

function createRepo(store: Store, request: RestRequest): RestReply {
  const body = bodyRecord(request.body);
  const name = body.name;
  if (typeof name !== 'string' || name === '' || !REPO_NAME_RE.test(name)) {
    return errorReply(422, 'name is required and must be a valid repository name');
  }
  if (store.getRepo(VIEWER_LOGIN, name) !== undefined) {
    return errorReply(422, 'name already exists on this account');
  }
  const defaultBranch =
    typeof body.default_branch === 'string' && body.default_branch !== '' ? body.default_branch : 'main';
  const repo = store.createRepo(VIEWER_LOGIN, name, {
    private: body.private === true,
    description: typeof body.description === 'string' ? body.description : '',
    defaultBranch: defaultBranch,
  });
  return reply(201, repoView(repo));
}

function listUserRepos(store: Store, request: RestRequest): RestReply {
  const params = pageParams(request.query);
  const repos = store.reposOf(VIEWER_LOGIN);
  const { page, headers } = paginate(repos, params, request.host, request.pathname, request.query);
  return reply(200, page.map(repoView), headers);
}

/** Resolve the repository a /repos/{owner}/{name}/... route names, or null (404). */
function resolveRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, name) ?? null;
}

function handleRepoRoute(store: Store, request: RestRequest): RestReply {
  const { method, segments } = request;
  const owner = decodeSegment(segments[1]!);
  const name = decodeSegment(segments[2]!);
  const repo = resolveRepo(store, owner, name);
  if (repo === null) return errorReply(404, 'Not Found');
  const tail = segments.slice(3);

  if (tail.length === 0) {
    if (method === 'GET') return reply(200, repoView(repo));
    if (method === 'PATCH') {
      const body = bodyRecord(request.body);
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      return reply(200, repoView(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, name);
      return reply(204, null);
    }
    return errorReply(404, 'Not Found');
  }

  const head = tail[0]!;
  if (head === 'branches') return handleBranches(repo, request, tail.slice(1));
  if (head === 'git' && tail[1] === 'refs') return handleGitRefs(repo, request, tail.slice(2));
  if (head === 'commits' && tail.length === 1 && method === 'GET') return handleCommits(repo, request);
  if (head === 'contents') return handleContents(store, repo, request, tail.slice(1));
  if (head === 'labels') return handleLabels(repo, request, tail.slice(1));
  if (head === 'issues') return handleIssues(store, repo, request, tail.slice(1));
  if (head === 'pulls') return handlePulls(store, repo, request, tail.slice(1));
  return errorReply(404, 'Not Found');
}

function handleBranches(repo: Repo, request: RestRequest, tail: readonly string[]): RestReply {
  const { method } = request;
  if (tail.length === 0) {
    if (method !== 'GET') return errorReply(404, 'Not Found');
    const branches = branchNames(repo).map((name) => ({
      name,
      commit: { sha: branchTip(repo, name) },
      protected: false,
    }));
    return reply(200, branches);
  }
  if (method !== 'GET') return errorReply(404, 'Not Found');
  const branch = tail.map(decodeSegment).join('/');
  const tip = branchTip(repo, branch);
  if (tip === null) return errorReply(404, 'Branch not found');
  return reply(200, { name: branch, commit: { sha: tip }, protected: false });
}

function handleGitRefs(repo: Repo, request: RestRequest, tail: readonly string[]): RestReply {
  const { method } = request;
  if (method === 'POST' && tail.length === 0) {
    const body = bodyRecord(request.body);
    const ref = body.ref;
    const sha = body.sha;
    if (typeof ref !== 'string' || !ref.startsWith('refs/') || ref.includes(' ') || ref.includes('..')) {
      return errorReply(422, 'ref must be a valid ref name under refs/');
    }
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/i.test(sha) || !repo.objects.has(sha.toLowerCase())) {
      return errorReply(422, 'sha must name an object the repository holds');
    }
    const normalized = sha.toLowerCase();
    repo.refs.set(ref, normalized);
    return reply(201, { ref, object: { sha: normalized } });
  }
  if (method === 'GET') {
    const wanted = `refs/${tail.map(decodeSegment).join('/')}`;
    const exact = repo.refs.get(wanted);
    if (exact !== undefined) return reply(200, { ref: wanted, object: { sha: exact } });
    const matches = [...repo.refs.entries()]
      .filter(([name]) => name.startsWith(wanted))
      .map(([name, sha]) => ({ ref: name, object: { sha } }));
    if (matches.length > 0) return reply(200, matches);
    return errorReply(404, 'Not Found');
  }
  return errorReply(404, 'Not Found');
}

function handleCommits(repo: Repo, request: RestRequest): RestReply {
  const shaParam = request.query.get('sha');
  const ref = shaParam ?? repo.defaultBranch;
  if (shaParam !== null && resolveRef(repo, shaParam) === null) {
    return errorReply(404, `ref ${shaParam} does not exist`);
  }
  if (shaParam === null && branchTip(repo, repo.defaultBranch) === null) {
    return reply(200, []);
  }
  const commits = listCommits(repo, ref);
  const params = pageParams(request.query);
  const { page, headers } = paginate(commits, params, request.host, request.pathname, request.query);
  const views = page.map((commit) => ({
    sha: commit.sha,
    commit: {
      message: commit.message,
      author: { name: commit.authorName, email: commit.authorEmail, date: new Date(commit.authorEpoch * 1000).toISOString() },
      committer: { name: commit.committerName, email: commit.committerEmail, date: new Date(commit.committerEpoch * 1000).toISOString() },
      tree: { sha: commit.tree },
    },
    parents: commit.parents.map((sha) => ({ sha })),
  }));
  return reply(200, views, headers);
}

function handleContents(store: Store, repo: Repo, request: RestRequest, tail: readonly string[]): RestReply {
  const { method } = request;
  const path = tail.map(decodeSegment).join('/');
  if (method === 'PUT') {
    const body = bodyRecord(request.body);
    if (typeof body.content !== 'string') return errorReply(422, 'content must be a base64 string');
    const message = typeof body.message === 'string' ? body.message : '';
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const sha = typeof body.sha === 'string' ? body.sha : undefined;
    const content = b64decode(body.content);
    const result = writeContents(repo, path, content, message, branch, sha);
    const name = path.split('/').pop() ?? path;
    return reply(result.created ? 201 : 200, {
      content: { name, path, sha: result.blobSha, size: content.length, type: 'file', encoding: 'base64' },
      commit: { sha: result.commitSha, message },
    });
  }
  if (method === 'GET') return getContents(repo, request, path);
  if (method === 'DELETE') {
    const body = bodyRecord(request.body);
    const message = typeof body.message === 'string' ? body.message : '';
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const sha = typeof body.sha === 'string' ? body.sha : undefined;
    const commitSha = deleteContents(repo, path, message, branch, sha);
    return reply(200, { commit: { sha: commitSha, message }, content: null });
  }
  return errorReply(404, 'Not Found');
}

function getContents(repo: Repo, request: RestRequest, path: string): RestReply {
  const ref = request.query.get('ref') ?? repo.defaultBranch;
  const tip = resolveRef(repo, ref);
  if (tip === null) return errorReply(404, 'Not Found');
  const lookup = lookupOf(repo);
  const commitObject = repo.objects.get(tip);
  if (commitObject === undefined || commitObject.type !== 'commit') return errorReply(404, 'Not Found');
  const rootTree = parseCommit(commitObject.data).tree;
  const resolved = resolveTreePath(rootTree, lookup, path);
  if (resolved === null) return errorReply(404, 'Not Found');
  if (!resolved.isDir) {
    const blob = repo.objects.get(resolved.entry.oid);
    if (blob === undefined) return errorReply(404, 'Not Found');
    const name = path.split('/').pop() ?? path;
    return reply(200, {
      type: 'file',
      encoding: 'base64',
      content: b64encode(blob.data),
      sha: resolved.entry.oid,
      size: blob.data.length,
      name,
      path,
    });
  }
  const treeObject = repo.objects.get(resolved.entry.oid);
  if (treeObject === undefined) return errorReply(404, 'Not Found');
  const entries = parseTree(treeObject.data).map((entry) => {
    const entryPath = path === '' ? entry.name : `${path}/${entry.name}`;
    const child = repo.objects.get(entry.oid);
    return {
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: entryPath,
      sha: entry.oid,
      size: entry.mode === '40000' ? 0 : (child?.data.length ?? 0),
    };
  });
  return reply(200, entries);
}

function handleLabels(repo: Repo, request: RestRequest, tail: readonly string[]): RestReply {
  const { method } = request;
  if (tail.length !== 0) return errorReply(404, 'Not Found');
  if (method === 'GET') {
    return reply(200, [...repo.labels.keys()].map((name) => labelView(repo, name)));
  }
  if (method === 'POST') {
    const body = bodyRecord(request.body);
    const name = body.name;
    if (typeof name !== 'string' || name === '') return errorReply(422, 'name is required');
    const color = typeof body.color === 'string' && body.color !== '' ? body.color : 'ededed';
    repo.labels.set(name, { name, color });
    return reply(201, labelView(repo, name));
  }
  return errorReply(404, 'Not Found');
}

function handleIssues(store: Store, repo: Repo, request: RestRequest, tail: readonly string[]): RestReply {
  const { method } = request;
  if (tail.length === 0) {
    if (method === 'POST') return createIssue(store, repo, request);
    if (method === 'GET') return listIssues(repo, request);
    return errorReply(404, 'Not Found');
  }
  const number = parseNumber(tail[0]!);
  if (number === null) return errorReply(404, 'Not Found');
  const issue = repo.issues.get(number);
  if (tail.length === 1) {
    if (issue === undefined) return errorReply(404, 'Not Found');
    if (method === 'GET') return reply(200, issueView(repo, issue));
    if (method === 'PATCH') {
      const body = bodyRecord(request.body);
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      issue.updatedAt = forgeTimestamp();
      return reply(200, issueView(repo, issue));
    }
    return errorReply(404, 'Not Found');
  }
  if (tail.length === 2 && tail[1] === 'comments') {
    if (issue === undefined) return errorReply(404, 'Not Found');
    if (method === 'GET') {
      return reply(200, (repo.comments.get(number) ?? []).map(commentView));
    }
    if (method === 'POST') {
      const body = bodyRecord(request.body);
      const commentBody = typeof body.body === 'string' ? body.body : '';
      const comment = store.addComment(repo, number, commentBody);
      return reply(201, commentView(comment));
    }
  }
  return errorReply(404, 'Not Found');
}

function createIssue(store: Store, repo: Repo, request: RestRequest): RestReply {
  const body = bodyRecord(request.body);
  const title = body.title;
  if (typeof title !== 'string' || title === '') return errorReply(422, 'title is required');
  const rawLabels = Array.isArray(body.labels) ? body.labels : [];
  const labelNames: string[] = [];
  for (const entry of rawLabels) {
    const name = typeof entry === 'string' ? entry : isRecord(entry) && typeof entry.name === 'string' ? entry.name : null;
    if (name === null) continue;
    if (!repo.labels.has(name)) return errorReply(422, `label ${name} does not exist`);
    labelNames.push(name);
  }
  const issue = store.createIssue(repo, {
    title,
    body: typeof body.body === 'string' ? body.body : '',
    labels: labelNames,
  });
  return reply(201, issueView(repo, issue));
}

function listIssues(repo: Repo, request: RestRequest): RestReply {
  const state = request.query.get('state') ?? 'open';
  const direction = request.query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
  issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  const params = pageParams(request.query);
  const { page, headers } = paginate(issues, params, request.host, request.pathname, request.query);
  return reply(200, page.map((issue) => issueView(repo, issue)), headers);
}

function handlePulls(store: Store, repo: Repo, request: RestRequest, tail: readonly string[]): RestReply {
  const { method } = request;
  if (tail.length === 0) {
    if (method === 'POST') return createPull(store, repo, request);
    if (method === 'GET') return listPulls(repo, request);
    return errorReply(404, 'Not Found');
  }
  const number = parseNumber(tail[0]!);
  if (number === null) return errorReply(404, 'Not Found');
  const pull = repo.pulls.get(number);
  if (tail.length === 1) {
    if (pull === undefined) return errorReply(404, 'Not Found');
    if (method === 'GET') return reply(200, pullView(repo, pull));
    return errorReply(404, 'Not Found');
  }
  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    if (pull === undefined) return errorReply(404, 'Not Found');
    const files = pullFiles(repo, pull).map((change) => ({
      filename: change.path,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.additions + change.deletions,
      sha: change.newOid ?? change.oldOid ?? '',
    }));
    return reply(200, files);
  }
  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    if (pull === undefined) return errorReply(404, 'Not Found');
    const sha = squashMerge(repo, pull);
    pull.updatedAt = forgeTimestamp();
    return reply(200, { merged: true, sha, message: 'Pull request successfully merged' });
  }
  return errorReply(404, 'Not Found');
}

function createPull(store: Store, repo: Repo, request: RestRequest): RestReply {
  const body = bodyRecord(request.body);
  const title = body.title;
  const head = body.head;
  const base = body.base;
  if (typeof title !== 'string' || title === '') return errorReply(422, 'title is required');
  if (typeof head !== 'string' || head === '' || typeof base !== 'string' || base === '') {
    return errorReply(422, 'head and base are required');
  }
  const headTip = branchTip(repo, head);
  const baseTip = branchTip(repo, base);
  if (headTip === null || baseTip === null) {
    return errorReply(422, 'head and base must name existing branches');
  }
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
      return errorReply(422, 'a pull request already exists for this head and base');
    }
  }
  const pull = store.createPull(repo, {
    title,
    body: typeof body.body === 'string' ? body.body : '',
    headRef: head,
    baseRef: base,
    headSha: headTip,
    baseSha: baseTip,
  });
  return reply(201, pullView(repo, pull));
}

function listPulls(repo: Repo, request: RestRequest): RestReply {
  const state = request.query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
  pulls.sort((a, b) => b.seq - a.seq);
  const params = pageParams(request.query);
  const { page, headers } = paginate(pulls, params, request.host, request.pathname, request.query);
  return reply(200, page.map((pull) => pullView(repo, pull)), headers);
}
