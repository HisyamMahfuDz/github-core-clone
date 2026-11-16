// The HTTP application: one node:http server routing requests to the git, REST,
// GraphQL and MCP surfaces. Every reply carries a non-empty X-GitHub-Request-Id
// and, unless it is bodyless, an application/json content type. Authentication
// is a single bearer token: required everywhere except /healthz, the API root
// and /api/v3/meta. Any handler failure becomes a JSON 500; the server never
// crashes on a request.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleInfoRefs, handleReceivePack, handleUploadPack, type GitResponse } from './githttp.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type RestReply } from './rest.ts';
import { Store } from './store.ts';
import { decodeSegment, VIEWER_LOGIN } from './util.ts';

export interface AppOptions {
  /** The expected bearer token, or null to accept any request (local practice). */
  readonly token: string | null;
}

export interface App {
  readonly server: Server;
  readonly store: Store;
}

const BODY_LIMIT_BYTES = 64 * 1024 * 1024;

class BodyTooLargeError extends Error {}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    request.on('data', (chunk: Buffer) => {
      if (failed) return;
      total += chunk.length;
      if (total > BODY_LIMIT_BYTES) {
        failed = true;
        reject(new BodyTooLargeError('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    request.on('error', (err) => {
      if (!failed) {
        failed = true;
        reject(err);
      }
    });
  });
}

function isAuthorized(request: IncomingMessage, token: string | null): boolean {
  if (token === null) return true;
  const header = request.headers.authorization;
  if (typeof header !== 'string') return false;
  const bearer = `Bearer ${token}`;
  const tokenScheme = `token ${token}`;
  return header === bearer || header === tokenScheme;
}

function send(
  response: ServerResponse,
  requestId: string,
  status: number,
  headers: Record<string, string>,
  body: Buffer | null,
): void {
  const allHeaders: Record<string, string> = { 'x-github-request-id': requestId, ...headers };
  if (body !== null && body.length > 0) allHeaders['content-length'] = String(body.length);
  response.writeHead(status, allHeaders);
  if (body !== null) response.end(body);
  else response.end();
}

function sendJson(
  response: ServerResponse,
  requestId: string,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  if (status === 204 || body === null) {
    send(response, requestId, status, extraHeaders, null);
    return;
  }
  send(response, requestId, status, { 'content-type': 'application/json', ...extraHeaders }, Buffer.from(JSON.stringify(body), 'utf8'));
}

function sendGit(response: ServerResponse, requestId: string, git: GitResponse): void {
  send(response, requestId, git.status, git.headers, git.body);
}

function parseJsonBody(body: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (body.length === 0) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

export function createApp(options: AppOptions): App {
  const store = new Store();
  let requestCounter = 0;

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((err: unknown) => {
      console.error('request handler failed:', err);
      if (!response.headersSent) {
        try {
          sendJson(response, String(requestCounter + 1), 500, { message: 'Internal Server Error' });
        } catch {
          response.destroy();
        }
      } else {
        response.destroy();
      }
    });
  });

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestId = String(++requestCounter);
    let url: URL;
    try {
      url = new URL(request.url ?? '/', 'http://localhost');
    } catch {
      sendJson(response, requestId, 400, { message: 'Bad Request' });
      return;
    }
    const method = (request.method ?? 'GET').toUpperCase();
    let pathname = url.pathname;
    if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
    const segments = pathname.split('/').filter((segment) => segment !== '');

    if (method === 'GET' && pathname === '/healthz') {
      sendJson(response, requestId, 200, { ok: true });
      return;
    }

    const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
    let body: Buffer = Buffer.alloc(0);
    if (needsBody) {
      try {
        body = await readBody(request);
      } catch (err) {
        if (err instanceof BodyTooLargeError) {
          sendJson(response, requestId, 413, { message: 'Request body too large' });
          return;
        }
        sendJson(response, requestId, 400, { message: 'Bad Request' });
        return;
      }
    }

    try {
      // MCP: POST /mcp, authenticated, raw text body.
      if (pathname === '/mcp') {
        if (method !== 'POST') {
          sendJson(response, requestId, 405, { message: 'Method Not Allowed' });
          return;
        }
        if (!isAuthorized(request, options.token)) {
          sendJson(response, requestId, 401, { message: 'Requires authentication' });
          return;
        }
        const reply = handleMcp(store, body.toString('utf8'));
        if (reply.body === null) {
          send(response, requestId, reply.status, {}, null);
        } else {
          sendJson(response, requestId, reply.status, reply.body);
        }
        return;
      }

      // GraphQL: POST /api/graphql, authenticated.
      if (pathname === '/api/graphql') {
        if (method !== 'POST') {
          sendJson(response, requestId, 405, { message: 'Method Not Allowed' });
          return;
        }
        if (!isAuthorized(request, options.token)) {
          sendJson(response, requestId, 401, { message: 'Requires authentication' });
          return;
        }
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendJson(response, requestId, 400, { message: 'Malformed JSON body' });
          return;
        }
        const result = handleGraphQL(store, parsed.value);
        sendJson(response, requestId, 200, result);
        return;
      }

      // REST v3: /api/v3 and below. The root and meta are public.
      if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
        const restSegments = segments.slice(2);
        const isPublic = restSegments.length === 0 || (restSegments.length === 1 && restSegments[0] === 'meta');
        if (!isPublic && !isAuthorized(request, options.token)) {
          sendJson(response, requestId, 401, { message: 'Requires authentication' });
          return;
        }
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendJson(response, requestId, 400, { message: 'Malformed JSON body' });
          return;
        }
        const host = request.headers.host ?? 'localhost';
        const reply: RestReply = handleRest(store, {
          method,
          segments: restSegments,
          pathname,
          query: url.searchParams,
          host,
          body: parsed.value,
        });
        sendJson(response, requestId, reply.status, reply.body, reply.headers);
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/...
      if (segments.length >= 2 && segments[1]!.endsWith('.git')) {
        if (!isAuthorized(request, options.token)) {
          sendJson(response, requestId, 401, { message: 'Requires authentication' });
          return;
        }
        const owner = decodeSegment(segments[0]!);
        const repoName = decodeSegment(segments[1]!.slice(0, -4));
        const repo = owner === VIEWER_LOGIN ? store.getRepo(owner, repoName) : undefined;
        if (repo === undefined) {
          sendJson(response, requestId, 404, { message: 'Not Found' });
          return;
        }
        const tail = segments.slice(2);
        const version2 = request.headers['git-protocol'] === 'version=2';
        if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
          const service = url.searchParams.get('service') ?? '';
          const git = handleInfoRefs(repo, service, version2);
          sendGit(response, requestId, git);
          return;
        }
        if (method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
          const git = handleUploadPack(repo, body, version2);
          sendGit(response, requestId, git);
          return;
        }
        if (method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
          const git = handleReceivePack(repo, body);
          sendGit(response, requestId, git);
          return;
        }
        sendJson(response, requestId, 404, { message: 'Not Found' });
        return;
      }

      sendJson(response, requestId, 404, { message: 'Not Found' });
    } catch (err) {
      if (err instanceof Error && 'status' in err && typeof (err as { status: unknown }).status === 'number') {
        const status = (err as { status: number }).status;
        sendJson(response, requestId, status, { message: err.message });
        return;
      }
      throw err;
    }
  }

  return { server, store };
}
