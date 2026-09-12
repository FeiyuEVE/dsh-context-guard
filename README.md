# dsh-context-guard

DeepSeek Harness 上下文压力守卫插件：监控会话上下文占用，超过阈值时提醒 agent 收尾、空闲时自动压缩、压缩后写一份**确定性接力摘要**并按压缩频率分级续跑任务。

Context-pressure guard plugin for DeepSeek Harness: watches session context usage, reminds the agent to wrap up above a threshold, compacts over-threshold idle sessions, writes a deterministic relay digest for each compaction, and resumes the task at a level that escalates with compaction frequency.

## 设置面板（Web UI）/ Settings UI

浏览器端 `settings.section`「**上下文守卫**」，三组共 14 项，保存即生效（host 侧实时 `watch`
`context-guard` settings 命名空间）。更新是**稀疏 patch**（只发本面板拥有的字段），不会碰其他插件
的键。

1. **压缩阈值** —— 默认阈值（tokens）+ 按供应商覆盖的阈值表（供应商列表取自 `remote.llm.listProviders()`；
   `llm` remote 不可用时降级为手输）。
2. **接力摘要** —— 生成开关、大小上限、预算比例、跨次继承、计价方式、归档是否剔除宿主重发注入、归档布局。
3. **续跑与收尾** —— 分级开关、统计窗口、窗口内上限，以及**两段可编辑提示词**（各带「填入默认」，
   把组合层 `base` 的文本填回输入框；留空 = 关闭该注入）。

字段语义见 §[设置项](#设置项--settings)。设置优先级处处一致：

```
settings 用户层  >  组合配置（cordis.patch.yml 的 config）  >  内置默认值
```

## 功能 / Features

每会话一个闭环，由四个事件触发（各自有开关）：

1. **hook `step/end`** —— 步骤结束时评估会话上下文（`tokenMeter` 测量 / 路由模型的 `contextWindow`）。
   超过阈值、且该步骤仍欠模型一次请求（assistant 消息带工具调用）时，把「尽快收尾」提醒折叠进
   下一步的进入消息，agent 看到后收尾并停轮；同一超阈值周期只提醒一次。
2. **hook `agent/status` idle** —— agent 停下后再次评估；仍超阈值则执行
   `compaction.compactNow()`（引擎解析见 §[容错设计](#容错设计)），每个超阈值周期只压缩一次
   （防止压缩-续跑死循环）。
3. **hook `compaction/end`** —— 压缩成功（无 `error`）且 agent 空闲时，**按压缩频率分级**渲染续跑
   提示并 `followup()` 唤醒，在压缩后的表层上续跑。失败、agent 运行中、或频率超上限时按规则不唤醒。
4. **hook `compaction/summary`（旁挂归档）** —— 压缩由**别人**执行时（`standard` preset 的
   `compaction-basic`、手动 `/compact`），守卫把被遮蔽的区间取回来，按同一格式补写
   `epoch-N.raw.md` + `epoch-N.digest.md`。**模型看到的 checkpoint 完全由 dsh 自己的压缩机决定**，
   本插件只是往旁边加文件 —— 不覆写 `summarize()`、不改压缩事务。

### 归档与接力摘要

归档有**两条路**，产物格式相同、落点相同：

- **旁挂（默认，零配置）**：任何后端压缩时，守卫从 `compaction/summary` 事件拿到被遮蔽的区间，
  自己写 raw + digest。线上 `standard` preset 走 `compaction-basic`（模型摘要），压缩后模型看到的
  仍是那份模型摘要 —— 归档只是**旁边多出来的文件**。手动 `/compact` 同理。
- **接管（可选）**：把 preset 的 `compaction` 行换成插件自带的 `ArchiveCutEngine`（导出子路径
  `./compaction`）。它只覆写 `BasicCompactionEngine.summarize()` 这一个受支持的扩展点，**零模型调用**，
  checkpoint 本身就是「路径清单帧」。两种方式不会同时生效：`ArchiveCutEngine` 自己已经写完归档，
  守卫看到 `provider=context-guard` 会跳过。

产物：

```
<cwd>/.handoff/sessions/<会话id>/
  epoch-N.raw.md          无损全文归档（细节按需 read）
  epoch-N.digest.md       确定性事实摘要（续跑后第一份要读的文档）
  epoch-N.handoff.md      收尾接力笔记（**由 agent 按收尾提示词写**，不是引擎产物）
  latest.txt              → 最新 raw 的绝对路径
  latest-digest.txt       → 最新 digest 的绝对路径
```

- **接力笔记也按会话分目录**：收尾提示词里的 `{{notePath}}` 由守卫算出（`epoch-N.handoff.md`，
  `N` = 本会话第几次压缩，即将发生的那次），并要求文件**首行标题**写成
  `# 第 N 次压缩 · 接力笔记 · <主题>`。守卫只算路径、不写文件（`write` 工具会自建父目录），
  所以「`.handoff/sessions/` 不存在」仍然等于「这个会话从未归档」。

- **digest 是纯代码抽取的事实清单**（意图原文 / 文件读写次数 / 报错行 / 待办 / 重复调用），不调用
  模型、逐字节可复现；体积默认 ≤800 tokens，而一个真实 raw 归档约 30 KB ≈ 8k tokens —— 直接回读
  raw 几乎会抵掉压缩省下的量，所以让 agent 先读 digest。
- **跨次继承**：新 digest 继承上一次的意图/概念/文件/报错小节，避免第二段压缩丢掉更早的历史
  （「摘要的摘要」）。绝不跨会话继承，版本不符则放弃继承。
- **进入上下文的只有短帧**，不是 digest 正文：接管模式下，帧给路径 + 读取规则（`regionTokens ≥ 600`
  时另加一行 ≤60 字线索）；旁挂模式下 checkpoint 由别人的压缩机决定，路径通过**续跑提示**进入上下文
  （见下）。格式契约见 [`docs/digest-format.md`](docs/digest-format.md)。
- **旁挂模式的两点取舍**（已知、接受）：
  1. `session/event` 是 cordis 的 `emit`（同步分发、**不等待**监听器），而 `compaction/summary` 之后
     **紧接**（中间无 `await`）就是区间替换 —— 所以落盘不保证先于覆盖。进程恰好在该窗口被杀，只会
     丢这一份归档，`checkpoint` 不受影响（模型摘要照旧）；写盘一律 tmp + `rename`，不会留半截文件。
  2. 路径只能靠**续跑提示**进上下文：checkpoint 是别人的摘要，不会带我们的路径。关掉
     `resumeAfterCompact`、agent 非空闲、或下一次压缩裁掉那条消息时，模型看不到路径（文件仍在磁盘上）。

### 分级续跑

固定不变的续跑提示在短时间内第二次压缩后已被证明无效（agent 本来就一直在跑，要改的是工作方式）。
因此提示由**可测量事实**渲染（窗口内自动压缩次数、digest 路径、待办、会话请求头里实际存在的委派
工具）：

| 级别 | 触发 | 文本 |
|---|---|---|
| `L0` | 窗口内 ≤1 次（或关闭分级） | 基础模板（含 digest/raw 路径） |
| `L1` | 窗口内 =2 次 | 追加「改为增量推进：只读确需片段、结论写进 todo_write」 |
| `L2` | 窗口内 ≥3 次 | 追加「先拆分再继续」：会话**确实**带 `subagent`/`subagent_fork`/`workflow`/`ralph` 时点名委派，否则给「按需取片」方案 |
| `L3` | 窗口内 ≥`resumeMaxPerWindow`（默认 5） | **不唤醒**：只留一条 `next-turn` 提示（「本次不再自动续跑」），归档与摘要照常落盘 |

- 窗口默认 30 分钟，**窗口内出现新的人类消息会重新计数**（只统计 `sourceCommandId === undefined`
  的自动压缩，手动 `/compact` 不计入）。
- 委派工具只有在 `requestHeader().tools` 里**确实存在**时才会被点名，不会建议一个不存在的工具。
- L3 抑制**与 `resumeEscalation` 开关无关**，始终生效 —— 它是防「压缩—续跑空转」烧 token 的安全阀。

所有注入内容都是带插件 source（`{ kind: 'plugin', plugin: 'context-guard' }`）的 user 角色消息，
因此在会话日志里是持久的、可重建的（模型可见 ⟺ 已记录）。

## 安装 / Install

```sh
dsh plugin --profile web add /path/to/dsh-context-guard
```

bundle 采用 cost-meter 式单一 Loader 行（`cordis.patch.yml` 只 insert `context-guard` 一行），不干预
profile 的压缩后端配置。**默认可用的归档就是旁挂模式**：preset 完全不用改。想改成「接管」式
（checkpoint 直接变成路径清单帧、写盘先于覆盖），再把 preset 的 `compaction` 行指到
`@feiyueve/dsh-context-guard/compaction`（或用 `file:` 绝对路径引用 `lib/compaction.mjs`）。

### 容错设计

插件出错不影响 dsh 进程：

- `compaction` 是可选服务，按 agent 解析：先查 host 平面的提供方（`ctx.get`），否则经 `agentPresets`
  seam 读取该 agent 的 preset 在 `isolate` realm 中挂载的实例（标准/ptc/cordis preset 都把
  `compaction-basic` 放在 `isolate: { compaction: true }` 后面，host 光纤看不到，只能走 seam）。
  两层都没有时插件照常加载，hook 1 可用，hook 2/3 降级并记录一次警告，**不会 pending、不会阻塞启动**。
- 越界配置（如 `thresholdRatio: 2`）不抛错：记录 `error` 日志并回退 0.85。
- 归档写盘失败只 `warn` 不抛：帧降级为「无路径」或「只有 raw」，压缩本身照常成功。
- **续跑提示里的归档路径只在真有时才写**，两个来源按可信度排序：
  1. **守卫自己的记录** —— 旁挂归档写完时按 `compactionId → {rawPath, digestPath}` 记下（值是在途
     promise，续跑渲染时 `await`，因此不会被「写盘比续跑慢」抢跑）。这是 `compaction-basic` 会话
     唯一可用的来源，因为它的 checkpoint 里根本没有路径。
  2. **本引擎的确定性指针帧** —— 帧首必须带 `dsh-context-guard 确定性归档` 标记（外域摘要一律不认）。

  两个来源都会再落盘确认一次。所以会话不会被告知去读一个不存在的 digest；确实没有时，模板里的
  `{{digest}}`/`{{raw}}` 渲染成「本次未生成摘要文件 / 归档文件」。
- 所有监听器的运行期异常均被包含并记日志，任何情况下都不向外抛出。

## 配置 / Config

插件行（`cordis.patch.yml` 的 `context-guard`）字段：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `thresholdRatio` | number (0–1) | `0.85` | 回退阈值：settings 未配绝对阈值时按 `占用 / contextWindow` 触发 |
| `wrapUpPrompt` | string | 内置中文收尾提醒 | 收尾提示模板；空字符串禁用 hook 1 |
| `resumePrompt` | string | 内置中文续跑提示 | 续跑提示模板；空字符串禁用 hook 3 |
| `autoCompactOnIdle` | boolean | `true` | 空闲且超阈值时自动压缩（hook 2 开关） |
| `resumeAfterCompact` | boolean | `true` | 压缩成功后自动续跑（hook 3 开关） |
| `delegationTools` | string[] | `['subagent','subagent_fork','workflow','ralph']` | 视为「可委派」的工具名；只在与请求头求交后才会被 `L2` 点名 |

压缩引擎行（`ArchiveCutEngine`，即 `./compaction` 子路径）字段 = `compaction-basic` 的全部策略键
（`thresholdRatio`/`retainRatio`/`retainTokens`/`summarization*`/`maxTokens`/`compactionRetries`/
`maxOverflowRetries`/`modelPolicies`/`auto`，原样透传）**加上**本引擎自己的键：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `archiveDir` | string | `''` | 归档基线目录；空则 `<会话 cwd>/.handoff` |
| `epochPrefix` | string | `epoch` | 归档文件名前缀 |
| `digestEnabled` | boolean | `true` | 是否生成摘要文档 |
| `digestMaxTokens` | number | `800` | 摘要上限（估算 tokens） |
| `digestTargetRatio` | number (0.05–0.95) | `0.45` | 预算 = `min(上限, 区间 tokens × 比例)` |
| `digestCarryForward` | boolean | `true` | 继承上一次摘要的有效小节 |
| `digestTokenEstimator` | `cjk` \| `ascii` | `cjk` | 计价方式；`cjk` 中文按 ~2 字/token |
| `rawExcludeInjected` | boolean | `false` | 无损归档中也剔除宿主重发的注入内容 |
| `archiveLayout` | `session` \| `flat` | `session` | `flat` 为旧行为（平铺，无会话隔离） |

> 引擎行上这几个键是**中间优先层**：settings 用户层 > 引擎行 config > 内置默认。引擎行是否显式写了
> 任一归档键，会记入 `context-guard/digest: knobs source=settings|config|default` 日志。

示例：

```yaml
- id: context-guard
  config:
    thresholdRatio: 0.9
    wrapUpPrompt: 'Context is near the limit. Finish the current task now and stop.'
```

## 设置项 / Settings

`context-guard` 命名空间（`~/.dsh/settings.yaml` 顶层，web/staging 共享；无 profile 级覆盖文件）。
面板可改的全部字段：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `defaultThresholdTokens` | `0` | 未单独配置的供应商使用的绝对阈值；`0` = 未配置 |
| `providerThresholds[]` | `[]` | `{ provider, thresholdTokens }`，按路由覆盖默认值 |
| `digestEnabled` | `true` | 生成摘要文档 |
| `digestMaxTokens` | `800` | 摘要上限 |
| `digestTargetRatio` | `0.45` | 预算比例 |
| `digestCarryForward` | `true` | 跨次继承 |
| `digestTokenEstimator` | `cjk` | 计价方式 |
| `rawExcludeInjected` | `false` | 归档剔除注入内容 |
| `archiveLayout` | `session` | 归档布局 |
| `resumeEscalation` | `true` | 按压缩频率分级 |
| `resumeWindowMinutes` | `30` | 统计窗口 |
| `resumeMaxPerWindow` | `5` | 窗口内自动压缩上限（达到即 L3 不唤醒） |
| `resumePromptTemplate` | `''` | 续跑提示词；**清空 = 关闭该注入** |
| `wrapUpPromptTemplate` | `''` | 收尾提示词；可用 `{{notePath}}`/`{{epoch}}`/`{{todos}}`；**清空 = 关闭该注入** |

> 组合层（`cordis.patch.yml` 的 `wrapUpPrompt`/`resumePrompt`）在注册时即写入 settings 的 **base 层**，
> 所以面板读到的就是「当前生效文本」。解析结果（**含空字符串**）是权威值：清空字段并保存即可关掉对应
> 注入，不会被组合层文本悄悄顶回来（该语义由 `tests/context-guard.spec.ts` 的 template precedence 用例
> 守住；2026-09-12 浏览器验证时发现旧实现做不到，已修）。

续跑模板占位符：`{{epoch}}` `{{window}}` `{{compactions}}` `{{digest}}` `{{raw}}` `{{intent}}`；
收尾模板占位符：`{{todos}}`。未知占位符原样保留。

阈值判定优先级：`供应商阈值 > 默认阈值 > 组合配置的 thresholdRatio × contextWindow`。

## 日志 / Logs

每个事件一行结构化日志，前缀统一，`key=value` 字段便于事后 grep 与统计；**字段值不含消息正文**
（只有路径、计数、名称）。

**投递方式**：每行同时写 `ctx.logger` 与进程 `console`。这不是冗余 —— cordis 的 `ctx.logger` 只有在
组合里挂了 logger exporter（如 `@deepseek-ai/cordis-plugin-logger-console`）时才会被导出，否则只进一个
1000 条的环形缓冲，外部完全看不到；web profile 与 dsh 自带的 bundle 都没挂。**实测**（2026-09-12
容器内）：压缩已经产出了归档文件，而 dsh 日志里 `context-guard` 行数为 0。所以 console 那一份才是可查
的那一份：

```sh
journalctl -u dsh-web | grep context-guard        # 宿主 web 服务
grep context-guard /path/to/dsh-web.log           # 启动器重定向的日志文件
```

> 若某个组合**确实**挂了 console exporter，同一行会打印两次（内容完全相同），这是可接受的代价，
> 而不是靠猜 exporter 是否存在来规避。

全部行（按前缀）：

| 行 | 级别 | 触发 |
| --- | --- | --- |
| `context-guard: invalid-threshold-ratio value=… fallback=0.85` | warn | 组合配置的 ratio 越界（已回退） |
| `context-guard: wrap-up-queued agent=… tokens=… threshold=… ratio=… window=…` | info | hook 1 排队收尾提醒 |
| `context-guard: step-end-failed agent=… error=…` | warn | `step/end` 评估异常（已包含） |
| `context-guard: pre-step-fold-failed agent=… error=…` | warn | 折叠进入消息失败 |
| `context-guard: no-compaction-provider note=…` | warn | 两层都找不到压缩引擎（只记一次，hook 2/3 降级） |
| `context-guard: idle-compacted agent=… tokens=… threshold=… ratio=… window=… shadowed=…` | info | hook 2 压缩成功 |
| `context-guard: idle-compaction-failed agent=… error=…` | warn | hook 2 压缩抛错 |
| `context-guard/resume: skipped reason=compaction-error error=…` | warn | 压缩带 error，不续跑 |
| `context-guard/resume: sent agent=… compaction=… inWindow=… level=… digest=… promptTokens=…` | info | 续跑已注入并唤醒 |
| `context-guard/resume: suppressed agent=… compaction=… inWindow=… window=…` | warn | L3：不唤醒，只留提示 |
| `context-guard/resume: failed agent=… error=…` | warn | 续跑渲染/注入异常 |
| `context-guard/digest: knobs source=settings\|config\|default enabled=… maxTokens=… targetRatio=… carryForward=… estimator=… rawExcludeInjected=… layout=…` | info | 生效配置**变化时**记一次（含来源） |
| `context-guard/digest: raw-written epoch=… session=… layout=… messages=… dir=… file=…` | info | 无损归档已落盘 |
| `context-guard/digest: written epoch=… session=… region=N/M tokens=…→… budget=… tier=… carriedFrom=… digest=… raw=…` | info | 摘要已落盘（`tier` 见格式契约 §5） |
| `context-guard/digest: skipped reason=disabled session=…` | info | 摘要被关闭 |
| `context-guard/digest: no-base-dir session=…` | warn | 会话无 `cwd` 且引擎未配 `archiveDir` |
| `context-guard/digest: write-failed session=… dir=… error=…` | warn | 写盘失败（帧降级，压缩仍成功） |
| `context-guard/digest: carry-forward-skipped reason=other-session\|unparsable\|version-N-expected-M from=…` | warn | 放弃继承 |
| `context-guard/sidecar: raw-written …` / `written …` / `skipped reason=disabled …` / `write-failed …` / `carry-forward-skipped …` | 同 `digest` 各行的级别 | **旁挂写盘**（外来压缩机），事件名与字段和 `digest` 行一致，只换 scope |
| `context-guard/sidecar: archived session=… compaction=… epoch=… messages=… raw=… digest=…` | info | 旁挂归档落盘完成（失败时为 `failed session=… error=…`，仍不抛） |
| `context-guard/sidecar: skipped reason=no-cwd\|empty-region session=…` | warn | 会话无 `cwd`（写 `.handoff` 会落到宿主进程的工作目录）或区间取不到消息 |

## 行为语义 / Behavior

- **每周期一次**：`warned` / `compacted` 标记在上下文回落到阈值以下时复位；压缩后若仍超阈值不会重复
  压缩，避免无限循环。
- **收尾提醒的确定性注入**：`step/end` 评估是异步的，而循环会立即领取下一步的 inbox 批次
  （`agent.inject()` 会错过领取），因此提醒通过 `agent/pre-step` waterfall 折叠进进入消息，保证下一次
  请求必达；工具结果不经过 inbox（由日志派生模型历史），工具延续步骤的进入批次可能为空，此时提醒
  单独作为该步骤的进入消息。
- **压缩失败**：`compaction/end` 带 `error` 时不续跑，仅记日志。
- **L3 只排队不唤醒**：用 `agent.send(msg, 'next-turn', false)` 而非 `followup()`，避免在被抑制时仍把
  agent 拉起来。
- **并发安全**：`compacting` 标记防止同一会话的并发压缩；压缩信号在插件卸载时中止。
- **写盘原子性**：tmp + `rename`；顺序 raw → `latest.txt` → digest → `latest-digest.txt`，指针最后移动。
- **旁挂序号与收尾笔记同源**：`N = ` 本会话（含手动）压缩总数 `+ 1`。写盘时 `compaction/end` 还没追加，
  所以这个数与收尾提示里的 `{{epoch}}`、以及盘上已有的最大编号（取较大者）一致，不会重号。

## 模型体验 / Model Experience

- 每个超阈值周期至多注入 **1 条**收尾提醒 + **1 条**续跑提示，均为短文本；压缩帧本身也只含路径与
  读取规则（外加 `regionTokens ≥ 600` 时的一行线索）。
- 提醒/续跑消息计入 `user/message` 表层，会被 token-meter 计量并进入后续请求历史；每次压缩后历史被
  摘要节点替换，实际占用下降。
- 本插件自身不发起任何额外模型调用；digest 与归档都是纯代码产物（`model: 'archive-cut-v1'`,
  `maxTokens: 0`，不产生 usage）。

## 本地开发 / Local Development

仓库内 `node_modules/` 是符号链接场（gitignored）：`@deepseek-ai/*` 链接到工作区
`deepseek-harness/` 的源码包目录，`vitest`/`typescript`/`tsdown` 链接到其 `node_modules`，保证与本地
dsh 同一份 cordis/schemastery 实例。

```sh
npm run typecheck   # tsc --noEmit
npm run test        # vitest（真实 agent loop + mock adapter，无网络）
npm run build       # tsdown → lib/，再 node scripts/build.mjs → lib/client.js
npm run verify      # 三者全跑
```

测试套件（`tests/`）通过真实 agent loop 驱动脚本化 mock adapter，覆盖完整闭环（提醒 → 收尾 → 空闲
压缩 → 续跑）、阈值以下无动作、已收尾步骤不提醒、失败压缩不续跑、每个配置开关、每周期一次防循环
语义、**旁挂归档**（外来后端写 raw+digest 并被续跑提示引用、跨次编号与继承、自家引擎不重复写），
以及新增模块的纯函数契约：摘要抽取/预算梯度/继承与版本失配（`digest.spec.ts`）、落点与目录名
清洗（`paths.spec.ts`）、分级续跑决策（`resume-prompt.spec.ts`）、会话事实读取（`session-facts.spec.ts`）、
设置解析与优先级（`settings.spec.ts`）、共用写盘器与 `minEpoch` 编号（`archive.spec.ts`）。

## 已知限制 / Known Limitations

- `compaction` 是可选服务，按 agent 解析（host 平面 `ctx.get` → preset realm `agentPresets.serviceFor`）：
  两层都没有提供方时 hook 2/3 降级（警告一次），hook 1 不受影响；preset 自带的 `compaction-basic`
  位于 `isolate` realm，host 行只能经 seam 访问。
- `step/end` 评估依赖 `session.requestHeader()` 与模型适配器声明的 `contextWindow`；无请求头或模型未
  声明窗口时会话被跳过。
- 收尾是「提示性停止」：通过提醒引导 agent 自行收尾停轮，不强制中断轮次。
- digest 是**事实清单而非语义摘要**：它不试图理解内容，模型需要推理脉络时仍要 `read` 完整归档。
- `.handoff/` 根下 299 份历史 flat 归档**不迁移**（无法按会话归属），新版不再写根 `latest.txt`。
  旧的收尾笔记（`<日期>-<主题>.md`）也留在根下不动：**0.3.4 起新笔记写进 `sessions/<会话id>/`**，
  根目录不再增长。
- 接力笔记的目录由守卫按 `<cwd>/.handoff` 默认基线 + settings 的 `archiveLayout` 算出；
  若压缩引擎行单独配了别的 `archiveDir`（不在 settings 命名空间里），笔记与归档会分处两地。
  **旁挂归档同理**：它读 settings 的 `archiveLayout`，读不到引擎行的 `archiveDir`/`epochPrefix`。
- 只归档**摘要式压缩**（`compaction/summary`）。同族里模型无关的 `compaction/prune` 不写归档 ——
  它是纯剪枝、没有摘要区间，混进同一套 `epoch-N` 编号会让 digest 与序号错位。
- 会话没有 `cwd` 时不旁挂写盘（`.handoff` 会相对宿主进程的工作目录解析），只记一行
  `sidecar: skipped reason=no-cwd`。
- digest 含用户文本与路径：父仓库 `.gitignore` 已 ignore `.handoff/sessions/`。
- 同一会话的并发压缩靠 guard 的 `compacting` 标记串行化；跨进程并发写同一会话仍未加文件锁。

## License

MIT
