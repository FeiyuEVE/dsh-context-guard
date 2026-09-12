/**
 * Session-facts suite: the log-derived inputs of the resume decision, driven
 * through a minimal fake session (the readers only touch `snapshotEvents` and
 * `requestHeader` by design).
 */

import { describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  availableToolNames,
  checkpointText,
  compactionPace,
  lastHumanIntent,
  pendingTodos,
} from '../src/session-facts.ts'

interface FakeEvent {
  type: string
  seq: number
  time: number
  data: Record<string, unknown>
}

/** A session-shaped double exposing only what the readers are allowed to use. */
function fakeSession(events: FakeEvent[], tools?: string[]): Session {
  return {
    snapshotEvents: () => events,
    requestHeader: () => tools === undefined
      ? undefined
      : { tools: tools.map(name => ({ name, description: '', parameters: {} })) },
  } as unknown as Session
}

/** One `user/message` event. */
function userMessage(seq: number, time: number, kind: 'user' | 'plugin', text: string): FakeEvent {
  return {
    type: 'user/message',
    seq,
    time,
    data: {
      role: 'user',
      content: [{ type: 'text', text }],
      source: kind === 'user' ? { kind: 'user' } : { kind: 'plugin', plugin: 'context-guard', form: 'notice', summary: text },
    },
  }
}

/** One `compaction/end` event. */
function compactionEnd(seq: number, time: number, options: { error?: string; manual?: boolean } = {}): FakeEvent {
  return {
    type: 'compaction/end',
    seq,
    time,
    data: {
      compactionId: `c${seq}`,
      turn: null,
      ...options.manual === true ? { sourceCommandId: 'cmd1' } : {},
      ...options.error === undefined ? {} : { error: options.error },
    },
  }
}

describe('compactionPace', () => {
  const now = 1_700_000_000_000
  const minute = 60_000

  it('counts automatic compactions inside the window and ignores manual ones', () => {
    const session = fakeSession([
      userMessage(1, now - 10 * minute, 'user', '任务 A'),
      compactionEnd(2, now - 8 * minute),
      compactionEnd(3, now - 6 * minute, { manual: true }),
      compactionEnd(4, now - 4 * minute),
      compactionEnd(5, now - 2 * minute, { error: 'failed' }),
    ])
    const pace = compactionPace(session, now, 30)
    expect(pace.autoInWindow).toBe(2)
    expect(pace.autoTotal).toBe(2)
    expect(pace.manualTotal).toBe(1)
    expect(pace.sessionTotal).toBe(3)
  })

  it('drops out-of-window compactions and resets at a new human turn', () => {
    const session = fakeSession([
      userMessage(1, now - 90 * minute, 'user', '旧任务'),
      compactionEnd(2, now - 80 * minute),
      compactionEnd(3, now - 60 * minute),
      // A new human request starts a fresh accounting: only compactions after
      // it count, so the previous task's escalation is not inherited.
      userMessage(4, now - 10 * minute, 'user', '新任务'),
      compactionEnd(5, now - 9 * minute),
      compactionEnd(6, now - 8 * minute),
    ])
    const pace = compactionPace(session, now, 30)
    expect(pace.autoInWindow).toBe(2)
    expect(pace.autoTotal).toBe(4)
  })

  it('treats a plugin message as no anchor', () => {
    const session = fakeSession([
      userMessage(1, now - 1 * minute, 'plugin', '上下文已压缩，已恢复任务'),
      compactionEnd(2, now),
    ])
    expect(compactionPace(session, now, 30).autoInWindow).toBe(1)
  })
})

describe('availableToolNames', () => {
  it('reads the entering request header, empty when there is none', () => {
    expect(availableToolNames(fakeSession([], ['subagent', 'read']))).toEqual(['subagent', 'read'])
    expect(availableToolNames(fakeSession([]))).toEqual([])
  })
})

describe('pendingTodos', () => {
  it('keeps the newest snapshot and drops completed entries', () => {
    const session = fakeSession([
      { type: 'todo/write', seq: 1, time: 0, data: { todos: [{ content: '旧的', status: 'pending' }] } },
      { type: 'todo/write', seq: 2, time: 0, data: { todos: [
        { content: '写文档', status: 'completed' },
        { content: '改代码', status: 'in_progress' },
      ] } },
    ])
    expect(pendingTodos(session)).toEqual(['改代码'])
  })

  it('tolerates a malformed payload', () => {
    const session = fakeSession([
      { type: 'todo/write', seq: 1, time: 0, data: { todos: 'nope' } },
      { type: 'todo/write', seq: 2, time: 0, data: { todos: [null, { content: '' }, { content: ' 有效 ' }] } },
    ])
    expect(pendingTodos(session)).toEqual(['有效'])
  })
})

describe('lastHumanIntent', () => {
  it('skips plugin messages and clips the result', () => {
    const session = fakeSession([
      userMessage(1, 0, 'user', '第一个请求'),
      userMessage(2, 0, 'plugin', '不要看这条'),
      userMessage(3, 0, 'user', 'x'.repeat(500)),
    ])
    const intent = lastHumanIntent(session, 40)
    expect(intent).toHaveLength(40)
    expect(intent?.endsWith('…')).toBe(true)
    expect(intent).not.toContain('不要看这条')
  })
})

describe('checkpointText', () => {
  it('joins the summary text of the matching compaction only', () => {
    const session = fakeSession([
      { type: 'compaction/summary', seq: 1, time: 0, data: { compactionId: 'a', summary: [{ type: 'text', text: '帧 A' }] } },
      { type: 'compaction/summary', seq: 2, time: 0, data: { compactionId: 'b', summary: [{ type: 'text', text: '帧 B' }] } },
    ])
    expect(checkpointText(session, 'b')).toBe('帧 B')
    expect(checkpointText(session, 'missing')).toBe('')
  })
})
