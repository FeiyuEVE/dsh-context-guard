import { describe, expect, it, vi } from 'vitest'
import { createLogSink, formatLogLine, logInfo, logWarn } from '../src/log.ts'

describe('formatLogLine', () => {
  it('renders scope, event and scalar fields', () => {
    expect(formatLogLine('digest', 'written', { epoch: 3, tier: 'full', carriedFrom: undefined }))
      .toBe('context-guard/digest: written epoch=3 tier=full')
  })

  it('drops the scope separator when there is no scope', () => {
    expect(formatLogLine('', 'idle-compacted', { agent: 'a1' }))
      .toBe('context-guard: idle-compacted agent=a1')
  })

  it('quotes a value containing whitespace so the line stays field-parseable', () => {
    expect(formatLogLine('resume', 'skipped', { reason: 'too many runs' }))
      .toBe('context-guard/resume: skipped reason="too many runs"')
  })

  it('renders no trailing space without fields', () => {
    expect(formatLogLine('', 'no-compaction-provider')).toBe('context-guard: no-compaction-provider')
  })
})

describe('createLogSink', () => {
  it('writes every line to both the cordis logger and the console', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const consoleSink = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const sink = createLogSink(logger, consoleSink)

    logInfo(sink, 'digest', 'written', { epoch: 1 })
    logWarn(sink, 'digest', 'write-failed', { session: 's' })
    sink.error('context-guard: boom')

    expect(logger.info).toHaveBeenCalledWith('context-guard/digest: written epoch=1')
    expect(consoleSink.log).toHaveBeenCalledWith('context-guard/digest: written epoch=1')
    expect(logger.warn).toHaveBeenCalledWith('context-guard/digest: write-failed session=s')
    expect(consoleSink.warn).toHaveBeenCalledWith('context-guard/digest: write-failed session=s')
    expect(logger.error).toHaveBeenCalledWith('context-guard: boom')
    expect(consoleSink.error).toHaveBeenCalledWith('context-guard: boom')
  })
})
