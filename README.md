# dsh-context-guard

DeepSeek Harness 上下文压力守卫插件：监控会话上下文占用，超过阈值时提醒 agent 收尾、空闲时自动压缩、压缩完成后自动续跑任务。

Context-pressure guard plugin for DeepSeek Harness: watches session context usage, reminds the agent to wrap up above a threshold, compacts over-threshold idle sessions, and resumes the task after a completed compaction.

## 设置面板（Web UI）/ Settings UI

插件带浏览器端分节（settings.section「压缩阈值」）：**按供应商（provider）配置绝对 token 阈值**（如 `300000`），保存即生效（host 侧实时 watch）。配置项：

- **默认阈值（tokens）**：未单独配置的供应商使用；
- **供应商阈值**：按 provider 覆盖默认值。

判定优先级：`供应商阈值 > 默认阈值 > 插件配置的百分比（thresholdRatio × contextWindow）`。设置存储在 dsh settings（`context-guard` 命名空间，settings-file 持久化）。

## 功能 / Features

三个 hook 组成一个闭环（每个会话独立）：

1. **hook `step/end`** — 步骤结束时评估会话上下文（`tokenMeter` 测量 / 路由模型的 `contextWindow`）。超过 `thresholdRatio` 且该步骤仍欠模型一次请求（assistant 消息带工具调用）时，把「尽快收尾」提醒折叠进下一步的进入消息，agent 看到后收尾并停轮；同一个超阈值周期只提醒一次。
2. **hook `agent/status` idle** — agent 停下后再次评估；仍超阈值则执行 `compaction.compactNow()`（引擎解析见下文「容错设计」），每个超阈值周期只压缩一次（防止压缩-续跑死循环）。
3. **hook `compaction/end`** — 压缩成功（无 `error`）且 agent 空闲时，注入「继续执行任务」提示并 `followup()` 唤醒，在压缩后的表层上续跑。失败或 agent 运行中不续跑。

All injected content is a user-role message stamped with the plugin source
(`{ kind: 'plugin', plugin: 'context-guard', form: 'notice' }`), so it is
durable in the session log and reconstructable (model-visible ⟺ logged).

## 安装 / Install

```sh
dsh plugin --profile web add /path/to/dsh-context-guard
```

bundle 采用 cost-meter 式单一 Loader 行（`cordis.patch.yml` 只 insert `context-guard` 一行），不干预 profile 的压缩后端配置。

**容错设计（插件出错不影响 dsh 进程）**：

- `compaction` 是可选服务，按 agent 解析：先查 host 平面的提供方（`ctx.get`），否则经 `agentPresets` seam 读取该 agent 的 preset 在 `isolate` realm 中挂载的实例（标准/ptc/cordis preset 都把 `compaction-basic` 放在 `isolate: { compaction: true }` 后面，host 光纤看不到，只能走 seam）。两层都没有时插件照常加载，hook 1（收尾提醒）可用，hook 2/3 降级并记录一次警告，**不会 pending、不会阻塞启动**。
- 越界配置（如 `thresholdRatio: 2`）不抛错：记录 error 日志并回退默认值。
- 所有监听器（`session/event`、`agent/pre-step`、`agent/status`、压缩续跑）的运行期异常均被包含并记日志，任何情况下都不向外抛出。

## 配置 / Config

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `thresholdRatio` | number (0–1) | `0.85` | 回退阈值：settings 未配置绝对阈值时按 `占用 / contextWindow` 触发 |
| `wrapUpPrompt` | string | 中文收尾提醒 | 步骤结束时注入的收尾提示；空字符串禁用 hook 1 |
| `resumePrompt` | string | 中文续跑提示 | 压缩成功后注入的续跑提示；空字符串禁用 hook 3 |
| `autoCompactOnIdle` | boolean | `true` | 空闲且超阈值时自动压缩（hook 2 开关） |
| `resumeAfterCompact` | boolean | `true` | 压缩成功后自动续跑（hook 3 开关） |

示例（profile 的 `cordis.patch.yml`）：

```yaml
- id: context-guard
  config:
    thresholdRatio: 0.9
    wrapUpPrompt: 'Context is near the limit. Finish the current task now and stop.'
```

## 行为语义 / Behavior

- **每周期一次**：`warned` / `compacted` 标记在上下文回落到阈值以下时复位；压缩后若仍超阈值不会重复压缩，避免无限循环。
- **收尾提醒的确定性注入**：`step/end` 评估是异步的，而循环会立即领取下一步的 inbox 批次（`agent.inject()` 会错过领取），因此提醒通过 `agent/pre-step` waterfall 折叠进进入消息，保证下一次请求必达；工具结果不经过 inbox（由日志派生模型历史），工具延续步骤的进入批次可能为空，此时提醒单独作为该步骤的进入消息。
- **压缩失败**：`compaction/end` 带 `error` 时不续跑，仅记录日志。
- **并发安全**：`compacting` 标记防止同一会话的并发压缩；压缩信号在插件卸载时中止。

## 模型体验 / Model Experience

- 每个超阈值周期至多注入 **1 条**收尾提醒 + **1 条**续跑提示，均为短文本；阈值可配，默认在窗口 85% 时介入。
- 提醒/续跑消息计入 `user/message` 表层，会被 token-meter 计量并进入后续请求历史；每次压缩后历史被摘要节点替换，实际占用下降。
- 本插件自身不发起任何额外模型调用；压缩调用由所配提供方（compaction-basic）执行。

## 本地开发 / Local Development

仓库内 `node_modules/` 是符号链接场（gitignored）：`@deepseek-ai/*` 链接到工作区 `deepseek-harness/` 的源码包目录，`vitest`/`typescript`/`tsdown` 链接到其 `node_modules`，保证与本地 dsh（0.1.2-alpha.1）同一份 cordis/schemastery 实例。

```sh
npm run typecheck   # tsc --noEmit
npm run test        # vitest（真实 agent loop + mock adapter，无网络）
npm run build       # tsdown → lib/
npm run verify      # 三者全跑
```

测试套件（`tests/`）通过真实 agent loop 驱动脚本化 mock adapter：覆盖完整闭环（提醒 → 收尾 → 空闲压缩 → 续跑）、阈值以下无动作、已收尾步骤不提醒、失败压缩不续跑、每个配置开关，以及每周期一次的防循环语义。

## 已知限制 / Known Limitations

- `compaction` 是可选服务，按 agent 解析（host 平面 `ctx.get` → preset realm `agentPresets.serviceFor`）：两层都没有提供方时 hook 2/3 降级（警告一次），hook 1 不受影响；preset 自带的 `compaction-basic` 位于 `isolate` realm，host 行只能经 seam 访问。
- `step/end` 评估依赖 `session.requestHeader()` 与模型适配器声明的 `contextWindow`；无请求头或模型未声明窗口时会话被跳过。
- 收尾是「提示性停止」：通过提醒引导 agent 自行收尾停轮，不强制中断轮次。

## License

MIT
