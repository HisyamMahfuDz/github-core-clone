// Shared constants and small helpers. Everything the forge serves is deterministic:
// no wall clock and no unseeded randomness anywhere in served data. The one timestamp the
// forge stamps on objects it creates comes from MAKEFUN_TRIAL_NOW when the trial sets it,
// else from a fixed epoch, so a live run and its replay serve byte-identical state.

/** The login the bearer token names. The trial scenario is one fixed seed, so this is a constant. */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

/** The fixed epoch (2025-01-01T00:00:00Z) every forge-created timestamp derives from. */
export const FIXED_EPOCH_SEC = 1735689600;

/** The epoch seconds the forge stamps on commits and records it creates. */
export function forgeEpochSec(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return Math.trunc(parsed);
  }
  return FIXED_EPOCH_SEC;
}

/** The ISO timestamp string for forge-created records (created_at, updated_at, merged_at). */
export function forgeTimestamp(): string {
  return new Date(forgeEpochSec() * 1000).toISOString();
}

/** The identity line for commits the forge authors (contents API, squash merges). */
export function forgeIdentity(): string {
  return `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
}

/** The author/committer line for a forge-created commit object. */
export function forgeIdentLine(): string {
  return `${forgeIdentity()} ${forgeEpochSec()} +0000`;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

const SHA40_RE = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return SHA40_RE.test(value);
}

/** Standard base64 of bytes, no line wrapping. */
export function b64encode(data: Buffer): string {
  return data.toString('base64');
}

/** Decode base64, tolerating the whitespace GitHub wraps it at. */
export function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

/** URL-safe base64 without padding, for opaque global ids. */
export function b64urlEncode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** Decode a URL-safe base64 string, or null when it is not one. */
export function b64urlDecode(text: string): string | null {
  if (typeof text !== 'string' || text === '' || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    return Buffer.from(text, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

/** Whether a value is a plain JSON object (not an array, not null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A string field of a record, or a fallback. */
export function stringField(record: Record<string, unknown>, key: string, fallback = ''): string {
  const value = record[key];
  return typeof value === 'string' ? value : fallback;
}

/** Safely decode one URI path segment; the raw segment survives a bad escape. */
export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
