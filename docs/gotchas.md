# 工程坑与历史教训

从 `AGENTS.md` 拆出：那里只讲项目本身，这里放踩过的坑与已修复缺陷的成因。
每条都对应一次实际失败或一次实测结论，不是预防性猜测。

## 客户端半边

- **bundle id 必须等于 npm 包名**：`src/client.js` 的
  `__ModuleLoader__.load({ id: '@feiyueve/dsh-context-guard' })` 与包名不一致时，client-modules 会让
  **整棵**客户端插件图加载失败（`../CHANGES.md` 2026-09-11 第 3 条）。
- **必须用真实浏览器验证**：页面/bundle HTTP 200 + `--dump-config` 显示全挂载，也可能全是假绿；
  真失败时页面只剩 `Failed to load plugins`。
- **布局要容器自适应，别写死列数（2026-09-12 手机端反馈）**：成对字段原先写死
  `grid-template-columns:1fr 1fr`，手机 WebView 内容区约 380px 时每格只剩 ~180px —— 标签折成两三行、
  `计价方式`/`归档布局` 下拉被截断、说明文字挤成窄条。改用 `flex-wrap` + `flex:1 1 200px` 后列数由
  **容器宽度**决定。**别只靠 `@media` 按视口判断**：宿主壳完全可能「宽视口 + 窄内容区」（实测
  `dsh-mobile` 的手机设置页，左导航就把内容区压到 106px），那时视口媒体查询根本不触发。
  复现/验收脚本 `/home/feiyueve/tmp/cg-e2e/mobile-layout.cjs`（四场景：手机满宽、手机专用前端、
  宽视口窄容器、桌面）。

## 构建与发布

- **`lib/` 未入库且无 `prepare`/`prepublishOnly`**：从干净克隆发布前必须先 `npm run build`，否则发
  空壳。`scripts/build.mjs` 注释称 client 产物 "committed to git"，与实际 gitignore 矛盾。
- **构建顺序**：`tsdown` 的 `clean: true` 会清空 `lib/`，`build:client` 必须在其后（`package.json`
  已保证）。
- **别信 publish 通告头的版本号**：npm 启动时把 `package.json` 读进内存（通告头与 tarball 文件名用
  这份），**打包时重新读磁盘**。2026-09-12 实测：发布进行中并发工作流把 `0.3.0` 改成 `0.3.1`，于是
  通告打 `@0.3.0` 而私源落库为 `0.3.1`（`0.3.0` 从不存在，号段作废）。**口径**：publish 后一律用
  `npm view @feiyueve/dsh-context-guard versions` + 回拉 tarball 与本地 `sha256sum` 逐文件对账。
- **`peerDependencies` 写版本号，不写 `link:`**（禁 `*`）。dsh 出新版本时按工作区「dsh 升级联动」
  追加一项 + 补一个 patch 版 + 在 `CHANGELOG.md` 记一条。
- **`overrides` 必须与实际 import 的 dsh 包一一对账**：漏一个会静默改用 registry 旧构建（0.2.4 曾漏
  `dsh-compaction-basic` 致 `assertNever` 导入失败）；`cordis`/`schemastery` 必须 link 到
  `../deepseek-harness/vendor/*`，否则出现双份。

## 压缩引擎与帧

- **帧长度受收缩不变量约束**：基类强制「摘要必须小于被替换内容」，帧写胖会在小区间上让压缩直接失败
  （`ManualCompactionError: summary is not smaller than the shadowed content`）。`- 线索：` 行只在
  `regionTokens ≥ 600`（`HEADLINE_MIN_REGION_TOKENS`）时出现。**改 `frameText` 必须重跑
  `tests/archive-cut.spec.ts` 的两个手动压缩用例** —— 它们是这条不变量的回归门禁。
- **digest 预算有下限 260**：header 自身约 100 tokens 固定成本，更低的下限任何正文都满足不了；
  digest 比小区间大并不额外占用上下文（进上下文的只有短帧）。
- **压缩引擎是可选服务**：先 `ctx.get('compaction')`，否则经
  `agentPresets.serviceFor(agent,'compaction')` 取 preset `isolate` realm 内的实例；两层都无则事件
  2/3 降级（warn 一次），事件 1 仍可用，**不阻塞启动**。

## settings 与优先级

- **两个模块图，settings 是唯一共享通道**：preset 用文件路径引用 `lib/compaction.mjs`（或包名），
  guard 来自已安装包 → 模块级单例**不可能**共享。guard 注册 `context-guard` 命名空间，引擎只经
  `describe().user` 读用户层（`userLayerOf` 特性探测 + try/catch）。优先级处处为
  `settings 用户层 > 组合 config > 内置默认`。预设引用引擎更稳的写法是包名
  `@feiyueve/dsh-context-guard/compaction`（`exports` 已暴露，实测可从 profile 的 `node_modules`
  解析），仓库绝对路径在 `lib/` 被清后会断。
- **提示词优先级的坑（2026-09-12 浏览器验证发现并修复）**：组合层的 `wrapUpPrompt`/`resumePrompt` 在
  `register(..., { base })` 时已写进 settings **base 层**，`scope.get()` 返回的就是「base ⊕ 用户层」。
  因此解析结果**含空字符串都必须照用** —— 若写成「非空才算覆盖」，用户在面板清空字段后会被 base
  文本顶回来，**注入永远关不掉**（`pickTemplate` 已改为 `settingValue !== undefined` 即采纳）。
  `mergeLayers` 对 `''` 是替换而非忽略，这是该语义成立的前提。回归用例见
  `tests/context-guard.spec.ts` 的 `template precedence over the settings layer`。
- **阈值存储**：`~/.dsh/settings.yaml` 顶层 `context-guard`，无 profile 级覆盖文件，web/staging 共享。

## 归档与 digest

- **旁挂归档必须同步落盘才能「写盘先于覆盖」（2026-09-12，0.3.6 修）**：守卫的旁挂写盘挂在
  `compaction/summary` 上，而这个事件**不是**可等待的钩子 —— `session/event` 走 cordis 的 `emit`
  （`vendor/cordis/lib/index.js` 注释原文：run listeners synchronously *without waiting for returned
  promises*；分发模式属于事件，**监听器无法选择被等待**），而 `compaction-basic/src/region.ts` 在追加
  `compaction/summary`（476 行）之后**紧接**（中间无 `await`）就在 489 行追加替换消息。
  `session/flush` 虽然可 await，却在 `compaction/end`（后于替换）才跑，救不了这个窗口。
  所以唯一的办法是**在监听器里用同步 I/O 把文件写完**：监听器是同步调用的，`append()` 返回时文件
  已在盘上，严格早于替换。0.3.5 曾用 `void promise`（fire-and-forget），那时「先落盘」只是通常成立
  —— 这是 0.3.6 改掉的东西。代价：归档盘卡住会拖住压缩调用方（不再是「丢一份归档、压缩照常」）。
  **推论**：`src/archive.ts` 全链保持同步（`mkdirSync`/`writeFileSync`/`renameSync`/`readFileSync`），
  不要在旁挂路径上引入 `await`；区间取回本身用的是**只增日志**（`session.eventAt(seq)` 读
  `this.log[seq]`，替换只改表层投影、不动日志），取内容永远安全。
  引擎那条路（`ArchiveCutEngine` 覆写 `summarize()`）本来就早于替换，两条路现在口径一致。
  回归门禁：`tests/context-guard.spec.ts` 的 `lands the archive before the replacing message is
  dispatched`（在替换消息派发的那一刻同步读盘；把写盘改成 `queueMicrotask` 它会失败）。
- **记录表不再是在途 promise**：0.3.5 时续跑提示在 `compaction/end` 之后的 microtask 里渲染，
  通常**赢过**旁挂第一次 `mkdir` 的 I/O 回调，所以记录表存的是在途 promise、渲染时 `await`；
  症状是 `resume: sent … digest=undefined` 而盘上文件已经存在。0.3.6 写盘同步完成，记录里直接就是
  落盘的 `Artifacts`，同步读取即可 —— **这条 `await` 的存在本身就是写盘不同步的信号**。
- **`writeArchive` 的 `minEpoch` 语义**：`max(扫描值, minEpoch)`。守卫知道自己会话的压缩总数
  （`compactionPace().sessionTotal + 1`，与收尾笔记 `{{epoch}}` 同源），引擎只管扫描。
  低报不会让序号倒退（扫描优先），高报只是留空洞 —— **任何一侧都不允许重号覆盖别人**。
- **落点**（默认 `session` 布局）：`<archiveDir 或 cwd>/.handoff/sessions/<sessionDirName(会话id)>/`
  下 `epoch-<N>.raw.md` + `epoch-<N>.digest.md` + `latest.txt` + `latest-digest.txt`；N 在本会话目录
  内递增。目录名用**完整会话 id**，清洗改变原 id 时附 `-<sha256[0..8]>`。`archiveLayout: 'flat'` 保留
  旧行为（无隔离），**299 份历史 flat 归档不迁移**。写失败仅 warn 不抛。
- **digest 必须剔除宿主重发注入**（`isInjectedContext`：agent-instructions/skill-catalog/system 及
  context-guard 的 snapshot/instructions/catalog/notice）：实测这些占了 raw 归档的大部分体积，写进
  digest 是纯浪费。格式契约改动必须 bump `DIGEST_FORMAT_VERSION`（见 `docs/digest-format.md` §8）。
- **归属行不能逐次累积**：digest「压缩说明」里 per-epoch 的归属行要在继承时按前缀过滤掉，否则每次
  压缩多加一行（实测 4 次压缩 4 行）。形状未变，无需 bump 格式版本（`EPOCH_NOTE_PREFIX`）。
- **别把「帧里的路径」当成文件（2026-09-12 线上会话发现并修复）**：续跑提示解析归档路径时，原实现
  从「压缩帧」里正则抓反引号内的 `*.digest.md`/`*.raw.md`。**只有本引擎的帧才是路径清单**；其他引擎
  的帧是模型写的摘要，正文里什么都可能出现 —— 实测 `standard` preset（`compaction-basic`）的会话
  摘要抄了 `docs/digest-format.md` 的占位符与磁盘现状，于是续跑提示注入了并不存在的
  `` `epoch-N.digest.md` `` 和别的会话的 `epoch-299.raw.md`（复现：把真实摘要喂给那两条正则，
  digest 候选 `["epoch-N.digest.md","epoch-N.digest.md"]`、raw 末位 `epoch-299.raw.md`，双双
  `isAbsolute=false`）。三道闸门现在缺一不可：
  1. **帧标记**（`FRAME_MARKER`，帧首固定句）—— 非本引擎的帧一律不认，连指针探测都不做；
  2. **只收绝对路径** —— 裸文件名是「提及」不是「指向」；
  3. **落盘确认**（`existingFile`）—— 路径必须真是文件；确认不到时 `{{archive}}` 如实写
     「本次压缩没有生成归档文档」，`{{digest}}`/`{{raw}}` 退回「（本次未生成摘要文件 / 归档文件）」。
  回归用例：`tests/context-guard.spec.ts` 的 `resume archive pointers`（含外域摘要、真文件、文件已删
  三种）与 `tests/digest.spec.ts` 的 `digestPathFrom`。**排查口径**：非归档引擎的会话「没有归档」是
  正常态（`agentPreset: standard` → `compaction-basic`，事件里 `provider=deepseek-official`、
  `maxTokens=8192`；本引擎是 `provider=context-guard`、`maxTokens=0`）。
  **0.3.5 起这条口径更新**：`standard` 会话现在由守卫旁挂写归档，`provider != context-guard`
  正是旁挂的触发条件；`provider=context-guard` 才是「引擎已写、守卫跳过」。而路径解析的第一来源
  不再是帧，而是守卫自己按 `compactionId` 存下的写盘记录（见上一条）。
- **agent 写的文件，路径必须由插件喂（2026-09-12 用户提问发现）**：分会话只做在「引擎写的」产物上
  是不够的 —— 收尾接力笔记是**模型**按提示词写的，而**模型不知道自己的会话 id**（system prompt 里没有），
  提示词若只说「写入 `.handoff/`，文件名自定」，结果就是一堆与会话无关的 `<日期>-<主题>.md` 堆在根目录
  （实测 12 份、跨 12 个工作流，只有 1 份自己写了 id）。修法：插件把 `{{notePath}}` 算好塞进提示词
  （`sessions/<完整id>/epoch-<N>.handoff.md`），并要求标题带序号。**推论**：凡是「让 agent 落盘」的
  提示词，落点都得由知道 id 的一方给出，别让模型自己编路径。
  另一个可选细节：`write` 工具（`fs-local/src/fsio.ts:581`）会 `mkdir -p` 父目录，所以插件不必预建目录 ——
  空目录因此仍是「该会话从未归档」的可判据。

## 日志

- **字段不含正文**：只有路径、计数、名称；`context-guard: knobs source=settings|config|default` 是排查
  「配置到底生没生效」的第一入口。
- **必须走 `createLogSink`（2026-09-12 容器验证发现并修复）**：cordis 的 `ctx.logger` 只在组合挂了
  logger exporter 时才导出，否则只进一个 1000 条环形缓冲 —— web profile 与 dsh 自带 bundle **都没挂**。
  实测：压缩已经写出归档文件，而 `dsh-web.log` 里 `context-guard` 行数为 0。现在每行同时投递
  `ctx.logger` 与 `console`，于是 `journalctl -u dsh-web | grep context-guard` 或启动器日志文件都能查
  到。**新增日志点也要走同一个 sink**，别直接调 `ctx.logger`。
