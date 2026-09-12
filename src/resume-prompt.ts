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
  + '1) 若任务尚未完成，把关键状态写入工作区 .handoff/ 目录下的一个 md 文件'
  + '（涉及的文件路径、已做决策、未完成项、下一步），文件名自定，并在下面的接力总结中给出该路径；\n'
  + '2) 用 todo_write 把未完成项写成待办清单（它会被自动摘要带进下一段上下文）；\n'
  + '3) 在回复末尾输出一段 ≤200 字、自包含的接力总结（截断后它将是上下文里唯一的对话帧）；\n'
  + '4) 不要启动新的子任务或继续深入探索，完成后停止。'

/** Default continuation prompt: pick the task back up from the digested state. */
export const DEFAULT_RESUME_PROMPT =
  '上下文已压缩（历史已确定性归档）。精简接力摘要（优先读）：`{{digest}}`；'
  + '完整原始记录（需要细节时）：`{{raw}}`。\n'
  + '需要细节时用 read 按需读取，不要在上下文中复述已归档内容；'
  + '然后继续执行压缩前正在进行的任务，直到任务完成。'

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
  /** Pending todo items at resume time. */
  todos: string[]
  /** Last direct human request, clipped. */
  intent?: string | undefined
  /** Delegation-capable tool names present in the session's request header. */
  delegationTools: string[]
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
      + '3) 若仍无法收敛，把当前状态写入工作区 .handoff/ 下的一个 md 文件，停下并向用户报告。'
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
        + '为避免压缩—续跑空转，本次不再自动续跑。归档与摘要已落盘，'
        + '请查看后由用户决定如何继续（直接发消息继续，或把任务拆小）。',
    }
  }
  const level: ResumeLevel = !policy.escalation || facts.compactionsInWindow <= 1
    ? 'L0'
    : facts.compactionsInWindow >= 3 ? 'L2' : 'L1'
  const base = substitute(template, {
    epoch: String(facts.epoch),
    window: String(facts.windowMinutes),
    compactions: String(facts.compactionsInWindow),
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
 * @param todos - pending todos at wrap-up time, when the session has any.
 */
export function buildWrapUpPrompt(template: string, todos: readonly string[]): string {
  return `${substitute(template, { todos: todos.join(' / ') }).trimEnd()}${todoBlock(todos)}`
}
