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
 * Minimal fake settings provider serving the `context-guard` namespace.
 *
 * `get()` returns `base` layered under the user section, because the real
 * provider resolves the composition base into every read: a double returning
 * only the user section would make template precedence behave differently from
 * production (`withDefaults` would turn an absent template into the empty
 * string, i.e. "disabled").
 */
type ThresholdSettingsValue = {
  defaultThresholdTokens: number
  providerThresholds: { provider: string; thresholdTokens: number }[]
}
interface FakeSettingsScope {
  get(): Record<string, unknown>
  watch(callback: (value: Record<string, unknown>) => void): () => void
  update(patch: object): Promise<void>
}
function fakeSettings(initial: ThresholdSettingsValue & Record<string, unknown>): {
  value: Record<string, unknown>
  scope: FakeSettingsScope | undefined
  provide(ctx: Context): void
} {
  const watchers = new Set<(value: Record<string, unknown>) => void>()
  let base: Record<string, unknown> = {}
  const state: {
    value: Record<string, unknown>
    scope: FakeSettingsScope | undefined
    provide(ctx: Context): void
  } = {
    value: initial,
    scope: undefined,
    provide(ctx) {
      /** Resolved view: composition base under the user section. */
      const resolve = (): Record<string, unknown> => ({ ...base, ...state.value })
      ctx.provide('settings', {
        register(_ns: string, _schema: unknown, options?: { base?: Record<string, unknown> }) {
          base = options?.base ?? {}
          state.scope = {
            get: () => resolve(),
            watch: (callback: (value: Record<string, unknown>) => void) => {
              watchers.add(callback)
              return () => { watchers.delete(callback) }
            },
            update: async (patch: object) => {
              state.value = { ...state.value, ...patch }
              for (const watcher of watchers) watcher(resolve())
            },
          }
          return state.scope
        },
      } as never)
    },
  }
  return state
}

/**
 * Boot the core spine, the stub compaction backend, and the guard with a
 * scripted mock adapter, and start one over-threshold turn.
 * @param presets - optional seam factory: receives the harness context and
 *   returns an `agentPresets`-shaped service (or undefined). Mirrors the real
 *   topology where the guard is a host row and the compaction provider lives
 *   in the agent's preset realm, reachable only through this seam.
 */
async function harness(
  script: ScriptEntry[],
  config: Config = {},
  contextWindow = 300,
  withCompaction = true,
  settings?: ReturnType<typeof fakeSettings>,
  presets?: (ctx: Context) => { serviceFor(agent: { ctx: Context }, name: string): unknown } | undefined,
): Promise<{ ctx: Context; agent: Agent; compaction: StubCompactionEngine | undefined; adapter: MockAdapter }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(TokenMeter)
  settings?.provide(ctx)
  const presetsValue = presets?.(ctx)
  if (presetsValue !== undefined) ctx.provide('agentPresets', presetsValue as never)
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
  const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: TASK_TEXT }], source: { kind: 'user' } }))
  return { ctx, agent, compaction, adapter }
}

/** All context-guard plugin-source user messages, in log order. */
function guardMessages(agent: Agent): { text: string; seq: number }[] {
  return [...agent.session.snapshotEvents()]
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
  return agent.session.snapshotEvents().filter(e => e.type === 'turn/start').length
}

/** Completed turns: the durable signal that a turn fully settled. */
function turnsEnded(agent: Agent): number {
  return agent.session.snapshotEvents().filter(e => e.type === 'turn/end').length
}

function compactionEndCount(agent: Agent): number {
  return agent.session.snapshotEvents().filter(e => e.type === 'compaction/end').length
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
    const wrapUpResponse = [...agent.session.snapshotEvents()].find(e =>
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

  it('reaches a realm-private compaction provider through the agentPresets seam', async () => {
    // Real web topology: the guard is a host row while the preset mounts the
    // compaction backend behind `isolate: { compaction: true }`, which the
    // host fiber cannot see. The provider is registered in an isolate realm
    // (cordis `ctx.isolate`), and the guard finds it only through the
    // agentPresets seam — the documented read path for exactly this case.
    const serviceForCalls: string[] = []
    const realm: { compaction: StubCompactionEngine | undefined } = { compaction: undefined }
    const { ctx, agent } = await harness(
      [
        toolCallResponse('c1', 'probe', { q: 1 }),
        textResponse('wrapping up now'),
        textResponse('continuing after compaction'),
      ],
      {},
      300,
      false, // no host-plane provider: the realm instance is the only one
      undefined,
      (ctx) => {
        realm.compaction = new StubCompactionEngine(ctx.isolate('compaction'))
        return {
          serviceFor: (_target, name) => {
            serviceForCalls.push(name)
            return name === 'compaction' ? realm.compaction : undefined
          },
        }
      },
    )
    await vi.waitFor(() => { expect(turnsEnded(agent)).toBe(2) })

    // The full warn → compact → resume loop ran, with the realm instance
    // reached through exactly one seam lookup.
    const messages = guardMessages(agent)
    expect(messages).toHaveLength(2)
    expect(messages[0]!.text).toContain('收尾')
    expect(messages[1]!.text).toContain('继续')
    expect(serviceForCalls).toEqual(['compaction'])
    expect(realm.compaction!.compactNowCalls).toEqual([1])
    expect(compactionEndCount(agent)).toBe(1)
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

describe('resume escalation', () => {
  it('escalates the continuation prompt after a second compaction in the window', async () => {
    // Wide window so the guard never auto-triggers: both cuts are manual here,
    // because what is under test is the guard's continuation, not the trigger.
    const { ctx, agent, compaction, adapter } = await harness(
      [
        textResponse('first'),
        textResponse('resumed once'),
        textResponse('grown'),
        textResponse('resumed twice'),
      ],
      {},
      4000,
    )
    await vi.waitFor(() => {
      expect(adapter.requests).toHaveLength(1)
      expect(agent.status).toBe('idle')
    })
    expect(await compaction!.compactNow(agent, new AbortController().signal)).not.toBeNull()
    await vi.waitFor(() => {
      expect(adapter.requests).toHaveLength(2)
      expect(agent.status).toBe('idle')
    })

    const afterFirst = guardMessages(agent)
    expect(afterFirst).toHaveLength(1)
    expect(afterFirst[0]!.text).toContain('继续执行')
    expect(afterFirst[0]!.text).not.toContain('增量推进')

    // Grow the surface with a non-human message, so the human anchor — and
    // therefore the compaction count — is not reset by the growth turn.
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'grow '.repeat(200) }],
      source: { kind: 'plugin', plugin: 'test' },
    }))
    await vi.waitFor(() => {
      expect(adapter.requests).toHaveLength(3)
      expect(agent.status).toBe('idle')
    })
    expect(await compaction!.compactNow(agent, new AbortController().signal)).not.toBeNull()
    await vi.waitFor(() => {
      expect(adapter.requests).toHaveLength(4)
      expect(agent.status).toBe('idle')
    })

    const afterSecond = guardMessages(agent)
    expect(afterSecond).toHaveLength(2)
    expect(afterSecond[1]!.text).toContain('增量推进')
    expect(afterSecond[1]!.text).toContain('已自动压缩 2 次')
    // The deferred resume still lands, and the session settles.
    expect(agent.status).toBe('idle')
    void ctx
  })
})

describe('settings-provided absolute thresholds', () => {
  it('uses the per-provider absolute token threshold: above it nothing fires, at it the loop runs', async () => {
    // Task pressure ≈ 560 tokens incl. the system prompt (ratio fallback 255).
    const high = fakeSettings({
      defaultThresholdTokens: 0,
      providerThresholds: [{ provider: 'mock', thresholdTokens: 600 }],
    })
    const first = await harness(
      [textResponse('first turn')],
      {},
      300,
      true,
      high,
    )
    // 600 > ~560-token pressure: nothing fires, the turn settles clean.
    await vi.waitFor(() => { expect(turnsEnded(first.agent)).toBe(1) })
    expect(guardMessages(first.agent)).toEqual([])
    expect(first.compaction!.compactNowCalls).toEqual([])
    void first.ctx

    const low = fakeSettings({
      defaultThresholdTokens: 0,
      providerThresholds: [{ provider: 'mock', thresholdTokens: 400 }],
    })
    const second = await harness(
      [textResponse('first turn'), textResponse('continuing')],
      {},
      300,
      true,
      low,
    )
    // 400 <= ~560-token pressure: idle compaction + resume run the loop.
    await vi.waitFor(() => { expect(turnsEnded(second.agent)).toBe(2) })
    const messages = guardMessages(second.agent)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.text).toContain('继续')
    expect(second.compaction!.compactNowCalls).toEqual([1])
    void second.ctx
  })

  it('uses the default absolute threshold for providers without an entry', async () => {
    const settings = fakeSettings({
      defaultThresholdTokens: 400,
      providerThresholds: [],
    })
    const { ctx, agent, compaction } = await harness(
      [textResponse('first turn'), textResponse('continuing')],
      {},
      300,
      true,
      settings,
    )
    await vi.waitFor(() => { expect(turnsEnded(agent)).toBe(2) })
    const messages = guardMessages(agent)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.text).toContain('继续')
    expect(compaction!.compactNowCalls).toEqual([1])
    void ctx
  })

  it('applies settings updates live through watch: a lowered threshold takes effect on the next turn', async () => {
    const settings = fakeSettings({
      defaultThresholdTokens: 1000,
      providerThresholds: [],
    })
    const { ctx, agent, compaction } = await harness(
      [textResponse('first turn'), textResponse('second turn'), textResponse('continuing')],
      {},
      300,
      true,
      settings,
    )
    // Above 1000 nothing fires; the first turn settles clean.
    await vi.waitFor(() => { expect(turnsEnded(agent)).toBe(1) })
    expect(guardMessages(agent)).toEqual([])

    // Lower the default threshold below the ~560-token pressure.
    await settings.scope!.update({ defaultThresholdTokens: 100 })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go on' }], source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(turnsEnded(agent)).toBe(3) })
    const messages = guardMessages(agent)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.text).toContain('继续')
    expect(compaction!.compactNowCalls).toEqual([1])
    void ctx
  })
})

/*
 * Template precedence. The composition value is baked into the settings base
 * layer, so the resolved settings value is authoritative *including when it is
 * the empty string*: clearing a template field in the Web panel is the only way
 * a user can turn that injection off, and it must not silently fall back to the
 * composition text. Found by browser verification on 2026-09-12.
 */
describe('template precedence over the settings layer', () => {
  it('an empty settings wrap-up template disables the reminder but not compaction', async () => {
    const settings = fakeSettings({
      defaultThresholdTokens: 400,
      providerThresholds: [],
      wrapUpPromptTemplate: '',
    })
    const { ctx, agent, compaction } = await harness(
      [toolCallResponse('c1', 'probe', { q: 1 }), textResponse('wrapping up now'), textResponse('continuing')],
      {},
      300,
      true,
      settings,
    )
    await vi.waitFor(() => { expect(turnsEnded(agent)).toBe(2) })
    const messages = guardMessages(agent)
    // The reminder would normally fire on the tool-call step; only the resume lands.
    expect(messages.filter(m => m.text.includes('接近上限'))).toEqual([])
    expect(messages.some(m => m.text.includes('继续'))).toBe(true)
    expect(compaction!.compactNowCalls).toEqual([1])
    void ctx
  })

  it('an empty settings resume template disables the post-compaction wake-up', async () => {
    const settings = fakeSettings({
      defaultThresholdTokens: 400,
      providerThresholds: [],
      resumePromptTemplate: '',
    })
    const { ctx, agent, compaction } = await harness(
      [textResponse('first turn'), textResponse('unreachable')],
      {},
      300,
      true,
      settings,
    )
    // Compaction still runs on idle; only the continuation is withheld, so the
    // turn count stays at one.
    await vi.waitFor(() => { expect(compaction!.compactNowCalls).toEqual([1]) })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(guardMessages(agent)).toEqual([])
    expect(turnsEnded(agent)).toBe(1)
    void ctx
  })

  it('a composition-configured template still wins when settings has no override', async () => {
    const settings = fakeSettings({ defaultThresholdTokens: 400, providerThresholds: [] })
    const { ctx, agent } = await harness(
      [toolCallResponse('c1', 'probe', { q: 1 }), textResponse('config text'), textResponse('continuing')],
      { wrapUpPrompt: '配置层收尾提醒' },
      300,
      true,
      settings,
    )
    await vi.waitFor(() => { expect(turnsEnded(agent)).toBe(2) })
    expect(guardMessages(agent).some(m => m.text.includes('配置层收尾提醒'))).toBe(true)
    void ctx
  })
})
