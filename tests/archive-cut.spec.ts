/**
 * ArchiveCutEngine suite: the deterministic archival-cut compaction backend.
 *
 * Part 1 unit-tests the Markdown cleaner (pure, golden output shapes).
 * Part 2 drives the REAL engine + the guard through a real agent loop against
 * a scripted mock adapter (no network) and asserts the full closed loop:
 * wrap-up reminder → idle compaction → deterministic archive file → resume,
 * with ZERO additional model calls (the mock script never contains a
 * summarizer request, and exhaustion would throw).
 */

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { Message, UserMessage } from '@deepseek-ai/dsh-llm'
import { messagesToMarkdown } from '../src/messages-to-md.ts'
import ArchiveCutEngine from '../src/compaction.ts'
import * as ContextGuard from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'
import type { ScriptEntry } from './mock-adapter.ts'

/** Long initial task text: ~350 heuristic tokens, over a 255-token threshold. */
const TASK_TEXT = 'start '.repeat(350)

const tmpDirs: string[] = []
async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'archive-cut-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** One user message carrying the given text. */
function userMessage(text: string): UserMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  } as unknown as UserMessage
}

/** One assistant message with text + a tool call. */
function assistantWithTool(text: string, toolName: string, args: string): Message {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text },
      { type: 'tool-call', id: 'c1' as never, name: toolName, arguments: args },
    ],
  } as unknown as Message
}

/** One user message carrying a tool result. */
function toolResultMessage(isError: boolean, body: string): Message {
  return {
    role: 'user',
    content: [{
      type: 'tool-result',
      toolCallId: 'c1' as never,
      isError,
      content: [{ type: 'text', text: body }],
    }],
    source: { kind: 'tool', callId: 'c1' as never },
  } as unknown as Message
}

describe('messagesToMarkdown (deterministic cleaner)', () => {
  it('renders roles, verbatim text, tool calls and clipped tool results', () => {
    const md = messagesToMarkdown([
      userMessage('修复登录 bug'),
      assistantWithTool('我先看代码', 'read', JSON.stringify({ file_path: '/a/b.ts' })),
      toolResultMessage(false, 'ok\n'.repeat(2000)),
    ])
    expect(md).toContain('# 会话归档（dsh-context-guard 确定性导出，无模型参与）')
    expect(md).toContain('## 用户')
    expect(md).toContain('修复登录 bug')
    expect(md).toContain('## Assistant')
    expect(md).toContain('我先看代码')
    expect(md).toContain('🔧 read')
    expect(md).toContain('"file_path":"/a/b.ts"')
    // tool result: ✓ preview, clipped with an explicit marker
    expect(md).toContain('✓ 工具结果')
    expect(md).toContain('(中间省略')
    expect(md).toContain('ok\n'.repeat(2000).slice(-100))
  })

  it('marks error results and drops reasoning by default', () => {
    const md = messagesToMarkdown([
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'hmm, let me think' },
          { type: 'text', text: '结论' },
        ],
      } as unknown as Message,
      toolResultMessage(true, 'Error: EACCES denied'),
    ])
    expect(md).not.toContain('hmm, let me think')
    expect(md).toContain('结论')
    expect(md).toContain('✗ 工具结果')
    expect(md).toContain('EACCES')
  })

  it('adapts code fences longer than any payload run and degrades unknown blocks', () => {
    // Tool-call arguments containing backticks force a longer fence.
    const args = '{"cmd":"a```b\\ninside```"}'
    const md = messagesToMarkdown([
      assistantWithTool('跑一下', 'bash', args),
      {
        role: 'user',
        content: [{ type: 'bogus-type', text: 'x' } as never],
      } as unknown as Message,
    ])
    expect(md).toContain('````\n' + args + '\n````')
    expect(md).toContain('[未知内容块类型: bogus-type]')
    // deterministic: same input, same output
    const once = messagesToMarkdown([assistantWithTool('跑一下', 'bash', args)])
    expect(messagesToMarkdown([assistantWithTool('跑一下', 'bash', args)])).toBe(once)
  })
})

/** Shared boot: real engine mounted as a plugin (loader-equivalent inject
 * wiring), the guard, and one scripted over-threshold turn. */
async function bootLoop(
  script: ScriptEntry[],
  archiveDir: string,
  engineConfig: Record<string, unknown> = {},
  taskText = TASK_TEXT,
  contextWindow = 300,
): Promise<{ ctx: Context; agent: Awaited<ReturnType<AgentLoop['create']>>; adapter: MockAdapter }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(AgentLoop, { agents: [] })
  // Mount the REAL engine as a plugin: this wires its static inject
  // (llm/tokenMeter/sessions) exactly like a preset row does in production.
  await ctx.plugin(ArchiveCutEngine, {
    auto: false,
    archiveDir,
    retainTokens: 40,
    ...engineConfig,
  })
  await ctx.plugin(ContextGuard)
  ctx.tools.register(defineContentToolFixture({
    name: 'probe',
    description: 'p',
    parameters: {},
    async execute() { return [{ type: 'text', text: 'ok' }] },
  }))
  const adapter = new MockAdapter(script, contextWindow)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: taskText }], source: { kind: 'user' } }))
  return { ctx, agent, adapter }
}

function guardMessages(agent: { session: { snapshotEvents(): readonly SessionEvent[] } }): string[] {
  return [...agent.session.snapshotEvents()]
    .filter((e): e is SessionEvent<'user/message'> =>
      e.type === 'user/message'
      && e.data.source.kind === 'plugin'
      && e.data.source.plugin === 'context-guard')
    .map(e => e.data.content.filter(b => b.type === 'text').map(b => b.text).join('|'))
}

describe('ArchiveCutEngine full loop (real engine, zero summarizer calls)', () => {
  it('warns, archives deterministically at idle compaction, and resumes', async () => {
    const archiveDir = await makeTmpDir()
    const script: ScriptEntry[] = [
      toolCallResponse('c1', 'probe', { q: 1 }),
      textResponse('wrapping up now'),
      textResponse('continuing after compaction'),
    ]
    const { ctx, agent, adapter } = await bootLoop(script, archiveDir)

    // The whole loop settles: two completed turns (original + resumed).
    await vi.waitFor(() => {
      const ended = [...agent.session.snapshotEvents()]
        .filter(e => e.type === 'turn/end').length
      expect(ended).toBe(2)
    })

    // ZERO additional model calls: exactly the scripted requests ran, and none
    // of them was a summarization call.
    expect(adapter.requests).toHaveLength(3)
    expect(adapter.requests.every(r => r.purpose !== 'compaction')).toBe(true)

    // One durable compaction transaction landed.
    const compactionEnds = [...agent.session.snapshotEvents()]
      .filter(e => e.type === 'compaction/end').length
    expect(compactionEnds).toBe(1)

    // Guard messages: wrap-up reminder then resume prompt.
    const messages = guardMessages(agent)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toContain('收尾')
    expect(messages[0]).toContain('接力总结')
    expect(messages[1]).toContain('继续')

    // The checkpoint frame the model sees points at the deterministic archive.
    const checkpointText = [...agent.session.snapshotEvents()]
      .filter((e): e is SessionEvent<'user/message'> => e.type === 'user/message')
      .flatMap(e => e.data.content.filter(b => b.type === 'text').map(b => b.text))
      .find(text => text.includes('确定性归档'))
    expect(checkpointText).toBeDefined()
    expect(checkpointText).toContain('未调用模型摘要请求')
    expect(checkpointText).toContain('epoch-1.raw.md')
    expect(checkpointText).toContain(archiveDir)

    // The archive file exists and holds the archived region verbatim.
    const archivePath = path.join(archiveDir, 'epoch-1.raw.md')
    const md = await readFile(archivePath, 'utf8')
    expect(md).toContain('## 用户')
    expect(md).toContain('start start')
    expect(md).toContain('🔧 probe')
    const latest = await readFile(path.join(archiveDir, 'latest.txt'), 'utf8')
    expect(latest.trim()).toBe(archivePath)

    await vi.waitFor(() => { expect(agent.status).toBe('idle') })
    void ctx
  })

  it('continues epoch numbering across two manual compactions', async () => {
    const archiveDir = await makeTmpDir()
    // Mid-size task: below the guard threshold (255), but with enough shadowable
    // content that the deterministic frame (~144 tokens) shrinks the surface.
    const { ctx, agent, adapter } = await bootLoop(
      [
        textResponse('first reply'),
        textResponse('after first cut'),
        textResponse('after second task'),
        textResponse('after second cut'),
      ],
      archiveDir,
      { retainTokens: 10 },
      'mid '.repeat(180),
      // Wide window: the guard ratio (0.85 × window) must never trip across
      // two manual cuts, or its wrap-up/resume turns would race compactNow.
      2000,
    )
    // Turn 1 settles below the guard threshold; the agent is idle.
    await vi.waitFor(() => {
      expect(adapter.requests).toHaveLength(1)
      expect(agent.status).toBe('idle')
    })
    const engine = ctx.get('compaction') as ArchiveCutEngine
    // Two manual compactions (as /compact would) archive epochs 1 and 2:
    // epoch numbering continues across compactions.
    const first = await engine.compactNow(agent, new AbortController().signal)
    expect(first).not.toBeNull()
    // The guard posts its resume prompt after the cut; that resumed turn must
    // settle before the next manual cut (compactNow refuses a busy agent).
    await vi.waitFor(() => {
      expect(adapter.requests).toHaveLength(2)
      expect(agent.status).toBe('idle')
    })
    // Grow the surface again so the second cut has something to shrink.
    agent.followup(userMessage('mid '.repeat(180)))
    await vi.waitFor(() => {
      expect(adapter.requests).toHaveLength(3)
      expect(agent.status).toBe('idle')
    })
    const second = await engine.compactNow(agent, new AbortController().signal)
    expect(second).not.toBeNull()
    // Let the post-cut resume settle so teardown is quiet.
    await vi.waitFor(() => {
      expect(adapter.requests).toHaveLength(4)
      expect(agent.status).toBe('idle')
    })
    expect((await readdir(archiveDir)).sort()).toEqual(['epoch-1.raw.md', 'epoch-2.raw.md', 'latest.txt'])
    const latest = await readFile(path.join(archiveDir, 'latest.txt'), 'utf8')
    expect(latest.trim()).toBe(path.join(archiveDir, 'epoch-2.raw.md'))
    void ctx
  })
})
