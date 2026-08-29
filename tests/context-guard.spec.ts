/**
 * Behavior suite for the context guard, driven through a real agent loop
 * against a scripted mock adapter (no network): the full warn → stop →
 * compact → resume loop, the below-threshold no-op, the concluded-turn
 * no-reminder rule, failed-compaction no-resume, and the per-hook
 * configuration switches.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as ContextGuard from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'
import type { ScriptEntry } from './mock-adapter.ts'
import { StubCompactionEngine } from './stub-compaction.ts'

/** Long initial task text: ~440 heuristic tokens, over a 255-token threshold. */
const TASK_TEXT = 'start '.repeat(350)

/**
 * Boot the core spine, the stub compaction backend, and the guard with a
 * scripted mock adapter, and start one over-threshold turn.
 */
async function harness(
  script: ScriptEntry[],
  config: Config = {},
  contextWindow = 300,
  withCompaction = true,
): Promise<{ ctx: Context; agent: Agent; compaction: StubCompactionEngine | undefined; adapter: MockAdapter }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(TokenMeter)
  const compaction = withCompaction ? new StubCompactionEngine(ctx) : undefined
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ContextGuard, config)
  ctx.tools.register(defineContentToolFixture({
    name: 'probe',
    description: 'p',
    parameters: {},
    async execute() { return [{ type: 'text', text: 'ok' }] },
  }))
  const adapter = new MockAdapter(script, contextWindow)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: TASK_TEXT }], source: { kind: 'user' } }))
  return { ctx, agent, compaction, adapter }
}

/** All context-guard plugin-source user messages, in log order. */
function guardMessages(agent: Agent): { text: string; seq: number }[] {
  return [...agent.session.events]
    .filter((e): e is SessionEvent<'user/message'> =>
      e.type === 'user/message'
      && e.data.source.kind === 'plugin'
      && e.data.source.plugin === 'context-guard')
    .map(e => ({
      text: e.data.content.filter(block => block.type === 'text').map(block => block.text).join('|'),
      seq: e.seq,
    }))
}

function turnCount(agent: Agent): number {
  return agent.session.events.filter(e => e.type === 'turn/start').length
}

/** Completed turns: the durable signal that a turn fully settled. */
function turnsEnded(agent: Agent): number {
  return agent.session.events.filter(e => e.type === 'turn/end').length
}

function compactionEndCount(agent: Agent): number {
  return agent.session.events.filter(e => e.type === 'compaction/end').length
}

describe('context-guard full loop', () => {
  it('reminds once at step end, compacts on idle, resumes after compaction', async () => {
    const { ctx, agent, compaction } = await harness([
      toolCallResponse('c1', 'probe', { q: 1 }),
      textResponse('wrapping up now'),
      textResponse('continuing after compaction'),
    ])
    await vi.waitFor(() => { expect(turnsEnded(agent)).toBe(2) })

    // Hook 1: exactly one wrap-up reminder, folded into the step after the
    // tool call, before the model's wrap-up response.
    const messages = guardMessages(agent)
    expect(messages).toHaveLength(2)
    expect(messages[0]!.text).toContain('收尾')
    const wrapUpSeq = messages[0]!.seq
    const wrapUpResponse = [...agent.session.events].find(e =>
      e.type === 'assistant/message'
      && e.data.message.content.some(b => b.type === 'text' && b.text === 'wrapping up now'))
    expect(wrapUpResponse).toBeDefined()
    expect(wrapUpSeq).toBeLessThan(wrapUpResponse!.seq)

    // Hook 2: exactly one successful idle compaction.
    expect(compaction!.compactNowCalls).toEqual([1])
    expect(compactionEndCount(agent)).toBe(1)

    // Hook 3: exactly one resume prompt, opened as a second turn.
    expect(messages[1]!.text).toContain('继续')
    expect(turnCount(agent)).toBe(2)

    // The resumed turn settles below the threshold: no second reminder and no
    // second compaction; episode flags reset for later growth.
    await vi.waitFor(() => { expect(agent.status).toBe('idle') })
    expect(guardMessages(agent)).toHaveLength(2)
    expect(compaction!.compactNowCalls).toEqual([1])
    void ctx
  })

  it('does nothing below the threshold', async () => {
    const { ctx, agent, compaction } = await harness(
      [textResponse('fine')],
      {},
      64_000,
    )
    await vi.waitFor(() => { expect(turnsEnded(agent)).toBe(1) })
    expect(guardMessages(agent)).toEqual([])
    expect(compaction!.compactNowCalls).toEqual([])
    expect(compactionEndCount(agent)).toBe(0)
    void ctx
  })

  it('does not remind a step that concluded the turn, but still compacts and resumes on idle', async () => {
    const { ctx, agent, compaction } = await harness([
      textResponse('done now'),
      textResponse('continuing'),
    ])
    await vi.waitFor(() => { expect(turnsEnded(agent)).toBe(2) })

    const messages = guardMessages(agent)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.text).toContain('继续')
    expect(compaction!.compactNowCalls).toEqual([1])
    void ctx
  })
})

describe('context-guard failure and configuration paths', () => {
  it('does not resume after a failed compaction', async () => {
    const { ctx, agent, compaction } = await harness([
      toolCallResponse('c1', 'probe', { q: 1 }),
      textResponse('wrapping up now'),
    ])
    compaction!.failNext = true
    await vi.waitFor(() => { expect(compactionEndCount(agent)).toBe(1) })
    // The failure is contained: the wrap-up reminder still landed, but the
    // failed compaction opens no resume turn.
    expect(turnsEnded(agent)).toBe(1)
    const messages = guardMessages(agent)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.text).toContain('收尾')
    expect(compaction!.compactNowCalls).toEqual([0])
    void ctx
  })

  it('empty wrapUpPrompt disables the step-end reminder but keeps idle compaction and resume', async () => {
    const { ctx, agent, compaction } = await harness(
      [
        toolCallResponse('c1', 'probe', { q: 1 }),
        textResponse('wrapping up now'),
        textResponse('continuing'),
      ],
      { wrapUpPrompt: '' },
    )
    await vi.waitFor(() => { expect(turnsEnded(agent)).toBe(2) })

    const messages = guardMessages(agent)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.text).toContain('继续')
    expect(compaction!.compactNowCalls).toEqual([1])
    void ctx
  })

  it('resumeAfterCompact false leaves the agent idle after compaction', async () => {
    const { ctx, agent, compaction } = await harness(
      [
        toolCallResponse('c1', 'probe', { q: 1 }),
        textResponse('wrapping up now'),
      ],
      { resumeAfterCompact: false },
    )
    await vi.waitFor(() => { expect(compactionEndCount(agent)).toBe(1) })
    expect(turnsEnded(agent)).toBe(1)
    const messages = guardMessages(agent)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.text).toContain('收尾')
    expect(compaction!.compactNowCalls).toEqual([1])
    void ctx
  })

  it('autoCompactOnIdle false keeps the reminder but never compacts', async () => {
    const { ctx, agent, compaction } = await harness(
      [
        toolCallResponse('c1', 'probe', { q: 1 }),
        textResponse('wrapping up now'),
      ],
      { autoCompactOnIdle: false },
    )
    await vi.waitFor(() => { expect(turnsEnded(agent)).toBe(1) })
    const messages = guardMessages(agent)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.text).toContain('收尾')
    expect(compaction!.compactNowCalls).toEqual([])
    expect(compactionEndCount(agent)).toBe(0)
    void ctx
  })

  it('degrades gracefully when no compaction provider is mounted: reminder works, idle compact skipped', async () => {
    const { ctx, agent, compaction } = await harness(
      [
        toolCallResponse('c1', 'probe', { q: 1 }),
        textResponse('wrapping up now'),
      ],
      {},
      300,
      false,
    )
    await vi.waitFor(() => { expect(turnsEnded(agent)).toBe(1) })
    // Hook 1 still lands without any compaction service.
    const messages = guardMessages(agent)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.text).toContain('收尾')
    // Hook 2 has no provider to call: no crash, no compaction events.
    expect(compaction).toBeUndefined()
    expect(compactionEndCount(agent)).toBe(0)
    void ctx
  })

  it('an invalid thresholdRatio never throws: falls back to the default and keeps working', async () => {
    const { ctx, agent, compaction } = await harness(
      [
        toolCallResponse('c1', 'probe', { q: 1 }),
        textResponse('wrapping up now'),
        textResponse('continuing'),
      ],
      { thresholdRatio: 2 },
      300,
      true,
    )
    // The plugin loaded (fallback 0.85) and the full loop still runs.
    await vi.waitFor(() => { expect(turnsEnded(agent)).toBe(2) })
    const messages = guardMessages(agent)
    expect(messages).toHaveLength(2)
    expect(messages[0]!.text).toContain('收尾')
    expect(messages[1]!.text).toContain('继续')
    expect(compaction!.compactNowCalls).toEqual([1])
    void ctx
  })
})
