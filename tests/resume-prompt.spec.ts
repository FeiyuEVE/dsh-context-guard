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

/** The built-in reminder, pinned verbatim so a silent reword cannot slip through. */
const WRAP_UP_GOLDEN = [
  '当前上下文已经很长了 —— 这不是因为碰到了上限，而是因为上下文越长，后续每次请求越贵。',
  '所以请收尾，但不是必须立刻停手：先把**不适合中断**的事情做完（正在进行的编辑、已经发出还没拿到结果的命令、当次工具调用的收尾），不要再展开新的探索或大范围重读。然后：',
  '1) 把当前正在负责的工单同步到待办平台（本会话挂了 `task_platform` MCP 时用 `change_ticket_status` 推阶段、`add_comment` 记结论与证据；没挂就写清工单号与状态）：**新出现的待办必须先 `create_ticket` 建单**，不许只留在对话里；连一张工单都没接的临时活，也先建单再继续；',
  '2) 用 todo_write 写一份短清单（只作本段上下文被摘要后的临时补充，权威状态在单据上）；',
  '3) 在回复末尾输出一段 ≤200 字、自包含的接力总结：结论 + 工单号 + 下一步（截断后它是上下文里唯一的对话帧）；',
  '4) 收尾完成后停下即可。',
].join('\n')

/** The built-in continuation, pinned verbatim: tickets first, no archive read. */
const RESUME_GOLDEN = [
  '上下文已压缩。',
  '先看单据，不要凭对话记忆：用 `task_platform` 的 `list_tickets` / `get_ticket` 拉出当前负责的工单（需要结论与证据细节时用 `list_comments`），确认每张单的阶段与最近一条记录；以工单状态为准确认进度，然后继续执行未完成的工单，直到该工单被推进到应到的状态。',
  '本段没有单据信息时，先用 todo_write 里的清单兜底，并立即把缺的工单补建到待办平台。',
].join('\n')

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

describe('built-in templates', () => {
  it('pins the wrap-up reminder verbatim and hands state to the ticket platform', () => {
    expect(DEFAULT_WRAP_UP_PROMPT).toBe(WRAP_UP_GOLDEN)
    expect(DEFAULT_WRAP_UP_PROMPT).toContain('task_platform')
    expect(DEFAULT_WRAP_UP_PROMPT).toContain('`change_ticket_status`')
    expect(DEFAULT_WRAP_UP_PROMPT).toContain('`add_comment`')
    expect(DEFAULT_WRAP_UP_PROMPT).toContain('`create_ticket`')
    expect(DEFAULT_WRAP_UP_PROMPT).toContain('接力总结')
  })

  it('keeps the default wrap-up reminder free of the note-file hand-off', () => {
    // The placeholder still exists for custom templates; the built-in text no
    // longer sends the agent to a `.handoff` note.
    expect(DEFAULT_WRAP_UP_PROMPT).not.toContain('notePath')
    expect(DEFAULT_WRAP_UP_PROMPT).not.toContain('.handoff')
    expect(DEFAULT_WRAP_UP_PROMPT).not.toContain('接力笔记')
  })

  it('pins the resume prompt verbatim and starts from the tickets', () => {
    expect(DEFAULT_RESUME_PROMPT).toBe(RESUME_GOLDEN)
    expect(DEFAULT_RESUME_PROMPT).toContain('task_platform')
    expect(DEFAULT_RESUME_PROMPT).toContain('`list_tickets`')
    expect(DEFAULT_RESUME_PROMPT).toContain('`get_ticket`')
    expect(DEFAULT_RESUME_PROMPT).toContain('`list_comments`')
  })

  it('keeps the archive clause out of the default resume prompt', () => {
    expect(DEFAULT_RESUME_PROMPT).not.toContain('{{archive}}')
    expect(DEFAULT_RESUME_PROMPT).not.toContain('digest')
    const prompt = decideResume(DEFAULT_RESUME_PROMPT, facts(), { escalation: true }).prompt
    expect(prompt).not.toContain('本次压缩的交接文档')
    expect(prompt).not.toContain('/w/.handoff/sessions/a1/epoch-1.digest.md')
  })
})

describe('decideResume', () => {
  it('stays at L0 for the first compaction of the window', () => {
    const decision = decideResume(DEFAULT_RESUME_PROMPT, facts(), { escalation: true })
    expect(decision.level).toBe('L0')
    expect(decision.suppress).toBe(false)
    expect(decision.prompt).toContain('task_platform')
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
    // The L2 stop-note now lands on the ticket platform, not in `.handoff`.
    expect(withoutTool.prompt).not.toContain('.handoff')
    expect(withoutTool.prompt).toContain('task_platform')
    expect(withoutTool.prompt).toContain('`add_comment`')
    expect(withoutTool.prompt).toContain('`change_ticket_status`')
    expect(withoutTool.prompt).toContain('再停下向用户报告')
  })

  it('carries the division of labour on a continuation that can delegate', () => {
    const decision = decideResume(DEFAULT_RESUME_PROMPT, facts({
      delegationTools: ['subagent', 'subagent_fork'],
    }), { escalation: true })
    expect(decision.level).toBe('L0')
    expect(decision.prompt).toContain('分工：主线（你）负责规划、验收与汇报')
    expect(decision.prompt).toContain('`subagent` / `subagent_fork`')
    expect(decision.prompt).toContain('回来先核证据')
  })

  it('omits the division clause for a session that cannot delegate, and for a suppressed resume', () => {
    const withoutTools = decideResume(DEFAULT_RESUME_PROMPT, facts(), { escalation: true })
    expect(withoutTools.prompt).not.toContain('分工：主线')

    const suppressed = decideResume(DEFAULT_RESUME_PROMPT, facts({
      compactionsInWindow: 5,
      delegationTools: ['subagent'],
    }), { escalation: true })
    expect(suppressed.suppress).toBe(true)
    expect(suppressed.prompt).not.toContain('分工：主线')
  })

  it('renders the division clause exactly once at L2, where the split advice builds on it', () => {
    const decision = decideResume(DEFAULT_RESUME_PROMPT, facts({
      compactionsInWindow: 3,
      delegationTools: ['subagent'],
    }), { escalation: true })
    expect(decision.prompt.match(/分工：主线/g)).toHaveLength(1)
    expect(decision.prompt).toContain('按上面的分工')
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

  it('substitutes {{archive}} and {{digest}} for a custom template', () => {
    const decision = decideResume('{{archive}}\n摘要：{{digest}}\n继续执行。', facts(), { escalation: true })
    expect(decision.prompt).toContain('本次压缩的交接文档')
    expect(decision.prompt).toContain('/w/.handoff/sessions/a1/epoch-1.digest.md')
    expect(decision.prompt).toContain('继续执行')
  })

  it('renders the no-archive clause when a custom template asks and nothing was written', () => {
    const decision = decideResume('{{archive}}', facts({ digestPath: undefined, rawPath: undefined }), { escalation: true })
    // The handoff clause states plainly that nothing was archived, instead of
    // claiming the history was archived and then naming a missing file.
    expect(decision.prompt).toContain('本次压缩没有生成归档文档')
  })
})

describe('archiveClause', () => {
  it('states that the document exists and where, without demanding a read', () => {
    expect(archiveClause(facts({ epoch: 4 }))).toBe([
      '本次压缩的交接文档（上一段上下文的归档）：',
      '- 接力摘要（先读这份）：`/w/.handoff/sessions/a1/epoch-1.digest.md`',
      '- 完整原文归档（按需检索用，**不要整份读入**）：`/w/.handoff/sessions/a1/epoch-1.raw.md`',
      '原文归档是那段历史的完整记录，体量与被压缩掉的上下文相当 ——'
        + ' 整份读进来会把刚腾出的空间又填回去。需要细节时请先 grep 定位，再局部 read 那几段。',
    ].join('\n'))
  })

  it('sizes both documents so the reader can judge before opening them', () => {
    // The raw archive is the complete record: measured at 286 KB / ~64k tokens
    // for a 401-message region, i.e. about 59% of what the compaction replaced.
    // Offering it without a size reads as "go and read this", which would refill
    // the context the compaction just cleared.
    const clause = archiveClause(facts({ rawBytes: 285_971, digestTokens: 478 }))
    expect(clause).toContain('约 478 tokens')
    expect(clause).toContain('279 KB')
    expect(clause).toContain('72k tokens')
    expect(clause).toContain('不要整份读入')
    expect(clause).toContain('grep')
  })

  it('does not repeat the size when the caller did not measure it', () => {
    const clause = archiveClause(facts())
    expect(clause).toContain('不要整份读入')
    expect(clause).not.toContain('KB')
    expect(clause).not.toContain('tokens')
  })

  it('names only the digest when that is all the backend wrote', () => {
    const clause = archiveClause(facts({ rawPath: undefined }))
    expect(clause).toContain('epoch-1.digest.md')
    expect(clause).not.toContain('完整原文归档')
    expect(clause).toContain('不要求通读')
    // With no raw archive there is nothing to warn about reading whole.
    expect(clause).not.toContain('grep')
  })

  it('says plainly that nothing was archived instead of claiming otherwise', () => {
    expect(archiveClause(facts({ digestPath: undefined, rawPath: undefined })))
      .toBe('本次压缩没有生成归档文档；上面那段摘要就是本次压缩的全部交接内容。')
  })

  it('is rendered into a custom template and never asks the agent to check the file', () => {
    const prompt = decideResume('{{archive}}', facts(), { escalation: true }).prompt
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
    expect(prompt).toContain('task_platform')
    expect(prompt).toContain('todo_write')
    expect(prompt).toContain('接力总结')
    expect(prompt).toContain('- 未完成任务 A')
  })

  it('asks softly: wrapping up is not a hard stop, and the reason given is cost', () => {
    // The reminder fires on a fraction of the window and can land in the same
    // step as an automatic goal round whose own instruction is "keep going", so
    // it must not read as "stop now" beside it.
    expect(DEFAULT_WRAP_UP_PROMPT).toContain('不是必须立刻停手')
    expect(DEFAULT_WRAP_UP_PROMPT).toContain('不适合中断')
    expect(DEFAULT_WRAP_UP_PROMPT).toContain('越贵')
    expect(DEFAULT_WRAP_UP_PROMPT).not.toContain('立即收尾')
    expect(DEFAULT_WRAP_UP_PROMPT).not.toContain('接近上限')
  })

  it('no longer names a note file, while custom templates can still use {{notePath}}', () => {
    const prompt = buildWrapUpPrompt(DEFAULT_WRAP_UP_PROMPT, { todos: [], ...note })
    expect(prompt).not.toContain('notePath')
    expect(prompt).not.toContain('.handoff')
    expect(prompt).not.toContain('接力笔记')
    expect(prompt).not.toContain('epoch-3.handoff.md')

    // The placeholder mechanism stays: the guard keeps computing the path, a
    // hand-written template keeps receiving it (with either spelling).
    const custom = buildWrapUpPrompt('第 {{epoch}} 次压缩 · 写到 {{notePath}}', { todos: [], ...note })
    expect(custom).toContain('第 3 次压缩')
    expect(custom).toContain('/w/.handoff/sessions/a1/epoch-3.handoff.md')
  })

  it('substitutes {{todos}} and stays empty when the template is disabled', () => {
    expect(buildWrapUpPrompt('待办：{{todos}}', { todos: ['A', 'B'], ...note })).toContain('待办：A / B')
    expect(buildWrapUpPrompt('', { todos: ['A'], ...note })).toContain('- A')
  })

  it('leaves an unknown placeholder visible rather than dropping it', () => {
    expect(buildWrapUpPrompt('{{what}}', { todos: [], ...note })).toContain('{{what}}')
  })
})
