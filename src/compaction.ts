/**
 * ArchiveCutEngine — deterministic compaction backend for the context-guard
 * "cut to a surviving frame" flow.
 *
 * Where `@deepseek-ai/dsh-compaction-basic` replays the shadowed region into
 * an LLM summarization call, this engine archives the same region to a
 * Markdown document with pure code (zero additional model calls) and returns a
 * short pointer frame as the checkpoint. Everything else — pressure and
 * overflow triggers, retained tail policy, the durable compaction transaction
 * (boundary validation, tool-pair balance, `compaction/start|end` markers,
 * surface replacement, shrink guarantee) — is inherited unchanged from
 * `BasicCompactionEngine`; `summarize()` is the sole hook this engine
 * overrides, which the base class documents as the sanctioned extension point
 * for "template or remote summarizer" backends.
 *
 * Archive layout (per session, under the resolved base directory):
 * - `<epochPrefix>-<n>.raw.md` — deterministic Markdown of the shadowed
 *   region (see `messages-to-md.ts`); `<n>` continues the highest existing
 *   number in the directory, so restarts never overwrite an epoch;
 * - `latest.txt` — absolute path of the most recent raw archive, so host-side
 *   consumers (e.g. a resume prompt) can locate the current epoch without
 *   parsing the engine's output.
 *
 * The checkpoint frame carries the archive path, so the model itself can read
 * details back on demand (`read`/`grep`) instead of carrying them in context.
 *
 * @module dsh-context-guard/compaction
 */

import { mkdir, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { messagesToMarkdown } from './messages-to-md.ts'

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

/** Provider/model label reported on the deterministic checkpoint (no usage is
 * recorded: the result carries no `llmStreamCall`, so metering ignores it). */
const ENGINE_MODEL = 'archive-cut-v1'

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
} {
  const { archiveDir, epochPrefix, ...basic } = config
  return {
    basic: basic as BasicCompactionConfig,
    archiveDir: typeof archiveDir === 'string' ? archiveDir : '',
    epochPrefix: typeof epochPrefix === 'string' && epochPrefix.length > 0 ? epochPrefix : 'epoch',
  }
}

/**
 * Deterministic archival-cut compaction engine: override of the sole
 * `summarize()` hook. Archives the shadowed region to Markdown and returns a
 * pointer frame; never calls a model.
 */
export class ArchiveCutEngine extends BasicCompactionEngine {
  /** Base keys plus the archive knobs; loader-validated on mount. */
  static override Config = z.object({
    ...basicPolicyKeys,
    archiveDir: z.string().default(''),
    epochPrefix: z.string().default('epoch'),
  })

  /** Absolute directory for raw epoch archives; empty means "derive from the
   * session's `cwd` (`.handoff/` underneath it)". */
  readonly archiveDir: string

  /** Filename prefix for raw epoch archives. */
  readonly epochPrefix: string

  constructor(ctx: Context, config: Record<string, unknown> = {}) {
    const { basic, archiveDir, epochPrefix } = splitConfig(config)
    super(ctx, basic)
    this.archiveDir = archiveDir
    this.epochPrefix = epochPrefix
  }

  /**
   * Deterministic "summarizer": archive the shadowed region to Markdown and
   * return a pointer frame. No `ctx.llm` interaction; the region's full text
   * lives in the archive file instead of a model-written summary.
   * @param input - the shadowed region in surface order (system/tools omitted
   *   from the archive on purpose: they are re-sent by the host every request
   *   and may contain preset secrets).
   * @param agent - supplies the session whose `cwd` anchors the archive dir.
   */
  protected override async summarize(
    input: ArchiveInput,
    agent: Agent,
  ): Promise<ArchiveResult> {
    const archivePath = await this.archiveSpan(agent, input.messages)
    const location = archivePath === undefined
      ? '（归档目录不可用：会话无 cwd 且未配置 archiveDir）'
      : `\`${archivePath}\``
    const text = [
      '本段历史已由 dsh-context-guard 确定性归档（未调用模型摘要请求）。',
      `完整原始记录（含全部对话、工具调用与结果）见：${location}`,
      '需要细节时用 read 工具按需读取该文件恢复状态，不要在上下文中复述。',
      '请直接继续执行截断前正在进行的任务。',
    ].join('\n\n')
    return {
      summary: [{ type: 'text', text }],
      provider: 'context-guard',
      model: ENGINE_MODEL,
      maxTokens: 0,
    }
  }

  /** Write one epoch archive plus the `latest.txt` pointer; never throws. */
  private async archiveSpan(agent: Agent, messages: readonly Message[]): Promise<string | undefined> {
    const base = this.resolveBaseDir(agent)
    if (base === undefined) {
      this.ctx.logger.warn(
        'context-guard/compaction: no archive base directory (session cwd missing and archiveDir unset); '
        + 'skipping deterministic archive — the checkpoint will carry no file path',
      )
      return undefined
    }
    try {
      await mkdir(base, { recursive: true })
      let max = 0
      const pattern = new RegExp(`^${escapeRegExp(this.epochPrefix)}-(\\d+)\\.raw\\.md$`)
      for (const name of await readdir(base)) {
        const match = pattern.exec(name)
        if (match !== null) max = Math.max(max, Number(match[1]))
      }
      const number = max + 1
      const file = path.join(base, `${this.epochPrefix}-${number}.raw.md`)
      const md = messagesToMarkdown(messages)
      await writeFile(file, md, 'utf8')
      await writeFile(path.join(base, 'latest.txt'), `${file}\n`, 'utf8')
      this.ctx.logger.info(
        `context-guard/compaction: archived ${messages.length} messages to ${file}`,
      )
      return file
    } catch (error: unknown) {
      this.ctx.logger.warn(
        `context-guard/compaction: archive write failed (${String(error)}); `
        + 'compaction proceeds without a file',
      )
      return undefined
    }
  }

  /** Absolute base directory: configured `archiveDir`, else `<cwd>/.handoff`. */
  private resolveBaseDir(agent: Agent): string | undefined {
    if (this.archiveDir.length > 0) return this.archiveDir
    const cwd = agent.session?.header?.cwd
    if (cwd !== undefined && cwd.length > 0) return path.join(cwd, '.handoff')
    return undefined
  }
}

/** Escape a filename prefix for the epoch-scanning regex. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export default ArchiveCutEngine

/** Re-export the cleaner for host-side consumers and tests. */
export { messagesToMarkdown } from './messages-to-md.ts'
