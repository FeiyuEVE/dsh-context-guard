# Changelog

本文件记录 `@feiyueve/dsh-context-guard` 的发布历史，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 SemVer。

dsh 处于预发布阶段：本插件每个版本都在 `package.json` 的 `peerDependencies` 里**显式列出**兼容的 `@deepseek-ai/dsh-*` 版本（禁止 `*` / 过宽范围），dsh 升级后按工作区「dsh 升级联动」规则追加新版本号并发补丁版。

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
