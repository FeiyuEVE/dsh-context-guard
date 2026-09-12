/**
 * Context-pressure guard: wraps up over-threshold turns, compacts idle
 * sessions, and resumes the task after a completed compaction.
 *
 * The guard owns one closed loop per session:
 *
 * 1. `step/end` — after a step that still owes another model request, the
 *    session's request pressure is measured against the routed model's
 *    context window. Above the threshold the guard queues a wrap-up reminder
 *    that the next `agent/pre-step` folds into the entering messages, so the
 *    model sees it before its very next action and wraps the turn up instead
 *    of extending it.
 * 2. `agent/status` idle — when the agent stops and the session is still over
 *    the threshold, the guard runs `compaction.compactNow()` once per
 *    over-threshold episode. The engine is resolved per agent: a host-plane
 *    provider first, else the instance the agent's preset mounted behind its
 *    `isolate` realm (via the `agentPresets` seam), so preset-owned backends
 *    are reachable from this host-mounted guard.
 * 3. `compaction/end` — after a successful compaction of an idle agent, the
 *    guard queues a continuation prompt and wakes the driver, so the task
 *    resumes on the compacted surface instead of sitting idle.
 * 4. `compaction/summary` — for a compaction some *other* backend ran (the
 *    `standard` preset's `compaction-basic`, a manual `/compact`), the guard
 *    writes the deterministic `raw` + `digest` pair beside that backend's
 *    checkpoint. The backend stays in charge of the checkpoint the model sees;
 *    this is a side-car, and it is why the archive works with zero preset
 *    edits. Compactions this plugin's own engine ran are skipped — it wrote
 *    them itself, before the region was shadowed.
 *
 * The continuation prompt is not a fixed string: it is rendered from measured
 * facts (how often this session compacted inside a sliding window, the digest
 * the backend wrote, the pending todo list, whether the session actually
 * carries a delegation tool) and escalates with frequency. Above
 * `resumeMaxPerWindow` automatic compactions the guard stops waking the agent
 * entirely — a compaction/resume loop that keeps repeating burns tokens
 * without changing the working style that causes it.
 *
 * All injected content is user-role context stamped with the plugin source
 * (`{ kind: 'plugin', plugin: 'context-guard' }`), so it is durable in the
 * session log and reconstructable (model-visible ⟺ logged).
 *
 * @module dsh-context-guard
 */

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
// Type-only: pulls in the `ctx.compaction` / `ctx.tokenMeter` / `ctx.settings`
// declaration merges.
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-settings'
import { writeArchive } from './archive.ts'
import type { Artifacts } from './archive.ts'
import { DIGEST_FORMAT_VERSION, FRAME_MARKER, digestPathFrom, estimateTextTokens } from './digest.ts'
import { createLogSink, logInfo, logWarn } from './log.ts'
import { archiveLocation, digestPointerCandidates, handoffNotePath } from './paths.ts'
import {
  DEFAULT_RESUME_PROMPT,
  DEFAULT_WRAP_UP_PROMPT,
  buildWrapUpPrompt,
  decideResume,
} from './resume-prompt.ts'
import {
  availableToolNames,
  checkpointText,
  compactionPace,
  lastHumanIntent,
  pendingTodos,
} from './session-facts.ts'
import {
  SETTINGS_DEFAULTS,
  SETTINGS_NAMESPACE,
  overridesOf,
  resolveDigestConfig,
  settingsSchema,
  withDefaults,
} from './settings.ts'
import type { ContextGuardSettingsValue, ThresholdOverrides } from './settings.ts'

export const name = 'context-guard'

/** Required services: routed-model metadata, token measurement, and the live agent registry. */
export const inject = ['llm', 'tokenMeter', 'agents']

/** Default delegation-capable tool names, matched against the session's request header. */
const DEFAULT_DELEGATION_TOOLS = ['subagent', 'subagent_fork', 'workflow', 'ralph']

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
   * (default asks the agent to continue from the archived state).
   */
  resumePrompt?: string
  /** Whether an over-threshold idle session is compacted automatically (default `true`). */
  autoCompactOnIdle?: boolean
  /** Whether a completed compaction resumes the idle agent (default `true`). */
  resumeAfterCompact?: boolean
  /**
   * Tool names that count as delegation-capable when the guard suggests
   * splitting context-hungry work (default `subagent`, `subagent_fork`,
   * `workflow`, `ralph`). A name absent from the session's request header is
   * never suggested.
   */
  delegationTools?: string[]
}

export const Config: z<Config> = z.object({
  // Unbounded on purpose: an out-of-range ratio is normalized in apply (with
  // a logged fallback) instead of failing plugin load, so a misconfiguration
  // can never take the host process down.
  thresholdRatio: z.number().default(0.85),
  wrapUpPrompt: z.string().default(DEFAULT_WRAP_UP_PROMPT),
  resumePrompt: z.string().default(DEFAULT_RESUME_PROMPT),
  autoCompactOnIdle: z.boolean().default(true),
  resumeAfterCompact: z.boolean().default(true),
  delegationTools: z.array(z.string()).default(DEFAULT_DELEGATION_TOOLS),
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
/** One-line account of a suppressed resume for collapsed transcript rows. */
const RESUME_HOLD_SUMMARY = '压缩过于频繁，已暂停自动续跑'

/**
 * Filename prefix shared by every artifact of one compaction: the side-car
 * `raw`/`digest` pair, the engine's pair, and the wrap-up note. The guard does
 * not read the engine row's `epochPrefix` config, so it uses the default; a
 * row that renames its prefix gets two naming schemes in one directory, which
 * is why the default is the only prefix the guard ever assumes.
 */
const EPOCH_PREFIX = 'epoch'

/** How many `compactionId → archive paths` records one session keeps. */
const ARCHIVE_RECORD_LIMIT = 8

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
 * The one `agentPresets` seam method the guard reads: the service instance an
 * agent's preset mounted behind an `isolate` realm. Such an instance is
 * invisible to every context outside the preset group — including the host
 * fiber this guard runs on — so the seam is the supported read path for it.
 */
interface PresetServiceSeam {
  serviceFor<K extends string & keyof Context>(agent: { ctx: Context }, name: K): Context[K] | undefined
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
 * Resolve one template through the shared precedence: the settings value wins
 * whenever it is present, else the composition config, else the built-in text.
 *
 * The composition value is already baked into the settings base layer at
 * registration (`baseSettings`), so the resolved settings value is normally the
 * effective one and must be taken *verbatim* — including the empty string.
 * Clearing a template field in the Web panel is how a user disables that
 * injection, and a `length > 0` guard here would silently fall back to the
 * composition text, making the injection impossible to turn off from the UI
 * (found by browser verification on 2026-09-12).
 */
function pickTemplate(settingValue: string | undefined, configValue: string | undefined, builtin: string): string {
  if (settingValue !== undefined) return settingValue
  return configValue ?? builtin
}

/**
 * Absolute path of a raw archive referenced anywhere in one frame text.
 *
 * Absolute-only, like {@link digestPathFrom}: a bare `epoch-N.raw.md` in prose
 * is a filename pattern, not a file this session wrote.
 */
function rawPathFrom(text: string): string | undefined {
  const fenced = [...text.matchAll(/`([^`\n]*\.raw\.md)`/g)]
    .map(match => match[1] ?? '')
    .filter(candidate => path.isAbsolute(candidate))
  return fenced.length > 0 ? fenced[fenced.length - 1] : undefined
}

/** The candidate itself when it is an existing regular file, else undefined. */
async function existingFile(candidate: string | undefined): Promise<string | undefined> {
  if (candidate === undefined) return undefined
  try {
    return (await stat(candidate)).isFile() ? candidate : undefined
  } catch {
    return undefined
  }
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
  // One sink for the whole plugin: cordis logger plus the console line that is
  // actually observable in a composition with no logger exporter.
  const log = createLogSink(ctx.logger)
  let thresholdRatio = config.thresholdRatio as number
  const wrapUpPrompt = config.wrapUpPrompt as string
  const resumePrompt = config.resumePrompt as string
  const autoCompactOnIdle = config.autoCompactOnIdle as boolean
  const resumeAfterCompact = config.resumeAfterCompact as boolean
  const delegationTools = config.delegationTools as string[]
  if (!Number.isFinite(thresholdRatio) || thresholdRatio < 0 || thresholdRatio > 1) {
    logWarn(log, '', 'invalid-threshold-ratio', { value: thresholdRatio, fallback: 0.85 })
    thresholdRatio = 0.85
  }

  // The composition base layer: config-derived templates plus the built-in
  // defaults, so `scope.get()` alone already answers "settings > config >
  // default" and a composition that never mounts a settings provider degrades
  // to exactly the config it declared.
  const baseSettings: ContextGuardSettingsValue = {
    ...SETTINGS_DEFAULTS,
    wrapUpPromptTemplate: wrapUpPrompt,
    resumePromptTemplate: resumePrompt,
  }
  let settingsValue: Partial<ContextGuardSettingsValue> = baseSettings
  let thresholds: ThresholdOverrides | undefined

  // The settings seam is optional: without a provider the guard falls back to
  // the config's percentage ratio. Registration waits on the settings service
  // via ctx.inject (declarative, retried on service changes) rather than
  // reading ctx.get('settings') once at apply time — the eager read could run
  // before the settings provider finished loading and silently skip
  // registration forever.
  ctx.inject(['settings'], (settingsCtx) => {
    const scope = settingsCtx.settings.register(SETTINGS_NAMESPACE, settingsSchema, {
      base: baseSettings,
    })
    settingsValue = scope.get()
    thresholds = overridesOf(settingsValue)
    scope.watch(() => {
      settingsValue = scope.get()
      thresholds = overridesOf(settingsValue)
    })
    settingsCtx.effect(() => () => {
      settingsValue = baseSettings
      thresholds = undefined
    }, 'context-guard settings source')
  })

  /** The resolved settings value with every absent field defaulted. */
  function settings(): ContextGuardSettingsValue {
    return withDefaults(settingsValue)
  }

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
    const message = session.snapshotEvents().findLast((event): event is SessionEvent<'assistant/message'> =>
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
    const template = pickTemplate(settings().wrapUpPromptTemplate, wrapUpPrompt, DEFAULT_WRAP_UP_PROMPT)
    if (state.warned || template.length === 0) return
    if (!stepOwesMoreWork(agent.session, turn, step)) return
    const note = handoffNote(agent)
    state.pendingReminder = createUserMessage({
      content: [{
        type: 'text',
        text: buildWrapUpPrompt(template, {
          todos: pendingTodos(agent.session),
          epoch: note.epoch,
          notePath: note.path,
        }),
      }],
      source: pluginSource(WRAP_UP_SUMMARY),
    })
    state.warned = true
    logInfo(log, '', 'wrap-up-queued', {
      agent: agent.id,
      tokens: pressure.totalTokens,
      threshold: thresholdTokensFor(pressure.provider, pressure.contextWindow),
      ratio: Math.round(pressure.ratio * 100),
      window: pressure.contextWindow,
    })
  }

  /**
   * The digest this engine wrote for one compaction: taken from the checkpoint
   * frame (authoritative and configuration-independent), else probed from the
   * default archive base as a fallback.
   *
   * A frame without {@link FRAME_MARKER} is not this engine's pointer frame but
   * another compaction engine's summary — ordinary prose that may quote
   * archive-looking text — so it can vouch for no digest at all.
   */
  async function digestPathFor(agent: Agent, frame: string): Promise<string | undefined> {
    if (!frame.includes(FRAME_MARKER)) return undefined
    const fromFrame = digestPathFrom(frame)
    if (fromFrame !== undefined) return fromFrame
    const cwd = agent.session.header?.cwd
    if (cwd === undefined || cwd.length === 0) return undefined
    for (const candidate of digestPointerCandidates(path.join(cwd, '.handoff'), String(agent.session.id))) {
      try {
        const value = (await readFile(candidate, 'utf8')).trim()
        if (value.length > 0) return value
      } catch {
        // Missing pointer: try the next layout.
      }
    }
    return undefined
  }

  /**
   * Absolute archive base directory for one agent, or undefined when the
   * session exposes no working directory.
   *
   * A base that is not absolute is *not* usable for writing: `.handoff` would
   * resolve against whatever directory the host process happens to run in.
   * {@link sessionArchiveDir} still falls back to the relative form because it
   * only renders prompt text.
   */
  function archiveBase(agent: Agent): string | undefined {
    return sessionBase(agent.session)
  }

  /**
   * Absolute archive base directory for one session, or undefined when it
   * exposes no working directory.
   *
   * A base that is not absolute is *not* usable for writing: `.handoff` would
   * resolve against whatever directory the host process happens to run in.
   * {@link sessionArchiveDir} still falls back to the relative form because it
   * only renders prompt text.
   */
  function sessionBase(session: Session): string | undefined {
    const cwd = session.header?.cwd
    if (cwd === undefined || cwd.length === 0) return undefined
    return path.join(cwd, '.handoff')
  }

  /**
   * This session's artifact directory: the same resolved base and layout the
   * engine archives into, since both read the same settings layer.
   */
  function sessionArchiveDir(agent: Agent): string {
    const base = archiveBase(agent) ?? '.handoff'
    return archiveLocation(base, String(agent.session.id), settings().archiveLayout).dir
  }

  /**
   * This session's wrap-up note: the path the reminder tells the agent to write,
   * plus the compaction number both that path and the note title carry.
   *
   * The number is the *coming* compaction's — the note is written just before
   * the cut it hands off from — counted the way the continuation prompt counts
   * them: every compaction of this session, automatic or manual.
   *
   * The directory is deliberately not created here: the `write` tool creates
   * parent directories, and creating it eagerly would leave empty session
   * directories behind for sessions that never archive (that emptiness is also
   * how "this session archived nothing" is recognized on disk).
   */
  function handoffNote(agent: Agent): { epoch: number; path: string; dir: string } {
    const dir = sessionArchiveDir(agent)
    const epoch = compactionPace(agent.session, Date.now(), settings().resumeWindowMinutes).sessionTotal + 1
    return { epoch, path: handoffNotePath(dir, epoch), dir: `${dir}/` }
  }

  /**
   * What the guard's own side-car writer produced for one compaction, keyed by
   * `compactionId` inside one session. The value is the *in-flight* promise,
   * so the continuation prompt can wait for it: the write is fire-and-forget
   * from `compaction/summary`, while the continuation is rendered one
   * `compaction/end` later — from a microtask that routinely wins the race
   * against the first filesystem call.
   *
   * The continuation prompt must name files that exist, and a
   * `compaction-basic` checkpoint is a model-written summary that carries no
   * path — the guard's own frame marker is absent from it by definition. This
   * record is the guard's own memory of what *it* wrote, and it is
   * authoritative in a way a text scrape can never be, so it is consulted
   * first; the frame scan remains for compactions this guard did not archive
   * (an `ArchiveCutEngine` preset, whose frame does carry the paths).
   */
  const archiveRecords = new WeakMap<Session, Map<string, Promise<Artifacts>>>()

  /** Remember one compaction's pending or landed artifacts, keeping the newest few. */
  function recordArchive(session: Session, compactionId: string, work: Promise<Artifacts>): void {
    let records = archiveRecords.get(session)
    if (records === undefined) {
      records = new Map()
      archiveRecords.set(session, records)
    }
    records.set(compactionId, work)
    while (records.size > ARCHIVE_RECORD_LIMIT) {
      const oldest = records.keys().next()
      if (oldest.done === true) break
      records.delete(oldest.value)
    }
  }

  /**
   * Archive one compaction the guard did not run itself.
   *
   * This is the "side-car" half of the plugin: whatever engine the preset
   * mounted stays in charge of the checkpoint the model sees, and the guard
   * only adds the deterministic `raw` + `digest` pair beside it. Everything
   * here is fire-and-forget — `session/event` is a plain cordis `emit`, whose
   * listeners are not awaited, and the backend appends the region's
   * replacement immediately after this event. The region's events are read
   * from the append-only log, so they are still there when this runs; the
   * files, however, may land after the surface has already moved on (see
   * `docs/gotchas.md`).
   *
   * @param session - session whose compaction committed the summary.
   * @param compactionId - id of that compaction, the key of the archive record.
   * @param shadowedSeqs - the shadowed surface nodes, captured synchronously.
   * @returns what landed; never rejects.
   */
  async function writeSidecar(
    session: Session,
    compactionId: string,
    shadowedSeqs: readonly SessionSeq[],
  ): Promise<Artifacts> {
    try {
      const base = sessionBase(session)
      if (base === undefined) {
        logWarn(log, 'sidecar', 'skipped', { reason: 'no-cwd', session: String(session.id) })
        return {}
      }
      const messages = shadowedSeqs
        .map(seq => session.eventAt(seq))
        .filter((event): event is SessionEvent => event !== undefined)
        .map(event => session.deriveEventMessage(event))
        .filter((message): message is Message => message !== null)
      if (messages.length === 0) {
        logWarn(log, 'sidecar', 'skipped', { reason: 'empty-region', session: String(session.id) })
        return {}
      }
      const resolved = settings()
      // The same number the wrap-up note carried: this compaction's ordinal
      // among the session's compactions. `compaction/end` has not been
      // appended yet, so the pace still counts the compactions before this one.
      const epoch = compactionPace(session, Date.now(), resolved.resumeWindowMinutes).sessionTotal + 1
      const artifacts = await writeArchive({
        base,
        layout: resolved.archiveLayout,
        epochPrefix: EPOCH_PREFIX,
        sessionId: String(session.id),
        messages,
        config: resolveDigestConfig(resolved),
        log,
        logScope: 'sidecar',
        minEpoch: epoch,
      })
      logInfo(log, 'sidecar', 'archived', {
        session: String(session.id),
        compaction: compactionId,
        epoch: artifacts.epoch,
        messages: messages.length,
        raw: artifacts.rawPath,
        digest: artifacts.digestPath,
      })
      return artifacts
    } catch (error: unknown) {
      logWarn(log, 'sidecar', 'failed', { session: String(session.id), error: String(error) })
      return {}
    }
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
          logWarn(log, '', 'step-end-failed', { agent: agent.id, error: String(error) })
        })
      return
    }
    if (event.type === 'compaction/summary') {
      // A `context-guard` summary is this plugin's own engine, which already
      // wrote the pair while it summarized — before the region was shadowed.
      // Only other backends need the side-car.
      if (event.data.provider !== 'context-guard') {
        const compactionId = String(event.data.compactionId)
        recordArchive(
          session,
          compactionId,
          writeSidecar(session, compactionId, [...event.data.shadowedSeqs]),
        )
      }
      return
    }
    if (event.type !== 'compaction/end') return
    if (event.data.error !== undefined) {
      logWarn(log, 'resume', 'skipped', { reason: 'compaction-error', error: event.data.error })
      return
    }
    if (!resumeAfterCompact) return
    // A stale wrap-up reminder must not steer the resumed turn.
    stateOf(session).pendingReminder = undefined
    const agent = ctx.agents.get(session.id)
    if (agent === undefined) return
    // Deferred: this listener runs inside the compaction/end append dispatch,
    // and appending the follow-up splice would reenter that publication.
    queueMicrotask(() => {
      void resumeAfter(agent, String(event.data.compactionId))
    })
  })

  /** Render and deliver (or deliberately withhold) the post-compaction continuation. */
  async function resumeAfter(agent: Agent, compactionId: string): Promise<void> {
    try {
      if (agent.status !== 'idle') return
      const resolved = settings()
      const template = pickTemplate(resolved.resumePromptTemplate, resumePrompt, DEFAULT_RESUME_PROMPT)
      if (template.length === 0) return
      const frame = checkpointText(agent.session, compactionId)
      // Two sources, in trust order:
      // 1. the guard's own record of the side-car it wrote for this exact
      //    compaction — exact, and the only source for a backend whose
      //    checkpoint is a model-written summary;
      // 2. the deterministic pointer frame an `ArchiveCutEngine` returns,
      //    which describes real archives only when it carries the marker
      //    (a foreign summary's paths are prose).
      // Every pointer is then re-checked against the filesystem, so the
      // prompt never names a file that is not there.
      const pending = archiveRecords.get(agent.session)?.get(compactionId)
      const recorded = pending === undefined ? undefined : await pending
      const ownsFrame = frame.includes(FRAME_MARKER)
      const digestPath = await existingFile(
        recorded?.digestPath ?? (ownsFrame ? await digestPathFor(agent, frame) : undefined),
      )
      const rawPath = await existingFile(recorded?.rawPath ?? (ownsFrame ? rawPathFrom(frame) : undefined))
      const pace = compactionPace(agent.session, Date.now(), resolved.resumeWindowMinutes)
      const delegation = availableToolNames(agent.session)
        .filter(tool => delegationTools.includes(tool))
      const decision = decideResume(template, {
        compactionsInWindow: pace.autoInWindow,
        windowMinutes: resolved.resumeWindowMinutes,
        maxPerWindow: resolved.resumeMaxPerWindow,
        epoch: pace.sessionTotal,
        digestPath,
        rawPath,
        todos: pendingTodos(agent.session),
        intent: lastHumanIntent(agent.session),
        noteDir: `${sessionArchiveDir(agent)}/`,
        delegationTools: delegation,
      }, { escalation: resolved.resumeEscalation })
      const promptTokens = estimateTextTokens(decision.prompt, resolved.digestTokenEstimator)
      if (decision.suppress) {
        logWarn(log, 'resume', 'suppressed', {
          agent: agent.id,
          compaction: pace.sessionTotal,
          inWindow: pace.autoInWindow,
          window: resolved.resumeWindowMinutes,
        })
        agent.send(createUserMessage({
          content: [{ type: 'text', text: decision.prompt }],
          source: pluginSource(RESUME_HOLD_SUMMARY),
        }), 'next-turn', false)
        return
      }
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: decision.prompt }],
        source: pluginSource(RESUME_SUMMARY),
      }))
      logInfo(log, 'resume', 'sent', {
        agent: agent.id,
        compaction: pace.sessionTotal,
        inWindow: pace.autoInWindow,
        level: decision.level,
        digest: digestPath,
        promptTokens,
      })
    } catch (error: unknown) {
      logWarn(log, 'resume', 'failed', { agent: agent.id, error: String(error) })
    }
  }

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
      logWarn(log, '', 'pre-step-fold-failed', { agent: agent.id, error: String(error) })
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
      // Compaction is an optional service, and where it lives depends on the
      // composition. Web profiles keep it preset-owned: `compaction-basic`
      // mounts behind the preset's `isolate` realm, invisible to the host
      // fiber this guard runs on, so the host lookup alone misses every
      // preset composition. The agentPresets seam is the supported read path
      // for exactly that case — the instance the agent's own composition
      // mounted. Host-plane providers (tests, non-preset compositions)
      // resolve through `ctx.get` first. A missing provider degrades hooks
      // 2/3 (with the wrap-up reminder still active) instead of blocking
      // boot.
      const compaction = ctx.get('compaction')
        ?? (ctx.get('agentPresets') as PresetServiceSeam | undefined)?.serviceFor(agent, 'compaction')
      if (compaction === undefined) {
        if (!warnedNoProvider) {
          warnedNoProvider = true
          logWarn(log, '', 'no-compaction-provider', { note: 'idle auto-compaction disabled' })
        }
        return
      }
      const result = await compaction.compactNow(agent, compactionSignal)
      if (result !== null) {
        state.compacted = true
        logInfo(log, '', 'idle-compacted', {
          agent: agent.id,
          tokens: pressure.totalTokens,
          threshold: thresholdTokensFor(pressure.provider, pressure.contextWindow),
          ratio: Math.round(pressure.ratio * 100),
          window: pressure.contextWindow,
          shadowed: result.shadowedSeqs.length,
        })
      }
    } catch (error: unknown) {
      logWarn(log, '', 'idle-compaction-failed', { agent: agent.id, error: String(error) })
    } finally {
      state.compacting = false
    }
  }
}

/** Re-exported for tests and host-side consumers. */
export { DIGEST_FORMAT_VERSION }
