// Domain operations shared by the REST, GraphQL and MCP surfaces: ref resolution,
// the contents API's commits, the commit list, pull-request files, mergeability and
// the squash merge. All git state lives in the store's per-repo object maps.

import {
  buildForgeCommit,
  commitHistory,
  diffTrees,
  displayMessage,
  EMPTY_TREE_OID,
  flattenTree,
  mergeBase,
  parseCommit,
  parseIdent,
  peelToNonTag,
  resolveTreePath,
  treeWithPath,
  type FileChange,
} from './gitobj.ts';
import { lookupOf, putObject, type PullRequest, type Repo } from './store.ts';
import { forgeTimestamp, isOid, ZERO_OID } from './util.ts';

// ---------------------------------------------------------------------------------------------
// refs
// ---------------------------------------------------------------------------------------------

/** The tip a branch name resolves to, or null when the branch does not exist. */
export function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** The tip a ref-ish resolves to: a branch name, a full ref, or a 40-hex object id. */
export function resolveRef(repo: Repo, ref: string): string | null {
  if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
  const branch = branchTip(repo, ref);
  if (branch !== null) return branch;
  if (isOid(ref) && repo.objects.has(ref)) return ref;
  if (ref === 'HEAD') return branchTip(repo, repo.defaultBranch);
  return null;
}

/** Branch names in creation order (ref insertion order). */
export function branchNames(repo: Repo): string[] {
  const names: string[] = [];
  for (const ref of repo.refs.keys()) {
    if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
  }
  return names;
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

export interface ContentsWrite {
  readonly commitSha: string;
  readonly blobSha: string;
  readonly created: boolean;
}

export class ForgeError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ForgeError';
    this.status = status;
  }
}

/**
 * Write a file through the contents API: create or update `path` on `branch` with
 * `content`, committing with `message`. `sha` is the caller's expected current blob
 * id: a mismatch is 409, a missing sha on an existing path is 422. An unknown branch
 * is created from the default branch's tip first. Returns the commit and blob ids.
 */
export function writeContents(
  repo: Repo,
  path: string,
  content: Buffer,
  message: string,
  branch: string,
  sha: string | undefined,
): ContentsWrite {
  const lookup = lookupOf(repo);
  let tip = branchTip(repo, branch);
  if (tip === null) {
    const base = branchTip(repo, repo.defaultBranch);
    if (base !== null) {
      repo.refs.set(`refs/heads/${branch}`, base);
      tip = base;
    }
  }
  const rootTree = tip === null ? EMPTY_TREE_OID : parseCommit(repo.objects.get(peelToNonTag(tip, lookup))!.data).tree;
  const existing = tip === null ? null : resolveTreePath(rootTree, lookup, path);
  if (existing !== null && existing.isDir) {
    throw new ForgeError(422, `cannot write a file over the directory ${path}`);
  }
  const blobSha = putObject(repo, 'blob', content);
  if (existing !== null) {
    if (sha === undefined) {
      throw new ForgeError(422, 'sha must be supplied when updating an existing file');
    }
    if (sha.toLowerCase() !== existing.entry.oid.toLowerCase()) {
      throw new ForgeError(409, `sha ${sha} does not match the current blob ${existing.entry.oid} at ${path}`);
    }
  }
  const newTree = treeWithPath(rootTree, lookup, (type, data) => putObject(repo, type, data), path, {
    oid: blobSha,
    mode: '100644',
  });
  const parents = tip === null ? [] : [peelToNonTag(tip, lookup)];
  const commitSha = putObject(repo, 'commit', buildForgeCommit(newTree, parents, message));
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  return { commitSha, blobSha, created: existing === null };
}

/**
 * Delete a file through the contents API: remove `path` from `branch`, committing
 * with `message`. A supplied `sha` that mismatches the current blob is 409.
 */
export function deleteContents(repo: Repo, path: string, message: string, branch: string, sha: string | undefined): string {
  const lookup = lookupOf(repo);
  const tip = branchTip(repo, branch);
  if (tip === null) throw new ForgeError(404, `branch ${branch} does not exist`);
  const commit = parseCommit(repo.objects.get(peelToNonTag(tip, lookup))!.data);
  const existing = resolveTreePath(commit.tree, lookup, path);
  if (existing === null || existing.isDir) throw new ForgeError(404, `${path} does not exist on ${branch}`);
  if (sha !== undefined && sha.toLowerCase() !== existing.entry.oid.toLowerCase()) {
    throw new ForgeError(409, `sha ${sha} does not match the current blob ${existing.entry.oid} at ${path}`);
  }
  const newTree = treeWithPath(commit.tree, lookup, (type, data) => putObject(repo, type, data), path, null);
  const commitSha = putObject(repo, 'commit', buildForgeCommit(newTree, [peelToNonTag(tip, lookup)], message));
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  return commitSha;
}

// ---------------------------------------------------------------------------------------------
// commits
// ---------------------------------------------------------------------------------------------

export interface CommitView {
  readonly sha: string;
  readonly message: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authorEpoch: number;
  readonly committerName: string;
  readonly committerEmail: string;
  readonly committerEpoch: number;
  readonly tree: string;
  readonly parents: readonly string[];
}

/** The commit list for a ref: reachable commits, newest first. */
export function listCommits(repo: Repo, ref: string): CommitView[] {
  const lookup = lookupOf(repo);
  const tip = resolveRef(repo, ref);
  if (tip === null) throw new ForgeError(404, `ref ${ref} does not exist`);
  const views: CommitView[] = [];
  for (const oid of commitHistory(tip, lookup)) {
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    const parsed = parseCommit(object.data);
    const author = parseIdent(parsed.author);
    const committer = parseIdent(parsed.committer);
    views.push({
      sha: oid,
      message: displayMessage(parsed.message),
      authorName: author.name,
      authorEmail: author.email,
      authorEpoch: author.epoch,
      committerName: committer.name,
      committerEmail: committer.email,
      committerEpoch: committer.epoch,
      tree: parsed.tree,
      parents: parsed.parents,
    });
  }
  return views;
}

// ---------------------------------------------------------------------------------------------
// pull requests: files, mergeability, squash merge
// ---------------------------------------------------------------------------------------------

export interface PullTips {
  readonly headTip: string;
  readonly baseTip: string;
  readonly mergeBase: string | null;
}

/** Resolve a pull request's live tips and their merge-base. Null when a branch is gone. */
export function pullTips(repo: Repo, pull: PullRequest): PullTips | null {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return null;
  const lookup = lookupOf(repo);
  return { headTip, baseTip, mergeBase: mergeBase(headTip, baseTip, lookup) };
}

/** The tree id a tip points at (peeling tags), or the empty tree when unresolvable. */
function treeOf(repo: Repo, tip: string | null): string {
  if (tip === null) return EMPTY_TREE_OID;
  const lookup = lookupOf(repo);
  const object = repo.objects.get(peelToNonTag(tip, lookup));
  if (object === undefined || object.type !== 'commit') return EMPTY_TREE_OID;
  return parseCommit(object.data).tree;
}

/** A pull request's changed files: the merge-base tree versus the head tree. */
export function pullFiles(repo: Repo, pull: PullRequest): FileChange[] {
  const tips = pullTips(repo, pull);
  const lookup = lookupOf(repo);
  if (tips === null) {
    // A branch was deleted: fall back to the creation-time shas.
    return diffTrees(treeOf(repo, pull.baseShaAtCreation), treeOf(repo, pull.headShaAtCreation), lookup);
  }
  return diffTrees(treeOf(repo, tips.mergeBase), treeOf(repo, tips.headTip), lookup);
}

/**
 * Whether a pull request's head can merge into its base cleanly: a three-way merge
 * over the merge-base tree. A path changed on both sides to different blobs (or
 * changed on one side and deleted on the other) conflicts.
 */
export function pullMergeable(repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  const tips = pullTips(repo, pull);
  if (tips === null) return 'UNKNOWN';
  return mergeConflict(repo, tips) === null ? 'MERGEABLE' : 'CONFLICTING';
}

/**
 * The first conflicting path of a three-way merge, or null when the merge is clean.
 * A path conflicts when the merge-base version differs from both sides' versions and
 * the two sides disagree (including add/add and modify/delete).
 */
export function mergeConflict(repo: Repo, tips: PullTips): string | null {
  const lookup = lookupOf(repo);
  const baseFlat = tips.mergeBase === null ? new Map() : flattenTree(treeOf(repo, tips.mergeBase), lookup);
  const headFlat = flattenTree(treeOf(repo, tips.headTip), lookup);
  const targetFlat = flattenTree(treeOf(repo, tips.baseTip), lookup);
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys(), ...targetFlat.keys()]);
  for (const path of paths) {
    const base = baseFlat.get(path)?.oid ?? null;
    const head = headFlat.get(path)?.oid ?? null;
    const target = targetFlat.get(path)?.oid ?? null;
    const headChanged = head !== base;
    const targetChanged = target !== base;
    if (headChanged && targetChanged && head !== target) return path;
  }
  return null;
}

/**
 * Squash-merge a pull request: one commit on the base tip whose tree is the base
 * tree plus the head's changes over the merge-base. Updates the base ref and the
 * pull request's merged state. Throws ForgeError 405 on a conflict, 405 when the
 * pull request is already merged, 422 when a branch is missing.
 */
export function squashMerge(repo: Repo, pull: PullRequest): string {
  if (pull.merged || pull.state !== 'open') {
    throw new ForgeError(405, `pull request #${pull.number} is already ${pull.merged ? 'merged' : 'closed'}`);
  }
  const tips = pullTips(repo, pull);
  if (tips === null) throw new ForgeError(422, 'the head or base branch does not exist');
  const conflict = mergeConflict(repo, tips);
  if (conflict !== null) {
    throw new ForgeError(405, `pull request #${pull.number} has a merge conflict in ${conflict}`);
  }
  const lookup = lookupOf(repo);
  const baseFlat = tips.mergeBase === null ? new Map() : flattenTree(treeOf(repo, tips.mergeBase), lookup);
  const headFlat = flattenTree(treeOf(repo, tips.headTip), lookup);
  // Start from the base tree, apply the head's changes over the merge-base.
  let tree = treeOf(repo, tips.baseTip);
  const put = (type: 'tree' | 'blob' | 'commit' | 'tag', data: Buffer): string => putObject(repo, type, data);
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of [...paths].sort()) {
    const base = baseFlat.get(path)?.oid ?? null;
    const head = headFlat.get(path);
    const headChanged = (head?.oid ?? null) !== base;
    if (!headChanged) continue;
    if (head === undefined) {
      tree = treeWithPath(tree, lookup, put, path, null);
    } else {
      tree = treeWithPath(tree, lookup, put, path, { oid: head.oid, mode: head.mode });
    }
  }
  const commitSha = putObject(repo, 'commit', buildForgeCommit(tree, [peelToNonTag(tips.baseTip, lookup)], pull.title));
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = forgeTimestamp();
  pull.mergeCommitSha = commitSha;
  return commitSha;
}

/** Whether `oid` is an object the store holds (used to validate ref targets). */
export function objectExists(repo: Repo, oid: string): boolean {
  return oid !== ZERO_OID && repo.objects.has(oid);
}
