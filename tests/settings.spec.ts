/**
 * Settings suite: the live-field schema defaults, the shared resolution order
 * (settings > composition config > built-in default), and the feature-detected
 * user-layer read the archive engine relies on.
 */

import { describe, expect, it } from 'vitest'
import {
  SETTINGS_DEFAULTS,
  overridesOf,
  resolveDigestConfig,
  userLayerOf,
  withDefaults,
} from '../src/settings.ts'
import { Config } from '../src/index.ts'
import { DEFAULT_RESUME_PROMPT, DEFAULT_WRAP_UP_PROMPT } from '../src/resume-prompt.ts'

describe('settings fields', () => {
  // The knobs are live fields of the guard row's own Config (a form *is* the
  // profile entry's config in 0.1.7), so the defaults are read through the
  // reference each field is parsed into.
  const resolveEmpty = () => Config({})

  it('resolves an empty section to the built-in defaults', () => {
    const resolved = resolveEmpty()
    expect(resolved.digestEnabled.get()).toBe(true)
    expect(resolved.digestMaxTokens.get()).toBe(800)
    expect(resolved.digestTargetRatio.get()).toBe(0.45)
    expect(resolved.digestCarryForward.get()).toBe(true)
    expect(resolved.digestTokenEstimator.get()).toBe('cjk')
    expect(resolved.rawExcludeInjected.get()).toBe(false)
    expect(resolved.archiveLayout.get()).toBe('session')
    expect(resolved.resumeEscalation.get()).toBe(true)
    expect(resolved.resumeWindowMinutes.get()).toBe(30)
    expect(resolved.resumeMaxPerWindow.get()).toBe(5)
    expect(resolved.defaultThresholdTokens.get()).toBe(0)
    expect(resolved.providerThresholds.get()).toEqual([])
    expect(resolved.writeRawArchive.get()).toBe(false)
  })

  it('keeps the documented defaults in one place', () => {
    const resolved = resolveEmpty()
    expect({
      digestMaxTokens: resolved.digestMaxTokens.get(),
      resumeWindowMinutes: resolved.resumeWindowMinutes.get(),
      resumeMaxPerWindow: resolved.resumeMaxPerWindow.get(),
    }).toEqual({
      digestMaxTokens: SETTINGS_DEFAULTS.digestMaxTokens,
      resumeWindowMinutes: SETTINGS_DEFAULTS.resumeWindowMinutes,
      resumeMaxPerWindow: SETTINGS_DEFAULTS.resumeMaxPerWindow,
    })
  })

  it('leaves the two templates unset, so a composition text can still be reached', () => {
    // No schema default on purpose: an unset template must fall through to the
    // composition's own `resumePrompt` / `wrapUpPrompt` (those fields carry the
    // built-in text), while an empty string stays empty = "injection off".
    const resolved = resolveEmpty()
    expect(resolved.resumePromptTemplate.get()).toBeUndefined()
    expect(resolved.wrapUpPromptTemplate.get()).toBeUndefined()
    expect(resolved.resumePrompt).toBe(DEFAULT_RESUME_PROMPT)
    expect(resolved.wrapUpPrompt).toBe(DEFAULT_WRAP_UP_PROMPT)
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
