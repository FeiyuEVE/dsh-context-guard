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
  3. **落盘确认**（`existingFile`）—— 路径必须真是文件，否则模板退回
     「（本次未生成摘要文件 / 归档文件）」。
  回归用例：`tests/context-guard.spec.ts` 的 `resume archive pointers`（含外域摘要、真文件、文件已删
  三种）与 `tests/digest.spec.ts` 的 `digestPathFrom`。**排查口径**：非归档引擎的会话「没有归档」是
  正常态（`agentPreset: standard` → `compaction-basic`，事件里 `provider=deepseek-official`、
  `maxTokens=8192`；本引擎是 `provider=context-guard`、`maxTokens=0`），此时 `.handoff/sessions/`
  为空不是缺陷。

## 日志

- **字段不含正文**：只有路径、计数、名称；`context-guard: knobs source=settings|config|default` 是排查
  「配置到底生没生效」的第一入口。
- **必须走 `createLogSink`（2026-09-12 容器验证发现并修复）**：cordis 的 `ctx.logger` 只在组合挂了
  logger exporter 时才导出，否则只进一个 1000 条环形缓冲 —— web profile 与 dsh 自带 bundle **都没挂**。
  实测：压缩已经写出归档文件，而 `dsh-web.log` 里 `context-guard` 行数为 0。现在每行同时投递
  `ctx.logger` 与 `console`，于是 `journalctl -u dsh-web | grep context-guard` 或启动器日志文件都能查
  到。**新增日志点也要走同一个 sink**，别直接调 `ctx.logger`。
