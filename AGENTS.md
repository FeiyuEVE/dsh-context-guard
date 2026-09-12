# AGENTS.md — dsh-context-guard

## 项目定位

DSH 上下文压力守卫插件（Host + Web Client 两半）：监控会话上下文占用，超阈值时提醒 agent 收尾、
空闲时自动压缩超阈值会话、压缩后写一份**确定性接力摘要（digest）**并按压缩频率分级续跑任务。

每个会话一个闭环，由四个事件驱动（各自有开关）：

1. `step/end`（经 `session/event` 分发）：超阈值且该步骤仍欠一次模型请求（assistant 带 tool-call）
   时，把收尾提醒排队，经 `agent/pre-step` 折叠进下一步进入消息；同一超阈值周期只提醒一次。
2. `agent/status` idle：仍超阈值则 `compaction.compactNow()`；同一超阈值周期只压缩一次
   （防压缩-续跑死循环）。
3. `compaction/end`：压缩无 `error`、开关开启且 agent 空闲时，按 **L0–L3 分级**渲染续跑提示并
   `agent.followup()`；L3 只 `agent.send(..., 'next-turn', false)` 排队不唤醒。
4. `compaction/summary`（**旁挂归档**）：压缩由别的引擎执行（`provider !== 'context-guard'`，即
   `standard` preset 的 `compaction-basic` 或手动 `/compact`）时，守卫按 `shadowedSeqs` 取回区间，
   自己写 `raw` + `digest`。**不接管 dsh 的压缩执行** —— 不覆写 `summarize()`、不改替换消息，
   模型看到的 checkpoint 始终是原压缩机产出的。

- 阈值优先级：settings 供应商绝对阈值 > settings 默认绝对阈值 > `thresholdRatio × contextWindow`。
- 续跑分级：窗口内自动压缩 2 次→L1（增量推进）、≥3 次→L2（拆分/委派，仅在请求头确实带委派工具时
  点名）、≥`resumeMaxPerWindow`→L3 不唤醒（与分级开关无关，始终生效）。只统计自动压缩
  （`sourceCommandId === undefined`），窗口内出现新的人类消息重置计数。
- Web 设置分节「上下文守卫」三组共 14 项写入 `context-guard` settings 命名空间，host 实时 `watch`，
  保存即生效（稀疏 patch；提示词留空 = 关闭该注入）。

## 形态与入口

独立 npm 包类插件（形态选型见 `../PLUGIN-DEV.md`）：`peerDependencies` 显式版本列表（禁 `*`）+
`dsh.bundle.patch` 单行 + `dsh.client.platform=web`；兼容矩阵登记在 `../PLUGINS.md`。

| 入口 | 产物 | 谁引用 |
|---|---|---|
| `.` | `lib/index.mjs` | host row（`cordis.patch.yml` 往 profile 插一行） |
| `./compaction` | `lib/compaction.mjs` | agent 预设的 compaction 行 |
| `./client` | `lib/client.js` | 浏览器侧（bundle id 必须等于包名） |

归档有两条路，**默认那条不需要改任何 preset**：

- **旁挂**（host 半边，`src/index.ts`）：监听 `compaction/summary`，任何后端压缩都补写归档；
- **接管**（可选，`./compaction`）：`ArchiveCutEngine extends BasicCompactionEngine`，只覆写
  `summarize()` 这一个受支持的扩展点、**零模型调用**，checkpoint 直接是只带路径的指针帧。
  它与旁挂互斥（`provider=context-guard` 时守卫跳过）。

两条路共用 `src/archive.ts` 的 `writeArchive()`。格式契约见 `docs/digest-format.md`。

## 目录结构

| 路径 | 职责 |
|---|---|
| `src/index.ts` | Host 插件：`apply()`、Config schema、四个事件触发、settings 注册、每会话 EpisodeState、分级续跑、**旁挂归档**（`compaction/summary` → `writeArchive`，按 `compactionId` 记路径） |
| `src/archive.ts` | **共用写盘器** `writeArchive()`：raw + digest + `latest*` 指针、跨次继承、`minEpoch` 序号；失败只 warn 不抛；不 import 压缩后端（host 半边可安全使用） |
| `src/compaction.ts` | `ArchiveCutEngine`：覆写 `summarize()`，委托 `writeArchive` 并渲染指针帧 |
| `src/digest.ts` | 确定性事实抽取与 digest 渲染（`extractFacts`/`composeDigest`/`parseDigest`/`carriedFrom`） |
| `src/paths.ts` | 落点计算：`sessionDirName`/`archiveLocation`/`digestPointerCandidates` |
| `src/settings.ts` | `context-guard` 命名空间：schema、默认值、优先级解析 |
| `src/resume-prompt.ts` | 纯函数提示词渲染：`decideResume`(L0–L3)、`buildWrapUpPrompt`、内置默认模板 |
| `src/session-facts.ts` | 结构化读会话：压缩节奏、可用委派工具、待办、最后一次人类意图 |
| `src/messages-to-md.ts` | 纯函数清洗：会话区段 → Markdown（无 I/O、无时间戳、可 golden 测试） |
| `src/log.ts` | 单行日志 sink：`context-guard[/scope]: event k=v`，同时投递 `ctx.logger` 与 console |
| `src/client.js` | 浏览器端源码：`settings.section`「上下文守卫」三组表单 |
| `tests/` | vitest：9 个 spec + mock adapter / stub 引擎，无网络 |
| `docs/digest-format.md` | digest 格式契约（结构、抽取口径、预算梯度、继承、版本规则、边界） |
| `docs/gotchas.md` | 工程坑与历史教训（构建发布、settings 优先级、归档、日志） |
| `cordis.patch.yml` | bundle patch：只 insert 一行 `context-guard` → `@feiyueve/dsh-context-guard` |
| `scripts/build.mjs` | esbuild 压缩 `src/client.js` → `lib/client.js`（超 262144B 退出 1） |
| `lib/` | 构建产物（gitignored、未入库）：`index.mjs`、`compaction.mjs`、共享 chunk、`client.js` |
| `pnpm-workspace.yaml` | `overrides` 把 `@deepseek-ai/*` link 到 `../deepseek-harness/` 源码 |

## 常用命令

```sh
npm run typecheck   # tsc --noEmit
npm test            # vitest run（真实 agent loop + mock adapter，无网络）
npm run build       # tsdown → lib/，再 node scripts/build.mjs → lib/client.js
npm run verify      # typecheck && test && build（顺序固定）
```

- 链接场前提：`node_modules/@deepseek-ai/*` 是 pnpm 按 `pnpm-workspace.yaml` 的 `overrides` 生成的
  link，**不是** registry 安装；`verify` 依赖它。
- 发布契约：`files: ["lib","cordis.patch.yml"]`（白名单），`exports` 暴露 `.` / `./compaction` / `./client`。

## 关键约定

- **客户端 bundle id 必须等于 npm 包名**；改客户端半边必须用真实浏览器验证。
- **`lib/` 是 gitignored 构建产物**，无 `prepare`/`prepublishOnly`：发布前必须走 `npm run verify`，
  发版即 `npm run verify && npm publish`。
- **构建顺序固定**：`tsdown`（`clean: true` 会清空 `lib/`）→ `scripts/build.mjs`。
- **归档落点**：`<archiveDir 或 cwd>/.handoff/sessions/<完整会话id>/`；写失败仅 warn 不抛。
- **接力笔记同落点**：收尾提示词的 `{{notePath}}` = 该会话目录下的 `epoch-<即将这次序号>.handoff.md`
  （序号 = 本会话压缩总数 + 1，与续跑提示 `{{epoch}}` 同一事实源），标题要求
  `# 第 N 次压缩 · 接力笔记 · <主题>`；守卫只算路径、不建目录（`write` 工具自建父目录），
  所以空目录仍等于「从未归档」。
- **续跑提示里的路径必须为真**，两个来源按可信度排序：①守卫按 `compactionId` 存下的**旁挂写盘记录**
  （值是在途 promise，渲染时 `await` —— `compaction/end` 的 microtask 会抢在写盘 I/O 之前）；
  ②本引擎的指针帧（帧首 `FRAME_MARKER` 标记归属，外域摘要一律不认）。两者都只收绝对路径、
  都要落盘确认；否则模板渲染成「本次未生成摘要文件 / 归档文件」。
- **旁挂归档的两点已知弱化**（`session/event` 是 `emit`，不 await 监听器；`compaction/summary` 之后
  紧接无 `await` 的替换消息）：落盘不保证先于覆盖（丢了只损这一份归档，checkpoint 无碍），
  路径只能靠续跑提示进上下文。详见 `docs/gotchas.md`。
- **日志一律走 `createLogSink`**（`ctx.logger` + console 双投递），字段不含正文。
- **配置优先级处处一致**：`settings 用户层 > 组合 config > 内置默认`；解析结果含空字符串都必须照用。

## 文档

| 文档 | 内容 |
|---|---|
| `README.md` | 面向使用者：功能、设置面板、安装、设置字段、日志、行为语义、已知限制 |
| `docs/digest-format.md` | digest 格式契约 |
| `docs/gotchas.md` | 工程坑与历史教训 |
| `../PLUGINS.md` / `../CHANGES.md` | 插件登记与兼容矩阵 / dsh 核心改造登记 |
| `../PLUGIN-DEV.md` | 插件形态选型、构建、安装、发版流程 |
| `../RESOURCES.md` | remote / 代理 / 端口等本机事实 |
