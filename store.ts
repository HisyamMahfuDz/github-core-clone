// The forge's in-memory store: repositories, git objects and refs, labels, issues,
// pull requests and comments. One process holds one store; nothing is persisted.
// Every id is a deterministic counter — no randomness, no clock — so a replay of
// the same requests reaches the same state.

import { hashObject, type GitObject, type GitObjectType } from './gitobj.ts';
import { b64urlDecode, b64urlEncode, forgeTimestamp, VIEWER_LOGIN } from './util.ts';

export interface Label {
  readonly name: string;
  readonly color: string;
}

export interface Issue {
  readonly number: number;
  readonly id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly seq: number;
  readonly createdAt: string;
  updatedAt: string;
}

export interface PullRequest {
  readonly number: number;
  readonly id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly headRef: string;
  readonly baseRef: string;
  readonly headShaAtCreation: string;
  readonly baseShaAtCreation: string;
  readonly seq: number;
  readonly createdAt: string;
  updatedAt: string;
}

export interface Comment {
  readonly id: number;
  readonly body: string;
  readonly createdAt: string;
}

export interface Repo {
  readonly databaseId: number;
  readonly name: string;
  readonly owner: string;
  private: boolean;
  description: string;
  readonly defaultBranch: string;
  readonly createdSeq: number;
  readonly createdAt: string;
  /** Git objects by id. */
  readonly objects: Map<string, GitObject>;
  /** Refs by full name (refs/heads/..., refs/tags/...). */
  readonly refs: Map<string, string>;
  readonly labels: Map<string, Label>;
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, PullRequest>;
  /** Comments keyed by issue/PR number. */
  readonly comments: Map<number, Comment[]>;
  /** The shared issue/PR numbering sequence; the next number to hand out. */
  nextNumber: number;
  /** The next per-repo comment id. */
  nextCommentId: number;
}

export class Store {
  /** Repositories by "owner/name", in creation order. */
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextItemId = 1;
  private nextSeq = 1;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  /** Repositories owned by `owner`, in creation order. */
  reposOf(owner: string): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner === owner);
  }

  createRepo(owner: string, name: string, input: { private: boolean; description: string; defaultBranch: string }): Repo {
    const repo: Repo = {
      databaseId: this.nextRepoId++,
      name,
      owner,
      private: input.private,
      description: input.description,
      defaultBranch: input.defaultBranch,
      createdSeq: this.nextSeq++,
      createdAt: forgeTimestamp(),
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      comments: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  nextSequence(): number {
    return this.nextSeq++;
  }

  /** A fresh stable REST id for an issue, pull request or comment. */
  allocateItemId(): number {
    return this.nextItemId++;
  }

  createIssue(repo: Repo, input: { title: string; body: string; labels: string[] }): Issue {
    const now = forgeTimestamp();
    const issue: Issue = {
      number: repo.nextNumber++,
      id: this.allocateItemId(),
      title: input.title,
      body: input.body,
      state: 'open',
      labels: [...input.labels],
      seq: this.nextSequence(),
      createdAt: now,
      updatedAt: now,
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  createPull(
    repo: Repo,
    input: { title: string; body: string; headRef: string; baseRef: string; headSha: string; baseSha: string },
  ): PullRequest {
    const now = forgeTimestamp();
    const pull: PullRequest = {
      number: repo.nextNumber++,
      id: this.allocateItemId(),
      title: input.title,
      body: input.body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: input.headRef,
      baseRef: input.baseRef,
      headShaAtCreation: input.headSha,
      baseShaAtCreation: input.baseSha,
      seq: this.nextSequence(),
      createdAt: now,
      updatedAt: now,
    };
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  addComment(repo: Repo, number: number, body: string): Comment {
    const comment: Comment = { id: repo.nextCommentId++, body, createdAt: forgeTimestamp() };
    const list = repo.comments.get(number) ?? [];
    list.push(comment);
    repo.comments.set(number, list);
    return comment;
  }
}

/** Store one object in a repo, returning its id. Idempotent: the same bytes hash the same. */
export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/** A repo's object lookup, for the git walk helpers. */
export function lookupOf(repo: Repo): (oid: string) => GitObject | undefined {
  return (oid: string) => repo.objects.get(oid);
}

// ---------------------------------------------------------------------------------------------
// opaque global (Relay) ids for GraphQL: base64url of "Type:payload", stable across reads.
// ---------------------------------------------------------------------------------------------

export type GlobalId =
  | { kind: 'Repository'; databaseId: number }
  | { kind: 'Issue'; databaseId: number; number: number }
  | { kind: 'PullRequest'; databaseId: number; number: number }
  | { kind: 'IssueComment'; databaseId: number; commentId: number }
  | { kind: 'User'; userId: number };

export function repositoryGlobalId(repo: Repo): string {
  return b64urlEncode(`Repository:${repo.databaseId}`);
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return b64urlEncode(`Issue:${repo.databaseId}:${issue.number}`);
}

export function pullGlobalId(repo: Repo, pull: PullRequest): string {
  return b64urlEncode(`PullRequest:${repo.databaseId}:${pull.number}`);
}

export function commentGlobalId(repo: Repo, comment: Comment): string {
  return b64urlEncode(`IssueComment:${repo.databaseId}:${comment.id}`);
}

export function userGlobalId(): string {
  return b64urlEncode('User:1000');
}

/** Decode a global id, or null when it is not one of the forge's. */
export function decodeGlobalId(id: string): GlobalId | null {
  const text = b64urlDecode(id);
  if (text === null) return null;
  const parts = text.split(':');
  const kind = parts[0];
  const num = (value: string | undefined): number | null => {
    if (value === undefined || !/^\d+$/.test(value)) return null;
    return Number(value);
  };
  if (kind === 'Repository' && parts.length === 2) {
    const databaseId = num(parts[1]);
    return databaseId === null ? null : { kind, databaseId };
  }
  if (kind === 'Issue' && parts.length === 3) {
    const databaseId = num(parts[1]);
    const number = num(parts[2]);
    return databaseId === null || number === null ? null : { kind, databaseId, number };
  }
  if (kind === 'PullRequest' && parts.length === 3) {
    const databaseId = num(parts[1]);
    const number = num(parts[2]);
    return databaseId === null || number === null ? null : { kind, databaseId, number };
  }
  if (kind === 'IssueComment' && parts.length === 3) {
    const databaseId = num(parts[1]);
    const commentId = num(parts[2]);
    return databaseId === null || commentId === null ? null : { kind, databaseId, commentId };
  }
  if (kind === 'User' && parts.length === 2) {
    const userId = num(parts[1]);
    return userId === null ? null : { kind, userId };
  }
  return null;
}

/** Find a repository by its numeric database id. */
export function repoByDatabaseId(store: Store, databaseId: number): Repo | undefined {
  for (const repo of store.repos.values()) {
    if (repo.databaseId === databaseId) return repo;
  }
  return undefined;
}

/** The viewer is the only user the forge knows; every repository belongs to this login. */
export function isViewerOwner(owner: string): boolean {
  return owner === VIEWER_LOGIN;
}
