/**
 * Paths suite: the session-scoped archive layout and the id-to-directory
 * mapping. The mapping is a filesystem boundary, so the cases here are the
 * hostile ones (separators, traversal, reserved names, length, collisions).
 */

import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SESSIONS_DIRNAME, archiveLocation, digestPointerCandidates, sessionDirName } from '../src/paths.ts'

describe('sessionDirName', () => {
  it('keeps an ordinary id verbatim', () => {
    expect(sessionDirName('a1')).toBe('a1')
    expect(sessionDirName('session-0f3a9c11-1b2c')).toBe('session-0f3a9c11-1b2c')
  })

  it('never lets a path separator or traversal reach the filesystem', () => {
    for (const hostile of ['a/b', '..', '.', '', 'a\\b', '../etc/passwd']) {
      const name = sessionDirName(hostile)
      expect(name).not.toContain('/')
      expect(name).not.toContain('\\')
      expect(name).not.toBe('.')
      expect(name).not.toBe('..')
      expect(name.length).toBeGreaterThan(0)
    }
  })

  it('keeps different ids on different directories even after sanitizing', () => {
    expect(sessionDirName('a/b')).not.toBe(sessionDirName('a_b'))
    expect(sessionDirName('a/b')).toBe(sessionDirName('a/b'))
  })

  it('caps the readable part and stays stable for one id', () => {
    const long = 'x'.repeat(400)
    const name = sessionDirName(long)
    expect(name.length).toBeLessThanOrEqual(128 + 9)
    expect(sessionDirName(long)).toBe(name)
  })
})

describe('archiveLocation', () => {
  it('nests the session directory under the base by default', () => {
    const location = archiveLocation('/w/.handoff', 'session-abc', 'session')
    expect(location.dir).toBe(path.join('/w/.handoff', SESSIONS_DIRNAME, 'session-abc'))
    expect(location.session).toBe('session-abc')
    expect(location.layout).toBe('session')
  })

  it('falls back to the legacy flat layout on request', () => {
    const location = archiveLocation('/w/.handoff', 'session-abc', 'flat')
    expect(location.dir).toBe('/w/.handoff')
    expect(location.session).toBe('')
  })

  it('puts two concurrent sessions of one workspace in separate directories', () => {
    const first = archiveLocation('/w/.handoff', 'session-1', 'session')
    const second = archiveLocation('/w/.handoff', 'session-2', 'session')
    expect(first.dir).not.toBe(second.dir)
  })
})

describe('digestPointerCandidates', () => {
  it('probes the session pointer before the flat one', () => {
    expect(digestPointerCandidates('/w/.handoff', 'a1')).toEqual([
      path.join('/w/.handoff', SESSIONS_DIRNAME, 'a1', 'latest-digest.txt'),
      path.join('/w/.handoff', 'latest-digest.txt'),
    ])
  })
})
