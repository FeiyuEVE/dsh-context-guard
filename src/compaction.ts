/**
 * ArchiveCutEngine — deterministic compaction backend for the context-guard
 * "cut to a surviving frame" flow.
 *
 * Where `@deepseek-ai/dsh-compaction-basic` replays the shadowed region into
 * an LLM summarization call, this engine writes two files with pure code (zero
 * additional model calls) and returns a short pointer frame as the checkpoint.
 * Everything else — pressure and overflow triggers, retained tail policy, the
 * durable compaction transaction (boundary validation, tool-pair balance,
 * `compaction/start|end` markers, surface replacement, shrink guarantee) — is
 * inherited unchanged from `BasicCompactionEngine`; `summarize()` is the sole
 * hook this engine overrides, which the base class documents as the sanctioned
 * extension point for "template or remote summarizer" backends.
 *
 * Layout (per session, under the resolved base directory — see `paths.ts`),
 * produced by the shared writer in `archive.ts`:
 * - `sessions/<session dir>/epoch-<n>.raw.md`
 *   — lossless deterministic Markdown of the shadowed region;
 * - `sessions/<session dir>/epoch-<n>.digest.md`
 *   — short deterministic fact digest, the cheap re-entry document;
 * - `sessions/<session dir>/latest.txt` / `latest-digest.txt`
 *   — absolute paths of the newest pair, so host-side consumers (e.g. the
 *   resume prompt, or carry-forward) locate the current epoch without parsing
 *   engine output.
 *
 * This engine writes both files *before* the region is shadowed, so a
 * compaction it owns can never lose the data it removes. (The guard's side-car
 * writer uses the same files but runs from the `compaction/summary` event,
 * which cannot make that guarantee — see `docs/gotchas.md`.) Writes are tmp+rename and pointers move
 * last, so a reader never sees a half-written document behind a fresh pointer.
 *
 * The checkpoint frame carries the digest path (first choice for a resumed
 * agent) and the raw path (details on demand), plus a short headline so the
 * model can act without reading anything at all.
 *
 * @module dsh-context-guard/compaction
 */

import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
// Type-only: pulls in the `ctx.settings` declaration merge.
import type {} from '@deepseek-ai/dsh-settings'
import { writeArchive } from './archive.ts'
import type { Artifacts } from './archive.ts'
import { FRAME_MARKER, estimateMessageTokens } from './digest.ts'
import { createLogSink, logInfo } from './log.ts'
import { resolveDigestConfig, userLayerOf } from './settings.ts'
import type { EngineDigestConfig, ResolvedDigestConfig } from './settings.ts'
import type { LogSink } from './log.ts'

/** Compaction-config keys mirrored from `compaction-basic` (forwarded verbatim). */
const modelPolicy = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  thresholdRatio: z.number(),
  retainRatio: z.number(),
  retainTokens: z.number().step(1).min(0),
  summarizationProvider: z.string(),
  summarizationModel: z.string(),
  maxTokens: z.number().step(1).min(1),
  compactionRetries: z.number().step(1).min(0),
  maxOverflowRetries: z.number().step(1).min(0),
})

const basicPolicyKeys = {
  thresholdRatio: z.number(),
  retainRatio: z.number(),
  retainTokens: z.number().step(1).min(0),
  summarizationProvider: z.string(),
  summarizationModel: z.string(),
  maxTokens: z.number().step(1).min(1),
  compactionRetries: z.number().step(1).min(0),
  maxOverflowRetries: z.number().step(1).min(0),
  modelPolicies: z.array(modelPolicy),
  auto: z.boolean(),
} as const

/** This engine's own keys: archive destination plus the digest knobs. */
const archivePolicyKeys = {
  archiveDir: z.string().default(''),
  epochPrefix: z.string().default('epoch'),
  digestEnabled: z.boolean().default(true),
  digestMaxTokens: z.number().step(1).min(80).default(800),
  digestTargetRatio: z.number().min(0.05).max(0.95).default(0.45),
  digestCarryForward: z.boolean().default(true),
  digestTokenEstimator: z.union([z.const('cjk'), z.const('ascii')]).default('cjk'),
  rawExcludeInjected: z.boolean().default(false),
  archiveLayout: z.union([z.const('session'), z.const('flat')]).default('session'),
} as const

/** Config keys that count as "this row configured the digest". */
const ARCHIVE_POLICY_KEY_NAMES: readonly string[] = Object.keys(archivePolicyKeys)

/** Provider/model label reported on the deterministic checkpoint (no usage is
 * recorded: the result carries no `llmStreamCall`, so metering ignores it). */
const ENGINE_MODEL = 'archive-cut-v1'

/** Region size (estimated tokens) at or above which the frame carries a headline. */
const HEADLINE_MIN_REGION_TOKENS = 600

/** Structural summarization-input shape (the package does not export the
 * nominal type; `readonly` + optional fields keep it a supertype of the base
 * signature so the override stays bivariantly compatible). */
interface ArchiveInput {
  readonly system?: string
  readonly tools?: readonly unknown[]
  readonly messages: readonly Message[]
}

/** Deterministic checkpoint content returned instead of an LLM summary. */
interface ArchiveResult {
  summary: ContentBlock[]
  provider: string
  model: string
  maxTokens: number
}

/** Split engine config: base policy keys for the superclass, archive knobs here. */
function splitConfig(config: Record<string, unknown>): {
  basic: BasicCompactionConfig
  archiveDir: string
  epochPrefix: string
  digest: EngineDigestConfig
  configuredHere: boolean
} {
  const {
    archiveDir,
    epochPrefix,
    digestEnabled,
    digestMaxTokens,
    digestTargetRatio,
    digestCarryForward,
    digestTokenEstimator,
    rawExcludeInjected,
    archiveLayout,
    ...basic
  } = config
  const digest: EngineDigestConfig = {
    ...typeof digestEnabled === 'boolean' ? { enabled: digestEnabled } : {},
    ...typeof digestMaxTokens === 'number' ? { maxTokens: digestMaxTokens } : {},
    ...typeof digestTargetRatio === 'number' ? { targetRatio: digestTargetRatio } : {},
    ...typeof digestCarryForward === 'boolean' ? { carryForward: digestCarryForward } : {},
    ...digestTokenEstimator === 'cjk' || digestTokenEstimator === 'ascii'
      ? { estimator: digestTokenEstimator }
      : {},
    ...typeof rawExcludeInjected === 'boolean' ? { rawExcludeInjected } : {},
    ...archiveLayout === 'session' || archiveLayout === 'flat' ? { layout: archiveLayout } : {},
  }
  return {
    basic: basic as BasicCompactionConfig,
    archiveDir: typeof archiveDir === 'string' ? archiveDir : '',
    epochPrefix: typeof epochPrefix === 'string' && epochPrefix.length > 0 ? epochPrefix : 'epoch',
    digest,
    configuredHere: ARCHIVE_POLICY_KEY_NAMES.some(key => key in config),
  }
}

/**
 * Deterministic archival-cut compaction engine: override of the sole
 * `summarize()` hook. Archives the shadowed region to Markdown, writes a
 * deterministic fact digest beside it, and returns a pointer frame; never calls
 * a model.
 */
export class ArchiveCutEngine extends BasicCompactionEngine {
  /** Base keys plus the archive knobs; loader-validated on mount. */
  static override Config = z.object({
    ...basicPolicyKeys,
    ...archivePolicyKeys,
  })

  /** Absolute directory for archives; empty means "derive from the session's
   * `cwd` (`.handoff/` underneath it)". */
  readonly archiveDir: string

  /** Filename prefix for epoch archives. */
  readonly epochPrefix: string

  /** The digest knobs as this row declared them (the middle precedence layer). */
  private readonly digestEntry: EngineDigestConfig

  /** Whether this row declared any archive-policy key at all. */
  private readonly digestConfiguredHere: boolean

  /** Signature of the last logged knob resolution, to log provenance once per change. */
  private loggedKnobs = ''

  /** Structured log sink: cordis logger plus the console line that is observable without an exporter. */
  private readonly log: LogSink

  constructor(ctx: Context, config: Record<string, unknown> = {}) {
    const { basic, archiveDir, epochPrefix, digest, configuredHere } = splitConfig(config)
    super(ctx, basic)
    this.archiveDir = archiveDir
    this.epochPrefix = epochPrefix
    this.digestEntry = digest
    this.digestConfiguredHere = configuredHere
    this.log = createLogSink(ctx.logger)
  }

  /**
   * Deterministic "summarizer": archive the shadowed region to Markdown, write
   * the digest, and return a pointer frame. No `ctx.llm` interaction; the
   * region's full text lives in the archive file instead of a model-written
   * summary.
   * @param input - the shadowed region in surface order (system/tools omitted
   *   from the archive on purpose: they are re-sent by the host every request
   *   and may contain preset secrets).
   * @param agent - supplies the session whose `cwd` anchors the archive dir.
   */
  protected override async summarize(
    input: ArchiveInput,
    agent: Agent,
  ): Promise<ArchiveResult> {
    const resolved = this.resolveKnobs()
    const regionTokens = input.messages.reduce(
      (total, message) => total + estimateMessageTokens(message, resolved.estimator),
      0,
    )
    // Synchronous on purpose: the files must exist before this summarizer's
    // result is framed and committed (see `archive.ts`).
    const artifacts = writeArchive({
      base: this.resolveBaseDir(agent),
      layout: resolved.layout,
      epochPrefix: this.epochPrefix,
      sessionId: String(agent.session.id),
      messages: input.messages,
      config: resolved,
      log: this.log,
      logScope: 'digest',
      regionTokens,
    })
    return {
      summary: [{ type: 'text', text: this.frameText(artifacts) }],
      provider: 'context-guard',
      model: ENGINE_MODEL,
      maxTokens: 0,
    }
  }

  /**
   * Effective digest knobs: the settings user layer, else this row's config,
   * else the built-in defaults. The settings service is the only channel that
   * works across the two module graphs (the guard comes from the installed
   * package, this engine from a preset's absolute file reference).
   */
  private resolveKnobs(): ResolvedDigestConfig {
    const user = userLayerOf(this.ctx.get('settings'))
    const resolved = resolveDigestConfig(user, this.digestEntry)
    const source = user !== undefined && Object.keys(user).length > 0
      ? 'settings'
      : this.digestConfiguredHere ? 'config' : 'default'
    const signature = [
      source,
      resolved.enabled,
      resolved.maxTokens,
      resolved.targetRatio,
      resolved.carryForward,
      resolved.estimator,
      resolved.rawExcludeInjected,
      resolved.layout,
    ].join('|')
    if (signature !== this.loggedKnobs) {
      this.loggedKnobs = signature
      logInfo(this.log, 'digest', 'knobs', {
        source,
        enabled: resolved.enabled,
        maxTokens: resolved.maxTokens,
        targetRatio: resolved.targetRatio,
        carryForward: resolved.carryForward,
        estimator: resolved.estimator,
        rawExcludeInjected: resolved.rawExcludeInjected,
        layout: resolved.layout,
      })
    }
    return resolved
  }

  /** Absolute base directory: configured `archiveDir`, else `<cwd>/.handoff`. */
  private resolveBaseDir(agent: Agent): string | undefined {
    if (this.archiveDir.length > 0) return this.archiveDir
    const cwd = agent.session?.header?.cwd
    if (cwd !== undefined && cwd.length > 0) return path.join(cwd, '.handoff')
    return undefined
  }

  /**
   * The pointer frame the model sees: paths, at most one short headline, and
   * the reading rule.
   *
   * The frame is deliberately lean. The base engine enforces a shrink
   * invariant — the framed summary must be smaller than the content it
   * replaces — and a frame padded with a full headline can violate it for a
   * small region. The headline therefore appears only when the region is large
   * enough for it to be both useful and affordable (a big region is expensive
   * to read back, so saving that round-trip is worth ~20 tokens).
   */
  private frameText(artifacts: Artifacts): string {
    const lines = [`${FRAME_MARKER}（未调用模型摘要请求）。`]
    if (artifacts.digestPath !== undefined) lines.push(`- 精简接力摘要：\`${artifacts.digestPath}\``)
    if (artifacts.rawPath !== undefined) lines.push(`- 完整归档：\`${artifacts.rawPath}\``)
    const facts = artifacts.facts
    if (facts !== undefined && (artifacts.regionTokens ?? 0) >= HEADLINE_MIN_REGION_TOKENS) {
      const lead = facts.intents[0]
        ?? facts.todos[facts.todos.length - 1]
        ?? facts.lastAssistantText.split('\n').find(line => line.trim().length > 0)
      if (lead !== undefined && lead.trim().length > 0) lines.push(`- 线索：「${lead.trim().slice(0, 60)}」`)
    }
    if (artifacts.rawPath === undefined && artifacts.digestPath === undefined) {
      lines.push('（归档目录不可用：会话无 cwd 且未配置 archiveDir）')
    } else {
      lines.push('需要细节时用 read 工具按需读取该文件恢复状态，不要在上下文中复述。')
    }
    lines.push('请直接继续执行截断前正在进行的任务。')
    return lines.join('\n')
  }
}

export default ArchiveCutEngine

/** Re-export the cleaner for host-side consumers and tests. */
export { messagesToMarkdown } from './messages-to-md.ts'
