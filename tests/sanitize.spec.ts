/**
 * Text hygiene rules.
 *
 * These exist because an archive is opened by humans and models through readers
 * that reject a document outright on a control byte: the fs layer rejects a NUL
 * in the first 8192 bytes, and the workspace-files reader rejects a NUL anywhere
 * in the page it returns. Both surfaces report the same thing to the reader —
 * 「非文本文件，暂时无法预览。」 — so the rule is asserted directly here, next to
 * the archive-level test that proves the writer applies it.
 */

import { describe, expect, it } from 'vitest'
import { NUL_PLACEHOLDER, sanitizeDocText } from '../src/sanitize.ts'

describe('sanitizeDocText', () => {
  it('renders NUL as a visible placeholder instead of dropping it silently', () => {
    expect(sanitizeDocText('a\u0000b')).toBe(`a${NUL_PLACEHOLDER}b`)
  })

  it('leaves ordinary text, tab, and newline untouched', () => {
    const text = '第一行\n\t缩进\n第三行'
    expect(sanitizeDocText(text)).toBe(text)
  })

  it('normalizes CRLF and lone CR to LF', () => {
    expect(sanitizeDocText('a\r\nb\rc')).toBe('a\nb\nc')
  })

  it('drops other C0 controls and DEL', () => {
    expect(sanitizeDocText('a\u0007b\u0008c\u000bd\u007fe')).toBe('abcde')
  })

  it('strips CSI colour sequences', () => {
    expect(sanitizeDocText('\u001b[1;34m==> done\u001b[0m')).toBe('==> done')
  })

  it('strips OSC sequences terminated by BEL and by ST', () => {
    expect(sanitizeDocText('\u001b]0;title\u0007text')).toBe('text')
    expect(sanitizeDocText('\u001b]8;;http://x\u001b\\label')).toBe('label')
  })

  it('strips two-character escapes', () => {
    expect(sanitizeDocText('a\u001bMb')).toBe('ab')
  })

  it('keeps text that merely looks like an escape', () => {
    expect(sanitizeDocText('path [1;34] not an escape')).toBe('path [1;34] not an escape')
  })
})
