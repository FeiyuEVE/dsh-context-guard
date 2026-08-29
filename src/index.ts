/**
 * Context-pressure guard: wraps up over-threshold turns, compacts idle
 * sessions, and resumes the task after a completed compaction.
 *
 * The guard owns one closed loop per session:
 *
 * 1. `step/end` — after a step that still owes another model request, the
 *    session's request pressure is measured against the routed model's
 *    context window. Above {@link Config.thresholdRatio} the guard queues a
 *    wrap-up reminder that the next `agent/pre-step` folds into the entering
 *    messages, so the model sees it before its very next action and wraps the
 *    turn up instead of extending it.
 * 2. `agent/status` idle — when the agent stops and the session is still over
 *    the threshold, the guard runs `ctx.compaction.compactNow()` once per
 *    over-threshold episode.
 * 3. `compaction/end` — after a successful compaction of an idle agent, the
 *    guard queues a continuation prompt and wakes the driver, so the task
 *    resumes on the compacted surface instead of sitting idle.
 *
 * All injected content is user-role context stamped with the plugin source
 * (`{ kind: 'plugin', plugin: 'context-guard' }`), so it is durable in the
 * session log and reconstructable (model-visible ⟺ logged).
 *
 * @module dsh-context-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
// Type-only: pulls in the `ctx.compaction` / `ctx.tokenMeter` / `ctx.settings`
// declaration merges.
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-token-meter'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'

export const name = 'context-guard'

/** Required services: routed-model metadata, token measurement, and the live agent registry. */
export const inject = ['llm', 'tokenMeter', 'agents']

/**
 * Plugin config, validated by the same-named schemastery schema. An empty
 * `wrapUpPrompt` disables the step-end reminder and an empty `resumePrompt`
 * disables the post-compaction resume; the two booleans are explicit
 * switches for the same injections.
 */
export interface Config {
  /**
   * Fraction of the routed model's context window above which the guard acts
   * (default `0.85`).
   */
  thresholdRatio?: number
  /**
   * Wrap-up reminder folded into the next step's messages when pressure
   * exceeds the threshold (default prompts a quick finish and stop).
   */
  wrapUpPrompt?: string
  /**
   * Continuation prompt queued as a new turn after a successful compaction
   * (default asks the agent to continue the task it was working on).
   */
  resumePrompt?: string
  /** Whether an over-threshold idle session is compacted automatically (default `true`). */
  autoCompactOnIdle?: boolean
  /** Whether a completed compaction resumes the idle agent (default `true`). */
  resumeAfterCompact?: boolean
}

/** Default wrap-up reminder: finish the current task, do not start new work. */
const DEFAULT_WRAP_UP_PROMPT =
  '当前会话上下文已接近模型上下文窗口上限。请立即收尾：不要启动新的子任务或继续深入探索，'
  + '只完成当前任务尚未完成的最后一步，给出最终结论并停止。'

/** Default continuation prompt: keep going after the compaction. */
const DEFAULT_RESUME_PROMPT =
  '上下文压缩已完成。请继续执行压缩前正在进行的任务，直到任务完成。'

export const Config: z<Config> = z.object({
  // Unbounded on purpose: an out-of-range ratio is normalized in apply (with
  // a logged fallback) instead of failing plugin load, so a misconfiguration
  // can never take the host process down.
  thresholdRatio: z.number().default(0.85),
  wrapUpPrompt: z.string().default(DEFAULT_WRAP_UP_PROMPT),
  resumePrompt: z.string().default(DEFAULT_RESUME_PROMPT),
  autoCompactOnIdle: z.boolean().default(true),
  resumeAfterCompact: z.boolean().default(true),
})

/** The plugin source stamped on every injected context message. */
const PLUGIN_SOURCE = {
  kind: 'plugin',
  plugin: 'context-guard',
} as const

/** One-line account of the wrap-up reminder for collapsed transcript rows. */
const WRAP_UP_SUMMARY = '上下文超过阈值，已提醒 agent 收尾'
/** One-line account of the post-compaction resume for collapsed transcript rows. */
const RESUME_SUMMARY = '上下文已压缩，已恢复任务'

/** Request pressure relative to the routed model's context capacity. */
interface Pressure {
  /** The routed provider route. */
  provider: string
  /** Token-meter request pressure of the whole session surface. */
  totalTokens: number
  /** The routed model's declared combined request-and-response window. */
  contextWindow: number
  /** `totalTokens / contextWindow`. */
  ratio: number
}

/**
 * Settings-provided absolute thresholds (in tokens) per provider route. The
 * `context-guard` settings namespace lets the web UI configure these; values
 * are merged over the config's percentage fallback. `0` means "not set".
 */
interface ThresholdOverrides {
  /** Global absolute threshold applied to every provider without an entry. */
  defaultTokens: number
  /** Per-provider absolute thresholds, keyed by provider route id. */
  providerTokens: Map<string, number>
}

/** The settings namespace value: absolute token thresholds per provider. */
interface ThresholdSettingsValue {
  /** Global absolute threshold applied to every provider without an entry; `0` means unset. */
  defaultThresholdTokens: number
  /** Per-provider absolute thresholds, keyed by provider route id. */
  providerThresholds: { provider: string; thresholdTokens: number }[]
}

/** The composition fallback: no settings layer configured means every value unset. */
const EMPTY_THRESHOLDS: ThresholdSettingsValue = {
  defaultThresholdTokens: 0,
  providerThresholds: [],
}

/** The settings namespace schema: absolute token thresholds per provider. */
const settingsSchema: z<ThresholdSettingsValue> = z.object({
  defaultThresholdTokens: z.number().step(1).min(0).default(0),
  providerThresholds: z.array(z.object({
    provider: z.string().required(),
    thresholdTokens: z.number().step(1).min(1).required(),
  })).default([]),
})

/** Extract the live threshold overrides from a resolved settings value. */
function overridesOf(value: ThresholdSettingsValue): ThresholdOverrides {
  const providerTokens = new Map<string, number>()
  for (const entry of value.providerThresholds) {
    providerTokens.set(entry.provider, entry.thresholdTokens)
  }
  return { defaultTokens: value.defaultThresholdTokens, providerTokens }
}

/** One session's over-threshold episode state; entries are GC'd with the session. */
interface EpisodeState {
  /** A wrap-up reminder was queued this episode. */
  warned: boolean
  /** An idle-session compaction landed this episode. */
  compacted: boolean
  /** An idle-session compaction is in flight. */
  compacting: boolean
  /** Chain of in-flight step-end evaluations; pre-step awaits the latest link. */
  evaluation: Promise<void>
  /** Reminder produced by the latest settled evaluation, folded once at the next pre-step. */
  pendingReminder: UserMessage | undefined
}

/**
 * Install the guard's listeners.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - validated {@link Config}; schemastery's `.default()` guarantees
 *   the fields are set after validation. An invalid ratio never throws: the
 *   guard reports it and falls back to the default, so a misconfiguration can
 *   never take the host process down.
 */
export function apply(ctx: Context, config: Config = {}): void {
  let thresholdRatio = config.thresholdRatio as number
  const wrapUpPrompt = config.wrapUpPrompt as string
  const resumePrompt = config.resumePrompt as string
  const autoCompactOnIdle = config.autoCompactOnIdle as boolean
  const resumeAfterCompact = config.resumeAfterCompact as boolean
  if (!Number.isFinite(thresholdRatio) || thresholdRatio < 0 || thresholdRatio > 1) {
    ctx.logger.error(
      `context-guard: invalid thresholdRatio ${thresholdRatio} — must be a finite number in [0, 1]; using default 0.85`,
    )
    thresholdRatio = 0.85
  }

  // The settings seam is optional: without a provider the guard falls back to
  // the config's percentage ratio. Registration uses the official
  // installSettingsSection helper, which waits for the settings service via
  // ctx.inject (declarative, retried on service changes) rather than reading
  // ctx.get('settings') once at apply time — the eager read could run before
  // the settings provider finished loading and silently skip registration
  // forever. The composition entry (no base layer) is the fallback source.
  let thresholds: ThresholdOverrides | undefined
  let settingsSource: () => ThresholdSettingsValue = () => EMPTY_THRESHOLDS
  installSettingsSection(ctx, settingsNamespace('context-guard'), settingsSchema, EMPTY_THRESHOLDS, {
    setSource: (current) => { settingsSource = current },
    onChange: () => { thresholds = overridesOf(settingsSource()) },
  })

  /**
   * The absolute token threshold in force for one provider route: the
   * per-provider settings entry, else the settings default, else the config
   * percentage ratio converted against the model's context window.
   */
  function thresholdTokensFor(provider: string, contextWindow: number): number {
    const overrides = thresholds
    const explicit = overrides?.providerTokens.get(provider) ?? overrides?.defaultTokens ?? 0
    return explicit > 0 ? explicit : Math.round(contextWindow * thresholdRatio)
  }

  const states = new WeakMap<Session, EpisodeState>()

  function stateOf(session: Session): EpisodeState {
    let state = states.get(session)
    if (state === undefined) {
      state = {
        warned: false,
        compacted: false,
        compacting: false,
        evaluation: Promise.resolve(),
        pendingReminder: undefined,
      }
      states.set(session, state)
    }
    return state
  }

  /** A `notice`-form plugin source carrying one one-line account. */
  function pluginSource(summary: string): { kind: 'plugin'; plugin: 'context-guard'; form: 'notice'; summary: string } {
    return { ...PLUGIN_SOURCE, form: 'notice', summary }
  }

  /**
   * Measure request pressure against the routed model's context window.
   * @param agent - agent whose latest durable routed request is measured.
   * @returns the pressure, or undefined when no request header exists yet or
   *   the routed model declares no context window.
   */
  async function measurePressure(agent: Agent): Promise<Pressure | undefined> {
    const header = agent.session.requestHeader()
    const provider = header?.config.provider
    const model = header?.config.model
    if (provider === undefined || provider.length === 0 || model === undefined || model.length === 0) {
      return undefined
    }
    const info = await ctx.llm.resolveModelInfo(provider, model)
    const contextWindow = info.context?.contextWindow
    if (contextWindow === undefined) return undefined
    const totalTokens = ctx.tokenMeter.measure(agent.session).totalTokens
    return { provider, totalTokens, contextWindow, ratio: totalTokens / contextWindow }
  }

  /**
   * Whether the step's assistant message carried tool calls, i.e. the turn
   * owes another request after this step. A step that ended without tool
   * calls closes the turn; there is nothing to remind, and the idle
   * compaction owns recovery.
   */
  function stepOwesMoreWork(session: Session, turn: number, step: number): boolean {
    const message = session.events.findLast((event): event is SessionEvent<'assistant/message'> =>
      event.type === 'assistant/message' && event.data.turn === turn && event.data.step === step)
    return message !== undefined
      && message.data.message.content.some(block => block.type === 'tool-call')
  }

  /** Evaluate one ended step and queue the wrap-up reminder when warranted. */
  async function evaluateStepEnd(agent: Agent, turn: number, step: number, state: EpisodeState): Promise<void> {
    const pressure = await measurePressure(agent)
    if (pressure === undefined) return
    if (pressure.totalTokens < thresholdTokensFor(pressure.provider, pressure.contextWindow)) {
      state.warned = false
      state.compacted = false
      state.pendingReminder = undefined
      return
    }
    if (state.warned || wrapUpPrompt.length === 0) return
    if (!stepOwesMoreWork(agent.session, turn, step)) return
    state.pendingReminder = createUserMessage({
      content: [{ type: 'text', text: wrapUpPrompt }],
      source: pluginSource(WRAP_UP_SUMMARY),
    })
    state.warned = true
    ctx.logger.info(
      `context-guard: ${agent.id} at ${pressure.totalTokens} of `
      + `${thresholdTokensFor(pressure.provider, pressure.contextWindow)}-token threshold `
      + `(${Math.round(pressure.ratio * 100)}% of ${pressure.contextWindow}); queued wrap-up reminder`,
    )
  }

  ctx.on('session/event', (session, event) => {
    if (event.type === 'step/end') {
      const agent = ctx.agents.get(session.id)
      if (agent === undefined) return
      const state = stateOf(session)
      // Serialize evaluations so a slower earlier one cannot clobber a newer
      // decision; the chain promise never rejects (pre-step awaits it).
      state.evaluation = state.evaluation
        .then(() => evaluateStepEnd(agent, event.data.turn, event.data.step, state))
        .catch((error: unknown) => {
          ctx.logger.warn(`context-guard: step-end evaluation failed for ${agent.id}: ${String(error)}`)
        })
      return
    }
    if (event.type !== 'compaction/end') return
    if (event.data.error !== undefined || resumePrompt.length === 0 || !resumeAfterCompact) return
    // A stale wrap-up reminder must not steer the resumed turn.
    stateOf(session).pendingReminder = undefined
    const agent = ctx.agents.get(session.id)
    if (agent === undefined) return
    // Deferred: this listener runs inside the compaction/end append dispatch,
    // and appending the follow-up splice would reenter that publication.
    queueMicrotask(() => {
      try {
        if (agent.status !== 'idle') return
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: resumePrompt }],
          source: pluginSource(RESUME_SUMMARY),
        }))
        ctx.logger.info(`context-guard: resumed ${agent.id} after compaction`)
      } catch (error: unknown) {
        ctx.logger.warn(`context-guard: resume after compaction failed for ${agent.id}: ${String(error)}`)
      }
    })
  })

  // Fold a pending wrap-up reminder into the entering messages after the
  // claimed batch, so it reaches the very next request deterministically
  // (agent.inject() from an async step-end listener would miss the claim).
  // A tool-continuation step may claim nothing (tool results enter the model
  // history from the log), so the reminder folds into an empty entered batch;
  // only a genuinely empty FIRST step owns a no-request turn and keeps the
  // reminder pending. Any guard failure here degrades to the unmodified
  // decision, so the loop is never disturbed.
  ctx.on('agent/pre-step', async ({ agent, messages, step }, next): Promise<PreStepDecision> => {
    try {
      const state = stateOf(agent.session)
      await state.evaluation
      const reminder = state.pendingReminder
      if (reminder === undefined) return next()
      const decision = await next()
      if (decision.kind === 'reject' || (step === 1 && decision.messages.length === 0)) return decision
      state.pendingReminder = undefined
      const lastClaimedIndex = decision.messages.findLastIndex(message => messages.includes(message))
      const entered = decision.messages.toSpliced(lastClaimedIndex + 1, 0, reminder)
      return { ...decision, messages: entered }
    } catch (error: unknown) {
      ctx.logger.warn(`context-guard: pre-step fold failed for ${agent.id}: ${String(error)}`)
      return next()
    }
  })

  const compactionController = new AbortController()
  ctx.effect(() => () => { compactionController.abort() })
  const compactionSignal = compactionController.signal

  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return
    void handleIdle(agent)
  })

  /** Warn once per plugin instance when no compaction provider is available. */
  let warnedNoProvider = false

  /** Compact one idle over-threshold session, once per episode. */
  async function handleIdle(agent: Agent): Promise<void> {
    const state = stateOf(agent.session)
    if (state.compacting) return
    state.compacting = true
    try {
      const pressure = await measurePressure(agent)
      if (pressure === undefined) return
      if (pressure.totalTokens < thresholdTokensFor(pressure.provider, pressure.contextWindow)) {
        state.warned = false
        state.compacted = false
        return
      }
      if (!autoCompactOnIdle || state.compacted) return
      // Compaction is an optional service: web compositions may leave it to
      // their agent presets, so a missing provider degrades hooks 2/3 (with
      // the wrap-up reminder still active) instead of blocking boot.
      const compaction = ctx.get('compaction')
      if (compaction === undefined) {
        if (!warnedNoProvider) {
          warnedNoProvider = true
          ctx.logger.warn('context-guard: no compaction provider loaded; idle auto-compaction is disabled')
        }
        return
      }
      const result = await compaction.compactNow(agent, compactionSignal)
      if (result !== null) {
        state.compacted = true
        ctx.logger.info(
          `context-guard: ${agent.id} idle at ${pressure.totalTokens} of `
          + `${thresholdTokensFor(pressure.provider, pressure.contextWindow)}-token threshold `
          + `(${Math.round(pressure.ratio * 100)}% of ${pressure.contextWindow}); `
          + `compacted ${result.shadowedSeqs.length} surface nodes`,
        )
      }
    } catch (error: unknown) {
      ctx.logger.warn(`context-guard: idle compaction failed for ${agent.id}: ${String(error)}`)
    } finally {
      state.compacting = false
    }
  }
}
