# AGENTS.md — dsh-context-guard

## 项目定位
DSH 上下文压力守卫插件（Host + Web Client 两半）。每个会话一个闭环，由三个事件触发：

1. `step/end`（经 `session/event` 监听分发）：超阈值且该步骤仍欠一次模型请求（assistant 带 tool-call）时，把收尾提醒排队，经 `agent/pre-step` 折叠进下一步进入消息；
2. `agent/status` idle：仍超阈值则 `compaction.compactNow()`，每个超阈值周期一次（防压缩-续跑死循环）；
3. `compaction/end`：压缩无 `error`、开关开启且 agent 空闲时，按**压缩频率分级**（L0–L3）渲染续跑提示并 `agent.followup()`；L3 只 `agent.send(..., 'next-turn', false)` 排队不唤醒。

- 阈值优先级：settings 供应商绝对阈值 > settings 默认绝对阈值 > `thresholdRatio × contextWindow`。
- 续跑分级：窗口内自动压缩 2 次→L1（增量推进）、≥3 次→L2（拆分/委派，仅在请求头确实带委派工具时点名）、≥`resumeMaxPerWindow`→L3 不唤醒（**与 `resumeEscalation` 开关无关**，始终生效）。只统计自动压缩（`sourceCommandId === undefined`），窗口内出现新的人类消息重置计数。
- Web 设置分节「上下文守卫」三组共 14 项写入 `context-guard` settings 命名空间，host 实时 `watch`，保存即生效（稀疏 patch；提示词留空 = 关闭该注入）。
- 另导出子路径 `./compaction`：`ArchiveCutEngine extends BasicCompactionEngine`，只覆写 `summarize()`，零模型调用地把被裁历史导成 Markdown **并生成确定性事实摘要（digest）**，返回只带路径的指针帧。
- 形态：独立 npm 包类插件（`../PLUGIN-DEV.md`），`peerDependencies` 显式版本列表 + `dsh.bundle.patch` 单行 + `dsh.client.platform=web`；兼容矩阵登记在 `../PLUGINS.md`。
## 仓库与状态
| 项 | 事实 |
|---|---|
| remote | `git@github.com:FeiyuEVE/dsh-context-guard.git`（SSH） |
| 当前分支 | `local/digest-resume`（基线 `local/archive-cut` @ `0adca9b`，2026-09-12），**全部改动未提交、未推送** |
| origin 头 | `3e51afd`，其 `package.json` 版本 0.2.4 |
| `main` | 停在 `91b298c` / 0.2.2，**已陈旧，勿当基线** |
| 包名/版本 | `@feiyueve/dsh-context-guard@0.3.0`（`package.json`；**已改版本号，尚未发私源** —— 发版与 `systemctl restart dsh-web` 需用户确认时机） |
| 发布/上线 | 私源最新 0.2.6；`~/.dsh/profiles/{web,staging}/package.json` 均装 0.2.6 并列入 `dsh.profile.bundles` |
| tag | 无 |
## 目录结构
| 路径 | 职责 |
|---|---|
| `src/index.ts` | Host 插件：`apply()`、Config schema、三个事件触发、settings 注册、每会话 EpisodeState、分级续跑 |
| `src/compaction.ts` | `ArchiveCutEngine`：覆写 `summarize()`；归档 + digest 落盘 + carry-forward + 指针帧 + 日志 |
| `src/digest.ts` | 确定性事实抽取与 digest 渲染：`extractFacts`/`composeDigest`/`parseDigest`/`carriedFrom`/`isInjectedContext`/计价器 |
| `src/paths.ts` | 落点：`sessionDirName`（清洗 + 变更时附 sha256 短摘要）、`archiveLocation`、`digestPointerCandidates` |
| `src/settings.ts` | `context-guard` 命名空间的 schema、默认值、优先级解析（`resolveDigestConfig`/`userLayerOf`/`overridesOf`） |
| `src/resume-prompt.ts` | 纯函数提示词渲染：`decideResume`（L0–L3）、`buildWrapUpPrompt`、内置默认模板 |
| `src/session-facts.ts` | 结构化读会话：`compactionPace`、`availableToolNames`、`pendingTodos`、`lastHumanIntent`、`checkpointText` |
| `src/log.ts` | `formatLogLine`/`createLogSink`/`logInfo`/`logWarn`：`context-guard[/scope]: event k=v` 单行日志，**同时投递到 `ctx.logger` 与 console**（见「约定与坑」） |
| `src/messages-to-md.ts` | 纯函数清洗：会话区段 → Markdown（无 I/O、无时间戳、可 golden 测试）；`excludeInjected` 选项 |
| `src/client.js` | 浏览器端源码：`settings.section`「上下文守卫」三组表单，走 `remote.settings`/`remote.llm` |
| `docs/digest-format.md` | **digest 格式契约**（结构、抽取口径、预算梯度、继承、版本规则、已知边界） |
| `lib/` | 构建产物（gitignored、未入库）：`index.mjs`、`compaction.mjs`、共享 chunk `settings-*.mjs`、`client.js` 及同名 `*.d.mts` |
| `scripts/build.mjs` | esbuild 压缩 `src/client.js` → `lib/client.js`；超 262144B 退出 1（当前 17491B） |
| `tests/` | vitest：`context-guard.spec.ts`(17) + `digest.spec.ts`(10) + `resume-prompt.spec.ts`(9) + `paths.spec.ts`(8) + `session-facts.spec.ts`(8) + `archive-cut.spec.ts`(7) + `settings.spec.ts`(7) + `log.spec.ts`(5) = **71 例** + mock adapter / stub 引擎 |
| `cordis.patch.yml` | bundle patch：只 insert 一行 `context-guard` → `@feiyueve/dsh-context-guard` |
| `pnpm-workspace.yaml` | `overrides` 把 `@deepseek-ai/*` link 到 `../deepseek-harness/` 源码；`allowBuilds: esbuild` |
| `node_modules/` | 本地符号链接场（gitignored）：`@deepseek-ai/*` → `../deepseek-harness/...`，工具链在 `.pnpm/` |
## 常用命令
```sh
npm run typecheck   # tsc --noEmit（复核实跑 exit 0）
npm test            # vitest run：71 例全通过，真实 agent loop + mock adapter，无网络
npm run build       # tsdown → lib/index.mjs + lib/compaction.mjs（+ 共享 chunk），再 node scripts/build.mjs → lib/client.js
npm run verify      # typecheck && test && build（顺序固定，见 package.json）
```

- 链接场前提：`node_modules/@deepseek-ai/*` 是 pnpm 按 `pnpm-workspace.yaml` 的 `overrides` 生成的 link，**不是** registry 安装；`verify` 依赖它。
- 发布契约：`files: ["lib","cordis.patch.yml"]`（白名单），入口 `main=lib/index.mjs`，`exports` 暴露 `.` / `./compaction` / `./client`。
- 装进 profile：`dsh plugin --profile web add /home/feiyueve/文档/dsh/dsh-context-guard`（README）；当前 profile 实际装的是私源 0.2.6。
## 约定与坑
- **客户端 bundle id 必须等于 npm 包名**：`src/client.js` 的 `__ModuleLoader__.load({ id: '@feiyueve/dsh-context-guard' })` 不一致时 client-modules 会让整棵客户端插件图加载失败（`../CHANGES.md` 2026-09-11 第 3 条）；`../PLUGINS.md` 把客户端 bundle id 列入「保持原名不动」的旧表述已过时。
- **改客户端半边必须用真实浏览器验证**：页面/bundle HTTP 200 + `--dump-config` 全挂载也可能全是假绿，失败时页面只剩 `Failed to load plugins`（`../PLUGINS.md` 2026-09-11 教训）。
- **帧文本长度受收缩不变量约束**：基类强制「摘要必须小于被替换内容」，帧写胖会在小区间上让压缩直接失败（`summary is not smaller than the shadowed content`）。`- 线索：` 行只在 `regionTokens ≥ 600`（`HEADLINE_MIN_REGION_TOKENS`）时出现。**改 `frameText` 必须重跑 `tests/archive-cut.spec.ts` 的两个手动压缩用例**（它们是这条不变量的回归门禁；本轮已在此栽过一次）。
- **digest 预算有下限 260**：header 自身约 100 tokens 固定成本，更低的下限任何正文都满足不了；digest 比小区间大不额外占用上下文（只有短帧进上下文）。
- **两个模块图，settings 是唯一共享通道**：preset 用绝对路径引用 `lib/compaction.mjs`，guard 来自已安装包 → 模块级单例**不可能**共享。guard 注册 `context-guard` 命名空间，引擎只经 `describe().user` 读用户层（`userLayerOf` 特性探测 + try/catch）。优先级处处为 `settings 用户层 > 组合 config > 内置默认`。
- **`lib/` 未入库且无 `prepare`/`prepublishOnly`**：从干净克隆发布前必须先 `npm run build`，否则发空壳；`scripts/build.mjs` 注释称 client 产物 "committed to git" 与实际 gitignore 矛盾。
- **构建顺序**：`tsdown` 的 `clean: true` 会清空 `lib/`，`build:client` 必须在其后（`package.json` 已保证）。
- **overrides 必须与实际 import 的 dsh 包一一对账**：漏一个会静默改用 registry 旧构建（0.2.4 曾漏 `dsh-compaction-basic` 致 `assertNever` 导入失败）；`cordis`/`schemastery` 必须 link 到 `../deepseek-harness/vendor/*`，否则出现双份。
- **`peerDependencies` 写版本号，不写 `link:`**（发布契约，禁 `*`）；当前覆盖 `0.1.1-rc.2` 至 `0.1.5-rc.2-local.3`。
- **压缩引擎是可选服务**：先 `ctx.get('compaction')`，否则经 `agentPresets.serviceFor(agent,'compaction')` 取 preset `isolate` realm 内的实例；两层都无则事件 2/3 降级（warn 一次），事件 1 仍可用，不阻塞启动。
- **归档落点**（默认 `session` 布局）：`<archiveDir 或 cwd>/.handoff/sessions/<sessionDirName(会话id)>/` 下 `epoch-<N>.raw.md` + `epoch-<N>.digest.md` + `latest.txt` + `latest-digest.txt`；N 在本会话目录内递增。目录名用**完整会话 id**，清洗改变原 id 时附 `-<sha256[0..8]>`。`archiveLayout: 'flat'` 保留旧行为（无隔离），**299 份历史 flat 归档不迁移**。写失败仅 warn 不抛。
- **digest 必须剔除宿主重发注入**（`isInjectedContext`：agent-instructions/skill-catalog/system 及 context-guard 的 snapshot/instructions/catalog/notice）：实测这些占了 raw 归档的大部分体积，写进 digest 是纯浪费。格式契约改动必须 bump `DIGEST_FORMAT_VERSION`（见 `docs/digest-format.md` §8）。
- **阈值存储**：`~/.dsh/settings.yaml` 顶层 `context-guard`，无 profile 级覆盖文件，web/staging 共享。
- **提示词优先级的坑（2026-09-12 浏览器验证发现并修复）**：组合层的 `wrapUpPrompt`/`resumePrompt` 在 `register(..., { base })` 时已写进 settings **base 层**，`scope.get()` 返回的就是「base ⊕ 用户层」。因此解析结果**含空字符串都必须照用** —— 若写成「非空才算覆盖」，用户在面板清空字段后会被 base 文本顶回来，**注入永远关不掉**（`pickTemplate` 已改为 `settingValue !== undefined` 即采纳）。`mergeLayers` 对 `''` 是替换而非忽略，这是该语义成立的前提。回归用例见 `tests/context-guard.spec.ts` 的 `template precedence over the settings layer`；改这块必须先看那三个用例。
- **日志字段不含正文**：只有路径、计数、名称；`context-guard: knobs source=settings|config|default` 是排查「配置到底生没生效」的第一入口。
- **日志必须走 `createLogSink`（2026-09-12 容器验证发现并修复）**：cordis 的 `ctx.logger` 只在组合挂了 logger exporter 时才导出，否则只进一个 1000 条环形缓冲 —— web profile 与 dsh 自带 bundle **都没挂**。实测：压缩已经写出归档文件，而 `dsh-web.log` 里 `context-guard` 行数为 0（用户明确要求「日志也要有」，所以这是必须修的）。现在每行同时投递 `ctx.logger` 与 `console`，于是 `journalctl -u dsh-web | grep context-guard` 或启动器日志文件都能查到。新增日志点也要走同一个 sink，别直接调 `ctx.logger`。
## 相关文档
| 文档 | 内容 |
|---|---|
| `README.md` | 功能、设置面板、安装、Config/设置字段、日志目录、行为语义、已知限制 |
| `docs/digest-format.md` | digest 格式契约（结构/抽取/预算/继承/版本/边界） |
| `../AGENTS.md` | 父仓库总规则与资源路由 |
| `../PLUGINS.md` | 插件登记 + dsh 版本兼容矩阵（本插件行） |
| `../CHANGES.md` | 本插件历史教训（scope 改名、客户端 id、0.2.4 适配、archive-cut） |
| `../PLUGIN-DEV.md` | 插件形态选型 / 构建 / 安装 / 发版流程 |
| `../RESOURCES.md` | remote / 代理 / 端口等本机事实 |
