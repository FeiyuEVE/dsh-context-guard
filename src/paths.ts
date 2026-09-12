/**
 * Archive layout: where one compaction's files land.
 *
 * The archive base directory is shared by every session whose working
 * directory resolves to it (`<cwd>/.handoff` by default), while an epoch
 * number is allocated by scanning that directory. A flat layout therefore
 * gives two concurrent sessions the same number space and, because the
 * readdir → max+1 → write sequence is unlocked, the same file name: the later
 * writer truncates the earlier archive. It also leaves `latest.txt` as a
 * single directory-level pointer that any session may overwrite.
 *
 * The session layout below removes all three problems by putting every
 * session's files under `sessions/<session dir>/`: epochs number within one
 * session ("this session's 3rd compaction"), pointers belong to exactly one
 * session, and concurrent sessions cannot collide.
 *
 * The session directory name is derived from `Session.id`, which is a branded
 * string the caller may set to anything — including values containing `/` or
 * `..`. It is therefore sanitized, and whenever sanitization changed the id a
 * short digest of the original id is appended so that two different ids can
 * never map onto one directory.
 *
 * @module dsh-context-guard/paths
 */

import { createHash } from 'node:crypto'
import path from 'node:path'

/** Subdirectory holding every session-scoped archive below one base directory. */
export const SESSIONS_DIRNAME = 'sessions'

/** How archive files are laid out below the base directory. */
export type ArchiveLayout = 'session' | 'flat'

/** Plain pointer file naming the newest raw archive in one directory. */
export const LATEST_POINTER = 'latest.txt'
/** Plain pointer file naming the newest digest in one directory. */
export const LATEST_DIGEST_POINTER = 'latest-digest.txt'

/** Characters a generated session directory name may keep verbatim. */
const UNSAFE_CHARS = /[^A-Za-z0-9._-]/g
/** Upper bound on the readable part of a session directory name. */
const MAX_SESSION_DIR_CHARS = 128

/**
 * Filesystem-safe directory name for one session id.
 *
 * Unsafe characters become `_`, the readable part is capped, and the reserved
 * names `.`/`..`/empty resolve to `session`. When any of that changed the id,
 * `-<sha256[0..8]>` is appended so distinct ids stay distinct.
 *
 * @param sessionId - the raw `Session.id` string.
 * @returns a name safe to join under a base directory.
 */
export function sessionDirName(sessionId: string): string {
  const raw = String(sessionId)
  const safe = raw.replace(UNSAFE_CHARS, '_').slice(0, MAX_SESSION_DIR_CHARS)
  const readable = safe.length === 0 || safe === '.' || safe === '..' ? 'session' : safe
  if (readable === raw) return readable
  return `${readable}-${createHash('sha256').update(raw).digest('hex').slice(0, 8)}`
}

/** One resolved archive destination for a single compaction. */
export interface ArchiveLocation {
  /** Absolute directory every file of this compaction lands in. */
  dir: string
  /** Layout that produced {@link dir}. */
  layout: ArchiveLayout
  /** Sanitized session directory name; the empty string under the flat layout. */
  session: string
}

/**
 * Resolve the directory one session's archive files belong in.
 * @param base - the archive base directory (configured `archiveDir`, else `<cwd>/.handoff`).
 * @param sessionId - owning session id.
 * @param layout - `session` (default) or the legacy `flat`.
 */
export function archiveLocation(base: string, sessionId: string, layout: ArchiveLayout): ArchiveLocation {
  if (layout === 'flat') return { dir: base, layout, session: '' }
  const session = sessionDirName(sessionId)
  return { dir: path.join(base, SESSIONS_DIRNAME, session), layout, session }
}

/**
 * Pointer paths a caller outside the engine may probe for one session's newest
 * digest, most specific first. The engine's own frame carries the authoritative
 * path; these are the fallback for a reader that only knows the default base
 * directory (`<cwd>/.handoff`) and the session id.
 *
 * Both layouts are probed because the guard does not know the engine's
 * `archiveLayout` setting: existence checks are cheap and a miss is harmless.
 *
 * @param base - the default archive base directory (`<cwd>/.handoff`).
 * @param sessionId - owning session id.
 * @returns candidate absolute pointer paths, session layout first.
 */
export function digestPointerCandidates(base: string, sessionId: string): string[] {
  return [
    path.join(base, SESSIONS_DIRNAME, sessionDirName(sessionId), LATEST_DIGEST_POINTER),
    path.join(base, LATEST_DIGEST_POINTER),
  ]
}

/** Suffix of the wrap-up handoff note that belongs to one epoch. */
export const HANDOFF_NOTE_SUFFIX = '.handoff.md'

/**
 * Path of the wrap-up handoff note for one compaction, beside that epoch's
 * `raw`/`digest` pair.
 *
 * The note is written by the agent (the wrap-up prompt names this path), not by
 * the engine, but it belongs in the same directory: one session's artifacts
 * stay together, and the epoch prefix makes the note sort with the cut it
 * describes. The prefix is fixed rather than the engine's `epochPrefix` because
 * the guard does not read the engine row's config.
 *
 * @param dir - the session's archive directory ({@link ArchiveLocation.dir}).
 * @param epoch - this session's compaction number the note describes (1-based).
 */
export function handoffNotePath(dir: string, epoch: number): string {
  return path.join(dir, `epoch-${epoch}${HANDOFF_NOTE_SUFFIX}`)
}
