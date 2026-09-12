/**
 * Deterministic relay-digest builder.
 *
 * The archive-cut compaction already dumps the compacted region to a lossless
 * Markdown file. That file is expensive to read back (a real epoch in this
 * workspace is ~30 KB ≈ 8k tokens), which cancels out most of what the
 * compaction saved. This module produces the second artifact: a short,
 * deterministic, fact-only digest the resumed agent reads first.
 *
 * Design constraints, all load-bearing:
 *
 * - **Zero model calls.** Extraction is pure code, so the digest costs no
 *   tokens to produce (the same property the archive itself has). It is a fact
 *   list, not a semantic summary — by design it does not try to understand.
 * - **Deterministic.** Identical input renders byte-identical output: no
 *   clock, no randomness, no map iteration over unstable keys, so golden
 *   tests can assert equality.
 * - **Host-re-injected context is dropped.** The system prompt, AGENTS.md
 *   instructions and skill catalogs are re-sent by the host every request; the
 *   model can never lose them, so copying them into the digest is pure waste
 *   (measured: they were the majority of a raw archive).
 * - **Prefix carry-forward.** The next digest inherits the still-relevant
 *   sections of the previous one, otherwise a session's older history
 *   disappears at the second compaction ("summary of a summary").
 *
 * The format is a contract: see `docs/digest-format.md`. Bump
 * {@link DIGEST_FORMAT_VERSION} and the marker when a reader must notice.
 *
 * @module dsh-context-guard/digest
 */

import path from 'node:path'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'

/** Version of the digest document format. */
export const DIGEST_FORMAT_VERSION = 1

/**
 * Opening words of every pointer frame the archive-cut engine returns.
 *
 * The guard matches on this marker to tell its own deterministic frame apart
 * from a *foreign* compaction summary (any other engine's, e.g. the
 * model-written one from `compaction-basic`). The distinction is
 * load-bearing: a summary is ordinary prose and may quote archive-looking
 * text — a doc placeholder such as `epoch-N.digest.md`, a path mentioned in
 * passing — and those quoted strings are not artifacts of this session.
 */
export const FRAME_MARKER = '本段历史已由 dsh-context-guard 确定性归档'

/** First line of every digest; carries the format version. */
export const DIGEST_MARKER = `<!-- context-guard-digest v${DIGEST_FORMAT_VERSION} -->`

/** Digest section headers, in render order. */
export const DIGEST_SECTIONS = {
  intent: '主要意图',
  concepts: '关键技术概念',
  files: '涉及文件',
  errors: '报错与修复',
  todos: '未完成待办',
  current: '当前进展',
  next: '下一步',
  context: '压缩说明',
} as const

/** Sections a new digest inherits from the previous one. */
const CARRIED_SECTIONS: readonly string[] = [
  DIGEST_SECTIONS.intent,
  DIGEST_SECTIONS.concepts,
  DIGEST_SECTIONS.files,
  DIGEST_SECTIONS.errors,
  DIGEST_SECTIONS.context,
]

/**
 * First words of the per-epoch provenance line closing every digest.
 *
 * That line describes the epoch it was written in, so inheriting it is both
 * useless and unbounded: with N compactions the carried `压缩说明` grew by one
 * stale line each time (observed in a real 4-compaction session on 2026-09-12).
 * Carried copies are therefore dropped and the current digest writes exactly
 * one, which keeps the section's growth bounded by the duplicate-call notes.
 */
const EPOCH_NOTE_PREFIX = '本段由 dsh-context-guard 确定性压缩'

/** How digest budgets price text. */
export type DigestEstimator = 'cjk' | 'ascii'

/** One tool call's contribution to the duplicated-work note. */
interface CallRecord {
  /** Tool name. */
  name: string
  /** Parsed arguments, when the payload was JSON. */
  parsed: Record<string, unknown> | undefined
}

/** Everything the deterministic extractor recovered from one region. */
export interface DigestFacts {
  /** Messages in the compacted region. */
  messageCount: number
  /** Tool calls in the compacted region. */
  toolCallCount: number
  /** Verbatim user requests, oldest first. */
  intents: string[]
  /** Command words and file extensions seen. */
  concepts: string[]
  /** Touched paths with read/write counts. */
  files: Map<string, { reads: number; writes: number }>
  /** Shell commands, verbatim. */
  commands: string[]
  /** One line per observed failure. */
  errors: string[]
  /** Pending todo items (structured source first). */
  todos: string[]
  /** Identical tool calls repeated within the region. */
  duplicates: { name: string; display: string; count: number }[]
  /** Text of the last user-role request. */
  lastUserText: string
  /** Text of the last assistant message. */
  lastAssistantText: string
}

/** Identity of one digest document. */
export interface DigestMeta {
  /** Owning session id. */
  sessionId: string
  /** This session's compaction number, 1-based. */
  epoch: number
  /** Absolute path of the raw archive written alongside, when it landed. */
  rawPath?: string | undefined
  /** Epoch the carried sections came from, when any were inherited. */
  carriedFrom?: number | undefined
  /** Messages in the compacted region. */
  regionMessages: number
  /** Tool calls in the compacted region. */
  regionToolCalls: number
  /** Estimated tokens of the compacted region. */
  regionTokens: number
}

/** Budget knobs for one digest. */
export interface DigestOptions {
  /** Hard upper bound, in estimated tokens. Defaults to `800`. */
  maxTokens?: number | undefined
  /** Share of the region the digest may cost; the budget is `min(maxTokens, region × ratio)`. Defaults to `0.45`. */
  targetRatio?: number | undefined
  /** Estimator used for budgeting and reporting. Defaults to `cjk`. */
  estimator?: DigestEstimator | undefined
  /** Sections inherited from the previous digest. */
  carried?: Map<string, string[]> | undefined
}

/** Which renderer produced the body; reported in logs. */
export type DigestTier = 'full' | 'section3' | 'section2' | 'terse' | 'hard-cut'

/** One composed digest. */
export interface DigestResult {
  /** The complete document. */
  text: string
  /** The section body alone (no header). */
  body: string
  /** Renderer that produced {@link body}. */
  tier: DigestTier
  /** Estimated tokens of {@link text}. */
  digestTokens: number
  /** Budget {@link text} was composed against. */
  targetTokens: number
}

/**
 * Lowest budget a digest is composed against, in estimated tokens.
 *
 * The document header is a fixed ~100-token cost (identity, paths, provenance),
 * so a lower floor could not be met by any body and the budget assertion would
 * be a lie for tiny regions. A digest larger than a tiny region costs nothing
 * extra in context — only the short frame enters the context, this document is
 * read on demand — so the floor errs towards a still-useful document.
 */
const MIN_TARGET_TOKENS = 260
/** Longest a single bullet may be, before the tier ladder tightens it. */
const DEFAULT_ITEM_CHARS = 160

/** Arg keys whose string value names a filesystem path. */
const PATH_KEYS = ['file_path', 'absolute_path', 'notebook_path', 'path', 'glob', 'pattern'] as const
/** Arg keys whose string value is a shell command. */
const COMMAND_KEYS = ['command', 'cmd', 'script'] as const
/** Tool-name fragments marking a write-side call. */
const WRITE_TOOL = /write|edit|patch|delete|remove|mkdir|move|rename|create/i
/** Command vocabulary lifted into the concepts section. */
const COMMAND_CONCEPTS = /\b(git|npm|pnpm|yarn|bun|cargo|python|pip|uv|docker|kubectl|helm|make|gradle|maven|curl|terraform)\b/gi
/** First-line signals of a failure, English and Chinese. */
const ERROR_LINE = /(error|failed|failure|fatal|exception|enoent|eacces|eperm|denied|refused|not found|cannot |unable |exit code [1-9]|失败|错误|报错|异常|找不到|未找到|不存在|无法|拒绝|超时|崩溃|致命)/i
/** CJK scripts and full-width forms, priced denser than ASCII. */
const CJK_CHAR = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]/g

/**
 * Estimated tokens of one text.
 *
 * `cjk` prices CJK at ~2 chars/token and ASCII at 4 — the host meter prices
 * everything at 4, which underestimates Chinese by roughly 2x. `ascii` mirrors
 * the host meter exactly.
 */
export function estimateTextTokens(text: string, mode: DigestEstimator = 'cjk'): number {
  const source = String(text)
  if (mode === 'ascii') return Math.ceil(source.length / 4)
  const cjk = source.match(CJK_CHAR)?.length ?? 0
  return Math.ceil(cjk / 2 + (source.length - cjk) / 4)
}

/** Estimated tokens of one message: text blocks, tool arguments, result text. */
export function estimateMessageTokens(message: Message, mode: DigestEstimator = 'cjk'): number {
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'tool-call') parts.push(block.arguments)
    else if (block.type === 'tool-result') {
      for (const inner of block.content) {
        if (inner.type === 'text') parts.push(inner.text)
      }
    }
  }
  return estimateTextTokens(parts.join('\n'), mode)
}

/** Collapse whitespace and hard-cap one item. */
export function clip(text: string, maxChars: number): string {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length <= maxChars ? flat : `${flat.slice(0, Math.max(1, maxChars - 1))}…`
}

/** Text blocks of one message, joined. */
function textOf(message: Message): string {
  return message.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/**
 * Host-re-injected context that reappears every request: system prompts,
 * AGENTS.md instructions, skill catalogs, plugin snapshots, and prior
 * compaction frames. None of it may enter the digest, and the raw archive can
 * be told to drop it too.
 */
export function isInjectedContext(message: Message): boolean {
  const source = message.source as { kind: string; plugin?: string; form?: string }
  // Widened to string: the source-kind vocabulary is merge-extensible, so a
  // kind this compilation does not know (skill-catalog, coordinator, …) is
  // compared without a literal-overlap error.
  const kind = source.kind
  if (kind === 'agent-instructions' || kind === 'skill-catalog' || kind === 'system') return true
  if (kind !== 'plugin') return false
  const plugin = source.plugin ?? ''
  if (plugin === 'context-guard' || plugin === 'dsh-context-guard' || plugin === 'compact') return true
  const form = source.form
  return form === 'snapshot' || form === 'instructions' || form === 'catalog'
}

/** First non-empty line of each tool-result block, with its error flag. */
function resultFirstLines(content: readonly ContentBlock[]): { isError: boolean; line: string }[] {
  const lines: { isError: boolean; line: string }[] = []
  for (const block of content) {
    if (block.type !== 'tool-result') continue
    const line = block.content
      .filter((inner): inner is Extract<ContentBlock, { type: 'text' }> => inner.type === 'text')
      .map(inner => inner.text)
      .join('\n')
      .split('\n')
      .map(entry => entry.trim())
      .find(entry => entry.length > 0)
    if (line !== undefined) lines.push({ isError: block.isError === true, line })
  }
  return lines
}

/** Parsed tool arguments, when the payload is a JSON object. */
function parseArguments(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return undefined
  } catch {
    return undefined
  }
}

/** First present string value among `keys`. */
function argString(parsed: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (parsed === undefined) return undefined
  for (const key of keys) {
    const value = parsed[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/**
 * Pending items of one `todo_write` call, or undefined when the call is not a
 * todo write. The structured list beats scraping checkbox lines out of prose.
 */
function todosFromToolCall(name: string, parsed: Record<string, unknown> | undefined): string[] | undefined {
  if (parsed === undefined || !/todo/i.test(name)) return undefined
  const list = parsed['todos']
  if (!Array.isArray(list)) return undefined
  const pending: string[] = []
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const content = typeof record['content'] === 'string' ? record['content'].trim() : ''
    const status = typeof record['status'] === 'string' ? record['status'] : 'pending'
    if (content.length === 0 || status === 'completed') continue
    if (!pending.includes(content)) pending.push(content)
  }
  return pending
}

/** Checkbox and marker todo lines found in free text. */
function todosFromText(text: string): string[] {
  const items: string[] = []
  for (const match of text.matchAll(/^\s*[-*]\s+\[( |x|X)\]\s*(.+)$/gm)) {
    const item = (match[2] ?? '').trim()
    if (item.length === 0) continue
    if ((match[1] ?? ' ') === ' ') {
      if (!items.includes(item)) items.push(item)
    }
  }
  for (const match of text.matchAll(/^\s*(?:TODO|FIXME|待办)\s*[:：]\s*(.+)$/gim)) {
    const item = (match[1] ?? '').trim()
    if (item.length > 0 && !items.includes(item)) items.push(item)
  }
  return items
}

/**
 * Walk a compacted region and collect every deterministic fact.
 * @param messages - region messages in surface order.
 * @param itemChars - per-item clip bound applied to verbatim user text.
 */
export function extractFacts(messages: readonly Message[], itemChars = DEFAULT_ITEM_CHARS): DigestFacts {
  const facts: DigestFacts = {
    messageCount: messages.length,
    toolCallCount: 0,
    intents: [],
    concepts: [],
    files: new Map(),
    commands: [],
    errors: [],
    todos: [],
    duplicates: [],
    lastUserText: '',
    lastAssistantText: '',
  }
  const callsById = new Map<string, CallRecord>()
  const dupCounts = new Map<string, { name: string; parsed: Record<string, unknown> | undefined; count: number }>()

  for (const message of messages) {
    if (message.role === 'assistant') {
      const text = textOf(message)
      if (text.trim().length > 0) {
        facts.lastAssistantText = text
        for (const item of todosFromText(text)) {
          if (!facts.todos.includes(item)) facts.todos.push(item)
        }
      }
      for (const block of message.content) {
        if (block.type !== 'tool-call') continue
        facts.toolCallCount += 1
        const parsed = parseArguments(block.arguments)
        callsById.set(String(block.id), { name: block.name, parsed })

        const structured = todosFromToolCall(block.name, parsed)
        if (structured !== undefined) facts.todos = structured

        const filePath = argString(parsed, PATH_KEYS)
        if (filePath !== undefined) {
          const entry = facts.files.get(filePath) ?? { reads: 0, writes: 0 }
          if (WRITE_TOOL.test(block.name)) entry.writes += 1
          else entry.reads += 1
          facts.files.set(filePath, entry)
          const extension = /\.([a-z0-9]{1,5})$/i.exec(filePath)
          if (extension !== null) {
            const token = (extension[1] ?? '').toLowerCase()
            if (token.length > 0 && !facts.concepts.includes(token)) facts.concepts.push(token)
          }
        }
        const command = argString(parsed, COMMAND_KEYS)
        if (command !== undefined) {
          facts.commands.push(command)
          for (const match of command.match(COMMAND_CONCEPTS) ?? []) {
            const token = match.toLowerCase()
            if (!facts.concepts.includes(token)) facts.concepts.push(token)
          }
          const head = command.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
          if (head.length > 0 && !facts.concepts.includes(head)) facts.concepts.push(head)
        }
        const key = `${block.name}\u0000${block.arguments}`
        const dup = dupCounts.get(key) ?? { name: block.name, parsed, count: 0 }
        dup.count += 1
        dupCounts.set(key, dup)
      }
      continue
    }

    if (message.role === 'system') continue

    // user-role: tool results, prior frames, or an actual request
    const results = resultFirstLines(message.content)
    if (results.length > 0) {
      for (const result of results) {
        if (!result.isError && !ERROR_LINE.test(result.line)) continue
        const call = message.source.kind === 'tool' ? callsById.get(String(message.source.callId)) : undefined
        facts.errors.push(`${call?.name ?? 'tool'}: ${result.line}`)
      }
      continue
    }
    const text = textOf(message)
    if (text.trim().length === 0 || isInjectedContext(message)) continue
    const notice = message.source.kind === 'plugin' && message.source.form === 'notice'
      ? message.source.summary
      : undefined
    const intent = clip(notice ?? text, itemChars)
    facts.lastUserText = intent
    facts.intents.push(intent)
    for (const item of todosFromText(text)) {
      if (!facts.todos.includes(item)) facts.todos.push(item)
    }
  }

  facts.duplicates = [...dupCounts.values()]
    .filter(entry => entry.count > 1)
    .map(entry => ({
      name: entry.name,
      display: clip(argString(entry.parsed, PATH_KEYS) ?? argString(entry.parsed, COMMAND_KEYS) ?? '', 80),
      count: entry.count,
    }))
  return facts
}

/** Normalized dedup key: case- and punctuation-insensitive. */
function dedupKey(line: string): string {
  return line.toLowerCase().replace(/[^a-z0-9/\u4e00-\u9fff]/g, '')
}

/** Merge two line lists, first occurrence wins. */
function dedupe(lines: readonly string[]): string[] {
  const seen = new Set<string>()
  const merged: string[] = []
  for (const line of lines) {
    const key = dedupKey(line)
    if (key.length === 0 || seen.has(key)) continue
    seen.add(key)
    merged.push(line)
  }
  return merged
}

/** Keep the newest `cap` items, prefixed by an elision note. */
function withElision(lines: readonly string[], cap: number): string[] {
  if (lines.length <= cap) return [...lines]
  const kept = lines.slice(-Math.max(1, cap - 1))
  return [`（省略 ${lines.length - kept.length} 条较早的条目）`, ...kept]
}

/** One renderer's knobs. */
interface RenderOptions {
  /** Max items per section. */
  sectionCap: number
  /** Max characters per item. */
  itemChars: number
  /** Drop sections with no content instead of rendering `（无）`. */
  dropEmpty: boolean
}

/** Render one section, or null when dropped. */
function renderSection(header: string, items: readonly string[], dropEmpty: boolean): string | null {
  const unique = [...new Set(items.filter(item => item.trim().length > 0))]
  if (unique.length === 0 && dropEmpty) return null
  const body = unique.length === 0 ? ['（无）'] : unique.map(item => `- ${item}`)
  return [`## ${header}`, ...body, ''].join('\n')
}

/** Section bodies for one tier. */
function renderSections(
  facts: DigestFacts,
  carried: Map<string, string[]>,
  options: RenderOptions,
): string {
  const carriedOf = (header: string): string[] => carried.get(header) ?? []
  const cap = options.sectionCap
  const chars = options.itemChars

  const intents = withElision(dedupe([
    ...carriedOf(DIGEST_SECTIONS.intent),
    ...facts.intents.map(text => clip(text, chars)),
  ]), cap)

  const concepts = dedupe([...carriedOf(DIGEST_SECTIONS.concepts), ...facts.concepts]).slice(0, cap)

  const freshFiles = [...facts.files.entries()].map(([filePath, ops]) => clip(
    `${filePath} — ${ops.writes > 0
      ? `W×${ops.writes}${ops.reads > 0 ? ` R×${ops.reads}` : ''}`
      : `R×${ops.reads}`}`,
    chars,
  ))
  const freshPaths = new Set([...facts.files.keys()])
  const carriedFiles = carriedOf(DIGEST_SECTIONS.files).filter(line => {
    const head = line.split(/\s+[—-]\s+/)[0]?.trim() ?? line
    return !freshPaths.has(head)
  })
  const files = dedupe([...freshFiles, ...carriedFiles]).slice(0, cap)

  const errors = withElision(dedupe([
    ...carriedOf(DIGEST_SECTIONS.errors),
    ...facts.errors.map(line => clip(line, chars)),
  ]), cap)

  const todos = facts.todos.map(item => clip(item, chars)).slice(0, cap)

  const current: string[] = []
  if (facts.lastUserText.trim().length > 0) current.push(clip(facts.lastUserText, chars))
  if (facts.lastAssistantText.trim().length > 0) {
    current.push(clip(
      facts.lastAssistantText.split('\n').filter(line => line.trim().length > 0).slice(0, 2).join(' / '),
      chars,
    ))
  }

  const next = facts.todos.length > 0 ? clip(facts.todos[facts.todos.length - 1] ?? '', chars) : '（无）'

  // Inherited provenance lines are dropped (see EPOCH_NOTE_PREFIX) so only
  // genuine duplicate-call notes survive across epochs; the current epoch's own
  // line is appended last and never elided.
  const notePrefix = EPOCH_NOTE_PREFIX
  const inheritedNotes = carriedOf(DIGEST_SECTIONS.context).filter(line => !line.startsWith(notePrefix))
  const dupNotes: string[] = []
  for (const dup of facts.duplicates) {
    if (dup.count < 2) continue
    dupNotes.push(`${dup.name}(${dup.display}) 重复执行 ${dup.count} 次 —— 同参数调用，仅保留最近一次结果`)
  }
  const context = [
    ...withElision(dedupe([...inheritedNotes, ...dupNotes]), Math.max(2, cap - 1)),
    `${notePrefix}（${facts.messageCount} 条消息 / ${facts.toolCallCount} 次工具调用，未调用模型摘要）`,
  ]

  const blocks = [
    renderSection(DIGEST_SECTIONS.intent, intents, options.dropEmpty),
    renderSection(DIGEST_SECTIONS.concepts, concepts, options.dropEmpty),
    renderSection(DIGEST_SECTIONS.files, files, options.dropEmpty),
    renderSection(DIGEST_SECTIONS.errors, errors, options.dropEmpty),
    renderSection(DIGEST_SECTIONS.todos, todos, options.dropEmpty),
    renderSection(DIGEST_SECTIONS.current, current, options.dropEmpty),
    renderSection(DIGEST_SECTIONS.next, [next], options.dropEmpty),
    renderSection(DIGEST_SECTIONS.context, context, false),
  ]
  return blocks.filter((block): block is string => block !== null).join('\n').trim()
}

/** Last-resort single-block body for pathological budgets. */
function renderTerse(facts: DigestFacts): string {
  const files = [...facts.files.keys()].slice(0, 12).join(', ')
  const lastError = facts.errors.length > 0 ? clip(facts.errors[facts.errors.length - 1] ?? '', 120) : '（无）'
  const next = facts.todos.length > 0 ? clip(facts.todos[facts.todos.length - 1] ?? '', 120) : '（无）'
  return [
    `本段由 dsh-context-guard 确定性压缩（${facts.messageCount} 条消息 / ${facts.toolCallCount} 次工具调用，未调用模型摘要）。`,
    `- 请求：${clip(facts.lastUserText.length > 0 ? facts.lastUserText : '（无）', 160)}`,
    `- 文件：${files.length > 0 ? files : '（无）'}`,
    `- 报错：${lastError}`,
    `- 下一步：${next}`,
  ].join('\n')
}

/** The document header: identity and budget facts, never a wall clock. */
function renderHeader(meta: DigestMeta, bodyTokens: number): string {
  return [
    DIGEST_MARKER,
    `# 接力摘要（会话 ${meta.sessionId} · 第 ${meta.epoch} 次压缩）`,
    '',
    `- 会话: ${meta.sessionId}`,
    `- 第几次: ${meta.epoch}`,
    `- 原始档: ${meta.rawPath ?? '（本次未落盘）'}`,
    `- 截断区间: ${meta.regionMessages} 条消息 / ${meta.regionToolCalls} 次工具调用（≈${meta.regionTokens} tokens）`,
    `- 继承: ${meta.carriedFrom === undefined ? '无' : `第 ${meta.carriedFrom} 次`}`,
    `- 摘要正文: ≈${bodyTokens} tokens（确定性抽取，未调用模型）`,
  ].join('\n')
}

/** Hard-truncate a body so even a pathological budget terminates. */
function hardCut(body: string, targetTokens: number): string {
  const maxChars = Math.max(240, targetTokens * 3)
  return body.length <= maxChars ? body : `${body.slice(0, maxChars)}…`
}

/**
 * Compose one digest under a token budget.
 *
 * The budget is `max(MIN_TARGET_TOKENS, min(maxTokens, regionTokens × targetRatio))`
 * — a *read-cost* bound, not a context bound (only the short frame enters the
 * context; this document is read on demand), so the floor keeps a small digest
 * useful instead of degrading to three words. See {@link MIN_TARGET_TOKENS} for
 * why that floor is 260 rather than something smaller.
 *
 * @param facts - {@link extractFacts} output for this region.
 * @param meta - document identity.
 * @param options - budget knobs and the carried sections.
 */
export function composeDigest(
  facts: DigestFacts,
  meta: DigestMeta,
  options: DigestOptions = {},
): DigestResult {
  const estimator = options.estimator ?? 'cjk'
  const maxTokens = options.maxTokens ?? 800
  const targetRatio = options.targetRatio ?? 0.45
  const targetTokens = Math.max(
    MIN_TARGET_TOKENS,
    Math.min(maxTokens, Math.round(meta.regionTokens * targetRatio)),
  )
  const carried = options.carried ?? new Map<string, string[]>()

  const candidates: { tier: DigestTier; render: () => string }[] = [
    { tier: 'full', render: () => renderSections(facts, carried, { sectionCap: 6, itemChars: 160, dropEmpty: false }) },
    { tier: 'section3', render: () => renderSections(facts, carried, { sectionCap: 3, itemChars: 80, dropEmpty: true }) },
    { tier: 'section2', render: () => renderSections(facts, carried, { sectionCap: 2, itemChars: 60, dropEmpty: true }) },
    { tier: 'terse', render: () => renderTerse(facts) },
  ]

  let tier: DigestTier = 'full'
  let body = candidates[0]?.render() ?? ''
  let text = `${renderHeader(meta, estimateTextTokens(body, estimator))}\n\n${body}\n`
  for (const candidate of candidates) {
    tier = candidate.tier
    body = candidate.render()
    text = `${renderHeader(meta, estimateTextTokens(body, estimator))}\n\n${body}\n`
    if (estimateTextTokens(text, estimator) <= targetTokens) break
    if (candidate.tier === 'terse') {
      tier = 'hard-cut'
      body = hardCut(body, targetTokens)
      text = `${renderHeader(meta, estimateTextTokens(body, estimator))}\n\n${body}\n`
    }
  }

  return { text, body, tier, digestTokens: estimateTextTokens(text, estimator), targetTokens }
}

/** One parsed digest document. */
export interface ParsedDigest {
  /** Format version read from the marker. */
  version: number
  /** Section header → its bullet lines, markers stripped. */
  sections: Map<string, string[]>
}

/**
 * Parse a digest document back into sections.
 * @param text - the document.
 * @returns the parsed form, or undefined when the marker is absent.
 */
export function parseDigest(text: string): ParsedDigest | undefined {
  const marker = /<!-- context-guard-digest v(\d+) -->/.exec(text)
  if (marker === null) return undefined
  const version = Number(marker[1] ?? '0')
  const sections = new Map<string, string[]>()
  let header = ''
  for (const line of text.split('\n')) {
    const match = /^##\s+(.+?)\s*$/.exec(line)
    if (match !== null) {
      header = match[1] ?? ''
      if (!sections.has(header)) sections.set(header, [])
      continue
    }
    if (header.length === 0) continue
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    sections.get(header)?.push(trimmed.replace(/^[-*]\s+/, ''))
  }
  return { version, sections }
}

/**
 * Sections carried from a parsed previous digest, when its version matches.
 * A version mismatch degrades to "no carry-forward" rather than misreading an
 * older shape.
 */
export function carriedFrom(parsed: ParsedDigest | undefined): Map<string, string[]> {
  const carried = new Map<string, string[]>()
  if (parsed === undefined || parsed.version !== DIGEST_FORMAT_VERSION) return carried
  for (const header of CARRIED_SECTIONS) {
    const items = parsed.sections.get(header)
    if (items !== undefined && items.length > 0) carried.set(header, [...items])
  }
  return carried
}

/**
 * Absolute path of a digest referenced anywhere in one text.
 *
 * Only absolute candidates count. Prose mentions a digest by bare filename
 * (the `epoch-N.digest.md` of the format docs, `epoch-12.digest.md` in a
 * checkpoint summary), and treating those as paths invents files that were
 * never written.
 */
export function digestPathFrom(text: string): string | undefined {
  const fenced = [...text.matchAll(/`([^`\n]*\.digest\.md)`/g)].map(match => match[1] ?? '')
  const candidates = (fenced.length > 0
    ? fenced
    : [...text.matchAll(/(\/[^\s`'"，。]*\.digest\.md)/g)].map(match => match[1] ?? ''))
    .filter(candidate => path.isAbsolute(candidate))
  return candidates.length > 0 ? candidates[candidates.length - 1] : undefined
}
