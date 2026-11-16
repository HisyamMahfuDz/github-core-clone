// The git object model: SHA-1 ids, commit/tree/tag codecs, tree flattening,
// reachability walks, merge-base and diffs. Written from the git object format
// (object id = SHA-1 over "<type> <size>\0" + bytes).

import { createHash } from 'node:crypto';
import { forgeIdentLine } from './util.ts';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export type ObjectLookup = (oid: string) => GitObject | undefined;

/** The object id of a (type, bytes) pair. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

// ---------------------------------------------------------------------------------------------
// commits
// ---------------------------------------------------------------------------------------------

export interface ParsedCommit {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

/** Parse a commit object's headers and message. Throws on a malformed object. */
export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  if (tree === '') throw new Error('commit object has no tree header');
  return { tree, parents, author, committer, message };
}

/** Build a commit object's bytes. The message is stored with a trailing newline, git's convention. */
export function buildCommit(input: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author}`);
  lines.push(`committer ${input.committer}`);
  const message = input.message.endsWith('\n') ? input.message : `${input.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

/** A commit object authored by the forge (contents API, squash merge). */
export function buildForgeCommit(tree: string, parents: readonly string[], message: string): Buffer {
  const ident = forgeIdentLine();
  return buildCommit({ tree, parents, author: ident, committer: ident, message });
}

/** The message a commit object carries, with git's single trailing newline stripped for display. */
export function displayMessage(message: string): string {
  return message.endsWith('\n') ? message.slice(0, -1) : message;
}

/** Split an ident line ("Name <email> epoch tz") into its display parts. */
export function parseIdent(line: string): { name: string; email: string; epoch: number; tz: string } {
  const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', epoch: 0, tz: '+0000' };
  return { name: match[1] ?? '', email: match[2] ?? '', epoch: Number(match[3]), tz: match[4] ?? '+0000' };
}

// ---------------------------------------------------------------------------------------------
// trees
// ---------------------------------------------------------------------------------------------

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object's entries: "<mode ascii> <name>\0<20-byte oid>", in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode/name separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree sort: entries ordered by name, directory names compared with a trailing '/'. */
export function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const aKey = a.mode === '40000' ? `${a.name}/` : a.name;
  const bKey = b.mode === '40000' ? `${b.name}/` : b.name;
  if (aKey < bKey) return -1;
  if (aKey > bKey) return 1;
  return 0;
}

/** Build a tree object's bytes from entries (sorted by git's rule). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** A flat path -> {oid, mode} view of a tree, recursing into subtrees. */
export function flattenTree(
  rootOid: string,
  lookup: ObjectLookup,
  out: Map<string, { oid: string; mode: string }> = new Map(),
  prefix = '',
): Map<string, { oid: string; mode: string }> {
  const object = lookup(rootOid);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(entry.oid, lookup, out, path);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** The empty tree's id (the SHA-1 of a zero-byte tree object). */
export const EMPTY_TREE_OID = hashObject('tree', Buffer.alloc(0));

/**
 * Build the tree that results from setting (or deleting) one path in a tree, creating
 * intermediate subtrees as needed. Returns the new root tree id, storing new objects
 * through `put`. `value` null deletes the path.
 */
export function treeWithPath(
  rootOid: string | null,
  lookup: ObjectLookup,
  put: (type: GitObjectType, data: Buffer) => string,
  path: string,
  value: { oid: string; mode: string } | null,
): string {
  const segments = path.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) return rootOid ?? EMPTY_TREE_OID;
  const build = (treeOid: string | null, depth: number): string | null => {
    const entries = new Map<string, TreeEntry>();
    if (treeOid !== null) {
      const object = lookup(treeOid);
      if (object !== undefined && object.type === 'tree') {
        for (const entry of parseTree(object.data)) entries.set(entry.name, entry);
      }
    }
    const name = segments[depth]!;
    if (depth === segments.length - 1) {
      if (value === null) entries.delete(name);
      else entries.set(name, { mode: value.mode, name, oid: value.oid });
    } else {
      const child = entries.get(name);
      const childOid = child !== undefined && child.mode === '40000' ? child.oid : null;
      const next = build(childOid, depth + 1);
      if (next === null) entries.delete(name);
      else entries.set(name, { mode: '40000', name, oid: next });
    }
    if (entries.size === 0) return null;
    return put('tree', buildTree([...entries.values()]));
  };
  return build(rootOid, 0) ?? EMPTY_TREE_OID;
}

/** Resolve a path inside a tree: the entry it names, or null. Directories resolve to their tree entry. */
export function resolveTreePath(
  rootOid: string,
  lookup: ObjectLookup,
  path: string,
): { entry: TreeEntry; isDir: boolean } | null {
  const segments = path.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) return { entry: { mode: '40000', name: '', oid: rootOid }, isDir: true };
  let currentOid = rootOid;
  for (let index = 0; index < segments.length; index += 1) {
    const object = lookup(currentOid);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
    if (entry === undefined) return null;
    if (index === segments.length - 1) return { entry, isDir: entry.mode === '40000' };
    if (entry.mode !== '40000') return null;
    currentOid = entry.oid;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// tags
// ---------------------------------------------------------------------------------------------

export interface ParsedTag {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** Parse a tag object's headers and message. */
export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let object = '';
  let type: GitObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as GitObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** Peel tags recursively until a non-tag object id. Returns the input when it is not a tag. */
export function peelToNonTag(oid: string, lookup: ObjectLookup): string {
  const seen = new Set<string>();
  let current = oid;
  for (;;) {
    if (seen.has(current)) return current;
    seen.add(current);
    const object = lookup(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
}

// ---------------------------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------------------------

/**
 * The closure of `tips`: every object reachable from them (commits, their trees and blobs,
 * tags and their targets). `allowMissing` skips tips the store does not hold.
 */
export function collectReachable(
  tips: Iterable<string>,
  lookup: ObjectLookup,
  options: { allowMissing?: boolean } = {},
): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) {
      if (options.allowMissing === true) continue;
      throw new Error(`missing object ${oid}`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree, ...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/**
 * The closure of `tips` cut at `stopCommits`: the walk descends from a tip through its
 * commit parents, but never past a commit in `stopCommits` (the commit itself and its full
 * tree closure are included; its parents are not). Used for fetch exclusion with shallow
 * boundaries: the client holds the boundary commit but not its history.
 */
export function collectReachableCut(
  tips: Iterable<string>,
  stopCommits: ReadonlySet<string>,
  lookup: ObjectLookup,
): Set<string> {
  const seen = new Set<string>();
  const visitTree = (oid: string): void => {
    if (seen.has(oid)) return;
    const object = lookup(oid);
    if (object === undefined) return;
    seen.add(oid);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) visitTree(entry.oid);
    }
  };
  const stack: string[] = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      visitTree(commit.tree);
      if (!stopCommits.has(oid)) stack.push(...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) visitTree(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

export interface DepthWalk {
  /** Every object in the depth-limited closure (commits, trees, blobs, tags). */
  readonly objects: Set<string>;
  /** Commits at the depth cutoff whose parents were excluded: the new shallow boundary. */
  readonly boundary: string[];
}

/**
 * Walk `tips` to `depth` commit generations (depth 1 = the tips only), collecting the full
 * tree closure of every included commit. Tags peel at the same generation as the tag itself.
 */
export function collectDepthLimited(tips: Iterable<string>, depth: number, lookup: ObjectLookup): DepthWalk {
  const objects = new Set<string>();
  const boundary: string[] = [];
  const commitDistance = new Map<string, number>();
  const queue: Array<{ oid: string; distance: number }> = [];
  const visitTree = (oid: string): void => {
    if (objects.has(oid)) return;
    const object = lookup(oid);
    if (object === undefined) return;
    objects.add(oid);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) visitTree(entry.oid);
    }
  };
  for (const tip of tips) queue.push({ oid: tip, distance: 0 });
  while (queue.length > 0) {
    const { oid, distance } = queue.shift()!;
    const object = lookup(oid);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      objects.add(oid);
      queue.push({ oid: parseTag(object.data).object, distance });
      continue;
    }
    if (object.type !== 'commit') {
      visitTree(oid);
      continue;
    }
    const known = commitDistance.get(oid);
    if (known !== undefined && known <= distance) continue;
    commitDistance.set(oid, distance);
    objects.add(oid);
    const commit = parseCommit(object.data);
    visitTree(commit.tree);
    if (distance + 1 < depth) {
      for (const parent of commit.parents) queue.push({ oid: parent, distance: distance + 1 });
    } else if (commit.parents.length > 0) {
      boundary.push(oid);
    }
  }
  return { objects, boundary };
}

/** Whether `ancestor` is reachable from `tip` following commit parents (peeling tags). */
export function isAncestor(ancestor: string, tip: string, lookup: ObjectLookup): boolean {
  const start = peelToNonTag(tip, lookup);
  const target = peelToNonTag(ancestor, lookup);
  if (start === target) return true;
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === target) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    stack.push(...parseCommit(object.data).parents);
  }
  return false;
}

/**
 * The merge-base of two tips: the common ancestor nearest to `b` (a breadth-first walk
 * from `b` meeting the ancestor set of `a`). Exact for the linear histories the suite
 * builds; a reasonable nearest common ancestor otherwise. Null when unrelated.
 */
export function mergeBase(a: string, b: string, lookup: ObjectLookup): string | null {
  const aPeeled = peelToNonTag(a, lookup);
  const bPeeled = peelToNonTag(b, lookup);
  const ancestorsOfA = new Set<string>();
  const stack = [aPeeled];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (ancestorsOfA.has(oid)) continue;
    ancestorsOfA.add(oid);
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    stack.push(...parseCommit(object.data).parents);
  }
  const seen = new Set<string>();
  const queue = [bPeeled];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (ancestorsOfA.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    queue.push(...parseCommit(object.data).parents);
  }
  return null;
}

/** Commits reachable from `tip`, newest first (depth-first pre-order, parents in order). */
export function commitHistory(tip: string, lookup: ObjectLookup, limit = 10000): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const visit = (oid: string): void => {
    if (seen.has(oid) || order.length >= limit) return;
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') return;
    seen.add(oid);
    order.push(oid);
    for (const parent of parseCommit(object.data).parents) visit(parent);
  };
  visit(peelToNonTag(tip, lookup));
  return order;
}

// ---------------------------------------------------------------------------------------------
// diffs
// ---------------------------------------------------------------------------------------------

export interface FileChange {
  readonly path: string;
  readonly status: 'added' | 'removed' | 'modified';
  readonly oldOid: string | null;
  readonly newOid: string | null;
  readonly additions: number;
  readonly deletions: number;
}

/** Split bytes into lines for diffing (a trailing newline does not make an empty last line). */
export function splitLines(data: Buffer): string[] {
  if (data.length === 0) return [];
  const text = data.toString('utf8');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line counts of a change, via longest-common-subsequence DP (files here are small). */
export function lineDiffCounts(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  if (oldData === null && newData === null) return { additions: 0, deletions: 0 };
  if (oldData === null) return { additions: splitLines(newData!).length, deletions: 0 };
  if (newData === null) return { additions: 0, deletions: splitLines(oldData).length };
  const a = splitLines(oldData);
  const b = splitLines(newData);
  if (a.length > 2000 || b.length > 2000) return { additions: b.length, deletions: a.length };
  let previous = new Array<number>(b.length + 1).fill(0);
  let current = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = a[i - 1] === b[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    }
    const swap = previous;
    previous = current;
    current = swap;
    current.fill(0);
  }
  const common = previous[b.length] ?? 0;
  return { additions: b.length - common, deletions: a.length - common };
}

/** The file-level diff between two trees (null = the empty tree). */
export function diffTrees(
  oldRoot: string | null,
  newRoot: string | null,
  lookup: ObjectLookup,
): FileChange[] {
  const oldFlat = oldRoot === null ? new Map() : flattenTree(oldRoot, lookup);
  const newFlat = newRoot === null ? new Map() : flattenTree(newRoot, lookup);
  const paths = new Set([...oldFlat.keys(), ...newFlat.keys()]);
  const changes: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const oldEntry = oldFlat.get(path);
    const newEntry = newFlat.get(path);
    if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid === newEntry.oid) continue;
    const oldData = oldEntry === undefined ? null : (lookup(oldEntry.oid)?.data ?? null);
    const newData = newEntry === undefined ? null : (lookup(newEntry.oid)?.data ?? null);
    const counts = lineDiffCounts(oldData, newData);
    changes.push({
      path,
      status: oldEntry === undefined ? 'added' : newEntry === undefined ? 'removed' : 'modified',
      oldOid: oldEntry?.oid ?? null,
      newOid: newEntry?.oid ?? null,
      additions: counts.additions,
      deletions: counts.deletions,
    });
  }
  return changes;
}
