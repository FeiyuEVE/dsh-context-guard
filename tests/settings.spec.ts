/**
 * Settings suite: schema defaults, the shared resolution order
 * (settings > composition config > built-in default), and the feature-detected
 * user-layer read the archive engine relies on.
 */

import { describe, expect, it } from 'vitest'
import type { ContextGuardSettingsValue } from '../src/settings.ts'
import {
  SETTINGS_DEFAULTS,
  overridesOf,
  resolveDigestConfig,
  settingsSchema,
  userLayerOf,
  withDefaults,
} from '../src/settings.ts'

describe('settings schema', () => {
  // schemastery's callable type is the *resolved* shape; an empty user section
  // is valid input at runtime (every field has a default), which is exactly
  // what a freshly created settings document looks like.
  const resolveEmpty = (): ReturnType<typeof settingsSchema> => settingsSchema({} as ContextGuardSettingsValue)

  it('resolves an empty section to the built-in defaults', () => {
    const resolved = resolveEmpty()
    expect(resolved.digestEnabled).toBe(true)
    expect(resolved.digestMaxTokens).toBe(800)
    expect(resolved.digestTargetRatio).toBe(0.45)
    expect(resolved.digestCarryForward).toBe(true)
    expect(resolved.digestTokenEstimator).toBe('cjk')
    expect(resolved.rawExcludeInjected).toBe(false)
    expect(resolved.archiveLayout).toBe('session')
    expect(resolved.resumeEscalation).toBe(true)
    expect(resolved.resumeWindowMinutes).toBe(30)
    expect(resolved.resumeMaxPerWindow).toBe(5)
    expect(resolved.defaultThresholdTokens).toBe(0)
    expect(resolved.providerThresholds).toEqual([])
  })

  it('keeps the documented defaults in one place', () => {
    expect(resolveEmpty()).toMatchObject({
      digestMaxTokens: SETTINGS_DEFAULTS.digestMaxTokens,
      resumeWindowMinutes: SETTINGS_DEFAULTS.resumeWindowMinutes,
      resumeMaxPerWindow: SETTINGS_DEFAULTS.resumeMaxPerWindow,
    })
  })
})

describe('withDefaults / overridesOf', () => {
  it('fills absent fields without touching present ones', () => {
    const filled = withDefaults({ digestMaxTokens: 200 })
    expect(filled.digestMaxTokens).toBe(200)
    expect(filled.archiveLayout).toBe('session')
    expect(withDefaults(undefined).digestEnabled).toBe(true)
  })

  it('maps provider thresholds for lookup', () => {
    const overrides = overridesOf({
      defaultThresholdTokens: 300_000,
      providerThresholds: [{ provider: 'deepseek-official', thresholdTokens: 500_000 }],
    })
    expect(overrides.defaultTokens).toBe(300_000)
    expect(overrides.providerTokens.get('deepseek-official')).toBe(500_000)
    expect(overridesOf(undefined).defaultTokens).toBe(0)
  })
})

describe('resolveDigestConfig', () => {
  it('prefers the settings user layer over the engine row', () => {
    const resolved = resolveDigestConfig(
      { digestMaxTokens: 300, archiveLayout: 'flat' },
      { maxTokens: 900, layout: 'session', enabled: false },
    )
    expect(resolved.maxTokens).toBe(300)
    expect(resolved.layout).toBe('flat')
    // Not overridden in settings: the engine row wins over the default.
    expect(resolved.enabled).toBe(false)
  })

  it('falls back to the engine row, then the built-in default', () => {
    expect(resolveDigestConfig(undefined, { maxTokens: 900 }).maxTokens).toBe(900)
    expect(resolveDigestConfig(undefined, undefined).maxTokens).toBe(SETTINGS_DEFAULTS.digestMaxTokens)
    expect(resolveDigestConfig(undefined, undefined).layout).toBe('session')
  })
})

describe('userLayerOf', () => {
  it('reads the namespace user layer, and degrades when the provider cannot describe', () => {
    const reader = {
      describe: () => [{ ns: 'context-guard', user: { digestMaxTokens: 120 }, value: {} }],
    }
    expect(userLayerOf(reader)).toEqual({ digestMaxTokens: 120 })

    // No describe (a minimal test double), a missing namespace, and a throwing
    // reader all mean "no overrides" instead of an exception inside compaction.
    expect(userLayerOf({ register: () => undefined })).toBeUndefined()
    expect(userLayerOf(undefined)).toBeUndefined()
    expect(userLayerOf({ describe: () => [{ ns: 'other' }] })).toBeUndefined()
    expect(userLayerOf({ describe: () => { throw new Error('boom') } })).toBeUndefined()
    expect(userLayerOf({ describe: () => [{ ns: 'context-guard', user: [1, 2] }] })).toBeUndefined()
  })
})
