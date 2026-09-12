/**
 * Resume-prompt suite: level selection, template substitution, delegation
 * detection wiring, and the always-on cap. Pure functions only.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RESUME_PROMPT,
  DEFAULT_WRAP_UP_PROMPT,
  archiveClause,
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
    // The handoff clause states plainly that nothing was archived, instead of
    // claiming the history was archived and then naming a missing file.
    expect(decision.prompt).toContain('本次压缩没有生成归档文档')
  })
})

describe('archiveClause', () => {
  it('states that the document exists and where, without demanding a read', () => {
    expect(archiveClause(facts({ epoch: 4 }))).toBe([
      '本次压缩的交接文档（上一段上下文的归档）：',
      '- 精简接力摘要（建议先读）：`/w/.handoff/sessions/a1/epoch-1.digest.md`',
      '- 完整原文归档（需要细节时再读）：`/w/.handoff/sessions/a1/epoch-1.raw.md`',
      '不要求通读，但请知道它在那里，需要时可直接 read。',
    ].join('\n'))
  })

  it('names only the digest when that is all the backend wrote', () => {
    const clause = archiveClause(facts({ rawPath: undefined }))
    expect(clause).toContain('epoch-1.digest.md')
    expect(clause).not.toContain('完整原文归档')
    expect(clause).toContain('不要求通读')
  })

  it('says plainly that nothing was archived instead of claiming otherwise', () => {
    expect(archiveClause(facts({ digestPath: undefined, rawPath: undefined })))
      .toBe('本次压缩没有生成归档文档；上面那段摘要就是本次压缩的全部交接内容。')
  })

  it('is rendered into the built-in template and never asks the agent to check the file', () => {
    const prompt = decideResume(DEFAULT_RESUME_PROMPT, facts(), { escalation: true }).prompt
    expect(prompt).toContain('本次压缩的交接文档')
    expect(prompt).toContain('epoch-1.digest.md')
    expect(prompt).toContain('epoch-1.raw.md')
    // The guard checked the filesystem; the agent is only told, not sent to verify.
    expect(prompt).not.toContain('确认')
    expect(prompt).not.toContain('是否存在')
  })

  it('is part of the L3 notice too, so a suppressed resume still points at the archive', () => {
    const prompt = decideResume(DEFAULT_RESUME_PROMPT, facts({ compactionsInWindow: 5 }), { escalation: true }).prompt
    expect(prompt).toContain('本次压缩的交接文档')
    expect(prompt).toContain('epoch-1.digest.md')
  })
})

describe('buildWrapUpPrompt', () => {
  /** Facts as the guard computes them: note path in the session's own directory. */
  const note = {
    epoch: 3,
    notePath: '/w/.handoff/sessions/a1/epoch-3.handoff.md',
  }

  it('renders the built-in template and appends the live todo list', () => {
    const prompt = buildWrapUpPrompt(DEFAULT_WRAP_UP_PROMPT, { todos: ['未完成任务 A'], ...note })
    expect(prompt).toContain('收尾')
    expect(prompt).toContain('todo_write')
    expect(prompt).toContain('接力总结')
    expect(prompt).toContain('- 未完成任务 A')
  })

  it('names the session-scoped note and its compaction number', () => {
    const prompt = buildWrapUpPrompt(DEFAULT_WRAP_UP_PROMPT, { todos: [], ...note })
    // The path is the session's own directory, not the flat .handoff/ inbox.
    expect(prompt).toContain('`/w/.handoff/sessions/a1/epoch-3.handoff.md`')
    expect(prompt).not.toContain('.handoff/ 目录下的一个 md 文件')
    // Both the title and the prose carry the ordinal.
    expect(prompt).toContain('# 第 3 次压缩 · 接力笔记 · <一句话主题>')
    expect(prompt).toContain('本会话第 3 次压缩')
  })

  it('substitutes {{todos}} and stays empty when the template is disabled', () => {
    expect(buildWrapUpPrompt('待办：{{todos}}', { todos: ['A', 'B'], ...note })).toContain('待办：A / B')
    expect(buildWrapUpPrompt('', { todos: ['A'], ...note })).toContain('- A')
  })

  it('leaves an unknown placeholder visible rather than dropping it', () => {
    expect(buildWrapUpPrompt('{{what}}', { todos: [], ...note })).toContain('{{what}}')
  })
})
