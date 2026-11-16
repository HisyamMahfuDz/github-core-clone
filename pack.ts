// The git wire codecs: pkt-line framing and packfiles. The pack writer emits plain
// (undelted) objects only — the suite judges deltas only "when the server sends them",
// and an undelted pack is always valid. The pack reader resolves REF_DELTA and
// OFS_DELTA entries, so pushes carrying deltas still unpack.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { hashObject, type GitObject, type GitObjectType, type ObjectLookup } from './gitobj.ts';

// ---------------------------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------------------------

/** The largest pkt-line, including its 4-byte length header. */
export const PKT_LINE_MAX = 65520;

export type GitPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Encode one data packet: a 4-hex length (including the header) plus the payload. */
export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  if (length > PKT_LINE_MAX) throw new Error(`pkt-line payload of ${data.length} bytes exceeds the limit`);
  const header = length.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(header, 'ascii'), data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/** Encode a list of text lines / control packets into one pkt-line stream. */
export function encodePktLines(lines: readonly (string | 'flush' | 'delim' | 'response-end')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(PKT_FLUSH);
    else if (line === 'delim') parts.push(PKT_DELIM);
    else if (line === 'response-end') parts.push(PKT_RESPONSE_END);
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

export interface DecodedPktLines {
  readonly packets: GitPacket[];
  /** Offset just past the last packet consumed (the start of the trailing raw bytes, e.g. a pack). */
  readonly consumed: number;
}

/**
 * Decode pkt-lines from the start of `buffer` until the first flush packet (inclusive) or
 * the buffer's end. Throws on a malformed length header. Used for request bodies, where a
 * pack may follow the flush: `consumed` marks where the pack starts.
 */
export function decodePktLinesUntilFlush(buffer: Buffer): DecodedPktLines {
  const packets: GitPacket[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`malformed pkt-line header ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      break;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) throw new Error('pkt-line length out of range');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, consumed: offset };
}

/** Decode every pkt-line in a buffer (no trailing raw bytes expected). */
export function decodeAllPktLines(buffer: Buffer): GitPacket[] {
  const packets: GitPacket[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const { packets: chunk, consumed } = decodePktLinesUntilFlush(buffer.subarray(offset));
    packets.push(...chunk);
    if (consumed === 0) break;
    offset += consumed;
    if (chunk.length > 0 && chunk[chunk.length - 1]?.kind === 'flush' && offset >= buffer.length) break;
    if (chunk.length === 0) break;
  }
  return packets;
}

/** The data payloads of a packet list, as UTF-8 lines without their trailing newline. */
export function packetLines(packets: readonly GitPacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

/**
 * Wrap raw bytes in sideband packets: each packet carries a band byte (1 = data, 2 =
 * progress, 3 = error) plus up to 65515 payload bytes, framed as pkt-lines.
 */
export function sidebandEncode(band: 1 | 2 | 3, data: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = PKT_LINE_MAX - 5; // 4-byte header + 1 band byte
  if (data.length === 0) {
    parts.push(pktLine(Buffer.from([band])));
    return Buffer.concat(parts);
  }
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const slice = data.subarray(offset, Math.min(data.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([band]), slice])));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------------------------

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Encode one object's pack header: the type/size varint. */
function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile v2 from plain objects (no deltas), deduplicated by id. Trailer included. */
const DEFLATE_CACHE_LIMIT = 50_000;
const deflateCache = new Map<string, Buffer>();

function deflatedBytes(object: GitObject, oid: string): Buffer {
  const cached = deflateCache.get(oid);
  if (cached !== undefined) return cached;
  const compressed = deflateSync(object.data);
  if (deflateCache.size >= DEFLATE_CACHE_LIMIT) deflateCache.clear();
  deflateCache.set(oid, compressed);
  return compressed;
}

export function writePack(objects: Iterable<GitObject>): Buffer {
  const seen = new Set<string>();
  const list: GitObject[] = [];
  const oids: string[] = [];
  for (const object of objects) {
    const oid = hashObject(object.type, object.data);
    if (seen.has(oid)) continue;
    seen.add(oid);
    list.push(object);
    oids.push(oid);
  }
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (let i = 0; i < list.length; i++) {
    const object = list[i]!;
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflatedBytes(object, oids[i]!));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Whether a pack's trailer matches its bytes. */
export function verifyPackChecksum(pack: Buffer): boolean {
  if (pack.length < 32) return false;
  const expected = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  return pack.subarray(pack.length - 20).toString('hex') === expected;
}

export interface ReadPackResult {
  readonly objects: Map<string, GitObject>;
  readonly declaredCount: number;
  readonly deltaCount: number;
  readonly checksumOk: boolean;
}

interface PackEntry {
  readonly offset: number;
  readonly typeCode: number;
  readonly size: number;
  readonly dataStart: number;
  readonly dataEnd: number;
  readonly inflated: Buffer;
  readonly baseOffset?: number;
  readonly baseOid?: string;
}

/** Read the type/size varint at `offset`; returns the code, size and next offset. */
function readPackEntryHeader(pack: Buffer, offset: number): { typeCode: number; size: number; next: number } {
  let pos = offset;
  let byte = pack[pos]!;
  const typeCode = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  pos += 1;
  while ((byte & 0x80) !== 0) {
    byte = pack[pos]!;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    pos += 1;
  }
  return { typeCode, size, next: pos };
}

/** Apply a git delta to a base buffer, producing the reconstructed object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (pos >= delta.length) throw new Error('delta varint is truncated');
      const byte = delta[pos]!;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  if (baseSize !== base.length) throw new Error(`delta base size ${baseSize} does not match ${base.length}`);
  const chunks: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos]!;
    pos += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          if (pos >= delta.length) throw new Error('delta copy offset is truncated');
          offset |= delta[pos]! << (8 * i);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          if (pos >= delta.length) throw new Error('delta copy size is truncated');
          size |= delta[pos]! << (8 * i);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy runs past the base');
      chunks.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      if (pos + op > delta.length) throw new Error('delta insert runs past the delta');
      chunks.push(delta.subarray(pos, pos + op));
      pos += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(chunks);
  if (produced !== resultSize || result.length !== resultSize) throw new Error('delta result size mismatch');
  return result;
}

/**
 * Parse a packfile, resolving deltas against earlier entries in the same pack and,
 * for REF_DELTA, against `resolveBase` (the repository's objects). Throws on any
 * structural problem; the caller turns that into an unpack error.
 */
export function readPack(pack: Buffer, options: { resolveBase?: ObjectLookup } = {}): ReadPackResult {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack has no PACK signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version} is not supported`);
  const declaredCount = pack.readUInt32BE(8);
  const checksumOk = verifyPackChecksum(pack);
  const trailerStart = pack.length - 20;
  const entries: PackEntry[] = [];
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    if (offset >= trailerStart) throw new Error('pack ends before its declared object count');
    const start = offset;
    const header = readPackEntryHeader(pack, offset);
    offset = header.next;
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (header.typeCode === 6) {
      // OFS_DELTA: a negative offset varint back to the base entry.
      if (offset >= trailerStart) throw new Error('OFS_DELTA base offset is truncated');
      let byte = pack[offset]!;
      offset += 1;
      let base = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        if (offset >= trailerStart) throw new Error('OFS_DELTA base offset is truncated');
        byte = pack[offset]!;
        offset += 1;
        base = ((base + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = start - base;
      if (baseOffset < 12) throw new Error('OFS_DELTA base offset points before the pack entries');
    } else if (header.typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('REF_DELTA base id is truncated');
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    // The zlib stream's end is found by inflating with a trailing-garbage-tolerant loop:
    // inflate incrementally until the output reaches the declared size.
    const dataStart = offset;
    const inflated = inflateWithEnd(pack, dataStart, header.size, trailerStart);
    offset = inflated.end;
    entries.push({ offset: start, typeCode: header.typeCode, size: header.size, dataStart, dataEnd: offset, inflated: inflated.data, baseOffset, baseOid });
  }
  if (offset !== trailerStart) throw new Error('pack entries do not end at the trailer');

  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let deltaCount = 0;
  const resolveEntry = (entry: PackEntry, chain: Set<number>): GitObject => {
    const cached = byOffset.get(entry.offset);
    if (cached !== undefined) return cached;
    if (chain.has(entry.offset)) throw new Error('delta chain is cyclic');
    chain.add(entry.offset);
    const raw = entry.inflated;
    if (raw.length !== entry.size) throw new Error('inflated object size does not match its header');
    let resolved: GitObject;
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      deltaCount += 1;
      let base: GitObject | undefined;
      if (entry.typeCode === 6) {
        const baseEntry = entries.find((candidate) => candidate.offset === entry.baseOffset);
        if (baseEntry === undefined) throw new Error('OFS_DELTA names an unknown base offset');
        base = resolveEntry(baseEntry, chain);
      } else {
        base = options.resolveBase?.(entry.baseOid!);
        if (base === undefined) {
          // A REF_DELTA whose base is also in this pack: find it by id.
          for (const candidate of entries) {
            if (candidate.offset === entry.offset) continue;
            const resolvedCandidate = byOffset.get(candidate.offset);
            if (resolvedCandidate !== undefined && hashObject(resolvedCandidate.type, resolvedCandidate.data) === entry.baseOid) {
              base = resolvedCandidate;
              break;
            }
          }
          if (base === undefined) {
            for (const candidate of entries) {
              if (candidate.offset === entry.offset || candidate.typeCode === 6 || candidate.typeCode === 7) continue;
              const plain = resolveEntry(candidate, new Set(chain));
              if (hashObject(plain.type, plain.data) === entry.baseOid) {
                base = plain;
                break;
              }
            }
          }
        }
        if (base === undefined) throw new Error(`REF_DELTA base ${entry.baseOid} is not available`);
      }
      resolved = { type: base.type, data: applyDelta(base.data, raw) };
    } else {
      const type = CODE_TYPE[entry.typeCode];
      if (type === undefined) throw new Error(`unknown pack object type code ${entry.typeCode}`);
      resolved = { type, data: raw };
    }
    chain.delete(entry.offset);
    byOffset.set(entry.offset, resolved);
    objects.set(hashObject(resolved.type, resolved.data), resolved);
    return resolved;
  };
  for (const entry of entries) resolveEntry(entry, new Set());
  return { objects, declaredCount, deltaCount, checksumOk };
}

/**
 * Find the end of the zlib stream starting at `start`: the smallest window that
 * inflates to exactly `expectedSize` bytes. Node's inflateSync throws on a
/** Adler-32, the checksum a zlib stream ends with. Computed in 5552-byte blocks. */
function adler32(data: Buffer): number {
  const MOD = 65521;
  let a = 1;
  let b = 0;
  let pos = 0;
  while (pos < data.length) {
    const end = Math.min(pos + 5552, data.length);
    for (; pos < end; pos++) {
      a += data[pos]!;
      b += a;
    }
    a %= MOD;
    b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Find where the zlib stream starting at `start` ends, and return its inflated
 * bytes. `inflateSync` ignores trailing garbage, so one inflation of the
 * remainder yields this stream's output; the stream ends with the Adler-32 of
 * that output, so a native scan for the checksum finds the end, verified by
 * one more inflation of the candidate prefix. This replaces a binary search
 * that re-inflated the prefix ~log2(n) times. The stream must end at or
 * before `limit`.
 */
function inflateWithEnd(
  pack: Buffer,
  start: number,
  expectedSize: number,
  limit: number,
): { end: number; data: Buffer } {
  const remainder = pack.subarray(start, limit);
  let inflated: Buffer;
  try {
    inflated = inflateSync(remainder);
  } catch {
    throw new Error('could not inflate a pack object');
  }
  if (inflated.length !== expectedSize) throw new Error('could not inflate a pack object');
  const needle = Buffer.allocUnsafe(4);
  needle.writeUInt32BE(adler32(inflated), 0);
  let searchFrom = 2;
  for (;;) {
    const pos = remainder.indexOf(needle, searchFrom);
    if (pos === -1 || pos + 4 > remainder.length) break;
    const end = pos + 4;
    try {
      const probe = inflateSync(remainder.subarray(0, end));
      if (probe.length === expectedSize && probe.equals(inflated)) {
        return { end: start + end, data: inflated };
      }
    } catch {
      // A spurious checksum match inside the deflate data: keep scanning.
    }
    searchFrom = pos + 1;
  }
  // Defensive fallback: binary search for the smallest window that inflates
  // to the declared size (monotonic in the window end).
  const inflatesToSize = (end: number): boolean => {
    try {
      return inflateSync(pack.subarray(start, end)).length === expectedSize;
    } catch {
      return false;
    }
  };
  if (!inflatesToSize(limit)) throw new Error('could not inflate a pack object');
  let lo = start + 1;
  let hi = limit;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (inflatesToSize(mid)) hi = mid;
    else lo = mid;
  }
  return { end: hi, data: inflated };
}
