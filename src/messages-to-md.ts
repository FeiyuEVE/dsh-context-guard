/**
 * Deterministic session-to-Markdown cleaner: renders an archived conversation
 * region (the `Message[]` a compaction backend receives) into a structured,
 * human- and model-readable Markdown document. Pure code — no model calls, no
 * I/O, no timestamps (identical input always renders identically), so it can
 * be unit-tested with golden fixtures.
 *
 * Cleaning rules:
 * - user/assistant text is preserved verbatim;
 * - reasoning blocks are dropped by default (folded into `<details>` on demand);
 * - images become placeholders (bytes are never exported);
 * - tool calls render as one line with clipped JSON arguments;
 * - tool results render as a ✓/✗-prefixed clipped preview (first/last lines);
 * - unknown content-block types render as a marker instead of throwing
 *   (the block vocabulary is merge-extensible).
 *
 * @module dsh-context-guard/messages-to-md
 */

import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { isInjectedContext } from './digest.ts'

/** Length knobs for the cleaner. */
export interface CleanOptions {
  /** Max characters of one tool-call argument JSON kept in the archive. */
  toolArgChars?: number
  /** Max characters of one tool-result preview kept in the archive. */
  resultPreviewChars?: number
  /** Keep reasoning blocks inside a collapsed `<details>` element. */
  includeReasoning?: boolean
  /**
   * Drop host-re-injected context (system prompt, AGENTS.md instructions, skill
   * catalogs, plugin snapshots, prior compaction frames). Off by default: the
   * raw archive is the lossless record, and only a caller who prefers a smaller
   * readable document turns this on.
   */
  excludeInjected?: boolean
}

const DEFAULT_TOOL_ARG_CHARS = 500
const DEFAULT_RESULT_PREVIEW_CHARS = 2000

/** Adaptive fence: longer than any backtick run inside the payload. */
function fenceFor(text: string): string {
  let longest = 0
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length)
  return '`'.repeat(Math.max(3, longest + 1))
}

/** Clip text with an explicit truncation marker. */
function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}…(截断 ${text.length - maxChars} 字符)`
}

/** Keep head and tail around a middle elision, so truncation never mangles the payload. */
function preview(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const head = Math.floor(maxChars * 0.6)
  const tail = maxChars - head
  return `${text.slice(0, head)}\n…(中间省略 ${text.length - head - tail} 字符)…\n${text.slice(-tail)}`
}

/** Flat text of one block tree: text blocks joined, everything else skipped. */
function textOf(block: ContentBlock): string {
  if (block.type === 'text') return block.text
  if (block.type === 'tool-result') {
    return block.content
      .filter((inner): inner is Extract<ContentBlock, { type: 'text' }> => inner.type === 'text')
      .map(inner => inner.text)
      .join('\n')
  }
  return ''
}

/** Render one tool-result block as a clipped, fenced preview. */
function renderToolResult(block: Extract<ContentBlock, { type: 'tool-result' }>, maxChars: number): string {
  const body = textOf(block).trim()
  const tag = block.isError === true ? '✗' : '✓'
  const payload = body.length === 0 ? '(无文本内容)' : preview(body, maxChars)
  const fence = fenceFor(payload)
  return `${tag} 工具结果\n${fence}\n${payload}\n${fence}`
}

/** Render one content block; unknown types degrade to a marker. */
function renderBlock(block: ContentBlock, options: Required<CleanOptions>): string {
  switch (block.type) {
    case 'text':
      return block.text.trim()
    case 'reasoning':
      if (!options.includeReasoning) return ''
      return `<details><summary>思考过程</summary>\n\n${block.text.trim()}\n\n</details>`
    case 'image':
      return `![image](attachment:${block.attachment.attachmentId})`
    case 'tool-call': {
      const args = clip(block.arguments, options.toolArgChars)
      const fence = fenceFor(args)
      return `🔧 ${block.name}\n${fence}\n${args}\n${fence}`
    }
    case 'tool-result':
      return renderToolResult(block, options.resultPreviewChars)
    default:
      return `[未知内容块类型: ${String((block as { type?: unknown }).type)}]`
  }
}

/** Render one LLM message to its Markdown section (empty when dropped). */
function renderMessage(message: Message, options: Required<CleanOptions>): string {
  const heading = message.role === 'assistant' ? '## Assistant' : '## 用户'
  const parts: string[] = []
  for (const block of message.content) {
    const rendered = renderBlock(block, options)
    if (rendered.length > 0) parts.push(rendered)
  }
  if (parts.length === 0) return ''
  return `${heading}\n\n${parts.join('\n\n')}`
}

/**
 * Deterministically render an archived conversation region to Markdown.
 * @param messages - the region's messages in surface order (what a compaction
 *   backend receives as its summarization input).
 * @param options - optional length knobs.
 * @returns the rendered Markdown document.
 */
export function messagesToMarkdown(messages: readonly Message[], options: CleanOptions = {}): string {
  const resolved: Required<CleanOptions> = {
    toolArgChars: options.toolArgChars ?? DEFAULT_TOOL_ARG_CHARS,
    resultPreviewChars: options.resultPreviewChars ?? DEFAULT_RESULT_PREVIEW_CHARS,
    includeReasoning: options.includeReasoning ?? false,
    excludeInjected: options.excludeInjected ?? false,
  }
  const sections = messages
    .filter(message => !resolved.excludeInjected || !isInjectedContext(message))
    .map(message => renderMessage(message, resolved))
    .filter(section => section.length > 0)
  if (sections.length === 0) return '# 会话归档（空）\n'
  return `# 会话归档（dsh-context-guard 确定性导出，无模型参与）\n\n${sections.join('\n\n')}\n`
}
