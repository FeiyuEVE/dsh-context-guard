/**
 * Guard-side readers over one session's durable log.
 *
 * Every fact the resume decision needs is derived from the log rather than
 * kept in plugin state, so it survives a plugin reload, a process restart, and
 * a fork: compaction frequency, the entering tool set, the pending todo list,
 * and the last human request.
 *
 * Two reads are structural on purpose. `todo/write` and the `agent-instructions`
 * / `skill-catalog` source kinds come from packages this plugin does not depend
 * on; depending on them would add peer-dependency surface and a version matrix
 * entry for two field reads, so the shapes are declared locally and read
 * defensively. A missing or reshaped payload degrades to "no facts" instead of
 * throwing.
 *
 * @module dsh-context-guard/session-facts
 */

import type { Session } from '@deepseek-ai/dsh-session'
import { clip } from './digest.ts'

/** How often one session has compacted, and how recently. */
export interface CompactionPace {
  /** Successful automatic compactions inside the window, after the last human turn. */
  autoInWindow: number
  /** Successful automatic compactions in this session. */
  autoTotal: number
  /** Successful manual compactions (`/compact`) in this session. */
  manualTotal: number
  /** Successful compactions of any kind in this session. */
  sessionTotal: number
}

/**
 * Measure compaction frequency for one session.
 *
 * Only *automatic* compactions count towards the window: a human running
 * `/compact` deliberately is not evidence that the task is context-hungry.
 * The window additionally resets at the last human message, so a new request
 * does not inherit the previous task's escalation level.
 *
 * @param session - session whose log is folded.
 * @param now - current time, epoch milliseconds.
 * @param windowMinutes - sliding window length.
 */
export function compactionPace(session: Session, now: number, windowMinutes: number): CompactionPace {
  const windowMs = Math.max(1, windowMinutes) * 60_000
  let anchorSeq = -1
  let autoTotal = 0
  let manualTotal = 0
  let sessionTotal = 0
  let autoInWindow = 0
  for (const event of session.snapshotEvents()) {
    if (event.type === 'user/message' && event.data.source.kind === 'user') {
      anchorSeq = event.seq
      continue
    }
    if (event.type !== 'compaction/end' || event.data.error !== undefined) continue
    sessionTotal += 1
    if (event.data.sourceCommandId !== undefined) {
      manualTotal += 1
      continue
    }
    autoTotal += 1
    if (event.seq > anchorSeq && now - event.time <= windowMs) autoInWindow += 1
  }
  return { autoInWindow, autoTotal, manualTotal, sessionTotal }
}

/** Tool names the session's next request will carry, in header order. */
export function availableToolNames(session: Session): string[] {
  const tools = session.requestHeader()?.tools
  if (tools === undefined) return []
  return tools.map(tool => tool.name)
}

/** One `todo/write` payload entry, read structurally. */
interface TodoItemLike {
  content?: unknown
  status?: unknown
}

/** Pending todo contents from the newest `todo/write` snapshot. */
export function pendingTodos(session: Session): string[] {
  let latest: string[] = []
  for (const event of session.snapshotEvents()) {
    // Widened: `todo/write` is declared by a package this plugin does not import.
    if ((event.type as string) !== 'todo/write') continue
    const data = event.data as unknown as { todos?: unknown }
    if (!Array.isArray(data.todos)) continue
    const items: string[] = []
    for (const entry of data.todos) {
      if (typeof entry !== 'object' || entry === null) continue
      const record = entry as TodoItemLike
      const content = typeof record.content === 'string' ? record.content.trim() : ''
      const status = typeof record.status === 'string' ? record.status : 'pending'
      if (content.length === 0 || status === 'completed') continue
      items.push(content)
    }
    latest = items
  }
  return latest
}

/** The most recent direct human request, clipped. */
export function lastHumanIntent(session: Session, itemChars = 160): string | undefined {
  let latest: string | undefined
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'user/message' || event.data.source.kind !== 'user') continue
    const text = event.data.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    if (text.trim().length > 0) latest = clip(text, itemChars)
  }
  return latest
}

/** Checkpoint frame text of one compaction, once its summary has landed. */
export function checkpointText(session: Session, compactionId: string): string {
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'compaction/summary' || String(event.data.compactionId) !== compactionId) continue
    return event.data.summary
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
  }
  return ''
}
