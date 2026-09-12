/**
 * One structured log line per event, for both halves of the plugin.
 *
 * Every line starts with the same `context-guard` prefix so a single grep
 * recovers the whole feature, and carries `key=value` fields instead of prose
 * so "which epoch, how large, which tier, which level" is machine-readable
 * after the fact. Values are never message contents: paths, counts, names.
 *
 * Lines are delivered through {@link createLogSink}, which writes to the cordis
 * logger *and* the console — see that function for why both are needed.
 *
 * @module dsh-context-guard/log
 */

/** The logger face every cordis context exposes. */
export interface LogSink {
  /** Informational line. */
  info(message: string): void
  /** Degraded-but-recovered line. */
  warn(message: string): void
  /** Misconfiguration line. */
  error(message: string): void
}

/** The console face this module writes to; injectable so tests can capture lines. */
export interface ConsoleSink {
  /** Informational line. */
  log(message: string): void
  /** Warning line. */
  warn(message: string): void
  /** Error line. */
  error(message: string): void
}

/** One field value: primitives only, so rendering stays lossless and cheap. */
export type LogValue = string | number | boolean | undefined

/** Root prefix shared by every line this plugin writes. */
const ROOT = 'context-guard'

/**
 * A sink that writes every line to `ctx.logger` *and* to the process console.
 *
 * `ctx.logger` is cordis's structured channel, but a composition only *exports*
 * it when a logger exporter is mounted (e.g.
 * `@deepseek-ai/cordis-plugin-logger-console`); without one it merely fills a
 * 1000-message ring buffer, so the lines are unobservable. Neither the web
 * profile nor the shipped bundles mount such an exporter — verified in a
 * container on 2026-09-12, where a compaction had demonstrably produced its
 * archive files while the dsh log held zero `context-guard` lines. The console
 * line is what makes this plugin's audit trail readable through the launcher's
 * log file or systemd/journald, which is also how the sibling plugins in this
 * workspace report. A composition that *does* mount a console exporter prints
 * each line twice; the duplicates are identical and prefixed, so this is
 * accepted rather than guessed around.
 *
 * @param logger - the cordis logger from the plugin's context.
 * @param consoleSink - console replacement for tests; defaults to the global.
 */
export function createLogSink(logger: LogSink, consoleSink: ConsoleSink = console): LogSink {
  return {
    info: (message) => {
      logger.info(message)
      consoleSink.log(message)
    },
    warn: (message) => {
      logger.warn(message)
      consoleSink.warn(message)
    },
    error: (message) => {
      logger.error(message)
      consoleSink.error(message)
    },
  }
}

/**
 * Render one log line.
 * @param scope - feature scope below the root prefix (`digest`, `guard`, …); empty for none.
 * @param event - short event name, lowercase words.
 * @param fields - scalar fields; `undefined` fields are omitted.
 * @returns a single line, e.g. `context-guard/digest: written epoch=3 tokens=812→704`.
 */
export function formatLogLine(scope: string, event: string, fields: Record<string, LogValue> = {}): string {
  const head = scope.length > 0 ? `${ROOT}/${scope}: ${event}` : `${ROOT}: ${event}`
  const parts = [head]
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    const text = String(value)
    parts.push(`${key}=${/\s/.test(text) ? JSON.stringify(text) : text}`)
  }
  return parts.join(' ')
}

/** Write one informational line. */
export function logInfo(logger: LogSink, scope: string, event: string, fields?: Record<string, LogValue>): void {
  logger.info(formatLogLine(scope, event, fields))
}

/** Write one warning line. */
export function logWarn(logger: LogSink, scope: string, event: string, fields?: Record<string, LogValue>): void {
  logger.warn(formatLogLine(scope, event, fields))
}
