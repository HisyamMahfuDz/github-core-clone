// The Model Context Protocol surface: JSON-RPC 2.0 over Streamable HTTP, served as
// plain JSON responses. It implements the modern era (server/discover, protocol
// version 2026-07-28) with a legacy `initialize` fallback, and six tools that
// share the same store as the REST surface. Authentication is checked by the
// caller before this module ever sees a request.

import { branchTip, ForgeError, squashMerge } from './forge.ts';
import { issueView, pullView, repoView } from './rest.ts';
import type { Repo, Store } from './store.ts';
import { isRecord, VIEWER_LOGIN } from './util.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const MODERN_VERSION = '2026-07-28';
const LEGACY_VERSION = '2025-11-25';

export interface McpReply {
  readonly status: number;
  /** JSON value, or null for a bodyless reply (202 for notifications). */
  readonly body: unknown;
}

// ---------------------------------------------------------------------------------------------
// tool catalog (built once: tools/list must be byte-identical across calls)
// ---------------------------------------------------------------------------------------------

interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, { type: string; description?: string }>;
    readonly required: string[];
  };
}

function stringProp(description: string): { type: string; description: string } {
  return { type: 'string', description };
}

const TOOLS: readonly ToolDefinition[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        name: stringProp('The repository name.'),
        description: stringProp('The repository description.'),
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: stringProp('The owner login (defaults to the authenticated user).'),
        full_name: stringProp('The owner/name of the repository, as an alternative to owner and repo.'),
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: stringProp('The owner login.'),
        repo: stringProp('The repository name.'),
        full_name: stringProp('The owner/name of the repository, as an alternative to owner and repo.'),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: stringProp('The owner login.'),
        repo: stringProp('The repository name.'),
        title: stringProp('The issue title.'),
        body: stringProp('The issue body.'),
        full_name: stringProp('The owner/name of the repository, as an alternative to owner and repo.'),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues in a repository, newest first.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: stringProp('The owner login.'),
        repo: stringProp('The repository name.'),
        state: stringProp('Filter by state: open, closed, or all.'),
        full_name: stringProp('The owner/name of the repository, as an alternative to owner and repo.'),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: stringProp('The owner login.'),
        repo: stringProp('The repository name.'),
        title: stringProp('The pull request title.'),
        head: stringProp('The head branch name.'),
        base: stringProp('The base branch name.'),
        body: stringProp('The pull request body.'),
        full_name: stringProp('The owner/name of the repository, as an alternative to owner and repo.'),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit onto its base branch.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: stringProp('The owner login.'),
        repo: stringProp('The repository name.'),
        pull_number: { type: 'integer', description: 'The pull request number.' },
        full_name: stringProp('The owner/name of the repository, as an alternative to owner and repo.'),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

// ---------------------------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------------------------

type RequestId = string | number | null;

interface JsonRpcError {
  readonly code: number;
  readonly message: string;
}

function successResult(id: RequestId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function errorResult(id: RequestId, error: JsonRpcError): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code: error.code, message: error.message } };
}

function textResult(payload: unknown): Record<string, unknown> {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    content: [{ type: 'text', text }],
    structuredContent: payload,
  };
}

function errorTextResult(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------------------------
// argument handling
// ---------------------------------------------------------------------------------------------

function stringArg(args: Record<string, unknown>, name: string): string | null {
  const value = args[name];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Resolve owner/repo from the arguments, accepting `full_name` as a fallback. */
function resolveRepoArgs(args: Record<string, unknown>): { owner: string; repo: string } | null {
  let owner = stringArg(args, 'owner');
  let repo = stringArg(args, 'repo');
  const fullName = stringArg(args, 'full_name');
  if ((owner === null || repo === null) && fullName !== null) {
    const slash = fullName.indexOf('/');
    if (slash > 0 && slash < fullName.length - 1) {
      owner ??= fullName.slice(0, slash);
      repo ??= fullName.slice(slash + 1);
    }
  }
  if (owner === null || repo === null) return null;
  return { owner, repo };
}

function findRepo(store: Store, owner: string, repoName: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, repoName) ?? null;
}

// ---------------------------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------------------------

type ToolHandler = (store: Store, args: Record<string, unknown>) => Record<string, unknown>;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  create_repo: (store, args) => {
    const name = stringArg(args, 'name');
    if (name === null) throw new ToolArgumentError('name is required');
    if (store.getRepo(VIEWER_LOGIN, name) !== undefined) {
      return errorTextResult('name already exists on this account');
    }
    const repo = store.createRepo(VIEWER_LOGIN, name, {
      private: args.private === true,
      description: stringArg(args, 'description') ?? '',
      defaultBranch: 'main',
    });
    return textResult(repoView(repo));
  },
  get_repo: (store, args) => {
    const resolved = resolveRepoArgs(args);
    if (resolved === null) throw new ToolArgumentError('owner and repo are required');
    const repo = findRepo(store, resolved.owner, resolved.repo);
    if (repo === null) return errorTextResult('Not Found');
    return textResult(repoView(repo));
  },
  create_issue: (store, args) => {
    const resolved = resolveRepoArgs(args);
    if (resolved === null) throw new ToolArgumentError('owner and repo are required');
    const repo = findRepo(store, resolved.owner, resolved.repo);
    if (repo === null) return errorTextResult('Not Found');
    const title = stringArg(args, 'title');
    if (title === null) throw new ToolArgumentError('title is required');
    const issue = store.createIssue(repo, {
      title,
      body: stringArg(args, 'body') ?? '',
      labels: [],
    });
    return textResult(issueView(repo, issue));
  },
  list_issues: (store, args) => {
    const resolved = resolveRepoArgs(args);
    if (resolved === null) throw new ToolArgumentError('owner and repo are required');
    const repo = findRepo(store, resolved.owner, resolved.repo);
    if (repo === null) return errorTextResult('Not Found');
    const state = stringArg(args, 'state') ?? 'open';
    let issues = [...repo.issues.values()];
    if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
    issues.sort((a, b) => b.seq - a.seq);
    const views = issues.map((issue) => issueView(repo, issue));
    return {
      content: [{ type: 'text', text: JSON.stringify(views) }],
      structuredContent: { issues: views },
    };
  },
  create_pull_request: (store, args) => {
    const resolved = resolveRepoArgs(args);
    if (resolved === null) throw new ToolArgumentError('owner and repo are required');
    const repo = findRepo(store, resolved.owner, resolved.repo);
    if (repo === null) return errorTextResult('Not Found');
    const title = stringArg(args, 'title');
    const head = stringArg(args, 'head');
    const base = stringArg(args, 'base');
    if (title === null) throw new ToolArgumentError('title is required');
    if (head === null || base === null) throw new ToolArgumentError('head and base are required');
    const headTip = branchTip(repo, head);
    const baseTip = branchTip(repo, base);
    if (headTip === null || baseTip === null) {
      return errorTextResult('head and base must name existing branches');
    }
    for (const existing of repo.pulls.values()) {
      if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
        return errorTextResult('a pull request already exists for this head and base');
      }
    }
    const pull = store.createPull(repo, {
      title,
      body: stringArg(args, 'body') ?? '',
      headRef: head,
      baseRef: base,
      headSha: headTip,
      baseSha: baseTip,
    });
    return textResult(pullView(repo, pull));
  },
  merge_pull_request: (store, args) => {
    const resolved = resolveRepoArgs(args);
    if (resolved === null) throw new ToolArgumentError('owner and repo are required');
    const repo = findRepo(store, resolved.owner, resolved.repo);
    if (repo === null) return errorTextResult('Not Found');
    const raw = args.pull_number;
    const number = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : null;
    if (number === null) throw new ToolArgumentError('pull_number is required');
    const pull = repo.pulls.get(number);
    if (pull === undefined) return errorTextResult('Not Found');
    try {
      const sha = squashMerge(repo, pull);
      return textResult({ merged: true, sha, message: 'Pull request successfully merged' });
    } catch (err) {
      if (err instanceof ForgeError) return errorTextResult(err.message);
      throw err;
    }
  },
};

class ToolArgumentError extends Error {}

// ---------------------------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------------------------

/**
 * Handle one JSON-RPC request object. Returns null for notifications (no reply).
 */
function dispatchOne(store: Store, request: Record<string, unknown>): Record<string, unknown> | null {
  const hasId = request.id !== undefined && request.id !== null;
  const id: RequestId = typeof request.id === 'string' || typeof request.id === 'number' ? request.id : null;
  const method = request.method;
  if (typeof method !== 'string') {
    if (!hasId) return null;
    return errorResult(id, { code: -32600, message: 'Invalid Request: method is required' });
  }
  const isNotification = !hasId;

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return null;
  }
  if (isNotification) return null;

  if (method === 'server/discover') {
    return successResult(id, {
      supportedVersions: [MODERN_VERSION],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }
  if (method === 'initialize') {
    const params = isRecord(request.params) ? request.params : {};
    const requested = params.protocolVersion;
    const protocolVersion = requested === MODERN_VERSION ? MODERN_VERSION : LEGACY_VERSION;
    return successResult(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'ping') {
    return successResult(id, {});
  }
  if (method === 'tools/list') {
    return successResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const params = isRecord(request.params) ? request.params : {};
    const name = params.name;
    if (typeof name !== 'string' || name === '') {
      return errorResult(id, { code: -32602, message: 'Invalid params: tool name is required' });
    }
    const handler = TOOL_HANDLERS[name];
    if (handler === undefined) {
      return errorResult(id, { code: -32602, message: `Unknown tool: ${name}` });
    }
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    try {
      const result = handler(store, args);
      return successResult(id, result);
    } catch (err) {
      if (err instanceof ToolArgumentError) {
        return errorResult(id, { code: -32602, message: `Invalid params: ${err.message}` });
      }
      throw err;
    }
  }
  return errorResult(id, { code: -32601, message: `Method not found: ${method}` });
}

/**
 * Handle the raw request body of a POST /mcp. A body that is not JSON is a
 * parse error answered with HTTP 400; everything else is answered with HTTP
 * 200, or 202 with an empty body when the request was only notifications.
 */
export function handleMcp(store: Store, rawBody: string): McpReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (Array.isArray(parsed)) {
    const replies: unknown[] = [];
    for (const entry of parsed) {
      if (!isRecord(entry)) {
        replies.push(errorResult(null, { code: -32600, message: 'Invalid Request' }));
        continue;
      }
      const reply = dispatchOne(store, entry);
      if (reply !== null) replies.push(reply);
    }
    if (replies.length === 0) return { status: 202, body: null };
    return { status: 200, body: replies };
  }
  if (!isRecord(parsed)) {
    return {
      status: 200,
      body: errorResult(null, { code: -32600, message: 'Invalid Request' }),
    };
  }
  const reply = dispatchOne(store, parsed);
  if (reply === null) return { status: 202, body: null };
  return { status: 200, body: reply };
}
