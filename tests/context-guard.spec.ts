/**
 * Behavior suite for the context guard, driven through a real agent loop
 * against a scripted mock adapter (no network): the full warn → stop →
 * compact → resume loop, the below-threshold no-op, the concluded-turn
 * no-reminder rule, failed-compaction no-resume, and the per-hook
 * configuration switches.
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
import { FRAME_MARKER } from '../src/digest.ts'
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
 * @param cwd - the session's working directory; sets where the guard's
 *   side-car writer archives (`<cwd>/.handoff`). Without one the session has
 *   no resolvable archive base, exactly like a session created outside any
 *   workspace.
 */
async function harness(
  script: ScriptEntry[],
  config: Config = {},
  contextWindow = 300,
  withCompaction = true,
  settings?: ReturnType<typeof fakeSettings>,
  presets?: (ctx: Context) => { serviceFor(agent: { ctx: Context }, name: string): unknown } | undefined,
  cwd?: string,
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
  const agent = await ctx.agentLoop.create(
    SessionId('a1'),
    { provider: 'mock', model: 'mock' },
    cwd === undefined ? {} : { cwd },
  )
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
    // The reminder sends the note to this session's own directory (the test
    // session has no cwd, so the base is relative) and numbers the coming cut.
    expect(messages[0]!.text).toContain('.handoff/sessions/a1/epoch-1.handoff.md')
    expect(messages[0]!.text).toContain('第 1 次压缩')
    expect(messages[0]!.text).not.toContain('文件名自定')
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

/**
 * What the continuation may claim about archives.
 *
 * The default template names two files (`{{digest}}` / `{{raw}}`), so a wrong
 * resolution is not a cosmetic log line: it sends the resumed agent to read a
 * file that does not exist. A session on `compaction-basic` (the `standard`
 * preset, i.e. every ordinary web session) never writes either file, and its
 * "frame" is a model-written summary in prose.
 */
describe('resume archive pointers', () => {
  const tmpDirs: string[] = []
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  })

  /** Cut once (wide threshold: the guard itself never compacts) and read the continuation. */
  async function cutOnceAndResume(
    compaction: StubCompactionEngine,
    agent: Agent,
    adapter: MockAdapter,
  ): Promise<string> {
    expect(await compaction.compactNow(agent, new AbortController().signal)).not.toBeNull()
    await vi.waitFor(() => {
      expect(adapter.requests).toHaveLength(2)
      expect(agent.status).toBe('idle')
    })
    const messages = guardMessages(agent)
    expect(messages).toHaveLength(1)
    return messages[0]!.text
  }

  it('names no file when the frame is a foreign (model-written) summary', async () => {
    const { ctx, agent, compaction, adapter } = await harness(
      [textResponse('first'), textResponse('resumed')],
      {},
      4000,
    )
    await vi.waitFor(() => {
      expect(adapter.requests).toHaveLength(1)
      expect(agent.status).toBe('idle')
    })
    // The real defect (2026-09-12): a `standard`-preset session's summary
    // quoted the format docs, and the guard injected `epoch-N.digest.md`.
    compaction!.summaryText = [
      '手动 `/compact` 走同一个 `summarize()` → 写 `epoch-N.raw.md` + `epoch-N.digest.md`。',
      '磁盘现状：`.handoff/sessions/` 为空，`latest.txt` → `epoch-299.raw.md`。',
    ].join('\n')

    const text = await cutOnceAndResume(compaction!, agent, adapter)
    expect(text).toContain('本次压缩没有生成归档文档')
    expect(text).not.toContain('epoch-N.digest.md')
    expect(text).not.toContain('epoch-299.raw.md')
    void ctx
  })

  it('names the engine frame\'s artifacts when they exist on disk', async () => {
    const { ctx, agent, compaction, adapter } = await harness(
      [textResponse('first'), textResponse('resumed')],
      {},
      4000,
    )
    await vi.waitFor(() => {
      expect(adapter.requests).toHaveLength(1)
      expect(agent.status).toBe('idle')
    })
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cg-pointers-'))
    tmpDirs.push(dir)
    const digest = path.join(dir, 'epoch-1.digest.md')
    const raw = path.join(dir, 'epoch-1.raw.md')
    await writeFile(digest, 'digest body', 'utf8')
    await writeFile(raw, 'raw body', 'utf8')
    compaction!.summaryText = [
      `${FRAME_MARKER}（未调用模型摘要请求）。`,
      `- 精简接力摘要：\`${digest}\``,
      `- 完整归档：\`${raw}\``,
    ].join('\n')

    const text = await cutOnceAndResume(compaction!, agent, adapter)
    expect(text).toContain(digest)
    expect(text).toContain(raw)
    expect(text).not.toContain('本次压缩没有生成归档文档')
    void ctx
  })

  it('withholds a pointer whose file is gone, even in the engine frame', async () => {
    const { ctx, agent, compaction, adapter } = await harness(
      [textResponse('first'), textResponse('resumed')],
      {},
      4000,
    )
    await vi.waitFor(() => {
      expect(adapter.requests).toHaveLength(1)
      expect(agent.status).toBe('idle')
    })
    compaction!.summaryText = [
      `${FRAME_MARKER}（未调用模型摘要请求）。`,
      '- 精简接力摘要：`/nonexistent-cg/epoch-7.digest.md`',
    ].join('\n')

    const text = await cutOnceAndResume(compaction!, agent, adapter)
    expect(text).toContain('本次压缩没有生成归档文档')
    expect(text).not.toContain('/nonexistent-cg/epoch-7.digest.md')
    void ctx
  })
})

/**
 * The side-car writer.
 *
 * The point of the feature is that the archive works *without* taking over
 * compaction: a session on the `standard` preset runs `compaction-basic`, whose
 * checkpoint is a model-written summary that names no file, and the guard adds
 * the deterministic pair beside it. These tests therefore use a foreign
 * (non-`context-guard`) provider string on the stub backend and a real session
 * `cwd`, and assert on both the files and the continuation prompt.
 */
describe('side-car archiving beside a foreign compaction engine', () => {
  const tmpDirs: string[] = []
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  })

  async function workspace(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cg-sidecar-'))
    tmpDirs.push(dir)
    return dir
  }

  /**
   * Settings with the full transcript dump switched on.
   *
   * The side-car digest knobs are read from the settings layer only (the
   * composition entry has no digest fields), so these tests must go through
   * `fakeSettings` to get a `raw` member at all: since 0.4.0 the transcript is
   * opt-in and the default ships the digest alone. `defaultThresholdTokens: 0`
   * keeps threshold resolution on the composition/ratio path the tests expect.
   */
  function rawSidecar(): ReturnType<typeof fakeSettings> {
    return fakeSettings({
      defaultThresholdTokens: 0,
      providerThresholds: [],
      writeRawArchive: true,
    })
  }

  /** Cut once and wait for the post-cut continuation to settle. */
  async function cutOnce(
    compaction: StubCompactionEngine,
    agent: Agent,
    adapter: MockAdapter,
    expectedRequests: number,
  ): Promise<void> {
    expect(await compaction.compactNow(agent, new AbortController().signal)).not.toBeNull()
    await vi.waitFor(() => {
      expect(adapter.requests).toHaveLength(expectedRequests)
      expect(agent.status).toBe('idle')
    })
  }

  it('writes raw + digest for a foreign backend and names them in the continuation', async () => {
    const cwd = await workspace()
    const { ctx, agent, compaction, adapter } = await harness(
      [textResponse('first'), textResponse('resumed')],
      {},
      4000,
      true,
      rawSidecar(),
      undefined,
      cwd,
    )
    await vi.waitFor(() => {
      expect(adapter.requests).toHaveLength(1)
      expect(agent.status).toBe('idle')
    })
    // The `standard`-preset shape: a model-written prose summary with no paths.
    compaction!.summaryText = '模型写的摘要：我们改了三个文件，还剩两件事。'
    await cutOnce(compaction!, agent, adapter, 2)

    const sessionDir = path.join(cwd, '.handoff', 'sessions', 'a1')
    expect((await readdir(sessionDir)).sort()).toEqual([
      'epoch-1.digest.md',
      'epoch-1.raw.md',
      'latest-digest.txt',
      'latest.txt',
    ])
    // The raw archive holds the shadowed region verbatim, and the digest is the
    // deterministic document — not the model's summary.
    const raw = await readFile(path.join(sessionDir, 'epoch-1.raw.md'), 'utf8')
    expect(raw).toContain('# 会话归档')
    expect(raw).toContain('start start')
    const digest = await readFile(path.join(sessionDir, 'epoch-1.digest.md'), 'utf8')
    expect(digest).toContain('<!-- context-guard-digest v1 -->')
    expect(digest).toContain('- 会话: a1')
    expect(digest).toContain('- 第几次: 1')

    // The continuation prompt names both real files. Both the write and this
    // render happen inside `compaction/summary`, so the pointers describe files
    // that were already on disk when the region was replaced.
    const messages = guardMessages(agent)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.text).toContain(path.join(sessionDir, 'epoch-1.digest.md'))
    expect(messages[0]!.text).toContain(path.join(sessionDir, 'epoch-1.raw.md'))
    expect(messages[0]!.text).not.toContain('本次压缩没有生成归档文档')
    void ctx
  })

  it('lands the archive before the replacing message is dispatched', async () => {
    const cwd = await workspace()
    const { ctx, agent, compaction, adapter } = await harness(
      [textResponse('first'), textResponse('resumed')],
      {},
      4000,
      true,
      rawSidecar(),
      undefined,
      cwd,
    )
    await vi.waitFor(() => {
      expect(adapter.requests).toHaveLength(1)
      expect(agent.status).toBe('idle')
    })
    compaction!.summaryText = '模型写的摘要'

    // The ordering contract of 0.3.6: the archive must be on disk *before* the
    // compaction takes effect. The backend appends the replacement
    // (`surfaceOp: {op:'replace'}`) immediately after `compaction/summary` with
    // no `await` in between, and `session/event` is `emit` — never awaited — so
    // the only window is synchronous work inside the summary listener.
    //
    // This listener therefore reads the filesystem *synchronously*: it stands
    // exactly where the region leaves the model's view, and whatever it sees is
    // what a resumed agent would have seen. (Snapshotting beats asserting
    // inside the callback, where a throw would be swallowed by the emitter.)
    const sessionDir = path.join(cwd, '.handoff', 'sessions', 'a1')
    const read = (name: string): string | undefined => {
      try { return readFileSync(path.join(sessionDir, name), 'utf8') } catch { return undefined }
    }
    const atReplacement: { digest: string | undefined; raw: string | undefined }[] = []
    ctx.on('session/event', (_session, event) => {
      // `surfaceOp` is an envelope field, not `event.data`.
      if (event.type !== 'user/message') return
      if (typeof event.surfaceOp !== 'object' || event.surfaceOp.op !== 'replace') return
      atReplacement.push({ digest: read('epoch-1.digest.md'), raw: read('epoch-1.raw.md') })
    })

    await cutOnce(compaction!, agent, adapter, 2)

    expect(atReplacement).toHaveLength(1)
    expect(atReplacement[0]!.digest).toContain('<!-- context-guard-digest v1 -->')
    expect(atReplacement[0]!.raw).toContain('# 会话归档')
    // The archive is not a copy of the checkpoint the model sees: the
    // replacement carries the foreign model-written summary, the raw file the
    // shadowed region verbatim.
    expect(atReplacement[0]!.raw).toContain('start start')
    expect(atReplacement[0]!.raw).not.toContain('模型写的摘要')
    void ctx
  })

  it('numbers the side-car like the wrap-up note and continues across cuts', async () => {
    const cwd = await workspace()
    const { ctx, agent, compaction, adapter } = await harness(
      [textResponse('first'), textResponse('resumed once'), textResponse('grown'), textResponse('resumed twice')],
      {},
      4000,
      true,
      rawSidecar(),
      undefined,
      cwd,
    )
    await vi.waitFor(() => {
      expect(adapter.requests).toHaveLength(1)
      expect(agent.status).toBe('idle')
    })
    await cutOnce(compaction!, agent, adapter, 2)

    // Grow the surface without a human message, so the compaction count is not
    // reset, then cut again.
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'grow '.repeat(200) }],
      source: { kind: 'plugin', plugin: 'test' },
    }))
    await vi.waitFor(() => {
      expect(adapter.requests).toHaveLength(3)
      expect(agent.status).toBe('idle')
    })
    await cutOnce(compaction!, agent, adapter, 4)

    const sessionDir = path.join(cwd, '.handoff', 'sessions', 'a1')
    expect((await readdir(sessionDir)).filter(name => name.endsWith('.raw.md')).sort())
      .toEqual(['epoch-1.raw.md', 'epoch-2.raw.md'])
    const second = await readFile(path.join(sessionDir, 'epoch-2.digest.md'), 'utf8')
    expect(second).toContain('- 第几次: 2')
    // Carry-forward keeps the first cut's content alive through the second.
    expect(second).toContain('- 继承: 第 1 次')
    const messages = guardMessages(agent)
    expect(messages[1]!.text).toContain(path.join(sessionDir, 'epoch-2.digest.md'))
    void ctx
  })

  it('skips a compaction its own engine already archived', async () => {
    const cwd = await workspace()
    const { ctx, agent, compaction, adapter } = await harness(
      [textResponse('first'), textResponse('resumed')],
      {},
      4000,
      true,
      undefined,
      undefined,
      cwd,
    )
    await vi.waitFor(() => {
      expect(adapter.requests).toHaveLength(1)
      expect(agent.status).toBe('idle')
    })
    // The guard's own engine reports provider `context-guard` and returns a
    // pointer frame; it wrote the pair while summarizing, so the side-car must
    // stay out of the way (no second epoch, no overwrite).
    const sessionDir = path.join(cwd, '.handoff', 'sessions', 'a1')
    compaction!.provider = 'context-guard'
    compaction!.summaryText = [
      `${FRAME_MARKER}（未调用模型摘要请求）。`,
      `- 精简接力摘要：\`${path.join(sessionDir, 'epoch-1.digest.md')}\``,
    ].join('\n')
    await cutOnce(compaction!, agent, adapter, 2)

    // Nothing was written anywhere by the guard: the engine in this test is a
    // stub that only lands the transaction, so an empty workspace proves the
    // side-car skipped the compaction instead of archiving what the engine
    // already owns.
    await expect(readdir(path.join(cwd, '.handoff'))).rejects.toThrow()
    // The continuation still names the frame's path... which the guard
    // withholds, because a frame that claims a file that does not exist must
    // not send the resumed agent there.
    const messages = guardMessages(agent)
    expect(messages[0]!.text).toContain('本次压缩没有生成归档文档')
    void ctx
  })
})
