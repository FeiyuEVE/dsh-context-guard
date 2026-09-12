/**
 * Deterministic archive writer, shared by the two things that produce one.
 *
 * Both the `ArchiveCutEngine` (which takes over a compaction's summarization
 * and returns a pointer frame) and the host guard (which writes a side-car
 * document *beside* whatever engine the preset mounted) need to turn one
 * shadowed region into the same file pair. This module is that one writer:
 * `epoch-<n>.raw.md` (lossless) plus `epoch-<n>.digest.md` (deterministic fact
 * digest), and the `latest*.txt` pointers that name each pair.
 *
 * Nothing here imports the compaction backend, so the host half can use it
 * without dragging `@deepseek-ai/dsh-compaction-basic`'s runtime class into a
 * composition that only mounts the guard row.
 *
 * The writer is deliberately **synchronous**. `compaction/summary` reaches
 * listeners through `session/event`, which dsh invokes synchronously but never
 * awaits (`@mode emit`), and the backend appends the region's replacement
 * message immediately after with no `await` in between. An asynchronous write
 * would therefore keep running while the region leaves the model's view. Writing
 * synchronously inside that listener is the only way to guarantee the archive is
 * already on disk when the compaction takes effect — and "when the compaction is
 * done, the handoff document already exists" is the property that matters. The
 * price is that the caller waits for the write (a few milliseconds for a normal
 * region); a hung archive filesystem would stall that caller instead of merely
 * losing the archive.
 *
 * Every failure degrades rather than throws: a compaction must never fail
 * because an archive could not be written.
 *
 * @module dsh-context-guard/archive
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import {
  DIGEST_FORMAT_VERSION,
  carriedFrom,
  composeDigest,
  digestPathFrom,
  estimateMessageTokens,
  extractFacts,
  parseDigest,
} from './digest.ts'
import type { DigestFacts, DigestTier } from './digest.ts'
import { logInfo, logWarn } from './log.ts'
import type { LogSink } from './log.ts'
import { messagesToMarkdown } from './messages-to-md.ts'
import { LATEST_DIGEST_POINTER, LATEST_POINTER, archiveLocation } from './paths.ts'
import type { ArchiveLayout, ArchiveLocation } from './paths.ts'
import type { ResolvedDigestConfig } from './settings.ts'

/** Everything one compaction wrote, for a pointer frame, a record, or a log line. */
export interface Artifacts {
  /** This session's compaction number, when the destination was resolvable. */
  epoch?: number | undefined
  /** Absolute raw archive path, when it landed. */
  rawPath?: string | undefined
  /** Absolute digest path, when it landed. */
  digestPath?: string | undefined
  /** Estimated tokens of the digest. */
  digestTokens?: number | undefined
  /** Budget the digest was composed against. */
  targetTokens?: number | undefined
  /** Renderer that produced the digest body. */
  tier?: DigestTier | undefined
  /** Epoch the digest inherited from. */
  carriedFrom?: number | undefined
  /** Extracted facts, for the frame headline. */
  facts?: DigestFacts | undefined
  /** Estimated tokens of the compacted region. */
  regionTokens?: number | undefined
}

/** One archive to write. */
export interface ArchiveRequest {
  /**
   * Absolute archive base directory (`<cwd>/.handoff` by default), or
   * undefined when the session exposes no working directory — in which case
   * nothing is written and a warn line is left.
   */
  base?: string | undefined
  /** Layout below the base directory. */
  layout: ArchiveLayout
  /** Filename prefix for epoch archives (`epoch`). */
  epochPrefix: string
  /** Owning session id, recorded inside the digest and used for the session directory. */
  sessionId: string
  /** The shadowed region, in surface order. */
  messages: readonly Message[]
  /** Effective digest knobs. */
  config: ResolvedDigestConfig
  /** Structured log sink. */
  log: LogSink
  /** Log scope below the plugin root (`digest`, `sidecar`, …). */
  logScope: string
  /**
   * Lower bound for this compaction's number. The scan of existing archives
   * still wins when it is higher, so a number is never reused by overwriting a
   * file — a caller that already counted the session's compactions (the guard)
   * passes that count here; the engine, which allocates purely from disk, omits
   * it.
   */
  minEpoch?: number | undefined
  /** Estimated tokens of the region, when the caller already measured them. */
  regionTokens?: number | undefined
}

/** Write one file atomically (tmp + rename) so readers never see a partial document. */
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

/** Escape a filename prefix for the epoch-scanning regex. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Text blocks of one message, joined. */
function messageText(message: Message): string {
  return message.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/** Next unused epoch in one directory: one past the highest raw archive present. */
function nextEpoch(dir: string, epochPrefix: string): number {
  let max = 0
  const pattern = new RegExp(`^${escapeRegExp(epochPrefix)}-(\\d+)\\.raw\\.md$`)
  try {
    for (const name of readdirSync(dir)) {
      const match = pattern.exec(name)
      if (match !== null) max = Math.max(max, Number(match[1]))
    }
  } catch {
    // The directory is created by the caller just before this scan; a failure
    // here means the very first write, which starts the numbering at 1.
  }
  return max + 1
}

/**
 * Write this compaction's artifacts. Never throws: each failure degrades the
 * result (no path, or no digest) and leaves a warn line.
 *
 * @param request - the region, the destination, and the digest knobs.
 * @returns what landed; empty when the base directory was unresolvable.
 */
export function writeArchive(request: ArchiveRequest): Artifacts {
  const {
    base,
    layout,
    epochPrefix,
    sessionId,
    messages,
    config,
    log,
    logScope,
    minEpoch,
    regionTokens,
  } = request
  if (base === undefined || base.length === 0) {
    logWarn(log, logScope, 'no-base-dir', { session: sessionId })
    return {}
  }
  const location = archiveLocation(base, sessionId, layout)
  const artifacts: Artifacts = { regionTokens }
  try {
    mkdirSync(location.dir, { recursive: true })
    writeRaw(location, messages, config, artifacts, log, logScope, epochPrefix, minEpoch)
    if (!config.enabled) {
      logInfo(log, logScope, 'skipped', { reason: 'disabled', session: sessionId })
      return artifacts
    }
    writeDigest(location, sessionId, messages, config, artifacts, log, logScope, epochPrefix)
  } catch (error: unknown) {
    logWarn(log, logScope, 'write-failed', {
      session: sessionId,
      dir: location.dir,
      error: String(error),
    })
  }
  return artifacts
}

/** Write the lossless archive and move its pointer. */
function writeRaw(
  location: ArchiveLocation,
  messages: readonly Message[],
  config: ResolvedDigestConfig,
  artifacts: Artifacts,
  log: LogSink,
  logScope: string,
  epochPrefix: string,
  minEpoch: number | undefined,
): void {
  const scanned = nextEpoch(location.dir, epochPrefix)
  const epoch = minEpoch === undefined ? scanned : Math.max(scanned, minEpoch)
  const file = path.join(location.dir, `${epochPrefix}-${epoch}.raw.md`)
  const md = messagesToMarkdown(messages, { excludeInjected: config.rawExcludeInjected })
  writeAtomic(file, md)
  writeAtomic(path.join(location.dir, LATEST_POINTER), `${file}\n`)
  artifacts.epoch = epoch
  artifacts.rawPath = file
  logInfo(log, logScope, 'raw-written', {
    epoch,
    session: location.session.length > 0 ? location.session : '(flat)',
    layout: location.layout,
    messages: messages.length,
    dir: location.dir,
    file,
  })
}

/** Write the deterministic digest and move its pointer. */
function writeDigest(
  location: ArchiveLocation,
  sessionId: string,
  messages: readonly Message[],
  config: ResolvedDigestConfig,
  artifacts: Artifacts,
  log: LogSink,
  logScope: string,
  epochPrefix: string,
): void {
  const epoch = artifacts.epoch ?? 1
  const estimator = config.estimator
  const regionTokens = artifacts.regionTokens ?? messages.reduce(
    (total, message) => total + estimateMessageTokens(message, estimator),
    0,
  )
  const carried = config.carryForward
    ? readCarried(location, sessionId, messages, log, logScope)
    : undefined
  const facts = extractFacts(messages)
  const result = composeDigest(facts, {
    sessionId,
    epoch,
    rawPath: artifacts.rawPath,
    carriedFrom: carried?.from,
    regionMessages: messages.length,
    regionToolCalls: facts.toolCallCount,
    regionTokens,
  }, {
    maxTokens: config.maxTokens,
    targetRatio: config.targetRatio,
    estimator,
    carried: carried?.sections,
  })

  const file = path.join(location.dir, `${epochPrefix}-${epoch}.digest.md`)
  writeAtomic(file, result.text)
  writeAtomic(path.join(location.dir, LATEST_DIGEST_POINTER), `${file}\n`)

  artifacts.digestPath = file
  artifacts.digestTokens = result.digestTokens
  artifacts.targetTokens = result.targetTokens
  artifacts.tier = result.tier
  artifacts.carriedFrom = carried?.from
  artifacts.facts = facts
  logInfo(log, logScope, 'written', {
    epoch,
    session: location.session.length > 0 ? location.session : '(flat)',
    region: `${messages.length}/${facts.toolCallCount}`,
    tokens: `${regionTokens}→${result.digestTokens}`,
    budget: result.targetTokens,
    tier: result.tier,
    carriedFrom: carried?.from,
    digest: file,
    raw: artifacts.rawPath,
  })
}

/**
 * Sections a new digest inherits from the previous one.
 *
 * Primary source is the `latest-digest.txt` pointer, which is exact and cheap.
 * When it is missing (first compaction, a fork whose parent archived under
 * another session directory, a removed file), the region itself is scanned
 * for a referenced digest path — the previous frame carries it. A digest
 * belonging to a different session is never inherited.
 */
function readCarried(
  location: ArchiveLocation,
  sessionId: string,
  messages: readonly Message[],
  log: LogSink,
  logScope: string,
): { sections: Map<string, string[]>; from?: number } | undefined {
  const candidates: string[] = []
  try {
    const pointer = readFileSync(path.join(location.dir, LATEST_DIGEST_POINTER), 'utf8').trim()
    if (pointer.length > 0) candidates.push(pointer)
  } catch {
    // No pointer yet: fall through to the in-region reference.
  }
  for (const message of messages) {
    const referenced = digestPathFrom(messageText(message))
    if (referenced !== undefined && !candidates.includes(referenced)) candidates.push(referenced)
  }
  for (const candidate of candidates) {
    try {
      const text = readFileSync(candidate, 'utf8')
      const owner = /^- 会话: (.+)$/m.exec(text)?.[1]?.trim()
      if (owner !== undefined && owner !== sessionId) {
        logWarn(log, logScope, 'carry-forward-skipped', {
          reason: 'other-session',
          from: candidate,
        })
        continue
      }
      const parsed = parseDigest(text)
      const sections = carriedFrom(parsed)
      if (sections.size === 0) {
        logWarn(log, logScope, 'carry-forward-skipped', {
          reason: parsed === undefined
            ? 'unparsable'
            : `version-${parsed.version}-expected-${DIGEST_FORMAT_VERSION}`,
          from: candidate,
        })
        continue
      }
      const from = Number(/^- 第几次: (\d+)$/m.exec(text)?.[1] ?? 'NaN')
      return { sections, ...Number.isFinite(from) ? { from } : {} }
    } catch {
      // Missing or unreadable candidate: try the next one.
    }
  }
  return undefined
}
