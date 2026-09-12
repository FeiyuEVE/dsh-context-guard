/**
 * Prompt builders for the two injections the guard owns.
 *
 * A fixed continuation prompt says "keep going" no matter what happened. After
 * a second compaction in a short window that instruction is demonstrably
 * useless — the agent already kept going, and the working style, not the
 * instruction, is what has to change. The builders below therefore render one
 * *fact-anchored* prompt whose escalation level follows measured compaction
 * frequency, and which mentions delegation only when the session's own request
 * header actually carries a delegation tool.
 *
 * Everything here is a pure function of its inputs, so level selection and
 * template rendering are golden-testable without a running loop.
 *
 * @module dsh-context-guard/resume-prompt
 */

/** Default wrap-up reminder: finish, externalize state, hand off, stop. */
export const DEFAULT_WRAP_UP_PROMPT =
  '当前会话上下文已接近上限，即将被截断为「本回复 + 归档指针」。请立即收尾：\n'
  + '1) 若任务尚未完成，把关键状态写入 `{{notePath}}`；该文件**第一行标题**必须是 '
  + '`# 第 {{epoch}} 次压缩 · 接力笔记 · <一句话主题>`（本会话第 {{epoch}} 次压缩），'
  + '正文写涉及的文件路径、已做决策、未完成项、下一步，并在下面的接力总结中给出该路径；\n'
  + '2) 用 todo_write 把未完成项写成待办清单（它会被自动摘要带进下一段上下文）；\n'
  + '3) 在回复末尾输出一段 ≤200 字、自包含的接力总结（截断后它将是上下文里唯一的对话帧）；\n'
  + '4) 不要启动新的子任务或继续深入探索，完成后停止。'

/**
 * Default continuation prompt: pick the task back up from the digested state.
 *
 * `{{archive}}` renders the handoff-document clause — written to state plainly
 * that the document exists and where it is, and to say so only when it really
 * does (see {@link archiveClause}). It never asks the agent to verify the file:
 * the guard checked the filesystem before rendering, and an existence check by
 * the model would be a wasted step. `{{digest}}`/`{{raw}}` stay available for
 * hand-written templates.
 */
export const DEFAULT_RESUME_PROMPT =
  '上下文已压缩。\n'
  + '{{archive}}\n'
  + '然后继续执行压缩前正在进行的任务，直到任务完成；'
  + '需要更多细节时再按需 read，不必在上下文中复述整份归档。'

/** Escalation level of one resume decision. */
export type ResumeLevel = 'L0' | 'L1' | 'L2' | 'L3'

/** Measured facts one resume decision is made from. */
export interface ResumeFacts {
  /** Successful automatic compactions inside the window, after the last human turn. */
  compactionsInWindow: number
  /** Window length the count was measured over, minutes. */
  windowMinutes: number
  /** Count at or above which resume is suppressed. */
  maxPerWindow: number
  /** This session's compaction number. */
  epoch: number
  /** Digest document to read first, when the backend produced one. */
  digestPath?: string | undefined
  /** Lossless archive of the compacted region, when the backend produced one. */
  rawPath?: string | undefined
  /**
   * Size of {@link rawPath} in bytes, when known.
   *
   * The raw archive is the complete record of the region, so it is large by
   * design (measured: 401 messages → 286 KB ≈ 64k tokens, about 59% of the
   * region it replaces). Stating the size is what keeps the prompt from reading
   * as an invitation to open it: reading it whole would re-inflate the context
   * the compaction just cleared.
   */
  rawBytes?: number | undefined
  /** Estimated tokens of the digest named by {@link digestPath}. */
  digestTokens?: number | undefined
  /** Pending todo items at resume time. */
  todos: string[]
  /** Last direct human request, clipped. */
  intent?: string | undefined
  /** This session's archive directory, so an L2 stop-note lands there too. */
  noteDir?: string | undefined
  /** Delegation-capable tool names present in the session's request header. */
  delegationTools: string[]
}

/** Measured facts one wrap-up reminder is rendered from. */
export interface WrapUpFacts {
  /** Pending todo items at wrap-up time. */
  todos: string[]
  /** Number the coming compaction will carry for this session (1-based). */
  epoch: number
  /** Absolute path the note must be written to (session directory). */
  notePath: string
}

/** Policy switches governing level selection. */
export interface ResumePolicy {
  /** Whether frequency escalates the prompt text (the L3 cap applies regardless). */
  escalation: boolean
}

/** The rendered decision. */
export interface ResumeDecision {
  /** Selected level. */
  level: ResumeLevel
  /** Whether the caller must skip `followup` and only record a notice. */
  suppress: boolean
  /** Prompt to inject; empty when suppressed. */
  prompt: string
}

/** Values substituted into `{{placeholders}}`; unknown placeholders survive. */
function substitute(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match)
}

/** Human-readable tool list for the delegation sentence. */
function toolList(tools: readonly string[]): string {
  return tools.map(tool => `\`${tool}\``).join(' / ')
}

/** Byte size a person can read at a glance. */
function humanBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

/**
 * Rough token count of an archive document, so the clause can warn about size.
 *
 * Deliberately cheap and approximate (4 bytes per token, rounded to 1k): this
 * only has to tell the reader "tens of thousands, do not open it whole". The
 * exact figure the digest itself reports comes from the real estimator.
 */
function humanTokens(bytes: number): string {
  const tokens = Math.ceil(bytes / 4 / 1000) * 1000
  return tokens >= 1000 ? `≈${Math.round(tokens / 1000)}k` : `≈${tokens}`
}

/**
 * The handoff-document clause: what this compaction archived, or that it
 * archived nothing.
 *
 * Only the caller that really checked the filesystem may pass these paths, so
 * this clause can state the document's existence as a fact — and when there is
 * nothing to name it says exactly that, instead of an unconditional claim that
 * the history was archived.
 *
 * @param facts - measured facts; `digestPath`/`rawPath` are confirmed to exist.
 */
export function archiveClause(facts: ResumeFacts): string {
  const { digestPath, rawPath, rawBytes, digestTokens } = facts
  if (digestPath === undefined && rawPath === undefined) {
    return '本次压缩没有生成归档文档；上面那段摘要就是本次压缩的全部交接内容。'
  }
  const lines = ['本次压缩的交接文档（上一段上下文的归档）：']
  if (digestPath !== undefined) {
    const size = digestTokens === undefined ? '' : `，约 ${digestTokens} tokens`
    lines.push(`- 接力摘要（先读这份${size}）：\`${digestPath}\``)
  }
  if (rawPath !== undefined) {
    const size = rawBytes === undefined ? '' : `，约 ${humanBytes(rawBytes)} / ${humanTokens(rawBytes)} tokens`
    lines.push(`- 完整原文归档（按需检索用，**不要整份读入**${size}）：\`${rawPath}\``)
  }
  lines.push(
    rawPath === undefined
      ? '不要求通读，但请知道它在那里，需要时可直接 read。'
      : '原文归档是那段历史的完整记录，体量与被压缩掉的上下文相当 —— 整份读进来会把刚腾出的空间又填回去。'
        + '需要细节时请先 grep 定位，再局部 read 那几段。',
  )
  return lines.join('\n')
}

/** One-line account of the pending todos, for prompt tails. */
function todoBlock(todos: readonly string[]): string {
  if (todos.length === 0) return ''
  return `\n未完成待办：\n${todos.slice(0, 8).map(item => `- ${item}`).join('\n')}`
}

/** The level-specific instruction appended after the base template. */
function levelBlock(level: ResumeLevel, facts: ResumeFacts): string {
  const window = String(facts.windowMinutes)
  const count = String(facts.compactionsInWindow)
  if (level === 'L1') {
    return `\n注意：${window} 分钟内本会话已自动压缩 ${count} 次。请改为增量推进：`
      + '只读归档中确需的片段，已确认的结论写进 todo_write，不要重新探索已知内容。'
  }
  if (level === 'L2') {
    const head = `\n本会话已连续压缩 ${count} 次，说明单上下文放不下这项工作。请先拆分再继续：\n`
    const delegation = facts.delegationTools.length > 0
      ? `1) 检索、批量阅读、漫游式探索交给 ${toolList(facts.delegationTools)}（只把结论带回主线）；\n`
        + '2) 主线只保留决策与编辑；\n'
      : '1) 大文件阅读切成按需片段（用 read 精确取片，而不是整文件通读）；\n'
        + '2) 已确认的结论写进 todo_write，不要留在上下文里；\n'
    return head + delegation
      + `3) 若仍无法收敛，把当前状态写入 \`${facts.noteDir ?? '.handoff/'}\` 下的一个 md 文件，`
      + '停下并向用户报告。'
  }
  return ''
}

/**
 * Decide the level and render the continuation prompt.
 *
 * The cap is deliberately independent of {@link ResumePolicy.escalation}:
 * escalation governs wording, while the cap is the safety valve that stops a
 * compaction/resume loop from silently burning tokens.
 *
 * @param template - base continuation template (settings/config/built-in).
 * @param facts - measured facts.
 * @param policy - escalation switch.
 */
export function decideResume(template: string, facts: ResumeFacts, policy: ResumePolicy): ResumeDecision {
  const overCap = facts.maxPerWindow > 0 && facts.compactionsInWindow >= facts.maxPerWindow
  if (overCap) {
    return {
      level: 'L3',
      suppress: true,
      prompt: `本会话在 ${facts.windowMinutes} 分钟内已自动压缩 ${facts.compactionsInWindow} 次；`
        + '为避免压缩—续跑空转，本次不再自动续跑。'
        + `${archiveClause(facts)}\n`
        + '请由用户决定如何继续（直接发消息继续，或把任务拆小）。',
    }
  }
  const level: ResumeLevel = !policy.escalation || facts.compactionsInWindow <= 1
    ? 'L0'
    : facts.compactionsInWindow >= 3 ? 'L2' : 'L1'
  const base = substitute(template, {
    epoch: String(facts.epoch),
    window: String(facts.windowMinutes),
    compactions: String(facts.compactionsInWindow),
    archive: archiveClause(facts),
    digest: facts.digestPath ?? '（本次未生成摘要文件）',
    raw: facts.rawPath ?? '（本次未生成归档文件）',
    intent: facts.intent ?? '',
  })
  return {
    level,
    suppress: false,
    prompt: `${base.trimEnd()}${levelBlock(level, facts)}${todoBlock(facts.todos)}`,
  }
}

/**
 * Render the wrap-up reminder.
 * @param template - wrap-up template (settings/config/built-in).
 * @param facts - measured facts: pending todos, the coming compaction's number,
 *   and the note path that number determines.
 */
export function buildWrapUpPrompt(template: string, facts: WrapUpFacts): string {
  return `${substitute(template, {
    todos: facts.todos.join(' / '),
    epoch: String(facts.epoch),
    notePath: facts.notePath,
  }).trimEnd()}${todoBlock(facts.todos)}`
}
