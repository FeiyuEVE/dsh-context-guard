/**
 * Digest suite: the deterministic fact extractor, composer, budget ladder, and
 * carry-forward parser. Pure functions only — no loop, no I/O.
 */

import { describe, expect, it } from 'vitest'
import type { Message } from '@deepseek-ai/dsh-llm'
import {
  DIGEST_FORMAT_VERSION,
  DIGEST_MARKER,
  DIGEST_SECTIONS,
  carriedFrom,
  composeDigest,
  digestPathFrom,
  estimateTextTokens,
  extractFacts,
  parseDigest,
} from '../src/digest.ts'

/** One user-role text message. */
function user(text: string, source: unknown = { kind: 'user' }): Message {
  return { role: 'user', content: [{ type: 'text', text }], source } as unknown as Message
}

/** One assistant message carrying text and tool calls. */
function assistant(text: string, calls: { id: string; name: string; args: unknown }[] = []): Message {
  return {
    role: 'assistant',
    content: [
      ...text.length > 0 ? [{ type: 'text', text }] : [],
      ...calls.map(call => ({
        type: 'tool-call',
        id: call.id,
        name: call.name,
        arguments: typeof call.args === 'string' ? call.args : JSON.stringify(call.args),
      })),
    ],
  } as unknown as Message
}

/** One user-role message carrying a tool result. */
function toolResult(body: string, isError = false): Message {
  return {
    role: 'user',
    content: [{
      type: 'tool-result',
      toolCallId: 'c1',
      isError,
      content: [{ type: 'text', text: body }],
    }],
    source: { kind: 'tool', callId: 'c1' },
  } as unknown as Message
}

/** A minimal meta block for composition. */
function meta(overrides: Partial<Parameters<typeof composeDigest>[1]> = {}): Parameters<typeof composeDigest>[1] {
  return {
    sessionId: 'a1',
    epoch: 1,
    regionMessages: 4,
    regionToolCalls: 2,
    regionTokens: 4000,
    ...overrides,
  }
}

describe('estimateTextTokens', () => {
  it('prices CJK denser than the flat ascii estimate', () => {
    const chinese = '这是一段中文文本'
    expect(estimateTextTokens(chinese, 'cjk')).toBeGreaterThan(estimateTextTokens(chinese, 'ascii'))
    expect(estimateTextTokens('abcdefgh', 'ascii')).toBe(2)
    expect(estimateTextTokens('abcdefgh', 'cjk')).toBe(2)
  })
})

describe('extractFacts', () => {
  it('collects intents, files, commands, errors and structured todos', () => {
    const facts = extractFacts([
      user('修复登录 bug，涉及 src/auth.ts'),
      assistant('先看代码', [
        { id: 'c1', name: 'read', args: { file_path: '/w/src/auth.ts' } },
        { id: 'c2', name: 'bash', args: { command: 'pnpm test auth' } },
      ]),
      toolResult('Error: EACCES denied', true),
      assistant('更新计划', [
        { id: 'c3', name: 'todo_write', args: { todos: [
          { content: '改完 auth.ts', status: 'pending' },
          { content: '跑一遍回归', status: 'in_progress' },
          { content: '写文档', status: 'completed' },
        ] } },
      ]),
      assistant('结果如下', [{ id: 'c4', name: 'read', args: { file_path: '/w/src/auth.ts' } }]),
    ])

    expect(facts.intents[0]).toContain('修复登录 bug')
    expect(facts.lastUserText).toContain('修复登录 bug')
    expect(facts.files.get('/w/src/auth.ts')).toEqual({ reads: 2, writes: 0 })
    expect(facts.commands).toEqual(['pnpm test auth'])
    expect(facts.errors.some(line => line.includes('EACCES'))).toBe(true)
    // Structured todos win, and completed entries are dropped.
    expect(facts.todos).toEqual(['改完 auth.ts', '跑一遍回归'])
    expect(facts.toolCallCount).toBe(4)
    // Identical repeated call is noted.
    expect(facts.duplicates).toEqual([
      { name: 'read', display: '/w/src/auth.ts', count: 2 },
    ])
  })

  it('does not promote a successful call whose output merely mentions an error', () => {
    // Real defect: a shipped digest listed
    // `bash: === 该错误是否历史就有（上次重启/更早）===` under 报错与修复 — an
    // echo banner the agent printed while investigating. Only the error *word*
    // matched; the call itself succeeded and printed no diagnostic.
    const facts = extractFacts([
      assistant('查一下', [{ id: 'c1', name: 'bash', args: { command: "echo '=== 该错误是否历史就有 ==='" } }]),
      toolResult('=== 该错误是否历史就有（上次重启/更早）==='),
    ])
    expect(facts.errors).toEqual([])
  })

  it('keeps a real diagnostic printed by a call that exited zero', () => {
    const facts = extractFacts([
      assistant('看看进程', [{ id: 'c1', name: 'bash', args: { command: 'ps aux' } }]),
      toolResult('sh: 1: ps: not found'),
    ])
    expect(facts.errors).toEqual(['bash: sh: 1: ps: not found'])
  })

  it('keeps an error-flagged result whatever its shape', () => {
    const facts = extractFacts([
      assistant('跑一下', [{ id: 'c1', name: 'bash', args: { command: 'something' } }]),
      toolResult('工具调用被中止', true),
    ])
    expect(facts.errors).toEqual(['bash: 工具调用被中止'])
  })

  it('reads past the stream markers a tool wraps output in', () => {
    // A failing command arrives as `[stderr]` / message / `[exit code: N]` with
    // isError: false. Taking the literal first line read `[stderr]`, which
    // matches no error signal — so every real stderr failure was invisible in
    // 报错与修复 (observed in the container: `ps aux` reported nothing).
    const facts = extractFacts([
      assistant('看看进程', [{ id: 'c1', name: 'bash', args: { command: 'ps aux' } }]),
      toolResult('[stderr]\nbash: line 1: ps: command not found\n[exit code: 127]'),
    ])
    expect(facts.errors).toEqual(['bash: bash: line 1: ps: command not found'])
  })

  it('keeps shell noise, file extensions and diagnostic verbs out of the concepts', () => {
    const facts = extractFacts([
      assistant('干活', [
        { id: 'c1', name: 'bash', args: { command: 'cd /w && git status' } },
        { id: 'c2', name: 'read', args: { file_path: '/w/README.md' } },
        { id: 'c3', name: 'read', args: { file_path: '/w/notes.txt' } },
        { id: 'c4', name: 'read', args: { file_path: '/w/src/index.ts' } },
        { id: 'c5', name: 'read', args: { file_path: '/w/package.json' } },
      ]),
    ])
    expect(facts.concepts).not.toContain('cd')
    // A real digest read `git, ts, js, json, npm, docker`: the tooling is worth
    // carrying, but the extensions of files that 涉及文件 already lists in full
    // retrieve nothing.
    expect(facts.concepts).toContain('git')
    expect(facts.concepts).not.toContain('ts')
    expect(facts.concepts).not.toContain('json')
    expect(facts.concepts).not.toContain('md')
    expect(facts.concepts).not.toContain('txt')
    // Diagnostic verbs are noise too: a container run listed `ps` as a
    // 关键技术概念 after the session ran `ps aux` once.
    const probe = extractFacts([
      assistant('看看', [{ id: 'c1', name: 'bash', args: { command: 'ps aux' } }]),
    ])
    expect(probe.concepts).not.toContain('ps')
    // `for` opens a construct rather than naming a program, and the first word
    // of a command may be an assignment. A replay of a real region listed both
    // `for` and `p=/home/…/@feiyueve/dsh-context-guard;` as 关键技术概念.
    const shell = extractFacts([
      assistant('批量', [
        { id: 'c1', name: 'bash', args: { command: 'for p in a b; do systemctl status "$p"; done' } },
        { id: 'c2', name: 'bash', args: { command: 'p=/home/w/node_modules/@feiyueve/x; echo "$p"' } },
        { id: 'c3', name: 'bash', args: { command: 'systemctl restart dsh-web' } },
      ]),
    ])
    expect(shell.concepts).not.toContain('for')
    expect(shell.concepts).not.toContain('p=/home/w/node_modules/@feiyueve/x;')
    // A program that really is the head of a command is still a technology.
    expect(shell.concepts).toContain('systemctl')
  })

  it('does not read a grep line number as a diagnostic', () => {
    // Real defect: a digest listed
    // `bash: 38:### [2026-09-12] … 报错判据收严` under 报错与修复. That is a
    // changelog *heading* which happens to contain the word 报错; it matched
    // only because the `grep -n` line number in front of it had the `name:`
    // shape. A count is not a program.
    const facts = extractFacts([
      assistant('查标题', [{ id: 'c1', name: 'bash', args: { command: 'grep -n 报错 CHANGES.md' } }]),
      toolResult('38:### [2026-09-12] dsh-context-guard 0.3.8–0.3.10：交接声明块带体积、报错判据收严'),
    ])
    expect(facts.errors).toEqual([])
  })

  it('drops failures the very next step clears by retrying', () => {
    // Real defect: five of one digest's six 报错与修复 bullets were these. They
    // carry `isError: true`, so the flag alone keeps them — but the agent fixed
    // each by re-issuing the call, and a reader learns nothing.
    const facts = extractFacts([
      assistant('改代码', [{ id: 'c1', name: 'edit', args: { file_path: '/w/src/a.ts' } }]),
      toolResult('Error: cannot modify "/w/src/a.ts": file has not been read — read the file, then retry', true),
      assistant('再试', [{ id: 'c2', name: 'edit', args: { file_path: '/w/src/b.ts' } }]),
      toolResult('Error: old_string was not found in "/w/src/b.ts"', true),
    ])
    expect(facts.errors).toEqual([])
  })

  it('does not read a background-job notice as a human request', () => {
    // Real defect: a digest opened 主要意图 with `bash cd … && sed …` — the
    // *command line* a `tool-jobs` completion notice carries as its summary —
    // and pushed the human's actual question to second place.
    const facts = extractFacts([
      user('重启了吗？怎么样？'),
      user('background job bash-3 (bash: cd /w && sed s/a/b/ f.txt) finished [status: completed]', {
        kind: 'plugin',
        plugin: 'tool-jobs',
        form: 'notice',
        summary: 'bash cd /w && sed s/a/b/ f.txt',
      }),
    ])
    expect(facts.intents).toEqual(['重启了吗？怎么样？'])
  })

  it('drops host-re-injected context and prior frames', () => {
    const facts = extractFacts([
      user('You are an AI agent powered by DeepSeek Harness.', { kind: 'agent-instructions', form: 'instructions' }),
      { role: 'system', content: [{ type: 'text', text: 'system prompt' }], source: { kind: 'system' } } as unknown as Message,
      user('skills catalog', { kind: 'skill-catalog' }),
      user('本段历史已由 dsh-context-guard 确定性归档', { kind: 'plugin', plugin: 'compact' }),
      user('真正的任务：检查部署'),
    ])
    expect(facts.intents).toEqual(['真正的任务：检查部署'])
    expect(facts.messageCount).toBe(5)
  })

  it('flags writes separately from reads', () => {
    const facts = extractFacts([
      assistant('', [{ id: 'c1', name: 'edit', args: { path: '/w/a.ts' } }]),
      assistant('', [{ id: 'c2', name: 'read', args: { path: '/w/a.ts' } }]),
    ])
    expect(facts.files.get('/w/a.ts')).toEqual({ reads: 1, writes: 1 })
  })
})

describe('composeDigest', () => {
  it('renders the eight sections, the version marker and the identity header', () => {
    const facts = extractFacts([
      user('把移动端抽屉修好'),
      assistant('看代码', [{ id: 'c1', name: 'read', args: { file_path: '/w/drawer.ts' } }]),
      toolResult('Error: 找不到模块 drawer'),
      assistant('计划', [{ id: 'c2', name: 'todo_write', args: { todos: [
        { content: '修好抽屉', status: 'pending' },
      ] } }]),
    ])
    const result = composeDigest(facts, meta({ epoch: 3, rawPath: '/w/.handoff/epoch-3.raw.md', carriedFrom: 2 }), {})

    expect(result.text.startsWith(DIGEST_MARKER)).toBe(true)
    expect(result.text).toContain(`v${DIGEST_FORMAT_VERSION}`)
    expect(result.text).toContain('- 会话: a1')
    expect(result.text).toContain('- 第几次: 3')
    expect(result.text).toContain('epoch-3.raw.md')
    expect(result.text).toContain('- 继承: 第 2 次')
    for (const header of Object.values(DIGEST_SECTIONS)) {
      expect(result.text).toContain(`## ${header}`)
    }
    expect(result.text).toContain('把移动端抽屉修好')
    expect(result.text).toContain('找不到模块 drawer')
    expect(result.text).toContain('修好抽屉')
    expect(result.tier).toBe('full')
  })

  it('is byte-identical for identical input', () => {
    const messages = [
      user('任务 A'),
      assistant('读文件', [{ id: 'c1', name: 'read', args: { file_path: '/w/x.ts' } }]),
    ]
    const first = composeDigest(extractFacts(messages), meta(), {})
    const second = composeDigest(extractFacts(messages), meta(), {})
    expect(second.text).toBe(first.text)
  })

  it('does not render the last user request twice', () => {
    // 主要意图 already ends with the last user request, so repeating it as the
    // head of 当前进展 made the longest line of a real 478-token digest appear
    // twice — and that duplicate was what pushed the page over its tier floor.
    const messages = [user('把部署脚本修好，这是本次唯一的请求'), assistant('已经改完并提交')]
    const result = composeDigest(extractFacts(messages), meta({ regionTokens: 100_000 }), { maxTokens: 800 })
    expect(result.body.split('把部署脚本修好').length - 1).toBe(1)
    // 当前进展 still says where things stood.
    expect(result.body).toContain('已经改完并提交')
  })

  it('renders the immediate next action once, not also inside the todo list', () => {
    const messages = [
      user('继续'),
      assistant('记录待办', [{ id: 'c1', name: 'todo_write', args: { todos: [
        { content: '先修 A', status: 'pending' },
        { content: '再修 B', status: 'pending' },
      ] } }]),
    ]
    const result = composeDigest(extractFacts(messages), meta({ regionTokens: 100_000 }), { maxTokens: 800 })
    expect(result.body).toContain(`## ${DIGEST_SECTIONS.next}\n- 先修 A`)
    expect(result.body).toContain(`## ${DIGEST_SECTIONS.todos}\n- 再修 B`)
    // The head of the list is shown as the next action and nowhere else.
    expect(result.body.split('先修 A').length - 1).toBe(1)
  })

  it('tightens the tier as the budget shrinks and never exceeds the hard cap', () => {
    // The fixture has to be big enough that the *full* tier alone exceeds the
    // 260-token floor, otherwise no budget can force a downgrade and the test
    // asserts nothing. It previously crossed that line only because of a bug:
    // 当前进展 repeated the last user request, which 主要意图 had already
    // rendered — so the duplicated line was what pushed the page over the floor.
    const messages: Message[] = [user('长任务：' + '内容 '.repeat(400))]
    for (let index = 0; index < 8; index += 1) {
      messages.push(user(`第 ${index} 项请求：` + '这一段是足够长的用户原文，用来占满意图条的裁剪上限。'.repeat(6)))
    }
    for (let index = 0; index < 40; index += 1) {
      messages.push(assistant(`第 ${index} 步说明文字`, [
        { id: `c${index}`, name: 'read', args: { file_path: `/w/file-${index}.ts` } },
      ]))
      messages.push(toolResult(`失败：第 ${index} 步报错`))
    }
    const facts = extractFacts(messages)

    const full = composeDigest(facts, meta({ regionTokens: 100_000 }), { maxTokens: 800 })
    const tight = composeDigest(facts, meta({ regionTokens: 2_000 }), { maxTokens: 200 })
    const hard = composeDigest(facts, meta({ regionTokens: 10 }), { maxTokens: 800 })

    expect(full.tier).toBe('full')
    expect(tight.tier).not.toBe('full')
    expect(tight.digestTokens).toBeLessThanOrEqual(tight.targetTokens)
    expect(hard.digestTokens).toBeLessThanOrEqual(hard.targetTokens)
    expect(full.digestTokens).toBeLessThanOrEqual(full.targetTokens)
    // Every tier still carries the marker and the reading contract.
    for (const result of [full, tight, hard]) {
      expect(result.text).toContain(DIGEST_MARKER)
      expect(result.body.length).toBeGreaterThan(0)
    }
    expect(hard.body).toContain('…')
  })

  it('carries the prior digest sections forward, with fresh facts winning', () => {
    const previous = [
      DIGEST_MARKER,
      '# 接力摘要',
      '',
      `## ${DIGEST_SECTIONS.intent}`,
      '- 上一个任务：修复部署脚本',
      `## ${DIGEST_SECTIONS.files}`,
      '- /w/old.sh — W×1',
      '',
    ].join('\n')
    const carried = carriedFrom(parseDigest(previous))
    const facts = extractFacts([user('新任务：补充文档'), assistant('', [
      { id: 'c1', name: 'edit', args: { file_path: '/w/new.md' } },
    ])])
    const result = composeDigest(facts, meta({ epoch: 2, carriedFrom: 1 }), { carried })

    expect(result.text).toContain('上一个任务：修复部署脚本')
    expect(result.text).toContain('新任务：补充文档')
    expect(result.text).toContain('/w/old.sh')
    expect(result.text).toContain('/w/new.md')
  })

  it('does not accumulate the per-epoch provenance line across generations', () => {
    // Regression: a real 4-compaction session (2026-09-12) showed 压缩说明
    // growing by one stale "本段由 …" line per epoch.
    const composeOnce = (region: Message[], carried: Map<string, string[]> | undefined, epoch: number) =>
      composeDigest(extractFacts(region), meta({ epoch, carriedFrom: epoch > 1 ? epoch - 1 : undefined }), { carried })

    const first = composeOnce([user('任务一')], undefined, 1)
    const second = composeOnce([user('任务二')], carriedFrom(parseDigest(first.text)), 2)
    const third = composeOnce([user('任务三')], carriedFrom(parseDigest(second.text)), 3)

    const countNotes = (text: string): number => text.split('本段由 dsh-context-guard 确定性压缩').length - 1
    expect(countNotes(first.text)).toBe(1)
    expect(countNotes(second.text)).toBe(1)
    expect(countNotes(third.text)).toBe(1)
    // The earlier intents are still carried; only the provenance line is not.
    expect(third.text).toContain('任务一')
    expect(third.text).toContain('任务三')
  })
})

describe('parseDigest / carriedFrom', () => {
  it('round-trips sections and refuses a version mismatch', () => {
    const parsed = parseDigest([DIGEST_MARKER, `## ${DIGEST_SECTIONS.intent}`, '- 做 A', '- 做 B'].join('\n'))
    expect(parsed?.version).toBe(DIGEST_FORMAT_VERSION)
    expect(parsed?.sections.get(DIGEST_SECTIONS.intent)).toEqual(['做 A', '做 B'])
    expect(carriedFrom(parsed).get(DIGEST_SECTIONS.intent)).toEqual(['做 A', '做 B'])

    const older = parseDigest('<!-- context-guard-digest v99 -->\n## 主要意图\n- 旧')
    expect(carriedFrom(older).size).toBe(0)
    expect(parseDigest('no marker here')).toBeUndefined()
  })
})

describe('digestPathFrom', () => {
  it('reads the backticked path out of a frame, falling back to a bare path', () => {
    expect(digestPathFrom('摘要：`/w/.handoff/sessions/a1/epoch-2.digest.md`'))
      .toBe('/w/.handoff/sessions/a1/epoch-2.digest.md')
    expect(digestPathFrom('摘要见 /w/.handoff/sessions/a1/epoch-2.digest.md 文件'))
      .toBe('/w/.handoff/sessions/a1/epoch-2.digest.md')
    expect(digestPathFrom('没有引用')).toBeUndefined()
  })

  it('ignores a bare filename: prose mentions a digest without pointing at one', () => {
    expect(digestPathFrom('归档为 `epoch-N.digest.md`')).toBeUndefined()
    expect(digestPathFrom('落点 `epoch-12.digest.md` 与 `latest-digest.txt`')).toBeUndefined()
  })

  it('ignores archive-looking prose in a model-written checkpoint summary', () => {
    // Verbatim shape from a real compaction on 2026-09-12 (session
    // session-30535614…, `standard` preset → `compaction-basic`): the summary
    // is ordinary text that quotes the format docs, and the guard used to
    // resolve `epoch-N.digest.md` out of it as if the engine had written it.
    const foreignSummary = [
      '- 手动 `/compact` 走同一个 `summarize()` → 写 `epoch-N.raw.md` + `epoch-N.digest.md`，编号递增。',
      '- 磁盘现状：`.handoff/sessions/` 为空，299 个 flat `*.raw.md`，`latest.txt` → `epoch-299.raw.md`。',
    ].join('\n')
    expect(digestPathFrom(foreignSummary)).toBeUndefined()
  })

  it('takes the last absolute path when a frame names several', () => {
    const frame = [
      '- 精简接力摘要：`/w/.handoff/sessions/a1/epoch-1.digest.md`',
      '- 继承自：`/w/.handoff/sessions/a1/epoch-2.digest.md`',
    ].join('\n')
    expect(digestPathFrom(frame)).toBe('/w/.handoff/sessions/a1/epoch-2.digest.md')
  })
})
