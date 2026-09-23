/**
 * The `context-guard` configuration surface: one schema and one resolution
 * order shared by the host guard row and the compaction backend.
 *
 * dsh 0.1.7 replaced the register-a-namespace settings provider with
 * `SettingsForms`: a settings form *is* the live half of one profile entry's
 * own Config, and the profile patch a form write lands in is that entry's
 * config. So the knobs below are declared as `Volatile<T>` fields of the guard
 * row ({@link settingsFields}, spread into `Config` by `index.ts`) instead of
 * being registered under a namespace key. The Web panel keeps editing the same
 * fifteen fields under their original names — the panel is now the entry's
 * auto-generated form, addressed by profile entry id rather than by a
 * registered namespace.
 *
 * The guard reads its own knobs through those references, so `.get()` already
 * answers "user override > composition config > built-in default". The archive
 * engine is a *separate* row (a preset may reference it by absolute file path,
 * i.e. from another module graph, where the guard's Config object is not
 * reachable at all), so it still reads the guard entry's explicitly-set layer
 * through {@link userLayerOf}: the settings service remains the only shared
 * channel between the two, and a module-level singleton still would not be.
 *
 * Resolution order, everywhere:
 *   settings user layer  >  composition config  >  built-in default.
 *
 * @module dsh-context-guard/settings
 */

import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
// Type-only: pulls in the `ctx.settings` declaration merge.
import type {} from '@deepseek-ai/dsh-settings'
import type { DigestEstimator } from './digest.ts'
import type { ArchiveLayout } from './paths.ts'

/**
 * The profile entry id whose form carries this plugin's knobs.
 *
 * A form namespace is the local id of one profile entry, so this is the id
 * `cordis.patch.yml` gives the guard row (`id: context-guard`); the archive
 * engine matches the same string against `describe()` descriptors. A row
 * mounted under a different id keeps its own form — the Web panel still edits
 * it — but the engine's user-layer read cannot find it, exactly the limitation
 * the registered namespace name had before 0.1.7.
 */
export const SETTINGS_NAMESPACE = 'context-guard'

/** One provider route's absolute token threshold. */
export interface ProviderThreshold {
  /** Registered provider route id. */
  provider: string
  /** Absolute token count. */
  thresholdTokens: number
}

/** The settings namespace value: every knob the Web panel may override. */
export interface ContextGuardSettingsValue {
  /** Global absolute threshold for routes without an entry; `0` means unset. */
  defaultThresholdTokens: number
  /** Per-route absolute thresholds, overriding the global one. */
  providerThresholds: readonly ProviderThreshold[]
  /** Whether a completed compaction writes a digest document. */
  digestEnabled: boolean
  /** Upper bound on digest size, in estimated tokens. */
  digestMaxTokens: number
  /** Fraction of the compacted region the digest may cost, as a budget. */
  digestTargetRatio: number
  /** Whether a new digest inherits the still-relevant sections of the previous one. */
  digestCarryForward: boolean
  /** Token estimator used for digest budgeting. */
  digestTokenEstimator: DigestEstimator
  /**
   * Whether a compaction also writes the lossless raw transcript archive.
   *
   * Off by default: the point of this plugin's side-car is the **0-token
   * digest**, a document small enough to read at handoff time. The raw archive
   * is the whole compacted region re-dumped (measured: 401 messages → 286 KB
   * ≈ 64k tokens, 65.6% of it tool results) — nobody reads that at handoff, and
   * writing it costs ~300 KB per compaction with no retention policy. Turn it on
   * when you want the region kept verbatim for later grepping.
   */
  writeRawArchive: boolean
  /** Whether the raw archive also drops host-re-injected context (raw only). */
  rawExcludeInjected: boolean
  /** Archive layout below the base directory. */
  archiveLayout: ArchiveLayout
  /** Whether the resume prompt escalates with compaction frequency. */
  resumeEscalation: boolean
  /** Sliding window, in minutes, that "recently" means for escalation. */
  resumeWindowMinutes: number
  /** Auto compactions within the window above which resume is suppressed. */
  resumeMaxPerWindow: number
  /** Continuation prompt template; empty string disables the injection. */
  resumePromptTemplate: string
  /** Wrap-up reminder template; empty string disables the injection. */
  wrapUpPromptTemplate: string
}

/**
 * Built-in defaults, mirroring the defaults declared in {@link settingsFields}.
 *
 * The schema is what actually supplies them (a live field is never absent once
 * parsed); this table is the floor the guard-side resolution falls back to, and
 * the value the archive engine layers its own row config over.
 */
export const SETTINGS_DEFAULTS: ContextGuardSettingsValue = {
  defaultThresholdTokens: 0,
  providerThresholds: [],
  digestEnabled: true,
  digestMaxTokens: 800,
  digestTargetRatio: 0.45,
  digestCarryForward: true,
  digestTokenEstimator: 'cjk',
  writeRawArchive: false,
  rawExcludeInjected: false,
  archiveLayout: 'session',
  resumeEscalation: true,
  resumeWindowMinutes: 30,
  resumeMaxPerWindow: 5,
  resumePromptTemplate: '',
  wrapUpPromptTemplate: '',
}

/**
 * The live half of the guard row's Config, as a schema fragment: these are the
 * fields the Web panel renders and writes back through the profile patch.
 *
 * dsh 0.1.7 has no namespace-level schema to register any more — the form is
 * derived from the owning entry's Config — so `index.ts` spreads this fragment
 * into the row's own `z.object` alongside its plain (composition-only) fields.
 * Defaults, bounds and steps are unchanged from the pre-0.1.7 namespace schema,
 * so every knob keeps the value and meaning it had.
 */
export const settingsFields = {
  defaultThresholdTokens: z.number().step(1).min(0).default(0).volatile(),
  providerThresholds: z.array(z.object({
    provider: z.string().required(),
    thresholdTokens: z.number().step(1).min(1).required(),
  })).default([]).volatile(),
  digestEnabled: z.boolean().default(true).volatile(),
  digestMaxTokens: z.number().step(1).min(80).default(800).volatile(),
  digestTargetRatio: z.number().min(0.05).max(0.95).default(0.45).volatile(),
  digestCarryForward: z.boolean().default(true).volatile(),
  digestTokenEstimator: z.union([z.const('cjk'), z.const('ascii')]).default('cjk').volatile(),
  writeRawArchive: z.boolean().default(false).volatile(),
  rawExcludeInjected: z.boolean().default(false).volatile(),
  archiveLayout: z.union([z.const('session'), z.const('flat')]).default('session').volatile(),
  resumeEscalation: z.boolean().default(true).volatile(),
  resumeWindowMinutes: z.number().step(1).min(1).default(30).volatile(),
  resumeMaxPerWindow: z.number().step(1).min(1).default(5).volatile(),
  // The two templates carry *no* schema default on purpose: an absent field must
  // stay "unset" so `pickTemplate` can fall through to the composition's own
  // `resumePrompt` / `wrapUpPrompt` field (the pre-0.1.7 key names, still
  // honoured), while an explicit empty string must be taken verbatim — that is
  // how the panel disables the injection.
  resumePromptTemplate: z.string().volatile(),
  wrapUpPromptTemplate: z.string().volatile(),
}

/** The live half of the guard row's Config, as the parsed value the guard reads. */
export interface ContextGuardSettingsFields {
  /** See {@link ContextGuardSettingsValue.defaultThresholdTokens}. */
  defaultThresholdTokens: Volatile<number>
  /** See {@link ContextGuardSettingsValue.providerThresholds}. */
  providerThresholds: Volatile<ProviderThreshold[]>
  /** See {@link ContextGuardSettingsValue.digestEnabled}. */
  digestEnabled: Volatile<boolean>
  /** See {@link ContextGuardSettingsValue.digestMaxTokens}. */
  digestMaxTokens: Volatile<number>
  /** See {@link ContextGuardSettingsValue.digestTargetRatio}. */
  digestTargetRatio: Volatile<number>
  /** See {@link ContextGuardSettingsValue.digestCarryForward}. */
  digestCarryForward: Volatile<boolean>
  /** See {@link ContextGuardSettingsValue.digestTokenEstimator}. */
  digestTokenEstimator: Volatile<DigestEstimator>
  /** See {@link ContextGuardSettingsValue.writeRawArchive}. */
  writeRawArchive: Volatile<boolean>
  /** See {@link ContextGuardSettingsValue.rawExcludeInjected}. */
  rawExcludeInjected: Volatile<boolean>
  /** See {@link ContextGuardSettingsValue.archiveLayout}. */
  archiveLayout: Volatile<ArchiveLayout>
  /** See {@link ContextGuardSettingsValue.resumeEscalation}. */
  resumeEscalation: Volatile<boolean>
  /** See {@link ContextGuardSettingsValue.resumeWindowMinutes}. */
  resumeWindowMinutes: Volatile<number>
  /** See {@link ContextGuardSettingsValue.resumeMaxPerWindow}. */
  resumeMaxPerWindow: Volatile<number>
  /** See {@link ContextGuardSettingsValue.resumePromptTemplate}; `undefined` = unset. */
  resumePromptTemplate: Volatile<string | undefined>
  /** See {@link ContextGuardSettingsValue.wrapUpPromptTemplate}; `undefined` = unset. */
  wrapUpPromptTemplate: Volatile<string | undefined>
}

/** Fill every absent field with its built-in default. */
export function withDefaults(value: Partial<ContextGuardSettingsValue> | undefined): ContextGuardSettingsValue {
  return {
    defaultThresholdTokens: value?.defaultThresholdTokens ?? SETTINGS_DEFAULTS.defaultThresholdTokens,
    providerThresholds: value?.providerThresholds ?? [],
    digestEnabled: value?.digestEnabled ?? SETTINGS_DEFAULTS.digestEnabled,
    digestMaxTokens: value?.digestMaxTokens ?? SETTINGS_DEFAULTS.digestMaxTokens,
    digestTargetRatio: value?.digestTargetRatio ?? SETTINGS_DEFAULTS.digestTargetRatio,
    digestCarryForward: value?.digestCarryForward ?? SETTINGS_DEFAULTS.digestCarryForward,
    digestTokenEstimator: value?.digestTokenEstimator ?? SETTINGS_DEFAULTS.digestTokenEstimator,
    writeRawArchive: value?.writeRawArchive ?? SETTINGS_DEFAULTS.writeRawArchive,
    rawExcludeInjected: value?.rawExcludeInjected ?? SETTINGS_DEFAULTS.rawExcludeInjected,
    archiveLayout: value?.archiveLayout ?? SETTINGS_DEFAULTS.archiveLayout,
    resumeEscalation: value?.resumeEscalation ?? SETTINGS_DEFAULTS.resumeEscalation,
    resumeWindowMinutes: value?.resumeWindowMinutes ?? SETTINGS_DEFAULTS.resumeWindowMinutes,
    resumeMaxPerWindow: value?.resumeMaxPerWindow ?? SETTINGS_DEFAULTS.resumeMaxPerWindow,
    resumePromptTemplate: value?.resumePromptTemplate ?? SETTINGS_DEFAULTS.resumePromptTemplate,
    wrapUpPromptTemplate: value?.wrapUpPromptTemplate ?? SETTINGS_DEFAULTS.wrapUpPromptTemplate,
  }
}

/** Absolute thresholds in force, keyed for lookup. */
export interface ThresholdOverrides {
  /** Global absolute threshold applied to every provider without an entry. */
  defaultTokens: number
  /** Per-provider absolute thresholds. */
  providerTokens: Map<string, number>
}

/** Extract the live threshold overrides from a resolved settings value. */
export function overridesOf(value: Partial<ContextGuardSettingsValue> | undefined): ThresholdOverrides {
  const providerTokens = new Map<string, number>()
  for (const entry of value?.providerThresholds ?? []) providerTokens.set(entry.provider, entry.thresholdTokens)
  return { defaultTokens: value?.defaultThresholdTokens ?? 0, providerTokens }
}

/**
 * The digest knobs as declared on the engine's own composition row. They are
 * the middle layer: a user override in settings wins, and these win over the
 * built-in defaults when the guard is not mounted at all.
 */
export interface EngineDigestConfig {
  /** See {@link ContextGuardSettingsValue.digestEnabled}. */
  enabled?: boolean | undefined
  /** See {@link ContextGuardSettingsValue.digestMaxTokens}. */
  maxTokens?: number | undefined
  /** See {@link ContextGuardSettingsValue.digestTargetRatio}. */
  targetRatio?: number | undefined
  /** See {@link ContextGuardSettingsValue.digestCarryForward}. */
  carryForward?: boolean | undefined
  /** See {@link ContextGuardSettingsValue.digestTokenEstimator}. */
  estimator?: DigestEstimator | undefined
  /** See {@link ContextGuardSettingsValue.writeRawArchive}. */
  writeRaw?: boolean | undefined
  /** See {@link ContextGuardSettingsValue.rawExcludeInjected}. */
  rawExcludeInjected?: boolean | undefined
  /** See {@link ContextGuardSettingsValue.archiveLayout}. */
  layout?: ArchiveLayout | undefined
}

/** The digest knobs after resolution. */
export interface ResolvedDigestConfig {
  /** See {@link ContextGuardSettingsValue.digestEnabled}. */
  enabled: boolean
  /** See {@link ContextGuardSettingsValue.digestMaxTokens}. */
  maxTokens: number
  /** See {@link ContextGuardSettingsValue.digestTargetRatio}. */
  targetRatio: number
  /** See {@link ContextGuardSettingsValue.digestCarryForward}. */
  carryForward: boolean
  /** See {@link ContextGuardSettingsValue.digestTokenEstimator}. */
  estimator: DigestEstimator
  /** See {@link ContextGuardSettingsValue.writeRawArchive}. */
  writeRaw: boolean
  /** See {@link ContextGuardSettingsValue.rawExcludeInjected}. */
  rawExcludeInjected: boolean
  /** See {@link ContextGuardSettingsValue.archiveLayout}. */
  layout: ArchiveLayout
}

/**
 * Resolve the digest knobs for one compaction: user settings, then the
 * engine's composition entry, then the built-in default.
 * @param user - the guard entry's explicitly-set fields, when one exists.
 * @param entry - the engine row's own config; absent for a caller with no row
 *   of its own (the guard's side-car writer reads only the settings layer).
 */
export function resolveDigestConfig(
  user: Partial<ContextGuardSettingsValue> | undefined,
  entry?: EngineDigestConfig,
): ResolvedDigestConfig {
  return {
    enabled: user?.digestEnabled ?? entry?.enabled ?? SETTINGS_DEFAULTS.digestEnabled,
    maxTokens: user?.digestMaxTokens ?? entry?.maxTokens ?? SETTINGS_DEFAULTS.digestMaxTokens,
    targetRatio: user?.digestTargetRatio ?? entry?.targetRatio ?? SETTINGS_DEFAULTS.digestTargetRatio,
    carryForward: user?.digestCarryForward ?? entry?.carryForward ?? SETTINGS_DEFAULTS.digestCarryForward,
    estimator: user?.digestTokenEstimator ?? entry?.estimator ?? SETTINGS_DEFAULTS.digestTokenEstimator,
    writeRaw: user?.writeRawArchive ?? entry?.writeRaw ?? SETTINGS_DEFAULTS.writeRawArchive,
    rawExcludeInjected: user?.rawExcludeInjected ?? entry?.rawExcludeInjected ?? SETTINGS_DEFAULTS.rawExcludeInjected,
    layout: user?.archiveLayout ?? entry?.layout ?? SETTINGS_DEFAULTS.archiveLayout,
  }
}

/** One descriptor as this plugin reads it: the form namespace plus its user layer. */
interface SettingsDescriptorLike {
  ns: string
  user?: unknown
}

/** The one read-only settings face the archive engine depends on. */
interface SettingsReaderLike {
  describe(options?: { redactSecrets?: boolean }): readonly SettingsDescriptorLike[]
}

/**
 * The guard entry's explicitly-set layer, for a reader that only observes it.
 *
 * `describe()` projects each active entry's overrides onto its volatile form
 * fields, so `user` is exactly "fields the profile patch sets" — the same
 * meaning the registered namespace's raw user layer had before 0.1.7, and the
 * reason a field absent here still falls through to the engine row's own config
 * instead of being pinned by the guard's schema default.
 *
 * Feature-detected on purpose: `describe` is optional for a caller that only
 * ever sees a settings provider, and a provider serving this entry without it
 * (a test double, an older composition) degrades to "no user overrides" instead
 * of throwing inside a compaction.
 *
 * @param settings - `ctx.get('settings')`, of unknown shape to this caller.
 * @returns the user section, or undefined when absent/unreadable.
 */
export function userLayerOf(settings: unknown): Partial<ContextGuardSettingsValue> | undefined {
  const reader = settings as SettingsReaderLike | undefined
  if (reader === undefined || typeof reader.describe !== 'function') return undefined
  try {
    const descriptor = reader.describe({ redactSecrets: true }).find(entry => entry.ns === SETTINGS_NAMESPACE)
    const user = descriptor?.user
    if (typeof user !== 'object' || user === null || Array.isArray(user)) return undefined
    return user as Partial<ContextGuardSettingsValue>
  } catch {
    return undefined
  }
}
