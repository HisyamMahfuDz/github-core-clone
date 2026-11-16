// Git smart HTTP: the info/refs advertisements (protocol v0 and v2), the
// upload-pack fetch paths (v2 ls-refs/fetch, v0 want/have negotiation) and the
// v0 receive-pack push path with report-status. Packs are always undelted on
// the way out; pushes carrying deltas are resolved on the way in.

import {
  collectDepthLimited,
  collectReachable,
  collectReachableCut,
  isAncestor,
  parseCommit,
  parseTag,
  peelToNonTag,
  type GitObject,
} from './gitobj.ts';
import {
  decodeAllPktLines,
  decodePktLinesUntilFlush,
  encodePktLines,
  packetLines,
  PKT_FLUSH,
  pktLine,
  readPack,
  sidebandEncode,
  writePack,
} from './pack.ts';
import { lookupOf, type Repo } from './store.ts';
import { isOid, ZERO_OID } from './util.ts';

const AGENT = 'forge/1.0.0';

export interface GitResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

function gitResponse(status: number, contentType: string, body: Buffer): GitResponse {
  return { status, headers: { 'content-type': contentType }, body };
}

function textResponse(status: number, text: string): GitResponse {
  return gitResponse(status, 'text/plain; charset=utf-8', Buffer.from(text, 'utf8'));
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

function sortedRefEntries(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The peeled (non-tag) target of a ref, for `^{}` lines and ls-refs peel attributes. */
function peeledOid(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tag') return null;
  return peelToNonTag(oid, lookupOf(repo));
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:${defaultRef} multi_ack multi_ack_detailed thin-pack side-band-64k ofs-delta shallow deepen-relative agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const refs = sortedRefEntries(repo);
  const headTip = repo.refs.get(defaultRef) ?? null;
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const headOid = headTip ?? refs[0]!.oid;
    lines.push(`${headOid} HEAD\0${caps}\n`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      const peeled = peeledOid(repo, ref.oid);
      if (peeled !== null) lines.push(`${peeled} ${ref.name}^{}\n`);
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

function v2Advertisement(): Buffer {
  const lines: Array<string | 'flush'> = [
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    'flush',
  ];
  return encodePktLines(lines);
}

/** GET /info/refs for a service. `version2` is true when Git-Protocol: version=2 was sent. */
export function handleInfoRefs(repo: Repo, service: string, version2: boolean): GitResponse {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return textResponse(400, `unknown service ${service}`);
  }
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && version2) {
    return gitResponse(200, contentType, v2Advertisement());
  }
  return gitResponse(200, contentType, v0Advertisement(repo, service));
}

// ---------------------------------------------------------------------------------------------
// fetch planning (shared by v0 and v2)
// ---------------------------------------------------------------------------------------------

export interface FetchPlan {
  /** Objects to send (already minus what the client holds). */
  readonly objects: Map<string, GitObject>;
  /** New shallow boundaries to report. */
  readonly shallow: string[];
  /** Old boundaries that are no longer shallow. */
  readonly unshallow: string[];
  /** Haves the server holds (acknowledgments). */
  readonly acks: string[];
}

/** Shortest parent-edge distance from any want to each reachable boundary. Tag objects peel at the same distance as the tag itself (a want may be an annotated tag). */
function boundaryDistances(
  wants: readonly string[],
  boundaries: readonly string[],
  lookup: (oid: string) => GitObject | undefined,
): Map<string, number> {
  const wanted = new Set(boundaries);
  const distances = new Map<string, number>();
  const seen = new Set<string>();
  const queue: Array<{ oid: string; distance: number }> = wants.map((oid) => ({ oid, distance: 0 }));
  while (queue.length > 0 && distances.size < wanted.size) {
    const { oid, distance } = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (wanted.has(oid) && !distances.has(oid)) distances.set(oid, distance);
    const object = lookup(oid);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      queue.push({ oid: parseTag(object.data).object, distance });
    } else if (object.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) {
        queue.push({ oid: parent, distance: distance + 1 });
      }
    }
  }
  return distances;
}

export function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowBoundaries: readonly string[],
  depth: number | null,
  relative = false,
  includeTags = false,
): FetchPlan {
  const lookup = lookupOf(repo);
  const boundarySet = new Set(shallowBoundaries);
  // A relative deepen asks for N more levels below the client's current
  // shallow boundaries. Convert it to an absolute depth: a boundary at
  // distance d from a want sits at depth d+1, so the new depth is
  // d+1+N. Unreachable boundaries contribute nothing; with none reachable
  // the requested depth is used as-is.
  let effectiveDepth = depth;
  if (depth !== null && relative && shallowBoundaries.length > 0) {
    const distances = boundaryDistances(wants, shallowBoundaries, lookup);
    let max = 0;
    for (const distance of distances.values()) max = Math.max(max, distance + 1 + depth);
    if (max > 0) effectiveDepth = max;
  }
  let wanted: Set<string>;
  let includedCommits: Set<string>;
  let newBoundary: string[];
  if (effectiveDepth !== null) {
    const walked = collectDepthLimited(wants, effectiveDepth, lookup);
    wanted = walked.objects;
    newBoundary = walked.boundary;
    includedCommits = new Set<string>();
    for (const oid of wanted) {
      const object = lookup(oid);
      if (object !== undefined && object.type === 'commit') includedCommits.add(oid);
    }
  } else {
    wanted = collectReachable(wants, lookup, { allowMissing: true });
    newBoundary = [];
    includedCommits = new Set<string>();
    for (const oid of wanted) {
      const object = lookup(oid);
      if (object !== undefined && object.type === 'commit') includedCommits.add(oid);
    }
  }
  const newBoundarySet = new Set(newBoundary);
  const unshallow = shallowBoundaries.filter((oid) => includedCommits.has(oid) && !newBoundarySet.has(oid));
  const excluded = collectReachableCut(haves, boundarySet, lookup);
  const objects = new Map<string, GitObject>();
  for (const oid of wanted) {
    if (excluded.has(oid)) continue;
    const object = lookup(oid);
    if (object !== undefined) objects.set(oid, object);
  }
  const acks = haves.filter((oid) => repo.objects.has(oid));
  if (includeTags) {
    // Protocol v2 include-tag: also send annotated tags pointing at objects
    // already in the pack (the client needs the tag objects to resolve the
    // tag refs it learned from ls-refs).
    for (const ref of sortedRefEntries(repo)) {
      if (!ref.name.startsWith('refs/tags/')) continue;
      const chain: string[] = [];
      let current = ref.oid;
      let guard = 0;
      for (;;) {
        const object = lookup(current);
        if (object === undefined || object.type !== 'tag' || guard++ > 16) break;
        chain.push(current);
        current = parseTag(object.data).object;
      }
      if (chain.length > 0 && objects.has(current)) {
        for (const oid of chain) {
          const object = lookup(oid);
          if (object !== undefined) objects.set(oid, object);
        }
      }
    }
  }
  return { objects, shallow: newBoundary, unshallow, acks };
}

// ---------------------------------------------------------------------------------------------
// protocol v2: ls-refs and fetch
// ---------------------------------------------------------------------------------------------

interface V2Request {
  readonly command: string;
  readonly args: string[];
}

/** Split a v2 request body into its command section and argument lines. */
function parseV2Request(body: Buffer): V2Request {
  const packets = decodeAllPktLines(body);
  const lines: string[] = [];
  let seenDelim = false;
  const args: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!seenDelim) lines.push(line);
    else args.push(line);
  }
  const commandLine = lines.find((line) => line.startsWith('command='));
  if (commandLine === undefined) throw new Error('v2 request has no command line');
  return { command: commandLine.slice('command='.length), args };
}

function handleLsRefs(repo: Repo, args: readonly string[]): Buffer {
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(defaultRef) ?? null;
  const lines: Array<string | 'flush'> = [];
  if (keep('HEAD')) {
    if (headTip === null) {
      if (wantUnborn) {
        lines.push(wantSymrefs ? `unborn HEAD symref-target:${defaultRef}\n` : 'unborn HEAD\n');
      }
    } else if (wantSymrefs) {
      lines.push(`${headTip} HEAD symref-target:${defaultRef}\n`);
    } else {
      lines.push(`${headTip} HEAD\n`);
    }
  }
  for (const ref of sortedRefEntries(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (wantPeel) {
      const peeled = peeledOid(repo, ref.oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

function handleFetchV2(repo: Repo, args: readonly string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let relative = false;
  let includeTags = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
    else if (arg === 'deepen-relative') relative = true;
    else if (arg === 'include-tag') includeTags = true;
    else if (arg.startsWith('deepen ')) {
      const parsed = Number(arg.slice(7).trim());
      if (Number.isFinite(parsed) && parsed > 0) depth = Math.trunc(parsed);
    }
    // thin-pack, no-progress, ofs-delta, filter, done: accepted, no special handling
    // (the forge sends undelted packs, so thin-pack/ofs-delta change nothing).
  }
  for (const want of wants) {
    if (!isOid(want)) throw new Error(`fetch wants a bad object id ${JSON.stringify(want)}`);
  }
  const plan = planFetch(repo, wants, haves, shallow, depth, relative, includeTags);
  const parts: Buffer[] = [];
  // The acknowledgments section exists only when the client sent haves: a
  // fresh clone expects the packfile section first, and real git aborts when
  // it finds acknowledgments instead.
  if (haves.length > 0) {
    const ackLines: Array<string | 'delim'> = ['acknowledgments\n'];
    if (plan.acks.length > 0) {
      for (const ack of plan.acks) ackLines.push(`ACK ${ack}\n`);
      ackLines.push('ready\n');
    } else {
      ackLines.push('NAK\n');
    }
    ackLines.push('delim');
    parts.push(encodePktLines(ackLines));
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const infoLines: Array<string | 'delim'> = ['shallow-info\n'];
    for (const oid of plan.shallow) infoLines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) infoLines.push(`unshallow ${oid}\n`);
    infoLines.push('delim');
    parts.push(encodePktLines(infoLines));
  }
  const pack = writePack(plan.objects.values());
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandEncode(1, pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// protocol v0 fetch
// ---------------------------------------------------------------------------------------------

function handleFetchV0(repo: Repo, body: Buffer): Buffer {
  const first = decodePktLinesUntilFlush(body);
  const wantLines = packetLines(first.packets);
  const rest = body.subarray(first.consumed);
  const second = decodePktLinesUntilFlush(rest);
  const haveLines = packetLines(second.packets);
  const wants: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const line of wantLines) {
    if (line.startsWith('want ')) {
      const oid = line.slice(5, 45);
      if (isOid(oid)) wants.push(oid);
    } else if (line.startsWith('shallow ')) {
      shallow.push(line.slice(8).trim());
    } else if (line.startsWith('deepen ')) {
      const parsed = Number(line.slice(7).trim());
      if (Number.isFinite(parsed) && parsed > 0) depth = Math.trunc(parsed);
    }
  }
  const haves: string[] = [];
  let hasDone = false;
  for (const line of haveLines) {
    if (line.startsWith('have ')) {
      const oid = line.slice(5, 45);
      if (isOid(oid)) haves.push(oid);
    } else if (line === 'done') {
      hasDone = true;
    }
  }
  // deepen-relative arrives as a capability on the want line in v0, not as a
  // standalone line, so match it anywhere in the request lines.
  const relative =
    wantLines.some((line) => line.includes('deepen-relative')) ||
    haveLines.some((line) => line.includes('deepen-relative'));
  const plan = planFetch(repo, wants, haves, shallow, depth, relative);
  const parts: Buffer[] = [];
  // A request without `done` is a negotiation round, not a pack request:
  // the client reads only this round's section and then sends the next
  // request, so anything more would be left unread in the HTTP body and
  // corrupt the next round on a reused connection. A shallow probe is
  // answered with the shallow list and its terminating flush only; a
  // have-negotiation round with the ACK/NAK section only. The pack is
  // sent only once the client sends `done`.
  const shallowSection: Buffer[] = [];
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    for (const oid of plan.shallow) shallowSection.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) shallowSection.push(pktLine(`unshallow ${oid}\n`));
    shallowSection.push(PKT_FLUSH);
  }
  // With multi_ack_detailed negotiated, real upload-pack answers each known
  // have with `ACK <oid> common` and closes with one bare `ACK <last>`: the
  // bare line is what tells the client negotiation is over. Without it, one
  // bare ACK (or NAK) is the whole section.
  const detailed = wantLines.some((line) => line.includes('multi_ack_detailed'));
  const ackSection: Buffer[] = [];
  if (plan.acks.length > 0) {
    if (detailed) {
      for (const ack of plan.acks) ackSection.push(pktLine(`ACK ${ack} common\n`));
      ackSection.push(pktLine(`ACK ${plan.acks[plan.acks.length - 1]}\n`));
    } else {
      ackSection.push(pktLine(`ACK ${plan.acks[0]}\n`));
    }
  } else {
    ackSection.push(pktLine('NAK\n'));
  }
  if (!hasDone) {
    // The client reads the shallow list only when it asked for depth, and
    // the ACK section only when it sent haves. Send exactly those sections
    // and nothing more: the pack comes only after `done`.
    const round: Buffer[] = [...shallowSection];
    if (haves.length > 0) round.push(...ackSection);
    return Buffer.concat(round);
  }
  // Response order for the pack round, matching real upload-pack: the
  // shallow section first, then the ACK/NAK section, then the sideband
  // pack. A NAK before the shallow lines makes real git abort a shallow
  // fetch, so the shallow section must come first.
  parts.push(...shallowSection, ...ackSection);
  const pack = writePack(plan.objects.values());
  parts.push(sidebandEncode(1, pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** POST /git-upload-pack: v2 when Git-Protocol: version=2 was sent, else v0. */
export function handleUploadPack(repo: Repo, body: Buffer, version2: boolean): GitResponse {
  const contentType = 'application/x-git-upload-pack-result';
  try {
    let out: Buffer;
    if (version2) {
      const request = parseV2Request(body);
      if (request.command === 'ls-refs') out = handleLsRefs(repo, request.args);
      else if (request.command === 'fetch') out = handleFetchV2(repo, request.args);
      else return textResponse(400, `unknown v2 command ${request.command}`);
    } else {
      out = handleFetchV0(repo, body);
    }
    return gitResponse(200, contentType, out);
  } catch (err) {
    // A malformed request must never take the server down: answer 400 and stay up.
    const message = err instanceof Error ? err.message : String(err);
    return textResponse(400, `malformed upload-pack request: ${message}`);
  }
}

// ---------------------------------------------------------------------------------------------
// protocol v0 receive-pack (push)
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

export function handleReceivePack(repo: Repo, body: Buffer): GitResponse {
  const contentType = 'application/x-git-receive-pack-result';
  let commands: PushCommand[] = [];
  let sideband = false;
  let packBytes: Buffer = Buffer.alloc(0);
  try {
    const decoded = decodePktLinesUntilFlush(body);
    const lines = packetLines(decoded.packets);
    packBytes = body.subarray(decoded.consumed);
    let first = true;
    for (const line of lines) {
      let text = line;
      if (first) {
        first = false;
        const nul = text.indexOf('\0');
        if (nul >= 0) {
          const caps = text.slice(nul + 1);
          if (caps.split(' ').includes('side-band-64k')) sideband = true;
          text = text.slice(0, nul);
        }
      }
      const parts = text.split(' ');
      if (parts.length < 3 || !isOid(parts[0]!) || !isOid(parts[1]!)) {
        throw new Error(`malformed push command ${JSON.stringify(text.slice(0, 60))}`);
      }
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
    }
    if (commands.length === 0) throw new Error('push has no commands');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return textResponse(400, `malformed receive-pack request: ${message}`);
  }

  // Unpack first: a refused ref must still report "unpack ok", and its objects stay.
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes, { resolveBase: lookupOf(repo) });
      if (!read.checksumOk) throw new Error('pack trailer checksum mismatch');
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }

  const lookup = lookupOf(repo);
  const reports: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref) ?? ZERO_OID;
      let ok = false;
      let reason = 'non-fast-forward';
      if (command.oldOid !== current) {
        ok = false;
      } else if (command.newOid === ZERO_OID) {
        // Delete: ok (a delete of a ref that is already gone is a no-op success).
        ok = true;
      } else if (!repo.objects.has(command.newOid)) {
        ok = false;
      } else if (command.oldOid === ZERO_OID) {
        ok = true; // create
      } else if (isAncestor(command.oldOid, command.newOid, lookup)) {
        ok = true; // fast-forward
      } else {
        ok = false;
      }
      if (ok) {
        if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
        else repo.refs.set(command.ref, command.newOid);
        reports.push({ ref: command.ref, ok: true, reason: '' });
      } else {
        reports.push({ ref: command.ref, ok: false, reason });
      }
    }
  } else {
    for (const command of commands) {
      reports.push({ ref: command.ref, ok: false, reason: 'unpack error' });
    }
  }

  const reportLines: Array<string | 'flush'> = [`unpack ${unpackDetail}\n`];
  for (const report of reports) {
    reportLines.push(report.ok ? `ok ${report.ref}\n` : `ng ${report.ref} ${report.reason}\n`);
  }
  reportLines.push('flush');
  const reportStream = encodePktLines(reportLines);
  let out: Buffer;
  if (sideband) {
    out = Buffer.concat([sidebandEncode(1, reportStream), PKT_FLUSH]);
  } else {
    out = reportStream;
  }
  return gitResponse(200, contentType, out);
}
