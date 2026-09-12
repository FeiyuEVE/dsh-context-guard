# 接力摘要（digest）格式契约 / Digest Format Contract

> 本文件是 `src/digest.ts` 产出文档的**格式契约**。读它的是三类消费者：下一次压缩的
> carry-forward（`carriedFrom`）、host 侧的续跑提示、以及被唤醒后按路径 `read` 这个文件的
> agent。任何一条被下面标为「契约」的规则改动，都必须同时 bump
> `DIGEST_FORMAT_VERSION`（`src/digest.ts`），否则旧文档会被新代码误读。

## 1. 为什么有第二个文件

被裁区间可以被**逐字**导成 `epoch-N.raw.md`（由共用写盘器 `src/archive.ts` 产出，默认走守卫的
旁挂路径，见 §7）。那个文件很贵：本工作区一个真实 epoch 实测 ≈286 KB ≈ **64k tokens**（401 条
消息 / 204 次工具调用，工具结果占 65.6%），与被压缩掉的区间同量级，整份读回来等于把刚腾出的
空间又填满。所以：

- **默认只写 digest**（`writeRawArchive: false`，0.4.0 起）；
- 显式开启 `writeRawArchive` 时，每次压缩写**两份**产物：

| 文件 | 性质 | 谁读 | 典型体量 |
|---|---|---|---|
| `epoch-N.digest.md` | **确定性事实清单**（不调用模型） | 续跑后**第一份**要读的文档 | ≤ 800 tokens（默认） |
| `epoch-N.raw.md` | 逐字全文（逐角色逐块），**按需开启** | 需要精确原文时先 `grep` 再局部 `read` | ~286 KB / ≈64k tokens |

digest 不是「模型写的摘要」，它是**纯代码抽取的事实列表**：意图原文、涉及文件与读写次数、报错行、
待办、重复调用。设计上它不试图理解内容，因此零模型调用、零 token 成本、逐字节可复现 —— 这才是
「0 token 摘要」。raw 只是被裁区间的重录，**不是摘要**。

压缩帧（进入上下文的那几句）**只带路径**，不带 digest 正文 —— digest 是「按需读」的文档，
不是「提前塞进上下文」的内容。见 §7 的预算口径。

## 2. 落点

基线目录（`archiveDir` 配置，空则 `<会话 cwd>/.handoff`）之下，按会话分目录：

```
<base>/
  sessions/
    <session-dir>/            ← 目录名由 paths.ts:sessionDirName(Session.id) 推导
      epoch-1.digest.md       ← 默认产物
      epoch-2.digest.md
      latest-digest.txt       ← 「最新 digest 的绝对路径」，一行
      epoch-1.raw.md          ← 仅在 writeRawArchive 开启时
      latest.txt              ← 「最新 raw 的绝对路径」，一行（同上）
```

- `sessionDirName()`：字符白名单 `[A-Za-z0-9._-]`，越界字符替 `_`；可读部分截断到 128 字符；
  空/`.`/`..` → `session`。**只要规范化改变了原 id**，追加 `-<sha256(原id)[0..8]>`，保证两个
  不同 id 永不映射到同一目录（也保证 `Session.id` 含 `/` 或 `..` 时不会越目录写）。
- 目录名用**完整会话 id**（非短前缀）：短前缀会撞名，而撞名即丢档。
- epoch 号在**本会话目录内**递增（`^<epochPrefix>-\d+\.(?:raw|digest)\.md$` 的最大值 +1），语义是
  「本会话的第 N 次压缩」。`epochPrefix` 默认 `epoch`。**正则必须同时覆盖两种后缀**：只扫 `*.raw.md`
  会在关闭 raw 时让序号每次从 1 重来，覆盖上一份 digest 并让 carry-forward 失效。
- **写法**：每个文件 tmp + `rename` 原子落盘；开启 raw 时顺序 raw → `latest.txt` → digest →
  `latest-digest.txt`，默认只走 digest → `latest-digest.txt`；指针最后移动。读者永不会在
  「指针已更新」时看到一个半截文档。
- `archiveLayout: 'flat'` 保留为兼容模式：直接写 `<base>/`，无 `sessions/` 层、无会话隔离，
  epoch 号与其他会话共享。**默认 `session`**；299 份历史 flat 归档不迁移（见 §9）。

## 3. 文档结构

```
<!-- context-guard-digest v1 -->                ← 第 1 行，契约：标记 + 版本
# 接力摘要（会话 <sessionId> · 第 <N> 次压缩）

- 会话: <sessionId>                              ← 契约：carry-forward 用它判归属
- 第几次: <N>                                    ← 契约：carry-forward 用它填「继承」来源
- 原始档: <raw 绝对路径>          ← 仅在本次写了 raw 时出现（writeRawArchive）
- 截断区间: <消息数> 条消息 / <工具调用数> 次工具调用（≈<regionTokens> tokens）
- 继承: 无 | 第 <M> 次
- 摘要正文: ≈<tokens> tokens（确定性抽取，未调用模型）

## 主要意图
- <用户请求原文，clip 到 160 字符>

## 关键技术概念
- <扩展名 / 命令词>

## 涉及文件
- <绝对或相对路径> — W×<写次数> R×<读次数>

## 报错与修复
- <工具名>: <报错行>

## 未完成待办
- <待办项>（除首项外；首项已作为「下一步」）

## 当前进展
- <最后一条 assistant 文本的前三个非空行>

## 下一步
- <待办首项> | （无）

## 压缩说明
- <工具名>(<参数摘要>) 重复执行 <k> 次 —— 同参数调用，仅保留最近一次结果
- 本段由 dsh-context-guard 确定性压缩（<N> 条消息 / <M> 次工具调用，未调用模型摘要）
```

**契约点**（改变即 bump 版本）：

1. 第 1 行是且只是 `<!-- context-guard-digest v<整数> -->`；`parseDigest()` 用它判定「这是一个
   digest」并读出 `version`。缺标记 → 直接判为非 digest。
2. header 里 `- 会话: ` 与 `- 第几次: ` 两行是**机器读**的：carry-forward 用前者拒绝继承别的
   会话的摘要，用后者填 `- 继承:`；续跑侧用它报告 epoch。
3. 小节标题格式固定为 `## <标题>`，标题集合与渲染顺序见 §4。
4. 小节条目一律是 `- ` 开头的单行；用换行分隔，不嵌套子列表。
5. 八个标题之外不再出现 `## `。

## 4. 小节语义与抽取口径

八个标题（`DIGEST_SECTIONS`）固定为中文，顺序即渲染顺序：

| 标题 | 来源 | 抽取规则 |
|---|---|---|
| `主要意图` | 区间内**非注入**的 user 消息 | 原文 clip 到 `itemChars`；plugin notice 取 `source.summary` 而非正文 |
| `关键技术概念` | 路径扩展名 + 命令词 | `/\.([a-z0-9]{1,5})$/`；`COMMAND_CONCEPTS` 词表（git/npm/docker/…）+ 命令首词 |
| `涉及文件` | 工具调用参数 | 键 `file_path`/`absolute_path`/`path`/`glob`/`pattern` 等；`WRITE_TOOL` 命中的工具记 `W×`，否则 `R×` |
| `报错与修复` | tool-result 块 | 块 `isError` 为真，**或**（**首个非流标记行**命中 `ERROR_LINE`（中英双语）**且**该行具备诊断形态 `^\S{1,32}:\s*\S`）；取所在工具调用名。`[stdout]`/`[stderr]`/`[exit code: N]` 是包装标记、先跳过 |
| `未完成待办` | `todo_write` 结构化参数优先，其次自由文本 | 结构化：`todos[].status !== 'completed'`；文本：`- [ ] ` 未勾选行 + `TODO:/FIXME:/待办:` 行。**渲染时去掉首项**（首项在「下一步」） |
| `当前进展` | 区间末 | 最后一条 assistant 文本的前三个非空行。**不再复述最后一条用户请求**——它已经是「主要意图」的末项 |
| `下一步` | 待办首项 | 无待办则 `（无）` |
| `压缩说明` | 重复调用统计 + 固定尾行 | 同 `(工具名, 原始参数)` 出现 ≥2 次即列出；固定行永远渲染（`dropEmpty: false`） |

抽取的硬规则：

- **注入上下文一律丢弃**（`isInjectedContext()`）：`agent-instructions`/`skill-catalog`/`system`
  三类 source，以及 plugin source 中 `context-guard`/`dsh-context-guard`/`compact` 或
  form 为 `snapshot`/`instructions`/`catalog`/`notice` 的消息。理由：这些内容 host 每次请求都会
  重发，模型不可能丢，写进 digest 是纯浪费 —— 实测它们占了 raw 归档的**大部分**体积。
- **去重**：`dedupKey()` 做大小写与标点归一（保留字母数字、`/`、汉字）；先出现者胜。
- **截断标记**：条目超过 `sectionCap` 时保留**最新**的 `cap-1` 条，并在首行插入
  `（省略 <k> 条较早的条目）`。
- **无时钟**：不写时间戳、不读系统时间。相同输入必得逐字节相同输出（golden 测试的前提）。

## 5. 预算与降级梯度

预算（`targetTokens`）是**读取成本**上界，不是上下文上界：

```
targetTokens = max(260, min(digestMaxTokens, regionTokens × digestTargetRatio))
```

- 默认 `digestMaxTokens = 800`、`digestTargetRatio = 0.45`。
- 下限 260（`MIN_TARGET_TOKENS`）是**故意**的：header 自身约 100 tokens 的固定成本，更低的下限
  任何正文都满足不了，预算断言就成了假话。digest 比小区间还大**不额外占用上下文**（只有短帧进
  上下文），所以下限宁大勿小。
- 计价器（`digestTokenEstimator`）：`cjk`（默认）把 CJK 记 ~2 字符/token、ASCII 记 4 —— host
  meter 一律按 4 计价，对中文低估约 2 倍；`ascii` 则与 host meter 完全一致。

梯度（从宽到紧，第一个满足预算的胜出）：

| tier | `sectionCap` | `itemChars` | `dropEmpty` | 说明 |
|---|---|---|---|---|
| `full` | 6 | 160 | 否 | 空小节渲染 `（无）` |
| `section3` | 3 | 80 | 是 | 开始丢空小节 |
| `section2` | 2 | 60 | 是 | |
| `terse` | — | — | — | 单块：固定行 + 请求/文件/报错/下一步各一行 |
| `hard-cut` | — | — | — | `terse` 仍超预算时按字符硬截（`max(240, target*3)` 字符） |

选中的 tier 记入日志（`context-guard/digest: written … tier=…`）与 header 之外不落文档正文，
便于事后判断「这次摘要为什么这么短」。

## 6. 继承（carry-forward）

`digestCarryForward`（默认开）时，新 digest 继承上一次 digest 的**部分**小节，否则会话更早的历史
会在第二次压缩时消失（「摘要的摘要」问题）。

- 继承集（`CARRIED_SECTIONS`）：`主要意图`、`关键技术概念`、`涉及文件`、`报错与修复`、`压缩说明`。
  **不继承** `未完成待办`/`当前进展`/`下一步` —— 这三者必须是本区间的新鲜事实。
- 来源优先级：① 本会话目录的 `latest-digest.txt` 指针（精确且便宜）；② 区间文本里被引用到的
  `*.digest.md` 路径（上一帧带着它）—— 覆盖首次压缩、fork、文件被删等情况。
- **绝不跨会话继承**：读到候选文档的 `- 会话:` 与当前 session id 不符 → 记
  `carry-forward-skipped reason=other-session` 并继续试下一个候选。
- **版本不符则不继承**：`parseDigest()` 无标记、或 `version !== DIGEST_FORMAT_VERSION` → 记
  `carry-forward-skipped reason=unparsable|version-N-expected-M`，按「无继承」继续。宁可丢继承，
  不可误读旧结构。
- 文件级去重：本区间新出现的路径会顶掉继承来的同路径条目（比较 `— ` 之前的部分）。

## 7. 进上下文的只有帧或续跑提示，不是本文档

同一份 digest 由两条路产出（共用 `src/archive.ts` 的 `writeArchive()`，格式完全相同）：

- **接管模式**（可选）：`ArchiveCutEngine.frameText`（见 `src/compaction.ts`）产出的 checkpoint
  帧就是路径清单，形如：

```
本段历史已由 dsh-context-guard 确定性归档（未调用模型摘要请求）。
- 精简接力摘要：`<digest 绝对路径>`
- 完整归档：`<raw 绝对路径>`                      ← 仅在 writeRawArchive 开启时
- 线索：「<最多 60 字的首条意图/末条待办>」        ← 仅当 regionTokens ≥ 600
需要细节时用 read 工具按需读取该文件恢复状态，不要在上下文中复述。
请直接继续执行截断前正在进行的任务。
```

- **旁挂模式**（默认）：checkpoint 是原压缩机的产物（如 `compaction-basic` 的模型摘要），不含路径；
  路径改由**续跑提示**给出，来源是守卫按 `compactionId` 存的写盘记录（本文件不规定提示词文本，
  见 `src/resume-prompt.ts` 的 `archiveClause`）。该模板片段（`{{archive}}`）**陈述文档存在与位置**
  （「不要求通读，但请知道它在那里，需要时可直接 read」），不要求 agent 去核查文件 —— 守卫渲染前
  已经落盘确认过。

**写盘时序是格式契约的一部分**：旁挂写盘在 `compaction/summary` 的监听器里**同步**跑完，所以后端
追加替换消息（区间离开模型视野）时，本文件的 digest（以及开启时的 raw）已经在盘上；两条路（接管 / 旁挂）现在
都满足「归档先于覆盖」。改 `src/archive.ts` 时不要把同步 I/O 换成 promise —— 详见
`docs/gotchas.md`「旁挂归档必须同步落盘」。

**帧必须瘦**：基类（`compaction-basic`）强制「摘要必须小于被替换内容」的收缩不变量，帧写胖了会
在小区间上直接让压缩失败（`summary is not smaller than the shadowed content`）。所以 `- 线索：`
只在 `regionTokens ≥ 600`（`HEADLINE_MIN_REGION_TOKENS`）时出现 —— 大区间读回原文很贵，省这一趟
值 ~20 tokens；小区间省不下，就不加。**改帧文本必须重跑 `tests/archive-cut.spec.ts` 的两个手动压缩
用例**（它们正是这条不变量的回归门禁）。

## 8. 版本与兼容规则

- `DIGEST_FORMAT_VERSION`（当前 `1`）与首行标记中的版本号必须一致，二者由同一个常量渲染。
- **bump 的时机**：任何会让旧文档被新读者误读的改动 —— 新增/删除/改名小节、改变 `- 会话:` /
  `- 第几次:` 行格式、改变条目必须 `- ` 开头、改变预算口径到影响解析。纯粹改渲染细节（文案、
  阈值）不必 bump。
- bump 的后果是**安全的**：旧 digest 不再被继承（记 warn），新旧文档各自可读，历史归档不迁移。
- 解析失败永不上抛：`parseDigest` 返回 `undefined`，`carriedFrom` 返回空 Map。

## 9. 已知边界

- **旧 flat 归档不迁移**：`.handoff/` 根下 299 份 `epoch-*.raw.md`（约 31 KB/份）与根
  `latest.txt` 保持原样，新版不再写根指针。它们按会话无法归属，且大部分体积是重复注入的
  agent-instructions/AGENTS.md。
- **digest 含用户文本与路径**：因此父仓库 `.gitignore` 必须 ignore `.handoff/sessions/`（与既有的
  `.handoff/epoch-*.raw.md`、`.handoff/latest.txt` 同级）。
- **`archiveLayout: 'flat'`** 与 `session` 混用会让 `latest-digest.txt` 出现两个候选位置；host 侧
  `digestPointerCandidates()` 两个都探测（存在性检查便宜，落空无害），引擎自己的帧里带的路径才是
  权威。
- **单文件未做并发锁**：同一会话的并发压缩由 guard 的 `compacting` 标记挡住；`session` 布局把不同
  会话的写入空间分开，避免 flat 布局下 `readdir → max+1 → write` 的竞态覆盖。
