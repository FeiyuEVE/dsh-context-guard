/**
 * Shared archive writer suite.
 *
 * `writeArchive` is the one place a `raw`/`digest` pair is produced, used by
 * both the `ArchiveCutEngine` (which summarizes) and the host guard (which
 * writes a side-car beside a foreign backend). Its contract is what makes both
 * safe to call from inside a compaction: it never throws, it never overwrites
 * an existing epoch, and a caller that already knows the session's compaction
 * ordinal can pin the number without the scan disagreeing.
 */

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Message } from '@deepseek-ai/dsh-llm'
import { writeArchive } from '../src/archive.ts'
import type { LogSink } from '../src/log.ts'
import { LATEST_DIGEST_POINTER, LATEST_POINTER } from '../src/paths.ts'
import { resolveDigestConfig } from '../src/settings.ts'

const tmpDirs: string[] = []
async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cg-archive-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** Collect lines instead of writing them, so a failure can be asserted on. */
function captureLog(): { lines: string[]; log: LogSink } {
  const lines: string[] = []
  return {
    lines,
    log: {
      info: message => lines.push(`info ${message}`),
      warn: message => lines.push(`warn ${message}`),
      error: message => lines.push(`error ${message}`),
    },
  }
}

function message(text: string): Message {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  } as unknown as Message
}

describe('writeArchive', () => {
  it('writes the pair plus both pointers under the session layout', async () => {
    const base = await makeTmpDir()
    const { log } = captureLog()
    const artifacts = await writeArchive({
      base,
      layout: 'session',
      epochPrefix: 'epoch',
      sessionId: 'a1',
      messages: [message('修复登录 bug'), message('继续')],
      config: resolveDigestConfig(undefined, { writeRaw: true }),
      log,
      logScope: 'sidecar',
    })

    const dir = path.join(base, 'sessions', 'a1')
    expect((await readdir(dir)).sort()).toEqual([
      'epoch-1.digest.md',
      'epoch-1.raw.md',
      'latest-digest.txt',
      'latest.txt',
    ])
    expect(artifacts.epoch).toBe(1)
    expect(artifacts.rawPath).toBe(path.join(dir, 'epoch-1.raw.md'))
    expect(artifacts.digestPath).toBe(path.join(dir, 'epoch-1.digest.md'))
    expect(await readFile(path.join(dir, LATEST_POINTER), 'utf8')).toBe(`${artifacts.rawPath}\n`)
    expect(await readFile(path.join(dir, LATEST_DIGEST_POINTER), 'utf8')).toBe(`${artifacts.digestPath}\n`)
    const digest = await readFile(artifacts.digestPath!, 'utf8')
    expect(digest).toContain('- 会话: a1')
    expect(digest).toContain('- 第几次: 1')
    expect(digest).toContain('修复登录 bug')
  })

  it('honours minEpoch so a caller that counted the session never reuses a number', async () => {
    const base = await makeTmpDir()
    const { log } = captureLog()
    const request = {
      base,
      layout: 'session' as const,
      epochPrefix: 'epoch',
      sessionId: 'a1',
      messages: [message('first')],
      config: resolveDigestConfig(undefined, { writeRaw: true }),
      log,
      logScope: 'sidecar',
    }
    const first = await writeArchive(request)
    expect(first.epoch).toBe(1)
    // Two compactions were lost before this one (a write failure, a session
    // whose cwd changed): the scan would still say 2, and overwriting epoch 2
    // would destroy nothing — but the caller's own count says 4, and a number
    // must never be reused for a different region.
    const fourth = await writeArchive({ ...request, minEpoch: 4 })
    expect(fourth.epoch).toBe(4)
    // A stale count below the scan never moves the number backwards.
    const fifth = await writeArchive({ ...request, minEpoch: 2 })
    expect(fifth.epoch).toBe(5)
  })

  it('writes the raw archive without a digest when the digest is disabled', async () => {
    const base = await makeTmpDir()
    const { log, lines } = captureLog()
    const artifacts = await writeArchive({
      base,
      layout: 'session',
      epochPrefix: 'epoch',
      sessionId: 'a1',
      messages: [message('body')],
      config: resolveDigestConfig({ digestEnabled: false }, { writeRaw: true }),
      log,
      logScope: 'sidecar',
    })
    expect(artifacts.digestPath).toBeUndefined()
    expect(await readdir(path.join(base, 'sessions', 'a1'))).toEqual(['epoch-1.raw.md', 'latest.txt'])
    expect(lines.some(line => line.includes('skipped reason=disabled'))).toBe(true)
  })

  it('degrades to no files, never a throw, when the base is unresolvable', async () => {
    const { log, lines } = captureLog()
    const artifacts = await writeArchive({
      base: undefined,
      layout: 'session',
      epochPrefix: 'epoch',
      sessionId: 'a1',
      messages: [message('body')],
      config: resolveDigestConfig(undefined),
      log,
      logScope: 'sidecar',
    })
    expect(artifacts).toEqual({})
    expect(lines.some(line => line.includes('no-base-dir'))).toBe(true)
  })

  it('reports a write failure instead of throwing', async () => {
    const base = await makeTmpDir()
    const { log, lines } = captureLog()
    // A regular file where the session directory must go: mkdir fails.
    // The first call below writes the digest (the raw is opt-in), so that is the
    // file to aim the second call at.
    await writeArchive({
      base,
      layout: 'flat',
      epochPrefix: 'epoch',
      sessionId: 'a1',
      messages: [message('body')],
      config: resolveDigestConfig(undefined),
      log,
      logScope: 'sidecar',
    })
    const artifacts = await writeArchive({
      base: path.join(base, 'epoch-1.digest.md'),
      layout: 'flat',
      epochPrefix: 'epoch',
      sessionId: 'a1',
      messages: [message('body')],
      config: resolveDigestConfig(undefined),
      log,
      logScope: 'sidecar',
    })
    expect(artifacts.digestPath).toBeUndefined()
    expect(lines.some(line => line.includes('write-failed'))).toBe(true)
  })
})

/**
 * The side-car exists to hand over a **0-token digest** — a document small
 * enough to read at resume time. The raw transcript is the whole compacted
 * region re-dumped (measured: 401 messages → 286 KB ≈ 64k tokens, 65.6% of it
 * tool results), so it is opt-in: writing ~300 KB per compaction that nobody
 * reads is not the default. These tests pin both sides of that switch.
 */
describe('raw transcript is opt-in', () => {
  it('writes only the digest by default', async () => {
    const base = await makeTmpDir()
    const { log, lines } = captureLog()
    const artifacts = await writeArchive({
      base,
      layout: 'session',
      epochPrefix: 'epoch',
      sessionId: 'a1',
      messages: [message('修复登录 bug')],
      config: resolveDigestConfig(undefined),
      log,
      logScope: 'sidecar',
    })
    const dir = path.join(base, 'sessions', 'a1')
    expect((await readdir(dir)).sort()).toEqual(['epoch-1.digest.md', LATEST_DIGEST_POINTER])
    expect(artifacts.rawPath).toBeUndefined()
    expect(artifacts.rawBytes).toBeUndefined()
    expect(artifacts.digestPath).toBe(path.join(dir, 'epoch-1.digest.md'))
    expect(lines.some(line => line.includes('raw-skipped'))).toBe(true)
    // The digest no longer advertises a transcript that was never written.
    const digest = await readFile(artifacts.digestPath as string, 'utf8')
    expect(digest).not.toContain('原始档')
    expect(digest).not.toContain('未落盘')
  })

  it('still numbers epochs from the digests alone', async () => {
    const base = await makeTmpDir()
    const { log } = captureLog()
    const config = resolveDigestConfig(undefined)
    const numbers: (number | undefined)[] = []
    for (let index = 0; index < 3; index += 1) {
      const artifacts = await writeArchive({
        base,
        layout: 'session',
        epochPrefix: 'epoch',
        sessionId: 'a1',
        messages: [message(`第 ${index} 段`)],
        config,
        log,
        logScope: 'sidecar',
      })
      numbers.push(artifacts.epoch)
    }
    // Numbering used to be scanned from `*.raw.md`, so with no raws every
    // compaction would have claimed epoch 1 and overwritten the previous digest.
    expect(numbers).toEqual([1, 2, 3])
    const dir = path.join(base, 'sessions', 'a1')
    expect((await readdir(dir)).sort()).toEqual([
      'epoch-1.digest.md',
      'epoch-2.digest.md',
      'epoch-3.digest.md',
      LATEST_DIGEST_POINTER,
    ])
  })

  it('writes the transcript when the setting asks for it', async () => {
    const base = await makeTmpDir()
    const { log } = captureLog()
    const artifacts = await writeArchive({
      base,
      layout: 'session',
      epochPrefix: 'epoch',
      sessionId: 'a1',
      messages: [message('body')],
      config: resolveDigestConfig({ writeRawArchive: true }),
      log,
      logScope: 'sidecar',
    })
    const dir = path.join(base, 'sessions', 'a1')
    expect((await readdir(dir)).sort()).toEqual([
      'epoch-1.digest.md',
      'epoch-1.raw.md',
      LATEST_DIGEST_POINTER,
      LATEST_POINTER,
    ])
    expect(artifacts.rawBytes).toBeGreaterThan(0)
    const digest = await readFile(artifacts.digestPath as string, 'utf8')
    expect(digest).toContain('原始档')
  })
})

/**
 * A control byte anywhere in a written document makes the Web preview refuse the
 * whole file (`workspace-file/not-text` → 「非文本文件，暂时无法预览。」), because
 * the workspace-files reader checks the entire returned page for NUL. Tool
 * results carry those bytes for real — dumping `/proc/<pid>/cmdline` separates
 * arguments with NUL — so the writer, not each renderer, has to guarantee the
 * documents it produces are NUL-free.
 */
describe('archive text hygiene', () => {
  it('writes no NUL byte even when a message carries one', async () => {
    const base = await makeTmpDir()
    const { log } = captureLog()
    const artifacts = await writeArchive({
      base,
      layout: 'session',
      epochPrefix: 'epoch',
      sessionId: 'a1',
      messages: [message('before\u0000after'), message('tail')],
      config: resolveDigestConfig(undefined, { writeRaw: true }),
      log,
      logScope: 'sidecar',
    })
    const raw = await readFile(artifacts.rawPath as string)
    expect(raw.includes(0)).toBe(false)
    const text = raw.toString('utf8')
    expect(text).toContain('before␀after')
    expect(text).toContain('tail')
  })

  it('strips ANSI colour escapes from tool output', async () => {
    const base = await makeTmpDir()
    const { log } = captureLog()
    const artifacts = await writeArchive({
      base,
      layout: 'session',
      epochPrefix: 'epoch',
      sessionId: 'a1',
      messages: [message('\u001b[1;34m==> checking\u001b[0m done')],
      config: resolveDigestConfig(undefined, { writeRaw: true }),
      log,
      logScope: 'sidecar',
    })
    const text = await readFile(artifacts.rawPath as string, 'utf8')
    expect(text).not.toContain('\u001b')
    expect(text).toContain('==> checking done')
  })
})
