/**
 * The `context-guard` settings namespace: one schema and one resolution order
 * shared by the host guard row and the compaction backend.
 *
 * The guard registers the namespace (it owns the composition entry and the Web
 * panel), and the archive engine only *reads* the user layer through
 * {@link userLayerOf}. Two independently mounted plugins may come from
 * different module graphs — the archive-cut preset references the engine by
 * absolute file path while the guard comes from the installed package — so the
 * settings service is the only shared channel between them; a module-level
 * singleton would not be.
 *
 * Resolution order, everywhere:
 *   settings user layer  >  composition config  >  built-in default.
 *
 * @module dsh-context-guard/settings
 */

import z from '@deepseek-ai/schemastery'
// Type-only: pulls in the `ctx.settings` declaration merge.
import type {} from '@deepseek-ai/dsh-settings'
import type { DigestEstimator } from './digest.ts'
import type { ArchiveLayout } from './paths.ts'

/** The one settings namespace this plugin owns. */
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
  providerThresholds: ProviderThreshold[]
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
  /** Whether the lossless raw archive also drops host-re-injected context. */
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

/** Built-in defaults: the composition base layer when config sets nothing. */
export const SETTINGS_DEFAULTS: ContextGuardSettingsValue = {
  defaultThresholdTokens: 0,
  providerThresholds: [],
  digestEnabled: true,
  digestMaxTokens: 800,
  digestTargetRatio: 0.45,
  digestCarryForward: true,
  digestTokenEstimator: 'cjk',
  rawExcludeInjected: false,
  archiveLayout: 'session',
  resumeEscalation: true,
  resumeWindowMinutes: 30,
  resumeMaxPerWindow: 5,
  resumePromptTemplate: '',
  wrapUpPromptTemplate: '',
}

/** The settings namespace schema. */
export const settingsSchema: z<ContextGuardSettingsValue> = z.object({
  defaultThresholdTokens: z.number().step(1).min(0).default(0),
  providerThresholds: z.array(z.object({
    provider: z.string().required(),
    thresholdTokens: z.number().step(1).min(1).required(),
  })).default([]),
  digestEnabled: z.boolean().default(true),
  digestMaxTokens: z.number().step(1).min(80).default(800),
  digestTargetRatio: z.number().min(0.05).max(0.95).default(0.45),
  digestCarryForward: z.boolean().default(true),
  digestTokenEstimator: z.union([z.const('cjk'), z.const('ascii')]).default('cjk'),
  rawExcludeInjected: z.boolean().default(false),
  archiveLayout: z.union([z.const('session'), z.const('flat')]).default('session'),
  resumeEscalation: z.boolean().default(true),
  resumeWindowMinutes: z.number().step(1).min(1).default(30),
  resumeMaxPerWindow: z.number().step(1).min(1).default(5),
  resumePromptTemplate: z.string().default(''),
  wrapUpPromptTemplate: z.string().default(''),
})

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
  /** See {@link ContextGuardSettingsValue.rawExcludeInjected}. */
  rawExcludeInjected: boolean
  /** See {@link ContextGuardSettingsValue.archiveLayout}. */
  layout: ArchiveLayout
}

/**
 * Resolve the digest knobs for one compaction: user settings, then the
 * engine's composition entry, then the built-in default.
 * @param user - the namespace's raw user layer, when the guard registered one.
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
    rawExcludeInjected: user?.rawExcludeInjected ?? entry?.rawExcludeInjected ?? SETTINGS_DEFAULTS.rawExcludeInjected,
    layout: user?.archiveLayout ?? entry?.layout ?? SETTINGS_DEFAULTS.archiveLayout,
  }
}

/** One descriptor as this plugin reads it: the namespace plus its user layer. */
interface SettingsDescriptorLike {
  ns: string
  user?: unknown
}

/** The one read-only settings face the archive engine depends on. */
interface SettingsReaderLike {
  describe(options?: { redactSecrets?: boolean }): readonly SettingsDescriptorLike[]
}

/**
 * The namespace's raw user layer, for a reader that must not register it.
 *
 * Feature-detected on purpose: `describe` is optional for a caller that only
 * ever sees a settings provider, and a provider serving this namespace without
 * it (a test double, an older composition) degrades to "no user overrides"
 * instead of throwing inside a compaction.
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
