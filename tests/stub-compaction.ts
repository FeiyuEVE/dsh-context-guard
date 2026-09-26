/**
 * Stub CompactionEngine for the context-guard suite: `compactNow` records
 * calls and lands a real durable compaction transaction on the session
 * (compaction/start → compaction/summary → replacement user/message →
 * compaction/end), so the guard's `compaction/end` resume hook observes it.
 * The replacement shadows the first two surface nodes with a short summary,
 * which also drops the token-meter pressure below any test threshold.
 *
 * `compactOnStepPressure` makes `compactIfNeeded` land the same transaction
 * instead of returning null, which is what `compaction-basic` does from its own
 * `agent/pre-step` hook: a compaction that lands *inside* a running step, with
 * no maintenance phase and no idle transition to react to.
 */

import {
  CompactionEngine,
  CompactionId,
  ManualCompactionError,
  compactCheckpointSource,
} from '@deepseek-ai/dsh-compaction'
import type {
  CompactionAgentContext,
  CompactionResult,
  CompactionTrigger,
  ManualCompactAgentContext,
} from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export class StubCompactionEngine extends CompactionEngine {
  /** Number of `compactNow` calls; entries record 0 for failure / 1 for success. */
  compactNowCalls: number[] = []
  /** When set, the next `compactNow` lands a failed transaction and throws. */
  failNext = false
  /**
   * When set, `compactIfNeeded` lands a successful transaction (the
   * `compaction-basic` pre-step pressure path) instead of returning null.
   */
  compactOnStepPressure = false
  /**
   * Text of the checkpoint frame this stub lands. A real backend's summary is
   * whatever its engine returned — this engine's deterministic pointer frame,
   * or (for `compaction-basic`) a model-written summary in prose.
   */
  summaryText = 'stub summary of the compacted range'

  /**
   * Provider string recorded on the summary event. `context-guard` is the
   * guard's own deterministic engine, which archives while it summarizes; any
   * other value stands for a foreign backend, beside which the guard must
   * write its own side-car archive.
   */
  provider = 'mock'

  /** Transactions landed so far; makes every `stub-N` id unique across paths. */
  private landed = 0

  override async compactIfNeeded(
    agent: CompactionAgentContext,
    _trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    if (!this.compactOnStepPressure) return null
    return this.land(agent.session)
  }

  override async compactNow(
    agent: ManualCompactAgentContext,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    this.compactNowCalls.push(0)
    signal.throwIfAborted()
    const failure = this.failNext ? 'stub failure' : undefined
    this.failNext = false
    // Serialize against driver turns like the real backend does; the guard
    // only calls while idle, so the maintenance claim succeeds.
    return agent.runMaintenance(async () => {
      const result = this.land(agent.session, failure)
      if (result === null) return null
      if (failure !== undefined) throw new ManualCompactionError('summary', failure)
      this.compactNowCalls[this.compactNowCalls.length - 1] = 1
      return result
    })
  }

  override async compactRegion(
    _start: number,
    _end: number,
    _agent: CompactionAgentContext,
    _signal?: AbortSignal,
  ): Promise<CompactionResult> {
    throw new Error('compactRegion is not used by the context-guard suite')
  }

  /**
   * Land one compaction transaction, or return null when the surface has no
   * range it may cut.
   * @param session - session to compact.
   * @param failure - when set, the transaction ends in a `compaction/end`
   *   carrying that error, exactly as a backend reports a failed summary.
   */
  private land(session: CompactionAgentContext['session'], failure?: string): CompactionResult | null {
    const surface = session.surface.nodes
    // A `system/message` at surface node 0 is never inside a compaction
    // range: session surface validation refuses a replacement that shadows
    // the system prompt unless the replacing event is a `system/message`
    // over exactly that node, and the real backend therefore starts past it.
    // Without a system head the range starts at node 0.
    const headSeq = surface[0]
    const head = headSeq === undefined ? undefined : session.eventAt(headSeq)
    const firstIdx = head?.type === 'system/message' ? 1 : 0
    if (surface.length < firstIdx + 2) return null
    const shadowedSeqs = surface.slice(firstIdx, firstIdx + 2)
    const start = shadowedSeqs[0]!
    const end = shadowedSeqs[1]!
    this.landed += 1
    const compactionId = CompactionId(`stub-${this.landed}`)
    const summary = [{ type: 'text' as const, text: this.summaryText }]
    const startEvent = session.append('compaction/start', { compactionId, turn: null })
    const summaryEvent = session.append('compaction/summary', {
      compactionId,
      summary,
      shadowedRange: { start, end },
      shadowedSeqs,
      shadowedTokenCount: 100,
      provider: this.provider,
      model: 'stub',
      rawOutput: summary,
      llmStreamCall: true,
    })
    session.append('user/message', createUserMessage({
      content: summary,
      source: compactCheckpointSource(compactionId),
    }), {
      surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
      sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
    })
    const endEvent = session.append('compaction/end', failure === undefined
      ? { compactionId, turn: null }
      : { compactionId, turn: null, error: failure })
    return {
      compactionId,
      startSeq: startEvent.seq,
      summarySeq: summaryEvent.seq,
      endSeq: endEvent.seq,
      summary,
      shadowedRange: { start, end },
      shadowedSeqs,
      shadowedTokenCount: 100,
    }
  }
}
