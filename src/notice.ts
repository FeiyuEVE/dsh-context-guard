/**
 * This plugin's own message-source kind.
 *
 * V4 removed the catch-all `plugin` source kind: `MessageSourceMap` is a
 * merge-extensible sum type where **each producer declares its own `kind` in
 * its own module**, so there is no shared kind to stamp a plugin's context
 * with. The declaration below is that per-producer entry — the sanctioned
 * pattern (see `@deepseek-ai/dsh-agent`'s `model-selection`) — and it is what
 * makes the `kind: 'context-guard'` source typed everywhere in this package
 * instead of a string nobody can narrow.
 *
 * `index.ts` produces these messages and `digest.ts` reads them back, so the
 * vocabulary lives in one module both import; a foreign producer's kind stays
 * unknown here on purpose, and consumers fall through it.
 *
 * @module dsh-context-guard/notice
 */

import type { ContextFormed, MessageSource } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'context-guard': { kind: 'context-guard' } & ContextFormed
  }
}

/** The source stamped on every context message this plugin injects. */
export const PLUGIN_SOURCE = { kind: 'context-guard' } as const

/** A `notice`-form source carrying one one-line account of what happened. */
export interface NoticeSource {
  /** This plugin's producer kind. */
  readonly kind: 'context-guard'
  /** One-off account, superseding nothing. */
  readonly form: 'notice'
  /** The one-line account shown without expanding the transcript row. */
  readonly summary: string
}

/**
 * Build the source of one injected notice.
 * @param summary - one-line account of what the guard just did, for collapsed
 *   transcript rows. The message body stays the model-facing text; this is the
 *   durable, human-readable label beside it.
 * @returns the stamped source, ready to hand to `createUserMessage`.
 */
export function noticeSource(summary: string): NoticeSource {
  return { ...PLUGIN_SOURCE, form: 'notice', summary }
}

/**
 * The one-line account when `source` is this plugin's own notice, else
 * undefined.
 *
 * Reading through the declared kind means the fields are checked against the
 * `notice` form's contract: a `snapshot`-form source of ours cannot be mistaken
 * for a notice, and `summary` cannot be read off a form that has none.
 *
 * @param source - a message source of any producer.
 * @returns the account, or undefined for every other kind and form.
 */
export function noticeSummary(source: MessageSource): string | undefined {
  if (source.kind !== 'context-guard') return undefined
  return source.form === 'notice' ? source.summary : undefined
}
