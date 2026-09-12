/**
 * Resume-prompt suite: level selection, template substitution, delegation
 * detection wiring, and the always-on cap. Pure functions only.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RESUME_PROMPT,
  DEFAULT_WRAP_UP_PROMPT,
  buildWrapUpPrompt,
  decideResume,
} from '../src/resume-prompt.ts'
import type { ResumeFacts } from '../src/resume-prompt.ts'

/** Facts with every frequency-related field overridable. */
function facts(overrides: Partial<ResumeFacts> = {}): ResumeFacts {
  return {
    compactionsInWindow: 1,
    windowMinutes: 30,
    maxPerWindow: 5,
    epoch: 1,
    digestPath: '/w/.handoff/sessions/a1/epoch-1.digest.md',
    rawPath: '/w/.handoff/sessions/a1/epoch-1.raw.md',
    todos: [],
    intent: '修好移动端抽屉',
    delegationTools: [],
    ...overrides,
  }
}

describe('decideResume', () => {
  it('stays at L0 for the first compaction of the window', () => {
    const decision = decideResume(DEFAULT_RESUME_PROMPT, facts(), { escalation: true })
    expect(decision.level).toBe('L0')
    expect(decision.suppress).toBe(false)
    expect(decision.prompt).toContain('epoch-1.digest.md')
    expect(decision.prompt).toContain('epoch-1.raw.md')
    expect(decision.prompt).toContain('继续执行')
    expect(decision.prompt).not.toContain('增量推进')
  })

  it('escalates to L1 at two compactions in the window', () => {
    const decision = decideResume(DEFAULT_RESUME_PROMPT, facts({ compactionsInWindow: 2, epoch: 2 }), { escalation: true })
    expect(decision.level).toBe('L1')
    expect(decision.prompt).toContain('已自动压缩 2 次')
    expect(decision.prompt).toContain('增量推进')
    expect(decision.prompt).toContain('todo_write')
  })

  it('escalates to L2 at three, mentioning delegation only when the tool is present', () => {
    const withTool = decideResume(DEFAULT_RESUME_PROMPT, facts({
      compactionsInWindow: 3,
      delegationTools: ['subagent', 'workflow'],
    }), { escalation: true })
    expect(withTool.level).toBe('L2')
    expect(withTool.prompt).toContain('`subagent`')
    expect(withTool.prompt).toContain('`workflow`')

    const withoutTool = decideResume(DEFAULT_RESUME_PROMPT, facts({ compactionsInWindow: 3 }), { escalation: true })
    expect(withoutTool.level).toBe('L2')
    expect(withoutTool.prompt).not.toContain('subagent')
    expect(withoutTool.prompt).toContain('按需片段')
  })

  it('suppresses resume at the window cap, regardless of the escalation switch', () => {
    for (const escalation of [true, false]) {
      const decision = decideResume(DEFAULT_RESUME_PROMPT, facts({ compactionsInWindow: 5 }), { escalation })
      expect(decision.level).toBe('L3')
      expect(decision.suppress).toBe(true)
      expect(decision.prompt).toContain('不再自动续跑')
    }
  })

  it('keeps L0 wording when escalation is off but the count is low', () => {
    const decision = decideResume(DEFAULT_RESUME_PROMPT, facts({ compactionsInWindow: 3 }), { escalation: false })
    expect(decision.level).toBe('L0')
    expect(decision.prompt).not.toContain('增量推进')
  })

  it('appends pending todos and substitutes templates', () => {
    const decision = decideResume('第 {{epoch}} 次压缩（窗口 {{window}} 分钟，第 {{compactions}} 次）{{unknown}}', facts({
      compactionsInWindow: 2,
      epoch: 7,
      todos: ['改完 auth.ts', '跑回归'],
    }), { escalation: true })
    expect(decision.prompt).toContain('第 7 次压缩（窗口 30 分钟，第 2 次）{{unknown}}')
    expect(decision.prompt).toContain('未完成待办：')
    expect(decision.prompt).toContain('- 改完 auth.ts')
    expect(decision.prompt).toContain('- 跑回归')
  })

  it('names the digest placeholder even when the backend wrote none', () => {
    const decision = decideResume(DEFAULT_RESUME_PROMPT, facts({ digestPath: undefined, rawPath: undefined }), { escalation: true })
    expect(decision.prompt).toContain('（本次未生成摘要文件）')
    expect(decision.prompt).toContain('（本次未生成归档文件）')
  })
})

describe('buildWrapUpPrompt', () => {
  it('renders the built-in template and appends the live todo list', () => {
    const prompt = buildWrapUpPrompt(DEFAULT_WRAP_UP_PROMPT, ['未完成任务 A'])
    expect(prompt).toContain('收尾')
    expect(prompt).toContain('todo_write')
    expect(prompt).toContain('接力总结')
    expect(prompt).toContain('- 未完成任务 A')
  })

  it('substitutes {{todos}} and stays empty when the template is disabled', () => {
    expect(buildWrapUpPrompt('待办：{{todos}}', ['A', 'B'])).toContain('待办：A / B')
    expect(buildWrapUpPrompt('', ['A'])).toContain('- A')
  })
})
