# Changelog

本文件记录 `@feiyueve/dsh-context-guard` 的发布历史，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 SemVer。

dsh 处于预发布阶段：本插件每个版本都在 `package.json` 的 `peerDependencies` 里**显式列出**兼容的 `@deepseek-ai/dsh-*` 版本（禁止 `*` / 过宽范围），dsh 升级后按工作区「dsh 升级联动」规则追加新版本号并发补丁版。

## [0.4.6] - 2026-09-17

### 修复

- **不再与 goal round 争 `next-turn`：压缩续跑提示改用下一步通道，消灭「goal round 被判废 + 空转一轮 +
  重排到提示后面」**。线上会话 `session-6178b6e6`（8 个 goal round、自动压缩 `eb56714f`）逐 seq 复现：
  `1293` goal driver 在压缩期间把 round 7 排进 `next-turn[0]` → `1296 compaction/end` → `1297` 守卫用
  `followup()` 把续跑提示排到 `next-turn[1]` → `1298` 开轮、`1299` 领走的是 round → `1300`
  `turn/end reason=blocked`（driver 的 `agent/pre-step` 把已置 `stale` 的 reservation 判为失效）→
  `1301` round 被重排到提示**后面** → `1303` 领走提示。
  根因是**通道选错**：`next-turn` 在这套架构里的语义是「申请一轮」（`claim('next-turn')` 领走全部
  `next-step` + 恰好一个 `next-turn`），而 goal driver 把该通道上的任何外来消息读成竞争提示；「只想让
  模型看到的内容」在本仓库的惯例是走 `next-step` —— 同一会话里 `agent-instructions`（AGENTS.md）6 次、
  `tool-jobs` 通知 4 次、`agent-message`/`subagent-settled` 17 次全部如此，因此从不被抢占。
  现在按「谁拥有这一轮」选通道：**无 goal** → 保持 `followup()`（进 `next-turn`；自动压缩发生在
  `agent/status idle`，这一轮本来没有别的 owner，不唤醒会话就停住）；**有 goal** → `agent.steer()`
  （进 `next-step`，与 goal round 落在**同一个 step**、同一个请求）；**L3 抑制 + 有 goal** →
  `agent.inject()`（同通道、不唤醒）。
  归属判据 `goalTurnOwner()` 用两层观察：①`next-turn` 里已排队的 goal round（无需服务查找；
  composition 把 `dsh-goal` 挂在 preset `isolate` realm 时，这是 host 半边**唯一**可见的信号）；
  ②`ctx.get('goals')` 的 live 视图（`phase==='active' && activation==='armed' &&
  roundsStarted < maxGoalRounds`；`activation` 是进程内的，会话日志里读不到）。两者都读不到时退回
  `followup()`，即 0.4.5 及以前的行为，不会更糟。**goal 处于 paused / blocked / complete / disarmed /
  轮次用尽时不拥有这一轮**，守卫照常自己唤醒，否则「goal 停了，会话也跟着停住」。
- 不新增依赖（`goals` 经 `ctx.get` 读、缺失即降级，`MessageSourceMap` 的 `goal` 判别子按字符串比较）；
  不改客户端半边、不改归档/digest 契约、不改任何 preset。`resume: sent` / `resume: suppressed` 两行日志
  新增 `owner=` 字段（空 = 守卫自己开轮）。

### 验证

- `npm run verify`（typecheck + vitest + tsdown/esbuild）退出 0，**124 例 / 10 文件**（新增 4 例）。
- **新用例会拒绝旧行为**：把通道改回无条件 `followup()`，`goal-owned post-compaction continuation`
  一组 4 例挂 3 例（第 4 例「goal 不拥有时必须自己唤醒」是反向不变量，两种实现都通过）。
- 4 例分别钉住：armed goal 时提示**不**进 `next-turn`（`nextTurnGuardInserts` 为空）且不再出现
  `turn/end reason=blocked`；已排队的 goal round 与续跑提示落在同一个 `turn/step`（对 `step/start`
  边界比对，覆盖 realm-isolate 下只有 inbox 信号的场景）；goal 处于 paused/disarmed/blocked/complete/
  轮次用尽时守卫仍走 `followup()`；L3 抑制 + armed goal 时提示停在 `agent.inbox.nextStep`、不唤醒、
  `turn/end` 计数不变。

## [0.4.5] - 2026-09-16

### 兼容性

- 声明兼容 dsh `0.1.6-alpha.1` 与本地发布线 `0.1.6-alpha.1-local.1`:7 个 `@deepseek-ai/dsh-*` 依赖的 `peerDependencies` 列表末尾各追加这两个版本号,保持显式列表风格。
- **只做版本适配,功能零改动**(`src/`、`scripts/`、`cordis.patch.yml` 均未触碰)。0.1.6 下契约核实结果:`compaction/compaction/src/types.ts` 与 `0.1.5-rc.2` diff 为空、`summarize()` 仍是唯一官方扩展点、「同步落盘先于替换」不变量未变;settings 与 `ui-settings` slot 契约源码零改动;守卫不订阅 `agent/session-start`(0.1.6 已删除该事件)。
- 记债(不在本版处理):`session.snapshotEvents()` / `eventAt()` 在 0.1.6 起标记 `@deprecated`(仍保留实现,运行期不崩),上游 policy 允许既有调用延后迁移;迁移需单独立项。

## [0.4.4] - 2026-09-14

### 兼容性

- 声明兼容 dsh `0.1.5-rc.2-local.5`（与上游基线 `0.1.5-rc.2` 相同，仅本地补丁号 +1，上游兼容面未变）。
- 7 个 `@deepseek-ai/dsh-*` 依赖（`dsh-agent` / `dsh-compaction` / `dsh-compaction-basic` / `dsh-llm` / `dsh-session` / `dsh-token-meter` / `dsh-settings`）的 `peerDependencies` 列表末尾追加 `|| 0.1.5-rc.2-local.5`，保持显式列表风格。
- **只做版本适配，功能零改动**（`src/`、`scripts/`、`cordis.patch.yml` 均未触碰）。

### 验证

- 兼容性验证口径：本仓库无 `scripts/check-dsh-compatibility.mjs`；以「链接场实测版本对账」代替 —— `node_modules/@deepseek-ai/*`（经 `pnpm-workspace.yaml` 的 `overrides` link 到 `../deepseek-harness/` 源码）7 个包实际版本均为 `0.1.5-rc.2-local.5`，且逐条落在新声明的 `peerDependencies` 范围内。
- `npm run verify`（typecheck + vitest + tsdown/esbuild 构建）退出 0。

## [0.4.3] - 2026-09-12

### 修复

- **贴底保存行下方不再露出滚过去的正文**。0.4.2 把保存行做成 `position:sticky; bottom:0` 后，实测
  行底边对齐的是滚动窗口的**内容盒**底边，不含宿主容器自己的 `padding-bottom`（staging 实测
  `._7kpBWW_options` 是 **24px**），于是保存行与窗口底边之间留出一条 24px 的缝，正在滚过去的
  下一组标题就从缝里透出来（`elementFromPoint` 落点确认为 `.cg-group`，截图同样可见）。
  补一块与保存行同底色、向下溢出 **24px** 的「围裙」（`.cg-actions::after`，`background:inherit`），
  缝即被盖住。围裙高度必须**正好等于**宿主那段 padding：矮了盖不住；高了会多出可滚动余量
  （绝对定位的后代同样计入滚动溢出，先按 40px 做实测多出 12px，滚到底会多出一截空白），
  24px 时 `scrollHeight` 回到 1990、零溢出。短面板不滚动时它落在窗口内边距里，无副作用。
  在线注入同款 CSS 复测：同一落点由 `.cg-group` 变为 `.cg-actions`，滚到底无残留。

## [0.4.2] - 2026-09-12

### 修复

- **移动端设置分节看不到保存按钮：保存行改为贴底常驻**。在真实移动壳里复现（staging 网关配对进入、
  390×664 视口、设置 → 上下文守卫）：分节内容高 **2145px**，而设置弹窗的滚动窗口只有 **511px**，
  保存按钮起始位置在 **y=2249**，要连滑三次才进视口 —— 用户报的「移动端无法滚动、看不到保存」
  就是这个。触摸本身能滚（实测 `scrollTop` 0→742→1438→1662，起手落在 textarea / 复选框上同样能滚），
  所以问题在按钮位置而不在事件。
  - 保存按钮与保存状态收进同一个 `.cg-actions` 容器，`position:sticky; bottom:0`，底色用弹窗同一套
    surface token（`--dsw-alias-bg-base`，浅色主题即弹窗的 #fff），滚动时不透出下方内容。
    状态必须与按钮同容器：原来状态渲染在保存行**之后**，落在 sticky 容器之外，贴底只剩一个按钮，
    且状态一出现就把容器撑高、贴底行会跳。
  - 窄屏（`max-width:640px`）再收一档：`gap` 16→10、分组内边距 12→10、说明字号 13→11 行高 18→16，
    两列字段一律单列 —— 省下的都是要滑的距离。
  - 顺手删掉一条对 flex 容器无效的死规则（`@media (max-width:640px){.cg-grid2{grid-template-columns:…}}`；
    `.cg-grid2` 是 `display:flex`，列定义从未生效，真正的单列规则是 `flex-basis:100%`）。

## [0.4.1] - 2026-09-12

### 修复

- **摘要抽取口径收严：不再把过程噪音、文档标题误判和后台任务通知当成交接知识**。线上第一份
  由 0.4.0 产出的摘要（`epoch-8`，362 条消息 / 193 次工具调用）暴露出四处误判，本节逐一收口；
  同一段真实区间重放后，`报错与修复` 由 6 条降到 0 条、`主要意图` 首条回到真人请求、
  `关键技术概念` 由 `git, ts, js, json, npm, docker` 变为 `git, npm, docker, curl, pnpm, systemctl`。
  - **重试即消的策略拒绝不再进 `报错与修复`**（新增 `PROCESS_NOISE`）。原逻辑对 `isError: true`
    无条件收录，于是 6 条里有 5 条是 `Error: cannot modify "…": file has not been read — read the
    file, then retry` 与 `Error: old_string was not found` —— agent 下一步就修好了，读者学不到东西。
  - **数字前缀不再算诊断形态**。`DIAGNOSTIC_LINE` 加上 `(?![0-9]+:)`：原来 `grep -n` 的行号
    （`38:### … 报错判据收严`）会同时满足「诊断形态」与被 `ERROR_LINE` 命中的中文「报错」，
    把一条**变更日志标题**抬成了报错。
  - **后台任务完成通知不再算用户请求**（新增 `isJobNotice()`）。`tool-jobs` 的通知是
    `role: 'user'` + `form: 'notice'`，其 `summary` 就是跑过的命令行，于是「plugin notice 取
    summary」这条既有规则把 `bash cd … && sed …` 抬成 `主要意图` **首条**，真人那句掉到第二。
  - **`关键技术概念` 不再收录路径扩展名**，并收严命令首词。原口径把扩展名当技术栈；重放同一区间
    又暴露两种首词噪音：shell 关键字 `for`（来自 `for p in …`）与变量赋值
    `p=/home/…/@feiyueve/dsh-context-guard;`。现在只收 `COMMAND_CONCEPTS` 词表与**真正的程序名**
    （匹配 `^[a-z][a-z0-9._+-]*$`、非 `SHELL_KEYWORD`、非 `COMMAND_NOISE`）。

## [0.4.0] - 2026-09-12

### 变更

- **完整原文归档改为按需开启，默认只产接力摘要**。此前的「旁挂归档」每次都写一对文件：
  `epoch-<N>.raw.md`（被裁区间逐字重录）与 `epoch-<N>.digest.md`（确定性摘要）。实测一段
  401 条消息 / 204 次工具调用的区间，raw = 286 KB ≈ **64k tokens**，约等于该区间估算 tokens 的 59%
  （构成：工具结果 65.6%、工具调用 JSON 26.9%、正文 7.6%），而 digest = 2.2 KB ≈ 478 tokens。
  raw 的用途只是「按需检索」，但它的体量与刚压缩掉的上下文相当，留着就是一份随时可能被整份
  读回来的第二份上下文。现在新增 settings 开关 `writeRawArchive`（**默认 false**）：默认只写
  digest 与 `latest-digest.txt`，raw 与 `latest.txt` 仅在显式开启时落盘，跳过时记一行
  `raw-skipped` 日志。Web 设置面板「接力摘要」组因此从 14 项增至 15 项。
- **交接声明块只声明真实存在的文件**。默认（无 raw）时只给摘要路径，让 agent 先读摘要、
  需要细节去会话日志检索，而不是指向一份并不存在的原文。

### 修复

- **epoch 序号在只写 digest 时不再重来**。`nextEpoch()` 原只扫 `*.raw.md`，关掉 raw 后每次都从
  1 开始，会**覆盖上一份摘要**并让「继承上一次摘要」失效。现在同时扫 `*.digest.md`。

## [0.3.9] - 2026-09-12

### 修复

- **真正的 stderr 失败不再从「报错与修复」里消失**。工具把捕获到的输出包在标记里：
  `[stderr]` / `bash: line 1: ps: command not found` / `[exit code: 127]`，而这类结果
  `isError` 是 **false**。抽取器只取「第一个非空行」，于是取到 `[stderr]` —— 它不含任何错误词、
  也不匹配任何信号，**所有 stderr 失败都读不到**。容器实测 `ps aux` 失败后该节渲染成「（无）」。
  现在 `resultFirstLines` 跳过 `[stdout]`/`[stderr]`/`[exit code: N]` 这类流标记，取第一条有内容
  的行。（0.3.8 未部署到任何 profile，其内容并入本版。）

## [0.3.8] - 2026-09-12

### 变更

- **交接声明块不再把原文归档说成「可以读」的东西**。此前它写「完整原文归档（需要细节时再读）」，
  读起来像邀请 —— 而原文归档是**那段历史的完整记录**：实测 401 条消息 → 286 KB / ≈64k tokens，
  约等于被压缩掉那段的 59%。整份读进来会把压缩刚腾出的上下文又填满，与「0 token 摘要」的目的相反。
  现在两个文件都**带体积**（摘要约 N tokens；原文归档约 N KB / ≈Nk tokens），并明确
  「**按需检索用，不要整份读入**……请先 grep 定位，再局部 read 那几段」。
  `Artifacts` 因此多带 `rawBytes`，`ResumeFacts` 多带 `rawBytes`/`digestTokens`。

### 修复

- **「报错与修复」不再把 prose 当报错**。判据原为「块 `isError` 或首行命中错误词」，于是一条
  `echo '=== 该错误是否历史就有（上次重启/更早）==='` 的**成功**调用被记成报错（只因文本里有「错误」）。
  现在非 error 的块还须具备**诊断形态** `^\S{1,32}:\s*\S` —— 真正的诊断长这样（`sh: 1: ps: not found`、
  `Error: tool call aborted`），横幅以标点开头、不匹配。
- **同一段文本不再渲染两次**。「当前进展」原样复述最后一条用户请求，而它已经是「主要意图」的末项 ——
  实测 478 token 的 digest 里同一段 160 字符出现两遍，且**正是这个重复**把 digest 顶过了档位下限
  （修掉之后同一 fixture 的 full 档从 ~300 降到 ~216 tokens）。现在「当前进展」只取最后一条 assistant
  文本的前三个非空行（回答「进展到哪」），「下一步」取待办**首项**、「未完成待办」列其余项
  （此前「下一步」是待办末项的复制）。
- **「关键技术概念」去掉噪声**：shell 内建与导航词（`cd`/`ls`/`cat`/`echo`…）不再进入概念，
  文档类扩展名（`md`/`txt`/`log`/`lock`…）不再当作技术；`git`/`docker` 这类真技术词与
  `ts` 这类代码扩展名照旧保留。

## [0.3.7] - 2026-09-12

### 修复

- **归档文档不再写进控制字节，Web 预览不再拒绝整份文件**。0.3.6 的 raw 归档逐字复制消息与工具结果
  文本，而工具结果里**合法地**带着控制字节：打印 `/proc/<pid>/cmdline` 的命令会输出 NUL 分隔符，
  多数 CLI 又用 ANSI 颜色包裹输出。只要有**一个 NUL**，阅读路径就整体失败：
  - `@deepseek-ai/dsh-fs-local` 对「前 8192 字节含 NUL」直接判为二进制（`FS_NOT_TEXT`, binary file）；
  - `@deepseek-ai/dsh-api-workspace-files` 更严，对**返回页整段**再查一次 NUL，抛
    `workspace-file/not-text`，Web 侧文档预览把它渲染成「**非文本文件，暂时无法预览。**」
    —— 于是最需要打开的那份交接文档，反而一个字都看不到。
  现在所有归档写盘都过 `writeAtomic` → `sanitizeDocText()`：剥掉 ANSI 转义序列、把 CRLF/CR 归一成
  LF、把 NUL 渲染成可见的 `␀`、丢掉其余 C0 与 DEL（保留 `\t`/`\n`）。规则收在写盘器这一处，所以
  「归档不可能带 NUL」是**写入方的性质**，不再依赖每个渲染器各自记得。

### 变更

- 归档文档的**文本卫生是有损的、且已界定**：只影响控制字节与转义序列，正文一字不动；**逐字节的原始
  记录仍是会话日志**（`sessions/<id>/session.v3.jsonl.zstd`）。这条写进了 `docs/gotchas.md`。

## [0.3.6] - 2026-09-12

### 变更

- **旁挂归档改为同步堵塞写盘：压缩生效的那一刻，文件已经在盘上**。0.3.5 的旁挂写盘是
  fire-and-forget（在 `compaction/summary` 的监听器里 `void` 掉一个 promise），于是「归档先于替换」
  只是**通常**成立：`session/event` 是 cordis `emit`（同步分发、**不 await** 监听器返回值），替换消息
  紧跟在同一轮 append 里，写盘 I/O 完全可能落在替换之后。现在整条写盘链（`writeArchive` →
  `writeAtomic`/`nextEpoch`/`readCarried`）都是同步 I/O，并且就在监听器里跑完 —— 监听器是同步调用的，
  所以 `append('compaction/summary')` 返回时文件已经落盘，**严格早于**后端追加的替换消息。
  为什么必须这样：`emit` 的监听器**无法**选择被等待（分发模式属于事件，不属于监听器），
  `session/flush` 又发生在 `compaction/end` 之后 —— 都晚于替换。同步是唯一不碰 dsh 核心就能做到
  「先落盘、再覆盖」的手段。
  - 代价（知情接受）：调用方每次压缩多等几毫秒同步 I/O；归档盘卡住时会**拖住**压缩调用方，而不再是
    「丢一份归档、压缩照常」。写盘仍是 tmp + `rename`，不会留半截文件。
- **续跑提示新增交接文档声明块 `{{archive}}`**，并删掉无条件的「历史已确定性归档」。渲染前守卫已在
  文件系统上确认过，所以有文件时就**陈述事实**：文档在哪、建议先读 digest、需要细节再读 raw，
  并明确写「不要求通读，但请知道它在那里，需要时可直接 read」；没有文件时如实写
  「本次压缩没有生成归档文档；上面那段摘要就是本次压缩的全部交接内容」。
  - 这个块的用途是**上下文传递**：让续跑的 agent 知道上一段历史有归档可查，而不是让它去核查文件
    是否存在（守卫已经查过，让它再查一遍是白费一步）。
  - L3（`resumeMaxPerWindow` 达到、不唤醒）的通知里也带同一段声明。
  - 记录的写盘结果不再是「在途 promise」：`archiveRecords` 直接存 `Artifacts`，渲染时同步读取。
- 收尾语义收进内置默认续跑模板：`上下文已压缩。\n{{archive}}\n然后继续执行压缩前正在进行的任务…`。

### 测试

- 新增时序回归用例（`side-car archiving … > lands the archive before the replacing message is
  dispatched`）：在替换消息（`surfaceOp: {op:'replace'}`）派发的**那一刻**同步读盘，断言
  `epoch-1.raw.md`/`epoch-1.digest.md` 已经存在。把写盘改回延迟（`queueMicrotask`）该用例即失败 ——
  这是「文件先于替换」唯一可自动验证的形式。
- 新增 `archiveClause` 金样例（两条路径 / 只有 digest / 一无所获 / 进入默认模板 / L3 通知）。

## [0.3.5] - 2026-09-12

### 新增

- **旁挂式归档：不接管压缩，也能拿到 raw + digest**。此前「确定性归档」只在会话把 preset 的
  `compaction` 行换成插件自带 `ArchiveCutEngine` 时才发生；线上 `standard` preset 走
  `compaction-basic`（模型摘要），于是这些会话的 `.handoff/sessions/` 一直是空的（0.3.3 记录了
  这个「归档空转」）。现在守卫自己监听 `compaction/summary`：
  - **别的引擎压缩时**（`provider !== 'context-guard'`）—— 按 `shadowedSeqs` 把被遮蔽的区间从会话
    日志取回（`session.eventAt` + `deriveEventMessage`），用同一格式补写
    `epoch-<N>.raw.md` + `epoch-<N>.digest.md` 与两个 `latest*` 指针（**旁挂**）；
  - **本插件引擎压缩时** —— 跳过：它已在 `summarize()` 里写完，且写盘先于覆盖。

  **模型看到的 checkpoint 完全由 dsh 自己的压缩机决定**：不覆写 `summarize()`、不改压缩事务、
  不动 dsh 放进上下文的替换消息。直接收益是**零 preset 改动** —— `standard` preset 的 web 会话，
  以及手动 `/compact`，现在都有归档与 digest。
- 写盘逻辑抽成模块级 `writeArchive()`（新 `src/archive.ts`）：`ArchiveCutEngine` 与守卫共用同一份
  实现，且**不把 `@deepseek-ai/dsh-compaction-basic` 的运行时类拖进 host 半边**（实测 `lib/index.mjs`
  与其共享 chunk 没有任何 dsh 运行时 import，那一串只出现在注释里）。`writeArchive` 新增 `minEpoch`：
  调用方若已知本会话压缩总数（守卫）可以钉住序号，扫描结果更高时以扫描为准，**任何情况下不重号**。
- 续跑提示改走**记录优先**：守卫按 `compactionId → {rawPath, digestPath}` 记住自己写的文件
  （值是在途 promise，续跑渲染时 `await`，避免「写盘比续跑慢」抢跑；**0.3.6 起写盘同步完成，
  该记录直接存 `Artifacts`，不再有在途态**）。`compaction-basic` 的
  checkpoint 是模型摘要、没有帧标记，这条记录是它唯一可信的路径来源；`FRAME_MARKER` 帧解析保留给
  自家引擎的指针帧。

### 变更

- `resolveDigestConfig(user, entry?)` 第二参数改为可选（守卫侧没有自己的引擎行）。
- 归档写入器的日志 scope 参数化：引擎写 `context-guard/digest:`，旁挂写 `context-guard/sidecar:`
  （事件名与字段一致，便于同口径 grep）。

### 已知取舍（知情接受）

- **落盘不保证先于覆盖**：`session/event` 是 cordis `emit`（同步分发、**不 await** 监听器），而
  `compaction/summary` 之后紧接（中间无 `await`）就是区间替换消息。进程恰好在该窗口被杀只丢这一份
  归档，checkpoint 不受影响（模型摘要照旧）；写盘一律 tmp + `rename`，不会留半截文件。
  （**0.3.6 已废止此条**：写盘改为同步堵塞，落盘严格先于替换。）
- **路径只能靠续跑提示进上下文**：关掉 `resumeAfterCompact`、agent 非空闲、或下一次压缩裁掉那条
  消息时，模型看不到路径（文件仍在磁盘上）。
- 只归档 `compaction/summary`；模型无关的 `compaction/prune` 不写归档（无摘要区间，混入同一套
  `epoch-N` 编号会让 digest 与序号错位）。
- 会话无 `cwd` 时不写（`.handoff` 会相对宿主进程工作目录解析），记一行 `sidecar: skipped reason=no-cwd`。

## [0.3.4] - 2026-09-12

### 变更

- **收尾接力笔记也按会话分目录，标题带压缩序号**：原先收尾提示词只让 agent「写入工作区 `.handoff/`
  目录下的一个 md 文件，文件名自定」——于是每个越阈值的会话都在 `.handoff/` 根下留一份
  `<日期>-<主题>.md`，与会话无关、也排不进压缩序号。现在提示词里的 `{{notePath}}` 由守卫算出
  （`<归档基线>/sessions/<完整会话id>/epoch-<N>.handoff.md`，`N` = 本会话第 N 次压缩，即即将发生的那次），
  并要求文件**首行标题**写成 `# 第 N 次压缩 · 接力笔记 · <一句话主题>`；同一会话的笔记与
  `raw`/`digest` 归档同目录、同前缀。
  - 收尾模板新增 `{{notePath}}` / `{{epoch}}`（原 `{{todos}}` 不变）；L2 的「停下并报告」也改为写会话目录。
  - 守卫**不创建目录**：`write` 工具自建父目录，空目录因此仍等于「这个会话从未归档」。
  - 既有 12 份根目录笔记不迁移（无法逐个确证会话 id）。

## [0.3.3] - 2026-09-12

### 修复

- **续跑提示可能指向不存在的归档文件**：`{{digest}}`/`{{raw}}` 的路径原先从「压缩帧」里正则抓取
  反引号内的 `*.digest.md` / `*.raw.md`。只有本插件的 `ArchiveCutEngine` 返回的是**路径清单帧**；
  其他引擎（如 `standard` preset 的 `compaction-basic`）的帧是**模型写的摘要**，正文里什么都可能出现。
  线上实测（会话 `session-30535614…`，11:20 手动压缩）摘要抄了 `docs/digest-format.md` 的占位符与磁盘
  现状，于是续跑提示注入了并不存在的 `` `epoch-N.digest.md` `` 与**别的会话**的 `epoch-299.raw.md`，
  而该会话根本没有归档（`.handoff/sessions/` 未生成）。现在三道闸门：
  1. **帧归属**：帧首 `FRAME_MARKER` 标记，非本引擎的帧一律不认（也不做指针兜底探测）；
  2. **只收绝对路径**：裸文件名是「提及」不是「指向」；
  3. **落盘确认**：路径必须是真实文件，否则模板退回「（本次未生成摘要文件 / 归档文件）」。

  对普通 web 会话（`standard` preset）的直接效果：续跑提示不再谎称「已确定性归档」，也不再让续跑的
  agent 去 `read` 一个不存在的文件。

## [0.3.2] - 2026-09-12

### 修复

- **窄屏（手机）设置面板布局**：设置分节的成对字段原本写死两列，手机 WebView 里每格只剩约 180px，导致标签折成两三行、`计价方式`/`归档布局` 两个下拉被截断、说明文字挤成窄条。
  - 成对字段改用 `flex-wrap` + `flex:1 1 200px`：容器够宽时自动两列，容器变窄时自动落成一列。这是内禀布局，**不依赖视口宽度**，所以在「宽视口 + 窄内容区」的宿主壳里同样成立。
  - 供应商阈值行与整体仍保留 `@media (max-width:640px)` 单列兜底。
  - 补 `min-width:0` 守卫与 `.cg-check` 文本 `flex:1 1 auto`，说明文字 `overflow-wrap:anywhere`，消除横向溢出。
- 桌面观感不变（设置弹窗内容区 564px 时仍两列）。

### 验证

- 容器测试台（dsh `0.1.5-rc.2-local.4` + `@feiyueve/dsh-mobile` 0.3.28）真实浏览器四场景：手机满宽内容区（294px，单列、下拉不截断、无溢出）、手机端专用前端（106px，单列、无溢出）、宽视口 + 360px 窄容器（单列，证明不靠视口判断）、桌面 1600px（仍两列、下拉不截断）。

## [0.3.1] - 2026-09-12

### 兼容性

- 声明兼容 dsh `0.1.5-rc.2-local.4`（与上游基线 `0.1.5-rc.2` 相同，仅本地补丁号 +1，上游兼容面未变）。
- 7 个 `@deepseek-ai/dsh-*` 依赖（`dsh-agent` / `dsh-compaction` / `dsh-compaction-basic` / `dsh-llm` / `dsh-session` / `dsh-token-meter` / `dsh-settings`）的 `peerDependencies` 列表末尾追加 `|| 0.1.5-rc.2-local.4`，保持显式列表风格。

### 说明

- **本版是 0.3 系列首次上线**：`0.3.0` **从未发布**到私源（该号段作废，registry 上不存在这个版本），其规划的全部特性由 `0.3.1` 首次交付。若在 registry 上找不到 `0.3.0`，属预期，不是漏发。
- 兼容性验证口径：本仓库无 `scripts/check-dsh-compatibility.mjs`；以「链接场实测版本对账」代替 —— `node_modules/@deepseek-ai/*`（经 `pnpm-workspace.yaml` 的 `overrides` link 到 `../deepseek-harness/` 源码）7 个包实际版本均为 `0.1.5-rc.2-local.4`，且逐条落在新声明的 `peerDependencies` 范围内（全部 `OK`）。

### 新增（原 0.3.0 规划内容，随本版首次发布）

- **确定性接力摘要（digest）**：压缩时不再只有一份无损归档，而是「无损 raw + 零模型调用抽取的事实摘要 digest」两份产物；逐字节可复现，剔除宿主每轮重发的注入上下文，跨次继承有效小节（不跨会话、版本不符则放弃继承）。格式契约见 `docs/digest-format.md`。
- **分级续跑 L0–L3**：按窗口内自动压缩次数渲染续跑提示 —— 2 次 → L1（增量推进）、≥3 次 → L2（先拆分；仅当会话请求头确实带 `subagent`/`subagent_fork`/`workflow`/`ralph` 时才点名委派）、≥ `resumeMaxPerWindow` → L3 只排队不唤醒（与分级开关无关，始终生效）。窗口内出现新的人类消息重置计数。
- **分会话归档布局**：落点为 `<archiveDir|cwd>/.handoff/sessions/<完整会话id>/` 下的 `epoch-N.raw.md` + `epoch-N.digest.md` + `latest.txt` + `latest-digest.txt`；目录名清洗后发生变更时附 sha256 短摘要，避免两个会话 id 撞同一目录（`archiveLayout: 'flat'` 保留旧行为）。
- **Web 设置面板**：「上下文守卫」分节三组共 14 项写入 `context-guard` settings 命名空间，host 实时 `watch`，保存即生效（提示词留空 = 关闭该注入）。

## 更早版本（私源已发布，仓库内无独立条目）

| 版本 | 要点 |
|---|---|
| `0.1.0` | 首个版本（2026-08-29）：`typecheck` + 12 例 vitest + 构建通过，含 Web 设置面板 |
| `0.2.1` | 发到私源（2026-09-01） |
| `0.2.2` | 在 web/staging profile 实跑验证 |
| `0.2.4` | 补 `dsh-compaction-basic` 的 workspace override；适配 `assertSystemHeadRewrite` 不变量与 agentLoop 异步化（2026-09-11，`npm run verify` 退出 0） |
| `0.2.5` | 私源有此号，仓库内无对应记录（历史件） |
| `0.2.6` | 客户端 bundle 的 `__ModuleLoader__.load` id 改为 scoped 包名（client-modules 要求与包名一致），随 dsh `0.1.5-rc.2-local.3` 发版（2026-09-11） |
| ~~`0.3.0`~~ | **未发布，号段作废** —— 特性由 `0.3.1` 首次交付 |
